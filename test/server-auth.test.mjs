// 실행: node --test test/server-auth.test.mjs
// 확장이 띄운 서버의 비밀번호(OPENCODE_SERVER_PASSWORD, Basic Auth)를 다루는 흐름.
// opencode 1.19.6은 이 변수를 받으면 health·SSE를 포함한 모든 경로에 인증을 건다(실측) — mock의 password 옵션이 같은 동작이다.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startMockOpencode, ev } from './helpers/mock-opencode.mjs';
import { loadBackground, waitFor } from './helpers/background-harness.mjs';

const MODEL = { selectedModel: { providerID: 'mock', modelID: 'model' } };
const SID = 'ses_auth';

/** 아무것도 듣고 있지 않은 포트(범위 검사에서 서버가 없게 하려고) */
async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

test('host가 띄운 서버의 비밀번호로 health·세션·SSE·전송에 모두 인증을 붙인다', async (t) => {
  const PW = 'pw-started';
  const ours = await startMockOpencode({ password: PW });
  const startMessages = [];
  const bg = await loadBackground({
    port: await freePort(),
    local: MODEL,
    nativeMessage: (msg) => {
      if (msg.action === 'start') { startMessages.push(msg); return { status: 'success', port: ours.port, isWSL: true, password: PW }; }
      return { status: 'success' };
    }
  });
  t.after(async () => { bg.cleanup(); await ours.close(); });

  const res = await bg.send({ action: 'init-server' });
  assert.equal(res.port, ours.port);
  assert.equal(startMessages[0]?.auth, true, '확장은 start에 auth:true를 보내 host가 비밀번호를 걸게 한다');
  assert.deepEqual(bg.sessionStorage.serverPasswords, { [ours.port]: PW }, 'SW가 다시 떠도 쓰도록 storage.session에 둔다');

  ours.state.onPrompt = (req, res2) => {
    res2.writeHead(204); res2.end();
    setTimeout(() => {
      ours.emit(ev.busy(SID));
      ours.emit(ev.user(SID, 'msg_u'));
      ours.emit(ev.assistant(SID));
      ours.emit(ev.textPart(SID));
      ours.emit(ev.delta(SID, 'hi there'));
      ours.emit(ev.idle(SID));
    }, 20);
  };
  const sent = await bg.send({ action: 'send-message', sessionId: SID, message: 'hello' });
  assert.deepEqual(sent, { success: true });
  await waitFor(() => bg.sent.some((m) => m.action === 'message-complete' && m.sessionId === SID), 3000, 'message-complete');
  const done = bg.sent.find((m) => m.action === 'message-complete' && m.sessionId === SID);
  assert.equal(done.error, undefined);
  assert.equal(done.content, 'hi there');
  assert.deepEqual(ours.state.unauthorized, [], '인증 없이 보낸 요청이 없어야 한다');
});

test('브라우저를 다시 켜 비밀번호를 잊었으면 host의 server-info(managed)로 받아 기록된 확장 서버에 다시 붙는다', async (t) => {
  const PW = 'pw-recorded';
  const ours = await startMockOpencode({ password: PW });
  const calls = [];
  const bg = await loadBackground({
    port: await freePort(),
    local: { ...MODEL, managedServerPort: ours.port },
    nativeMessage: (msg) => {
      calls.push([msg.action, msg.port]);
      if (msg.action === 'server-info') return { status: 'success', managed: msg.port === ours.port, password: PW };
      throw new Error('unexpected ' + msg.action);
    }
  });
  t.after(async () => { bg.cleanup(); await ours.close(); });

  const res = await bg.send({ action: 'init-server' });
  assert.equal(res.port, ours.port);
  assert.ok(!calls.some(([a]) => a === 'start'), '새 서버를 띄우지 않는다');
  assert.equal(bg.sessionStorage.serverPasswords?.[ours.port], PW);
  assert.ok(bg.logs().some((l) => l.includes('recoverServerPassword')), '비밀번호 복구를 로그에 남긴다');
});

test('비밀번호를 모르는 다른 프로그램의 서버(401, managed 아님)는 건너뛰고 새 서버를 띄운다', async (t) => {
  const foreign = await startMockOpencode({ password: 'someone-elses' });
  const ours = await startMockOpencode();
  const calls = [];
  const bg = await loadBackground({
    port: foreign.port,
    local: MODEL,
    nativeMessage: (msg) => {
      calls.push(msg.action);
      if (msg.action === 'server-info') return { status: 'success', managed: false };
      if (msg.action === 'start') return { status: 'success', port: ours.port, isWSL: true };
      return { status: 'success' };
    }
  });
  t.after(async () => { bg.cleanup(); await foreign.close(); await ours.close(); });

  const res = await bg.send({ action: 'init-server' });
  assert.equal(res.port, ours.port);
  assert.ok(calls.includes('start'));
  assert.equal(bg.sessionStorage.serverPasswords?.[foreign.port], undefined, '다른 서버의 비밀번호는 알 수 없다');
  assert.ok(foreign.state.unauthorized.every((p) => p === '/global/health'), '다른 서버에는 health 확인만 한다');
});

test('host가 비밀번호를 주지 않으면(구버전 host) 예전처럼 인증 없이 동작한다', async (t) => {
  const ours = await startMockOpencode();
  const bg = await loadBackground({
    port: await freePort(),
    local: MODEL,
    nativeMessage: (msg) => (msg.action === 'start' ? { status: 'success', port: ours.port, isWSL: true } : { status: 'success' })
  });
  t.after(async () => { bg.cleanup(); await ours.close(); });

  const res = await bg.send({ action: 'init-server' });
  assert.equal(res.port, ours.port);
  assert.equal(bg.sessionStorage.serverPasswords, undefined);
});

test('API 버전을 판별한다: 1.x는 v1, 비밀번호를 아는 2.x는 v2', async (t) => {
  const PW = 'pw-v2';
  const { default: http } = await import('node:http');
  const v2 = http.createServer((req, res) => {
    const ok = req.headers.authorization === `Basic ${Buffer.from(`opencode:${PW}`).toString('base64')}`;
    if (req.url.startsWith('/api/')) {
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ok ? { version: '2.3.2', pid: 1 } : { _tag: 'UnauthorizedError', message: 'Authentication required' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html>');
  });
  await new Promise((r) => v2.listen(0, '127.0.0.1', r));
  const v2Port = v2.address().port;
  const v1 = await startMockOpencode();
  t.after(async () => { await new Promise((r) => v2.close(r)); await v1.close(); });

  const bg1 = await loadBackground({ port: v1.port, local: MODEL, nativeMessage: () => ({ status: 'success', managed: true }) });
  t.after(() => bg1.cleanup());
  assert.equal((await bg1.send({ action: 'init-server' })).apiVersion, 'v1');

  const bg2 = await loadBackground({
    port: await freePort(),
    local: MODEL,
    nativeMessage: (msg) => (msg.action === 'start' ? { status: 'success', port: v2Port, isWSL: true, password: PW } : { status: 'success' })
  });
  t.after(() => bg2.cleanup());
  const res = await bg2.send({ action: 'init-server' });
  assert.equal(res.port, v2Port);
  assert.equal(res.apiVersion, 'v2');
  assert.equal(res.version, '2.3.2');
});
