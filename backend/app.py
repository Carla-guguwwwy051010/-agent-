from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import re
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from openpyxl import load_workbook
import xlrd

load_dotenv(Path(__file__).with_name('.env'))
DB = Path(os.getenv('FOLIO_DB', str(Path(__file__).with_name('folio.db'))))
app = FastAPI(title='Folio API')
app.add_middleware(CORSMiddleware, allow_origins=['http://localhost:5173', 'http://127.0.0.1:5173'], allow_methods=['*'], allow_headers=['*'])

SCHEMA = '''
CREATE TABLE IF NOT EXISTS dataset(id INTEGER PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, imported_at TEXT NOT NULL, mapping TEXT NOT NULL, status TEXT NOT NULL, imported_count INTEGER DEFAULT 0, skipped_count INTEGER DEFAULT 0, duplicate_count INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS feedback(id TEXT PRIMARY KEY, dataset_id INTEGER NOT NULL, raw_text TEXT NOT NULL, row_number INTEGER NOT NULL, source_file TEXT NOT NULL, date_raw TEXT, date_value TEXT, date_error INTEGER DEFAULT 0, version TEXT, platform TEXT, source TEXT, rating REAL, text_hash TEXT NOT NULL, FOREIGN KEY(dataset_id) REFERENCES dataset(id));
CREATE INDEX IF NOT EXISTS ix_feedback_dataset ON feedback(dataset_id);
CREATE TABLE IF NOT EXISTS feedback_analysis(feedback_id TEXT PRIMARY KEY, theme TEXT NOT NULL, intent TEXT NOT NULL, sentiment TEXT NOT NULL, severity TEXT NOT NULL, summary TEXT NOT NULL, confidence REAL NOT NULL, analysis_version TEXT NOT NULL, FOREIGN KEY(feedback_id) REFERENCES feedback(id));
CREATE TABLE IF NOT EXISTS cluster(id INTEGER PRIMARY KEY, dataset_id INTEGER NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cluster_member(cluster_id INTEGER NOT NULL, feedback_id TEXT NOT NULL, PRIMARY KEY(cluster_id, feedback_id));
CREATE TABLE IF NOT EXISTS human_review(id INTEGER PRIMARY KEY, dataset_id INTEGER NOT NULL, cluster_id INTEGER, operation TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS model_call(id INTEGER PRIMARY KEY, dataset_id INTEGER, provider TEXT, purpose TEXT, duration_ms INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER, status TEXT, created_at TEXT);
'''

def conn():
    DB.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    c.execute('PRAGMA foreign_keys=ON')
    c.executescript(SCHEMA)
    return c

def now(): return datetime.now(timezone.utc).isoformat()
def rowdict(row): return dict(row) if row else None

def parse_file(name: str, data: bytes):
    ext = Path(name).suffix.lower()
    if ext not in {'.csv', '.tsv', '.xlsx', '.xls', '.txt'}:
        raise HTTPException(400, '仅支持 CSV、TSV、XLSX、XLS、TXT')
    if not data: raise HTTPException(400, '文件为空')
    try:
        if ext in {'.xlsx', '.xls'}:
            if ext == '.xlsx':
                ws = load_workbook(io.BytesIO(data), read_only=True, data_only=True).active
                rows = [[str(v) if v is not None else '' for v in row] for row in ws.values]
            else:
                sheet = xlrd.open_workbook(file_contents=data).sheet_by_index(0)
                rows = [[str(sheet.cell_value(i, j)) for j in range(sheet.ncols)] for i in range(sheet.nrows)]
        else:
            try: content = data.decode('utf-8-sig')
            except UnicodeDecodeError: content = data.decode('gb18030')
            if ext == '.txt': rows = [[line] for line in content.splitlines()]
            else:
                sample = content[:4096]
                delim = '\t' if ext == '.tsv' else csv.Sniffer().sniff(sample, delimiters=',;\t').delimiter
                rows = list(csv.reader(io.StringIO(content), delimiter=delim))
    except Exception as exc:
        raise HTTPException(400, f'文件读取失败或格式不正确：{type(exc).__name__}') from exc
    if not rows or not any(str(x).strip() for row in rows for x in row): raise HTTPException(400, '文件没有可读取的内容')
    if ext == '.txt': return ['反馈内容'], rows
    headers = [str(x).strip() or f'未命名列 {i+1}' for i, x in enumerate(rows[0])]
    if len(set(headers)) != len(headers): headers = [f'{x} ({i+1})' for i, x in enumerate(headers)]
    return headers, rows[1:]

