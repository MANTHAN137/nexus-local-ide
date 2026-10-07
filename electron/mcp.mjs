import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ProjectStdioTransport } from './mcp-transport.mjs';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SandboxRunner, sandboxProfile } from './sandbox.mjs';

export function validateServer(value) {
  if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80) throw new Error('Give the server a name of up to 80 characters.');
  if (typeof value.command !== 'string' || !path.isAbsolute(value.command) || /[\0\r\n]/.test(value.command)) throw new Error('Use the absolute path of an installed server executable.');
  if (!Array.isArray(value.args) || value.args.length > 40 || value.args.some(a => typeof a !== 'string' || a.length > 2000 || a.includes('\0'))) throw new Error('Arguments must be a JSON array of strings.');
  if(value.id !== undefined && (typeof value.id!=='string'||!value.id||value.id.length>100))throw new Error('Invalid server ID.');
  return { id: value.id || crypto.randomUUID(), name: value.name.trim(), command: value.command, args: value.args, enabled: value.enabled !== false };
}

async function packageRoot(file) {
  let directory=path.dirname(file);
  while(directory!==path.dirname(directory)) {
    try{await fs.access(path.join(directory,'package.json'));return directory;}catch{}
    directory=path.dirname(directory);
  }
  return path.dirname(file);
}

// Local stdio servers run under the same project boundary as checks. No shell,
// inherited credentials, network, or unrestricted transport fallback.
export class MCPManager extends EventEmitter {
  constructor(file) { super(); this.file = file; this.config = { enabled: false, servers: [] }; this.connections = new Map(); this.catalog = []; this.epoch = 0; }
  async init() {
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.config = { enabled: data.enabled === true, servers: (data.servers || []).map(validateServer).slice(0, 12) };
    } catch (e) { if (e.code !== 'ENOENT') this.config.error = 'MCP settings could not be read. Add the servers again.'; }
  }
  state() { return { ...this.config, servers: this.config.servers.map(s => ({ ...s, status: this.connections.get(s.id)?.status || 'disconnected', error: this.connections.get(s.id)?.error, toolCount: this.connections.get(s.id)?.tools?.length || 0 })) }; }
  publish() { this.emit('state', this.state()); }
  async update(value) {
    if (!value || typeof value.enabled !== 'boolean' || !Array.isArray(value.servers) || value.servers.length > 12) throw new Error('Configure up to 12 MCP servers.');
    const next = { enabled: value.enabled, servers: value.servers.map(validateServer) };
    if (new Set(next.servers.map(s => s.id)).size !== next.servers.length) throw new Error('Server IDs must be unique.');
    await this.close();
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = this.file + '.tmp';
    await fs.writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    await fs.rename(temp, this.file); this.config = next; this.publish(); return this.state();
  }
  async connect(root, onEvent = () => {}) {
    await this.close();
    if (!this.config.enabled) return [];
    const epoch = this.epoch;
    const runner = await SandboxRunner.create(root);
    for (const server of this.config.servers.filter(s => s.enabled)) {
      if (epoch !== this.epoch) throw new Error('MCP connection cancelled.');
      const entry = { status: 'connecting', tools: [] };
      this.connections.set(server.id, entry); this.publish();
      onEvent({ type: 'mcp', text: `Connecting ${server.name}` });
      try {
        const executable = await fs.realpath(server.command); await fs.access(executable, 1);
        entry.scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-mcp-'));
        entry.scratch = await fs.realpath(entry.scratch);
        const args = server.args.map(a => a.replaceAll('${PROJECT_ROOT}', runner.root));
        const readPaths = [executable, ...Object.values(runner.tools), ...args.filter(a => path.isAbsolute(a) && !a.startsWith(runner.root + path.sep))];
        for(const arg of args.filter(a=>path.isAbsolute(a))){const root=await packageRoot(arg);if(root!==path.dirname(root))readPaths.push(path.join(root,'package.json'));}
        const env = { PATH: `${path.dirname(executable)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, HOME: entry.scratch, TMPDIR: entry.scratch, LANG: 'en_US.UTF-8', NODE_OPTIONS: '--max-old-space-size=256', PYTHONDONTWRITEBYTECODE: '1' };
        entry.transport = new ProjectStdioTransport({ command: '/usr/bin/sandbox-exec', args: ['-p', sandboxProfile(runner.root, entry.scratch, readPaths), executable, ...args], cwd: runner.root, env, stderr: 'pipe', maxBufferSize: 2*1024*1024 });
        entry.client = new Client({ name: 'nexus', version: '0.4.1' }, { capabilities: { roots: { listChanged: false } } });
        entry.client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(runner.root).href, name: path.basename(runner.root) }] }));
        entry.client.onerror = error => { entry.error = error.message; this.publish(); };
        entry.client.onclose = () => { entry.status = 'disconnected'; this.catalog = this.catalog.filter(t => t.serverId !== server.id); this.publish(); };
        entry.transport.stderr?.on('data', chunk => {entry.stderr=((entry.stderr||'')+chunk.toString()).slice(-2000);});
        if(epoch !== this.epoch)throw new Error('MCP connection cancelled.');
        await entry.client.connect(entry.transport, { timeout: 15000 });
        if (epoch !== this.epoch) throw new Error('MCP connection cancelled.');
        let cursor;
        do {
          const result = await entry.client.listTools({ cursor }, { timeout: 10000 });
          entry.tools.push(...result.tools);
          cursor = result.nextCursor;
          if (entry.tools.length > 100) throw new Error('Server exposes more than 100 tools. Configure a smaller tool set.');
        } while (cursor);
        entry.status = 'connected';
        for (const tool of entry.tools) this.catalog.push({ key: `${server.id}:${tool.name}`, serverId: server.id, server: server.name, name: tool.name, description: (tool.description || '').slice(0, 1000), inputSchema: tool.inputSchema });
      } catch (e) {
        await entry.client?.close().catch(() => {});
        await entry.transport?.close().catch(() => {});
        if(entry.scratch) await fs.rm(entry.scratch, { recursive: true, force: true });
        entry.status = 'error'; entry.error = e.message+(entry.stderr?' · '+entry.stderr:'');
        onEvent({ type: 'error', text: `MCP ${server.name}: ${e.message}` });
      }
      this.publish();
    }
    if (epoch !== this.epoch) throw new Error('MCP connection cancelled.');
    return this.catalog;
  }
  async call(key, args, signal) {
    if (!this.config.enabled) throw new Error('MCP is OFF.');
    const tool = this.catalog.find(t => t.key === key), entry = this.connections.get(tool?.serverId);
    if (!tool || entry?.status !== 'connected') throw new Error('This MCP tool is unavailable.');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('MCP arguments must be a JSON object.');
    const result = await entry.client.callTool({ name: tool.name, arguments: args }, undefined, { timeout: 60000, signal });
    // Never retain binary media or arbitrarily large tool payloads in conversation history.
    return { isError: !!result.isError, content: (result.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').slice(0, 24000) };
  }
  async close() {
    this.epoch++; this.catalog = [];
    const entries = [...this.connections.values()]; this.connections.clear();
    for (const entry of entries) {
      await entry.client?.close().catch(() => {});
      await entry.transport?.close().catch(() => {});
      if (entry.scratch) await fs.rm(entry.scratch, { recursive: true, force: true }).catch(() => {});
    }
    this.publish();
  }
}
