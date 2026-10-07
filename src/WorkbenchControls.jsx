import React, { useRef, useState } from 'react';
import { Cpu, Link2, Plus, Trash2, Users, SquareTerminal, Square, Play } from 'lucide-react';

export const defaultAgents = [
  { id: 'builder', name: 'Builder', enabled: true, modelId: null },
  { id: 'reviewer', name: 'Reviewer', enabled: false, modelId: null },
  { id: 'tester', name: 'Tester', enabled: false, modelId: null },
];
export const memoryLabel = bytes => bytes == null ? 'Unavailable' : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
export const memoryPolicyLabel = policy => policy === 'managed' ? 'Model focused' : 'Protect other apps';
export const contexts = [0, 4096, 8192, 16384, 32768, 65536, 98304, 131072];
export const contextLabel = n => n === 0 ? 'Auto' : `${n / 1024}K`;

export function ResizeHandle({ label, value, onChange, min = 10, max = 55, horizontal = false, reverse = false }) {
  const drag = useRef(null);
  const update = n => onChange(Math.min(max, Math.max(min, Math.round(n))));
  return <div role="separator" tabIndex={0} aria-label={label} aria-orientation={horizontal ? 'horizontal' : 'vertical'} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value}
    className={`resize-handle ${horizontal ? 'horizontal' : 'vertical'}`}
    onPointerDown={e => {
      if(e.button !== 0)return;
      e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);
      const bounds = e.currentTarget.parentElement.getBoundingClientRect();
      drag.current = { start: horizontal ? e.clientY : e.clientX, value, size: horizontal ? bounds.height : bounds.width };
    }}
    onPointerMove={e => { if(!drag.current)return; const d=drag.current;update(d.value + ((horizontal?e.clientY:e.clientX)-d.start)/d.size*100*(reverse?-1:1)); }}
    onPointerUp={() => {drag.current=null;}} onPointerCancel={() => {drag.current=null;}} onLostPointerCapture={() => {drag.current=null;}}
    onKeyDown={e => {if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key)){e.preventDefault();update(e.key==='Home'?min:e.key==='End'?max:value+(['ArrowRight','ArrowDown'].includes(e.key)?2:-2)*(reverse?-1:1));}}} />;
}

