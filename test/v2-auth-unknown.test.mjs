// 실행: node --test test/v2-auth-unknown.test.mjs
// 비밀번호를 모르는 opencode 2.x 서버. 2.x는 env로 비밀번호를 받지 않으면 실행마다 무작위 비밀번호를 건다.
// host 2.26.0 미만은 start의 auth를 몰라 비밀번호 없이 띄우므로 확장이 그 서버에 붙을 수 없다(401).
// 그대로 두면 연결할 때마다 서버를 새로 띄워 4096, 4097 …에 쌓인다. 그래서 방금 띄운 서버를 정리하고
// init-server가 reason 'host-outdated'(+ required)로 host 업데이트 안내를 띄우게 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startMockOpencode } from './helpers/mock-opencode.mjs';
import { loadBackground } from './helpers/background-harness.mjs';
import { MIN_HOST_VERSION } from '../lib/host-version.mjs';

const MODEL = { selectedModel: { providerID: 'mock', modelID: 'model' } };

/** 비밀번호를 모르는 opencode 2.3.2처럼 응답하는 가짜 서버(/api/*는 항상 401, 예전 경로는 웹 UI HTML) */
async function startLockedV2Server() {
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

test('구버전 host가 비밀번호 없이 띄운 2.x면 그 서버를 정리하고 host-outdated를 알리며, 쿨다운 동안 다시 띄우지 않는다', async (t) => {
  const stale = await startLockedV2Server(); // 확장이 예전에 띄운 2.x 서버(스캔 범위 안)
  const started = await startLockedV2Server(); // host가 새로 띄운 서버도 비밀번호를 모른다
  const calls = [];
  const bg = await loadBackground({
    port: stale.port,
    local: MODEL,
    nativeMessage: (msg) => {
      calls.push([msg.action, msg.port]);
      // 구버전 host: server-info는 있지만 비밀번호를 돌려주지 않고, start 응답에도 password가 없다.
      if (msg.action === 'server-info') return { status: 'success', managed: msg.port === stale.port };
      if (msg.action === 'start') return { status: 'success', port: started.port, isWSL: true };
      return { status: 'success' };
    }
  });
  t.after(async () => { bg.cleanup(); await stale.close(); await started.close(); });

  const res = await bg.send({ action: 'init-server' });
  assert.equal(res.success, false);
  assert.equal(res.reason, 'host-outdated');
  assert.equal(res.required, MIN_HOST_VERSION);
  assert.deepEqual(calls.filter(([a]) => a === 'stop'), [['stop', stale.port], ['stop', started.port]],
    '예전에 띄운 서버와 방금 띄운 서버를 모두 정리한다');
  assert.equal(calls.filter(([a]) => a === 'start').length, 1);
  assert.notEqual(bg.localStorage.managedServerPort, started.port, '쓸 수 없는 서버는 확장 서버로 기록하지 않는다');

  // 사용자가 시작하지 않은 연결(탭 세션 요청 등)은 쿨다운 동안 서버를 다시 띄우지 않는다.
  await bg.send({ action: 'get-tab-session', tabId: 1, title: 't' });
  assert.equal(calls.filter(([a]) => a === 'start').length, 1);
});

test('host를 업데이트한 뒤 재연결하면 남아 있던 확장의 잠긴 서버를 정리하고 새 서버에 붙는다', async (t) => {
  const stale = await startLockedV2Server();
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

test('다른 프로그램이 비밀번호를 걸고 띄운 2.x 서버는 종료하지 않는다', async (t) => {
  const foreign = await startLockedV2Server();
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
