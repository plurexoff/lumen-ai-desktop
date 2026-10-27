import {memo,useEffect,useRef,useState} from 'react';
import type {MouseEvent,RefObject} from 'react';
import {Activity,Bookmark,Brain,Check,ChevronDown,Copy,CornerDownLeft,GitFork,Languages,ListChecks,Pencil,Quote,RefreshCw,Sparkles,ThumbsDown,ThumbsUp,Trash2,Volume2,VolumeX,Wrench} from 'lucide-react';
import type {Message,MessageVariant,ProviderConfig,ToolEvent} from '../../electron/shared';
import {providerColors} from '../store';
import {useMarkdownHtml,useThrottledMarkdown} from '../useMarkdown';
import {formatCost,messageCost} from '../cost';
import {t,useT} from '../i18n';

interface Props{
 messages:Message[];
 busy:boolean;
 stream:string;
 reasoning:string;
 error:string;
 // Tool activity between text chunks (e.g. "Running read_file…") in the stream heading.
 status?:string;
 // Search jump target: the message to scroll to and flash.
 highlightId?:string;
 variants:Record<string,MessageVariant[]>;
 providers:ProviderConfig[];
 bottomRef:RefObject<HTMLDivElement>;
 onCopy:(text:string)=>void;
 onRegenerate:()=>void;
 onContinue:(messageId:string)=>void;
 onDeleteMessage:(message:Message)=>void;
 onEditMessage:(message:Message,text:string)=>void;
 onRetry:()=>void;
 onLoadVariants:(messageId:string)=>void;
 onRestoreVariant:(variantId:string)=>void;
 onBranch:(message:Message)=>void;
 onBookmark:(message:Message)=>void;
 onRate:(message:Message,rating:number)=>void;
 // Tool-call cards for the in-flight answer (batch 6), shown in the stream bubble.
 toolEvents?:ToolEvent[];
 // First letter of the OS login name, shown in the user avatar (batch 7).
 userInitial:string;
 // Selection toolbar (batch 9): quote/explain/translate highlighted answer text —
 // the handler drops a formatted quote into the composer draft.
 onQuote:(text:string,mode:'quote'|'explain'|'translate')=>void;
}

// Rolling streaming speed in ≈tokens/s (chars/4 over a 2 s window), shown in the
// streaming bubble's heading. Resets whenever a new stream starts.
function useStreamRate(text:string):number{
 const [rate,setRate]=useState(0);
 const samples=useRef<{t:number;len:number}[]>([]);
 useEffect(()=>{
  if(!text){samples.current=[];setRate(0);return;}
  const now=performance.now();
  samples.current.push({t:now,len:text.length});
  const cut=now-2000;
  samples.current=samples.current.filter(s=>s.t>=cut);
  const first=samples.current[0];
  if(first&&now-first.t>500){
   setRate(Math.max(0,Math.round((text.length-first.len)/((now-first.t)/1000)/4)));
  }
 },[text]);
 return rate;
}

// Stable empty array so the `variants[id] ?? NO_VARIANTS` fallback does not hand each
// memoized row a fresh reference every render (which would defeat React.memo).
const NO_VARIANTS:MessageVariant[]=[];

// User avatar: a deterministic gradient derived from the initial, so it is stable
// across sessions but distinct per login name.
function avatarGradient(initial:string){
 const hue=((initial.codePointAt(0)??65)*47)%360;
 return `linear-gradient(145deg,hsl(${hue} 52% 55%),hsl(${(hue+42)%360} 55% 40%))`;
}

