import fs from 'node:fs';
import path from 'node:path';
import {
 buildChatRequest, buildModelsRequest, parseAnthropicFinish, parseAnthropicToolEvent, parseAnthropicUsage,
 parseFinishReason, parseGeminiToolCall, parseReasoningEvent, parseSseEvent, parseToolCallDelta, parseUsageEvent,
 stripGeminiModelPrefix, authHeaders,
 type HistoryMessage, type ResolvedProvider, type ToolCallRecord, type ToolDef,
} from '../electron/providers';
import { listFiles, MAX_TOOL_ROUNDS, normalizeTodos, runToolCall, TOOL_DEFS, WORKSPACE_PROMPT, type ApproveFn, type TodoItem, type ToolResult } from '../electron/tools';
import { mcpCall, mcpTools } from '../electron/mcp';
import type { FinishReason, McpServer, PricingMap } from '../electron/shared';

// CLI port of the desktop generate() loop (electron/main.ts): stream one
// completion, run any requested workspace tools (each mutation via ApproveFn),
// feed results back, repeat — bounded by the same round/budget limits.

const STREAM_IDLE_MS = 60_000;
const MAX_TOOL_BUDGET_CHARS = 200_000;

export interface OpRecord { tool: string; path: string | null; status: 'ok' | 'error' | 'declined'; detail: string; snapshot: string | null; createdAt: number }

export interface AgentCallbacks {
 onText(text: string): void;
 onReasoning(text: string): void;
 onTool(ev: { name: string; hint: string; status: 'running' | 'ok' | 'error' | 'declined'; bytes?: number }): void;
 onTodos(todos: TodoItem[]): void;
 onOp(op: OpRecord): void;
 onNote(note: string): void;
}

export interface AgentOptions {
 provider: ResolvedProvider;
 pricing?: PricingMap;
 model: string;
 systemPrompt?: string;
 temperature?: number;
 topP?: number;
 maxTokens?: number;
 reasoningEffort?: 'off' | 'low' | 'medium' | 'high';
 workspace: string | null;
 readonly?: boolean;
 approve: ApproveFn;
 mcpServers?: McpServer[];
 controller: AbortController;
 firstMessage: boolean;
 watchBaseline?: Map<string, number>;
}

export interface AgentResult {
 text: string;
 reasoning: string;
 promptTokens?: number;
 completionTokens?: number;
 finishReason: FinishReason;
 stopped: boolean;
 error?: string;
 watchBaseline?: Map<string, number>;
}

// watch_files: relative path → mtime for every file listFiles sees (capped list).
export function snapshotWorkspace(root: string): Map<string, number> {
 const out = new Map<string, number>();
 try { for (const line of listFiles(root).split('\n')) { if (!line || line.endsWith('/') || line.startsWith('…')) continue; try { const st = fs.statSync(path.join(root, line)); if (st.isFile()) out.set(line, st.mtimeMs); } catch { /* gone */ } } } catch { /* no workspace */ }
 return out;
}

export async function loadModels(p: ResolvedProvider): Promise<string[]> {
 const { url, headers } = buildModelsRequest(p);
 const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
 if (!response.ok) throw new Error('HTTP ' + response.status);
 const data = await response.json() as { data?: Array<{ id?: string }>; models?: Array<{ name?: string }> };
 return data.data ? data.data.map(x => x.id ?? '').filter(Boolean) : ((data.models ?? []).map(x => x.name ?? '').filter(Boolean));
}

