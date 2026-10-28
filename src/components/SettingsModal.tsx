import {useEffect,useState} from 'react';
import {Archive,BarChart3,Bot,Check,FileDown,FolderOpen,Keyboard,LayoutTemplate,Moon,Monitor,Pencil,Plus,RotateCcw,Save,Server,Shield,Sparkles,Sun,Trash2,X} from 'lucide-react';
import type {Accent,DayUsage,HotkeyMap,McpServer,Persona,PromptTemplate,ProviderConfig,ProviderId,UsageRow,UsageSummary} from '../../electron/shared';
import type {BuiltinProviderId} from '../../electron/shared';
import {PROVIDER_LOGOS} from './providerLogos';
import {ACCENTS,DENSITIES,isCustomProviderId,PERSONA_COLORS,REASONING_EFFORTS,THEME_PRESETS} from '../../electron/shared';
import type {Prefs} from '../store';
import {providerColors} from '../store';
import {formatCost,messageCost} from '../cost';
import {useT} from '../i18n';
import {isMobile} from '../platform/detect';

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

// Built-in providers show their brand glyph; custom endpoints keep the letter tile.
function ProviderIcon({id,name}:{id:ProviderId;name:string}){
 const logo=PROVIDER_LOGOS[id as BuiltinProviderId];
 const color=providerColors[id]??providerColors.custom;
 if(logo)return <svg className="provider-logo" viewBox={logo.viewBox} aria-hidden="true"><path d={logo.path} fill={color}/></svg>;
 return <span style={{color}}>{name[0]}</span>;
}

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
 const t=useT();
 return <div className="hotkey-row">
  <span>{label}</span>
  <button className={'hotkey-capture '+(listening?'listening':'')} aria-label={t('settings.changeShortcutAria',{label})}
   onClick={()=>setListening(v=>!v)}
   onBlur={()=>setListening(false)}
   onKeyDown={e=>{
    if(!listening)return;
    e.preventDefault();e.stopPropagation();
    if(e.key==='Escape'){setListening(false);return;}
    const combo=comboFromEvent(e);
    if(!combo)return;
    if(!/^(Ctrl|Alt)/.test(combo)&&!combo.includes('+Ctrl')&&!combo.includes('+Alt')){onInvalid(t('settings.hotkeyInvalid'));return;}
    onChange(combo);setListening(false);
   }}>
   {listening?t('settings.pressKeys'):value}
  </button>
 </div>;
}

const HOTKEY_LABELS:Record<keyof HotkeyMap,string>={newChat:'settings.hotkeyNewChat',openSettings:'settings.hotkeyOpenSettings',toggleSidebar:'settings.hotkeyToggleSidebar',quickChat:'settings.hotkeyQuickChat'};

// Persona editor draft: ids are assigned on creation, the rest is plain fields.
// Kept local to the modal; saving writes the whole personas array via onPref.
const blankPersona=():Persona=>({id:crypto.randomUUID(),name:'',prompt:'',color:PERSONA_COLORS[0]});

const blankTemplate=():PromptTemplate=>({id:crypto.randomUUID(),name:'',text:''});

function TemplateEditor({template,onSave,onCancel}:{template:PromptTemplate;onSave:(t:PromptTemplate)=>void;onCancel:()=>void}){
 const [draft,setDraft]=useState<PromptTemplate>(template);
 const t=useT();
 return <div className="persona-editor">
  <Field label={t('settings.name')}><input value={draft.name} onChange={e=>setDraft(d=>({...d,name:e.target.value}))} placeholder={t('settings.templateNamePh')} autoFocus/></Field>
  <Field label={t('settings.templateText')}><textarea rows={6} value={draft.text} onChange={e=>setDraft(d=>({...d,text:e.target.value}))} placeholder={t('settings.templateTextPh')}/></Field>
  <p className="field-hint"><code>{'{{input}}'}</code> {t('settings.templateHint')}</p>
  <div className="settings-actions">
   <button className="secondary-button" onClick={onCancel}>{t('settings.cancel')}</button>
   <button className="primary-button" disabled={!draft.name.trim()||!draft.text.trim()} onClick={()=>onSave({...draft,name:draft.name.trim()})}>{t('settings.saveTemplate')}</button>
  </div>
 </div>;
}

