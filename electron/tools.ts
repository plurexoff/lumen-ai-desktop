import fs from 'node:fs';
import path from 'node:path';
import { exec, execFile } from 'node:child_process';
import type { ToolDef } from './providers';

// Workspace file tools (OpenCode/Kilo-style, scoped down for a chat app): the model
// can list, read, search and edit files inside ONE user-picked folder per chat, run
// allow-listed commands, and write only after a native approval dialog. Everything
// stays inside the workspace root — resolveInWorkspace is the single choke point
// every file tool goes through. Mutating tools snapshot the target into
// .lumen-backup/ first, so any change can be rolled back from the activity log.

export const MAX_TOOL_ROUNDS = 6;
export const MAX_READ_BYTES = 128 * 1024;
export const MAX_WRITE_BYTES = 1024 * 1024;
export const MAX_LIST_ENTRIES = 200;
export const MAX_SEARCH_HITS = 50;
export const MAX_COMMAND_OUTPUT = 32 * 1024;
export const MAX_PATCH_FILES = 20;
const COMMAND_TIMEOUT_MS = 60_000;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'dist-electron', 'release', 'out', '.next', '.cache', '__pycache__', '.lumen-backup']);

export interface ToolCallRequest { id: string; name: string; args: string }
export interface ToolResult { toolCallId: string; name: string; content: string; isError?: boolean; path?: string; snapshot?: string }

// Every disk mutation / command / network fetch goes through this callback; main
// turns it into a native dialog (with a diff preview for writes). Declining is a
// normal outcome — the model is told and can adapt.
export interface ApprovalRequest { kind: 'write' | 'delete' | 'move' | 'command' | 'commit' | 'web'; target: string; detail?: string }
export type ApproveFn = (req: ApprovalRequest) => Promise<boolean>;

const REL_PATH = { type: 'string', description: 'Path relative to the workspace root (no drive letters, no "..")' };
export const TOOL_DEFS: ToolDef[] = [
 { name: 'list_files', description: 'List files and folders in the workspace (recursive, depth-limited). Call with no arguments to see the root.', schema: { type: 'object', properties: { path: { ...REL_PATH, description: 'Subfolder to list; omit for the root' } } } },
 { name: 'read_file', description: 'Read a UTF-8 text file. Large files are truncated; use from/to for a line range of a big file.', schema: { type: 'object', properties: { path: REL_PATH, from: { type: 'number', description: 'First line (1-based)' }, to: { type: 'number', description: 'Last line (inclusive)' } }, required: ['path'] } },
 { name: 'read_many', description: 'Read several files at once. Prefer this over many read_file calls.', schema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, description: 'Relative paths (max 10)' } }, required: ['paths'] } },
 { name: 'search_files', description: 'Search file names and text contents for a substring (case-insensitive). Returns matching paths with line snippets.', schema: { type: 'object', properties: { query: { type: 'string', description: 'Text to find' } }, required: ['query'] } },
 { name: 'find_definition', description: 'Find where a function/class/variable is defined (regex-based, works for most languages).', schema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } },
 { name: 'find_references', description: 'Find all lines referencing a symbol (word-boundary match).', schema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } },
 { name: 'get_file_info', description: 'File size, modified time and line count without reading the file.', schema: { type: 'object', properties: { path: REL_PATH }, required: ['path'] } },
 { name: 'diff_files', description: 'Show a unified diff between two text files in the workspace.', schema: { type: 'object', properties: { a: REL_PATH, b: REL_PATH }, required: ['a', 'b'] } },
 { name: 'write_file', description: 'Create or fully overwrite a text file. The user approves every write and sees a diff. Always read the file first if it exists.', schema: { type: 'object', properties: { path: REL_PATH, content: { type: 'string', description: 'Full new file content' } }, required: ['path', 'content'] } },
 { name: 'edit_file', description: 'Targeted edit: replace ONE exact fragment of a file with new text. Cheaper and safer than write_file — the fragment must match exactly once. Always read the file first.', schema: { type: 'object', properties: { path: REL_PATH, old_text: { type: 'string', description: 'Exact existing fragment (must occur exactly once)' }, new_text: { type: 'string', description: 'Replacement text' } }, required: ['path', 'old_text', 'new_text'] } },
 { name: 'apply_patch', description: 'Apply a unified diff to one or more files. The user approves each file.', schema: { type: 'object', properties: { patch: { type: 'string', description: 'Unified diff (--- a/file, +++ b/file, @@ hunks)' } }, required: ['patch'] } },
 { name: 'create_folder', description: 'Create a folder (with parents). Requires approval.', schema: { type: 'object', properties: { path: REL_PATH }, required: ['path'] } },
 { name: 'delete_file', description: 'Delete a file or empty folder. Requires approval; a backup is kept for rollback.', schema: { type: 'object', properties: { path: REL_PATH }, required: ['path'] } },
 { name: 'move_file', description: 'Move/rename a file or folder. Requires approval; a backup is kept for rollback.', schema: { type: 'object', properties: { from: REL_PATH, to: REL_PATH }, required: ['from', 'to'] } },
 { name: 'run_command', description: 'Run a shell command in the workspace (allow-listed dev tools: npm, git, tsc, python…). The user approves every command; output is captured. No pipes/redirects/chaining.', schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
 { name: 'git_status', description: 'Show git status (short) of the workspace, if it is a repository.', schema: { type: 'object', properties: {} } },
 { name: 'git_diff', description: 'Show uncommitted git changes (stat + diff, truncated).', schema: { type: 'object', properties: {} } },
 { name: 'git_commit', description: 'Stage everything and commit with a message. Requires approval.', schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } },
 { name: 'memory_read', description: 'Read the long-term project memory (.lumen-memory.md) — facts you saved earlier.', schema: { type: 'object', properties: {} } },
 { name: 'memory_save', description: 'Overwrite the project memory with everything worth remembering about this project. Requires approval.', schema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } },
 { name: 'todo_write', description: 'Replace the task checklist for this chat (array of {text, done}). Use it to plan and show progress on multi-step work.', schema: { type: 'object', properties: { todos: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, done: { type: 'boolean' } }, required: ['text'] } } }, required: ['todos'] } },
 { name: 'web_fetch', description: 'Fetch a web page and return its text (docs, issues). The user approves each new domain.', schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
 { name: 'sql_query', description: 'Run a read-only SELECT query against a .sqlite/.db file or a .csv file in the workspace (data analysis). Returns rows as a table (max 50 rows).', schema: { type: 'object', properties: { path: REL_PATH, query: { type: 'string', description: 'A single SELECT statement; for CSV files use table name "data"' } }, required: ['path', 'query'] } },
 { name: 'spawn_subagent', description: 'Delegate a self-contained research subtask (e.g. "analyze the tests folder and report what is covered") to a sub-agent with READ-ONLY workspace access. Returns its findings; your own context stays clean.', schema: { type: 'object', properties: { task: { type: 'string', description: 'What the sub-agent should find out' } }, required: ['task'] } },
];

