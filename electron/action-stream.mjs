export class ActionFormatError extends Error {}

// Use the same output allowance when admitting a prompt and sending it to the
// runtime. Small context windows need room for the task and tool observations.
export function actionOutputBudget(contextSize = 16384) {
  const context = Number.isFinite(contextSize) && contextSize > 0 ? contextSize : 16384;
  return Math.min(2048, Math.max(512, Math.floor(context / 3)));
}

// Consume structured output without exposing partial JSON or private reasoning.
// A prompt can take longer than a token; both phases have explicit deadlines.
export async function streamAction({ url, token, messages, schema, controller, maxTokens = 2048, onProgress = () => {}, fetcher = fetch, firstTokenMs = 180000, stallMs = 45000, deadlineMs = 300000, progressMs = 1000 }) {
  const started = Date.now();
  let lastToken = started, received = 0, content = '', pending = '', finishReason, completed = false, failure;
  const fail = message => { failure = new Error(message); controller.abort(); };
  const deadline = setTimeout(() => fail('The model exceeded five minutes for one action. Saved files remain. Try a smaller model or a shorter task.'), deadlineMs);
  let watchdog = setTimeout(() => fail('The model produced no output before the prompt timeout. Saved files remain. Try a smaller model or context window.'), firstTokenMs);
  const progress = setInterval(() => onProgress({ elapsedSeconds: Math.floor((Date.now() - started) / 1000), characters: received, stalledSeconds: Math.floor((Date.now() - lastToken) / 1000) }), progressMs);
  const line = raw => {
    if (!raw.startsWith('data:')) return;
    const data = raw.slice(5).trim();
    if (data === '[DONE]') { completed = true; return; }
    if (!data) return;
    let item;
    try { item = JSON.parse(data); } catch { throw new Error('The model runtime returned an invalid stream. Reload the model and retry.'); }
    if (item.error) throw new Error(item.error.message || 'Local inference failed.');
    const choice = item.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const delta = choice?.delta?.content;
    // Never forward reasoning_content to the UI or conversation history.
    if (typeof delta === 'string' && delta) {
      content += delta; received += delta.length; lastToken = Date.now();
      if (received > 128000) throw new Error('The model exceeded the safe action size.');
      clearTimeout(watchdog);
      watchdog = setTimeout(() => fail('The model stopped generating for 45 seconds. The task was stopped; saved files remain. Try a smaller model or reload it.'), stallMs);
    }
  };
  try {
    const response = await fetcher(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, signal: controller.signal,
      // llama.cpp also accepts the native top-level schema. Keep it present so
      // templates without a generated grammar still constrain the sampler.
      body: JSON.stringify({ messages, stream: true, temperature: 0.2, max_tokens: maxTokens, chat_template_kwargs: { enable_thinking: false }, json_schema: schema, response_format: { type: 'json_schema', json_schema: { name: 'agent_action', strict: true, schema } } }),
    });
    if (!response.ok) throw new Error(`Local model request failed (${response.status}): ${(await response.text()).slice(0, 1000)}`);
    if (!response.body) throw new Error('The model runtime returned no response stream.');
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true });
      if (pending.length > 256000) throw new Error('The model runtime returned an oversized stream record.');
      const lines = pending.split('\n'); pending = lines.pop();
      for (const entry of lines) line(entry);
      if (completed) break;
    }
    if (pending.trim()) line(pending);
    if (controller.signal.aborted) throw failure || new DOMException('Stopped.', 'AbortError');
    if (!completed && !finishReason) throw new Error('The model response was interrupted. No partial action was applied.');
    // A token-limit finish can still contain a complete object. Accept that
    // object rather than discarding useful output and generating it again.
    // Truncated JSON is never repaired or applied by the host.
    try {
      const action = JSON.parse(content);
      if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error('Expected an object');
      return action;
    } catch {
      if (finishReason === 'length') throw new ActionFormatError('Action reached the output limit. Use write_file for a small first section, then append_file for the remaining sections. Keep each content chunk under 3,000 characters.');
      throw new ActionFormatError('The model did not return a complete JSON tool action. Return one short, valid action.');
    }
  } catch (error) { throw failure || error; }
  finally { clearTimeout(deadline); clearTimeout(watchdog); clearInterval(progress); }
}
