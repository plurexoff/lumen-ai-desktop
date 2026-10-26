import {memo,useState} from 'react';
import type {RefObject} from 'react';
import {Activity,Brain,Check,Copy,CornerDownLeft,GitFork,Pencil,RefreshCw,Sparkles,Trash2} from 'lucide-react';
import type {Message,MessageVariant} from '../../electron/shared';
import {useMarkdownHtml,useThrottledMarkdown} from '../useMarkdown';

interface Props{
 messages:Message[];
 busy:boolean;
 stream:string;
 reasoning:string;
 error:string;
 variants:Record<string,MessageVariant[]>;
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
}

// Stable empty array so the `variants[id] ?? NO_VARIANTS` fallback does not hand each
// memoized row a fresh reference every render (which would defeat React.memo).
const NO_VARIANTS:MessageVariant[]=[];

function Usage({promptTokens,completionTokens}:{promptTokens?:number|null;completionTokens?:number|null}){
 if(!promptTokens&&!completionTokens)return null;
 return <small className="token-usage">{promptTokens?'↑ '+promptTokens.toLocaleString():''}{promptTokens&&completionTokens?' · ':''}{completionTokens?'↓ '+completionTokens.toLocaleString():''} tokens</small>;
}

function Reasoning({text,collapsedByDefault,live}:{text:string;collapsedByDefault?:boolean;live?:boolean}){
 const [open,setOpen]=useState(!collapsedByDefault);
 // Live reasoning is throttled; stored reasoning is parsed once per content.
 const html=useThrottledMarkdown(text,live?120:0);
 if(!text)return null;
 return <div className="reasoning-block">
  <button className="reasoning-toggle" onClick={()=>setOpen(o=>!o)}><Brain size={12}/><span>Thinking</span><i>{open?'▾':'▸'}</i></button>
  {open&&<div className="markdown reasoning-text" dangerouslySetInnerHTML={{__html:html}}/>}
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
const MessageRow=memo(function MessageRow({m,isLast,busy,variants,onCopy,onRegenerate,onContinue,onDeleteMessage,onEditMessage,onLoadVariants,onRestoreVariant,onBranch}:{
 m:Message;isLast:boolean;busy:boolean;variants:MessageVariant[];
 onCopy:(t:string)=>void;onRegenerate:()=>void;onContinue:(id:string)=>void;
 onDeleteMessage:(m:Message)=>void;onEditMessage:(m:Message,text:string)=>void;
 onLoadVariants:(id:string)=>void;onRestoreVariant:(id:string)=>void;
 onBranch:(m:Message)=>void;
}){
 const html=useMarkdownHtml(m.content);
 const [editing,setEditing]=useState(false);
 const [editText,setEditText]=useState(m.content);
 const [showVariants,setShowVariants]=useState(false);
 const truncated=m.finishReason==='length';
 const filtered=m.finishReason==='content_filter';
 const refused=m.finishReason==='refusal';
 return <article className={'message '+m.role}>
  <div className="message-avatar">{m.role==='user'?'Y':<Sparkles size={15}/>}</div>
  <div className="message-content">
   <div className="message-heading"><b>{m.role==='user'?'You':'Lumen'}</b>
    <small>{new Date(m.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</small>
    {m.role==='assistant'&&m.model&&<small className="message-model">{m.model}</small>}
    {m.role==='assistant'&&<Usage promptTokens={m.promptTokens} completionTokens={m.completionTokens}/>}
   </div>
   {!!m.attachments?.length&&<div className="attach-list">
    {/* Persisted images are served by the lumen-attachment:// protocol (CSP-listed);
        the optimistic bubble carries its own data: preview instead. */}
    {m.attachments.map(a=><img className="attach-img" key={a.id} src={a.preview??`lumen-attachment://${a.id}`} alt={a.name} title={a.name}/>)}
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
    :<div className="markdown" dangerouslySetInnerHTML={{__html:html}}/>}
   {m.role==='assistant'&&(truncated||filtered||refused)&&
    <div className={'finish-note '+(truncated?'truncated':'blocked')}>
     {truncated?<><span>Answer was cut off by the token limit.</span><button onClick={()=>onContinue(m.id)}><CornerDownLeft size={12}/> Continue</button></>
      :<span>{filtered?'This response was filtered by the provider.':refused?'The model declined to answer.':'The provider did not report why it stopped.'}</span>}
    </div>}
   <div className="message-actions">
    <button className="copy-btn" onClick={()=>onCopy(m.content)} aria-label="Copy message"><Copy size={12}/> Copy</button>
    {m.role==='user'&&!busy&&<button className="copy-btn" onClick={()=>{setEditText(m.content);setEditing(v=>!v);}} aria-label="Edit message"><Pencil size={12}/> Edit</button>}
    {m.role==='assistant'&&isLast&&<button className="copy-btn" disabled={busy} onClick={onRegenerate} aria-label="Regenerate response"><RefreshCw size={12}/> Regenerate</button>}
    {m.role==='assistant'&&!!m.variantCount&&<button className="copy-btn" onClick={()=>{setShowVariants(v=>!v);onLoadVariants(m.id);}} aria-label="Previous answers">History ({m.variantCount})</button>}
    {m.role==='assistant'&&<button className="copy-btn" onClick={()=>onDeleteMessage(m)} aria-label="Delete message"><Trash2 size={12}/></button>}
    {/* Pending bubbles (id "pending-…") exist only in the renderer — branching from one
        would fail in main, which knows nothing about the row yet. */}
    {!busy&&!m.id.startsWith('pending-')&&<button className="copy-btn" onClick={()=>onBranch(m)} aria-label="Branch conversation from here" title="Branch conversation from here"><GitFork size={12}/> Branch</button>}
   </div>
   {showVariants&&<Variants list={variants} onRestore={id=>{onRestoreVariant(id);setShowVariants(false);}} onClose={()=>setShowVariants(false)}/>}
  </div>
 </article>;
});

export default function MessageList({messages,busy,stream,reasoning,error,variants,bottomRef,onCopy,onRegenerate,onContinue,onDeleteMessage,onEditMessage,onRetry,onLoadVariants,onRestoreVariant,onBranch}:Props){
 const last=messages[messages.length-1];
 const canRetry=!!last&&last.role==='assistant'&&!busy;
 // The streaming bubble re-parses on a throttle, not per chunk (idea #17).
 const streamHtml=useThrottledMarkdown(stream,120);
 return <div className="message-list">
  {messages.map((m,i)=><MessageRow key={m.id} m={m} isLast={i===messages.length-1} busy={busy} variants={variants[m.id]??NO_VARIANTS}
    onCopy={onCopy} onRegenerate={onRegenerate} onContinue={onContinue}
    onDeleteMessage={onDeleteMessage} onEditMessage={onEditMessage}
    onLoadVariants={onLoadVariants} onRestoreVariant={onRestoreVariant} onBranch={onBranch}/>)}
  {(busy||stream||reasoning)&&<article className="message assistant" aria-live="polite" aria-busy="true">
   <div className="message-avatar"><Sparkles size={15}/></div>
   <div className="message-content">
    <div className="message-heading"><b>Lumen</b><small>{stream?'Responding':'Thinking'}</small></div>
    <Reasoning key={stream?'answering':'thinking'} text={reasoning} collapsedByDefault={!!stream} live/>
    {stream
     ?<div className="markdown" dangerouslySetInnerHTML={{__html:streamHtml}}/>
     :!reasoning&&<div className="typing"><i/><i/><i/></div>}
   </div>
  </article>}
  {error&&<div className="error-banner" role="alert"><Activity size={14}/><span>{error}</span>{canRetry&&<button onClick={onRetry}>Retry</button>}</div>}
  <div ref={bottomRef}/>
 </div>;
}
