import { scopedPath, writeScoped } from './scoped-files.mjs';
import fs from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";

const quantNames = {
  0: "F32",
  1: "F16",
  2: "Q4_0",
  3: "Q4_1",
  7: "Q8_0",
  8: "Q5_0",
  9: "Q5_1",
  10: "Q2_K",
  11: "Q3_K_S",
  12: "Q3_K_M",
  13: "Q3_K_L",
  14: "Q4_K_S",
  15: "Q4_K_M",
  16: "Q5_K_S",
  17: "Q5_K_M",
  18: "Q6_K",
  19: "IQ2_XXS",
  20: "IQ2_XS",
  21: "Q2_K_S",
  22: "IQ3_XS",
  23: "IQ3_XXS",
  24: "IQ1_S",
  25: "IQ4_NL",
  26: "IQ3_S",
  27: "IQ3_M",
  28: "IQ2_S",
  29: "IQ2_M",
  30: "IQ4_XS",
  31: "IQ1_M",
  32: "BF16",
  36: "TQ1_0",
  37: "TQ2_0",
  38: "MXFP4_MOE",
  39: "NVFP4",
  40: "Q1_0",
  41: "Q2_0",
};
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
// Increase when inspection changes so existing imports acquire corrected estimates.
export const GGUF_METADATA_VERSION = 2;

function modelCacheLayout(meta) {
  const architecture = meta['general.architecture'];
  const prefix = key => meta[`${architecture}.${key}`];
  const layerCount = prefix('block_count');
  const nextN = prefix('nextn_predict_layers') || 0;
  if (!Number.isInteger(layerCount) || layerCount <= 0 || layerCount > 8192 || !Number.isInteger(nextN) || nextN < 0 || nextN >= layerCount) return null;
  const trunkLayers = layerCount - nextN;
  const hybrid = ['qwen35', 'qwen35moe', 'qwen3next'].includes(architecture);
  const recurrentFlags = prefix('attention.recurrent_layers');
  const fullAttentionInterval = prefix('full_attention_interval') || 4;
  if (hybrid && (!Number.isInteger(fullAttentionInterval) || fullAttentionInterval <= 0 || (Array.isArray(recurrentFlags) && recurrentFlags.length < trunkLayers))) return null;
  const perLayer = (value, layer) => Array.isArray(value) ? value[layer] : value;
  let attentionLayers = 0, recurrentLayers = 0, kvBytesPerToken = 0;
  for (let layer = 0; layer < trunkLayers; layer++) {
    const recurrent = hybrid && (Array.isArray(recurrentFlags) ? Boolean(recurrentFlags[layer]) : (layer + 1) % fullAttentionInterval !== 0);
    if (recurrent) { recurrentLayers++; continue; }
    const heads = perLayer(prefix('attention.head_count'), layer);
    const kvHeads = perLayer(prefix('attention.head_count_kv'), layer);
    const embedding = prefix('embedding_length');
    const keyDim = perLayer(prefix('attention.key_length'), layer) || embedding / heads;
    const valueDim = perLayer(prefix('attention.value_length'), layer) || embedding / heads;
    if (![heads, kvHeads, keyDim, valueDim].every(n => Number.isFinite(n) && n > 0)) return null;
    attentionLayers++;
    // Q8_0 stores a 2-byte scale with each 32-byte block, independently for K/V.
    kvBytesPerToken += (Math.ceil(kvHeads * keyDim / 32) + Math.ceil(kvHeads * valueDim / 32)) * 34;
  }
  let recurrentBytes = 0;
  if (recurrentLayers) {
    const convolution = prefix('ssm.conv_kernel'), inner = prefix('ssm.inner_size');
    const state = prefix('ssm.state_size'), groups = prefix('ssm.group_count');
    if (![convolution, inner, state, groups].every(n => Number.isInteger(n) && n > 0)) return null;
    // llama.cpp qwen35 uses F32 R/S state per recurrent layer, one sequence.
    // This state is independent of token context; server checkpoints duplicate it.
    recurrentBytes = recurrentLayers * 4 * ((convolution - 1) * (inner + 2 * groups * state) + state * inner);
  }
  return { attentionLayers, recurrentLayers, trunkLayers, kvBytesPerToken, recurrentBytes, cacheType: 'q8_0', sequences: 1 };
}

