import React from 'react';import{createRoot}from'react-dom/client';import App from './App';import QuickChat from './components/QuickChat';import'./styles.css';
// The quick-chat mini window loads the same bundle with #quick and renders only the
// mini chat — no sidebar, no store hydration, no chat list traffic.
createRoot(document.getElementById('root')!).render(<React.StrictMode>{window.location.hash==='#quick'?<div className="app-shell"><QuickChat/></div>:<App/>}</React.StrictMode>);
