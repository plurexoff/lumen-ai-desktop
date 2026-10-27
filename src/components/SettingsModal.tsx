import {useEffect,useState} from 'react';
import {Archive,BarChart3,Bot,Check,FileDown,FolderOpen,Keyboard,LayoutTemplate,Moon,Monitor,Pencil,Plus,RotateCcw,Save,Server,Shield,Sparkles,Sun,Trash2,X} from 'lucide-react';
import type {Accent,DayUsage,HotkeyMap,McpServer,Persona,PromptTemplate,ProviderConfig,ProviderId,UsageRow,UsageSummary} from '../../electron/shared';
import {ACCENTS,DENSITIES,isCustomProviderId,PERSONA_COLORS,REASONING_EFFORTS,THEME_PRESETS} from '../../electron/shared';
import type {Prefs} from '../store';
import {providerColors} from '../store';
import {formatCost,messageCost} from '../cost';

type Tab='providers'|'appearance'|'agents'|'data'|'stats';

interface Props{
 tab:Tab;
 onTab:(t:Tab)=>void;
 providers:ProviderConfig[];
 providerId:ProviderId;
 model:string;
 settings:Prefs;
 hasActiveChat:boolean;
 onClose:()=>void;
 onProviderSelect:(id:ProviderId)=>void;
 onModel:(model:string)=>void;
 onPref:<K extends keyof Prefs>(key:K,value:Prefs[K])=>void;
 onSaveProvider:(config:ProviderConfig,key?:string)=>Promise<ProviderConfig|undefined>;
 onRemoveProvider:(id:ProviderId)=>Promise<void>;
 onCreateProvider:()=>Promise<ProviderConfig|undefined>;
 onTestProvider:()=>void;
 onRefreshModels:()=>Promise<void>;
 refreshingModels:boolean;
 onExport:(format:'md'|'json')=>void;
 onExportPrepared:(format:'html'|'pdf')=>void;
 onExportZip:()=>void;
 onWipe:()=>void;
 onOpenDataFolder:()=>void;
 notice:string;
 onNotice:(text:string)=>void;
}

// Cloud providers have their endpoint pinned in the main process, so the field is
// read-only here; offering to edit it would only surface a rejection on save. Local
// presets (ollama/lmstudio/custom) stay editable because ports vary.
const PINNED_IDS=new Set<ProviderId>(['openai','anthropic','gemini','openrouter','groq','deepseek','mistral']);

function Field({label,hint,children}:{label:string;hint?:string;children:React.ReactNode}){return <label className="field"><span>{label}</span>{children}{hint&&<p className="field-hint">{hint}</p>}</label>}

// A boolean preference rendered as a switch row. Saves via onPref immediately —
// there is no "apply" button anywhere else in this modal either.
function ToggleRow({title,hint,checked,onChange}:{title:string;hint:string;checked:boolean;onChange:(v:boolean)=>void}){
 return <div className="toggle-row">
  <div><b>{title}</b><small>{hint}</small></div>
  <button role="switch" aria-checked={checked} aria-label={title} className={'switch '+(checked?'on':'')} onClick={()=>onChange(!checked)}><i/></button>
 </div>;
}

// Build a "Ctrl+Shift+K"-style combo from a key event. Returns null while only
// modifiers are held (the user is still composing the chord).
function comboFromEvent(e:React.KeyboardEvent):string|null{
 if(['Control','Shift','Alt','Meta'].includes(e.key))return null;
 const mods:string[]=[];
 if(e.ctrlKey||e.metaKey)mods.push('Ctrl');
 if(e.altKey)mods.push('Alt');
 if(e.shiftKey)mods.push('Shift');
 let key=e.key;
 if(key===' ')key='Space';
 key=key.length===1?key.toUpperCase():key.replace(/^Arrow/,'');
 return [...mods,key].join('+');
}

