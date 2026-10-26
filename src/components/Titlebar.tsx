import {Sparkles,X} from 'lucide-react';

// `busy` shows a subtle activity indicator: a generation running in a background
// conversation (or behind another window) was previously invisible.
export default function Titlebar({busy}:{busy?:boolean}){
 return <header className="titlebar">
  <div className={'brand-mark'+(busy?' busy':'')}><Sparkles size={15}/>{busy&&<i className="busy-pulse"/>}</div>
  <b>lumen</b><span className="title-separator"/><span className="title-caption">{busy?'Generating…':'AI workspace'}</span>
  <div className="drag-region"/>
  <button aria-label="Minimize" title="Minimize" onClick={()=>window.lumen.window.minimize()}>—</button>
  <button aria-label="Maximize" title="Maximize" onClick={()=>window.lumen.window.toggleMaximize()}>▢</button>
  <button className="window-close" aria-label="Close" title="Close" onClick={()=>window.lumen.window.close()}><X size={14}/></button>
 </header>;
}
