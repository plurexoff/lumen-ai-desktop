import fs from 'node:fs';
import path from 'node:path';
import type { ToolDef } from './providers';

// Workspace file tools (OpenCode/Kilo-style, scoped down for a chat app): the model
// can list, read and search files inside ONE user-picked folder per chat, and write
// files only after a native approval dialog. Everything stays inside the workspace
// root — resolveInWorkspace is the single choke point every tool goes through.

export const MAX_TOOL_ROUNDS = 6;
export const MAX_READ_BYTES = 128 * 1024;
export const MAX_WRITE_BYTES = 1024 * 1024;
export const MAX_LIST_ENTRIES = 200;
export const MAX_SEARCH_HITS = 50;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'dist-electron', 'release', 'out', '.next', '.cache', '__pycache__']);

export interface ToolCallRequest { id: string; name: string; args: string }
export interface ToolResult { toolCallId: string; name: string; content: string; isError?: boolean }

const REL_PATH = { type: 'string', description: 'Path relative to the workspace root (no drive letters, no "..")' };
export const TOOL_DEFS: ToolDef[] = [
 { name: 'list_files', description: 'List files and folders in the workspace (recursive, depth-limited). Call with no arguments to see the root.', schema: { type: 'object', properties: { path: { ...REL_PATH, description: 'Subfolder to list; omit for the root' } } } },
 { name: 'read_file', description: 'Read a UTF-8 text file from the workspace. Large files are truncated.', schema: { type: 'object', properties: { path: REL_PATH }, required: ['path'] } },
 { name: 'search_files', description: 'Search file names and text contents for a substring (case-insensitive). Returns matching paths with line snippets.', schema: { type: 'object', properties: { query: { type: 'string', description: 'Text to find' } }, required: ['query'] } },
 { name: 'write_file', description: 'Create or fully overwrite a text file in the workspace. The user is asked to approve every write. Always read the file first if it exists.', schema: { type: 'object', properties: { path: REL_PATH, content: { type: 'string', description: 'Full new file content' } }, required: ['path', 'content'] } },
];

export const WORKSPACE_PROMPT = 'You have tools to work with files in the user\'s workspace folder (the working directory). Rules: use relative paths only; call list_files before guessing paths; read a file before rewriting it; keep answers concise and mention which files you read or changed. Writes require the user\'s approval and may be declined — respect that.';

// Resolve a model-supplied relative path inside the root, rejecting anything that
// escapes it — including via symlinks (checked against the nearest existing
// ancestor, so creating a brand-new file is allowed but a symlinked parent is not).
export function resolveInWorkspace(root: string, rel: unknown): string {
 if (typeof rel !== 'string' || !rel.trim() || rel.length > 500) throw new Error('Invalid path');
 if (path.isAbsolute(rel) || /^[a-zA-Z]:[\\/]/.test(rel)) throw new Error('Only relative paths are allowed');
 const rootAbs = path.resolve(root);
 const abs = path.resolve(rootAbs, rel);
 if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) throw new Error('Path escapes the workspace');
 // Symlink jailbreak check: realpath the deepest existing ancestor.
 let probe = abs;
 const tail: string[] = [];
 while (!fs.existsSync(probe)) {
  const parent = path.dirname(probe);
  if (parent === probe) break;
  tail.unshift(path.basename(probe));
  probe = parent;
 }
 if (fs.existsSync(probe)) {
  const real = fs.realpathSync(probe);
  if (real !== rootAbs && !real.startsWith(rootAbs + path.sep)) throw new Error('Path escapes the workspace via a symlink');
 }
 return tail.length ? path.join(probe, ...tail) : abs;
}

function isBinary(buf: Buffer): boolean {
 const n = Math.min(buf.length, 8000);
 for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
 return false;
}

export function listFiles(root: string, rel?: string): string {
 const abs = rel ? resolveInWorkspace(root, rel) : path.resolve(root);
 if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error('Not a folder');
 const base = path.resolve(root);
 const out: string[] = [];
 const walk = (dir: string, depth: number) => {
  if (depth > 4 || out.length >= MAX_LIST_ENTRIES) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  for (const e of entries) {
   if (out.length >= MAX_LIST_ENTRIES) { out.push('… (truncated)'); return; }
   if (e.name.startsWith('.')) continue;
   const full = path.join(dir, e.name);
   const entry = path.relative(base, full) || e.name;
   if (e.isDirectory()) {
    if (SKIP_DIRS.has(e.name)) continue;
    out.push(entry + '/');
    walk(full, depth + 1);
   } else if (e.isFile()) {
    out.push(entry);
   }
  }
 };
 walk(abs, 0);
 return out.join('\n');
}

