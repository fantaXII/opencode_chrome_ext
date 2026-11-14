// 테스트용 가짜 opencode 서버. background.js가 프롬프트 전송 경로에서 호출하는 엔드포인트만 구현한다
// (health/config/global/event/prompt_async/session/status/abort/message).
// 테스트는 emit()으로 SSE 이벤트를 밀어 넣고, onPrompt로 prompt_async 응답 방식을 정한다.
import http from 'node:http';

export async function startMockOpencode() {
  const clients = new Set();
  let eventSeq = 0;
  const state = {
    aborts: [],          // POST /session/{id}/abort를 받은 sessionID
    prompts: [],         // prompt_async를 받은 sessionID
    statusMap: {},       // GET /session/status 응답
    // 실제 opencode는 세션 상태를 디렉터리 instance별로 둔다(?directory= → x-opencode-directory → 서버 cwd 순).
    // 값을 주면 이 디렉터리로 요청했을 때만 statusMap을, 아니면 {}를 돌려준다(opencode 1.19.4 실측과 같은 동작).
    statusDirectory: null,
    statusRequests: [],  // /session/status 요청의 x-opencode-directory 값
    messages: {},        // GET /session/{id}/message 응답
    created: [],         // POST /session으로 만든 sessionID
    // 세션별 directory. opencode처럼 생성 때의 x-opencode-directory(없으면 서버 cwd '/mock')로 고정한다
    sessionDirs: {},
    promptDirs: [],      // prompt_async 요청의 x-opencode-directory 값
    deleted: [],         // DELETE /session/{id}를 받은 sessionID
    mcpRequests: [],     // /mcp 요청의 [method, path, x-opencode-directory]
    catalogRequests: [], // /command·/agent 요청의 [path, x-opencode-directory]
    sessionList: [],     // GET /session 응답
    sessionListQueries: [], // GET /session 요청의 query string
    // (req, res, sessionId) => void. 기본은 즉시 204
    onPrompt: (req, res) => { res.writeHead(204); res.end(); }
  };

  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    let m;
    if (p === '/global/health') return json(res, 200, { healthy: true, version: 'mock' });
    if (p === '/config') return json(res, 200, { model: 'mock/model' });
    if (p === '/global/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      clients.add(res);
      req.on('close', () => clients.delete(res));
      writeEvent(res, { type: 'server.connected', properties: {} });
      return;
    }
    if (p === '/session/status') {
      const dir = url.searchParams.get('directory') || req.headers['x-opencode-directory'] || null;
      state.statusRequests.push(dir);
      const visible = state.statusDirectory == null || state.statusDirectory === dir;
      return json(res, 200, visible ? state.statusMap : {});
    }
    if (p === '/command' || p === '/agent') {
      state.catalogRequests.push([p, req.headers['x-opencode-directory'] || null]);
      return json(res, 200, p === '/agent' ? [{ name: 'build', mode: 'primary' }] : [{ name: 'workcmd', template: 'do it' }]);
    }
    if (p === '/mcp' || p.startsWith('/mcp/')) {
      req.resume();
      state.mcpRequests.push([req.method, p, req.headers['x-opencode-directory'] || null]);
      return json(res, 200, p === '/mcp' ? {} : true);
    }
    if ((m = p.match(/^\/session\/([^/]+)\/prompt_async$/))) {
      state.prompts.push(m[1]);
      state.promptDirs.push(req.headers['x-opencode-directory'] || null);
      req.resume();
      return state.onPrompt(req, res, m[1]);
    }
    if ((m = p.match(/^\/session\/([^/]+)\/abort$/))) {
      state.aborts.push(m[1]);
      return json(res, 200, true);
    }
    if ((m = p.match(/^\/session\/([^/]+)\/message$/))) return json(res, 200, state.messages[m[1]] || []);
    if (p === '/session' && req.method === 'GET') {
      state.sessionListQueries.push(url.search);
      return json(res, 200, state.sessionList);
    }
    if (p === '/session' && req.method === 'POST') {
      req.resume();
      const id = `ses_mock${state.created.length + 1}`;
      state.created.push(id);
      const dir = req.headers['x-opencode-directory'];
      state.sessionDirs[id] = dir ? decodeURIComponent(dir) : '/mock';
      return json(res, 200, { id, title: 'mock', directory: state.sessionDirs[id] });
    }
    if ((m = p.match(/^\/session\/([^/]+)$/))) {
      if (req.method === 'DELETE') { state.deleted.push(m[1]); return json(res, 200, true); }
      return json(res, 200, { id: m[1], directory: state.sessionDirs[m[1]] || '/mock' });
    }
    json(res, 404, {});
  });

  function writeEvent(res, payload) {
    res.write(`id: ${++eventSeq}\ndata: ${JSON.stringify({ directory: '/mock', payload })}\n\n`);
  }

  function emit(payload) {
    for (const res of clients) writeEvent(res, payload);
  }

  // 서버가 SSE 스트림을 끊는다(네트워크 끊김·dispose 등) → 클라이언트는 재연결해야 한다
  function dropStreams() {
    for (const res of clients) res.end();
    clients.clear();
  }

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    state,
    emit,
    dropStreams,
    get clientCount() { return clients.size; },
    close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); })
  };
}

// opencode 이벤트 payload 생성기 (opencode 1.19 바이너리의 스키마와 같은 형태:
// session.status의 retry는 {attempt, message, action?, next(다음 시도 epoch ms)}).
export const ev = {
  busy: (sessionID) => ({ type: 'session.status', properties: { sessionID, status: { type: 'busy' } } }),
  retry: (sessionID, { attempt, message, next }) =>
    ({ type: 'session.status', properties: { sessionID, status: { type: 'retry', attempt, message, next } } }),
  idle: (sessionID) => ({ type: 'session.status', properties: { sessionID, status: { type: 'idle' } } }),
  // parentID = 이 응답이 답하는 user 메시지 id (opencode는 대기 메시지를 처리할 때 부모가 바뀐다, 1.19.5 실측)
  assistant: (sessionID, id = 'msg_a', parentID = 'msg_u') =>
    ({ type: 'message.updated', properties: { info: { id, sessionID, role: 'assistant', parentID, providerID: 'mock', modelID: 'model' } } }),
  user: (sessionID, id = 'msg_u') =>
    ({ type: 'message.updated', properties: { info: { id, sessionID, role: 'user' } } }),
  textPart: (sessionID, id = 'prt_t', messageID = 'msg_a') =>
    ({ type: 'message.part.updated', properties: { part: { id, sessionID, messageID, type: 'text', text: '' } } }),
  delta: (sessionID, delta, partID = 'prt_t', messageID = 'msg_a') =>
    ({ type: 'message.part.delta', properties: { sessionID, messageID, partID, field: 'text', delta } })
};
