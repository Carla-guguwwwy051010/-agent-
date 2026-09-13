import importlib
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

os.environ['MODEL_PROVIDER']='mock'

@pytest.fixture
def client(tmp_path,monkeypatch):
    import app as module
    monkeypatch.setattr(module,'DB',tmp_path/'test.db')
    return TestClient(module.app)

def import_rows(client,rows,mapping=None):
    return client.post('/api/import',json={'name':'test.csv','headers':['feedback','date','version','platform'],'rows':rows,'mapping':mapping or {'text':'feedback','date':'date','version':'version','platform':'platform'},'source':'upload'})

def test_import_counts_dates_and_evidence(client):
    r=import_rows(client,[['登录验证码收不到','2026-01-01','1.0','iOS'],['登录验证码收不到','2026-01-02','1.0','Android'],[' ','','',''],['付款失败','bad date','1.1','Web']])
    assert r.status_code==200
    assert (r.json()['imported'],r.json()['skipped'],r.json()['duplicate'])==(2,1,1)
    did=r.json()['dataset_id']
    overview=client.get(f'/api/datasets/{did}/overview').json()
    assert overview['total']==2 and overview['dated']==1 and overview['versions']==2
    issue=overview['issues'][0]
    detail=client.get(f"/api/datasets/{did}/clusters/{issue['id']}").json()
    assert detail['count']==len(detail['evidence'])
    found=client.get(f'/api/datasets/{did}/tools/search_feedback?query=付款').json()['evidence'][0]
    assert found['date_raw']=='bad date' and found['date_value'] is None and found['date_error']==1
    assert client.get(f"/api/datasets/{did}/feedback/{found['id']}").json()['evidence']['raw_text']=='付款失败'

def test_missing_comparisons_and_reviews(client):
    r=import_rows(client,[['启动很慢','','','iOS'],['搜索找不到内容','','','Web']],{'text':'feedback','platform':'platform'})
    did=r.json()['dataset_id']; base=f'/api/datasets/{did}'
    assert client.get(base+'/tools/get_issue_trend').json()['available'] is False
    assert client.get(base+'/tools/compare_versions').json()['available'] is False
    issues=client.get(base+'/overview').json()['issues']; first,second=issues
    assert client.post(base+f"/clusters/{first['id']}/review",json={'operation':'rename','name':'速度问题'}).status_code==200
    assert client.post(base+f"/clusters/{first['id']}/review",json={'operation':'merge','target_id':second['id']}).status_code==200
    updated=client.get(base+'/overview').json()
    assert updated['total']==2 and updated['issues'][0]['count']==2
    assert len(client.get(base+'/tools/search_feedback?query=').json()['evidence'])==2
    assert client.post(base+f"/clusters/{second['id']}/review",json={'operation':'remove'}).json()['issues']==[]

def test_invalid_mapping_and_tool_scope(client):
    assert import_rows(client,[['hello','','','']],{'text':'missing'}).status_code==400
    did=import_rows(client,[['登录失败','','','']]).json()['dataset_id']
    assert client.get(f'/api/datasets/{did}/tools/get_evidence?query=abc').status_code==400
    assert client.post(f'/api/datasets/{did}/chat',json={'question':'提及最多的问题'}).json()['mode']=='mock'

@pytest.mark.parametrize('filename,data,expected',[
    ('a.txt',b'hello\nworld',2),
    ('a.csv',b'feedback,date\nhello,2026-01-01',1),
    ('a.tsv',b'feedback\tdate\nhello\t2026-01-01',1),
])
def test_preview_formats(client,filename,data,expected):
    r=client.post('/api/preview',files={'file':(filename,data)})
    assert r.status_code==200 and r.json()['estimated']==expected

def test_preview_excel(client):
    from io import BytesIO
    from openpyxl import Workbook
    w=Workbook();w.active.append(['feedback','date']);w.active.append(['hello','2026-01-01'])
    out=BytesIO();w.save(out)
    r=client.post('/api/preview',files={'file':('a.xlsx',out.getvalue())})
    assert r.status_code==200 and r.json()['preview'][0][0]=='hello'

def test_insufficient_balance_falls_back_to_mock(monkeypatch):
    import time
    import app as module
    monkeypatch.setenv('MODEL_PROVIDER', 'auto')
    monkeypatch.setenv('DEEPSEEK_API_KEY', 'test-key')
    monkeypatch.setitem(module._BALANCE_CACHE, 'checked', time.monotonic())
    monkeypatch.setitem(module._BALANCE_CACHE, 'status', 'insufficient_balance')
    assert module.model_status() == 'insufficient_balance'
    assert isinstance(module.provider(), module.MockProvider)

def test_reference_sample_counts(client):
    result = client.post('/api/sample')
    assert result.status_code == 200
    assert result.json()['imported'] == 16
    overview = client.get(f"/api/datasets/{result.json()['dataset_id']}/overview").json()
    assert overview['total'] == 16
    assert len(overview['issues']) == 5
    assert overview['issues'][0]['count'] == 6
    assert round(overview['negative_share']) == 56