function buildSystemPrompt(opts: AgentOptions): string {
 let sys = opts.systemPrompt;
 const workspace = opts.workspace;
 if (!workspace) return sys ?? '';
 sys = (sys ? sys + '\n\n' : '') + WORKSPACE_PROMPT + '\nWorkspace root: ' + workspace;
 // Project rules and a compact tree are attached on the FIRST message only.
 try { const rulesPath = path.join(workspace, 'LUMEN.md'); if (fs.existsSync(rulesPath)) sys += '\n\nProject rules (LUMEN.md):\n' + fs.readFileSync(rulesPath, 'utf8').slice(0, 8192); } catch { /* unreadable */ }
 if (opts.firstMessage) { try { sys += '\n\nProject tree:\n' + listFiles(workspace); } catch { /* unreadable */ } }
 if (opts.readonly) sys += '\n\nREAD-ONLY MODE: the user has disabled all write/edit/command tools for this chat. Read, search and advise only.';
 // watch_files: report what changed on disk outside the app since the previous answer.
 const prev = opts.watchBaseline;
 if (prev) {
  const now = snapshotWorkspace(workspace); const changed: string[] = [];
  for (const [f, m] of now) { const old = prev.get(f); if (old === undefined) changed.push(f + ' (new)'); else if (old !== m) changed.push(f); }
  for (const f of prev.keys()) if (!now.has(f)) changed.push(f + ' (deleted)');
  if (changed.length) sys += '\n\nFiles changed outside this chat since your last answer: ' + changed.slice(0, 30).join(', ') + (changed.length > 30 ? ' …' : '') + '. Read them again before editing.';
 }
 return sys;
}

async function streamOnce(p: ResolvedProvider, wire: HistoryMessage[], opts: AgentOptions, tools: ToolDef[] | undefined, state: { answer: string; reasoning: string; usage: { promptTokens: number; completionTokens: number } | null; finish: FinishReason }, cb: AgentCallbacks, armWatchdog: () => void): Promise<Map<number, ToolCallRecord>> {
 const { url, headers, body } = buildChatRequest(p, wire, { model: opts.model, systemPrompt: buildSystemPrompt(opts), temperature: opts.temperature, maxTokens: opts.maxTokens, topP: opts.topP, reasoningEffort: opts.reasoningEffort, tools });
 const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.controller.signal });
 if (!response.ok) {
  const detail = (await response.text()).slice(0, 240);
  throw new Error(response.status === 401 ? 'Invalid API key (401)' : response.status === 403 ? 'Access denied by provider (403): ' + detail : response.status === 429 ? 'Rate limit reached (429): ' + detail : 'Provider error ' + response.status + ': ' + detail);
 }
 if (!response.body) throw new Error('Streaming unavailable');
 const toolCalls = new Map<number, ToolCallRecord>();
 let geminiSeq = 0;
 const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
 for (;;) {
  const result = await reader.read(); if (result.done) break; armWatchdog(); buffer += decoder.decode(result.value, { stream: true });
  const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? '';
  for (const line of lines) {
   const text = parseSseEvent(line); const thought = parseReasoningEvent(line);
   const fin = p.id === 'anthropic' ? parseAnthropicFinish(line) : parseFinishReason(line); if (fin) state.finish = fin;
   if (p.id === 'anthropic') state.usage = parseAnthropicUsage(line, state.usage); else state.usage = parseUsageEvent(line) ?? state.usage;
   if (text) { state.answer += text; cb.onText(text); }
   if (thought) { state.reasoning += thought; cb.onReasoning(thought); }
   if (tools) {
    const events = p.id === 'anthropic' ? parseAnthropicToolEvent(line) : p.id === 'gemini' ? parseGeminiToolCall(line, geminiSeq) : parseToolCallDelta(line);
    for (const ev of events) {
     if (ev.kind === 'call-start') toolCalls.set(ev.index, { id: ev.id, name: ev.name, args: '' });
     else if (ev.kind === 'call-args') { const call = toolCalls.get(ev.index); if (call) call.args += ev.chunk; }
     else if (ev.kind === 'call-complete') { geminiSeq++; toolCalls.set(1000 + geminiSeq, { id: ev.id, name: ev.name, args: ev.args }); }
     // 'tool-stop' needs no action: accumulated calls alone drive the tool round.
    }
   }
  }
 }
 return toolCalls;
}