// Click the field, press the new chord, done. A chord without Ctrl or Alt would
// swallow normal typing, so it is rejected with a hint; Escape cancels. While
// listening, all keys are captured (stopPropagation) so the global Ctrl+K handler
// does not fire behind the modal and the field itself keeps the event.
function HotkeyField({label,value,onChange,onInvalid}:{label:string;value:string;onChange:(v:string)=>void;onInvalid:(msg:string)=>void}){
 const [listening,setListening]=useState(false);
 return <div className="hotkey-row">
  <span>{label}</span>
  <button className={'hotkey-capture '+(listening?'listening':'')} aria-label={'Change shortcut for '+label}
   onClick={()=>setListening(v=>!v)}
   onBlur={()=>setListening(false)}
   onKeyDown={e=>{
    if(!listening)return;
    e.preventDefault();e.stopPropagation();
    if(e.key==='Escape'){setListening(false);return;}
    const combo=comboFromEvent(e);
    if(!combo)return;
    if(!/^(Ctrl|Alt)/.test(combo)&&!combo.includes('+Ctrl')&&!combo.includes('+Alt')){onInvalid('A shortcut needs Ctrl or Alt');return;}
    onChange(combo);setListening(false);
   }}>
   {listening?'Press keys…':value}
  </button>
 </div>;
}

const HOTKEY_LABELS:Record<keyof HotkeyMap,string>={newChat:'New conversation',openSettings:'Open settings',toggleSidebar:'Toggle sidebar',quickChat:'Quick chat window'};

// Persona editor draft: ids are assigned on creation, the rest is plain fields.
// Kept local to the modal; saving writes the whole personas array via onPref.
const blankPersona=():Persona=>({id:crypto.randomUUID(),name:'',prompt:'',color:PERSONA_COLORS[0]});

const blankTemplate=():PromptTemplate=>({id:crypto.randomUUID(),name:'',text:''});

function TemplateEditor({template,onSave,onCancel}:{template:PromptTemplate;onSave:(t:PromptTemplate)=>void;onCancel:()=>void}){
 const [draft,setDraft]=useState<PromptTemplate>(template);
 return <div className="persona-editor">
  <Field label="Name"><input value={draft.name} onChange={e=>setDraft(d=>({...d,name:e.target.value}))} placeholder="Explain like I'm five" autoFocus/></Field>
  <Field label="Template text"><textarea rows={6} value={draft.text} onChange={e=>setDraft(d=>({...d,text:e.target.value}))} placeholder={'Explain simply:\n\n{{input}}'}/></Field>
  <p className="field-hint"><code>{'{{input}}'}</code> is replaced by whatever is currently typed in the composer.</p>
  <div className="settings-actions">
   <button className="secondary-button" onClick={onCancel}>Cancel</button>
   <button className="primary-button" disabled={!draft.name.trim()||!draft.text.trim()} onClick={()=>onSave({...draft,name:draft.name.trim()})}>Save template</button>
  </div>
 </div>;
}

// Daily token/cost bars for the Statistics tab — plain divs, no chart library.
function StatsView(){
 const [days,setDays]=useState<DayUsage[]|null>(null);
 useEffect(()=>{let alive=true;void window.lumen.chats.usageByDay().then(d=>{if(alive)setDays(d);}).catch(()=>{if(alive)setDays([]);});return()=>{alive=false;};},[]);
 if(days===null)return <p className="models-empty">Loading…</p>;
 if(!days.length)return <p className="models-empty">No usage yet — statistics appear after your first replies.</p>;
 const maxTokens=Math.max(...days.map(d=>d.promptTokens+d.completionTokens),1);
 const priced=days.some(d=>d.cost>0);
 return <>
  <div className="stats-bars">
   {days.slice(-30).map(d=>{
    const total=d.promptTokens+d.completionTokens;
    return <div className="stats-row" key={d.day} title={d.day+': ↑'+d.promptTokens.toLocaleString()+' ↓'+d.completionTokens.toLocaleString()+(d.cost?' · ≈'+formatCost(d.cost):'')}>
     <small>{d.day.slice(5)}</small>
     <div className="stats-bar"><i style={{width:Math.max(2,total/maxTokens*100)+'%'}}/></div>
     <span>{total>=1000?(total/1000).toFixed(1)+'k':total}{d.cost?' · '+formatCost(d.cost):''}</span>
    </div>;
   })}
  </div>
  {priced&&<p className="field-hint">Costs are estimates from the provider price lists.</p>}
 </>;
}

