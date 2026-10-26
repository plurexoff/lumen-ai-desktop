import {beforeEach,describe,expect,it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveInWorkspace, listFiles, readWorkspaceFile, searchWorkspace,
  writeWorkspaceFile, runToolCall, MAX_READ_BYTES,
  unifiedDiff, editWorkspaceFile, applyPatch, readMany, getFileInfo, diffFiles,
  createFolder, deleteWorkspaceFile, moveWorkspaceFile, snapshotFile, restoreSnapshot,
  memoryRead, memorySave, normalizeTodos, findDefinition, findReferences, runCommand,
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
    const out = await writeWorkspaceFile(root, 'sub/new.txt', 'hello', (req) => { seen.push(req.kind + ':' + req.target); return Promise.resolve(true); });
    expect(fs.readFileSync(path.join(root, 'sub', 'new.txt'), 'utf8')).toBe('hello');
    expect(out.message).toContain('Wrote 5 bytes');
    expect(seen).toEqual(['write:' + path.join('sub', 'new.txt')]);
  });
  it('snapshots the previous content and shows a diff in the approval request', async () => {
    fs.writeFileSync(path.join(root, 'f.txt'), 'old line\n');
    let detail = '';
    const out = await writeWorkspaceFile(root, 'f.txt', 'new line\n', (req) => { detail = req.detail ?? ''; return Promise.resolve(true); });
    expect(detail).toContain('-old line');
    expect(detail).toContain('+new line');
    expect(out.snapshot).toBeTruthy();
    expect(fs.readFileSync(out.snapshot as string, 'utf8')).toBe('old line\n');
  });
  it('does not touch disk when the user declines', async () => {
    await expect(writeWorkspaceFile(root, 'x.txt', 'data', denyAll)).rejects.toThrow(/declined/);
    expect(fs.existsSync(path.join(root, 'x.txt'))).toBe(false);
  });
  it('refuses oversized content', async () => {
    await expect(writeWorkspaceFile(root, 'x.txt', 'x'.repeat(1024 * 1024 + 1), approveAll)).rejects.toThrow(/too large/);
  });
});

describe('unifiedDiff', () => {
  it('produces a parseable unified diff with -/+ lines', () => {
    const d = unifiedDiff('a\nb\nc', 'a\nB\nc', 'f', 'f');
    expect(d).toContain('--- a/f');
    expect(d).toContain('+++ b/f');
    expect(d).toContain('-b');
    expect(d).toContain('+B');
    expect(d).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
  });
  it('reports no changes for identical inputs', () => {
    expect(unifiedDiff('x\ny', 'x\ny')).toBe('(no changes)');
  });
});

describe('editWorkspaceFile', () => {
  it('replaces a unique fragment and snapshots the old file', async () => {
    fs.writeFileSync(path.join(root, 'a.ts'), 'const x = 1;\nconst y = 2;\n');
    const out = await editWorkspaceFile(root, 'a.ts', 'const x = 1;', 'const x = 42;', approveAll);
    expect(fs.readFileSync(path.join(root, 'a.ts'), 'utf8')).toBe('const x = 42;\nconst y = 2;\n');
    expect(out.snapshot).toBeTruthy();
  });
  it('refuses a fragment that is missing or ambiguous', async () => {
    fs.writeFileSync(path.join(root, 'b.ts'), 'foo\nfoo\n');
    await expect(editWorkspaceFile(root, 'b.ts', 'bar', 'baz', approveAll)).rejects.toThrow(/not found/);
    await expect(editWorkspaceFile(root, 'b.ts', 'foo', 'baz', approveAll)).rejects.toThrow(/more than once/);
    expect(fs.readFileSync(path.join(root, 'b.ts'), 'utf8')).toBe('foo\nfoo\n');
  });
});

describe('applyPatch', () => {
  it('applies a unified diff produced by unifiedDiff', async () => {
    fs.writeFileSync(path.join(root, 'p.txt'), 'one\ntwo\nthree\n');
    const patch = unifiedDiff('one\ntwo\nthree', 'one\nTWO\nthree', 'p.txt', 'p.txt');
    const out = await applyPatch(root, patch, approveAll);
    expect(out).toContain('p.txt: applied');
    expect(fs.readFileSync(path.join(root, 'p.txt'), 'utf8')).toBe('one\nTWO\nthree\n');
  });
  it('fails cleanly when the context does not match', async () => {
    fs.writeFileSync(path.join(root, 'q.txt'), 'actual content\n');
    const patch = '--- a/q.txt\n+++ b/q.txt\n@@ -1,1 +1,1 @@\n-completely different\n+new\n';
    await expect(applyPatch(root, patch, approveAll)).rejects.toThrow(/does not apply/);
    expect(fs.readFileSync(path.join(root, 'q.txt'), 'utf8')).toBe('actual content\n');
  });
});

describe('read_many / get_file_info / diff_files', () => {
  it('reads several files with headers and reports per-file errors', async () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'A');
    const out = readMany(root, ['a.txt', 'missing.txt']);
    expect(out).toContain('=== a.txt ===\nA');
    expect(out).toContain('=== missing.txt ===\n[error:');
  });
  it('reports size and line count without a full read', () => {
    fs.writeFileSync(path.join(root, 'i.txt'), 'l1\nl2\nl3');
    expect(getFileInfo(root, 'i.txt')).toContain('3 lines');
  });
  it('diffs two workspace files', () => {
    fs.writeFileSync(path.join(root, 'd1.txt'), 'x\n');
    fs.writeFileSync(path.join(root, 'd2.txt'), 'y\n');
    const out = diffFiles(root, 'd1.txt', 'd2.txt');
    expect(out).toContain('-x');
    expect(out).toContain('+y');
  });
});

