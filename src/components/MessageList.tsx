import {memo,useEffect,useRef,useState} from 'react';
import type {MouseEvent,RefObject} from 'react';
import {Activity,Bookmark,Brain,Check,ChevronDown,Copy,CornerDownLeft,GitFork,Pencil,Quote,RefreshCw,ThumbsDown,ThumbsUp,Trash2,Volume2,VolumeX,Wrench} from 'lucide-react';
import type {Message,MessageVariant,ProviderConfig,ToolEvent} from '../../electron/shared';
import {providerColors} from '../store';
import {useMarkdownHtml,useThrottledMarkdown} from '../useMarkdown';
import {formatCost,messageCost} from '../cost';

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
 const ref=useRef<HTMLDivElement>(null);
 const [root,setRoot]=useState<HTMLDivElement|null>(null);
 useEffect(()=>{setRoot(ref.current);},[html]);
 const onClick=(e:MouseEvent)=>{
  const btn=(e.target as HTMLElement).closest('.code-copy');
  if(!btn)return;
  const code=btn.closest('.code-block')?.querySelector('pre code');
  if(!code)return;
  void navigator.clipboard.writeText(code.textContent??'').then(()=>{
   btn.textContent='Copied';
   setTimeout(()=>{btn.textContent='Copy';},1200);
  });
 };
 return <><div className="markdown" ref={ref} onClick={onClick} dangerouslySetInnerHTML={{__html:html}}/><MermaidRenderer root={root}/></>;
}

// Cards for the tool calls of the answer currently streaming (batch 6): name, the
// argument hint and the outcome, so tool work is visible without opening Thinking.
function ToolCards({events}:{events:ToolEvent[]}){
 if(!events.length)return null;
 return <div className="tool-cards" aria-label="Tool activity">
  {events.map((ev,i)=><div key={i} className={'tool-card '+ev.status}>
   <Wrench size={12}/>
   <span className="tool-name">{ev.name.replace(/^mcp__[^_]+__/,'mcp: ')}</span>
   {ev.hint&&<code className="tool-hint">{ev.hint}</code>}
   <span className="tool-status">{ev.status==='running'?'…':ev.status==='ok'?'✓':ev.status==='declined'?'declined':'failed'}</span>
  </div>)}
 </div>;
}

// Day separators inside the feed ("Today" / "Yesterday" / date) — long chats are
// much easier to scan. Comparison is by local calendar day, not 24h distance.
const dayStart=(ts:number)=>{const d=new Date(ts);return new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime();};
function dayLabel(ts:number):string{
 const diff=Math.round((dayStart(Date.now())-dayStart(ts))/86400000);
 if(diff===0)return 'Today';
 if(diff===1)return 'Yesterday';
 return new Date(ts).toLocaleDateString([],{year:'numeric',month:'long',day:'numeric'});
}

function Usage({promptTokens,completionTokens,cost}:{promptTokens?:number|null;completionTokens?:number|null;cost?:string}){
 if(!promptTokens&&!completionTokens)return null;
 return <small className="token-usage">{promptTokens?'↑ '+promptTokens.toLocaleString():''}{promptTokens&&completionTokens?' · ':''}{completionTokens?'↓ '+completionTokens.toLocaleString():''} tokens{cost?' · ≈'+cost:''}</small>;
}

function Reasoning({text,collapsedByDefault,live}:{text:string;collapsedByDefault?:boolean;live?:boolean}){
 const [open,setOpen]=useState(!collapsedByDefault);
 // Live reasoning is throttled; stored reasoning is parsed once per content.
 const html=useThrottledMarkdown(text,live?120:0);
 if(!text)return null;
 return <div className="reasoning-block">
  <button className="reasoning-toggle" onClick={()=>setOpen(o=>!o)}><Brain size={12}/><span>Thinking</span><i>{open?'▾':'▸'}</i></button>
  {open&&<div className="reasoning-text"><Markdown html={html}/></div>}
 </div>;
}

