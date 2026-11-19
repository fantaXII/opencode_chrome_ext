// 테스트용 가짜 opencode 2.x 서버(v2 API). 형식은 2.3.2 실측(docs/opencode_v2_support_plan.md "0단계 실측 결과"):
//  - 예전 경로(/global/health 등)는 웹 UI HTML 200, API는 /api/ 아래
//  - password가 있으면 /api/*에 Basic Auth(사용자 opencode), 없으면 401 {"_tag":"UnauthorizedError"}
//  - SSE(/api/event)는 `data: {json}` 줄만 보낸다(id: 줄 없음, 세션 필터 없음)
//  - 대화 기록은 {data, cursor:{next}} 페이지(기본 최신순)
// 응답 턴은 실제 2.3.2에서 기록한 이벤트(test/fixtures/v2-turn-*.jsonl)를 replay()로 재생한다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/** 기록한 v2 턴 이벤트(JSON 줄) */
export function loadFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export async function startMockOpencodeV2({ password = null, version = '2.3.2', pageSize = 200 } = {}) {
  const clients = new Set();
  const state = {
    created: [],         // POST /api/session 본문
    sessions: {},        // id -> { id, title, location }
    prompts: [],         // [{ sessionId, body }]
    interrupts: [],      // POST /api/session/{id}/interrupt를 받은 id
    modelSets: [],       // [{ sessionId, model }]
    messages: {},        // id -> v2 메시지 배열(오래된 순)
    active: {},          // GET /api/session/active의 data
    activeRequests: 0,
    eventConnections: 0,
    unauthorized: [],    // 인증 없이 들어온 /api/ 경로
    // 대기 중 권한·form 목록(GET /api/permission/request, /api/form). 실측상 location별이라 x-opencode-directory를 기록한다.
    pendingPermissions: [],
    pendingForms: [],
    listDirectories: [], // [{ path, directory }]
    permissionReplies: [], // [{ sessionId, requestId, body }]
    formReplies: [],     // [{ sessionId, formId, body }]
    formDeletes: [],     // [{ sessionId, formId }]
    // 4단계 목록·설정(형식은 OpenAPI 2.3.2: 목록은 {location, data})
    models: [],          // GET /api/model의 data
    providers: [],       // GET /api/provider의 data
    defaultModel: null,  // GET /api/model/default의 data
    agents: [],          // GET /api/agent의 data
    commands: [],        // GET /api/command의 data
    skills: [],          // GET /api/skill의 data
    mcp: [],             // GET /api/mcp의 data [{name, status:{status, error?}}]
    mcpToggles: [],      // [{ name, action, directory }]
    agentSets: [],       // [{ sessionId, agent }]
    commandRuns: [],     // [{ sessionId, body }]
    reloads: [],         // POST /api/location/reload의 x-opencode-directory(없으면 null)
    sessionListRequests: [], // GET /api/session 쿼리
    listHeaders: {},     // 경로 -> 마지막 x-opencode-directory
    // (sessionId, body) => void. 기본은 아무 일도 하지 않는다(테스트가 replay로 이벤트를 보낸다)
    onPrompt: () => {}
  };

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch { resolve(null); } });
  });
  const authorized = (req) => !password || req.headers.authorization === `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    let m;
    if (!p.startsWith('/api/')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><body>opencode</body></html>');
      return;
    }
    if (!authorized(req)) {
      state.unauthorized.push(p);
      return json(res, 401, { _tag: 'UnauthorizedError', message: 'Authentication required' });
    }
    if (p === '/api/info') return json(res, 200, { version, pid: 1, hostname: null, urls: [], paths: { tmp: '/tmp' } });
    if (p === '/api/location') return json(res, 200, { directory: '/mockv2', project: { id: 'p', directory: '/mockv2', canonical: '/mockv2' } });
    if (p === '/api/event') {
      state.eventConnections++;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      clients.add(res);
      req.on('close', () => clients.delete(res));
      res.write(`data: ${JSON.stringify({ id: 'evt_connected', type: 'server.connected', data: {} })}\n\n`);
      return;
    }
    if (p === '/api/session/active') { state.activeRequests++; return json(res, 200, { data: state.active }); }
    if (p === '/api/session' && req.method === 'POST') {
      const body = await readBody(req);
      const id = `ses_v2mock${state.created.length + 1}`;
      state.created.push(body);
      state.sessions[id] = { id, title: body?.title || '', location: body?.location || { directory: '/mockv2' }, time: { created: Date.now(), updated: Date.now() } };
      return json(res, 200, { data: { ...state.sessions[id], time: { created: Date.now(), updated: Date.now() } } });
    }
    if ((m = p.match(/^\/api\/session\/([^/]+)\/prompt$/))) {
      const body = await readBody(req);
      const sessionId = decodeURIComponent(m[1]);
      state.prompts.push({ sessionId, body });
      const id = `msg_user${state.prompts.length}`;
      json(res, 200, { data: { id, sessionID: sessionId, time: { created: Date.now() }, type: 'user', payload: { text: body?.text }, delivery: body?.delivery || 'steer' } });
      setTimeout(() => state.onPrompt(sessionId, body, id), 5);
      return;
    }
    const loc = { directory: req.headers['x-opencode-directory'] || '/mockv2' };
    const list = (data) => { state.listHeaders[p] = req.headers['x-opencode-directory'] || null; return json(res, 200, { location: loc, data }); };
    if (p === '/api/model') return list(state.models);
    if (p === '/api/provider') return list(state.providers);
    if (p === '/api/model/default') return json(res, 200, { location: loc, data: state.defaultModel });
    if (p === '/api/agent') return list(state.agents);
    if (p === '/api/command') return list(state.commands);
    if (p === '/api/skill') return list(state.skills);
    if (p === '/api/mcp') return list(state.mcp);
    if ((m = p.match(/^\/api\/experimental\/mcp\/([^/]+)\/(connect|disconnect)$/)) && req.method === 'POST') {
      const name = decodeURIComponent(m[1]);
      state.mcpToggles.push({ name, action: m[2], directory: req.headers['x-opencode-directory'] || null });
      const item = state.mcp.find((x) => x.name === name);
      if (item) item.status = { status: m[2] === 'connect' ? 'connected' : 'disabled' };
      res.writeHead(204); res.end();
      return;
    }
    if (p === '/api/location/reload' && req.method === 'POST') {
      state.reloads.push(req.headers['x-opencode-directory'] || null);
      res.writeHead(204); res.end();
      return;
    }
    if (p === '/api/session' && req.method === 'GET') {
      // 최신순 페이지. 실측처럼 cursor와 order를 함께 보내면 400, 마지막 페이지에도 next가 온다.
      state.sessionListRequests.push(Object.fromEntries(url.searchParams));
      const cursor = url.searchParams.get('cursor');
      if (cursor && url.searchParams.has('order')) return json(res, 400, { _tag: 'InvalidCursorError' });
      const all = Object.values(state.sessions).sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0));
      const limit = Math.min(Number(url.searchParams.get('limit')) || 50, pageSize);
      const start = Number(cursor) || 0;
      const page = all.slice(start, start + limit);
      return json(res, 200, { data: page, cursor: { previous: null, next: page.length ? String(start + page.length) : null } });
    }
    if ((m = p.match(/^\/api\/session\/([^/]+)\/agent$/)) && req.method === 'POST') {
      state.agentSets.push({ sessionId: decodeURIComponent(m[1]), agent: (await readBody(req))?.agent });
      res.writeHead(204); res.end();
      return;
    }
    if ((m = p.match(/^\/api\/session\/([^/]+)\/command$/)) && req.method === 'POST') {
      state.commandRuns.push({ sessionId: decodeURIComponent(m[1]), body: await readBody(req) });
      res.writeHead(204); res.end();
      return;
    }
    if (p === '/api/permission/request' || p === '/api/form') {
      state.listDirectories.push({ path: p, directory: req.headers['x-opencode-directory'] || null });
      return json(res, 200, { data: p === '/api/form' ? state.pendingForms : state.pendingPermissions });
    }
    if ((m = p.match(/^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/)) && req.method === 'POST') {
      state.permissionReplies.push({ sessionId: decodeURIComponent(m[1]), requestId: decodeURIComponent(m[2]), body: await readBody(req) });
      res.writeHead(204); res.end();
      return;
    }
    if ((m = p.match(/^\/api\/session\/([^/]+)\/form\/([^/]+)\/reply$/)) && req.method === 'POST') {
      state.formReplies.push({ sessionId: decodeURIComponent(m[1]), formId: decodeURIComponent(m[2]), body: await readBody(req) });
      res.writeHead(204); res.end();
      return;
    }
    if ((m = p.match(/^\/api\/session\/([^/]+)\/form\/([^/]+)$/)) && req.method === 'DELETE') {
      state.formDeletes.push({ sessionId: decodeURIComponent(m[1]), formId: decodeURIComponent(m[2]) });
      res.writeHead(204); res.end();
      return;
    }
    if ((m = p.match(/^\/api\/session\/([^/]+)\/interrupt$/))) {
      state.interrupts.push(decodeURIComponent(m[1]));
      return json(res, 200, { interrupted: true });
    }
    if ((m = p.match(/^\/api\/session\/([^/]+)\/model$/))) {
      const body = await readBody(req);
      state.modelSets.push({ sessionId: decodeURIComponent(m[1]), model: body?.model });
      res.writeHead(204); res.end();
      return;
    }
    if ((m = p.match(/^\/api\/session\/([^/]+)\/message$/))) {
      // 실측: 커서에 정렬 방향이 들어 있어 cursor+order는 400이다. 마지막 페이지에도 next가 오고, 그 커서는 빈 목록을 준다.
      const cursor = url.searchParams.get('cursor');
      if (cursor && url.searchParams.has('order')) return json(res, 400, { _tag: 'InvalidCursorError', message: 'Cursor cannot be combined with order' });
      const all = state.messages[decodeURIComponent(m[1])] || [];
      const [order, startStr] = cursor ? cursor.split(':') : [url.searchParams.get('order') || 'desc', '0'];
      const ordered = order === 'asc' ? all : [...all].reverse();
      const limit = Math.min(Number(url.searchParams.get('limit')) || pageSize, pageSize);
      const start = Number(startStr) || 0;
      const page = ordered.slice(start, start + limit);
      const next = page.length ? `${order}:${start + page.length}` : null;
      return json(res, 200, { data: page, cursor: { previous: null, next } });
    }
    if ((m = p.match(/^\/api\/session\/([^/]+)$/))) {
      const s = state.sessions[decodeURIComponent(m[1])];
      return s ? json(res, 200, { data: s }) : json(res, 404, { _tag: 'SessionNotFoundError', sessionID: m[1], message: 'Session not found' });
    }
    json(res, 404, { _tag: 'NotFound', message: p });
  });

  /** v2 이벤트 하나를 모든 SSE 연결로 보낸다. */
  function emit(event) {
    for (const res of clients) res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  /** 기록한 턴 이벤트를 sessionId의 것으로 바꿔 순서대로 보낸다. from/to로 일부만 보낼 수 있다. */
  async function replay(events, sessionId, { from = 0, to = events.length, gapMs = 1 } = {}) {
    for (const e of events.slice(from, to)) {
      const ev = JSON.parse(JSON.stringify(e));
      if (ev.data?.sessionID) ev.data.sessionID = sessionId;
      emit(ev);
      if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
    }
  }

  function dropStreams() {
    for (const res of clients) res.end();
    clients.clear();
  }

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    state,
    emit,
    replay,
    dropStreams,
    get clientCount() { return clients.size; },
    close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); })
  };
}
