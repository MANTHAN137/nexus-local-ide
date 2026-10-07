import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { LocalRuntime } from '../electron/runtime.mjs';
import { GiB } from '../electron/memory.mjs';
import { ContextCapacityError, ModelLoadGate, runtimeArguments, runtimeMatches } from '../electron/runtime-config.mjs';

const model = { id: 'test', name: 'Test', path: '/test.gguf', size: GiB, kvBytesPerToken: 65536, context: 131072 };
function fixture() {
  const children = [], argumentsSeen = [];
  let inputTokens = 20;
  const runtime = new LocalRuntime({
    sampleMemory: async () => ({ totalMemory: 24*GiB, availableMemory: 18*GiB, pressure: 'normal' }),
    allocatePort: async () => 1234,
    spawnProcess: (_binary,args) => {
      argumentsSeen.push(args);
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.exitCode = null; child.signalCode = null;
      child.kill = signal => { child.signalCode=signal; queueMicrotask(()=>child.emit('exit',null,signal)); return true; };
      children.push(child); return child;
    },
    fetcher: async url => url.endsWith('/apply-template') ? Response.json({prompt:'test'}) : url.endsWith('/tokenize') ? Response.json({tokens:Array(inputTokens).fill(1)}) : Response.json({data:[]}),
  });
  return { runtime, children, argumentsSeen, tokens:n=>{inputTokens=n;} };
}

test('a 64K maximum starts small and grows once the actual input requires it', async t => {
  const f=fixture();t.after(()=>f.runtime.stop());
  await f.runtime.start(model,'/llama',65536);
  assert.equal(f.runtime.state.contextSize,4096);
  assert.equal(f.runtime.state.contextLimit,65536);
  await f.runtime.ensureContext([],1792);
  assert.equal(f.children.length,1);
  f.tokens(5000);await f.runtime.ensureContext([],1792);
  assert.equal(f.runtime.state.contextSize,8192);
  assert.equal(f.children.length,2);
  assert.equal(f.children[0].signalCode,'SIGTERM');
  await f.runtime.ensureContext([],1792);
  assert.equal(f.children.length,2);
});

test('a context ceiling rejection retains the loaded model instead of discarding it', async t => {
  const f=fixture();t.after(()=>f.runtime.stop());
  await f.runtime.start(model,'/llama',4096);f.tokens(3500);
  await assert.rejects(f.runtime.ensureContext([],1792),ContextCapacityError);
  assert.equal(f.runtime.state.status,'ready');assert.equal(f.children.length,1);
  assert.equal(f.children[0].signalCode,null);
});

test('cancellation during asynchronous memory admission never spawns a model', async () => {
  const f=fixture();let finish;
  f.runtime.sampleMemory=()=>new Promise(resolve=>{finish=resolve;});
  const starting=f.runtime.start(model,'/llama');
  while(!finish)await Promise.resolve();
  f.runtime.cancel();finish({totalMemory:24*GiB,availableMemory:18*GiB,pressure:'normal'});
  await starting;
  assert.equal(f.children.length,0);assert.equal(f.runtime.state.status,'idle');
});

test('cancellation while tokenizing cannot revive inference or grow a cache', async t => {
  const f=fixture();t.after(()=>f.runtime.stop());await f.runtime.start(model,'/llama');
  let finish;f.runtime.tokenCount=()=>new Promise(resolve=>{finish=resolve;});
  const preparing=f.runtime.ensureContext([],1792);f.runtime.cancel();finish(6000);
  await assert.rejects(preparing,{name:'AbortError'});assert.equal(f.children.length,1);
});

test('load gate reserves before the first await and cancellation survives metadata inspection', async () => {
  const gate=new ModelLoadGate();let finish,spawns=0;
  const loading=gate.run(async current=>{await new Promise(resolve=>{finish=resolve;});if(current())spawns++;});
  assert.equal(gate.busy,true);await assert.rejects(gate.run(async()=>{}),/already loading/);
  gate.cancel();finish();await loading;
  assert.equal(spawns,0);assert.equal(gate.busy,false);
});

test('runtime reuse honors model, context maximum and energy profile', () => {
  const state={status:'ready',modelId:'9b',contextSize:4096,contextLimit:0,powerMode:'balanced',memoryPolicy:'protect',executionMode:'auto'};
  assert.equal(runtimeMatches(state,'9b',0,'balanced'),true);
  assert.equal(runtimeMatches(state,'27b',0,'balanced'),false);
  assert.equal(runtimeMatches(state,'9b',65536,'balanced'),false);
  assert.equal(runtimeMatches(state,'9b',0,'cool'),false);
  assert.equal(runtimeMatches(state,'9b',0,'balanced',8192),false);
  assert.equal(runtimeMatches(state,'9b',0,'balanced',4096,'managed'),false);
  assert.equal(runtimeMatches(state,'9b',0,'balanced',4096,'protect','cpu'),false);
});

