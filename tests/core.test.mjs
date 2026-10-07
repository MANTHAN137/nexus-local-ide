import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { inspectGGUF, ModelLibrary, Workspace } from "../electron/library.mjs";

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
function gguf() {
  const buffer = Buffer.alloc(24);
  buffer.write("GGUF");
  buffer.writeUInt32LE(3, 4);
  return buffer;
}

test("GGUF importer validates magic and versions, and preserves canonical file location", async (t) => {
  const dir = await fixture(t),
    file = path.join(dir, "qwen-27B-Q4_K_M.gguf");
  await fs.writeFile(file, gguf());
  const m = await inspectGGUF(file);
  assert.equal(m.path, await fs.realpath(file));
  assert.equal(m.parameters, "27B");
  assert.equal(m.quantization, "Q4_K_M");
  await fs.writeFile(file, "this is not a model");
  await assert.rejects(inspectGGUF(file), /valid GGUF/);
  const invalid = gguf();
  invalid.writeUInt32LE(100, 4);
  await fs.writeFile(file, invalid);
  await assert.rejects(inspectGGUF(file), /not supported/);
});
test("split GGUF requires the first shard and complete sibling files", async (t) => {
  const dir = await fixture(t),
    first = path.join(dir, "m-00001-of-00002.gguf"),
    second = path.join(dir, "m-00002-of-00002.gguf");
  await fs.writeFile(first, gguf());
  await assert.rejects(inspectGGUF(first), /Missing model shard/);
  await fs.writeFile(second, gguf());
  assert.equal((await inspectGGUF(first)).size, 48);
  await assert.rejects(inspectGGUF(second), /first shard/);
});
test("library watches sources, deduplicates imports and removes entries without deleting weights", async (t) => {
  const dir = await fixture(t),
    models = path.join(dir, "models");
  await fs.mkdir(models);
  const file = path.join(models, "model.gguf");
  await fs.writeFile(file, gguf());
  const library = new ModelLibrary(path.join(dir, "data", "library.json"));
  t.after(() => library.close());
  await library.init();
  await library.add(file);
  await library.add(file);
  await library.addFolder(models);
  assert.equal(library.data.models.length, 1);
  await library.remove(library.data.models[0].id);
  await library.refresh();
  assert.equal(library.data.models.length, 0);
  assert.equal((await fs.stat(file)).size, 24);
  await library.add(file);
  await library.rename(library.data.models[0].id, "My Qwen");
  assert.equal(library.data.models[0].name, "My Qwen");
  const second = path.join(models, "second.gguf");
  await fs.writeFile(second, gguf());
  await library.refresh();
  assert.equal(library.data.models.length, 2);
  await fs.rm(file);
  await library.refresh();
  assert.equal(
    library.data.models.find((m) => m.name === "My Qwen").available,
    false,
  );
  const persisted = new ModelLibrary(library.file);
  t.after(() => persisted.close());
  await persisted.init();
  assert.equal(persisted.data.models.length, 2);
  assert.equal(persisted.data.folders[0], await fs.realpath(models));
});
test("workspace blocks traversal and symlinks that escape the opened folder", async (t) => {
  const dir = await fixture(t),
    root = path.join(dir, "project");
  await fs.mkdir(root);
  await fs.writeFile(path.join(dir, "secret.txt"), "private");
  await fs.symlink(
    path.join(dir, "secret.txt"),
    path.join(root, "shortcut.txt"),
  );
  const w = new Workspace();
  await w.open(root);
  await assert.rejects(w.read("../secret.txt"), /outside/);
  await assert.rejects(w.read("shortcut.txt"), /outside/);
  await assert.rejects(w.read(path.join(dir, "secret.txt")), /relative/);
});
test("file saves reject external changes instead of overwriting them", async (t) => {
  const dir = await fixture(t),
    file = path.join(dir, "app.ts");
  await fs.writeFile(file, "original");
  const w = new Workspace();
  await w.open(dir);
  const initial = await w.read("app.ts");
  await fs.writeFile(file, "external");
  await assert.rejects(
    w.save("app.ts", "editor", initial.version),
    /changed on disk/,
  );
  assert.equal(await fs.readFile(file, "utf8"), "external");
});
test("AI edit checkpoints restore originals and refuse to overwrite subsequent changes", async (t) => {
  const dir = await fixture(t),
    file = path.join(dir, "app.ts");
  await fs.writeFile(file, "original");
  const w = new Workspace();
  await w.open(dir);
  const initial = await w.read("app.ts");
  await w.apply("app.ts", "AI suggestion", initial.version);
  assert.equal((await w.undo("app.ts")).content, "original");
  await w.apply("app.ts", "second suggestion", initial.version);
  await fs.writeFile(file, "later user edit");
  await assert.rejects(w.undo("app.ts"), /changed on disk/);
  assert.equal(await fs.readFile(file, "utf8"), "later user edit");
});
test("workspace rejects binary and oversized text files", async (t) => {
  const dir = await fixture(t);
  await fs.writeFile(path.join(dir, "binary.bin"), Buffer.from([0, 1, 2]));
  await fs.writeFile(
    path.join(dir, "large.txt"),
    Buffer.alloc(2 * 1024 * 1024 + 1, 65),
  );
  const w = new Workspace();
  await w.open(dir);
  await assert.rejects(w.read("binary.bin"), /Binary/);
  await assert.rejects(w.read("large.txt"), /2 MB/);
});
