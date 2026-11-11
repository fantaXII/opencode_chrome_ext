// 실행: node --test test/subagent-progress.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubagentTracker } from '../lib/subagent-progress.mjs';

const ROOT = 'ses_root', CHILD = 'ses_child', GRAND = 'ses_grand';
const taskPart = (metadata) => ({
  id: 'prt_task', sessionID: ROOT, type: 'tool', tool: 'task',
  state: { status: 'running', input: { subagent_type: 'explore', description: 'Extract' }, ...(metadata && { metadata }) }
});
const childPart = (type, extra = {}, sessionID = CHILD) => ({ id: `prt_${Math.random()}`, sessionID, messageID: 'msg_asst', type, ...extra });

function setup() {
  let t = 1000;
  const tr = createSubagentTracker({ rootSessionId: ROOT, now: () => t });
  return { tr, advance: (ms) => { t += ms; } };
}

test('task 파트의 metadata.sessionId로 하위 세션을 카드에 연결하고, 단계·활동을 요약한다', () => {
  const { tr } = setup();
  assert.equal(tr.onRootPart(taskPart()), null, '하위 세션 id가 없으면 연결하지 않는다');
  tr.onSessionInfo({ id: CHILD, parentID: ROOT, agent: 'explore' });
  const linked = tr.onRootPart(taskPart({ sessionId: CHILD }));
  // 하위 세션의 첫 user 메시지(task 프롬프트) text 파트는 활동이 아니다
  assert.equal(tr.onChildPart(childPart('text', { messageID: 'msg_user' })), null);
  tr.onChildMessage({ id: 'msg_asst', sessionID: CHILD, role: 'assistant' });
  assert.deepEqual(linked, { kind: 'subagent', toolId: 'prt_task', sessionId: CHILD, agent: 'explore', steps: 0, activity: null, startedAt: 1000 });

  const s1 = tr.onChildPart(childPart('step-start', { id: 'step1' }));
  assert.equal(s1.steps, 1);
  assert.deepEqual(s1.activity, { type: 'thinking' });
  assert.equal(tr.onChildPart(childPart('step-start', { id: 'step1' })), null, '같은 단계를 두 번 세지 않는다');

  const s2 = tr.onChildPart(childPart('tool', { tool: 'bash', state: { status: 'running' } }));
  assert.deepEqual(s2.activity, { type: 'tool', tool: 'bash' });
  assert.equal(tr.onChildPart(childPart('tool', { tool: 'bash', state: { status: 'running' } })), null, '변화가 없으면 보내지 않는다');
  const s3 = tr.onChildPart(childPart('tool', { tool: 'bash', state: { status: 'completed' } }));
  assert.deepEqual(s3.activity, { type: 'thinking' });
  const s4 = tr.onChildPart(childPart('text'));
  assert.deepEqual(s4.activity, { type: 'writing' });
  assert.equal(tr.onChildPart(childPart('step-finish')), null);
});

test('카드가 연결되기 전에 온 진행 상황은 쌓아 두었다가 연결 시점에 보낸다', () => {
  const { tr, advance } = setup();
  tr.onSessionInfo({ id: CHILD, parentID: ROOT, agent: 'explore' });
  assert.equal(tr.onChildPart(childPart('step-start', { id: 'a' })), null, '연결 전에는 보낼 카드가 없다');
  advance(500);
  const linked = tr.onRootPart(taskPart({ sessionId: CHILD }));
  assert.equal(linked.steps, 1);
  assert.equal(linked.startedAt, 1000, '시작 시각은 처음 본 시점');
  assert.equal(tr.onRootPart(taskPart({ sessionId: CHILD })), null, '같은 연결을 반복하지 않는다');
});

test('손자 세션(하위 에이전트가 다시 task를 씀)의 활동은 같은 카드에 합친다', () => {
  const { tr } = setup();
  tr.onChildMessage({ id: 'msg_asst', sessionID: GRAND, role: 'assistant' });
  tr.onSessionInfo({ id: CHILD, parentID: ROOT, agent: 'general' });
  tr.onRootPart(taskPart({ sessionId: CHILD }));
  assert.equal(tr.onSessionInfo({ id: GRAND, parentID: CHILD, agent: 'explore' }), null);
  const p = tr.onChildPart(childPart('tool', { tool: 'grep', state: { status: 'running' } }, GRAND));
  assert.equal(p.toolId, 'prt_task');
  assert.equal(p.sessionId, CHILD);
  assert.equal(p.agent, 'general', '카드에는 최상위 하위 에이전트 이름을 보인다');
  assert.deepEqual(p.activity, { type: 'tool', tool: 'grep' });
});

test('본 세션의 다른 도구나 다른 세션의 task 파트는 무시한다', () => {
  const { tr } = setup();
  assert.equal(tr.onRootPart({ ...taskPart({ sessionId: CHILD }), tool: 'bash' }), null);
  assert.equal(tr.onRootPart({ ...taskPart({ sessionId: CHILD }), sessionID: 'other' }), null);
  assert.equal(tr.onChildPart(childPart('text', {}, ROOT)), null, '본 세션 파트는 하위 진행이 아니다');
});
