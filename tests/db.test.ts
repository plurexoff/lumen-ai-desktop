import {beforeEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// db.ts reads only app.getPath('userData'); point it at a fresh temp dir per test
// so no test can touch real application data or another test's database file.
const mockState = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({ app: { getPath: () => mockState.dir } }));

import {
  openDatabase, query, one, run, saveNow, transaction,
  dbStatus, lastPersistError, SCHEMA_VERSION,
} from '../electron/db';

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-db-test-'));
  mockState.dir = dir;
  return dir;
}
const dbFile = () => path.join(mockState.dir, 'lumen.sqlite');
const pragmaValue = (pragma: string): number =>
  Number(Object.values(one(`PRAGMA ${pragma}`) ?? {})[0] ?? 0);

const insertChat = (id: string, title = 't') =>
  run('INSERT INTO chats(id,title,provider_id,model,updated_at) VALUES(?,?,?,?,?)', [id, title, 'openai', 'gpt-4o-mini', 1]);

beforeEach(() => { freshDir(); });

describe('schema creation', () => {
  it('creates a fresh database with every table at the current schema version', async () => {
    await openDatabase();
    expect(fs.existsSync(dbFile())).toBe(true);
    expect(pragmaValue('user_version')).toBe(SCHEMA_VERSION);
    const tables = query("SELECT name FROM sqlite_master WHERE type='table'").map(r => String(r.name));
    for (const t of ['chats', 'messages', 'message_variants', 'attachments', 'providers', 'secrets', 'settings']) {
      expect(tables).toContain(t);
    }
  });

  it('keeps foreign_keys enabled after a flush (sql.js export() resets pragmas)', async () => {
    await openDatabase();
    saveNow(); // flush calls db.export(), the operation that used to silently drop the pragma
    expect(pragmaValue('foreign_keys')).toBe(1);
  });
});

describe('persistence', () => {
  it('persists rows to disk and reads them back on reopen', async () => {
    await openDatabase();
    insertChat('c1', 'hello');
    saveNow();
    await openDatabase(); // re-reads the file from disk into a fresh in-memory DB
    expect(one('SELECT title FROM chats WHERE id=?', ['c1'])).toEqual({ title: 'hello' });
  });

  it('commits a successful transaction atomically', async () => {
    await openDatabase();
    transaction(() => { insertChat('c1'); insertChat('c2'); });
    expect(Number(one('SELECT COUNT(*) AS n FROM chats')?.n)).toBe(2);
  });

  it('rolls back a failed transaction: no partial writes survive', async () => {
    await openDatabase();
    expect(() => transaction(() => {
      insertChat('c1');
      throw new Error('boom');
    })).toThrow('boom');
    expect(Number(one('SELECT COUNT(*) AS n FROM chats')?.n)).toBe(0);
  });

  it('records a persist error when the write fails, and clears it after a good flush', async () => {
    await openDatabase();
    insertChat('c1');
    const dir = mockState.dir;
    fs.rmSync(dir, { recursive: true, force: true }); // simulate an unwritable location
    saveNow();
    expect(lastPersistError()).toBeTruthy();
    fs.mkdirSync(dir, { recursive: true });
    saveNow();
    expect(lastPersistError()).toBeNull();
  });
});

