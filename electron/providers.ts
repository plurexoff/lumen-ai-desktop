import type { ChatRequest, FinishReason, HotkeyMap, ModelPrice, NewAttachment, Persona, PricingMap, ProviderConfig, ProviderId } from './shared';
import { ACCENTS, DEFAULT_HOTKEYS, IMAGE_MIMES, MAX_ATTACHMENT_BYTES, MAX_IMAGE_ATTACHMENTS, MAX_PERSONAS, PERSONA_COLORS } from './shared';

export interface ResolvedProvider { id: string; name: string; url: string; key: string; }
// `images` are base64 payloads inlined into the provider request (all supported
// vision APIs take inline images; hosting them would leak them to a third party).
// toolCalls/toolResults appear only on in-flight wire messages built by the tool
// loop in main.ts — they are never persisted to the DB.
export interface ToolCallRecord { id: string; name: string; args: string }
export interface ToolResultRecord { toolCallId: string; name: string; content: string }
export interface HistoryMessage { role: string; content: string; images?: { mime: string; data: string }[]; toolCalls?: ToolCallRecord[]; toolResults?: ToolResultRecord[] }
export interface ProviderRequest {
 url: string;
 headers: Record<string,string>;
 body: unknown;
}
export interface ToolDef { name: string; description: string; schema: Record<string, unknown> }
export interface RequestParams {
 model: string;
 systemPrompt?: string;
 temperature?: number;
 maxTokens?: number;
 topP?: number;
 tools?: ToolDef[];
}
// Keep the context bounded: recent turns first so long chats cannot overflow the
// provider context window. The system prompt is added separately per provider.
export const MAX_HISTORY_MESSAGES = 40;
// Local servers (Ollama, LM Studio) have no API key at all. Requiring one made the
// advertised localhost support unusable, so loopback endpoints may run keyless.
const LOOPBACK_HOSTS = new Set(['localhost','127.0.0.1','[::1]','::1']);
export function isLoopbackUrl(value: string): boolean {
 try { return LOOPBACK_HOSTS.has(new URL(value).hostname); } catch { return false; }
}

export function trimHistory(history: HistoryMessage[], max = MAX_HISTORY_MESSAGES): HistoryMessage[] {
 if (history.length <= max) return history;
 return history.slice(history.length - max);
}

// Providers reject a window that opens on an assistant turn or contains two
// neighbours of the same role. A single failed send leaves an orphan user row, so
// without this the conversation is permanently broken with no way to repair it from
// the UI. Applied AFTER trimming: trim can expose a leading assistant on its own.
// `allowTrailingAssistant` is the Anthropic prefill path: the partial answer is
// itself the final turn, so it must NOT be stripped there.
export function normalizeHistory(history: HistoryMessage[], options?: { allowTrailingAssistant?: boolean }): HistoryMessage[] {
 const out: HistoryMessage[] = [];
 for (const m of history) {
  // An image-only turn has no text but must survive.
  if ((!m.content || !m.content.trim()) && !(m.images && m.images.length)) continue;
  const role = m.role === 'assistant' ? 'assistant' : 'user';
  const prev = out[out.length - 1];
  if (prev && prev.role === role) {
   prev.content = (prev.content + '\n\n' + m.content).trim();
   if (m.images) prev.images = [...(prev.images ?? []), ...m.images];
   continue;
  }
  out.push(m.images ? { role, content: m.content, images: m.images } : { role, content: m.content });
 }
 if (out[0]?.role === 'assistant') out.shift();
 if (!options?.allowTrailingAssistant) {
  while (out.length && out[out.length - 1].role === 'assistant') out.pop();
 }
 return out;
}

export function parseSseEvent(line: string): string | null {
 if (!line.startsWith('data:')) return null;
 const raw = line.slice(5).trim(); if (!raw || raw === '[DONE]') return null;
 try {
  const obj = JSON.parse(raw) as { choices?: Array<{ delta?: { content?: string } }>; type?: string; delta?: { text?: string }; candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> };
  // Gemini splits a turn across several parts; only non-thought parts are the
  // visible answer. Reading parts[0] alone dropped text and leaked thoughts.
  if (obj.candidates?.[0]?.content?.parts) {
   const text = obj.candidates[0].content.parts.filter(p => !p.thought).map(p => p.text ?? '').join('');
   if (text) return text;
  }
  return obj.choices?.[0]?.delta?.content ?? (obj.type === 'content_block_delta' ? obj.delta?.text : undefined) ?? null;
 } catch { return null; }
}

