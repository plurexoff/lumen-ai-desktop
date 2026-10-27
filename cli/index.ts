#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { isCustomProviderId, type ProviderId } from '../electron/shared';
import { validateProviderUrl } from '../electron/providers';
import { mcpShutdown } from '../electron/mcp';
import { loadModels } from './agent';
import { ask, closeInput, onSigint, resolvePending } from './input';
import { configPath, findProvider, loadConfig, pickModel, pickProvider, providerKey, resolveProvider, saveConfig } from './config';
import { latestSession, listSessions, loadSession, newSession } from './session';
import { c, printErr, printLine } from './term';
import { startRepl } from './repl';
import { runTurn, type TurnContext } from './turn';

const USAGE = `Lumen CLI — multi-provider AI chat with OpenCode-style workspace tools

Usage:
  lumencode                               interactive chat (TUI)
  lumencode <prompt...>                   one-shot answer (same as: lumencode run …)
  lumencode run <prompt...>               one-shot answer
  lumencode chat                          interactive chat
  lumencode login <provider> [key]        save an API key (prompts when omitted)
  lumencode logout <provider>             remove a saved key
  lumencode add-provider <id> <url> [name]  register a custom OpenAI-compatible endpoint
  lumencode providers                     list providers and key status
  lumencode models [provider]             refresh and list models from the provider API
  lumencode use <provider> [model]        set the default provider/model
  lumencode config                        show the configuration (keys masked)
  lumencode sessions                      list saved sessions
  lumencode init                          write a starter LUMEN.md into the current folder
  lumencode help                          show this help

Flags:
  -p, --provider <id>    provider to use (openai, anthropic, gemini, openrouter,
                         groq, deepseek, mistral, ollama, lmstudio, custom-…)
  -m, --model <name>     model to use
  -w, --workspace <dir>  workspace folder for file tools (default: cwd)
      --no-workspace     disable workspace tools
      --readonly         read-only mode: no writes, edits or commands
  -y, --yes              auto-approve every write/command/fetch
      --effort <level>   reasoning effort: off | low | medium | high
      --temperature <n>  sampling temperature (0-2)
      --top-p <n>        nucleus sampling (0-1)
      --max-tokens <n>   response token limit
      --system <text>    system prompt
  -c, --continue         continue the most recent session
      --session <id>     continue a specific session (see: lumencode sessions)

Providers without a saved key fall back to the usual environment variables
(OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, …). Local servers
(Ollama, LM Studio) work with no key at all.`;

interface Flags {
 provider?: string; model?: string; workspace?: string; noWorkspace?: boolean;
 readonly?: boolean; yes?: boolean; effort?: 'off' | 'low' | 'medium' | 'high';
 temperature?: number; topP?: number; maxTokens?: number; system?: string;
 continueSession?: boolean; sessionId?: string;
}

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
 const flags: Flags = {};
 const positional: string[] = [];
 const valueFlags: Record<string, keyof Flags> = {
  '-p': 'provider', '--provider': 'provider', '-m': 'model', '--model': 'model',
  '-w': 'workspace', '--workspace': 'workspace', '--effort': 'effort',
  '--temperature': 'temperature', '--top-p': 'topP', '--max-tokens': 'maxTokens',
  '--system': 'system', '--session': 'sessionId',
 };
 for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const key = valueFlags[a];
  if (key) {
   const v = argv[++i];
   if (v === undefined) throw new Error(`Flag ${a} needs a value`);
   if (key === 'temperature' || key === 'topP' || key === 'maxTokens') {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`Flag ${a} needs a number`);
    (flags as Record<string, unknown>)[key] = n;
   } else (flags as Record<string, unknown>)[key] = v;
  } else if (a === '--no-workspace') flags.noWorkspace = true;
  else if (a === '--readonly') flags.readonly = true;
  else if (a === '-y' || a === '--yes') flags.yes = true;
  else if (a === '-c' || a === '--continue') flags.continueSession = true;
  else if (a.startsWith('-') && a !== '-') throw new Error(`Unknown flag ${a} (lumencode help)`);
  else positional.push(a);
 }
 if (flags.effort && !['off', 'low', 'medium', 'high'].includes(flags.effort)) throw new Error('--effort must be off|low|medium|high');
 return { positional, flags };
}

function applyFlagOverrides(cfg: ReturnType<typeof loadConfig>, flags: Flags): void {
 if (flags.temperature !== undefined) cfg.temperature = flags.temperature;
 if (flags.topP !== undefined) cfg.topP = flags.topP;
 if (flags.maxTokens !== undefined) cfg.maxTokens = flags.maxTokens;
 if (flags.effort) cfg.reasoningEffort = flags.effort;
 if (flags.system) cfg.systemPrompt = flags.system;
}

