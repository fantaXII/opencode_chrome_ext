// 실행: node --test test/stream-stall.test.mjs
// opencode가 느리거나(제공자 retry/backoff) 멈출 때 background.js의 응답 스트림 처리를 가짜 서버로 재현한다.
// 실제 background.js를 불러오고, 타임아웃만 짧게 줄인다(무응답 제한 300ms, 전송 제한 200ms).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockOpencode, ev } from './helpers/mock-opencode.mjs';
import { loadBackground, sleep, waitFor } from './helpers/background-harness.mjs';

const IDLE_MS = 300;
const SEND_MS = 200;
const SID = 'ses_test';

async function setup({ local = {}, idleMs = IDLE_MS } = {}) {
  const server = await startMockOpencode();
  const bg = await loadBackground({
    port: server.port,
    constants: { STREAM_IDLE_TIMEOUT_MS: idleMs, PROMPT_SEND_TIMEOUT_MS: SEND_MS },
    local: { selectedModel: { providerID: 'mock', modelID: 'model' }, ...local }
  });
  const forSession = (action) => bg.sent.filter((m) => m.action === action && m.sessionId === SID);
  return {
    server, bg, forSession,
    complete: () => forSession('message-complete')[0],
    done: async () => { bg.cleanup(); await server.close(); }
  };
}

// 프롬프트를 받은 뒤 응답 생성을 시작하는 공통 흐름
function startAnswering(server) {
  server.emit(ev.busy(SID));
  server.emit(ev.assistant(SID));
  server.emit(ev.textPart(SID));
}

test('재시도 대기(next)가 무응답 제한보다 길어도 중단하지 않고 응답을 받는다', async (t) => {
  const { server, bg, forSession, complete, done } = await setup();
  t.after(done);
  const backoffMs = IDLE_MS * 3; // Retry-After가 긴 레이트 리밋
  server.state.onPrompt = (req, res) => {
    res.writeHead(204); res.end();
    setTimeout(() => {
      startAnswering(server);
      server.emit(ev.retry(SID, { attempt: 1, message: 'Rate limited', next: Date.now() + backoffMs }));
      setTimeout(() => {
        server.emit(ev.busy(SID));
        server.emit(ev.delta(SID, 'hello'));
        server.emit(ev.idle(SID));
      }, backoffMs);
    }, 20);
  };

  const res = await bg.send({ action: 'send-message', sessionId: SID, message: 'hi' });
  assert.deepEqual(res, { success: true });
  await waitFor(() => complete(), backoffMs + IDLE_MS * 4, 'message-complete');

  assert.deepEqual(server.state.aborts, [], '재시도 중인 세션을 abort하면 안 된다');
  assert.equal(complete().error, undefined);
  assert.equal(complete().content, 'hello');
  // 사이드패널이 "재시도 중"을 표시할 수 있도록 retry 상태가 전달된다
  const retryParts = forSession('message-part').filter((m) => m.part?.kind === 'retry');
  assert.equal(retryParts.length, 1);
  assert.equal(retryParts[0].part.attempt, 1);
  assert.equal(retryParts[0].part.message, 'Rate limited');
  assert.equal(typeof retryParts[0].part.next, 'number');
  // 재시도가 끝나고 진행이 재개되면 해제 신호가 간다
  assert.ok(forSession('message-part').some((m) => m.part?.kind === 'retry-cleared'));
});

test('재시도 시각이 지나도 아무 이벤트가 없으면 결국 타임아웃으로 중단한다', async (t) => {
  const { server, bg, complete, done } = await setup();
  t.after(done);
  const backoffMs = IDLE_MS; // next 이후 서버가 완전히 멈춤
  let retryAt = 0;
  server.state.onPrompt = (req, res) => {
    res.writeHead(204); res.end();
    setTimeout(() => {
      startAnswering(server);
      retryAt = Date.now();
      server.emit(ev.retry(SID, { attempt: 2, message: 'Overloaded', next: retryAt + backoffMs }));
    }, 20);
  };

  await bg.send({ action: 'send-message', sessionId: SID, message: 'hi' });
  await waitFor(() => complete(), backoffMs + IDLE_MS * 6, 'timeout message-complete');
  const elapsed = complete().at - retryAt;

  assert.ok(complete().error, '타임아웃 오류가 표시되어야 한다');
  assert.deepEqual(server.state.aborts, [SID], '멈춘 세션은 서버에서도 abort한다');
  assert.ok(elapsed >= backoffMs, `재시도 시각 전에 끊으면 안 된다 (elapsed=${elapsed}ms)`);
});

