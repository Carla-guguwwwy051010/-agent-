const NETLIFY_ORIGIN = 'https://my-agent-demo-233.netlify.app';
const LOCAL_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
const SESSION_RE = /^[A-Za-z0-9_-]{8,128}$/;
const MAX_MESSAGE_LENGTH = 2000;

function corsHeaders(origin) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
  });
  if (origin === NETLIFY_ORIGIN || LOCAL_ORIGINS.has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type');
    headers.set('Access-Control-Max-Age', '86400');
  }
  return headers;
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders(origin) });
}

function validSession(value) {
  return typeof value === 'string' && SESSION_RE.test(value);
}

function mockReply() {
  return '模拟回答：当前线上对话仅演示消息交互与 D1 历史保存，尚未读取或分析用户反馈。因此我不能给出反馈数量、趋势、根因或证据 ID。若需基于上传数据的真实洞察，请使用本地完整分析服务。';
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';
    const allowed = !origin || origin === NETLIFY_ORIGIN || LOCAL_ORIGINS.has(origin);

    if (!allowed) return json({ error: '此来源不允许访问' }, 403, origin);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (path === '/api/health' && request.method === 'GET') {
      return json({ status: 'ok', provider: 'mock', database: env.DB ? 'bound' : 'missing' }, 200, origin);
    }
    if (!env.DB) return json({ error: '数据库未绑定，请检查 Worker 的 DB 绑定' }, 503, origin);

    try {
      if (path === '/api/chat' && request.method === 'POST') {
        if (!(request.headers.get('Content-Type') || '').toLowerCase().includes('application/json')) {
          return json({ error: '请以 JSON 格式发送消息' }, 415, origin);
        }
        let body;
        try { body = await request.json(); } catch { return json({ error: 'JSON 格式无效' }, 400, origin); }
        if (!body || !validSession(body.session_id)) {
          return json({ error: 'session_id 无效，请刷新页面重试' }, 400, origin);
        }
        if (typeof body.message !== 'string' || !body.message.trim() || body.message.trim().length > MAX_MESSAGE_LENGTH) {
          return json({ error: `消息不能为空，且不能超过 ${MAX_MESSAGE_LENGTH} 字` }, 400, origin);
        }
        const message = body.message.trim();
        const reply = mockReply();
        const createdAt = new Date().toISOString();
        // D1 batch is transactional: both messages persist, or neither does.
        await env.DB.batch([
          env.DB.prepare('INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)')
            .bind(body.session_id, 'user', message, createdAt),
          env.DB.prepare('INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)')
            .bind(body.session_id, 'assistant', reply, createdAt),
        ]);
        return json({ session_id: body.session_id, reply, mode: 'mock' }, 200, origin);
      }

      if (path === '/api/history' && (request.method === 'GET' || request.method === 'DELETE')) {
        const sessionId = url.searchParams.get('session_id');
        if (!validSession(sessionId)) return json({ error: 'session_id 无效，请刷新页面重试' }, 400, origin);
        if (request.method === 'GET') {
          const result = await env.DB.prepare(
            'SELECT id, session_id, role, content, created_at FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC, id ASC'
          ).bind(sessionId).all();
          return json({ session_id: sessionId, messages: result.results || [] }, 200, origin);
        }
        const result = await env.DB.prepare('DELETE FROM chat_messages WHERE session_id = ?').bind(sessionId).run();
        return json({ session_id: sessionId, deleted: result.meta?.changes ?? 0 }, 200, origin);
      }
      if (['/api/chat', '/api/history', '/api/health'].includes(path)) {
        return json({ error: '此接口不支持该请求方法' }, 405, origin);
      }
      return json({ error: '接口不存在' }, 404, origin);
    } catch (error) {
      console.error('D1 request failed', { path, name: error?.name || 'Error' });
      return json({ error: '数据库暂时不可用，请稍后重试' }, 503, origin);
    }
  },
};