function Variants({list,onRestore,onClose}:{list:MessageVariant[];onRestore:(id:string)=>void;onClose:()=>void}){
 if(!list.length)return <div className="models-empty">No previous answers kept</div>;
 return <div className="variant-list">{list.map((v,i)=>
  <button className="variant-row" key={v.id} onClick={()=>onRestore(v.id)} title="Restore this answer">
   <span className="variant-index">#{list.length-i}</span>
   <span className="variant-preview">{v.content.replace(/\s+/g,' ').slice(0,120)||'(empty)'}</span>
   <Check size={13}/></button>)}
  <button className="variant-close" onClick={onClose}>Close</button>
 </div>;
}

// One row per message. Memoized + markdown parsed once per content string: the whole
// point of idea #5. `isLast` is a boolean prop (not an identity compare against the
// parent's `last`) so memo can decide correctly without leaking the array.
// Long messages collapse to a preview; the threshold is in rendered text length.
const COLLAPSE_CHARS=3000;
// Copy-as-quote: markdown blockquote with attribution, ready to paste anywhere.
const asQuote=(m:Message)=>m.content.split('\n').map(l=>'> '+l).join('\n')+'\n\n— '+(m.role==='user'?'You':(m.model??'Lumen'))+', '+new Date(m.createdAt).toLocaleString();

