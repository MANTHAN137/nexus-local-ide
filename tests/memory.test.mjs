import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GiB, modelAdmission, modelMemoryBreakdown, parseVMStatDetails, planModel } from '../electron/memory.mjs';
import { GGUF_METADATA_VERSION, inspectGGUF, ModelLibrary } from '../electron/library.mjs';

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
function string(s) { const b = Buffer.from(s); return Buffer.concat([u64(b.length), b]); }
function gguf(meta) {
  const pairs = Object.entries(meta).map(([key, value]) => {
    if (Array.isArray(value)) return Buffer.concat([string(key), u32(9), u32(7), u64(value.length), Buffer.from(value.map(Boolean).map(Number))]);
    return Buffer.concat([string(key), u32(typeof value === 'string' ? 8 : 4), typeof value === 'string' ? string(value) : u32(value)]);
  });
  return Buffer.concat([Buffer.from('GGUF'), u32(3), u64(0), u64(pairs.length), ...pairs]);
}
const qwenMeta = {
  'general.architecture': 'qwen35', 'general.file_type': 23,
  'qwen35.block_count': 65, 'qwen35.nextn_predict_layers': 1,
  'qwen35.context_length': 262144, 'qwen35.embedding_length': 5120,
  'qwen35.attention.head_count': 24, 'qwen35.attention.head_count_kv': 4,
  'qwen35.attention.key_length': 256, 'qwen35.attention.value_length': 256,
  'qwen35.full_attention_interval': 4, 'qwen35.ssm.conv_kernel': 4,
  'qwen35.ssm.inner_size': 6144, 'qwen35.ssm.state_size': 128, 'qwen35.ssm.group_count': 16,
};
async function modelFixture(t, meta = qwenMeta) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-memory-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'qwen-27B.gguf');
  await fs.writeFile(file, gguf(meta));
  return { dir, file, model: await inspectGGUF(file) };
}

test('Qwen hybrid GGUF counts only trunk attention KV and adds fixed recurrent state', async t => {
  const { model } = await modelFixture(t);
  assert.equal(model.cacheLayout.trunkLayers, 64);
  assert.equal(model.cacheLayout.attentionLayers, 16);
  assert.equal(model.cacheLayout.recurrentLayers, 48);
  assert.equal(model.kvBytesPerToken, 34816);
  assert.equal(model.recurrentBytes, 156893184);
  assert.equal(model.quantization, 'IQ3_XXS');
  const breakdown = modelMemoryBreakdown({ ...model, size: 10934860704 }, 4096);
  assert.equal(breakdown.kv, 142606336);
  assert.equal(breakdown.checkpoints, 156893184);
  assert.equal(modelMemoryBreakdown(model, 32768).recurrent, breakdown.recurrent);
});

test('GGUF boolean recurrent array overrides the default interval and excludes NextN', async t => {
  const flags = Array.from({ length: 65 }, (_, i) => i !== 3);
  const { model } = await modelFixture(t, { ...qwenMeta, 'qwen35.attention.recurrent_layers': flags });
  assert.equal(model.cacheLayout.attentionLayers, 1);
  assert.equal(model.cacheLayout.recurrentLayers, 63);
  assert.equal(model.kvBytesPerToken, 2176);
});

test('Auto uses task-sized context; required context cannot silently shrink', () => {
  const model = { size: 4 * GiB, kvBytesPerToken: 64 * 1024, context: 131072 };
  const memory = { totalMemory: 24 * GiB, availableMemory: 18 * GiB, pressure: 'normal' };
  assert.equal(planModel(model, 0, memory).context, 4096);
  const capped = planModel(model, 65536, memory);
  assert.equal(capped.context, 4096);
  assert.equal(capped.contextLimit, 65536);
  assert.equal(capped.requestedContext, 65536);
  assert.equal(planModel(model, 0, memory, { minimumContext: 8192 }).context, 8192);
  assert.equal(planModel(model, 0, memory, { minimumContext: 8192, preferredContext: 16384 }).context, 16384);
  assert.throws(() => planModel(model, 4096, memory, { minimumContext: 8192 }), /at least 8192/);
  assert.equal(modelAdmission(model, 0, { ...memory, availableMemory: 6.5 * GiB }, { minimumContext: 8192 }).fits, false);
});

