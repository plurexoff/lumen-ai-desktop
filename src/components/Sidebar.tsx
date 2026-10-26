import {useEffect,useMemo,useState} from 'react';
import type {DragEvent} from 'react';
import {Archive,ArchiveRestore,Check,ChevronDown,ChevronRight,Folder as FolderIcon,FolderPlus,Loader2,MessageSquare,MoreHorizontal,Pencil,Pin,PinOff,Plus,Search,SlidersHorizontal,Tag,Trash2,X,Zap} from 'lucide-react';
import type {Chat,Folder,ProviderConfig,SearchFilters,SearchResult} from '../../electron/shared';

interface Props{
 chats:Chat[];
 activeId:string|null;
 providers:ProviderConfig[];
 folders:Folder[];
 // Chats with a generation in flight; memoized as a Set in App so identity is stable
 // while text streams and only changes when a generation starts or ends.
 busyIds:Set<string>;
 // Chats with a reply that finished while another chat was open (cleared on open).
 unread:Set<string>;
 needsSetup:boolean;
 newChatHotkey:string;
 onNew:()=>void;
 onOpen:(chat:Chat)=>void;
 onDelete:(chat:Chat)=>void;
 onRename:(id:string,title:string)=>void;
 onOpenSettings:()=>void;
 onTogglePin:(chat:Chat)=>void;
 onMoveFolder:(chatId:string,folderId:string|null)=>void;
 onToggleArchived:(chat:Chat)=>void;
 onSetTags:(chatId:string,tags:string[])=>void;
 onCreateFolder:(name:string)=>void;
 onRenameFolder:(id:string,name:string)=>void;
 onDeleteFolder:(id:string)=>void;
 // Search jump: open the chat and scroll straight to the matched message.
 onOpenHit:(chatId:string,messageId:string)=>void;
}

type SearchHit=SearchResult;

function groupLabel(updatedAt:number):string{
 const d=new Date(updatedAt),now=new Date();
 const startOf=(x:Date)=>new Date(x.getFullYear(),x.getMonth(),x.getDate()).getTime();
 const days=Math.round((startOf(now)-startOf(d))/86400000);
 if(days<=0)return 'Today';
 if(days===1)return 'Yesterday';
 if(days<7)return 'Last 7 days';
 return 'Earlier';
}

