// 실행: node --test test/v2-flow.test.mjs
// opencode 2.x 서버에서의 대화 흐름(docs/opencode_v2_support_plan.md 2단계): 세션 생성(location)·전송(delivery:queue)·
// 스트리밍(v2 이벤트 → 1.x 처리)·대기 메시지·중단(interrupt)·기록(페이지·parentID)·상태 확인(/api/session/active).
// 실제 background.js를 V2_ENABLED=true로 불러오고, 응답은 실제 2.3.2에서 기록한 턴을 재생한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockOpencodeV2, loadFixture } from './helpers/mock-opencode-v2.mjs';
import { loadBackground, waitFor } from './helpers/background-harness.mjs';

const PW = 'pw-v2-flow';
const TOOL_TURN = loadFixture('v2-turn-tool.jsonl');
const QUEUED_TURN = loadFixture('v2-turn-queued.jsonl');
const INTERRUPTED_TURN = loadFixture('v2-turn-interrupted.jsonl');

async function setup({ local = {}, constants = {}, server = {} } = {}) {
  const srv = await startMockOpencodeV2({ password: PW, ...server });
  const bg = await loadBackground({
    port: srv.port,
    constants: { V2_ENABLED: 'true', ...constants },
    local: { managedServerPort: srv.port, workingDirectory: '/work', selectedModel: { providerID: 'opencode', modelID: 'tidepool-alpha-free' }, ...local },
    nativeMessage: (msg) => (msg.action === 'server-info' ? { status: 'success', managed: true, password: PW } : { status: 'success' })
  });
  const init = await bg.send({ action: 'init-server' });
  assert.equal(init.apiVersion, 'v2');
  const created = await bg.send({ action: 'create-session', tabId: 1 });
  assert.ok(created.success, JSON.stringify(created));
  const sid = created.sessionId;
  const forSession = (action) => bg.sent.filter((m) => m.action === action && m.sessionId === sid);
  return {
    srv, bg, sid, forSession,
    complete: () => forSession('message-complete')[0],
    parts: (kind) => forSession('message-part').map((m) => m.part).filter((p) => p.kind === kind),
    done: async () => { bg.cleanup(); await srv.close(); }
  };
}

test('세션을 location·모델과 함께 만들고, 도구 턴을 1.x와 같은 청크·도구 카드·완료로 받는다', async (t) => {
  const { srv, bg, sid, complete, parts, forSession, done } = await setup();
  t.after(done);
  assert.deepEqual(srv.state.created[0].location, { directory: '/work' });
  assert.deepEqual(srv.state.created[0].model, { id: 'tidepool-alpha-free', providerID: 'opencode' });

  srv.state.onPrompt = (sessionId) => srv.replay(TOOL_TURN, sessionId);
  const res = await bg.send({ action: 'send-message', sessionId: sid, message: 'read README.txt' });
  assert.deepEqual(res, { success: true });
  await waitFor(() => complete(), 5000, 'message-complete');

  assert.equal(srv.state.prompts[0].body.delivery, 'queue', '실행 중 턴에 끼워 넣지 않도록 항상 queue');
  assert.match(srv.state.prompts[0].body.text, /read README\.txt$/);
  assert.equal(srv.state.modelSets.length, 0, '세션을 만들 때 모델을 줬으면 다시 보내지 않는다');
  assert.equal(complete().error, undefined);
  assert.equal(complete().content, 'It reads: "hello spike".');
  assert.equal(forSession('message-chunk').map((m) => m.chunk ?? m.delta ?? m.content).join(''), 'It reads: "hello spike".');
  const tools = parts('tool');
  assert.deepEqual(tools.map((p) => p.status), ['pending', 'running', 'completed']);
  assert.equal(tools[0].tool, 'read');
  assert.ok(parts('reasoning-delta').length > 0);
  // 처음 연결할 때만 비밀번호를 모르고 /api/info에 401을 받은 뒤 host로 복구한다. 그 뒤 요청은 모두 인증한다.
  assert.ok(srv.state.unauthorized.every((p) => p === '/api/info'), JSON.stringify(srv.state.unauthorized));
});

