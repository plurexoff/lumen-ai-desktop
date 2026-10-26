import {useEffect,useMemo,useRef,useState} from 'react';
import {renderMarkdown} from './markdown';

// A stored message's content never changes, so parsing it once per content string is
// enough. Without this a 100-message conversation re-ran marked + DOMPurify for every
// message on every animation frame while a new answer streamed in (~6000 parses/sec).
export function useMarkdownHtml(content:string):string{
 return useMemo(()=>renderMarkdown(content),[content]);
}

// The streaming bubble and its reasoning block grow with every chunk, so re-parsing
// the whole text each flush is O(n²) in the answer length. Re-parse at most every `ms`
// instead, and always schedule a trailing parse so the final chunk is never dropped.
// `ms=0` degrades to "parse when the text changes", which is right for stored content.
export function useThrottledMarkdown(text:string,ms=0):string{
 const [html,setHtml]=useState(()=>(text?renderMarkdown(text):''));
 const textRef=useRef(text);
 textRef.current=text;
 const lastRun=useRef(0);
 const timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 useEffect(()=>{
  if(!text){setHtml('');lastRun.current=0;return;}
  const parse=()=>{lastRun.current=Date.now();setHtml(renderMarkdown(textRef.current));};
  const since=Date.now()-lastRun.current;
  if(since>=ms){parse();return;}
  if(timer.current)clearTimeout(timer.current);
  timer.current=setTimeout(parse,ms-since);
  return()=>{if(timer.current)clearTimeout(timer.current);};
 },[text,ms]);
 return html;
}
