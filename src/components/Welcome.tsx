import {ArrowDown,KeyRound,Sparkles} from 'lucide-react';

const suggestions: Array<[string,string,string]>=[
 ['✦','Brainstorm ideas','Explore a fresh perspective'],
 ['▤','Make it make sense','Understand something new'],
 ['◌','Find the right words','Write with more clarity'],
 ['⌘','Work through a problem','One step at a time'],
];

// `needsSetup` is true when no provider has a key yet. The old welcome said nothing
// about that, so the first message just failed with a raw error banner.
export default function Welcome({needsSetup,onSetup,onPick}:{needsSetup?:boolean;onSetup:()=>void;onPick:(text:string)=>void}){
 return <div className="welcome">
  <div className="welcome-icon"><Sparkles size={25}/></div>
  <div className="eyebrow">YOUR AI WORKSPACE</div>
  <h1>A little more <em>intelligence.</em></h1>
  <p>Bring your favorite models together in one thoughtful space.<br/>Your conversations stay yours.</p>
  {needsSetup&&<div className="setup-card">
   <KeyRound size={18}/>
   <div><b>Connect a provider to start</b>
    <small>Paste an API key, or pick Ollama / LM Studio to run models on this machine with no key at all. Keys are encrypted with Windows DPAPI and never leave your device.</small></div>
   <button className="primary-button" onClick={onSetup}>Set up a provider</button>
  </div>}
  <div className="suggestions">{suggestions.map(([icon,title,sub])=>
   <button key={title} onClick={()=>onPick(title)}><i>{icon}</i><span><b>{title}</b><small>{sub}</small></span><ArrowDown size={14}/></button>)}</div>
 </div>;
}
