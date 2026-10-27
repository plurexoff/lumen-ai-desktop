import { spawn, type ChildProcess } from 'node:child_process';
import type { ToolDef } from './providers';

// Minimal MCP (Model Context Protocol) client over stdio: LSP-style Content-Length
// framing (newline-delimited JSON is also tolerated вЂ” some servers use it). Only
// the parts a chat app needs: initialize в†’ tools/list в†’ tools/call. One process per
// configured server, cached for the session; a dead server is dropped and retried
// on the next generation instead of poisoning the session.

export interface McpToolInfo { server: string; remoteName: string; def: ToolDef }

interface JsonRpcResponse { jsonrpc?: string; id?: number | string; result?: unknown; error?: { code?: number; message?: string } }

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;
const MAX_TOOL_RESULT_CHARS = 20_000;

class McpClient {
 private proc: ChildProcess | null = null;
 private buffer = Buffer.alloc(0);
 private nextId = 1;
 private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
 private ready: Promise<void> | null = null;

 constructor(private command: string) {}

 private send(msg: Record<string, unknown>) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  this.proc?.stdin?.write(`Content-Length: ${body.length}\r\n\r\n`);
  this.proc?.stdin?.write(body);
 }

 private request<T>(method: string, params: unknown): Promise<T> {
  const id = this.nextId++;
  return new Promise<T>((resolve, reject) => {
   const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP "${method}" timed out`)); }, method === 'initialize' ? CONNECT_TIMEOUT_MS : CALL_TIMEOUT_MS);
   this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
   this.send({ jsonrpc: '2.0', id, method, params });
  });
 }

 private onData(chunk: Buffer) {
  this.buffer = Buffer.concat([this.buffer, chunk]);
  for (;;) {
   // Header-framed message
   const headEnd = this.buffer.indexOf('\r\n\r\n');
   if (this.buffer.subarray(0, 16).toString('latin1').startsWith('Content-Length:') && headEnd > 0) {
    const m = /Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, headEnd).toString('latin1'));
    if (!m) { this.buffer = this.buffer.subarray(headEnd + 4); continue; }
    const len = Number(m[1]);
    if (this.buffer.length < headEnd + 4 + len) return;
    const body = this.buffer.subarray(headEnd + 4, headEnd + 4 + len);
    this.buffer = this.buffer.subarray(headEnd + 4 + len);
    this.dispatch(body.toString('utf8'));
    continue;
   }
   // Newline-delimited fallback
   const nl = this.buffer.indexOf(0x0a);
   if (nl < 0) return;
   const line = this.buffer.subarray(0, nl).toString('utf8').trim();
   this.buffer = this.buffer.subarray(nl + 1);
   if (line.startsWith('{')) this.dispatch(line);
  }
 }

 private dispatch(raw: string) {
  let msg: JsonRpcResponse;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.id === undefined) return; // notifications carry no id
  const entry = this.pending.get(Number(msg.id));
  if (!entry) return;
  this.pending.delete(Number(msg.id));
  clearTimeout(entry.timer);
  if (msg.error) entry.reject(new Error(msg.error.message || 'MCP error ' + msg.error.code));
  else entry.resolve(msg.result);
 }

 connect(): Promise<void> {
  if (this.ready) return this.ready;
  this.ready = new Promise<void>((resolve, reject) => {
   // shell: true so "npx вЂ¦" / ".cmd" shims work on Windows. The command comes from
   // the user's own Settings вЂ” same trust level as run_command's allow-list.
   this.proc = spawn(this.command, [], { shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
   this.proc.stderr?.on('data', () => { /* server logs вЂ” ignored */ });
   this.proc.on('error', e => { this.teardown(); reject(new Error('Could not start MCP server: ' + e.message)); });
   this.proc.on('exit', () => this.teardown());
   this.proc.stdout?.on('data', (c: Buffer) => this.onData(c));
   this.request<{ protocolVersion?: string }>('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'lumen-ai-desktop', version: '1.1.0' },
   })
    .then(() => { this.send({ jsonrpc: '2.0', method: 'notifications/initialized' }); resolve(); })
    .catch(e => { this.teardown(); reject(e instanceof Error ? e : new Error('MCP initialize failed')); });
  });
  return this.ready;
 }

 async listTools(): Promise<ToolDef[]> {
  const result = await this.request<{ tools?: Array<{ name?: string; description?: string; inputSchema?: unknown }> }>('tools/list', {});
  return (result.tools ?? [])
   .filter(t => t && typeof t.name === 'string' && t.name)
   .slice(0, 50)
   .map(t => ({
    name: t.name as string,
    description: typeof t.description === 'string' ? t.description.slice(0, 500) : '',
    schema: (t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} }) as ToolDef['schema'],
   }));
 }

 async callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await this.request<{ content?: Array<{ type?: string; text?: string }>; isError?: boolean }>('tools/call', { name, arguments: args });
  const text = (result.content ?? []).map(c => (c.type === 'text' && typeof c.text === 'string' ? c.text : '')).filter(Boolean).join('\n');
  const out = text || JSON.stringify(result).slice(0, MAX_TOOL_RESULT_CHARS);
  const clipped = out.slice(0, MAX_TOOL_RESULT_CHARS);
  return (result.isError ? '[tool reported an error] ' : '') + clipped + (out.length > clipped.length ? '\nвЂ¦ (truncated)' : '');
 }

 teardown() {
  for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('MCP server stopped')); }
  this.pending.clear();
  try { this.proc?.kill(); } catch { /* already dead */ }
  this.proc = null;
  this.ready = null;
 }
}

const clients = new Map<string, McpClient>();

// Tool name prefix routes the dispatcher: mcp__<serverId>__<remoteTool>.
export function mcpToolName(serverId: string, remote: string): string { return `mcp__${serverId}__${remote}`; }

// Connect (or reuse) a server and return its tools with namespaced names.
export async function mcpTools(serverId: string, command: string): Promise<McpToolInfo[]> {
 let client = clients.get(serverId);
 if (!client) { client = new McpClient(command); clients.set(serverId, client); }
 await client.connect();
 const tools = await client.listTools();
 return tools.map(def => ({ server: serverId, remoteName: def.name, def: { ...def, name: mcpToolName(serverId, def.name) } }));
}

export async function mcpCall(serverId: string, remoteName: string, args: Record<string, unknown>): Promise<string> {
 const client = clients.get(serverId);
 if (!client) throw new Error('MCP server is not connected');
 return client.callTool(remoteName, args);
}

export function mcpDrop(serverId: string) {
 clients.get(serverId)?.teardown();
 clients.delete(serverId);
}

export function mcpShutdown() {
 for (const id of [...clients.keys()]) mcpDrop(id);
}