// Reasoning models stream chain-of-thought separately: OpenAI-style
// `reasoning_content`, Gemini `parts[].thought`. Surfacing it beats dropping it.
export function parseReasoningEvent(line: string): string | null {
 if (!line.startsWith('data:')) return null;
 const raw = line.slice(5).trim(); if (!raw || raw === '[DONE]') return null;
 try {
  const obj = JSON.parse(raw) as { choices?: Array<{ delta?: { reasoning_content?: string } }>; candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> };
  if (obj.choices?.[0]?.delta?.reasoning_content != null) return obj.choices[0].delta.reasoning_content;
  if (obj.candidates?.[0]?.content?.parts) {
   const thought = obj.candidates[0].content.parts.filter(p => p.thought).map(p => p.text ?? '').join('');
   if (thought) return thought;
  }
  return null;
 } catch { return null; }
}

// OpenAI-compatible and Gemini report token usage inline in the stream.
export function parseUsageEvent(line: string): { promptTokens: number; completionTokens: number } | null {
 if (!line.startsWith('data:')) return null;
 const raw = line.slice(5).trim(); if (!raw || raw === '[DONE]') return null;
 try {
  const obj = JSON.parse(raw) as {
   usage?: { prompt_tokens?: number; completion_tokens?: number };
   usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  if (obj.usage && (obj.usage.prompt_tokens || obj.usage.completion_tokens)) return { promptTokens: obj.usage.prompt_tokens ?? 0, completionTokens: obj.usage.completion_tokens ?? 0 };
  if (obj.usageMetadata && (obj.usageMetadata.promptTokenCount || obj.usageMetadata.candidatesTokenCount)) return { promptTokens: obj.usageMetadata.promptTokenCount ?? 0, completionTokens: obj.usageMetadata.candidatesTokenCount ?? 0 };
  return null;
 } catch { return null; }
}

// Anthropic reports usage on message_start / message_delta events instead.
export function parseAnthropicUsage(line: string, accumulated: { promptTokens: number; completionTokens: number } | null): { promptTokens: number; completionTokens: number } | null {
 if (!line.startsWith('data:')) return accumulated;
 const raw = line.slice(5).trim(); if (!raw || raw === '[DONE]') return accumulated;
 try {
  const obj = JSON.parse(raw) as { type?: string; message?: { usage?: { input_tokens?: number; output_tokens?: number } }; usage?: { output_tokens?: number } };
  const next = { ...(accumulated ?? { promptTokens: 0, completionTokens: 0 }) };
  if (obj.type === 'message_start' && obj.message?.usage) { next.promptTokens = obj.message.usage.input_tokens ?? 0; next.completionTokens = obj.message.usage.output_tokens ?? 0; }
  if (obj.type === 'message_delta' && obj.usage?.output_tokens != null) next.completionTokens = obj.usage.output_tokens;
  if (!accumulated && !next.promptTokens && !next.completionTokens) return null;
  return next;
 } catch { return accumulated; }
}

// A response truncated by the token limit looks identical to a finished one unless
// the finish signal is read. `null` means "provider never said" (custom proxies,
// some OpenRouter routes) and must not be presented as a clean stop.
export function parseFinishReason(line: string): FinishReason {
 if (!line.startsWith('data:')) return null;
 const raw = line.slice(5).trim(); if (!raw || raw === '[DONE]') return null;
 try {
  const obj = JSON.parse(raw) as { choices?: Array<{ finish_reason?: string | null }>; candidates?: Array<{ finishReason?: string }> };
  return normalizeFinishReason(obj.choices?.[0]?.finish_reason ?? obj.candidates?.[0]?.finishReason ?? null);
 } catch { return null; }
}

// Anthropic carries stop_reason on the message_delta envelope, not inside `delta`.
export function parseAnthropicFinish(line: string): FinishReason {
 if (!line.startsWith('data:')) return null;
 const raw = line.slice(5).trim(); if (!raw || raw === '[DONE]') return null;
 try {
  const obj = JSON.parse(raw) as { type?: string; delta?: { stop_reason?: string | null } };
  if (obj.type !== 'message_delta') return null;
  return normalizeFinishReason(obj.delta?.stop_reason ?? null);
 } catch { return null; }
}

export function normalizeFinishReason(value: string | null | undefined): FinishReason {
 switch (value) {
  case 'stop': case 'end_turn': case 'stop_sequence': case 'STOP': return 'stop';
  case 'length': case 'max_tokens': case 'MAX_TOKENS': return 'length';
  case 'content_filter': case 'SAFETY': case 'RECITATION': case 'PROHIBITED_CONTENT': return 'content_filter';
  case 'refusal': return 'refusal';
  default: return null;
 }
}

// ---- workspace tool-call streaming -------------------------------------------
// A single SSE line can carry several tool events (OpenAI batches deltas), so the
// parsers return arrays. `call-complete` is for Gemini, which delivers a whole
// functionCall part in one chunk instead of streaming arguments.
export type ToolStreamEvent =
 | { kind: 'call-start'; index: number; id: string; name: string }
 | { kind: 'call-args'; index: number; chunk: string }
 | { kind: 'call-complete'; id: string; name: string; args: string }
 | { kind: 'tool-stop' };

const toolJson = (line: string): Record<string, unknown> | null => {
 if (!line.startsWith('data:')) return null;
 const raw = line.slice(5).trim(); if (!raw || raw === '[DONE]') return null;
 try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
};

// OpenAI-compatible: delta.tool_calls entries are index-keyed fragments — the id and
// name arrive once (usually the first fragment), arguments stream as chunks. A
// finish_reason of 'tool_calls' signals the model wants the results back.
export function parseToolCallDelta(line: string): ToolStreamEvent[] {
 const obj = toolJson(line); if (!obj) return [];
 const choice = (obj.choices as Array<{ delta?: { tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }> | undefined)?.[0];
 const out: ToolStreamEvent[] = [];
 for (const tc of choice?.delta?.tool_calls ?? []) {
  const index = typeof tc.index === 'number' ? tc.index : 0;
  if (tc.id || tc.function?.name) out.push({ kind: 'call-start', index, id: tc.id ?? 'call_' + index, name: tc.function?.name ?? '' });
  if (tc.function?.arguments) out.push({ kind: 'call-args', index, chunk: tc.function.arguments });
 }
 if (choice?.finish_reason === 'tool_calls') out.push({ kind: 'tool-stop' });
 return out;
}

// Anthropic: tool_use is its own content block. content_block_start carries id+name,
// input_json_delta streams the arguments as partial JSON text, and the turn ends
// with stop_reason 'tool_use' on message_delta.
export function parseAnthropicToolEvent(line: string): ToolStreamEvent[] {
 const obj = toolJson(line); if (!obj) return [];
 const type = obj.type as string | undefined;
 if (type === 'content_block_start') {
  const block = obj.content_block as { type?: string; id?: string; name?: string } | undefined;
  if (block?.type === 'tool_use') return [{ kind: 'call-start', index: typeof obj.index === 'number' ? obj.index : 0, id: block.id ?? '', name: block.name ?? '' }];
 }
 if (type === 'content_block_delta') {
  const delta = obj.delta as { type?: string; partial_json?: string } | undefined;
  if (delta?.type === 'input_json_delta' && delta.partial_json) return [{ kind: 'call-args', index: typeof obj.index === 'number' ? obj.index : 0, chunk: delta.partial_json }];
 }
 if (type === 'message_delta') {
  const delta = obj.delta as { stop_reason?: string | null } | undefined;
  if (delta?.stop_reason === 'tool_use') return [{ kind: 'tool-stop' }];
 }
 return [];
}

// Gemini: functionCall arrives as a complete part (args is an object, not text), so
// each one becomes a whole call. No tool-stop needed — a call part IS the signal.
export function parseGeminiToolCall(line: string, seq: number): ToolStreamEvent[] {
 const obj = toolJson(line); if (!obj) return [];
 const parts = (obj.candidates as Array<{ content?: { parts?: Array<{ functionCall?: { name?: string; args?: unknown } }> } }> | undefined)?.[0]?.content?.parts;
 const out: ToolStreamEvent[] = [];
 for (const part of parts ?? []) {
  if (!part.functionCall?.name) continue;
  out.push({ kind: 'call-complete', id: 'gemini-call-' + (seq + out.length), name: part.functionCall.name, args: JSON.stringify(part.functionCall.args ?? {}) });
 }
 return out;
}

// Provider base URLs come from settings; an attacker-controlled value must not be
// able to exfiltrate the API key over cleartext or via credentials in the URL.
export function validateProviderUrl(value: string): string {
 let parsed: URL; try { parsed = new URL(value); } catch { throw new Error('Enter a valid provider URL'); }
 // Loopback is allowed over http:// (no key crosses a network) but must still be a
 // real http(s) URL; everything else requires HTTPS.
 if (isLoopbackUrl(value)) {
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Local provider URL must use HTTP or HTTPS');
 } else if (parsed.protocol !== 'https:') {
  throw new Error('Provider URL must use HTTPS');
 }
 if (parsed.username || parsed.password) throw new Error('Credentials must not be embedded in the URL');
 return parsed.toString().replace(/\/$/, '');
}

// Only web-safe protocols may leave the app. The renderer can ask main to open a
// URL, and an unfiltered shell.openExternal would run any registered Windows
// handler (search-ms:, ms-msdt:, ...) on a single click.
export function isSafeExternalUrl(value: string): boolean {
 let parsed: URL; try { parsed = new URL(value); } catch { return false; }
 return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:';
}

// OpenRouter and other gateways prefix vendor model IDs ("openai/o3-mini"), so the
// reasoning check has to look at the segment after the last slash. Reasoning models
// reject temperature/top_p outright and want max_completion_tokens.
export function isOpenAiReasoningModel(model: string): boolean {
 const bare = (model.split('/').pop() ?? model).trim().toLowerCase();
 return /^(o[134]|gpt-5)([.-]|$)/.test(bare);
}
// Gemini 2.5+ spends part of maxOutputTokens on thinking, so the user's budget has
// to be raised rather than trusted: at 2048 the model can end on MAX_TOKENS having
// emitted no visible text at all.
export function isGeminiThinkingModel(model: string): boolean { return /gemini-(2\.5|3)/.test(model); }
export const GEMINI_THINKING_BUDGET = 8192;

// Generous ceiling: OpenRouter alone lists several hundred models, so the old limit
// of 200 made "Refresh models" fail outright for it. Still a hard error rather than
// a silent truncation — a dropped model would be invisible to the user.
export const MAX_MODELS_PER_PROVIDER = 1000;
// A single message body cap. Drag-and-drop reads whole files into one string; without
// this a large .log OOMs the sandboxed renderer and then makes every debounced
// re-export of the in-memory DB in main heavier. Generous: ~200k words.
export const MAX_MESSAGE_CHARS = 1_000_000;
// Gemini's ListModels returns ids already prefixed with "models/" (e.g.
// "models/gemini-2.5-flash"), but the generate URL adds that segment itself, so an
// unstripped id 404s as models/models/gemini-2.5-flash.
export function stripGeminiModelPrefix(model: string): string {
 return model.replace(/^models\//, '');
}
export function normalizeModelIds(values: string[], max = MAX_MODELS_PER_PROVIDER): string[] {
 const normalized = Array.from(new Set(values.map(value => value.trim()).filter(Boolean)));
 if (normalized.length > max) throw new Error(`A provider can have at most ${max} models`);
 // eslint-disable-next-line no-control-regex -- rejecting control characters is the whole point of this check
 if (normalized.some(value => value.length > 200 || /[\u0000-\u001f]/.test(value))) throw new Error('Model IDs must be under 200 characters and contain no control characters');
 return normalized;
}
export function mergeModelIds(current: string[], incoming: string[]): string[] { return normalizeModelIds([...current, ...incoming]); }

// The renderer runs web content and is treated as untrusted input: every IPC
// argument is validated here instead of being believed. Clamping beats throwing so
// a stale or odd value degrades instead of breaking the send/stop flow.
const KNOWN_PROVIDER_IDS: ProviderId[] = ['openai','anthropic','gemini','openrouter','groq','deepseek','mistral','ollama','lmstudio','custom'];
export function isKnownProviderId(value: unknown): value is ProviderId {
 return typeof value === 'string' && (KNOWN_PROVIDER_IDS as string[]).includes(value);
}

export function validateProviderConfig(input: unknown, pinnedUrls: Map<ProviderId, string>): ProviderConfig {
 if (!input || typeof input !== 'object') throw new Error('Invalid provider configuration');
 const c = input as Partial<ProviderConfig>;
 if (!isKnownProviderId(c.id)) throw new Error('Unknown provider');
 const name = typeof c.name === 'string' ? c.name.trim().slice(0, 60) : '';
 if (!name) throw new Error('Provider name is required');
 const models = normalizeModelIds(Array.isArray(c.models) ? c.models.filter((m): m is string => typeof m === 'string') : []);
 // Built-in providers keep their official endpoint. Allowing the renderer to swap
 // baseUrl for id='openai' would send the real decrypted key to an attacker's host
 // on the next message, so only the pinned URL is accepted for them.
 const pinned = pinnedUrls.get(c.id);
 let baseUrl: string;
 if (pinned !== undefined) {
  baseUrl = validateProviderUrl(typeof c.baseUrl === 'string' && c.baseUrl ? c.baseUrl : pinned);
  if (baseUrl !== pinned) throw new Error('The base URL of a built-in provider cannot be changed; add a custom provider instead');
 } else {
  baseUrl = validateProviderUrl(typeof c.baseUrl === 'string' ? c.baseUrl : '');
 }
 const pricing = validatePricing(c.pricing);
 return { id: c.id, name, baseUrl, models, ...(pricing ? { pricing } : {}) };
}

// Every field of a chat request crosses an IPC boundary, so each is type-checked
// rather than assumed. Numbers are coerced through clamp() instead of rejected: a
// NaN temperature would otherwise reach the provider body and cause a 400.
export function validateChatRequest(input: unknown): ChatRequest {
 if (!input || typeof input !== 'object') throw new Error('Invalid request');
 const r = input as Record<string, unknown>;
 const shortId = (v: unknown, label: string): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > 200) throw new Error('Invalid ' + label);
  return v;
 };
 const requestId = shortId(r.requestId, 'request id');
 const chatId = shortId(r.chatId, 'chat id');
 const model = shortId(r.model, 'model');
 if (!isKnownProviderId(r.providerId)) throw new Error('Unknown provider');
 const providerId: ProviderId = r.providerId;
 if (typeof r.content !== 'string') throw new Error('Message is empty');
 // Bound the body: an unbounded paste/drop could OOM the renderer and then make every
 // debounced re-export of the whole DB in main progressively heavier.
 if (r.content.length > MAX_MESSAGE_CHARS) throw new Error(`Message is too long (max ${MAX_MESSAGE_CHARS.toLocaleString()} characters)`);
 const opt = (v: unknown): string | undefined => (typeof v === 'string' && v.length <= 200 ? v : undefined);
 const out: ChatRequest = { requestId, chatId, providerId, model, content: r.content };
 if (typeof r.systemPrompt === 'string') out.systemPrompt = r.systemPrompt.slice(0, 32768);
 if ('temperature' in r) out.temperature = clamp(r.temperature, 0, 2, 0.7);
 if ('maxTokens' in r) out.maxTokens = Math.round(clamp(r.maxTokens, 128, 32000, 2048));
 if ('topP' in r) out.topP = clamp(r.topP, 0, 1, 1);
 if (r.skipUserPersist === true) out.skipUserPersist = true;
 const cont = opt(r.continueMessageId); if (cont) out.continueMessageId = cont;
 const regen = opt(r.regenerateMessageId); if (regen) out.regenerateMessageId = regen;
 const trunc = opt(r.truncateFromMessageId); if (trunc) out.truncateFromMessageId = trunc;
 if (r.attachments !== undefined) out.attachments = validateAttachments(r.attachments);
 return out;
}

// Vision input arrives as base64 over IPC. Every field is attacker-controlled
// (the renderer is untrusted), so mime, count and decoded size are all enforced here.
function validateAttachments(input: unknown): NewAttachment[] {
 if (!Array.isArray(input)) throw new Error('Invalid attachments');
 if (input.length > MAX_IMAGE_ATTACHMENTS) throw new Error(`At most ${MAX_IMAGE_ATTACHMENTS} images per message`);
 const out: NewAttachment[] = [];
 for (const a of input) {
  if (!a || typeof a !== 'object') throw new Error('Invalid attachment');
  const att = a as Record<string, unknown>;
  const name = typeof att.name === 'string' ? att.name.trim().slice(0, 200) : '';
  const mime = typeof att.mime === 'string' ? att.mime : '';
  const data = typeof att.data === 'string' ? att.data : '';
  if (!name) throw new Error('Attachment needs a file name');
  if (!(IMAGE_MIMES as readonly string[]).includes(mime)) throw new Error('Unsupported image type (use PNG, JPEG, WebP or GIF)');
  // data.length * 3/4 approximates the decoded byte size without decoding it twice.
  if (!data || data.length * 3 / 4 > MAX_ATTACHMENT_BYTES) throw new Error(`Image "${name}" is too large (max ${MAX_ATTACHMENT_BYTES / 1048576} MB)`);
  out.push({ name, mime, data });
 }
 return out;
}

const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
 const n = typeof value === 'number' ? value : Number(value);
 return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

// Settings reach the request body, so a NaN or a megabyte-long prompt must not be
// stored verbatim. Unknown keys are dropped by the caller's allow-list.
export function clampSettings(input: Record<string, unknown>): Record<string, unknown> {
 const out: Record<string, unknown> = {};
 if ('theme' in input) out.theme = input.theme === 'light' ? 'light' : 'dark';
 if ('systemPrompt' in input) out.systemPrompt = typeof input.systemPrompt === 'string' ? input.systemPrompt.slice(0, 32768) : '';
 if ('temperature' in input) out.temperature = clamp(input.temperature, 0, 2, 0.7);
 if ('maxTokens' in input) out.maxTokens = Math.round(clamp(input.maxTokens, 128, 32000, 2048));
 if ('topP' in input) out.topP = clamp(input.topP, 0, 1, 1);
 if ('minimizeToTray' in input) out.minimizeToTray = input.minimizeToTray === true;
 if ('autoStart' in input) out.autoStart = input.autoStart === true;
 if ('notifications' in input) out.notifications = input.notifications === true;
 if ('accent' in input) out.accent = (ACCENTS as readonly string[]).includes(input.accent as string) ? input.accent : 'violet';
 if ('personaId' in input) out.personaId = typeof input.personaId === 'string' && input.personaId.length <= 100 ? input.personaId : '';
 if ('personas' in input) {
  const personas = validatePersonas(input.personas);
  if (personas) out.personas = personas;
 }
 if ('hotkeys' in input) {
  const h = normalizeHotkeys(input.hotkeys);
  if (h) out.hotkeys = h;
 }
 return out;
}

const HOTKEY_ACTIONS = ['newChat', 'openSettings', 'toggleSidebar'] as const;

// Personas live in the settings blob, so every field is renderer-controlled and
// must be re-validated here. Invalid entries are dropped, not fatal.
export function validatePersonas(input: unknown): Persona[] | undefined {
 if (!Array.isArray(input)) return undefined;
 const out: Persona[] = [];
 for (const p of input.slice(0, MAX_PERSONAS)) {
  if (!p || typeof p !== 'object') continue;
  const src = p as Record<string, unknown>;
  const id = typeof src.id === 'string' && src.id && src.id.length <= 100 ? src.id : '';
  const name = typeof src.name === 'string' ? src.name.trim().slice(0, 60) : '';
  const prompt = typeof src.prompt === 'string' ? src.prompt.slice(0, 32768) : '';
  if (!id || !name || !prompt.trim()) continue;
  const persona: Persona = { id, name, prompt, color: (PERSONA_COLORS as readonly string[]).includes(src.color as string) ? src.color as string : PERSONA_COLORS[0] };
  if (typeof src.temperature === 'number') persona.temperature = clamp(src.temperature, 0, 2, 0.7);
  if (isKnownProviderId(src.providerId)) persona.providerId = src.providerId;
  if (typeof src.model === 'string' && src.model.trim() && src.model.length <= 200) persona.model = src.model.trim();
  out.push(persona);
 }
 return out;
}

// Prompt for the auto-title side request, and the cleanup applied to whatever the
// model answers with (quotes, trailing dots, multi-line rambling).
export const TITLE_PROMPT = 'Write a short conversation title (3-6 words, no quotes, no punctuation at the end) for this exchange. Reply with the title only.';
export function cleanTitle(raw: unknown): string {
 if (typeof raw !== 'string') return '';
 const line = raw.split('\n')[0].trim().replace(/^["'«»“”*#\s]+|[."'«»“”\s]+$/g, '');
 return line.length >= 2 && line.length <= 80 ? line : '';
}

// Prompt for the "enhance draft" side request (Kilo Code's Enhance Prompt): the
// model rewrites the user's rough draft into a clearer, more effective prompt. The
// original stays in place until the rewritten text is explicitly accepted.
export const ENHANCE_PROMPT = 'Rewrite the following draft into a clear, effective prompt for an AI assistant: keep the user\'s intent and language, add structure and missing specifics, remove filler. Reply with the improved prompt only — no preamble, no quotes, no markdown fences.';
// The enhanced text is still model output: it must be non-empty and bounded, and
// surrounding quotes/fences are stripped so the composer gets plain text.
export function cleanEnhanced(raw: unknown, original: string): string {
 if (typeof raw !== 'string') return '';
 let out = raw.trim().replace(/^```[a-z]*\s*|\s*```$/g, '').trim();
 const pairs: Array<[string, string]> = [['"', '"'], ['«', '»'], ['“', '”']];
 for (const [a, b] of pairs) if (out.length >= 2 && out.startsWith(a) && out.endsWith(b)) { out = out.slice(1, -1).trim(); break; }
 return out && out !== original.trim() && out.length <= 32768 ? out : '';
}

// Reference prices in USD per 1M tokens for the built-in model lists. Seeded once
// into each provider's `pricing` map (existing keys win — the user's numbers are
// never overwritten). Local/custom providers have no reference price: they stay
// empty and simply never show a $ estimate.
export const DEFAULT_PRICING: Record<string, PricingMap> = {
 openai: { 'gpt-4o': { input: 2.5, output: 10 }, 'gpt-4o-mini': { input: 0.15, output: 0.6 }, 'o3-mini': { input: 1.1, output: 4.4 } },
 anthropic: { 'claude-sonnet-4-20250514': { input: 3, output: 15 }, 'claude-3-5-haiku-20241022': { input: 0.8, output: 4 } },
 gemini: { 'gemini-2.0-flash': { input: 0.1, output: 0.4 }, 'gemini-2.5-pro-preview-03-25': { input: 1.25, output: 10 } },
 openrouter: { 'anthropic/claude-sonnet-4': { input: 3, output: 15 }, 'openai/gpt-4o-mini': { input: 0.15, output: 0.6 } },
 groq: { 'llama-3.3-70b-versatile': { input: 0.59, output: 0.79 }, 'deepseek-r1-distill-llama-70b': { input: 0.75, output: 0.99 } },
 deepseek: { 'deepseek-chat': { input: 0.27, output: 1.1 }, 'deepseek-reasoner': { input: 0.55, output: 2.19 } },
 mistral: { 'mistral-large-latest': { input: 2, output: 6 }, 'mistral-small-latest': { input: 0.1, output: 0.3 } },
};

// A pricing map is renderer-controlled JSON: keep only well-formed entries so a
// tampered map cannot poison the cost display (NaN, negatives, huge objects).
export function validatePricing(input: unknown): PricingMap | undefined {
 if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
 const out: PricingMap = {};
 for (const [model, price] of Object.entries(input as Record<string, unknown>).slice(0, 200)) {
  if (!model || model.length > 200 || !price || typeof price !== 'object') continue;
  const p = price as Partial<ModelPrice>;
  if (typeof p.input !== 'number' || typeof p.output !== 'number') continue;
  if (!Number.isFinite(p.input) || !Number.isFinite(p.output) || p.input < 0 || p.output < 0 || p.input > 1e6 || p.output > 1e6) continue;
  out[model] = { input: p.input, output: p.output };
 }
 return out;
}// A combo is "Ctrl+Shift+K"-style: modifiers first, one non-modifier key last.
// Requiring Ctrl or Alt keeps a bare letter from swallowing normal typing.
export function isValidHotkey(value: unknown): value is string {
 if (typeof value !== 'string' || value.length > 30) return false;
 const parts = value.split('+');
 if (parts.length < 2) return false;
 const key = parts[parts.length - 1];
 if (!/^(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|[,./;\]'[\]\\`=-])$/.test(key)) return false;
 const mods = parts.slice(0, -1);
 if (!mods.every(m => m === 'Ctrl' || m === 'Alt' || m === 'Shift')) return false;
 return mods.includes('Ctrl') || mods.includes('Alt');
}
// Unknown/invalid entries fall back to defaults rather than breaking every shortcut.
export function normalizeHotkeys(input: unknown): HotkeyMap {
 const out = { ...DEFAULT_HOTKEYS };
 if (!input || typeof input !== 'object') return out;
 const src = input as Record<string, unknown>;
 for (const a of HOTKEY_ACTIONS) if (isValidHotkey(src[a])) out[a] = src[a] as string;
 return out;
}

// Per-provider request construction. Keeping this out of main.ts makes the
// streaming path testable and keeps provider quirks in one place.
export function authHeaders(p: ResolvedProvider): Record<string,string> {
 // A keyless loopback server must not receive an empty Authorization header.
 if (!p.key) return {};
 if (p.id === 'gemini') return { 'x-goog-api-key': p.key };
 if (p.id === 'anthropic') return { 'x-api-key': p.key, 'anthropic-version': '2023-06-01' };
 return { Authorization: 'Bearer ' + p.key };
}

export function buildModelsRequest(p: ResolvedProvider): { url: string; headers: Record<string,string> } {
 // Ollama and LM Studio both expose an OpenAI-compatible /v1 endpoint, so the local
 // presets reuse this path instead of their native NDJSON APIs (which the SSE
 // parsers below cannot read). API key goes in a header, never in the URL.
 return { url: p.url + '/models', headers: authHeaders(p) };
}

export function buildChatRequest(p: ResolvedProvider, history: HistoryMessage[], params: RequestParams): ProviderRequest {
 // Tool call arguments arrive as a JSON string; providers want parsed objects.
 const safeJson = (s: string): unknown => { try { return JSON.parse(s); } catch { return {}; } };
 if (p.id === 'anthropic') {
  // Anthropic's documented temperature range is 0.0–1.0, but the shared slider and
  // clamp allow 0–2 (the OpenAI range). Forwarding 1.5 verbatim is a guaranteed
  // 400 ("temperature: must be <= 1"), so narrow it here rather than reject the send.
  const temperature = Math.min(1, Math.max(0, params.temperature ?? 0.7));
  return {
   url: p.url + '/messages',
   headers: { ...authHeaders(p), 'content-type': 'application/json' },
   body: {
    model: params.model,
    max_tokens: params.maxTokens ?? 2048,
    temperature,
    top_p: params.topP ?? 1,
    system: params.systemPrompt,
    ...(params.tools?.length ? { tools: params.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.schema })) } : {}),
    // Anthropic vision: image blocks precede the text block. Plain-text turns keep
    // the string form so non-vision payloads stay byte-identical to before.
    messages: history.flatMap((m): unknown[] => {
     if (m.toolResults) return [{ role: 'user', content: m.toolResults.map(r => ({ type: 'tool_result', tool_use_id: r.toolCallId, content: r.content.slice(0, 100000) })) }];
     if (m.toolCalls) return [{ role: 'assistant', content: [...(m.content ? [{ type: 'text', text: m.content }] : []), ...m.toolCalls.map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: safeJson(c.args) }))] }];
     return [{
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.images?.length
       ? [...m.images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } })), { type: 'text', text: m.content || 'Attached image(s)' }]
       : m.content,
     }];
    }),
    stream: true,
   },
  };
 }
 if (p.id === 'gemini') {
  // "Refresh models" stores ids as Gemini returns them ("models/gemini-2.5-flash");
  // the generate URL prepends /models/ itself, so an unstripped id 404s as
  // models/models/gemini-2.5-flash. Presets store bare ids, which pass through.
  const model = stripGeminiModelPrefix(params.model);
  const thinking = isGeminiThinkingModel(model);
  const requested = params.maxTokens ?? 2048;
  // Thinking budget is deducted from maxOutputTokens, so floor the visible budget.
  const maxOutputTokens = thinking ? Math.max(requested, GEMINI_THINKING_BUDGET + requested) : requested;
  return {
   url: p.url + '/models/' + encodeURIComponent(model) + ':streamGenerateContent?alt=sse',
   headers: { ...authHeaders(p), 'content-type': 'application/json' },
   body: {
    systemInstruction: params.systemPrompt ? { parts: [{ text: params.systemPrompt }] } : undefined,
    ...(params.tools?.length ? { tools: [{ functionDeclarations: params.tools.map(t => ({ name: t.name, description: t.description, parameters: t.schema })) }] } : {}),
    // Gemini vision: inlineData parts before the text part.
    contents: history.flatMap((m): unknown[] => {
     if (m.toolResults) return [{ role: 'user', parts: m.toolResults.map(r => ({ functionResponse: { name: r.name, response: { result: r.content.slice(0, 100000) } } })) }];
     if (m.toolCalls) {
      const parts: unknown[] = [];
      if (m.content) parts.push({ text: m.content });
      parts.push(...m.toolCalls.map(c => ({ functionCall: { name: c.name, args: safeJson(c.args) } })));
      return [{ role: 'model', parts }];
     }
     return [{
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: m.images?.length
       ? [...m.images.map(i => ({ inlineData: { mimeType: i.mime, data: i.data } })), { text: m.content || 'Attached image(s)' }]
       : [{ text: m.content }],
     }];
    }),
    generationConfig: {
     temperature: params.temperature ?? 0.7,
     topP: params.topP ?? 1,
     maxOutputTokens,
     ...(thinking ? { thinkingConfig: { thinkingBudget: GEMINI_THINKING_BUDGET } } : {}),
    },
   },
  };
 }
 const reasoning = isOpenAiReasoningModel(params.model);
 return {
  url: p.url + '/chat/completions',
  headers: { ...authHeaders(p), 'content-type': 'application/json' },
  body: {
   model: params.model,
   messages: [...(params.systemPrompt ? [{ role: 'system', content: params.systemPrompt }] : []),
    // OpenAI-compatible vision: content becomes a parts array with image_url data URLs.
    ...history.flatMap((m): unknown[] => {
     if (m.toolResults) return m.toolResults.map(r => ({ role: 'tool', tool_call_id: r.toolCallId, content: r.content.slice(0, 100000) }));
     if (m.toolCalls) return [{ role: 'assistant', content: m.content || null, tool_calls: m.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })) }];
     return [m.images?.length
      ? { role: m.role, content: [{ type: 'text', text: m.content || 'Attached image(s)' }, ...m.images.map(i => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data}` } }))] }
      : { role: m.role, content: m.content }];
    })],
   ...(params.tools?.length ? { tools: params.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })) } : {}),
   // o-series / gpt-5 reject temperature and top_p with HTTP 400 and want
   // max_completion_tokens instead of max_tokens.
   ...(reasoning ? {} : { temperature: params.temperature ?? 0.7, top_p: params.topP ?? 1 }),
   ...(reasoning ? { max_completion_tokens: params.maxTokens ?? 2048 } : { max_tokens: params.maxTokens ?? 2048 }),
   stream: true,
   // Without this OpenAI-compatible servers never send the final usage chunk, so
   // token accounting was silently null for this whole family of providers.
   stream_options: { include_usage: true },
  },
 };
}
