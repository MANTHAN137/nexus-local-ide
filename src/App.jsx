import React, { lazy, Suspense, useEffect, useRef, useState } from "react";
const Editor=lazy(()=>import('./CodeEditor').then(m=>({default:m.Editor})));
const DiffEditor=lazy(()=>import('./CodeEditor').then(m=>({default:m.DiffEditor})));
import {
  ArrowUp,
  ArrowUpRight,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Command,
  Cpu,
  Download,
  FileCode2,
  FilePlus2,
  Files,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Layers3,
  Loader2,
  Lock,
  MessageSquare,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  SquareTerminal,
  Trash2,
  Undo2,
  X,
  Braces,
  CheckCheck,
  Link2,
  AlertTriangle,
  Pencil,
  ExternalLink,
  CheckCircle2,
} from "lucide-react";
import { api, isPreview } from "./preview";
import { ResizeHandle, ResourceSettings, AgentSettings, MCPSettings, ActivityPanel, CheckTerminal, defaultAgents, contexts, contextLabel, memoryLabel } from './WorkbenchControls';

const gb = (n) => (n ? `${(n / 1024 ** 3).toFixed(1)} GB` : "—");
const shortPath = (p) => p?.replace(/^\/Users\/[^/]+/, "~") || "";
const lang = (p) =>
  ({
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    md: "markdown",
    py: "python",
    rs: "rust",
    css: "css",
    html: "html",
    go: "go",
    yml: "yaml",
    yaml: "yaml",
  })[p?.split(".").pop()] || "plaintext";
function Mark({ size = 27 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M7 23V9L25 23V9"
        stroke="currentColor"
        strokeWidth="3.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M15.5 6L20 9.5M12 22.5L16.5 26"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        opacity=".42"
      />
    </svg>
  );
}
function IconButton({
  icon: Icon,
  title,
  onClick,
  active = false,
  disabled = false,
}) {
  return (
    <button
      className={`icon-button ${active ? "active" : ""}`}
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon size={17} />
    </button>
  );
}
function Tag({ children, tone = "" }) {
  return <span className={`tag ${tone}`}>{children}</span>;
}
function FileIcon({ name }) {
  return (
    <span
      className={`file-type ${name.endsWith(".ts") ? "ts" : name.endsWith(".json") ? "json" : "md"}`}
    >
      {name.endsWith(".ts") ? (
        "TS"
      ) : name.endsWith(".json") ? (
        <Braces size={13} />
      ) : (
        <FileCode2 size={13} />
      )}
    </span>
  );
}
function FileTree({ nodes, active, onOpen, depth = 0 }) {
  const [closed, setClosed] = useState({});
  return nodes?.map((n) => (
    <React.Fragment key={n.path}>
      <button
        className={`tree-item ${active === n.path ? "selected" : ""}`}
        style={{ paddingLeft: 12 + depth * 15 }}
        onClick={() =>
          n.directory
            ? setClosed({ ...closed, [n.path]: !closed[n.path] })
            : onOpen(n.path)
        }
      >
        {n.directory ? (
          <>
            <ChevronRight
              size={12}
              className={!closed[n.path] ? "rotate" : ""}
            />
            <Folder size={14} />
          </>
        ) : (
          <>
            <span className="tree-spacer" />
            <FileIcon name={n.name} />
          </>
        )}
        <span>{n.name}</span>
      </button>
      {n.directory && !closed[n.path] && (
        <FileTree
          nodes={n.children}
          active={active}
          onOpen={onOpen}
          depth={depth + 1}
        />
      )}
    </React.Fragment>
  ));
}

