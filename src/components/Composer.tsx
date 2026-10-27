import {forwardRef,useEffect,useRef,useState} from 'react';
import {ArrowUp,ChevronDown,Eye,FileText,ImagePlus,KeyRound,LayoutTemplate,ListPlus,Mic,MicOff,Shield,TriangleAlert,Wand2,X} from 'lucide-react';
import type {Persona,PromptTemplate,ProviderConfig,ProviderId} from '../../electron/shared';
import {IMAGE_MIMES} from '../../electron/shared';
import type {PendingImage} from '../store';
import {providerColors} from '../store';
import {renderMarkdown} from '../markdown';
import {useCountUp} from '../useCountUp';
import {formatCost} from '../cost';
import {t,useT} from '../i18n';

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
 templates:PromptTemplate[];
 // Sent-message history for ArrowUp recall (newest last), and messages queued while
 // this chat was busy (they auto-send when the reply finishes).
 history:string[];
 queued:string[];
 onAddImages:(files:File[])=>void;
 onRemoveImage:(index:number)=>void;
 onPersona:(id:string)=>void;
 onDraft:(value:string)=>void;
 onSend:()=>void;
 onStop:()=>void;
 onProvider:(id:ProviderId)=>void;
 onModel:(model:string)=>void;
 onOpenSettings:()=>void;
 onEnhance:(text:string)=>Promise<string>;
 onClearQueue:()=>void;
 // Slash commands (/persona X, /model Y, /clear, /template N). Returns true when the
 // draft was consumed as a command.
 onSlash:(raw:string)=>boolean;
 // @file autocomplete source: workspace-relative paths matching a substring. Absent
 // when the chat has no workspace — the "@" menu simply never opens then.
 fileQuery?:(q:string)=>Promise<string[]>;
}

// Rough draft token estimate plus its cost at the current model's input price.
// Deliberately approximate — it is a budgeting hint, not accounting. The token
// count comes in pre-tweened (useCountUp) so the digits glide while typing.
function estimateDraft(tokens:number,providers:ProviderConfig[],providerId:ProviderId,model:string):string{
 if(!tokens)return '';
 const price=providers.find(p=>p.id===providerId)?.pricing?.[model];
 const cost=price?formatCost(tokens/1e6*price.input):null;
 return t('composer.tokensEstimate',{tokens:tokens.toLocaleString()})+(cost?t('composer.tokensCost',{cost}):'');
}

// Minimal shape of the Web Speech API recognizer (not in TS's DOM lib for all builds).
interface SpeechRecognitionLike{
 lang:string;interimResults:boolean;continuous:boolean;
 onresult:((e:{results:ArrayLike<ArrayLike<{transcript:string}>>})=>void)|null;
 onend:(()=>void)|null;onerror:(()=>void)|null;
 start():void;stop():void;
}