export async function inspectGGUF(file) {
  if (!path.isAbsolute(file) || path.extname(file).toLowerCase() !== ".gguf")
    throw new Error("Select a .gguf file using its full path.");
  const actual = await fs.realpath(file);
  const stat = await fs.stat(actual);
  if (!stat.isFile()) throw new Error("This location is not a model file.");
  const handle = await fs.open(actual, "r");
  let data;
  try {
    data = Buffer.alloc(Math.min(stat.size, 16 * 1024 * 1024));
    await handle.read(data, 0, data.length, 0);
  } finally {
    await handle.close();
  }
  if (data.length < 24 || data.toString("ascii", 0, 4) !== "GGUF")
    throw new Error("This file does not have a valid GGUF header.");
  const version = data.readUInt32LE(4);
  if (![2, 3].includes(version))
    throw new Error(
      `GGUF version ${version} is not supported by this importer.`,
    );
  const count = Number(data.readBigUInt64LE(16));
  if (count > 100000) throw new Error("Invalid GGUF metadata count.");
  let offset = 24;
  const ensure = (n) => {
    if (offset + n > data.length || n < 0)
      throw new RangeError("Metadata exceeds inspection buffer");
  };
  const u32 = () => {
    ensure(4);
    const n = data.readUInt32LE(offset);
    offset += 4;
    return n;
  };
  const u64 = () => {
    ensure(8);
    const n = Number(data.readBigUInt64LE(offset));
    offset += 8;
    return n;
  };
  const str = () => {
    const n = u64();
    ensure(n);
    const v = data.toString("utf8", offset, offset + n);
    offset += n;
    return v;
  };
  const value = (type, depth = 0) => {
    if (depth > 2) throw new Error("Invalid nested GGUF metadata.");
    if (type === 8) return str();
    if (type === 9) {
      const t = u32(),
        n = u64();
      if (n > 2e6) throw new RangeError();
      // Preserve small numeric architecture arrays (e.g. recurrent layer flags),
      // while skipping the large tokenizer arrays without retaining them.
      const retained = t !== 8 && t !== 9 && n <= 8192 ? [] : null;
      for (let i = 0; i < n; i++) { const item = value(t, depth + 1); if (retained) retained.push(item); }
      return retained;
    }
    const sizes = [1, 1, 2, 2, 4, 4, 4, 1, 0, 0, 8, 8, 8];
    const size = sizes[type];
    if (!size) throw new Error("Invalid GGUF metadata type.");
    ensure(size);
    let n;
    switch (type) {
      case 0: n = data.readUInt8(offset); break;
      case 1: n = data.readInt8(offset); break;
      case 2: n = data.readUInt16LE(offset); break;
      case 3: n = data.readInt16LE(offset); break;
      case 4: n = data.readUInt32LE(offset); break;
      case 5: n = data.readInt32LE(offset); break;
      case 6: n = data.readFloatLE(offset); break;
      case 7: n = Boolean(data.readUInt8(offset)); break;
      case 10: n = Number(data.readBigUInt64LE(offset)); break;
      case 11: n = Number(data.readBigInt64LE(offset)); break;
      case 12: n = data.readDoubleLE(offset); break;
    }
    offset += size;
    return n;
  };
  const meta = {};
  try {
    for (let i = 0; i < count; i++) {
      const k = str();
      const v = value(u32());
      if (v !== null) meta[k] = v;
    }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
  }
  const filename = path.basename(actual);
  const cacheLayout = modelCacheLayout(meta);
  const split = filename.match(/-(\d{5})-of-(\d{5})\.gguf$/i);
  let size = stat.size;
  const sourceFiles = [{ path: actual, size: stat.size, mtimeMs: stat.mtimeMs }];
  if (split) {
    if (split[1] !== "00001")
      throw new Error(
        "For a split model, select the first shard (00001-of-…).",
      );
    const total = Number(split[2]);
    if (total > 1000) throw new Error("Invalid split model shard count.");
    for (let i = 2; i <= total; i++) {
      const sibling = actual.replace(
        /-\d{5}-of-(\d{5})\.gguf$/i,
        `-${String(i).padStart(5, "0")}-of-$1.gguf`,
      );
      try {
        const s = await fs.stat(sibling);
        if (!s.isFile()) throw new Error();
        size += s.size;
        sourceFiles.push({ path: sibling, size: s.size, mtimeMs: s.mtimeMs });
      } catch {
        throw new Error(
          `Missing model shard ${i} of ${total}. Keep all shards in the same folder.`,
        );
      }
    }
  }
  return {
    id: hash(actual).slice(0, 16),
    path: actual,
    filename,
    name: filename.replace(/\.gguf$/i, ""),
    metadataName: meta["general.name"] || null,
    size,
    architecture: meta["general.architecture"] || "GGUF",
    quantization:
      quantNames[meta["general.file_type"]] ||
      filename.match(/(?:IQ|Q)\d[^. -]*/i)?.[0] ||
      "Unknown",
    parameters:
      meta["general.size_label"] ||
      filename.match(/\b\d+(?:\.\d+)?B\b/i)?.[0] ||
      null,
    kvBytesPerToken: cacheLayout?.kvBytesPerToken ?? null,
    recurrentBytes: cacheLayout?.recurrentBytes ?? null,
    cacheLayout,
    metadataVersion: GGUF_METADATA_VERSION,
    sourceMtimeMs: stat.mtimeMs,
    sourceFiles,
    context: meta[`${meta["general.architecture"]}.context_length`] || null,
    available: true,
    addedAt: Date.now(),
  };
}

