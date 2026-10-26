import {useEffect,useMemo,useState} from 'react';
import {Check,ChevronDown,Loader2,MessageSquare,MoreHorizontal,Pencil,Plus,Search,Trash2,X,Zap} from 'lucide-react';
import type {Chat,ProviderConfig} from '../../electron/shared';

interface Props{
 chats:Chat[];
 activeId:string|null;
 providers:ProviderConfig[];
 // Chats with a generation in flight; memoized as a Set in App so identity is stable
 // while text streams and only changes when a generation starts or ends.
 busyIds:Set<string>;
 needsSetup:boolean;
 newChatHotkey:string;
 onNew:()=>void;
 onOpen:(chat:Chat)=>void;
 onDelete:(chat:Chat)=>void;
 onRename:(id:string,title:string)=>void;
 onOpenSettings:()=>void;
}

interface SearchHit{chatId:string;title:string;snippet:string}

function groupLabel(updatedAt:number):string{
 const d=new Date(updatedAt),now=new Date();
 const startOf=(x:Date)=>new Date(x.getFullYear(),x.getMonth(),x.getDate()).getTime();
 const days=Math.round((startOf(now)-startOf(d))/86400000);
 if(days<=0)return 'Today';
 if(days===1)return 'Yesterday';
 if(days<7)return 'Last 7 days';
 return 'Earlier';
}

