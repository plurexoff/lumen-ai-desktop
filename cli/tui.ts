import { setSink, c } from './term';
import { setImpl, type IoImpl, type AskOptions } from './input';

// Full terminal UI (opencode-style): a scrollable chat region on top and a
// fixed input panel at the bottom — border row with the current role, the
// input line itself, and a status bar (spinner / hints). Chat output streams
// into the scroll region while the input panel stays put.
//
// Raw-mode key handling + an ANSI scroll region; no dependencies.

const MAX_QUEUED_LINES = 10;

const KEY_SEQS: Record<string, string> = {
 '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left',
 '\x1b[H': 'home', '\x1b[F': 'end', '\x1bOH': 'home', '\x1bOF': 'end',
 '\x1b[1~': 'home', '\x1b[4~': 'end', '\x1b[3~': 'delete',
};

// eslint-disable-next-line no-control-regex -- ANSI escape handling is the point
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

export class Tui implements IoImpl {
 private buf = '';
 private cursor = 0;
 private winStart = 0;
 private label = 'you';
 private status = '';
 private baseStatus = '';
 private rows = process.stdout.rows || 24;
 private cols = process.stdout.columns || 80;
 private pending: { resolve: (v: string) => void; approval: boolean } | null = null;
 private queued: string[] = [];
 private sigintHandler: (() => void) | null = null;
 private history: string[] = [];
 private historyIdx = -1;
 private draft = '';
 private outRemainder = '';
 private partial = '';
 private pasteBuf: string | null = null;
 private stopped = false;
 // Next free row inside the scroll region (1-based) — chat fills top-down and
 // starts scrolling only when the region is full.
 private regionRow = 1;

 start(): void {
  setSink({ write: s => this.writeOut(s), status: s => { this.status = s ?? ''; this.drawInput(); } });
  setImpl(this);
  process.stdout.write('\x1b[?2004h'); // bracketed paste
  this.layout();
  process.stdout.on('resize', this.onResize);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', this.onData);
 }

 stop(): void {
  if (this.stopped) return;
  this.stopped = true;
  process.stdin.off('data', this.onData);
  process.stdout.removeListener('resize', this.onResize);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  setSink(null);
  setImpl(null);
  // Restore the normal scroll region, erase the panel and leave the cursor
  // where the panel was, so the shell prompt continues cleanly.
  process.stdout.write(`\x1b[${this.sr + 1};1H\x1b[J\x1b[r\x1b[${this.sr + 1};1H\x1b[?2004l`);
 }

 setBaseStatus(s: string): void { this.baseStatus = s; this.drawInput(); }

 // ---- IoImpl ----------------------------------------------------------------

 ask(prompt: string, opts?: AskOptions): Promise<string> {
  const plain = stripAnsi(prompt);
  this.label = opts?.approval || /allow\?/i.test(plain) ? 'allow? [y/n/a]' : plain.includes('...') ? '…' : 'you';
  this.historyIdx = -1;
  return new Promise(resolve => {
   this.pending = { resolve, approval: this.label.startsWith('allow?') };
   this.drawInput();
  });
 }

 resolvePending(value: string): boolean {
  if (!this.pending) return false;
  const p = this.pending;
  this.pending = null;
  this.buf = '';
  this.cursor = 0;
  p.resolve(value);
  return true;
 }

 takeQueuedLine(): string | undefined { return this.queued.shift(); }
 queuedCount(): number { return this.queued.length; }
 isStdinClosed(): boolean { return false; }
 onSigint(fn: () => void): void { this.sigintHandler = fn; }
 close(): void { this.stop(); }

 // ---- layout / rendering ------------------------------------------------------

 private get sr(): number { return Math.max(1, this.rows - 3); } // last scroll row

 private layout(): void {
  process.stdout.write(`\x1b[1;${this.sr}r\x1b[${this.sr};1H`);
  this.drawInput();
 }