// Mermaid diagrams: ```mermaid fenced blocks are rendered to SVG after mount.
// mermaid is imported lazily (it is by far the heaviest dependency); a failed or
// incomplete diagram stays a plain code block. securityLevel 'strict' sanitizes
// labels — the diagram source is untrusted model output.
function MermaidRenderer({root}:{root:HTMLDivElement|null}){
 useEffect(()=>{
  if(!root)return;
  const blocks=Array.from(root.querySelectorAll('pre code.language-mermaid'));
  if(!blocks.length)return;
  let cancelled=false;
  void import('mermaid').then(async({default:mermaid})=>{
   mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:document.querySelector('.app-shell')?.getAttribute('data-theme')==='light'?'default':'dark'});
   for(const block of blocks){
    const holder=block.closest('.code-block');
    if(!holder||cancelled)return;
    try{
     const {svg}=await mermaid.render('mmd-'+Math.random().toString(36).slice(2),block.textContent??'');
     if(cancelled)return;
     const div=document.createElement('div');
     div.className='mermaid-diagram';
     div.innerHTML=svg;
     holder.replaceWith(div);
    }catch{/* not a valid (complete) diagram — keep the code block */}
   }
  }).catch(()=>{});
  return()=>{cancelled=true;};
 },[root]);
 return null;
}

// Rendered markdown plus click delegation for the per-block Copy buttons that
// renderMarkdown injects into fenced code blocks. The code text is read from the
// DOM (never an attribute), and the button flips to "Copied" as feedback.
function Markdown({html}:{html:string}){
 const t=useT();
 const ref=useRef<HTMLDivElement>(null);
 const [root,setRoot]=useState<HTMLDivElement|null>(null);
 useEffect(()=>{setRoot(ref.current);},[html]);
 const onClick=(e:MouseEvent)=>{
  const btn=(e.target as HTMLElement).closest('.code-copy');
  if(!btn)return;
  const code=btn.closest('.code-block')?.querySelector('pre code');
  if(!code)return;
  void navigator.clipboard.writeText(code.textContent??'').then(()=>{
   btn.textContent=t('messages.copied');
   btn.classList.add('done');
   setTimeout(()=>{btn.textContent=t('messages.copy');btn.classList.remove('done');},1200);
  });
 };
 return <><div className="markdown" ref={ref} onClick={onClick} dangerouslySetInnerHTML={{__html:html}}/><MermaidRenderer root={root}/></>;
}

// Cards for the tool calls of the answer currently streaming (batch 6): name, the
// argument hint and the outcome, so tool work is visible without opening Thinking.
function ToolCards({events}:{events:ToolEvent[]}){
 const t=useT();
 if(!events.length)return null;
 return <div className="tool-cards" aria-label={t('messages.toolActivity')}>
  {events.map((ev,i)=><div key={i} className={'tool-card '+ev.status}>
   <Wrench size={12}/>
   <span className="tool-name">{ev.name.replace(/^mcp__[^_]+__/,'mcp: ')}</span>
   {ev.hint&&<code className="tool-hint">{ev.hint}</code>}
   <span className="tool-status">{ev.status==='running'?'…':ev.status==='ok'?'✓':ev.status==='declined'?t('messages.toolDeclined'):t('messages.toolFailed')}</span>
  </div>)}
 </div>;
}

// Day separators inside the feed ("Today" / "Yesterday" / date) — long chats are
// much easier to scan. Comparison is by local calendar day, not 24h distance.
const dayStart=(ts:number)=>{const d=new Date(ts);return new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime();};
function dayLabel(ts:number):string{
 const diff=Math.round((dayStart(Date.now())-dayStart(ts))/86400000);
 if(diff===0)return t('messages.today');
 if(diff===1)return t('messages.yesterday');
 return new Date(ts).toLocaleDateString([],{year:'numeric',month:'long',day:'numeric'});
}

function Usage({promptTokens,completionTokens,cost}:{promptTokens?:number|null;completionTokens?:number|null;cost?:string}){
 const t=useT();
 if(!promptTokens&&!completionTokens)return null;
 return <small className="token-usage">{promptTokens?'↑ '+promptTokens.toLocaleString():''}{promptTokens&&completionTokens?' · ':''}{completionTokens?'↓ '+completionTokens.toLocaleString():''}{t('messages.tokens')}{cost?' · ≈'+cost:''}</small>;
}

function Reasoning({text,collapsedByDefault,live}:{text:string;collapsedByDefault?:boolean;live?:boolean}){
 const t=useT();
 const [open,setOpen]=useState(!collapsedByDefault);
 // Live reasoning is throttled; stored reasoning is parsed once per content.
 const html=useThrottledMarkdown(text,live?120:0);
 if(!text)return null;
 return <div className="reasoning-block">
  <button className="reasoning-toggle" onClick={()=>setOpen(o=>!o)}><Brain size={12}/><span>{t('messages.thinking')}</span><i>{open?'▾':'▸'}</i></button>
  {open&&<div className="reasoning-text"><Markdown html={html}/></div>}
 </div>;
}

