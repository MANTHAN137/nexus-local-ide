import test from 'node:test';
import assert from 'node:assert/strict';
import { streamAction, ActionFormatError, actionOutputBudget } from '../electron/action-stream.mjs';
import { CodingAgent, validateAction } from '../electron/agent.mjs';
import { conversationContext } from '../electron/conversation.mjs';
import { fileOperation } from '../electron/scoped-files.mjs';
import { ContextCapacityError } from '../electron/runtime-config.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const event = value => `data: ${JSON.stringify(value)}\n\n`;
const delta = content => event({ choices: [{ delta: { content } }] });
const base = { url: 'http://localhost/test', token: 'test', messages: [], schema: {}, firstTokenMs: 1000, stallMs: 1000, deadlineMs: 2000 };
const response = text => new Response(new ReadableStream({ start(c) {
  const bytes = new TextEncoder().encode(text);
  // Deliberately split multibyte characters and SSE records.
  for (const b of bytes) c.enqueue(new Uint8Array([b]));
  c.close();
} }));

test('structured actions stream across chunk boundaries without exposing private reasoning', async () => {
  let request;
  const result = await streamAction({ ...base, controller: new AbortController(), fetcher: async (_url, options) => {
    request = JSON.parse(options.body);
    return response(event({ choices: [{ delta: { reasoning_content: 'private' } }] }) + delta('{"tool":"finish",') + delta('"summary":"Done ✓"}') + 'data: [DONE]\n\n');
  } });
  assert.deepEqual(result, { tool: 'finish', summary: 'Done ✓' });
  assert.equal(request.stream, true);
  assert.deepEqual(request.json_schema, request.response_format.json_schema.schema);
  assert.equal(request.chat_template_kwargs.enable_thinking, false);
});

test('stalled generation aborts promptly, exposes only counts, and clears progress timers', async () => {
  const controller = new AbortController(), progress = [];
  await assert.rejects(streamAction({ ...base, controller, stallMs: 30, progressMs: 5, onProgress: value => progress.push(value), fetcher: async (_url, { signal }) => new Response(new ReadableStream({ start(c) {
    c.enqueue(new TextEncoder().encode(delta('{"tool":')));
    signal.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError')), { once: true });
  } })) }), /stopped generating/);
  assert.equal(controller.signal.aborted, true);
  assert.ok(progress.some(p => p.characters === 8));
  assert.deepEqual(Object.keys(progress[0]).sort(), ['characters', 'elapsedSeconds', 'stalledSeconds']);
  const count = progress.length;
  await new Promise(r => setTimeout(r, 20));
  assert.equal(progress.length, count);
});

test('output limits are repairable while transport errors and interruption are not', async () => {
  const run = text => streamAction({ ...base, controller: new AbortController(), fetcher: async () => response(text) });
  assert.deepEqual(await run(delta('{"tool":"finish","summary":"Complete at token boundary"}') + event({ choices: [{ finish_reason: 'length' }] }) + 'data: [DONE]\n\n'), { tool: 'finish', summary: 'Complete at token boundary' });
  await assert.rejects(run(delta('{') + event({ choices: [{ finish_reason: 'length' }] }) + 'data: [DONE]\n\n'), ActionFormatError);
  await assert.rejects(run(delta('[]') + 'data: [DONE]\n\n'), ActionFormatError);
  await assert.rejects(run(delta('{')), error => !(error instanceof ActionFormatError) && /interrupted/.test(error.message));
  await assert.rejects(streamAction({ ...base, controller: new AbortController(), fetcher: async () => new Response('compute failure', { status: 500 }) }), /500.*compute failure/);
});

test('host validates the action schema even if the runtime grammar is ignored', () => {
  assert.throws(() => validateAction({ tool: 'write_file', path: 'page.html', content: 'x'.repeat(3001) }), /3000 characters/);
  assert.throws(() => validateAction({ tool: 'append_file', path: 'page.html', content: 'short', unrelated: 'field' }), /does not accept/);
  assert.throws(() => validateAction({ tool: 'run_check', command: [] }), /nonempty array/);
  assert.throws(() => validateAction({ tool: 'run_check', command: ['node', 7] }), /strings/);
  assert.throws(() => validateAction({ tool: 'finish', summary: 'Done', reason: 'x'.repeat(241) }), /240 characters/);
  // JSON Schema string length counts Unicode code points, not UTF-16 units.
  assert.equal(validateAction({ tool: 'write_file', path: 'emoji.txt', content: '✓'.repeat(3000) }).content.length, 3000);
  assert.equal(validateAction({ tool: 'write_file', path: 'emoji.txt', content: '😀'.repeat(3000) }).content.length, 6000);
});