export async function runAgent(history: HistoryMessage[], opts: AgentOptions, cb: AgentCallbacks): Promise<AgentResult> {
 const p = opts.provider;
 const signal = opts.controller.signal;
 const state = { answer: '', reasoning: '', usage: null as { promptTokens: number; completionTokens: number } | null, finish: null as FinishReason };
 let timedOut = false;
 let watchdog: ReturnType<typeof setTimeout> | null = null;
 // Any chunk (or stream end) re-arms the watchdog; firing it aborts the request.
 const armWatchdog = () => { if (watchdog) clearTimeout(watchdog); watchdog = setTimeout(() => { timedOut = true; opts.controller.abort(); }, STREAM_IDLE_MS); };
 try {
  armWatchdog();
  // MCP servers extend the tool list; their tools are namespaced and routed in
  // the dispatch loop. A server that fails to start is skipped with a note.
  const mcpByName = new Map<string, { server: string; remote: string }>();
  const mcpDefs: ToolDef[] = [];
  for (const s of opts.mcpServers ?? []) {
   if (!s || typeof s.id !== 'string' || typeof s.command !== 'string') continue;
   try { for (const info of await mcpTools(s.id, s.command)) { mcpDefs.push(info.def); mcpByName.set(info.def.name, { server: info.server, remote: info.remoteName }); } }
   catch (e) { const note = '⚠️ MCP server "' + String(s.name ?? s.id) + '" unavailable: ' + (e instanceof Error ? e.message : 'failed') + '\n'; state.reasoning += note; cb.onNote(note); }
  }
  const tools = (opts.workspace || mcpDefs.length) ? [...(opts.workspace ? TOOL_DEFS : []), ...mcpDefs] : undefined;
  const wire: HistoryMessage[] = [...history];
  let rounds = 0; let toolChars = 0;
  for (;;) {
   const roundStart = state.answer.length;
   const toolCalls = await streamOnce(p, wire, opts, tools, state, cb, armWatchdog);
   const doToolRound = !!tools && toolCalls.size > 0 && rounds < MAX_TOOL_ROUNDS && toolChars < MAX_TOOL_BUDGET_CHARS && !signal.aborted;
   if (!doToolRound) break;
   rounds++;
   wire.push({ role: 'assistant', content: state.answer.slice(roundStart), toolCalls: [...toolCalls.values()] });
   const results: Array<{ toolCallId: string; name: string; content: string }> = [];
   // Approvals are user think-time, not a stalled stream — the watchdog stands down.
   if (watchdog) { clearTimeout(watchdog); watchdog = null; }
   for (const call of toolCalls.values()) {
    let hint = ''; try { const a = JSON.parse(call.args || '{}') as Record<string, unknown>; hint = String(a.path ?? a.query ?? a.command ?? a.url ?? a.task ?? a.symbol ?? '').slice(0, 120); } catch { /* bad args */ }
    cb.onTool({ name: call.name, hint, status: 'running' });
    let res: ToolResult;
    const mcpRoute = mcpByName.get(call.name);
    if (mcpRoute) {
     try { let args: Record<string, unknown> = {}; try { args = JSON.parse(call.args || '{}') as Record<string, unknown>; } catch { /* bad args */ } res = { toolCallId: call.id, name: call.name, content: await mcpCall(mcpRoute.server, mcpRoute.remote, args) }; }
     catch (e) { res = { toolCallId: call.id, name: call.name, content: 'MCP call failed: ' + (e instanceof Error ? e.message : 'unknown'), isError: true }; }
    } else if (call.name === 'spawn_subagent') {
     let task = ''; try { task = String((JSON.parse(call.args || '{}') as Record<string, unknown>).task ?? ''); } catch { /* bad args */ }
     if (!task.trim()) res = { toolCallId: call.id, name: call.name, content: 'No task given', isError: true };
     else { try { res = { toolCallId: call.id, name: call.name, content: await runSubagent(p, opts.model, task, opts.workspace, signal) }; } catch (e) { res = { toolCallId: call.id, name: call.name, content: 'Sub-agent failed: ' + (e instanceof Error ? e.message : 'unknown'), isError: true }; } }
    } else if (!opts.workspace) {
     res = { toolCallId: call.id, name: call.name, content: 'Workspace tools are unavailable: this chat has no workspace folder.', isError: true };
    } else {
     res = await runToolCall(opts.workspace, call, opts.approve, { readonly: opts.readonly });
    }
    const status = res.isError ? (res.content.includes('declined') ? 'declined' : 'error') : 'ok';
    cb.onTool({ name: call.name, hint, status, bytes: res.content.length });
    toolChars += res.content.length;
    if (call.name === 'todo_write' && !res.isError) { try { cb.onTodos(normalizeTodos(JSON.parse(res.content))); } catch { /* bad payload */ } }
    const opPath = res.path ?? (hint || null);
    if (res.isError) cb.onOp({ tool: call.name, path: opPath, status: status === 'declined' ? 'declined' : 'error', detail: res.content.slice(0, 500), snapshot: null, createdAt: Date.now() });
    else if (res.path || call.name === 'run_command' || call.name === 'git_commit' || call.name === 'web_fetch' || call.name === 'apply_patch') cb.onOp({ tool: call.name, path: opPath, status: 'ok', detail: res.content.slice(0, 500), snapshot: res.snapshot ?? null, createdAt: Date.now() });
    results.push({ toolCallId: res.toolCallId, name: res.name, content: res.content });
   }
   wire.push({ role: 'user', content: '', toolResults: results });
   if (toolChars >= MAX_TOOL_BUDGET_CHARS) {
    cb.onNote('⚠️ Tool output budget reached — finishing with what is already known.');
    // One final round WITHOUT tools so the model can wrap up.
    wire.push({ role: 'user', content: 'Tool output budget reached. Do not call any more tools — answer with what you have.' });
    await streamOnce(p, wire, opts, undefined, state, cb, armWatchdog);
    break;
   }
   armWatchdog();
  }
 } catch (error) {
  const aborted = signal.aborted && !timedOut;
  return {
   text: state.answer, reasoning: state.reasoning, finishReason: state.finish, stopped: aborted,
   promptTokens: state.usage?.promptTokens, completionTokens: state.usage?.completionTokens,
   error: timedOut ? 'Provider stopped responding' : aborted ? 'Generation stopped' : error instanceof Error ? error.message : 'Network error',
   watchBaseline: opts.workspace ? snapshotWorkspace(opts.workspace) : undefined,
  };
 } finally { if (watchdog) clearTimeout(watchdog); }
 if (watchdog) { clearTimeout(watchdog); watchdog = null; }
 const stopped = signal.aborted && !timedOut;
 const empty = !state.answer.trim() && !state.reasoning.trim();
 const emptyError = empty && !stopped ? (state.finish === 'content_filter' ? 'The provider filtered this response' : state.finish === 'refusal' ? 'The model declined to answer' : 'Provider returned an empty response') : undefined;
 return {
  text: state.answer, reasoning: state.reasoning, finishReason: state.finish, stopped,
  promptTokens: state.usage?.promptTokens, completionTokens: state.usage?.completionTokens, error: emptyError,
  watchBaseline: opts.workspace ? snapshotWorkspace(opts.workspace) : undefined,
 };
}

