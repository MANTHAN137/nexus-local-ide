export class ContextCapacityError extends Error {}

export class ModelLoadGate {
  busy = false;
  epoch = 0;
  cancel() { this.epoch++; }
  async run(work) {
    if (this.busy) throw new Error('A model is already loading.');
    this.busy = true;
    const ticket = this.epoch;
    const isCurrent = () => ticket === this.epoch;
    try { return await work(isCurrent); }
    finally { this.busy = false; }
  }
}

export function runtimeMatches(state, modelId, contextLimit, powerMode, minimumContext = 4096, memoryPolicy = 'protect', executionMode = 'auto') {
  return state.status === 'ready' && state.modelId === modelId &&
    state.contextLimit === contextLimit && state.powerMode === powerMode && state.memoryPolicy === memoryPolicy && state.executionMode === executionMode &&
    state.contextSize >= minimumContext;
}

export function runtimeArguments(model, port, context, powerMode, cores, gpuLayers = null, executionMode = 'auto') {
  const cool = powerMode === 'cool';
  const partial = Number.isInteger(gpuLayers) && gpuLayers >= 0;
  const cpuOnly = executionMode === 'cpu';
  return [
    '-m', model.path, '--host', '127.0.0.1', '--port', String(port),
    '-c', String(context), '-ngl', cpuOnly ? '0' : partial ? String(gpuLayers) : 'auto', '--flash-attn', 'on',
    ...(cpuOnly ? ['--device', 'none', '--fit', 'off', '--load-mode', 'mmap', '--no-kv-offload', '--no-repack', '--no-op-offload', '--no-warmup'] : partial ? ['--fit', 'off', '--load-mode', 'none', '--no-op-offload', '--no-repack'] : []),
    '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0',
    '--ctx-checkpoints', '1', '--batch-size', cool ? '128' : '256', '--ubatch-size', '64',
    '--threads', String(Math.min(cores, cool ? 2 : 4)),
    '--threads-batch', String(Math.min(cores, cool ? 2 : 4)),
    '--prio', cool ? '-1' : '0', '--poll', '0', '--poll-batch', '0',
    '--threads-http', '2', '--parallel', '1', '--offline', '--no-webui', '--cache-ram', '0',
    '--reasoning', 'off', '--reasoning-budget', '0',
  ];
}