 private onResize = (): void => {
  // Erase the panel at its OLD position first — otherwise a copy of it stays
  // frozen in the scrollback when the window grows.
  process.stdout.write(`\x1b[${this.sr + 1};1H\x1b[J`);
  this.rows = process.stdout.rows || 24;
  this.cols = process.stdout.columns || 80;
  this.regionRow = Math.min(this.regionRow, this.sr);
  process.stdout.write(`\x1b[1;${this.sr}r`);
  this.drawInput();
 };

 // Chat output lands in the scroll region (rows 1..sr), filling it top-down.
 // A trailing partial line (stream chunks without \n yet) is re-rendered in
 // place on the current row.
 private writeOut(s: string): void {
  this.outRemainder += s;
  const parts = this.outRemainder.split('\n');
  this.outRemainder = parts.pop() ?? '';
  let out = '';
  for (const line of parts) {
   out += `\x1b[${this.regionRow};1H\x1b[2K` + line;
   if (this.regionRow === this.sr) out += '\n'; // at the bottom: scroll up
   else this.regionRow++;
  }
  out += `\x1b[${this.regionRow};1H\x1b[2K` + this.outRemainder;
  process.stdout.write(out);
  this.drawInput();
 }

 private visibleWindow(textWidth: number): { text: string; cursorCol: number } {
  const disp = this.buf.replace(/\n/g, '↵');
  if (this.cursor < this.winStart) this.winStart = this.cursor;
  if (this.cursor > this.winStart + textWidth - 1) this.winStart = this.cursor - textWidth + 1;
  if (this.winStart > Math.max(0, disp.length - textWidth)) this.winStart = Math.max(0, disp.length - textWidth);
  return { text: disp.slice(this.winStart, this.winStart + textWidth), cursorCol: this.cursor - this.winStart };
 }

 private drawInput(): void {
  if (this.stopped) return;
  const w = this.cols;
  const r = this.sr;
  const label = ` ${this.label} `;
  const top = c.cyan('╭─' + label + '─'.repeat(Math.max(0, w - 3 - label.length)) + '╮');
  const textWidth = Math.max(8, w - 6);
  const { text, cursorCol } = this.visibleWindow(textWidth);
  const mid = c.cyan('│') + ' ' + c.green('❯') + ' ' + text + ' '.repeat(Math.max(0, textWidth - text.length)) + ' ' + c.cyan('│');
  const st = this.status || this.baseStatus;
  const stLen = st ? stripAnsi(st).length : 0;
  const bot = st
   ? c.cyan('╰─ ') + st + ' '.repeat(Math.max(0, w - 6 - stLen)) + c.cyan(' ╯')
   : c.cyan('╰' + '─'.repeat(Math.max(0, w - 2)) + '╯');
  process.stdout.write(
   `\x1b[${r + 1};1H\x1b[2K` + top +
   `\x1b[${r + 2};1H\x1b[2K` + mid +
   `\x1b[${r + 3};1H\x1b[2K` + bot +
   `\x1b[${r + 2};${5 + cursorCol}H`,
  );
 }

 // ---- key handling ------------------------------------------------------------

