// Keep conversational requirements separate from disposable tool observations.
// Only user/assistant text crosses this boundary; renderer metadata is ignored.
export function conversationContext(history) {
  if (!Array.isArray(history)) return [];
  let remaining = 24000;
  const result = [];
  for (const message of history.slice(-24).reverse()) {
    if (!message || message.failed || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') continue;
    const content = message.content.slice(0, Math.min(remaining, message.role === 'user' ? 10000 : 1500));
    if (content.trim()) result.unshift({ role: message.role, content });
    remaining -= content.length;
    if (!remaining) break;
  }
  return result;
}
