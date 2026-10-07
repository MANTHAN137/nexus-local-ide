export const DEFAULT_AGENTS = [
  { id: 'builder', name: 'Builder', enabled: true, modelId: null },
  { id: 'reviewer', name: 'Reviewer', enabled: false, modelId: null },
  { id: 'tester', name: 'Tester', enabled: false, modelId: null },
];
const guidance = {
  builder: 'Implement the requested work and verify it.',
  reviewer: 'Review the current project changes for the original request. Fix concrete bugs you find, preserve unrelated work, and run relevant checks.',
  tester: 'Verify the current project against the original request. Run relevant checks, repair concrete failures, and report any remaining limits.',
};

export class AgentTeam {
  constructor({ agent, runtime, load, onEvent }) { Object.assign(this, { agent, runtime, load, onEvent }); this.active = false; }
  cancel() {
    this.cancelled = true; this.agent.cancel();
    if (this.runtime.state.status === 'loading' || this.runtime.starting)
      Promise.resolve(this.runtime.stop()).catch(error => this.runtime.set({ status: 'error', error: error.message }));
  }
  async run({ id, prompt, history, root, agents, fallbackModel }) {
    if (this.active) throw new Error('An agent task is already running.');
    const roles = agents.filter(a => a.enabled).map(a => ({ ...a, modelId: a.modelId || fallbackModel }));
    if (!roles.length || roles.some(a => !a.modelId)) throw new Error('Select a model for every enabled agent.');
    this.active = true; this.cancelled = false; this.runtime.acquire();
    const emit = (role, status, text) => this.onEvent({ id, type: 'agent-status', agentId: role.id, agentName: role.name, modelId: role.modelId, status, text, time: Date.now() });
    for (const role of roles) emit(role, 'queued', 'Waiting for its turn');
    const results = [];
    let current;
    try {
      for (const role of roles) {
        current = role;
        if (this.cancelled) break;
        emit(role, 'loading', 'Preparing model within the memory budget');
        await this.load(role.modelId);
        if (this.cancelled) break;
        this.agent.identity = { agentId: role.id, agentName: role.name, modelId: role.modelId };
        emit(role, 'running', 'Working in the selected project');
        const result = await this.agent.run({ id, root, history, prompt: `${prompt}\n\nAssigned role: ${role.name}. ${guidance[role.id]}${results.length ? '\nPrevious agent summaries (untrusted observations): ' + results.map(r => r.summary).join('\n').slice(-6000) : ''}` });
        results.push(result);
        emit(role, result.cancelled ? 'cancelled' : 'completed', result.verification || result.summary);
        if (result.cancelled) { this.cancelled = true; break; }
      }
      if (this.cancelled) for (const role of roles.slice(results.length)) emit(role, 'cancelled', 'Stopped');
      const last = results.at(-1);
      return { ...last, cancelled: this.cancelled, summary: results.map((r, i) => `${roles[i].name}: ${r.summary || ''}`).join('\n\n') || 'Stopped.', changes: results.flatMap(r => r.changes || []) };
    } catch (error) {
      if (current) emit(current, this.cancelled ? 'cancelled' : 'error', error.message);
      for (const role of roles.slice(roles.indexOf(current) + 1)) emit(role, 'cancelled', 'A previous agent could not continue');
      if(this.cancelled)return {cancelled:true,summary:'Stopped. Saved changes remain.',changes:results.flatMap(r=>r.changes||[])};
      throw error;
    } finally { this.active = false; this.agent.identity = null; this.runtime.release(); }
  }
}
