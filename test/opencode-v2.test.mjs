// 실행: node --test test/opencode-v2.test.mjs
// lib/opencode-v2.mjs: v2 이벤트·기록을 1.x 모양으로 바꾸는 순수 함수. 입력은 실제 2.3.2에서 기록한 턴(test/fixtures).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createV2EventAdapter, v2ActiveToStatusMap, flattenV2History, v2FallbackFromMessages, v1ToolName, v1ToolInput, contentText, v2PermissionToAsk, v2FormToAsk, v2FormAnswer, v2List } from '../lib/opencode-v2.mjs';
import { loadFixture } from './helpers/mock-opencode-v2.mjs';

const translateAll = (events) => {
  const a = createV2EventAdapter();
  return events.flatMap((e) => a.translate(e));
};

test('도구 턴: user → assistant(parentID=user) → 도구 pending/running/completed → 텍스트 delta → idle', () => {
  const events = loadFixture('v2-turn-tool.jsonl');
  const userId = events.find((e) => e.type === 'session.inbox.delivered').data.inboxID;
  const out = translateAll(events);

  const users = out.filter((e) => e.type === 'message.updated' && e.properties.info.role === 'user');
  assert.deepEqual(users.map((e) => e.properties.info.id), [userId]);
  const assistants = out.filter((e) => e.type === 'message.updated' && e.properties.info.role === 'assistant');
  assert.equal(assistants.length, 2, '단계마다 assistant 메시지');
  assert.ok(assistants.every((e) => e.properties.info.parentID === userId));
  assert.equal(assistants[0].properties.info.modelID, 'tidepool-alpha-free');

  const tool = out.filter((e) => e.type === 'message.part.updated' && e.properties.part.type === 'tool').map((e) => e.properties.part);
  assert.deepEqual(tool.map((p) => p.state.status), ['pending', 'running', 'completed']);
  assert.equal(tool[0].tool, 'read');
  assert.equal(tool.at(-1).state.input.filePath, 'README.txt', '사이드패널이 읽는 1.x 필드도 채운다');
  assert.match(tool.at(-1).state.output, /hello spike/);
  assert.equal(tool.at(-1).messageID, assistants[0].properties.info.id);

  const textPart = out.find((e) => e.type === 'message.part.updated' && e.properties.part.type === 'text').properties.part;
  const text = out.filter((e) => e.type === 'message.part.delta' && e.properties.partID === textPart.id).map((e) => e.properties.delta).join('');
  assert.equal(text, 'It reads: "hello spike".');
  assert.equal(textPart.messageID, assistants[1].properties.info.id);
  assert.ok(out.some((e) => e.type === 'message.part.updated' && e.properties.part.type === 'reasoning'));
  assert.equal(out.at(-1).type, 'session.idle');
});

test('대기 메시지 턴: 두 번째 inbox 전달이 새 user가 되고 다음 assistant의 parentID가 바뀐다(idle은 끝에 한 번)', () => {
  const events = loadFixture('v2-turn-queued.jsonl');
  const [first, second] = events.filter((e) => e.type === 'session.inbox.delivered').map((e) => e.data.inboxID);
  const out = translateAll(events);
  const parents = out.filter((e) => e.type === 'message.updated' && e.properties.info.role === 'assistant').map((e) => e.properties.info.parentID);
  assert.deepEqual(parents, [first, second]);
  assert.equal(out.filter((e) => e.type === 'session.idle').length, 1);
});

test('중단 턴: execution.interrupted → idle(interrupted), 하위 에이전트 결과(synthetic) 전달은 새 user가 아니다', () => {
  const out = translateAll(loadFixture('v2-turn-interrupted.jsonl'));
  assert.deepEqual(out.at(-1).properties.interrupted, true);

  const a = createV2EventAdapter();
  a.translate({ type: 'session.inbox.enqueued', data: { sessionID: 's', inboxID: 'syn1', item: { type: 'synthetic' } } });
  const delivered = a.translate({ type: 'session.inbox.delivered', data: { sessionID: 's', inboxID: 'syn1' } });
  assert.ok(!delivered.some((e) => e.type === 'message.updated'));
});

