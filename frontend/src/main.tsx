import React, {useEffect, useRef, useState} from 'react'
import {createRoot} from 'react-dom/client'
import {LoaderCircle} from 'lucide-react'
import './style.css'

type Preview={name:string;headers:string[];rows:string[][];preview:string[][];estimated:number;suggested_mapping:Record<string,string|null>}
type Issue={id:number;name:string;description:string;status:string;count:number}
type Dataset={id:number;name:string;source:string;status:string;imported_count:number;skipped_count:number;duplicate_count:number}
type Overview={dataset:Dataset;total:number;negative:number;negative_share:number;dated:number;versions:number;issues:Issue[];provider:string;model_status:string}
type Evidence={id:string;raw_text:string;row_number:number;source_file:string;date_raw:string|null;date_value:string|null;date_error:number;version:string|null;platform:string|null;source:string|null;sentiment:string;severity:string}
type Detail={cluster:Issue;count:number;share:number;denominator:number;evidence:Evidence[]}
type ChatMessage={role:'user'|'agent';text:string;mode?:string}
const labels:Record<string,string>={text:'反馈内容',date:'日期',version:'版本',platform:'平台',source:'来源',rating:'评分'}
const API=(import.meta.env.VITE_API_BASE_URL||'').replace(/\/$/,'')+'/api'
async function request<T>(url:string,options?:RequestInit):Promise<T>{const r=await fetch(API+url,options);if(!(r.headers.get('content-type')||'').includes('application/json'))throw new Error('分析服务未连接');const data=await r.json().catch(()=>({detail:'服务器返回了无效响应'}));if(!r.ok)throw new Error(typeof data.detail==='string'?data.detail:'请求失败');return data as T}
const json=(body:unknown)=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})

