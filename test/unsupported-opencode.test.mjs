// 실행: node --test test/unsupported-opencode.test.mjs
// opencode 2.x(v2 API)는 아직 지원하지 않는다. 2.x는 예전 경로(/global/health 등)에 웹 UI HTML을 200으로 주고
// API는 /api/ 아래에서 인증을 요구한다(2.3.2 실측). 예전에는 이를 "서버 없음"으로 보고 서버를 계속 새로 띄웠다.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startMockOpencode } from './helpers/mock-opencode.mjs';
import { loadBackground } from './helpers/background-harness.mjs';

const MODEL = { selectedModel: { providerID: 'mock', modelID: 'model' } };

/** opencode 2.3.2처럼 응답하는 가짜 서버 */
async function startV2Server() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ _tag: 'UnauthorizedError', message: 'Authentication required' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><body>opencode</body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

test('설치된 opencode가 2.x면 띄운 서버를 정리하고 opencode-unsupported를 알리며, 쿨다운 동안 다시 띄우지 않는다', async (t) => {
  const stale = await startV2Server(); // 확장이 예전에 띄운 2.x 서버(스캔 범위 안)
  const started = await startV2Server(); // host가 새로 띄운 서버도 2.x
  const calls = [];
  const bg = await loadBackground({
    port: stale.port,
    local: MODEL,
    nativeMessage: (msg) => {
      calls.push([msg.action, msg.port]);
      if (msg.action === 'server-info') return { status: 'success', managed: msg.port === stale.port };
      if (msg.action === 'start') return { status: 'success', port: started.port, isWSL: true };
      return { status: 'success' };
    }
  });
  t.after(async () => { bg.cleanup(); await stale.close(); await started.close(); });

  const res = await bg.send({ action: 'init-server' });
  assert.equal(res.success, false);
  assert.equal(res.reason, 'opencode-unsupported');
  assert.deepEqual(calls.filter(([a]) => a === 'stop'), [['stop', stale.port], ['stop', started.port]],
    '예전 2.x 서버와 방금 띄운 2.x 서버를 모두 정리한다');
  assert.equal(calls.filter(([a]) => a === 'start').length, 1);
  assert.notEqual(bg.localStorage.managedServerPort, started.port, '2.x 서버는 확장 서버로 기록하지 않는다');

  // 사용자가 시작하지 않은 연결(탭 세션 요청 등)은 쿨다운 동안 서버를 다시 띄우지 않는다.
  await bg.send({ action: 'get-tab-session', tabId: 1, title: 't' });
  assert.equal(calls.filter(([a]) => a === 'start').length, 1);
});

test('1.x로 내린 뒤 재연결하면 남아 있던 확장의 2.x 서버를 정리하고 새 서버에 붙는다', async (t) => {
  const stale = await startV2Server();
  const v1 = await startMockOpencode();
  const calls = [];
  const bg = await loadBackground({
    port: stale.port,
    local: MODEL,
    nativeMessage: (msg) => {
      calls.push([msg.action, msg.port]);
      if (msg.action === 'server-info') return { status: 'success', managed: msg.port === stale.port };
      if (msg.action === 'start') return { status: 'success', port: v1.port, isWSL: true };
      return { status: 'success' };
    }
  });
  t.after(async () => { bg.cleanup(); await stale.close(); await v1.close(); });

  const res = await bg.send({ action: 'init-server' });
  assert.equal(res.port, v1.port);
  assert.equal(res.reason, undefined);
  assert.deepEqual(calls.filter(([a]) => a === 'stop'), [['stop', stale.port]]);
});

test('다른 프로그램이 띄운 2.x 서버는 종료하지 않는다', async (t) => {
  const foreign = await startV2Server();
  const v1 = await startMockOpencode();
  const calls = [];
  const bg = await loadBackground({
    port: foreign.port,
    local: MODEL,
    nativeMessage: (msg) => {
      calls.push([msg.action, msg.port]);
      if (msg.action === 'server-info') return { status: 'success', managed: false };
      if (msg.action === 'start') return { status: 'success', port: v1.port, isWSL: true };
      return { status: 'success' };
    }
  });
  t.after(async () => { bg.cleanup(); await foreign.close(); await v1.close(); });

  const res = await bg.send({ action: 'init-server' });
  assert.equal(res.port, v1.port);
  assert.equal(calls.filter(([a]) => a === 'stop').length, 0);
});
