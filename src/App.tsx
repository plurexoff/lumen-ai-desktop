import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {AlertTriangle,Archive,BookOpen,CheckSquare,Command,FileClock,FolderOpen,GitCompareArrows,GitFork,ListChecks,Maximize2,Minimize2,PanelLeftClose,Pin,Settings,Shield,Sparkles,X} from 'lucide-react';
import {useApp} from './store';
import type {PendingImage,Prefs,State,StreamState} from './store';
import type {Chat,ChatChunk,ChatDoc,CompareAnswer,FileOp,Folder,Message,MessageVariant,ProviderConfig,ProviderId,TodoItem} from '../electron/shared';
import {IMAGE_MIMES,isCustomProviderId,MAX_ATTACHMENT_BYTES,MAX_IMAGE_ATTACHMENTS} from '../electron/shared';
import {isMobile} from './platform/detect';
import Titlebar from './components/Titlebar';
import Sidebar from './components/Sidebar';
import Welcome from './components/Welcome';
import MessageList from './components/MessageList';
import Composer from './components/Composer';
import SettingsModal from './components/SettingsModal';
import {renderMarkdown} from './markdown';

type Tab='providers'|'appearance'|'agents'|'data'|'stats';
// Request params are taken from preferences; `theme` is deliberately not forwarded.
// A selected persona overrides the system prompt and (when pinned) the temperature.
const requestParams=(s:Prefs)=>{
 const persona=s.personas.find(p=>p.id===s.personaId);
 return{systemPrompt:persona?.prompt||s.systemPrompt,temperature:persona?.temperature??s.temperature,maxTokens:s.maxTokens,topP:s.topP,reasoningEffort:s.reasoningEffort};
};
const newStream=(requestId:string):StreamState=>({requestId,text:'',reasoning:'',error:'',finishReason:null,usage:null,toolEvents:[]});
// btoa() takes a binary string; chunking avoids a stack overflow on multi-MB images.
const toBase64=(buf:ArrayBuffer)=>{let s='';const bytes=new Uint8Array(buf);for(let i=0;i<bytes.length;i+=0x8000)s+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return btoa(s);};
// Match a KeyboardEvent against a stored "Ctrl+Shift+K" combo. Cmd counts as Ctrl.
const matchHotkey=(e:KeyboardEvent,combo:string)=>{
 const parts=combo.split('+');const key=parts[parts.length-1];
 const norm=(k:string)=>k.length===1?k.toUpperCase():k;
 if(norm(e.key)!==norm(key))return false;
 if((e.ctrlKey||e.metaKey)!==parts.includes('Ctrl'))return false;
 if(e.altKey!==parts.includes('Alt'))return false;
 if(e.shiftKey!==parts.includes('Shift'))return false;
 return true;
};
const LOCAL_PROVIDER_IDS=new Set<ProviderId>(['ollama','lmstudio']);
// A loopback endpoint needs no API key, so a local custom provider counts as usable
// too. This only drives the onboarding hint; main.ts is the authority on sending.
const isLocalProvider=(p:ProviderConfig)=>LOCAL_PROVIDER_IDS.has(p.id)||
 (isCustomProviderId(p.id)&&(p.baseUrl.includes('://localhost')||p.baseUrl.includes('://127.0.0.1')||p.baseUrl.includes('://[::1]')));