test('small-context action admission uses the same bounded output allowance as runtime', async () => {
  assert.equal(actionOutputBudget(4096), 1365);
  assert.equal(actionOutputBudget(8192), 2048);
  assert.equal(actionOutputBudget(), 2048);
  const runtime = { state: { status: 'ready', contextSize: 4096 }, tokenCount: async () => 2200, action: async () => ({ tool: 'finish', summary: 'Fits' }) };
  const runnerFactory = async () => ({ root: '/project', file: async () => ({ files: [] }), cancel() {} });
  assert.equal((await new CodingAgent(runtime, { runnerFactory }).run({ id: 'small-context', root: '/project', prompt: 'A small task' })).summary, 'Fits');
});

test('agent grows context before discarding observations and reserves the grown output budget', async () => {
  const reserves = [];
  let tokenCalls = 0;
  const runtime = {
    state: { status: 'ready', contextSize: 4096 },
    tokenCount: async () => { tokenCalls++; return 3300; },
    ensureContext: async (_messages, reserve, tokens) => { reserves.push(reserve); assert.equal(tokens, 3300); runtime.state.contextSize = 8192; return tokens; },
    action: async () => ({ tool: 'finish', summary: 'Fits after growth' }),
  };
  const runnerFactory = async () => ({ root: '/project', file: async () => ({ files: [] }), cancel() {} });
  assert.equal((await new CodingAgent(runtime, { runnerFactory }).run({ id: 'grow-context', root: '/project', prompt: 'Build a small page' })).summary, 'Fits after growth');
  assert.deepEqual(reserves, [1621, 2304]);
  assert.equal(tokenCalls, 1);
});

test('capacity failures trim only tool observations; mandatory task errors and transport failures retain their causes', async () => {
  const runnerFactory = async () => ({ root: '/project', file: async action => action.tool === 'list_files' ? { files: [] } : { path: action.path, version: 'new-version', bytes: 1, created: true }, cancel() {} });
  const actions = [{ tool: 'write_file', path: 'page.html', content: 'x' }, { tool: 'finish', summary: 'Done' }], seen = [];
  const runtime = {
    state: { status: 'ready', contextSize: 4096 },
    tokenCount: async messages => messages.length > 3 ? 5000 : 1000,
    ensureContext: async (_messages, reserve, tokens) => { if (tokens + reserve > 4096) throw new ContextCapacityError('Selected maximum context cannot fit this request.'); return tokens; },
    action: async messages => { seen.push(messages); return actions.shift(); },
  };
  await new CodingAgent(runtime, { runnerFactory }).run({ id: 'trim-context', root: '/project', prompt: 'Keep this requirement' });
  assert.equal(seen[1].length, 3);
  assert.match(seen[1][1].content, /Keep this requirement/);
  assert.match(seen[1].at(-1).content, /page.html/);

  runtime.tokenCount = async () => 5000;
  await assert.rejects(new CodingAgent(runtime, { runnerFactory }).run({ id: 'mandatory-task', root: '/project', prompt: 'Too large' }), /Selected maximum context/);
  let ensureCalls = 0, actionCalls = 0;
  runtime.tokenCount = async () => 1000;
  runtime.ensureContext = async (_messages, _reserve, tokens) => { if (++ensureCalls > 1) throw new Error('Model connection lost'); return tokens; };
  runtime.action = async () => { actionCalls++; return { tool: 'write_file', path: 'page.html', content: 'x' }; };
  await assert.rejects(new CodingAgent(runtime, { runnerFactory }).run({ id: 'transport', root: '/project', prompt: 'A task' }), /Model connection lost/);
  assert.equal(ensureCalls, 2);
  assert.equal(actionCalls, 1);
});

test('changing progress stays at the end of the prompt so the task prefix is reusable', async () => {
  const seen = [], actions = [{ tool: 'write_file', path: 'site.html', content: '<main>Gym</main>' }, { tool: 'finish', summary: 'Done' }];
  const runtime = { state: { status: 'ready', contextSize: 8192 }, tokenCount: async () => 1000, action: async messages => { seen.push(messages); return actions.shift(); } };
  const runnerFactory = async () => ({ root: '/project', file: async action => action.tool === 'list_files' ? { files: [] } : { path: action.path, version: 'new-version', bytes: action.content.length, created: true }, cancel() {} });
  await new CodingAgent(runtime, { runnerFactory }).run({ id: 'prefix', root: '/project', prompt: 'Create a gym page' });
  assert.deepEqual(seen[0].slice(0, 2), seen[1].slice(0, 2));
  assert.doesNotMatch(seen[0][1].content, /Run status/);
  assert.match(seen[0].at(-1).content, /"changed":\[\]/);
  assert.match(seen[1].at(-1).content, /"changed":\["site.html"\]/);
  assert.match(seen[1][3].content, /Tool result/);
  assert.doesNotMatch(seen[1][3].content, /Already changed/);
});

