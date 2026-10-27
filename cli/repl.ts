import fs from 'node:fs';
import path from 'node:path';
import { restoreSnapshot } from '../electron/tools';
import { loadModels } from './agent';
import { findProvider, hasKey, resolveProvider, saveConfig } from './config';
import { ask, closeInput, isStdinClosed, onSigint, queuedCount, resolvePending, takeQueuedLine } from './input';
import { saveSession } from './session';
import { c, printBanner, printErr, printLine, printTodos } from './term';
import { canUseTui, Tui } from './tui';
import { runTurn, type TurnContext } from './turn';

const HELP = `
Commands:
  /help                 show this help
  /model [name]         show or change the model
  /provider [id]        show or change the provider
  /models               refresh the provider's model list from its API
  /workspace [dir|off]  show or change the workspace folder (tools live there)
  /readonly             toggle read-only mode (no writes/commands)
  /todos                show the current task checklist
  /ops                  show file operations of this session
  /rollback <n>         restore the backup snapshot of operation <n>
  /memory               show the workspace long-term memory (.lumen-memory.md)
  /clear                forget the conversation history
  /exit                 quit

End a line with \\ to continue it on the next line. Ctrl-C stops the current
reply (or declines an open approval); press it twice at the prompt to quit.
Text typed while a reply streams is queued and sent next (up to 10 lines).`;

export async function startRepl(ctx: TurnContext): Promise<void> {
 let generating = false;
 let controller: AbortController | null = null;
 let lastSigint = 0;

 onSigint(() => {
  if (generating) {
   resolvePending('n'); // an open approval counts as declined
   controller?.abort();
   printLine(c.dim('\n(stopping…)'));
   return;
  }
  const now = Date.now();
  if (now - lastSigint < 1000) { saveSession(ctx.session); closeInput(); process.exit(0); }
  lastSigint = now;
  printLine(c.dim('\n(Press Ctrl-C again to exit)'));
 });

 // With a real terminal, upgrade to the opencode-style TUI: scrollable chat on
 // top, fixed input panel at the bottom. Pipes keep the plain line mode.
 const tui = canUseTui() ? new Tui() : null;
 if (tui) {
  tui.start();
  tui.setBaseStatus(`${ctx.provider.name} · ${ctx.model}${ctx.readonly ? ' · read-only' : ''} · /help`);
 }

 printBanner(ctx.provider.name, ctx.model, ctx.workspace, ctx.readonly);

 try {
 for (;;) {
  // Buffered lines (typed ahead or piped) are consumed before asking for more.
  let line = takeQueuedLine() ?? await ask('\n' + c.cyan('you › '));
  if (!line && isStdinClosed()) break;

  // Multi-line drafts: a trailing backslash continues on the next line.
  while (line.endsWith('\\')) {
   const next = await ask(c.dim('... '));
   line = line.slice(0, -1) + '\n' + next;
  }

  const text = line.trim();
  if (!text) continue;
  if (text.startsWith('/')) { if (await slash(ctx, text)) break; continue; }

  await send(ctx, text);
  // Messages typed while the reply was streaming are sent next, in order;
  // queued slash commands run as commands, not prompts.
  let exit = false;
  while (queuedCount() && !exit) {
   const queued = takeQueuedLine();
   if (!queued?.trim()) continue;
   printLine('\n' + c.cyan('you › ') + c.dim(queued));
   if (queued.trim().startsWith('/')) exit = await slash(ctx, queued.trim());
   else await send(ctx, queued);
  }
  if (exit) break;
 }
 } finally {
  tui?.stop();
 }
 saveSession(ctx.session);

 async function send(ctx: TurnContext, text: string): Promise<void> {
  generating = true;
  controller = new AbortController();
  try { await runTurn(ctx, text, controller); }
  catch (e) { printErr('Error: ' + (e instanceof Error ? e.message : String(e))); }
  finally { generating = false; controller = null; }
 }
}

