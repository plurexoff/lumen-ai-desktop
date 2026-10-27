import {create} from 'zustand';
import type {Accent,Chat,Density,HotkeyMap,Language,McpServer,Message,Persona,PromptTemplate,ProviderConfig,ProviderId,FinishReason,ReasoningEffort,ThemePreset,ToolEvent} from '../electron/shared';
import {DEFAULT_HOTKEYS} from '../electron/shared';

export type Prefs={theme:'dark'|'light';language:Language;systemPrompt:string;temperature:number;maxTokens:number;topP:number;minimizeToTray:boolean;autoStart:boolean;notifications:boolean;accent:Accent;personas:Persona[];personaId:string;hotkeys:HotkeyMap;templates:PromptTemplate[];defaultWorkspace:string;customCss:string;compactMode:boolean;mcpServers:McpServer[];density:Density;themePreset:ThemePreset;reasoningEffort:ReasoningEffort};

// An image staged in the composer but not sent yet. `preview` is a data: URL so the
// optimistic bubble can render it without touching the lumen-attachment:// protocol.
export interface PendingImage{name:string;mime:string;size:number;data:string;preview:string}

// One in-flight generation per chat, keyed by chatId. A flat {busy,stream} made the
// whole UI stuck the moment a done-chunk was dropped (switching chats mid-stream):
// busy never cleared and every composer stayed disabled until restart. Keying by chat
// lets a stream finish in the background and lets the UI reconnect to orphans.
export interface StreamState{
 requestId:string;
 text:string;
 reasoning:string;
 error:string;
 finishReason:FinishReason;
 usage:{promptTokens:number;completionTokens:number}|null;
 // What the model is doing between text chunks (e.g. "Running read_file…") while
 // workspace tools execute. Cleared by the next status chunk or stream end.
 status?:string;
 // Tool calls of the current answer, for the cards in the streaming bubble.
 toolEvents?:ToolEvent[];
}

export interface State{
 chats:Chat[];
 activeId:string|null;
 messages:Message[];
 providers:ProviderConfig[];
 settings:Prefs;
 providerId:ProviderId;
 model:string;
 // Live generations, keyed by chatId. Presence of an entry == that chat is busy.
 streams:Record<string,StreamState>;
 // A finished generation's error, keyed by chatId. Kept separate from `streams` so
 // the banner + Retry survive after the stream entry is cleared (which is what
 // re-enables the composer). Cleared on the next send or when the chat is opened.
 errors:Record<string,string>;
 // Chunk batching: main sends a chunk per token; the App listener accumulates here
 // and flushes into `streams` once per animation frame instead of per token.
 pending:Record<string,{text:string;reasoning:string}>;
 set:(x:Partial<State>)=>void;
}

export const useApp=create<State>(set=>({
 chats:[],activeId:null,messages:[],providers:[],
 settings:{theme:'dark',language:'en',systemPrompt:'',temperature:.7,maxTokens:2048,topP:1,minimizeToTray:false,autoStart:false,notifications:false,accent:'violet',personas:[],personaId:'',hotkeys:DEFAULT_HOTKEYS,templates:[],defaultWorkspace:'',customCss:'',compactMode:false,mcpServers:[],density:'default',themePreset:'default',reasoningEffort:'off'},
 providerId:'openai',model:'gpt-4o-mini',
 streams:{},errors:{},pending:{},
 set:x=>set(x),
}));

// Is this specific chat generating? Used to gate its composer and show its bubble.
export const isStreaming=(s:State,chatId:string|null):boolean=>!!chatId&&!!s.streams[chatId];
// Any generation in flight at all? Used for the global titlebar indicator.
export const anyStreaming=(s:State):boolean=>Object.keys(s.streams).length>0;

export const providerColors:Record<string,string>={openai:'#74aa9c',anthropic:'#d49572',gemini:'#7896f2',openrouter:'#b994e8',groq:'#edaa5e',deepseek:'#65a6dc',mistral:'#f2a35b',ollama:'#8bd5ca',lmstudio:'#7dd3fc',custom:'#94a3b8'};
