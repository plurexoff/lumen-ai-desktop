import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { McpServer, ProviderConfig, ProviderId, ReasoningEffort } from '../electron/shared';
import { isCustomProviderId } from '../electron/shared';
import { DEFAULT_PRICING, isLoopbackUrl, validateProviderUrl, type ResolvedProvider } from '../electron/providers';

// CLI configuration lives outside the project in the user profile. Unlike the
// desktop app (Electron safeStorage / DPAPI), keys are stored as plain JSON —
// the file is created with owner-only permissions and `lumencode config` masks them.
export interface CliConfig {
 providers: ProviderConfig[];
 keys: Record<string, string>;
 defaultProvider?: string;
 defaultModel?: string;
 defaultWorkspace?: string;
 systemPrompt?: string;
 temperature?: number;
 topP?: number;
 maxTokens?: number;
 reasoningEffort?: ReasoningEffort;
 mcpServers?: McpServer[];
}

// Same presets as the desktop app (electron/main.ts).
export const DEFAULT_PROVIDERS: ProviderConfig[] = [
 { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'] },
 { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', models: ['claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022'] },
 { id: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', models: ['gemini-2.0-flash', 'gemini-2.5-pro-preview-03-25'] },
 { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: ['anthropic/claude-sonnet-4', 'openai/gpt-4o-mini'] },
 { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile', 'deepseek-r1-distill-llama-70b'] },
 { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
 { id: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', models: ['mistral-large-latest', 'mistral-small-latest'] },
 // Local servers ship keyless: both expose an OpenAI-compatible /v1 endpoint.
 { id: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: [] },
 { id: 'lmstudio', name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', models: [] },
];

// Environment variables that can substitute a stored key (conventional for CLIs).
const ENV_KEYS: Record<string, string[]> = {
 openai: ['OPENAI_API_KEY'],
 anthropic: ['ANTHROPIC_API_KEY'],
 gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
 openrouter: ['OPENROUTER_API_KEY'],
 groq: ['GROQ_API_KEY'],
 deepseek: ['DEEPSEEK_API_KEY'],
 mistral: ['MISTRAL_API_KEY'],
};

const CONFIG_DIR = path.join(os.homedir(), '.lumen-cli');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const SESSIONS_DIR = path.join(CONFIG_DIR, 'sessions');

export function configPath(): string { return CONFIG_FILE; }

export function loadConfig(): CliConfig {
 let raw: Partial<CliConfig> = {};
 try { raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Partial<CliConfig>; } catch { /* first run */ }
 const providers = Array.isArray(raw.providers) ? (raw.providers as ProviderConfig[]) : [];
 const merged: ProviderConfig[] = DEFAULT_PROVIDERS.map(d => {
  const saved = providers.find(p => p.id === d.id);
  return { ...d, ...(saved ?? {}), pricing: { ...(DEFAULT_PRICING[d.id] ?? {}), ...(saved?.pricing ?? {}) } };
 });
 for (const p of providers) if (isCustomProviderId(p.id) && !merged.some(m => m.id === p.id)) merged.push(p);
 return {
  providers: merged,
  keys: raw.keys && typeof raw.keys === 'object' ? raw.keys : {},
  defaultProvider: typeof raw.defaultProvider === 'string' ? raw.defaultProvider : undefined,
  defaultModel: typeof raw.defaultModel === 'string' ? raw.defaultModel : undefined,
  defaultWorkspace: typeof raw.defaultWorkspace === 'string' ? raw.defaultWorkspace : undefined,
  systemPrompt: typeof raw.systemPrompt === 'string' ? raw.systemPrompt : undefined,
  temperature: typeof raw.temperature === 'number' ? raw.temperature : undefined,
  topP: typeof raw.topP === 'number' ? raw.topP : undefined,
  maxTokens: typeof raw.maxTokens === 'number' ? raw.maxTokens : undefined,
  reasoningEffort: typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort : undefined,
  mcpServers: Array.isArray(raw.mcpServers) ? raw.mcpServers : undefined,
 };
}

export function saveConfig(cfg: CliConfig): void {
 fs.mkdirSync(CONFIG_DIR, { recursive: true });
 const tmp = CONFIG_FILE + '.tmp';
 fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
 try { fs.chmodSync(tmp, 0o600); } catch { /* Windows: best effort */ }
 fs.renameSync(tmp, CONFIG_FILE);
}

export function findProvider(cfg: CliConfig, id: string): ProviderConfig | undefined {
 return cfg.providers.find(p => p.id === id);
}

export function providerKey(cfg: CliConfig, id: string): string {
 if (cfg.keys[id]) return cfg.keys[id];
 for (const env of ENV_KEYS[id] ?? []) { const v = process.env[env]; if (v) return v; }
 return '';
}

export function hasKey(cfg: CliConfig, id: string): boolean { return !!providerKey(cfg, id); }

// CLI equivalent of the desktop getProvider(): resolves id → {url, key}, allowing
// keyless access only for loopback endpoints (Ollama, LM Studio).
export function resolveProvider(cfg: CliConfig, id: string): ResolvedProvider {
 const p = findProvider(cfg, id);
 if (!p) throw new Error(`Unknown provider "${id}". Run: lumencode providers`);
 if (!p.baseUrl) throw new Error(`Provider "${p.name}" has no base URL configured.`);
 const url = validateProviderUrl(p.baseUrl);
 const key = providerKey(cfg, id);
 if (!key && !isLoopbackUrl(url)) throw new Error(`No API key for ${p.name}. Run: lumencode login ${id} (or set ${(ENV_KEYS[id] ?? ['API key'])[0]})`);
 return { id: p.id as ProviderId, name: p.name, url, key };
}

// Pick the provider to chat with: explicit flag > session > default > first one
// that can actually authenticate (stored key, env var, or loopback).
export function pickProvider(cfg: CliConfig, explicit?: string, session?: string): ProviderConfig {
 const id = explicit ?? session ?? cfg.defaultProvider;
 if (id) {
  const p = findProvider(cfg, id);
  if (!p) throw new Error(`Unknown provider "${id}". Run: lumencode providers`);
  return p;
 }
 const usable = cfg.providers.find(p => hasKey(cfg, p.id) || isLoopbackUrl(p.baseUrl));
 if (!usable) throw new Error('No provider is set up yet. Run: lumencode login openai (or lumencode providers to see options)');
 return usable;
}

export function pickModel(cfg: CliConfig, provider: ProviderConfig, explicit?: string, session?: string): string {
 const model = explicit ?? session ?? (cfg.defaultProvider === provider.id ? cfg.defaultModel : undefined) ?? provider.models[0];
 if (!model) throw new Error(`No model selected for ${provider.name}. Run: lumencode models ${provider.id} to refresh the list, then: lumencode use ${provider.id} <model>`);
 return model;
}
