import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import { memorySnapshot, planModel } from "./memory.mjs";
import { EventEmitter } from "node:events";
import { streamAction, actionOutputBudget } from "./action-stream.mjs";
import { ContextCapacityError, runtimeArguments } from "./runtime-config.mjs";
import { MemoryPressureGuard } from './memory-guard.mjs';

export async function findRuntime(configured) {
  const candidates = [
    configured,
    process.env.NEXUS_LLAMA_BINARY,
    "/opt/homebrew/bin/llama-server",
    "/usr/local/bin/llama-server",
    ...(process.env.PATH || "")
      .split(path.delimiter)
      .map((p) =>
        path.join(
          p,
          process.platform === "win32" ? "llama-server.exe" : "llama-server",
        ),
      ),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      await fs.access(file, 1);
      return file;
    } catch {}
  }
  return null;
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function port() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

export class LocalRuntime extends EventEmitter {
  constructor({ sampleMemory = memorySnapshot, spawnProcess = spawn, allocatePort = port, fetcher = fetch, memoryPollInterval = 500 } = {}) {
    super();
    Object.assign(this, { sampleMemory, spawnProcess, allocatePort, fetcher, memoryPollInterval });
    this.cancelEpoch = 0;
    this.state = { status: "idle", modelId: null, error: null };
    this.generation = 0;
    this.log = "";
    this.settings = { idleUnloadSeconds: 120, powerMode: 'balanced', memoryPolicy: 'protect', executionMode: 'auto' };
    this.lastUsed = Date.now();
    this.leases = 0;
  }
  set(value) {
    Object.assign(this.state, value);
    this.emit("state", { ...this.state });
  }
  async stop() {
    this.generation++;this.cancel();clearTimeout(this.idleTimer);clearInterval(this.memoryTimer);
    if(this.stopping)return this.stopping;
    const child=this.child;this.child=null;
    const halt=async()=>{
      if(child && child.exitCode===null && child.signalCode===null) {
        const exited=new Promise(resolve=>child.once('exit',resolve));
        child.kill('SIGTERM');await Promise.race([exited,delay(2500)]);
        if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await Promise.race([exited,delay(1000)]);}
        if(child.exitCode===null&&child.signalCode===null){this.child=child;throw new Error('The previous model has not exited. Model switching is blocked.');}
      }
      this.base=null;this.token=null;this.modelConfig=null;this.memoryGuard=null;
      this.set({status:'idle',modelId:null,error:null,contextSize:null,contextLimit:null,powerMode:null,memoryPolicy:null,admissionMode:null,executionMode:null,gpuLayers:null,resourceWarning:null,estimatedMemory:0,memoryBreakdown:null,notice:null});
    };
    this.stopping=halt();
    try{await this.stopping;}finally{this.stopping=null;}
  }
  configure(settings) { this.settings = { ...this.settings, ...settings }; this.scheduleIdle(); }
  async checkMemorySafety(child = this.child, generation = this.generation) {
    if (!child || this.child !== child || this.memorySampling || this.state.admissionMode !== 'os-managed') return;
    this.memorySampling = true;
    try {
      let memory;
      try { memory = await this.sampleMemory(child.pid); } catch {}
      if (this.child !== child || generation !== this.generation) return;
      const decision = this.memoryGuard.evaluate(memory);
      if (decision.action === 'stop') {
        const notice = `Model focused work stopped and the model unloaded. ${decision.reason} Saved files are retained.`;
        this.emit('memory-stop', notice);
        try { await this.stop(); this.set({ notice }); }
        catch (error) { this.set({ status: 'error', error: error.message, notice }); }
      } else {
        const warning = decision.action === 'warn' ? `${decision.reason} Recovery allowance: ${Math.ceil(decision.graceRemainingMs / 1000)} seconds.` : null;
        if (warning !== this.state.resourceWarning) this.set({ resourceWarning: warning });
      }
    } finally { this.memorySampling = false; }
  }
  acquire() { this.leases++; clearTimeout(this.idleTimer); }
  async waitForMemoryRecovery() {
    const generation = this.generation;
    while (this.state.resourceWarning && this.child) {
      await delay(250);
      if (generation !== this.generation) throw new DOMException('Stopped.', 'AbortError');
    }
  }
  release() { this.leases = Math.max(0, this.leases - 1); this.lastUsed = Date.now(); this.scheduleIdle(); }
  scheduleIdle() {
    clearTimeout(this.idleTimer);
    if (this.leases || this.state.status !== 'ready') return;
    const seconds = this.settings.idleUnloadSeconds;
    this.idleTimer = setTimeout(() => {
      if (!this.leases && !this.controller) this.stop().then(() => this.set({notice:'Idle model unloaded to release unified memory.'})).catch(error=>this.set({status:'error',error:error.message}));
      else this.scheduleIdle();
    }, seconds * 1000);
    this.idleTimer.unref?.();
  }
  async start(model, binary, contextLimit = 0, requirements = {}) {
    if(this.starting)throw new Error('A model load is already in progress.');
    this.starting = true;
    try { return await this.startModel(model, binary, contextLimit, requirements); }
    finally { this.starting = false; }
  }
  async startModel(model, binary, contextLimit, requirements) {
    const generation = this.generation + 1;
    const cancellation = this.cancelEpoch + 1;
    await this.stop();
    if(generation !== this.generation || cancellation !== this.cancelEpoch)return;
    const memory = await this.sampleMemory();
    const plan = planModel(model, contextLimit, memory, { memoryPolicy: this.settings.memoryPolicy, executionMode: this.settings.executionMode, ...requirements });
    const context = plan.context;
    if(generation !== this.generation || cancellation !== this.cancelEpoch)return;

    if (!binary)
      throw new Error(
        "llama-server was not found. Choose its executable in Settings.",
      );
    const p = await this.allocatePort();
    if(generation !== this.generation || cancellation !== this.cancelEpoch)return;
    this.token = crypto.randomBytes(32).toString("hex");
    this.base = `http://127.0.0.1:${p}`;
    this.log = "";
    this.modelConfig = { model, binary, contextLimit };
    const cpuOnly = this.settings.executionMode === 'cpu';
    this.set({ status: "loading", modelId: model.id, error: null, notice: plan.message || `Allocated ${context / 1024}K context; grows when needed up to ${plan.contextLimit / 1024}K.`, contextSize: context, contextLimit, powerMode: this.settings.powerMode, memoryPolicy: plan.memoryPolicy, admissionMode: plan.admissionMode, executionMode: this.settings.executionMode, gpuLayers: cpuOnly ? 0 : plan.gpuLayers ?? null, resourceWarning: null, estimatedMemory: plan.estimatedMemory, memoryBreakdown: plan.memoryBreakdown });
    const child = this.spawnProcess(binary,
      runtimeArguments(model, p, context, this.settings.powerMode, os.cpus().length, plan.gpuLayers, this.settings.executionMode),
      { env: { ...process.env, LLAMA_API_KEY: this.token }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    this.child = child;
    if (plan.admissionMode === 'os-managed') {
      this.memoryGuard = new MemoryPressureGuard({ baselineSwap: memory.swapUsedMemory });
      this.memoryTimer = setInterval(() => this.checkMemorySafety(child, generation), this.memoryPollInterval);
      this.memoryTimer.unref?.();
    }
    const log = (chunk) => {
      this.log = (this.log + chunk.toString()).slice(-14000);
      this.pendingLog = ((this.pendingLog || '') + chunk.toString()).slice(-30000);
      if(!this.logTimer)this.logTimer = setTimeout(() => {this.emit('log',this.pendingLog);this.pendingLog='';this.logTimer=null;},100);
    };
    child.stderr.on("data", log);
    child.stdout.on("data", log);
    child.on("error", (e) => {
      if (this.child === child) this.set({ status: "error", error: e.message });
    });
    child.on("exit", (code, signal) => {
      if (this.child === child) {
        clearInterval(this.memoryTimer);
        this.child = null;
        this.set({
          status: "error",
          error: `The model process stopped (${signal || code}). ${this.log.slice(-900)}`,
        });
      }
    });
    try {
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        if (generation !== this.generation || cancellation !== this.cancelEpoch) {
          if (this.child === child) await this.stop();
          return;
        }
        if (this.state.status === "error") throw new Error(this.state.error);
        try {
          const response = await this.fetcher(`${this.base}/v1/models`, {
            headers: { Authorization: `Bearer ${this.token}` },
            signal: AbortSignal.timeout(1500),
          });
          if (response.ok) {
            if(generation !== this.generation || cancellation !== this.cancelEpoch)return;
            this.set({ status: "ready" });
            this.scheduleIdle();
            return;
          }
        } catch {}
        await delay(300);
      }
      throw new Error(
        "Model loading exceeded three minutes. Try a smaller model or check the runtime output.",
      );
    } catch (error) {
      if (generation === this.generation) {
        await this.stop();
        this.set({ status: "error", modelId: model.id, error: error.message });
      }
      throw error;
    }
  }
  cancel() {
    this.cancelEpoch++;
    this.controller?.abort();
  }
  async tokenCount(messages) {
    const headers = {"Content-Type":"application/json", Authorization:`Bearer ${this.token}`};
    try {
      const rendered = await this.fetcher(`${this.base}/apply-template`, {method:"POST",headers,body:JSON.stringify({messages,add_generation_prompt:true,chat_template_kwargs:{enable_thinking:false}}),signal:AbortSignal.timeout(5000)});
      if(!rendered.ok) throw new Error('Template unavailable');
      const {prompt} = await rendered.json();
      const response = await this.fetcher(`${this.base}/tokenize`, {method:"POST",headers,body:JSON.stringify({content:prompt,add_special:true}),signal:AbortSignal.timeout(5000)});
      if(!response.ok) throw new Error('Tokenizer unavailable');
      return (await response.json()).tokens.length;
    } catch { return Buffer.byteLength(JSON.stringify(messages)) + 256; }
  }
  async ensureContext(messages, outputReserve, inputTokens) {
    const cancellation = this.cancelEpoch;
    const count = inputTokens ?? await this.tokenCount(messages);
    if (cancellation !== this.cancelEpoch) throw new DOMException('Stopped.', 'AbortError');
    if (this.state.status !== 'ready' || !this.modelConfig) throw new Error('Load a model before preparing a response.');
    if (count + outputReserve <= this.state.contextSize) return count;
    if (this.state.resourceWarning) throw new ContextCapacityError('Context cannot grow until memory pressure has recovered. Shorten the conversation or wait for normal pressure.');
    const config = this.modelConfig;
    const memory = await this.sampleMemory();
    if (cancellation !== this.cancelEpoch) throw new DOMException('Stopped.', 'AbortError');
    // Preflight the extra context allocation while this model remains resident.
    // The real admission check samples again after its process exits.
    try {
      planModel(config.model, config.contextLimit, {
        ...memory, availableMemory: Math.min(memory.totalMemory, memory.availableMemory + this.state.estimatedMemory),
      }, { memoryPolicy: this.settings.memoryPolicy, executionMode: this.settings.executionMode, minimumContext: count + outputReserve, preferredContext: count + outputReserve });
    } catch (error) { throw new ContextCapacityError(error.message); }
    await this.start(config.model, config.binary, config.contextLimit,
      { minimumContext: count + outputReserve, preferredContext: count + outputReserve });
    if (this.state.status !== 'ready') throw new DOMException('Stopped.', 'AbortError');
    return count;
  }
  async action(messages, schema, onProgress) {
    if(this.state.status !== 'ready' || this.controller) throw new Error('Load a model and wait for the current response.');
    const controller = new AbortController(); this.controller = controller;
    this.acquire();
    try {
      return await streamAction({ url: `${this.base}/v1/chat/completions`, token: this.token, messages, schema, controller, maxTokens: actionOutputBudget(this.state.contextSize), onProgress, fetcher: this.fetcher });
    } finally { if(this.controller === controller) this.controller = null; this.release(); }
  }
  async chat(request, onToken) {
    if (this.state.status !== "ready")
      throw new Error("Load a local model before sending a message.");
    if (this.controller)
      throw new Error(
        "A response is already running. Stop it before starting another.",
      );
    const inputTokens = await this.ensureContext(request.messages, 1536 + 256);
    if (this.state.status !== "ready" || this.controller) throw new Error("The model changed while preparing the response. Retry the message.");
    const controller = new AbortController();
    this.controller = controller;
    this.acquire();
    const timer = setTimeout(() => controller.abort(), 180000);
    try {
      const response = await this.fetcher(`${this.base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({
          messages: request.messages,
          stream: true,
          temperature: 0.3,
          max_tokens: Math.min(1536, this.state.contextSize - inputTokens - 256),
          reasoning_budget_tokens: 0,
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error((await response.text()).slice(0, 1000));
      let pending = "";
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (raw === "[DONE]") return;
          let item;
          try {
            item = JSON.parse(raw);
          } catch {
            continue;
          }
          if (item.error)
            throw new Error(item.error.message || "Local inference failed.");
          const delta = item.choices?.[0]?.delta?.content;
          if (delta) onToken(delta);
        }
      }
    } finally {
      clearTimeout(timer);
      if (this.controller === controller) this.controller = null;
      this.release();
    }
  }
}
