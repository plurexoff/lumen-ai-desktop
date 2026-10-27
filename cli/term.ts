import fs from 'node:fs';
import path from 'node:path';
import type { PricingMap } from '../electron/shared';
import type { TodoItem } from '../electron/tools';

// Terminal presentation for the CLI: ANSI colors (disabled when piped or
// NO_COLOR), incremental markdown rendering, a spinner, framed tool cards and
// approval panels.

const enabled = !!process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string, off = '0') => (s: string) => enabled ? `\x1b[${code}m${s}\x1b[${off}m` : s;

export const c = {
 bold: wrap('1', '22'),
 dim: wrap('2', '22'),
 italic: wrap('3', '23'),
 underline: wrap('4', '24'),
 strike: wrap('9', '29'),
 red: wrap('31', '39'),
 green: wrap('32', '39'),
 yellow: wrap('33', '39'),
 blue: wrap('34', '39'),
 magenta: wrap('35', '39'),
 cyan: wrap('36', '39'),
 gray: wrap('90', '39'),
 white: wrap('97', '39'),
};

// Output sink: while the TUI owns the screen, all output is routed through it
// (scroll-region management); otherwise straight to stdout/stderr.
export interface OutputSink { write(s: string): void; status(s: string | null): void }
let sink: OutputSink | null = null;
export function setSink(s: OutputSink | null): void { sink = s; }

export function print(text: string): void { if (sink) sink.write(text); else process.stdout.write(text); }
export function printLine(text = ''): void { if (sink) sink.write(text + '\n'); else process.stdout.write(text + '\n'); }
export function printErr(text: string): void { if (sink) sink.write(c.red(text) + '\n'); else process.stderr.write(c.red(text) + '\n'); }

function cliVersion(): string {
 try { return String((JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version?: string }).version ?? ''); } catch { return ''; }
}

// ---- inline markdown -------------------------------------------------------

