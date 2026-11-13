// 실행: node --test test/working-dir.test.mjs
// 작업 폴더는 세션별이다: opencode는 세션을 만든 폴더에 세션을 고정하고, 다른 x-opencode-directory로 보내도
// 원래 폴더에서 실행한다(1.19.5 실측). 탭 A에서 폴더를 바꿔도 탭 B의 세션은 원래 폴더로 보내야 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockOpencode, ev } from './helpers/mock-opencode.mjs';
import { loadBackground, waitFor } from './helpers/background-harness.mjs';

const X = '/work/x';
const Y = '/work/y';

async function setup() {
  const server = await startMockOpencode();
  const bg = await loadBackground({
    port: server.port,
    constants: { STREAM_QUIET_CHECK_MS: 100 },
    local: { selectedModel: { providerID: 'mock', modelID: 'model' }, workingDirectory: X }
  });
  return { server, bg, done: async () => { bg.cleanup(); await server.close(); } };
}

test('탭 A에서 폴더를 바꾸면 A만 새 세션(Y), 탭 B의 기존 세션은 원래 폴더(X)로 계속 보낸다', async (t) => {
  const { server, bg, done } = await setup();
  t.after(done);
  const a = await bg.send({ action: 'get-tab-session', tabId: 1, title: 'A' });
  const b = await bg.send({ action: 'get-tab-session', tabId: 2, title: 'B' });
  assert.equal(server.state.sessionDirs[a.sessionId], X);
  assert.equal(server.state.sessionDirs[b.sessionId], X);

  const res = await bg.send({ action: 'set-working-directory', directory: Y, tabId: 1, sessionId: a.sessionId });
  assert.equal(res.success, true);
  assert.ok(res.newSessionId, '탭 A는 새 폴더로 새 세션');
  assert.equal(server.state.sessionDirs[res.newSessionId], Y);
  assert.deepEqual(server.state.deleted, [], '이전 세션은 지우지 않는다(TUI처럼 /sessions로 이어갈 수 있게)');

  // 탭별 표시: A = Y, B = X
  assert.equal((await bg.send({ action: 'get-working-directory', sessionId: res.newSessionId })).directory, Y);
  assert.equal((await bg.send({ action: 'get-working-directory', sessionId: b.sessionId })).directory, X);
  // 새 세션의 기본값은 Y (B가 /new 하면 Y로 시작)
  const fresh = await bg.send({ action: 'create-session', title: 'n', tabId: 2 });
  assert.equal(server.state.sessionDirs[fresh.sessionId], Y);
});

test('기존 세션에 보내는 프롬프트·상태 확인은 그 세션의 폴더로 보낸다(전역 값이 바뀌어도)', async (t) => {
  const { server, bg, done } = await setup();
  t.after(done);
  const b = await bg.send({ action: 'get-tab-session', tabId: 2, title: 'B' }); // X로 생성
  const a = await bg.send({ action: 'get-tab-session', tabId: 1, title: 'A' });
  await bg.send({ action: 'set-working-directory', directory: Y, tabId: 1, sessionId: a.sessionId }); // 전역 기본값 = Y

  // 서버는 B 세션을 X instance에서만 busy로 보여 준다(실측과 같음)
  server.state.statusDirectory = X;
  server.state.statusMap = { [b.sessionId]: { type: 'busy' } };
  let finish;
  server.state.onPrompt = (req, res, sid) => {
    res.writeHead(204); res.end();
    setTimeout(async () => {
      server.emit(ev.busy(sid)); server.emit(ev.user(sid, 'msg_u')); server.emit(ev.assistant(sid));
      server.emit(ev.textPart(sid)); server.emit(ev.delta(sid, 'working...'));
      await new Promise((r) => { finish = r; });          // 조용한 상태로 오래 걸린다
      server.emit(ev.delta(sid, ' done'));
      server.state.statusMap = {};
      server.emit(ev.idle(sid));
    }, 20);
  };
  await bg.send({ action: 'send-message', sessionId: b.sessionId, message: 'hi' });
  assert.equal(server.state.promptDirs.at(-1), X, '프롬프트는 B 세션의 폴더(X)로');

  await new Promise((r) => setTimeout(r, 600)); // 상태 확인이 여러 번 돈다
  const completeB = () => bg.sent.find((m) => m.action === 'message-complete' && m.sessionId === b.sessionId);
  assert.equal(completeB(), undefined, 'Y로 상태를 물어 idle로 오인해 일찍 끝내면 안 된다');
  assert.ok(server.state.statusRequests.length > 0 && server.state.statusRequests.every((d) => d === X),
    `상태 확인은 X로: ${JSON.stringify(server.state.statusRequests)}`);
  finish();
  await waitFor(completeB, 2000, 'complete');
  assert.equal(completeB().content, 'working... done');
  assert.equal(completeB().error, undefined);
});

test('SW 재시작 등으로 세션 폴더를 모르면 서버(GET /session/{id})에서 확인한다', async (t) => {
  const { server, bg, done } = await setup();
  t.after(done);
  server.state.sessionDirs.ses_old = X;       // 이 SW가 만들지 않은 세션
  await bg.send({ action: 'switch-session', sessionId: 'ses_old', tabId: 3 });
  await chrome.storage.local.set({ workingDirectory: Y });
  const res = await bg.send({ action: 'get-working-directory', sessionId: 'ses_old' });
  assert.equal(res.directory, X);
});

test('폴더를 바꾸거나 탭을 닫아도 이전 세션은 남고, 응답 중이었다면 중단한다', async (t) => {
  const { server, bg, done } = await setup();
  t.after(done);
  const a = await bg.send({ action: 'get-tab-session', tabId: 1, title: 'A' });
  server.state.onPrompt = (req, res, sid) => {
    res.writeHead(204); res.end();
    setTimeout(() => { server.emit(ev.busy(sid)); server.emit(ev.user(sid, 'msg_u')); server.emit(ev.assistant(sid)); }, 20);
  };
  await bg.send({ action: 'send-message', sessionId: a.sessionId, message: 'long job' });
  await new Promise((r) => setTimeout(r, 80));
  const res = await bg.send({ action: 'set-working-directory', directory: Y, tabId: 1, sessionId: a.sessionId });
  assert.deepEqual(server.state.deleted, []);
  assert.deepEqual(server.state.aborts, [a.sessionId], '응답 중이던 이전 세션은 중단한다');
  assert.equal(bg.internals.eventSources.has(a.sessionId), false);

  // 다시 X로 돌아가 /sessions로 불러오면 원래 폴더(X)로 이어진다
  await bg.send({ action: 'switch-session', sessionId: a.sessionId, tabId: 1 });
  assert.equal((await bg.send({ action: 'get-working-directory', sessionId: a.sessionId })).directory, X);
  assert.ok(res.newSessionId);
});
