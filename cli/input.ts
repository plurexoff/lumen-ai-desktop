import readline from 'node:readline';

// Input layer with pluggable backends. Default: a shared readline interface
// (line mode) — used for pipes and non-TTY. When the TUI starts it swaps in its
// own backend (setImpl), so repl/approve/turn code stays unchanged.
// Lines typed while NO question is open are buffered as queued chat messages.

export interface AskOptions { approval?: boolean }

export interface IoImpl {
 ask(prompt: string, opts?: AskOptions): Promise<string>;
 resolvePending(value: string): boolean;
 takeQueuedLine(): string | undefined;
 queuedCount(): number;
 isStdinClosed(): boolean;
 onSigint(fn: () => void): void;
 close(): void;
}

const MAX_QUEUED_LINES = 10;

function createLineImpl(): IoImpl {
 let rl: readline.Interface | null = null;
 const queue: Array<{ resolve: (v: string) => void }> = [];
 const queuedLines: string[] = [];
 let sigintHandler: (() => void) | null = null;
 let stdinClosed = false;

 const iface = (): readline.Interface => {
  if (!rl) {
   rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
   rl.on('line', line => {
    const q = queue.shift();
    if (q) q.resolve(line);
    else if (queuedLines.length < MAX_QUEUED_LINES) queuedLines.push(line);
   });
   rl.on('SIGINT', () => sigintHandler?.());
   rl.on('close', () => {
    stdinClosed = true;
    // A pending question resolves empty (counts as a declined approval); buffered
    // lines are still processed — the REPL exits once they run out.
    const q = queue.shift();
    if (q) q.resolve('');
    else if (!queuedLines.length) process.exit(0);
   });
  }
  return rl;
 };

 return {
  ask(prompt) {
   if (stdinClosed) return Promise.resolve('');
   const i = iface();
   return new Promise(resolve => {
    queue.push({ resolve });
    i.setPrompt(prompt);
    i.prompt();
   });
  },
  resolvePending(value) {
   const q = queue.shift();
   if (!q) return false;
   q.resolve(value);
   return true;
  },
  takeQueuedLine: () => queuedLines.shift(),
  queuedCount: () => queuedLines.length,
  isStdinClosed: () => stdinClosed,
  onSigint(fn) { sigintHandler = fn; },
  close() { rl?.close(); rl = null; },
 };
}

let lineImpl: IoImpl | null = null;
let customImpl: IoImpl | null = null;
const io = (): IoImpl => customImpl ?? (lineImpl ??= createLineImpl());

// The TUI installs itself here; passing null restores line mode.
export function setImpl(custom: IoImpl | null): void { customImpl = custom; }

export function ask(prompt: string, opts?: AskOptions): Promise<string> { return io().ask(prompt, opts); }
export function resolvePending(value: string): boolean { return io().resolvePending(value); }
export function takeQueuedLine(): string | undefined { return io().takeQueuedLine(); }
export function queuedCount(): number { return io().queuedCount(); }
export function isStdinClosed(): boolean { return io().isStdinClosed(); }
export function onSigint(fn: () => void): void { io().onSigint(fn); }
export function closeInput(): void { io().close(); }