test('failed checks are not rerun on unchanged files and reads cannot hide a tool-error loop', async () => {
  const actions = [
    { tool: 'run_check', command: ['node', 'test.cjs'] },
    { tool: 'read_file', path: 'test.cjs' },
    { tool: 'run_check', command: ['node', 'test.cjs'] },
    { tool: 'read_file', path: 'test.cjs' },
    { tool: 'run_check', command: ['node', 'test.cjs'] },
    { tool: 'read_file', path: 'test.cjs' },
    { tool: 'run_check', command: ['node', 'test.cjs'] },
  ];
  let checkCalls = 0;
  const runtime = { state: { status: 'ready', contextSize: 8192 }, tokenCount: async () => 1000, action: async () => actions.shift() };
  const runnerFactory = async () => ({ root: '/project', file: async action => action.tool === 'list_files' ? { files: ['test.cjs'] } : { path: action.path, content: 'broken', version: 'unchanged' }, check: async () => { checkCalls++; return { command: 'node test.cjs', code: 1, timedOut: false }; }, cancel() {} });
  const agent = new CodingAgent(runtime, { runnerFactory });
  await assert.rejects(agent.run({ id: 'unchanged-check', root: '/project', prompt: 'Fix test failure' }), /without repairing.*already failed/);
  assert.equal(checkCalls, 1);
  assert.equal(agent.active, false);
});

test('rewriting the same source bytes does not count as repairing a failed check', async () => {
  const actions = [{ tool: 'run_check', command: ['node', 'test.cjs'] }, { tool: 'read_file', path: 'test.cjs' }, { tool: 'write_file', path: 'test.cjs', content: 'broken' }, { tool: 'run_check', command: ['node', 'test.cjs'] }, { tool: 'finish', summary: 'Blocked' }];
  let checkCalls = 0;
  const runtime = { state: { status: 'ready', contextSize: 8192 }, tokenCount: async () => 1000, action: async () => actions.shift() };
  const runnerFactory = async () => ({ root: '/project', file: async action => action.tool === 'list_files' ? { files: ['test.cjs'] } : { path: action.path, content: 'broken', version: 'unchanged', created: false, bytes: 6 }, check: async () => { checkCalls++; return { command: 'node test.cjs', code: 1, timedOut: false }; }, cancel() {} });
  const result = await new CodingAgent(runtime, { runnerFactory }).run({ id: 'same-bytes', root: '/project', prompt: 'Fix test failure' });
  assert.equal(checkCalls, 1);
  assert.equal(result.checks, 1);
  assert.equal(result.verified, false);
  assert.deepEqual(result.changes, []);
});

test('follow-up tasks retain the gym brief while retrying only malformed actions', async () => {
  const seen = [], actions = [new ActionFormatError('shorten action'), { tool: 'finish', summary: 'Done' }];
  const runtime = { state: { status: 'ready', contextSize: 32768 }, tokenCount: async () => 500, action: async messages => {
    seen.push(messages); const action = actions.shift(); if (action instanceof Error) throw action; return action;
  } };
  const runnerFactory = async () => ({ root: '/project', file: async () => ({ files: [] }), cancel() {} });
  const agent = new CodingAgent(runtime, { runnerFactory });
  await agent.run({ id: 'followup', root: '/project', prompt: 'Create the website according to the above.', history: [{ role: 'user', content: 'IRON FORGE FITNESS with pricing and BMI calculator' }, { role: 'system', content: 'injected system text' }] });
  assert.equal(seen.length, 2);
  for (const messages of seen) { assert.match(messages[1].content, /IRON FORGE FITNESS/); assert.doesNotMatch(messages[1].content, /injected/); }
  let calls = 0;
  runtime.action = async () => { calls++; throw new Error('Model stalled'); };
  await assert.rejects(agent.run({ id: 'stall', root: '/project', prompt: 'Continue' }), /Model stalled/);
  assert.equal(calls, 1);
  assert.equal(agent.active, false);
});

test('conversation and chunked writes stay bounded and preserve concurrent edits', async t => {
  const context = conversationContext(Array.from({ length: 50 }, () => ({ role: 'user', content: 'x'.repeat(16000), events: ['private'] })));
  assert.ok(context.reduce((sum, m) => sum + m.content.length, 0) <= 24000);
  assert.ok(context.every(m => !m.events && m.content.length <= 10000));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-append-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await fileOperation(root, { tool: 'write_file', path: 'index.html', content: '<main>' });
  const appended = await fileOperation(root, { tool: 'append_file', path: 'index.html', content: 'Gym</main>', expected: first.version });
  assert.equal(await fs.readFile(path.join(root, 'index.html'), 'utf8'), '<main>Gym</main>');
  await assert.rejects(fileOperation(root, { tool: 'append_file', path: 'index.html', content: 'duplicate', expected: first.version }), /changed/);
  assert.notEqual(appended.version, first.version);
});