def guess(headers):
    keys = {'text':['feedback','content','text','评论','反馈','内容'], 'date':['date','time','日期','时间'], 'version':['version','版本'], 'platform':['platform','平台'], 'source':['source','来源'], 'rating':['rating','score','评分']}
    return {k: next((h for h in headers if any(t in h.lower() for t in terms)), None) for k, terms in keys.items()}

def date_parse(raw):
    if not raw: return None, 0
    s = str(raw).strip()
    for fmt in ('%Y-%m-%d','%Y/%m/%d','%Y.%m.%d','%Y-%m-%d %H:%M:%S','%Y/%m/%d %H:%M:%S','%Y年%m月%d日'):
        try: return datetime.strptime(s, fmt).date().isoformat(), 0
        except ValueError: pass
    return None, 1

class ImportBody(BaseModel):
    name: str
    rows: list[list[str]]
    headers: list[str]
    mapping: dict[str, str | None]
    source: str = 'upload'

RULES = [
    ('登录与验证', ['登录','验证码','密码','login','code']),
    ('性能与稳定性', ['慢','卡','崩溃','闪退','加载','启动','slow','crash']),
    ('搜索与发现', ['搜索','找不到','检索','search']),
    ('支付与账单', ['付款','支付','扣费','退款','payment']),
    ('功能建议', ['希望','建议','支持','能否','feature']),
]

def validate_analysis(value):
    required = {'theme':str,'intent':str,'sentiment':str,'severity':str,'summary':str,'confidence':(float,int)}
    if not isinstance(value, dict) or any(not isinstance(value.get(k), t) for k,t in required.items()): raise ValueError('模型分析结构无效')
    if value['sentiment'] not in {'negative','neutral','positive'} or value['severity'] not in {'low','medium','high'} or not 0 <= value['confidence'] <= 1: raise ValueError('模型分析枚举或置信度无效')
    if not value['theme'].strip() or len(value['summary']) > 500: raise ValueError('模型分析内容无效')
    return value

class ModelProvider:
    name = 'base'
    def classify(self, text: str): raise NotImplementedError
    def chat(self, dataset_id: int, question: str): raise NotImplementedError

class MockProvider(ModelProvider):
    name = 'mock'
    def classify(self, text):
        lower = text.lower()
        theme = next((name for name, words in RULES if any(w in lower for w in words)), '其他反馈')
        negative = any(w in lower for w in ['不','没','失败','慢','卡','错误','差','crash','slow'])
        positive = any(w in lower for w in ['更清晰','很好','喜欢','满意'])
        return validate_analysis({'theme':theme,'intent':'problem' if negative else 'suggestion' if theme == '功能建议' else 'comment','sentiment':'negative' if negative else 'positive' if positive else 'neutral','severity':'high' if any(w in lower for w in ['扣费','崩溃','闪退']) else 'medium' if negative else 'low','summary':text[:120], 'confidence':0.55})
    def chat(self, dataset_id, question):
        q = question.lower()
        if any(x in q for x in ['趋势','增长','按天']): result = tool(dataset_id, 'get_issue_trend', {})
        elif any(x in q for x in ['版本','对比']): result = tool(dataset_id, 'compare_versions', {})
        elif any(x in q for x in ['搜索','查找','包含']): result = tool(dataset_id, 'search_feedback', {'query':question[:50]})
        else: result = tool(dataset_id, 'get_top_issues', {})
        return {'mode':'mock','answer':format_tool_answer(result), 'tool_results':[result]}

_BALANCE_CACHE = {'checked': 0.0, 'status': 'unknown'}

def model_status():
    if os.getenv('MODEL_PROVIDER','auto').lower() == 'mock':
        return 'mock_forced'
    key = os.getenv('DEEPSEEK_API_KEY')
    if not key:
        return 'missing_key'
    if time.monotonic() - _BALANCE_CACHE['checked'] < 60:
        return _BALANCE_CACHE['status']
    try:
        url = os.getenv('DEEPSEEK_BASE_URL','https://api.deepseek.com').rstrip('/') + '/user/balance'
        with httpx.Client(timeout=min(float(os.getenv('DEEPSEEK_TIMEOUT','30')), 10)) as client:
            response = client.get(url, headers={'Authorization': 'Bearer ' + key})
        if response.status_code == 200:
            status = 'ready' if response.json().get('is_available') is True else 'insufficient_balance'
        elif response.status_code == 401:
            status = 'invalid_key'
        else:
            status = 'unknown'
    except (httpx.HTTPError, ValueError):
        status = 'unknown'
    _BALANCE_CACHE.update(checked=time.monotonic(), status=status)
    return status