test('실패·재시도·하위 세션 생성·도구 이름(shell→bash, subagent→task)', () => {
  const a = createV2EventAdapter();
  const [failed] = a.translate({ type: 'session.execution.failed', data: { sessionID: 's', error: { message: 'boom' } } });
  assert.deepEqual(failed, { type: 'session.error', properties: { sessionID: 's', error: { message: 'boom' } } });

  const [retry] = a.translate({ type: 'session.retry.scheduled', data: { sessionID: 's', attempt: 2, at: 123, error: { message: 'Rate limited' } } });
  assert.deepEqual(retry.properties.status, { type: 'retry', attempt: 2, message: 'Rate limited', next: 123 });

  const [created] = a.translate({ type: 'session.created', data: { sessionID: 'child', parentID: 's', agent: 'general' } });
  assert.deepEqual(created.properties.info, { id: 'child', parentID: 's', agent: 'general', title: undefined });

  assert.equal(v1ToolName('shell'), 'bash');
  assert.equal(v1ToolName('subagent'), 'task');
  assert.equal(v1ToolName('grep'), 'grep');
  assert.deepEqual(v1ToolInput('subagent', { agent: 'general', prompt: 'x' }), { agent: 'general', prompt: 'x', subagent_type: 'general' });
  const [progress] = a.translate({ type: 'session.tool.progress', data: { sessionID: 's', assistantMessageID: 'm', id: 'c1', name: 'subagent', metadata: { sessionID: 'child', status: 'running' } } });
  assert.equal(progress.properties.part.tool, 'task');
  assert.equal(progress.properties.part.state.metadata.sessionId, 'child', '1.x 하위 세션 연결 키');
  assert.equal(contentText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'ab');
});

test('실행 상태: running은 busy, 없으면 idle(맵에 없음)', () => {
  assert.deepEqual(v2ActiveToStatusMap({ s1: { type: 'running' }, s2: { type: 'idle' } }), { s1: { type: 'busy' } });
  assert.deepEqual(v2ActiveToStatusMap(undefined), {});
});

const HISTORY = [
  { id: 'u1', type: 'user', text: 'hi', time: { created: 1 } },
  { id: 'a1', type: 'assistant', content: [{ type: 'reasoning', text: 'r' }, { type: 'tool', state: { status: 'completed' } }], time: { created: 2 } },
  { id: 'a2', type: 'assistant', content: [{ type: 'text', text: 'hel' }, { type: 'text', text: 'lo' }], time: { created: 3 } },
  { id: 'i1', type: 'idle', outcome: 'succeeded', time: { created: 4 } },
  { id: 'u2', type: 'user', text: 'again', time: { created: 5 } },
  { id: 'a3', type: 'assistant', content: [], finish: 'error', error: { type: 'aborted', message: 'Step interrupted' }, time: { created: 6 } }
];

test('기록 평탄화: parentID를 바로 앞 user로 채우고 idle은 뺀다', () => {
  assert.deepEqual(flattenV2History(HISTORY), [
    { role: 'user', id: 'u1', parentID: null, text: 'hi' },
    { role: 'assistant', id: 'a1', parentID: 'u1', text: '' },
    { role: 'assistant', id: 'a2', parentID: 'u1', text: 'hello' },
    { role: 'user', id: 'u2', parentID: null, text: 'again' },
    { role: 'assistant', id: 'a3', parentID: 'u2', text: '' }
  ]);
});

test('폴백 내용: 정렬과 무관하게 마지막 assistant 기준, 오류·미완료 도구', () => {
  const fb = v2FallbackFromMessages([...HISTORY].reverse());
  assert.equal(fb.lastMessageId, 'a3');
  assert.equal(fb.errorMessage, 'Step interrupted');
  assert.equal(v2FallbackFromMessages(HISTORY.slice(0, 3)).content, 'hello');
  assert.equal(v2FallbackFromMessages([{ id: 'x', type: 'assistant', content: [{ type: 'tool', state: { status: 'running' } }] }]).hasUnfinishedTool, true);
  assert.deepEqual(v2FallbackFromMessages([]), { content: '', partTypes: [], lastMessageId: null });
});