export default function App(){
 const chats=useApp(s=>s.chats);
 const activeId=useApp(s=>s.activeId);
 const messages=useApp(s=>s.messages);
 const providers=useApp(s=>s.providers);
 const settings=useApp(s=>s.settings);
 const streams=useApp(s=>s.streams);
 const errors=useApp(s=>s.errors);
 const providerId=useApp(s=>s.providerId);
 const model=useApp(s=>s.model);
 const set=useApp(s=>s.set);
 const [showSettings,setShowSettings]=useState(false);
 const [showSidebar,setShowSidebar]=useState(()=>!isMobile);
 const [tab,setTab]=useState<Tab>('providers');
 const [draft,setDraft]=useState('');
 const [images,setImagesState]=useState<PendingImage[]>([]);
 // imagesRef mirrors images so send()/failStream read them without taking the state
 // as a dependency (same trick as draftRef — keeps send() identity stable).
 const imagesRef=useRef(images);
 const setImages=(list:PendingImage[])=>{imagesRef.current=list;setImagesState(list);};
 const [notice,setNotice]=useState('');
 const [refreshingModels,setRefreshingModels]=useState(false);
 const [variants,setVariants]=useState<Record<string,MessageVariant[]>>({});
 // Mirrors `variants` so refreshOpenVariants can read the loaded set without taking it
 // as a dependency (which would give it a new identity on every variant change).
 const variantsRef=useRef(variants);
 useEffect(()=>{variantsRef.current=variants;},[variants]);
 const [atBottom,setAtBottom]=useState(true);
 // A failed disk flush means new messages exist only in memory and will be lost on
 // exit. main.ts tracks it (db.persistError) but nothing ever asked — surface it.
 const [persistError,setPersistError]=useState('');
 const input=useRef<HTMLTextAreaElement>(null),bottom=useRef<HTMLDivElement>(null),conversation=useRef<HTMLElement>(null);
 const noticeTimer=useRef<ReturnType<typeof setTimeout>>();
 // draftRef lets send() read the current text without depending on `draft`, so its
 // identity stays stable and memoized children do not re-render while typing.
 const draftRef=useRef('');
 useEffect(()=>{draftRef.current=draft;},[draft]);
 // Sent prompts for ArrowUp recall in the composer (session-only, newest last).
 const [history,setHistory]=useState<string[]>([]);
 const historyRef=useRef(history);
 // Sidebar folders and the search-jump highlight target.
 const [folders,setFolders]=useState<Folder[]>([]);
 const [highlightId,setHighlightId]=useState('');
 // Messages typed while a chat was still generating, keyed by chatId. Drained one
 // at a time by the queue-flush effect below when that chat's stream settles.
 const [queues,setQueues]=useState<Record<string,string[]>>({});
 const queuesRef=useRef(queues);
 // Batch 5 UI state: focus mode (sidebar/toolbar hidden), always-on-top window,
 // per-chat todo checklist + workspace activity panels, summarize modal, unread
 // badges for replies that finished while another chat was open.
 const [focusMode,setFocusMode]=useState(false);
 const [alwaysOnTop,setAlwaysOnTop]=useState(false);
 const [todos,setTodos]=useState<TodoItem[]>([]);
 const [fileOps,setFileOps]=useState<FileOp[]>([]);
 const [showFileOps,setShowFileOps]=useState(false);
 const [showTodos,setShowTodos]=useState(false);
 const [summary,setSummary]=useState<string|null>(null);
 const [summarizing,setSummarizing]=useState(false);
 const [unread,setUnread]=useState<Set<string>>(new Set());
 // Counts replies that finished while the window was hidden — "while you were away".
 const awayCount=useRef(0);
 // Batch 6: open-chat tabs, command palette, compare mode, attached docs (RAG),
 // and a toast with a Rollback action when the model changes a workspace file.
 const [openTabs,setOpenTabs]=useState<string[]>([]);
 const [showPalette,setShowPalette]=useState(false);
 const [paletteQuery,setPaletteQuery]=useState('');
 const [compareOpen,setCompareOpen]=useState(false);
 const [compareModel,setCompareModel]=useState('');
 const [compareProvider,setCompareProvider]=useState<ProviderId>('anthropic');
 const [compareAnswers,setCompareAnswers]=useState<CompareAnswer[]|null>(null);
 const [compareBusy,setCompareBusy]=useState(false);
 const [docs,setDocs]=useState<ChatDoc[]>([]);
 const [showDocs,setShowDocs]=useState(false);
 const [actionToast,setActionToast]=useState<{opId:string;text:string}|null>(null);
 const actionToastTimer=useRef<ReturnType<typeof setTimeout>>();
 // OS profile: whether the Mica material is live (translucent panels) and the login
 // name whose initial becomes the user avatar.
 const [profile,setProfile]=useState<{mica:boolean;username:string}>({mica:false,username:''});
 useEffect(()=>{window.lumen.app.profile().then(setProfile).catch(()=>{});},[]);

 const active=chats.find(c=>c.id===activeId);
 const stream=activeId?streams[activeId]:undefined;
 const busy=!!stream;
 const error=activeId?errors[activeId]??'':'';
 // Onboarding signal. The ollama/lmstudio presets are seeded on every launch and can
 // never be removed, so "id is a local provider" is NOT evidence that anything is
 // usable — it made this permanently false and all three onboarding surfaces dead code.
 // A local server counts only once it has actually yielded models (the user ran
 // "Refresh models" against a running server); otherwise nothing is ready to send to.
 const needsSetup=providers.length>0&&!providers.some(p=>p.hasKey||(isLocalProvider(p)&&p.models.length>0));
 // Derived from a key-signature so identity is stable during a stream (only the text
 // changes, not which chats are busy) — keeps Sidebar/Titlebar from re-rendering 60/s.
 const busySignature=useMemo(()=>Object.keys(streams).sort().join('|'),[streams]);
 const busyIds=useMemo(()=>new Set(busySignature?busySignature.split('|'):[]),[busySignature]);
 const anyBusy=busyIds.size>0;

 const flash=useCallback((text:string)=>{setNotice(text);if(noticeTimer.current)clearTimeout(noticeTimer.current);noticeTimer.current=setTimeout(()=>setNotice(''),2600);},[]);
 const load=useCallback(async(id:string)=>{set({messages:await window.lumen.chats.messages(id)});},[set]);

 const beginStream=useCallback((chatId:string,requestId:string)=>{
  const s=useApp.getState();const errors={...s.errors};delete errors[chatId];
  set({streams:{...s.streams,[chatId]:newStream(requestId)},pending:{...s.pending,[chatId]:{text:'',reasoning:''}},errors});
 },[set]);

 // The invoke itself rejected (bad key, no provider, validation): main persisted
 // nothing, so the optimistic user bubble is a phantom. Drop it and give the text
 // back to the composer — otherwise it silently vanishes on the next chat load.
 const failStream=useCallback((chatId:string,e:unknown,restore?:PendingImage[])=>{
  const s=useApp.getState();const next={...s.streams};const live=next[chatId];delete next[chatId];
  let messages=s.messages;
  if(live){
   const phantomId='pending-'+live.requestId;
   const phantom=s.messages.find(m=>m.id===phantomId);
   if(phantom){
    messages=s.messages.filter(m=>m.id!==phantomId);
    if(!draftRef.current)setDraft(phantom.content);
   }
  }
  // Give the staged images back too — main persisted nothing, so the user should
  // not have to re-attach them after a rejected send.
  if(restore?.length&&!imagesRef.current.length)setImages(restore);
  set({streams:next,messages,errors:{...s.errors,[chatId]:e instanceof Error?e.message:'Generation failed'}});
 },[set]);

 // Ask main whether the last disk flush succeeded. Checked on load and after every
 // turn, because a full disk / locked file loses history silently otherwise.
 // Returns the error so callers can act on it immediately — the state setter is async,
 // so reading `persistError` straight after calling this would see the previous value.
 const checkHealth=useCallback(async()=>{
  try{const h=await window.lumen.data.health();const err=h.ok?'':(h.persistError??'Could not write the database file');setPersistError(err);return err;}catch{return '';}
 },[]);

 // Re-fetch variants only for messages whose History panel is currently loaded, so an
 // open panel never goes stale (or falsely empty) after regenerate/restore/finalize.
 const refreshOpenVariants=useCallback(async()=>{
  const ids=Object.keys(variantsRef.current);
  if(!ids.length){setVariants({});return;}
  try{
   const lists=await Promise.all(ids.map(id=>window.lumen.chats.variants(id)));
   setVariants(Object.fromEntries(ids.map((id,i)=>[id,lists[i]])));
  }catch{}
 },[]);

 // Clear busy for the chat BEFORE awaiting anything: the old code cleared it after two
 // IPC round-trips inside an un-try/caught block, so any throw left the composer
 // disabled for the rest of the session.
 const finalize=useCallback(async(chatId:string,d:ChatChunk)=>{
  const s=useApp.getState();
  const nextStreams={...s.streams};delete nextStreams[chatId];
  const nextPending={...s.pending};delete nextPending[chatId];
  const nextErrors={...s.errors};
  if(d.error)nextErrors[chatId]=d.error;else delete nextErrors[chatId];
  set({streams:nextStreams,pending:nextPending,errors:nextErrors});
  // Unread badge: a reply finished for a chat the user is not looking at.
  if(!d.error&&chatId!==useApp.getState().activeId){setUnread(prev=>{const n=new Set(prev);n.add(chatId);return n;});}
  if(document.hidden)awayCount.current+=1;
  // A turn just archived or replaced an answer. Clearing the variant cache outright
  // left an OPEN History panel reading "No previous answers kept" while its own button
  // said "History (3)", so re-fetch only the messages whose panels are loaded.
  void refreshOpenVariants();
  try{
   const list=await window.lumen.chats.list();
   // Only the visible chat's messages are re-read; `activeId` is never reassigned
   // here, or a background generation would yank the user out of their current chat.
   const patch:Partial<State>={chats:list};
   if(chatId===useApp.getState().activeId){
    patch.messages=await window.lumen.chats.messages(chatId);
    const chat=list.find(c=>c.id===chatId);
    if(chat){patch.providerId=chat.providerId;patch.model=chat.model;}
   }
   set(patch);
  }catch{flash('Could not reload the conversation');}
  void checkHealth();
 },[checkHealth,flash,refreshOpenVariants,set]);

 const send=useCallback(async(text?:string,over?:{chatId?:string;skipUserPersist?:boolean})=>{
  const s=useApp.getState();
  // Defensive: if a caller passes a non-string (React once passed a mouse event here,
  // silently breaking the send button), fall back to the draft instead of throwing on
  // `.trim()` inside an async function, where it surfaces only as an unhandled reject.
  const content=(typeof text==='string'?text:draftRef.current).trim();
  const chatId=over?.chatId??s.activeId;
  const atts=imagesRef.current;
  // An image-only message is valid: the prompt may BE the image.
  if(!content&&!atts.length)return;
  if(chatId&&s.streams[chatId]){
   // A generation is running in this chat: queue the text and let the queue-flush
   // effect send it when the reply settles. Images can't be queued — they stage in
   // the composer and would be stranded, so keep them out for now.
   if(atts.length){flash('Wait for the current reply before attaching images');return;}
   if(!content)return;
   const q=queuesRef.current[chatId]??[];
   if(q.length>=10){flash('Queue is full — wait for the current reply');return;}
   const next={...queuesRef.current,[chatId]:[...q,content]};
   queuesRef.current=next;setQueues(next);
   if(text===undefined)setDraft('');
   flash('Queued — sends when the reply finishes');
   return;
  }
  // A selected persona overrides the prompt and (when pinned) provider/model/temp.
  const persona=s.settings.personas.find(p=>p.id===s.settings.personaId);
  const effProvider=persona?.providerId??s.providerId;
  const effModel=persona?.model??s.model;
  if(!effModel){flash('Add or select a model for this provider in Settings');setShowSettings(true);setTab('providers');return;}
  let id=chatId;
  if(!id){const c=await window.lumen.chats.create();id=c.id;set({chats:[c,...useApp.getState().chats],activeId:id,providerId:effProvider,model:effModel});}
  const requestId=crypto.randomUUID();
  const target=id;
  beginStream(target,requestId);
  set({messages:[...useApp.getState().messages,{id:'pending-'+requestId,chatId:target,role:'user',content,createdAt:Date.now(),
   attachments:atts.map((a,i)=>({id:'pending-'+i,name:a.name,mime:a.mime,size:a.size,preview:a.preview}))} as Message]});
  if(text===undefined)setDraft('');
  setImages([]);
  if(input.current)input.current.style.height='auto';
  const st=useApp.getState().settings;
  try{await window.lumen.chat.send({requestId,chatId:target,providerId:effProvider,model:effModel,content,skipUserPersist:over?.skipUserPersist,
   ...(atts.length?{attachments:atts.map(({name,mime,data})=>({name,mime,data}))}:{})
   ,...requestParams(st)});
  // History for ArrowUp recall: only messages that actually reached the provider,
  // no consecutive duplicates, capped at 50.
  if(content){const h=historyRef.current;if(h[h.length-1]!==content){const next=[...h,content].slice(-50);historyRef.current=next;setHistory(next);}}
  }
  catch(e){failStream(target,e,atts);}
 },[beginStream,failStream,flash,set]);

 const addImages=useCallback((files:File[])=>{
  const ok=files.filter(f=>(IMAGE_MIMES as readonly string[]).includes(f.type));
  if(ok.length<files.length)flash('Only PNG, JPEG, WebP or GIF images can be attached');
  const room=MAX_IMAGE_ATTACHMENTS-imagesRef.current.length;
  if(ok.length>room)flash(`At most ${MAX_IMAGE_ATTACHMENTS} images per message`);
  void Promise.all(ok.slice(0,Math.max(0,room)).map(async f=>{
   if(f.size>MAX_ATTACHMENT_BYTES){flash(`"${f.name}" is over ${MAX_ATTACHMENT_BYTES/1048576} MB`);return null;}
   const data=toBase64(await f.arrayBuffer());
   return {name:f.name,mime:f.type,size:f.size,data,preview:`data:${f.type};base64,${data}`} as PendingImage;
  })).then(list=>{const good=list.filter((x):x is PendingImage=>!!x);if(good.length)setImages([...imagesRef.current,...good]);});
 },[flash]);
 const removeImage=useCallback((i:number)=>setImages(imagesRef.current.filter((_,j)=>j!==i)),[]);

 // Fork the conversation at any message: main copies the history up to that point
 // (with variants and attachments) into a new chat, which we then open.
 const branchChat=useCallback(async(message:Message)=>{
  if(useApp.getState().streams[message.chatId]){flash('Still generating — stop it first');return;}
  try{
   const chat=await window.lumen.chats.branch(message.chatId,message.id);
   set({chats:await window.lumen.chats.list(),activeId:chat.id,messages:[],providerId:chat.providerId,model:chat.model});
   setVariants({});
   await load(chat.id);
   flash('Branched into a new conversation');
  }catch(e){flash(e instanceof Error?e.message:'Could not branch the conversation');}
 },[flash,load,set]);

 const regenerate=useCallback(()=>{
  const s=useApp.getState();const chatId=s.activeId;if(!chatId||s.streams[chatId])return;
  const last=s.messages[s.messages.length-1];if(!last||last.role!=='assistant')return;
  const requestId=crypto.randomUUID();beginStream(chatId,requestId);
  // Non-destructive: main archives the outgoing answer as a variant and updates the
  // row in place, so the previous text stays recoverable instead of being deleted.
  void window.lumen.chat.regenerate({requestId,chatId,providerId:s.providerId,model:s.model,content:'',regenerateMessageId:last.id,...requestParams(s.settings)}).catch(e=>failStream(chatId,e));
 },[beginStream,failStream]);

 const continueMessage=useCallback((messageId:string)=>{
  const s=useApp.getState();const chatId=s.activeId;if(!chatId||s.streams[chatId])return;
  const requestId=crypto.randomUUID();beginStream(chatId,requestId);
  void window.lumen.chat.continueMessage({requestId,chatId,providerId:s.providerId,model:s.model,content:'',continueMessageId:messageId,...requestParams(s.settings)}).catch(e=>failStream(chatId,e));
 },[beginStream,failStream]);

 // Edit-and-resend. Validation happens BEFORE anything is deleted: send() bails on an
 // empty model with no side effect, and main.ts truncates the tail inside the same
 // request only after the provider resolved. The old flow deleted first and sent
 // after, so a rejected send destroyed the conversation tail permanently.
 const commitEdit=useCallback(async(message:Message,text:string)=>{
  const s=useApp.getState();const chatId=message.chatId;
  if(s.streams[chatId]){flash('Still generating — stop it first');return;}
  const next=text.trim();if(!next)return;
  if(!s.model){flash('Select a model before resending');setShowSettings(true);setTab('providers');return;}
  const requestId=crypto.randomUUID();
  beginStream(chatId,requestId);
  // Replace the edited row optimistically so the UI reflects the new text at once;
  // finalize() re-reads the authoritative list from main when the turn completes.
  set({messages:s.messages.map(m=>m.id===message.id?{...m,content:next}:m).filter(m=>m.createdAt<message.createdAt||m.id===message.id)});
  // If the invoke itself rejects (bad key, validation), main deleted nothing, so
  // re-read the DB to undo the optimistic truncation instead of leaving the tail
  // hidden until the user switches chats.
  void window.lumen.chat.send({requestId,chatId,providerId:s.providerId,model:s.model,content:next,truncateFromMessageId:message.id,...requestParams(useApp.getState().settings)})
   .catch(async e=>{failStream(chatId,e);try{set({messages:await window.lumen.chats.messages(chatId)});}catch{}});
 },[beginStream,failStream,flash,set]);

 const deleteMessage=useCallback(async(message:Message)=>{
  const chatId=useApp.getState().activeId;if(!chatId)return;
  await window.lumen.chats.deleteMessage(message.id,chatId);
  set({messages:useApp.getState().messages.filter(m=>m.id!==message.id)});
 },[set]);

 const loadVariants=useCallback(async(messageId:string)=>{
  try{const list=await window.lumen.chats.variants(messageId);setVariants(v=>({...v,[messageId]:list}));}
  catch{flash('Could not load previous answers');}
 },[flash]);

 const restoreVariant=useCallback(async(variantId:string)=>{
  try{const chatId=useApp.getState().activeId;if(!chatId)return;const msgs=await window.lumen.chats.restoreVariant(variantId) as Message[];set({messages:msgs});
   // The swap archived the outgoing answer and consumed this variant, so the open
   // panel's contents changed — re-fetch instead of blanking it.
   void refreshOpenVariants();}
  catch(e){flash(e instanceof Error?e.message:'Could not restore that answer');}
 },[flash,refreshOpenVariants,set]);

 const newChat=useCallback(async()=>{
  const c=await window.lumen.chats.create();const s=useApp.getState();
  set({chats:[c,...s.chats],activeId:c.id,messages:[],providerId:s.providerId,model:s.model});
  setVariants({});
 },[set]);

 const openChat=useCallback((chat:Chat)=>{
  if(isMobile)setShowSidebar(false);
  setUnread(prev=>{if(!prev.has(chat.id))return prev;const n=new Set(prev);n.delete(chat.id);return n;});
  setOpenTabs(prev=>prev.includes(chat.id)?prev:[...prev.slice(-7),chat.id]);
  if(chat.id===useApp.getState().activeId)return;
  set({activeId:chat.id,providerId:chat.providerId,model:chat.model});
  setVariants({});
  void load(chat.id);
 },[load,set]);

 const removeChat=useCallback(async(chat:Chat)=>{
  const s=useApp.getState();
  // Stop the generation first: leaving it running spends tokens and its INSERT would
  // target a chat that no longer exists.
  const live=s.streams[chat.id];
  if(live)await window.lumen.chat.stop(live.requestId).catch(()=>{});
  await window.lumen.chats.delete(chat.id);
  const cs=await window.lumen.chats.list();const next=cs[0];
  setOpenTabs(prev=>prev.filter(id=>id!==chat.id));
  const nextStreams={...useApp.getState().streams};delete nextStreams[chat.id];
  const nextErrors={...useApp.getState().errors};delete nextErrors[chat.id];
  set({chats:cs,activeId:next?.id??null,messages:[],streams:nextStreams,errors:nextErrors});
  setVariants({});
  // A deleted chat's queued messages have nowhere to go — drop them too.
  if(queuesRef.current[chat.id]){const nq={...queuesRef.current};delete nq[chat.id];queuesRef.current=nq;setQueues(nq);}
  if(next)await load(next.id);
 },[load,set]);

 const renameChat=useCallback(async(id:string,title:string)=>{
  await window.lumen.chats.rename(id,title);set({chats:await window.lumen.chats.list()});
 },[set]);

 const togglePin=useCallback(async(chat:Chat)=>{
  await window.lumen.chats.pin(chat.id,!chat.pinned);set({chats:await window.lumen.chats.list()});
 },[set]);

 const moveToFolder=useCallback(async(chatId:string,folderId:string|null)=>{
  await window.lumen.chats.setFolder(chatId,folderId);set({chats:await window.lumen.chats.list()});
 },[set]);

 const createFolder=useCallback(async(name:string)=>{
  await window.lumen.folders.create(name);setFolders(await window.lumen.folders.list());
 },[]);

 const renameFolder=useCallback(async(id:string,name:string)=>{
  await window.lumen.folders.rename(id,name);setFolders(await window.lumen.folders.list());
 },[]);

 const deleteFolder=useCallback(async(id:string)=>{
  await window.lumen.folders.delete(id);
  setFolders(await window.lumen.folders.list());
  set({chats:await window.lumen.chats.list()});
 },[set]);

 // Search jump: open the chat (if needed), load its messages, then scroll the hit
 // into view with a brief highlight so the eye lands on the matched message.
 const openChatAt=useCallback(async(chatId:string,messageId:string)=>{
  const s=useApp.getState();const chat=s.chats.find(c=>c.id===chatId);if(!chat)return;
  if(chatId!==s.activeId){set({activeId:chat.id,providerId:chat.providerId,model:chat.model});setVariants({});}
  await load(chat.id);
  setHighlightId(messageId);
  requestAnimationFrame(()=>{document.getElementById('msg-'+messageId)?.scrollIntoView({block:'center'});});
  window.setTimeout(()=>setHighlightId(''),2600);
 },[load,set]);

 // The workspace folder enables file tools for this chat (reads are automatic,
 // writes ask first). pickWorkspace shows a native folder dialog in main.
 const pickWorkspace=useCallback(async()=>{
  const id=useApp.getState().activeId;if(!id)return;
  try{
   const updated=await window.lumen.chats.pickWorkspace(id);
   if(updated){set({chats:useApp.getState().chats.map(c=>c.id===id?updated:c)});flash('Workspace: '+updated.workspace);}
  }catch(e){flash(e instanceof Error?e.message:'Could not set the workspace');}
 },[flash,set]);

 const clearWorkspace=useCallback(async()=>{
  const id=useApp.getState().activeId;if(!id)return;
  await window.lumen.chats.clearWorkspace(id);
  set({chats:useApp.getState().chats.map(c=>c.id===id?{...c,workspace:null}:c)});
 },[set]);

 // ---- batch 5: archive / read-only / tags / bookmarks ------------------------------
 const toggleArchived=useCallback(async(chat:Chat)=>{
  await window.lumen.chats.setArchived(chat.id,!chat.archived);
  const cs=await window.lumen.chats.list();set({chats:cs});
  // Archiving the open chat closes it (it disappears from the default list).
  if(!chat.archived&&chat.id===useApp.getState().activeId){
   const next=cs.find(c=>!c.archived);set({activeId:next?.id??null,messages:[]});if(next)await load(next.id);
  }
 },[load,set]);

 const toggleReadonly=useCallback(async()=>{
  const s=useApp.getState();const chat=s.chats.find(c=>c.id===s.activeId);if(!chat)return;
  await window.lumen.chats.setReadonly(chat.id,!chat.workspaceReadonly);
  set({chats:s.chats.map(c=>c.id===chat.id?{...c,workspaceReadonly:chat.workspaceReadonly?0:1}:c)});
  flash(chat.workspaceReadonly?'Read-only mode off — writes will ask for approval':'Read-only mode on — the model cannot change files in this chat');
 },[flash,set]);

 const setTags=useCallback(async(chatId:string,tags:string[])=>{
  await window.lumen.chats.setTags(chatId,tags);set({chats:await window.lumen.chats.list()});
 },[set]);

 const toggleBookmark=useCallback(async(msg:Message)=>{
  await window.lumen.chats.bookmarkMessage(msg.id,!msg.bookmarked);
  set({messages:useApp.getState().messages.map(m=>m.id===msg.id?{...m,bookmarked:m.bookmarked?0:1}:m)});
 },[set]);

 // Answer rating (👍/👎): persisted in main, reflected locally at once.
 const rateMessage=useCallback(async(msg:Message,rating:number)=>{
  set({messages:useApp.getState().messages.map(m=>m.id===msg.id?{...m,rating}:m)});
  try{await window.lumen.chats.rateMessage(msg.id,rating);}catch{}
 },[set]);

 // Zip export: markdown + JSON + attachments, packed by main via Compress-Archive.
 const exportZip=useCallback(async()=>{
  const id=useApp.getState().activeId;if(!id)return;
  try{const p=await window.lumen.chats.exportZip(id);flash(p?'Saved to '+p:'Export cancelled');}
  catch(e){flash(e instanceof Error?e.message:'Export failed');}
 },[flash]);

 // Compare mode: replay the conversation on a second provider/model, side by side.
 const runCompare=useCallback(async()=>{
  const id=useApp.getState().activeId;if(!id||compareBusy)return;
  if(!compareModel){flash('Pick a model to compare against');return;}
  setCompareBusy(true);setCompareAnswers(null);
  try{setCompareAnswers(await window.lumen.chats.compare(id,compareProvider,compareModel));}
  catch(e){flash(e instanceof Error?e.message:'Compare failed');setCompareOpen(false);}
  finally{setCompareBusy(false);}
 },[compareBusy,compareModel,compareProvider,flash]);

 // Attached documents (RAG): attach via a native picker, remove by id.
 const attachDoc=useCallback(async()=>{
  const id=useApp.getState().activeId;if(!id)return;
  try{
   const doc=await window.lumen.chats.attachDoc(id);
   if(doc){setDocs(await window.lumen.chats.docs(id));flash('Attached '+doc.name);}
  }catch(e){flash(e instanceof Error?e.message:'Could not attach the document');}
 },[flash]);
 const removeDoc=useCallback(async(docId:string)=>{
  try{await window.lumen.chats.removeDoc(docId);const id=useApp.getState().activeId;if(id)setDocs(await window.lumen.chats.docs(id));}catch{}
 },[]);

 // @file autocomplete in the composer (workspace-relative paths).
 const fileQuery=useCallback((q:string)=>{
  const id=useApp.getState().activeId;if(!id)return Promise.resolve([]);
  return window.lumen.chats.listWorkspaceFiles(id,q).catch(()=>[]);
 },[]);

 // Summarize: main condenses the transcript; the user can start a fresh chat from it.
 const runSummarize=useCallback(async()=>{
  const id=useApp.getState().activeId;if(!id||summarizing)return;
  setSummarizing(true);
  try{setSummary(await window.lumen.chats.summarize(id));}
  catch(e){flash(e instanceof Error?e.message:'Could not summarize this chat');}
  finally{setSummarizing(false);}
 },[flash,summarizing]);

 const newChatFromSummary=useCallback(async()=>{
  if(!summary)return;
  const text=summary;setSummary(null);
  await newChat();
  setDraft('Here is the summary of our previous conversation. Continue from it:\n\n'+text);
  input.current?.focus();
 },[summary,newChat]);

 // Export to HTML/PDF: the document is built here (the markdown pipeline lives in the
 // renderer); main only saves the file or prints it.
 const buildChatHtml=useCallback((chat:Chat,msgs:Message[])=>{
  const esc=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const body=msgs.map(m=>'<section class="msg '+m.role+'"><header>'+(m.role==='user'?'You':esc(m.model??'Assistant'))+' <time>'+new Date(m.createdAt).toLocaleString()+'</time></header><div class="content">'+renderMarkdown(m.content)+'</div></section>').join('\n');
  return '<!doctype html><html><head><meta charset="utf-8"><title>'+esc(chat.title)+'</title><style>'
   +'body{font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#1c1c1e;background:#fff}'
   +'h1{font-size:22px}.msg{margin:18px 0;padding:14px 16px;border-radius:12px;background:#f5f5f7}.msg.user{background:#e8f0fe}'
   +'.msg header{font-size:12px;color:#666;margin-bottom:6px}.msg time{opacity:.7;margin-left:6px}'
   +'pre{background:#16181d;color:#e6e6e6;padding:12px;border-radius:8px;overflow-x:auto}code{font-family:Consolas,Menlo,monospace;font-size:13px}'
   +'table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 10px}blockquote{border-left:3px solid #bbb;margin:0;padding-left:12px;color:#555}'
   +'</style></head><body><h1>'+esc(chat.title)+'</h1>'+body+'</body></html>';
 },[]);

 const exportPrepared=useCallback(async(format:'html'|'pdf')=>{
  const s=useApp.getState();const chat=s.chats.find(c=>c.id===s.activeId);if(!chat||!s.messages.length)return;
  try{const path=await window.lumen.chats.exportPrepared(chat.id,format,buildChatHtml(chat,s.messages));flash(path?'Saved to '+path:'Export cancelled');}
  catch(e){flash(e instanceof Error?e.message:'Export failed');}
 },[buildChatHtml,flash]);

 // Slash commands: /model X, /persona Y, /clear, /template N, /summarize, /readonly.
 // Returns true when the input was consumed as a command (Composer then skips send).
 const handleSlash=useCallback((raw:string)=>{
  const [cmd,...rest]=raw.slice(1).split(/\s+/);const arg=rest.join(' ').trim();
  const s=useApp.getState();
  switch(cmd.toLowerCase()){
   case 'model':{
    const p=s.providers.find(x=>x.id===s.providerId);
    const m=p?.models.find(x=>x.toLowerCase().includes(arg.toLowerCase()));
    if(m){set({model:m});flash('Model → '+m);}else flash('Model "'+arg+'" not found for '+s.providerId);
    return true;
   }
   case 'persona':{
    const persona=s.settings.personas.find(x=>x.name.toLowerCase().includes(arg.toLowerCase()));
    if(persona||!arg){const id=persona?.id??'';set({settings:{...s.settings,personaId:id}});void window.lumen.settings.save({personaId:id});flash(persona?'Persona → '+persona.name:'Persona cleared');}
    else flash('No persona named "'+arg+'"');
    return true;
   }
   case 'template':{
    const t=s.settings.templates[Number(arg)-1]??s.settings.templates.find(x=>x.name.toLowerCase().includes(arg.toLowerCase()));
    if(t){setDraft(t.text.replace('{{input}}',''));input.current?.focus();}else flash('Template "'+arg+'" not found');
    return true;
   }
   case 'clear':void newChat();return true;
   case 'summarize':void runSummarize();return true;
   case 'readonly':void toggleReadonly();return true;
   case 'help':flash('Commands: /model · /persona · /template N · /clear · /summarize · /readonly');return true;
   default:return false;
  }
 },[flash,newChat,runSummarize,set,toggleReadonly]);

 const toggleAlwaysOnTop=useCallback(()=>{
  const next=!alwaysOnTop;setAlwaysOnTop(next);
  window.lumen.window.setAlwaysOnTop(next);
 },[alwaysOnTop]);

 const rollbackOp=useCallback(async(opId:string)=>{
  try{
   const r=await window.lumen.chats.rollbackOp(opId);flash(r.message);
   const id=useApp.getState().activeId;if(id)setFileOps(await window.lumen.chats.fileOps(id));
  }catch(e){flash(e instanceof Error?e.message:'Rollback failed');}
 },[flash]);

 const pref=useCallback(async<K extends keyof Prefs>(key:K,value:Prefs[K])=>{
  const s=useApp.getState().settings;set({settings:{...s,[key]:value}});
  try{await window.lumen.settings.save({[key]:value});}catch{flash('Could not save that preference');}
 },[flash,set]);

 const saveProvider=useCallback(async(config:ProviderConfig,key?:string)=>{
  try{await window.lumen.providers.save(config,key);const updated=await window.lumen.providers.list();set({providers:updated});return updated.find(p=>p.id===config.id)??config;}
  catch(e){flash(e instanceof Error?e.message:'Unable to save');return undefined;}
 },[flash,set]);

 const removeProvider=useCallback(async(id:ProviderId)=>{
  try{await window.lumen.providers.remove(id);set({providers:await window.lumen.providers.list()});}
  catch(e){flash(e instanceof Error?e.message:'Unable to remove');}
 },[flash,set]);

 // Creates an empty custom endpoint ("custom-<hex>") and selects it; the user then
 // fills in the URL/key and presses Save like for any other provider.
 const createProvider=useCallback(async()=>{
  try{const created=await window.lumen.providers.create('');const updated=await window.lumen.providers.list();set({providers:updated,providerId:created.id,model:''});return created;}
  catch(e){flash(e instanceof Error?e.message:'Unable to add a provider');return undefined;}
 },[flash,set]);

 const testProvider=useCallback(async()=>{const result=await window.lumen.providers.test(useApp.getState().providerId);flash(result.message);},[flash]);

 const refreshModels=useCallback(async()=>{
  const st=useApp.getState();const provider=st.providers.find(p=>p.id===st.providerId);
  if(!provider)return;
  setRefreshingModels(true);
  try{
   const fetched=await window.lumen.providers.models(st.providerId);
   const models=Array.from(new Set([...provider.models,...fetched.map(x=>x.trim()).filter(Boolean)]));
   await window.lumen.providers.save({...provider,models});
   const updated=await window.lumen.providers.list();set({providers:updated});
   const saved=updated.find(p=>p.id===st.providerId);
   if(saved&&!saved.models.includes(st.model))set({model:saved.models[0]??''});
   flash(`Loaded ${fetched.length} model${fetched.length===1?'':'s'}`);
  }catch(e){flash(e instanceof Error?e.message:'Could not load models');}
  finally{setRefreshingModels(false);}
 },[flash,set]);

 const copy=useCallback(async(text:string)=>{try{await navigator.clipboard.writeText(text);flash('Copied');}catch{flash('Copy failed');}},[flash]);

 const changeProvider=useCallback((id:ProviderId)=>{
  set({providerId:id});const p=useApp.getState().providers.find(x=>x.id===id);if(p?.models[0])set({model:p.models[0]});
 },[set]);
 const selectModel=useCallback((m:string)=>set({model:m}),[set]);

 const stopActive=useCallback(()=>{
  const s=useApp.getState();const chatId=s.activeId;if(!chatId)return;const live=s.streams[chatId];if(!live)return;
  void window.lumen.chat.stop(live.requestId).catch(()=>{});
 },[]);

 // Queue flush: when a chat leaves the busy set and its turn did not end in an error,
 // send the oldest queued message. One per settle — the flush of that send triggers
 // the next, so a long queue drains in order without overlapping requests.
 const prevBusyRef=useRef<Set<string>>(new Set());
 useEffect(()=>{
  const prev=prevBusyRef.current;
  const now=new Set(Object.keys(streams));
  for(const id of prev){
   if(now.has(id)||errors[id])continue;
   const q=queuesRef.current[id];
   if(!q?.length)continue;
   const [next,...rest]=q;
   const nextQueues={...queuesRef.current,[id]:rest};
   queuesRef.current=nextQueues;setQueues(nextQueues);
   void send(next,{chatId:id});
  }
  prevBusyRef.current=now;
 },[streams,errors,send]);

 const clearQueue=useCallback(()=>{
  const id=useApp.getState().activeId;if(!id)return;
  if(!queuesRef.current[id]?.length)return;
  const next={...queuesRef.current};delete next[id];
  queuesRef.current=next;setQueues(next);
 },[]);

 // Enhance Prompt: the draft is rewritten by the currently selected (or persona-
 // pinned) provider/model via a mini-request in main. Errors surface as a toast;
 // the composer keeps its original draft either way.
 const enhanceDraft=useCallback(async(text:string)=>{
  const s=useApp.getState();
  const persona=s.settings.personas.find(p=>p.id===s.settings.personaId);
  const effProvider=persona?.providerId??s.providerId;
  const effModel=persona?.model??s.model;
  if(!effModel){flash('Add or select a model for this provider in Settings');throw new Error('No model selected');}
  try{return await window.lumen.prompt.enhance(text,effProvider,effModel);}
  catch(e){flash(e instanceof Error?e.message:'Could not enhance the draft');throw e;}
 },[flash]);

 const scrollToBottom=useCallback(()=>{
  const el=conversation.current;if(!el)return;el.scrollTo({top:el.scrollHeight,behavior:'smooth'});setAtBottom(true);
 },[]);
 const onScroll=useCallback(()=>{const el=conversation.current;if(el)setAtBottom(el.scrollHeight-el.scrollTop-el.clientHeight<160);},[]);

 const exportChat=useCallback(async(format:'md'|'json')=>{
  const id=useApp.getState().activeId;if(!id)return;
  try{const path=await window.lumen.chats.export(id,format);flash(path?'Saved to '+path:'Export cancelled');}
  catch(e){flash(e instanceof Error?e.message:'Export failed');}
 },[flash]);

 const wipeData=useCallback(async()=>{
  try{
   const s=useApp.getState();
   for(const id of Object.keys(s.streams))await window.lumen.chat.stop(s.streams[id].requestId).catch(()=>{});
   await window.lumen.data.wipe();
   set({chats:[],activeId:null,messages:[],streams:{},errors:{}});
   setVariants({});variantsRef.current={};
   queuesRef.current={};setQueues({});
   // Wipe flushes synchronously in main; if that write failed the conversations come
   // back on next launch, so only claim success once health confirms it.
   const err=await checkHealth();
   flash(err?'Could not write the database — nothing was deleted':'All conversations deleted');
  }catch(e){flash(e instanceof Error?e.message:'Could not erase data');}
 },[checkHealth,flash,set]);
 const openDataFolder=useCallback(async()=>{try{await window.lumen.data.openFolder();}catch{flash('Could not open the data folder');}},[flash]);

 const openProvidersTab=useCallback(()=>{setShowSettings(true);setTab('providers');},[]);
 const closeSettings=useCallback(()=>setShowSettings(false),[]);
 const toggleSidebar=useCallback(()=>setShowSidebar(v=>!v),[]);
 // Tab strip: closing the active tab moves to the neighbour that stays open.
 const closeTab=useCallback((id:string)=>{
  const next=openTabs.filter(x=>x!==id);
  setOpenTabs(next);
  if(id===useApp.getState().activeId&&next.length){
   const nc=useApp.getState().chats.find(x=>x.id===next[next.length-1]);
   if(nc)openChat(nc);
  }
 },[openTabs,openChat]);
 const newChatAndFocus=useCallback(()=>{if(isMobile)setShowSidebar(false);void newChat().then(()=>input.current?.focus());},[newChat]);
 const pickSuggestion=useCallback((t:string)=>{setDraft(t);input.current?.focus();},[]);

 // ---- stream batching: main sends a chunk per token; accumulate and flush on rAF
 useEffect(()=>{
  let frame=0;
  const flush=()=>{
   frame=0;const s=useApp.getState();
   const ids=Object.keys(s.pending).filter(id=>s.pending[id].text||s.pending[id].reasoning);
   if(!ids.length)return;
   const nextStreams={...s.streams},nextPending={...s.pending};
   for(const id of ids){
    const cur=nextStreams[id],p=nextPending[id];
    nextPending[id]={text:'',reasoning:''};
    if(cur)nextStreams[id]={...cur,text:cur.text+p.text,reasoning:cur.reasoning+p.reasoning};
   }
   set({streams:nextStreams,pending:nextPending});
  };
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(flush);};
  return window.lumen.chat.onChunk(d=>{
   const s=useApp.getState();const cur=s.streams[d.chatId];
   // Status chunks (tool activity) bypass the batched text pipeline — they are
   // rare, and the heading should react immediately.
   if(cur&&cur.requestId===d.requestId&&d.status!==undefined){
    set({streams:{...useApp.getState().streams,[d.chatId]:{...cur,status:d.status||undefined}}});
   }
   // Matched by chatId only. Filtering on activeId here was the bug that left the app
   // stuck in busy forever after switching chats mid-generation.
   if(cur&&cur.requestId===d.requestId&&(d.text||d.reasoning)){
    const p=s.pending[d.chatId]??{text:'',reasoning:''};
    s.pending[d.chatId]={text:p.text+(d.text??''),reasoning:p.reasoning+(d.reasoning??'')};
    schedule();return;
   }
   if(d.done){if(frame){cancelAnimationFrame(frame);frame=0;}void finalize(d.chatId,d);}
  });
 },[finalize,set]);

 // ---- initial load + reconnect to generations that outlived a renderer reload
 useEffect(()=>{
  void Promise.all([window.lumen.chats.list(),window.lumen.providers.list(),window.lumen.settings.get(),window.lumen.chat.status(),window.lumen.folders.list()])
   .then(([cs,ps,prefs,active,fs2])=>{
    const initial=cs[0];
    const streams:Record<string,StreamState>={};
    for(const a of active)streams[a.chatId]=newStream(a.requestId);
    set({chats:cs,providers:ps,settings:prefs,streams,
     ...(initial?{activeId:initial.id,providerId:initial.providerId,model:initial.model}:ps[0]?{providerId:ps[0].id,model:ps[0].models[0]??''}:{})});
    setFolders(fs2);
    if(initial){setOpenTabs([initial.id]);void load(initial.id);}
    void checkHealth();
   })
   .catch(e=>flash(e instanceof Error?e.message:'Could not load your workspace'));
 },[checkHealth,flash,load,set]);

 // ---- autoscroll: follow the stream only when already near the bottom
 useEffect(()=>{
  if(!atBottom)return;
  bottom.current?.scrollIntoView({behavior:'auto'});
 },[atBottom,messages,stream?.text,stream?.reasoning]);

 // The main process may rename a chat itself (auto-title after the first reply);
 // keep the sidebar in sync without a full reload.
 useEffect(()=>window.lumen.chats.onRenamed(({id,title})=>{
  set({chats:useApp.getState().chats.map(c=>c.id===id?{...c,title}:c)});
 }),[set]);

 // ---- custom CSS theme: injected as a <style> tag, re-applied when the setting changes
 useEffect(()=>{
  let el=document.getElementById('lumen-custom-css') as HTMLStyleElement|null;
  if(!settings.customCss){el?.remove();return;}
  if(!el){el=document.createElement('style');el.id='lumen-custom-css';document.head.appendChild(el);}
  el.textContent=settings.customCss;
 },[settings.customCss]);

 // ---- per-chat todo checklist: load on chat switch, live-updated by todo_write
 useEffect(()=>{
  if(!activeId){setTodos([]);return;}
  void window.lumen.chats.todos(activeId).then(setTodos).catch(()=>setTodos([]));
 },[activeId]);
 useEffect(()=>window.lumen.chats.onTodos(({chatId,todos:list})=>{
  if(chatId===useApp.getState().activeId)setTodos(list);
 }),[]);

 // ---- batch 6: tool-call cards in the streaming bubble
 useEffect(()=>window.lumen.chat.onTool((chatId,ev)=>{
  const s=useApp.getState();const cur=s.streams[chatId];if(!cur)return;
  const events=[...(cur.toolEvents??[])];
  // A second event for the same call (running → ok/error) updates it in place.
  const idx=events.findIndex(e=>e.name===ev.name&&e.hint===ev.hint&&e.status==='running');
  if(ev.status!=='running'&&idx>=0)events[idx]=ev;else events.push(ev);
  set({streams:{...s.streams,[chatId]:{...cur,toolEvents:events}}});
 }),[set]);

 // ---- batch 6: actionable toast — a file change can be rolled back right away
 useEffect(()=>window.lumen.chats.onFileOp(op=>{
  if(op.status!=='ok'||!op.snapshot||op.tool==='rollback')return;
  if(actionToastTimer.current)clearTimeout(actionToastTimer.current);
  setActionToast({opId:op.id,text:op.tool+': '+(op.path??'')});
  actionToastTimer.current=setTimeout(()=>setActionToast(null),9000);
 }),[]);

 // ---- batch 6: attached documents (RAG) for the open chat
 useEffect(()=>{
  if(!showDocs||!activeId)return;
  void window.lumen.chats.docs(activeId).then(setDocs).catch(()=>setDocs([]));
 },[showDocs,activeId]);

 // ---- batch 6: Ctrl+Tab cycles open tabs, Ctrl+P opens the command palette
 useEffect(()=>{
  const onKey=(e:KeyboardEvent)=>{
   if(e.key==='Tab'&&(e.ctrlKey||e.metaKey)){
    if(openTabs.length<2)return;
    e.preventDefault();
    const cur=useApp.getState().activeId;
    const i=openTabs.indexOf(cur??'');
    const next=openTabs[(i+(e.shiftKey?-1:1)+openTabs.length)%openTabs.length];
    const chat=useApp.getState().chats.find(c=>c.id===next);
    if(chat&&next!==cur)openChat(chat);
    return;
   }
   if((e.ctrlKey||e.metaKey)&&!e.shiftKey&&!e.altKey&&e.key.toLowerCase()==='p'){
    e.preventDefault();setPaletteQuery('');setShowPalette(v=>!v);
   }
  };
  window.addEventListener('keydown',onKey);
  return()=>window.removeEventListener('keydown',onKey);
 },[openTabs,openChat]);

 // ---- workspace activity log (loaded lazily when the panel opens)
 useEffect(()=>{
  if(!showFileOps||!activeId)return;
  void window.lumen.chats.fileOps(activeId).then(setFileOps).catch(()=>setFileOps([]));
 },[showFileOps,activeId]);
 // A finished stream may have touched files — refresh an open panel.
 useEffect(()=>{
  if(!showFileOps||!activeId||streams[activeId])return;
  void window.lumen.chats.fileOps(activeId).then(setFileOps).catch(()=>{});
 },[showFileOps,activeId,streams]);

 // ---- "while you were away": count replies that finished in the background
 useEffect(()=>{
  const onFocus=()=>{
   if(awayCount.current>0){flash('While you were away: '+awayCount.current+' '+(awayCount.current===1?'reply':'replies')+' finished');awayCount.current=0;}
  };
  window.addEventListener('focus',onFocus);
  return()=>window.removeEventListener('focus',onFocus);
 },[flash]);

 // Focus mode: Escape exits it.
 useEffect(()=>{
  if(!focusMode)return;
  const onKey=(e:KeyboardEvent)=>{if(e.key==='Escape')setFocusMode(false);};
  window.addEventListener('keydown',onKey);
  return()=>window.removeEventListener('keydown',onKey);
 },[focusMode]);

 // ---- keyboard shortcuts (rebindable in Settings → Appearance)
 useEffect(()=>{
  const onKey=(e:KeyboardEvent)=>{
   // While Settings is open the modal owns the keyboard: Ctrl+K must not create a chat
   // behind the backdrop (the user would silently land in a different conversation on
   // close), and Escape is handled by the modal's own listener.
   if(showSettings)return;
   const h=useApp.getState().settings.hotkeys;
   if(matchHotkey(e,h.newChat)){e.preventDefault();newChatAndFocus();}
   else if(matchHotkey(e,h.openSettings)){e.preventDefault();setShowSettings(true);}
   else if(matchHotkey(e,h.toggleSidebar)){e.preventDefault();toggleSidebar();}
  };
  window.addEventListener('keydown',onKey);
  return()=>window.removeEventListener('keydown',onKey);
 },[newChatAndFocus,showSettings,toggleSidebar]);

 // Command palette (Ctrl+P): static commands first, then fuzzy chat matches.
 const paletteItems=(q:string)=>{
  const cmds=[
   {id:'cmd:new',icon:<Sparkles size={13}/>,label:'New conversation',hint:settings.hotkeys.newChat,run:()=>void newChat()},
   {id:'cmd:settings',icon:<Settings size={13}/>,label:'Open settings',hint:settings.hotkeys.openSettings,run:()=>setShowSettings(true)},
   {id:'cmd:sidebar',icon:<PanelLeftClose size={13}/>,label:'Toggle sidebar',hint:settings.hotkeys.toggleSidebar,run:toggleSidebar},
   {id:'cmd:focus',icon:<Maximize2 size={13}/>,label:'Toggle focus mode',hint:'Esc',run:()=>setFocusMode(v=>!v)},
   {id:'cmd:compare',icon:<GitCompareArrows size={13}/>,label:'Compare models…',hint:'',run:()=>setCompareOpen(true)},
   {id:'cmd:summarize',icon:<Sparkles size={13}/>,label:'Summarize this chat',hint:'',run:()=>void runSummarize()},
   {id:'cmd:zip',icon:<Archive size={13}/>,label:'Export chat as zip…',hint:'',run:()=>void exportZip()},
  ].filter(c=>!q||c.label.toLowerCase().includes(q));
  const chatItems=chats.filter(c=>!q||c.title.toLowerCase().includes(q)).slice(0,8)
   .map(c=>({id:'chat:'+c.id,icon:<BookOpen size={13}/>,label:c.title,hint:'chat',run:()=>openChat(c)}));
  return [...cmds,...chatItems].slice(0,12);
 };

 return <div className={'app-shell'+(settings.density==='compact'||settings.compactMode?' compact':'')+(settings.density==='comfortable'?' comfy':'')+(focusMode?' focus':'')+(profile.mica?' mica':'')} data-theme={settings.theme} data-accent={settings.accent} data-preset={settings.themePreset}>
  {!isMobile&&<Titlebar busy={anyBusy}/>}
  <div className="layout">
   {showSidebar&&!focusMode&&<Sidebar chats={chats} activeId={activeId} providers={providers} folders={folders} busyIds={busyIds} needsSetup={needsSetup} unread={unread}
     newChatHotkey={settings.hotkeys.newChat}
     onNew={newChatAndFocus} onOpen={openChat} onDelete={removeChat} onRename={renameChat} onOpenSettings={openProvidersTab}
     onTogglePin={togglePin} onMoveFolder={moveToFolder} onToggleArchived={toggleArchived} onSetTags={setTags}
     onCreateFolder={createFolder} onRenameFolder={renameFolder} onDeleteFolder={deleteFolder}
     onOpenHit={openChatAt}/>}
   {isMobile&&showSidebar&&!focusMode&&<div className="drawer-backdrop" onClick={()=>setShowSidebar(false)}/>}
   <main className="main-panel">
    {openTabs.length>0&&!focusMode&&<div className="tab-strip" role="tablist" aria-label="Open conversations">
     {openTabs.map(id=>{const c=chats.find(x=>x.id===id);if(!c)return null;
      return <div key={id} role="tab" aria-selected={id===activeId} className={'chat-tab'+(id===activeId?' active':'')}>
       {!!streams[id]&&<span className="tab-busy" aria-label="Generating"/>}
       <button className="tab-title" title={c.title} onClick={()=>openChat(c)}>{c.title}</button>
       <button className="tab-close" aria-label={'Close tab '+c.title} onClick={()=>closeTab(id)}><X size={11}/></button>
      </div>;})}
    </div>}
    {persistError&&<div className="persist-error" role="alert">
     <AlertTriangle size={14}/>
     <span>Changes are not being saved to disk: {persistError}. Free up space or close whatever is locking the file, then restart Lumen.</span>
    </div>}
    <div className="toolbar">
     <div className="toolbar-left">
      <button className="icon-btn" aria-label={showSidebar?'Hide sidebar':'Show sidebar'} onClick={toggleSidebar}><PanelLeftClose size={16}/></button>
      <span>Conversations</span>{active&&<><i>/</i><b>{active.title}</b></>}
      {/* Branch lineage: jump back to the source chat, or into one of its forks. */}
      {active?.branchedFrom&&<button className="branch-link" title="Open the conversation this one branched from"
       onClick={()=>{const parent=chats.find(c=>c.id===active.branchedFrom);if(parent)openChat(parent);}}>
       <GitFork size={12}/> from {chats.find(c=>c.id===active.branchedFrom)?.title??'deleted chat'}</button>}
      {active&&chats.some(c=>c.branchedFrom===active.id)&&<select className="branch-select" value="" aria-label="Open a branch of this conversation"
       onChange={e=>{const chat=chats.find(c=>c.id===e.target.value);if(chat)openChat(chat);}}>
       <option value="">{chats.filter(c=>c.branchedFrom===active.id).length} {chats.filter(c=>c.branchedFrom===active.id).length===1?'branch':'branches'}</option>
       {chats.filter(c=>c.branchedFrom===active.id).map(c=><option key={c.id} value={c.id}>{c.title}</option>)}
      </select>}
      {/* Workspace: the model gets file tools inside this folder (writes ask first). */}
      {active&&<button className={'branch-link'+(active.workspace?' workspace-on':'')}
       title={active.workspace?active.workspace+' — the model can list, read and search files here; writes need your approval. Click to change.':'Attach a workspace folder — the model can list, read and search files in it; writes need your approval'}
       onClick={()=>void pickWorkspace()}>
       <FolderOpen size={12}/>{active.workspace?active.workspace.split(/[\\/]/).filter(Boolean).pop():'Workspace'}</button>}
      {active?.workspace&&<button className="icon-btn" aria-label="Detach workspace folder" title="Detach workspace" onClick={()=>void clearWorkspace()}><X size={12}/></button>}
      {active?.workspace&&<button className={'branch-link'+(active.workspaceReadonly?' workspace-on':'')}
       title={active.workspaceReadonly?'Read-only mode is ON: the model cannot write files or run commands. Click to allow writes (with approval).':'Read-only mode is off. Click to forbid all file writes in this chat.'}
       onClick={()=>void toggleReadonly()}>
       <Shield size={12}/>{active.workspaceReadonly?'Read-only':'Writable'}</button>}
     </div>
     <div className="toolbar-right">
      {active&&<>
       {!!todos.length&&<button className={'icon-btn'+(showTodos?' active':'')} aria-label="Task checklist" title="Task checklist (todo_write)" onClick={()=>setShowTodos(v=>!v)}><ListChecks size={16}/></button>}
       {active.workspace&&<button className={'icon-btn'+(showFileOps?' active':'')} aria-label="Workspace activity" title="Workspace activity — files the model read, wrote, or was refused" onClick={()=>setShowFileOps(v=>!v)}><FileClock size={16}/></button>}
       <button className={'icon-btn'+(showDocs?' active':'')} aria-label="Attached documents" title="Attached documents (RAG) — their relevant excerpts are added to the model's context" onClick={()=>setShowDocs(v=>!v)}><BookOpen size={16}/></button>
       <button className="icon-btn" aria-label="Compare models" title="Compare: replay this conversation on another model, side by side" onClick={()=>{setCompareAnswers(null);setCompareOpen(true);}}><GitCompareArrows size={16}/></button>
       {messages.length>=4&&<button className="icon-btn" aria-label="Summarize this chat" title="Summarize this chat (start fresh with the summary)" disabled={summarizing} onClick={()=>void runSummarize()}><Sparkles size={16}/></button>}
       <button className="icon-btn" aria-label={active.archived?'Unarchive this chat':'Archive this chat'} title={active.archived?'Unarchive':'Archive (hide without deleting)'} onClick={()=>void toggleArchived(active)}><Archive size={16}/></button>
      </>}
      <button className={'icon-btn'+(focusMode?' active':'')} aria-label="Focus mode" title="Focus mode — hide everything but the conversation (Esc to exit)" onClick={()=>setFocusMode(v=>!v)}>{focusMode?<Minimize2 size={16}/>:<Maximize2 size={16}/>}</button>
      {!isMobile&&<button className={'icon-btn'+(alwaysOnTop?' active':'')} aria-label="Always on top" title="Always on top" onClick={toggleAlwaysOnTop}><Pin size={16}/></button>}
      <span className="private-label"><Shield size={13}/>Private by design</span>
      <button className="icon-btn" aria-label="Settings" onClick={openProvidersTab}><Settings size={16}/></button>
     </div>
    </div>
    {/* Batch-5 side panels: the model's checklist and the workspace activity log. */}
    {showTodos&&!!todos.length&&<aside className="side-panel" aria-label="Task checklist">
     <header><CheckSquare size={13}/> Tasks</header>
     <ul>{todos.map((t,i)=><li key={i} className={t.done?'done':''}><input type="checkbox" checked={t.done} readOnly tabIndex={-1}/><span>{t.text}</span></li>)}</ul>
    </aside>}
    {showFileOps&&<aside className="side-panel" aria-label="Workspace activity">
     <header><FileClock size={13}/> Workspace activity</header>
     {fileOps.length?<ul>{fileOps.map(op=><li key={op.id} className={'op-'+op.status}>
       <div><b>{op.tool}</b>{op.path&&<code>{op.path}</code>}</div>
       <small>{new Date(op.createdAt).toLocaleTimeString()} · {op.status}{op.detail&&' — '+op.detail.slice(0,120)}</small>
       {op.snapshot&&op.status==='ok'&&op.tool!=='rollback'&&<button className="op-rollback" onClick={()=>void rollbackOp(op.id)}>Roll back</button>}
      </li>)}</ul>:<div className="empty-state"><FileClock size={18}/><p>No operations yet — file activity of the model will show up here.</p></div>}
    </aside>}
    {/* Batch 6: attached documents (RAG) — relevant excerpts join the system prompt. */}
    {showDocs&&<aside className="side-panel" aria-label="Attached documents">
     <header><BookOpen size={13}/> Documents</header>
     {docs.length?<ul>{docs.map(d=><li key={d.id}>
       <div><b>{d.name}</b></div>
       <small>{Math.round(d.chars/100)/10}k chars · {new Date(d.createdAt).toLocaleDateString()}</small>
       <button className="op-rollback" onClick={()=>void removeDoc(d.id)}>Remove</button>
      </li>)}</ul>:<div className="empty-state"><BookOpen size={18}/><p>No documents yet — attach a text, markdown or PDF file and the model will quote from it.</p><button className="secondary-button" onClick={()=>void attachDoc()}>Attach document…</button></div>}
     <div className="settings-actions"><button className="secondary-button" disabled={docs.length>=8} onClick={()=>void attachDoc()}>Attach document…</button></div>
    </aside>}
    <section className="conversation" ref={conversation} onScroll={onScroll}>
     {messages.length===0&&!stream&&!busy
      ?<Welcome needsSetup={needsSetup} onSetup={openProvidersTab} onPick={pickSuggestion}/>
      :<MessageList messages={messages} busy={busy} stream={stream?.text??''} reasoning={stream?.reasoning??''} error={error}
        status={stream?.status} highlightId={highlightId} toolEvents={stream?.toolEvents}
        variants={variants} providers={providers} bottomRef={bottom} onCopy={copy} onRegenerate={regenerate}
        onContinue={continueMessage} onDeleteMessage={deleteMessage} onEditMessage={commitEdit} onRetry={regenerate}
        onLoadVariants={loadVariants} onRestoreVariant={restoreVariant} onBranch={branchChat} onBookmark={toggleBookmark} onRate={rateMessage} userInitial={profile.username?profile.username[0].toUpperCase():'Y'}/>}
    </section>
    {!atBottom&&(messages.length>0||busy)&&<button className="scroll-bottom" aria-label="Scroll to latest" onClick={scrollToBottom}>↓</button>}
    <Composer ref={input} draft={draft} busy={busy} needsSetup={needsSetup} providers={providers} providerId={providerId} model={model}
      images={images} onAddImages={addImages} onRemoveImage={removeImage}
      personas={settings.personas} personaId={settings.personaId} onPersona={id=>void pref('personaId',id)}
      templates={settings.templates} onSlash={handleSlash}
      history={history} queued={activeId?queues[activeId]??[]:[]} onClearQueue={clearQueue} onEnhance={enhanceDraft}
      onDraft={setDraft} onSend={send} onStop={stopActive} onOpenSettings={openProvidersTab}
      onProvider={changeProvider} onModel={selectModel} fileQuery={active?.workspace||settings.defaultWorkspace?fileQuery:undefined}/>
   </main>
  </div>
  {/* Compare mode: the last turn replayed on a second provider/model, side by side. */}
  {compareOpen&&<div className="modal-backdrop" role="dialog" aria-label="Compare models" onClick={()=>setCompareOpen(false)}>
   <div className="modal compare-modal" onClick={e=>e.stopPropagation()}>
    <header><h2><GitCompareArrows size={16}/> Compare models</h2><button className="icon-btn" aria-label="Close" onClick={()=>setCompareOpen(false)}><X size={16}/></button></header>
    <div className="compare-controls">
     <select value={compareProvider} onChange={e=>{const id=e.target.value as ProviderId;setCompareProvider(id);setCompareModel(providers.find(x=>x.id===id)?.models[0]??'');}} aria-label="Compare provider">
      {providers.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
     </select>
     <select value={compareModel} onChange={e=>setCompareModel(e.target.value)} aria-label="Compare model">
      <option value="">Choose model</option>
      {(providers.find(p=>p.id===compareProvider)?.models??[]).map(m=><option key={m} value={m}>{m}</option>)}
     </select>
     <button className="btn-primary" disabled={compareBusy||!compareModel||!active} onClick={()=>void runCompare()}>{compareBusy?'Comparing…':'Run compare'}</button>
    </div>
    {compareAnswers&&<div className="compare-grid">
     {compareAnswers.map((a,i)=><div className="compare-cell" key={i}>
      <header><b>{a.model}</b><small>{a.providerId}{a.completionTokens?' · ↓'+a.completionTokens:''}</small></header>
      {a.error?<p className="compare-error" role="alert">{a.error}</p>:<div className="markdown" dangerouslySetInnerHTML={{__html:renderMarkdown(a.text||'(no answer)')}}/>}
     </div>)}
    </div>}
   </div>
  </div>}
  {/* Command palette (Ctrl+P): commands above, matching conversations below. */}
  {showPalette&&<div className="modal-backdrop" role="dialog" aria-label="Command palette" onClick={()=>setShowPalette(false)}>
   <div className="modal palette-modal" onClick={e=>e.stopPropagation()}>
    <div className="palette-head"><Command size={14}/><input autoFocus value={paletteQuery} placeholder="Type a command or chat name…" aria-label="Command palette"
     onChange={e=>setPaletteQuery(e.target.value)}
     onKeyDown={e=>{
      if(e.key==='Escape'){setShowPalette(false);return;}
      if(e.key==='Enter'){
       const q=paletteQuery.trim().toLowerCase();
       const items=paletteItems(q);
       if(items[0]){setShowPalette(false);items[0].run();}
      }
     }}/></div>
    <div className="palette-list">{paletteItems(paletteQuery.trim().toLowerCase()).map(it=>
     <button key={it.id} onClick={()=>{setShowPalette(false);it.run();}}>{it.icon}<span>{it.label}</span>{it.hint&&<small>{it.hint}</small>}</button>)}
     {paletteItems(paletteQuery.trim().toLowerCase()).length===0&&<div className="empty-state"><Command size={16}/><p>No matches for «{paletteQuery.trim()}»</p></div>}
    </div>
   </div>
  </div>}
  {/* Summarize modal: the condensed transcript with a one-click fresh start. */}
  {summary&&<div className="modal-backdrop" role="dialog" aria-label="Chat summary" onClick={()=>setSummary(null)}>
   <div className="modal summary-modal" onClick={e=>e.stopPropagation()}>
    <header><h2><Sparkles size={16}/> Summary</h2><button className="icon-btn" aria-label="Close" onClick={()=>setSummary(null)}><X size={16}/></button></header>
    <div className="summary-body markdown-body" dangerouslySetInnerHTML={{__html:renderMarkdown(summary)}}/>
    <footer><button className="btn-secondary" onClick={()=>setSummary(null)}>Close</button>
     <button className="btn-primary" onClick={()=>void newChatFromSummary()}>New chat from summary</button></footer>
   </div>
  </div>}
  {showSettings&&<SettingsModal tab={tab} onTab={setTab} providers={providers} providerId={providerId} model={model}
    settings={settings} hasActiveChat={!!active} onClose={closeSettings}
    onProviderSelect={changeProvider} onModel={selectModel} onPref={pref}
    onSaveProvider={saveProvider} onRemoveProvider={removeProvider} onCreateProvider={createProvider} onTestProvider={testProvider}
    onRefreshModels={refreshModels} refreshingModels={refreshingModels}
    onExport={exportChat} onExportPrepared={exportPrepared} onExportZip={exportZip} onWipe={wipeData} onOpenDataFolder={openDataFolder}
    notice={notice} onNotice={flash}/>}
  {notice&&!showSettings&&<div className="toast" role="status">{notice}</div>}
  {/* Actionable toast: a workspace file was just changed — one click rolls it back. */}
  {actionToast&&<div className="toast toast-action" role="status">
   <span>{actionToast.text}</span>
   <button onClick={()=>{const id=actionToast.opId;setActionToast(null);void rollbackOp(id);}}>Roll back</button>
   <button aria-label="Dismiss" onClick={()=>setActionToast(null)}><X size={12}/></button>
  </div>}
 </div>;
}
