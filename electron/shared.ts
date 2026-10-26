export type ProviderId = 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'groq' | 'deepseek' | 'mistral' | 'ollama' | 'lmstudio' | 'custom';
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
export interface Chat { id: string; title: string; providerId: ProviderId; model: string; updatedAt: number; branchedFrom?: string | null; }
export interface Message { id: string; chatId: string; role: 'user' | 'assistant'; content: string; createdAt: number; model?: string | null; providerId?: ProviderId | null; promptTokens?: number | null; completionTokens?: number | null; reasoning?: string | null; finishReason?: FinishReason; variantCount?: number; attachments?: AttachmentMeta[]; }
// A superseded assistant answer, kept so Regenerate is not destructive.
export interface MessageVariant { id: string; messageId: string; content: string; reasoning: string | null; createdAt: number; promptTokens: number | null; completionTokens: number | null; }
// `skipUserPersist` lets Regenerate re-send a prompt that is already stored;
// `continueMessageId` asks the provider to carry on from a truncated answer;
// `regenerateMessageId` names the assistant turn to replace (kept as a variant);
// `truncateFromMessageId` deletes that message and everything after it as part of
// THIS request, so an edit-and-resend can never delete the tail and then fail.
export interface ChatRequest { requestId: string; chatId: string; providerId: ProviderId; model: string; content: string; systemPrompt?: string; temperature?: number; maxTokens?: number; topP?: number; skipUserPersist?: boolean; continueMessageId?: string; regenerateMessageId?: string; truncateFromMessageId?: string; attachments?: NewAttachment[]; }
export interface ChatChunk { requestId: string; chatId: string; text: string; reasoning?: string; done?: boolean; stopped?: boolean; error?: string; promptTokens?: number; completionTokens?: number; finishReason?: FinishReason; }
export interface ActiveStream { chatId: string; requestId: string }
export interface UsageRow { providerId: string | null; model: string | null; messages: number; promptTokens: number; completionTokens: number }
export interface UsageSummary { messages: number; promptTokens: number; completionTokens: number; byModel: UsageRow[] }
export interface DataHealth { ok: boolean; persistError: string | null; }
// Rebindable global shortcuts, stored as "Ctrl+Shift+K"-style combos.
export interface HotkeyMap { newChat: string; openSettings: string; toggleSidebar: string }
export const DEFAULT_HOTKEYS: HotkeyMap = { newChat: 'Ctrl+K', openSettings: 'Ctrl+,', toggleSidebar: 'Ctrl+B' };
// A named preset ("agent" in opencode terms): prompt + optional sampling/model
// overrides, applied on top of the global settings when selected in the composer.
export interface Persona { id: string; name: string; prompt: string; color: string; temperature?: number; providerId?: ProviderId; model?: string; }
export const PERSONA_COLORS = ['#b59af4', '#7aa2f7', '#74b89a', '#e0a35e', '#e78a91', '#d4b86a'] as const;
export const MAX_PERSONAS = 20;
// Accent palettes the shell theme supports; validated against this allow-list.
export const ACCENTS = ['violet', 'blue', 'green', 'amber', 'rose'] as const;
export type Accent = (typeof ACCENTS)[number];
export interface SettingsData { theme: 'dark' | 'light'; systemPrompt: string; temperature: number; maxTokens: number; topP: number; minimizeToTray: boolean; autoStart: boolean; notifications: boolean; accent: Accent; personas: Persona[]; personaId: string; hotkeys: HotkeyMap; }
export interface DesktopAPI {
 window: { minimize():void; toggleMaximize():void; close():void };
 app: { version():Promise<string> };
 chats: { list():Promise<Chat[]>; create():Promise<Chat>; rename(id:string,title:string):Promise<void>; delete(id:string):Promise<void>; messages(id:string):Promise<Message[]>; deleteMessage(id:string,chatId:string):Promise<void>; variants(messageId:string):Promise<MessageVariant[]>; restoreVariant(variantId:string):Promise<Message[]>; branch(id:string,messageId:string):Promise<Chat>; usageSummary():Promise<UsageSummary>; export(id:string,format:'md'|'json'):Promise<string|null>; search(query:string):Promise<Array<{chatId:string;title:string;snippet:string}>>; onRenamed(callback:(chat:{id:string;title:string})=>void):()=>void };
 providers: { list():Promise<ProviderConfig[]>; save(config:ProviderConfig,key?:string):Promise<void>; remove(id:ProviderId):Promise<void>; models(id:ProviderId):Promise<string[]>; test(id:ProviderId):Promise<{ok:boolean;message:string}> };
 chat: { send(request:ChatRequest):Promise<void>; continueMessage(request:ChatRequest):Promise<void>; regenerate(request:ChatRequest):Promise<void>; stop(requestId?:string):Promise<{stopped:boolean}>; status():Promise<ActiveStream[]>; onChunk(callback:(data:ChatChunk)=>void):()=>void };
 prompt: { enhance(draft:string,providerId:ProviderId,model:string):Promise<string> };
 data: { health():Promise<DataHealth>; wipe():Promise<void>; openFolder():Promise<void> };
 settings: { get():Promise<SettingsData>; save(settings:Record<string,unknown>):Promise<void> };
}