test('응답 중 보낸 대기 메시지는 queue로 접수되고, inbox 전달 때 새 말풍선(turn-start)이 열린다', async (t) => {
  const { srv, bg, sid, complete, parts, done } = await setup();
  t.after(done);
  const secondEnqueue = QUEUED_TURN.findIndex((e, i) => i > 0 && e.type === 'session.inbox.enqueued');
  srv.state.onPrompt = (sessionId) => {
    if (srv.state.prompts.length === 1) return srv.replay(QUEUED_TURN, sessionId, { to: secondEnqueue });
    return srv.replay(QUEUED_TURN, sessionId, { from: secondEnqueue });
  };
  await bg.send({ action: 'send-message', sessionId: sid, message: 'count' });
  // 이 턴은 두 번째 메시지 접수 전까지 reasoning만 흐른다(실측 기록)
  await waitFor(() => srv.state.prompts.length === 1 && parts('reasoning-delta').length > 0, 3000, 'first turn streaming');
  const queued = await bg.send({ action: 'queue-message', sessionId: sid, message: 'After that, reply with just: QUEUED-OK' });
  assert.deepEqual(queued, { success: true, queued: true });
  await waitFor(() => complete(), 5000, 'message-complete');

  assert.equal(srv.state.prompts[1].body.delivery, 'queue');
  assert.deepEqual(parts('turn-start').map((p) => [p.consumed, p.newBubble]), [[1, true]]);
  assert.equal(complete().content, 'QUEUED-OK', '완료 내용은 마지막 턴의 텍스트');
});

test('중단(cancel-message)은 /interrupt로 서버 실행을 멈춘다', async (t) => {
  const { srv, bg, sid, done } = await setup();
  t.after(done);
  srv.state.onPrompt = (sessionId) => srv.replay(INTERRUPTED_TURN, sessionId, { to: 6 });
  await bg.send({ action: 'send-message', sessionId: sid, message: 'long' });
  await waitFor(() => bg.sent.some((m) => m.action === 'message-part' && m.sessionId === sid), 3000, 'streaming');
  const res = await bg.send({ action: 'cancel-message', sessionId: sid });
  assert.deepEqual(res, { success: true });
  assert.deepEqual(srv.state.interrupts, [sid]);
});

test('서버가 중단하면(execution.interrupted) 받은 내용으로 완료한다', async (t) => {
  const { srv, bg, sid, complete, done } = await setup();
  t.after(done);
  srv.state.onPrompt = (sessionId) => srv.replay(INTERRUPTED_TURN, sessionId);
  await bg.send({ action: 'send-message', sessionId: sid, message: 'long' });
  await waitFor(() => complete(), 5000, 'message-complete');
  assert.ok(complete(), '중단된 턴도 스트림을 끝낸다');
});

test('기록은 페이지를 끝까지 읽어 오래된 순으로, assistant의 parentID를 바로 앞 user로 채운다', async (t) => {
  const { srv, bg, sid, done } = await setup({ server: { pageSize: 2 } });
  t.after(done);
  srv.state.messages[sid] = [
    { id: 'u1', type: 'user', text: 'hi', time: { created: 1 } },
    { id: 'a1', type: 'assistant', content: [{ type: 'text', text: 'hello' }], time: { created: 2 } },
    { id: 'i1', type: 'idle', outcome: 'succeeded', time: { created: 3 } },
    { id: 'u2', type: 'user', text: 'again', time: { created: 4 } },
    { id: 'a2', type: 'assistant', content: [{ type: 'text', text: 'ok' }], time: { created: 5 } }
  ];
  const res = await bg.send({ action: 'get-session-history', sessionId: sid });
  assert.equal(res.success, true);
  assert.deepEqual(res.messages.map((m) => [m.role, m.id, m.parentID, m.text]), [
    ['user', 'u1', null, 'hi'],
    ['assistant', 'a1', 'u1', 'hello'],
    ['user', 'u2', null, 'again'],
    ['assistant', 'a2', 'u2', 'ok']
  ]);
});

test('완료 이벤트를 놓쳐도 조용할 때 /api/session/active로 확인해 완료하고, 실행 중이면 기다린다', async (t) => {
  const { srv, bg, sid, complete, parts, done } = await setup({ constants: { STREAM_QUIET_CHECK_MS: 200 } });
  t.after(done);
  const succeeded = TOOL_TURN.findIndex((e) => e.type === 'session.execution.succeeded');
  srv.state.active[sid] = { type: 'running' };
  srv.state.onPrompt = (sessionId) => srv.replay(TOOL_TURN, sessionId, { to: succeeded }); // 완료 이벤트 유실
  await bg.send({ action: 'send-message', sessionId: sid, message: 'read' });
  await waitFor(() => parts('heartbeat').some((p) => p.state === 'busy'), 3000, 'busy heartbeat');
  assert.equal(complete(), undefined, '서버가 실행 중이면 끝내지 않는다');
  delete srv.state.active[sid];
  await waitFor(() => complete(), 3000, 'message-complete');
  assert.equal(complete().content, 'It reads: "hello spike".');
});

