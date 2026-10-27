import {useEffect,useRef,useState} from 'react';

// Tweens a number towards its target over `dur` ms (ease-out cubic). Used for live
// counters (e.g. the composer's token/cost estimate) so digits glide instead of
// jumping on every keystroke. Honors prefers-reduced-motion by snapping instantly.
export function useCountUp(target:number,dur=250):number{
 const [value,setValue]=useState(target);
 // The last value actually painted — a retarget mid-tween starts from here, not
 // from the previous target, so rapid changes stay smooth.
 const shown=useRef(target);
 useEffect(()=>{
  const from=shown.current;
  if(from===target)return;
  if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){shown.current=target;setValue(target);return;}
  const t0=performance.now();
  let raf=requestAnimationFrame(function step(now){
   const k=Math.min(1,(now-t0)/dur);
   const v=Math.round(from+(target-from)*(1-Math.pow(1-k,3)));
   shown.current=v;setValue(v);
   if(k<1)raf=requestAnimationFrame(step);
  });
  return()=>cancelAnimationFrame(raf);
 },[target,dur]);
 return value;
}
