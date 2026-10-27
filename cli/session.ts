import { randomUUID } from 'node:crypto';
import type { HistoryMessage } from '../electron/providers';
import type { TodoItem } from '../electron/tools';
import { SESSIONS_DIR } from './config';
import { dbAll, dbOne, dbRun, migrateJsonSessions } from './db';
import type { OpRecord } from './agent';

// Sessions live in the SQLite database (cli/db.ts) — FR-5.1. The message/op/todo
// payload travels as a JSON column (full fidelity); metadata columns drive
// lists, stats and search. Legacy JSON session files are imported on startup.

export interface SessionMessage { role: 'user' | 'assistant'; content: string; createdAt: number; model?: string; promptTokens?: number; completionTokens?: number }

export interface Session {
 id: string;
 title: string;
 createdAt: number;
 updatedAt: number;
 providerId?: string;
 model?: string;
 workspace?: string | null;
 readonly?: boolean;
 parentId?: string;
 agent?: string;
 messages: SessionMessage[];
 ops: OpRecord[];
 todos: TodoItem[];
}

interface SessionRow { id: string; title: string; created_at: number; updated_at: number; provider_id: string | null; model: string | null; workspace: string | null; readonly: number; parent_id: string | null; agent: string | null; data: string }

function rowToSession(r: SessionRow): Session {
 let payload: { messages?: SessionMessage[]; ops?: OpRecord[]; todos?: TodoItem[] } = {};
 try { payload = JSON.parse(r.data) as typeof payload; } catch { /* corrupted payload — keep metadata */ }
 return {
  id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at,
  providerId: r.provider_id ?? undefined, model: r.model ?? undefined,
  workspace: r.workspace, readonly: !!r.readonly,
  parentId: r.parent_id ?? undefined, agent: r.agent ?? undefined,
  messages: Array.isArray(payload.messages) ? payload.messages : [],
  ops: Array.isArray(payload.ops) ? payload.ops : [],
  todos: Array.isArray(payload.todos) ? payload.todos : [],
 };
}

export function newSession(): Session {
 return { id: randomUUID(), title: 'New conversation', createdAt: Date.now(), updatedAt: Date.now(), messages: [], ops: [], todos: [] };
}

export function saveSession(s: Session): void {
 dbRun(
  `INSERT INTO sessions(id,title,created_at,updated_at,provider_id,model,workspace,readonly,parent_id,agent,data)
   VALUES(?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at,
    provider_id=excluded.provider_id, model=excluded.model, workspace=excluded.workspace,
    readonly=excluded.readonly, parent_id=excluded.parent_id, agent=excluded.agent, data=excluded.data`,
  [s.id, s.title, s.createdAt, s.updatedAt, s.providerId ?? null, s.model ?? null, s.workspace ?? null,
   s.readonly ? 1 : 0, s.parentId ?? null, s.agent ?? null,
   JSON.stringify({ messages: s.messages, ops: s.ops, todos: s.todos })],
 );
}

export function loadSession(id: string): Session | null {
 // Allow unambiguous id prefixes (like the desktop's short ids in the UI).
 const row = dbOne<SessionRow>('SELECT * FROM sessions WHERE id = ?', [id])
  ?? dbOne<SessionRow>('SELECT * FROM sessions WHERE id LIKE ? LIMIT 2', [id + '%']);
 if (!row) return null;
 return rowToSession(row);
}

export function listSessions(): Session[] {
 return dbAll<SessionRow>('SELECT * FROM sessions ORDER BY updated_at DESC').map(rowToSession);
}

export function latestSession(): Session | null { return listSessions()[0] ?? null; }

export function deleteSession(id: string): boolean {
 dbRun('DELETE FROM sessions WHERE id = ?', [id]);
 dbRun('DELETE FROM usage WHERE session_id = ?', [id]);
 dbRun('DELETE FROM tool_log WHERE session_id = ?', [id]);
 return true;
}

