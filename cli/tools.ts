import fs from 'node:fs';
import path from 'node:path';
import { runToolCall, type ApproveFn, type ToolResult } from '../electron/tools';
import type { ToolCallRecord, ToolDef } from '../electron/providers';
import { SKILLS_DIR, type LspServerConfig } from './config';
import { lspQuery } from './lsp';
import { ask } from './input';

// Canonical opencode-style tool registry (FR-4): bash, edit, write, read, grep,
// glob, lsp, patch, webfetch, websearch, question, skill. File/shell tools
// delegate to the battle-tested implementations in electron/tools.ts (same
// approvals and path-sandboxing); grep/glob/websearch/question/skill/lsp are
// CLI-native. Every tool has a JSON schema, validation, error capture, and each
// call is journaled by the agent loop (NFR-5) into the SQLite tool_log table.

export interface CliToolContext {
 workspace: string;
 readonly: boolean;
 approve: ApproveFn;
 lspServers?: LspServerConfig[];
}

const REL_PATH = { type: 'string', description: 'Path relative to the workspace root' };

export const CLI_TOOL_DEFS: ToolDef[] = [
 { name: 'bash', description: 'Run a shell command in the workspace (allow-listed dev tools: npm, git, tsc, python…). The user approves every command; output is captured.', schema: { type: 'object', properties: { command: { type: 'string', description: 'The command line to run' } }, required: ['command'] } },
 { name: 'edit', description: 'Exact string replacement in an existing file: old_string must match exactly once. Always read the file first.', schema: { type: 'object', properties: { path: REL_PATH, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] } },
 { name: 'write', description: 'Create a new file or fully overwrite an existing one. The user approves every write. Always read the file first if it exists.', schema: { type: 'object', properties: { path: REL_PATH, content: { type: 'string', description: 'Full new file content' } }, required: ['path', 'content'] } },
 { name: 'read', description: 'Read a UTF-8 text file. Large files are truncated; use offset/limit for a line range of a big file.', schema: { type: 'object', properties: { path: REL_PATH, offset: { type: 'number', description: 'First line (1-based)' }, limit: { type: 'number', description: 'Last line (inclusive)' } }, required: ['path'] } },
 { name: 'grep', description: 'Search file CONTENTS with a regular expression. Returns matching path:line: text, capped.', schema: { type: 'object', properties: { pattern: { type: 'string', description: 'Regular expression' }, include: { type: 'string', description: 'Optional glob filter, e.g. **/*.ts' } }, required: ['pattern'] } },
 { name: 'glob', description: 'Find files by glob pattern, e.g. **/*.ts or src/**/*.test.*', schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Subfolder to search in; omit for the workspace root' } }, required: ['pattern'] } },
 { name: 'lsp', description: 'Experimental LSP: go to definition / find references / hover for a symbol at a position. Requires a configured language server (lumencode lsp add).', schema: { type: 'object', properties: { action: { type: 'string', enum: ['definition', 'references', 'hover'] }, path: REL_PATH, line: { type: 'number', description: '1-based line' }, character: { type: 'number', description: '1-based column' } }, required: ['action', 'path', 'line', 'character'] } },
 { name: 'patch', description: 'Apply a unified diff to one or more files. The user approves each file.', schema: { type: 'object', properties: { patch: { type: 'string', description: 'Unified diff (--- a/file, +++ b/file, @@ hunks)' } }, required: ['patch'] } },
 { name: 'webfetch', description: 'Fetch a web page and return its text (docs, issues). The user approves each new domain.', schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
 { name: 'websearch', description: 'Search the web via Exa AI (needs EXA_API_KEY). Returns titles, URLs and text snippets.', schema: { type: 'object', properties: { query: { type: 'string' }, num_results: { type: 'number', description: '1-10, default 5' } }, required: ['query'] } },
 { name: 'question', description: 'Ask the user a clarifying question mid-task and wait for the answer. Optionally provide multiple-choice options.', schema: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' }, description: 'Optional choices; the user may also type a free-form answer' } }, required: ['question'] } },
 { name: 'skill', description: 'Load a named skill (SKILL.md) — packaged instructions for a specialized task. Call with no name to list available skills.', schema: { type: 'object', properties: { name: { type: 'string', description: 'Skill name; omit to list all' } } } },
];

// Names handled here; everything else falls through to electron/tools.ts.
const CLI_TOOL_NAMES = new Set(CLI_TOOL_DEFS.map(t => t.name));

export function isCliTool(name: string): boolean { return CLI_TOOL_NAMES.has(name); }

function parseArgs(argsJson: string): Record<string, unknown> {
 try {
  const parsed = JSON.parse(argsJson || '{}') as unknown;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
 } catch { /* fall through */ }
 return {};
}

function ok(call: ToolCallRecord, content: string): ToolResult { return { toolCallId: call.id, name: call.name, content }; }
function fail(call: ToolCallRecord, message: string): ToolResult { return { toolCallId: call.id, name: call.name, content: message, isError: true }; }

// Delegating to electron/tools keeps one implementation of approval + sandboxing.
async function delegate(root: string, call: ToolCallRecord, name: string, args: Record<string, unknown>, ctx: CliToolContext): Promise<ToolResult> {
 const mapped: ToolCallRecord = { id: call.id, name, args: JSON.stringify(args) };
 const res = await runToolCall(root, mapped, ctx.approve, { readonly: ctx.readonly });
 return { ...res, name: call.name };
}

export async function runCliTool(call: ToolCallRecord, ctx: CliToolContext): Promise<ToolResult> {
 const args = parseArgs(call.args);
 try {
  switch (call.name) {
   case 'bash': {
    if (typeof args.command !== 'string' || !args.command.trim()) return fail(call, 'bash: "command" must be a non-empty string');
    return delegate(ctx.workspace, call, 'run_command', { command: args.command }, ctx);
   }
   case 'edit': {
    if (typeof args.path !== 'string' || typeof args.old_string !== 'string' || typeof args.new_string !== 'string') return fail(call, 'edit: path, old_string and new_string are required strings');
    return delegate(ctx.workspace, call, 'edit_file', { path: args.path, old_text: args.old_string, new_text: args.new_string }, ctx);
   }
   case 'write': {
    if (typeof args.path !== 'string' || typeof args.content !== 'string') return fail(call, 'write: path and content are required strings');
    return delegate(ctx.workspace, call, 'write_file', { path: args.path, content: args.content }, ctx);
   }
   case 'read': {
    if (typeof args.path !== 'string' || !args.path) return fail(call, 'read: "path" is required');
    const mapped: Record<string, unknown> = { path: args.path };
    if (typeof args.offset === 'number') mapped.from = args.offset;
    if (typeof args.limit === 'number') mapped.to = args.limit;
    return delegate(ctx.workspace, call, 'read_file', mapped, ctx);
   }
   case 'grep': {
    if (typeof args.pattern !== 'string' || !args.pattern) return fail(call, 'grep: "pattern" is required');
    return ok(call, grepWorkspace(ctx.workspace, args.pattern, typeof args.include === 'string' ? args.include : undefined));
   }
   case 'glob': {
    if (typeof args.pattern !== 'string' || !args.pattern) return fail(call, 'glob: "pattern" is required');
    return ok(call, globWorkspace(ctx.workspace, args.pattern, typeof args.path === 'string' ? args.path : undefined));
   }
   case 'lsp': {
    const action = args.action;
    if (action !== 'definition' && action !== 'references' && action !== 'hover') return fail(call, 'lsp: action must be definition | references | hover');
    if (typeof args.path !== 'string') return fail(call, 'lsp: "path" is required');
    return ok(call, await lspQuery(ctx.lspServers, ctx.workspace, action, args.path, Number(args.line) || 1, Number(args.character) || 1));
   }
   case 'patch': {
    if (typeof args.patch !== 'string' || !args.patch.trim()) return fail(call, 'patch: "patch" (unified diff) is required');
    return delegate(ctx.workspace, call, 'apply_patch', { patch: args.patch }, ctx);
   }
   case 'webfetch': {
    if (typeof args.url !== 'string' || !/^https?:\/\//.test(args.url)) return fail(call, 'webfetch: "url" must be an http(s) URL');
    return delegate(ctx.workspace, call, 'web_fetch', { url: args.url }, ctx);
   }
   case 'websearch': {
    if (typeof args.query !== 'string' || !args.query.trim()) return fail(call, 'websearch: "query" is required');
    return ok(call, await webSearch(args.query, typeof args.num_results === 'number' ? args.num_results : 5));
   }
   case 'question': {
    if (typeof args.question !== 'string' || !args.question.trim()) return fail(call, 'question: "question" is required');
    return ok(call, await askUser(args.question, Array.isArray(args.options) ? args.options.map(String) : undefined));
   }
   case 'skill': {
    return ok(call, loadSkill(ctx.workspace, typeof args.name === 'string' ? args.name : ''));
   }
   default:
    return fail(call, 'Unknown CLI tool: ' + call.name);
  }
 } catch (e) {
  return fail(call, (call.name + ' failed: ' + (e instanceof Error ? e.message : String(e))).slice(0, 2000));
 }
}

// ---- grep / glob ---------------------------------------------------------------

const IGNORED_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'dist-cli', 'dist-electron', 'build', 'out', '.next', 'coverage', '__pycache__']);
const MAX_WALK_FILES = 4000;
const MAX_RESULTS = 100;

function walk(root: string, sub?: string): string[] {
 const out: string[] = [];
 const rootAbs = path.resolve(root);
 const start = sub ? path.resolve(rootAbs, sub) : rootAbs;
 if (!start.startsWith(rootAbs)) return out; // never escape the workspace
 const stack = [start];
 while (stack.length && out.length < MAX_WALK_FILES) {
  const dir = stack.pop() as string;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
  for (const e of entries) {
   const full = path.join(dir, e.name);
   if (e.isDirectory()) { if (!IGNORED_DIRS.has(e.name)) stack.push(full); }
   else if (e.isFile()) out.push(path.relative(root, full).replace(/\\/g, '/'));
   if (out.length >= MAX_WALK_FILES) break;
  }
 }
 return out;
}

// Glob → RegExp: ** crosses directories, * stays within one segment, ? = one char.
export function globToRegExp(glob: string): RegExp {
 const esc = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
 let re = '';
 for (let i = 0; i < glob.length; i++) {
  const ch = glob[i];
  if (ch === '*') {
   if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
   else re += '[^/]*';
  } else if (ch === '?') re += '[^/]';
  else re += esc(ch);
 }
 return new RegExp('^' + re + '$', 'i');
}

export function globWorkspace(root: string, pattern: string, sub?: string): string {
 const rx = globToRegExp(pattern.replace(/\\/g, '/'));
 const matches = walk(root, sub).filter(f => rx.test(f));
 if (!matches.length) return '(no files match ' + pattern + ')';
 return matches.slice(0, MAX_RESULTS).join('\n') + (matches.length > MAX_RESULTS ? `\n… and ${matches.length - MAX_RESULTS} more` : '');
}

export function grepWorkspace(root: string, pattern: string, include?: string): string {
 let rx: RegExp;
 try { rx = new RegExp(pattern, 'i'); } catch { return 'grep: invalid regular expression: ' + pattern; }
 const filter = include ? globToRegExp(include.replace(/\\/g, '/')) : null;
 const hits: string[] = [];
 let scanned = 0;
 for (const rel of walk(root)) {
  if (filter && !filter.test(rel)) continue;
  if (scanned++ > MAX_WALK_FILES) break;
  let text: string;
  try {
   const st = fs.statSync(path.join(root, rel));
   if (st.size > 512 * 1024) continue; // skip huge files
   text = fs.readFileSync(path.join(root, rel), 'utf8');
  } catch { continue; }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
   if (rx.test(lines[i])) {
    hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
    if (hits.length >= MAX_RESULTS) return hits.join('\n') + '\n… (results capped at ' + MAX_RESULTS + ')';
   }
  }
 }
 return hits.length ? hits.join('\n') : '(no matches for ' + pattern + ')';
}

// ---- websearch (Exa AI) ---------------------------------------------------------

interface ExaResult { title?: string; url?: string; text?: string }

async function webSearch(query: string, numResults: number): Promise<string> {
 const key = process.env.EXA_API_KEY ?? '';
 if (!key) return 'websearch needs an Exa AI API key: set EXA_API_KEY (https://dashboard.exa.ai) and try again.';
 const res = await fetch('https://api.exa.ai/search', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': key },
  body: JSON.stringify({ query, numResults: Math.min(10, Math.max(1, numResults)), contents: { text: { maxCharacters: 1000 } } }),
  signal: AbortSignal.timeout(20_000),
 });
 if (!res.ok) return 'websearch failed: HTTP ' + res.status + ' — ' + (await res.text()).slice(0, 200);
 const data = await res.json() as { results?: ExaResult[] };
 const results = data.results ?? [];
 if (!results.length) return '(no results)';
 return results.map((r, i) => `${i + 1}. ${r.title ?? '(untitled)'}\n   ${r.url ?? ''}\n   ${(r.text ?? '').replace(/\s+/g, ' ').slice(0, 500)}`).join('\n\n');
}