def provider():
    return DeepSeekProvider() if model_status() in {'ready', 'unknown'} else MockProvider()

def log_call(dataset_id, provider_name, purpose, started, usage=None, status='ok'):
    with conn() as c: c.execute('INSERT INTO model_call(dataset_id,provider,purpose,duration_ms,prompt_tokens,completion_tokens,status,created_at) VALUES(?,?,?,?,?,?,?,?)', (dataset_id,provider_name,purpose,int((time.monotonic()-started)*1000),(usage or {}).get('prompt_tokens',0),(usage or {}).get('completion_tokens',0),status,now()))

class DeepSeekProvider(ModelProvider):
    name = 'deepseek'
    def complete(self, messages, tools=None, json_mode=False, dataset_id=None, purpose='chat'):
        payload = {'model':os.getenv('DEEPSEEK_MODEL','deepseek-v4-flash'),'messages':messages,'thinking':{'type':'disabled'}}
        if tools: payload['tools'] = tools
        if json_mode: payload['response_format'] = {'type':'json_object'}
        retries = max(0,min(5,int(os.getenv('DEEPSEEK_RETRIES','2'))))
        started = time.monotonic()
        for attempt in range(retries+1):
            try:
                with httpx.Client(timeout=float(os.getenv('DEEPSEEK_TIMEOUT','30'))) as client:
                    r = client.post(os.getenv('DEEPSEEK_BASE_URL','https://api.deepseek.com').rstrip('/') + '/chat/completions', headers={'Authorization':'Bearer '+os.environ['DEEPSEEK_API_KEY']}, json=payload)
                if r.status_code in {429,500,502,503,504} and attempt < retries:
                    time.sleep(min(2**attempt,4)); continue
                if r.status_code == 402: raise RuntimeError('DeepSeek 余额不足；可切换模拟模式后重试')
                if r.status_code == 429: raise RuntimeError('DeepSeek 请求限流；稍后重试')
                r.raise_for_status()
                data = r.json()
                message = data['choices'][0]['message']
                if not isinstance(message,dict): raise ValueError('无效模型响应')
                log_call(dataset_id,self.name,purpose,started,data.get('usage'))
                return message
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                if attempt < retries: time.sleep(min(2**attempt,4)); continue
                log_call(dataset_id,self.name,purpose,started,status='timeout')
                raise RuntimeError('DeepSeek 请求超时或连接失败；可重试') from exc
            except Exception:
                log_call(dataset_id,self.name,purpose,started,status='failed')
                raise
    def classify(self,text):
        msg = self.complete([{'role':'system','content':'请分析用户反馈，只输出 JSON 对象，包含 theme、intent、sentiment(negative/neutral/positive)、severity(low/medium/high)、summary、confidence(0到1)。不要推测根因。'}, {'role':'user','content':text[:4000]}],json_mode=True,purpose='classify')
        return validate_analysis(json.loads(msg.get('content') or '{}'))
    def chat(self,dataset_id,question):
        specs = [{'type':'function','function':{'name':n,'description':d,'parameters':{'type':'object','properties':p,'additionalProperties':False}}} for n,d,p in TOOL_SPECS]
        messages=[{'role':'system','content':'你是 Folio 数据分析助手。先调用工具读取当前数据集，回答仅基于工具结果。区分观察事实、可能解释和建议核查；每项重要事实引用原始反馈 ID。没有数据时明确说明。不得把提及频次说成优先级。'}, {'role':'user','content':question[:2000]}]
        results=[]
        for _ in range(3):
            msg=self.complete(messages,tools=specs,dataset_id=dataset_id)
            calls=msg.get('tool_calls') or []
            if not calls:
                if not results: raise ValueError('模型未调用数据工具，无法生成事实回答')
                answer=msg.get('content') or ''
                known={fid for result in results for fid in json.dumps(result,ensure_ascii=False).split('"') if re.fullmatch(r'F-\d+-\d+-[a-f0-9]{8}',fid)}
                cited=set(re.findall(r'F-\d+-\d+-[a-f0-9]{8}',answer))
                if cited-known: raise ValueError('模型引用了不属于工具结果的反馈 ID')
                return {'mode':'deepseek','answer':answer,'tool_results':results}
            messages.append(msg)
            for call in calls[:6]:
                try: args=json.loads(call['function']['arguments'])
                except Exception as exc: raise ValueError('工具参数不是有效 JSON') from exc
                result=tool(dataset_id,call['function']['name'],args)
                results.append(result)
                messages.append({'role':'tool','tool_call_id':call['id'],'content':json.dumps(result,ensure_ascii=False)[:15000]})
        raise ValueError('工具调用超过限制')

