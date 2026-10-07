import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
await fs.writeFile('mcp-child.pid',String(child.pid));
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const server=new Server({name:'fixture',version:'1.0.0'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'write_note',description:'Write a project note',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path']}}]}));
server.setRequestHandler(CallToolRequestSchema,async request=>{
  try{await fs.writeFile(request.params.arguments.path,'MCP wrote this');return {content:[{type:'text',text:'Note created'}]};}
  catch(e){return {isError:true,content:[{type:'text',text:e.code}]};}
});
await server.connect(new StdioServerTransport());
