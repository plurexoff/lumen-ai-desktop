import { app, BrowserWindow, ipcMain, safeStorage, dialog, shell, screen, nativeTheme, Tray, Menu, nativeImage, protocol, Notification } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { openDatabase, query, run, one, saveNow, transaction, dbStatus, lastPersistError, SCHEMA_VERSION } from './db';
import {
 parseSseEvent, parseReasoningEvent, parseUsageEvent, parseAnthropicUsage, parseFinishReason, parseAnthropicFinish,
 validateProviderUrl, isSafeExternalUrl, isLoopbackUrl, buildModelsRequest, buildChatRequest, trimHistory, normalizeHistory,
 validateProviderConfig, validateChatRequest, clampSettings, isKnownProviderId, normalizeHotkeys, authHeaders, TITLE_PROMPT, cleanTitle, stripGeminiModelPrefix, ENHANCE_PROMPT, cleanEnhanced, DEFAULT_PRICING,
 parseToolCallDelta, parseAnthropicToolEvent, parseGeminiToolCall,
 type ResolvedProvider, type HistoryMessage, type ToolCallRecord,
} from './providers';
import { TOOL_DEFS, WORKSPACE_PROMPT, MAX_TOOL_ROUNDS, runToolCall, restoreSnapshot, listFiles, readWorkspaceFile, normalizeTodos, type ApproveFn } from './tools';
import { randomUUID } from 'node:crypto';
import type { ProviderConfig, ProviderId, FinishReason, ActiveStream, UsageRow, UsageSummary, Folder, SearchFilters, DayUsage, FileOp } from './shared';

// Lightweight structured logging: main-process failures were previously invisible.
function log(...args: unknown[]) { console.log('[lumen]', ...args); }
process.on('uncaughtException', e => console.error('[lumen] uncaughtException', e));
process.on('unhandledRejection', r => console.error('[lumen] unhandledRejection', r));

const defaults:ProviderConfig[]=[
{id:'openai',name:'OpenAI',baseUrl:'https://api.openai.com/v1',models:['gpt-4o','gpt-4o-mini','o3-mini']},
{id:'anthropic',name:'Anthropic',baseUrl:'https://api.anthropic.com/v1',models:['claude-sonnet-4-20250514','claude-3-5-haiku-20241022']},
{id:'gemini',name:'Google Gemini',baseUrl:'https://generativelanguage.googleapis.com/v1beta',models:['gemini-2.0-flash','gemini-2.5-pro-preview-03-25']},
{id:'openrouter',name:'OpenRouter',baseUrl:'https://openrouter.ai/api/v1',models:['anthropic/claude-sonnet-4','openai/gpt-4o-mini']},
{id:'groq',name:'Groq',baseUrl:'https://api.groq.com/openai/v1',models:['llama-3.3-70b-versatile','deepseek-r1-distill-llama-70b']},
{id:'deepseek',name:'DeepSeek',baseUrl:'https://api.deepseek.com/v1',models:['deepseek-chat','deepseek-reasoner']},
{id:'mistral',name:'Mistral',baseUrl:'https://api.mistral.ai/v1',models:['mistral-large-latest','mistral-small-latest']},
// Local servers ship keyless: both expose an OpenAI-compatible /v1 endpoint.
{id:'ollama',name:'Ollama',baseUrl:'http://127.0.0.1:11434/v1',models:[]},
{id:'lmstudio',name:'LM Studio',baseUrl:'http://127.0.0.1:1234/v1',models:[]},
{id:'custom',name:'Custom provider',baseUrl:'',models:[]}
];
// Cloud providers keep their official endpoint: letting the renderer swap baseUrl
// for id='openai' would leak the real decrypted key to an attacker's host. Local
// presets (ollama/lmstudio/custom) stay editable because ports vary.
const PINNED_PROVIDER_IDS=new Set<ProviderId>(['openai','anthropic','gemini','openrouter','groq','deepseek','mistral']);
const PINNED_URLS=new Map<ProviderId,string>(defaults.filter(d=>PINNED_PROVIDER_IDS.has(d.id)).map(d=>[d.id,validateProviderUrl(d.baseUrl)] as [ProviderId,string]));
// A stalled stream must not leave the UI stuck in "busy" forever.
const STREAM_IDLE_MS=60000;
// Cumulative tool-output cap per answer: keeps a runaway tool loop from stuffing
// the context window with file contents (≈ 200k characters of tool results).
const MAX_TOOL_BUDGET_CHARS=200_000;
let win:BrowserWindow;
// chatId is kept so the renderer can discover orphaned streams after a reload.
const activeRequests=new Map<string,{controller:AbortController;chatId:string}>();
// Image bytes live as plain files (not in lumen.sqlite): sql.js holds the whole DB
// in memory and re-exports it on every flush, so inlined images would tax every write.
const attachmentsDir=()=>path.join(app.getPath('userData'),'attachments');
// Tray mode: closing the window hides it instead of quitting; real quit goes
// through the tray menu or before-quit.
let tray:Tray|null=null;let trayEnabled=false;let quitting=false;
// Attachments render via a dedicated scheme that the CSP allow-lists
// (img-src lumen-attachment:). Must be registered before app ready.
protocol.registerSchemesAsPrivileged([{scheme:'lumen-attachment',privileges:{stream:true}}]);

function setTray(enabled:boolean){
 trayEnabled=enabled;
 if(enabled&&!tray){
  const icon=windowIcon();if(!icon)return; // no icon -> no tray; retried on next save
  tray=new Tray(nativeImage.createFromPath(icon));
  tray.setToolTip('Lumen AI');
  tray.on('click',()=>{if(win&&!win.isDestroyed()){win.show();win.focus();}});
  tray.setContextMenu(Menu.buildFromTemplate([
   {label:'Open Lumen',click:()=>{if(!win||win.isDestroyed())createWindow();else{win.show();win.focus();}}},
   {type:'separator'},
   {label:'Quit',click:()=>{quitting=true;app.quit();}},
  ]));
 }else if(!enabled&&tray){tray.destroy();tray=null;}
}
// Attachment files referenced by a set of message rows, for post-delete cleanup.
function attachmentFiles(messageIds:string[]):string[]{
 if(!messageIds.length)return[];
 const marks=messageIds.map(()=>'?').join(',');
 return query(`SELECT id FROM attachments WHERE message_id IN (${marks})`,messageIds).map(r=>String(r.id));
}
// Files are removed AFTER the rows commit: a failed transaction must not orphan
// the images of messages that are still in the database.
function removeAttachmentFiles(ids:string[]){for(const id of ids)try{fs.unlinkSync(path.join(attachmentsDir(),id));}catch{}}
// Inline a message's images into the provider request. Missing files are skipped
// with a log line rather than failing the whole send.
function messageImages(messageId:string):{mime:string;data:string}[]|undefined{
 const atts=query('SELECT id,mime FROM attachments WHERE message_id=? ORDER BY created_at',[messageId]) as Array<{id:string;mime:string}>;
 if(!atts.length)return undefined;
 const out:{mime:string;data:string}[]=[];
 for(const a of atts){try{out.push({mime:a.mime,data:fs.readFileSync(path.join(attachmentsDir(),a.id)).toString('base64')});}catch{log('attachment file missing',a.id);}}
 return out.length?out:undefined;
}
// Desktop notification when a generation settles while the window is unfocused or
// hidden in the tray. Opt-in via Settings; flashFrame stays the always-on fallback.
function notifyCompletion(chatId:string,error?:string){
 try{
  const row=one("SELECT value FROM settings WHERE key='notifications'") as {value:string}|undefined;
  if(!row||JSON.parse(row.value)!==true)return;
 }catch{return;}
 if(!Notification.isSupported())return;
 if(win&&!win.isDestroyed()&&win.isFocused()&&win.isVisible())return;
 const chat=one('SELECT title FROM chats WHERE id=?',[chatId]) as {title:string}|undefined;
 const n=new Notification({title:chat?.title||'Lumen AI',body:error?'Generation failed: '+error.slice(0,140):'Response ready'});
 n.on('click',()=>{if(win&&!win.isDestroyed()){win.show();win.focus();}});
 n.show();
}
// A short non-streaming side request shared by auto-title and enhance-prompt.
// Returns the raw text the model produced ('' on any non-OK response).
async function miniRequest(p:ResolvedProvider,model:string,content:string,maxTokens:number):Promise<string>{
 const headers={...authHeaders(p),'content-type':'application/json'};
 if(p.id==='gemini'){
  const res=await fetch(p.url+`/models/${encodeURIComponent(stripGeminiModelPrefix(model))}:generateContent`,{method:'POST',headers,body:JSON.stringify({contents:[{role:'user',parts:[{text:content}]}],generationConfig:{maxOutputTokens:maxTokens}})});
  if(!res.ok)return '';
  const data=await res.json() as {candidates?:Array<{content?:{parts?:Array<{text?:string}>}}>};
  return (data.candidates?.[0]?.content?.parts??[]).map(x=>x.text??'').join('');
 }
 if(p.id==='anthropic'){
  const res=await fetch(p.url+'/messages',{method:'POST',headers,body:JSON.stringify({model,max_tokens:maxTokens,temperature:0.3,messages:[{role:'user',content}]})});
  if(!res.ok)return '';
  const data=await res.json() as {content?:Array<{text?:string}>};
  return data.content?.[0]?.text??'';
 }
 const res=await fetch(p.url+'/chat/completions',{method:'POST',headers,body:JSON.stringify({model,max_tokens:maxTokens,temperature:0.3,messages:[{role:'user',content}],stream:false})});
 if(!res.ok)return '';
 const data=await res.json() as {choices?:Array<{message?:{content?:string}}>};
 return data.choices?.[0]?.message?.content??'';
}
// A short non-streaming side request that names a chat after its first exchange
// (opencode's hidden "title" agent). Fire-and-forget: any failure just keeps the
// prefix title. The UPDATE guard never overwrites a title the user typed meanwhile.
async function maybeAutoTitle(p:ResolvedProvider,chatId:string,model:string,userText:string,assistantText:string){
 try{
  const chat=one('SELECT title FROM chats WHERE id=?',[chatId]) as {title:string}|undefined;
  if(!chat)return;
  const prefix=userText.replace(/\s+/g,' ').trim().slice(0,48);
  if(chat.title!=='New conversation'&&chat.title!==prefix)return;
  const content=TITLE_PROMPT+'\n\nUser: '+(userText||'[image attachment]').slice(0,500)+'\nAssistant: '+assistantText.slice(0,500);
  const raw=await miniRequest(p,model,content,40);
  const title=cleanTitle(raw);
  if(!title)return;
  run('UPDATE chats SET title=? WHERE id=? AND title=?',[title,chatId,chat.title]);
  toRenderer('chats:renamed',{id:chatId,title});
 }catch(e){log('auto-title failed',e instanceof Error?e.message:e);}
}

