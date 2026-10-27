import type { ProviderConfig } from '../electron/shared';
import { normalizeHistory, trimHistory } from '../electron/providers';
import { makeApprover } from './approve';
import { runAgent, type AgentResult, type OpRecord } from './agent';
import { resolveProvider, type CliConfig } from './config';
import { c, MarkdownStream, printErr, printLine, printReasoning, printTodos, printUsage, Spinner, toolEnd, toolStart } from './term';
import { recordTurn, sessionHistory, type Session } from './session';
import type { TodoItem } from '../electron/tools';

// Shared "ask the model once" used by both the interactive REPL and one-shot
// `lumencode run`. Wires the agent callbacks to terminal output and persists the turn.

export interface TurnContext {
 cfg: CliConfig;
 session: Session;
 provider: ProviderConfig;
 model: string;
 workspace: string | null;
 readonly: boolean;
 yes: boolean;
 // watch_files baseline for the current workspace (runtime only, not persisted)
 watchBaseline?: Map<string, number>;
}

// The approver is created once per process so "always allow" choices survive
// across turns, exactly like the desktop's per-chat session.
let approver: ReturnType<typeof makeApprover> | null = null;
let approverYes = false;

export async function runTurn(ctx: TurnContext, userText: string, controller: AbortController): Promise<AgentResult> {
 if (!approver || approverYes !== ctx.yes) { approver = makeApprover({ yes: ctx.yes }); approverYes = ctx.yes; }
 const resolved = resolveProvider(ctx.cfg, ctx.provider.id);
 const md = new MarkdownStream();
 const spinner = new Spinner();
 spinner.start('thinking…');
 const result = await runAgent(
  normalizeHistory(trimHistory(sessionHistory(ctx.session).concat([{ role: 'user', content: userText }]))),
  {
   provider: resolved,
   model: ctx.model,
   systemPrompt: ctx.cfg.systemPrompt,
   temperature: ctx.cfg.temperature,
   topP: ctx.cfg.topP,
   maxTokens: ctx.cfg.maxTokens,
   reasoningEffort: ctx.cfg.reasoningEffort,
   workspace: ctx.workspace,
   readonly: ctx.readonly,
   approve: approver,
   mcpServers: ctx.cfg.mcpServers,
   controller,
   firstMessage: ctx.session.messages.length === 0,
   watchBaseline: ctx.watchBaseline,
  },
  {
   onText: t => { spinner.stop(); md.write(t); },
   onReasoning: t => { spinner.stop(); printReasoning(t); },
   onTool: ev => {
    if (ev.status === 'running') { spinner.stop(); toolStart(ev.name, ev.hint); }
    else { toolEnd(ev.name, ev.status, ev.bytes); spinner.start('working…'); }
   },
   onTodos: (todos: TodoItem[]) => { ctx.session.todos = todos; printTodos(todos); },
   onOp: (op: OpRecord) => { ctx.session.ops.push(op); },
   onNote: note => { spinner.stop(); printLine(c.yellow('  ' + note.trim())); },
  },
 );
 spinner.stop();
 md.end();
 if (result.watchBaseline) ctx.watchBaseline = result.watchBaseline;
 // Persist the turn (partial answers survive, like the desktop on abort).
 recordTurn(ctx.session, userText, result.text, ctx.model, result.promptTokens, result.completionTokens);
 printUsage(result.promptTokens, result.completionTokens, ctx.provider.pricing, ctx.model);
 if (result.error) printErr('\nError: ' + result.error);
 else if (result.finishReason === 'length') printLine(c.dim('(answer hit the token limit — ask to continue)'));
 return result;
}
