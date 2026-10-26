import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI } from './shared';
const api:DesktopAPI={
 window:{minimize:()=>ipcRenderer.send('window:minimize'),toggleMaximize:()=>ipcRenderer.send('window:toggle-maximize'),close:()=>ipcRenderer.send('window:close')},
 app:{version:()=>ipcRenderer.invoke('app:version')},
 chats:{
  list:()=>ipcRenderer.invoke('chats:list'),
  create:()=>ipcRenderer.invoke('chats:create'),
  rename:(id,title)=>ipcRenderer.invoke('chats:rename',id,title),
  pin:(id,pinned)=>ipcRenderer.invoke('chats:pin',id,pinned),
  setFolder:(id,folderId)=>ipcRenderer.invoke('chats:set-folder',id,folderId),
  pickWorkspace:id=>ipcRenderer.invoke('chats:pick-workspace',id),
  clearWorkspace:id=>ipcRenderer.invoke('chats:clear-workspace',id),
  delete:id=>ipcRenderer.invoke('chats:delete',id),
  messages:id=>ipcRenderer.invoke('chats:messages',id),
  deleteMessage:(id,chatId)=>ipcRenderer.invoke('chats:delete-message',id,chatId),
  variants:messageId=>ipcRenderer.invoke('chats:variants',messageId),
  restoreVariant:variantId=>ipcRenderer.invoke('chats:restore-variant',variantId),
  branch:(id,messageId)=>ipcRenderer.invoke('chats:branch',id,messageId),
  usageSummary:()=>ipcRenderer.invoke('chats:usage-summary'),
  export:(id,format)=>ipcRenderer.invoke('chats:export',id,format),
  search:q=>ipcRenderer.invoke('chats:search',q),
  onRenamed:callback=>{const listener=(_event:Electron.IpcRendererEvent,data:Parameters<typeof callback>[0])=>callback(data);ipcRenderer.on('chats:renamed',listener);return()=>ipcRenderer.removeListener('chats:renamed',listener);},
 },
 providers:{
  list:()=>ipcRenderer.invoke('providers:list'),
  save:(config,key)=>ipcRenderer.invoke('providers:save',config,key),
  remove:id=>ipcRenderer.invoke('providers:remove',id),
  models:id=>ipcRenderer.invoke('providers:models',id),
  test:id=>ipcRenderer.invoke('providers:test',id),
 },
 chat:{
  send:request=>ipcRenderer.invoke('chat:send',request),
  continueMessage:request=>ipcRenderer.invoke('chat:continue',request),
  regenerate:request=>ipcRenderer.invoke('chat:regenerate',request),
  stop:(requestId?:string)=>ipcRenderer.invoke('chat:stop',requestId),
  status:()=>ipcRenderer.invoke('chat:status'),
  onChunk:callback=>{const listener=(_event:Electron.IpcRendererEvent,data:Parameters<typeof callback>[0])=>callback(data);ipcRenderer.on('chat:chunk',listener);return()=>ipcRenderer.removeListener('chat:chunk',listener);},
 },
 prompt:{
  enhance:(draft,providerId,model)=>ipcRenderer.invoke('prompt:enhance',draft,providerId,model),
 },
 folders:{
  list:()=>ipcRenderer.invoke('folders:list'),
  create:name=>ipcRenderer.invoke('folders:create',name),
  rename:(id,name)=>ipcRenderer.invoke('folders:rename',id,name),
  delete:id=>ipcRenderer.invoke('folders:delete',id),
 },
 data:{
  health:()=>ipcRenderer.invoke('data:health'),
  wipe:()=>ipcRenderer.invoke('data:wipe'),
  openFolder:()=>ipcRenderer.invoke('data:open-folder'),
 },
 settings:{get:()=>ipcRenderer.invoke('settings:get'),save:settings=>ipcRenderer.invoke('settings:save',settings)},
};
contextBridge.exposeInMainWorld('lumen',api);