export function ResourceSettings({ resources, preferences, runtime, models, onChange, onUnload, disabled }) {
  const loaded = ['ready','loading'].includes(runtime.status) ? models.find(m => m.id === runtime.modelId) : null;
  const plan = resources?.modelPlans?.find(p => p.id === preferences.selectedModel);
  const breakdown = loaded ? runtime.memoryBreakdown : plan?.memoryBreakdown;
  const settingsLocked = disabled || runtime.status === 'loading';
  const admissionLabel = mode => mode === 'os-managed' ? 'Monitored macOS-managed load' : 'Current available-memory budget';
  return <section className="settings-section">
    <h3><Cpu size={17}/>Memory & energy</h3>
    <div className="resource-grid">
      <div><small>Reclaimable RAM estimate / total</small><strong>{memoryLabel(resources?.availableMemory)} / {memoryLabel(resources?.totalMemory)}</strong></div>
      <div><small>Memory pressure</small><strong>{resources?.pressure || 'Unavailable'}</strong></div>
      <div><small>Thermal state · macOS</small><strong>{resources?.thermalState || 'unknown'}</strong></div>
      <div><small>Nexus processes</small><strong>{memoryLabel(resources?.appMemory)}</strong></div>
      <div><small>Model resident memory</small><strong>{memoryLabel(resources?.modelResidentMemory)}</strong></div>
    </div>
    <div className="setting-row"><div><strong>Loaded model · {loaded ? 1 : 0}</strong><p>{loaded ? `${loaded.name} · ${runtime.status} · ${contextLabel(runtime.contextSize)} allocated context` : 'No model is holding memory.'}</p>{loaded && (runtime.memoryPolicy || runtime.admissionMode) && <p>{runtime.memoryPolicy && `Loaded policy: ${memoryPolicyLabel(runtime.memoryPolicy)}.`}{runtime.admissionMode && ` Admission: ${admissionLabel(runtime.admissionMode)}.`}</p>}{loaded && runtime.executionMode && <p>Loaded processing: {runtime.executionMode === 'cpu' ? 'CPU compatibility' : 'Automatic (GPU)'}.</p>}{loaded && runtime.executionMode === 'cpu' ? <p>CPU compatibility uses file-backed model weights and avoids Metal buffer pinning. It may be slower; CPU thread limits follow the selected energy profile.</p> : loaded && Number.isInteger(runtime.gpuLayers) && runtime.gpuLayers >= 0 && <p>Memory-saving GPU offload: up to {runtime.gpuLayers} layers; remaining weights processed on CPU. May be slower.</p>}<p>Weights are needed even for a short prompt. Context starts small and grows before a request needs more space. Resident memory excludes some Metal allocations.</p>{runtime.notice && <p role="status">{runtime.notice}</p>}{runtime.resourceWarning && <p role="status">{runtime.resourceWarning}</p>}{runtime.error && <p role="alert" className="error-text">{runtime.error}</p>}</div><button className="secondary-button" disabled={(disabled && runtime.status !== 'loading') || !loaded} onClick={onUnload}>{runtime.status === 'loading' ? 'Cancel load' : 'Unload'}</button></div>
    {breakdown && <div className="resource-grid">
      <div><small>Model weights</small><strong>{memoryLabel(breakdown.weights)}</strong></div>
      <div><small>Context and recurrent cache</small><strong>{memoryLabel(breakdown.kv + breakdown.recurrent + breakdown.checkpoints)}</strong></div>
      <div><small>Buffers and safety margin</small><strong>{memoryLabel(breakdown.compute + breakdown.safetyMargin)}</strong></div>
      <div><small>Estimated model requirement</small><strong>{memoryLabel(breakdown.total)}</strong></div>
      {plan && <div><small>Current available-memory model budget</small><strong>{memoryLabel(plan.budget)}</strong></div>}
      {plan?.memoryPolicy === 'managed' && plan.physicalBudget != null && <div><small>Monitored physical RAM ceiling</small><strong>{memoryLabel(plan.physicalBudget)}</strong></div>}
    </div>}
    {plan && (!plan.fits || plan.admissionMode === 'os-managed') && <p role="status" className="settings-help">{plan.message || 'A monitored load may compress background apps. Eligibility does not guarantee free RAM; loading can fail and work stops if pressure becomes critical or fails to recover.'}</p>}
    <div className="setting-row"><div><strong>Memory policy</strong><p>Protect other apps requires current estimated headroom. Model focused allows a monitored load when it fits the physical RAM ceiling and memory pressure is normal. macOS may compress background apps; eligibility does not guarantee free RAM. Loading can still fail and work stops if pressure becomes critical or fails to recover.</p></div><select aria-label="Memory policy" disabled={settingsLocked} value={preferences.memoryPolicy || 'protect'} onChange={e => onChange({ ...preferences, memoryPolicy: e.target.value })}><option value="protect">Protect other apps</option><option value="managed">Model focused</option></select></div>
    <div className="setting-row"><div><strong>Processing mode</strong><p>Automatic uses GPU acceleration where possible. CPU compatibility uses file-backed model weights to avoid Metal buffer pinning. It may be slower, and CPU thread limits still follow the selected energy profile.</p></div><select aria-label="Processing mode" disabled={settingsLocked} value={preferences.executionMode || 'auto'} onChange={e => onChange({ ...preferences, executionMode: e.target.value })}><option value="auto">Automatic (GPU)</option><option value="cpu">CPU compatibility</option></select></div>
    <div className="setting-row"><div><strong>Unload after inactivity</strong><p>The selected model reloads automatically for the next task.</p></div><select aria-label="Idle unload delay" disabled={settingsLocked} value={preferences.idleUnloadSeconds} onChange={e => onChange({ ...preferences, idleUnloadSeconds: Number(e.target.value) })}>{[30,60,120,300].map(n => <option key={n} value={n}>{n < 60 ? `${n} seconds` : `${n/60} minutes`}</option>)}</select></div>
    <div className="setting-row"><div><strong>Energy profile</strong><p>Changing the profile unloads an idle model so the next request uses the new limits. Cool & quiet lowers CPU priority, threads and prompt batches. GPU inference can still produce heat; serious thermal pressure stops work.</p></div><select aria-label="Energy profile" disabled={settingsLocked} value={preferences.powerMode} onChange={e => onChange({ ...preferences, powerMode: e.target.value })}><option value="balanced">Balanced</option><option value="cool">Cool & quiet</option></select></div>
  </section>;
}