TOOL_SPECS=[
    ('get_top_issues','获取当前数据集主题提及数',{}),
    ('get_cluster_detail','获取主题详情与原始证据',{'cluster_id':{'type':'integer'}}),
    ('get_issue_trend','按有效日期统计主题或全部反馈',{'cluster_id':{'type':'integer'}}),
    ('compare_versions','比较至少两个有效版本的主题频次',{}),
    ('search_feedback','搜索原始反馈',{'query':{'type':'string'},'limit':{'type':'integer'}}),
    ('get_evidence','按反馈 ID 获取原文',{'feedback_id':{'type':'string'}}),
]

def get_dataset(c,dataset_id):
    row=c.execute('SELECT * FROM dataset WHERE id=?',(dataset_id,)).fetchone()
    if not row: raise HTTPException(404,'数据集不存在')
    return row

def feedback_rows(c,dataset_id,where='',params=(),limit=100):
    return [dict(x) for x in c.execute('SELECT f.*,a.theme,a.intent,a.sentiment,a.severity,a.summary,a.confidence FROM feedback f JOIN feedback_analysis a ON a.feedback_id=f.id WHERE f.dataset_id=? '+where+' ORDER BY f.row_number LIMIT ?', (dataset_id,*params,limit)).fetchall()]

def cluster_detail(c,dataset_id,cluster_id):
    cl=c.execute('SELECT * FROM cluster WHERE id=? AND dataset_id=?',(cluster_id,dataset_id)).fetchone()
    if not cl: raise HTTPException(404,'主题不存在')
    members=feedback_rows(c,dataset_id,'AND f.id IN (SELECT feedback_id FROM cluster_member WHERE cluster_id=?)',(cluster_id,),1000)
    total=c.execute('SELECT COUNT(*) FROM feedback WHERE dataset_id=?',(dataset_id,)).fetchone()[0]
    return {'cluster':dict(cl),'count':len(members),'share':round(len(members)/total*100,1) if total else 0,'denominator':total,'evidence':members}

def tool(dataset_id,name,args):
    allowed={x[0]:x[2] for x in TOOL_SPECS}
    if name not in allowed or not isinstance(args,dict) or set(args)-set(allowed[name]): raise ValueError('无效工具或参数')
    with conn() as c:
        get_dataset(c,dataset_id)
        if name=='get_top_issues':
            rows=c.execute("SELECT c.id,c.name,c.description,c.status,COUNT(m.feedback_id) count FROM cluster c LEFT JOIN cluster_member m ON m.cluster_id=c.id WHERE c.dataset_id=? AND c.status='active' GROUP BY c.id ORDER BY count DESC,c.id",(dataset_id,)).fetchall()
            issues=[]
            for row in rows:
                item=dict(row)
                item['evidence_ids']=[x[0] for x in c.execute('SELECT feedback_id FROM cluster_member WHERE cluster_id=? ORDER BY feedback_id LIMIT 3',(item['id'],)).fetchall()]
                issues.append(item)
            return {'tool':name,'issues':issues}
        if name=='get_cluster_detail':
            if type(args.get('cluster_id')) is not int: raise ValueError('cluster_id 必须是整数')
            return {'tool':name,**cluster_detail(c,dataset_id,args['cluster_id'])}
        if name=='get_issue_trend':
            cid=args.get('cluster_id')
            if cid is not None:
                if type(cid) is not int: raise ValueError('cluster_id 必须是整数')
                cluster_detail(c,dataset_id,cid)
            sql='SELECT date_value,COUNT(*) count FROM feedback WHERE dataset_id=? AND date_value IS NOT NULL'
            params=[dataset_id]
            if cid is not None: sql+=' AND id IN (SELECT feedback_id FROM cluster_member WHERE cluster_id=?)'; params.append(cid)
            rows=c.execute(sql+' GROUP BY date_value ORDER BY date_value',params).fetchall()
            return {'tool':name,'available':bool(rows),'points':[dict(x) for x in rows], 'note':'仅按有效日期统计；无有效日期时不可比较增长'}
        if name=='compare_versions':
            versions=c.execute("SELECT DISTINCT version FROM feedback WHERE dataset_id=? AND version IS NOT NULL AND TRIM(version)<>''",(dataset_id,)).fetchall()
            if len(versions)<2: return {'tool':name,'available':False,'reason':'至少需要两个有效版本'}
            rows=c.execute('SELECT version,COUNT(*) count FROM feedback WHERE dataset_id=? GROUP BY version',(dataset_id,)).fetchall()
            return {'tool':name,'available':True,'versions':[dict(x) for x in rows]}
        if name=='search_feedback':
            query=args.get('query','')
            limit=args.get('limit',20)
            if not isinstance(query,str) or len(query)>100 or type(limit) is not int or not 1<=limit<=100: raise ValueError('搜索参数无效')
            return {'tool':name,'evidence':feedback_rows(c,dataset_id,'AND f.raw_text LIKE ?',(f'%{query}%',),limit)}
        fid=args.get('feedback_id')
        if not isinstance(fid,str) or not re.fullmatch(r'F-\d+-\d+-[a-f0-9]{8}',fid): raise ValueError('反馈 ID 无效')
        rows=feedback_rows(c,dataset_id,'AND f.id=?',(fid,),1)
        return {'tool':name,'evidence':rows[0] if rows else None}