export const WORKSPACE_PROMPT = 'You have tools to work with files in the user\'s workspace folder (the working directory). Rules: use relative paths only; the project tree is attached below — read a file before rewriting it; prefer edit_file for targeted changes and write_file for new/fully-rewritten files; use todo_write to plan multi-step work and update it as you progress; memory_read/memory_save is your long-term memory about this project — check it when context matters. Writes, deletes, moves and commands require the user\'s approval and may be declined — respect that. Keep answers concise and mention which files you read or changed.';

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

export function readWorkspaceFile(root: string, rel: string, from?: number, to?: number): string {
 const abs = resolveInWorkspace(root, rel);
 if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error('No such file');
 const size = fs.statSync(abs).size;
 const buf = Buffer.alloc(Math.min(size, MAX_READ_BYTES + 1));
 const fd = fs.openSync(abs, 'r');
 try { fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
 if (isBinary(buf)) throw new Error('Binary file — only text files can be read');
 const text = buf.subarray(0, Math.min(buf.length, MAX_READ_BYTES)).toString('utf8');
 // Line-range read for big files: 1-based, inclusive, clamped.
 if (from !== undefined || to !== undefined) {
  const lines = text.split(/\r?\n/);
  const a = Math.max(1, Math.floor(from ?? 1));
  const b = Math.min(lines.length, Math.floor(to ?? lines.length));
  if (a > b) throw new Error(`Invalid line range ${from}–${to} (file has ${lines.length} lines)`);
  return lines.slice(a - 1, b).join('\n') + `\n… (lines ${a}–${b} of ${lines.length})`;
 }
 return size > MAX_READ_BYTES ? text + `\n… (file truncated: ${size} bytes total, showing first ${MAX_READ_BYTES})` : text;
}

export function readMany(root: string, paths: unknown): string {
 if (!Array.isArray(paths) || !paths.length || paths.length > 10) throw new Error('Give me 1–10 paths');
 return paths.map(p => {
  const rel = String(p ?? '');
  try { return `=== ${rel} ===\n` + readWorkspaceFile(root, rel); }
  catch (e) { return `=== ${rel} ===\n[error: ${e instanceof Error ? e.message : 'failed'}]`; }
 }).join('\n\n');
}

export function getFileInfo(root: string, rel: string): string {
 const abs = resolveInWorkspace(root, rel);
 if (!fs.existsSync(abs)) throw new Error('No such file');
 const st = fs.statSync(abs);
 if (st.isDirectory()) return `${rel}: folder`;
 let lines = 'n/a (binary)';
 const buf = Buffer.alloc(Math.min(st.size, MAX_READ_BYTES + 1));
 const fd = fs.openSync(abs, 'r');
 try { fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
 if (!isBinary(buf)) lines = String(buf.toString('utf8').split(/\r?\n/).length) + (st.size > MAX_READ_BYTES ? '+' : '');
 return `${rel}: ${st.size} bytes, ${lines} lines, modified ${new Date(st.mtimeMs).toLocaleString()}`;
}

export function searchWorkspace(root: string, query: string): string {
 if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('Invalid query');
 const needle = query.trim().toLowerCase();
 const hits: string[] = [];
 walkTextFiles(root, (rel, lines) => {
  if (hits.length >= MAX_SEARCH_HITS) return;
  const name = path.basename(rel).toLowerCase();
  if (name.includes(needle)) { hits.push(rel); return; }
  for (let i = 0; i < lines.length && hits.length < MAX_SEARCH_HITS; i++) {
   if (lines[i].toLowerCase().includes(needle)) hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 160)}`);
  }
 }, (rel) => { if (rel.toLowerCase().includes(needle) && hits.length < MAX_SEARCH_HITS) hits.push(rel + '/'); });
 return hits.length ? hits.join('\n') : 'No matches';
}

// Shared walker: visits every readable text file (path + lines) and every directory.
function walkTextFiles(root: string, onFile: (rel: string, lines: string[]) => void, onDir?: (rel: string) => void) {
 const base = path.resolve(root);
 const visit = (dir: string, depth: number) => {
  if (depth > 6) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
   if (e.name.startsWith('.')) continue;
   const full = path.join(dir, e.name);
   const rel = path.relative(base, full) || e.name;
   if (e.isDirectory()) {
    if (SKIP_DIRS.has(e.name)) continue;
    onDir?.(rel);
    visit(full, depth + 1);
   } else if (e.isFile()) {
    try {
     const st = fs.statSync(full);
     if (st.size > MAX_READ_BYTES) continue;
     const buf = fs.readFileSync(full);
     if (isBinary(buf)) continue;
     onFile(rel, buf.toString('utf8').split(/\r?\n/));
    } catch { /* unreadable file — skip */ }
   }
  }
 };
 visit(base, 0);
}

const DEF_PATTERN = (sym: string) => new RegExp(`\\b(function|class|interface|type|enum|const|let|var|def|fn|struct|impl|pub\\s+fn|export\\s+(default\\s+)?(function|class|const|let))\\s+${sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b|^\\s*${sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[=:(]`);

export function findDefinition(root: string, symbol: string): string {
 if (typeof symbol !== 'string' || !symbol.trim() || symbol.length > 100) throw new Error('Invalid symbol');
 const re = DEF_PATTERN(symbol.trim());
 const hits: string[] = [];
 walkTextFiles(root, (rel, lines) => {
  for (let i = 0; i < lines.length && hits.length < MAX_SEARCH_HITS; i++) {
   if (re.test(lines[i])) hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 160)}`);
  }
 });
 return hits.length ? hits.join('\n') : 'No definitions found';
}

export function findReferences(root: string, symbol: string): string {
 if (typeof symbol !== 'string' || !symbol.trim() || symbol.length > 100) throw new Error('Invalid symbol');
 const re = new RegExp(`\\b${symbol.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
 const hits: string[] = [];
 walkTextFiles(root, (rel, lines) => {
  for (let i = 0; i < lines.length && hits.length < MAX_SEARCH_HITS; i++) {
   if (re.test(lines[i])) hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 160)}`);
  }
 });
 return hits.length ? hits.join('\n') : 'No references found';
}

