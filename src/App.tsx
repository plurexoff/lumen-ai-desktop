import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {AlertTriangle,GitFork,PanelLeftClose,Settings,Shield} from 'lucide-react';
import {useApp} from './store';
import type {PendingImage,Prefs,State,StreamState} from './store';
import type {Chat,ChatChunk,Message,MessageVariant,ProviderConfig,ProviderId} from '../electron/shared';
import {IMAGE_MIMES,MAX_ATTACHMENT_BYTES,MAX_IMAGE_ATTACHMENTS} from '../electron/shared';
import Titlebar from './components/Titlebar';
import Sidebar from './components/Sidebar';
import Welcome from './components/Welcome';
import MessageList from './components/MessageList';
import Composer from './components/Composer';
import SettingsModal from './components/SettingsModal';

type Tab='providers'|'appearance'|'agents'|'data';
// Request params are taken from preferences; `theme` is deliberately not forwarded.
// A selected persona overrides the system prompt and (when pinned) the temperature.
const requestParams=(s:Prefs)=>{
 const persona=s.personas.find(p=>p.id===s.personaId);
 return{systemPrompt:persona?.prompt||s.systemPrompt,temperature:persona?.temperature??s.temperature,maxTokens:s.maxTokens,topP:s.topP};
};
const newStream=(requestId:string):StreamState=>({requestId,text:'',reasoning:'',error:'',finishReason:null,usage:null});
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
 (p.id==='custom'&&(p.baseUrl.includes('://localhost')||p.baseUrl.includes('://127.0.0.1')||p.baseUrl.includes('://[::1]')));

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
 const [showSidebar,setShowSidebar]=useState(true);
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
 // Messages typed while a chat was still generating, keyed by chatId. Drained one
 // at a time by the queue-flush effect below when that chat's stream settles.
 const [queues,setQueues]=useState<Record<string,string[]>>({});
 const queuesRef=useRef(queues);

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
 const newChatAndFocus=useCallback(()=>{void newChat().then(()=>input.current?.focus());},[newChat]);
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
  void Promise.all([window.lumen.chats.list(),window.lumen.providers.list(),window.lumen.settings.get(),window.lumen.chat.status()])
   .then(([cs,ps,prefs,active])=>{
    const initial=cs[0];
    const streams:Record<string,StreamState>={};
    for(const a of active)streams[a.chatId]=newStream(a.requestId);
    set({chats:cs,providers:ps,settings:prefs,streams,
     ...(initial?{activeId:initial.id,providerId:initial.providerId,model:initial.model}:ps[0]?{providerId:ps[0].id,model:ps[0].models[0]??''}:{})});
    if(initial)void load(initial.id);
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

 return <div className="app-shell" data-theme={settings.theme} data-accent={settings.accent}>
  <Titlebar busy={anyBusy}/>
  <div className="layout">
   {showSidebar&&<Sidebar chats={chats} activeId={activeId} providers={providers} busyIds={busyIds} needsSetup={needsSetup}
     newChatHotkey={settings.hotkeys.newChat}
     onNew={newChatAndFocus} onOpen={openChat} onDelete={removeChat} onRename={renameChat} onOpenSettings={openProvidersTab}/>}
   <main className="main-panel">
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
     </div>
     <div className="toolbar-right"><span className="private-label"><Shield size={13}/>Private by design</span>
      <button className="icon-btn" aria-label="Settings" onClick={openProvidersTab}><Settings size={16}/></button>
     </div>
    </div>
    <section className="conversation" ref={conversation} onScroll={onScroll}>
     {messages.length===0&&!stream&&!busy
      ?<Welcome needsSetup={needsSetup} onSetup={openProvidersTab} onPick={pickSuggestion}/>
      :<MessageList messages={messages} busy={busy} stream={stream?.text??''} reasoning={stream?.reasoning??''} error={error}
        variants={variants} providers={providers} bottomRef={bottom} onCopy={copy} onRegenerate={regenerate}
        onContinue={continueMessage} onDeleteMessage={deleteMessage} onEditMessage={commitEdit} onRetry={regenerate}
        onLoadVariants={loadVariants} onRestoreVariant={restoreVariant} onBranch={branchChat}/>}
    </section>
    {!atBottom&&(messages.length>0||busy)&&<button className="scroll-bottom" aria-label="Scroll to latest" onClick={scrollToBottom}>↓</button>}
    <Composer ref={input} draft={draft} busy={busy} needsSetup={needsSetup} providers={providers} providerId={providerId} model={model}
      images={images} onAddImages={addImages} onRemoveImage={removeImage}
      personas={settings.personas} personaId={settings.personaId} onPersona={id=>void pref('personaId',id)}
      history={history} queued={activeId?queues[activeId]??[]:[]} onClearQueue={clearQueue} onEnhance={enhanceDraft}
      onDraft={setDraft} onSend={send} onStop={stopActive} onOpenSettings={openProvidersTab}
      onProvider={changeProvider} onModel={selectModel}/>
   </main>
  </div>
  {showSettings&&<SettingsModal tab={tab} onTab={setTab} providers={providers} providerId={providerId} model={model}
    settings={settings} hasActiveChat={!!active} onClose={closeSettings}
    onProviderSelect={changeProvider} onModel={selectModel} onPref={pref}
    onSaveProvider={saveProvider} onRemoveProvider={removeProvider} onTestProvider={testProvider}
    onRefreshModels={refreshModels} refreshingModels={refreshingModels}
    onExport={exportChat} onWipe={wipeData} onOpenDataFolder={openDataFolder}
    notice={notice} onNotice={flash}/>}
  {notice&&!showSettings&&<div className="toast" role="status">{notice}</div>}
 </div>;
}