function App(){
 const [datasets,setDatasets]=useState<Dataset[]>([]),[current,setCurrent]=useState<number|null>(null),[overview,setOverview]=useState<Overview|null>(null)
 const [preview,setPreview]=useState<Preview|null>(null),[mapping,setMapping]=useState<Record<string,string|null>>({}),[paste,setPaste]=useState(''),[pasteOpen,setPasteOpen]=useState(false)
 const [busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[drawer,setDrawer]=useState<{type:'cluster'|'metric'|'evidence';id?:number;metric?:string;feedback?:Evidence}|null>(null),[detail,setDetail]=useState<Detail|null>(null)
 const [question,setQuestion]=useState(''),[messages,setMessages]=useState<ChatMessage[]>([]),[chatBusy,setChatBusy]=useState(false),[searchResults,setSearchResults]=useState<Evidence[]>([])
 const [serviceError,setServiceError]=useState(false)
 const [renameName,setRenameName]=useState(''),[mergeTarget,setMergeTarget]=useState(''),[contextLabel,setContextLabel]=useState(''),[drag,setDrag]=useState(false)
 const fileRef=useRef<HTMLInputElement>(null),evidenceRefs=useRef<Record<string,HTMLElement|null>>({}),evidenceSectionRef=useRef<HTMLDivElement>(null),questionRef=useRef<HTMLTextAreaElement>(null)
 const refresh=async(id:number)=>{const data=await request<Overview>(`/datasets/${id}/overview`);setOverview(data);setCurrent(id);setDatasets(await request<Dataset[]>('/datasets'));setTimeout(()=>document.getElementById('insights')?.scrollIntoView({behavior:'smooth'}),80)}
 useEffect(()=>{request<Dataset[]>('/datasets').then(ds=>{setDatasets(ds);if(ds[0])refresh(ds[0].id).catch(()=>setServiceError(true));else loadSample().catch(()=>setServiceError(true))}).catch(()=>setServiceError(true))},[])
 useEffect(()=>{if(drawer?.type==='cluster'&&drawer.id&&current)request<Detail>(`/datasets/${current}/clusters/${drawer.id}`).then(setDetail).catch(e=>setError(e.message));else setDetail(null)},[drawer?.type,drawer?.id,current])
 useEffect(()=>{if(drawer?.feedback?.id)setTimeout(()=>evidenceRefs.current[drawer.feedback!.id]?.scrollIntoView({block:'center',behavior:'smooth'}),100)},[drawer,detail])
 useEffect(()=>{if(detail){setRenameName(detail.cluster.name);setMergeTarget('')}},[detail])
 useEffect(()=>{if(!notice&&!error)return;const timer=setTimeout(()=>{setNotice('');setError('')},5000);return ()=>clearTimeout(timer)},[notice,error])
 const upload=async(file:File)=>{setError('');setBusy('reading');try{const form=new FormData();form.append('file',file);const p=await request<Preview>('/preview',{method:'POST',body:form});setPreview(p);setMapping(p.suggested_mapping)}catch(e){setError((e as Error).message)}finally{setBusy('')}}
 const importRows=async(p:Preview,source:'upload'|'paste'='upload')=>{setBusy('analyzing');setError('');try{const result=await request<{dataset_id:number;imported:number;skipped:number;duplicate:number;analysis_errors:unknown[]}>('/import',json({name:p.name,headers:p.headers,rows:p.rows,mapping,source}));setPreview(null);setPasteOpen(false);setPaste('');await refresh(result.dataset_id);setNotice(`导入 ${result.imported} 条 · 跳过 ${result.skipped} 条 · 重复 ${result.duplicate} 条${result.analysis_errors.length?' · 部分模型分析失败，已回退模拟分类':''}`)}catch(e){setError((e as Error).message)}finally{setBusy('')}}
 const loadSample=async()=>{setBusy('sample');setError('');try{const r=await request<{dataset_id:number}>('/sample',{method:'POST'});await refresh(r.dataset_id);setNotice('已加载示例数据，可以探索分析与证据。')}catch(e){setError((e as Error).message)}finally{setBusy('')}}
 const usePaste=()=>{const rows=paste.split(/\r?\n/).map(x=>[x]).filter(x=>x[0].trim());if(!rows.length){setError('请先粘贴至少一条反馈');return}const p={name:'粘贴文本',headers:['反馈内容'],rows,preview:rows.slice(0,3),estimated:rows.length,suggested_mapping:{text:'反馈内容'}};setMapping({text:'反馈内容'});setPasteOpen(false);setPreview(p)}
 const openEvidence=async(fid:string)=>{if(!current)return;try{const r=await request<{evidence:Evidence|null}>(`/datasets/${current}/feedback/${fid}`);if(!r.evidence){setError('当前数据集找不到这条反馈');return}setDrawer({type:'evidence',feedback:r.evidence})}catch(e){setError((e as Error).message)}}
 const renderText=(text:string)=>text.split(/(F-\d+-\d+-[a-f0-9]{8})/g).map((part,i)=>/^F-\d+-\d+-[a-f0-9]{8}$/.test(part)?<button className="citation" key={i} onClick={()=>openEvidence(part)}>{part}</button>:<React.Fragment key={i}>{part}</React.Fragment>)
 const ask=async(q=question)=>{if(!q.trim()||!current||chatBusy)return;setMessages(m=>[...m,{role:'user',text:q}]);setQuestion('');setContextLabel('');setChatBusy(true);try{const r=await request<{mode:string;answer:string}>(`/datasets/${current}/chat`,json({question:q}));setMessages(m=>[...m,{role:'agent',text:r.answer,mode:r.mode}])}catch(e){setMessages(m=>[...m,{role:'agent',text:(e as Error).message+'。请重试。'}])}finally{setChatBusy(false)}}
 const review=async(operation:string,id:number,name?:string,target_id?:number)=>{if(!current)return;setBusy('review');try{const result=await request<Overview>('/datasets/'+current+'/clusters/'+id+'/review',json({operation,name,target_id}));setOverview(result);setNotice('主题已更新，原始反馈保持不变。');if(operation==='rename'){const updated=await request<Detail>('/datasets/'+current+'/clusters/'+id);setDetail(updated);setRenameName(updated.cluster.name)}else setDrawer(null)}catch(e){setError((e as Error).message)}finally{setBusy('')}}
 const rename=()=>{if(drawer?.id&&renameName.trim())review('rename',drawer.id,renameName.trim())}
 const merge=()=>{if(drawer?.id&&mergeTarget)review('merge',drawer.id,undefined,Number(mergeTarget))}
 const prepareQuestion=(text:string)=>{setQuestion(text);setContextLabel(drawer?.type==='cluster'?detail?.cluster.name||'当前主题':drawer?.type==='metric'?'当前指标':'当前反馈');setDrawer(null);document.getElementById('conversation')?.scrollIntoView({behavior:'smooth',block:'center'});setTimeout(()=>questionRef.current?.focus(),100)}
 const metricEvidence=async(metric:string)=>{if(!current||!overview)return;setDrawer({type:'metric',metric});try{if(metric==='priority'&&overview.issues[0]){const d=await request<Detail>('/datasets/'+current+'/clusters/'+overview.issues[0].id);setSearchResults(d.evidence)}else if(metric==='themes'){const details=await Promise.all(overview.issues.map(x=>request<Detail>('/datasets/'+current+'/clusters/'+x.id)));setSearchResults(details.flatMap(d=>d.evidence.slice(0,2)))}else{const r=await request<{evidence:Evidence[]}>('/datasets/'+current+'/tools/search_feedback?query=');setSearchResults(r.evidence)}}catch(e){setError((e as Error).message)}}
 const currentEvidence=drawer?.type==='metric'?(drawer.metric==='negative'?searchResults.filter(x=>x.sentiment==='negative'):searchResults):drawer?.type==='evidence'&&drawer.feedback?[drawer.feedback]:[]
 const drawerTitle=drawer?.type==='cluster'?detail?.cluster.name||'主题分析':drawer?.type==='evidence'?'原始反馈':drawer?.metric==='themes'?'问题主题':drawer?.metric==='negative'?'负向线索':drawer?.metric==='priority'?'提及最多':'反馈总量'
 const drawerList=drawer?.type==='cluster'?detail?.evidence||[]:currentEvidence
 const drawerCount=drawer?.type==='cluster'?detail?.count||0:drawer?.type==='evidence'?1:drawer?.metric==='themes'?drawerList.length:drawer?.metric==='negative'?overview?.negative||0:drawer?.metric==='priority'?overview?.issues[0]?.count||0:overview?.total||0
 const drawerShare=drawer?.type==='cluster'?'占当前数据 '+(detail?.share||0)+'%':drawer?.metric==='negative'?'占当前数据 '+(overview?.negative_share||0)+'%':'当前数据集'
 const observed=drawer?.type==='cluster'?'当前 '+(detail?.denominator||0)+' 条反馈中，'+(detail?.count||0)+' 条归入「'+drawerTitle+'」。点击下方编号可核对原文。':drawer?.type==='evidence'?'以下是数据库保留的原始反馈与来源行号。':drawer?.metric==='themes'?'当前识别 '+(overview?.issues.length||0)+' 个主题。':drawer?.metric==='negative'?'负向反馈 '+(overview?.negative||0)+' 条；分母是 '+(overview?.total||0)+' 条有效反馈。':drawer?.metric==='priority'?'「'+(overview?.issues[0]?.name||'')+'」提及 '+(overview?.issues[0]?.count||0)+' 条，是当前频次最高的主题。':'当前数据集包含 '+(overview?.total||0)+' 条有效反馈。'
 const explanation=drawer?.metric==='priority'?'提及最多不等于业务优先级最高。':'这些表达可能指向同一用户场景，但单凭反馈不能证明根因或实际影响人数。'
 const nextStep='按版本、平台和时间核查分布，再结合行为数据与日志确认范围。'
 const otherIssues=overview?.issues.filter(x=>x.id!==detail?.cluster.id)||[]
 return <div className="site">
  <header className="wrap topbar">
   <a className="brand" href="#top"><i aria-hidden="true"/>folio.</a>
   <nav><a href="#conversation">对话</a><a href="#insights">洞察</a></nav>
   <span className="ready">工作台已就绪</span>
  </header>
  <main id="top">
   <section className="wrap hero">
    <div className="eyebrow">USER INSIGHT / AGENT WORKSPACE</div>
    <div className="hero-grid">
     <div><h1>Listen closer.<br/><em>See further.</em></h1><p className="lead">让每一条用户声音，成为下一步产品决策的线索。</p></div>
     <div className="art" aria-hidden="true"><div className="disc"/><span>Signals</span></div>
    </div>
   </section>
   {serviceError&&<div className="wrap service-error" role="alert"><span>分析服务暂不可用。页面已加载，但上传和 Agent 需要连接分析服务。</span><button type="button" onClick={()=>window.location.reload()}>重试 ↗</button></div>}
   <section className="wrap work" id="conversation">
    <div>
     <div className="section-title"><h2>开始分析</h2><small>01 / INPUT</small></div>
     <div className={'drop'+(drag?' drag':'')} onDragOver={e=>{e.preventDefault();setDrag(true)}} onDragLeave={()=>setDrag(false)} onDrop={e=>{e.preventDefault();setDrag(false);const file=e.dataTransfer.files?.[0];if(file)upload(file)}}>
      <div className="upload-symbol">↗</div>
      <div className="upload-copy"><strong>放入你的用户反馈</strong><small>CSV、Excel 或 TXT · 拖放文件至此</small></div>
      <button className="outline" type="button" onClick={()=>fileRef.current?.click()} disabled={!!busy}>选择文件 ↗</button>
      <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,.xlsx,.xls" onChange={e=>{const file=e.target.files?.[0];if(file)upload(file);e.target.value=''}}/>
     </div>
     <div className={'file-state'+(busy?' show':'')}><span>{busy==='reading'?'正在读取文件…':busy==='analyzing'?'正在分析反馈…':busy==='sample'?'正在载入示例数据…':busy==='review'?'正在更新主题…':''}</span>{busy&&<LoaderCircle className="spin" size={15}/>}</div>
     <div className="action-row"><span>也可以直接粘贴一段反馈文本</span><button className="text-link" type="button" onClick={()=>setPasteOpen(true)} disabled={!!busy}>粘贴文本 ↗</button></div>
     <div className="action-row"><span>想先看看它如何工作？</span><button className="text-link" type="button" onClick={loadSample} disabled={!!busy}>载入示例数据 ↗</button></div>
    </div>
    <div className="chat">
     <div className="chat-head"><span>◉ &nbsp; FOLIO AGENT</span><span>● 在线 · {overview?.model_status==='insufficient_balance'?'余额不足 · 模拟回答':overview?.provider==='deepseek'?'DeepSeek 回答':'模拟回答'}</span></div>
     <div className="messages" aria-live="polite">
      {messages.length===0&&<div className="message agent"><span className="who">FOLIO</span>你好。上传反馈，或先载入示例数据。你也可以直接问我想了解什么。</div>}
      {messages.map((m,i)=><div key={i} className={'message '+m.role}>{m.role==='agent'&&<span className="who">{m.mode==='mock'?'FOLIO · 模拟回答':'FOLIO'}</span>}{renderText(m.text)}</div>)}
      {chatBusy&&<div className="message agent"><span className="who">FOLIO</span>正在查询当前数据集…</div>}
     </div>
     {contextLabel&&<div className="context show"><span>{contextLabel}</span><button type="button" onClick={()=>setContextLabel('')} aria-label="移除上下文">×</button></div>}
     <form className="composer" onSubmit={e=>{e.preventDefault();ask()}}>
      <textarea ref={questionRef} rows={1} value={question} onChange={e=>setQuestion(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();ask()}}} placeholder="向 Folio 提问…" aria-label="向 Agent 提问" disabled={!current||chatBusy}/>
      <button className="send" type="submit" disabled={!current||!question.trim()||chatBusy} aria-label="发送">↗</button>
     </form>
    </div>
   </section>
   <section className="wrap insights" id="insights">
    <div className="insight-head">
     <div><div className="eyebrow">THE SIGNALS / 02</div><h2>数据中的声音</h2></div>
     <div className="dataset">当前数据集<br/><div className="dataset-name"><strong>{overview?.dataset.name||'尚未载入'}</strong>{datasets.length>0&&<select aria-label="切换数据集" value={current??''} onChange={e=>refresh(Number(e.target.value)).catch(err=>setError(err.message))}>{datasets.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select>}</div><div className="data-badges"><span className={'badge'+(overview?.dataset.source==='upload'?' real':'')}>{overview?.dataset.source==='sample'?'示例数据':overview?'上传数据':'待载入'}</span><span className="badge">初步归类</span></div></div>
    </div>
    <div className="stats">
     <button className="stat" type="button" onClick={()=>metricEvidence('total')} disabled={!overview}><span className="stat-label">反馈总量<span>↗</span></span><span className="value">{overview?.total||0}</span><span className="stat-note">条原始反馈</span></button>
     <button className="stat" type="button" onClick={()=>metricEvidence('themes')} disabled={!overview}><span className="stat-label">问题主题<span>↗</span></span><span className="value">{overview?.issues.length||0}</span><span className="stat-note">个初步识别主题</span></button>
     <button className="stat" type="button" onClick={()=>metricEvidence('negative')} disabled={!overview}><span className="stat-label">负向线索<span>↗</span></span><span className="value">{Math.round(overview?.negative_share||0)}%</span><span className="stat-note">情绪分类估算</span></button>
     <button className="stat" type="button" onClick={()=>metricEvidence('priority')} disabled={!overview}><span className="stat-label">提及最多<span>↗</span></span><span className="value">{overview?.issues[0]?.count||0}</span><span className="stat-note">条相关反馈</span></button>
    </div>
    <div className="issues-layout"><div><h3>Top Issues</h3><p>点击数据，查看分析或询问 Agent ↗</p></div><div>{overview?.issues.map((issue,i)=><button className="issue" type="button" key={issue.id} onClick={()=>setDrawer({type:'cluster',id:issue.id})}><span className="issue-no">{String(i+1).padStart(2,'0')}</span><span className="issue-name">{issue.name}<small>{issue.description}</small></span><span className="issue-count">{issue.count}<small> 条</small></span><span className="arrow">↗</span></button>)}</div></div>
   </section>
  </main>
  <footer className="wrap"><strong>folio.</strong><span>Every voice has a signal. © 2026 Folio</span></footer>
  {pasteOpen&&<dialog ref={node=>{if(node&&!node.open)node.showModal()}} onClose={()=>setPasteOpen(false)}><div className="dialog-head"><h2>粘贴反馈</h2><button className="close" type="button" onClick={()=>setPasteOpen(false)} aria-label="关闭">×</button></div><textarea className="dialog-textarea" value={paste} onChange={e=>setPaste(e.target.value)} placeholder="每行一条反馈，或粘贴带字段名的 CSV 内容。"/><div className="dialog-foot"><small>支持逐行文本</small><button className="solid" type="button" onClick={usePaste}>继续 ↗</button></div></dialog>}
  {preview&&<dialog ref={node=>{if(node&&!node.open)node.showModal()}} onClose={()=>setPreview(null)}><div className="dialog-head"><h2>确认数据字段</h2><button className="close" type="button" onClick={()=>setPreview(null)} aria-label="关闭">×</button></div><p className="map-intro">确认反馈文本所在列。日期、版本和平台可选；没有相应字段时，不会生成相关比较。</p><div className="map-grid">{(['text','date','version','platform'] as const).map(key=><div className="field" key={key}><label>{labels[key]}{key==='text'?' *':''}</label><select value={mapping[key]||''} onChange={e=>setMapping(m=>({...m,[key]:e.target.value||null}))}><option value="">{key==='text'?'请选择':'不映射'}</option>{preview.headers.map(h=><option key={h} value={h}>{h}</option>)}</select><small>{key==='text'?'用于主题归类和原文引用':key==='date'?'用于时间对比':key==='version'?'用于版本对比':'用于平台筛选'}</small></div>)}</div><details className="extra-fields"><summary>更多可选字段</summary><div className="map-grid">{(['source','rating'] as const).map(key=><div className="field" key={key}><label>{labels[key]}</label><select value={mapping[key]||''} onChange={e=>setMapping(m=>({...m,[key]:e.target.value||null}))}><option value="">不映射</option>{preview.headers.map(h=><option key={h} value={h}>{h}</option>)}</select></div>)}</div></details><div className="map-preview"><strong>数据预览</strong><div>{preview.preview.map((row,i)=><p key={i}>{row.join(' · ')}</p>)}</div></div><div className="dialog-foot"><small>预计可读取 {preview.estimated} 条</small><button className="solid" type="button" disabled={!mapping.text||!!busy} onClick={()=>importRows(preview,preview.name==='粘贴文本'?'paste':'upload')}>载入反馈 ↗</button></div></dialog>}
  {drawer&&<><div className="drawer-backdrop show" onClick={()=>setDrawer(null)}/><aside className="drawer show" role="dialog" aria-modal="true" aria-labelledby="drawerTitle"><div className="drawer-head"><div><small>THE SIGNAL / DETAIL</small><h2 id="drawerTitle">{drawerTitle}</h2></div><button className="drawer-close" type="button" onClick={()=>setDrawer(null)} aria-label="关闭分析">×</button></div><div className="drawer-scroll"><div className="drawer-actions"><button className="solid" type="button" onClick={()=>prepareQuestion('「'+drawerTitle+'」有哪些原始反馈作为证据？')}>询问 Agent ↗</button><button className="outline" type="button" onClick={()=>evidenceSectionRef.current?.scrollIntoView({behavior:'smooth',block:'start'})}>查看原始反馈 ↓</button></div><div className="metric-line"><strong>{drawerCount} 条</strong><span>{drawerShare}</span></div><div className="drawer-section"><h3>分析判断</h3><div className="three-part"><article><label>观察到的数据</label><p>{observed}</p></article><article><label>可能的解释</label><p>{explanation}</p></article><article><label>建议核查</label><p>{nextStep}</p></article></div></div><div className="drawer-section"><h3>继续追问</h3><div className="quick"><button type="button" onClick={()=>prepareQuestion('「'+drawerTitle+'」有哪些原始反馈作为证据？')}>查看支持这项判断的原文</button><button type="button" disabled={(overview?.versions||0)<2} title="需要至少两个版本值" onClick={()=>prepareQuestion('「'+drawerTitle+'」在不同版本的反馈数量有什么差异？')}>按版本比较</button><button type="button" disabled={(overview?.dated||0)<2} title="需要有效日期字段" onClick={()=>prepareQuestion('「'+drawerTitle+'」的反馈在不同日期如何分布？')}>查看时间分布</button></div><p className="quick-note">{(overview?.versions||0)<2||(overview?.dated||0)<2?'灰色问题需要相应的版本或日期字段。':'快捷提问会带入当前主题。'}</p></div><div className="drawer-section" ref={evidenceSectionRef}><h3>原始反馈 <span>({drawerList.length})</span></h3><div className="evidence-list">{drawerList.length?drawerList.map(item=><EvidenceCard key={item.id} item={item} refCallback={el=>evidenceRefs.current[item.id]=el} selected={drawer.feedback?.id===item.id}/>):<p className="quick-note">当前没有匹配的原始反馈。</p>}</div></div>{drawer.type==='cluster'&&detail&&<div className="drawer-section"><h3>整理主题</h3><div className="edit-grid"><div><label htmlFor="renameInput">主题名称</label><input id="renameInput" value={renameName} onChange={e=>setRenameName(e.target.value)}/><div className="edit-row"><button type="button" onClick={rename} disabled={!!busy}>保存名称</button></div></div><div><label htmlFor="mergeTarget">合并到其他主题</label><select id="mergeTarget" value={mergeTarget} onChange={e=>setMergeTarget(e.target.value)}><option value="">请选择主题</option>{otherIssues.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select><div className="edit-row"><button type="button" onClick={merge} disabled={!mergeTarget||!!busy}>合并主题</button><button className="danger" type="button" onClick={()=>review('remove',detail.cluster.id)} disabled={!!busy}>移出 Top Issues</button></div></div></div></div>}</div></aside></>}
  {(notice||error)&&<div className="toast show" role="status">{error||notice}</div>}
 </div>
}
function EvidenceCard({item,refCallback,selected}:{item:Evidence;refCallback:(el:HTMLElement|null)=>void;selected:boolean}){return <article ref={refCallback} className={'evidence'+(selected?' flash':'')}><div className="evidence-head"><span>#{item.id}</span><span>{[item.date_value||item.date_raw,item.version,item.platform].filter(Boolean).join(' · ')}</span></div><p>{item.raw_text}</p><div className="evidence-meta">{item.source_file} · 第 {item.row_number} 行</div></article>}
createRoot(document.getElementById('root')!).render(<App/>)
