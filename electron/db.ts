import initSqlJs,{type Database}from'sql.js';
import{app}from'electron';
import fs from'node:fs';
import path from'node:path';
let db:Database;let filePath:string;let saveTimer:NodeJS.Timeout|null=null;
const SAVE_DEBOUNCE_MS=250;
// Bumped whenever the schema changes; stored in `PRAGMA user_version` so an old
// install can be migrated forward and a too-new file can be refused outright.
export const SCHEMA_VERSION=5;

export interface DbStatus{recovered:boolean;backupPath:string|null;newerVersion:number|null;}
let status:DbStatus={recovered:false,backupPath:null,newerVersion:null};
export function dbStatus(){return status;}
// Persistence failures must not be silent: a full disk would otherwise lose the
// whole history with no signal until the next launch. main.ts surfaces this.
let persistError:string|null=null;
export function lastPersistError(){return persistError;}

export async function openDatabase(){
 filePath=path.join(app.getPath('userData'),'lumen.sqlite');
 const SQL=await initSqlJs({locateFile:file=>path.join(__dirname,'../node_modules/sql.js/dist',file)});
 const bytes=fs.existsSync(filePath)?fs.readFileSync(filePath):null;
 // A 0-byte file is a VALID empty database to SQLite, so sql.js will not throw on
 // it — the user would silently lose everything. Check the size explicitly.
 if(bytes&&bytes.length===0)throw new Error('Database file is empty (0 bytes)');
 if(bytes){
  try{
   db=new SQL.Database(bytes);
   // sql.js validates lazily: a file with a bad header can survive the constructor
   // and only blow up on first use. Force that read here so corruption is caught
   // (and quarantined) instead of crashing startup with "file is not a database".
   // Integrity costs O(size), so it is only worth it for a file that already exists.
   if(db.exec('PRAGMA quick_check')[0]?.values?.[0]?.[0]!=='ok')throw new Error('integrity check failed');
  }
  catch{
   // Quarantine the unreadable file instead of overwriting it, then start clean.
   const backupPath=quarantine();
   db=new SQL.Database();
   status={recovered:true,backupPath,newerVersion:null};
  }
 }else db=new SQL.Database();
 db.run('PRAGMA foreign_keys=ON');
 const version=Number(db.exec('PRAGMA user_version')[0]?.values?.[0]?.[0]??0);
 if(version>SCHEMA_VERSION){status={...status,newerVersion:version};return db;}
 createSchema();
 migrate(version);
 saveNow();return db;
}

function createSchema(){
 db.run('CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY,title TEXT NOT NULL,provider_id TEXT NOT NULL,model TEXT NOT NULL,updated_at INTEGER NOT NULL,branched_from TEXT,pinned INTEGER NOT NULL DEFAULT 0,folder_id TEXT,workspace TEXT)');
 db.run('CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,role TEXT NOT NULL,content TEXT NOT NULL,created_at INTEGER NOT NULL)');
 db.run("CREATE TABLE IF NOT EXISTS providers(id TEXT PRIMARY KEY,name TEXT NOT NULL,base_url TEXT NOT NULL,models TEXT NOT NULL,headers TEXT NOT NULL DEFAULT '{}')");
 db.run('CREATE TABLE IF NOT EXISTS secrets(id TEXT PRIMARY KEY,value BLOB NOT NULL)');
 db.run('CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
 db.run('CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id,created_at)');
 // Image bytes live as FILES under userData/attachments (keyed by row id) — keeping
 // them out of this file matters: sql.js re-exports the whole DB on every flush.
 db.run('CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,created_at INTEGER NOT NULL)');
 db.run('CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id)');
}

function ensureColumn(table:string,column:string,decl:string){const info=db.exec(`PRAGMA table_info(${table})`)[0];const cols=info?info.values.map(v=>String(v[1])):[];if(!cols.includes(column))db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);}