function inline(s: string): string {
 if (!enabled) return s;
 return s
  .replace(/`([^`]+)`/g, (_m, code) => `\x1b[100m\x1b[97m ${code} \x1b[0m`)
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text) => c.underline(String(text)))
  .replace(/\*\*([^*]+)\*\*/g, (_m, b) => c.bold(String(b)))
  .replace(/(^|[^*\w])\*([^*\n]+)\*/g, (_m, pre, i) => String(pre) + c.italic(String(i)))
  .replace(/~~([^~]+)~~/g, (_m, s2) => c.strike(String(s2)));
}

// ---- incremental markdown stream -------------------------------------------
// Assistant answers stream in chunk by chunk; lines are rendered as soon as
// they complete, so fenced code blocks and headers get real styling without
// waiting for the whole reply.

export class MarkdownStream {
 private buf = '';
 private inCode = false;

 write(chunk: string): void {
  this.buf += chunk;
  let i: number;
  while ((i = this.buf.indexOf('\n')) >= 0) {
   const line = this.buf.slice(0, i);
   this.buf = this.buf.slice(i + 1);
   this.line(line);
  }
 }

 end(): void {
  if (this.buf) { this.line(this.buf); this.buf = ''; }
  if (this.inCode) { this.inCode = false; printLine(c.gray('  ╰─')); }
 }

 private line(text: string): void {
  const fence = text.match(/^\s*```(.*)$/);
  if (fence) {
   if (!this.inCode) { this.inCode = true; printLine(c.gray('  ╭─') + (fence[1].trim() ? c.gray(' ' + fence[1].trim()) : '')); }
   else { this.inCode = false; printLine(c.gray('  ╰─')); }
   return;
  }
  if (this.inCode) { printLine(c.gray('  │ ') + (enabled ? `\x1b[97m${text}\x1b[0m` : text)); return; }
  const header = text.match(/^(#{1,6})\s+(.*)$/);
  if (header) { printLine(''); printLine('  ' + c.bold(c.cyan(header[2]))); return; }
  if (/^\s*([-*_])\1{2,}\s*$/.test(text)) { printLine(c.gray('  ' + '─'.repeat(40))); return; }
  const quote = text.match(/^>\s?(.*)$/);
  if (quote) { printLine(c.gray('  ▎ ') + c.dim(inline(quote[1]))); return; }
  const list = text.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
  if (list) { printLine('  ' + list[1] + c.cyan(list[2].match(/\d/) ? list[2] : '•') + ' ' + inline(list[3])); return; }
  if (!text.trim()) { printLine(); return; }
  printLine('  ' + inline(text));
 }
}

// ---- spinner ---------------------------------------------------------------

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class Spinner {
 private timer: ReturnType<typeof setInterval> | null = null;
 private frame = 0;
 private text = '';
 private active = false;

 start(text: string): void {
  this.text = text;
  this.stop();
  this.active = true;
  if (sink) { this.timer = setInterval(() => sink?.status(c.cyan(SPINNER_FRAMES[this.frame++ % SPINNER_FRAMES.length]) + ' ' + this.text), 80); return; }
  if (!enabled) { this.active = false; return; }
  this.timer = setInterval(() => {
   process.stdout.write('\r\x1b[2K' + c.cyan(SPINNER_FRAMES[this.frame++ % SPINNER_FRAMES.length]) + ' ' + c.dim(this.text));
  }, 80);
 }

 update(text: string): void { this.text = text; }

 stop(): void {
  if (this.timer) { clearInterval(this.timer); this.timer = null; }
  if (!this.active) return;
  this.active = false;
  if (sink) { sink.status(null); return; }
  if (enabled) process.stdout.write('\r\x1b[2K');
 }
}

// ---- reasoning -------------------------------------------------------------

export function printReasoning(chunk: string): void { print(c.dim(c.italic(chunk))); }

// ---- tool cards ------------------------------------------------------------

export function toolStart(name: string, hint: string): void {
 printLine('');
 printLine('  ' + c.magenta('╭─ ') + c.bold(name) + (hint ? c.dim(' · ' + hint) : ''));
}

export function toolEnd(name: string, status: 'ok' | 'error' | 'declined', bytes?: number): void {
 const mark = status === 'ok' ? c.green('✓ ok') : status === 'declined' ? c.yellow('⌀ declined') : c.red('✗ error');
 const size = bytes !== undefined ? c.dim(` · ${formatBytes(bytes)}`) : '';
 printLine('  ' + c.magenta('╰─ ') + mark + c.dim(' ' + name) + size);
}

function formatBytes(n: number): string {
 if (n < 1024) return n + ' B';
 if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
 return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

// ---- usage / cost ----------------------------------------------------------

export function usageLine(promptTokens?: number, completionTokens?: number, pricing?: PricingMap, model?: string): string {
 if (promptTokens === undefined && completionTokens === undefined) return '';
 const parts: string[] = [];
 if (promptTokens !== undefined) parts.push(`↑${promptTokens.toLocaleString('en-US')}`);
 if (completionTokens !== undefined) parts.push(`↓${completionTokens.toLocaleString('en-US')}`);
 let line = parts.join(' ') + ' tokens';
 const price = model && pricing ? pricing[model] : undefined;
 if (price && promptTokens !== undefined && completionTokens !== undefined) {
  const cost = promptTokens / 1e6 * price.input + completionTokens / 1e6 * price.output;
  line += ` · ≈$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}`;
 }
 return line;
}

export function printUsage(promptTokens: number | undefined, completionTokens: number | undefined, pricing: PricingMap | undefined, model: string): void {
 const line = usageLine(promptTokens, completionTokens, pricing, model);
 if (line) printLine(c.dim('\n  ' + line));
}

// ---- todos / approvals / banner --------------------------------------------

export function printTodos(todos: TodoItem[]): void {
 if (!todos.length) return;
 printLine('  ' + c.bold('Tasks:'));
 for (const t of todos) printLine(`    ${t.done ? c.green('☑') : c.gray('☐')} ${t.done ? c.dim(t.text) : t.text}`);
}

// The framed request; the caller then asks the y/n/a question right after it.
export function printApproval(req: { kind: string; target: string; detail?: string }): void {
 const titles: Record<string, string> = { write: 'File write request', delete: 'Delete request', move: 'Move request', command: 'Command request', commit: 'Git commit request', web: 'Web access request' };
 printLine('');
 printLine('  ' + c.yellow('╭─ ⚠ ') + c.bold(titles[req.kind] ?? 'Approval request'));
 printLine('  ' + c.yellow('│  ') + c.cyan(req.target));
 if (req.detail) for (const line of req.detail.slice(0, 4000).split('\n')) printLine('  ' + c.yellow('│  ') + c.dim(line));
}

export function approvalPrompt(): string { return '  ' + c.yellow('╰─ ') + 'Allow? [y]es / [n]o / [a]lways: '; }

export function printBanner(provider: string, model: string, workspace: string | null, readonly: boolean): void {
 const title = `  ✦ Lumen CLI ${cliVersion()}`.trimEnd();
 const w = Math.max(44, title.length + 2);
 printLine('');
 printLine(c.cyan('  ╭' + '─'.repeat(w) + '╮'));
 printLine(c.cyan('  │') + c.bold(title) + ' '.repeat(Math.max(0, w - title.length)) + c.cyan('│'));
 printLine(c.cyan('  ╰' + '─'.repeat(w) + '╯'));
 printLine('  ' + c.dim('provider ') + provider + c.dim(' · model ') + model);
 if (workspace) printLine('  ' + c.dim('workspace ') + workspace + (readonly ? c.yellow(' (read-only)') : ''));
 else printLine('  ' + c.yellow('  no workspace tools') + c.dim(' (set one with --workspace or /workspace)'));
 printLine('  ' + c.dim('/help — commands · /exit — quit · Ctrl-C stops the reply'));
}
