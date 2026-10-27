import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { LspServerConfig } from './config';

// Experimental LSP client (FR-5.7): just enough of the protocol for code-aware
// tools — initialize → didOpen → definition / references / hover. One process
// per configured server, Content-Length framed JSON-RPC over stdio.
// Servers are bound to file extensions in the config:
//   lumencode config is not the place — use `lumencode lsp add <id> <ext,ext> <command...>`
// or edit ~/.lumen-cli/config.json ("lspServers").

interface JsonRpcMessage { jsonrpc?: string; id?: number; method?: string; result?: unknown; error?: { code?: number; message?: string }; params?: unknown }

const REQUEST_TIMEOUT_MS = 20_000;

export class LspClient {
 private proc: ChildProcess | null = null;
 private buffer = Buffer.alloc(0);
 private nextId = 1;
 private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
 private ready: Promise<void> | null = null;
 private opened = new Set<string>();

 constructor(private server: LspServerConfig, private root: string) {}

 private send(msg: Record<string, unknown>): void {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  this.proc?.stdin?.write(`Content-Length: ${body.length}\r\n\r\n`);
  this.proc?.stdin?.write(body);
 }

 private request<T>(method: string, params: unknown): Promise<T> {
  const id = this.nextId++;
  return new Promise<T>((resolve, reject) => {
   const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`LSP "${method}" timed out`)); }, REQUEST_TIMEOUT_MS);
   this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
   this.send({ jsonrpc: '2.0', id, method, params });
  });
 }

 private onData = (chunk: Buffer): void => {
  this.buffer = Buffer.concat([this.buffer, chunk]);
  for (;;) {
   const headEnd = this.buffer.indexOf('\r\n\r\n');
   if (headEnd < 0) return;
   const m = /Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, headEnd).toString('latin1'));
   if (!m) { this.buffer = this.buffer.subarray(headEnd + 4); continue; }
   const len = Number(m[1]);
   if (this.buffer.length < headEnd + 4 + len) return;
   const body = this.buffer.subarray(headEnd + 4, headEnd + 4 + len).toString('utf8');
   this.buffer = this.buffer.subarray(headEnd + 4 + len);
   let msg: JsonRpcMessage;
   try { msg = JSON.parse(raw(body)) as JsonRpcMessage; } catch { continue; }
   if (msg.id === undefined) continue; // server notifications are ignored
   const entry = this.pending.get(Number(msg.id));
   if (!entry) continue;
   this.pending.delete(Number(msg.id));
   clearTimeout(entry.timer);
   if (msg.error) entry.reject(new Error(msg.error.message || 'LSP error ' + msg.error.code));
   else entry.resolve(msg.result);
  }
 };

 connect(): Promise<void> {
  if (this.ready) return this.ready;
  this.ready = new Promise<void>((resolve, reject) => {
   this.proc = spawn(this.server.command, [], { shell: true, windowsHide: true, cwd: this.root, stdio: ['pipe', 'pipe', 'pipe'] });
   this.proc.stderr?.on('data', () => { /* server logs — ignored */ });
   this.proc.on('error', e => { this.teardown(); reject(new Error('Could not start LSP server "' + this.server.id + '": ' + e.message)); });
   this.proc.on('exit', () => this.teardown());
   this.proc.stdout?.on('data', this.onData);
   this.request('initialize', {
    processId: process.pid,
    rootUri: 'file:///' + this.root.replace(/\\/g, '/'),
    capabilities: { textDocument: { definition: {}, references: {}, hover: {} } },
    clientInfo: { name: 'lumencode', version: '1.1.0' },
   })
    .then(() => { this.send({ jsonrpc: '2.0', method: 'initialized', params: {} }); resolve(); })
    .catch(e => { this.teardown(); reject(e instanceof Error ? e : new Error('LSP initialize failed')); });
  });
  return this.ready;
 }

 // didOpen is required before most servers will answer position queries.
 private async ensureOpen(absPath: string): Promise<void> {
  const uri = 'file:///' + absPath.replace(/\\/g, '/');
  if (this.opened.has(uri)) return;
  const text = fs.readFileSync(absPath, 'utf8');
  this.send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: languageId(absPath), version: 1, text } } });
  this.opened.add(uri);
 }

 async query(method: 'textDocument/definition' | 'textDocument/references' | 'textDocument/hover', absPath: string, line: number, character: number): Promise<unknown> {
  await this.connect();
  await this.ensureOpen(absPath);
  const params: Record<string, unknown> = {
   textDocument: { uri: 'file:///' + absPath.replace(/\\/g, '/') },
   position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) }, // tool args are 1-based
  };
  if (method === 'textDocument/references') params.context = { includeDeclaration: true };
  return this.request(method, params);
 }

 teardown(): void {
  for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('LSP server stopped')); }
  this.pending.clear();
  try { this.proc?.kill(); } catch { /* already dead */ }
  this.proc = null;
  this.ready = null;
  this.opened.clear();
 }
}

