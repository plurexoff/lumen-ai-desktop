import {Sparkles,X} from 'lucide-react';
import {useT} from '../i18n';

// `busy` shows a subtle activity indicator: a generation running in a background
// conversation (or behind another window) was previously invisible.
export default function Titlebar({busy}:{busy?:boolean}){
 const t=useT();
 return <header className="titlebar">
  <div className={'brand-mark'+(busy?' busy':'')}><Sparkles size={15}/>{busy&&<i className="busy-pulse"/>}</div>
  <b>lumen</b><span className="title-separator"/><span className="title-caption">{busy?t('titlebar.generating'):t('titlebar.caption')}</span>
  <div className="drag-region"/>
  <button aria-label={t('titlebar.minimize')} title={t('titlebar.minimize')} onClick={()=>window.lumen.window.minimize()}>—</button>
  <button aria-label={t('titlebar.maximize')} title={t('titlebar.maximize')} onClick={()=>window.lumen.window.toggleMaximize()}>▢</button>
  <button className="window-close" aria-label={t('titlebar.close')} title={t('titlebar.close')} onClick={()=>window.lumen.window.close()}><X size={14}/></button>
 </header>;
}
