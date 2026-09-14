import test from 'node:test'
import assert from 'node:assert/strict'

const memory=new Map()
globalThis.localStorage={getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,String(value)),removeItem:key=>memory.delete(key)}
const {demoRequest}=await import('./demoApi.ts')
const post=body=>({method:'POST',body:JSON.stringify(body)})

test('sample counts match evidence and citations resolve',async()=>{
 const {dataset_id}=await demoRequest('/sample',{method:'POST'})
 const overview=await demoRequest(`/datasets/${dataset_id}/overview`)
 assert.equal(overview.total,16)
 assert.equal(overview.negative_share,Math.round(overview.negative/overview.total*1000)/10)
 for(const issue of overview.issues){
  const detail=await demoRequest(`/datasets/${dataset_id}/clusters/${issue.id}`)
  assert.equal(issue.count,detail.evidence.length)
  assert.equal(detail.denominator,overview.total)
 }
 const answer=await demoRequest(`/datasets/${dataset_id}/chat`,post({question:'Top Issues 有哪些？'}))
 assert.match(answer.answer,/模拟回答/)
 const id=answer.answer.match(/F-\d+-\d+-[a-f0-9]{8}/)?.[0]
 assert.ok(id)
 const evidence=await demoRequest(`/datasets/${dataset_id}/feedback/${id}`)
 assert.equal(evidence.evidence.id,id)
})

test('rename, merge and hide update overview without losing feedback',async()=>{
 const [{id}]=await demoRequest('/datasets')
 const before=await demoRequest(`/datasets/${id}/overview`)
 const source=before.issues[0],target=before.issues[1]
 await demoRequest(`/datasets/${id}/clusters/${source.id}/review`,post({operation:'rename',name:'导出问题演示'}))
 let after=await demoRequest(`/datasets/${id}/overview`)
 assert.equal(after.issues.find(x=>x.id===source.id).name,'导出问题演示')
 await demoRequest(`/datasets/${id}/clusters/${source.id}/review`,post({operation:'merge',target_id:target.id}))
 after=await demoRequest(`/datasets/${id}/overview`)
 assert.equal(after.issues.find(x=>x.id===target.id).count,target.count+source.count)
 assert.equal(after.total,before.total)
 await demoRequest(`/datasets/${id}/clusters/${target.id}/review`,post({operation:'remove'}))
 after=await demoRequest(`/datasets/${id}/overview`)
 assert.equal(after.issues.some(x=>x.id===target.id),false)
 assert.equal(after.total,before.total)
})

test('virtual file import is marked as sample; missing fields block comparisons',async()=>{
 const form=new FormData()
 form.append('file',new File(['private user text'],'notes.xlsx'))
 const preview=await demoRequest('/preview',{method:'POST',body:form})
 assert.match(preview.name,/演示样例/)
 assert.equal(preview.estimated,16)
 const imported=await demoRequest('/import',post({name:preview.name,headers:preview.headers,rows:preview.rows,mapping:preview.suggested_mapping,source:'upload'}))
 const overview=await demoRequest(`/datasets/${imported.dataset_id}/overview`)
 assert.equal(overview.dataset.source,'sample')
 const pasted=await demoRequest('/import',post({name:'粘贴文本',headers:['反馈内容'],rows:[['希望增加深色模式'],['登录失败']],mapping:{text:'反馈内容'},source:'paste'}))
 const noMeta=await demoRequest(`/datasets/${pasted.dataset_id}/overview`)
 assert.equal(noMeta.versions,0)
 assert.equal(noMeta.dated,0)
 const answer=await demoRequest(`/datasets/${pasted.dataset_id}/chat`,post({question:'比较版本'}))
 assert.match(answer.answer,/无法比较版本差异/)
})