export class ModelLibrary extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.data = { models: [], folders: [], ignored: [], binary: null };
    this.watchers = [];
    this.queue = Promise.resolve();
  }
  async init() {
    try {
      Object.assign(
        this.data,
        JSON.parse(await fs.readFile(this.file, "utf8")),
      );
    } catch (e) {
      if (e.code !== "ENOENT")
        throw new Error(
          "The model library could not be read. Your model files are untouched.",
        );
    }
    await this.refresh();
    this.watchFolders();
    return this.data;
  }
  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(`${this.file}.tmp`, JSON.stringify(this.data, null, 2));
    await fs.rename(`${this.file}.tmp`, this.file);
    this.emit("change", this.data);
  }
  serialize(fn) {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  async add(file) {
    return this.serialize(async () => {
      const model = await inspectGGUF(file);
      const existing = this.data.models.find((x) => x.id === model.id);
      this.data.models = this.data.models.filter((x) => x.id !== model.id);
      this.data.models.push({ ...model, name: existing?.name || model.name });
      this.data.ignored = this.data.ignored.filter((x) => x !== model.path);
      await this.save();
      return model;
    });
  }
  async addFolder(folder) {
    const actual = await fs.realpath(folder);
    if (!(await fs.stat(actual)).isDirectory())
      throw new Error("Choose a folder.");
    await this.serialize(async () => {
      if (!this.data.folders.includes(actual)) this.data.folders.push(actual);
      await this.save();
    });
    await this.refresh();
    this.watchFolders();
    return this.data;
  }
  async remove(id) {
    return this.serialize(async () => {
      const m = this.data.models.find((x) => x.id === id);
      if (m) this.data.ignored.push(m.path);
      this.data.models = this.data.models.filter((x) => x.id !== id);
      await this.save();
    });
  }
  async removeFolder(folder) {
    return this.serialize(async () => {
      this.data.folders = this.data.folders.filter((x) => x !== folder);
      await this.save();
      this.watchFolders();
    });
  }
  async rename(id, name) {
    return this.serialize(async () => {
      const m = this.data.models.find((x) => x.id === id);
      if (!m || typeof name !== "string" || !name.trim())
        throw new Error("Enter a model name.");
      m.name = name.trim().slice(0, 120);
      await this.save();
    });
  }
  async setBinary(file) {
    return this.serialize(async () => {
      await fs.access(file, 1);
      this.data.binary = file;
      await this.save();
    });
  }
  async refresh() {
    return this.serialize(async () => {
      const errors = [];
      let visited = 0;
      const walk = async (dir, depth = 0) => {
        if (depth > 6 || visited > 20000) return;
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          errors.push(`Folder unavailable: ${dir}`);
          return;
        }
        for (const e of entries) {
          if (++visited > 20000) break;
          if (e.name.startsWith(".") || e.name === "node_modules") continue;
          const f = path.join(dir, e.name);
          if (e.isDirectory()) await walk(f, depth + 1);
          else if (
            e.isFile() &&
            /\.gguf$/i.test(e.name) &&
            !/-0*(?:[2-9]|[1-9]\d+)-of-\d+\.gguf$/i.test(e.name)
          ) {
            if (
              this.data.models.some((x) => x.path === f) ||
              this.data.ignored.includes(f)
            )
              continue;
            try {
              this.data.models.push(await inspectGGUF(f));
            } catch (error) {
              errors.push(`${e.name}: ${error.message}`);
            }
          }
        }
      };
      for (const folder of this.data.folders) await walk(folder);
      for (const m of this.data.models) {
        try {
          const sources = m.sourceFiles?.length ? m.sourceFiles : [{ path: m.path, size: m.size, mtimeMs: m.sourceMtimeMs }];
          const stats = await Promise.all(sources.map(source => fs.stat(source.path)));
          m.available = stats.every(s => s.isFile());
          if (m.available && (m.metadataVersion !== GGUF_METADATA_VERSION || sources.some((source, i) => source.mtimeMs !== stats[i].mtimeMs || source.size !== stats[i].size))) {
            const inspected = await inspectGGUF(m.path);
            Object.assign(m, inspected, { name: m.name || inspected.name, addedAt: m.addedAt || inspected.addedAt });
          }
        } catch {
          m.available = false;
        }
      }
      this.data.scanErrors = errors;
      await this.save();
      return this.data;
    });
  }
  watchFolders() {
    this.watchers.forEach((x) => x.close());
    this.watchers = [];
    clearInterval(this.poll);
    for (const folder of this.data.folders) {
      try {
        const watcher = watch(folder, { recursive: true }, () => {
          clearTimeout(this.timer);
          this.timer = setTimeout(() => this.refresh().catch(() => {}), 1500);
        });
        watcher.on("error", () => watcher.close());
        this.watchers.push(watcher);
      } catch {}
    }
    if (this.data.folders.length) {
      this.poll = setInterval(() => this.refresh().catch(() => {}), 300000);
      this.poll.unref();
    }
  }
  close() {
    clearTimeout(this.timer);
    clearInterval(this.poll);
    this.watchers.forEach((x) => x.close());
  }
}

