// Android platform layer: a window.lumen-compatible implementation backed by
// sql.js (chats/messages/providers), Capacitor Preferences (API keys) and
// CapacitorHttp (provider calls, non-streaming РІР‚вЂќ the plugin buffers responses,
// so the UI gets one big chunk instead of a token stream on mobile).
// Desktop-only features (workspace tools, MCP, quick window, updater) are stubs.
import { CapacitorHttp } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Preferences } from '@capacitor/preferences';
import type {
 AppProfile, Chat, ChatChunk, ChatDoc, ChatRequest, CompareAnswer, DataHealth, DayUsage, DesktopAPI,
 FileOp, Folder, Message, MessageVariant, ProviderConfig, ProviderId, SearchFilters, SearchResult,
 SettingsData, TodoItem, UsageRow, UsageSummary,
} from '../../electron/shared';
import { DEFAULT_HOTKEYS, isCustomProviderId } from '../../electron/shared';
import {
 buildChatRequest, buildModelsRequest, clampSettings, ENHANCE_PROMPT, cleanEnhanced,
 normalizeModelIds, PROVIDER_DEFAULTS, PINNED_URLS, trimHistory, validateChatRequest, validateProviderConfig,
 type HistoryMessage, type ResolvedProvider,
} from '../../electron/providers';
import { openMobileDb, persistDbSoon, wipeMobileDb, dbPersistError, rows, oneRow } from './mobileDb';
import { apiErrorMessage, parseAnthropicAnswer, parseGeminiAnswer, parseOpenAiAnswer } from './mobileParse';

const id = () => crypto.randomUUID();
const MAX_CUSTOM_PROVIDERS = 20;

const SETTINGS_DEFAULTS: SettingsData = {
 theme: 'dark', language: 'en', systemPrompt: '', temperature: 0.7, maxTokens: 2048, topP: 1,
 minimizeToTray: false, autoStart: false, notifications: false, accent: 'violet',
 personas: [], personaId: '', hotkeys: DEFAULT_HOTKEYS, templates: [], defaultWorkspace: '',
 customCss: '', compactMode: false, mcpServers: [], density: 'default', themePreset: 'default', reasoningEffort: 'off',
};

interface ChatRow { id: string; title: string; provider_id: string; model: string; updated_at: number; pinned: number | null; folder_id: string | null; archived: number | null; tags: string | null }
interface MsgRow { id: string; chat_id: string; role: string; content: string; created_at: number; model: string | null; provider_id: string | null; prompt_tokens: number | null; completion_tokens: number | null; reasoning: string | null; finish_reason: string | null; bookmarked: number | null; rating: number | null }
interface ProvRow { id: string; name: string; base_url: string; models: string; pricing: string | null }

const chatFromRow = (r: ChatRow): Chat => ({
 id: r.id, title: r.title, providerId: r.provider_id as ProviderId, model: r.model, updatedAt: r.updated_at,
 pinned: r.pinned ?? 0, folderId: r.folder_id, archived: r.archived ?? 0,
 tags: r.tags ? (JSON.parse(r.tags) as string[]) : [],
});
const msgFromRow = (r: MsgRow): Message => ({
 id: r.id, chatId: r.chat_id, role: r.role as 'user' | 'assistant', content: r.content, createdAt: r.created_at,
 model: r.model, providerId: (r.provider_id as ProviderId | null) ?? null,
 promptTokens: r.prompt_tokens, completionTokens: r.completion_tokens,
 reasoning: r.reasoning, finishReason: (r.finish_reason as Message['finishReason']) ?? null,
 bookmarked: r.bookmarked ?? 0, rating: r.rating ?? undefined,
});

