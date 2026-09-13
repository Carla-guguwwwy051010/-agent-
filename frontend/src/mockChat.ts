export type MockMessage={role:'user'|'agent';text:string;mode?:string}
const SESSION_KEY='folio_demo_session_id'
const HISTORY_PREFIX='folio_demo_history_'
export function getSessionId(){try{let id=localStorage.getItem(SESSION_KEY);if(!id||!/^[A-Za-z0-9_-]{8,128}$/.test(id)){id=crypto.randomUUID();localStorage.setItem(SESSION_KEY,id)}return id}catch{return crypto.randomUUID()}}
export function loadMockHistory(sessionId:string):MockMessage[]{try{const value:unknown=JSON.parse(localStorage.getItem(HISTORY_PREFIX+sessionId)||'[]');return Array.isArray(value)?value.filter((m:unknown):m is MockMessage=>typeof m==='object'&&m!==null&&('role' in m)&&('text' in m)&&(m.role==='user'||m.role==='agent')&&typeof m.text==='string').slice(-100):[]}catch{return []}}
export function saveMockHistory(sessionId:string,messages:MockMessage[]){try{localStorage.setItem(HISTORY_PREFIX+sessionId,JSON.stringify(messages.slice(-100)))}catch{}}
export function mockReply(question:string):string{
 const q=question.trim()
 const prefix='模拟回答：当前演示没有连接反馈数据，因此以下是分析方法，不是针对真实数据的结论。'
 if(/你好|hi|hello/i.test(q)&&q.length<12)return '你好！我是 Folio 的模拟 Agent。你可以问我如何整理用户反馈、判断优先级或核查趋势；此页面不会读取真实反馈。'
 if(/趋势|增长|最近|日期|时间/.test(q))return prefix+'要判断是否增长，先按有效日期统计每个时间段的反馈量，并检查采集渠道和总反馈量是否也变化。没有日期和基准期时，我不能声称某个问题正在增长。'
 if(/版本|对比/.test(q))return prefix+'版本比较需要至少两个有效版本，并分别核对相同主题的反馈数和分母。若版本样本量不同，直接比较条数容易误导。'
 if(/优先|先做|重要|排序/.test(q))return prefix+'可以结合提及频次、严重程度、受影响用户范围和修复成本排优先级。提及最多只表示频次高，不能自动等于最该先做。'
 if(/根因|为什么|原因/.test(q))return prefix+'反馈可以提示可能的原因，但不能单独证明根因。建议用日志、行为数据和用户访谈交叉核查，再决定修复方案。'
 if(/主题|问题|分类|反馈/.test(q))return prefix+'先保留原文和反馈 ID，再清理空白与重复记录，按相似场景整理主题。每个主题应能展开到原始反馈，并人工检查边界案例。'
 return prefix+'我可以示范如何设计分析步骤，但不能凭这段对话编造数量或证据。你可以试着问“如何判断问题优先级？”或“怎样核查增长趋势？”。'
}