// Returns true when the REPL should exit.
async function slash(ctx: TurnContext, input: string): Promise<boolean> {
 const [cmd, ...rest] = input.slice(1).split(/\s+/);
 const arg = rest.join(' ').trim();
 switch (cmd) {
  case 'exit': case 'quit': return true;
  case 'help': printLine(HELP); return false;
  case 'clear':
   ctx.session.messages = [];
   ctx.session.todos = [];
   printLine(c.dim('Conversation history cleared.'));
   return false;
  case 'model':
   if (!arg) {
    printLine(c.dim('Current: ') + ctx.model);
    for (const m of ctx.provider.models) printLine('  ' + (m === ctx.model ? c.green('● ') : '  ') + m);
    return false;
   }
   ctx.model = arg;
   ctx.session.model = arg;
   printLine(c.dim('Model: ') + arg);
   return false;
  case 'provider': {
   if (!arg) {
    for (const p of ctx.cfg.providers) {
     const key = hasKey(ctx.cfg, p.id) ? c.green('key') : c.dim('no key');
     printLine('  ' + (p.id === ctx.provider.id ? c.green('● ') : '  ') + p.id.padEnd(12) + c.dim(' ' + p.name + ' · ' + key));
    }
    return false;
   }
   const p = findProvider(ctx.cfg, arg);
   if (!p) { printErr(`Unknown provider "${arg}".`); return false; }
   try { resolveProvider(ctx.cfg, p.id); } catch (e) { printErr(e instanceof Error ? e.message : String(e)); return false; }
   ctx.provider = p;
   ctx.model = ctx.cfg.defaultModel && ctx.cfg.defaultProvider === p.id ? ctx.cfg.defaultModel : (p.models[0] ?? ctx.model);
   ctx.session.providerId = p.id;
   ctx.session.model = ctx.model;
   printLine(c.dim(`Provider: ${p.name} · model ${ctx.model}`));
   return false;
  }
  case 'models': {
   try {
    const models = await loadModels(resolveProvider(ctx.cfg, ctx.provider.id));
    if (!models.length) { printLine(c.dim('The provider returned an empty list.')); return false; }
    ctx.provider.models = models;
    ctx.cfg.providers = ctx.cfg.providers.map(p => p.id === ctx.provider.id ? { ...p, models } : p);
    saveConfig(ctx.cfg);
    for (const m of models) printLine('  ' + (m === ctx.model ? c.green('● ') : '  ') + m);
   } catch (e) { printErr('Model refresh failed: ' + (e instanceof Error ? e.message : String(e))); }
   return false;
  }
  case 'workspace': {
   if (!arg) { printLine(c.dim('Workspace: ') + (ctx.workspace ?? c.yellow('(none)')) + (ctx.readonly ? c.dim(' (read-only)') : '')); return false; }
   if (arg === 'off') { ctx.workspace = null; printLine(c.dim('Workspace tools disabled.')); return false; }
   const dir = path.resolve(arg);
   if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { printErr('Not a folder: ' + dir); return false; }
   ctx.workspace = dir;
   ctx.watchBaseline = undefined;
   ctx.session.workspace = dir;
   printLine(c.dim('Workspace: ') + dir);
   return false;
  }
  case 'readonly':
   ctx.readonly = !ctx.readonly;
   ctx.session.readonly = ctx.readonly;
   printLine(c.dim('Read-only mode: ') + (ctx.readonly ? c.yellow('on — writes and commands are blocked') : 'off'));
   return false;
  case 'todos': printTodos(ctx.session.todos); return false;
  case 'ops': {
   if (!ctx.session.ops.length) { printLine(c.dim('No file operations yet.')); return false; }
   ctx.session.ops.forEach((op, i) => {
    const mark = op.status === 'ok' ? c.green('✓') : op.status === 'declined' ? c.yellow('⌀') : c.red('✗');
    printLine(`  ${c.dim(String(i + 1).padStart(3))} ${mark} ${op.tool}${op.path ? ' ' + op.path : ''}${op.snapshot ? c.dim(' (rollbackable)') : ''}`);
   });
   return false;
  }
  case 'rollback': {
   const n = Number(arg);
   const op = ctx.session.ops[n - 1];
   if (!op || !op.snapshot) { printErr('Usage: /rollback <n> — pick a rollbackable op from /ops'); return false; }
   if (!ctx.workspace) { printErr('No workspace set.'); return false; }
   try { printLine(c.green('Restored: ') + restoreSnapshot(ctx.workspace, op.snapshot)); }
   catch (e) { printErr('Rollback failed: ' + (e instanceof Error ? e.message : String(e))); }
   return false;
  }
  case 'memory': {
   if (!ctx.workspace) { printErr('No workspace set.'); return false; }
   const file = path.join(ctx.workspace, '.lumen-memory.md');
   try { printLine(fs.readFileSync(file, 'utf8').trim() || c.dim('(memory is empty)')); }
   catch { printLine(c.dim('(memory is empty)')); }
   return false;
  }
  default:
   printErr(`Unknown command /${cmd} — /help lists them all.`);
   return false;
 }
}