// Sub-agent (spawn_subagent): a bounded nested tool loop with read-only tools
// only — no approvals, no writes, max 3 rounds. Ported from electron/main.ts.
const SUBAGENT_TOOLS = new Set(['list_files', 'read_file', 'read_many', 'search_files', 'find_definition', 'find_references', 'get_file_info', 'diff_files', 'git_status', 'git_diff', 'memory_read', 'sql_query']);
async function runSubagent(p: ResolvedProvider, model: string, task: string, workspace: string | null, signal: AbortSignal): Promise<string> {
 const subDefs = TOOL_DEFS.filter(t => SUBAGENT_TOOLS.has(t.name));
 const sys = 'You are a read-only research sub-agent inside a chat app. Investigate the task with the file tools, then give a compact final answer (facts + file references). You cannot write files, run commands or access the network.';
 const wire: HistoryMessage[] = [{ role: 'user', content: task.slice(0, 4000) }];
 for (let round = 0; round < 3; round++) {
  const { url, headers, body } = buildChatRequest(p, wire, { model, systemPrompt: sys, temperature: 0.2, maxTokens: 2048, topP: 1, tools: workspace ? subDefs : undefined });
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!response.ok || !response.body) throw new Error('sub-agent request failed (HTTP ' + response.status + ')');
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = ''; let text = ''; const calls = new Map<number, ToolCallRecord>(); let geminiSeq = 0;
  for (;;) {
   const result = await reader.read(); if (result.done) break; buffer += decoder.decode(result.value, { stream: true });
   const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? '';
   for (const line of lines) {
    const t = parseSseEvent(line); if (t) text += t;
    for (const ev of p.id === 'anthropic' ? parseAnthropicToolEvent(line) : p.id === 'gemini' ? parseGeminiToolCall(line, geminiSeq) : parseToolCallDelta(line)) {
     if (ev.kind === 'call-start') calls.set(ev.index, { id: ev.id, name: ev.name, args: '' });
     else if (ev.kind === 'call-args') { const call = calls.get(ev.index); if (call) call.args += ev.chunk; }
     else if (ev.kind === 'call-complete') { geminiSeq++; calls.set(1000 + geminiSeq, { id: ev.id, name: ev.name, args: ev.args }); }
    }
   }
  }
  if (!calls.size || !workspace) return text.trim() || '(sub-agent returned nothing)';
  wire.push({ role: 'assistant', content: text, toolCalls: [...calls.values()] });
  const results: Array<{ toolCallId: string; name: string; content: string }> = [];
  for (const call of calls.values()) {
   if (!SUBAGENT_TOOLS.has(call.name)) { results.push({ toolCallId: call.id, name: call.name, content: 'Sub-agents may only use read-only tools' }); continue; }
   const out = await runToolCall(workspace, call, async () => false, { readonly: true });
   results.push({ toolCallId: out.toolCallId, name: out.name, content: out.content.slice(0, 8000) });
  }
  wire.push({ role: 'user', content: '', toolResults: results });
 }
 return '(sub-agent hit its round limit without a final answer)';
}

