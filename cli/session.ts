import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HistoryMessage } from '../electron/providers';
import type { TodoItem } from '../electron/tools';
import { SESSIONS_DIR } from './config';
import type { OpRecord } from './agent';

// Sessions are plain JSON files in ~/.lumen-cli/sessions/ — the CLI analogue of
// the desktop's SQLite chat history. Saved after every completed turn.

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
 messages: SessionMessage[];
 ops: OpRecord[];
 todos: TodoItem[];
}

export function newSession(): Session {
 return { id: randomUUID(), title: 'New conversation', createdAt: Date.now(), updatedAt: Date.now(), messages: [], ops: [], todos: [] };
}

export function saveSession(s: Session): void {
 fs.mkdirSync(SESSIONS_DIR, { recursive: true });
 const tmp = path.join(SESSIONS_DIR, s.id + '.tmp');
 fs.writeFileSync(tmp, JSON.stringify(s));
 fs.renameSync(tmp, path.join(SESSIONS_DIR, s.id + '.json'));
}

export function loadSession(id: string): Session | null {
 try {
  const raw = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, id + '.json'), 'utf8')) as Session;
  if (!raw || typeof raw.id !== 'string' || !Array.isArray(raw.messages)) return null;
  raw.ops = Array.isArray(raw.ops) ? raw.ops : [];
  raw.todos = Array.isArray(raw.todos) ? raw.todos : [];
  return raw;
 } catch { return null; }
}

export function listSessions(): Session[] {
 const files: string[] = (() => { try { return fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json')); } catch { return []; } })();
 const out: Session[] = [];
 for (const f of files) { const s = loadSession(path.basename(f, '.json')); if (s) out.push(s); }
 out.sort((a, b) => b.updatedAt - a.updatedAt);
 return out;
}

export function latestSession(): Session | null { return listSessions()[0] ?? null; }

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
