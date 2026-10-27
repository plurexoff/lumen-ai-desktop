import {marked} from 'marked';
import DOMPurify from 'dompurify';
import {t} from './i18n';

marked.setOptions({gfm:true,breaks:true});

const escapeHtml=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// Fenced blocks get a header with the language and a Copy button (Kilo/OpenCode
// style). The button is inert markup — clicks are delegated in the Markdown
// component, which reads the sibling <code> textContent, so no code text is ever
// stuffed into an attribute.
marked.use({renderer:{
 code({text,lang}){
  const language=(lang??'').trim().split(/\s+/)[0];
  const label=escapeHtml(language||'text');
  return `<div class="code-block"><div class="code-head"><span class="code-lang">${label}</span><button type="button" class="code-copy">${escapeHtml(t('messages.copy'))}</button></div><pre><code class="language-${label}">${escapeHtml(text)}</code></pre></div>`;
 },
}});

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
 return DOMPurify.sanitize(html,{USE_PROFILES:{html:true},ADD_TAGS:['button'],ADD_ATTR:['target','rel','type']});
}