// Daily token/cost bars for the Statistics tab — plain divs, no chart library.
function StatsView(){
 const [days,setDays]=useState<DayUsage[]|null>(null);
 const t=useT();
 useEffect(()=>{let alive=true;void window.lumen.chats.usageByDay().then(d=>{if(alive)setDays(d);}).catch(()=>{if(alive)setDays([]);});return()=>{alive=false;};},[]);
 if(days===null)return <p className="models-empty">{t('settings.loading')}</p>;
 if(!days.length)return <p className="models-empty">{t('settings.noUsage')}</p>;
 const maxTokens=Math.max(...days.map(d=>d.promptTokens+d.completionTokens),1);
 const priced=days.some(d=>d.cost>0);
 // Activity heatmap (GitHub-style): last 18 weeks, columns = weeks starting Monday,
 // intensity = total tokens that day. Future days render as empty placeholders.
 const HEAT_WEEKS=18;
 const byDay=new Map(days.map(d=>[d.day,d.promptTokens+d.completionTokens]));
 const end=new Date();end.setHours(0,0,0,0);
 const first=new Date(end);first.setDate(first.getDate()-((end.getDay()+6)%7)-7*(HEAT_WEEKS-1));
 const weeks:Array<Array<{key:string;total:number}>>=[];
 const cursor=new Date(first);
 for(let w=0;w<HEAT_WEEKS;w++){
  const week:Array<{key:string;total:number}>=[];
  for(let d=0;d<7;d++){
   const key=cursor.getFullYear()+'-'+String(cursor.getMonth()+1).padStart(2,'0')+'-'+String(cursor.getDate()).padStart(2,'0');
   week.push({key,total:cursor<=end?(byDay.get(key)??0):-1});
   cursor.setDate(cursor.getDate()+1);
  }
  weeks.push(week);
 }
 return <>
  <p className="field-hint">{t('settings.statsHeatmap')}</p>
  <div className="heatmap">
   {weeks.map((week,wi)=><div className="hm-week" key={wi}>
    {week.map(c=>c.total<0
     ?<i key={c.key} className="hm-cell future"/>
     :<i key={c.key} className="hm-cell" data-l={c.total?Math.min(4,Math.ceil(c.total/maxTokens*4)):0}
       title={c.key+': '+c.total.toLocaleString()+t('messages.tokens')}/>)}
   </div>)}
  </div>
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
  {priced&&<p className="field-hint">{t('settings.costEstimateHint')}</p>}
 </>;
}

// One-row form to register an MCP server (name + stdio command). Validation of the
// final list happens in main (clampSettings); here we only require both fields.
function McpAddRow({servers,onAdd}:{servers:McpServer[];onAdd:(s:McpServer)=>void}){
 const [name,setName]=useState('');
 const [command,setCommand]=useState('');
 const t=useT();
 const full=servers.length>=5;
 return <div className="inline-row">
  <input value={name} onChange={e=>setName(e.target.value)} placeholder={t('settings.mcpNamePh')} aria-label={t('settings.mcpNameAria')} maxLength={60} disabled={full}/>
  <input value={command} onChange={e=>setCommand(e.target.value)} placeholder={t('settings.mcpCommandPh')} aria-label={t('settings.mcpCommandAria')} maxLength={300} disabled={full}/>
  <button className="secondary-button" disabled={full||!name.trim()||!command.trim()} onClick={()=>{onAdd({id:crypto.randomUUID(),name:name.trim(),command:command.trim()});setName('');setCommand('');}}><Plus size={14}/> {t('settings.add')}</button>
 </div>;
}

