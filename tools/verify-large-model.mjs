// Bounded, supervised hardware verification. Never writes into a user project.
import fs from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LocalRuntime } from '../electron/runtime.mjs';
import { inspectGGUF } from '../electron/library.mjs';
import { memorySnapshot, modelAdmission } from '../electron/memory.mjs';

const exec = promisify(execFile);
const file = process.argv[2];
if (!file) throw new Error('Supply an existing GGUF file.');
const model = { id: 'bounded-verification', path: file, ...await inspectGGUF(file) };
const cpuOnly = process.env.NEXUS_VERIFY_CPU === '1';
const before = await memorySnapshot();
const admission = modelAdmission(model, 4096, before, { memoryPolicy: 'managed', executionMode: cpuOnly ? 'cpu' : 'auto' });
console.log(JSON.stringify({ stage: 'admission', name: model.name, admission, before }));
if (!admission.fits) process.exit(2);
let logs = '', peakRSS = 0, peakCompressed = before.compressedMemory || 0, lowestAvailable = before.availableMemory, sampleBusy = false;
const runtime = new LocalRuntime({ memoryPollInterval: 250, spawnProcess: (binary, args, options) => spawn(binary, [...args, '-lv', '4'], options) });
runtime.configure({ powerMode: 'cool', memoryPolicy: 'managed', executionMode: cpuOnly ? 'cpu' : 'auto', idleUnloadSeconds: 30 });
runtime.on('log', text => { logs = (logs + text).slice(-250000); });
const started = Date.now();
let timeout = false, response, failure, safetyStop;
runtime.on('memory-stop', notice => { safetyStop = notice; console.log(JSON.stringify({ stage: 'safety-stop', notice })); });
const deadline = setTimeout(() => { timeout = true; runtime.stop().catch(() => {}); }, 60000);
const sampler = setInterval(async () => {
  if (sampleBusy) return; sampleBusy = true;
  try {
    const sample = await memorySnapshot(runtime.child?.pid);
    peakRSS = Math.max(peakRSS, sample.modelResidentMemory || 0);
    peakCompressed = Math.max(peakCompressed, sample.compressedMemory || 0);
    lowestAvailable = Math.min(lowestAvailable, sample.availableMemory);
  } finally { sampleBusy = false; }
}, 500);
try {
  await runtime.start(model, '/opt/homebrew/bin/llama-server', 4096);
  if (runtime.stopping) await runtime.stopping;
  if (runtime.state.status !== 'ready') throw new Error(safetyStop || runtime.state.notice || 'The model did not reach ready state.');
  runtime.acquire();
  console.log(JSON.stringify({ stage: 'ready', elapsedMs: Date.now() - started, state: runtime.state }));
  const result = await fetch(`${runtime.base}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${runtime.token}` },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'What is 2 plus 2? Reply with the digit only.' }], max_tokens: 8, temperature: 0, stream: false, reasoning_budget_tokens: 0, chat_template_kwargs: { enable_thinking: false } }),
    signal: AbortSignal.timeout(40000),
  });
  if (!result.ok) throw new Error((await result.text()).slice(0, 1000));
  const data = await result.json();
  response = { content: data.choices?.[0]?.message?.content, finishReason: data.choices?.[0]?.finish_reason, usage: data.usage, timings: data.timings };
} catch (error) { failure = error.message; }
finally { clearTimeout(deadline); clearInterval(sampler); await runtime.stop(); runtime.release(); }
const after = await memorySnapshot();
const swap = (await exec('/usr/sbin/sysctl', ['-n', 'vm.swapusage'])).stdout.trim();
const allocations = logs.split('\n').filter(line => /buffer size|KV.*size|cache.*size|Metal.*MB|compute.*MB|checkpoint|memory.*breakdown/i.test(line));
const report = { model: model.name, modelPath: file, cpuOnly, context: 4096, outputLimit: 8, elapsedMs: Date.now() - started, timeout, response, failure, safetyStop, peakRSS, peakCompressed, lowestAvailable, before, after, swap, allocations, unloaded: !runtime.child };
await fs.writeFile(new URL('../verification/large-model-runtime.log', import.meta.url), logs);
await fs.writeFile(new URL('../large-model-verification.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ stage: 'finished', ...report }));
if (failure || timeout || !response?.content) process.exitCode = 1;
