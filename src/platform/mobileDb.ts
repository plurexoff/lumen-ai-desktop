// Android storage: the same sql.js engine as the desktop, persisted to the app
// sandbox via @capacitor/filesystem (base64). No DPAPI equivalent here — API keys
// live in Capacitor Preferences (see mobile.ts), chat data in this SQLite file.
import initSqlJs, { type Database } from 'sql.js';
import { Filesystem, Directory } from '@capacitor/filesystem';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

const DB_FILE = 'lumen-mobile.sqlite';

let db: Database | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastPersistError: string | null = null;

// Minimal mobile schema — deliberately a subset of the desktop's v7: no workspaces,
// docs, variants or file ops on Android v1.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats(
 id TEXT PRIMARY KEY, title TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL,
 updated_at INTEGER NOT NULL, pinned INTEGER DEFAULT 0, folder_id TEXT, archived INTEGER DEFAULT 0, tags TEXT DEFAULT '[]');
CREATE TABLE IF NOT EXISTS messages(
 id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
 created_at INTEGER NOT NULL, model TEXT, provider_id TEXT,
 prompt_tokens INTEGER, completion_tokens INTEGER, reasoning TEXT, finish_reason TEXT,
 bookmarked INTEGER DEFAULT 0, rating INTEGER);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);
CREATE TABLE IF NOT EXISTS providers(
 id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, models TEXT NOT NULL DEFAULT '[]', pricing TEXT);
CREATE TABLE IF NOT EXISTS folders(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export function dbPersistError(): string | null { return lastPersistError; }

export async function openMobileDb(): Promise<Database> {
 if (db) return db;
 const SQL = await initSqlJs({ locateFile: () => wasmUrl });
 let bytes: Uint8Array | null = null;
 try {
  const res = await Filesystem.readFile({ path: DB_FILE, directory: Directory.Data });
  const raw = typeof res.data === 'string' ? res.data : '';
  if (raw) {
   const bin = atob(raw);
   bytes = new Uint8Array(bin.length);
   for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  }
 } catch { /* first launch: no file yet */ }
 db = bytes ? new SQL.Database(bytes) : new SQL.Database();
 db.run(SCHEMA);
 persistDbSoon();
 return db;
}

// Debounced export+write: a chat turn touches the DB a handful of times in a row.
export function persistDbSoon(): void {
 if (saveTimer) clearTimeout(saveTimer);
 saveTimer = setTimeout(() => { void persistDbNow(); }, 400);
}

export async function persistDbNow(): Promise<void> {
 if (!db) return;
 try {
  const bytes = db.export();
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  await Filesystem.writeFile({ path: DB_FILE, directory: Directory.Data, data: btoa(bin), recursive: true });
  lastPersistError = null;
 } catch (e) {
  lastPersistError = e instanceof Error ? e.message : 'persist failed';
 }
}

export async function wipeMobileDb(): Promise<void> {
 if (!db) return;
 for (const t of ['messages', 'chats', 'providers', 'folders', 'kv']) db.run(`DELETE FROM ${t}`);
 db.run(SCHEMA);
 await persistDbNow();
}

// Tiny row helpers — sql.js exec returns {columns, values}[].
export function rows<T>(d: Database, sql: string, params: (string | number | null)[] = []): T[] {
 const out: T[] = [];
 for (const r of d.exec(sql, params)) {
  for (const v of r.values) {
   const o: Record<string, unknown> = {};
   r.columns.forEach((c, i) => { o[c] = v[i]; });
   out.push(o as T);
  }
 }
 return out;
}
export function oneRow<T>(d: Database, sql: string, params: (string | number | null)[] = []): T | undefined {
 return rows<T>(d, sql, params)[0];
}
