import fs from 'node:fs';
import path from 'node:path';
import { COMMANDS_DIR, PLUGINS_DIR, type AgentConfig, type CliConfig } from './config';

// Plugin system (FR-5.4 / FR-5.5):
//  * Custom slash commands — Markdown files in ~/.lumen-cli/commands/ and
//    <workspace>/.lumencode/commands/. `/review-stuff arg1` sends the file
//    contents as a prompt with $ARGUMENTS substituted.
//  * Plugins — CommonJS files in ~/.lumen-cli/plugins/ and
//    <workspace>/.lumencode/plugins/. A plugin exports { name, commands } where
//    each command is { description, run(arg, api) }.
//  * Agents — named presets (prompt + optional model/provider) from the config
//    plus built-ins; switch with /agent or --agent.

export interface CustomCommand { name: string; description: string; source: 'markdown' | 'plugin'; body?: string; run?: (arg: string) => Promise<string | void> }

export interface PluginApi {
 log(message: string): void;
 workspace(): string | null;
}

interface PluginModule {
 name?: string;
 commands?: Record<string, { description?: string; run: (arg: string, api: PluginApi) => Promise<string | void> | string | void }>;
}

const loadedPlugins: string[] = [];
const pluginCommands: CustomCommand[] = [];
let pluginsLoaded = false;

export function loadPlugins(workspace: string | null, log: (msg: string) => void): void {
 const dirs = [PLUGINS_DIR, ...(workspace ? [path.join(workspace, '.lumencode', 'plugins')] : [])];
 for (const dir of dirs) {
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter(f => /\.(js|cjs)$/.test(f)); } catch { continue; }
  for (const f of files) {
   const full = path.join(dir, f);
   if (loadedPlugins.includes(full)) continue;
   try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- plugins are userland CJS by design
    const mod = require(full) as PluginModule;
    const name = mod.name ?? path.basename(f).replace(/\.(js|cjs)$/, '');
    for (const [cmdName, cmd] of Object.entries(mod.commands ?? {})) {
     pluginCommands.push({
      name: cmdName, source: 'plugin',
      description: cmdName + ' (plugin: ' + name + (mod.commands?.[cmdName]?.description ? ' — ' + mod.commands[cmdName].description : '') + ')',
      run: async arg => mod.commands?.[cmdName]?.run(arg, { log, workspace: () => workspace }),
     });
    }
    loadedPlugins.push(full);
    log(`Plugin loaded: ${name}`);
   } catch (e) {
    log(`Plugin ${f} failed to load: ${e instanceof Error ? e.message : String(e)}`);
   }
  }
 }
 pluginsLoaded = true;
}

export function markdownCommands(workspace: string | null): CustomCommand[] {
 const dirs = [COMMANDS_DIR, ...(workspace ? [path.join(workspace, '.lumencode', 'commands')] : [])];
 const out: CustomCommand[] = [];
 for (const dir of dirs) {
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')); } catch { continue; }
  for (const f of files) {
   try {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    const descMatch = /^<!--\s*description:\s*(.+?)\s*-->/m.exec(raw);
    out.push({
     name: path.basename(f, '.md'),
     description: descMatch?.[1] ?? 'custom command (' + path.join(dir, f) + ')',
     source: 'markdown',
     body: raw.replace(/^<!--\s*description:.*?-->\s*/m, ''),
    });
   } catch { /* unreadable file */ }
  }
 }
 return out;
}

// All custom commands visible right now (markdown + plugins).
export function customCommands(workspace: string | null): CustomCommand[] {
 return [...markdownCommands(workspace), ...(pluginsLoaded ? pluginCommands : [])];
}

// Render a markdown command into a prompt ($ARGUMENTS substitution).
export function renderMarkdownCommand(body: string, arg: string): string {
 return body.replace(/\$ARGUMENTS/g, arg).trim();
}

// ---- agents -----------------------------------------------------------------------

// Built-in agents (FR-5.5): specialized presets. User agents come from the
// config (`lumencode agent create`).
export const BUILTIN_AGENTS: AgentConfig[] = [
 { id: 'build', name: 'Build', description: 'Default coding agent — full tool access.', prompt: '' },
 { id: 'plan', name: 'Plan', description: 'Read-only planning agent: analyzes and proposes, never edits.', prompt: 'You are a planning agent. Investigate the codebase with read-only tools, then produce a concrete step-by-step implementation plan. Do NOT write or edit files and do NOT run mutating commands.' },
 { name: 'review', name: 'Review', description: 'Code-review agent: finds bugs, risks and style issues.', prompt: 'You are a senior code reviewer. Review the changes/code the user points at: correctness, security, performance, style. Report findings ordered by severity with file:line references. Be concise and specific.' },
];

export function allAgents(cfg: CliConfig): AgentConfig[] {
 const custom = (cfg.agents ?? []).filter(a => a && typeof a.id === 'string' && typeof a.prompt === 'string');
 return [...BUILTIN_AGENTS, ...custom.filter(a => !BUILTIN_AGENTS.some(b => b.id === a.id))];
}

export function findAgent(cfg: CliConfig, id: string | undefined): AgentConfig | null {
 if (!id) return null;
 return allAgents(cfg).find(a => a.id === id || a.name.toLowerCase() === id.toLowerCase()) ?? null;
}