function resolveWorkspace(cfg: ReturnType<typeof loadConfig>, flags: Flags, sessionWorkspace?: string | null): string | null {
 if (flags.noWorkspace) return null;
 const raw = flags.workspace ?? sessionWorkspace ?? cfg.defaultWorkspace ?? process.cwd();
 const dir = path.resolve(raw);
 if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('Workspace is not a folder: ' + dir);
 return dir;
}

function maskKey(key: string): string { return key.length <= 6 ? '•••' : key.slice(0, 4) + '…' + key.slice(-2); }

async function main(): Promise<void> {
 const { positional, flags } = parseArgs(process.argv.slice(2));
 const cfg = loadConfig();
 applyFlagOverrides(cfg, flags);
 const cmd = positional[0];

 switch (cmd) {
  case 'help': case '--help': case '-h': printLine(USAGE); return;

  case 'login': {
   const id = positional[1];
   if (!id) throw new Error('Usage: lumencode login <provider> [key]');
   const p = findProvider(cfg, id);
   if (!p) throw new Error(`Unknown provider "${id}". Run: lumencode providers`);
   let key = positional[2];
   if (!key) key = (await ask(`API key for ${p.name}: `)).trim();
   if (!key) throw new Error('Empty key — nothing saved.');
   cfg.keys[id] = key;
   saveConfig(cfg);
   printLine(c.green('✓ ') + `Key saved for ${p.name} (${configPath()}, permissions 600)`);
   return;
  }

  case 'logout': {
   const id = positional[1];
   if (!id) throw new Error('Usage: lumencode logout <provider>');
   if (!cfg.keys[id]) { printLine(c.dim('No key stored for ' + id)); return; }
   delete cfg.keys[id];
   saveConfig(cfg);
   printLine(c.green('✓ ') + 'Key removed for ' + id);
   return;
  }

  case 'add-provider': {
   const [, id, url, ...nameParts] = positional;
   if (!id || !url) throw new Error('Usage: lumencode add-provider <custom-id> <base-url> [name]');
   if (!isCustomProviderId(id) || id === 'custom') throw new Error('Custom provider ids look like custom-<name> (e.g. custom-lab)');
   const baseUrl = validateProviderUrl(url); // HTTPS, loopback http allowed
   if (findProvider(cfg, id)) throw new Error(`Provider "${id}" already exists.`);
   cfg.providers.push({ id: id as ProviderId, name: nameParts.join(' ') || id, baseUrl, models: [] });
   saveConfig(cfg);
   printLine(c.green('✓ ') + `Added ${id} (${baseUrl}). Next: lumencode login ${id}, then lumencode models ${id}`);
   return;
  }

  case 'providers': {
   for (const p of cfg.providers) {
    const key = providerKey(cfg, p.id) ? c.green('key: ' + maskKey(providerKey(cfg, p.id))) : c.dim('no key');
    const def = cfg.defaultProvider === p.id ? c.cyan(' (default)') : '';
    printLine('  ' + p.id.padEnd(12) + p.name.padEnd(16) + key + def);
    printLine(c.dim('    ' + (p.baseUrl || '(no URL)') + (p.models.length ? ' · models: ' + p.models.slice(0, 4).join(', ') + (p.models.length > 4 ? ', …' : '') : '')));
   }
   return;
  }

  case 'models': {
   const id = positional[1] ?? flags.provider ?? cfg.defaultProvider;
   if (!id) throw new Error('Usage: lumencode models <provider>');
   const models = await loadModels(resolveProvider(cfg, id));
   if (!models.length) { printLine(c.dim('The provider returned an empty list.')); return; }
   cfg.providers = cfg.providers.map(p => p.id === id ? { ...p, models } : p);
   saveConfig(cfg);
   for (const m of models) printLine('  ' + m);
   return;
  }

  case 'use': {
   const [, id, model] = positional;
   if (!id) throw new Error('Usage: lumencode use <provider> [model]');
   const p = findProvider(cfg, id);
   if (!p) throw new Error(`Unknown provider "${id}". Run: lumencode providers`);
   resolveProvider(cfg, id); // fails early when no key is available
   cfg.defaultProvider = id;
   if (model) cfg.defaultModel = model;
   else if (!cfg.defaultModel && p.models.length) cfg.defaultModel = p.models[0];
   saveConfig(cfg);
   printLine(c.green('✓ ') + `Default: ${p.name} · ${cfg.defaultModel ?? c.yellow('(pick a model with -m or /model)')}`);
   return;
  }

  case 'config': {
   printLine(c.dim('Config: ') + configPath());
   printLine(c.dim('Default provider: ') + (cfg.defaultProvider ?? '(auto)'));
   printLine(c.dim('Default model: ') + (cfg.defaultModel ?? '(auto)'));
   if (cfg.defaultWorkspace) printLine(c.dim('Default workspace: ') + cfg.defaultWorkspace);
   if (cfg.systemPrompt) printLine(c.dim('System prompt: ') + cfg.systemPrompt.slice(0, 80));
   printLine(c.dim('Sampling: ') + `temperature ${cfg.temperature ?? 0.7}, top-p ${cfg.topP ?? 1}, max tokens ${cfg.maxTokens ?? 2048}, effort ${cfg.reasoningEffort ?? 'provider default'}`);
   const keys = Object.keys(cfg.keys);
   printLine(c.dim('Saved keys: ') + (keys.length ? keys.map(k => `${k} (${maskKey(cfg.keys[k])})`).join(', ') : '(none)'));
   if (cfg.mcpServers?.length) printLine(c.dim('MCP servers: ') + cfg.mcpServers.map(s => s.name || s.id).join(', '));
   return;
  }

  case 'sessions': {
   const sessions = listSessions();
   if (!sessions.length) { printLine(c.dim('No saved sessions yet.')); return; }
   for (const s of sessions.slice(0, 20)) {
    printLine(`  ${c.cyan(s.id.slice(0, 8))}  ${new Date(s.updatedAt).toLocaleString()}  ${c.dim(String(s.messages.length).padStart(3) + ' msgs')}  ${s.title}`);
   }
   printLine(c.dim('\nContinue one with: lumencode chat --session <id> (or -c for the latest)'));
   return;
  }

  case 'init': {
   const file = path.join(process.cwd(), 'LUMEN.md');
   if (fs.existsSync(file)) { printLine(c.dim('LUMEN.md already exists.')); return; }
   fs.writeFileSync(file, '# Project rules for Lumen\n\n- Build: <how to build>\n- Test: <how to test>\n- Style: <conventions>\n\nLumen reads this file at the start of every chat in this workspace.\n');
   printLine(c.green('✓ ') + 'LUMEN.md created — edit it with your project rules.');
   return;
  }

  case 'chat': case 'run': case undefined: {
   // chat / run / bare prompt all share the same setup; only the loop differs.
   const prompt = cmd === 'run' ? positional.slice(1).join(' ') : cmd === undefined ? positional.join(' ') : '';
   const oneShot = cmd === 'run' || (cmd === undefined && prompt.trim().length > 0);
   if ((cmd === 'run') && !prompt.trim()) throw new Error('Usage: lumencode run <prompt...>');

   let session = flags.sessionId ? loadSession(flags.sessionId) : flags.continueSession ? latestSession() : null;
   if (flags.sessionId && !session) throw new Error('Session not found: ' + flags.sessionId + ' (see: lumencode sessions)');
   if (!session) session = newSession();
   if (flags.provider) { session.providerId = undefined; } // explicit flag wins; don't inherit stale session choice
   const provider = pickProvider(cfg, flags.provider, flags.provider ? undefined : session.providerId);
   const model = pickModel(cfg, provider, flags.model, flags.model ? undefined : session.model);
   const workspace = resolveWorkspace(cfg, flags, session.workspace);
   const readonly = flags.readonly ?? session.readonly ?? false;
   session.workspace = workspace;
   session.providerId = provider.id;
   session.model = model;

   const ctx: TurnContext = { cfg, session, provider, model, workspace, readonly, yes: !!flags.yes };

   if (oneShot) {
    const controller = new AbortController();
    onSigint(() => { resolvePending('n'); controller.abort(); });
    await runTurn(ctx, prompt, controller);
    return;
   }
   await startRepl(ctx);
   return;
  }

  default:
   // Unknown word in position 0 with more text → treat the whole line as a prompt.
   if (positional.length > 1 || cmd.length > 0) {
    const prompt = positional.join(' ');
    const session = newSession();
    const provider = pickProvider(cfg, flags.provider, undefined);
    const model = pickModel(cfg, provider, flags.model, undefined);
    const workspace = resolveWorkspace(cfg, flags, null);
    const ctx: TurnContext = { cfg, session, provider, model, workspace, readonly: !!flags.readonly, yes: !!flags.yes };
    const controller = new AbortController();
    onSigint(() => { resolvePending('n'); controller.abort(); });
    await runTurn(ctx, prompt, controller);
    return;
   }
   printLine(USAGE);
 }
}

process.on('exit', () => { try { mcpShutdown(); } catch { /* best effort */ } });
main().catch(e => { printErr('Error: ' + (e instanceof Error ? e.message : String(e))); process.exit(1); }).finally(() => closeInput());