// ---- line diff (LCS) -----------------------------------------------------------
// Small, dependency-free unified diff used for approval previews, diff_files and
// edit_file. Capped at 1500 lines per side — beyond that we show a summary instead.

interface DiffOp { type: ' ' | '-' | '+'; line: string }

function lcsDiff(a: string[], b: string[]): DiffOp[] {
 const n = a.length, m = b.length;
 // dp[i][j] = LCS length of a[i..] and b[j..]
 const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
 for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
  dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
 }
 const ops: DiffOp[] = [];
 let i = 0, j = 0;
 while (i < n && j < m) {
  if (a[i] === b[j]) { ops.push({ type: ' ', line: a[i++] }); j++; }
  else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ type: '-', line: a[i++] });
  else ops.push({ type: '+', line: b[j++] });
 }
 while (i < n) ops.push({ type: '-', line: a[i++] });
 while (j < m) ops.push({ type: '+', line: b[j++] });
 return ops;
}

export function unifiedDiff(oldText: string, newText: string, fromName = 'old', toName = 'new', context = 3): string {
 const a = oldText.split('\n'), b = newText.split('\n');
 if (a.length > 1500 || b.length > 1500) return `(files too large for a diff: ${a.length} → ${b.length} lines)`;
 const ops = lcsDiff(a, b);
 const changeIdx = ops.map((o, i) => (o.type === ' ' ? -1 : i)).filter(i => i >= 0);
 if (!changeIdx.length) return '(no changes)';
 // Group changes separated by at most 2*context+1 unchanged lines into one hunk.
 const groups: Array<[number, number]> = [];
 let start = changeIdx[0], last = changeIdx[0];
 for (let k = 1; k < changeIdx.length; k++) {
  if (changeIdx[k] - last <= 2 * context + 1) last = changeIdx[k];
  else { groups.push([start, last]); start = changeIdx[k]; last = changeIdx[k]; }
 }
 groups.push([start, last]);
 const out = [`--- a/${fromName}`, `+++ b/${toName}`];
 let aPos = 1, bPos = 1, i = 0; // aPos/bPos are the 1-based line numbers at ops[i]
 for (const [g0, g1] of groups) {
  const from = Math.max(0, g0 - context);
  const to = Math.min(ops.length - 1, g1 + context);
  while (i < from) { if (ops[i].type !== '+') aPos++; if (ops[i].type !== '-') bPos++; i++; }
  const aStart = aPos, bStart = bPos;
  let aCount = 0, bCount = 0;
  const lines: string[] = [];
  for (; i <= to; i++) {
   const op = ops[i];
   lines.push(op.type + op.line);
   if (op.type !== '+') aCount++;
   if (op.type !== '-') bCount++;
  }
  aPos += aCount; bPos += bCount;
  out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`, ...lines);
 }
 return out.join('\n');
}

export function diffFiles(root: string, relA: string, relB: string): string {
 const ta = readWorkspaceFile(root, relA);
 const tb = readWorkspaceFile(root, relB);
 return unifiedDiff(ta, tb, relA, relB);
}

// ---- snapshots (rollback safety net) -------------------------------------------
// Before any mutation the old file is copied under .lumen-backup/<stamp>/<relpath>.
// The log in SQLite stores the snapshot path so a change can be rolled back later.

export function snapshotFile(root: string, abs: string): string | null {
 if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
 const rel = path.relative(path.resolve(root), abs);
 const stamp = new Date().toISOString().replace(/[:.]/g, '-');
 const dest = path.join(path.resolve(root), '.lumen-backup', stamp, rel);
 fs.mkdirSync(path.dirname(dest), { recursive: true });
 fs.copyFileSync(abs, dest);
 pruneSnapshots(root);
 return dest;
}

function pruneSnapshots(root: string, keep = 50) {
 const dir = path.join(path.resolve(root), '.lumen-backup');
 let names: string[];
 try { names = fs.readdirSync(dir); } catch { return; }
 if (names.length <= keep) return;
 names.sort();
 for (const old of names.slice(0, names.length - keep)) {
  try { fs.rmSync(path.join(dir, old), { recursive: true, force: true }); } catch { /* best effort */ }
 }
}

// Restore a snapshot back to its workspace path (used by the activity log rollback).
export function restoreSnapshot(root: string, snapshotPath: string): string {
 const backupRoot = path.join(path.resolve(root), '.lumen-backup');
 const abs = path.resolve(snapshotPath);
 if (!abs.startsWith(backupRoot + path.sep) || !fs.existsSync(abs)) throw new Error('Snapshot not found');
 const rel = path.relative(backupRoot, abs).split(path.sep).slice(1).join(path.sep);
 const target = resolveInWorkspace(root, rel);
 snapshotFile(root, target); // snapshot the CURRENT state before overwriting
 fs.mkdirSync(path.dirname(target), { recursive: true });
 fs.copyFileSync(abs, target);
 return rel;
}

// ---- mutating tools (all approval-gated) ---------------------------------------

export async function writeWorkspaceFile(root: string, rel: string, content: string, approve: ApproveFn): Promise<{ message: string; snapshot: string | null }> {
 if (typeof content !== 'string') throw new Error('Invalid content');
 const bytes = Buffer.byteLength(content, 'utf8');
 if (bytes > MAX_WRITE_BYTES) throw new Error(`File too large (${(bytes / 1048576).toFixed(1)} MB, max 1 MB)`);
 const abs = resolveInWorkspace(root, rel);
 const relPath = path.relative(path.resolve(root), abs);
 const old = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
 const diff = fs.existsSync(abs) ? unifiedDiff(old, content, relPath, relPath) : `(new file, ${bytes} bytes)`;
 const ok = await approve({ kind: 'write', target: relPath, detail: diff.slice(0, 4000) });
 if (!ok) throw new Error('The user declined this write');
 const snapshot = snapshotFile(root, abs);
 fs.mkdirSync(path.dirname(abs), { recursive: true });
 fs.writeFileSync(abs, content, 'utf8');
 return { message: `Wrote ${bytes} bytes to ${relPath}`, snapshot };
}

export async function editWorkspaceFile(root: string, rel: string, oldText: string, newText: string, approve: ApproveFn): Promise<{ message: string; snapshot: string | null }> {
 if (typeof oldText !== 'string' || !oldText) throw new Error('old_text must be a non-empty string');
 if (typeof newText !== 'string') throw new Error('new_text must be a string');
 const abs = resolveInWorkspace(root, rel);
 if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error('No such file');
 const current = fs.readFileSync(abs, 'utf8');
 const first = current.indexOf(oldText);
 if (first < 0) throw new Error('Fragment not found — read the file again and copy the exact text');
 if (current.indexOf(oldText, first + 1) >= 0) throw new Error('Fragment matches more than once — include more context to make it unique');
 const updated = current.slice(0, first) + newText + current.slice(first + oldText.length);
 if (Buffer.byteLength(updated, 'utf8') > MAX_WRITE_BYTES) throw new Error('Resulting file too large (max 1 MB)');
 const relPath = path.relative(path.resolve(root), abs);
 const ok = await approve({ kind: 'write', target: relPath, detail: unifiedDiff(current, updated, relPath, relPath).slice(0, 4000) });
 if (!ok) throw new Error('The user declined this edit');
 const snapshot = snapshotFile(root, abs);
 fs.writeFileSync(abs, updated, 'utf8');
 return { message: `Edited ${relPath} (replaced ${oldText.split('\n').length} lines with ${newText.split('\n').length})`, snapshot };
}

// Minimal unified-diff apply: ---/+++ headers + @@ hunks, exact context matching
// with a small search window for drift. Enough for model-generated patches.
export async function applyPatch(root: string, patch: string, approve: ApproveFn): Promise<string> {
 if (typeof patch !== 'string' || !patch.trim()) throw new Error('Empty patch');
 interface Hunk { aStart: number; lines: DiffOp[] }
 interface FilePatch { path: string; hunks: Hunk[] }
 const files: FilePatch[] = [];
 let cur: FilePatch | null = null;
 let hunk: Hunk | null = null;
 for (const rawLine of patch.split('\n')) {
  const line = rawLine.replace(/\r$/, '');
  const plus = line.match(/^\+\+\+ [bi]\/(.+)$/);
  if (plus) { cur = { path: plus[1].trim(), hunks: [] }; files.push(cur); hunk = null; continue; }
  const h = line.match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/);
  if (h && cur) { hunk = { aStart: Number(h[1]), lines: [] }; cur.hunks.push(hunk); continue; }
  if (hunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
   hunk.lines.push({ type: line[0] as DiffOp['type'], line: line.slice(1) });
  }
 }
 if (!files.length) throw new Error('No file sections found in the patch');
 if (files.length > MAX_PATCH_FILES) throw new Error(`Patch touches too many files (max ${MAX_PATCH_FILES})`);
 const results: string[] = [];
 for (const f of files) {
  const abs = resolveInWorkspace(root, f.path);
  const original = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  const lines = original ? original.split('\n') : [];
  let offset = 0;
  for (const h of f.hunks) {
   // Expected position (1-based → 0-based) plus accumulated drift.
   let pos = h.aStart - 1 + offset;
   const oldLen = h.lines.filter(l => l.type !== '+').length;
   const matches = (at: number) => {
    let k = at;
    for (const l of h.lines) {
     if (l.type === '+') continue;
     if (k >= lines.length || lines[k] !== l.line) return false;
     k++;
    }
    return true;
   };
   if (!matches(pos)) {
    // Search a small window for drifted context.
    let found = -1;
    for (let d = 1; d <= 20 && found < 0; d++) {
     if (pos - d >= 0 && matches(pos - d)) found = pos - d;
     else if (matches(pos + d)) found = pos + d;
    }
    if (found < 0) throw new Error(`Hunk @@ -${h.aStart} does not apply to ${f.path} (context mismatch)`);
    pos = found;
   }
   const replacement = h.lines.filter(l => l.type !== '-').map(l => l.line);
   lines.splice(pos, oldLen, ...replacement);
   offset += replacement.length - oldLen;
  }
  const updated = lines.join('\n');
  const ok = await approve({ kind: 'write', target: f.path, detail: unifiedDiff(original, updated, f.path, f.path).slice(0, 4000) });
  if (!ok) { results.push(`${f.path}: declined by user`); continue; }
  const snapshot = snapshotFile(root, abs);
  void snapshot;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, updated, 'utf8');
  results.push(`${f.path}: applied (${f.hunks.length} hunks)`);
 }
 return results.join('\n');
}

export async function createFolder(root: string, rel: string, approve: ApproveFn): Promise<string> {
 const abs = resolveInWorkspace(root, rel);
 if (fs.existsSync(abs)) throw new Error('Already exists');
 const relPath = path.relative(path.resolve(root), abs);
 if (!(await approve({ kind: 'write', target: relPath + '/', detail: 'Create folder' }))) throw new Error('The user declined');
 fs.mkdirSync(abs, { recursive: true });
 return 'Created folder ' + relPath;
}

export async function deleteWorkspaceFile(root: string, rel: string, approve: ApproveFn): Promise<{ message: string; snapshot: string | null }> {
 const abs = resolveInWorkspace(root, rel);
 if (!fs.existsSync(abs)) throw new Error('No such file or folder');
 const relPath = path.relative(path.resolve(root), abs);
 const st = fs.statSync(abs);
 if (st.isDirectory() && fs.readdirSync(abs).length > 0) throw new Error('Folder is not empty — refusing to delete it recursively');
 if (!(await approve({ kind: 'delete', target: relPath }))) throw new Error('The user declined this delete');
 const snapshot = snapshotFile(root, abs);
 fs.rmSync(abs, { force: true });
 return { message: 'Deleted ' + relPath + (snapshot ? ' (backup kept)' : ''), snapshot };
}

export async function moveWorkspaceFile(root: string, from: string, to: string, approve: ApproveFn): Promise<{ message: string; snapshot: string | null }> {
 const absFrom = resolveInWorkspace(root, from);
 const absTo = resolveInWorkspace(root, to);
 if (!fs.existsSync(absFrom)) throw new Error('Source not found');
 if (fs.existsSync(absTo)) throw new Error('Target already exists');
 const relFrom = path.relative(path.resolve(root), absFrom);
 const relTo = path.relative(path.resolve(root), absTo);
 if (!(await approve({ kind: 'move', target: relFrom, detail: 'Move to ' + relTo }))) throw new Error('The user declined this move');
 const snapshot = snapshotFile(root, absFrom);
 fs.mkdirSync(path.dirname(absTo), { recursive: true });
 fs.renameSync(absFrom, absTo);
 return { message: `Moved ${relFrom} → ${relTo}`, snapshot };
}

// ---- shell commands -------------------------------------------------------------
// Allow-list by first token; anything that could chain, pipe or redirect is refused
// outright (those would bypass the allow-list). Output is captured and capped.

const COMMAND_ALLOWLIST = new Set(['npm', 'npx', 'node', 'git', 'python', 'python3', 'pip', 'pip3', 'pytest', 'tsc', 'cargo', 'go', 'dotnet', 'java', 'javac', 'mvn', 'gradle', 'make', 'cmake', 'eslint', 'vitest', 'jest', 'deno', 'bun', 'php', 'ruby', 'perl', 'gcc', 'g++', 'clang', 'dir', 'ls', 'type', 'cat', 'echo', 'where', 'which']);
const COMMAND_FORBIDDEN = /[;&|`$<>]|\([\s\S]*\$\(|(\brm\b|\bdel\b|\brmdir\b|\bformat\b|\bshutdown\b|\breboot\b|\breg\b|\bmkfs\b|\bdd\b)/i;

export async function runCommand(root: string, command: string, approve: ApproveFn): Promise<string> {
 if (typeof command !== 'string' || !command.trim() || command.length > 500) throw new Error('Invalid command');
 const cmd = command.trim();
 const first = cmd.split(/\s+/)[0].replace(/^\.[\\/]/, '').replace(/\.(cmd|exe|bat)$/i, '').toLowerCase();
 if (!COMMAND_ALLOWLIST.has(first)) throw new Error(`"${first}" is not on the allow-list of dev commands`);
 if (COMMAND_FORBIDDEN.test(cmd)) throw new Error('Chaining, pipes, redirects and destructive commands are not allowed');
 if (!(await approve({ kind: 'command', target: cmd }))) throw new Error('The user declined this command');
 return await new Promise<string>((resolvePromise) => {
  exec(cmd, { cwd: path.resolve(root), timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
   const out = (stdout + (stderr ? (stdout ? '\n' : '') + stderr : '')).slice(0, MAX_COMMAND_OUTPUT);
   const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
   resolvePromise(`exit ${code}\n${out}${stdout.length + stderr.length > MAX_COMMAND_OUTPUT ? '\n… (output truncated)' : ''}`);
  });
 });
}

function git(root: string, args: string[]): Promise<string> {
 return new Promise((resolvePromise, reject) => {
  execFile('git', ['-C', path.resolve(root), ...args], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
   if (err) reject(new Error(stderr.trim() || err.message));
   else resolvePromise(stdout);
  });
 });
}

export async function gitStatus(root: string): Promise<string> {
 const out = await git(root, ['status', '--short', '--branch']);
 return out.trim() || '(clean)';
}

export async function gitDiff(root: string): Promise<string> {
 const stat = (await git(root, ['diff', '--stat'])).trim();
 const diff = (await git(root, ['diff'])).slice(0, 20000);
 return (stat ? stat + '\n\n' : '') + (diff || '(no uncommitted changes)');
}

export async function gitCommit(root: string, message: string, approve: ApproveFn): Promise<string> {
 if (typeof message !== 'string' || !message.trim() || message.length > 200) throw new Error('Invalid commit message');
 const msg = message.trim().split('\n')[0];
 const status = await gitStatus(root);
 if (status === '(clean)') throw new Error('Nothing to commit — the working tree is clean');
 if (!(await approve({ kind: 'commit', target: msg, detail: status.slice(0, 2000) }))) throw new Error('The user declined this commit');
 await git(root, ['add', '-A']);
 const out = await git(root, ['commit', '-m', msg]);
 return out.trim() || 'Committed';
}

// ---- long-term memory ------------------------------------------------------------

const MEMORY_FILE = '.lumen-memory.md';

export function memoryRead(root: string): string {
 const abs = path.join(path.resolve(root), MEMORY_FILE);
 try { return fs.readFileSync(abs, 'utf8').slice(0, 16000) || '(memory is empty)'; }
 catch { return '(memory is empty)'; }
}

export async function memorySave(root: string, content: string, approve: ApproveFn): Promise<string> {
 if (typeof content !== 'string' || !content.trim()) throw new Error('Invalid content');
 if (Buffer.byteLength(content, 'utf8') > 64 * 1024) throw new Error('Memory too large (max 64 KB)');
 if (!(await approve({ kind: 'write', target: MEMORY_FILE, detail: 'Long-term project memory (overwrites the previous one)' }))) throw new Error('The user declined');
 const abs = path.join(path.resolve(root), MEMORY_FILE);
 fs.writeFileSync(abs, content, 'utf8');
 return 'Memory saved (' + content.split('\n').length + ' lines)';
}

// ---- web fetch --------------------------------------------------------------------
// Loopback/private hosts are refused (a fetched page could otherwise probe the LAN);
// domains are approved one by one through the native dialog.

function isPrivateHost(host: string): boolean {
 const h = host.toLowerCase();
 return h === 'localhost' || h === '::1' || h.endsWith('.local') || /^127\.|^10\.|^192\.168\.|^169\.254\.|^0\.|^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^\[?::1\]?$/.test(h);
}

function htmlToText(html: string): string {
 return html
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t]+/g, ' ')
  .replace(/\n\s*\n+/g, '\n\n')
  .trim();
}