test('model focused admission loads a physically bounded model and unloads at critical pressure', async t => {
  const f=fixture();t.after(()=>f.runtime.stop());
  let pressure='normal',stops=0;
  f.runtime.sampleMemory=async()=>({totalMemory:24*GiB,availableMemory:8.5*GiB,wiredMemory:3*GiB,compressedMemory:4*GiB,pressure,source:'darwin-vmstat',sampledAt:Date.now()});
  f.runtime.configure({memoryPolicy:'managed'});
  f.runtime.on('memory-stop',()=>{stops++;});
  await f.runtime.start({...model,size:10*GiB,kvBytesPerToken:34816},'/llama');
  assert.equal(f.runtime.state.admissionMode,'os-managed');
  assert.equal(f.runtime.state.contextSize,4096);
  pressure='critical';await f.runtime.checkMemorySafety();
  assert.equal(stops,1);assert.equal(f.children[0].signalCode,'SIGTERM');
  assert.equal(f.runtime.state.status,'idle');assert.match(f.runtime.state.notice,/pressure/);
});

test('model focused refuses a stale or unavailable pressure reading before spawning', async () => {
  const f=fixture();f.runtime.configure({memoryPolicy:'managed'});
  f.runtime.sampleMemory=async()=>({totalMemory:24*GiB,availableMemory:8.5*GiB,wiredMemory:3*GiB,compressedMemory:4*GiB,pressure:'unknown',source:'darwin-vmstat',sampledAt:Date.now()});
  await assert.rejects(f.runtime.start({...model,size:10*GiB},'/llama'),/safe budget/);
  assert.equal(f.children.length,0);
});

test('a late pressure sample cannot unload a replacement model', async t => {
  const f=fixture();t.after(()=>f.runtime.stop());
  f.runtime.sampleMemory=async()=>({totalMemory:24*GiB,availableMemory:8.5*GiB,wiredMemory:3*GiB,compressedMemory:4*GiB,pressure:'normal',source:'darwin-vmstat',sampledAt:Date.now()});
  f.runtime.configure({memoryPolicy:'managed'});
  await f.runtime.start({...model,size:10*GiB,kvBytesPerToken:34816},'/llama');
  let finish;f.runtime.sampleMemory=()=>new Promise(resolve=>{finish=resolve;});
  const checking=f.runtime.checkMemorySafety();await f.runtime.stop();
  f.runtime.sampleMemory=async()=>({totalMemory:24*GiB,availableMemory:18*GiB,pressure:'normal'});
  await f.runtime.start(model,'/llama');
  finish({pressure:'critical',availableMemory:0});await checking;
  assert.equal(f.runtime.state.status,'ready');assert.equal(f.children[1].signalCode,null);
});

test('runtime bounds recurrent checkpoints and uses supported cool-mode flags', () => {
  const args=runtimeArguments(model,1234,4096,'cool',10);
  const value=key=>args[args.indexOf(key)+1];
  assert.equal(value('--ctx-checkpoints'),'1');assert.equal(value('--threads'),'2');
  assert.equal(value('--prio'),'-1');assert.equal(args.includes('--prio-batch'),false);
  assert.equal(value('--reasoning'),'off');assert.equal(value('--reasoning-budget'),'0');
  assert.equal(value('--parallel'),'1');assert.equal(value('--cache-ram'),'0');
});

test('memory-saving offload uses separate buffers to avoid pinning a whole mapped model file', () => {
  const args=runtimeArguments(model,1234,4096,'cool',10,24);
  const value=key=>args[args.indexOf(key)+1];
  assert.equal(value('-ngl'),'24');assert.equal(value('--fit'),'off');assert.equal(value('--load-mode'),'none');
  assert.equal(args.includes('--no-op-offload'),true);
  assert.equal(args.includes('--no-repack'),true);
});

test('CPU compatibility leaves weights mapped without Metal residency or warmup', () => {
  const args=runtimeArguments(model,1234,4096,'cool',10,24,'cpu');
  const value=key=>args[args.indexOf(key)+1];
  assert.equal(value('-ngl'),'0');assert.equal(value('--device'),'none');assert.equal(value('--load-mode'),'mmap');
  assert.equal(args.includes('--no-kv-offload'),true);assert.equal(args.includes('--no-warmup'),true);
});
