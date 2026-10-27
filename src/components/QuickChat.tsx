import {useEffect,useRef,useState} from 'react';
import {ArrowUp,Copy,Sparkles,X} from 'lucide-react';
import {renderMarkdown} from '../markdown';

// The quick-chat mini window (#quick): one question, one answer. Uses the provider
// and model of the most recent conversation via the main process (quick:ask), so it
// works without any setup UI here. Esc / clicking away hides the window.
export default function QuickChat(){
 const [question,setQuestion]=useState('');
 const [answer,setAnswer]=useState('');
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [copied,setCopied]=useState(false);
 const input=useRef<HTMLTextAreaElement>(null);
 // Focus the input every time the global hotkey shows the window.
 useEffect(()=>window.lumen.quick.onShown(()=>{setError('');requestAnimationFrame(()=>{input.current?.focus();input.current?.select();});}),[]);
 const ask=()=>{
  const text=question.trim();
  if(!text||busy)return;
  setBusy(true);setAnswer('');setError('');
  window.lumen.quick.ask(text)
   .then(t=>setAnswer(t))
   .catch(e=>setError(e instanceof Error?e.message:'Request failed'))
   .finally(()=>setBusy(false));
 };
 const copy=()=>{void navigator.clipboard.writeText(answer).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),1200);});};
 return <div className="quick-shell">
  <header className="quick-head">
   <Sparkles size={14}/><b>Quick chat</b>
   <button className="icon-btn" aria-label="Hide quick chat" title="Hide (Esc)" onClick={()=>window.lumen.quick.hide()}><X size={14}/></button>
  </header>
  {(answer||busy||error)
   ?<div className="quick-answer">
     {error?<p className="quick-error" role="alert">{error}</p>:busy&&!answer?<p className="quick-thinking">Thinking…</p>:<div className="markdown" dangerouslySetInnerHTML={{__html:renderMarkdown(answer)}}/>}
     {answer&&<button className="copy-btn" onClick={copy} aria-label="Copy answer"><Copy size={12}/> {copied?'Copied':'Copy'}</button>}
    </div>
   :null}
  <div className="quick-input">
   <textarea ref={input} value={question} rows={1} autoFocus spellCheck placeholder="Ask anything…"
    onChange={e=>setQuestion(e.target.value)}
    onKeyDown={e=>{
     if(e.key==='Escape'){window.lumen.quick.hide();return;}
     if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();ask();}
    }}/>
   <button className="send-btn" aria-label="Ask" title="Ask" disabled={busy||!question.trim()} onClick={ask}><ArrowUp size={15}/></button>
  </div>
 </div>;
}