// ---- question --------------------------------------------------------------------

async function askUser(question: string, options?: string[]): Promise<string> {
 if (!process.stdin.isTTY) return '(no interactive user available — proceed with your best assumption)';
 let prompt = '\n? ' + question;
 if (options?.length) prompt += '\n' + options.map((o, i) => `  ${i + 1}) ${o}`).join('\n');
 const answer = (await ask(prompt + '\n› ')).trim();
 if (!answer) return '(user gave no answer)';
 const n = Number(answer);
 if (options?.length && Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1];
 return answer;
}

// ---- skill ------------------------------------------------------------------------

function skillRoots(workspace: string): string[] {
 return [SKILLS_DIR, path.join(workspace, '.lumencode', 'skills'), path.join(workspace, '.lumen', 'skills')];
}

function listSkills(workspace: string): string {
 const found: string[] = [];
 for (const root of skillRoots(workspace)) {
  let entries: string[] = [];
  try { entries = fs.readdirSync(root); } catch { continue; }
  for (const e of entries) {
   if (e.endsWith('.md')) found.push(`${path.basename(e, '.md')} (${root})`);
   else { try { if (fs.existsSync(path.join(root, e, 'SKILL.md'))) found.push(`${e} (${root})`); } catch { /* skip */ } }
  }
 }
 return found.length ? 'Available skills:\n' + found.map(s => '  ' + s).join('\n') : 'No skills found. Create one at ' + path.join(SKILLS_DIR, '<name>', 'SKILL.md');
}

function loadSkill(workspace: string, name: string): string {
 if (!name.trim()) return listSkills(workspace);
 const clean = name.replace(/[^\w.-]+/g, '');
 for (const root of skillRoots(workspace)) {
  for (const candidate of [path.join(root, clean, 'SKILL.md'), path.join(root, clean + '.md')]) {
   try {
    const text = fs.readFileSync(candidate, 'utf8');
    return `Skill "${clean}" (${candidate}):\n\n` + text.slice(0, 30_000);
   } catch { /* try next */ }
  }
 }
 return `Skill "${clean}" not found.\n` + listSkills(workspace);
}