function Variants({list,onRestore,onClose}:{list:MessageVariant[];onRestore:(id:string)=>void;onClose:()=>void}){
 const t=useT();
 if(!list.length)return <div className="models-empty">{t('messages.noVariants')}</div>;
 return <div className="variant-list">{list.map((v,i)=>
  <button className="variant-row" key={v.id} onClick={()=>onRestore(v.id)} title={t('messages.restoreVariant')}>
   <span className="variant-index">#{list.length-i}</span>
   <span className="variant-preview">{v.content.replace(/\s+/g,' ').slice(0,120)||t('messages.emptyVariant')}</span>
   <Check size={13}/></button>)}
  <button className="variant-close" onClick={onClose}>{t('messages.close')}</button>
 </div>;
}

// One row per message. Memoized + markdown parsed once per content string: the whole
// point of idea #5. `isLast` is a boolean prop (not an identity compare against the
// parent's `last`) so memo can decide correctly without leaking the array.
// Long messages collapse to a preview; the threshold is in rendered text length.
const COLLAPSE_CHARS=3000;
// Copy-as-quote: markdown blockquote with attribution, ready to paste anywhere.
const asQuote=(m:Message)=>m.content.split('\n').map(l=>'> '+l).join('\n')+'\n\n— '+(m.role==='user'?t('messages.you'):(m.model??'Lumen'))+', '+new Date(m.createdAt).toLocaleString();

