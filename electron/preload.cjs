const { contextBridge, ipcRenderer } = require("electron");
const methods = {
  runCheck: "workspace:check",
  state: "app:state",
  setResources: "settings:resources",
  setAgents: "settings:agents",
  setMcp: "mcp:update",
  setContext: "settings:context",
  create: "workspace:create",
  agent: "agent:run",
  addModel: "library:add",
  addFolder: "library:folder",
  refresh: "library:refresh",
  removeModel: "library:remove",
  removeFolder: "library:remove-folder",
  renameModel: "library:rename",
  chooseBinary: "runtime:binary",
  load: "runtime:load",
  unload: "runtime:stop",
  cancel: "runtime:cancel",
  openWorkspace: "workspace:open",
  tree: "workspace:tree",
  read: "workspace:read",
  save: "workspace:save",
  apply: "workspace:apply",
  undo: "workspace:undo",
  chat: "chat:send",
};
const api = {};
for (const [name, channel] of Object.entries(methods))
  api[name] = (...args) => ipcRenderer.invoke(channel, ...args);
api.setDirty = (value) => ipcRenderer.invoke("app:dirty", value);
api.on = (event, callback) => {
  if (
    ![
      "resources:state",
      "mcp:state",
      "library:changed",
      "runtime:state",
      "runtime:log",
      "chat:token",
      "agent:event",
      "workspace:changed",
      "app:command",
    ].includes(event)
  )
    throw new Error("Unknown event");
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(event, listener);
  return () => ipcRenderer.removeListener(event, listener);
};
contextBridge.exposeInMainWorld("nexus", api);