// A short non-streaming side request (auto-titles etc.), ported from main.ts.
export async function miniRequest(p: ResolvedProvider, model: string, content: string, maxTokens: number): Promise<string> {
 const headers = { ...authHeaders(p), 'content-type': 'application/json' };
 if (p.id === 'gemini') {
  const res = await fetch(p.url + `/models/${encodeURIComponent(stripGeminiModelPrefix(model))}:generateContent`, { method: 'POST', headers, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: content }] }], generationConfig: { maxOutputTokens: maxTokens } }) });
  if (!res.ok) return '';
  const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return (data.candidates?.[0]?.content?.parts ?? []).map(x => x.text ?? '').join('');
 }
 if (p.id === 'anthropic') {
  const res = await fetch(p.url + '/messages', { method: 'POST', headers, body: JSON.stringify({ model, max_tokens: maxTokens, temperature: 0.3, messages: [{ role: 'user', content }] }) });
  if (!res.ok) return '';
  const data = await res.json() as { content?: Array<{ text?: string }> };
  return data.content?.[0]?.text ?? '';
 }
 const res = await fetch(p.url + '/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model, max_tokens: maxTokens, temperature: 0.3, messages: [{ role: 'user', content }], stream: false }) });
 if (!res.ok) return '';
 const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
 return data.choices?.[0]?.message?.content ?? '';
}
