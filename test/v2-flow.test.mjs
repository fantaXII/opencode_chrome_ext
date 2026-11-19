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

async function setup({ local = {}, constants = {}, server = {}, before } = {}) {
  const srv = await startMockOpencodeV2({ password: PW, ...server });
  before?.(srv);
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

// 3단계: 권한·질문(form). 이벤트·목록 형식은 2.3.2 실측(docs/opencode_v2_support_plan.md). 응답 엔드포인트는 mock 기준.
const permissionAsked = (sid, id = 'per_1') => ({ id: `evt_${id}`, type: 'permission.asked', data: { id, sessionID: sid, action: 'shell', resources: ['echo spike-bash'], save: ['echo *'], source: { type: 'tool', messageID: 'msg_x', id: 'call_x' } } });
const questionForm = (sid, id = 'frm_1') => ({
  id, sessionID: sid, title: 'Questions', metadata: { kind: 'question', tool: { messageID: 'msg_x', id: 'call_q' } },
  fields: [
    { key: 'q0', title: 'Color', description: 'Pick a color', type: 'string', options: [{ value: 'blue', label: 'Blue' }, { value: 'red', label: 'Red' }], custom: true },
    { key: 'q1', title: 'Langs', description: 'Pick languages', type: 'multiselect', options: [{ value: 'js', label: 'JavaScript' }, { value: 'py', label: 'Python' }], custom: false }
  ]
});

test('권한·질문 카드: v2 요청을 1.x 카드로 보이고, 응답을 v2 엔드포인트로 보낸다(다른 세션의 요청은 거른다)', async (t) => {
  const { srv, bg, sid, complete, parts, done } = await setup();
  t.after(done);
  const called = TOOL_TURN.findIndex((e) => e.type === 'session.tool.called');
  srv.state.onPrompt = (sessionId) => srv.replay(TOOL_TURN, sessionId, { to: called + 1 });
  await bg.send({ action: 'send-message', sessionId: sid, message: 'run it' });
  await waitFor(() => parts('tool').some((p) => p.status === 'running'), 3000, 'tool running');

  srv.emit(permissionAsked(sid));
  srv.emit({ id: 'evt_other', type: 'form.created', data: { form: questionForm('ses_other', 'frm_other') } });
  srv.emit({ id: 'evt_q', type: 'form.created', data: { form: questionForm(sid) } });
  srv.emit({ id: 'evt_u', type: 'form.created', data: { form: { id: 'frm_u', sessionID: sid, title: 'Login', metadata: { kind: 'mcp' }, fields: [{ key: 'ok', type: 'boolean' }] } } });
  await waitFor(() => parts('question').length === 2 && parts('permission').length === 1, 3000, 'cards');

  const [perm] = parts('permission');
  assert.deepEqual([perm.id, perm.permission, perm.patterns, perm.always, perm.fromSubagent], ['per_1', 'shell', ['echo spike-bash'], ['echo *'], false]);
  const [q, unsupported] = parts('question');
  assert.equal(q.id, 'frm_1', '다른 세션의 form은 보이지 않는다');
  assert.deepEqual(q.questions.map((x) => [x.header, x.question, x.multiple, x.options.map((o) => o.label)]),
    [['Color', 'Pick a color', false, ['Blue', 'Red']], ['Langs', 'Pick languages', true, ['JavaScript', 'Python']]]);
  assert.equal(unsupported.unsupported, true);
  assert.equal(unsupported.title, 'Login');

  // 재오픈 시 카드 복원(메모리 보관분)
  const pending = await bg.send({ action: 'get-pending-interactions', sessionId: sid });
  assert.deepEqual(pending.items.map((i) => i.id).sort(), ['frm_1', 'frm_u', 'per_1']);

  assert.deepEqual(await bg.send({ action: 'reply-permission', sessionId: sid, requestId: 'per_1', requestSessionId: sid, reply: 'always' }), { success: true });
  assert.deepEqual(srv.state.permissionReplies, [{ sessionId: sid, requestId: 'per_1', body: { decision: 'always' } }]);
  srv.emit({ id: 'evt_pr', type: 'permission.replied', data: { sessionID: sid, requestID: 'per_1', reply: 'always' } });

  assert.deepEqual(await bg.send({ action: 'reply-question', sessionId: sid, requestId: 'frm_1', answers: [['Blue', 'teal'], ['JavaScript', 'Python']] }), { success: true });
  assert.deepEqual(srv.state.formReplies, [{ sessionId: sid, formId: 'frm_1', body: { answer: { q0: 'teal', q1: ['js', 'py'] } } }]);
  srv.emit({ id: 'evt_fr', type: 'form.replied', data: { sessionID: sid, id: 'frm_1', answer: { q0: 'teal' } } });

  assert.deepEqual(await bg.send({ action: 'reject-question', sessionId: sid, requestId: 'frm_u' }), { success: true });
  assert.deepEqual(srv.state.formDeletes, [{ sessionId: sid, formId: 'frm_u' }]);

  await waitFor(() => parts('interaction-resolved').length === 2, 3000, 'resolved');
  assert.deepEqual(parts('interaction-resolved').map((p) => p.id), ['per_1', 'frm_1']);

  await srv.replay(TOOL_TURN, sid, { from: called + 1 });
  await waitFor(() => complete(), 5000, 'message-complete');
  assert.equal(complete().error, undefined);
});

test('SW 재시작 후: 대기 중 권한·form을 서버 목록(세션 폴더)에서 복원하고, form 응답 key도 목록에서 찾는다', async (t) => {
  const { srv, bg, sid, done } = await setup();
  t.after(done);
  srv.state.pendingPermissions = [permissionAsked(sid).data, permissionAsked('ses_other', 'per_other').data];
  srv.state.pendingForms = [questionForm(sid)];

  const pending = await bg.send({ action: 'get-pending-interactions', sessionId: sid });
  assert.deepEqual(pending.items.map((i) => [i.kind, i.id]), [['permission', 'per_1'], ['question', 'frm_1']]);
  assert.equal(pending.items[0].permission, 'shell');
  assert.equal(pending.items[1].questions[1].multiple, true);
  assert.ok(srv.state.listDirectories.length >= 2 && srv.state.listDirectories.every((l) => /work/.test(l.directory || '')),
    JSON.stringify(srv.state.listDirectories));

  assert.deepEqual(await bg.send({ action: 'reply-question', sessionId: sid, requestId: 'frm_1', answers: [['Red'], []] }), { success: true });
  assert.deepEqual(srv.state.formReplies[0].body, { answer: { q0: 'red', q1: [] } });
});

// 4단계: 모델·에이전트·명령·skill·MCP·재시작·세션 목록·하위 에이전트. 형식은 OpenAPI 2.3.2(목록 {location, data}).
test('모델: 목록을 providers[]로, 고른 모델이 없으면 서버 기본 모델, 바꾸면 지금 세션에 바로 적용', async (t) => {
  const { srv, bg, sid, done } = await setup({
    local: { selectedModel: null },
    before: (s) => {
      s.state.models = [{ id: 'tidepool-alpha-free', providerID: 'opencode', name: 'Tidepool', type: 'chat' }, { id: 'gpt-5', providerID: 'openai', name: 'GPT-5' }, { id: 'img', providerID: 'openai', type: 'image' }];
      s.state.providers = [{ id: 'opencode', name: 'OpenCode Zen' }, { id: 'openai', name: 'OpenAI' }];
      s.state.defaultModel = { id: 'gpt-5', providerID: 'openai' };
    }
  });
  t.after(done);
  assert.deepEqual((await bg.send({ action: 'get-current-model' })).model, { providerID: 'openai', modelID: 'gpt-5' });
  assert.deepEqual(srv.state.created[0].model, { id: 'gpt-5', providerID: 'openai' }, '새 세션은 그 모델로 만든다');

  const { models } = await bg.send({ action: 'get-models' });
  assert.deepEqual(models.map((p) => [p.id, p.name, Object.keys(p.models)]), [['opencode', 'OpenCode Zen', ['tidepool-alpha-free']], ['openai', 'OpenAI', ['gpt-5']]]);

  assert.deepEqual(await bg.send({ action: 'set-model', providerId: 'opencode', modelName: 'tidepool-alpha-free', sessionId: sid }), { success: true });
  assert.deepEqual(srv.state.modelSets.at(-1), { sessionId: sid, model: { id: 'tidepool-alpha-free', providerID: 'opencode' } });
  const created = await bg.send({ action: 'create-session', tabId: 2 });
  assert.deepEqual(srv.state.created.at(-1).model, { id: 'tidepool-alpha-free', providerID: 'opencode' });
  assert.ok(created.success);
});

test('에이전트·명령(skill 합침)·명령 실행·MCP 목록/토글을 v2 경로로, 세션 폴더 기준으로 묻는다', async (t) => {
  const { srv, bg, sid, done } = await setup({
    before: (s) => {
      s.state.agents = [{ id: 'build', name: 'Build', mode: 'primary', hidden: false }, { id: 'explore', name: 'Explore', mode: 'subagent' }, { id: 'plan', name: 'Plan', mode: 'primary', hidden: true }];
      s.state.commands = [{ name: 'init', description: 'Init project' }];
      s.state.skills = [{ id: 'sk_pdf', name: 'pdf', description: 'PDF skill', path: '/s', content: '' }];
      s.state.mcp = [{ name: 'github', status: { status: 'disabled' } }, { name: 'bad', status: { status: 'failed', error: 'boom' } }];
    }
  });
  t.after(done);
  const agents = await bg.send({ action: 'get-agents', sessionId: sid });
  assert.deepEqual(agents.agents.map((a) => a.name), ['build'], 'primary·숨기지 않은 것만, 키는 id');
  assert.match(srv.state.listHeaders['/api/agent'] || '', /work/);
  assert.deepEqual(await bg.send({ action: 'set-agent', sessionId: sid, agentName: 'build' }), { success: true, agent: 'build' });
  assert.deepEqual(srv.state.agentSets, [{ sessionId: sid, agent: 'build' }]);

  const cmds = await bg.send({ action: 'get-commands', sessionId: sid });
  assert.deepEqual(cmds.commands.map((c) => c.name), ['init', 'pdf']);
  assert.match(srv.state.listHeaders['/api/skill'] || '', /work/);
  assert.deepEqual(await bg.send({ action: 'run-command', sessionId: sid, commandId: 'init' }), { success: true, status: 204 });
  assert.deepEqual(srv.state.commandRuns, [{ sessionId: sid, body: { name: 'init', text: '', delivery: 'queue' } }]);

  const mcp = await bg.send({ action: 'get-mcp-status', sessionId: sid });
  assert.deepEqual(mcp, { success: true, servers: { github: { status: 'disabled' }, bad: { status: 'failed', error: 'boom' } } });
  const toggled = await bg.send({ action: 'toggle-mcp', sessionId: sid, name: 'github', connect: true });
  assert.equal(toggled.success, true);
  assert.equal(toggled.servers.github.status, 'connected');
  assert.equal(srv.state.mcpToggles[0].action, 'connect');
  assert.match(srv.state.mcpToggles[0].directory || '', /work/);
});

test('소프트 재시작은 /api/location/reload(세션 폴더 헤더) 한 번이다', async (t) => {
  const { srv, bg, sid, done } = await setup();
  t.after(done);
  const res = await bg.send({ action: 'restart-instance', sessionId: sid });
  assert.equal(res.success, true, JSON.stringify(res));
  assert.equal(res.mode, 'soft');
  assert.equal(srv.state.reloads.length, 1);
  assert.match(srv.state.reloads[0] || '', /work/);
});

test('세션 목록·최근 폴더: 커서로 넘기며(order 없이) root 세션만 모으고, 대화가 있는 세션만 /sessions에 보인다', async (t) => {
  const { srv, bg, sid, done } = await setup({ server: { pageSize: 2 } });
  t.after(done);
  const now = Date.now();
  const add = (id, dir, updated, extra = {}) => { srv.state.sessions[id] = { id, title: id, location: { directory: dir }, time: { created: updated, updated }, ...extra }; };
  add('ses_a', '/proj/a', now - 1000);
  add('ses_b', '/proj/b', now - 2000);
  add('ses_child', '/proj/a', now - 500, { parentID: 'ses_a' });
  add('ses_c', '/proj/c', now - 3000);
  // 하위 에이전트 세션이 많아도 root 수를 채운다(limit은 root만 센다)
  for (let i = 0; i < 5; i++) add(`ses_kid${i}`, '/proj/a', now - 100 - i, { parentID: 'ses_a' });
  srv.state.messages.ses_a = [{ type: 'user', id: 'msg_1', text: 'hi' }];
  srv.state.messages.ses_c = [{ type: 'user', id: 'msg_2', text: 'yo' }];

  const folders = await bg.send({ action: 'get-folder-list' });
  assert.ok(folders.success);
  const recentPaths = (folders.recent || []).map((r) => r.path);
  for (const d of ['/proj/a', '/proj/b', '/proj/c']) assert.ok(recentPaths.includes(d), `${d} in ${JSON.stringify(recentPaths)}`);
  assert.ok(srv.state.sessionListRequests.length >= 3, '여러 페이지');
  assert.ok(srv.state.sessionListRequests.every((q) => !('order' in q)), 'order를 보내지 않는다');

  const list = await bg.send({ action: 'list-sessions' });
  assert.deepEqual(list.sessions.map((x) => [x.id, x.directory]), [['ses_a', '/proj/a'], ['ses_c', '/proj/c']]);
  const filtered = await bg.send({ action: 'list-sessions', directory: '/proj/c' });
  assert.deepEqual(filtered.sessions.map((x) => x.id), ['ses_c']);
  assert.ok(!list.sessions.some((x) => x.id === sid), '대화가 없는 세션은 뺀다');
});

test('서버 정보: 응답 중 세션 수는 /api/session/active, 실행 환경 정보에 apiVersion', async (t) => {
  const { srv, bg, sid, done } = await setup();
  t.after(done);
  srv.state.active = { [sid]: { type: 'running' } };
  const origin = await bg.send({ action: 'get-server-origin' });
  assert.equal(origin.busy, 1);
  const info = await bg.send({ action: 'get-runtime-info' });
  assert.equal(info.apiVersion, 'v2');
});

test('하위 에이전트: subagent 도구가 먼저 끝나도 하위 세션이 끝날 때까지 진행 중(running)으로 보인다', async (t) => {
  const { srv, bg, sid, complete, parts, done } = await setup();
  t.after(done);
  const CHILD = 'ses_child_bg';
  const e = (type, data) => srv.emit({ id: `evt_${Math.random()}`, type, data });
  srv.state.onPrompt = async (sessionId, _body, inboxID) => {
    const gap = () => new Promise((r) => setTimeout(r, 5));
    e('session.inbox.delivered', { sessionID: sessionId, inboxID }); await gap();
    e('session.step.started', { sessionID: sessionId, assistantMessageID: 'msg_a1', agent: 'build', model: { id: 'tidepool-alpha-free', providerID: 'opencode' } }); await gap();
    e('session.tool.input.started', { sessionID: sessionId, assistantMessageID: 'msg_a1', id: 'call_sub', name: 'subagent' }); await gap();
    e('session.tool.called', { sessionID: sessionId, assistantMessageID: 'msg_a1', id: 'call_sub', name: 'subagent', input: { agent: 'explore', description: 'look', prompt: 'look around' } }); await gap();
    e('session.created', { sessionID: CHILD, parentID: sessionId, agent: 'explore', title: 'look' }); await gap();
    e('session.tool.progress', { sessionID: sessionId, assistantMessageID: 'msg_a1', id: 'call_sub', metadata: { sessionID: CHILD, status: 'running' } }); await gap();
    e('session.tool.success', { sessionID: sessionId, assistantMessageID: 'msg_a1', id: 'call_sub', content: [{ type: 'text', text: 'working in the background' }], metadata: { sessionID: CHILD } }); await gap();
    e('session.step.started', { sessionID: CHILD, assistantMessageID: 'msg_c1', agent: 'explore' }); await gap();
    e('session.tool.input.started', { sessionID: CHILD, assistantMessageID: 'msg_c1', id: 'call_c', name: 'shell' }); await gap();
    e('session.execution.succeeded', { sessionID: CHILD }); await gap();
    e('session.step.started', { sessionID: sessionId, assistantMessageID: 'msg_a2', agent: 'build' }); await gap();
    e('session.text.delta', { sessionID: sessionId, assistantMessageID: 'msg_a2', ordinal: 0, delta: 'done' }); await gap();
    e('session.execution.succeeded', { sessionID: sessionId });
  };
  await bg.send({ action: 'send-message', sessionId: sid, message: 'explore' });
  await waitFor(() => complete(), 5000, 'message-complete');
  assert.equal(complete().error, undefined);
  assert.equal(complete().content, 'done');

  const tool = parts('tool').filter((p) => p.id === 'call_sub');
  assert.equal(tool.at(-1).status, 'completed');
  assert.equal(tool.at(-1).tool, 'task');
  const progress = parts('subagent');
  assert.ok(progress.length >= 2, JSON.stringify(progress));
  assert.ok(progress.every((p) => p.toolId === 'call_sub' && p.agent === 'explore'));
  assert.ok(progress.some((p) => p.running === true && p.activity?.type === 'tool' && p.activity.tool === 'bash'), '도구가 끝난 뒤에도 진행 중');
  assert.deepEqual([progress.at(-1).running, progress.at(-1).steps], [false, 1], '하위 세션 완료로 끝난다');
});