// Text-to-speech for assistant replies (Web Speech API, Chromium built-in).
function speak(text:string,onEnd:()=>void):()=>void{
 const plain=text.replace(/```[\s\S]*?```/g,' code block ').replace(/[#*`_>]/g,'').slice(0,4000);
 const u=new SpeechSynthesisUtterance(plain);
 u.onend=onEnd;u.onerror=onEnd;
 speechSynthesis.cancel();speechSynthesis.speak(u);
 return ()=>speechSynthesis.cancel();
}

const MessageRow=memo(function MessageRow({m,isLast,busy,highlighted,variants,providers,onCopy,onRegenerate,onContinue,onDeleteMessage,onEditMessage,onLoadVariants,onRestoreVariant,onBranch,onBookmark,onRate,onImageClick,userInitial}:{
 m:Message;isLast:boolean;busy:boolean;highlighted?:boolean;variants:MessageVariant[];providers:ProviderConfig[];
 onCopy:(t:string)=>void;onRegenerate:()=>void;onContinue:(id:string)=>void;
 onDeleteMessage:(m:Message)=>void;onEditMessage:(m:Message,text:string)=>void;
 onLoadVariants:(id:string)=>void;onRestoreVariant:(id:string)=>void;
 onBranch:(m:Message)=>void;onBookmark:(m:Message)=>void;onRate:(m:Message,rating:number)=>void;onImageClick:(src:string)=>void;
 userInitial:string;
}){
 const html=useMarkdownHtml(m.content);
 const [editing,setEditing]=useState(false);
 const [editText,setEditText]=useState(m.content);
 const [showVariants,setShowVariants]=useState(false);
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
 return <article id={'msg-'+m.id} className={'message '+m.role+(highlighted?' highlighted':'')+(m.bookmarked?' bookmarked':'')}>
  <div className={'message-avatar '+m.role} style={m.role==='user'?{background:avatarGradient(userInitial)}:undefined}>{m.role==='user'?userInitial:'L'}</div>
  <div className="message-content">
   <div className="message-heading"><b>{m.role==='user'?'You':'Lumen'}</b>
    {m.role==='assistant'&&m.providerId&&<span className="msg-provider-dot" style={{background:providerColors[m.providerId]??'var(--faint)'}} title={m.providerId}/>}
    <small>{new Date(m.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</small>
    {m.role==='assistant'&&m.model&&<small className="message-model">{m.model}</small>}
    {m.role==='assistant'&&<Usage promptTokens={m.promptTokens} completionTokens={m.completionTokens} cost={cost}/>}
    {!!m.bookmarked&&<Bookmark size={12} className="bookmark-flag" aria-label="Bookmarked"/>}
   </div>
   {!!m.attachments?.length&&<div className="attach-list">
    {/* Persisted images are served by the lumen-attachment:// protocol (CSP-listed);
        the optimistic bubble carries its own data: preview instead. */}
    {m.attachments.map(a=><img className="attach-img" key={a.id} src={a.preview??`lumen-attachment://${a.id}`} alt={a.name} title={a.name+' — click to zoom'}
     onClick={e=>onImageClick((e.target as HTMLImageElement).src)}/>)}
   </div>}
   {editing
    ?<div className="message-edit">
      <textarea autoFocus value={editText} rows={3} onChange={e=>setEditText(e.target.value)}
       onKeyDown={e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();onEditMessage(m,editText);setEditing(false);}if(e.key==='Escape')setEditing(false);}}/>
      <div className="edit-actions">
       <button className="secondary-button" onClick={()=>setEditing(false)}>Cancel</button>
       <button className="primary-button" onClick={()=>{onEditMessage(m,editText);setEditing(false);}}>Save & resend</button>
      </div>
     </div>
    :<>
      <div className={collapsible&&!expanded?'collapsible collapsed':''}>
       <Markdown html={html}/>
      </div>
      {collapsible&&<button className="collapse-toggle" onClick={()=>setExpanded(v=>!v)} aria-expanded={expanded}>
       <ChevronDown size={12} className={expanded?'flip':''}/> {expanded?'Collapse':'Show full message ('+Math.round(m.content.length/1000)+'k chars)'}
      </button>}
     </>}
   {m.role==='assistant'&&(truncated||filtered||refused)&&
    <div className={'finish-note '+(truncated?'truncated':'blocked')}>
     {truncated?<><span>Answer was cut off by the token limit.</span><button onClick={()=>onContinue(m.id)}><CornerDownLeft size={12}/> Continue</button></>
      :<span>{filtered?'This response was filtered by the provider.':refused?'The model declined to answer.':'The provider did not report why it stopped.'}</span>}
    </div>}
   <div className="message-actions">
    <button className="copy-btn" onClick={()=>onCopy(m.content)} aria-label="Copy message"><Copy size={12}/> Copy</button>
    <button className="copy-btn" onClick={()=>onCopy(asQuote(m))} aria-label="Copy as quote" title="Copy as a quote with attribution"><Quote size={12}/></button>
    {m.role==='assistant'&&<button className={'copy-btn'+(speaking?' speaking':'')} onClick={toggleSpeak} aria-label={speaking?'Stop reading aloud':'Read aloud'} title={speaking?'Stop reading aloud':'Read aloud (text-to-speech)'}>{speaking?<VolumeX size={12}/>:<Volume2 size={12}/>}</button>}
    {!m.id.startsWith('pending-')&&<button className={'copy-btn'+(m.bookmarked?' bookmarked':'')} onClick={()=>onBookmark(m)} aria-label={m.bookmarked?'Remove bookmark':'Bookmark message'} title={m.bookmarked?'Remove bookmark':'Bookmark this message'}><Bookmark size={12}/></button>}
    {m.role==='user'&&!busy&&<button className="copy-btn" onClick={()=>{setEditText(m.content);setEditing(v=>!v);}} aria-label="Edit message"><Pencil size={12}/> Edit</button>}
    {m.role==='assistant'&&isLast&&<button className="copy-btn" disabled={busy} onClick={onRegenerate} aria-label="Regenerate response"><RefreshCw size={12}/> Regenerate</button>}
    {m.role==='assistant'&&!!m.variantCount&&<button className="copy-btn" onClick={()=>{setShowVariants(v=>!v);onLoadVariants(m.id);}} aria-label="Previous answers">History ({m.variantCount})</button>}
    {m.role==='assistant'&&<button className="copy-btn" onClick={()=>onDeleteMessage(m)} aria-label="Delete message"><Trash2 size={12}/></button>}
    {/* Answer rating: 👍/👎 stored on the message; clicking the active one clears it. */}
    {m.role==='assistant'&&!m.id.startsWith('pending-')&&<>
     <button className={'copy-btn'+(m.rating===1?' rated-up':'')} onClick={()=>onRate(m,m.rating===1?0:1)} aria-label="Good answer" title="Good answer"><ThumbsUp size={12}/></button>
     <button className={'copy-btn'+(m.rating===-1?' rated-down':'')} onClick={()=>onRate(m,m.rating===-1?0:-1)} aria-label="Bad answer" title="Bad answer"><ThumbsDown size={12}/></button>
    </>}
    {/* Pending bubbles (id "pending-…") exist only in the renderer — branching from one
        would fail in main, which knows nothing about the row yet. */}
    {!busy&&!m.id.startsWith('pending-')&&<button className="copy-btn" onClick={()=>onBranch(m)} aria-label="Branch conversation from here" title="Branch conversation from here"><GitFork size={12}/> Branch</button>}
   </div>
   {showVariants&&<Variants list={variants} onRestore={id=>{onRestoreVariant(id);setShowVariants(false);}} onClose={()=>setShowVariants(false)}/>}
  </div>
 </article>;
});

export default function MessageList({messages,busy,stream,reasoning,error,status,highlightId,variants,providers,bottomRef,onCopy,onRegenerate,onContinue,onDeleteMessage,onEditMessage,onRetry,onLoadVariants,onRestoreVariant,onBranch,onBookmark,onRate,toolEvents,userInitial}:Props){
 const last=messages[messages.length-1];
 const canRetry=!!last&&last.role==='assistant'&&!busy;
 // The streaming bubble re-parses on a throttle, not per chunk (idea #17).
 const streamHtml=useThrottledMarkdown(stream,120);
 // Image lightbox: full-screen zoom on click.
 const [lightbox,setLightbox]=useState('');
 // Bookmarked messages get a jump strip at the top of the feed.
 const bookmarks=messages.filter(m=>m.bookmarked&&!m.id.startsWith('pending-'));
 return <div className="message-list">
  {!!bookmarks.length&&<div className="bookmark-strip" aria-label="Bookmarked messages">
   <Bookmark size={12}/>{bookmarks.map(b=><button key={b.id} title={b.content.slice(0,120)} onClick={()=>document.getElementById('msg-'+b.id)?.scrollIntoView({block:'center'})}>{b.content.replace(/\s+/g,' ').slice(0,40)||'(attachment)'}</button>)}
  </div>}
  {messages.map((m,i)=>{
   const prev=messages[i-1];
   const newDay=!prev||dayStart(prev.createdAt)!==dayStart(m.createdAt);
   return <div key={m.id} className="day-group">
    {newDay&&<div className="date-sep" aria-hidden="true"><span>{dayLabel(m.createdAt)}</span></div>}
    <MessageRow m={m} isLast={i===messages.length-1} busy={busy} highlighted={m.id===highlightId} variants={variants[m.id]??NO_VARIANTS} providers={providers}
     onCopy={onCopy} onRegenerate={onRegenerate} onContinue={onContinue}
     onDeleteMessage={onDeleteMessage} onEditMessage={onEditMessage}
     onLoadVariants={onLoadVariants} onRestoreVariant={onRestoreVariant} onBranch={onBranch} onBookmark={onBookmark} onRate={onRate} onImageClick={setLightbox} userInitial={userInitial}/>
   </div>;
  })}
  {(busy||stream||reasoning)&&<article className="message assistant" aria-live="polite" aria-busy="true">
   <div className="message-avatar assistant">L</div>
   <div className="message-content">
    <div className="message-heading"><b>Lumen</b><small>{status??(stream?'Responding':'Thinking')}</small></div>
    {/* Indeterminate progress while generating — no total is knowable mid-stream. */}
    <div className="gen-progress" aria-hidden="true"><i/></div>
    {!!toolEvents?.length&&<ToolCards events={toolEvents}/>}
    <Reasoning key={stream?'answering':'thinking'} text={reasoning} collapsedByDefault={!!stream} live/>
    {stream
     ?<Markdown html={streamHtml}/>
     :!reasoning&&<div className="typing"><i/><i/><i/></div>}
   </div>
  </article>}
  {error&&<div className="error-banner" role="alert"><Activity size={14}/><span>{error}</span>{canRetry&&<button onClick={onRetry}>Retry</button>}</div>}
  <div ref={bottomRef}/>
  {lightbox&&<div className="lightbox" role="dialog" aria-label="Image preview" onClick={()=>setLightbox('')}><img src={lightbox} alt="Attachment, full size"/></div>}
 </div>;
}