async function initDb(){
 await openDatabase();
 // Seed the built-in presets the install does not have yet. INSERT OR IGNORE (not a
 // single "table empty?" guard) so an existing database also picks up newly added
 // local presets like ollama/lmstudio, while a preset the user already configured is
 // never overwritten.
 const empty=!Number(one('SELECT COUNT(*) AS n FROM providers')?.n);
 for(const p of defaults){
  // `custom` is user-removable: only create it on a first run, so removing it sticks.
  if(p.id==='custom'&&!empty)continue;
  run('INSERT OR IGNORE INTO providers(id,name,base_url,models) VALUES(?,?,?,?)',[p.id,p.name,p.baseUrl,JSON.stringify(p.models)]);
  // Seed reference prices for the built-in model lists. Only missing keys are
  // filled — a price the user edited always wins over an update to the defaults.
  const ref=DEFAULT_PRICING[p.id];
  if(ref){
   const row=one('SELECT pricing FROM providers WHERE id=?',[p.id]) as {pricing:string|null}|undefined;
   let cur:Record<string,unknown>;
   try{cur=row?.pricing?JSON.parse(row.pricing):{};}catch{cur={};}
   let changed=false;
   for(const [m,price] of Object.entries(ref))if(!(m in cur)){cur[m]=price;changed=true;}
   if(changed)run('UPDATE providers SET pricing=? WHERE id=?',[JSON.stringify(cur),p.id]);
  }
 }
 reapOrphans();
}
// Earlier builds deleted only the `chats` row and relied on ON DELETE CASCADE, which
// sql.js silently disables whenever export() resets the foreign_keys pragma. Any
// conversation "permanently removed" by such a build is still sitting on disk, so
// sweep the leftovers once at startup. Order matters: messages first, then the
// variants that pointed at them.
function reapOrphans(){
 const before=Number(one('SELECT COUNT(*) AS n FROM messages')?.n??0);
 transaction(()=>{
  run('DELETE FROM messages WHERE chat_id NOT IN (SELECT id FROM chats)');
  run('DELETE FROM message_variants WHERE message_id NOT IN (SELECT id FROM messages)');
  run('DELETE FROM attachments WHERE message_id NOT IN (SELECT id FROM messages)');
 });
 const removed=before-Number(one('SELECT COUNT(*) AS n FROM messages')?.n??0);
 if(removed>0)log('removed '+removed+' orphaned message(s) left by an older build');
}
// IPC to the renderer must tolerate a closed/destroyed window (a generation can
// still be streaming when the user quits).
function toRenderer(channel:string,payload:unknown){if(!win||win.isDestroyed()||win.webContents.isDestroyed())return;win.webContents.send(channel,payload);}
function savedBounds(){try{const raw=one("SELECT value FROM settings WHERE key='windowBounds'") as {value:string}|undefined;if(!raw)return undefined;const b=JSON.parse(raw.value) as Electron.Rectangle;if(!(b.width>0&&b.height>0))return undefined;const visible=screen.getAllDisplays().some(d=>{const w=d.workArea;return b.x<w.x+w.width&&b.x+b.width>w.x&&b.y<w.y+w.height&&b.y+b.height>w.y;});return visible?b:undefined;}catch{return undefined;}}
// Match the window background to the saved theme so there is no dark flash when a
// light-theme user launches.
function savedTheme():'dark'|'light'{try{const v=one("SELECT value FROM settings WHERE key='theme'") as {value:string}|undefined;return v&&JSON.parse(v.value)==='light'?'light':'dark';}catch{return 'dark';}}
// Window/taskbar/titlebar icon. The exe's OWN embedded icon is left as stock Electron
// because the dist:win script passes -c.win.signAndEditExecutable=false, which skips the
// rcedit step that would rewrite the exe icon+version info — that needs a package.json
// change we are not making. Setting BrowserWindow.icon still drives the live window,
// taskbar button and Alt-Tab entry. Prefer the renderer-shipped copy (dist/icon.ico,
// covered by build.files and present in the packaged app); fall back to build/icon.ico
// for a dev run before the renderer has been built.
function windowIcon():string|undefined{
 for(const rel of [['..','dist','icon.ico'],['..','build','icon.ico']]){
  const p=path.join(__dirname,...rel);
  if(fs.existsSync(p))return p;
 }
 return undefined;
}
function createWindow(){
 const bounds=savedBounds();const theme=savedTheme();const icon=windowIcon();
 nativeTheme.themeSource=theme;
 win=new BrowserWindow({...(bounds??{width:1320,height:860}),minWidth:900,minHeight:620,frame:false,backgroundColor:theme==='light'?'#f5f6f8':'#0d0f12',...(icon?{icon}:{}),webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
 // Only web-safe protocols may leave the app; anything else (search-ms:, file:, …)
 // is denied. .catch avoids an unhandled rejection when no handler is registered.
 win.webContents.setWindowOpenHandler(({url})=>{if(isSafeExternalUrl(url))shell.openExternal(url).catch(()=>{});return{action:'deny'};});
 // The app is a single-page client: block in-window navigation so a hostile
 // markdown link cannot replace the UI with remote content.
 win.webContents.on('will-navigate',e=>e.preventDefault());
 win.webContents.on('did-fail-load',(_e,code,desc,url)=>{if(code!==-3)log('renderer failed to load',code,desc,url);});
 win.on('focus',()=>win.flashFrame(false));
 // In production, hide DevTools/reload accelerators but KEEP the edit roles so
 // Ctrl+C/V/X/A still work in inputs (removing the menu entirely would break them).
 if(!process.env.VITE_DEV_SERVER_URL){
  win.webContents.on('before-input-event',(e,input)=>{if(input.type!=='keyDown')return;const k=input.key.toLowerCase();if(input.key==='F12'||((input.control||input.meta)&&input.shift&&k==='i')||((input.control||input.meta)&&k==='r'))e.preventDefault();});
 }
 const persistBounds=()=>{if(!win||win.isDestroyed()||win.isMinimized())return;run("INSERT OR REPLACE INTO settings VALUES('windowBounds',?)",[JSON.stringify(win.getBounds())]);};
 win.on('resized',persistBounds);win.on('moved',persistBounds);
 // With the tray enabled, "closing" only hides the window; real quit goes through
 // the tray menu (or any path that reaches before-quit, which sets `quitting`).
 win.on('close',e=>{if(trayEnabled&&!quitting){e.preventDefault();win.hide();}});
 win.on('closed',()=>saveNow());
 if(process.env.VITE_DEV_SERVER_URL)void win.loadURL(process.env.VITE_DEV_SERVER_URL);else void win.loadURL(pathToFileURL(path.join(__dirname,'../dist/index.html')).toString());
}
const MESSAGE_COLUMNS='id,chat_id as chatId,role,content,created_at as createdAt,model,provider_id as providerId,prompt_tokens as promptTokens,completion_tokens as completionTokens,reasoning,finish_reason as finishReason,bookmarked,(SELECT COUNT(*) FROM message_variants v WHERE v.message_id=messages.id) AS variantCount';
const CHAT_COLUMNS='id,title,provider_id as providerId,model,updated_at as updatedAt,branched_from as branchedFrom,pinned,folder_id as folderId,workspace,archived,workspace_readonly as workspaceReadonly';
function listChats(){
 const chats=query(`SELECT ${CHAT_COLUMNS} FROM chats ORDER BY pinned DESC, updated_at DESC`) as Array<Record<string,unknown>&{id:string}>;
 const tags=query('SELECT chat_id as chatId,tag FROM chat_tags') as Array<{chatId:string;tag:string}>;
 const byChat=new Map<string,string[]>();
 for(const t of tags){(byChat.get(t.chatId)??byChat.set(t.chatId,[]).get(t.chatId)!).push(t.tag);}
 return chats.map(c=>({...c,tags:byChat.get(c.id)??[]}));
}
function listMessages(chatId:string){
 const msgs=query(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE chat_id=? ORDER BY created_at`,[chatId]) as Array<Record<string,unknown>&{id:string}>;
 const atts=query('SELECT message_id as messageId,id,name,mime,size FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE chat_id=?)',[chatId]) as Array<{messageId:string;id:string;name:string;mime:string;size:number}>;
 if(!atts.length)return msgs;
 const byMsg=new Map<string,Array<{id:string;name:string;mime:string;size:number}>>();
 for(const a of atts){const list=byMsg.get(a.messageId)??[];list.push({id:a.id,name:a.name,mime:a.mime,size:a.size});byMsg.set(a.messageId,list);}
 return msgs.map(m=>({...m,attachments:byMsg.get(m.id)??[]}));
}
function initIpc(){
 ipcMain.on('window:minimize',()=>win.minimize());ipcMain.on('window:toggle-maximize',()=>win.isMaximized()?win.unmaximize():win.maximize());ipcMain.on('window:close',()=>win.close());
 ipcMain.handle('app:version',()=>app.getVersion());
 ipcMain.handle('app:pick-folder',async(_e,title?:string)=>{
  const result=await dialog.showOpenDialog(win,{title:typeof title==='string'&&title?title.slice(0,100):'Choose a folder',properties:['openDirectory','createDirectory']});
  return result.canceled?null:(result.filePaths[0]?path.resolve(result.filePaths[0]):null);
 });
 ipcMain.handle('chats:list',()=>listChats());
 ipcMain.handle('chats:create',()=>{const id=randomUUID(),updatedAt=Date.now();run('INSERT INTO chats(id,title,provider_id,model,updated_at) VALUES(?,?,?,?,?)',[id,'New conversation','openai','gpt-4o-mini',updatedAt]);return{id,title:'New conversation',providerId:'openai',model:'gpt-4o-mini',updatedAt};});
 ipcMain.handle('chats:rename',(_e,id:string,title:string)=>{if(typeof id!=='string'||typeof title!=='string')return;const clean=title.trim().slice(0,100);if(!clean)return;run('UPDATE chats SET title=?,updated_at=? WHERE id=?',[clean,Date.now(),id]);});
 // Pin toggles ordering only — deliberately does not bump updated_at.
 ipcMain.handle('chats:pin',(_e,id:string,pinned:boolean)=>{if(typeof id!=='string')return;run('UPDATE chats SET pinned=? WHERE id=?',[pinned?1:0,id]);});
 ipcMain.handle('chats:set-folder',(_e,id:string,folderId:string|null)=>{if(typeof id!=='string')return;
  if(folderId!==null&&(typeof folderId!=='string'||!one('SELECT id FROM folders WHERE id=?',[folderId])))return;
  run('UPDATE chats SET folder_id=? WHERE id=?',[folderId,id]);});
 // The workspace folder enables the model's file tools for this chat. The picker
 // dialog lives in main so the renderer never sees a filesystem path it didn't
 // explicitly ask the user for.
 ipcMain.handle('chats:pick-workspace',async(_e,id:string)=>{
  if(typeof id!=='string')return null;
  const result=await dialog.showOpenDialog(win,{title:'Choose a workspace folder',properties:['openDirectory','createDirectory']});
  if(result.canceled||!result.filePaths[0])return null;
  const folder=path.resolve(result.filePaths[0]);
  run('UPDATE chats SET workspace=? WHERE id=?',[folder,id]);
  return one(`SELECT ${CHAT_COLUMNS} FROM chats WHERE id=?`,[id]);
 });
 ipcMain.handle('chats:clear-workspace',(_e,id:string)=>{if(typeof id!=='string')return;run('UPDATE chats SET workspace=NULL WHERE id=?',[id]);});
 // Archive hides a chat from the sidebar without deleting anything.
 ipcMain.handle('chats:set-archived',(_e,id:string,archived:boolean)=>{if(typeof id!=='string')return;run('UPDATE chats SET archived=? WHERE id=?',[archived?1:0,id]);});
 // Read-only mode: the model may read/search the workspace but every write tool
 // refuses with an explanation (checked inside runToolCall).
 ipcMain.handle('chats:set-readonly',(_e,id:string,readonly:boolean)=>{if(typeof id!=='string')return;run('UPDATE chats SET workspace_readonly=? WHERE id=?',[readonly?1:0,id]);});
 ipcMain.handle('chats:set-tags',(_e,id:string,tags:unknown)=>{if(typeof id!=='string'||!Array.isArray(tags))return;
  const clean=[...new Set(tags.map(t=>String(t??'').trim().toLowerCase().slice(0,40)).filter(Boolean))].slice(0,10);
  transaction(()=>{run('DELETE FROM chat_tags WHERE chat_id=?',[id]);for(const t of clean)run('INSERT INTO chat_tags VALUES(?,?)',[id,t]);});});
 ipcMain.handle('chats:bookmark-message',(_e,id:string,bookmarked:boolean)=>{if(typeof id!=='string')return;run('UPDATE messages SET bookmarked=? WHERE id=?',[bookmarked?1:0,id]);});
 ipcMain.handle('folders:list',()=>query('SELECT id,name,created_at as createdAt FROM folders ORDER BY created_at'));
 ipcMain.handle('folders:create',(_e,name:string)=>{
  if(typeof name!=='string')throw new Error('Invalid folder name');
  const clean=name.trim().slice(0,60);if(!clean)throw new Error('Invalid folder name');
  const folder:Folder={id:randomUUID(),name:clean,createdAt:Date.now()};
  run('INSERT INTO folders VALUES(?,?,?)',[folder.id,folder.name,folder.createdAt]);
  return folder;
 });
 ipcMain.handle('folders:rename',(_e,id:string,name:string)=>{if(typeof id!=='string'||typeof name!=='string')return;const clean=name.trim().slice(0,60);if(!clean)return;run('UPDATE folders SET name=? WHERE id=?',[clean,id]);});
 // Deleting a folder never deletes its chats — they fall back to the ungrouped list.
 ipcMain.handle('folders:delete',(_e,id:string)=>{if(typeof id!=='string')return;
  transaction(()=>{run('UPDATE chats SET folder_id=NULL WHERE folder_id=?',[id]);run('DELETE FROM folders WHERE id=?',[id]);});});
 // Delete children explicitly instead of relying on ON DELETE CASCADE: sql.js resets
 // the foreign_keys pragma on every export() (see db.flush), so a cascade can silently
 // not fire and leave the whole conversation text on disk after the user "permanently
 // removed" it. All deletes are one transaction so a failure cannot half-erase a chat.
 ipcMain.handle('chats:delete',(_e,id:string)=>{if(typeof id!=='string')return;
 const files=attachmentFiles(query('SELECT id FROM messages WHERE chat_id=?',[id]).map(r=>String(r.id)));
 transaction(()=>{
  run('DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE chat_id=?)',[id]);
  run('DELETE FROM message_variants WHERE message_id IN (SELECT id FROM messages WHERE chat_id=?)',[id]);
  run('DELETE FROM messages WHERE chat_id=?',[id]);
  run('DELETE FROM chat_tags WHERE chat_id=?',[id]);
  run('DELETE FROM file_ops WHERE chat_id=?',[id]);
  run('DELETE FROM chats WHERE id=?',[id]);
 });
 removeAttachmentFiles(files);});
 ipcMain.handle('chats:messages',(_e,id:string)=>{if(typeof id!=='string')return[];return listMessages(id);});
 ipcMain.handle('chats:delete-message',(_e,id:string,chatId:string)=>{if(typeof id!=='string'||typeof chatId!=='string')return;
 const files=attachmentFiles([id]);
 transaction(()=>{
  run('DELETE FROM attachments WHERE message_id=?',[id]);
  run('DELETE FROM message_variants WHERE message_id=?',[id]);
  run('DELETE FROM messages WHERE id=? AND chat_id=?',[id,chatId]);
 });
 removeAttachmentFiles(files);});
 ipcMain.handle('chats:variants',(_e,messageId:string)=>{if(typeof messageId!=='string')return[];return query('SELECT id,message_id as messageId,content,reasoning,created_at as createdAt,prompt_tokens as promptTokens,completion_tokens as completionTokens FROM message_variants WHERE message_id=? ORDER BY created_at',[messageId]);});
 // Swap a stored variant back in as the live answer, archiving the current text so
 // nothing is lost either way.
 ipcMain.handle('chats:restore-variant',(_e,variantId:string)=>{
  if(typeof variantId!=='string')throw new Error('Invalid variant');
  const v=one('SELECT * FROM message_variants WHERE id=?',[variantId]) as {message_id:string;content:string;reasoning:string|null}|undefined;
  if(!v)throw new Error('Variant not found');
  const msg=one('SELECT id,content,reasoning,created_at,prompt_tokens,completion_tokens FROM messages WHERE id=?',[v.message_id]) as {id:string;content:string;reasoning:string|null;created_at:number;prompt_tokens:number|null;completion_tokens:number|null}|undefined;
  if(!msg)throw new Error('Message not found');
  transaction(()=>{
   run('INSERT INTO message_variants(id,message_id,content,reasoning,created_at,prompt_tokens,completion_tokens) VALUES(?,?,?,?,?,?,?)',[randomUUID(),msg.id,msg.content,msg.reasoning,msg.created_at,msg.prompt_tokens,msg.completion_tokens]);
   run('UPDATE messages SET content=?,reasoning=? WHERE id=?',[v.content,v.reasoning,v.message_id]);
   run('DELETE FROM message_variants WHERE id=?',[variantId]);
  });
  const chatId=(one('SELECT chat_id FROM messages WHERE id=?',[v.message_id]) as {chat_id:string}|undefined)?.chat_id;
  return chatId?listMessages(chatId):[];
 });
 // Fork a conversation at any message: the new chat gets everything up to and
 // including that message (variants and attachment copies included), then stands
 // alone — later edits in either chat never affect the other.
 ipcMain.handle('chats:branch',(_e,chatId:string,messageId:string)=>{
  if(typeof chatId!=='string'||typeof messageId!=='string')throw new Error('Invalid branch request');
  const chat=one('SELECT title,provider_id,model,folder_id,workspace,workspace_readonly FROM chats WHERE id=?',[chatId]) as {title:string;provider_id:string;model:string;folder_id:string|null;workspace:string|null;workspace_readonly:number}|undefined;
  const cut=one('SELECT created_at FROM messages WHERE id=? AND chat_id=?',[messageId,chatId]) as {created_at:number}|undefined;
  if(!chat||!cut)throw new Error('Nothing to branch from');
  const id=randomUUID(),now=Date.now(),title=chat.title.slice(0,92)+' (branch)';
  const msgs=query('SELECT * FROM messages WHERE chat_id=? AND created_at<=? ORDER BY created_at',[chatId,cut.created_at]) as Array<Record<string,unknown>&{id:string}>;
  const variants=query('SELECT v.* FROM message_variants v JOIN messages m ON m.id=v.message_id WHERE m.chat_id=? AND m.created_at<=?',[chatId,cut.created_at]) as Array<Record<string,unknown>&{message_id:string}>;
  const idMap=new Map<string,string>();
  transaction(()=>{
   run('INSERT INTO chats(id,title,provider_id,model,updated_at,branched_from,folder_id,workspace,workspace_readonly) VALUES(?,?,?,?,?,?,?,?,?)',[id,title,chat.provider_id,chat.model,now,chatId,chat.folder_id,chat.workspace,chat.workspace_readonly]);
   for(const m of msgs){
    const nid=randomUUID();idMap.set(m.id,nid);
    run('INSERT INTO messages(id,chat_id,role,content,created_at,model,provider_id,prompt_tokens,completion_tokens,reasoning,finish_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
     [nid,id,m.role,m.content,m.created_at,m.model??null,m.provider_id??null,m.prompt_tokens??null,m.completion_tokens??null,m.reasoning??null,m.finish_reason??null]);
    const atts=query('SELECT id,name,mime,size,created_at FROM attachments WHERE message_id=?',[m.id]) as Array<{id:string;name:string;mime:string;size:number;created_at:number}>;
    for(const a of atts){
     const aid=randomUUID();
     try{fs.mkdirSync(attachmentsDir(),{recursive:true});fs.copyFileSync(path.join(attachmentsDir(),a.id),path.join(attachmentsDir(),aid));}
     catch{continue;} // a lost file must not abort the whole branch
     run('INSERT INTO attachments VALUES(?,?,?,?,?,?)',[aid,nid,a.name,a.mime,a.size,a.created_at]);
    }
   }
   for(const v of variants){
    const nid=idMap.get(v.message_id);if(!nid)continue;
    run('INSERT INTO message_variants VALUES(?,?,?,?,?,?,?)',[randomUUID(),nid,v.content,v.reasoning??null,v.created_at,v.prompt_tokens??null,v.completion_tokens??null]);
   }
  });
  return {id,title,providerId:chat.provider_id,model:chat.model,updatedAt:now,branchedFrom:chatId,folderId:chat.folder_id,workspace:chat.workspace,workspaceReadonly:chat.workspace_readonly};
 });
 ipcMain.handle('chats:usage-summary',()=>{
  // JOIN chats so messages orphaned by pre-fix deletes (cascades silently not firing
  // in sql.js) stop counting toward lifetime usage after their chat was deleted.
  const byModel=query("SELECT m.provider_id as providerId,m.model,COUNT(*) as messages,COALESCE(SUM(m.prompt_tokens),0) as promptTokens,COALESCE(SUM(m.completion_tokens),0) as completionTokens FROM messages m JOIN chats c ON c.id=m.chat_id WHERE m.role='assistant' GROUP BY m.provider_id,m.model ORDER BY completionTokens DESC");
  const t=one("SELECT COUNT(*) as messages,COALESCE(SUM(m.prompt_tokens),0) as promptTokens,COALESCE(SUM(m.completion_tokens),0) as completionTokens FROM messages m JOIN chats c ON c.id=m.chat_id WHERE m.role='assistant'");
  const num=(v:unknown)=>Number(v??0);
  const rows:UsageRow[]=byModel.map(r=>({providerId:(r.providerId as string|null)??null,model:(r.model as string|null)??null,messages:num(r.messages),promptTokens:num(r.promptTokens),completionTokens:num(r.completionTokens)}));
  const summary:UsageSummary={messages:num(t?.messages),promptTokens:num(t?.promptTokens),completionTokens:num(t?.completionTokens),byModel:rows};
  return summary;
 });
 // Global search with filters: text + optional date range, model, role, folder, tag.
 // Every condition is parameterized; LIKE wildcards in the query are escaped.
 ipcMain.handle('chats:search',(_e,f:SearchFilters)=>{
  if(!f||typeof f!=='object')return[];
  const term=typeof f.query==='string'?f.query.trim().slice(0,200):'';
  const cond:string[]=[];const params:unknown[]=[];
  if(term){cond.push("m.content LIKE ? ESCAPE '\\'");params.push('%'+term.replace(/[\\%_]/g,m=>'\\'+m)+'%');}
  if(typeof f.from==='number'&&Number.isFinite(f.from)){cond.push('m.created_at>=?');params.push(f.from);}
  if(typeof f.to==='number'&&Number.isFinite(f.to)){cond.push('m.created_at<=?');params.push(f.to);}
  if(typeof f.model==='string'&&f.model){cond.push('m.model=?');params.push(f.model.slice(0,200));}
  if(f.role==='user'||f.role==='assistant'){cond.push('m.role=?');params.push(f.role);}
  if(typeof f.folderId==='string'&&f.folderId){cond.push('c.folder_id=?');params.push(f.folderId);}
  if(typeof f.tag==='string'&&f.tag){cond.push('EXISTS(SELECT 1 FROM chat_tags t WHERE t.chat_id=c.id AND t.tag=?)');params.push(f.tag.slice(0,40));}
  if(!cond.length)return[];
  const rows=query(`SELECT m.id as messageId,m.chat_id as chatId,c.title as title,m.content as content,m.role as role,m.model as model,m.created_at as createdAt FROM messages m JOIN chats c ON c.id=m.chat_id WHERE ${cond.join(' AND ')} ORDER BY m.created_at DESC LIMIT 100`,params) as Array<{messageId:string;chatId:string;title:string;content:string;role:string;model:string|null;createdAt:number}>;
  const needle=term.toLowerCase();
  // Only the surrounding snippet crosses the IPC boundary, not whole messages.
  // messageId lets the renderer scroll straight to the hit and highlight it.
  return rows.map(({messageId,chatId,title,content,role,model,createdAt})=>{const idx=needle?content.toLowerCase().indexOf(needle):0;return{messageId,chatId,title,role,model,createdAt,snippet:idx<0?content.slice(0,160):content.slice(Math.max(0,idx-60),idx+term.length+100)};});
 });
 ipcMain.handle('chats:export',async(_e,id:string,format:'md'|'json')=>{
  if(typeof id!=='string'||(format!=='md'&&format!=='json'))return null;
  const chat=one('SELECT * FROM chats WHERE id=?',[id]) as {title:string}|undefined;if(!chat)return null;
  const msgs=query('SELECT role,content FROM messages WHERE chat_id=? ORDER BY created_at',[id]) as Array<{role:string;content:string}>;
  const text=format==='json'?JSON.stringify({chat,messages:msgs},null,2):'# '+chat.title+'\n\n'+msgs.map(m=>'## '+(m.role==='user'?'You':'Assistant')+'\n\n'+m.content).join('\n\n---\n\n');
  const result=await dialog.showSaveDialog(win,{defaultPath:'lumen-chat.'+format,filters:[{name:format==='json'?'JSON':'Markdown',extensions:[format]}]});
  if(!result.filePath)return null; // user cancelled
  const target=result.filePath.toLowerCase().endsWith('.'+format)?result.filePath:result.filePath+'.'+format;
  try{fs.writeFileSync(target,text,'utf8');return target;}
  catch(e){throw new Error('Could not write file: '+(e instanceof Error?e.message:'unknown'),{cause:e});}
 });
 // HTML/PDF export: the renderer builds a styled standalone HTML document (its
 // markdown pipeline is already there); main only persists it or prints to PDF.
 ipcMain.handle('chats:export-prepared',async(_e,id:string,format:'html'|'pdf',html:string)=>{
  if(typeof id!=='string'||(format!=='html'&&format!=='pdf')||typeof html!=='string'||!html||html.length>5*1024*1024)return null;
  const chat=one('SELECT title FROM chats WHERE id=?',[id]) as {title:string}|undefined;if(!chat)return null;
  const safeName=(chat.title.replace(/[\\/:*?"<>|]/g,'').trim()||'lumen-chat').slice(0,60);
  const result=await dialog.showSaveDialog(win,{defaultPath:safeName+'.'+format,filters:[{name:format==='pdf'?'PDF':'HTML',extensions:[format]}]});
  if(!result.filePath)return null;
  const target=result.filePath.toLowerCase().endsWith('.'+format)?result.filePath:result.filePath+'.'+format;
  try{
   if(format==='html'){fs.writeFileSync(target,html,'utf8');return target;}
   // printToPDF needs a real web contents; use a hidden offscreen window so the
   // document never touches the visible UI.
   const printWin=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
   try{
    await printWin.loadURL('data:text/html;base64,'+Buffer.from(html,'utf8').toString('base64'));
    const pdf=await printWin.webContents.printToPDF({printBackground:true});
    fs.writeFileSync(target,pdf);
    return target;
   }finally{printWin.destroy();}
  }catch(e){throw new Error('Could not export: '+(e instanceof Error?e.message:'unknown'),{cause:e});}
 });
 // Summarize: one mini-request over the transcript; the renderer offers to start a
 // fresh chat from the result (the original history is never modified here).
 ipcMain.handle('chats:summarize',async(_e,id:string)=>{
  if(typeof id!=='string')throw new Error('Invalid chat');
  const chat=one('SELECT provider_id as providerId,model FROM chats WHERE id=?',[id]) as {providerId:ProviderId;model:string}|undefined;
  if(!chat)throw new Error('Chat not found');
  const msgs=query("SELECT role,content FROM messages WHERE chat_id=? ORDER BY created_at",[id]) as Array<{role:string;content:string}>;
  if(msgs.length<4)throw new Error('The chat is too short to need a summary');
  const transcript=msgs.map(m=>(m.role==='user'?'User':'Assistant')+': '+m.content).join('\n\n').slice(0,60000);
  const p=getProvider(chat.providerId);
  const raw=await miniRequest(p,chat.model,'Summarize this conversation so work can continue in a fresh chat. Include: the goal, decisions made, key facts/code changes, and what remains to do. Be compact (under 300 words).\n\n'+transcript,2048);
  const out=raw.trim();
  if(!out)throw new Error('The provider returned nothing usable — try again');
  return out;
 });
 // Per-day token usage for the statistics view, with cost from provider pricing.
 ipcMain.handle('chats:usage-by-day',()=>{
  const rows=query("SELECT date(m.created_at/1000,'unixepoch','localtime') as day,m.provider_id as providerId,m.model,COALESCE(SUM(m.prompt_tokens),0) as promptTokens,COALESCE(SUM(m.completion_tokens),0) as completionTokens FROM messages m JOIN chats c ON c.id=m.chat_id WHERE m.role='assistant' GROUP BY day,m.provider_id,m.model ORDER BY day") as Array<{day:string;providerId:string|null;model:string|null;promptTokens:number;completionTokens:number}>;
  const pricingByProvider=new Map<string,Record<string,{input:number;output:number}>>();
  for(const p of query('SELECT id,pricing FROM providers') as Array<{id:string;pricing:string|null}>){
   try{pricingByProvider.set(p.id,p.pricing?JSON.parse(p.pricing):{});}catch{pricingByProvider.set(p.id,{});}
  }
  const byDay=new Map<string,DayUsage>();
  for(const r of rows){
   const d=byDay.get(r.day)??{day:r.day,promptTokens:0,completionTokens:0,cost:0};
   d.promptTokens+=Number(r.promptTokens);d.completionTokens+=Number(r.completionTokens);
   const price=r.providerId&&r.model?pricingByProvider.get(r.providerId)?.[r.model]:undefined;
   if(price)d.cost+=(Number(r.promptTokens)*price.input+Number(r.completionTokens)*price.output)/1e6;
   byDay.set(r.day,d);
  }
  return [...byDay.values()];
 });
 // Read a workspace file for the renderer (@file mention preview). Same jail rules
 // as the model's tools — the renderer is equally untrusted with paths.
 ipcMain.handle('chats:read-workspace-file',(_e,id:string,rel:string)=>{
  if(typeof id!=='string'||typeof rel!=='string')return null;
  const chat=one('SELECT workspace FROM chats WHERE id=?',[id]) as {workspace:string|null}|undefined;
  if(!chat?.workspace)return null;
  try{return readWorkspaceFile(chat.workspace,rel);}catch{return null;}
 });
 ipcMain.handle('chats:todos',(_e,id:string)=>{
  if(typeof id!=='string')return[];
  const row=one('SELECT todos FROM chats WHERE id=?',[id]) as {todos:string|null}|undefined;
  try{return row?.todos?normalizeTodos(JSON.parse(row.todos)):[];}catch{return [];}
 });
 ipcMain.handle('chats:file-ops',(_e,id:string)=>{
  if(typeof id!=='string')return[];
  return query('SELECT id,chat_id as chatId,tool,path,status,detail,snapshot,created_at as createdAt FROM file_ops WHERE chat_id=? ORDER BY created_at DESC LIMIT 200',[id]) as unknown as FileOp[];
 });
 // Rollback: copy the pre-change snapshot back over the workspace file.
 ipcMain.handle('chats:rollback-op',(_e,opId:string)=>{
  if(typeof opId!=='string')return{ok:false,message:'Invalid operation'};
  const op=one('SELECT id,chat_id as chatId,path,snapshot FROM file_ops WHERE id=?',[opId]) as {id:string;chatId:string;path:string|null;snapshot:string|null}|undefined;
  if(!op?.snapshot||!op.path)return{ok:false,message:'No backup was kept for this operation'};
  const chat=one('SELECT workspace FROM chats WHERE id=?',[op.chatId]) as {workspace:string|null}|undefined;
  if(!chat?.workspace)return{ok:false,message:'The chat has no workspace folder'};
  try{
   const rel=restoreSnapshot(chat.workspace,op.snapshot);
   run('INSERT INTO file_ops VALUES(?,?,?,?,?,?,?,?)',[randomUUID(),op.chatId,'rollback',op.path,'ok','Restored from backup',null,Date.now()]);
   return{ok:true,message:'Restored '+rel};
  }catch(e){return{ok:false,message:e instanceof Error?e.message:'Rollback failed'};}
 });
 ipcMain.handle('providers:list',()=>query('SELECT id,name,base_url as baseUrl,models,pricing,(SELECT COUNT(*) FROM secrets s WHERE s.id=providers.id)>0 AS hasKey FROM providers').map((v)=>{const p=v as {models:string;pricing:string|null;hasKey:number};let pricing:ProviderConfig['pricing'];try{pricing=p.pricing?JSON.parse(p.pricing):undefined;}catch{pricing=undefined;}return{...v,models:JSON.parse(p.models),pricing,hasKey:Number(p.hasKey)>0};}));
 ipcMain.handle('providers:save',(_e,c:unknown,key?:string)=>{const config=validateProviderConfig(c,PINNED_URLS);run('INSERT INTO providers(id,name,base_url,models,pricing) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,base_url=excluded.base_url,models=excluded.models,pricing=excluded.pricing',[config.id,config.name,config.baseUrl,JSON.stringify(config.models),JSON.stringify(config.pricing??{})]);if(typeof key==='string'&&key){if(!safeStorage.isEncryptionAvailable())throw new Error('Windows secure storage unavailable');run('INSERT OR REPLACE INTO secrets VALUES(?,?)',[config.id,safeStorage.encryptString(key)]);}});
 ipcMain.handle('providers:remove',(_e,id:ProviderId)=>{if(!isKnownProviderId(id))return;run('DELETE FROM secrets WHERE id=?',[id]);if(id==='custom')run('DELETE FROM providers WHERE id=?',[id]);});
 ipcMain.handle('settings:get',()=>{const rows=query('SELECT key,value FROM settings') as Array<{key:string;value:string}>;const v=Object.fromEntries(rows.map(x=>[x.key,JSON.parse(x.value)]));return{theme:v.theme??'dark',systemPrompt:v.systemPrompt??'',temperature:v.temperature??0.7,maxTokens:v.maxTokens??2048,topP:v.topP??1,minimizeToTray:v.minimizeToTray===true,autoStart:v.autoStart===true,notifications:v.notifications===true,accent:v.accent??'violet',personas:Array.isArray(v.personas)?v.personas:[],personaId:typeof v.personaId==='string'?v.personaId:'',hotkeys:normalizeHotkeys(v.hotkeys),templates:Array.isArray(v.templates)?v.templates:[],defaultWorkspace:typeof v.defaultWorkspace==='string'?v.defaultWorkspace:'',customCss:typeof v.customCss==='string'?v.customCss:'',compactMode:v.compactMode===true};});ipcMain.handle('settings:save',(_e,s:Record<string,unknown>)=>{if(!s||typeof s!=='object')return;const clamped=clampSettings(s);for(const[k,v]of Object.entries(clamped))run('INSERT OR REPLACE INTO settings VALUES(?,?)',[k,JSON.stringify(v)]);if(clamped.theme)nativeTheme.themeSource=clamped.theme as 'dark'|'light';
  // Side effects of system settings are applied here, not at next launch.
  if('autoStart' in clamped)app.setLoginItemSettings({openAtLogin:clamped.autoStart===true});
  if('minimizeToTray' in clamped)setTray(clamped.minimizeToTray===true);});
 ipcMain.handle('providers:test',async(_e,id:ProviderId)=>{if(!isKnownProviderId(id))return{ok:false,message:'Unknown provider'};try{await loadModels(id);return{ok:true,message:'Connection successful'};}catch(e){return{ok:false,message:e instanceof Error?e.message:'Connection failed'};}});ipcMain.handle('providers:models',(_e,id:ProviderId)=>{if(!isKnownProviderId(id))throw new Error('Unknown provider');return loadModels(id);});
 ipcMain.handle('chat:stop',(_e,requestId?:string)=>{if(typeof requestId!=='string'||!requestId)return{stopped:false};const entry=activeRequests.get(requestId);if(!entry)return{stopped:false};entry.controller.abort();return{stopped:true};});
 // Lets the renderer re-mark chats that are still streaming after a reload.
 ipcMain.handle('chat:status',()=>[...activeRequests.entries()].map(([requestId,s])=>({chatId:s.chatId,requestId})) as ActiveStream[]);
 ipcMain.handle('chat:send',(_e,r:unknown)=>generate(r,'send'));
 // Enhance Prompt (Kilo-style): rewrite the composer draft via the same mini-request
 // path as auto-titles. Fully validated — the renderer is untrusted.
 ipcMain.handle('prompt:enhance',async(_e,draft:unknown,providerId:unknown,model:unknown)=>{
  if(typeof draft!=='string'||!draft.trim()||draft.length>32768)throw new Error('Draft is empty or too long');
  if(!isKnownProviderId(providerId))throw new Error('Unknown provider');
  if(typeof model!=='string'||!model.trim()||model.length>200)throw new Error('No model selected');
  const p=getProvider(providerId);
  const raw=await miniRequest(p,model.trim(),ENHANCE_PROMPT+'\n\n'+draft.trim(),2048);
  const out=cleanEnhanced(raw,draft);
  if(!out)throw new Error('The provider returned nothing usable — try again');
  return out;
 });
 ipcMain.handle('chat:continue',(_e,r:unknown)=>generate(r,'continue'));
 ipcMain.handle('chat:regenerate',(_e,r:unknown)=>generate(r,'regenerate'));
 ipcMain.handle('data:health',()=>({ok:!lastPersistError(),persistError:lastPersistError()}));
 ipcMain.handle('data:wipe',()=>{transaction(()=>{run('DELETE FROM attachments');run('DELETE FROM message_variants');run('DELETE FROM messages');run('DELETE FROM chats');run('DELETE FROM folders');run('DELETE FROM chat_tags');run('DELETE FROM file_ops');run("DELETE FROM settings WHERE key!='windowBounds'");});saveNow();try{fs.rmSync(attachmentsDir(),{recursive:true,force:true});}catch{}});
 ipcMain.handle('data:open-folder',()=>shell.openPath(app.getPath('userData')));
 // Backup: copy the database + attachment files into a user-picked folder. The DB
 // is flushed first so the copy is consistent.
 ipcMain.handle('data:backup',async()=>{
  const result=await dialog.showOpenDialog(win,{title:'Choose where to save the backup',properties:['openDirectory','createDirectory']});
  if(result.canceled||!result.filePaths[0])return null;
  saveNow();
  const stamp=new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
  const dest=path.join(path.resolve(result.filePaths[0]),'lumen-backup-'+stamp);
  try{
   fs.mkdirSync(path.join(dest,'attachments'),{recursive:true});
   fs.copyFileSync(path.join(app.getPath('userData'),'lumen.sqlite'),path.join(dest,'lumen.sqlite'));
   const src=attachmentsDir();
   if(fs.existsSync(src))for(const f of fs.readdirSync(src))fs.copyFileSync(path.join(src,f),path.join(dest,'attachments',f));
   return dest;
  }catch(e){throw new Error('Backup failed: '+(e instanceof Error?e.message:'unknown'),{cause:e});}
 });
 // Restore: replace the database with a picked file, then relaunch so every open
 // handle starts from the restored bytes. Attachments are NOT auto-restored (they
 // live next to the backup file; the user can copy them manually if needed).
 ipcMain.handle('data:restore',async()=>{
  const result=await dialog.showOpenDialog(win,{title:'Choose a lumen.sqlite backup file',properties:['openFile'],filters:[{name:'Lumen backup',extensions:['sqlite']}]});
  if(result.canceled||!result.filePaths[0])return false;
  const src=path.resolve(result.filePaths[0]);
  const bytes=fs.readFileSync(src);
  if(bytes.length<100||bytes.toString('utf8',0,15)!=='SQLite format 3')throw new Error('That file is not a SQLite database');
  const confirm=await dialog.showMessageBox(win,{type:'warning',buttons:['Restore and restart','Cancel'],defaultId:1,cancelId:1,title:'Restore backup',message:'Replace ALL current data with this backup?',detail:'The app restarts afterwards. Your current database is kept as lumen.sqlite.pre-restore.'});
  if(confirm.response!==0)return false;
  saveNow();
  const target=path.join(app.getPath('userData'),'lumen.sqlite');
  try{fs.copyFileSync(target,target+'.pre-restore');}catch{}
  fs.copyFileSync(src,target);
  app.relaunch();app.exit(0);
  return true;
 });
 ipcMain.on('window:always-on-top',(_e,on:unknown)=>{if(win&&!win.isDestroyed())win.setAlwaysOnTop(on===true);});
}
function getProvider(id:ProviderId):ResolvedProvider{const p=one('SELECT * FROM providers WHERE id=?',[id]) as {id:string;name:string;base_url:string}|undefined;if(!p)throw new Error('Provider not configured');const secret=one('SELECT value FROM secrets WHERE id=?',[id]) as {value:Buffer}|undefined;let key='';if(secret){try{key=safeStorage.decryptString(secret.value);}catch{throw new Error('Saved API key could not be decrypted on this device. Re-enter it in Settings.');}}else if(!isLoopbackUrl(p.base_url))throw new Error('Add an API key for '+p.name+' in Settings');return{id:p.id as ProviderId,name:p.name,url:p.base_url.replace(/\/$/,''),key};}
async function loadModels(id:ProviderId){const p=getProvider(id);const{url,headers}=buildModelsRequest(p);const response=await fetch(url,{headers,signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('HTTP '+response.status);const data=await response.json() as {data?:Array<{id?:string}>;models?:Array<{name?:string}>};return data.data?data.data.map(x=>x.id??'').filter(Boolean):((data.models??[]).map(x=>x.name??'').filter(Boolean));}

type GenMode='send'|'continue'|'regenerate';
async function generate(raw:unknown,mode:GenMode){
 const r=validateChatRequest(raw);
 const p=getProvider(r.providerId);const controller=new AbortController();activeRequests.set(r.requestId,{controller,chatId:r.chatId});const signal=controller.signal;
 // A chat deleted mid-generation must not throw a foreign-key error at the user.
 if(!one('SELECT id FROM chats WHERE id=?',[r.chatId])){activeRequests.delete(r.requestId);throw new Error('Conversation no longer exists');}
 const rows=query('SELECT id,role,content,created_at FROM messages WHERE chat_id=? ORDER BY created_at',[r.chatId]) as Array<{id:string;role:string;content:string;created_at:number}>;
 let history:HistoryMessage[];let updateId:string|null=null;let prependText='';
 if(mode==='send'){
  if(!r.content.trim()&&!r.attachments?.length){activeRequests.delete(r.requestId);throw new Error('Message is empty');}
  // Edit-and-resend: delete this message and everything after it as part of THIS
  // request. Doing it in a separate IPC call before sending meant a rejected send
  // (cleared model, undecryptable key, network failure) destroyed the tail for good.
  if(r.truncateFromMessageId){
   const cut=one('SELECT created_at FROM messages WHERE id=? AND chat_id=?',[r.truncateFromMessageId,r.chatId]) as {created_at:number}|undefined;
   if(!cut){activeRequests.delete(r.requestId);throw new Error('Nothing to edit');}
   const doomed=attachmentFiles(query('SELECT id FROM messages WHERE chat_id=? AND created_at>=?',[r.chatId,cut.created_at]).map(x=>String(x.id)));
   transaction(()=>{
    run('DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE chat_id=? AND created_at>=?)',[r.chatId,cut.created_at]);
    run('DELETE FROM message_variants WHERE message_id IN (SELECT id FROM messages WHERE chat_id=? AND created_at>=?)',[r.chatId,cut.created_at]);
    run('DELETE FROM messages WHERE chat_id=? AND created_at>=?',[r.chatId,cut.created_at]);
   });
   removeAttachmentFiles(doomed);
   rows.length=0;
   rows.push(...query('SELECT id,role,content,created_at FROM messages WHERE chat_id=? ORDER BY created_at',[r.chatId]) as Array<{id:string;role:string;content:string;created_at:number}>);
  }
  history=normalizeHistory(trimHistory([...rows.map(x=>({role:x.role,content:x.content,images:messageImages(x.id)})),{role:'user',content:r.content,images:r.attachments?.length?r.attachments.map(a=>({mime:a.mime,data:a.data})):undefined}]));
  // Regenerate/edit re-sends an already-stored prompt; don't duplicate the row.
  if(!r.skipUserPersist){
   const msgId=randomUUID();
   // Message row and its attachment rows/files land together, or not at all.
   transaction(()=>{
    run('INSERT INTO messages(id,chat_id,role,content,created_at,model,provider_id) VALUES(?,?,?,?,?,?,?)',[msgId,r.chatId,'user',r.content,Date.now(),r.model,r.providerId]);
    if(r.attachments?.length){
     fs.mkdirSync(attachmentsDir(),{recursive:true});
     for(const a of r.attachments){
      const aid=randomUUID();const buf=Buffer.from(a.data,'base64');
      fs.writeFileSync(path.join(attachmentsDir(),aid),buf);
      run('INSERT INTO attachments VALUES(?,?,?,?,?,?)',[aid,msgId,a.name,a.mime,buf.length,Date.now()]);
     }
    }
   });
  }
  // CASE guard: an image-only send has empty content — don't blank the title.
  run("UPDATE chats SET title=CASE WHEN title=? AND ?<>'' THEN ? ELSE title END,provider_id=?,model=?,updated_at=? WHERE id=?",['New conversation',r.content.replace(/\s+/g,' ').trim().slice(0,48),r.content.replace(/\s+/g,' ').trim().slice(0,48),r.providerId,r.model,Date.now(),r.chatId]);
 }else{
  const targetId=mode==='continue'?r.continueMessageId:r.regenerateMessageId;
  const at=rows.findIndex(x=>x.id===targetId&&x.role==='assistant');
  if(at<0){activeRequests.delete(r.requestId);throw new Error('Nothing to '+mode);}
  updateId=rows[at].id;const before=rows.slice(0,at);
  if(mode==='continue'){
   prependText=rows[at].content;
   const beforeTurns=before.map(x=>({role:x.role,content:x.content,images:messageImages(x.id)}));
   // trimHistory first: Continue is used on long chats that hit the token limit, and
   // sending the whole unbounded transcript overflows the context window with a 400.
   // The partial (and, for non-Anthropic, the instruction) sit at the end, so a trim
   // that keeps the most recent turns never drops them.
   const continueInstruction='Continue your previous answer from exactly where it stopped. Do not repeat anything already written.';
   if(p.id==='anthropic'){
    // Anthropic prefills from a trailing assistant turn.
    history=normalizeHistory(trimHistory([...beforeTurns,{role:'assistant',content:prependText}]),{allowTrailingAssistant:true});
   }else{
    // Others have no prefill: show the partial as context, then ask to continue.
    history=normalizeHistory(trimHistory([...beforeTurns,{role:'assistant',content:prependText},{role:'user',content:continueInstruction}]));
   }
  }else{
   history=normalizeHistory(trimHistory(before.map(x=>({role:x.role,content:x.content,images:messageImages(x.id)}))));
   run('UPDATE chats SET updated_at=? WHERE id=?',[Date.now(),r.chatId]);
  }
 }
 const assistantId=randomUUID();let answer='';let reasoning='';let usage:{promptTokens:number;completionTokens:number}|null=null;let finish:FinishReason=null;let timedOut=false;let watchdog:NodeJS.Timeout|null=null;
 // Any chunk (or stream end) re-arms the watchdog; firing it aborts the request.
 const armWatchdog=()=>{if(watchdog)clearTimeout(watchdog);watchdog=setTimeout(()=>{timedOut=true;controller.abort();},STREAM_IDLE_MS);};
 try{
  armWatchdog();
  // A chat with a workspace folder gives the model file tools (OpenCode-style).
  // The workspace comes from OUR chats row (falling back to the default workspace
  // from Settings), not the request — the renderer cannot turn tools on by itself.
  const chatRow=one('SELECT workspace,workspace_readonly FROM chats WHERE id=?',[r.chatId]) as {workspace:string|null;workspace_readonly:number}|undefined;
  let workspace=chatRow?.workspace||null;
  if(!workspace){
   const def=one("SELECT value FROM settings WHERE key='defaultWorkspace'") as {value:string}|undefined;
   try{const d=def?JSON.parse(def.value):'';if(typeof d==='string'&&d&&fs.existsSync(d)&&fs.statSync(d).isDirectory())workspace=path.resolve(d);}catch{}
  }
  const workspaceReadonly=!!chatRow?.workspace_readonly;
  const tools=workspace?TOOL_DEFS:undefined;
  let sysPrompt=r.systemPrompt;
  if(workspace){
   sysPrompt=(sysPrompt?sysPrompt+'\n\n':'')+WORKSPACE_PROMPT+'\nWorkspace root: '+workspace;
   // Project rules (LUMEN.md, AGENTS.md-style) and a compact tree are attached on
   // the FIRST message only — re-sending them every turn would waste context.
   try{const rulesPath=path.join(workspace,'LUMEN.md');if(fs.existsSync(rulesPath))sysPrompt+='\n\nProject rules (LUMEN.md):\n'+fs.readFileSync(rulesPath,'utf8').slice(0,8192);}catch{}
   if(!rows.length){try{sysPrompt+='\n\nProject tree:\n'+listFiles(workspace);}catch{}}
   if(workspaceReadonly)sysPrompt+='\n\nREAD-ONLY MODE: the user has disabled all write/edit/command tools for this chat. Read, search and advise only.';
  }
  // Every mutation/command/fetch passes through this native dialog. Writes include
  // a diff preview so the user sees WHAT changes, not just where.
  const approve:ApproveFn=async req=>{
   if(!win||win.isDestroyed())return false;
   if(win.isMinimized())win.restore();win.show();win.focus();
   const titles:Record<string,string>={write:'File write request',delete:'Delete request',move:'Move request',command:'Command request',commit:'Git commit request',web:'Web access request'};
   const verbs:Record<string,string>={write:'write/edit this file',delete:'delete',move:'move',command:'run this command in the workspace',commit:'create a git commit',web:'fetch a web page from this domain'};
   const res=await dialog.showMessageBox(win,{type:'question',buttons:['Allow','Decline'],defaultId:0,cancelId:1,title:titles[req.kind]??'Approval request',message:`The model wants to ${verbs[req.kind]??'perform an action'}:`,detail:req.target+(req.detail?'\n\n'+req.detail:''),noLink:true});
   return res.response===0;
  };
  // The tool loop: stream one completion; if the model asked for tools, run them
  // (writes go through the approval dialog), feed results back, and continue with
  // the SAME wire history. Tool turns live only in memory — the DB keeps just the
  // final answer, with the tool log folded into the collapsible Thinking block.
  const wire:HistoryMessage[]=[...history];
  let rounds=0;let toolChars=0;
  const logOp=(tool:string,pathArg:string|null,status:'ok'|'error'|'declined',detail:string|null,snapshot:string|null)=>{
   try{run('INSERT INTO file_ops VALUES(?,?,?,?,?,?,?,?)',[randomUUID(),r.chatId,tool,pathArg,status,detail,snapshot,Date.now()]);}catch{}};
  for(;;){
   const{url,headers,body}=buildChatRequest(p,wire,{model:r.model,systemPrompt:sysPrompt,temperature:r.temperature,maxTokens:r.maxTokens,topP:r.topP,tools});
   const response=await fetch(url,{method:'POST',headers,body:JSON.stringify(body),signal});
   if(!response.ok){const detail=(await response.text()).slice(0,240);throw new Error(response.status===401?'Invalid API key (401)':response.status===403?'Access denied by provider (403): '+detail:response.status===429?'Rate limit reached (429): '+detail:'Provider error '+response.status+': '+detail);}
   if(!response.body)throw new Error('Streaming unavailable');
   const toolCalls=new Map<number,ToolCallRecord>();
   let roundText='';let geminiSeq=0;
   const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
   while(true){
    const result=await reader.read();if(result.done)break;armWatchdog();buffer+=decoder.decode(result.value,{stream:true});
    const lines=buffer.split(/\r?\n/);buffer=lines.pop()??'';
    for(const line of lines){
     const text=parseSseEvent(line);const thought=parseReasoningEvent(line);const fin=p.id==='anthropic'?parseAnthropicFinish(line):parseFinishReason(line);if(fin)finish=fin;if(p.id==='anthropic')usage=parseAnthropicUsage(line,usage);else usage=parseUsageEvent(line)??usage;if(text){answer+=text;roundText+=text;toRenderer('chat:chunk',{requestId:r.requestId,chatId:r.chatId,text});}if(thought){reasoning+=thought;toRenderer('chat:chunk',{requestId:r.requestId,chatId:r.chatId,text:'',reasoning:thought});}
     if(workspace){
      const events=p.id==='anthropic'?parseAnthropicToolEvent(line):p.id==='gemini'?parseGeminiToolCall(line,geminiSeq):parseToolCallDelta(line);
      for(const ev of events){
       if(ev.kind==='call-start')toolCalls.set(ev.index,{id:ev.id,name:ev.name,args:''});
       else if(ev.kind==='call-args'){const c=toolCalls.get(ev.index);if(c)c.args+=ev.chunk;}
       else if(ev.kind==='call-complete'){geminiSeq++;toolCalls.set(1000+geminiSeq,{id:ev.id,name:ev.name,args:ev.args});}
       // 'tool-stop' needs no action: accumulated calls alone drive the tool round.
      }
     }
    }
   }
   // Any accumulated call is honored even without an explicit tool-stop signal —
   // some OpenAI-compatible servers omit finish_reason entirely. The loop also
   // stops when tool output has eaten its context budget for this answer.
   const doToolRound=!!workspace&&toolCalls.size>0&&rounds<MAX_TOOL_ROUNDS&&toolChars<MAX_TOOL_BUDGET_CHARS&&!signal.aborted;
   if(!doToolRound)break;
   rounds++;
   wire.push({role:'assistant',content:roundText,toolCalls:[...toolCalls.values()]});
   const results:Array<{toolCallId:string;name:string;content:string}>=[];
   // The approval dialog can sit open for minutes — that's user think-time, not a
   // stalled stream, so the watchdog stands down while tools run.
   if(watchdog){clearTimeout(watchdog);watchdog=null;}
   for(const call of toolCalls.values()){
    let hint='';try{const a=JSON.parse(call.args||'{}') as Record<string,unknown>;hint=String(a.path??a.query??a.command??a.url??'').slice(0,120);}catch{}
    const note='\n🔧 **'+call.name+'**'+(hint?' `'+hint+'`':'')+'\n';
    reasoning+=note;
    toRenderer('chat:chunk',{requestId:r.requestId,chatId:r.chatId,text:'',reasoning:note,status:'Running '+call.name+'…'});
    const res=await runToolCall(workspace as string,call,approve,{readonly:workspaceReadonly});
    toolChars+=res.content.length;
    // todo_write updates the per-chat checklist: persist + mirror to the panel.
    if(call.name==='todo_write'&&!res.isError){
     try{const todos=normalizeTodos(JSON.parse(res.content));run('UPDATE chats SET todos=? WHERE id=?',[JSON.stringify(todos),r.chatId]);toRenderer('chats:todos',{chatId:r.chatId,todos});}catch{}
    }
    const opPath=res.path??(hint||null);
    if(res.isError)logOp(call.name,opPath,res.content.includes('declined')?'declined':'error',res.content.slice(0,500),null);
    else if(res.path||call.name==='run_command'||call.name==='git_commit'||call.name==='web_fetch'||call.name==='apply_patch')logOp(call.name,opPath,'ok',res.content.slice(0,500),res.snapshot??null);
    results.push({toolCallId:res.toolCallId,name:res.name,content:res.content});
   }
   toRenderer('chat:chunk',{requestId:r.requestId,chatId:r.chatId,text:'',status:''});
   wire.push({role:'user',content:'',toolResults:results});
   if(toolChars>=MAX_TOOL_BUDGET_CHARS){
    const note='\n⚠️ Tool output budget reached — finishing with what is already known.\n';
    reasoning+=note;toRenderer('chat:chunk',{requestId:r.requestId,chatId:r.chatId,text:'',reasoning:note});
    // One final round WITHOUT tools so the model can wrap up.
    const wrap:HistoryMessage={role:'user',content:'Tool output budget reached. Do not call any more tools — answer with what you have.'};
    wire.push(wrap);
    const finReq=buildChatRequest(p,wire,{model:r.model,systemPrompt:sysPrompt,temperature:r.temperature,maxTokens:r.maxTokens,topP:r.topP});
    const finRes=await fetch(finReq.url,{method:'POST',headers:finReq.headers,body:JSON.stringify(finReq.body),signal});
    if(finRes.ok&&finRes.body){
     const rd=finRes.body.getReader(),dec=new TextDecoder();let buf='';
     while(true){const rr=await rd.read();if(rr.done)break;armWatchdog();buf+=dec.decode(rr.value,{stream:true});const ls=buf.split(/\r?\n/);buf=ls.pop()??'';for(const line of ls){const text=parseSseEvent(line);const fin=p.id==='anthropic'?parseAnthropicFinish(line):parseFinishReason(line);if(fin)finish=fin;if(p.id==='anthropic')usage=parseAnthropicUsage(line,usage);else usage=parseUsageEvent(line)??usage;if(text){answer+=text;toRenderer('chat:chunk',{requestId:r.requestId,chatId:r.chatId,text});}}}
    }
    break;
   }
   armWatchdog();
  }
  const aborted=signal.aborted&&!timedOut;const empty=!answer.trim()&&!reasoning.trim();
  const emptyError=empty&&!aborted?(finish==='content_filter'?'The provider filtered this response':finish==='refusal'?'The model declined to answer':'Provider returned an empty response'):undefined;
  // Persist only when the chat still exists and there is something worth keeping.
  if(one('SELECT id FROM chats WHERE id=?',[r.chatId])){
   if(updateId){
    // Archive the outgoing answer as a variant first (regenerate) so it survives.
    if(mode==='regenerate'&&!empty)run('INSERT INTO message_variants(id,message_id,content,reasoning,created_at,prompt_tokens,completion_tokens) SELECT ?,id,content,reasoning,created_at,prompt_tokens,completion_tokens FROM messages WHERE id=?',[randomUUID(),updateId]);
    if(!empty)run('UPDATE messages SET content=?,reasoning=?,finish_reason=?,prompt_tokens=?,completion_tokens=?,model=?,provider_id=? WHERE id=?',[(mode==='continue'?prependText+answer:answer),reasoning||null,finish,usage?.promptTokens??null,usage?.completionTokens??null,r.model,r.providerId,updateId]);
   }else if(!empty){
    run('INSERT INTO messages(id,chat_id,role,content,created_at,model,provider_id,prompt_tokens,completion_tokens,reasoning,finish_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[assistantId,r.chatId,'assistant',answer,Date.now(),r.model,r.providerId,usage?.promptTokens??null,usage?.completionTokens??null,reasoning||null,finish]);
   }
   run('UPDATE chats SET updated_at=? WHERE id=?',[Date.now(),r.chatId]);
  }
  toRenderer('chat:chunk',{requestId:r.requestId,chatId:r.chatId,text:'',done:true,finishReason:finish,error:emptyError,promptTokens:usage?.promptTokens,completionTokens:usage?.completionTokens});
  if(win&&!win.isDestroyed()&&!win.isFocused())win.flashFrame(true);
  notifyCompletion(r.chatId,emptyError);
  if(mode==='send'&&!empty)void maybeAutoTitle(p,r.chatId,r.model,r.content,answer);
 }catch(error){
  log('generation failed',r.providerId,error instanceof Error?error.message:error);
  const aborted=signal.aborted&&!timedOut;
  // Keep a partial answer (send mode only) so the user does not lose what streamed.
  if(!updateId&&(answer||reasoning)&&one('SELECT id FROM chats WHERE id=?',[r.chatId]))run('INSERT INTO messages(id,chat_id,role,content,created_at,model,provider_id,prompt_tokens,completion_tokens,reasoning,finish_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[assistantId,r.chatId,'assistant',answer,Date.now(),r.model,r.providerId,usage?.promptTokens??null,usage?.completionTokens??null,reasoning||null,finish]);
  toRenderer('chat:chunk',{requestId:r.requestId,chatId:r.chatId,text:'',done:true,stopped:aborted,finishReason:finish,error:timedOut?'Provider stopped responding':aborted?'Generation stopped':error instanceof Error?error.message:'Network error'});
  if(!aborted)notifyCompletion(r.chatId,error instanceof Error?error.message:timedOut?'Provider stopped responding':undefined);
 }finally{if(watchdog)clearTimeout(watchdog);activeRequests.delete(r.requestId);}
}
// A second launch would hold a competing in-memory copy of the database and
// overwrite the first instance's data on exit, so focus the existing window.
if(!app.requestSingleInstanceLock())app.quit();else{
 app.on('second-instance',()=>{if(!win||win.isDestroyed())return;if(win.isMinimized())win.restore();win.focus();});
 app.whenReady().then(async()=>{
  app.setAppUserModelId('com.lumen.ai.desktop');
  await initDb();
  const st=dbStatus();
  // A file written by a newer schema must not be silently downgraded.
  if(st.newerVersion){dialog.showErrorBox('Database from a newer version',`This data file was written by schema v${st.newerVersion}, but this build understands v${SCHEMA_VERSION}. Please update Lumen to open it.`);app.quit();return;}
  initIpc();
  // Serve attachment bytes to <img> tags in the sandboxed renderer. Ids are uuids
  // from our own rows; the path can never escape attachmentsDir.
  protocol.handle('lumen-attachment',req=>{
   const id=decodeURIComponent(req.url.slice('lumen-attachment://'.length)).replace(/\/+$/,'');
   if(!/^[\w-]{1,64}$/.test(id))return new Response('bad id',{status:400});
   const row=one('SELECT mime FROM attachments WHERE id=?',[id]) as {mime:string}|undefined;
   if(!row)return new Response('not found',{status:404});
   try{return new Response(fs.readFileSync(path.join(attachmentsDir(),id)),{headers:{'content-type':row.mime}});}
   catch{return new Response('not found',{status:404});}
  });
  const traySetting=one("SELECT value FROM settings WHERE key='minimizeToTray'") as {value:string}|undefined;
  if(traySetting){try{if(JSON.parse(traySetting.value)===true)setTray(true);}catch{}}
  createWindow();log('ready');
  if(st.recovered)void dialog.showMessageBox(win,{type:'warning',title:'Database recovered',message:'Your previous database could not be read, so a fresh one was started.',detail:'The unreadable file was kept at:\n'+(st.backupPath??'(unknown)')+'\n\nSaved API keys are tied to that file and must be entered again.'});
  app.on('activate',()=>{if(!BrowserWindow.getAllWindows().length)createWindow();});
 }).catch(e=>{dialog.showErrorBox('Lumen failed to start',e instanceof Error?e.message:String(e));app.quit();});
 app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
 app.on('before-quit',()=>{quitting=true;saveNow();});
}