 private onData = (data: string): void => {
  let s = this.partial + data;
  this.partial = '';
  while (s.length) {
   // Bracketed paste: everything between the markers is inserted verbatim.
   if (this.pasteBuf !== null) {
    const end = s.indexOf('\x1b[201~');
    if (end < 0) { this.pasteBuf += s; return; }
    this.pasteBuf += s.slice(0, end);
    s = s.slice(end + 6);
    this.insert(this.pasteBuf.replace(/\r\n?/g, '\n'));
    this.pasteBuf = null;
    continue;
   }
   if (s.startsWith('\x1b[200~')) { this.pasteBuf = ''; s = s.slice(6); continue; }
   if (s[0] === '\x1b') {
    let matched = false;
    for (const seq of Object.keys(KEY_SEQS)) {
     if (s.startsWith(seq)) { this.key(KEY_SEQS[seq]); s = s.slice(seq.length); matched = true; break; }
    }
    if (matched) continue;
    // Incomplete escape sequence at the end — wait for more bytes.
    // eslint-disable-next-line no-control-regex -- matching the raw ESC prefix
    if (/^\x1b(\[[0-9;~]*)?$/.test(s)) { this.partial = s; return; }
    this.key('escape');
    s = s.slice(1);
    continue;
   }
   const ch = s[0];
   s = s.slice(1);
   if (ch === '\r' || ch === '\n') this.key('enter');
   else if (ch === '\x7f' || ch === '\x08') this.key('backspace');
   else if (ch === '\x03') this.key('ctrl-c');
   else if (ch === '\x01') this.key('home');       // Ctrl-A
   else if (ch === '\x05') this.key('end');        // Ctrl-E
   else if (ch === '\x15') { this.buf = ''; this.cursor = 0; this.drawInput(); } // Ctrl-U
   else if (ch >= ' ') this.insert(ch);
  }
 };

 private insert(text: string): void {
  // During an approval the answer is a single keypress: y / n / a.
  if (this.pending?.approval && /^[yYnNaA]$/.test(text)) { this.resolvePending(text.toLowerCase()); this.drawInput(); return; }
  this.buf = this.buf.slice(0, this.cursor) + text + this.buf.slice(this.cursor);
  this.cursor += text.length;
  this.drawInput();
 }

 private submit(): void {
  const line = this.buf;
  // Trailing backslash = multi-line continuation (same as line mode).
  if (line.endsWith('\\')) {
   this.buf = line.slice(0, -1) + '\n';
   this.cursor = this.buf.length;
   this.drawInput();
   return;
  }
  this.buf = '';
  this.cursor = 0;
  this.winStart = 0;
  if (line.trim()) { this.history.push(line); if (this.history.length > 100) this.history.shift(); }
  if (this.pending) {
   const p = this.pending;
   this.pending = null;
   p.resolve(line);
  } else if (line.trim()) {
   if (this.queued.length < MAX_QUEUED_LINES) {
    this.queued.push(line);
    this.status = `queued (${this.queued.length}) — sent when the reply finishes`;
   }
  }
  this.drawInput();
 }

 private key(name: string): void {
  switch (name) {
   case 'ctrl-c': this.sigintHandler?.(); return;
   case 'escape':
    if (this.pending?.approval) this.resolvePending('n');
    return;
   case 'enter': this.submit(); return;
   case 'left': if (this.cursor > 0) this.cursor--; break;
   case 'right': if (this.cursor < this.buf.length) this.cursor++; break;
   case 'home': this.cursor = 0; break;
   case 'end': this.cursor = this.buf.length; break;
   case 'backspace':
    if (this.cursor > 0) { this.buf = this.buf.slice(0, this.cursor - 1) + this.buf.slice(this.cursor); this.cursor--; }
    break;
   case 'delete':
    if (this.cursor < this.buf.length) this.buf = this.buf.slice(0, this.cursor) + this.buf.slice(this.cursor + 1);
    break;
   case 'up':
    if (this.history.length && !this.pending?.approval) {
     if (this.historyIdx === -1) { this.draft = this.buf; this.historyIdx = this.history.length - 1; }
     else if (this.historyIdx > 0) this.historyIdx--;
     this.buf = this.history[this.historyIdx];
     this.cursor = this.buf.length;
    }
    break;
   case 'down':
    if (this.historyIdx !== -1) {
     if (this.historyIdx < this.history.length - 1) { this.historyIdx++; this.buf = this.history[this.historyIdx]; }
     else { this.historyIdx = -1; this.buf = this.draft; }
     this.cursor = this.buf.length;
    }
    break;
   default: return;
  }
  this.drawInput();
 }
}

export function canUseTui(): boolean {
 return !!(process.stdin.isTTY && process.stdout.isTTY);
}