export function AgentSettings({ agents, models, onChange, disabled }) {
  return <section className="settings-section"><h3><Users size={17}/>Agent assignments</h3><p className="settings-help">Agents work in order and release the previous model before switching. Only enabled roles run.</p>{agents.map((a,i) => <div className="setting-row" key={a.id}><label className="toggle-label"><input type="checkbox" checked={a.enabled} disabled={disabled} onChange={e => onChange(agents.map((r,j) => i===j?{...r,enabled:e.target.checked}:r))}/>{a.name}</label><select aria-label={`${a.name} model`} value={a.modelId || ''} disabled={disabled} onChange={e => onChange(agents.map((r,j) => i===j?{...r,modelId:e.target.value||null}:r))}><option value="">Use selected model</option>{models.filter(m=>m.available).map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></div>)}</section>;
}

export function MCPSettings({ mcp, onChange, disabled }) {
  const [form,setForm]=useState({name:'',command:'',args:'[]'}),[error,setError]=useState(''),[saving,setSaving]=useState(false);
  const update=async value=>{setSaving(true);setError('');try{await onChange(value);return true;}catch(e){setError(e.message);return false;}finally{setSaving(false);}};
  const locked=disabled||saving;
  return <section className="settings-section"><h3><Link2 size={17}/>MCP servers <span className={`mcp-badge ${mcp.enabled?'on':''}`}>{mcp.enabled?'ON':'OFF'}</span></h3>
    <div className="setting-row"><div><strong>Enable MCP tools for agents</strong><p>Local stdio servers run inside the selected project sandbox, without network access. Servers connect when a task starts and close when it ends.</p></div><input type="checkbox" role="switch" aria-label="Enable MCP" checked={mcp.enabled} disabled={locked} onChange={e=>update({...mcp,enabled:e.target.checked})}/></div>
    {mcp.servers.map(s=><div className="setting-row" key={s.id}><div><label className="toggle-label"><input type="checkbox" aria-label={`Enable ${s.name}`} checked={s.enabled} disabled={locked} onChange={e=>update({...mcp,servers:mcp.servers.map(x=>x.id===s.id?{...x,enabled:e.target.checked}:x)})}/><strong>{s.name}</strong></label><p>{s.status || 'disconnected'} · {s.toolCount || 0} tools</p><p>{s.command}</p>{s.error&&<p className="error-text">{s.error}</p>}</div><button title={`Remove ${s.name}`} aria-label={`Remove ${s.name}`} disabled={locked} onClick={()=>update({...mcp,servers:mcp.servers.filter(x=>x.id!==s.id)})}><Trash2 size={15}/></button></div>)}
    <form className="mcp-form" onSubmit={async e=>{e.preventDefault();try{const args=JSON.parse(form.args);if(await update({...mcp,servers:[...mcp.servers,{...form,args,enabled:true}]}))setForm({name:'',command:'',args:'[]'});}catch(e){setError(e.message);}}}>
      <label>Server name<input required value={form.name} disabled={locked} onChange={e=>setForm({...form,name:e.target.value})} placeholder="Project tools"/></label>
      <label>Installed executable<input required value={form.command} disabled={locked} onChange={e=>setForm({...form,command:e.target.value})} placeholder="/opt/homebrew/bin/node"/></label>
      <label>Arguments · JSON array<textarea value={form.args} disabled={locked} onChange={e=>setForm({...form,args:e.target.value})} placeholder={'["/path/to/server.js", "${PROJECT_ROOT}"]'}/></label>
      <p className="settings-help">Use ${'{PROJECT_ROOT}'} for the current folder. Install servers separately, then select their executable and script here. Root discovery is also supported.</p>
      {(error||mcp.error)&&<p role="alert" className="error-text">{error||mcp.error}</p>}<button className="secondary-button" disabled={locked}><Plus size={14}/>Add server</button>
    </form>
  </section>;
}

export function ActivityPanel({ events, agents, models }) {
  return <section className="activity-panel" aria-label="Agent activity"><div className="activity-heading">AGENT ACTIVITY <span>Sequential · one model in memory</span></div><div className="agent-cards">{agents.filter(a=>a.enabled).map(a=>{
    const latest=[...events].reverse().find(e=>e.agentId===a.id),status=[...events].reverse().find(e=>e.agentId===a.id&&e.type==='agent-status');
    const model=models.find(m=>m.id===(status?.modelId||a.modelId));
    return <article key={a.id}><div><strong>{a.name}</strong><span className={`agent-status ${status?.status||'idle'}`}>{status?.status||'idle'}</span></div><small>{model?.name||'Selected model'}</small><p>{latest?.text||'Ready for a task'}{latest?.step?` · Action ${latest.step}/80`:''}</p></article>;
  })}</div></section>;
}

export function CheckTerminal({ api, onBusy, notify, state, onChange, disabled }) {
  const {command,output,running}=state;
  const setCommand=command=>onChange(previous=>({...previous,command}));
  const setOutput=output=>onChange(previous=>({...previous,output}));
  const setRunning=running=>onChange(previous=>({...previous,running}));
  const run=async e=>{e.preventDefault();if(running||disabled)return;setRunning(true);onBusy(true);setOutput(`$ ${command}\nRunning…`);try{const r=await api.runCheck(command);setOutput(`$ ${r.command}\n${r.stdout}\n${r.stderr}\n${r.cancelled?'Stopped':r.timedOut?'Timed out':`Exit ${r.code??r.signal}`}`);}catch(e){setOutput(e.message);notify(e);}finally{setRunning(false);onBusy(false);}};
  return <div className="check-terminal"><form onSubmit={run}><SquareTerminal size={14}/><input aria-label="Project check command" value={command} disabled={running||disabled} onChange={e=>setCommand(e.target.value)} placeholder="npm test"/>{running?<button type="button" aria-label="Stop check" onClick={()=>api.cancel()}><Square size={14}/></button>:<button disabled={disabled} aria-label="Run check"><Play size={14}/></button>}</form><small>Project checks: node, npm test/build/lint/check/typecheck, Python. No shell operators.</small><pre>{output||'Run a check in your selected project. Output appears here.'}</pre></div>;
}