export async function webFetch(url: string, approve: ApproveFn): Promise<string> {
 let u: URL;
 try { u = new URL(String(url)); } catch { throw new Error('Invalid URL'); }
 if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http(s) URLs');
 if (isPrivateHost(u.hostname)) throw new Error('Local and private network addresses are not allowed');
 if (!(await approve({ kind: 'web', target: u.host, detail: u.href.slice(0, 300) }))) throw new Error('The user declined this fetch');
 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), 20_000);
 try {
  const res = await fetch(u.href, { signal: controller.signal, headers: { 'user-agent': 'Lumen-AI-Desktop/1.1' }, redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const type = res.headers.get('content-type') ?? '';
  const raw = (await res.text()).slice(0, 400_000);
  const text = type.includes('html') ? htmlToText(raw) : raw;
  return text.slice(0, 20000) + (text.length > 20000 ? '\n… (page truncated)' : '');
 } finally { clearTimeout(timer); }
}

// ---- sql_query (read-only data analysis) ------------------------------------------
// SQLite files are opened with sql.js (fresh instance per call — these are the
// USER's data files, not the app database); CSV gets a tiny in-memory table.

// The WASM file ships in node_modules; its path relative to this compiled file
// depends on the build layout, so walk up from __dirname until
// node_modules/sql.js/dist is found.
function sqlJsDistDir(): string {
 let dir = __dirname;
 for (let i = 0; i < 8; i++) {
  const candidate = path.join(dir, 'node_modules', 'sql.js', 'dist');
  if (fs.existsSync(candidate)) return candidate;
  const parent = path.dirname(dir);
  if (parent === dir) break;
  dir = parent;
 }
 return path.join(__dirname, '../node_modules/sql.js/dist');
}

async function sqlJs() {
 const init = (await import('sql.js')).default;
 return init({ locateFile: (file: string) => path.join(sqlJsDistDir(), file) });
}

function parseCsv(text: string): string[][] {
 const rows: string[][] = [];
 let cur: string[] = [], field = '', inQ = false;
 for (let i = 0; i < text.length; i++) {
  const c = text[i];
  if (inQ) {
   if (text[i] === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
   else field += text[i];
  } else if (c === '"') inQ = true;
  else if (c === ',') { cur.push(field); field = ''; }
  else if (c === '\n' || c === '\r') {
   if (c === '\r' && text[i + 1] === '\n') i++;
   cur.push(field); field = '';
   if (cur.length > 1 || cur[0] !== '') rows.push(cur);
   cur = [];
  } else field += c;
 }
 if (field !== '' || cur.length) { cur.push(field); rows.push(cur); }
 return rows;
}

export async function sqlQuery(root: string, rel: string, query: string): Promise<string> {
 if (typeof query !== 'string' || !/^\s*select\b/i.test(query) || query.length > 2000) throw new Error('Only a single SELECT query is allowed');
 if (/;\s*\S/.test(query)) throw new Error('Only a single statement is allowed');
 const abs = resolveInWorkspace(root, rel);
 if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error('No such file');
 const ext = path.extname(abs).toLowerCase();
 const SQL = await sqlJs();
 const db = new SQL.Database();
 try {
  if (ext === '.csv') {
   const rows = parseCsv(fs.readFileSync(abs, 'utf8').slice(0, 4 * 1024 * 1024));
   if (rows.length < 2) throw new Error('CSV has no data rows');
   const cols = rows[0].map((c, i) => (c.trim().replace(/\W+/g, '_') || 'col_' + i));
   db.run('CREATE TABLE data(' + cols.map(c => `"${c}" TEXT`).join(',') + ')');
   const stmt = db.prepare('INSERT INTO data VALUES(' + cols.map(() => '?').join(',') + ')');
   for (const r of rows.slice(1, 50001)) { while (r.length < cols.length) r.push(''); stmt.run(r.slice(0, cols.length)); }
   stmt.free();
  } else if (ext === '.sqlite' || ext === '.db' || ext === '.sqlite3') {
   db.close();
   const bytes = fs.readFileSync(abs);
   if (bytes.length > 100 * 1024 * 1024) throw new Error('Database file too large (max 100 MB)');
   const real = new SQL.Database(bytes);
   try { return runSelect(real, query); } finally { real.close(); }
  } else throw new Error('Only .csv / .sqlite / .db files are supported');
  return runSelect(db, query);
 } finally {
  try { db.close(); } catch { /* already closed */ }
 }
}

function runSelect(db: import('sql.js').Database, query: string): string {
 const res = db.exec(query);
 if (!res.length) return '(no rows)';
 const { columns, values } = res[0];
 const shown = values.slice(0, 50);
 const widths = columns.map((c, i) => Math.min(40, Math.max(String(c).length, ...shown.map(r => String(r[i] ?? '').length))));
 const line = (cells: unknown[]) => cells.map((c, i) => String(c ?? 'NULL').slice(0, 40).padEnd(widths[i])).join(' │ ');
 const out = [line(columns), widths.map(w => '─'.repeat(w)).join('─┼─'), ...shown.map(line)];
 if (values.length > 50) out.push(`… (${values.length - 50} more rows)`);
 return out.join('\n');
}
// Validated here, persisted by main (chats.todos) and mirrored to the renderer panel.

export interface TodoItem { text: string; done: boolean }

export function normalizeTodos(input: unknown): TodoItem[] {
 if (!Array.isArray(input) || input.length > 50) throw new Error('todos must be an array (max 50)');
 return input.map(t => {
  const text = String((t as Record<string, unknown>)?.text ?? '').trim().slice(0, 200);
  if (!text) throw new Error('Every todo needs text');
  return { text, done: !!(t as Record<string, unknown>).done };
 });
}

// ---- dispatcher ---------------------------------------------------------------------
// One call → one result string. Errors are returned AS CONTENT so the model can
// recover (wrong path → it lists and retries) instead of dying the whole turn.
// `readonly` disables every mutating tool for the chat (user toggle).

const MUTATING = new Set(['write_file', 'edit_file', 'apply_patch', 'create_folder', 'delete_file', 'move_file', 'git_commit', 'memory_save']);

export async function runToolCall(root: string, call: ToolCallRequest, approve: ApproveFn, options?: { readonly?: boolean }): Promise<ToolResult> {
 const done = (content: string, isError?: boolean, extra?: { path?: string; snapshot?: string }): ToolResult => ({ toolCallId: call.id, name: call.name, content, isError, ...extra });
 let args: Record<string, unknown>;
 try { args = call.args ? JSON.parse(call.args) : {}; }
 catch { return done('Invalid tool arguments (not JSON)', true); }
 if (options?.readonly && MUTATING.has(call.name)) return done('This chat is in read-only mode — the user has disabled all file writes and commands that change state. Read, search and plan instead.', true);
 try {
  switch (call.name) {
   case 'list_files': return done(listFiles(root, typeof args.path === 'string' ? args.path : undefined) || '(empty folder)');
   case 'read_file': return done(readWorkspaceFile(root, String(args.path ?? ''), typeof args.from === 'number' ? args.from : undefined, typeof args.to === 'number' ? args.to : undefined));
   case 'read_many': return done(readMany(root, args.paths));
   case 'search_files': return done(searchWorkspace(root, String(args.query ?? '')));
   case 'find_definition': return done(findDefinition(root, String(args.symbol ?? '')));
   case 'find_references': return done(findReferences(root, String(args.symbol ?? '')));
   case 'get_file_info': return done(getFileInfo(root, String(args.path ?? '')));
   case 'diff_files': return done(diffFiles(root, String(args.a ?? ''), String(args.b ?? '')));
   case 'write_file': {
    const rel = String(args.path ?? '');
    const r = await writeWorkspaceFile(root, rel, String(args.content ?? ''), approve);
    return done(r.message, false, { path: rel, snapshot: r.snapshot ?? undefined });
   }
   case 'edit_file': {
    const rel = String(args.path ?? '');
    const r = await editWorkspaceFile(root, rel, String(args.old_text ?? ''), String(args.new_text ?? ''), approve);
    return done(r.message, false, { path: rel, snapshot: r.snapshot ?? undefined });
   }
   case 'apply_patch': return done(await applyPatch(root, String(args.patch ?? ''), approve));
   case 'create_folder': return done(await createFolder(root, String(args.path ?? ''), approve));
   case 'delete_file': {
    const rel = String(args.path ?? '');
    const r = await deleteWorkspaceFile(root, rel, approve);
    return done(r.message, false, { path: rel, snapshot: r.snapshot ?? undefined });
   }
   case 'move_file': {
    const rel = String(args.from ?? '');
    const r = await moveWorkspaceFile(root, rel, String(args.to ?? ''), approve);
    return done(r.message, false, { path: rel, snapshot: r.snapshot ?? undefined });
   }
   case 'run_command': return done(await runCommand(root, String(args.command ?? ''), approve));
   case 'git_status': return done(await gitStatus(root));
   case 'git_diff': return done(await gitDiff(root));
   case 'git_commit': return done(await gitCommit(root, String(args.message ?? ''), approve));
   case 'memory_read': return done(memoryRead(root));
   case 'memory_save': return done(await memorySave(root, String(args.content ?? ''), approve));
   case 'todo_write': {
    // Validated here; main persists it to chats.todos and mirrors it to the panel.
    return done(JSON.stringify(normalizeTodos(args.todos)));
   }
   case 'web_fetch': return done(await webFetch(String(args.url ?? ''), approve));
   case 'sql_query': return done(await sqlQuery(root, String(args.path ?? ''), String(args.query ?? '')));
   case 'spawn_subagent': return done('spawn_subagent is handled by the app core, not the dispatcher', true);
   default: return done('Unknown tool ' + call.name, true);
  }
 } catch (e) {
  return done(e instanceof Error ? e.message : 'Tool failed', true);
 }
}
