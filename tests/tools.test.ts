import {beforeEach,describe,expect,it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveInWorkspace, listFiles, readWorkspaceFile, searchWorkspace,
  writeWorkspaceFile, runToolCall, MAX_READ_BYTES,
} from '../electron/tools';

// Every test works in a fresh temp workspace; a second temp dir plays the role of
// "outside" for the escape-attempt tests.
let root = '';
let outside = '';
const approveAll = () => Promise.resolve(true);
const denyAll = () => Promise.resolve(false);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-ws-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-out-'));
});

describe('resolveInWorkspace', () => {
  it('resolves plain relative paths inside the root', () => {
    expect(resolveInWorkspace(root, 'a/b.txt')).toBe(path.resolve(root, 'a/b.txt'));
  });
  it('rejects absolute paths and drive letters', () => {
    expect(() => resolveInWorkspace(root, outside)).toThrow(/relative/);
    expect(() => resolveInWorkspace(root, 'C:\\Windows\\system32')).toThrow(/relative/);
    expect(() => resolveInWorkspace(root, '/etc/passwd')).toThrow(/relative/);
  });
  it('rejects .. traversal that escapes the root', () => {
    expect(() => resolveInWorkspace(root, '../evil.txt')).toThrow(/escapes/);
    expect(() => resolveInWorkspace(root, 'a/../../evil.txt')).toThrow(/escapes/);
    // .. that stays inside is fine.
    expect(resolveInWorkspace(root, 'a/../b.txt')).toBe(path.resolve(root, 'b.txt'));
  });
  it('rejects empty and overlong paths', () => {
    expect(() => resolveInWorkspace(root, '')).toThrow(/Invalid/);
    expect(() => resolveInWorkspace(root, 'x'.repeat(501))).toThrow(/Invalid/);
  });
  it('rejects a symlink/junction pointing outside the root', () => {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope');
    fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
    expect(() => resolveInWorkspace(root, 'link/secret.txt')).toThrow(/symlink/);
  });
  it('allows creating a brand-new file in a new subfolder', () => {
    expect(resolveInWorkspace(root, 'new/deep/file.txt')).toBe(path.resolve(root, 'new/deep/file.txt'));
  });
});

describe('listFiles', () => {
  it('lists files and folders with a trailing slash, skipping noise dirs', () => {
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'README.md'), 'hi');
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), '');
    const out = listFiles(root);
    expect(out).toContain('src/');
    expect(out).toContain(path.join('src', 'a.ts'));
    expect(out).toContain('README.md');
    expect(out).not.toContain('node_modules');
  });
  it('rejects a non-folder path', () => {
    fs.writeFileSync(path.join(root, 'f.txt'), 'x');
    expect(() => listFiles(root, 'f.txt')).toThrow(/Not a folder/);
  });
});

describe('readWorkspaceFile', () => {
  it('reads UTF-8 text', () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'привет мир');
    expect(readWorkspaceFile(root, 'a.txt')).toBe('привет мир');
  });
  it('truncates files larger than the read cap and says so', () => {
    fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(MAX_READ_BYTES + 100));
    const out = readWorkspaceFile(root, 'big.txt');
    expect(out.length).toBeLessThan(MAX_READ_BYTES + 300);
    expect(out).toContain('file truncated');
  });
  it('refuses binary files', () => {
    fs.writeFileSync(path.join(root, 'b.bin'), Buffer.from([1, 0, 2, 3]));
    expect(() => readWorkspaceFile(root, 'b.bin')).toThrow(/Binary/);
  });
  it('throws on a missing file', () => {
    expect(() => readWorkspaceFile(root, 'nope.txt')).toThrow(/No such file/);
  });
});

describe('searchWorkspace', () => {
  it('finds matches by file name and by content with line numbers', () => {
    fs.writeFileSync(path.join(root, 'notes-todo.txt'), 'nothing here');
    fs.writeFileSync(path.join(root, 'plain.txt'), 'first\nsecond todo line\nthird');
    const byName = searchWorkspace(root, 'notes-todo');
    expect(byName).toContain('notes-todo.txt');
    const byContent = searchWorkspace(root, 'todo line');
    expect(byContent).toContain('plain.txt:2: second todo line');
  });
  it('returns a friendly message when nothing matches', () => {
    expect(searchWorkspace(root, 'zzz-no-match')).toBe('No matches');
  });
  it('rejects an empty query', () => {
    expect(() => searchWorkspace(root, '  ')).toThrow(/Invalid query/);
  });
});

describe('writeWorkspaceFile', () => {
  it('writes only after approval and creates parent folders', async () => {
    const seen: string[] = [];
    const out = await writeWorkspaceFile(root, 'sub/new.txt', 'hello', (rel, bytes) => { seen.push(rel + ':' + bytes); return Promise.resolve(true); });
    expect(fs.readFileSync(path.join(root, 'sub', 'new.txt'), 'utf8')).toBe('hello');
    expect(out).toContain('Wrote 5 bytes');
    expect(seen).toEqual([path.join('sub', 'new.txt') + ':5']);
  });
  it('does not touch disk when the user declines', async () => {
    await expect(writeWorkspaceFile(root, 'x.txt', 'data', denyAll)).rejects.toThrow(/declined/);
    expect(fs.existsSync(path.join(root, 'x.txt'))).toBe(false);
  });
  it('refuses oversized content', async () => {
    await expect(writeWorkspaceFile(root, 'x.txt', 'x'.repeat(1024 * 1024 + 1), approveAll)).rejects.toThrow(/too large/);
  });
});

describe('runToolCall', () => {
  it('dispatches read_file and returns its content', async () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'content');
    const res = await runToolCall(root, { id: 't1', name: 'read_file', args: '{"path":"a.txt"}' }, approveAll);
    expect(res).toMatchObject({ toolCallId: 't1', name: 'read_file', content: 'content' });
  });
  it('returns errors AS CONTENT so the model can recover', async () => {
    const res = await runToolCall(root, { id: 't2', name: 'read_file', args: '{"path":"missing.txt"}' }, approveAll);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/No such file/);
  });
  it('handles invalid JSON arguments and unknown tools gracefully', async () => {
    expect((await runToolCall(root, { id: 't3', name: 'read_file', args: '{oops' }, approveAll)).isError).toBe(true);
    expect((await runToolCall(root, { id: 't4', name: 'rm_rf', args: '{}' }, approveAll)).content).toMatch(/Unknown tool/);
  });
  it('list_files with no arguments lists the root', async () => {
    fs.writeFileSync(path.join(root, 'f.txt'), '');
    const res = await runToolCall(root, { id: 't5', name: 'list_files', args: '' }, approveAll);
    expect(res.content).toContain('f.txt');
  });
});
