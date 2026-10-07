import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';

// MCP's public Transport contract plus process-group ownership. A server's
// subprocesses must not survive the task that started them.
export class ProjectStdioTransport {
  constructor(options) {
    this.options = options;
    this.stderr = new PassThrough();
    this.buffer = new ReadBuffer({ maxBufferSize: 2 * 1024 * 1024 });
  }
  async start() {
    if (this.child || this.closed) throw new Error('MCP transport already started or closed.');
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd, env: this.options.env,
      stdio: ['pipe', 'pipe', 'pipe'], detached: true, shell: false,
    });
    this.child = child; this.pid = child.pid;
    this.exited = new Promise(resolve => child.once('close', resolve));
    child.stderr.pipe(this.stderr);
    child.stdin.on('error', e => this.onerror?.(e));
    child.stdout.on('data', chunk => {
      try {
        this.buffer.append(chunk);
        let message;
        while ((message = this.buffer.readMessage()) !== null) this.onmessage?.(message);
      } catch (e) { this.onerror?.(e); this.close().catch(() => {}); }
    });
    child.on('error', e => this.onerror?.(e));
    child.once('close', () => { this.kill('SIGKILL'); this.buffer.clear(); this.onclose?.(); });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  }
  kill(signal) {
    if (!this.pid) return;
    try { process.kill(-this.pid, signal); } catch { try { this.child?.kill(signal); } catch {} }
  }
  async send(message) {
    if (this.closed || !this.child?.stdin?.writable) throw new Error('MCP server disconnected.');
    await new Promise((resolve, reject) => this.child.stdin.write(serializeMessage(message), e => e ? reject(e) : resolve()));
  }
  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      if (this.child) {
        this.child.stdin.end(); this.kill('SIGTERM');
        let timer;
        await Promise.race([this.exited, new Promise(resolve => { timer = setTimeout(resolve, 1500); })]);
        clearTimeout(timer); this.kill('SIGKILL');
        // SIGKILL terminates remaining members of this server's process group.
        this.child = null; this.pid = null;
      }
      this.buffer.clear(); this.stderr.destroy();
    })();
    return this.closing;
  }
}