def format_tool_answer(result):
    name=result['tool']
    if name=='get_top_issues':
        issues=result['issues']
        return '观察到的数据：'+('；'.join(f"{x['name']} {x['count']} 条（证据：{', '.join(x['evidence_ids']) or '暂无'}）" for x in issues[:5]) if issues else '暂无反馈')+'。提及数只表示频次，不等于优先级。\n可能的解释：仅凭频次无法判断根因。\n建议核查：打开主题查看原始反馈。'
    if name=='get_issue_trend': return '观察到的数据：'+('；'.join(f"{x['date_value']} {x['count']} 条" for x in result['points']) if result['available'] else '缺少有效日期，无法计算趋势')+'。\n可能的解释：趋势变化原因尚未验证。\n建议核查：结合发布与渠道记录。'
    if name=='compare_versions': return '观察到的数据：'+('；'.join(f"{x['version'] or '未标记'} {x['count']} 条" for x in result['versions']) if result['available'] else result['reason'])+'。\n可能的解释：版本差异不能直接说明因果。\n建议核查：比较相同渠道与时间窗口。'
    ev=result.get('evidence') or []
    return '观察到的数据：'+('；'.join(f"{x['id']} {x['raw_text'][:80]}" for x in ev[:5]) if ev else '没有匹配的原始反馈')+'。\n可能的解释：需更多证据。\n建议核查：核对原文和元数据。'

@app.get('/api/health')
def health(): return {'ok':True,'provider':provider().name,'model_status':model_status()}

@app.post('/api/preview')
async def preview(file:UploadFile=File(...)):
    data=await file.read()
    if len(data)>20_000_000: raise HTTPException(413,'文件超过 20 MB')
    headers,rows=parse_file(file.filename or 'upload.txt',data)
    return {'name':file.filename,'headers':headers,'rows':rows,'preview':rows[:3],'estimated':len(rows),'suggested_mapping':guess(headers)}

SAMPLE_THEMES = [
    ('导出与下载异常', ('导出', '下载', 'export', 'download'), '核心流程'),
    ('支付与订阅状态', ('付款', '支付', '扣费', '订阅', '会员', 'payment'), '交易体验'),
    ('登录与数据同步', ('登录', '验证码', '换手机', '同步', '账号'), '账号体验'),
    ('搜索与内容管理', ('搜索', '找不到', '历史记录'), '内容管理'),
    ('功能建议', ('希望', '增加', '建议', '批量', '深色模式'), '潜在需求'),
]

def sample_analysis(text):
    result = MockProvider().classify(text)
    lower = text.lower()
    result['theme'] = next((name for name, words, _ in SAMPLE_THEMES if any(word in lower for word in words)), '其他反馈')
    result['sentiment'] = 'negative' if re.search(r'卡|失败|无法|不见|收不到|扣费|慢|stuck|error', text, re.I) else 'positive' if any(word in lower for word in ('更好看', '顺手', '不错')) else 'neutral'
    return validate_analysis(result)