describe('corruption and versioning', () => {
  it('throws on a 0-byte database file instead of silently starting empty', async () => {
    fs.writeFileSync(dbFile(), Buffer.alloc(0));
    await expect(openDatabase()).rejects.toThrow('0 bytes');
  });

  it('quarantines an unreadable database and starts clean with a warning status', async () => {
    fs.writeFileSync(dbFile(), Buffer.from('definitely not a sqlite database', 'utf8'));
    await openDatabase();
    const st = dbStatus();
    expect(st.recovered).toBe(true);
    expect(st.backupPath).toBeTruthy();
    expect(fs.existsSync(st.backupPath as string)).toBe(true); // original bytes kept, not overwritten
    expect(path.basename(st.backupPath as string)).toMatch(/^lumen\.sqlite\.corrupt-/);
    // The replacement database is fully usable.
    insertChat('c1');
    expect(Number(one('SELECT COUNT(*) AS n FROM chats')?.n)).toBe(1);
  });

  it('flags a database written by a newer schema version instead of overwriting it', async () => {
    await openDatabase();
    run(`PRAGMA user_version=${SCHEMA_VERSION + 1}`);
    saveNow();
    await openDatabase();
    expect(dbStatus().newerVersion).toBe(SCHEMA_VERSION + 1);
  });

  it('migrates a pre-versioning (user_version=0) database forward and keeps its data', async () => {
    await openDatabase();
    insertChat('c1', 'old data');
    run('PRAGMA user_version=0'); // a pre-versioning install arrives here with live data
    saveNow();
    await openDatabase();
    expect(pragmaValue('user_version')).toBe(SCHEMA_VERSION);
    expect(one('SELECT title FROM chats WHERE id=?', ['c1'])).toEqual({ title: 'old data' });
    // The variant table introduced in v2 and the attachments table from v3 must
    // both exist after the migration.
    const tables = query("SELECT name FROM sqlite_master WHERE type='table'").map(r => String(r.name));
    expect(tables).toContain('message_variants');
    expect(tables).toContain('attachments');
  });

  it('stores attachment metadata linked to its message and cascades on message delete', async () => {
    await openDatabase();
    insertChat('c1');
    run('INSERT INTO messages(id,chat_id,role,content,created_at) VALUES(?,?,?,?,?)', ['m1', 'c1', 'user', 'look', 1]);
    run('INSERT INTO attachments VALUES(?,?,?,?,?,?)', ['a1', 'm1', 'pic.png', 'image/png', 123, 1]);
    expect(one('SELECT name FROM attachments WHERE message_id=?', ['m1'])).toEqual({ name: 'pic.png' });
    run('DELETE FROM messages WHERE id=?', ['m1']);
    expect(Number(one('SELECT COUNT(*) AS n FROM attachments')?.n)).toBe(0);
  });

  it('migrates a v3 database to v4 by adding chats.branched_from, keeping rows', async () => {
    await openDatabase();
    insertChat('c1', 'v3 chat');
    run('PRAGMA user_version=3');
    saveNow();
    await openDatabase();
    expect(pragmaValue('user_version')).toBe(SCHEMA_VERSION);
    const row = one('SELECT title,branched_from FROM chats WHERE id=?', ['c1']);
    expect(row).toEqual({ title: 'v3 chat', branched_from: null });
    // The new column accepts lineage links.
    run('UPDATE chats SET branched_from=? WHERE id=?', ['parent', 'c1']);
    expect(one('SELECT branched_from FROM chats WHERE id=?', ['c1'])).toEqual({ branched_from: 'parent' });
  });

  it('migrates a v4 database to v5: pin/folder/workspace columns and the folders table', async () => {
    await openDatabase();
    insertChat('c1', 'v4 chat');
    run('PRAGMA user_version=4');
    saveNow();
    await openDatabase();
    expect(pragmaValue('user_version')).toBe(SCHEMA_VERSION);
    const row = one('SELECT title,pinned,folder_id,workspace FROM chats WHERE id=?', ['c1']);
    expect(row).toEqual({ title: 'v4 chat', pinned: 0, folder_id: null, workspace: null });
    // Folders table works and chats can reference it.
    run('INSERT INTO folders VALUES(?,?,?)', ['f1', 'Work', 1]);
    run('UPDATE chats SET pinned=1,folder_id=? WHERE id=?', ['f1', 'c1']);
    expect(one('SELECT pinned,folder_id FROM chats WHERE id=?', ['c1'])).toEqual({ pinned: 1, folder_id: 'f1' });
    // Deleting a folder leaves chats intact (the app nulls folder_id explicitly).
    run('UPDATE chats SET folder_id=NULL WHERE folder_id=?', ['f1']);
    run('DELETE FROM folders WHERE id=?', ['f1']);
    expect(Number(one('SELECT COUNT(*) AS n FROM chats')?.n)).toBe(1);
  });

  it('migrates a v5 database to v6: archive/readonly columns, tags, file_ops, bookmarks', async () => {
    await openDatabase();
    insertChat('c1', 'v5 chat');
    run('INSERT INTO messages(id,chat_id,role,content,created_at) VALUES(?,?,?,?,?)', ['m1', 'c1', 'user', 'hi', 1]);
    run('PRAGMA user_version=5');
    saveNow();
    await openDatabase();
    expect(pragmaValue('user_version')).toBe(SCHEMA_VERSION);
    const chat = one('SELECT archived,workspace_readonly,todos FROM chats WHERE id=?', ['c1']);
    expect(chat).toEqual({ archived: 0, workspace_readonly: 0, todos: null });
    const msg = one('SELECT bookmarked FROM messages WHERE id=?', ['m1']);
    expect(msg).toEqual({ bookmarked: 0 });
    run('INSERT INTO chat_tags VALUES(?,?)', ['c1', 'work']);
    run('INSERT INTO file_ops VALUES(?,?,?,?,?,?,?,?)', ['op1', 'c1', 'write_file', 'a.txt', 'ok', null, null, 1]);
    expect(one('SELECT tag FROM chat_tags WHERE chat_id=?', ['c1'])).toEqual({ tag: 'work' });
    expect(one('SELECT tool FROM file_ops WHERE id=?', ['op1'])).toEqual({ tool: 'write_file' });
  });
});