describe('read_file line ranges', () => {
  it('returns only the requested lines', () => {
    fs.writeFileSync(path.join(root, 'r.txt'), 'a\nb\nc\nd\ne');
    expect(readWorkspaceFile(root, 'r.txt', 2, 3)).toContain('b\nc');
    expect(readWorkspaceFile(root, 'r.txt', 2, 3)).toContain('lines 2–3 of 5');
  });
});

describe('folder CRUD tools', () => {
  it('creates, moves and deletes with approval', async () => {
    await createFolder(root, 'sub', approveAll);
    expect(fs.statSync(path.join(root, 'sub')).isDirectory()).toBe(true);
    fs.writeFileSync(path.join(root, 'f.txt'), 'x');
    await moveWorkspaceFile(root, 'f.txt', 'sub/f.txt', approveAll);
    expect(fs.existsSync(path.join(root, 'sub', 'f.txt'))).toBe(true);
    await deleteWorkspaceFile(root, 'sub/f.txt', approveAll);
    expect(fs.existsSync(path.join(root, 'sub', 'f.txt'))).toBe(false);
  });
  it('refuses to delete a non-empty folder recursively', async () => {
    fs.mkdirSync(path.join(root, 'full'));
    fs.writeFileSync(path.join(root, 'full', 'f.txt'), 'x');
    await expect(deleteWorkspaceFile(root, 'full', approveAll)).rejects.toThrow(/not empty/);
  });
  it('declined operations change nothing', async () => {
    fs.writeFileSync(path.join(root, 'keep.txt'), 'x');
    await expect(deleteWorkspaceFile(root, 'keep.txt', denyAll)).rejects.toThrow(/declined/);
    expect(fs.existsSync(path.join(root, 'keep.txt'))).toBe(true);
  });
});

describe('snapshots and rollback', () => {
  it('restores a snapshot back to its original path', () => {
    fs.writeFileSync(path.join(root, 's.txt'), 'v1');
    const snap = snapshotFile(root, path.resolve(root, 's.txt')) as string;
    fs.writeFileSync(path.join(root, 's.txt'), 'v2');
    expect(restoreSnapshot(root, snap)).toBe('s.txt');
    // The restore copies the snapshot content over the current file:
    expect(fs.readFileSync(path.join(root, 's.txt'), 'utf8')).toBe('v1');
  });
  it('refuses snapshots outside the backup dir', () => {
    fs.writeFileSync(path.join(outside, 'evil.txt'), 'x');
    expect(() => restoreSnapshot(root, path.join(outside, 'evil.txt'))).toThrow(/not found/i);
  });
});

describe('runCommand', () => {
  it('runs allow-listed commands and captures output', async () => {
    const out = await runCommand(root, 'echo hello-lumen', approveAll);
    expect(out).toContain('exit 0');
    expect(out).toContain('hello-lumen');
  });
  it('rejects non-allow-listed and chained commands without asking', async () => {
    await expect(runCommand(root, 'curl http://x', approveAll)).rejects.toThrow(/allow-list/);
    await expect(runCommand(root, 'echo a && echo b', approveAll)).rejects.toThrow(/not allowed/);
    await expect(runCommand(root, 'echo a > out.txt', approveAll)).rejects.toThrow(/not allowed/);
  });
  it('declined commands never run', async () => {
    await expect(runCommand(root, 'echo hi', denyAll)).rejects.toThrow(/declined/);
  });
});

describe('memory', () => {
  it('round-trips the memory file with approval', async () => {
    expect(memoryRead(root)).toBe('(memory is empty)');
    await memorySave(root, 'uses vite and react', approveAll);
    expect(memoryRead(root)).toBe('uses vite and react');
  });
});

describe('todos', () => {
  it('normalizes and validates todo lists', () => {
    expect(normalizeTodos([{ text: 'do x' }, { text: 'done y', done: 1 }])).toEqual([{ text: 'do x', done: false }, { text: 'done y', done: true }]);
    expect(() => normalizeTodos([{ text: '' }])).toThrow();
    expect(() => normalizeTodos('nope')).toThrow();
  });
});

describe('symbol search', () => {
  it('finds definitions and references', () => {
    fs.writeFileSync(path.join(root, 'code.ts'), 'export function myHelper() {\n return 1;\n}\nconst z = myHelper();\n');
    expect(findDefinition(root, 'myHelper')).toContain('code.ts:1');
    expect(findReferences(root, 'myHelper')).toContain('code.ts:4');
  });
});

describe('read-only mode in the dispatcher', () => {
  it('blocks mutating tools but allows reads', async () => {
    fs.writeFileSync(path.join(root, 'ro.txt'), 'data');
    const write = await runToolCall(root, { id: 'w', name: 'write_file', args: '{"path":"ro.txt","content":"x"}' }, approveAll, { readonly: true });
    expect(write.isError).toBe(true);
    expect(write.content).toContain('read-only');
    const read = await runToolCall(root, { id: 'r', name: 'read_file', args: '{"path":"ro.txt"}' }, approveAll, { readonly: true });
    expect(read.content).toBe('data');
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