@app.post('/api/import')
def import_data(body:ImportBody):
    if body.source not in {'upload','sample','paste'}: raise HTTPException(400,'来源无效')
    if len(body.rows)>10000: raise HTTPException(413,'单次最多导入 10000 行')
    text_col=body.mapping.get('text')
    if text_col not in body.headers: raise HTTPException(400,'请选择有效的反馈内容列')
    if any(v and v not in body.headers for v in body.mapping.values()): raise HTTPException(400,'字段映射包含不存在的列')
    p=MockProvider() if body.source=='sample' else provider(); imported=skipped=duplicate=0; errors=[]
    with conn() as c:
        cur=c.execute('INSERT INTO dataset(name,source,imported_at,mapping,status) VALUES(?,?,?,?,?)',(body.name[:200],body.source,now(),json.dumps(body.mapping,ensure_ascii=False),'analyzing'))
        did=cur.lastrowid; seen=set()
        for number,row in enumerate(body.rows,start=2 if body.source!='paste' else 1):
            if len(row)<len(body.headers): row=row+['']*(len(body.headers)-len(row))
            values=dict(zip(body.headers,row))
            text=str(values.get(text_col) or '').strip()
            if not text: skipped+=1; continue
            digest=hashlib.sha256(text.encode()).hexdigest()
            if digest in seen: duplicate+=1; continue
            seen.add(digest)
            raw_date=str(values.get(body.mapping.get('date')) or '').strip() if body.mapping.get('date') else ''
            date_value,date_error=date_parse(raw_date)
            rating_raw=values.get(body.mapping.get('rating')) if body.mapping.get('rating') else None
            try: rating=float(rating_raw) if rating_raw not in ('',None) else None
            except (ValueError,TypeError): rating=None
            fid=f'F-{did}-{number}-{digest[:8]}'
            c.execute('INSERT INTO feedback(id,dataset_id,raw_text,row_number,source_file,date_raw,date_value,date_error,version,platform,source,rating,text_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',(fid,did,text,number,body.name,raw_date,date_value,date_error,*[str(values.get(body.mapping.get(k)) or '').strip() if body.mapping.get(k) else None for k in ('version','platform','source')],rating,digest))
            try: analysis=sample_analysis(text) if body.source=='sample' else p.classify(text)
            except Exception as exc:
                errors.append({'feedback_id':fid,'error':str(exc)[:150]})
                analysis=MockProvider().classify(text)
            c.execute('INSERT INTO feedback_analysis VALUES(?,?,?,?,?,?,?,?)',(fid,analysis['theme'],analysis['intent'],analysis['sentiment'],analysis['severity'],analysis['summary'],analysis['confidence'],p.name if not errors or errors[-1]['feedback_id']!=fid else 'mock-fallback'))
            cl=c.execute('SELECT id FROM cluster WHERE dataset_id=? AND name=?',(did,analysis['theme'])).fetchone()
            if not cl:
                clid=c.execute('INSERT INTO cluster(dataset_id,name,description,status,created_at) VALUES(?,?,?,?,?)',(did,analysis['theme'],next((tag for name,_,tag in SAMPLE_THEMES if name==analysis['theme']),'基于反馈内容整理的主题') if body.source=='sample' else '基于反馈内容整理的主题','hidden' if body.source=='sample' and analysis['theme']=='其他反馈' else 'active',now())).lastrowid
            else: clid=cl['id']
            c.execute('INSERT INTO cluster_member VALUES(?,?)',(clid,fid)); imported+=1
        status='empty' if not imported else 'partial' if errors else 'ready'
        c.execute('UPDATE dataset SET status=?,imported_count=?,skipped_count=?,duplicate_count=? WHERE id=?',(status,imported,skipped,duplicate,did))
    return {'dataset_id':did,'status':status,'imported':imported,'skipped':skipped,'duplicate':duplicate,'analysis_errors':errors[:20], 'provider':p.name}

@app.post('/api/sample')
def sample():
    path=Path(__file__).with_name('sample_feedback.csv')
    headers,rows=parse_file(path.name,path.read_bytes())
    return import_data(ImportBody(name='示例反馈 · 2026-09-01 至 09-12',headers=headers,rows=rows,mapping=guess(headers),source='sample'))