test('스트림이 끊겼다 다시 붙으면 실행 상태로 놓친 완료를 확인한다(v2는 재전송하지 않는다)', async (t) => {
  const { srv, bg, sid, complete, done } = await setup();
  t.after(done);
  const succeeded = TOOL_TURN.findIndex((e) => e.type === 'session.execution.succeeded');
  srv.state.onPrompt = async (sessionId) => {
    await srv.replay(TOOL_TURN, sessionId, { to: succeeded });
    srv.dropStreams(); // 완료 직전에 연결이 끊기고, 그 사이 서버는 실행을 마쳤다
  };
  await bg.send({ action: 'send-message', sessionId: sid, message: 'read' });
  await waitFor(() => complete(), 5000, 'message-complete');
  assert.ok(srv.state.eventConnections >= 2, '다시 연결했다');
  assert.equal(complete().content, 'It reads: "hello spike".');
});

test('SW가 응답 중에 다시 떴으면 /api/session/active로 끝나기를 기다렸다가 기록에서 내용을 회수한다', async (t) => {
  const srv = await startMockOpencodeV2({ password: PW });
  const sid = 'ses_recover';
  srv.state.sessions[sid] = { id: sid, location: { directory: '/work' } };
  srv.state.active[sid] = { type: 'running' };
  srv.state.messages[sid] = [
    { id: 'u1', type: 'user', text: 'hi', time: { created: 1 } },
    { id: 'a1', type: 'assistant', content: [{ type: 'text', text: 'recovered answer' }], time: { created: 2 } }
  ];
  // SW가 죽기 전에 남긴 기록: 응답 중이던 세션(pendingPrompts)과 서버 비밀번호
  const bg = await loadBackground({
    port: srv.port,
    constants: { V2_ENABLED: 'true' },
    local: { managedServerPort: srv.port },
    session: {
      serverPasswords: { [srv.port]: PW },
      pendingPrompts: { [sid]: { port: srv.port, startedAt: Date.now(), directory: '/work' } }
    },
    nativeMessage: (msg) => (msg.action === 'server-info' ? { status: 'success', managed: true, password: PW } : { status: 'success' })
  });
  t.after(async () => { bg.cleanup(); await srv.close(); });
  await waitFor(() => srv.state.activeRequests > 0, 3000, 'status polled via /api/session/active');
  const busyOnly = bg.sent.filter((m) => m.sessionId === sid && m.action === 'message-complete');
  assert.equal(busyOnly.length, 0, '실행 중인 동안은 끝내지 않는다');
  delete srv.state.active[sid];
  await waitFor(() => bg.sent.some((m) => m.action === 'message-complete' && m.sessionId === sid), 8000, 'recovered message-complete');
  const done = bg.sent.find((m) => m.action === 'message-complete' && m.sessionId === sid);
  assert.equal(done.content, 'recovered answer');
  assert.equal(done.recovered, true);
  assert.deepEqual(srv.state.unauthorized, []);
});

test('탭 전환 복원: 응답 중 기록의 진행 중 턴(parentID)이 스냅샷의 turnParentId와 같다', async (t) => {
  const { srv, bg, sid, done } = await setup();
  t.after(done);
  const userId = TOOL_TURN.find((e) => e.type === 'session.inbox.delivered').data.inboxID;
  const textStart = TOOL_TURN.findIndex((e) => e.type === 'session.text.started');
  srv.state.onPrompt = (sessionId) => srv.replay(TOOL_TURN, sessionId, { to: textStart + 3 }); // 텍스트 일부까지만
  await bg.send({ action: 'send-message', sessionId: sid, message: 'read' });
  await waitFor(() => bg.sent.some((m) => m.action === 'message-chunk' && m.sessionId === sid), 3000, 'streaming text');
  // 서버 기록: 이 턴의 user와 진행 중인 assistant 단계들
  srv.state.messages[sid] = [
    { id: userId, type: 'user', text: 'read', time: { created: 1 } },
    { id: 'a_step1', type: 'assistant', content: [{ type: 'tool', state: { status: 'completed' } }], time: { created: 2 } },
    { id: 'a_step2', type: 'assistant', content: [{ type: 'text', text: 'It' }], time: { created: 3 } }
  ];
  const res = await bg.send({ action: 'get-session-history', sessionId: sid });
  assert.equal(res.stream.turnParentId, userId);
  const inTurn = res.messages.filter((m) => m.role === 'assistant' && m.parentID === res.stream.turnParentId);
  assert.deepEqual(inTurn.map((m) => m.id), ['a_step1', 'a_step2'], '사이드패널이 빼고 스냅샷으로 다시 그릴 메시지');
  assert.ok(res.stream.text.length > 0);
});