// FR-1.3: fork — a new session that starts as an exact copy of the source.
export function forkSession(id: string): Session | null {
 const src = loadSession(id);
 if (!src) return null;
 const fork: Session = {
  ...src,
  id: randomUUID(),
  title: src.title + ' (fork)',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  parentId: src.id,
  messages: src.messages.map(m => ({ ...m })),
  ops: src.ops.map(o => ({ ...o })),
  todos: src.todos.map(t => ({ ...t })),
 };
 saveSession(fork);
 return fork;
}

// FR-5.10: export/import. The file format is versioned and self-describing.
export interface SessionExport { format: 'lumencode-session'; version: 1; exportedAt: number; session: Session }

export function exportSession(id: string): SessionExport | null {
 const s = loadSession(id);
 if (!s) return null;
 return { format: 'lumencode-session', version: 1, exportedAt: Date.now(), session: s };
}

// Returns the imported session (new id when the id is taken) or null on bad data.
export function importSession(raw: unknown): Session | null {
 const candidate = (raw as SessionExport)?.format === 'lumencode-session' ? (raw as SessionExport).session : raw as Session;
 if (!candidate || typeof candidate.id !== 'string' || !Array.isArray(candidate.messages)) return null;
 const s = rowToSession({
  id: candidate.id, title: String(candidate.title ?? 'Imported conversation'),
  created_at: Number(candidate.createdAt) || Date.now(), updated_at: Number(candidate.updatedAt) || Date.now(),
  provider_id: candidate.providerId ?? null, model: candidate.model ?? null, workspace: candidate.workspace ?? null,
  readonly: candidate.readonly ? 1 : 0, parent_id: candidate.parentId ?? null, agent: candidate.agent ?? null,
  data: JSON.stringify({ messages: candidate.messages, ops: candidate.ops ?? [], todos: candidate.todos ?? [] }),
 });
 if (loadSession(s.id)) { s.id = randomUUID(); s.parentId = candidate.id; } // never overwrite an existing session
 saveSession(s);
 return s;
}

// Import the pre-SQLite JSON session files once (they stay on disk untouched).
export function migrateLegacySessions(): number {
 return migrateJsonSessions(SESSIONS_DIR, raw => {
  const s = raw as Session;
  if (!s || typeof s.id !== 'string' || !Array.isArray(s.messages)) return false;
  if (loadSession(s.id)) return false; // already migrated
  return !!importSession(raw);
 });
}

// ---- usage stats + tool journal (NFR-5) --------------------------------------

export function recordUsage(s: Session, model: string, promptTokens: number, completionTokens: number, cost: number): void {
 dbRun('INSERT INTO usage(session_id,created_at,provider,model,workspace,prompt_tokens,completion_tokens,cost) VALUES(?,?,?,?,?,?,?,?)',
  [s.id, Date.now(), s.providerId ?? null, model, s.workspace ?? null, promptTokens, completionTokens, cost]);
}

export function logToolCall(sessionId: string, tool: string, hint: string, status: string, bytes: number): void {
 dbRun('INSERT INTO tool_log(session_id,created_at,tool,hint,status,bytes) VALUES(?,?,?,?,?,?)',
  [sessionId, Date.now(), tool, hint.slice(0, 200), status, bytes]);
}

// History sent to the provider: roles + content only (tool turns live in memory).
export function sessionHistory(s: Session): HistoryMessage[] {
 return s.messages.map(m => ({ role: m.role, content: m.content }));
}

export function recordTurn(s: Session, userText: string, assistantText: string, model: string, promptTokens?: number, completionTokens?: number): void {
 s.messages.push({ role: 'user', content: userText, createdAt: Date.now() });
 if (assistantText.trim()) s.messages.push({ role: 'assistant', content: assistantText, createdAt: Date.now(), model, promptTokens, completionTokens });
 // Chats are named automatically from the first exchange; user renames survive.
 if (s.title === 'New conversation' && userText.trim()) s.title = userText.replace(/\s+/g, ' ').trim().slice(0, 48);
 s.updatedAt = Date.now();
 saveSession(s);
}
