import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config';

// CLI storage layer: a real SQLite database (via sql.js WASM — the same engine
// the desktop app uses) at ~/.lumen-cli/lumencode.sqlite. sql.js keeps the DB
// in memory and exports bytes, so after the one async open all queries are
// synchronous; writes are flushed to disk on a short debounce.
//
// Schema (PRAGMA user_version = 1):
//   sessions  — one row per chat; the message/op/todo payload is a JSON column
//               (full fidelity), metadata columns drive lists and stats.
//   usage     — one row per assistant answer: tokens, cost, model, project.
//   tool_log  — one row per tool call: the journal NFR-5 requires.
//   kv        — misc persistent state.

export const CLI_DB_VERSION = 1;

let db: import('sql.js').Database | null = null;
let dbFile = '';
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

// Locate node_modules/sql.js/dist by walking up from __dirname (works both in
// dist-cli/cli and in the repo root under ts-node/vitest).
function sqlJsDistDir(): string {
 let dir = __dirname;
 for (let i = 0; i < 8; i++) {
  const candidate = path.join(dir, 'node_modules', 'sql.js', 'dist');
  if (fs.existsSync(path.join(candidate, 'sql-wasm.wasm'))) return candidate;
  const up = path.dirname(dir);
  if (up === dir) break;
  dir = up;
 }
 return path.join(__dirname, '../node_modules/sql.js/dist');
}

function createSchema(d: import('sql.js').Database): void {
 d.run(`CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  provider_id TEXT,
  model TEXT,
  workspace TEXT,
  readonly INTEGER NOT NULL DEFAULT 0,
  parent_id TEXT,
  agent TEXT,
  shared INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}'
 )`);
 d.run(`CREATE TABLE IF NOT EXISTS usage(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  provider TEXT,
  model TEXT,
  workspace TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0
 )`);
 d.run('CREATE INDEX IF NOT EXISTS idx_usage_created ON usage(created_at)');
 d.run(`CREATE TABLE IF NOT EXISTS tool_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  tool TEXT NOT NULL,
  hint TEXT,
  status TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0
 )`);
 d.run('CREATE INDEX IF NOT EXISTS idx_tool_log_created ON tool_log(created_at)');
 d.run('CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
}

export async function openCliDb(): Promise<void> {
 if (db) return;
 const init = (await import('sql.js')).default;
 const SQL = await init({ locateFile: (file: string) => path.join(sqlJsDistDir(), file) });
 fs.mkdirSync(CONFIG_DIR, { recursive: true });
 dbFile = path.join(CONFIG_DIR, 'lumencode.sqlite');
 const bytes = fs.existsSync(dbFile) ? fs.readFileSync(dbFile) : null;
 if (bytes && bytes.length > 0) {
  try { db = new SQL.Database(bytes); }
  catch {
   // Quarantine a corrupt file instead of losing it silently.
   try { fs.renameSync(dbFile, dbFile + '.corrupt-' + Date.now()); } catch { /* best effort */ }
   db = new SQL.Database();
  }
 } else db = new SQL.Database();
 createSchema(db);
 db.run(`PRAGMA user_version = ${CLI_DB_VERSION}`);
 persistNow();
}

function handle(): import('sql.js').Database {
 if (!db) throw new Error('CLI database is not open (openCliDb() must run first)');
 return db;
}

export function dbRun(sql: string, params: unknown[] = []): void {
 handle().run(sql, params as never[]);
 scheduleSave();
}

export function dbAll<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
 const stmt = handle().prepare(sql);
 try {
  stmt.bind(params as never[]);
  const rows: T[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject() as T);
  return rows;
 } finally { stmt.free(); }
}

export function dbOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | null {
 return dbAll<T>(sql, params)[0] ?? null;
}

export function dbFilePath(): string { return dbFile; }

export function persistNow(): void {
 if (!db) return;
 if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
 try {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = dbFile + '.tmp';
  fs.writeFileSync(tmp, Buffer.from(db.export()));
  fs.renameSync(tmp, dbFile);
  dirty = false;
 } catch { dirty = true; /* surfaced on exit / next flush */ }
}

function scheduleSave(): void {
 dirty = true;
 if (saveTimer) return;
 saveTimer = setTimeout(() => { saveTimer = null; persistNow(); }, 250);
}

export function closeCliDb(): void {
 if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
 if (dirty) persistNow();
 try { db?.close(); } catch { /* already closed */ }
 db = null;
}

// ---- one-time migration from the pre-SQLite JSON session files --------------

export function migrateJsonSessions(dir: string, importSession: (raw: unknown) => boolean): number {
 let files: string[] = [];
 try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return 0; }
 let imported = 0;
 for (const f of files) {
  try {
   const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as unknown;
   if (importSession(raw)) imported++;
  } catch { /* skip unreadable file */ }
 }
 return imported;
}