test('27B admission distinguishes real current shortage from supported model capacity', async t => {
  const { model: metadata } = await modelFixture(t);
  const model = { ...metadata, size: 10934860704, name: 'Qwen 27B IQ3_XXS' };
  const memory = { totalMemory: 24 * GiB, availableMemory: 15 * GiB, pressure: 'normal' };
  const ready = planModel(model, 0, memory);
  assert.equal(ready.context, 4096);
  assert.ok(ready.requiredMemory < ready.budget);
  const low = modelAdmission(model, 0, { ...memory, availableMemory: 9 * GiB });
  assert.equal(low.status, 'insufficient-memory');
  assert.equal(low.shortfall, low.requiredMemory - low.budget);
  assert.match(low.message, /weights.*cache\/state.*macOS.*Free about/);
  assert.throws(() => planModel(model, 0, { ...memory, pressure: 'critical' }), /critical/);
  assert.equal(modelAdmission(model, 65536, memory, { minimumContext: 65536 }).fits, false);
});

test('VM cache and compressor details do not double count reclaimable memory', () => {
  const details = parseVMStatDetails('page size of 16384 bytes\nPages free: 100.\nPages inactive: 200.\nPages speculative: 50.\nPages wired down: 20.\nFile-backed pages: 300.\nPages purgeable: 30.\nPages occupied by compressor: 40.');
  assert.equal(details.availableMemory, 350 * 16384);
  assert.equal(details.fileBackedMemory, 300 * 16384);
  assert.equal(details.compressedMemory, 40 * 16384);
  assert.equal(details.purgeableMemory, 30 * 16384);
  assert.equal(details.wiredMemory, 20 * 16384);
  assert.equal(details.valid, true);
  assert.equal(parseVMStatDetails('Pages free: 100.').valid, false);
});

test('Model focused admits a monitored 27B trial without labelling active apps as free RAM', async t => {
  const { model: metadata } = await modelFixture(t);
  const model = { ...metadata, size: 10934860704 };
  const memory = { totalMemory: 24 * GiB, availableMemory: 8.5 * GiB, pressure: 'normal', wiredMemory: 3.2 * GiB, compressedMemory: 3.7 * GiB, source: 'darwin-vmstat', sampledAt: Date.now() };
  assert.equal(modelAdmission(model, 0, memory).fits, false);
  const managed = modelAdmission(model, 0, memory, { memoryPolicy: 'managed' });
  assert.equal(managed.fits, true);
  assert.equal(managed.admissionMode, 'os-managed');
  assert.ok(managed.strictShortfall > 0);
  assert.equal(managed.availableMemory, memory.availableMemory);
  assert.equal(managed.strictBudget, managed.budget);
  assert.ok(managed.requiredMemory <= managed.physicalBudget);
  assert.match(managed.message, /may compress background apps.*not free RAM/);
  assert.ok(Number.isInteger(managed.gpuLayers) && managed.gpuLayers >= 0 && managed.gpuLayers < 64);
  assert.match(managed.message, /Partial GPU offload.*remainder on the CPU.*slower/);
  for (const changes of [
    { pressure: 'warning' }, { pressure: 'unknown' }, { pressure: 'critical' },
    { wiredMemory: undefined }, { compressedMemory: undefined }, { source: 'os' },
    { sampledAt: Date.now() - 6000 }, { sampledAt: Date.now() + 5000 },
    { availableMemory: GiB }, { wiredMemory: 25 * GiB },
  ]) assert.equal(modelAdmission(model, 0, { ...memory, ...changes }, { memoryPolicy: 'managed' }).fits, false);
  assert.equal(modelAdmission({ ...model, size: 20 * GiB }, 0, memory, { memoryPolicy: 'managed' }).fits, false);
});