// 3단계: 권한·질문(form). 형식은 2.3.2 실측(docs/opencode_v2_support_plan.md "권한"·"질문(form)").
const PERMISSION = { id: 'per_1', sessionID: 'ses_a', action: 'shell', resources: ['echo spike-bash'], save: ['echo *'], source: { type: 'tool', messageID: 'msg_1', id: 'call_1' } };
const QUESTION_FORM = {
  id: 'frm_1', sessionID: 'ses_a', title: 'Questions', metadata: { kind: 'question', tool: { messageID: 'msg_1', id: 'call_2' } },
  fields: [
    { key: 'q0', title: 'Color', description: 'Pick a color', type: 'string', options: [{ value: 'blue', label: 'Blue', description: 'cool' }, { value: 'red', label: 'Red' }], custom: true },
    { key: 'q1', title: 'Langs', description: 'Pick languages', type: 'multiselect', options: [{ value: 'js', label: 'JavaScript' }, { value: 'py', label: 'Python' }], custom: false }
  ]
};

test('권한 요청: action/resources/save → permission/patterns/always', () => {
  assert.deepEqual(v2PermissionToAsk(PERMISSION), { id: 'per_1', sessionID: 'ses_a', permission: 'shell', patterns: ['echo spike-bash'], always: ['echo *'] });
  assert.equal(v2PermissionToAsk({}), null);
});

test('question form: 필드마다 질문 하나(header·question·options·multiple·custom)와 응답용 fields', () => {
  const ask = v2FormToAsk(QUESTION_FORM);
  assert.equal(ask.unsupported, undefined);
  assert.equal(ask.v2Form, true);
  assert.deepEqual(ask.questions, [
    { header: 'Color', question: 'Pick a color', options: [{ label: 'Blue', description: 'cool' }, { label: 'Red', description: '' }], multiple: false, custom: true },
    { header: 'Langs', question: 'Pick languages', options: [{ label: 'JavaScript', description: '' }, { label: 'Python', description: '' }], multiple: true, custom: false }
  ]);
  assert.deepEqual(ask.fields.map((f) => [f.key, f.multiple]), [['q0', false], ['q1', true]]);
});

test('question이 아닌 form·다른 필드 종류는 unsupported(안내 + 건너뛰기만)', () => {
  assert.equal(v2FormToAsk({ ...QUESTION_FORM, metadata: { kind: 'mcp-elicitation' } }).unsupported, true);
  const boolField = { ...QUESTION_FORM, fields: [{ key: 'ok', title: 'OK?', type: 'boolean' }] };
  const ask = v2FormToAsk(boolField);
  assert.equal(ask.unsupported, true);
  assert.deepEqual(ask.questions, []);
});

test('form 응답: 라벨 → value, 직접 입력은 그대로, 한 개 고르기에 둘 다 오면 직접 입력, 여러 개는 배열', () => {
  const { fields } = v2FormToAsk(QUESTION_FORM);
  assert.deepEqual(v2FormAnswer(fields, [['Blue'], ['JavaScript', 'Python']]), { q0: 'blue', q1: ['js', 'py'] });
  assert.deepEqual(v2FormAnswer(fields, [['Red', 'Green'], []]), { q0: 'Green', q1: [] });
});

test('목록 응답은 배열·{data} 모두 받는다', () => {
  assert.deepEqual(v2List([1]), [1]);
  assert.deepEqual(v2List({ data: [2] }), [2]);
  assert.deepEqual(v2List(null), []);
});