export default function App() {
  const [data, setData] = useState(null),
    [view, updateView] = useState("models"),
    [library, setLibrary] = useState({ models: [], folders: [] }),
    [runtime, setRuntime] = useState({ status: "idle" }),
    [workspace, setWorkspace] = useState(null),
    [binary, setBinary] = useState(null);
  const [tabs, setTabs] = useState([]),
    [active, setActive] = useState(null),
    [showChat, setShowChat] = useState(true),
    [output, setOutput] = useState(false),
    [logs, setLogs] = useState(""),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all");
  const [modal, setModal] = useState(null),
    [pathInput, setPathInput] = useState(""),
    [toast, setToast] = useState(null),
    [busy, setBusy] = useState(false),
    [contextSize, setContextSize] = useState(0),
    [palette, setPalette] = useState(false),
    [paletteQuery, setPaletteQuery] = useState(""),
    [selector, setSelector] = useState(false);
  const [messages, setMessages] = useState([]),
    [prompt, setPrompt] = useState(""),
    [mode, setMode] = useState("agent"),
    [includeFile, setIncludeFile] = useState(false),
    [generating, setGenerating] = useState(false),
    [proposal, setProposal] = useState(null),
    [cursor, setCursor] = useState({ lineNumber: 1, column: 1 });
  const [preferences,setPreferences]=useState({idleUnloadSeconds:120,powerMode:'balanced',memoryPolicy:'protect',executionMode:'auto',agents:defaultAgents,selectedModel:null});
  const [resources,setResources]=useState(null),[mcp,setMcp]=useState({enabled:false,servers:[]}),[activity,setActivity]=useState([]),[terminalBusy,setTerminalBusy]=useState(false),[outputTab,setOutputTab]=useState('logs'),[showSidebar,setShowSidebar]=useState(window.innerWidth>1100);
  const [terminalState,setTerminalState]=useState({command:'npm test',output:'',running:false});
  const [layout,setLayout]=useState(()=>{try{const saved=JSON.parse(localStorage.getItem('nexus-layout')||'{}');return {sidebar:Math.max(10,Math.min(25,Number(saved.sidebar)||17)),chat:Math.max(20,Math.min(50,Number(saved.chat)||30)),output:Math.max(15,Math.min(65,Number(saved.output)||30))};}catch{return {sidebar:17,chat:30,output:30};}});
  useEffect(()=>{const media=window.matchMedia('(max-width:1100px)');const resize=()=>{if(media.matches)setShowSidebar(false);};media.addEventListener('change',resize);return()=>media.removeEventListener('change',resize);},[]);
  useEffect(()=>{const timer=setTimeout(()=>localStorage.setItem('nexus-layout',JSON.stringify(layout)),250);return()=>clearTimeout(timer);},[layout]);
  const setView=value=>{updateView(value);if(window.innerWidth<=700)setShowChat(false);};
  const changeLayout=(key,value)=>setLayout(previous=>({...previous,[key]:value}));
  const updateMcp=async value=>{const result=await api.setMcp(value);setMcp(result);return result;};
  const diffModels = useRef(null),
    editorRef = useRef(null),
    requestRef = useRef(null),
    messagesEnd = useRef(null),
    actionsRef = useRef({}),
    toastTimer = useRef(null),
    requestText = useRef(""),
    chatInput = useRef(null);
  const current = tabs.find((t) => t.path === active),
    selectedModel = library.models.find((m) => m.id === (preferences.selectedModel || runtime.modelId)),
    ready = runtime.status === "ready";
  function notify(message, type = "info") {
    setToast({ message, type });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 6500);
  }
  function error(e) {
    notify(
      (e?.message || String(e)).replace(
        /^Error invoking remote method '[^']+': (?:Error: )?/,
        "",
      ),
      "error",
    );
  }
  async function task(fn) {
    try {
      return await fn();
    } catch (e) {
      error(e);
      return null;
    }
  }
  async function openFile(file) {
    const existing = tabs.find((t) => t.path === file);
    if (existing) {
      setActive(file);
      setView("editor");
      return;
    }
    const result = await task(() => api.read(file));
    if (result) {
      setTabs((t) => [...t, {...result,saved:result.content}]);
      setActive(file);
      setView("editor");
    }
  }
  async function openProject() {
    if(generating||terminalBusy){notify("Stop the current task before changing folders.");return;}
    if (tabs.some((t) => t.content !== t.saved)) {
      setModal({ type: "discard-project" });
      return;
    }
    await doOpenProject();
  }
  async function doOpenProject() {
    const result = await task(() => api.openWorkspace());
    if (result) {
      setWorkspace(result);
      setTabs([]);
      setActive(null);
      setProposal(null);
      setMessages([]);setActivity([]);setTerminalState({command:'npm test',output:'',running:false});
      setView("editor");
      setModal(null);
    }
  }
  function newItem(directory=false) {
    if(generating){notify('Stop the agent before creating files manually.');return;}
    setPathInput('');setModal({type:'create',directory});
  }
  async function createItem() {
    setBusy(true);
    const result=await task(()=>api.create(pathInput.trim(),modal.directory));
    if(result){setWorkspace(await api.tree());setModal(null);if(!result.directory){setTabs(t=>[...t,{...result,saved:result.content}]);setActive(result.path);setView('editor');}notify(`${result.directory?'Folder':'File'} created.`, 'success');}
    setBusy(false);
  }
  async function refreshOpenFiles() {
    setWorkspace(await api.tree());
    const updated=await Promise.all(tabs.map(async t=>{try{const f=await api.read(t.path);return {...f,saved:f.content};}catch{return null;}}));
    setTabs(updated.filter(Boolean));
  }
  async function save() {
    if (!current) return;
    const result = await task(() =>
      api.save(current.path, current.content, current.version),
    );
    if (result) {
      setTabs((t) =>
        t.map((x) =>
          x.path === current.path
            ? { ...x, version: result.version, saved: current.content }
            : x,
        ),
      );
      notify("Saved to your workspace.", "success");
    }
  }
  function closeTab(file) {
    const t = tabs.find((x) => x.path === file);
    if (t.content !== t.saved) {
      setModal({ type: "close-tab", file });
      return;
    }
    doClose(file);
  }
  function doClose(file) {
    setTabs((t) => t.filter((x) => x.path !== file));
    if (active === file)
      setActive(tabs.find((x) => x.path !== file)?.path || null);
    setModal(null);
  }
  async function importModel(file) {
    setBusy(true);
    const result = await task(() => api.addModel(file));
    if (result) {
      setLibrary(result);
      setModal(null);
      setPathInput("");
      notify(
        "Model added. Its file stays in the original location.",
        "success",
      );
    }
    setBusy(false);
  }
  async function addFolder() {
    setBusy(true);
    const result = await task(() => api.addFolder());
    if (result) {
      setLibrary(result);
      setModal(null);
      notify(
        "Folder connected. New GGUF files will appear automatically.",
        "success",
      );
    }
    setBusy(false);
  }
  async function loadModel(model) {
    setSelector(false);
    setPreferences(p=>({...p,selectedModel:model.id}));
    const result = await task(() => api.load(model.id, contextSize));
    if (result?.status === "ready")
      notify(`${model.name} is ready. All inference stays local.`, "success");
  }
  async function sendMessage(text = prompt) {
    if (!text.trim() || generating || terminalBusy) return;
    if (!ready && !preferences.selectedModel && !preferences.agents.some(a=>a.enabled&&a.modelId)) {
      setView("models");
      notify("Add and load a local model to start a conversation.");
      return;
    }
    if (mode === "edit" && !current) {
      notify("Open a file before asking for an edit.");
      return;
    }
    if (mode === "edit" && current.content !== current.saved) {
      notify("Save your current changes before generating an edit.");
      return;
    }
    if(mode==='agent'&&!workspace?.agentGranted){notify('Choose the folder where Agent may create and edit files.');await openProject();return;}
    if(mode==='agent'&&tabs.some(t=>t.content!==t.saved)){notify('Save your open files before starting Agent.');return;}
    const id = crypto.randomUUID(),
      isEdit = mode === "edit",
      snapshot = current ? { ...current } : null;
    requestRef.current = id;
    requestText.current = "";
    setGenerating(true);setActivity([]);
    setPrompt("");
    setMessages((m) => [
      ...m.slice(-38),
      { role: "user", content: text },
      { role: "assistant", content: "", id, editing: isEdit, agent:mode==="agent",events:[] },
    ]);
    try {
      if(mode==='agent'){
        if(window.innerWidth>700)setView('editor');
        const result=await api.agent({id,prompt:text,history:messages.filter(m=>m.content&&!m.failed).map(({role,content})=>({role,content}))});
        setMessages(m=>m.map(x=>x.id===id?{...x,content:[result.summary,result.verification].filter(Boolean).join('\n\n'),stopped:result.cancelled,verified:result.verified}:x));
        return;
      }
      const result = await api.chat({
        id,
        prompt: text,
        mode,
        context: (includeFile || isEdit) && current ? current.content : "",
        history: messages.filter((m) => m.content),
      });
      if (result.cancelled) {
        setMessages((m) =>
          m.map((x) => (x.id === id ? { ...x, stopped: true } : x)),
        );
      } else if (isEdit) {
        const fenced = requestText.current.match(/```[^\n]*\n([\s\S]*?)```/);
        if (fenced) {
          setProposal({
            path: snapshot.path,
            original: snapshot.content,
            version: snapshot.version,
            modified: fenced[1].replace(/\n$/, "") + "\n",
          });
          setView("editor");
        } else
          notify(
            "The model did not return a complete fenced file. No changes were made.",
            "error",
          );
      }
    } catch (e) {
      error(e);
      setMessages((m) =>
        m.map((x) => (x.id === id ? { ...x, failed: true, content: x.content || e.message || "The task could not finish." } : x)),
      );
    } finally {
      if(mode==="agent") await refreshOpenFiles().catch(error);
      setMessages(m=>m.map(x=>x.id===id?{...x,events:x.events?.filter(e=>e.type!=='thinking')}:x));
      setGenerating(false);
      requestRef.current = null;
    }
  }
  async function applyProposal() {
    const t = tabs.find((t) => t.path === proposal.path);
    if (!t || t.content !== proposal.original) {
      notify(
        "The editor changed after this proposal was generated. Discard it and try again.",
        "error",
      );
      return;
    }
    const result = await task(() =>
      api.apply(proposal.path, proposal.modified, proposal.version),
    );
    if (result) {
      setTabs((t) =>
        t.map((x) =>
          x.path === proposal.path
            ? {
                ...x,
                content: proposal.modified,
                saved: proposal.modified,
                version: result.version,
                canUndo: true,
              }
            : x,
        ),
      );
      setActive(proposal.path);
      setProposal(null);
      notify(
        "Edit applied and saved. A session checkpoint is available.",
        "success",
      );
    }
  }
  async function undo() {
    if (!current) return;
    if (current.content !== current.saved) {
      notify(
        "Save or discard your current edits before restoring a checkpoint.",
      );
      return;
    }
    const result = await task(() => api.undo(current.path));
    if (result) {
      setTabs((t) =>
        t.map((x) =>
          x.path === current.path
            ? { ...x, ...result, saved: result.content, canUndo: false }
            : x,
        ),
      );
      notify("Restored the file before the AI edit.", "success");
    }
  }
  actionsRef.current = { open: openProject, save, newFile:()=>newItem(false),newFolder:()=>newItem(true) };
  useEffect(() => {
    api
      .state()
      .then(async (d) => {
        setData(d);
        setLibrary(d.library);
        setRuntime(d.runtime);
        setWorkspace(d.workspace);
        setBinary(d.binary);
        setContextSize(d.contextSize??0);
        if(d.preferences)setPreferences(d.preferences);
        if(d.resources)setResources(d.resources);
        if(d.mcp)setMcp(d.mcp);
        const first = d.workspace.files
          .find((f) => f.name === "src")
          ?.children?.find((f) => !f.directory);
        if (first) {
          const f = await api.read(first.path);
          setTabs([{ ...f, saved: f.content }]);
          setActive(f.path);
        }
      })
      .catch(error);
    const unsubscribe = [
      api.on("library:changed", setLibrary),
      api.on("resources:state",setResources),
      api.on("mcp:state",setMcp),
      api.on('workspace:changed',setWorkspace),
      api.on('agent:event',event=>{
        if(event.id!==requestRef.current)return;
        setActivity(a=>[...a.filter(e=>e.type!=='thinking').slice(-239),event]);
        setMessages(m=>m.map(x=>x.id===event.id?{...x,events:[...(x.events||[]).filter(e=>e.type!=='thinking'),event].slice(-240)}:x));
        if(['file','check'].includes(event.type))api.tree().then(setWorkspace).catch(()=>{});
        if(event.type==='file')api.read(event.path).then(f=>setTabs(t=>t.map(x=>x.path===f.path?{...f,saved:f.content}:x))).catch(()=>{});
      }),
      api.on("runtime:state", (s) => {
        setRuntime(s);
        if (s.status === "error")
          notify(
            "The local model could not run. Open Runtime output for details.",
            "error",
          );
      }),
      api.on("runtime:log", (s) => setLogs((t) => (t + s).slice(-30000))),
      api.on("chat:token", ({ id, token }) => {
        if (id === requestRef.current) {
          requestText.current += token;
          setMessages((m) =>
            m.map((x) =>
              x.id === id ? { ...x, content: x.content + token } : x,
            ),
          );
        }
      }),
      api.on("app:command", (c) => actionsRef.current[c]?.()),
    ];
    const key = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {e.preventDefault();actionsRef.current.newFile?.();}
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        actionsRef.current.save?.();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        actionsRef.current.open?.();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "1") {
        e.preventDefault();
        setView("editor");
      }
      if (e.key === "Escape") {
        setModal(null);
        setPalette(false);
        setSelector(false);
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      unsubscribe.forEach((f) => f());
      window.removeEventListener("keydown", key);
      clearTimeout(toastTimer.current);
    };
  }, []);
  useEffect(() => {
    api
      .setDirty?.(
        tabs.some((t) => t.saved !== undefined && t.content !== t.saved),
      )
      .catch(() => {});
  }, [tabs]);
  useEffect(() => {
    if (!proposal && diffModels.current) {
      const models = diffModels.current;
      diffModels.current = null;
      queueMicrotask(() => {
        models.original?.dispose();
        models.modified?.dispose();
      });
    }
  }, [proposal]);
  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: "instant", block: "nearest" });
  }, [messages]);
  // Newly opened files begin clean; edited buffers retain their original save snapshot.
  useEffect(() => {
    if (tabs.some((t) => t.saved === undefined))
      setTabs((t) =>
        t.map((x) => (x.saved === undefined ? { ...x, saved: x.content } : x)),
      );
  }, [tabs]);
  const commands = [
    {
      name: "Open project folder",
      icon: FolderOpen,
      run: openProject,
      key: "⌘O",
    },
    { name: "Go to editor", icon: Code2, run: () => setView("editor") },
    { name: "Open model library", icon: Layers3, run: () => setView("models") },
    {
      name: "Add a GGUF model",
      icon: FilePlus2,
      run: () => setModal({ type: "add" }),
    },
    { name: "Connect a models folder", icon: FolderPlus, run: addFolder },
    { name: "Save current file", icon: Check, run: save, key: "⌘S" },
    { name: "Open settings", icon: Settings2, run: () => setView("settings") },
    {
      name: "Toggle runtime output",
      icon: SquareTerminal,
      run: () => setOutput((o) => !o),
    },
  ];
  const filteredModels = library.models.filter(
    (m) =>
      (filter !== "available" || m.available) &&
      (filter !== "missing" || !m.available) &&
      (m.name + " " + m.path).toLowerCase().includes(search.toLowerCase()),
  );
  const usedMemory = (resources?.totalMemory || data?.hardware.totalMemory)
    ? Math.round(
        ((resources?.availableMemory ?? data?.hardware.freeMemory ?? 0) / (resources?.totalMemory || data?.hardware.totalMemory)) * 100,
      )
    : 0;

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="traffic-space" />
        <div className="brand">
          <Mark size={22} />
          <span>
            nexus<span className="brand-dot">.</span>
          </span>
          <span className="early-label">LOCAL IDE</span>
        </div>
        <button className="command-trigger" onClick={() => setPalette(true)}>
          <Search size={13} />
          <span>Search files, models, commands…</span>
          <kbd>⌘ K</kbd>
        </button>
        <div className="titlebar-right">
          <span className="local-pill">
            <span className="status-dot" />
            Local by design
          </span>
          <IconButton
            icon={showChat ? PanelRightClose : PanelRightOpen}
            title="Toggle assistant"
            onClick={() => setShowChat(!showChat)}
          />
        </div>
      </header>
      <div className={`workbench ${showChat?'with-chat':''} ${showSidebar?'with-sidebar':''}`} style={{'--sidebar-size':`${layout.sidebar}%`,'--chat-size':`${layout.chat}%`}}>
        <nav className="activity-rail" aria-label="Main navigation">
          <div>
            <IconButton
              icon={Code2}
              title="Editor"
              active={view === "editor"}
              onClick={() => setView("editor")}
            />
            <IconButton
              icon={Layers3}
              title="Model library"
              active={view === "models"}
              onClick={() => setView("models")}
            />
            <IconButton
              icon={FolderOpen}
              title="Open project"
              onClick={openProject}
            />
            <IconButton icon={Files} title="Toggle explorer" active={showSidebar} onClick={()=>setShowSidebar(v=>!v)}/>
            <div className="rail-divider" />
            <IconButton
              icon={SquareTerminal}
              title="Runtime output"
              active={output}
              onClick={() => setOutput(!output)}
            />
          </div>
          <div>
            <span className="rail-local" title="Local inference">
              <ShieldCheck size={19} />
            </span>
            <IconButton
              icon={Settings2}
              title="Settings"
              active={view === "settings"}
              onClick={() => setView("settings")}
            />
            <div className="avatar" title="Your local workspace">
              N
            </div>
          </div>
        </nav>
        <aside className="sidebar" hidden={!showSidebar}>
          <div className="sidebar-title">
            <span>YOUR WORKSPACE</span>
            <IconButton
              icon={MoreHorizontal}
              title="Workspace commands"
              onClick={() => setPalette(true)}
            />
          </div>
          <button className="project-button" onClick={openProject}>
            <div className="project-icon">
              <Code2 size={18} />
            </div>
            <div>
              <strong>{workspace?.name || "Welcome"}</strong>
              <small>Local workspace</small>
            </div>
            <ChevronDown size={13} />
          </button>
          <div className="side-nav">
            <button
              className={view === "editor" ? "selected" : ""}
              onClick={() => setView("editor")}
            >
              <Files size={16} />
              Explorer<span>⌘ 1</span>
            </button>
            <button
              className={view === "models" ? "selected" : ""}
              onClick={() => setView("models")}
            >
              <Layers3 size={16} />
              Model library
              <span className="count">{library.models.length}</span>
            </button>
          </div>
          {view === "editor" ? (
            <>
              <div className="section-label">
                <span className="files-label">FILES</span>
                <IconButton icon={FilePlus2} title="New File" disabled={generating} onClick={()=>newItem(false)} />
                <IconButton icon={FolderPlus} title="New Folder" disabled={generating} onClick={()=>newItem(true)} />
                <IconButton
                  icon={RefreshCw}
                  title="Refresh files"
                  onClick={() =>
                    task(async () => setWorkspace(await api.tree()))
                  }
                />
              </div>
              <div className="file-tree">
                <FileTree
                  nodes={workspace?.files}
                  active={active}
                  onOpen={openFile}
                />
              </div>
            </>
          ) : (
            <>
              <div className="section-label">LIBRARY</div>
              <button
                className={`source-button ${filter === "all" ? "selected" : ""}`}
                onClick={() => {
                  setFilter("all");
                  setView("models");
                }}
              >
                <HardDrive size={14} />
                All models<span>{library.models.length}</span>
              </button>
              <button
                className={`source-button ${filter === "available" ? "selected" : ""}`}
                onClick={() => {
                  setFilter("available");
                  setView("models");
                }}
              >
                <CheckCircle2 size={14} />
                Available
                <span>{library.models.filter((m) => m.available).length}</span>
              </button>
              <div className="section-label folder-label">
                WATCHED FOLDERS
                <IconButton
                  icon={Plus}
                  title="Add models folder"
                  onClick={addFolder}
                />
              </div>
              {library.folders.length ? (
                library.folders.map((f) => (
                  <div className="watched-folder" key={f} title={f}>
                    <Folder size={14} />
                    <span>{f.split(/[\\/]/).pop()}</span>
                    <IconButton
                      icon={X}
                      title="Stop watching folder"
                      onClick={() =>
                        task(async () => setLibrary(await api.removeFolder(f)))
                      }
                    />
                  </div>
                ))
              ) : (
                <p className="sidebar-hint">
                  Connect a folder to discover
                  <br />
                  your models automatically.
                </p>
              )}
              <button
                className="text-button add-folder-side"
                onClick={addFolder}
              >
                <Plus size={13} />
                Connect folder
              </button>
            </>
          )}
          <div className="sidebar-bottom">
            <div className="machine-title">
              <Cpu size={15} />
              <span>Your machine</span>
              <span className="status-dot" />
            </div>
            <strong>
              {data?.hardware.cpu?.replace("Apple ", "") ||
                "Detecting hardware…"}
            </strong>
            <div className="memory-line">
              <span>RAM headroom · estimate</span>
              <span>{usedMemory || "—"}%</span>
            </div>
            <div className="memory-bar">
              <span style={{ width: `${usedMemory}%` }} />
            </div>
            <div className="machine-foot">
              <span>{gb(data?.hardware.totalMemory)} RAM</span>
              <span>{resources?.pressure || data?.hardware.backend || "Local"}</span>
            </div>
          </div>
        </aside>
        {showSidebar&&<ResizeHandle label="Resize explorer" value={layout.sidebar} max={Math.min(28,75-layout.chat)} onChange={n=>changeLayout('sidebar',n)}/>}
        <main className="main-surface" style={{'--output-size':`${layout.output}%`}}>
          <div className="surface-top">
            <div className="breadcrumbs">
              <span>Nexus</span>
              <ChevronRight size={12} />
              <strong>
                {view === "models"
                  ? "Model library"
                  : view === "settings"
                    ? "Settings"
                    : workspace?.name || "Workspace"}
              </strong>
            </div>
            <div className="surface-actions">
              {isPreview && (
                <span className="preview-label">Browser preview</span>
              )}
              <IconButton
                icon={SlidersHorizontal}
                title="Model settings"
                onClick={() => setView("settings")}
              />
            </div>
          </div>
          {view === "models" && (
            <div className="models-view scroll-area">
              <div className="page-eyebrow">
                <span className="tiny-line" /> YOUR HARDWARE. YOUR INTELLIGENCE.
              </div>
              <div className="page-heading">
                <div>
                  <h1>
                    A home for your models<span>.</span>
                  </h1>
                  <p>Power your workspace with the models you already own.</p>
                </div>
                <button
                  className="primary-button"
                  onClick={() => setModal({ type: "add" })}
                >
                  <Plus size={16} />
                  Add model
                </button>
              </div>
              <div className="privacy-strip">
                <div className="privacy-icon">
                  <ShieldCheck size={18} />
                </div>
                <div>
                  <strong>Local from the first token to the last.</strong>
                  <span>
                    No cloud inference. No subscriptions. Just you and your
                    machine.
                  </span>
                </div>
                <Lock size={14} />
              </div>
              <div className="library-toolbar">
                <div className="library-tabs">
                  <button
                    className={filter === "all" ? "active" : ""}
                    onClick={() => setFilter("all")}
                  >
                    All models <span>{library.models.length}</span>
                  </button>
                  <button
                    className={filter === "available" ? "active" : ""}
                    onClick={() => setFilter("available")}
                  >
                    Available
                  </button>
                  {library.models.some((m) => !m.available) && (
                    <button
                      className={filter === "missing" ? "active" : ""}
                      onClick={() => setFilter("missing")}
                    >
                      Missing
                    </button>
                  )}
                </div>
                <div className="library-tools">
                  <div className="search-box">
                    <Search size={14} />
                    <input
                      aria-label="Search models"
                      placeholder="Find a model…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                  <IconButton
                    icon={RefreshCw}
                    title="Refresh models"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      await task(async () => {
                        setLibrary(await api.refresh());
                        notify("Model library refreshed.");
                      });
                      setBusy(false);
                    }}
                  />
                </div>
              </div>
              {filteredModels.length ? (
                <div className="model-list">
                  {filteredModels.map((m) => (
                    <article
                      className={`model-card ${runtime.modelId === m.id ? "loaded" : ""}`}
                      key={m.id}
                    >
                      <div className="model-row">
                        <div className="model-art">
                          <Layers3 size={25} />
                        </div>
                        <div className="model-info">
                          <h3>{m.name}</h3>
                          <div className="model-meta">
                            <Tag>{m.quantization}</Tag>
                            {m.parameters && (
                              <span>{m.parameters} parameters</span>
                            )}
                            <span>{gb(m.size)}</span>
                            <span>{m.architecture}</span>
                          </div>
                        </div>
                        <IconButton
                          icon={MoreHorizontal}
                          title={`Manage ${m.name}`}
                          onClick={() => {
                            setPathInput(m.name);
                            setModal({ type: "manage", model: m });
                          }}
                        />
                      </div>
                      <div className="model-path" title={m.path}>
                        <Folder size={12} />
                        <span>{shortPath(m.path)}</span>
                        <Tag>GGUF</Tag>
                      </div>
                      <div className="model-bottom">
                        <span
                          className={`model-state ${m.available ? "" : "missing"}`}
                        >
                          <span className="status-dot" />
                          {!m.available
                            ? "File not found"
                            : runtime.modelId === m.id
                              ? runtime.status === "ready"
                                ? "Loaded · ready to code"
                                : runtime.status === "loading"
                                  ? "Loading into memory…"
                                  : runtime.status === "error"
                                    ? "Could not load"
                                    : "Available locally"
                              : "Available locally"}
                        </span>
                        {runtime.modelId === m.id &&
                        ["ready", "loading"].includes(runtime.status) ? (
                          <button
                            className="small-button"
                            onClick={() => task(() => runtime.status === "loading" ? api.cancel() : api.unload())}
                          >
                            {runtime.status === "loading" ? (
                              <>
                                <X size={12} />
                                Cancel
                              </>
                            ) : (
                              <>
                                <Square size={11} />
                                Unload
                              </>
                            )}
                          </button>
                        ) : (
                          <button
                            className="small-button load-button"
                            disabled={
                              !m.available ||
                              runtime.status === "loading" ||
                              generating
                            }
                            onClick={() => loadModel(m)}
                          >
                            <Play size={12} />
                            Load model
                          </button>
                        )}
                      </div>
                      {resources?.modelPlans?.find(p=>p.id===m.id) && (()=>{
                        const plan=resources.modelPlans.find(p=>p.id===m.id);
                        const admission = !plan.fits ? (plan.message || `Free about ${memoryLabel(plan.shortfall)} more for a safe load.`) : plan.admissionMode === 'os-managed' ? 'Monitored load attempt. macOS may compress background apps; loading can still fail and work stops if pressure becomes critical or fails to recover.' : 'Within the current available-memory budget.';
                        return <div className="model-warning"><span>{contextLabel(plan.context)} initial context · needs about {memoryLabel(plan.requiredMemory)}. {admission}</span></div>;
                      })()}
                      {data?.hardware.totalMemory > 0 &&
                        m.size > data.hardware.totalMemory * 0.7 && (
                          <div className="model-warning">
                            <AlertTriangle size={13} />
                            Large for this machine. Loading also needs memory
                            for context and the app.
                          </div>
                        )}
                    </article>
                  ))}
                </div>
              ) : library.models.length ? (
                <div className="no-results">
                  <Search size={25} />
                  <h3>No matching models</h3>
                  <p>Try another name or choose All models.</p>
                  <button
                    className="text-button"
                    onClick={() => {
                      setSearch("");
                      setFilter("all");
                    }}
                  >
                    Clear filters
                  </button>
                </div>
              ) : (
                <div className="empty-library">
                  <div className="chip-illustration">
                    <div className="orbit orbit-one" />
                    <div className="orbit orbit-two" />
                    <span className="orbit-dot d1" />
                    <span className="orbit-dot d2" />
                    <div className="chip-body">
                      <Mark size={52} />
                      <span>LOCAL INTELLIGENCE</span>
                    </div>
                    <span className="file-float">
                      .gguf
                      <Check size={11} />
                    </span>
                  </div>
                  <h2>Big ideas. Local models.</h2>
                  <p>
                    Your next coding partner is already on your computer.
                    <br />
                    Add a GGUF file or connect your models folder to get
                    started.
                  </p>
                  <div className="empty-actions">
                    <button
                      className="primary-button"
                      onClick={() => importModel()}
                      disabled={busy}
                    >
                      <FilePlus2 size={16} />
                      Choose GGUF file
                    </button>
                    <button
                      className="secondary-button"
                      onClick={addFolder}
                      disabled={busy}
                    >
                      <FolderPlus size={16} />
                      Connect a folder
                    </button>
                  </div>
                  <button
                    className="paste-link"
                    onClick={() => setModal({ type: "add" })}
                  >
                    <Link2 size={12} />
                    Or paste a file location
                  </button>
                </div>
              )}
              {library.scanErrors?.length > 0 && (
                <div className="scan-errors">
                  <AlertTriangle size={15} />
                  <div>
                    <strong>Some files need attention</strong>
                    {library.scanErrors.slice(0, 3).map((e) => (
                      <p key={e}>{e}</p>
                    ))}
                  </div>
                </div>
              )}
              <div className="library-features">
                <div>
                  <div className="feature-icon">
                    <FolderOpen size={17} />
                  </div>
                  <h4>Keep files where they are</h4>
                  <p>
                    We link to your models.
                    <br />
                    No copies. No extra disk space.
                  </p>
                </div>
                <div>
                  <div className="feature-icon">
                    <RefreshCw size={17} />
                  </div>
                  <h4>A library that stays in sync</h4>
                  <p>
                    New model in your folder?
                    <br />
                    It appears here automatically.
                  </p>
                </div>
                <div>
                  <div className="feature-icon">
                    <ShieldCheck size={17} />
                  </div>
                  <h4>Yours, through and through</h4>
                  <p>
                    Your weights. Your prompts.
                    <br />
                    Inference on your machine.
                  </p>
                </div>
              </div>
              <div className="library-footer">
                <span>
                  <span className="status-dot" />{" "}
                  {binary ? "llama.cpp detected" : "Runtime setup needed"}
                </span>
                <button onClick={() => setView("settings")}>
                  Manage runtime <ArrowUpRight size={12} />
                </button>
              </div>
            </div>
          )}
          {view === "editor" && (
            <div className="editor-view">
              <div className="editor-tabs">
                {tabs.map((t) => (
                  <div
                    className={`editor-tab ${t.path === active ? "active" : ""}`}
                    key={t.path}
                  >
                    <button onClick={() => setActive(t.path)}>
                      <FileIcon name={t.path} />
                      {t.path.split("/").pop()}
                      {t.content !== t.saved && <span className="dirty-dot" />}
                    </button>
                    <IconButton
                      icon={X}
                      title={`Close ${t.path}`}
                      onClick={() => closeTab(t.path)}
                    />
                  </div>
                ))}
                <button
                  className="tab-open"
                  title="Open project"
                  onClick={openProject}
                >
                  <Plus size={14} />
                </button>
              </div>
              {proposal ? (
                <>
                  <div className="review-banner">
                    <span>
                      <Sparkles size={15} />
                      Review proposed changes <strong>{proposal.path}</strong>
                    </span>
                    <div>
                      <button
                        className="small-button"
                        onClick={() => setProposal(null)}
                      >
                        Discard
                      </button>
                      <button
                        className="primary-button compact"
                        onClick={applyProposal}
                      >
                        <Check size={13} />
                        Apply & save
                      </button>
                    </div>
                  </div>
                  <Suspense fallback={<div className="editor-loading">Loading editor…</div>}><DiffEditor
                    keepCurrentOriginalModel
                    keepCurrentModifiedModel
                    onMount={(editor) => {
                      diffModels.current = editor.getModel();
                    }}
                    original={proposal.original}
                    modified={proposal.modified}
                    language={lang(proposal.path)}
                    theme="nexus"
                    options={{
                      readOnly: true,
                      fontSize: 13,
                      minimap: { enabled: false },
                      renderSideBySide: false,
                      automaticLayout: true,
                      padding: { top: 20 },
                    }}
                  /></Suspense>
                </>
              ) : current ? (
                <>
                  <div className="file-breadcrumb">
                    <span>{current.path.split("/").join("  /  ")}</span>
                    <div>
                      {current.canUndo && (
                        <button className="text-button" onClick={undo}>
                          <Undo2 size={12} />
                          Undo AI edit
                        </button>
                      )}
                      <button
                        className="text-button"
                        disabled={generating}
                        onClick={() => {
                          setShowChat(true);
                          setIncludeFile(true);
                          setMode("edit");
                          chatInput.current?.focus();
                        }}
                      >
                        <Sparkles size={12} />
                        Edit with AI
                      </button>
                      <button className="text-button" onClick={save}>
                        <CheckCheck size={12} />
                        Save
                      </button>
                    </div>
                  </div>
                  <Suspense fallback={<div className="editor-loading">Loading editor…</div>}><Editor
                    path={current.path}
                    value={current.content}
                    language={lang(current.path)}
                    theme="nexus"
                    onChange={(value) =>
                      setTabs((t) =>
                        t.map((x) =>
                          x.path === active
                            ? { ...x, content: value || "" }
                            : x,
                        ),
                      )
                    }
                    onMount={(editor) => {
                      editorRef.current = editor;
                      editor.onDidChangeCursorPosition((e) =>
                        setCursor(e.position),
                      );
                    }}
                    options={{
                      fontSize: 13,
                      fontFamily:
                        '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
                      lineHeight: 24,
                      minimap: { enabled: false },
                      padding: { top: 24, bottom: 24 },
                      scrollBeyondLastLine: false,
                      smoothScrolling: true,
                      automaticLayout: true,
                      readOnly: generating && mode === "agent",
                      renderLineHighlight: "line",
                      overviewRulerBorder: false,
                      bracketPairColorization: { enabled: true },
                    }}
                  /></Suspense>
                </>
              ) : (
                <div className="empty-editor">
                  <Mark size={70} />
                  <h2>A little space for your next big idea.</h2>
                  <p>Open a project, pick a model, make something yours.</p>
                  <button className="primary-button" onClick={()=>newItem(false)}><FilePlus2 size={16}/>New file<kbd>⌘ N</kbd></button>
                  <button className="text-button" onClick={openProject}>
                    <FolderOpen size={16} />
                    Open project<kbd>⌘ O</kbd>
                  </button>
                </div>
              )}
            </div>
          )}
          {view === "settings" && (
            <div className="settings-view scroll-area">
              <div className="page-eyebrow">MAKE YOURSELF AT HOME</div>
              <h1>
                Your setup<span>.</span>
              </h1>
              <p className="page-description">
                Project access, local models, agent roles and tools.
              </p>
              <ResourceSettings resources={resources} preferences={preferences} runtime={runtime} models={library.models} disabled={busy||generating||terminalBusy} onUnload={()=>task(()=>runtime.status==='loading'?api.cancel():api.unload())} onChange={value=>task(async()=>setPreferences(await api.setResources(value)))}/>
              <AgentSettings agents={preferences.agents} models={library.models} disabled={generating||terminalBusy} onChange={value=>task(async()=>setPreferences(await api.setAgents(value)))}/>
              <MCPSettings mcp={mcp} disabled={generating||terminalBusy} onChange={updateMcp}/>
              <section className="settings-section">
                <h3>
                  <Cpu size={17} />
                  Local inference
                </h3>
                <div className="setting-row">
                  <div>
                    <strong>llama.cpp runtime</strong>
                    <p>
                      {binary || "Choose an installed llama-server executable."}
                    </p>
                  </div>
                  <button
                    className="secondary-button"
                    onClick={() =>
                      task(async () => {
                        const b = await api.chooseBinary();
                        if (b) setBinary(b);
                      })
                    }
                  >
                    Locate executable
                  </button>
                </div>
                <div className="setting-row">
                  <div>
                    <strong>Maximum context</strong>
                    <p>Starts at 4K and grows when the conversation needs more space. This setting is a ceiling. Growing the cache reloads the model between responses; weights remain necessary even for a short prompt.</p>
                  </div>
                  <select
                    aria-label="Maximum context" disabled={generating||terminalBusy||runtime.status==='loading'}
                    value={contextSize}
                    onChange={(e) => task(async()=>setContextSize(await api.setContext(Number(e.target.value))))}
                  >
                    {contexts.map((n) => (
                      <option key={n} value={n}>
                        {contextLabel(n)}{n===0?" · Grow as needed":" maximum"}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="setting-row">
                  <div>
                    <strong>Compute backend</strong>
                    <p>
                      llama.cpp chooses the available acceleration when loading.
                    </p>
                  </div>
                  <Tag tone="mint">{data?.hardware.backend || "Automatic"}</Tag>
                </div>
              </section>
              <section className="settings-section">
                <h3>
                  <ShieldCheck size={17} />
                  Privacy & control
                </h3>
                <div className="setting-row">
                  <div>
                    <strong>Local inference only</strong>
                    <p>
                      No cloud provider or remote inference endpoint is
                      configured.
                    </p>
                  </div>
                  <span className="setting-fixed">
                    <Lock size={13} />
                    Always on
                  </span>
                </div>
                <div className="setting-row">
                  <div>
                    <strong>Project permissions</strong>
                    <p>
                      Agents create, edit, rename, move and delete files in your chosen project. Checks run
                      without network or outside writes. Edit mode keeps its review step.
                    </p>
                  </div>
                  <span className="setting-fixed">
                    <Check size={13} />
                    Enabled
                  </span>
                </div>
                <div className="setting-row">
                  <div>
                    <strong>Model files stay in place</strong>
                    <p>
                      Removing a model from Nexus never deletes its GGUF file.
                    </p>
                  </div>
                  <span className="setting-fixed">
                    <Check size={13} />
                    Enabled
                  </span>
                </div>
              </section>
              <div className="settings-note">
                <Mark size={25} />
                <div>
                  <strong>Nexus · Local IDE 0.4.1</strong>
                  <p>
                    Local models, project agents, and editing. Built for a more
                    personal way to code.
                  </p>
                </div>
              </div>
            </div>
          )}
          {output && (
            <React.Fragment><ResizeHandle label="Resize terminal and logs" horizontal reverse value={layout.output} min={15} max={65} onChange={n=>changeLayout('output',n)}/><section className="output-panel">
              <div className="output-header">
                <span>
                  <SquareTerminal size={13} />
                  <button className={outputTab==='logs'?'selected':''} onClick={()=>setOutputTab('logs')}>Logs</button>
                  <button className={outputTab==='terminal'?'selected':''} onClick={()=>setOutputTab('terminal')}>Terminal</button>
                  <button className={outputTab==='activity'?'selected':''} onClick={()=>setOutputTab('activity')}>Activity</button>
                </span>
                <div>
                  <button className="text-button" onClick={() => setLogs("")}>
                    Clear
                  </button>
                  <IconButton
                    icon={X}
                    title="Close output"
                    onClick={() => setOutput(false)}
                  />
                </div>
              </div>
              {outputTab==='terminal'?<CheckTerminal api={api} onBusy={setTerminalBusy} notify={error} state={terminalState} onChange={setTerminalState} disabled={generating}/>:outputTab==='activity'?<ActivityPanel events={activity} agents={preferences.agents} models={library.models}/>:<pre>
                {runtime.error ? runtime.error + "\n\n" : ""}
                {logs ||
                  "Runtime is quiet. Load a model to see llama.cpp startup and inference logs."}
              </pre>}
            </section></React.Fragment>
          )}
        </main>
        {showChat && (
          <React.Fragment><ResizeHandle label="Resize chat" reverse value={layout.chat} min={20} max={Math.min(55,75-(showSidebar?layout.sidebar:0))} onChange={n=>changeLayout('chat',n)}/><aside className="assistant">
            <div className="assistant-top">
              <div>
                <Sparkles size={15} />
                <strong>Assistant</strong>
                <Tag>LOCAL</Tag>
              </div>
              <IconButton
                icon={Plus}
                title="New conversation"
                disabled={generating}
                onClick={() => {
                  setMessages([]);
                  setProposal(null);
                }}
              />
            </div>
            <div className="chat-mode">
              <button disabled={generating} className={mode==='agent'?'selected':''} onClick={()=>setMode('agent')}><Sparkles size={13}/>Agent</button>
              <button
                className={mode === "chat" ? "selected" : ""}
                disabled={generating} onClick={() => setMode("chat")}
              >
                <MessageSquare size={13} />
                Chat
              </button>
              <button
                className={mode === "edit" ? "selected" : ""}
                disabled={generating} onClick={() => setMode("edit")}
              >
                <Pencil size={13} />
                Edit
              </button>

            </div>
            {mode==='agent'&&<div className="agent-scope"><ShieldCheck size={14}/><div><strong>{workspace?.agentGranted?workspace.name:'Choose a project'}</strong><span>{workspace?.agentGranted?'Full file access • This folder only':'Select the folder Agent can work in'}</span></div><button disabled={generating} onClick={openProject} title="Choose agent folder"><FolderOpen size={15}/></button></div>}
            {mode==='agent'&&<details className="agent-roster" open={generating}><summary>{preferences.agents.filter(a=>a.enabled).length} agent(s) · {generating?'Working':'Ready'}</summary><ActivityPanel events={activity} agents={preferences.agents} models={library.models}/><button className="text-button" onClick={()=>setView('settings')}>Assign models & agents</button></details>}
            <div className="chat-body scroll-area">
              {messages.length === 0 ? (
                <div className="assistant-welcome">
                  <div className="assistant-mark">
                    <Mark size={35} />
                  </div>
                  <div className="assistant-eyebrow">
                    A LITTLE MORE POSSIBLE
                  </div>
                  <h2>
                    Your ideas.
                    <br />A local advantage.
                  </h2>
                  <p>{mode==='agent'?<>From an idea to files in your project.<br/>Create, test and iterate locally.</>:<>A thinking partner for your code.<br/>Right here, on your machine.</>}</p>
                  <div className="suggestions">
                    {(mode==='agent' ? [
                      {icon:Code2,title:'Build a small app',text:'Create a polished, accessible single-page to-do app in this folder using HTML, CSS and JavaScript. Include local storage, filters and a README. Add and run meaningful tests with built-in Node.js tools. Use no external packages.'},
                      {icon:Sparkles,title:'Improve this project',text:'Inspect this project, identify one useful improvement, implement it and run the relevant checks. Preserve unrelated work.'},
                      {icon:CheckCircle2,title:'Find and fix a bug',text:'Inspect the code and tests in this folder, reproduce a concrete bug, fix it and run tests that cover the fix.'}
                    ] : [
                      {
                        icon: Code2,
                        title: "Understand this code",
                        text: "Explain the current file and its main design decisions.",
                      },
                      {
                        icon: Sparkles,
                        title: "Make something better",
                        text: "Suggest practical improvements to the current file.",
                      },
                      {
                        icon: CheckCircle2,
                        title: "Think through an idea",
                        text: "Help me plan a small, useful developer tool.",
                      },
                    ]).map((s) => (
                      <button
                        key={s.title}
                        onClick={() => {
                          setPrompt(s.text);
                          setIncludeFile(s.title !== "Think through an idea");
                          chatInput.current?.focus();
                        }}
                      >
                        <s.icon size={15} />
                        <span>{s.title}</span>
                        <ArrowUpRight size={13} />
                      </button>
                    ))}
                  </div>
                  <div className="assistant-private">
                    <Lock size={12} />Local models. Real files. Your workspace.
                  </div>
                </div>
              ) : (
                messages.map((m, i) => (
                  <div className={`chat-message ${m.role}`} key={m.id || i}>
                    <div className="message-author">
                      {m.role === "assistant" ? (
                        <>
                          <Mark size={17} />
                          Nexus<span>LOCAL</span>
                        </>
                      ) : (
                        <>
                          <span className="you-dot">Y</span>You
                        </>
                      )}
                    </div>
                    {m.agent&&m.events?.length>0&&<div className="agent-events">{m.events.map((event,j)=><div className={`agent-event ${event.type}`} key={j}>
                      {event.type==='thinking'?<Loader2 size={13} className="spin"/>:event.type==='check'?<SquareTerminal size={13}/>:event.type==='file'?<FileCode2 size={13}/>:event.type==='error'?<AlertTriangle size={13}/>:<Check size={13}/>}
                      <div><span>{event.type==='action'?`${event.tool.replaceAll('_',' ')}${event.path?' · '+event.path:''}`:event.text}</span>
                      {event.type==='action'&&event.text!==event.tool&&<small>{event.text}</small>}
                      {event.agentName&&<small>{event.agentName}{event.step?` · Action ${event.step}/80`:''}</small>}
                      {event.type==='mcp'&&event.result&&<details><summary>Tool result</summary><pre>{event.result}</pre></details>}
                      {event.type==='check'&&<><small className={event.code===0?'check-pass':'error-text'}>{event.cancelled?'Stopped':event.timedOut?'Timed out':`Exit ${event.code ?? event.signal}`}</small><details><summary>Check output</summary><pre>{event.stdout||event.stderr?`${event.stdout}\n${event.stderr}`:'No output'}</pre></details></>}
                      </div></div>)}</div>}
                    <div className="message-content">
                      {m.content ||
                        (generating ? (
                          <span className="thinking">
                            <Loader2 size={13} className="spin" />
                            Thinking on your machine…
                          </span>
                        ) : m.failed ? (
                          "The response failed. See the error notice."
                        ) : (
                          "No response received."
                        ))}
                    </div>
                    {m.stopped && <small>Stopped</small>}
                    {m.failed && (
                      <small className="error-text">Response failed</small>
                    )}
                    {m.editing &&
                      m.content &&
                      !generating &&
                      !m.failed &&
                      !m.stopped && (
                        <small>
                          Any valid proposal appears in the editor for review.
                        </small>
                      )}
                  </div>
                ))
              )}
              <div ref={messagesEnd} />
            </div>
            <div className="chat-bottom">
              {!ready && (
                <div className="chat-setup">
                  <span className="status-dot amber" />
                  <span>
                    {runtime.status === "loading"
                      ? "Getting your model ready…"
                      : preferences.selectedModel?"Model will load automatically":"Your assistant needs a model"}
                  </span>
                  <button onClick={() => setView("models")}>
                    Set up
                    <ArrowRight size={12} />
                  </button>
                </div>
              )}
              <div className={`composer ${generating ? "working" : ""}`}>
                {(includeFile || mode === "edit") && current && (
                  <button
                    className="context-chip"
                    onClick={() => {
                      if (mode !== "edit") setIncludeFile(false);
                    }}
                  >
                    <FileCode2 size={11} />
                    {current.path.split("/").pop()}
                    {mode !== "edit" && <X size={10} />}
                  </button>
                )}
                <textarea
                  ref={chatInput}
                  aria-label="Message your local assistant"
                  placeholder={
                    mode === "agent" ? "Describe what to build in this folder…" : mode === "edit"
                      ? "Describe a change to this file…"
                      : "Ask anything. Build something."
                  }
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendMessage();
                    }
                  }}
                />
                <div className="composer-bottom">
                  <button
                    className="context-toggle"
                    onClick={() => setIncludeFile(!includeFile)}
                    disabled={!current || mode === "edit" || mode === "agent"}
                    title="Attach current file"
                  >
                    <Plus size={16} />
                    <span>Context</span>
                  </button>
                  <button type="button" className={`mcp-toggle ${mcp.enabled?'on':''}`} aria-label={`MCP ${mcp.enabled?'ON':'OFF'}`} aria-pressed={mcp.enabled} disabled={generating||terminalBusy} title="Toggle configured MCP servers" onClick={()=>task(()=>updateMcp({...mcp,enabled:!mcp.enabled}))}><Link2 size={14}/><span>MCP {mcp.enabled?'ON':'OFF'}</span></button>
                  <span className="enter-hint">↵</span>
                  {generating ? (
                    <button
                      className="send-button stop"
                      onClick={() => task(() => api.cancel())}
                      title="Stop response"
                    >
                      <Square size={13} />
                    </button>
                  ) : (
                    <button
                      className="send-button"
                      disabled={!prompt.trim()||terminalBusy||runtime.status==='loading'}
                      onClick={() => sendMessage()}
                      title="Send message"
                    >
                      <ArrowUp size={17} />
                    </button>
                  )}
                </div>
              </div>
              <div className="model-picker-wrap">
                <select className="context-size-picker" aria-label="Maximum context" disabled={generating||terminalBusy||runtime.status==='loading'} title={`Maximum: ${contextSize?contextLabel(contextSize):'Auto · 32K'}. Allocated: ${runtime.contextSize?runtime.contextSize/1024+'K':'none'}. Grows when needed.`} value={contextSize} onChange={e=>task(async()=>setContextSize(await api.setContext(Number(e.target.value))))}>{contexts.map(n=><option key={n} value={n}>{contextLabel(n)}</option>)}</select>
                <button
                  className="model-picker"
                  disabled={generating}
                  onClick={() => setSelector(!selector)}
                >
                  <span className={`status-dot ${ready ? "" : "muted"}`} />
                  <span>{selectedModel?.name || "Select a local model"}</span>
                  <ChevronDown size={12} />
                </button>
                <span className="privacy-lock" title="Local inference">
                  <Lock size={11} />
                </span>
                {selector && (
                  <div className="model-popover">
                    <span className="section-label">YOUR MODELS</span>
                    {library.models
                      .filter((m) => m.available)
                      .map((m) => (
                        <button
                          key={m.id}
                          disabled={generating || runtime.status === "loading"}
                          onClick={() => loadModel(m)}
                        >
                          <Layers3 size={14} />
                          <span>{m.name}</span>
                          {runtime.modelId === m.id && <Check size={13} />}
                        </button>
                      ))}
                    {!library.models.length && <p>No models added yet.</p>}
                    <button
                      onClick={() => {
                        setSelector(false);
                        setView("models");
                        setModal({ type: "add" });
                      }}
                    >
                      <Plus size={14} />
                      Add a local model
                    </button>
                  </div>
                )}
              </div>
            </div>
          </aside></React.Fragment>
        )}
      </div>
      <footer className="statusbar">
        <div>
          <span className="status-brand">
            <Mark size={13} />
          </span>
          <span>
            <Folder size={11} />
            {workspace?.name || "Workspace"}
          </span>
          <span className="status-divider" />
          <span>
            <ShieldCheck size={11} />
            Local inference
          </span>
        </div>
        <div>
          <button
            onClick={() => {
              setOutput(!output);
            }}
          >
            <span
              className={`status-dot ${ready ? "" : runtime.status === "loading" ? "amber" : "muted"}`}
            />
            {ready
              ? "Model ready"
              : runtime.status === "loading"
                ? "Loading model"
                : runtime.status === "error"
                  ? "Runtime error"
                  : "No model loaded"}
          </button>
          <span className="status-divider" />
          <span>
            {view === "editor" && current
              ? `Ln ${cursor.lineNumber}, Col ${cursor.column}`
              : "GGUF · local files"}
          </span>
          <span>UTF-8</span>
          <span className="version-label">v0.4.1</span>
        </div>
      </footer>
      {toast && (
        <div role="status" className={`toast ${toast.type}`}>
          {toast.type === "error" ? (
            <AlertTriangle size={17} />
          ) : toast.type === "success" ? (
            <CheckCircle2 size={17} />
          ) : (
            <Sparkles size={17} />
          )}
          <span>{toast.message}</span>
          <IconButton
            icon={X}
            title="Dismiss notification"
            onClick={() => setToast(null)}
          />
        </div>
      )}
      {modal && (
        <div className="modal-backdrop" onClick={() => !busy && setModal(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={
              modal.type === "manage" ? "Manage model" : "Nexus dialog"
            }
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <div className="modal-icon">
                <Layers3 size={23} />
              </div>
              <IconButton
                icon={X}
                title="Close dialog"
                onClick={() => setModal(null)}
              />
            </div>
            {modal.type === 'create' ? <form onSubmit={e=>{e.preventDefault();createItem();}}>
              <h2>{modal.directory?'New folder':'New file'}</h2><p>Create inside {workspace?.name}. Use a relative path, such as {modal.directory?'src/components':'src/components/Button.jsx'}.</p>
              <label className="input-label" htmlFor="new-path">{modal.directory?'Folder path':'File path'}</label>
              <input id="new-path" className="full-input" autoFocus value={pathInput} onChange={e=>setPathInput(e.target.value)} placeholder={modal.directory?'components':'index.html'}/>
              <div className="modal-bottom"><span><Folder size={13}/>{workspace?.name}</span><button type="submit" className="primary-button" disabled={busy||!pathInput.trim()}>{busy?<Loader2 size={14} className="spin"/>:<Plus size={14}/>}Create {modal.directory?'folder':'file'}</button></div>
            </form> : modal.type === "add" ? (
              <>
                <h2>Bring your own intelligence.</h2>
                <p>
                  Add an existing GGUF model. Nexus remembers its location and
                  takes care of the rest.
                </p>
                <div className="import-options">
                  <button onClick={() => importModel()} disabled={busy}>
                    <FilePlus2 size={22} />
                    <strong>Choose a GGUF file</strong>
                    <span>
                      Browse your computer
                      <ArrowUpRight size={12} />
                    </span>
                  </button>
                  <button onClick={addFolder} disabled={busy}>
                    <FolderPlus size={22} />
                    <strong>Connect a folder</strong>
                    <span>
                      Discover models automatically
                      <ArrowUpRight size={12} />
                    </span>
                  </button>
                </div>
                <div className="or-line">
                  <span />
                  or use a file location
                  <span />
                </div>
                <label className="input-label" htmlFor="model-path">
                  Full path to your GGUF file
                </label>
                <div className="path-input">
                  <Link2 size={15} />
                  <input
                    id="model-path"
                    autoFocus
                    placeholder="/Users/you/Desktop/Models/model.gguf"
                    value={pathInput}
                    onChange={(e) => setPathInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && pathInput.trim())
                        importModel(pathInput.trim());
                    }}
                  />
                </div>
                <div className="modal-bottom">
                  <span>
                    <Lock size={12} />
                    Files stay exactly where they are.
                  </span>
                  <button
                    className="primary-button"
                    disabled={busy || !pathInput.trim()}
                    onClick={() => importModel(pathInput.trim())}
                  >
                    {busy ? (
                      <Loader2 className="spin" size={14} />
                    ) : (
                      <Plus size={14} />
                    )}
                    Add model
                  </button>
                </div>
              </>
            ) : modal.type === "manage" ? (
              <>
                <h2>Model details</h2>
                <label className="input-label" htmlFor="model-name">
                  Display name
                </label>
                <input
                  id="model-name"
                  className="full-input"
                  value={pathInput}
                  onChange={(e) => setPathInput(e.target.value)}
                />
                <div className="detail-path">
                  <Folder size={14} />
                  {modal.model.path}
                </div>
                <div className="detail-tags">
                  <Tag>{modal.model.quantization}</Tag>
                  <Tag>{gb(modal.model.size)}</Tag>
                  <Tag>
                    {modal.model.context
                      ? `${modal.model.context.toLocaleString()} max context`
                      : "Context unknown"}
                  </Tag>
                </div>
                <p className="detail-note">
                  Remove only unregisters this model from Nexus. The original
                  GGUF file is never deleted. Use Add model to register a moved
                  file.
                </p>
                <div className="modal-bottom">
                  <button
                    className="danger-button"
                    disabled={generating}
                    onClick={() =>
                      task(async () => {
                        setLibrary(await api.removeModel(modal.model.id));
                        setModal(null);
                        notify("Removed from the library. Original file kept.");
                      })
                    }
                  >
                    <Trash2 size={14} />
                    Remove from library
                  </button>
                  <button
                    className="primary-button"
                    onClick={() =>
                      task(async () => {
                        setLibrary(
                          await api.renameModel(modal.model.id, pathInput),
                        );
                        setModal(null);
                      })
                    }
                  >
                    Save name
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2>Keep your changes?</h2>
                <p>
                  You have unsaved edits. Save them in the editor before
                  continuing, or discard them to proceed.
                </p>
                <div className="modal-bottom">
                  <button
                    className="secondary-button"
                    onClick={() => setModal(null)}
                  >
                    Keep editing
                  </button>
                  <button
                    className="danger-button"
                    onClick={() =>
                      modal.type === "close-tab"
                        ? doClose(modal.file)
                        : doOpenProject()
                    }
                  >
                    Discard & continue
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {palette && (
        <div
          className="modal-backdrop palette-backdrop"
          onClick={() => setPalette(false)}
        >
          <div
            className="palette"
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="palette-search">
              <Search size={19} />
              <input
                autoFocus
                placeholder="What would you like to do?"
                value={paletteQuery}
                onChange={(e) => setPaletteQuery(e.target.value)}
              />
              <kbd>esc</kbd>
            </div>
            <div className="section-label">COMMANDS</div>
            {commands
              .filter((c) =>
                c.name.toLowerCase().includes(paletteQuery.toLowerCase()),
              )
              .map((c) => (
                <button
                  key={c.name}
                  onClick={() => {
                    setPalette(false);
                    setPaletteQuery("");
                    c.run();
                  }}
                >
                  <c.icon size={16} />
                  <span>{c.name}</span>
                  {c.key && <kbd>{c.key}</kbd>}
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