export class Workspace {
  constructor() {
    this.root = null;
    this.versions = new Map();
    this.checkpoints = new Map();
  }
  async open(folder) {
    this.root = await fs.realpath(folder);
    this.versions.clear();
    this.checkpoints.clear();
    return this.tree();
  }
  async create(relative, directory = false) {
    if(!this.root) throw new Error('Open a project first.');
    const target = await scopedPath(this.root, relative, {protect:false});
    if(directory) { await fs.mkdir(target, {recursive:false}); return {path:relative,directory:true}; }
    await writeScoped(this.root, relative, '', null, {protect:false});
    return this.read(relative);
  }
  async resolve(relative) {
    if (!this.root || typeof relative !== "string" || path.isAbsolute(relative))
      throw new Error("Open a workspace first and use a relative file path.");
    const actual = await fs.realpath(path.resolve(this.root, relative));
    const rel = path.relative(this.root, actual);
    if (rel.startsWith(".." + path.sep) || rel === ".." || path.isAbsolute(rel))
      throw new Error("This file is outside the opened workspace.");
    return actual;
  }
  async tree() {
    let n = 0;
    const walk = async (dir, depth = 0) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const out = [];
      for (const e of entries.sort(
        (a, b) =>
          Number(b.isDirectory()) - Number(a.isDirectory()) ||
          a.name.localeCompare(b.name),
      )) {
        if (
          [".git", "node_modules", "dist", ".DS_Store"].includes(e.name) ||
          e.isSymbolicLink() ||
          n++ > 2000
        )
          continue;
        const full = path.join(dir, e.name),
          relative = path.relative(this.root, full);
        out.push({
          name: e.name,
          path: relative,
          directory: e.isDirectory(),
          children:
            e.isDirectory() && depth < 5
              ? await walk(full, depth + 1)
              : undefined,
        });
      }
      return out;
    };
    return {
      root: this.root,
      name: path.basename(this.root),
      files: await walk(this.root),
    };
  }
  async read(relative) {
    const full = await this.resolve(relative),
      stat = await fs.stat(full);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
      throw new Error("Only text files up to 2 MB can be opened in this MVP.");
    const content = await fs.readFile(full, "utf8");
    if (content.includes("\0"))
      throw new Error("Binary files cannot be edited.");
    const version = hash(content);
    this.versions.set(full, version);
    return { path: relative, content, version };
  }
  async save(relative, content, expected) {
    if (
      typeof content !== "string" ||
      Buffer.byteLength(content) > 2 * 1024 * 1024
    )
      throw new Error("File content exceeds the 2 MB editor limit.");
    const full = await this.resolve(relative),
      previous = await fs.readFile(full, "utf8");
    if (!expected || hash(previous) !== expected)
      throw new Error(
        "This file changed on disk. Reopen it before saving to avoid overwriting external changes.",
      );
    const currentStat = await fs.stat(full);
    const temp = path.join(
      path.dirname(full),
      `.nexus-${crypto.randomUUID()}.tmp`,
    );
    try {
      await fs.writeFile(temp, content, { flag: "wx", mode: currentStat.mode });
      if (hash(await fs.readFile(full, "utf8")) !== expected)
        throw new Error(
          "This file changed while saving. Reopen it and try again.",
        );
      await fs.rename(temp, full);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
    const version = hash(content);
    this.versions.set(full, version);
    return { version };
  }
  async apply(relative, content, expected) {
    const full = await this.resolve(relative);
    const previous = await fs.readFile(full, "utf8");
    const result = await this.save(relative, content, expected);
    this.checkpoints.set(full, { previous, after: result.version });
    return result;
  }
  async undo(relative) {
    const full = await this.resolve(relative),
      c = this.checkpoints.get(full);
    if (!c)
      throw new Error(
        "No AI edit checkpoint exists for this file in this session.",
      );
    const result = await this.save(relative, c.previous, c.after);
    this.checkpoints.delete(full);
    return { ...result, content: c.previous };
  }
}
