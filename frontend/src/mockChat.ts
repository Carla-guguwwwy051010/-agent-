export type MockMessage={role:'user'|'agent';text:string;mode?:string}
const SESSION_KEY='folio_demo_session_id'
const HISTORY_PREFIX='folio_demo_history_'
export function getSessionId(){try{let id=localStorage.getItem(SESSION_KEY);if(!id||!/^[A-Za-z0-9_-]{8,128}$/.test(id)){id=crypto.randomUUID();localStorage.setItem(SESSION_KEY,id)}return id}catch{return crypto.randomUUID()}}
export function loadMockHistory(sessionId:string):MockMessage[]{try{const value:unknown=JSON.parse(localStorage.getItem(HISTORY_PREFIX+sessionId)||'[]');return Array.isArray(value)?value.filter((m:unknown):m is MockMessage=>typeof m==='object'&&m!==null&&('role' in m)&&('text' in m)&&(m.role==='user'||m.role==='agent')&&typeof m.text==='string').slice(-100):[]}catch{return []}}
export function saveMockHistory(sessionId:string,messages:MockMessage[]){try{localStorage.setItem(HISTORY_PREFIX+sessionId,JSON.stringify(messages.slice(-100)))}catch{}}