export default forwardRef<HTMLTextAreaElement,Props>(function Composer({draft,busy,needsSetup,providers,providerId,model,images,personas,personaId,templates,history,queued,onAddImages,onRemoveImage,onPersona,onDraft,onSend,onStop,onProvider,onModel,onOpenSettings,onEnhance,onClearQueue,onSlash,fileQuery},ref){
 const current=providers.find(p=>p.id===providerId);
 const models=current?.models??[];
 const t=useT();
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
  if(tooBig)return Promise.resolve({kind:'error',error:t('composer.fileTooBig',{name:tooBig.name,size:(tooBig.size/1048576).toFixed(1)})});
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
 // Prompt history recall (terminal-style): ArrowUp at the start of the input walks
 // back through sent messages, ArrowDown walks forward and finally restores the
 // draft the user was typing before navigating.
 const nav=useRef<{idx:number;saved:string}|null>(null);
 useEffect(()=>{nav.current=null;},[history.length]);
 // Enhance Prompt: the draft goes to the model and comes back rewritten; the spinner
 // is local, errors are flashed by the App-level handler.
 const [enhancing,setEnhancing]=useState(false);
 const enhance=()=>{
  const text=draft.trim();
  if(!text||enhancing||busy)return;
  setEnhancing(true);
  onEnhance(text)
   .then(t=>{onDraft(t);requestAnimationFrame(()=>{const el=(ref&&typeof ref!=='function'?ref.current:null)??null;if(el){autosize(el);el.focus();}});})
   .catch(()=>{})
   .finally(()=>setEnhancing(false));
 };
 // Slash commands: a draft starting with "/" is consumed by App (/persona, /model,
 // /clear, /template …) instead of being sent as a message.
 const sendOrSlash=()=>{if(busy){onStop();return;}if(draft.trimStart().startsWith('/')&&onSlash(draft.trim()))return;onSend();};
 // Prompt templates: {{input}} is replaced by the current draft.
 const [showTemplates,setShowTemplates]=useState(false);
 const applyTemplate=(t:PromptTemplate)=>{onDraft(t.text.includes('{{input}}')?t.text.replace('{{input}}',draft):(draft?draft+'\n\n':'')+t.text);setShowTemplates(false);requestAnimationFrame(()=>{const el=(ref&&typeof ref!=='function'?ref.current:null)??null;if(el){autosize(el);el.focus();}});};
 // Voice input via the Chromium speech recognizer.
 const [listening,setListening]=useState(false);
 const recogRef=useRef<{stop:()=>void}|null>(null);
 useEffect(()=>()=>{recogRef.current?.stop();},[]);
 const toggleVoice=()=>{
  if(listening){recogRef.current?.stop();setListening(false);return;}
  const w=window as unknown as {SpeechRecognition?:new()=>SpeechRecognitionLike;webkitSpeechRecognition?:new()=>SpeechRecognitionLike};
  const Ctor=w.SpeechRecognition??w.webkitSpeechRecognition;
  if(!Ctor){setDropError(t('composer.noSpeech'));return;}
  const recog=new Ctor();
  recog.lang='ru-RU';recog.interimResults=true;recog.continuous=true;
  const base=draft;
  recog.onresult=e=>{let text=base;for(let i=0;i<e.results.length;i++)text+=(text&&!text.endsWith(' ')?' ':'')+e.results[i][0].transcript;onDraft(text);};
  recog.onend=()=>setListening(false);
  recog.onerror=()=>setListening(false);
  recogRef.current=recog;
  try{recog.start();setListening(true);}catch{setListening(false);}
 };
 // Live markdown preview of the draft + a rough token/cost counter.
 const [preview,setPreview]=useState(false);
 const previewHtml=preview&&draft.trim()?renderMarkdown(draft):'';
 const draftTokens=draft.trim()?Math.ceil(draft.length/4):0;
 const counter=estimateDraft(useCountUp(draftTokens),providers,providerId,model);
 // @file autocomplete: a "@src/ut…" token right before the caret queries the
 // workspace file list (main applies the same jail rules as the model's tools).
 const [fileMenu,setFileMenu]=useState<{start:number;items:string[];sel:number}|null>(null);
 const fileMenuRef=useRef(fileMenu);
 useEffect(()=>{fileMenuRef.current=fileMenu;},[fileMenu]);
 const updateFileMenu=(el:HTMLTextAreaElement,value:string)=>{
  if(!fileQuery){if(fileMenuRef.current)setFileMenu(null);return;}
  const caret=el.selectionStart;
  const m=/@([\w./\\-]*)$/.exec(value.slice(0,caret));
  if(!m){if(fileMenuRef.current)setFileMenu(null);return;}
  const start=caret-m[0].length;
  void fileQuery(m[1]).then(items=>{
   // A newer keystroke may have closed or moved the menu meanwhile.
   if(fileMenuRef.current?.start!==start&&fileMenuRef.current!==null)return;
   setFileMenu({start,items,sel:0});
  }).catch(()=>setFileMenu(null));
 };
 const pickFile=(item:string)=>{
  const fm=fileMenuRef.current;
  if(!fm)return;
  const el=(ref&&typeof ref!=='function'?ref.current:null)??null;
  const caret=el?el.selectionStart:draft.length;
  onDraft(draft.slice(0,fm.start)+'@'+item+' '+draft.slice(caret));
  setFileMenu(null);
  requestAnimationFrame(()=>{if(el){const pos=fm.start+item.length+2;el.setSelectionRange(pos,pos);el.focus();autosize(el);}});
 };
 return <footer className="composer-area"><div className={'composer'+(busy?' busy':'')}>
  {needsSetup&&<div className="composer-warning">
   <KeyRound size={13}/><span>{t('composer.noProvider')}</span>
   <button onClick={onOpenSettings}>{t('composer.connectProvider')}</button>
  </div>}
  {dropError&&<div className="composer-warning" role="alert">
   <TriangleAlert size={13}/><span>{dropError}</span>
   <button onClick={()=>setDropError('')}>{t('composer.dismiss')}</button>
  </div>}
  {!!images.length&&<div className="attach-strip">
   {images.map((a,i)=><span className="attach-thumb" key={i} title={a.name}>
    <img src={a.preview} alt={a.name}/>
    <button aria-label={t('composer.removeAttachment',{name:a.name})} onClick={()=>onRemoveImage(i)}><X size={11}/></button>
   </span>)}
  </div>}
  {!!queued.length&&<div className="queue-chip" role="status">
   <ListPlus size={12}/><span>{t('composer.queued',{n:queued.length})}</span>
   <button aria-label={t('composer.clearQueue')} title={t('composer.clearQueue')} onClick={onClearQueue}><X size={11}/></button>
  </div>}
  <input ref={fileInput} type="file" accept={IMAGE_MIMES.join(',')} multiple hidden aria-hidden="true" tabIndex={-1}
   onChange={e=>{const files=Array.from(e.target.files??[]);if(files.length)onAddImages(files);e.target.value='';}}/>
  {preview&&<div className="composer-preview markdown-body" aria-label={t('composer.draftPreview')} dangerouslySetInnerHTML={{__html:previewHtml||'<p>'+t('composer.nothingToPreview')+'</p>'}}/>}
  {showTemplates&&<div className="templates-menu" role="menu">
   {templates.length?templates.map(t=><button key={t.id} role="menuitem" onClick={()=>applyTemplate(t)}><LayoutTemplate size={12}/><span>{t.name}</span></button>):<span className="templates-empty">{t('composer.noTemplates')}</span>}
  </div>}
  {fileMenu&&fileMenu.items.length>0&&<div className="file-menu" role="listbox" aria-label={t('composer.workspaceFiles')}>
   {fileMenu.items.slice(0,8).map((f,i)=><button key={f} role="option" aria-selected={i===fileMenu.sel} className={i===fileMenu.sel?'active':''}
    onMouseDown={e=>{e.preventDefault();pickFile(f);}}><FileText size={12}/><span>{f}</span></button>)}
  </div>}
  <textarea ref={ref} value={draft} rows={1} spellCheck
   onCompositionStart={()=>{composing.current=true;}}
   onCompositionEnd={()=>{composing.current=false;}}
   onChange={e=>{nav.current=null;onDraft(e.target.value);autosize(e.currentTarget);updateFileMenu(e.currentTarget,e.target.value);}}
   onKeyDown={e=>{
    // The @file menu owns navigation/selection keys while it is open.
    const fm=fileMenuRef.current;
    if(fm&&fm.items.length){
     if(e.key==='ArrowDown'){e.preventDefault();setFileMenu({...fm,sel:(fm.sel+1)%Math.min(8,fm.items.length)});return;}
     if(e.key==='ArrowUp'){e.preventDefault();setFileMenu({...fm,sel:(fm.sel-1+Math.min(8,fm.items.length))%Math.min(8,fm.items.length)});return;}
     if(e.key==='Enter'||e.key==='Tab'){e.preventDefault();pickFile(fm.items[fm.sel]);return;}
     if(e.key==='Escape'){e.preventDefault();setFileMenu(null);return;}
    }
    // Ctrl/Cmd+Enter always sends; plain Enter sends unless composing an IME string.
    if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();sendOrSlash();return;}
    if(e.key==='Enter'&&!e.shiftKey&&!composing.current){e.preventDefault();sendOrSlash();return;}
    // ArrowUp at the very start of the input recalls the last sent message.
    if(e.key==='ArrowUp'&&history.length&&e.currentTarget.selectionStart===0&&e.currentTarget.selectionEnd===0){
     e.preventDefault();
     const n=nav.current??{idx:history.length,saved:draft};
     n.idx=Math.max(0,n.idx-1);
     nav.current=n;
     onDraft(history[n.idx]);
     return;
    }
    if(e.key==='ArrowDown'&&nav.current){
     e.preventDefault();
     const n=nav.current;
     if(n.idx>=history.length-1){nav.current=null;onDraft(n.saved);}
     else{n.idx+=1;onDraft(history[n.idx]);}
    }
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
     setDropError(r.skipped?t('composer.filesSkipped',{skipped:r.skipped}):'');
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
     setDropError(r.skipped?t('composer.filesSkipped',{skipped:r.skipped}):'');
     pasteText(r.text);
    });
   }}
   onDragOver={e=>{if(e.dataTransfer?.types?.includes('Files'))e.preventDefault();}}
   placeholder={needsSetup?t('composer.placeholderSetup'):t('composer.placeholder')} aria-label={t('composer.messageLumen')}/>
  <div className="composer-bottom">
   <div className="model-picker">
    {!!personas.length&&<>
     {(()=>{const persona=personas.find(p=>p.id===personaId);return <span className="provider-dot" style={{background:persona?.color??'transparent',border:persona?'none':'1px dashed var(--faint)'}} aria-hidden="true"/>;})()}
     <select value={personaId} onChange={e=>onPersona(e.target.value)} aria-label={t('composer.persona')} title={t('composer.personaHint')}>
      <option value="">{t('composer.defaultPersona')}</option>
      {personas.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
     </select>
     <span className="picker-divider" aria-hidden="true"/>
    </>}
    <span className="provider-dot" style={{background:providerColors[providerId]??providerColors.custom}} aria-hidden="true"/>
    <select value={providerId} onChange={e=>onProvider(e.target.value as ProviderId)} aria-label={t('composer.provider')}>{providers.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>
    <span className="picker-divider" aria-hidden="true"/>
    <select value={model} onChange={e=>onModel(e.target.value)} disabled={!models.length} aria-label={t('composer.model')}>
     <option value="">{models.length?t('composer.chooseModel'):t('composer.addModel')}</option>
     {models.map(m=><option key={m} value={m}>{m}</option>)}
    </select>
    <ChevronDown size={13} aria-hidden="true"/>
   </div>
   <div className="send-area">
    <button className="attach-btn" aria-label={t('composer.attachImages')} title={t('composer.attachImagesHint')} onClick={()=>fileInput.current?.click()}><ImagePlus size={15}/></button>
    <button className={'attach-btn enhance-btn'+(enhancing?' spinning':'')} aria-label={t('composer.enhance')} title={t('composer.enhanceHint')} disabled={!draft.trim()||busy||enhancing} onClick={enhance}><Wand2 size={15}/></button>
    <button className={'attach-btn'+(showTemplates?' active':'')} aria-label={t('composer.templates')} title={t('composer.templatesHint')} onClick={()=>setShowTemplates(v=>!v)}><LayoutTemplate size={15}/></button>
    <button className={'attach-btn'+(listening?' active recording':'')} aria-label={listening?t('composer.stopVoice'):t('composer.voiceInput')} title={listening?t('composer.stopVoice'):t('composer.voiceInputHint')} onClick={toggleVoice}>{listening?<MicOff size={15}/>:<Mic size={15}/>}</button>
    <button className={'attach-btn'+(preview?' active':'')} aria-label={t('composer.togglePreview')} title={t('composer.previewMarkdown')} disabled={!draft.trim()} onClick={()=>setPreview(v=>!v)}><Eye size={15}/></button>
    <small><kbd>↵</kbd> {t('composer.toSend')}</small>
    {/* Never pass the handler straight to onClick: React would hand it the mouse
        event as the first argument, and send(text?) would treat that object as the
        message body. Wrap it so the call is genuinely zero-arg. */}
    <button className={'send-btn '+(busy?'stop':'')} aria-label={busy?t('composer.stopGeneration'):t('composer.sendMessage')} title={busy?t('composer.stopGeneration'):t('composer.sendMessage')} onClick={()=>{sendOrSlash();}}>{busy?<X size={15}/>:<ArrowUp size={16}/>}</button>
   </div>
  </div>
 </div><div className="composer-note"><Shield size={11} aria-hidden="true"/> {t('composer.keysEncrypted')} <span>·</span> {t('composer.accuracyNote')}{counter&&<><span>·</span><span className="composer-counter">{counter}</span></>}</div></footer>;
});