// Text-to-speech for assistant replies (Web Speech API, Chromium built-in).
function speak(text:string,onEnd:()=>void):()=>void{
 const plain=text.replace(/```[\s\S]*?```/g,t('messages.codeBlock')).replace(/[#*`_>]/g,'').slice(0,4000);
 const u=new SpeechSynthesisUtterance(plain);
 u.onend=onEnd;u.onerror=onEnd;
 speechSynthesis.cancel();speechSynthesis.speak(u);
 return ()=>speechSynthesis.cancel();
}

const MessageRow=memo(function MessageRow({m,isLast,busy,highlighted,variants,providers,onCopy,onRegenerate,onContinue,onDeleteMessage,onEditMessage,onLoadVariants,onRestoreVariant,onBranch,onBookmark,onRate,onImageClick,userInitial,selecting,selected,onToggleSelect,onEnterSelect}:{
 m:Message;isLast:boolean;busy:boolean;highlighted?:boolean;variants:MessageVariant[];providers:ProviderConfig[];
 onCopy:(t:string)=>void;onRegenerate:()=>void;onContinue:(id:string)=>void;
 onDeleteMessage:(m:Message)=>void;onEditMessage:(m:Message,text:string)=>void;
 onLoadVariants:(id:string)=>void;onRestoreVariant:(id:string)=>void;
 onBranch:(m:Message)=>void;onBookmark:(m:Message)=>void;onRate:(m:Message,rating:number)=>void;onImageClick:(src:string)=>void;
 userInitial:string;
 // Multi-select mode (batch 9): rows show a check circle and toggle on click.
 selecting:boolean;selected:boolean;
 onToggleSelect:(id:string)=>void;onEnterSelect:(id:string)=>void;
}){
 const t=useT();
 const html=useMarkdownHtml(m.content);
 const [editing,setEditing]=useState(false);
 const [editText,setEditText]=useState(m.content);
 const [showVariants,setShowVariants]=useState(false);
 // Copy-button feedback: the icon morphs into a check for a moment after copying.
 const [copied,setCopied]=useState(false);
 const copyMessage=()=>{onCopy(m.content);setCopied(true);window.setTimeout(()=>setCopied(false),1200);};
 // Collapsed state for long messages; user-controlled once toggled.
 const collapsible=m.content.length>COLLAPSE_CHARS;
 const [expanded,setExpanded]=useState(false);
 const [speaking,setSpeaking]=useState(false);
 const truncated=m.finishReason==='length';
 const filtered=m.finishReason==='content_filter';
 const refused=m.finishReason==='refusal';
 // $ estimate from the provider's pricing map; null when the model has no known price.
 const rawCost=m.role==='assistant'?messageCost(providers,m.providerId,m.model,m.promptTokens,m.completionTokens):null;
 const cost=rawCost===null?undefined:formatCost(rawCost);
 const toggleSpeak=()=>{
  if(speaking){speechSynthesis.cancel();setSpeaking(false);return;}
  setSpeaking(true);speak(m.content,()=>setSpeaking(false));
 };
 const selectable=selecting&&!m.id.startsWith('pending-');
 return <article id={'msg-'+m.id} className={'message '+m.role+(highlighted?' highlighted':'')+(m.bookmarked?' bookmarked':'')+(selectable?' selectable':'')+(selected?' selected':'')}
  onClick={selectable?()=>onToggleSelect(m.id):undefined}>
  {selecting&&<span className={'sel-check'+(selected?' on':'')} aria-hidden="true"/>}
  <div className={'message-avatar '+m.role} style={m.role==='user'?{background:avatarGradient(userInitial)}:undefined}>{m.role==='user'?userInitial:'L'}</div>
  <div className="message-content">
   <div className="message-heading"><b>{m.role==='user'?t('messages.you'):'Lumen'}</b>
    {m.role==='assistant'&&m.providerId&&<span className="msg-provider-dot" style={{background:providerColors[m.providerId]??'var(--faint)'}} title={m.providerId}/>}
    <small>{new Date(m.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</small>
    {m.role==='assistant'&&m.model&&<small className="message-model">{m.model}</small>}
    {m.role==='assistant'&&<Usage promptTokens={m.promptTokens} completionTokens={m.completionTokens} cost={cost}/>}
    {!!m.bookmarked&&<Bookmark size={12} className="bookmark-flag" aria-label={t('messages.bookmarked')}/>}
   </div>
   {!!m.attachments?.length&&<div className="attach-list">
    {/* Persisted images are served by the lumen-attachment:// protocol (CSP-listed);
        the optimistic bubble carries its own data: preview instead. */}
    {m.attachments.map(a=><img className="attach-img" key={a.id} src={a.preview??`lumen-attachment://${a.id}`} alt={a.name} title={t('messages.clickToZoom',{name:a.name})}
     onClick={e=>onImageClick((e.target as HTMLImageElement).src)}/>)}
   </div>}
   {editing
    ?<div className="message-edit">
      <textarea autoFocus value={editText} rows={3} onChange={e=>setEditText(e.target.value)}
       onKeyDown={e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();onEditMessage(m,editText);setEditing(false);}if(e.key==='Escape')setEditing(false);}}/>
      <div className="edit-actions">
       <button className="secondary-button" onClick={()=>setEditing(false)}>{t('messages.cancel')}</button>
       <button className="primary-button" onClick={()=>{onEditMessage(m,editText);setEditing(false);}}>{t('messages.saveResend')}</button>
      </div>
     </div>
    :<>
      <div className={collapsible&&!expanded?'collapsible collapsed':''}>
       <Markdown html={html}/>
      </div>
      {collapsible&&<button className="collapse-toggle" onClick={()=>setExpanded(v=>!v)} aria-expanded={expanded}>
       <ChevronDown size={12} className={expanded?'flip':''}/> {expanded?t('messages.collapse'):t('messages.showFull',{n:Math.round(m.content.length/1000)})}
      </button>}
     </>}
   {m.role==='assistant'&&(truncated||filtered||refused)&&
    <div className={'finish-note '+(truncated?'truncated':'blocked')}>
     {truncated?<><span>{t('messages.truncated')}</span><button onClick={()=>onContinue(m.id)}><CornerDownLeft size={12}/> {t('messages.continue')}</button></>
      :<span>{filtered?t('messages.filtered'):refused?t('messages.refused'):t('messages.stoppedUnknown')}</span>}
    </div>}
   <div className="message-actions" onClick={e=>e.stopPropagation()}>
    {/* Multi-select entry: enters selection mode with this message checked. */}
    {!m.id.startsWith('pending-')&&<button className="copy-btn" onClick={()=>onEnterSelect(m.id)} aria-label={t('messages.selectMessage')} title={t('messages.selectMessage')}><ListChecks size={12}/></button>}
    <button className={'copy-btn'+(copied?' copied':'')} onClick={copyMessage} aria-label={t('messages.copyMessage')}>{copied?<Check size={12}/>:<Copy size={12}/>} {copied?t('messages.copied'):t('messages.copy')}</button>
    <button className="copy-btn" onClick={()=>onCopy(asQuote(m))} aria-label={t('messages.copyQuote')} title={t('messages.copyQuoteHint')}><Quote size={12}/></button>
    {m.role==='assistant'&&<button className={'copy-btn'+(speaking?' speaking':'')} onClick={toggleSpeak} aria-label={speaking?t('messages.stopReading'):t('messages.readAloud')} title={speaking?t('messages.stopReading'):t('messages.readAloudHint')}>{speaking?<VolumeX size={12}/>:<Volume2 size={12}/>}</button>}
    {!m.id.startsWith('pending-')&&<button className={'copy-btn'+(m.bookmarked?' bookmarked':'')} onClick={()=>onBookmark(m)} aria-label={m.bookmarked?t('messages.removeBookmark'):t('messages.bookmarkMessage')} title={m.bookmarked?t('messages.removeBookmark'):t('messages.bookmarkHint')}><Bookmark size={12}/></button>}
    {m.role==='user'&&!busy&&<button className="copy-btn" onClick={()=>{setEditText(m.content);setEditing(v=>!v);}} aria-label={t('messages.editMessage')}><Pencil size={12}/> {t('messages.edit')}</button>}
    {m.role==='assistant'&&isLast&&<button className="copy-btn" disabled={busy} onClick={onRegenerate} aria-label={t('messages.regenerateResponse')}><RefreshCw size={12}/> {t('messages.regenerate')}</button>}
    {m.role==='assistant'&&!!m.variantCount&&<button className="copy-btn" onClick={()=>{setShowVariants(v=>!v);onLoadVariants(m.id);}} aria-label={t('messages.previousAnswers')}>{t('messages.history',{n:m.variantCount})}</button>}
    {m.role==='assistant'&&<button className="copy-btn" onClick={()=>onDeleteMessage(m)} aria-label={t('messages.deleteMessage')}><Trash2 size={12}/></button>}
    {/* Answer rating: 👍/👎 stored on the message; clicking the active one clears it. */}
    {m.role==='assistant'&&!m.id.startsWith('pending-')&&<>
     <button className={'copy-btn'+(m.rating===1?' rated-up':'')} onClick={()=>onRate(m,m.rating===1?0:1)} aria-label={t('messages.goodAnswer')} title={t('messages.goodAnswer')}><ThumbsUp size={12}/></button>
     <button className={'copy-btn'+(m.rating===-1?' rated-down':'')} onClick={()=>onRate(m,m.rating===-1?0:-1)} aria-label={t('messages.badAnswer')} title={t('messages.badAnswer')}><ThumbsDown size={12}/></button>
    </>}
    {/* Pending bubbles (id "pending-…") exist only in the renderer — branching from one
        would fail in main, which knows nothing about the row yet. */}
    {!busy&&!m.id.startsWith('pending-')&&<button className="copy-btn" onClick={()=>onBranch(m)} aria-label={t('messages.branchHint')} title={t('messages.branchHint')}><GitFork size={12}/> {t('messages.branch')}</button>}
   </div>
   {showVariants&&<Variants list={variants} onRestore={id=>{onRestoreVariant(id);setShowVariants(false);}} onClose={()=>setShowVariants(false)}/>}
  </div>
 </article>;
});

export default function MessageList({messages,busy,stream,reasoning,error,status,highlightId,variants,providers,bottomRef,onCopy,onRegenerate,onContinue,onDeleteMessage,onEditMessage,onRetry,onLoadVariants,onRestoreVariant,onBranch,onBookmark,onRate,toolEvents,userInitial,onQuote}:Props){
 const t=useT();
 const last=messages[messages.length-1];
 const canRetry=!!last&&last.role==='assistant'&&!busy;
 // The streaming bubble re-parses on a throttle, not per chunk (idea #17).
 const streamHtml=useThrottledMarkdown(stream,120);
 // Live streaming speed (≈tokens/s) in the streaming bubble's heading (batch 9).
 const rate=useStreamRate(stream);
 // Image lightbox: full-screen zoom on click.
 const [lightbox,setLightbox]=useState('');
 // Batch 9 — multi-select mode: check circles on rows, action bar at the bottom.
 const [selMode,setSelMode]=useState(false);
 const [selected,setSelected]=useState<Set<string>>(new Set());
 const exitSelect=()=>{setSelMode(false);setSelected(new Set());};
 const toggleSelect=(id:string)=>setSelected(s=>{const n=new Set(s);if(n.has(id))n.delete(id);else n.add(id);return n;});
 const enterSelect=(id:string)=>{setSelMode(true);setSelected(new Set([id]));};
 const selectedMessages=messages.filter(m=>selected.has(m.id));
 useEffect(()=>{
  if(!selMode)return;
  const onKey=(e:KeyboardEvent)=>{if(e.key==='Escape')exitSelect();};
  window.addEventListener('keydown',onKey);
  return()=>window.removeEventListener('keydown',onKey);
 });
 // Batch 9 — selection toolbar: highlighting answer text offers quote/explain/
 // translate/copy actions above the selection.
 const [selBar,setSelBar]=useState<{x:number;y:number;text:string}|null>(null);
 const onMouseUp=()=>{
  if(selMode)return;
  const s=window.getSelection();
  const node=s?.anchorNode??null;
  const el=node?(node.nodeType===1?node as HTMLElement:node.parentElement):null;
  if(!s||s.isCollapsed||!el||!el.closest('.message .markdown')){setSelBar(null);return;}
  const text=s.toString().trim();
  if(text.length<2){setSelBar(null);return;}
  const r=s.getRangeAt(0).getBoundingClientRect();
  setSelBar({x:Math.min(Math.max(r.left+r.width/2,140),window.innerWidth-140),y:r.top,text:text.slice(0,600)});
 };
 useEffect(()=>{
  const hide=()=>setSelBar(null);
  const onKey=(e:KeyboardEvent)=>{if(e.key==='Escape')setSelBar(null);};
  document.addEventListener('scroll',hide,true);
  window.addEventListener('keydown',onKey);
  return()=>{document.removeEventListener('scroll',hide,true);window.removeEventListener('keydown',onKey);};
 },[]);
 const selAct=(mode:'quote'|'explain'|'translate'|'copy')=>{
  if(!selBar)return;
  if(mode==='copy')onCopy(selBar.text);else onQuote(selBar.text,mode);
  setSelBar(null);window.getSelection()?.removeAllRanges();
 };
 // Bookmarked messages get a jump strip at the top of the feed.
 const bookmarks=messages.filter(m=>m.bookmarked&&!m.id.startsWith('pending-'));
 return <div className={'message-list'+(selMode?' selecting':'')} onMouseUp={onMouseUp}>
  {!!bookmarks.length&&<div className="bookmark-strip" aria-label={t('messages.bookmarkedMessages')}>
   <Bookmark size={12}/>{bookmarks.map(b=><button key={b.id} title={b.content.slice(0,120)} onClick={()=>document.getElementById('msg-'+b.id)?.scrollIntoView({block:'center'})}>{b.content.replace(/\s+/g,' ').slice(0,40)||t('messages.attachmentFallback')}</button>)}
  </div>}
  {messages.map((m,i)=>{
   const prev=messages[i-1];
   const newDay=!prev||dayStart(prev.createdAt)!==dayStart(m.createdAt);
   return <div key={m.id} className="day-group">
    {newDay&&<div className="date-sep" aria-hidden="true"><span>{dayLabel(m.createdAt)}</span></div>}
    <MessageRow m={m} isLast={i===messages.length-1} busy={busy} highlighted={m.id===highlightId} variants={variants[m.id]??NO_VARIANTS} providers={providers}
     onCopy={onCopy} onRegenerate={onRegenerate} onContinue={onContinue}
     onDeleteMessage={onDeleteMessage} onEditMessage={onEditMessage}
     onLoadVariants={onLoadVariants} onRestoreVariant={onRestoreVariant} onBranch={onBranch} onBookmark={onBookmark} onRate={onRate} onImageClick={setLightbox} userInitial={userInitial}
     selecting={selMode} selected={selected.has(m.id)} onToggleSelect={toggleSelect} onEnterSelect={enterSelect}/>
   </div>;
  })}
  {(busy||stream||reasoning)&&<article className="message assistant" aria-live="polite" aria-busy="true">
   <div className="message-avatar assistant">L</div>
   <div className="message-content">
    <div className="message-heading"><b>Lumen</b><small>{status??(stream?t('messages.responding'):t('messages.thinking'))}</small>{!!stream&&rate>0&&<small className="stream-rate">{t('messages.streamRate',{n:rate})}</small>}</div>
    {/* Indeterminate progress while generating — no total is knowable mid-stream. */}
    <div className="gen-progress" aria-hidden="true"><i/></div>
    {!!toolEvents?.length&&<ToolCards events={toolEvents}/>}
    <Reasoning key={stream?'answering':'thinking'} text={reasoning} collapsedByDefault={!!stream} live/>
    {stream
     /* A blinking caret after the in-flight text reads as "typing" (batch 8). */
     ?<><Markdown html={streamHtml}/><span className="stream-caret" aria-hidden="true"/></>
     :!reasoning&&<div className="typing"><i/><i/><i/></div>}
   </div>
  </article>}
  {error&&<div className="error-banner" role="alert"><Activity size={14}/><span>{error}</span>{canRetry&&<button onClick={onRetry}>{t('messages.retry')}</button>}</div>}
  {/* Multi-select action bar: pinned to the bottom of the viewport while scrolling. */}
  {selMode&&<div className="sel-bar" role="toolbar" aria-label={t('messages.selectMessage')} onClick={e=>e.stopPropagation()}>
   <span>{t('messages.selectedCount',{n:selected.size})}</span>
   <button onClick={()=>setSelected(new Set(messages.filter(m=>!m.id.startsWith('pending-')).map(m=>m.id)))}>{t('messages.selectAll')}</button>
   <button disabled={!selected.size} onClick={()=>{onCopy(selectedMessages.map(m=>'**'+(m.role==='user'?t('messages.you'):'Lumen')+'**: '+m.content).join('\n\n'));exitSelect();}}><Copy size={12}/>{t('messages.copy')}</button>
   <button disabled={!selected.size} onClick={()=>{for(const m of selectedMessages)if(!m.bookmarked)onBookmark(m);exitSelect();}}><Bookmark size={12}/>{t('messages.bookmarkSelected')}</button>
   <button className="danger" disabled={!selected.size} onClick={()=>{for(const m of selectedMessages)onDeleteMessage(m);exitSelect();}}><Trash2 size={12}/>{t('messages.deleteSelected')}</button>
   <button onClick={exitSelect}>{t('messages.cancel')}</button>
  </div>}
  <div ref={bottomRef}/>
  {lightbox&&<div className="lightbox" role="dialog" aria-label={t('messages.imagePreview')} onClick={()=>setLightbox('')}><img src={lightbox} alt={t('messages.attachmentFull')}/></div>}
  {selBar&&<div className="sel-toolbar" role="toolbar" style={{left:selBar.x,top:selBar.y}}>
   <button onMouseDown={e=>e.preventDefault()} onClick={()=>selAct('quote')}><Quote size={12}/>{t('messages.selQuote')}</button>
   <button onMouseDown={e=>e.preventDefault()} onClick={()=>selAct('explain')}><Sparkles size={12}/>{t('messages.selExplain')}</button>
   <button onMouseDown={e=>e.preventDefault()} onClick={()=>selAct('translate')}><Languages size={12}/>{t('messages.selTranslate')}</button>
   <button onMouseDown={e=>e.preventDefault()} onClick={()=>selAct('copy')}><Copy size={12}/>{t('messages.copy')}</button>
  </div>}
 </div>;
}