test('prompt 전송이 시간 초과되면 스트림을 정리해 늦게 온 응답이 패널에 섞이지 않는다', async (t) => {
  const { server, bg, forSession, done } = await setup();
  t.after(done);
  server.state.onPrompt = (req, res) => {
    // 서버가 전송 제한보다 늦게 프롬프트를 받아들이고 처리까지 한다
    setTimeout(() => {
      if (!res.destroyed) { res.writeHead(204); res.end(); }
      startAnswering(server);
      server.emit(ev.delta(SID, 'late answer'));
      server.emit(ev.idle(SID));
    }, SEND_MS * 2);
  };

  const res = await bg.send({ action: 'send-message', sessionId: SID, message: 'hi' });
  assert.ok(res?.error, '전송 실패가 사이드패널에 알려져야 한다');
  const failedAt = Date.now();

  await sleep(SEND_MS * 4);
  const late = bg.sent.filter((m) => m.sessionId === SID && m.at >= failedAt
    && ['message-chunk', 'message-complete'].includes(m.action));
  assert.deepEqual(late.map((m) => m.action), [], '실패를 알린 뒤에는 이 프롬프트의 청크/완료가 오면 안 된다');
  assert.equal(bg.internals.eventSources.has(SID), false, 'SSE 구독이 남아 있으면 안 된다');
  assert.deepEqual(server.state.aborts, [SID], '서버에도 abort를 요청한다(서버가 아직 접수하기 전이면 효과가 없을 수 있다 — 최선 노력)');
  assert.equal(forSession('message-chunk').length, 0);
});

test('사용자가 중단한 뒤에는 남은 무응답 타이머가 뒤늦게 오류를 보내거나 세션을 abort하지 않는다', async (t) => {
  const { server, bg, done } = await setup();
  t.after(done);
  server.state.onPrompt = (req, res) => {
    res.writeHead(204); res.end();
    setTimeout(() => startAnswering(server), 20); // 응답 생성 중에 멈춤
  };

  await bg.send({ action: 'send-message', sessionId: SID, message: 'hi' });
  await sleep(50);
  await bg.send({ action: 'cancel-message', sessionId: SID });
  assert.deepEqual(server.state.aborts, [SID]); // 중단 버튼 → 서버 abort 1회
  const cancelledAt = Date.now();

  await sleep(IDLE_MS * 3);
  const late = bg.sent.filter((m) => m.sessionId === SID && m.at >= cancelledAt && m.action === 'message-complete');
  assert.deepEqual(late, [], '중단 후 타임아웃 오류가 뒤늦게 오면 안 된다');
  assert.deepEqual(server.state.aborts, [SID], '중단 후 타이머가 서버 세션을 다시 abort하면 안 된다(다음 프롬프트를 죽인다)');
});

test('작업 폴더를 지정한 상태에서 SSE가 재연결돼도 진행 중인 응답을 완료로 오인하지 않는다', async (t) => {
  const WORK = '/work/project';
  // 재연결은 끊긴 뒤 0.5초 후에 일어나므로 무응답 제한을 그보다 넉넉히 둔다(실제 값은 180초)
  const { server, bg, complete, done } = await setup({ local: { workingDirectory: WORK }, idleMs: 3000 });
  t.after(done);
  server.state.statusDirectory = WORK;               // 상태는 이 디렉터리 instance에만 있다
  server.state.statusMap = { [SID]: { type: 'busy' } };
  server.state.onPrompt = (req, res) => {
    res.writeHead(204); res.end();
    setTimeout(async () => {
      startAnswering(server);
      server.emit(ev.delta(SID, 'part1 '));
      await sleep(50);
      server.dropStreams();                          // 응답 도중 스트림이 끊긴다
      await waitFor(() => server.clientCount > 0, 5000, 'reconnect');
      await sleep(200);                              // 재연결 직후 상태 확인이 끝날 시간
      server.emit(ev.delta(SID, 'part2'));
      server.state.statusMap = {};
      server.emit(ev.idle(SID));
    }, 20);
  };

  await bg.send({ action: 'send-message', sessionId: SID, message: 'hi' });
  await waitFor(() => complete(), 6000, 'message-complete');
  assert.ok(server.state.statusRequests.length > 0, '재연결 후 상태 확인이 실행돼야 한다');
  assert.ok(server.state.statusRequests.every((d) => d === WORK), `상태 확인은 작업 폴더 instance로 보내야 한다: ${JSON.stringify(server.state.statusRequests)}`);
  assert.equal(complete().error, undefined);
  assert.equal(complete().content, 'part1 part2', '재연결 직후 응답이 잘리면 안 된다');
});

