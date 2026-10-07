import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MCPManager,validateServer } from '../electron/mcp.mjs';

test('MCP validates configuration and persists ON/OFF plus per-server enablement',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexus-mcp-config-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const mcp=new MCPManager(path.join(root,'mcp.json'));await mcp.init();assert.equal(mcp.state().enabled,false);
  assert.throws(()=>validateServer({name:'bad',command:'node',args:[]}),/absolute/);
  assert.throws(()=>validateServer({name:'bad',command:'/bin/node',args:'a'}),/JSON array/);
  await mcp.update({enabled:false,servers:[{name:'Fixture',command:process.execPath,args:[],enabled:false}]});
  const other=new MCPManager(mcp.file);await other.init();assert.equal(other.state().servers[0].enabled,false);
  assert.deepEqual(await mcp.connect(root),[]);await assert.rejects(mcp.call('anything',{}),/OFF/);
});
test('real MCP stdio handshake, discovery, invocation and project boundary',async t=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'nexus-mcp-test-')),root=path.join(parent,'project');await fs.mkdir(root);
  const mcp=new MCPManager(path.join(parent,'mcp.json'));
  t.after(async()=>{await mcp.close();await fs.rm(parent,{recursive:true,force:true});});
  await mcp.update({enabled:true,servers:[{name:'Fixture',command:process.execPath,args:[path.resolve('tests/fixtures/mcp-server.mjs')],enabled:true}]});
  const tools=await mcp.connect(root);assert.equal(tools.length,1,JSON.stringify(mcp.state()));
  assert.equal((await mcp.call(tools[0].key,{path:'note.txt'})).isError,false);
  assert.equal(await fs.readFile(path.join(root,'note.txt'),'utf8'),'MCP wrote this');
  assert.equal((await mcp.call(tools[0].key,{path:path.join(parent,'outside.txt')})).isError,true);
  const result=await fs.access(path.join(parent,'outside.txt')).then(()=>true,()=>false);assert.equal(result,false);
  const childPid=Number(await fs.readFile(path.join(root,'mcp-child.pid'),'utf8'));
  await mcp.close();
  await new Promise(r=>setTimeout(r,100));
  assert.throws(()=>process.kill(childPid,0),/ESRCH/);
  assert.equal(mcp.state().servers[0].status,'disconnected');assert.equal(mcp.catalog.length,0);
});
