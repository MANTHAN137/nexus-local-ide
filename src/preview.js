import welcome from "../example-project/src/welcome.ts?raw";
import readme from "../example-project/README.md?raw";
// Browser previews are deliberately separate from native filesystem and inference.
export const isPreview = !window.nexus;
const files = {
  "src/welcome.ts": welcome,
  "README.md": readme,
  "package.json": '{\n  "name": "something-great",\n  "private": true\n}\n',
};
const data = {
  library: { models: [], folders: [], scanErrors: [] },
  runtime: { status: "idle", modelId: null },
  hardware: {
    cpu: "Desktop application",
    totalMemory: 0,
    freeMemory: 0,
    backend: "Detected in desktop app",
  },
  binary: null,
  workspace: {
    name: "Welcome",
    root: "Example workspace · browser preview",
    files: [
      {
        name: "src",
        path: "src",
        directory: true,
        children: [{ name: "welcome.ts", path: "src/welcome.ts" }],
      },
      { name: "README.md", path: "README.md" },
      { name: "package.json", path: "package.json" },
    ],
  },
};
const native = () => {
  throw new Error(
    "Open the Nexus desktop app to access local files and llama.cpp. This browser is a design preview.",
  );
};
export const api = window.nexus || {
  state: async () => data,
  create: native,
  runCheck: native,
  agent: native,
  setContext: native,
  setResources: native,
  setAgents: native,
  setMcp: native,
  on: () => () => {},
  read: async (path) => ({ path, content: files[path], version: "preview" }),
  save: async (path, text) => {
    files[path] = text;
    return { version: "preview" };
  },
  tree: async () => data.workspace,
  refresh: async () => data.library,
  addModel: native,
  addFolder: native,
  removeModel: native,
  removeFolder: native,
  renameModel: native,
  chooseBinary: native,
  load: native,
  unload: native,
  cancel: async () => {},
  openWorkspace: native,
  chat: native,
  apply: native,
  undo: native,
};