export default function Sidebar({chats,activeId,providers,busyIds,needsSetup,newChatHotkey,onNew,onOpen,onDelete,onRename,onOpenSettings}:Props){
 const [query,setQuery]=useState('');
 const [hits,setHits]=useState<SearchHit[]>([]);
 const [searching,setSearching]=useState(false);
 const [renamingId,setRenamingId]=useState<string|null>(null);
 const [renameValue,setRenameValue]=useState('');
 const [pendingDelete,setPendingDelete]=useState<Chat|null>(null);
 const [showResults,setShowResults]=useState(false);

 // Full-text search over message contents (debounced) in addition to titles.
 useEffect(()=>{
  const term=query.trim();
  if(term.length<2){setHits([]);setSearching(false);return;}
  setSearching(true);
  const t=window.setTimeout(()=>{void window.lumen.chats.search(term).then(r=>{setHits(r);setSearching(false);}).catch(()=>setSearching(false));},250);
  return()=>window.clearTimeout(t);
 },[query]);

 // Escape closes the search panel and clears it — the modal-free way out.
 useEffect(()=>{
  if(!query)return;
  const onKey=(e:KeyboardEvent)=>{if(e.key==='Escape'){setQuery('');setHits([]);setShowResults(false);}};
  window.addEventListener('keydown',onKey);
  return()=>window.removeEventListener('keydown',onKey);
 },[query]);

 const groups=useMemo(()=>{
  const term=query.trim().toLowerCase();
  const list=term?chats.filter(c=>c.title.toLowerCase().includes(term)):chats;
  return list.reduce<Record<string,Chat[]>>((a,c)=>{(a[groupLabel(c.updatedAt)]??=[]).push(c);return a;},{});
 },[chats,query]);

 // Conversations whose TITLE matches, shown in their own section above the message
 // hits. contentHits below excludes these so a chat is not listed twice.
 const titleMatches=useMemo(()=>{
  const term=query.trim().toLowerCase();
  return term?chats.filter(c=>c.title.toLowerCase().includes(term)):[];
 },[chats,query]);

 const contentHits=useMemo(()=>{
  const term=query.trim().toLowerCase();
  if(!term)return [];
  const titleIds=new Set(titleMatches.map(c=>c.id));
  const seen=new Set<string>();
  return hits.filter(h=>{if(titleIds.has(h.chatId)||seen.has(h.chatId))return false;seen.add(h.chatId);return true;});
 },[hits,query,titleMatches]);

 function startRename(chat:Chat){setRenamingId(chat.id);setRenameValue(chat.title);}
 function commitRename(){
  if(!renamingId)return;
  const value=renameValue.trim();
  const chat=chats.find(c=>c.id===renamingId);
  if(value&&chat&&value!==chat.title)onRename(renamingId,value);
  setRenamingId(null);
 }

 return <>
 <aside className="sidebar">
  <div className="workspace"><div className="workspace-logo">L</div><div><b>Lumen</b><small>Personal workspace</small></div><ChevronDown size={14}/></div>
  <button className="new-chat" onClick={onNew}><Plus size={16}/>New conversation<kbd>{newChatHotkey}</kbd></button>
  <label className="search-box"><Search size={14}/>
   <input value={query} onChange={e=>{setQuery(e.target.value);setShowResults(true);}} onFocus={()=>setShowResults(true)} placeholder="Search conversations" aria-label="Search conversations"/>
   {query&&<button type="button" aria-label="Clear search" onClick={()=>{setQuery('');setHits([]);}}><X size={12}/></button>}
  </label>
  {!showResults||!query.trim()?<>
   <div className="section-label">WORKSPACE</div>
   <button className="nav-link active"><MessageSquare size={15}/>Conversations<span>{chats.length}</span></button>
   <button className="nav-link" onClick={onOpenSettings}><Zap size={15}/>Providers & settings<span>{providers.length}</span></button>
   <div className="chat-list">{Object.entries(groups).map(([label,list])=><div key={label}>
    <div className="section-label group-label">{label}</div>
    {list.map(c=><div className={'chat-row '+(c.id===activeId?'selected':'')} key={c.id}>
     {renamingId===c.id
      ?<span className="chat-rename"><input autoFocus value={renameValue} onChange={e=>setRenameValue(e.target.value)}
        onBlur={commitRename}
        onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();commitRename();}if(e.key==='Escape')setRenamingId(null);}}/>
        <button className="rename-ok" aria-label="Save name" onMouseDown={e=>e.preventDefault()} onClick={commitRename}><Check size={13}/></button></span>
      :<>
       <button className="chat-name" onDoubleClick={()=>startRename(c)} onClick={()=>onOpen(c)} title={c.title}>
        {busyIds.has(c.id)?<Loader2 size={14} className="spin"/>:<MessageSquare size={14}/>}<span>{c.title}</span>
       </button>
       <span className="chat-actions">
        <button aria-label={'Rename '+c.title} title="Rename (double-click)" onClick={()=>startRename(c)}><Pencil size={12}/></button>
        <button aria-label={'Delete '+c.title} title="Delete" onClick={()=>setPendingDelete(c)}><Trash2 size={13}/></button>
       </span>
      </>}
    </div>)}
   </div>)}</div>
  </>:<div className="chat-list">
   {/* Title matches were computed into `groups` but only rendered in the non-search
       branch, while contentHits deliberately excludes them — so searching by title
       found nothing at all. Render both sections. */}
   {!!titleMatches.length&&<>
    <div className="section-label group-label">CONVERSATIONS</div>
    {titleMatches.map(c=><div className={'chat-row '+(c.id===activeId?'selected':'')} key={c.id}>
     <button className="chat-name" onClick={()=>onOpen(c)} title={c.title}>
      {busyIds.has(c.id)?<Loader2 size={14} className="spin"/>:<MessageSquare size={14}/>}<span>{c.title}</span>
     </button>
    </div>)}
   </>}
   <div className="section-label group-label">IN MESSAGES{searching?' · SEARCHING…':''}</div>
   {!searching&&!contentHits.length&&<div className="models-empty">No matches inside conversations</div>}
   {contentHits.map(h=><div className="chat-row" key={h.chatId}>
    <button className="chat-name" onClick={()=>{const chat=chats.find(c=>c.id===h.chatId);if(chat)onOpen(chat);}}>
     <Search size={13}/><span className="hit-text"><b>{h.title}</b><small>{h.snippet}</small></span>
    </button>
   </div>)}
  </div>}
  <div className="sidebar-bottom">
   {needsSetup&&<div className="connect-card"><Zap size={15}/><div><b>Bring your own AI</b><small>Connect a provider to begin</small></div><button onClick={onOpenSettings}>Setup</button></div>}
   <button className="profile" onClick={onOpenSettings}><div className="avatar">L</div><div><b>Local workspace</b><small>Settings & preferences</small></div><MoreHorizontal size={16}/></button>
  </div>
 </aside>
 {pendingDelete&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setPendingDelete(null);}}>
  <section className="confirm-modal" role="dialog" aria-modal="true" aria-label="Delete conversation">
   <h3>Delete conversation?</h3>
   <p>“{pendingDelete.title}” and all of its messages will be permanently removed.</p>
   <div className="settings-actions">
    <button className="secondary-button" onClick={()=>setPendingDelete(null)}>Cancel</button>
    <button className="danger-button" onClick={()=>{const chat=pendingDelete;setPendingDelete(null);onDelete(chat);}}>Delete</button>
   </div>
  </section>
 </div>}
 </>;
}
