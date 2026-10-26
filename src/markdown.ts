import {marked} from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({gfm:true,breaks:true});

// Register once at module load, not per render: DOMPurify hooks are global state.
// Model output is untrusted — sanitize it, but also make links usable. Without a
// target the anchor click hits the blocked will-navigate handler and does nothing,
// so every link in every answer was dead. main.ts allow-lists the protocol it opens.
DOMPurify.addHook('afterSanitizeAttributes',node=>{
 if(node.tagName==='A'&&node.hasAttribute('href')){
  node.setAttribute('target','_blank');
  // rel guards against reverse-tabnabbing: the opened page must not get window.opener.
  node.setAttribute('rel','noopener noreferrer');
 }
});

export function renderMarkdown(source:string):string{
 const html=marked.parse(source,{async:false}) as string;
 return DOMPurify.sanitize(html,{USE_PROFILES:{html:true},ADD_ATTR:['target','rel']});
}
