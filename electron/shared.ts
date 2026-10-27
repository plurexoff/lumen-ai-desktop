// Built-in providers are a closed set; custom endpoints get generated ids like
// "custom-a1b2c3d4". The legacy single 'custom' id from early versions stays valid.
export type BuiltinProviderId = 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'groq' | 'deepseek' | 'mistral' | 'ollama' | 'lmstudio';
export type ProviderId = BuiltinProviderId | 'custom' | `custom-${string}`;
export function isCustomProviderId(id: string): boolean { return id === 'custom' || id.startsWith('custom-'); }
// Why a generation ended. `null` means the provider never told us (custom proxies,
// some OpenRouter routes) — it must NOT be read as a clean stop.
export type FinishReason = 'stop' | 'length' | 'content_filter' | 'refusal' | null;
// USD per 1M tokens, so a message cost is tokens/1e6 * price.
export interface ModelPrice { input: number; output: number }
export type PricingMap = Record<string, ModelPrice>;
export interface ProviderConfig { id: ProviderId; name: string; baseUrl: string; models: string[]; pricing?: PricingMap; hasKey?: boolean; }
// Attachment metadata. `preview` exists only on the renderer's optimistic bubble
// (a data: URL) — persisted attachments are served via lumen-attachment://<id>.
export interface AttachmentMeta { id: string; name: string; mime: string; size: number; preview?: string }
// What the renderer hands to main on send; `data` is base64.
export interface NewAttachment { name: string; mime: string; data: string }
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const MAX_IMAGE_ATTACHMENTS = 4;
// Base64 inflates by ~4/3; the cap applies to DECODED bytes.
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export interface Chat { id: string; title: string; providerId: ProviderId; model: string; updatedAt: number; branchedFrom?: string | null; pinned?: number; folderId?: string | null; workspace?: string | null; archived?: number; workspaceReadonly?: number; tags?: string[]; }
// A user-created grouping for the sidebar. Chats reference it via folder_id;
// deleting a folder never deletes its chats (they become ungrouped).
export interface Folder { id: string; name: string; createdAt: number }
// Per-chat checklist maintained by the model via todo_write; mirrored to a panel.
export interface TodoItem { text: string; done: boolean }
// One entry of the workspace operation log (what the model did to files).
export interface FileOp { id: string; chatId: string; tool: string; path: string | null; status: 'ok' | 'error' | 'declined'; detail: string | null; snapshot: string | null; createdAt: number }
// Filters for the global search (all optional, combined with AND).
export interface SearchFilters { query?: string; from?: number; to?: number; model?: string; role?: 'user' | 'assistant'; folderId?: string | null; tag?: string }
export interface SearchResult { chatId: string; messageId: string; title: string; snippet: string; role: string; model: string | null; createdAt: number }
// Token/cost usage per calendar day (Settings → Statistics).
export interface DayUsage { day: string; promptTokens: number; completionTokens: number; cost: number }
// A reusable prompt template; {{input}} is replaced by the current draft.
export interface PromptTemplate { id: string; name: string; text: string }
export const MAX_TEMPLATES = 50;
// A document attached to a chat for retrieval (RAG-lite): text extracted at attach
// time, keyword-ranked chunks injected into the system prompt on send.
export interface ChatDoc { id: string; chatId: string; name: string; chars: number; createdAt: number }
export const MAX_DOC_CHARS = 200_000;
export const MAX_DOCS_PER_CHAT = 8;
// An external MCP (Model Context Protocol) server, spawned over stdio.
export interface McpServer { id: string; name: string; command: string }
export const MAX_MCP_SERVERS = 5;
// One answer in compare mode.
export interface CompareAnswer { providerId: ProviderId; model: string; text: string; error?: string; promptTokens?: number; completionTokens?: number }
// A structured tool event for the feed cards (name + short hint + outcome).
export interface ToolEvent { name: string; hint: string; status: 'running' | 'ok' | 'error' | 'declined'; bytes?: number }
export interface Message { id: string; chatId: string; role: 'user' | 'assistant'; content: string; createdAt: number; model?: string | null; providerId?: ProviderId | null; promptTokens?: number | null; completionTokens?: number | null; reasoning?: string | null; finishReason?: FinishReason; variantCount?: number; attachments?: AttachmentMeta[]; bookmarked?: number; rating?: number; }
// A superseded assistant answer, kept so Regenerate is not destructive.
export interface MessageVariant { id: string; messageId: string; content: string; reasoning: string | null; createdAt: number; promptTokens: number | null; completionTokens: number | null; }
// `skipUserPersist` lets Regenerate re-send a prompt that is already stored;
// `continueMessageId` asks the provider to carry on from a truncated answer;
// `regenerateMessageId` names the assistant turn to replace (kept as a variant);
// `truncateFromMessageId` deletes that message and everything after it as part of
// THIS request, so an edit-and-resend can never delete the tail and then fail.
export interface ChatRequest { requestId: string; chatId: string; providerId: ProviderId; model: string; content: string; systemPrompt?: string; temperature?: number; maxTokens?: number; topP?: number; reasoningEffort?: ReasoningEffort; skipUserPersist?: boolean; continueMessageId?: string; regenerateMessageId?: string; truncateFromMessageId?: string; attachments?: NewAttachment[]; }
export interface ChatChunk { requestId: string; chatId: string; text: string; reasoning?: string; done?: boolean; stopped?: boolean; error?: string; promptTokens?: number; completionTokens?: number; finishReason?: FinishReason; status?: string; }
export interface ActiveStream { chatId: string; requestId: string }
export interface UsageRow { providerId: string | null; model: string | null; messages: number; promptTokens: number; completionTokens: number }
export interface UsageSummary { messages: number; promptTokens: number; completionTokens: number; byModel: UsageRow[] }
export interface DataHealth { ok: boolean; persistError: string | null; }
// Rebindable global shortcuts, stored as "Ctrl+Shift+K"-style combos.
export interface HotkeyMap { newChat: string; openSettings: string; toggleSidebar: string; quickChat: string }
export const DEFAULT_HOTKEYS: HotkeyMap = { newChat: 'Ctrl+K', openSettings: 'Ctrl+,', toggleSidebar: 'Ctrl+B', quickChat: 'Ctrl+Shift+Q' };
// A named preset ("agent" in opencode terms): prompt + optional sampling/model
// overrides, applied on top of the global settings when selected in the composer.
export interface Persona { id: string; name: string; prompt: string; color: string; temperature?: number; providerId?: ProviderId; model?: string; }
export const PERSONA_COLORS = ['#b59af4', '#7aa2f7', '#74b89a', '#e0a35e', '#e78a91', '#d4b86a'] as const;
export const MAX_PERSONAS = 20;
// Accent palettes the shell theme supports; validated against this allow-list.
export const ACCENTS = ['violet', 'blue', 'green', 'amber', 'rose'] as const;
export type Accent = (typeof ACCENTS)[number];
// Whole-palette theme presets (batch 7): 'default' keeps the classic Lumen look.
export const THEME_PRESETS = ['default', 'midnight', 'sepia'] as const;
export type ThemePreset = (typeof THEME_PRESETS)[number];
export const DENSITIES = ['comfortable', 'default', 'compact'] as const;
export type Density = (typeof DENSITIES)[number];
// Reasoning ("thinking") effort. 'off' = provider default behavior (Gemini keeps
// its built-in 8k thinking budget, others send nothing). Levels map per provider:
// OpenAI reasoning_effort, Anthropic thinking.budget_tokens, Gemini thinkingBudget,
// OpenRouter reasoning.effort.
export const REASONING_EFFORTS = ['off', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
// UI language. English is the default; Russian is a full translation.
export const LANGUAGES = ['en', 'ru'] as const;
export type Language = (typeof LANGUAGES)[number];
export interface SettingsData { theme: 'dark' | 'light'; language: Language; systemPrompt: string; temperature: number; maxTokens: number; topP: number; minimizeToTray: boolean; autoStart: boolean; notifications: boolean; accent: Accent; personas: Persona[]; personaId: string; hotkeys: HotkeyMap; templates: PromptTemplate[]; defaultWorkspace: string; customCss: string; compactMode: boolean; mcpServers: McpServer[]; density: Density; themePreset: ThemePreset; reasoningEffort: ReasoningEffort; }
export interface AppProfile { mica: boolean; username: string }
export interface DesktopAPI {
 window: { minimize():void; toggleMaximize():void; close():void; setAlwaysOnTop(on:boolean):void };
 app: { version():Promise<string>; pickFolder(title?:string):Promise<string|null>; profile():Promise<AppProfile> };
 chats: { list():Promise<Chat[]>; create():Promise<Chat>; rename(id:string,title:string):Promise<void>; delete(id:string):Promise<void>; pin(id:string,pinned:boolean):Promise<void>; setFolder(id:string,folderId:string|null):Promise<void>; setArchived(id:string,archived:boolean):Promise<void>; setReadonly(id:string,readonly:boolean):Promise<void>; setTags(id:string,tags:string[]):Promise<void>; pickWorkspace(id:string):Promise<Chat|null>; clearWorkspace(id:string):Promise<void>; messages(id:string):Promise<Message[]>; deleteMessage(id:string,chatId:string):Promise<void>; bookmarkMessage(id:string,bookmarked:boolean):Promise<void>; rateMessage(id:string,rating:number):Promise<void>; variants(messageId:string):Promise<MessageVariant[]>; restoreVariant(variantId:string):Promise<Message[]>; branch(id:string,messageId:string):Promise<Chat>; usageSummary():Promise<UsageSummary>; usageByDay():Promise<DayUsage[]>; summarize(id:string):Promise<string>; compare(chatId:string,otherProviderId:ProviderId,otherModel:string):Promise<CompareAnswer[]>; export(id:string,format:'md'|'json'):Promise<string|null>; exportPrepared(id:string,format:'html'|'pdf',html:string):Promise<string|null>; exportZip(id:string):Promise<string|null>; search(filters:SearchFilters):Promise<SearchResult[]>; readWorkspaceFile(id:string,rel:string):Promise<string|null>; listWorkspaceFiles(id:string,query:string):Promise<string[]>; docs(id:string):Promise<ChatDoc[]>; attachDoc(id:string):Promise<ChatDoc|null>; removeDoc(docId:string):Promise<void>; todos(id:string):Promise<TodoItem[]>; fileOps(id:string):Promise<FileOp[]>; rollbackOp(opId:string):Promise<{ok:boolean;message:string}>; onRenamed(callback:(chat:{id:string;title:string})=>void):()=>void; onTodos(callback:(chat:{chatId:string;todos:TodoItem[]})=>void):()=>void; onFileOp(callback:(op:FileOp)=>void):()=>void };
 folders: { list():Promise<Folder[]>; create(name:string):Promise<Folder>; rename(id:string,name:string):Promise<void>; delete(id:string):Promise<void> };
 providers: { list():Promise<ProviderConfig[]>; create(name:string):Promise<ProviderConfig>; save(config:ProviderConfig,key?:string):Promise<void>; remove(id:ProviderId):Promise<void>; models(id:ProviderId):Promise<string[]>; test(id:ProviderId):Promise<{ok:boolean;message:string}> };
 chat: { send(request:ChatRequest):Promise<void>; continueMessage(request:ChatRequest):Promise<void>; regenerate(request:ChatRequest):Promise<void>; stop(requestId?:string):Promise<{stopped:boolean}>; status():Promise<ActiveStream[]>; onChunk(callback:(data:ChatChunk)=>void):()=>void; onTool(callback:(chatId:string,ev:ToolEvent)=>void):()=>void };
 quick: { ask(text:string):Promise<string>; hide():void; onShown(callback:()=>void):()=>void };
 updates: { check():Promise<string>; install():void };
 prompt: { enhance(draft:string,providerId:ProviderId,model:string):Promise<string> };
 data: { health():Promise<DataHealth>; wipe():Promise<void>; openFolder():Promise<void>; backup():Promise<string|null>; restore():Promise<boolean> };
 settings: { get():Promise<SettingsData>; save(settings:Record<string,unknown>):Promise<void> };
}