// helpers -----------------------------------------------------------------

function languageId(file: string): string {
 const ext = path.extname(file).toLowerCase();
 const map: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.jsx': 'javascriptreact',
  '.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java', '.c': 'c', '.cpp': 'cpp', '.h': 'c',
  '.cs': 'csharp', '.rb': 'ruby', '.php': 'php', '.json': 'json', '.md': 'markdown',
 };
 return map[ext] ?? ext.slice(1) ?? 'plaintext';
}

const clients = new Map<string, LspClient>();

export function lspServerFor(servers: LspServerConfig[] | undefined, file: string): LspServerConfig | null {
 const ext = path.extname(file).toLowerCase();
 return servers.find(s => s.extensions.map(e => e.toLowerCase()).includes(ext)) ?? null;
}

export async function lspQuery(
 servers: LspServerConfig[] | undefined,
 root: string,
 action: 'definition' | 'references' | 'hover',
 relPath: string,
 line: number,
 character: number,
): Promise<string> {
 const absPath = path.resolve(root, relPath);
 if (!fs.existsSync(absPath)) throw new Error('File not found: ' + relPath);
 const server = lspServerFor(servers ?? [], absPath);
 if (!server) throw new Error(`No LSP server configured for "${path.extname(absPath)}" files. Add one: lumencode lsp add <id> ${path.extname(absPath)} <command...>`);
 const key = server.id + '|' + root;
 let client = clients.get(key);
 if (!client) { client = new LspClient(server, root); clients.set(key, client); }
 const method = action === 'definition' ? 'textDocument/definition' : action === 'references' ? 'textDocument/references' : 'textDocument/hover';
 const result = await client.query(method, absPath, line, character);
 return formatLspResult(action, result);
}

interface LspLocation { uri?: string; range?: { start?: { line?: number; character?: number } } }

function formatLspResult(action: string, result: unknown): string {
 if (action === 'hover') {
  const hover = result as { contents?: unknown } | null;
  const text = typeof hover?.contents === 'string' ? hover.contents
   : Array.isArray(hover?.contents) ? (hover.contents as Array<{ value?: string }>).map(c2 => c2.value ?? '').join('\n')
   : JSON.stringify(hover?.contents ?? '');
  return text ? String(text).slice(0, 4000) : '(no hover information)';
 }
 const locations = (Array.isArray(result) ? result : result ? [result] : []) as LspLocation[];
 if (!locations.length) return '(no results)';
 return locations.slice(0, 20).map(l => {
  const file = (l.uri ?? '').replace(/^file:\/\/\//, '');
  const line = (l.range?.start?.line ?? 0) + 1;
  const char = (l.range?.start?.character ?? 0) + 1;
  return `${file}:${line}:${char}`;
 }).join('\n');
}

export function lspShutdown(): void {
 for (const c of clients.values()) c.teardown();
 clients.clear();
}
