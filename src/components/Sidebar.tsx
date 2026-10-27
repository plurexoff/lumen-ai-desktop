import {useEffect,useMemo,useState} from 'react';
import type {DragEvent} from 'react';
import {Archive,ArchiveRestore,Check,ChevronDown,Folder as FolderIcon,FolderPlus,Loader2,MessageSquare,MoreHorizontal,Pencil,Pin,PinOff,Plus,Search,SlidersHorizontal,Tag,Trash2,X,Zap} from 'lucide-react';
import type {Chat,Folder,ProviderConfig,SearchFilters,SearchResult} from '../../electron/shared';
import {t,useT} from '../i18n';

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
 if(days<=0)return t('sidebar.group.today');
 if(days===1)return t('sidebar.group.yesterday');
 if(days<7)return t('sidebar.group.last7');
 return t('sidebar.group.earlier');
}

export default function Sidebar({chats,activeId,providers,folders,busyIds,unread,needsSetup,newChatHotkey,onNew,onOpen,onDelete,onRename,onOpenSettings,onTogglePin,onMoveFolder,onToggleArchived,onSetTags,onCreateFolder,onRenameFolder,onDeleteFolder,onOpenHit}:Props){
 const t=useT();
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
      <button className="rename-ok" aria-label={t('sidebar.saveName')} onMouseDown={e=>e.preventDefault()} onClick={commitRename}><Check size={13}/></button></span>
    :<>
     <button className="chat-name" onDoubleClick={()=>startRename(c)} onClick={()=>onOpen(c)} title={c.title}>
      {busyIds.has(c.id)?<Loader2 size={14} className="spin"/>:<MessageSquare size={14}/>}<span>{c.title}</span>
      {unread.has(c.id)&&<i className="unread-dot" aria-label={t('sidebar.newReply')}/>}
     </button>
     {!!c.tags?.length&&<span className="chat-tags">{c.tags.map(tag=><button key={tag} className="tag-chip" title={t('sidebar.searchTag',{tag})} onClick={()=>{setQuery('');setFTag(tag);setShowFilters(true);setShowResults(true);}}>{tag}</button>)}</span>}
     {tagEditId===c.id
      ?<span className="chat-rename"><input autoFocus value={tagValue} placeholder={t('sidebar.tags.placeholder')} aria-label={t('sidebar.tags.edit')}
        onChange={e=>setTagValue(e.target.value)} onBlur={commitTagEdit}
        onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();commitTagEdit();}if(e.key==='Escape')setTagEditId(null);}}/>
        <button className="rename-ok" aria-label={t('sidebar.tags.save')} onMouseDown={e=>e.preventDefault()} onClick={commitTagEdit}><Check size={13}/></button></span>
      :<span className="chat-actions">
       <button aria-label={t(c.pinned?'sidebar.unpin':'sidebar.pin',{title:c.title})} title={t(c.pinned?'sidebar.unpin.title':'sidebar.pin.title')} onClick={()=>onTogglePin(c)}>{c.pinned?<PinOff size={12}/>:<Pin size={12}/>}</button>
       <button aria-label={t('sidebar.tags.editOf',{title:c.title})} title={t('sidebar.tags.title')} onClick={()=>startTagEdit(c)}><Tag size={12}/></button>
       <button aria-label={t(c.archived?'sidebar.unarchive':'sidebar.archive',{title:c.title})} title={t(c.archived?'sidebar.unarchive.title':'sidebar.archive.title')} onClick={()=>onToggleArchived(c)}>{c.archived?<ArchiveRestore size={12}/>:<Archive size={12}/>}</button>
       <button aria-label={t('sidebar.rename',{title:c.title})} title={t('sidebar.rename.title')} onClick={()=>startRename(c)}><Pencil size={12}/></button>
       <button aria-label={t('sidebar.delete',{title:c.title})} title={t('sidebar.delete.title')} onClick={()=>setPendingDelete(c)}><Trash2 size={13}/></button>
      </span>}
    </>}
  </div>;
 }

 return <>
 <aside className="sidebar">
  <div className="workspace"><div className="workspace-logo">L</div><div><b>Lumen</b><small>Personal workspace</small></div><ChevronDown size={14}/></div>
  <button className="new-chat" onClick={onNew}><Plus size={16}/>{t('sidebar.newConversation')}<kbd>{newChatHotkey}</kbd></button>
  <label className="search-box"><Search size={14}/>
   <input value={query} onChange={e=>{setQuery(e.target.value);setShowResults(true);}} onFocus={()=>setShowResults(true)} placeholder={t('sidebar.search.placeholder')} aria-label={t('sidebar.search.placeholder')}/>
   <button type="button" className={'filter-toggle'+(showFilters||hasFilters?' active':'')} aria-label={t('sidebar.filters.aria')} title={t('sidebar.filters.title')} onClick={()=>setShowFilters(v=>!v)}><SlidersHorizontal size={12}/></button>
   {query&&<button type="button" aria-label={t('sidebar.search.clear')} onClick={()=>{setQuery('');setHits([]);}}><X size={12}/></button>}
  </label>
  {showFilters&&<div className="search-filters">
   <select value={fModel} onChange={e=>setFModel(e.target.value)} aria-label={t('sidebar.filter.model.aria')}><option value="">{t('sidebar.filter.model.any')}</option>{allModels.map(m=><option key={m} value={m}>{m}</option>)}</select>
   <select value={fRole} onChange={e=>setFRole(e.target.value)} aria-label={t('sidebar.filter.role.aria')}><option value="">{t('sidebar.filter.role.any')}</option><option value="user">{t('sidebar.filter.role.user')}</option><option value="assistant">{t('sidebar.filter.role.assistant')}</option></select>
   <select value={fFolder} onChange={e=>setFFolder(e.target.value)} aria-label={t('sidebar.filter.folder.aria')}><option value="">{t('sidebar.filter.folder.any')}</option>{folders.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}</select>
   <input list="lumen-tags" value={fTag} onChange={e=>setFTag(e.target.value)} placeholder={t('sidebar.filter.tag.placeholder')} aria-label={t('sidebar.filter.tag.aria')}/>
   <datalist id="lumen-tags">{allTags.map(t=><option key={t} value={t}/>)}</datalist>
   <div className="filter-dates">
    <input type="date" value={fFrom} onChange={e=>setFFrom(e.target.value)} aria-label={t('sidebar.filter.from')}/>
    <input type="date" value={fTo} onChange={e=>setFTo(e.target.value)} aria-label={t('sidebar.filter.to')}/>
   </div>
   {hasFilters&&<button className="filter-clear" onClick={()=>{setFModel('');setFRole('');setFFolder('');setFTag('');setFFrom('');setFTo('');}}>{t('sidebar.filter.clear')}</button>}
  </div>}
  {!showResults||(!query.trim()&&!hasFilters)?<>
   <div className="section-label">{t('sidebar.section.workspace')}</div>
   <button className="nav-link active"><MessageSquare size={15}/>{t('sidebar.nav.conversations')}<span>{visibleChats.length}</span></button>
   <button className="nav-link" onClick={onOpenSettings}><Zap size={15}/>{t('sidebar.nav.providers')}<span>{providers.length}</span></button>
   <div className="chat-list">
    {/* First paint: the built-in providers arrive with the initial load, so an
        empty provider list means "still loading" — show shimmer rows (batch 8). */}
    {!providers.length&&<div className="skel-list" aria-hidden="true">{[0,1,2,3,4].map(i=><div className="skel-row" key={i} style={{animationDelay:i*90+'ms'}}/>)}</div>}
    {!!pinnedChats.length&&<>
     <div className="section-label group-label">{t('sidebar.section.pinned')}</div>
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
         <button className="rename-ok" aria-label={t('sidebar.folder.saveName')} onMouseDown={e=>e.preventDefault()} onClick={commitFolderEdit}><Check size={13}/></button></span>
       :<div className="folder-header" onDragOver={allowDrop(f.id)} onDragLeave={()=>setDropTarget(t=>t===f.id?null:t)} onDrop={e=>dropOn(e,f.id,f.id)}>
        {/* Double-click the folder name starts an inline rename (the pencil button
            in the hover actions does the same) — batch 9 discoverability fix. */}
        <button className="folder-toggle" onClick={()=>toggleCollapsed(f.id)} onDoubleClick={()=>{setFolderEdit(f.id);setFolderValue(f.name);}} aria-label={t(isOpen?'sidebar.folder.collapse':'sidebar.folder.expand',{name:f.name})} title={f.name}>
         <ChevronDown size={13} className={'chevron'+(isOpen?'':' closed')}/><FolderIcon size={13}/><span>{f.name}</span><i>{list.length}</i>
        </button>
        <span className="chat-actions">
         <button aria-label={t('sidebar.folder.rename',{name:f.name})} title={t('sidebar.folder.rename.title')} onClick={()=>{setFolderEdit(f.id);setFolderValue(f.name);}}><Pencil size={11}/></button>
         <button aria-label={t('sidebar.folder.delete',{name:f.name})} title={t('sidebar.folder.delete.title')} onClick={()=>setPendingFolderDelete(f)}><Trash2 size={12}/></button>
        </span>
       </div>}
      {/* Height-animated open/close (grid-rows 0fr→1fr trick, batch 8). */}
      <div className={'folder-body'+(isOpen?' open':'')}><div>
       {list.map(chatRow)}
       {!list.length&&<div className="folder-empty">{t('sidebar.folder.empty')}</div>}
      </div></div>
     </div>;
    })}
    {addingFolder
     ?<span className="chat-rename folder-rename"><input autoFocus value={newFolderName} placeholder={t('sidebar.folder.name.placeholder')} aria-label={t('sidebar.folder.name.aria')}
       onChange={e=>setNewFolderName(e.target.value)} onBlur={commitNewFolder}
       onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();commitNewFolder();}if(e.key==='Escape'){setAddingFolder(false);setNewFolderName('');}}}/>
       <button className="rename-ok" aria-label={t('sidebar.folder.create')} onMouseDown={e=>e.preventDefault()} onClick={commitNewFolder}><Check size={13}/></button></span>
     :<button className="folder-add" onClick={()=>setAddingFolder(true)}><FolderPlus size={13}/>{t('sidebar.folder.new')}</button>}
    <div className={dropTarget==='__root'?'drop-target-root':''} onDragOver={allowDrop('__root')} onDragLeave={()=>setDropTarget(t=>t==='__root'?null:t)} onDrop={e=>dropOn(e,null,'__root')}>
     {Object.entries(ungrouped).map(([label,list])=><div key={label}>
      <div className="section-label group-label">{label}</div>
      {list.map(chatRow)}
     </div>)}
    </div>
    {!!archivedChats.length&&<div className="archived-section">
     <button className="folder-toggle archived-toggle" onClick={()=>setShowArchived(v=>!v)} aria-expanded={showArchived}>
      <ChevronDown size={13} className={'chevron'+(showArchived?'':' closed')}/><Archive size={13}/><span>{t('sidebar.archived')}</span><i>{archivedChats.length}</i>
     </button>
     <div className={'folder-body'+(showArchived?' open':'')}><div>{archivedChats.map(chatRow)}</div></div>
    </div>}
   </div>
  </>:<div className="chat-list">
   {!!titleMatches.length&&<>
    <div className="section-label group-label">{t('sidebar.section.conversations')}</div>
    {titleMatches.map(c=><div className={'chat-row '+(c.id===activeId?'selected':'')} key={c.id}>
     <button className="chat-name" onClick={()=>onOpen(c)} title={c.title}>
      {busyIds.has(c.id)?<Loader2 size={14} className="spin"/>:<MessageSquare size={14}/>}<span>{c.title}</span>
     </button>
    </div>)}
   </>}
   <div className="section-label group-label">{t('sidebar.section.inMessages')}{searching?' · '+t('sidebar.section.searching'):''}</div>
   {!searching&&!contentHits.length&&<div className="models-empty">{t('sidebar.search.noMatches')}</div>}
   {/* Message hits jump straight to the matched message and highlight it. */}
   {contentHits.map(h=><div className="chat-row" key={h.messageId}>
    <button className="chat-name" onClick={()=>onOpenHit(h.chatId,h.messageId)}>
     <Search size={13}/><span className="hit-text"><b>{h.title}</b><small>{h.snippet}</small>
      <small className="hit-meta">{h.role==='user'?t('sidebar.you'):'Lumen'}{h.model?' · '+h.model:''} · {new Date(h.createdAt).toLocaleDateString()}</small></span>
    </button>
   </div>)}
  </div>}
  <div className="sidebar-bottom">
   {needsSetup&&<div className="connect-card"><Zap size={15}/><div><b>{t('sidebar.connect.title')}</b><small>{t('sidebar.connect.sub')}</small></div><button onClick={onOpenSettings}>{t('sidebar.connect.button')}</button></div>}
   <button className="profile" onClick={onOpenSettings}><div className="avatar">L</div><div><b>{t('sidebar.profile.title')}</b><small>{t('sidebar.profile.sub')}</small></div><MoreHorizontal size={16}/></button>
  </div>
 </aside>
 {pendingDelete&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setPendingDelete(null);}}>
  <section className="confirm-modal" role="dialog" aria-modal="true" aria-label={t('sidebar.deleteChat.aria')}>
   <h3>{t('sidebar.deleteChat.title')}</h3>
   <p>{t('sidebar.deleteChat.body',{title:pendingDelete.title})}</p>
   <div className="settings-actions">
    <button className="secondary-button" onClick={()=>setPendingDelete(null)}>{t('sidebar.cancel')}</button>
    <button className="danger-button" onClick={()=>{const chat=pendingDelete;setPendingDelete(null);onDelete(chat);}}>{t('sidebar.delete.title')}</button>
   </div>
  </section>
 </div>}
 {pendingFolderDelete&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setPendingFolderDelete(null);}}>
  <section className="confirm-modal" role="dialog" aria-modal="true" aria-label={t('sidebar.deleteFolder.aria')}>
   <h3>{t('sidebar.deleteFolder.title')}</h3>
   <p>{t('sidebar.deleteFolder.body',{name:pendingFolderDelete.name})}</p>
   <div className="settings-actions">
    <button className="secondary-button" onClick={()=>setPendingFolderDelete(null)}>{t('sidebar.cancel')}</button>
    <button className="danger-button" onClick={()=>{const f=pendingFolderDelete;setPendingFolderDelete(null);onDeleteFolder(f.id);}}>{t('sidebar.deleteFolder.button')}</button>
   </div>
  </section>
 </div>}
 </>;
}
