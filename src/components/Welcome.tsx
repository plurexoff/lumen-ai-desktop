import {ArrowDown,KeyRound,Sparkles} from 'lucide-react';
import type {MouseEvent} from 'react';
import {useT} from '../i18n';
import {isMobile} from '../platform/detect';

const suggestions: Array<[string,string,string]>=[
 ['✦','welcome.sug1.title','welcome.sug1.sub'],
 ['▤','welcome.sug2.title','welcome.sug2.sub'],
 ['◌','welcome.sug3.title','welcome.sug3.sub'],
 ['⌘','welcome.sug4.title','welcome.sug4.sub'],
];

// `needsSetup` is true when no provider has a key yet. The old welcome said nothing
// about that, so the first message just failed with a raw error banner.
export default function Welcome({needsSetup,onSetup,onPick}:{needsSetup?:boolean;onSetup:()=>void;onPick:(text:string)=>void}){
 const t=useT();
 // Spotlight: the card's accent glow follows the cursor (--mx/--my feed a CSS
 // radial-gradient in .suggestions button::after).
 const spot=(e:MouseEvent<HTMLButtonElement>)=>{const r=e.currentTarget.getBoundingClientRect();e.currentTarget.style.setProperty('--mx',e.clientX-r.left+'px');e.currentTarget.style.setProperty('--my',e.clientY-r.top+'px');};
 return <div className="welcome">
  <div className="welcome-icon"><Sparkles size={25}/></div>
  <div className="eyebrow">{t('welcome.eyebrow')}</div>
  <h1>{t('welcome.heading.pre')}<em>{t('welcome.heading.em')}</em></h1>
  <p>{t('welcome.tagline1')}<br/>{t('welcome.tagline2')}</p>
  {needsSetup&&<div className="setup-card">
   <KeyRound size={18}/>
   <div><b>{t('welcome.setup.title')}</b>
    <small>{t(isMobile?'welcome.setup.bodyMobile':'welcome.setup.body')}</small></div>
   <button className="primary-button" onClick={onSetup}>{t('welcome.setup.button')}</button>
  </div>}
  <div className="suggestions">{suggestions.map(([icon,title,sub])=>
   <button key={title} onMouseMove={spot} onClick={()=>onPick(t(title))}><i>{icon}</i><span><b>{t(title)}</b><small>{t(sub)}</small></span><ArrowDown size={14}/></button>)}</div>
 </div>;
}