export function readWorkspaceFile(root: string, rel: string): string {
 const abs = resolveInWorkspace(root, rel);
 if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error('No such file');
 const size = fs.statSync(abs).size;
 const buf = Buffer.alloc(Math.min(size, MAX_READ_BYTES + 1));
 const fd = fs.openSync(abs, 'r');
 try { fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
 if (isBinary(buf)) throw new Error('Binary file — only text files can be read');
 let text = buf.subarray(0, Math.min(buf.length, MAX_READ_BYTES)).toString('utf8');
 if (size > MAX_READ_BYTES) text += `\n… (file truncated: ${size} bytes total, showing first ${MAX_READ_BYTES})`;
 return text;
}

export function searchWorkspace(root: string, query: string): string {
 if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('Invalid query');
 const needle = query.trim().toLowerCase();
 const base = path.resolve(root);
 const hits: string[] = [];
 const visit = (dir: string, depth: number) => {
  if (depth > 6 || hits.length >= MAX_SEARCH_HITS) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
   if (hits.length >= MAX_SEARCH_HITS) return;
   if (e.name.startsWith('.')) continue;
   const full = path.join(dir, e.name);
   const rel = path.relative(base, full) || e.name;
   if (e.isDirectory()) {
    if (SKIP_DIRS.has(e.name)) continue;
    if (e.name.toLowerCase().includes(needle)) hits.push(rel + '/');
    visit(full, depth + 1);
   } else if (e.isFile()) {
    if (e.name.toLowerCase().includes(needle)) { hits.push(rel); continue; }
    try {
     const st = fs.statSync(full);
     if (st.size > MAX_READ_BYTES) continue;
     const buf = fs.readFileSync(full);
     if (isBinary(buf)) continue;
     const lines = buf.toString('utf8').split(/\r?\n/);
     for (let i = 0; i < lines.length && hits.length < MAX_SEARCH_HITS; i++) {
      if (lines[i].toLowerCase().includes(needle)) hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 160)}`);
     }
    } catch { /* unreadable file — skip */ }
   }
  }
 };
 visit(base, 0);
 return hits.length ? hits.join('\n') : 'No matches';
}

// Write goes through an approval callback (a native dialog in main.ts) — the model
// can never touch disk without an explicit "Allow" from the user.
export async function writeWorkspaceFile(root: string, rel: string, content: string, approve: (relPath: string, bytes: number) => Promise<boolean>): Promise<string> {
 if (typeof content !== 'string') throw new Error('Invalid content');
 const bytes = Buffer.byteLength(content, 'utf8');
 if (bytes > MAX_WRITE_BYTES) throw new Error(`File too large (${(bytes / 1048576).toFixed(1)} MB, max 1 MB)`);
 const abs = resolveInWorkspace(root, rel);
 const ok = await approve(path.relative(path.resolve(root), abs), bytes);
 if (!ok) throw new Error('The user declined this write');
 fs.mkdirSync(path.dirname(abs), { recursive: true });
 fs.writeFileSync(abs, content, 'utf8');
 return `Wrote ${bytes} bytes to ${path.relative(path.resolve(root), abs)}`;
}

// One call → one result string. Errors are returned AS CONTENT so the model can
// recover (wrong path → it lists and retries) instead of dying the whole turn.
export async function runToolCall(root: string, call: ToolCallRequest, approve: (relPath: string, bytes: number) => Promise<boolean>): Promise<ToolResult> {
 const done = (content: string, isError?: boolean): ToolResult => ({ toolCallId: call.id, name: call.name, content, isError });
 let args: Record<string, unknown>;
 try { args = call.args ? JSON.parse(call.args) : {}; }
 catch { return done('Invalid tool arguments (not JSON)', true); }
 try {
  switch (call.name) {
   case 'list_files': return done(listFiles(root, typeof args.path === 'string' ? args.path : undefined) || '(empty folder)');
   case 'read_file': return done(readWorkspaceFile(root, String(args.path ?? '')));
   case 'search_files': return done(searchWorkspace(root, String(args.query ?? '')));
   case 'write_file': return done(await writeWorkspaceFile(root, String(args.path ?? ''), String(args.content ?? ''), approve));
   default: return done('Unknown tool ' + call.name, true);
  }
 } catch (e) {
  return done(e instanceof Error ? e.message : 'Tool failed', true);
 }
}