test('어댑터: permission.asked·form.created → 1.x 이벤트, form 세션 id를 properties.sessionID로 올린다', () => {
  const a = createV2EventAdapter();
  const [perm] = a.translate({ type: 'permission.asked', data: PERMISSION });
  assert.equal(perm.type, 'permission.asked');
  assert.equal(perm.properties.sessionID, 'ses_a');
  assert.equal(perm.properties.permission, 'shell');
  const [replied] = a.translate({ type: 'permission.replied', data: { sessionID: 'ses_a', requestID: 'per_1', reply: 'once' } });
  assert.deepEqual(replied, { type: 'permission.replied', properties: { sessionID: 'ses_a', requestID: 'per_1', reply: 'once' } });

  const [q] = a.translate({ type: 'form.created', data: { form: QUESTION_FORM } });
  assert.equal(q.type, 'question.asked');
  assert.equal(q.properties.sessionID, 'ses_a', 'data.form.sessionID');
  assert.equal(q.properties.questions.length, 2);
  assert.deepEqual(a.translate({ type: 'form.replied', data: { sessionID: 'ses_a', id: 'frm_1', answer: { q0: 'blue' } } }),
    [{ type: 'question.replied', properties: { sessionID: 'ses_a', requestID: 'frm_1' } }]);
  assert.equal(a.translate({ type: 'form.cancelled', data: { sessionID: 'ses_a', id: 'frm_1' } })[0].type, 'question.rejected');
});

// 4단계: 목록 API 변환(형식은 OpenAPI 2.3.2 — 목록은 {location, data})
import { v2ModelsToProviders, v2DefaultModel, v2AgentsToV1, v2CommandsToV1, v2McpToV1, v2SessionToV1 } from '../lib/opencode-v2.mjs';

test('모델: providerID로 묶어 1.x providers[](models는 id 키), 꺼진·대화용이 아닌 모델은 뺀다', () => {
  const models = { location: { directory: '/w' }, data: [
    { id: 'tidepool-alpha-free', modelID: 'tp-alpha', providerID: 'opencode', name: 'Tidepool Alpha', type: 'chat', enabled: true, status: 'alpha' },
    { id: 'gpt-image', providerID: 'openai', name: 'Image', type: 'image' },
    { id: 'old', providerID: 'opencode', name: 'Old', enabled: false },
    { id: 'gpt-5', providerID: 'openai', name: 'GPT-5' }
  ] };
  const providers = { data: [{ id: 'opencode', name: 'OpenCode Zen' }] };
  const out = v2ModelsToProviders(models, providers);
  assert.deepEqual(out.map((p) => [p.id, p.name, Object.keys(p.models)]), [['opencode', 'OpenCode Zen', ['tidepool-alpha-free']], ['openai', 'openai', ['gpt-5']]]);
  assert.equal(out[0].models['tidepool-alpha-free'].name, 'Tidepool Alpha');
  assert.deepEqual(v2DefaultModel({ data: { id: 'gpt-5', providerID: 'openai' } }), { providerID: 'openai', modelID: 'gpt-5' });
  assert.equal(v2DefaultModel({ data: null }), null);
});

test('에이전트·명령·skill·MCP·세션을 1.x 모양으로', () => {
  assert.deepEqual(v2AgentsToV1({ data: [{ id: 'build', name: 'Build', mode: 'primary', hidden: false }] }).map((a) => [a.name, a.mode]), [['build', 'primary']]);
  assert.deepEqual(v2CommandsToV1({ data: [{ name: 'init', description: 'Init' }] }, { data: [{ id: 'sk1', name: 'pdf', description: 'PDF', path: '/p', content: '' }, { id: 'sk2', name: 'init', path: '/p', content: '' }] }),
    [{ name: 'init', description: 'Init' }, { name: 'pdf', description: 'PDF', source: 'skill' }]);
  assert.deepEqual(v2McpToV1({ data: [{ name: 'gh', status: { status: 'connected' } }, { name: 'x', status: { status: 'failed', error: 'boom' } }] }),
    { gh: { status: 'connected' }, x: { status: 'failed', error: 'boom' } });
  assert.deepEqual(v2SessionToV1({ id: 'ses_1', title: 'T', location: { directory: '/w' }, time: { created: 1, updated: 2 } }),
    { id: 'ses_1', parentID: undefined, title: 'T', directory: '/w', time: { created: 1, updated: 2 } });
});
