import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Workspace} from '../electron/library.mjs';
import {SandboxRunner} from '../electron/sandbox.mjs';
import {CodingAgent} from '../electron/agent.mjs';
async function fixture(t){const parent=await fs.mkdtemp(path.join(os.tmpdir(),'nexus-agent-test-'));const root=path.join(parent,'project');await fs.mkdir(root);t.after(()=>fs.rm(parent,{recursive:true,force:true}));return {parent,root};}
test('manual create opens nested files; never overwrites or follows an escape',async t=>{
 const {parent,root}=await fixture(t),w=new Workspace();await w.open(root);
 assert.equal((await w.create('src/index.js')).content,'');await w.create('assets',true);
 await assert.rejects(w.create('src/index.js'),/exists|changed/);
 await assert.rejects(w.create('../escape.txt'),/traversal/);
 await fs.symlink(parent,path.join(root,'link'));await assert.rejects(w.create('link/escape.txt'),/Symlinks/);
 assert.equal((await fs.stat(path.join(root,'assets'))).isDirectory(),true);
});
test('sandbox creates files and enforces read-before-write with external conflict checks',async t=>{
 const {root}=await fixture(t),s=await SandboxRunner.create(root);t.after(()=>s.cancel());await s.preflight();
 await assert.rejects(SandboxRunner.create('/usr'),/specific project/);
 await assert.rejects(SandboxRunner.create(os.homedir()),/specific project/);
 const created=await s.file({tool:'write_file',path:'src/index.js',content:'one',expected:null});
 await assert.rejects(s.file({tool:'write_file',path:'src/index.js',content:'two',expected:null}),/read it/);
 await fs.writeFile(path.join(root,'src/index.js'),'external');
 await assert.rejects(s.file({tool:'write_file',path:'src/index.js',content:'two',expected:created.version}),/changed/);
 await assert.rejects(s.file({tool:'write_file',path:'../outside',content:'x'}),/traversal/);
 await s.file({tool:'write_file',path:'.env',content:'PROJECT_TEST=1',expected:null});
 assert.equal((await s.file({tool:'read_file',path:'.env'})).content,'PROJECT_TEST=1');
});
test('OS sandbox blocks outside read/write, symlink escapes, network, including child processes',async t=>{
 const {root,parent}=await fixture(t),s=await SandboxRunner.create(root);t.after(()=>s.cancel());
 const outside=path.join(parent,'outside.txt');await fs.writeFile(outside,'private');await fs.writeFile(path.join(root,'.env'),'secret');await fs.symlink(parent,path.join(root,'escape'));
 await fs.writeFile(path.join(root,'probe.cjs'),`const fs=require('fs'),assert=require('assert/strict'),{spawnSync}=require('child_process');
 for(const p of [${JSON.stringify(outside)},'escape/outside.txt'])assert.throws(()=>fs.readFileSync(p));
 assert.throws(()=>fs.writeFileSync(${JSON.stringify(path.join(parent,'leak'))},'x'));
 const child=spawnSync(process.execPath,['-e',${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(path.join(parent,'child-leak'))},'x')`)}]);assert.notEqual(child.status,0);
 const net=require('net');const client=net.connect({host:'127.0.0.1',port:9});client.on('connect',()=>{throw Error('network escaped')});client.on('error',e=>{assert(['EPERM','EACCES'].includes(e.code));console.log('ALL DENIED')});`);
 const result=await s.check(['node','probe.cjs']);assert.equal(result.code,0,result.stderr);assert.match(result.stdout,/ALL DENIED/);
 await assert.rejects(s.check(['npm','install']),/Allowed npm/);await assert.rejects(s.check(['sh','-c','echo hi']),/support/);
});
test('check failure and cancellation retain actual status',async t=>{
 const {root}=await fixture(t),s=await SandboxRunner.create(root);t.after(()=>s.cancel());
 await fs.writeFile(path.join(root,'fail.cjs'),'process.exit(7)');assert.equal((await s.check(['node','fail.cjs'])).code,7);
 await fs.writeFile(path.join(root,'wait.cjs'),'setInterval(()=>{},1000)');const wait=s.check(['node','wait.cjs']);setTimeout(()=>s.cancel(),300);const result=await wait;assert.equal(result.cancelled,true);assert.equal(result.signal,'SIGKILL');
});
test('agent creates multiple files, tests, fixes a failure and reports host verification',async t=>{
 const {root}=await fixture(t);const actions=[
 {tool:'write_file',path:'sum.cjs',content:'module.exports=(a,b)=>a-b;'},
 {tool:'write_file',path:'sum.test.cjs',content:"require('node:assert/strict').equal(require('./sum.cjs')(2,3),5);"},
 {tool:'run_check',command:['node','sum.test.cjs']},
 {tool:'read_file',path:'sum.cjs'},
 {tool:'write_file',path:'sum.cjs',content:'module.exports=(a,b)=>a+b;'},
 {tool:'run_check',command:['node','sum.test.cjs']},
 {tool:'finish',summary:'Created and tested addition.'}];
 const runtime={state:{status:'ready',contextSize:65536},cancel(){},tokenCount:async()=>1000,action:async()=>actions.shift()};
 const events=[],agent=new CodingAgent(runtime,{onEvent:e=>events.push(e)});const result=await agent.run({id:'test',root,prompt:'Build and test addition'});
 assert.equal(result.verified,true);assert.equal(result.changes.length,2);assert.equal(result.checks,2);assert.equal(events.filter(e=>e.type==='check')[0].code,1);
 assert.equal(await fs.readFile(path.join(root,'sum.cjs'),'utf8'),'module.exports=(a,b)=>a+b;');
});
test('agent cannot label failed or absent checks as verified',async t=>{
 const {root}=await fixture(t);const runtime={state:{status:'ready',contextSize:65536},cancel(){},tokenCount:async()=>1000,action:async()=>({tool:'finish',summary:'All tests pass!'})};
 const result=await new CodingAgent(runtime).run({id:'false-claim',root,prompt:'Check project'});assert.equal(result.verified,false);assert.match(result.verification,/No checks ran/);
});