function PersonaEditor({persona,providers,onSave,onCancel}:{persona:Persona;providers:ProviderConfig[];onSave:(p:Persona)=>void;onCancel:()=>void}){
 const [draft,setDraft]=useState<Persona>(persona);
 const t=useT();
 const set=<K extends keyof Persona>(k:K,v:Persona[K])=>setDraft(d=>({...d,[k]:v}));
 return <div className="persona-editor">
  <Field label={t('settings.name')}><input value={draft.name} onChange={e=>set('name',e.target.value)} placeholder={t('settings.personaNamePh')} autoFocus/></Field>
  <Field label={t('settings.color')}><div className="accent-options">{PERSONA_COLORS.map(c=>
   <button key={c} className={'accent-dot'+(draft.color===c?' chosen':'')} style={{background:c}} aria-label={t('settings.colorAria',{name:c})} onClick={()=>set('color',c)}/>)}</div></Field>
  <Field label={t('settings.systemPrompt')}><textarea rows={5} value={draft.prompt} onChange={e=>set('prompt',e.target.value)} placeholder={t('settings.personaPromptPh')}/></Field>
  <Field label={t('settings.temperatureOverride',{value:draft.temperature===undefined?t('settings.tempOff'):draft.temperature.toFixed(1)})}>
   <div className="inline-row">
    <input type="range" min="0" max="2" step="0.1" value={draft.temperature??0.7} onChange={e=>set('temperature',Number(e.target.value))} disabled={draft.temperature===undefined}/>
    <button className="secondary-button" onClick={()=>set('temperature',draft.temperature===undefined?0.7:undefined)}>{draft.temperature===undefined?t('settings.enable'):t('settings.useDefault')}</button>
   </div>
  </Field>
  <Field label={t('settings.providerOverride')}>
   <select value={draft.providerId??''} onChange={e=>{const v=e.target.value as ProviderId|'';setDraft(d=>({...d,providerId:v||undefined,model:v?d.model:undefined}));}}>
    <option value="">{t('settings.keepCurrent')}</option>
    {providers.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
   </select>
  </Field>
  {draft.providerId&&<Field label={t('settings.modelOverride')}>
   <input value={draft.model??''} onChange={e=>set('model',e.target.value||undefined)} placeholder={t('settings.modelIdOptionalPh')} list="persona-models"/>
   <datalist id="persona-models">{(providers.find(p=>p.id===draft.providerId)?.models??[]).map(m=><option key={m} value={m}/>)}</datalist>
  </Field>}
  <div className="settings-actions">
   <button className="secondary-button" onClick={onCancel}>{t('settings.cancel')}</button>
   <button className="primary-button" disabled={!draft.name.trim()||!draft.prompt.trim()} onClick={()=>onSave({...draft,name:draft.name.trim()})}>{t('settings.savePersona')}</button>
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
 const t=useT();
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
  if(updated){onNotice(t('settings.savedSecurely'));if(updated.models[0])onModel(updated.models[0]);}
 }
 async function addProvider(){
  const created=await onCreateProvider();
  if(created){setApiKey('');setBaseUrl('');setProviderName('');onNotice(t('settings.customProviderAdded'));}
 }
 async function addModels(){
  if(!provider)return;
  const values=modelInput.split(/[\n,]+/).map(x=>x.trim()).filter(Boolean);
  const models=Array.from(new Set([...provider.models,...values]));
  if(models.length===provider.models.length){setModelInput('');return;}
  const saved=await persist({...provider,models},apiKey||undefined);
  if(saved){setModelInput('');onModel(saved.models.at(-1)??'');onNotice(t('settings.modelAdded'));}
 }
 async function removeModel(value:string){
  if(!provider)return;
  const models=provider.models.filter(x=>x!==value);
  await persist({...provider,models});
  if(model===value)onModel(models[0]??'');
 }

 return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}>
 <section className="settings-modal" role="dialog" aria-modal="true" aria-label={t('settings.dialogAria')}>
  <header><div><div className="eyebrow">{t('settings.eyebrow')}</div><h2>{t('settings.title')}</h2></div>
   <button onClick={onClose} aria-label={t('settings.closeAria')}><X size={17}/></button></header>
  <div className="settings-layout">
   <nav className="settings-nav">{(['providers','appearance','agents','stats','data'] as const).map(tabId=>
    <button key={tabId} className={tab===tabId?'active':''} onClick={()=>onTab(tabId)}>
     {tabId==='providers'?<Sparkles size={15}/>:tabId==='appearance'?<Sun size={15}/>:tabId==='agents'?<Bot size={15}/>:tabId==='stats'?<BarChart3 size={15}/>:<Archive size={15}/>}
     <span>{tabId==='providers'?t('settings.tabProviders'):tabId==='appearance'?t('settings.tabAppearance'):tabId==='agents'?t('settings.tabAgents'):tabId==='stats'?t('settings.tabStats'):t('settings.tabData')}</span>
    </button>)}</nav>
   <div className="settings-page">
    {tab==='providers'?<>
     <h3>{t('settings.providersTitle')}</h3>
     <p>{t(isMobile?'settings.providersIntroMobile':'settings.providersIntro')}</p>
     <div className="provider-grid">{providers.map(p=>
      <button key={p.id} className={'provider-option '+(providerId===p.id?'chosen':'')}
       onClick={()=>{onProviderSelect(p.id);setBaseUrl(p.baseUrl);setProviderName(p.name);if(p.models[0])onModel(p.models[0]);}}>
       <ProviderIcon id={p.id} name={p.name}/>{p.name}
       {p.hasKey&&<i className="key-dot" title={t('settings.apiKeySaved')}>●</i>}
       {providerId===p.id&&<Check size={13}/>}
      </button>)}
      <button className="provider-option provider-add" onClick={()=>void addProvider()} title={t('settings.addProviderTitle')}>{t('settings.addProvider')}</button>
     </div>
     {isCustom&&<><h3>{t('settings.customProviderTitle')}</h3>
      <Field label={t('settings.providerName')}><input value={providerName||provider?.name||''} onChange={e=>setProviderName(e.target.value)} placeholder={t('settings.providerNamePh')}/></Field></>}
     <Field label={t('settings.apiKey')+(provider?.hasKey?t('settings.apiKeySavedSuffix'):'')}>
      <input type="password" value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder={provider?.hasKey?t('settings.apiKeyKeepPh'):t('settings.apiKeyPastePh')} autoComplete="off"/>
     </Field>
     <Field label={t('settings.baseUrl')}>
      {pinned
       ?<div className="readonly-url" title={t('settings.baseUrlFixedTitle')}>
         <span>{provider?.baseUrl}</span>
         <button type="button" className="link-button" onClick={()=>{onProviderSelect('custom');setBaseUrl('');setProviderName('');}}>{t('settings.useCustomEndpoint')}</button>
        </div>
       :<input value={baseUrl||provider?.baseUrl||''} onChange={e=>setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1 or http://127.0.0.1:11434/v1"/>}
     </Field>
     <div className="settings-actions">
      <button className="secondary-button" onClick={onTestProvider}>{t('settings.testConnection')}</button>
      <button className="secondary-button" disabled={refreshingModels} onClick={()=>void onRefreshModels()}>{refreshingModels?t('settings.loading'):t('settings.refreshModels')}</button>
      <button className="primary-button" disabled={busy} onClick={()=>void saveProvider()}>{isCustom?t('settings.saveCustomProvider'):t('settings.saveProvider')}</button>
      {isCustom&&provider&&<button className="danger-button" disabled={busy} onClick={()=>{void onRemoveProvider(providerId);onProviderSelect('openai');onNotice(t('settings.customProviderRemoved'));}}>{t('settings.remove')}</button>}
     </div>
     <div className="models-heading"><div><h3>{t('settings.availableModels')}</h3><p>{t('settings.modelsIntro')}</p></div></div>
     <div className="model-list">{(provider?.models??[]).map(item=>
      <div className="model-row" key={item}><span>{item}</span>
       <button title={t('settings.removeName',{name:item})} aria-label={t('settings.removeName',{name:item})} onClick={()=>void removeModel(item)}><X size={13}/></button></div>)}
      {!provider?.models.length&&<div className="models-empty">{t('settings.noModels')}</div>}
     </div>
     <div className="model-add">
      <input value={modelInput} onChange={e=>setModelInput(e.target.value)}
       onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();void addModels();}}}
       placeholder={t('settings.modelIdPh')} aria-label={t('settings.modelIdAria')}/>
      <button className="primary-button" onClick={()=>void addModels()}>{t('settings.addModel')}</button>
     </div>
    </>:tab==='appearance'?<>
     <h3>{t('settings.appearanceTitle')}</h3><p>{t('settings.appearanceIntro')}</p>
     <div className="theme-options">
      <button className={settings.theme==='dark'?'chosen':''} onClick={()=>void onPref('theme','dark')}><Moon size={18}/><b>{t('settings.themeDark')}</b><small>{t('settings.themeDarkHint')}</small></button>
      <button className={settings.theme==='light'?'chosen':''} onClick={()=>void onPref('theme','light')}><Sun size={18}/><b>{t('settings.themeLight')}</b><small>{t('settings.themeLightHint')}</small></button>
     </div>
     <Field label={t('settings.accentColor')}><div className="accent-options">{ACCENTS.map(a=>
      <button key={a} className={'accent-dot accent-'+a+(settings.accent===a?' chosen':'')} aria-label={t('settings.accentAria',{name:a})} title={a} onClick={()=>void onPref('accent',a as Accent)}/>)}</div></Field>
     <Field label={t('settings.themePreset')}><div className="preset-options">{THEME_PRESETS.map(p=>
      <button key={p} className={'preset-swatch preset-'+p+(settings.themePreset===p?' chosen':'')} onClick={()=>void onPref('themePreset',p)} aria-label={t('settings.themePresetAria',{name:p})}><i/><b>{p[0].toUpperCase()+p.slice(1)}</b></button>)}</div></Field>
     <Field label={t('settings.language')}>
      <select value={settings.language} onChange={e=>void onPref('language',e.target.value as Prefs['language'])}>
       <option value="en">English</option>
       <option value="ru">Русский</option>
      </select>
     </Field>
     <Field label={t('settings.temperature',{value:settings.temperature.toFixed(1)})}><input type="range" min="0" max="2" step="0.1" value={settings.temperature} onChange={e=>void onPref('temperature',Number(e.target.value))}/></Field>
     <Field label={t('settings.maxTokens')}><input type="number" min="128" max="32000" value={settings.maxTokens} onChange={e=>void onPref('maxTokens',Number(e.target.value))}/></Field>
     <Field label={t('settings.topP')}><input type="number" min="0" max="1" step="0.05" value={settings.topP} onChange={e=>void onPref('topP',Number(e.target.value))}/></Field>
     <Field label={t('settings.reasoningEffort')} hint={t('settings.reasoningEffortHint')}>
      <div className="density-picker">{REASONING_EFFORTS.map(eff=>
       <button key={eff} className={settings.reasoningEffort===eff?'active':''} onClick={()=>void onPref('reasoningEffort',eff)} aria-pressed={settings.reasoningEffort===eff}>{eff==='off'?t('settings.reasoningDefault'):eff[0].toUpperCase()+eff.slice(1)}</button>)}
      </div>
     </Field>
     <Field label={t('settings.systemPrompt')}><textarea rows={4} value={settings.systemPrompt} onChange={e=>void onPref('systemPrompt',e.target.value)}/></Field>
     <Field label={t('settings.density')} hint={t('settings.densityHint')}>
      <div className="density-picker">{DENSITIES.map(d=>
       <button key={d} className={settings.density===d?'active':''} onClick={()=>void onPref('density',d)} aria-pressed={settings.density===d}>{d[0].toUpperCase()+d.slice(1)}</button>)}
      </div>
     </Field>
     {!isMobile&&<Field label={t('settings.defaultWorkspace')}>
      <div className="inline-row">
       <input value={settings.defaultWorkspace} readOnly placeholder={t('settings.defaultWorkspacePh')} aria-label={t('settings.defaultWorkspace')}/>
       <button className="secondary-button" onClick={()=>{void window.lumen.app.pickFolder(t('settings.pickWorkspace')).then(p=>{if(p)void onPref('defaultWorkspace',p);});}}>{t('settings.browse')}</button>
       {settings.defaultWorkspace&&<button className="secondary-button" onClick={()=>void onPref('defaultWorkspace','')}>{t('settings.clear')}</button>}
      </div>
      <p className="field-hint">{t('settings.workspaceHint')}</p>
     </Field>}
     <Field label={t('settings.customCss')}>
      <div className="inline-row">
       <input value={settings.customCss?t('settings.cssCharsLoaded',{n:settings.customCss.length}):''} readOnly placeholder={t('settings.noCustomCss')} aria-label={t('settings.customCssAria')}/>
       <button className="secondary-button" onClick={()=>{
        const input=document.createElement('input');input.type='file';input.accept='.css,text/css';
        input.onchange=()=>{const f=input.files?.[0];if(!f)return;if(f.size>100*1024){onNotice(t('settings.cssTooLarge'));return;}void f.text().then(css=>{void onPref('customCss',css);onNotice(t('settings.customThemeApplied'));});};
        input.click();
       }}>{t('settings.loadCss')}</button>
       {settings.customCss&&<button className="secondary-button" onClick={()=>void onPref('customCss','')}>{t('settings.remove')}</button>}
      </div>
      <p className="field-hint">{t('settings.customCssHint')}</p>
     </Field>
     {/* Tray/autostart/notifications/hotkeys are Windows-desktop concepts. */}
     {!isMobile&&<>
      <h3><Monitor size={14}/> {t('settings.systemTitle')}</h3>
      <ToggleRow title={t('settings.trayTitle')} hint={t('settings.trayHint')} checked={settings.minimizeToTray} onChange={v=>void onPref('minimizeToTray',v)}/>
      <ToggleRow title={t('settings.autoStartTitle')} hint={t('settings.autoStartHint')} checked={settings.autoStart} onChange={v=>void onPref('autoStart',v)}/>
      <ToggleRow title={t('settings.notificationsTitle')} hint={t('settings.notificationsHint')} checked={settings.notifications} onChange={v=>void onPref('notifications',v)}/>
      <h3><Keyboard size={14}/> {t('settings.hotkeysTitle')}</h3>
      <p>{t('settings.hotkeysIntro')}</p>
      {(Object.keys(HOTKEY_LABELS) as Array<keyof HotkeyMap>).map(k=>
       <HotkeyField key={k} label={t(HOTKEY_LABELS[k])} value={settings.hotkeys[k]}
        onChange={v=>void onPref('hotkeys',{...settings.hotkeys,[k]:v})} onInvalid={onNotice}/>)}
     </>}
    </>:tab==='agents'?<>
     <h3>{t('settings.personasTitle')}</h3><p>{t('settings.personasIntro')}</p>
     {editingPersona
      ?<PersonaEditor persona={editingPersona} providers={providers} onCancel={()=>setEditingPersona(null)}
        onSave={p=>{
         const list=settings.personas.filter(x=>x.id!==p.id);
         void onPref('personas',[...list,p]);setEditingPersona(null);onNotice(t('settings.personaSaved'));
        }}/>
      :<>
       <div className="model-list">
        {settings.personas.map(p=><div className="persona-row" key={p.id}>
         <span className="provider-dot" style={{background:p.color}} aria-hidden="true"/>
         <span className="persona-name">{p.name}</span>
         {settings.personaId===p.id&&<small className="persona-active">{t('settings.personaActive')}</small>}
         <button title={t('settings.editName',{name:p.name})} aria-label={t('settings.editName',{name:p.name})} onClick={()=>setEditingPersona(p)}><Pencil size={13}/></button>
         <button title={t('settings.deleteName',{name:p.name})} aria-label={t('settings.deleteName',{name:p.name})} onClick={()=>{
          void onPref('personas',settings.personas.filter(x=>x.id!==p.id));
          if(settings.personaId===p.id)void onPref('personaId','');
         }}><Trash2 size={13}/></button>
        </div>)}
        {!settings.personas.length&&<div className="models-empty">{t('settings.noPersonas')}</div>}
       </div>
       <div className="settings-actions">
        <button className="primary-button" onClick={()=>setEditingPersona(blankPersona())}><Plus size={14}/> {t('settings.newPersona')}</button>
       </div>
      </>}
     <h3><LayoutTemplate size={14}/> {t('settings.templatesTitle')}</h3>
     <p>{t('settings.templatesIntro').split('{{input}}')[0]}<code>{'{{input}}'}</code>{t('settings.templatesIntro').split('{{input}}')[1]}</p>
     {editingTemplate
      ?<TemplateEditor template={editingTemplate} onCancel={()=>setEditingTemplate(null)}
        onSave={tpl=>{
         const list=settings.templates.filter(x=>x.id!==tpl.id);
         void onPref('templates',[...list,tpl]);setEditingTemplate(null);onNotice(t('settings.templateSaved'));
        }}/>
      :<>
       <div className="model-list">
        {settings.templates.map(tpl=><div className="persona-row" key={tpl.id}>
         <LayoutTemplate size={13}/>
         <span className="persona-name">{tpl.name}</span>
         <small className="persona-active">{tpl.text.slice(0,40)}{tpl.text.length>40?'…':''}</small>
         <button title={t('settings.editName',{name:tpl.name})} aria-label={t('settings.editName',{name:tpl.name})} onClick={()=>setEditingTemplate(tpl)}><Pencil size={13}/></button>
         <button title={t('settings.deleteName',{name:tpl.name})} aria-label={t('settings.deleteName',{name:tpl.name})} onClick={()=>void onPref('templates',settings.templates.filter(x=>x.id!==tpl.id))}><Trash2 size={13}/></button>
        </div>)}
        {!settings.templates.length&&<div className="models-empty">{t('settings.noTemplates')}</div>}
       </div>
       <div className="settings-actions">
        <button className="primary-button" onClick={()=>setEditingTemplate(blankTemplate())}><Plus size={14}/> {t('settings.newTemplate')}</button>
       </div>
      </>}
      <h3><Server size={14}/> {t('settings.mcpTitle')}</h3>
      <p>{t('settings.mcpIntro1')}<code>npx -y @modelcontextprotocol/server-filesystem C:\projects</code>{t('settings.mcpIntro2')}</p>
      <div className="model-list">
       {settings.mcpServers.map(s=><div className="persona-row" key={s.id}>
        <Server size={13}/>
        <span className="persona-name">{s.name}</span>
        <small className="persona-active">{s.command}</small>
        <button title={t('settings.removeName',{name:s.name})} aria-label={t('settings.removeName',{name:s.name})} onClick={()=>void onPref('mcpServers',settings.mcpServers.filter(x=>x.id!==s.id))}><Trash2 size={13}/></button>
       </div>)}
       {!settings.mcpServers.length&&<div className="models-empty">{t('settings.noMcp')}</div>}
      </div>
      <McpAddRow servers={settings.mcpServers} onAdd={s=>{void onPref('mcpServers',[...settings.mcpServers,s]);onNotice(t('settings.mcpAdded'));}}/>
    </>:tab==='stats'?<>
     <h3>{t('settings.statsTitle')}</h3><p>{t('settings.statsIntro')}</p>
     <StatsView/>
    </>:<>
     <h3>{t('settings.dataTitle')}</h3><p>{t('settings.dataIntro')}</p>
     <div className="privacy-row"><Shield size={17}/><div><b>{t('settings.localFirst')}</b><small>{t('settings.localFirstHint')}</small></div><Check size={14}/></div>
     <div className="privacy-row"><Shield size={17}/><div><b>{t('settings.encryptedKeys')}</b><small>{t(isMobile?'settings.encryptedKeysHintMobile':'settings.encryptedKeysHint')}</small></div><Check size={14}/></div>
     {usage&&<div className="usage-summary">
      <h4>{t('settings.lifetimeUsage')}</h4>
      {(()=>{
       // $ estimates come from each provider's pricing map; rows without a known
       // price simply don't contribute to the total.
       const costOf=(r:UsageRow)=>messageCost(providers,r.providerId,r.model,r.promptTokens,r.completionTokens);
       const total=usage.byModel.reduce((sum,r)=>sum+(costOf(r)??0),0);
       const priced=usage.byModel.some(r=>costOf(r)!==null);
       return <>
        <div className="usage-stats">
         <div><b>{usage.messages.toLocaleString()}</b><small>{t('settings.replies')}</small></div>
         <div><b>{usage.promptTokens.toLocaleString()}</b><small>{t('settings.promptTokens')}</small></div>
         <div><b>{usage.completionTokens.toLocaleString()}</b><small>{t('settings.completionTokens')}</small></div>
         {priced&&<div><b>{formatCost(total)}</b><small>{t('settings.estimatedCost')}</small></div>}
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
      <button className="secondary-button" onClick={()=>onExport('md')}>{t('settings.exportMd')}</button>
      <button className="secondary-button" onClick={()=>onExport('json')}>{t('settings.exportJson')}</button>
      {!isMobile&&<>
       <button className="secondary-button" onClick={()=>onExportPrepared('html')}><FileDown size={14}/> {t('settings.exportHtml')}</button>
       <button className="secondary-button" onClick={()=>onExportPrepared('pdf')}><FileDown size={14}/> {t('settings.exportPdf')}</button>
       <button className="secondary-button" onClick={onExportZip}><Archive size={14}/> {t('settings.exportZip')}</button>
       <button className="secondary-button" onClick={onOpenDataFolder}><FolderOpen size={14}/> {t('settings.openDataFolder')}</button>
      </>}
     </div>}
     <h3><RotateCcw size={14}/> {t('settings.updatesTitle')}</h3>
     <p>{t('settings.updatesIntro')}</p>
     <div className="settings-actions">
      <button className="secondary-button" onClick={()=>{void window.lumen.updates.check().then(onNotice);}}>{t('settings.checkUpdates')}</button>
      {!isMobile&&<button className="secondary-button" onClick={()=>window.lumen.updates.install()}>{t('settings.restartInstall')}</button>}
     </div>
     {!isMobile&&<>
      <h3><Save size={14}/> {t('settings.backupTitle')}</h3>
      <p>{t('settings.backupIntro')}</p>
      <div className="settings-actions">
       <button className="secondary-button" onClick={()=>{void window.lumen.data.backup().then(p=>onNotice(p?t('settings.backupSavedTo',{path:p}):t('settings.backupCancelled'))).catch(e=>onNotice(e instanceof Error?e.message:t('settings.backupFailed')));}}><Save size={14}/> {t('settings.backupNow')}</button>
       <button className="secondary-button" onClick={()=>{void window.lumen.data.restore().catch(e=>onNotice(e instanceof Error?e.message:t('settings.restoreFailed')));}}><RotateCcw size={14}/> {t('settings.restoreBackup')}</button>
      </div>
     </>}
     {confirmWipe
      ?<div className="confirm-inline" role="alertdialog" aria-label={t('settings.confirmWipeAria')}>
        <p>{t('settings.confirmWipeText')}</p>
        <div className="settings-actions">
         <button className="secondary-button" onClick={()=>setConfirmWipe(false)}>{t('settings.cancel')}</button>
         <button className="danger-button" onClick={()=>{setConfirmWipe(false);onWipe();onClose();}}><Trash2 size={14}/> {t('settings.deleteEverything')}</button>
        </div>
       </div>
      :<button className="danger-button block" onClick={()=>setConfirmWipe(true)}><Trash2 size={14}/> {t('settings.eraseAll')}</button>}
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
