// Supervised, bounded speed comparison. It never writes into a user project.
import fs from 'node:fs/promises';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LocalRuntime, findRuntime } from '../electron/runtime.mjs';
import { runtimeArguments } from '../electron/runtime-config.mjs';
import { MemoryPressureGuard } from '../electron/memory-guard.mjs';
import { inspectGGUF } from '../electron/library.mjs';
import { memorySnapshot, modelAdmission } from '../electron/memory.mjs';

const exec = promisify(execFile);
const file = process.argv[2];
if (!file) throw new Error('Supply an existing GGUF file.');
const gpuMode = process.env.NEXUS_BENCH_GPU || 'current';
const powerMode = process.env.NEXUS_BENCH_POWER || 'cool';
if (!['full', 'current'].includes(gpuMode) || !['cool', 'balanced'].includes(powerMode)) throw new Error('Use NEXUS_BENCH_GPU=full|current and NEXUS_BENCH_POWER=cool|balanced.');
const binary = await findRuntime(process.env.NEXUS_LLAMA_BINARY);
if (!binary) throw new Error('llama-server was not found.');
const model = { id: 'bounded-speed-benchmark', path: file, ...await inspectGGUF(file) };
const prompt = 'Repeat the word hello one hundred times, separated by spaces.';
const outputLimit = 32, context = 4096;
let build;
try {
  const result = await exec(binary, ['--version'], { timeout: 5000, maxBuffer: 65536 });
  const output = (result.stdout + result.stderr).trim();
  build = { binary, output, buildNumber: output.match(/version:\s*(\d+)/i)?.[1] || null, commit: output.match(/\(([a-f0-9]{7,40})\)/i)?.[1] || null };
} catch (error) { build = { binary, failure: error.message }; }
const before = await memorySnapshot();
const admission = modelAdmission(model, context, before, { memoryPolicy: 'managed', executionMode: 'auto' });
let actualArguments, productionArguments, logs = '', peakRSS = 0, peakCompressed = before.compressedMemory || 0, lowestAvailable = before.availableMemory;
let runtime, samplePending, sampleFailure, strictWarning = null, timeout = false, interrupted = false, response, failure, safetyStop, readyState;
let loadedMs, recoveredMs, requestMs, stopFailure;
const controller = new AbortController();
const strictGuard = new MemoryPressureGuard({ baselineSwap: before.swapUsedMemory });
const argumentValue = (args, name) => args[args.indexOf(name) + 1];
const replaceArgument = (args, name, value) => {
  const result = [...args], index = result.indexOf(name);
  if (index < 0) result.push(name, String(value));
  else result[index + 1] = String(value);
  return result;
};
runtime = new LocalRuntime({ memoryPollInterval: 500, spawnProcess: (executable, args, options) => {
  // The injected spawn hook changes this benchmark only. Production arguments
  // remain the baseline, including reasoning, cache and worker settings.
  productionArguments = runtimeArguments(model, Number(argumentValue(args, '--port')), Number(argumentValue(args, '-c')), powerMode, os.cpus().length, runtime.state.gpuLayers, 'auto');
  if (JSON.stringify(args) !== JSON.stringify(productionArguments)) throw new Error('Benchmark arguments no longer match the production runtime configuration.');
  actualArguments = [...args];
  if (gpuMode === 'full') {
    actualArguments = replaceArgument(actualArguments, '-ngl', 999);
    actualArguments = replaceArgument(actualArguments, '--fit', 'off');
    actualArguments = replaceArgument(actualArguments, '--load-mode', 'none');
  }
  return spawn(executable, actualArguments, options);
} });
runtime.configure({ powerMode, memoryPolicy: 'managed', executionMode: 'auto', idleUnloadSeconds: 30 });
runtime.on('log', text => { logs = (logs + text).slice(-500000); });
runtime.on('memory-stop', notice => { safetyStop = notice; });
const started = Date.now();
const stop = async () => { try { await runtime.stop(); } catch (error) { stopFailure = error.message; } };
const abort = reason => { controller.abort(new Error(reason)); runtime.cancel(); void stop(); };
const onInterrupt = () => { interrupted = true; abort('Benchmark interrupted.'); };
process.once('SIGINT', onInterrupt); process.once('SIGTERM', onInterrupt);
const deadline = setTimeout(() => { timeout = true; abort('Benchmark exceeded its 90-second deadline.'); }, 90000);
const sample = () => {
  if (samplePending || !runtime.child) return;
  samplePending = (async () => {
    let snapshot;
    try {
      snapshot = await memorySnapshot(runtime.child?.pid);
      peakRSS = Math.max(peakRSS, snapshot.modelResidentMemory || 0);
      peakCompressed = Math.max(peakCompressed, snapshot.compressedMemory || 0);
      lowestAvailable = Math.min(lowestAvailable, snapshot.availableMemory);
    } catch (error) { sampleFailure = error.message; }
    // Production monitors OS-managed admission. Strict admission gets the same
    // guard here too, so a full-GPU override never bypasses memory safeguards.
    if (runtime.child && runtime.state.admissionMode !== 'os-managed') {
      const decision = strictGuard.evaluate(snapshot);
      strictWarning = decision.action === 'warn' ? decision.reason : null;
      if (decision.action === 'stop') { safetyStop = decision.reason; abort(`Memory safety stop: ${decision.reason}`); }
    }
  })().finally(() => { samplePending = null; });
};
const sampler = setInterval(sample, 500);
runtime.acquire();
console.log(JSON.stringify({ stage: 'admission', gpuMode, powerMode, model: model.name, admission, build }));
try {
  if (!admission.fits) throw new Error(admission.message);
  await runtime.start(model, binary, context);
  loadedMs = Date.now() - started;
  if (runtime.stopping) await runtime.stopping;
  if (runtime.state.status !== 'ready') throw new Error(safetyStop || runtime.state.notice || 'The model did not reach ready state.');
  await runtime.waitForMemoryRecovery();
  sample(); if (samplePending) await samplePending;
  while (strictWarning && runtime.child && !controller.signal.aborted) await new Promise(resolve => setTimeout(resolve, 250));
  if (controller.signal.aborted) throw controller.signal.reason;
  if (runtime.state.status !== 'ready') throw new Error(safetyStop || 'The model stopped before the request.');
  recoveredMs = Date.now() - started;
  readyState = { ...runtime.state };
  runtime.controller = controller;
  const requestStarted = Date.now();
  const result = await fetch(`${runtime.base}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${runtime.token}` },
    body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], max_tokens: outputLimit, temperature: 0, stream: false, cache_prompt: false, reasoning_budget_tokens: 0, chat_template_kwargs: { enable_thinking: false } }),
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]),
  });
  if (!result.ok) throw new Error((await result.text()).slice(0, 1000));
  const data = await result.json();
  requestMs = Date.now() - requestStarted;
  response = { content: data.choices?.[0]?.message?.content, finishReason: data.choices?.[0]?.finish_reason, usage: data.usage, timings: data.timings };
} catch (error) { failure = error.message; if (error.name === 'TimeoutError') timeout = true; }
finally {
  clearTimeout(deadline); clearInterval(sampler);
  if (samplePending) await samplePending;
  await stop(); runtime.release();
  process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onInterrupt);
  // Flush the runtime's coalesced last log record before saving the evidence.
  await new Promise(resolve => setTimeout(resolve, 120));
}
const after = await memorySnapshot();
const timings = response?.timings;
const cachedTokens = response?.usage?.prompt_tokens_details?.cached_tokens ?? timings?.cache_n;
const report = {
  gpuMode, powerMode, model: model.name, modelPath: file, quantization: model.quantization, architecture: model.architecture, build,
  context, outputLimit, prompt, coldPrompt: cachedTokens === 0, cachedTokens,
  elapsedMs: Date.now() - started, loadedMs, recoveredMs, requestMs, timeout, interrupted, response, failure, safetyStop, sampleFailure, stopFailure,
  metrics: timings ? { prefillTokens: timings.prompt_n, prefillMs: timings.prompt_ms, prefillTokensPerSecond: timings.prompt_per_second, decodeTokens: timings.predicted_n, decodeMs: timings.predicted_ms, decodeTokensPerSecond: timings.predicted_per_second } : null,
  admission, readyState, productionArguments, actualArguments, peakRSS, peakCompressed, lowestAvailable, before, after,
  unloaded: !runtime.child, outputLimitReached: response?.finishReason === 'length',
};
const stem = `27b-speed-${gpuMode}-${powerMode}`;
await fs.mkdir(new URL('../verification/', import.meta.url), { recursive: true });
await fs.writeFile(new URL(`../verification/${stem}.log`, import.meta.url), logs);
await fs.writeFile(new URL(`../verification/${stem}.json`, import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ stage: 'finished', report: `verification/${stem}.json`, metrics: report.metrics, failure, safetyStop, timeout, unloaded: report.unloaded }));
if (failure || timeout || interrupted || safetyStop || stopFailure || !response?.content) process.exitCode = 1;
