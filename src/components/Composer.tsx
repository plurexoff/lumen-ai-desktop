import {forwardRef,useRef,useState} from 'react';
import {ArrowUp,ChevronDown,ImagePlus,KeyRound,Shield,TriangleAlert,X} from 'lucide-react';
import type {Persona,ProviderConfig,ProviderId} from '../../electron/shared';
import {IMAGE_MIMES} from '../../electron/shared';
import type {PendingImage} from '../store';
import {providerColors} from '../store';

interface Props{
 draft:string;
 busy:boolean;
 needsSetup?:boolean;
 providers:ProviderConfig[];
 providerId:ProviderId;
 model:string;
 images:PendingImage[];
 personas:Persona[];
 personaId:string;
 onAddImages:(files:File[])=>void;
 onRemoveImage:(index:number)=>void;
 onPersona:(id:string)=>void;
 onDraft:(value:string)=>void;
 onSend:()=>void;
 onStop:()=>void;
 onProvider:(id:ProviderId)=>void;
 onModel:(model:string)=>void;
 onOpenSettings:()=>void;
}

export default forwardRef<HTMLTextAreaElement,Props>(function Composer({draft,busy,needsSetup,providers,providerId,model,images,personas,personaId,onAddImages,onRemoveImage,onPersona,onDraft,onSend,onStop,onProvider,onModel,onOpenSettings},ref){
 const current=providers.find(p=>p.id===providerId);
 const models=current?.models??[];
 // An IME (CJK input) fires Enter to commit a candidate, not to send the message.
 const composing=useRef(false);
 const fileInput=useRef<HTMLInputElement>(null);
 const isImage=(f:File)=>(IMAGE_MIMES as readonly string[]).includes(f.type);
 // Images are staged as attachments; anything else goes through the text-file path.
 // Validation feedback (mime/count/size) comes from App.addImages via the toast.
 const partitionFiles=(files:File[])=>{const imgs=files.filter(isImage);if(imgs.length)onAddImages(imgs);return files.filter(f=>!isImage(f));};
 // Rejected/oversized drop feedback. The global toast is the wrong place: the user is
 // looking at the composer, and a silent no-op reads as "the app ignored my file".
 const [dropError,setDropError]=useState('');
 // A dropped/pasted text file is read whole into one string. Without a cap a large
 // .log (300 MB+) allocates gigabytes and can crash the sandboxed renderer — and the
 // main process rejects anything over MAX_MESSAGE_CHARS anyway, so fail early here
 // with a message instead of OOMing. 2 MB of text is already ~300k words.
 const MAX_DROP_FILE_BYTES=2*1024*1024;
 // A discriminated result so callers cannot read `.text` off the error branch (and so
 // `skipped` is only present where it is meaningful).
 type DropResult={kind:'skip'}|{kind:'error';error:string}|{kind:'text';text:string;skipped:number};
 const readTextFiles=(files:File[]):Promise<DropResult>=>{
  const textFiles=files.filter(f=>f.type.startsWith('text/')||/\.(txt|md|json|csv|log|ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|css|html|yml|yaml|xml)$/i.test(f.name));
  if(!textFiles.length)return Promise.resolve({kind:'skip'});
  const tooBig=textFiles.find(f=>f.size>MAX_DROP_FILE_BYTES);
  if(tooBig)return Promise.resolve({kind:'error',error:`"${tooBig.name}" is ${(tooBig.size/1048576).toFixed(1)} MB — text files must be under 2 MB`});
  const kept=textFiles.slice(0,5);
  const skipped=textFiles.length-kept.length;
  return Promise.all(kept.map(f=>f.text())).then(parts=>({kind:'text',text:parts.join('\n\n'),skipped}));
 };
 const autosize=(el:HTMLTextAreaElement)=>{el.style.height='auto';el.style.height=Math.min(el.scrollHeight,140)+'px';};
 const pasteText=(text:string)=>{
  const text2=(draft?draft+'\n':'')+text;
  onDraft(text2);
  // Height is recomputed after React applies the value.
  requestAnimationFrame(()=>{const el=(ref&&typeof ref!=='function'?ref.current:null)??null;if(el)autosize(el);});
 };
 return <footer className="composer-area"><div className="composer">
  {needsSetup&&<div className="composer-warning">
   <KeyRound size={13}/><span>No provider is connected yet.</span>
   <button onClick={onOpenSettings}>Connect one</button>
  </div>}
  {dropError&&<div className="composer-warning" role="alert">
   <TriangleAlert size={13}/><span>{dropError}</span>
   <button onClick={()=>setDropError('')}>Dismiss</button>
  </div>}
  {!!images.length&&<div className="attach-strip">
   {images.map((a,i)=><span className="attach-thumb" key={i} title={a.name}>
    <img src={a.preview} alt={a.name}/>
    <button aria-label={'Remove '+a.name} onClick={()=>onRemoveImage(i)}><X size={11}/></button>
   </span>)}
  </div>}
  <input ref={fileInput} type="file" accept={IMAGE_MIMES.join(',')} multiple hidden aria-hidden="true" tabIndex={-1}
   onChange={e=>{const files=Array.from(e.target.files??[]);if(files.length)onAddImages(files);e.target.value='';}}/>
  <textarea ref={ref} value={draft} rows={1} spellCheck
   onCompositionStart={()=>{composing.current=true;}}
   onCompositionEnd={()=>{composing.current=false;}}
   onChange={e=>{onDraft(e.target.value);autosize(e.currentTarget);}}
   onKeyDown={e=>{
    // Ctrl/Cmd+Enter always sends; plain Enter sends unless composing an IME string.
    if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();onSend();return;}
    if(e.key==='Enter'&&!e.shiftKey&&!composing.current){e.preventDefault();onSend();}
   }}
   onPaste={e=>{
    // Drag-and-drop and paste: images become attachments, text files are read whole
    // instead of inserting "[object File]".
    const files=Array.from(e.clipboardData.files);
    if(!files.length)return;
    e.preventDefault();
    const texts=partitionFiles(files);
    if(!texts.length)return;
    void readTextFiles(texts).then(r=>{
     if(r.kind==='error'){setDropError(r.error);return;}
     if(r.kind==='skip')return;
     setDropError(r.skipped?`Only the first 5 files were inserted (${r.skipped} skipped)`:'');
     pasteText(r.text);
    });
   }}
   onDrop={e=>{
    const files=Array.from(e.dataTransfer?.files??[]);
    if(!files.length)return;
    e.preventDefault();
    const texts=partitionFiles(files);
    if(!texts.length)return;
    void readTextFiles(texts).then(r=>{
     if(r.kind==='error'){setDropError(r.error);return;}
     if(r.kind==='skip')return;
     setDropError(r.skipped?`Only the first 5 files were inserted (${r.skipped} skipped)`:'');
     pasteText(r.text);
    });
   }}
   onDragOver={e=>{if(e.dataTransfer?.types?.includes('Files'))e.preventDefault();}}
   placeholder={needsSetup?'Connect a provider first…':'Message Lumen…'} aria-label="Message Lumen"/>
  <div className="composer-bottom">
   <div className="model-picker">
    {!!personas.length&&<>
     {(()=>{const persona=personas.find(p=>p.id===personaId);return <span className="provider-dot" style={{background:persona?.color??'transparent',border:persona?'none':'1px dashed var(--faint)'}} aria-hidden="true"/>;})()}
     <select value={personaId} onChange={e=>onPersona(e.target.value)} aria-label="Persona" title="Persona: overrides the system prompt for new messages">
      <option value="">Default</option>
      {personas.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
     </select>
     <span className="picker-divider" aria-hidden="true"/>
    </>}
    <span className="provider-dot" style={{background:providerColors[providerId]}} aria-hidden="true"/>
    <select value={providerId} onChange={e=>onProvider(e.target.value as ProviderId)} aria-label="Provider">{providers.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>
    <span className="picker-divider" aria-hidden="true"/>
    <select value={model} onChange={e=>onModel(e.target.value)} disabled={!models.length} aria-label="Model">
     <option value="">{models.length?'Choose model':'Add a model in Settings'}</option>
     {models.map(m=><option key={m} value={m}>{m}</option>)}
    </select>
    <ChevronDown size={13} aria-hidden="true"/>
   </div>
   <div className="send-area">
    <button className="attach-btn" aria-label="Attach images" title="Attach images (PNG, JPEG, WebP, GIF)" onClick={()=>fileInput.current?.click()}><ImagePlus size={15}/></button>
    <small><kbd>↵</kbd> to send</small>
    {/* Never pass the handler straight to onClick: React would hand it the mouse
        event as the first argument, and send(text?) would treat that object as the
        message body. Wrap it so the call is genuinely zero-arg. */}
    <button className={'send-btn '+(busy?'stop':'')} aria-label={busy?'Stop generation':'Send message'} title={busy?'Stop generation':'Send message'} onClick={()=>{if(busy)onStop();else onSend();}}>{busy?<X size={15}/>:<ArrowUp size={16}/>}</button>
   </div>
  </div>
 </div><div className="composer-note"><Shield size={11} aria-hidden="true"/> API keys encrypted on this device <span>·</span> Responses may not always be accurate</div></footer>;
});
