import React from 'react';import{createRoot}from'react-dom/client';import App from './App';import QuickChat from './components/QuickChat';import'./styles.css';
import{isMobile}from './platform/detect';
// The quick-chat mini window loads the same bundle with #quick and renders only the
// mini chat — no sidebar, no store hydration, no chat list traffic.
const mount=()=>createRoot(document.getElementById('root')!).render(<React.StrictMode>{window.location.hash==='#quick'?<div className="app-shell"><QuickChat/></div>:<App/>}</React.StrictMode>);
// Android shell: there is no Electron preload, so window.lumen is provided by the
// mobile platform layer (sql.js storage + Capacitor HTTP) before React mounts.
if(isMobile){void import('./platform/mobile').then(m=>{window.lumen=m.createMobileApi();mount();});}
else mount();