test('Model focused prefers a smaller strict allocation before using OS compression', () => {
  const model = { size: 4 * GiB, kvBytesPerToken: 128 * 1024 };
  const memory = { totalMemory: 24 * GiB, availableMemory: 7.8 * GiB, pressure: 'normal', wiredMemory: 3 * GiB, compressedMemory: 3 * GiB, source: 'darwin-vmstat', sampledAt: Date.now() };
  const admission = planModel(model, 0, memory, { preferredContext: 8192, memoryPolicy: 'managed' });
  assert.equal(admission.context, 4096);
  assert.equal(admission.admissionMode, 'strict');
  assert.equal(admission.gpuLayers, null);
});

test('partial GPU hint is bounded and does not discount full physical model weights', async t => {
  const { model: metadata } = await modelFixture(t);
  const model = { ...metadata, size: 10934860704 };
  const memory = { totalMemory: 24 * GiB, availableMemory: 8.5 * GiB, pressure: 'normal', wiredMemory: 3.2 * GiB, compressedMemory: 3.7 * GiB, source: 'darwin-vmstat', sampledAt: Date.now() };
  const options = { memoryPolicy: 'managed' };
  const admission = modelAdmission(model, 0, memory, options);
  const breakdown = admission.memoryBreakdown;
  const expected = Math.floor(64 * Math.max(0, admission.strictBudget - breakdown.kv - breakdown.recurrent - breakdown.checkpoints - breakdown.compute - breakdown.safetyMargin) / breakdown.weights);
  assert.equal(admission.gpuLayers, expected);
  assert.equal(breakdown.weights, model.size);
  assert.equal(admission.requiredMemory, modelMemoryBreakdown(model, 4096).total);
  assert.equal(modelAdmission(model, 0, { ...memory, availableMemory: 1.92 * GiB }, options).gpuLayers, 0);
  for (const invalid of [0, -1, 2.5, Infinity, 8193, '64']) assert.equal(modelAdmission({ ...model, trunkLayers: invalid }, 0, memory, options).gpuLayers, null);
  assert.equal(modelAdmission({ ...model, cacheLayout: null }, 0, memory, options).gpuLayers, null);
  assert.equal(modelAdmission({ ...model, size: 20 * GiB }, 0, memory, options).gpuLayers, null);
  assert.equal(modelAdmission(model, 4096, memory, { ...options, minimumContext: 8192 }).gpuLayers, null);
});

test('existing model library entries migrate incorrect GGUF estimates and retain user names', async t => {
  const { dir, file, model } = await modelFixture(t);
  const libraryFile = path.join(dir, 'library.json');
  await fs.writeFile(libraryFile, JSON.stringify({ models: [{ ...model, name: 'My model', addedAt: 42, kvBytesPerToken: 141440, metadataVersion: 1 }], folders: [] }));
  const library = new ModelLibrary(libraryFile);
  t.after(() => library.close());
  await library.init();
  assert.equal(library.data.models[0].kvBytesPerToken, 34816);
  assert.equal(library.data.models[0].metadataVersion, GGUF_METADATA_VERSION);
  assert.equal(library.data.models[0].name, 'My model');
  assert.equal(library.data.models[0].addedAt, 42);
  await fs.writeFile(file, gguf({ ...qwenMeta, 'qwen35.full_attention_interval': 8 }));
  await library.refresh();
  assert.equal(library.data.models[0].cacheLayout.attentionLayers, 8);
});

test('split GGUF refresh updates total weights and rejects missing secondary shards', async t => {
  const { dir } = await modelFixture(t);
  const first = path.join(dir, 'split-00001-of-00002.gguf'), second = path.join(dir, 'split-00002-of-00002.gguf');
  await fs.writeFile(first, gguf(qwenMeta));
  await fs.writeFile(second, Buffer.alloc(2048));
  const library = new ModelLibrary(path.join(dir, 'shards-library.json'));
  t.after(() => library.close());
  await library.add(first);
  const initialSize = library.data.models[0].size;
  await fs.writeFile(second, Buffer.alloc(4096));
  await library.refresh();
  assert.equal(library.data.models[0].size, initialSize + 2048);
  await fs.rm(second);
  await library.refresh();
  assert.equal(library.data.models[0].available, false);
});
