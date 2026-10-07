import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GiB, parseVMStat, planModel } from '../electron/memory.mjs';
import { fileOperation, digest } from '../electron/scoped-files.mjs';
import { CodingAgent, normalizeActionPaths, validateAction } from '../electron/agent.mjs';
import { AgentTeam, DEFAULT_AGENTS } from '../electron/team.mjs';
import { LocalRuntime } from '../electron/runtime.mjs';
import { SandboxRunner } from '../electron/sandbox.mjs';

async function project(t) { const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexus-resources-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root; }
test('full project CRUD preserves conflicts, destination files and outside boundaries', async t => {
  const root=await project(t),run=r=>fileOperation(root,r);
  await run({tool:'create_directory',path:'src/deep'});
  let result=await run({tool:'write_file',path:'src/deep/a.txt',content:'hello'});
  await assert.rejects(run({tool:'delete_file',path:'src/deep/a.txt'}),/Read/);
  await run({tool:'move_file',path:'src/deep/a.txt',destination:'lib/b.txt',expected:result.version});
  assert.equal(await fs.readFile(path.join(root,'lib/b.txt'),'utf8'),'hello');
  await run({tool:'write_file',path:'src/existing.txt',content:'keep'});
  await assert.rejects(run({tool:'rename_file',path:'lib/b.txt',destination:'src/existing.txt',expected:result.version}),/exists/);
  await assert.rejects(run({tool:'move_file',path:'lib/b.txt',destination:'../escape',expected:result.version}),/traversal/);
  await run({tool:'rename_file',path:'lib',destination:'renamed'});
  await assert.rejects(run({tool:'delete_file',path:'renamed'}),/ENOTEMPTY/);
  await run({tool:'delete_file',path:'renamed/b.txt',expected:digest('hello')});
  await run({tool:'delete_file',path:'renamed'});
  await run({tool:'write_file',path:'.env',content:'LOCAL_SETTING=1'});
  await fs.symlink(os.tmpdir(),path.join(root,'escape'));
  await assert.rejects(run({tool:'write_file',path:'escape/outside',content:'bad'}),/Symlinks/);
  await fs.link(path.join(root,'.env'),path.join(root,'linked'));
  await assert.rejects(run({tool:'delete_file',path:'linked',expected:digest('LOCAL_SETTING=1')}),/Hard-linked/);
});
test('file-only agent works when external Node is unavailable',async t=>{
  const root=await project(t),runner=new SandboxRunner(await fs.realpath(root),{});
  const actions=[{tool:'write_file',path:path.join(await fs.realpath(root),'new/project.txt'),content:'created'},{tool:'finish',summary:'Created file'}];
  const runtime={state:{status:'ready',contextSize:16384},action:async()=>actions.shift(),tokenCount:async()=>100,cancel(){}};
  const result=await new CodingAgent(runtime,{runnerFactory:async()=>runner}).run({root,id:'file-only',prompt:'Create file'});
  assert.equal(result.changes.length,1);assert.equal(await fs.readFile(path.join(root,'new/project.txt'),'utf8'),'created');
});
test('memory planner accounts for cache, rejects low memory, and reduces Auto context',()=>{
  assert.equal(parseVMStat('page size of 16384 bytes\nPages free: 100.\nPages inactive: 200.\nPages speculative: 50.'),350*16384);
  const model={size:10*GiB,kvBytesPerToken:128*1024},memory={totalMemory:24*GiB,availableMemory:16*GiB,pressure:'normal'};
  const plan=planModel(model,0,memory);assert.equal(plan.context,4096);
  assert.equal(planModel(model,0,memory,{preferredContext:32768}).context,16384);
  assert.equal(planModel(model,65536,memory).context,4096);
  assert.throws(()=>planModel(model,65536,memory,{minimumContext:65536}),/safe budget/);
  assert.throws(()=>planModel(model,0,{...memory,availableMemory:2*GiB}),/safe budget/);
  assert.throws(()=>planModel(model,0,{...memory,pressure:'critical'}),/critical/);
  assert.equal(planModel({...model,context:4096},0,memory).context,4096);
});
test('team loads sequentially and marks each assigned role with its model',async()=>{
  const order=[],events=[],runtime={state:{status:'ready'},acquire(){order.push('lease');},release(){order.push('release');}};
  const agent={run:async()=>{order.push('run');return {summary:'Done',changes:[],verified:true};},cancel(){}};
  const team=new AgentTeam({agent,runtime,load:async id=>{order.push(id);},onEvent:e=>events.push(e)});
  await team.run({id:'team',root:'project',prompt:'Build',agents:DEFAULT_AGENTS.map(a=>({...a,enabled:true,modelId:a.id})),fallbackModel:null});
  assert.deepEqual(order,['lease','builder','run','reviewer','run','tester','run','release']);
  assert.equal(events.filter(e=>e.status==='completed').length,3);assert.equal(team.active,false);
});
test('cancellation while loading never starts an agent and releases its task lease',async()=>{
  let resume,ran=false,leases=0;const events=[];
  const runtime={state:{status:'loading'},stop(){},acquire(){leases++;},release(){leases--;}};
  const team=new AgentTeam({agent:{cancel(){},async run(){ran=true;}},runtime,load:()=>new Promise(r=>resume=r),onEvent:e=>events.push(e)});
  const task=team.run({id:'stop',prompt:'Build',root:'project',agents:[DEFAULT_AGENTS[0]],fallbackModel:'m'});
  team.cancel();resume();const result=await task;
  assert.equal(result.cancelled,true);assert.equal(ran,false);assert.equal(leases,0);assert.equal(events.at(-1).status,'cancelled');
});
test('cancellation reports a model termination failure without an unhandled rejection',async()=>{
  const runtime={state:{status:'loading'},stop:async()=>{throw new Error('Model process did not exit.');},set(value){Object.assign(this.state,value);}};
  const team=new AgentTeam({agent:{cancel(){}},runtime});
  team.cancel();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(runtime.state.status,'error');assert.match(runtime.state.error,/did not exit/);
});
test('idle unload is suppressed by an active task and resumes after cleanup',async t=>{
  const runtime=new LocalRuntime();t.after(()=>runtime.stop());let stops=0;
  runtime.stop=async()=>{stops++;runtime.state.status='idle';clearTimeout(runtime.idleTimer);};
  runtime.state.status='ready';runtime.configure({idleUnloadSeconds:.025});runtime.acquire();
  await new Promise(r=>setTimeout(r,45));assert.equal(stops,0);
  runtime.release();await new Promise(r=>setTimeout(r,45));assert.equal(stops,1);
});