// Ordered, idempotent steps. Every step must tolerate having already run, because
// a pre-versioning install arrives here with user_version=0 and live data.
function migrate(from:number){
 if(from<1){
  ensureColumn('messages','model','TEXT');ensureColumn('messages','provider_id','TEXT');
  ensureColumn('messages','prompt_tokens','INTEGER');ensureColumn('messages','completion_tokens','INTEGER');
  ensureColumn('providers','pricing','TEXT');
 }
 if(from<2){
  // Reasoning and the truncation signal were rendered but never stored, so both
  // vanished on reload.
  ensureColumn('messages','reasoning','TEXT');ensureColumn('messages','finish_reason','TEXT');
  db.run('CREATE TABLE IF NOT EXISTS message_variants(id TEXT PRIMARY KEY,message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,content TEXT NOT NULL,reasoning TEXT,created_at INTEGER NOT NULL,prompt_tokens INTEGER,completion_tokens INTEGER)');
  db.run('CREATE INDEX IF NOT EXISTS idx_variants_message ON message_variants(message_id)');
 }
 if(from<3){
  // v3: image attachments (metadata only; bytes stay on disk).
  db.run('CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,created_at INTEGER NOT NULL)');
  db.run('CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id)');
 }
 if(from<4){
  // v4: branch lineage, so a forked chat can link back to its source.
  ensureColumn('chats','branched_from','TEXT');
 }
 if(from<5){
  // v5: sidebar organization (pin, folders) and a per-chat workspace folder that
  // enables the model's file tools. Deleting a folder never deletes chats.
  ensureColumn('chats','pinned','INTEGER NOT NULL DEFAULT 0');
  ensureColumn('chats','folder_id','TEXT');
  ensureColumn('chats','workspace','TEXT');
  db.run('CREATE TABLE IF NOT EXISTS folders(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at INTEGER NOT NULL)');
 }
 db.run(`PRAGMA user_version=${SCHEMA_VERSION}`);
}

// Rename the unreadable file aside. The rename itself can fail (an antivirus or
// indexer may hold a handle), so it is guarded separately from the recovery.
function quarantine():string|null{
 try{
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const backupPath=filePath+'.corrupt-'+stamp;
  fs.renameSync(filePath,backupPath);return backupPath;
 }catch{return filePath+'.corrupt';}
}

// Atomic write: serialize to a temp file, fsync it, then rename over the target so
// a crash or power loss mid-write cannot leave a truncated database behind.
function flush(){
 if(!db||!filePath)return;
 const tmp=filePath+'.tmp';
 let fd=-1;
 try{
  fd=fs.openSync(tmp,'w');
  // sql.js export() closes and re-opens the SQLite handle, which resets connection
  // pragmas to their defaults — foreign_keys silently drops back to OFF. Re-enable it
  // so ON DELETE CASCADE keeps working for writes after the first flush.
  fs.writeFileSync(fd,Buffer.from(db.export()));
  db.run('PRAGMA foreign_keys=ON');
  fs.fsyncSync(fd);fs.closeSync(fd);fd=-1;
  fs.renameSync(tmp,filePath);
  persistError=null;
 }catch(e){
  if(fd>=0)try{fs.closeSync(fd);}catch{}
  persistError=e instanceof Error?e.message:'unknown write error';
  console.error('lumen: failed to persist database',e);
 }
}
// Debounced persistence: coalesce bursts of writes (e.g. streaming inserts) into
// a single disk flush instead of re-exporting the whole DB on every statement.
export function save(){if(saveTimer)clearTimeout(saveTimer);saveTimer=setTimeout(()=>{saveTimer=null;flush();},SAVE_DEBOUNCE_MS);}
export function saveNow(){if(saveTimer){clearTimeout(saveTimer);saveTimer=null;}flush();}
export function query(sql:string,params:unknown[]=[]){const stmt=db.prepare(sql);try{stmt.bind(params as (string|number|Uint8Array|null)[]);const rows:Record<string,unknown>[]=[];while(stmt.step())rows.push(stmt.getAsObject());return rows;}finally{stmt.free();}}
export function run(sql:string,params:unknown[]=[]){db.run(sql,params as (string|number|Uint8Array|null)[]);save();}
export function one(sql:string,params:unknown[]=[]){return query(sql,params)[0];}
// Related writes must be all-or-nothing: a half-applied variant restore would
// leave the conversation with a duplicated or missing turn.
export function transaction<T>(fn:()=>T):T{
 db.run('BEGIN');
 try{const result=fn();db.run('COMMIT');save();return result;}
 catch(e){try{db.run('ROLLBACK');}catch{}throw e;}
}