@app.get('/api/datasets')
def datasets():
    with conn() as c: return [dict(x) for x in c.execute('SELECT * FROM dataset ORDER BY id DESC').fetchall()]

@app.get('/api/datasets/{dataset_id}/overview')
def overview(dataset_id:int):
    with conn() as c:
        ds=dict(get_dataset(c,dataset_id)); total=c.execute('SELECT COUNT(*) FROM feedback WHERE dataset_id=?',(dataset_id,)).fetchone()[0]
        neg=c.execute("SELECT COUNT(*) FROM feedback f JOIN feedback_analysis a ON a.feedback_id=f.id WHERE f.dataset_id=? AND a.sentiment='negative'",(dataset_id,)).fetchone()[0]
        dated=c.execute('SELECT COUNT(*) FROM feedback WHERE dataset_id=? AND date_value IS NOT NULL',(dataset_id,)).fetchone()[0]
        versions=c.execute("SELECT COUNT(DISTINCT version) FROM feedback WHERE dataset_id=? AND version IS NOT NULL AND TRIM(version)<>''",(dataset_id,)).fetchone()[0]
        issues=tool(dataset_id,'get_top_issues',{})['issues']
        return {'dataset':ds,'total':total,'negative':neg,'negative_share':round(neg/total*100,1) if total else 0,'dated':dated,'versions':versions,'issues':issues,'provider':provider().name,'model_status':model_status()}

@app.get('/api/datasets/{dataset_id}/clusters/{cluster_id}')
def detail(dataset_id:int,cluster_id:int):
    with conn() as c: return cluster_detail(c,dataset_id,cluster_id)

@app.get('/api/datasets/{dataset_id}/feedback/{feedback_id}')
def evidence(dataset_id:int,feedback_id:str): return tool(dataset_id,'get_evidence',{'feedback_id':feedback_id})

class ReviewBody(BaseModel):
    operation:str
    name:str|None=None
    target_id:int|None=None

@app.post('/api/datasets/{dataset_id}/clusters/{cluster_id}/review')
def review(dataset_id:int,cluster_id:int,body:ReviewBody):
    with conn() as c:
        cluster_detail(c,dataset_id,cluster_id)
        if body.operation=='rename':
            if not body.name or not body.name.strip() or len(body.name)>100: raise HTTPException(400,'主题名称不能为空且最多 100 字')
            c.execute('UPDATE cluster SET name=? WHERE id=?',(body.name.strip(),cluster_id))
        elif body.operation=='remove': c.execute("UPDATE cluster SET status='hidden' WHERE id=?",(cluster_id,))
        elif body.operation=='merge':
            if not body.target_id or body.target_id==cluster_id: raise HTTPException(400,'请选择不同的目标主题')
            cluster_detail(c,dataset_id,body.target_id)
            c.execute('INSERT OR IGNORE INTO cluster_member SELECT ?,feedback_id FROM cluster_member WHERE cluster_id=?',(body.target_id,cluster_id))
            c.execute('DELETE FROM cluster_member WHERE cluster_id=?',(cluster_id,))
            c.execute("UPDATE cluster SET status='merged' WHERE id=?",(cluster_id,))
        else: raise HTTPException(400,'不支持的人工操作')
        c.execute('INSERT INTO human_review(dataset_id,cluster_id,operation,details,created_at) VALUES(?,?,?,?,?)',(dataset_id,cluster_id,body.operation,body.model_dump_json(),now()))
    return overview(dataset_id)

class ChatBody(BaseModel): question:str=Field(min_length=1,max_length=2000)
@app.post('/api/datasets/{dataset_id}/chat')
def chat(dataset_id:int,body:ChatBody):
    with conn() as c: get_dataset(c,dataset_id)
    try: return provider().chat(dataset_id,body.question)
    except Exception as exc: raise HTTPException(503,f'模型回答失败：{str(exc)[:200]}；请重试或切换模拟模式') from exc

@app.get('/api/datasets/{dataset_id}/tools/{name}')
def tool_api(dataset_id:int,name:str,cluster_id:int|None=None,query:str|None=None):
    args={}
    if cluster_id is not None: args['cluster_id']=cluster_id
    if query is not None: args['query']=query
    try: return tool(dataset_id,name,args)
    except ValueError as exc: raise HTTPException(400,str(exc)) from exc