test('agent normalizes in-project absolute paths but rejects sibling and parent escapes',()=>{
 assert.equal(normalizeActionPaths({tool:'write_file',path:'/project/src/a.js'},'/project').path,'src/a.js');
 assert.throws(()=>normalizeActionPaths({tool:'write_file',path:'/project-other/a.js'},'/project'),/outside/);
 assert.throws(()=>normalizeActionPaths({tool:'move_file',path:'a',destination:'/outside'},'/project'),/outside/);
 assert.throws(()=>validateAction({tool:'write_file',content:'missing path'}),/requires path/);
});

test('binary files can be inspected, moved and deleted without loading their contents into a prompt',async t=>{
 const root=await project(t);await fs.writeFile(path.join(root,'image.bin'),Buffer.from([0,1,255]));
 const meta=await fileOperation(root,{tool:'stat_path',path:'image.bin'});assert.equal(meta.bytes,3);
 await fileOperation(root,{tool:'move_file',path:'image.bin',destination:'assets/image.bin',expected:meta.version});
 await fileOperation(root,{tool:'delete_file',path:'assets/image.bin',expected:meta.version});
 await assert.rejects(fs.access(path.join(root,'assets/image.bin')));
});
test('a repeated action loop stops and releases the active model lease',async t=>{
 const root=await project(t);let calls=0,leases=0;
 const runtime={state:{status:'ready',contextSize:16384},tokenCount:async()=>100,action:async()=>({tool:'list_files',path:'.',reason:`Attempt ${++calls}`}),acquire(){leases++;},release(){leases--;},cancel(){}};
 const agent=new CodingAgent(runtime,{runnerFactory:async()=>new SandboxRunner(await fs.realpath(root),{})});
 await assert.rejects(agent.run({id:'loop',root,prompt:'Inspect project'}),/without progress/);
 assert.equal(calls,4);assert.equal(leases,0);assert.equal(agent.active,false);
});
