import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const GiB = 1024 ** 3;
export const CONTEXT_CHOICES = [0, 4096, 8192, 16384, 32768, 65536, 98304, 131072];

export function parseVMStat(text) {
  const page = Number(text.match(/page size of (\d+) bytes/)?.[1] || 4096);
  const pages = name => Number(text.match(new RegExp(`${name}:\\s+(\\d+)`))?.[1] || 0);
  return (pages('Pages free') + pages('Pages inactive') + pages('Pages speculative')) * page;
}

export function parseSwapUsage(text) {
  const match = text.match(/\bused\s*=\s*([\d.]+)([KMGT])\b/i);
  if (!match) return null;
  const value = Number(match[1]) * 1024 ** ('KMGT'.indexOf(match[2].toUpperCase()) + 1);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function parseVMStatDetails(text) {
  const page = Number(text.match(/page size of (\d+) bytes/)?.[1] || 4096);
  const bytes = name => Number(text.match(new RegExp(`${name}:\\s+(\\d+)`))?.[1] || 0) * page;
  const valid = /page size of \d+ bytes/.test(text) && Number.isSafeInteger(page) && page > 0 && ['Pages free', 'Pages inactive', 'Pages speculative', 'Pages wired down', 'Pages occupied by compressor'].every(name => {
    const value = text.match(new RegExp(`${name}:\\s+(\\d+)`))?.[1];
    return value !== undefined && Number.isSafeInteger(Number(value)) && Number(value) >= 0;
  });
  return {
    availableMemory: parseVMStat(text),
    wiredMemory: bytes('Pages wired down'),
    fileBackedMemory: bytes('File-backed pages'),
    compressedMemory: bytes('Pages occupied by compressor'),
    // Purgeable/file-backed pages overlap active/inactive pages. They must not
    // be added to availableMemory a second time, nor counted as free RAM.
    purgeableMemory: bytes('Pages purgeable'),
    valid,
  };
}

export async function memorySnapshot(pid) {
  const totalMemory = os.totalmem(), freeMemory = os.freemem();
  let availableMemory = freeMemory, pressure = 'unknown', modelResidentMemory = null, swapUsedMemory = null, details = {}, source = 'os';
  const results = await Promise.allSettled([
    process.platform === 'darwin' ? exec('/usr/bin/vm_stat', [], { timeout: 2000 }) : null,
    process.platform === 'darwin' ? exec('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { timeout: 2000 }) : null,
    pid ? exec('/bin/ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 2000 }) : null,
    process.platform === 'darwin' ? exec('/usr/sbin/sysctl', ['-n', 'vm.swapusage'], { timeout: 2000 }) : null,
  ]);
  if (results[0].status === 'fulfilled' && results[0].value) {
    details = parseVMStatDetails(results[0].value.stdout);
    if (details.valid && details.wiredMemory + details.compressedMemory <= totalMemory) {
      availableMemory = Math.min(totalMemory, details.availableMemory);
      source = 'darwin-vmstat';
    } else details = {};
  }
  if (results[1].status === 'fulfilled' && results[1].value) {
    const level = Number(results[1].value.stdout.trim());
    if (Number.isInteger(level) && level >= 1) pressure = level >= 4 ? 'critical' : level >= 2 ? 'warning' : 'normal';
  }
  if (results[2].status === 'fulfilled' && results[2].value) modelResidentMemory = Number(results[2].value.stdout.trim()) * 1024;
  if (results[3].status === 'fulfilled' && results[3].value) swapUsedMemory = parseSwapUsage(results[3].value.stdout);
  return { ...details, source, totalMemory, freeMemory, availableMemory, pressure, modelResidentMemory, swapUsedMemory, appMemory: process.memoryUsage().rss, sampledAt: Date.now() };
}

export function modelMemoryBreakdown(model, context, { checkpointCount = 1 } = {}) {
  if (!Number.isFinite(model.size) || model.size <= 0) throw new Error('Model size is unavailable. Refresh the library.');
  if (!Number.isInteger(context) || context <= 0) throw new Error('Invalid context window.');
  if (!Number.isInteger(checkpointCount) || checkpointCount < 0 || checkpointCount > 32) throw new Error('Invalid context checkpoint count.');
  const kvPerToken = Number.isFinite(model.kvBytesPerToken) && model.kvBytesPerToken >= 0 ? model.kvBytesPerToken : 64 * 1024;
  const hybrid = ['qwen35', 'qwen35moe', 'qwen3next'].includes(model.architecture);
  const recurrent = Number.isFinite(model.recurrentBytes) && model.recurrentBytes >= 0 ? model.recurrentBytes : hybrid ? 0.5 * GiB : 0;
  const result = {
    weights: Math.ceil(model.size),
    kv: Math.ceil(kvPerToken * context),
    recurrent: Math.ceil(recurrent),
    checkpoints: Math.ceil(recurrent * checkpointCount),
    compute: Math.ceil(0.75 * GiB),
    safetyMargin: Math.ceil(model.size * 0.1),
  };
  result.total = Object.values(result).reduce((sum, bytes) => sum + bytes, 0);
  return result;
}

export function estimateModelMemory(model, context, options) {
  return modelMemoryBreakdown(model, context, options).total;
}

// Admission is returned even on a failed fit, so the UI can show precisely what
// needs memory instead of presenting every failure as an unsupported model.
export function modelAdmission(model, requested, memory, { minimumContext = 4096, preferredContext = minimumContext, checkpointCount = 1, memoryPolicy = 'protect', executionMode = 'auto' } = {}) {
  if (!CONTEXT_CHOICES.includes(requested)) throw new Error('Invalid context window.');
  if (!Number.isFinite(model.size) || model.size <= 0) throw new Error('Model size is unavailable. Refresh the library.');
  if (![minimumContext, preferredContext].every(n => Number.isInteger(n) && n > 0)) throw new Error('Invalid automatic context requirements.');
  if (!['protect', 'managed'].includes(memoryPolicy)) throw new Error('Invalid model memory policy.');
  if (!['auto', 'cpu'].includes(executionMode)) throw new Error('Invalid processing mode.');
  if (![memory.totalMemory, memory.availableMemory].every(n => Number.isFinite(n) && n >= 0) || memory.totalMemory <= 0) throw new Error('System memory is unavailable. Try loading again after the next resource sample.');
  const availableMemory = Math.min(memory.totalMemory, memory.availableMemory);
  const reserve = Math.max(1.5 * GiB, memory.totalMemory * 0.08);
  const budget = Math.min(memory.totalMemory * 0.75, Math.max(0, availableMemory - reserve));
  const fresh = Number.isFinite(memory.sampledAt) && Date.now() - memory.sampledAt <= 5000 && memory.sampledAt <= Date.now() + 1000;
  const validPhysicalMetrics = [memory.wiredMemory, memory.compressedMemory].every(n => Number.isFinite(n) && n >= 0) && memory.wiredMemory + memory.compressedMemory <= memory.totalMemory;
  const canManage = memoryPolicy === 'managed' && memory.source === 'darwin-vmstat' && fresh && validPhysicalMetrics && memory.pressure === 'normal' && availableMemory >= reserve;
  // This ceiling only permits a monitored attempt. It does not claim actively
  // used app pages are free or predict how well future pages will compress.
  const physicalBudget = validPhysicalMetrics ? Math.min(memory.totalMemory * 0.75, Math.max(0, memory.totalMemory - memory.wiredMemory - memory.compressedMemory - reserve)) : null;
  // The setting is a ceiling, not an allocation. Grow only when the actual
  // prompt/output allowance requires it; a 64K cap still begins at 4K.
  const contextLimit = Math.min(requested || 32768, model.context || Infinity);
  const sizes = CONTEXT_CHOICES.filter(n => n >= minimumContext && n <= contextLimit);
  const target = sizes.find(n => n >= Math.max(minimumContext, preferredContext)) || sizes.at(-1);
  const choices = sizes.filter(n => n <= target).reverse();
  let context = choices.at(-1) || CONTEXT_CHOICES.find(n => n >= minimumContext) || minimumContext;
  let memoryBreakdown = modelMemoryBreakdown(model, context, { checkpointCount });
  const candidates = choices.map(candidate => ({ context: candidate, breakdown: modelMemoryBreakdown(model, candidate, { checkpointCount }) }));
  // Prefer smaller strictly fitting contexts before borrowing OS-managed RAM.
  const chosen = candidates.find(candidate => candidate.breakdown.total <= budget) || (canManage ? candidates.find(candidate => candidate.breakdown.total <= physicalBudget) : null);
  if (chosen) { context = chosen.context; memoryBreakdown = chosen.breakdown; }
  const shortfall = Math.max(0, memoryBreakdown.total - budget);
  const admissionMode = shortfall && canManage && memoryBreakdown.total <= physicalBudget ? 'os-managed' : 'strict';
  let status = 'ready', message = null;
  if (memory.pressure === 'critical') {
    status = 'critical-pressure';
    message = 'Memory pressure is critical. Close other memory-heavy apps before loading.';
  } else if (!choices.length) {
    status = 'context-too-small';
    message = `This task needs at least ${minimumContext} context tokens, above the ${contextLimit} token maximum. Increase the maximum context or shorten the conversation.`;
  } else if (shortfall && admissionMode !== 'os-managed') {
    status = 'insufficient-memory';
    const gb = value => (value / GiB).toFixed(1);
    message = `${model.name || 'This model'} at ${context / 1024}K context needs about ${gb(memoryBreakdown.total)} GB (${gb(memoryBreakdown.weights)} GB weights, ${gb(memoryBreakdown.kv + memoryBreakdown.recurrent + memoryBreakdown.checkpoints)} GB cache/state, ${gb(memoryBreakdown.compute + memoryBreakdown.safetyMargin)} GB working buffers and margin). The current safe budget is ${gb(budget)} GB from ${gb(availableMemory)} GB available after reserving ${gb(reserve)} GB for macOS. Free about ${gb(shortfall)} GB or shorten the conversation.`;
  } else if (admissionMode === 'os-managed') {
    message = `Model focused permits a monitored load within the physical RAM limit. macOS may compress background apps to cover the ${(shortfall / GiB).toFixed(1)} GB above the current available-memory budget. Those app pages are not free RAM; loading can still fail. Brief warning pressure may recover; critical or persistent pressure stops work.`;
  }
  let gpuLayers = null;
  const trunkLayers = model.trunkLayers ?? model.cacheLayout?.trunkLayers;
  if (status === 'ready' && executionMode === 'cpu') {
    gpuLayers = 0;
    message = (message || '') + ' CPU compatibility maps file-backed weights without Metal residency. CPU processing is slower.';
  } else if (status === 'ready' && admissionMode === 'os-managed' && Number.isInteger(trunkLayers) && trunkLayers > 0 && trunkLayers <= 8192) {
    const nonWeightMemory = memoryBreakdown.kv + memoryBreakdown.recurrent + memoryBreakdown.checkpoints + memoryBreakdown.compute + memoryBreakdown.safetyMargin;
    const gpuWeightRoom = Math.max(0, budget - nonWeightMemory);
    // This approximates per-layer weights. Full weights still count toward
    // physical admission; partial offload is not an additional fit guarantee.
    gpuLayers = Math.max(0, Math.min(trunkLayers - 1, Math.floor(trunkLayers * gpuWeightRoom / memoryBreakdown.weights)));
    message += ` Partial GPU offload uses approximately ${gpuLayers} of ${trunkLayers} layers, with the remainder on the CPU; generation may be slower.`;
  }
  return { fits: status === 'ready', status, message, admissionMode, memoryPolicy, executionMode, physicalBudget, gpuLayers, strictBudget: budget, strictShortfall: shortfall, context, contextLimit, requestedContext: requested, automatic: requested === 0, estimatedMemory: memoryBreakdown.total, requiredMemory: memoryBreakdown.total, availableMemory, totalMemory: memory.totalMemory, reserve, budget, shortfall, memoryBreakdown, minimumContext, preferredContext };
}

export function planModel(model, requested, memory, options) {
  const admission = modelAdmission(model, requested, memory, options);
  if (!admission.fits) {
    const error = new Error(admission.message);
    error.admission = admission;
    throw error;
  }
  return admission;
}