test('하위 에이전트(task)가 오래 일하면 진행 상황이 task 카드로 전달된다', async (t) => {
  const { server, bg, forSession, complete, done } = await setup();
  t.after(done);
  const CHILD = 'ses_child';
  const task = (status, metadata) => ({ type: 'message.part.updated', properties: { part: {
    id: 'prt_task', sessionID: SID, messageID: 'msg_a', type: 'tool', tool: 'task',
    state: { status, input: { subagent_type: 'explore', description: 'Extract pricing' }, ...(metadata && { metadata }) }
  } } });
  const child = (part) => ({ type: 'message.part.updated', properties: { part: { sessionID: CHILD, messageID: 'msg_c', ...part } } });
  server.state.onPrompt = (req, res) => {
    res.writeHead(204); res.end();
    setTimeout(async () => {
      startAnswering(server);
      server.emit(task('running'));
      server.emit({ type: 'session.created', properties: { info: { id: CHILD, parentID: SID, agent: 'explore', title: 'Extract pricing (@explore subagent)' } } });
      server.emit(task('running', { parentSessionId: SID, sessionId: CHILD }));
      // 하위 에이전트가 무응답 제한(300ms)보다 오래 일한다: 단계·도구가 이어진다
      for (let i = 1; i <= 4; i++) {
        await sleep(IDLE_MS / 2);
        server.emit(child({ id: `step${i}`, type: 'step-start' }));
        server.emit(child({ id: `tool${i}`, type: 'tool', tool: 'bash', state: { status: 'running' } }));
        server.emit(child({ id: `tool${i}`, type: 'tool', tool: 'bash', state: { status: 'completed' } }));
      }
      server.emit(task('completed', { parentSessionId: SID, sessionId: CHILD }));
      server.emit(ev.delta(SID, 'done'));
      server.emit(ev.idle(SID));
    }, 20);
  };

  await bg.send({ action: 'send-message', sessionId: SID, message: 'hi' });
  await waitFor(() => complete(), IDLE_MS * 10, 'message-complete');
  assert.equal(complete().error, undefined, '하위 에이전트가 일하는 동안 타임아웃되면 안 된다');

  const parts = forSession('message-part').map((m) => m.part);
  const taskCardAt = parts.findIndex((p) => p.kind === 'tool' && p.id === 'prt_task');
  const progress = parts.filter((p) => p.kind === 'subagent');
  assert.ok(taskCardAt >= 0);
  assert.ok(parts.findIndex((p) => p.kind === 'subagent') > taskCardAt, '카드가 먼저 그려진 뒤에 진행 상황이 온다');
  assert.ok(progress.every((p) => p.toolId === 'prt_task' && p.agent === 'explore'));
  assert.equal(progress.at(-1).steps, 4);
  assert.ok(progress.some((p) => p.activity?.type === 'tool' && p.activity.tool === 'bash'));
});

test('정상 흐름: 느리지만 계속 delta가 오면 무응답 제한을 넘겨도 완료된다', async (t) => {
  const { server, bg, complete, done } = await setup();
  t.after(done);
  const steps = 6; // 총 6 * (IDLE_MS/2) = IDLE_MS*3 동안 스트리밍
  server.state.onPrompt = (req, res) => {
    res.writeHead(204); res.end();
    setTimeout(async () => {
      startAnswering(server);
      for (let i = 0; i < steps; i++) { await sleep(IDLE_MS / 2); server.emit(ev.delta(SID, `${i}`)); }
      server.emit(ev.idle(SID));
    }, 20);
  };

  await bg.send({ action: 'send-message', sessionId: SID, message: 'hi' });
  await waitFor(() => complete(), IDLE_MS * 8, 'message-complete');
  assert.equal(complete().error, undefined);
  assert.equal(complete().content, '012345');
  assert.deepEqual(server.state.aborts, []);
});