// One-row form to register an MCP server (name + stdio command). Validation of the
// final list happens in main (clampSettings); here we only require both fields.
function McpAddRow({servers,onAdd}:{servers:McpServer[];onAdd:(s:McpServer)=>void}){
 const [name,setName]=useState('');
 const [command,setCommand]=useState('');
 const full=servers.length>=5;
 return <div className="inline-row">
  <input value={name} onChange={e=>setName(e.target.value)} placeholder="Name (e.g. filesystem)" aria-label="MCP server name" maxLength={60} disabled={full}/>
  <input value={command} onChange={e=>setCommand(e.target.value)} placeholder="Command (e.g. npx -y @modelcontextprotocol/server-filesystem .)" aria-label="MCP server command" maxLength={300} disabled={full}/>
  <button className="secondary-button" disabled={full||!name.trim()||!command.trim()} onClick={()=>{onAdd({id:crypto.randomUUID(),name:name.trim(),command:command.trim()});setName('');setCommand('');}}><Plus size={14}/> Add</button>
 </div>;
}

function PersonaEditor({persona,providers,onSave,onCancel}:{persona:Persona;providers:ProviderConfig[];onSave:(p:Persona)=>void;onCancel:()=>void}){
 const [draft,setDraft]=useState<Persona>(persona);
 const set=<K extends keyof Persona>(k:K,v:Persona[K])=>setDraft(d=>({...d,[k]:v}));
 return <div className="persona-editor">
  <Field label="Name"><input value={draft.name} onChange={e=>set('name',e.target.value)} placeholder="Code reviewer" autoFocus/></Field>
  <Field label="Color"><div className="accent-options">{PERSONA_COLORS.map(c=>
   <button key={c} className={'accent-dot'+(draft.color===c?' chosen':'')} style={{background:c}} aria-label={'Color '+c} onClick={()=>set('color',c)}/>)}</div></Field>
  <Field label="System prompt"><textarea rows={5} value={draft.prompt} onChange={e=>set('prompt',e.target.value)} placeholder="You are a senior code reviewer. Focus on…"/></Field>
  <Field label={'Temperature override · '+(draft.temperature===undefined?'off':draft.temperature.toFixed(1))}>
   <div className="inline-row">
    <input type="range" min="0" max="2" step="0.1" value={draft.temperature??0.7} onChange={e=>set('temperature',Number(e.target.value))} disabled={draft.temperature===undefined}/>
    <button className="secondary-button" onClick={()=>set('temperature',draft.temperature===undefined?0.7:undefined)}>{draft.temperature===undefined?'Enable':'Use default'}</button>
   </div>
  </Field>
  <Field label="Provider override">
   <select value={draft.providerId??''} onChange={e=>{const v=e.target.value as ProviderId|'';setDraft(d=>({...d,providerId:v||undefined,model:v?d.model:undefined}));}}>
    <option value="">Keep current</option>
    {providers.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
   </select>
  </Field>
  {draft.providerId&&<Field label="Model override">
   <input value={draft.model??''} onChange={e=>set('model',e.target.value||undefined)} placeholder="Model ID (optional)" list="persona-models"/>
   <datalist id="persona-models">{(providers.find(p=>p.id===draft.providerId)?.models??[]).map(m=><option key={m} value={m}/>)}</datalist>
  </Field>}
  <div className="settings-actions">
   <button className="secondary-button" onClick={onCancel}>Cancel</button>
   <button className="primary-button" disabled={!draft.name.trim()||!draft.prompt.trim()} onClick={()=>onSave({...draft,name:draft.name.trim()})}>Save persona</button>
  </div>
 </div>;
}

export default function SettingsModal(props:Props){
 const {tab,onTab,providers,providerId,model,settings,hasActiveChat,onClose,onProviderSelect,onModel,onPref,onSaveProvider,onRemoveProvider,onCreateProvider,onTestProvider,onRefreshModels,refreshingModels,onExport,onExportPrepared,onExportZip,onWipe,onOpenDataFolder,notice,onNotice}=props;
 const [apiKey,setApiKey]=useState('');
 const [baseUrl,setBaseUrl]=useState('');
 const [providerName,setProviderName]=useState('');
 const [modelInput,setModelInput]=useState('');
 const [busy,setBusy]=useState(false);
 const [confirmWipe,setConfirmWipe]=useState(false);
 const [usage,setUsage]=useState<UsageSummary|null>(null);
 const [editingPersona,setEditingPersona]=useState<Persona|null>(null);
 const [editingTemplate,setEditingTemplate]=useState<PromptTemplate|null>(null);
 const provider=providers.find(p=>p.id===providerId);
 const pinned=PINNED_IDS.has(providerId);
 // Any custom endpoint (the legacy 'custom' or a generated 'custom-<hex>') is fully
 // editable: name, URL, key — and removable.
 const isCustom=isCustomProviderId(providerId);

 // Load lifetime token usage when the data tab is opened.
 useEffect(()=>{
  if(tab!=='data'){setUsage(null);return;}
  let alive=true;
  void window.lumen.chats.usageSummary().then(u=>{if(alive)setUsage(u);}).catch(()=>{});
  return()=>{alive=false;};
 },[tab]);

 // Escape closes the settings dialog from anywhere.
 useEffect(()=>{
  const onKey=(e:KeyboardEvent)=>{if(e.key==='Escape'){if(confirmWipe)setConfirmWipe(false);else onClose();}};
  window.addEventListener('keydown',onKey);
  return()=>window.removeEventListener('keydown',onKey);
 },[confirmWipe,onClose]);

 async function persist(config:ProviderConfig,key?:string){
  setBusy(true);
  try{const updated=await onSaveProvider(config,key);setApiKey('');return updated;}
  finally{setBusy(false);}
 }
 async function saveProvider(){
  if(!provider)return;
  const name=isCustom?(providerName.trim()||provider.name):provider.name;
  const updated=await persist({...provider,name,baseUrl:pinned?provider.baseUrl:(baseUrl||provider.baseUrl)},apiKey||undefined);
  if(updated){onNotice('Saved securely');if(updated.models[0])onModel(updated.models[0]);}
 }
 async function addProvider(){
  const created=await onCreateProvider();
  if(created){setApiKey('');setBaseUrl('');setProviderName('');onNotice('Custom provider added — set its URL and key below');}
 }
 async function addModels(){
  if(!provider)return;
  const values=modelInput.split(/[\n,]+/).map(x=>x.trim()).filter(Boolean);
  const models=Array.from(new Set([...provider.models,...values]));
  if(models.length===provider.models.length){setModelInput('');return;}
  const saved=await persist({...provider,models},apiKey||undefined);
  if(saved){setModelInput('');onModel(saved.models.at(-1)??'');onNotice('Model added');}
 }
 async function removeModel(value:string){
  if(!provider)return;
  const models=provider.models.filter(x=>x!==value);
  await persist({...provider,models});
  if(model===value)onModel(models[0]??'');
 }

 return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}>
 <section className="settings-modal" role="dialog" aria-modal="true" aria-label="Settings">
  <header><div><div className="eyebrow">PREFERENCES</div><h2>Settings</h2></div>
   <button onClick={onClose} aria-label="Close settings"><X size={17}/></button></header>
  <div className="settings-layout">
   <nav className="settings-nav">{(['providers','appearance','agents','stats','data'] as const).map(t=>
    <button key={t} className={tab===t?'active':''} onClick={()=>onTab(t)}>
     {t==='providers'?<Sparkles size={15}/>:t==='appearance'?<Sun size={15}/>:t==='agents'?<Bot size={15}/>:t==='stats'?<BarChart3 size={15}/>:<Archive size={15}/>}
     <span>{t==='providers'?'Providers':t==='appearance'?'Appearance':t==='agents'?'Personas':t==='stats'?'Statistics':'Data & privacy'}</span>
    </button>)}</nav>
   <div className="settings-page">
    {tab==='providers'?<>
     <h3>AI providers</h3>
     <p>Connect an API key to chat with your models. Keys are encrypted with Windows DPAPI. Local servers (Ollama, LM Studio) may use http://localhost and need no key.</p>
     <div className="provider-grid">{providers.map(p=>
      <button key={p.id} className={'provider-option '+(providerId===p.id?'chosen':'')}
       onClick={()=>{onProviderSelect(p.id);setBaseUrl(p.baseUrl);setProviderName(p.name);if(p.models[0])onModel(p.models[0]);}}>
       <span style={{color:providerColors[p.id]??providerColors.custom}}>{p.name[0]}</span>{p.name}
       {p.hasKey&&<i className="key-dot" title="API key saved">●</i>}
       {providerId===p.id&&<Check size={13}/>}
      </button>)}
      <button className="provider-option provider-add" onClick={()=>void addProvider()} title="Add a custom OpenAI-compatible endpoint">+ Add provider</button>
     </div>
     {isCustom&&<><h3>Custom provider</h3>
      <Field label="Provider name"><input value={providerName||provider?.name||''} onChange={e=>setProviderName(e.target.value)} placeholder="My provider"/></Field></>}
     <Field label={'API key'+(provider?.hasKey?' (saved)':'')}>
      <input type="password" value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder={provider?.hasKey?'Leave blank to keep the current key':'Paste your API key'} autoComplete="off"/>
     </Field>
     <Field label="Base URL">
      {pinned
       ?<div className="readonly-url" title="The endpoint of a built-in provider is fixed">
         <span>{provider?.baseUrl}</span>
         <button type="button" className="link-button" onClick={()=>{onProviderSelect('custom');setBaseUrl('');setProviderName('');}}>Use a custom endpoint instead</button>
        </div>
       :<input value={baseUrl||provider?.baseUrl||''} onChange={e=>setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1 or http://127.0.0.1:11434/v1"/>}
     </Field>
     <div className="settings-actions">
      <button className="secondary-button" onClick={onTestProvider}>Test connection</button>
      <button className="secondary-button" disabled={refreshingModels} onClick={()=>void onRefreshModels()}>{refreshingModels?'Loading…':'Refresh models'}</button>
      <button className="primary-button" disabled={busy} onClick={()=>void saveProvider()}>{isCustom?'Save custom provider':'Save provider'}</button>
      {isCustom&&provider&&<button className="danger-button" disabled={busy} onClick={()=>{void onRemoveProvider(providerId);onProviderSelect('openai');onNotice('Custom provider removed');}}>Remove</button>}
     </div>
     <div className="models-heading"><div><h3>Available models</h3><p>Manually add model IDs or refresh from the provider API.</p></div></div>
     <div className="model-list">{(provider?.models??[]).map(item=>
      <div className="model-row" key={item}><span>{item}</span>
       <button title={'Remove '+item} aria-label={'Remove '+item} onClick={()=>void removeModel(item)}><X size={13}/></button></div>)}
      {!provider?.models.length&&<div className="models-empty">No models yet. Add a model ID below.</div>}
     </div>
     <div className="model-add">
      <input value={modelInput} onChange={e=>setModelInput(e.target.value)}
       onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();void addModels();}}}
       placeholder="Model ID (e.g. my-model-v1)" aria-label="Model ID"/>
      <button className="primary-button" onClick={()=>void addModels()}>Add model</button>
     </div>
    </>:tab==='appearance'?<>
     <h3>Appearance</h3><p>Make Lumen feel at home on your desktop.</p>
     <div className="theme-options">
      <button className={settings.theme==='dark'?'chosen':''} onClick={()=>void onPref('theme','dark')}><Moon size={18}/><b>Dark</b><small>Easy on the eyes</small></button>
      <button className={settings.theme==='light'?'chosen':''} onClick={()=>void onPref('theme','light')}><Sun size={18}/><b>Light</b><small>Bright and clear</small></button>
     </div>
     <Field label="Accent color"><div className="accent-options">{ACCENTS.map(a=>
      <button key={a} className={'accent-dot accent-'+a+(settings.accent===a?' chosen':'')} aria-label={a+' accent'} title={a} onClick={()=>void onPref('accent',a as Accent)}/>)}</div></Field>
     <Field label="Theme preset"><div className="preset-options">{THEME_PRESETS.map(p=>
      <button key={p} className={'preset-swatch preset-'+p+(settings.themePreset===p?' chosen':'')} onClick={()=>void onPref('themePreset',p)} aria-label={p+' theme preset'}><i/><b>{p[0].toUpperCase()+p.slice(1)}</b></button>)}</div></Field>
     <Field label={'Temperature · '+settings.temperature.toFixed(1)}><input type="range" min="0" max="2" step="0.1" value={settings.temperature} onChange={e=>void onPref('temperature',Number(e.target.value))}/></Field>
     <Field label="Max response tokens"><input type="number" min="128" max="32000" value={settings.maxTokens} onChange={e=>void onPref('maxTokens',Number(e.target.value))}/></Field>
     <Field label="Top P"><input type="number" min="0" max="1" step="0.05" value={settings.topP} onChange={e=>void onPref('topP',Number(e.target.value))}/></Field>
     <Field label="Reasoning effort" hint="Thinking budget for reasoning models: OpenAI o-series/gpt-5, Claude 3.7+/4+, Gemini 2.5+, reasoning models via OpenRouter. 'Provider default' changes nothing.">
      <div className="density-picker">{REASONING_EFFORTS.map(eff=>
       <button key={eff} className={settings.reasoningEffort===eff?'active':''} onClick={()=>void onPref('reasoningEffort',eff)} aria-pressed={settings.reasoningEffort===eff}>{eff==='off'?'Provider default':eff[0].toUpperCase()+eff.slice(1)}</button>)}
      </div>
     </Field>
     <Field label="System prompt"><textarea rows={4} value={settings.systemPrompt} onChange={e=>void onPref('systemPrompt',e.target.value)}/></Field>
     <Field label="Density" hint="How much air the interface has — compact fits more text on screen.">
      <div className="density-picker">{DENSITIES.map(d=>
       <button key={d} className={settings.density===d?'active':''} onClick={()=>void onPref('density',d)} aria-pressed={settings.density===d}>{d[0].toUpperCase()+d.slice(1)}</button>)}
      </div>
     </Field>
     <Field label="Default workspace folder">
      <div className="inline-row">
       <input value={settings.defaultWorkspace} readOnly placeholder="None — attach per chat from the toolbar" aria-label="Default workspace folder"/>
       <button className="secondary-button" onClick={()=>{void window.lumen.app.pickFolder('Choose the default workspace folder').then(p=>{if(p)void onPref('defaultWorkspace',p);});}}>Browse…</button>
       {settings.defaultWorkspace&&<button className="secondary-button" onClick={()=>void onPref('defaultWorkspace','')}>Clear</button>}
      </div>
      <p className="field-hint">Chats without their own workspace use this folder for file tools. Writes still ask for approval.</p>
     </Field>
     <Field label="Custom CSS">
      <div className="inline-row">
       <input value={settings.customCss?settings.customCss.length+' characters loaded':''} readOnly placeholder="No custom styles" aria-label="Custom CSS status"/>
       <button className="secondary-button" onClick={()=>{
        const input=document.createElement('input');input.type='file';input.accept='.css,text/css';
        input.onchange=()=>{const f=input.files?.[0];if(!f)return;if(f.size>100*1024){onNotice('CSS file is too large (max 100 KB)');return;}void f.text().then(t=>{void onPref('customCss',t);onNotice('Custom theme applied');});};
        input.click();
       }}>Load .css…</button>
       {settings.customCss&&<button className="secondary-button" onClick={()=>void onPref('customCss','')}>Remove</button>}
      </div>
      <p className="field-hint">A .css file injected into the app window — restyle anything. It cannot access your data.</p>
     </Field>
     <h3><Monitor size={14}/> System</h3>
     <ToggleRow title="Keep running in the tray" hint="Closing the window hides it; quit from the tray icon." checked={settings.minimizeToTray} onChange={v=>void onPref('minimizeToTray',v)}/>
     <ToggleRow title="Launch at sign-in" hint="Start Lumen automatically when you log into Windows." checked={settings.autoStart} onChange={v=>void onPref('autoStart',v)}/>
     <ToggleRow title="Desktop notifications" hint="Notify when a response finishes while the window is unfocused or hidden." checked={settings.notifications} onChange={v=>void onPref('notifications',v)}/>
     <h3><Keyboard size={14}/> Keyboard shortcuts</h3>
     <p>Click a shortcut and press a new chord. It must include Ctrl or Alt.</p>
     {(Object.keys(HOTKEY_LABELS) as Array<keyof HotkeyMap>).map(k=>
      <HotkeyField key={k} label={HOTKEY_LABELS[k]} value={settings.hotkeys[k]}
       onChange={v=>void onPref('hotkeys',{...settings.hotkeys,[k]:v})} onInvalid={onNotice}/>)}
    </>:tab==='agents'?<>
     <h3>Personas</h3><p>Named presets — a system prompt with optional temperature, provider and model overrides. Pick one in the composer; it applies to new messages.</p>
     {editingPersona
      ?<PersonaEditor persona={editingPersona} providers={providers} onCancel={()=>setEditingPersona(null)}
        onSave={p=>{
         const list=settings.personas.filter(x=>x.id!==p.id);
         void onPref('personas',[...list,p]);setEditingPersona(null);onNotice('Persona saved');
        }}/>
      :<>
       <div className="model-list">
        {settings.personas.map(p=><div className="persona-row" key={p.id}>
         <span className="provider-dot" style={{background:p.color}} aria-hidden="true"/>
         <span className="persona-name">{p.name}</span>
         {settings.personaId===p.id&&<small className="persona-active">active</small>}
         <button title={'Edit '+p.name} aria-label={'Edit '+p.name} onClick={()=>setEditingPersona(p)}><Pencil size={13}/></button>
         <button title={'Delete '+p.name} aria-label={'Delete '+p.name} onClick={()=>{
          void onPref('personas',settings.personas.filter(x=>x.id!==p.id));
          if(settings.personaId===p.id)void onPref('personaId','');
         }}><Trash2 size={13}/></button>
        </div>)}
        {!settings.personas.length&&<div className="models-empty">No personas yet. Create one to reuse a prompt in one click.</div>}
       </div>
       <div className="settings-actions">
        <button className="primary-button" onClick={()=>setEditingPersona(blankPersona())}><Plus size={14}/> New persona</button>
       </div>
      </>}
     <h3><LayoutTemplate size={14}/> Prompt templates</h3>
     <p>Reusable prompts; {'{{input}}'} is replaced by your current draft. Pick one from the composer's template button or with /template N.</p>
     {editingTemplate
      ?<TemplateEditor template={editingTemplate} onCancel={()=>setEditingTemplate(null)}
        onSave={t=>{
         const list=settings.templates.filter(x=>x.id!==t.id);
         void onPref('templates',[...list,t]);setEditingTemplate(null);onNotice('Template saved');
        }}/>
      :<>
       <div className="model-list">
        {settings.templates.map(t=><div className="persona-row" key={t.id}>
         <LayoutTemplate size={13}/>
         <span className="persona-name">{t.name}</span>
         <small className="persona-active">{t.text.slice(0,40)}{t.text.length>40?'…':''}</small>
         <button title={'Edit '+t.name} aria-label={'Edit '+t.name} onClick={()=>setEditingTemplate(t)}><Pencil size={13}/></button>
         <button title={'Delete '+t.name} aria-label={'Delete '+t.name} onClick={()=>void onPref('templates',settings.templates.filter(x=>x.id!==t.id))}><Trash2 size={13}/></button>
        </div>)}
        {!settings.templates.length&&<div className="models-empty">No templates yet. Create one to reuse a prompt in one click.</div>}
       </div>
       <div className="settings-actions">
        <button className="primary-button" onClick={()=>setEditingTemplate(blankTemplate())}><Plus size={14}/> New template</button>
       </div>
      </>}
      <h3><Server size={14}/> MCP servers</h3>
      <p>External tool servers (Model Context Protocol) launched over stdio — e.g. <code>npx -y @modelcontextprotocol/server-filesystem C:\projects</code>. Their tools become available to every model (shown as mcp:… cards). Max 5.</p>
      <div className="model-list">
       {settings.mcpServers.map(s=><div className="persona-row" key={s.id}>
        <Server size={13}/>
        <span className="persona-name">{s.name}</span>
        <small className="persona-active">{s.command}</small>
        <button title={'Remove '+s.name} aria-label={'Remove '+s.name} onClick={()=>void onPref('mcpServers',settings.mcpServers.filter(x=>x.id!==s.id))}><Trash2 size={13}/></button>
       </div>)}
       {!settings.mcpServers.length&&<div className="models-empty">No MCP servers configured.</div>}
      </div>
      <McpAddRow servers={settings.mcpServers} onAdd={s=>{void onPref('mcpServers',[...settings.mcpServers,s]);onNotice('MCP server added — its tools are available from the next message');}}/>
    </>:tab==='stats'?<>
     <h3>Statistics</h3><p>Token usage per day across all providers (assistant replies).</p>
     <StatsView/>
    </>:<>
     <h3>Data & privacy</h3><p>Your conversations and preferences stay on this device.</p>
     <div className="privacy-row"><Shield size={17}/><div><b>Local-first storage</b><small>Chat history stored in local SQLite.</small></div><Check size={14}/></div>
     <div className="privacy-row"><Shield size={17}/><div><b>Encrypted API keys</b><small>Protected by Windows secure storage (DPAPI).</small></div><Check size={14}/></div>
     {usage&&<div className="usage-summary">
      <h4>Lifetime usage</h4>
      {(()=>{
       // $ estimates come from each provider's pricing map; rows without a known
       // price simply don't contribute to the total.
       const costOf=(r:UsageRow)=>messageCost(providers,r.providerId,r.model,r.promptTokens,r.completionTokens);
       const total=usage.byModel.reduce((sum,r)=>sum+(costOf(r)??0),0);
       const priced=usage.byModel.some(r=>costOf(r)!==null);
       return <>
        <div className="usage-stats">
         <div><b>{usage.messages.toLocaleString()}</b><small>replies</small></div>
         <div><b>{usage.promptTokens.toLocaleString()}</b><small>prompt tokens</small></div>
         <div><b>{usage.completionTokens.toLocaleString()}</b><small>completion tokens</small></div>
         {priced&&<div><b>{formatCost(total)}</b><small>estimated cost</small></div>}
        </div>
        {usage.byModel.length>0&&<div className="usage-by-model">{usage.byModel.slice(0,8).map((r,i)=>{
         const c=costOf(r);
         return <div className="usage-model-row" key={i}><span>{r.model??'—'} <i>{r.providerId??''}</i></span>
          <small>{r.completionTokens.toLocaleString()} ↓{c!==null?' · ≈'+formatCost(c):''}</small></div>;
        })}</div>}
       </>;
      })()}
     </div>}
     {hasActiveChat&&<div className="settings-actions">
      <button className="secondary-button" onClick={()=>onExport('md')}>Export Markdown</button>
      <button className="secondary-button" onClick={()=>onExport('json')}>Export JSON</button>
      <button className="secondary-button" onClick={()=>onExportPrepared('html')}><FileDown size={14}/> Export HTML</button>
      <button className="secondary-button" onClick={()=>onExportPrepared('pdf')}><FileDown size={14}/> Export PDF</button>
      <button className="secondary-button" onClick={onExportZip}><Archive size={14}/> Export zip (md+json+files)</button>
      <button className="secondary-button" onClick={onOpenDataFolder}><FolderOpen size={14}/> Open data folder</button>
     </div>}
     <h3><RotateCcw size={14}/> Updates</h3>
     <p>Updates download automatically in the installed app. A private GitHub repo requires a GH_TOKEN environment variable for the check.</p>
     <div className="settings-actions">
      <button className="secondary-button" onClick={()=>{void window.lumen.updates.check().then(onNotice);}}>Check for updates</button>
      <button className="secondary-button" onClick={()=>window.lumen.updates.install()}>Restart &amp; install</button>
     </div>
     <h3><Save size={14}/> Backup</h3>
     <p>Back up the whole database and attachments, or restore from an earlier backup file. Restoring restarts the app.</p>
     <div className="settings-actions">
      <button className="secondary-button" onClick={()=>{void window.lumen.data.backup().then(p=>onNotice(p?'Backup saved to '+p:'Backup cancelled')).catch(e=>onNotice(e instanceof Error?e.message:'Backup failed'));}}><Save size={14}/> Back up now…</button>
      <button className="secondary-button" onClick={()=>{void window.lumen.data.restore().catch(e=>onNotice(e instanceof Error?e.message:'Restore failed'));}}><RotateCcw size={14}/> Restore from backup…</button>
     </div>
     {confirmWipe
      ?<div className="confirm-inline" role="alertdialog" aria-label="Confirm deleting all data">
        <p>This permanently deletes every conversation, message and setting on this device. Encrypted API keys are kept. This cannot be undone.</p>
        <div className="settings-actions">
         <button className="secondary-button" onClick={()=>setConfirmWipe(false)}>Cancel</button>
         <button className="danger-button" onClick={()=>{setConfirmWipe(false);onWipe();onClose();}}><Trash2 size={14}/> Delete everything</button>
        </div>
       </div>
      :<button className="danger-button block" onClick={()=>setConfirmWipe(true)}><Trash2 size={14}/> Erase all conversations</button>}
    </>}
    {/* Outside the tab ternary on purpose: App suppresses the global toast while this
        modal is open, so a notice rendered only in the providers arm meant Export,
        wipe and preference failures on the other two tabs produced no feedback at all. */}
    {notice&&<div className="notice" role="status">{notice}</div>}
   </div>
  </div>
 </section>
 </div>;
}