export default function Sidebar({chats,activeId,providers,folders,busyIds,unread,needsSetup,newChatHotkey,onNew,onOpen,onDelete,onRename,onOpenSettings,onTogglePin,onMoveFolder,onToggleArchived,onSetTags,onCreateFolder,onRenameFolder,onDeleteFolder,onOpenHit}:Props){
 const [query,setQuery]=useState('');
 const [hits,setHits]=useState<SearchHit[]>([]);
 const [searching,setSearching]=useState(false);
 const [renamingId,setRenamingId]=useState<string|null>(null);
 const [renameValue,setRenameValue]=useState('');
 const [pendingDelete,setPendingDelete]=useState<Chat|null>(null);
 const [showResults,setShowResults]=useState(false);
 // Collapsed folder ids and the folder currently being renamed/created.
 const [collapsed,setCollapsed]=useState<Set<string>>(new Set());
 const [folderEdit,setFolderEdit]=useState<string|null>(null);
 const [folderValue,setFolderValue]=useState('');
 const [addingFolder,setAddingFolder]=useState(false);
 const [newFolderName,setNewFolderName]=useState('');
 const [pendingFolderDelete,setPendingFolderDelete]=useState<Folder|null>(null);
 // Drop-target highlight while dragging a chat over a folder header / ungrouped area.
 const [dropTarget,setDropTarget]=useState<string|null>(null);
 // Batch 5: archived chats live in a collapsed section; tags edit inline; the search
 // panel has optional filters (model / role / folder / tag / date range).
 const [showArchived,setShowArchived]=useState(false);
 const [tagEditId,setTagEditId]=useState<string|null>(null);
 const [tagValue,setTagValue]=useState('');
 const [showFilters,setShowFilters]=useState(false);
 const [fModel,setFModel]=useState('');
 const [fRole,setFRole]=useState('');
 const [fFolder,setFFolder]=useState('');
 const [fTag,setFTag]=useState('');
 const [fFrom,setFFrom]=useState('');
 const [fTo,setFTo]=useState('');
 const hasFilters=!!(fModel||fRole||fFolder||fTag||fFrom||fTo);

 // Full-text search over message contents (debounced) in addition to titles.
 useEffect(()=>{
  const term=query.trim();
  if(term.length<2&&!hasFilters){setHits([]);setSearching(false);return;}
  setSearching(true);
  const filters:SearchFilters={query:term||undefined,model:fModel||undefined,role:(fRole as 'user'|'assistant')||undefined,folderId:fFolder||null,tag:fTag.trim()||undefined};
  if(fFrom){const t=new Date(fFrom+'T00:00:00').getTime();if(Number.isFinite(t))filters.from=t;}
  if(fTo){const t=new Date(fTo+'T23:59:59').getTime();if(Number.isFinite(t))filters.to=t;}
  const t=window.setTimeout(()=>{void window.lumen.chats.search(filters).then(r=>{setHits(r);setSearching(false);}).catch(()=>setSearching(false));},250);
  return()=>window.clearTimeout(t);
 },[query,fModel,fRole,fFolder,fTag,fFrom,fTo,hasFilters]);

 // Escape closes the search panel and clears it — the modal-free way out.
 useEffect(()=>{
  if(!query)return;
  const onKey=(e:KeyboardEvent)=>{if(e.key==='Escape'){setQuery('');setHits([]);setShowResults(false);}};
  window.addEventListener('keydown',onKey);
  return()=>window.removeEventListener('keydown',onKey);
 },[query]);

 const visibleChats=useMemo(()=>chats.filter(c=>!c.archived),[chats]);
 const archivedChats=useMemo(()=>chats.filter(c=>c.archived),[chats]);
 const pinnedChats=useMemo(()=>visibleChats.filter(c=>c.pinned),[visibleChats]);
 const folderChats=useMemo(()=>{
  const map=new Map<string,Chat[]>();
  for(const c of visibleChats)if(!c.pinned&&c.folderId)(map.get(c.folderId)??map.set(c.folderId,[]).get(c.folderId)!).push(c);
  return map;
 },[visibleChats]);
 // Ungrouped = not pinned and not in any (existing) folder.
 const ungrouped=useMemo(()=>{
  const ids=new Set(folders.map(f=>f.id));
  const list=visibleChats.filter(c=>!c.pinned&&(!c.folderId||!ids.has(c.folderId)));
  return list.reduce<Record<string,Chat[]>>((a,c)=>{(a[groupLabel(c.updatedAt)]??=[]).push(c);return a;},{});
 },[visibleChats,folders]);
 // All known models across providers — for the search filter dropdown.
 const allModels=useMemo(()=>[...new Set(providers.flatMap(p=>p.models))],[providers]);
 const allTags=useMemo(()=>[...new Set(chats.flatMap(c=>c.tags??[]))],[chats]);

 // Conversations whose TITLE matches, shown in their own section above the message
 // hits. contentHits below excludes these so a chat is not listed twice.
 const titleMatches=useMemo(()=>{
  const term=query.trim().toLowerCase();
  return term?visibleChats.filter(c=>c.title.toLowerCase().includes(term)):[];
 },[visibleChats,query]);

 const contentHits=useMemo(()=>{
  const term=query.trim().toLowerCase();
  if(!term&&!hasFilters)return [];
  const titleIds=new Set(titleMatches.map(c=>c.id));
  return hits.filter(h=>!titleIds.has(h.chatId));
 },[hits,query,titleMatches,hasFilters]);

 function startRename(chat:Chat){setRenamingId(chat.id);setRenameValue(chat.title);}
 function commitRename(){
  if(!renamingId)return;
  const value=renameValue.trim();
  const chat=chats.find(c=>c.id===renamingId);
  if(value&&chat&&value!==chat.title)onRename(renamingId,value);
  setRenamingId(null);
 }
 function commitFolderEdit(){
  if(!folderEdit)return;
  const value=folderValue.trim();
  const folder=folders.find(f=>f.id===folderEdit);
  if(value&&folder&&value!==folder.name)onRenameFolder(folderEdit,value);
  setFolderEdit(null);
 }
 function commitNewFolder(){
  const value=newFolderName.trim();
  if(value)onCreateFolder(value);
  setNewFolderName('');setAddingFolder(false);
 }
 function toggleCollapsed(id:string){
  setCollapsed(s=>{const n=new Set(s);if(n.has(id))n.delete(id);else n.add(id);return n;});
 }
 function startTagEdit(c:Chat){setTagEditId(c.id);setTagValue((c.tags??[]).join(', '));}
 function commitTagEdit(){
  if(!tagEditId)return;
  onSetTags(tagEditId,tagValue.split(',').map(t=>t.trim()).filter(Boolean));
  setTagEditId(null);
 }

 // Drag-and-drop: chats carry their id; folder headers and the ungrouped label are
 // drop targets. Dropping on the ungrouped label clears the folder.
 function dragChat(e:DragEvent,chatId:string){e.dataTransfer.setData('text/lumen-chat',chatId);e.dataTransfer.effectAllowed='move';}
 function dropOn(e:DragEvent,folderId:string|null,key:string){
  e.preventDefault();setDropTarget(null);
  const chatId=e.dataTransfer.getData('text/lumen-chat');
  if(chatId)onMoveFolder(chatId,folderId);
  void key;
 }
 const allowDrop=(key:string)=>(e:DragEvent)=>{if(e.dataTransfer.types.includes('text/lumen-chat')){e.preventDefault();setDropTarget(key);}};

 function chatRow(c:Chat){
  return <div className={'chat-row '+(c.id===activeId?'selected':'')} key={c.id}
   draggable={renamingId!==c.id} onDragStart={e=>dragChat(e,c.id)}>
   {renamingId===c.id
    ?<span className="chat-rename"><input autoFocus value={renameValue} onChange={e=>setRenameValue(e.target.value)}
      onBlur={commitRename}
      onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();commitRename();}if(e.key==='Escape')setRenamingId(null);}}/>
      <button className="rename-ok" aria-label="Save name" onMouseDown={e=>e.preventDefault()} onClick={commitRename}><Check size={13}/></button></span>
    :<>
     <button className="chat-name" onDoubleClick={()=>startRename(c)} onClick={()=>onOpen(c)} title={c.title}>
      {busyIds.has(c.id)?<Loader2 size={14} className="spin"/>:<MessageSquare size={14}/>}<span>{c.title}</span>
      {unread.has(c.id)&&<i className="unread-dot" aria-label="New reply"/>}
     </button>
     {!!c.tags?.length&&<span className="chat-tags">{c.tags.map(t=><button key={t} className="tag-chip" title={'Search tag: '+t} onClick={()=>{setQuery('');setFTag(t);setShowFilters(true);setShowResults(true);}}>{t}</button>)}</span>}
     {tagEditId===c.id
      ?<span className="chat-rename"><input autoFocus value={tagValue} placeholder="tags, comma separated" aria-label="Edit tags"
        onChange={e=>setTagValue(e.target.value)} onBlur={commitTagEdit}
        onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();commitTagEdit();}if(e.key==='Escape')setTagEditId(null);}}/>
        <button className="rename-ok" aria-label="Save tags" onMouseDown={e=>e.preventDefault()} onClick={commitTagEdit}><Check size={13}/></button></span>
      :<span className="chat-actions">
       <button aria-label={(c.pinned?'Unpin ':'Pin ')+c.title} title={c.pinned?'Unpin':'Pin to top'} onClick={()=>onTogglePin(c)}>{c.pinned?<PinOff size={12}/>:<Pin size={12}/>}</button>
       <button aria-label={'Edit tags of '+c.title} title="Tags (comma separated)" onClick={()=>startTagEdit(c)}><Tag size={12}/></button>
       <button aria-label={(c.archived?'Unarchive ':'Archive ')+c.title} title={c.archived?'Unarchive':'Archive'} onClick={()=>onToggleArchived(c)}>{c.archived?<ArchiveRestore size={12}/>:<Archive size={12}/>}</button>
       <button aria-label={'Rename '+c.title} title="Rename (double-click)" onClick={()=>startRename(c)}><Pencil size={12}/></button>
       <button aria-label={'Delete '+c.title} title="Delete" onClick={()=>setPendingDelete(c)}><Trash2 size={13}/></button>
      </span>}
    </>}
  </div>;
 }

 return <>
 <aside className="sidebar">
  <div className="workspace"><div className="workspace-logo">L</div><div><b>Lumen</b><small>Personal workspace</small></div><ChevronDown size={14}/></div>
  <button className="new-chat" onClick={onNew}><Plus size={16}/>New conversation<kbd>{newChatHotkey}</kbd></button>
  <label className="search-box"><Search size={14}/>
   <input value={query} onChange={e=>{setQuery(e.target.value);setShowResults(true);}} onFocus={()=>setShowResults(true)} placeholder="Search conversations" aria-label="Search conversations"/>
   <button type="button" className={'filter-toggle'+(showFilters||hasFilters?' active':'')} aria-label="Search filters" title="Filter by model, role, folder, tag, date" onClick={()=>setShowFilters(v=>!v)}><SlidersHorizontal size={12}/></button>
   {query&&<button type="button" aria-label="Clear search" onClick={()=>{setQuery('');setHits([]);}}><X size={12}/></button>}
  </label>
  {showFilters&&<div className="search-filters">
   <select value={fModel} onChange={e=>setFModel(e.target.value)} aria-label="Filter by model"><option value="">Any model</option>{allModels.map(m=><option key={m} value={m}>{m}</option>)}</select>
   <select value={fRole} onChange={e=>setFRole(e.target.value)} aria-label="Filter by role"><option value="">Any role</option><option value="user">My messages</option><option value="assistant">Replies</option></select>
   <select value={fFolder} onChange={e=>setFFolder(e.target.value)} aria-label="Filter by folder"><option value="">Any folder</option>{folders.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}</select>
   <input list="lumen-tags" value={fTag} onChange={e=>setFTag(e.target.value)} placeholder="Tag" aria-label="Filter by tag"/>
   <datalist id="lumen-tags">{allTags.map(t=><option key={t} value={t}/>)}</datalist>
   <div className="filter-dates">
    <input type="date" value={fFrom} onChange={e=>setFFrom(e.target.value)} aria-label="From date"/>
    <input type="date" value={fTo} onChange={e=>setFTo(e.target.value)} aria-label="To date"/>
   </div>
   {hasFilters&&<button className="filter-clear" onClick={()=>{setFModel('');setFRole('');setFFolder('');setFTag('');setFFrom('');setFTo('');}}>Clear filters</button>}
  </div>}
  {!showResults||(!query.trim()&&!hasFilters)?<>
   <div className="section-label">WORKSPACE</div>
   <button className="nav-link active"><MessageSquare size={15}/>Conversations<span>{visibleChats.length}</span></button>
   <button className="nav-link" onClick={onOpenSettings}><Zap size={15}/>Providers & settings<span>{providers.length}</span></button>
   <div className="chat-list">
    {!!pinnedChats.length&&<>
     <div className="section-label group-label">PINNED</div>
     {pinnedChats.map(chatRow)}
    </>}
    {folders.map(f=>{
     const list=folderChats.get(f.id)??[];
     const isOpen=!collapsed.has(f.id);
     return <div key={f.id} className={'folder-section'+(dropTarget===f.id?' drop-target':'')}>
      {folderEdit===f.id
       ?<span className="chat-rename folder-rename"><input autoFocus value={folderValue} onChange={e=>setFolderValue(e.target.value)}
         onBlur={commitFolderEdit}
         onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();commitFolderEdit();}if(e.key==='Escape')setFolderEdit(null);}}/>
         <button className="rename-ok" aria-label="Save folder name" onMouseDown={e=>e.preventDefault()} onClick={commitFolderEdit}><Check size={13}/></button></span>
       :<div className="folder-header" onDragOver={allowDrop(f.id)} onDragLeave={()=>setDropTarget(t=>t===f.id?null:t)} onDrop={e=>dropOn(e,f.id,f.id)}>
        <button className="folder-toggle" onClick={()=>toggleCollapsed(f.id)} aria-label={(isOpen?'Collapse ':'Expand ')+f.name}>
         {isOpen?<ChevronDown size={13}/>:<ChevronRight size={13}/>}<FolderIcon size={13}/><span>{f.name}</span><i>{list.length}</i>
        </button>
        <span className="chat-actions">
         <button aria-label={'Rename folder '+f.name} title="Rename folder" onClick={()=>{setFolderEdit(f.id);setFolderValue(f.name);}}><Pencil size={11}/></button>
         <button aria-label={'Delete folder '+f.name} title="Delete folder (chats are kept)" onClick={()=>setPendingFolderDelete(f)}><Trash2 size={12}/></button>
        </span>
       </div>}
      {isOpen&&list.map(chatRow)}
      {isOpen&&!list.length&&<div className="folder-empty">Drag conversations here</div>}
     </div>;
    })}
    {addingFolder
     ?<span className="chat-rename folder-rename"><input autoFocus value={newFolderName} placeholder="Folder name" aria-label="New folder name"
       onChange={e=>setNewFolderName(e.target.value)} onBlur={commitNewFolder}
       onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();commitNewFolder();}if(e.key==='Escape'){setAddingFolder(false);setNewFolderName('');}}}/>
       <button className="rename-ok" aria-label="Create folder" onMouseDown={e=>e.preventDefault()} onClick={commitNewFolder}><Check size={13}/></button></span>
     :<button className="folder-add" onClick={()=>setAddingFolder(true)}><FolderPlus size={13}/>New folder</button>}
    <div className={dropTarget==='__root'?'drop-target-root':''} onDragOver={allowDrop('__root')} onDragLeave={()=>setDropTarget(t=>t==='__root'?null:t)} onDrop={e=>dropOn(e,null,'__root')}>
     {Object.entries(ungrouped).map(([label,list])=><div key={label}>
      <div className="section-label group-label">{label}</div>
      {list.map(chatRow)}
     </div>)}
    </div>
    {!!archivedChats.length&&<div className="archived-section">
     <button className="folder-toggle archived-toggle" onClick={()=>setShowArchived(v=>!v)} aria-expanded={showArchived}>
      {showArchived?<ChevronDown size={13}/>:<ChevronRight size={13}/>}<Archive size={13}/><span>Archived</span><i>{archivedChats.length}</i>
     </button>
     {showArchived&&archivedChats.map(chatRow)}
    </div>}
   </div>
  </>:<div className="chat-list">
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
   {/* Message hits jump straight to the matched message and highlight it. */}
   {contentHits.map(h=><div className="chat-row" key={h.messageId}>
    <button className="chat-name" onClick={()=>onOpenHit(h.chatId,h.messageId)}>
     <Search size={13}/><span className="hit-text"><b>{h.title}</b><small>{h.snippet}</small>
      <small className="hit-meta">{h.role==='user'?'You':'Lumen'}{h.model?' · '+h.model:''} · {new Date(h.createdAt).toLocaleDateString()}</small></span>
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
 {pendingFolderDelete&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setPendingFolderDelete(null);}}>
  <section className="confirm-modal" role="dialog" aria-modal="true" aria-label="Delete folder">
   <h3>Delete folder?</h3>
   <p>“{pendingFolderDelete.name}” will be removed. Its conversations are kept and move back to the main list.</p>
   <div className="settings-actions">
    <button className="secondary-button" onClick={()=>setPendingFolderDelete(null)}>Cancel</button>
    <button className="danger-button" onClick={()=>{const f=pendingFolderDelete;setPendingFolderDelete(null);onDeleteFolder(f.id);}}>Delete folder</button>
   </div>
  </section>
 </div>}
 </>;
}