export function createMobileApi(): DesktopAPI {
 const chunkSubs = new Set<(d: ChatChunk) => void>();
 const renamedSubs = new Set<(c: { id: string; title: string }) => void>();
 const emit = (d: ChatChunk) => { for (const f of chunkSubs) f(d); };
 // in-flight generations, for status()/stop()
 const active = new Map<string, string>(); // chatId -> requestId
 const stopped = new Set<string>(); // requestIds cancelled via stop()

 async function db() { return openMobileDb(); }

 async function seedProviders(): Promise<void> {
  const d = await db();
  const n = oneRow<{ n: number }>(d, 'SELECT COUNT(*) AS n FROM providers')?.n ?? 0;
  if (n === 0) for (const p of PROVIDER_DEFAULTS) {
   d.run('INSERT OR IGNORE INTO providers(id,name,base_url,models) VALUES(?,?,?,?)', [p.id, p.name, p.baseUrl, JSON.stringify(p.models)]);
  }
  persistDbSoon();
 }

 async function keyOf(pid: string): Promise<string> {
  const r = await Preferences.get({ key: 'key_' + pid });
  return r.value ?? '';
 }

 async function resolveProvider(pid: ProviderId): Promise<ResolvedProvider> {
  const d = await db();
  const p = oneRow<ProvRow>(d, 'SELECT * FROM providers WHERE id=?', [pid]);
  if (!p) throw new Error('Provider not configured');
  const key = await keyOf(pid);
  if (!key && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(p.base_url)) throw new Error('Add an API key for ' + p.name + ' in Settings');
  return { id: p.id as ProviderId, name: p.name, url: p.base_url.replace(/\/$/, ''), key };
 }

 async function callProvider(p: ResolvedProvider, history: HistoryMessage[], params: Parameters<typeof buildChatRequest>[2]) {
  const req = buildChatRequest(p, history, params);
  let url = req.url;
  const body = { ...(req.body as Record<string, unknown>) };
  // Switch the prebuilt streaming request to a buffered one.
  delete body.stream;
  delete body.stream_options;
  if (p.id === 'gemini') url = url.replace(':streamGenerateContent?alt=sse', ':generateContent');
  const res = await CapacitorHttp.post({
   url, headers: { ...req.headers }, data: body, responseType: 'json',
   connectTimeout: 30000, readTimeout: 180000,
  });
  if (res.status < 200 || res.status >= 300) throw new Error(apiErrorMessage(res.status, res.data));
  if (p.id === 'anthropic') return parseAnthropicAnswer(res.data);
  if (p.id === 'gemini') return parseGeminiAnswer(res.data);
  return parseOpenAiAnswer(res.data);
 }

 async function historyOf(chatId: string): Promise<HistoryMessage[]> {
  const d = await db();
  const list = rows<MsgRow>(d, 'SELECT * FROM messages WHERE chat_id=? ORDER BY created_at', [chatId]);
  return trimHistory(list.filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })));
 }

 async function generate(r: ChatRequest, mode: 'send' | 'regenerate' | 'continue'): Promise<void> {
  const d = await db();
  active.set(r.chatId, r.requestId);
  try {
   const p = await resolveProvider(r.providerId);
   // Edit-and-resend: drop the edited message and everything after it, so the
   // replacement prompt does not duplicate the tail of the conversation.
   if (r.truncateFromMessageId) {
    const cut = oneRow<MsgRow>(d, 'SELECT created_at FROM messages WHERE id=?', [r.truncateFromMessageId]);
    if (cut) d.run('DELETE FROM messages WHERE chat_id=? AND created_at>=?', [r.chatId, cut.created_at]);
   }
   if (mode === 'send' && !r.skipUserPersist) {
    d.run('INSERT INTO messages(id,chat_id,role,content,created_at) VALUES(?,?,?,?,?)', [id(), r.chatId, 'user', r.content, Date.now()]);
   }
   let history = await historyOf(r.chatId);
   if (mode === 'continue') {
    const last = history[history.length - 1];
    if (last?.role === 'assistant') history = [...history.slice(0, -1), { role: 'assistant' as const, content: last.content + '\n' }, { role: 'user' as const, content: 'Continue exactly where you stopped.' }];
   }
   const answer = await callProvider(p, history, {
    model: r.model, systemPrompt: r.systemPrompt, temperature: r.temperature,
    maxTokens: r.maxTokens, topP: r.topP, reasoningEffort: r.reasoningEffort,
   });
   if (stopped.has(r.requestId)) return;
   emit({ requestId: r.requestId, chatId: r.chatId, text: answer.text, reasoning: answer.reasoning || undefined });
   const mid = id();
   const finishReason = answer.finishReason;
   if (mode === 'regenerate' && r.regenerateMessageId) {
    d.run('UPDATE messages SET content=?,reasoning=?,model=?,provider_id=?,prompt_tokens=?,completion_tokens=?,finish_reason=? WHERE id=?',
     [answer.text, answer.reasoning || null, r.model, r.providerId, answer.promptTokens, answer.completionTokens, finishReason, r.regenerateMessageId]);
   } else if (mode === 'continue' && r.continueMessageId) {
    const prev = oneRow<MsgRow>(d, 'SELECT * FROM messages WHERE id=?', [r.continueMessageId]);
    d.run('UPDATE messages SET content=?,prompt_tokens=?,completion_tokens=?,finish_reason=? WHERE id=?',
     [(prev?.content ?? '') + answer.text, answer.promptTokens, answer.completionTokens, finishReason, r.continueMessageId]);
   } else {
    d.run('INSERT INTO messages(id,chat_id,role,content,created_at,model,provider_id,prompt_tokens,completion_tokens,reasoning,finish_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
     [mid, r.chatId, 'assistant', answer.text, Date.now(), r.model, r.providerId, answer.promptTokens, answer.completionTokens, answer.reasoning || null, finishReason]);
   }
   // Simple local auto-title from the first user line (desktop asks the model).
   const chat = oneRow<ChatRow>(d, 'SELECT * FROM chats WHERE id=?', [r.chatId]);
   if (chat && chat.title === 'New conversation' && r.content.trim()) {
    const title = r.content.trim().slice(0, 60);
    d.run('UPDATE chats SET title=? WHERE id=?', [title, r.chatId]);
    for (const f of renamedSubs) f({ id: r.chatId, title });
   }
   d.run('UPDATE chats SET updated_at=? WHERE id=?', [Date.now(), r.chatId]);
   persistDbSoon();
   emit({
    requestId: r.requestId, chatId: r.chatId, text: '', done: true,
    promptTokens: answer.promptTokens ?? undefined, completionTokens: answer.completionTokens ?? undefined, finishReason,
   });
  } catch (e) {
   if (stopped.has(r.requestId)) return;
   emit({ requestId: r.requestId, chatId: r.chatId, text: '', done: true, error: e instanceof Error ? e.message : 'Request failed' });
  } finally {
   stopped.delete(r.requestId);
   active.delete(r.chatId);
  }
 }

 async function listProviders(): Promise<ProviderConfig[]> {
  await seedProviders();
  const d = await db();
  const out: ProviderConfig[] = [];
  for (const p of rows<ProvRow>(d, 'SELECT * FROM providers ORDER BY rowid')) {
   let pricing: ProviderConfig['pricing'];
   try { pricing = p.pricing ? JSON.parse(p.pricing) as ProviderConfig['pricing'] : undefined; } catch { pricing = undefined; }
   out.push({ id: p.id as ProviderId, name: p.name, baseUrl: p.base_url, models: JSON.parse(p.models) as string[], pricing, hasKey: !!(await keyOf(p.id)) });
  }
  return out;
 }

 const api: DesktopAPI = {
  window: { minimize() {}, toggleMaximize() {}, close() {}, setAlwaysOnTop() {} },
  app: {
   async version() { return '1.1.2-android'; },
   async pickFolder() { return null; },
   async profile(): Promise<AppProfile> { return { mica: false, username: '' }; },
  },
  chats: {
   async list() {
    const d = await db();
    return rows<ChatRow>(d, 'SELECT * FROM chats WHERE COALESCE(archived,0)=0 ORDER BY pinned DESC, updated_at DESC').map(chatFromRow);
   },
   async create() {
    const d = await db();
    const c: Chat = { id: id(), title: 'New conversation', providerId: 'openai', model: 'gpt-4o-mini', updatedAt: Date.now() };
    d.run('INSERT INTO chats(id,title,provider_id,model,updated_at) VALUES(?,?,?,?,?)', [c.id, c.title, c.providerId, c.model, c.updatedAt]);
    persistDbSoon();
    return c;
   },
   async rename(cid, title) { const d = await db(); d.run('UPDATE chats SET title=? WHERE id=?', [title.slice(0, 120), cid]); persistDbSoon(); },
   async delete(cid) { const d = await db(); d.run('DELETE FROM messages WHERE chat_id=?', [cid]); d.run('DELETE FROM chats WHERE id=?', [cid]); persistDbSoon(); },
   async pin(cid, pinned) { const d = await db(); d.run('UPDATE chats SET pinned=? WHERE id=?', [pinned ? 1 : 0, cid]); persistDbSoon(); },
   async setFolder(cid, folderId) { const d = await db(); d.run('UPDATE chats SET folder_id=? WHERE id=?', [folderId, cid]); persistDbSoon(); },
   async setArchived(cid, archived) { const d = await db(); d.run('UPDATE chats SET archived=? WHERE id=?', [archived ? 1 : 0, cid]); persistDbSoon(); },
   async setReadonly() {},
   async setTags(cid, tags) { const d = await db(); d.run('UPDATE chats SET tags=? WHERE id=?', [JSON.stringify(tags.slice(0, 10)), cid]); persistDbSoon(); },
   async pickWorkspace() { return null; },
   async clearWorkspace() {},
   async messages(cid) { const d = await db(); return rows<MsgRow>(d, 'SELECT * FROM messages WHERE chat_id=? ORDER BY created_at', [cid]).map(msgFromRow); },
   async deleteMessage(mid) { const d = await db(); d.run('DELETE FROM messages WHERE id=?', [mid]); persistDbSoon(); },
   async bookmarkMessage(mid, bookmarked) { const d = await db(); d.run('UPDATE messages SET bookmarked=? WHERE id=?', [bookmarked ? 1 : 0, mid]); persistDbSoon(); },
   async rateMessage(mid, rating) { const d = await db(); d.run('UPDATE messages SET rating=? WHERE id=?', [rating || null, mid]); persistDbSoon(); },
   async variants(): Promise<MessageVariant[]> { return []; },
   async restoreVariant() { const d = await db(); return rows<MsgRow>(d, 'SELECT 1 WHERE 0').map(msgFromRow); },
   async branch(cid, messageId) {
    const d = await db();
    const src = oneRow<ChatRow>(d, 'SELECT * FROM chats WHERE id=?', [cid]);
    if (!src) throw new Error('Chat not found');
    const cut = oneRow<MsgRow>(d, 'SELECT * FROM messages WHERE id=?', [messageId]);
    const copy: Chat = { ...chatFromRow(src), id: id(), title: src.title.slice(0, 92) + ' (branch)', updatedAt: Date.now() };
    d.run('INSERT INTO chats(id,title,provider_id,model,updated_at,pinned,folder_id,archived,tags) VALUES(?,?,?,?,?,0,?,0,?)', [copy.id, copy.title, copy.providerId, copy.model, copy.updatedAt, src.folder_id, src.tags ?? '[]']);
    if (cut) for (const m of rows<MsgRow>(d, 'SELECT * FROM messages WHERE chat_id=? AND created_at<=? ORDER BY created_at', [cid, cut.created_at])) {
     d.run('INSERT INTO messages(id,chat_id,role,content,created_at,model,provider_id,prompt_tokens,completion_tokens,reasoning,finish_reason,bookmarked,rating) VALUES(?,?,?,?,?,?,?,?,?,?,?,0,NULL)',
      [id(), copy.id, m.role, m.content, m.created_at, m.model, m.provider_id, m.prompt_tokens, m.completion_tokens, m.reasoning, m.finish_reason]);
    }
    persistDbSoon();
    return copy;
   },
   async usageSummary(): Promise<UsageSummary> {
    const d = await db();
    const agg = oneRow<{ messages: number; p: number | null; c: number | null }>(d, "SELECT COUNT(*) AS messages, COALESCE(SUM(prompt_tokens),0) AS p, COALESCE(SUM(completion_tokens),0) AS c FROM messages WHERE role='assistant'");
    const byModel = rows<UsageRow>(d, "SELECT provider_id AS providerId, model, COUNT(*) AS messages, COALESCE(SUM(prompt_tokens),0) AS promptTokens, COALESCE(SUM(completion_tokens),0) AS completionTokens FROM messages WHERE role='assistant' GROUP BY provider_id, model ORDER BY messages DESC LIMIT 20");
    return { messages: agg?.messages ?? 0, promptTokens: agg?.p ?? 0, completionTokens: agg?.c ?? 0, byModel };
   },
   async usageByDay(): Promise<DayUsage[]> {
    const d = await db();
    const list = rows<{ day: string; p: number; c: number; model: string | null; provider_id: string | null; pt: number | null; ct: number | null }>(d,
     "SELECT date(created_at/1000,'unixepoch') AS day, COALESCE(SUM(prompt_tokens),0) AS p, COALESCE(SUM(completion_tokens),0) AS c FROM messages WHERE role='assistant' GROUP BY day ORDER BY day DESC LIMIT 60");
    return list.map(r => ({ day: r.day, promptTokens: r.p, completionTokens: r.c, cost: 0 }));
   },
   async summarize() { return ''; },
   async compare(): Promise<CompareAnswer[]> { return []; },
   async export(cid, format) {
    const d = await db();
    const chat = oneRow<ChatRow>(d, 'SELECT * FROM chats WHERE id=?', [cid]);
    if (!chat) return null;
    const msgs = rows<MsgRow>(d, 'SELECT * FROM messages WHERE chat_id=? ORDER BY created_at', [cid]);
    const content = format === 'json'
     ? JSON.stringify({ chat: chatFromRow(chat), messages: msgs.map(msgFromRow) }, null, 2)
     : ['# ' + chat.title, '', ...msgs.map(m => `**${m.role === 'user' ? 'You' : 'Lumen'}** Р’В· ${new Date(m.created_at).toLocaleString()}\n\n${m.content}`)].join('\n\n');
    // There is no save dialog on Android: write to the app cache and hand the UI
    // a real path (the toast shows it; the file is shareable from there).
    const safe = chat.title.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 40) || 'chat';
    const name = `lumen-${safe}-${Date.now()}.${format}`;
    await Filesystem.writeFile({ path: name, data: content, directory: Directory.Cache, encoding: Encoding.UTF8 });
    const uri = await Filesystem.getUri({ path: name, directory: Directory.Cache });
    return uri.uri;
   },
   async exportPrepared() { return null; },
   async exportZip() { return null; },
   async search(filters: SearchFilters): Promise<SearchResult[]> {
    const d = await db();
    const q = (filters.query ?? '').trim();
    if (!q) return [];
    const like = '%' + q.replace(/[%_]/g, '') + '%';
    const byTitle = rows<ChatRow>(d, 'SELECT * FROM chats WHERE title LIKE ? LIMIT 20', [like]);
    const hits = rows<MsgRow & { title: string }>(d,
     'SELECT m.*, c.title AS title FROM messages m JOIN chats c ON c.id=m.chat_id WHERE m.content LIKE ? ORDER BY m.created_at DESC LIMIT 30', [like]);
    const fromTitles: SearchResult[] = byTitle.map(c => ({ chatId: c.id, messageId: '', title: c.title, snippet: '', role: 'chat', model: c.model, createdAt: c.updated_at }));
    const fromMsgs: SearchResult[] = hits.map(m => {
     const i = m.content.toLowerCase().indexOf(q.toLowerCase());
     const start = Math.max(0, i - 60);
     return { chatId: m.chat_id, messageId: m.id, title: m.title, snippet: m.content.slice(start, start + 160), role: m.role, model: m.model, createdAt: m.created_at };
    });
    return [...fromTitles, ...fromMsgs];
   },
   async readWorkspaceFile() { return null; },
   async listWorkspaceFiles() { return []; },
   async docs(): Promise<ChatDoc[]> { return []; },
   async attachDoc(): Promise<ChatDoc | null> { return null; },
   async removeDoc() {},
   async todos(): Promise<TodoItem[]> { return []; },
   async fileOps(): Promise<FileOp[]> { return []; },
   async rollbackOp() { return { ok: false, message: 'Not available on Android' }; },
   onRenamed(cb) { renamedSubs.add(cb); return () => renamedSubs.delete(cb); },
   onTodos() { return () => {}; },
   onFileOp() { return () => {}; },
  },
  folders: {
   async list(): Promise<Folder[]> { const d = await db(); return rows<Folder>(d, 'SELECT * FROM folders ORDER BY created_at'); },
   async create(name) {
    const d = await db();
    const f: Folder = { id: id(), name: name.trim().slice(0, 60) || 'Folder', createdAt: Date.now() };
    d.run('INSERT INTO folders(id,name,created_at) VALUES(?,?,?)', [f.id, f.name, f.createdAt]);
    persistDbSoon();
    return f;
   },
   async rename(fid, name) { const d = await db(); d.run('UPDATE folders SET name=? WHERE id=?', [name.trim().slice(0, 60), fid]); persistDbSoon(); },
   async delete(fid) { const d = await db(); d.run('DELETE FROM folders WHERE id=?', [fid]); d.run('UPDATE chats SET folder_id=NULL WHERE folder_id=?', [fid]); persistDbSoon(); },
  },
  providers: {
   list: listProviders,
   async create(name) {
    const d = await db();
    const n = oneRow<{ n: number }>(d, "SELECT COUNT(*) AS n FROM providers WHERE id LIKE 'custom-%'")?.n ?? 0;
    if (n >= MAX_CUSTOM_PROVIDERS) throw new Error('At most ' + MAX_CUSTOM_PROVIDERS + ' custom providers');
    const c: ProviderConfig = { id: ('custom-' + id().slice(0, 8)) as ProviderId, name: name.trim().slice(0, 60) || 'Custom provider', baseUrl: '', models: [] };
    d.run('INSERT INTO providers(id,name,base_url,models) VALUES(?,?,?,?)', [c.id, c.name, c.baseUrl, '[]']);
    persistDbSoon();
    return { ...c, hasKey: false };
   },
   async save(config, key) {
    const clean = validateProviderConfig(config, PINNED_URLS);
    const d = await db();
    d.run('INSERT INTO providers(id,name,base_url,models,pricing) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,base_url=excluded.base_url,models=excluded.models,pricing=excluded.pricing',
     [clean.id, clean.name, clean.baseUrl, JSON.stringify(clean.models), JSON.stringify(clean.pricing ?? {})]);
    if (key) await Preferences.set({ key: 'key_' + clean.id, value: key });
    persistDbSoon();
   },
   async remove(pid) {
    if (!isCustomProviderId(pid)) return;
    const d = await db();
    d.run('DELETE FROM providers WHERE id=?', [pid]);
    await Preferences.remove({ key: 'key_' + pid });
    persistDbSoon();
   },
   async models(pid) {
    const p = await resolveProvider(pid);
    const req = buildModelsRequest(p);
    const res = await CapacitorHttp.get({ url: req.url, headers: req.headers, responseType: 'json', connectTimeout: 20000, readTimeout: 30000 });
    if (res.status < 200 || res.status >= 300) throw new Error(apiErrorMessage(res.status, res.data));
    const data = res.data as Record<string, unknown>;
    let ids: string[];
    if (p.id === 'gemini') {
     ids = ((data.models as { name?: string }[] | undefined) ?? []).map(m => (m.name ?? '').replace(/^models\//, '')).filter(Boolean);
    } else {
     ids = ((data.data as { id?: string }[] | undefined) ?? []).map(m => m.id ?? '').filter(Boolean);
    }
    return normalizeModelIds(ids).slice(0, 200);
   },
   async test(pid) {
    try { await api.providers.models(pid); return { ok: true, message: 'Connection successful' }; }
    catch (e) { return { ok: false, message: e instanceof Error ? e.message : 'Connection failed' }; }
   },
  },
  chat: {
   async send(request) { await generate(validateChatRequest(request), 'send'); },
   async continueMessage(request) { await generate(validateChatRequest(request), 'continue'); },
   async regenerate(request) { await generate(validateChatRequest(request), 'regenerate'); },
   async stop(requestId) {
    const entry = [...active.entries()].find(([, rid]) => !requestId || rid === requestId);
    if (!entry) return { stopped: false };
    stopped.add(entry[1]);
    emit({ requestId: entry[1], chatId: entry[0], text: '', done: true, stopped: true });
    active.delete(entry[0]);
    return { stopped: true };
   },
   async status() { return [...active.entries()].map(([chatId, requestId]) => ({ chatId, requestId })); },
   onChunk(cb) { chunkSubs.add(cb); return () => chunkSubs.delete(cb); },
   onTool() { return () => {}; },
  },
  quick: { async ask() { return ''; }, hide() {}, onShown() { return () => {}; } },
  updates: { async check() { return 'Android builds update by installing a newer APK'; }, install() {} },
  prompt: {
   async enhance(draft, providerId, model) {
    const p = await resolveProvider(providerId);
    const answer = await callProvider(p, [{ role: 'user', content: draft }], { model, systemPrompt: ENHANCE_PROMPT, temperature: 0.4, maxTokens: 2048 });
    return cleanEnhanced(answer.text, draft) || draft;
   },
  },
  data: {
   async health(): Promise<DataHealth> { return { ok: !dbPersistError(), persistError: dbPersistError() }; },
   async wipe() { await wipeMobileDb(); for (const p of PROVIDER_DEFAULTS) await Preferences.remove({ key: 'key_' + p.id }); },
   async openFolder() {},
   async backup() { return null; },
   async restore() { return false; },
  },
  settings: {
   async get(): Promise<SettingsData> {
    const d = await db();
    const row = oneRow<{ value: string }>(d, "SELECT value FROM kv WHERE key='settings'");
    let saved: Record<string, unknown>;
    try { saved = row ? (JSON.parse(row.value) as Record<string, unknown>) : {}; } catch { return { ...SETTINGS_DEFAULTS }; }
    return { ...SETTINGS_DEFAULTS, ...(clampSettings(saved) as Partial<SettingsData>) };
   },
   async save(settings) {
    const clean = clampSettings(settings);
    const cur = await api.settings.get();
    const d = await db();
    d.run("INSERT INTO kv(key,value) VALUES('settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [JSON.stringify({ ...cur, ...clean })]);
    persistDbSoon();
   },
  },
 };
 return api;
}
