import assert from 'node:assert/strict';
import {
  createRouterState,
  routeMessagePartUpdated,
  routeMessagePartDelta,
} from '../lib/part-router.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  createBlocks,
  appendTextDelta,
  upsertToolPart,
  upsertReasoningStart,
  appendReasoningDelta,
  finalizeRunning,
} = require('../sidepanel/block-state.js');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---------- part-router.mjs ----------

test('text part updated → track-text (no onPart)', () => {
  const st = createRouterState();
  const r = routeMessagePartUpdated(st, { id: 'p1', type: 'text', messageID: 'm1' }, 'm1');
  assert.deepEqual(r, { action: 'track-text' });
});

test('text part delta after updated → chunk action', () => {
  const st = createRouterState();
  routeMessagePartUpdated(st, { id: 'p1', type: 'text', messageID: 'm1' }, 'm1');
  const r = routeMessagePartDelta(st, { partID: 'p1', delta: 'hello' });
  assert.deepEqual(r, { action: 'chunk', delta: 'hello' });
});

test('part belonging to a different assistant message is ignored', () => {
  const st = createRouterState();
  const r = routeMessagePartUpdated(st, { id: 'p1', type: 'text', messageID: 'OTHER' }, 'm1');
  assert.equal(r, null);
});

test('tool part updated → part action with mapped fields', () => {
  const st = createRouterState();
  const r = routeMessagePartUpdated(st, {
    id: 't1', type: 'tool', messageID: 'm1', tool: 'bash',
    state: { status: 'running', input: { command: 'yarn build' }, output: null, title: 'yarn build' },
  }, 'm1');
  assert.deepEqual(r, {
    action: 'part',
    part: { kind: 'tool', id: 't1', tool: 'bash', status: 'running', input: { command: 'yarn build' }, output: null, title: 'yarn build' },
  });
});

test('reasoning part updated (no text yet) → reasoning-start', () => {
  const st = createRouterState();
  const r = routeMessagePartUpdated(st, { id: 'r1', type: 'reasoning', messageID: 'm1' }, 'm1');
  assert.deepEqual(r, { action: 'part', part: { kind: 'reasoning-start', id: 'r1' } });
});

test('reasoning delta after reasoning-start → reasoning-delta part action', () => {
  const st = createRouterState();
  routeMessagePartUpdated(st, { id: 'r1', type: 'reasoning', messageID: 'm1' }, 'm1');
  const r = routeMessagePartDelta(st, { partID: 'r1', delta: '생각 중...' });
  assert.deepEqual(r, { action: 'part', part: { kind: 'reasoning-delta', id: 'r1', delta: '생각 중...' } });
});

test('delta for untracked partID is dropped safely (no crash)', () => {
  const st = createRouterState();
  const r = routeMessagePartDelta(st, { partID: 'unknown', delta: 'x' });
  assert.equal(r, null);
});

test('unknown part type falls back to debug action', () => {
  const st = createRouterState();
  const r = routeMessagePartUpdated(st, { id: 's1', type: 'step-start', messageID: 'm1' }, 'm1');
  assert.deepEqual(r, { action: 'debug', partType: 'step-start' });
});

// ---------- block-state.js ----------

test('appendTextDelta on empty blocks creates one text block', () => {
  const blocks = createBlocks();
  appendTextDelta(blocks, 'hi');
  assert.deepEqual(blocks, [{ type: 'text', raw: 'hi' }]);
});

test('consecutive appendTextDelta merges into same block', () => {
  const blocks = createBlocks();
  appendTextDelta(blocks, 'hi ');
  appendTextDelta(blocks, 'there');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].raw, 'hi there');
});

test('text block created after a tool card does NOT merge into pre-tool text', () => {
  const blocks = createBlocks();
  appendTextDelta(blocks, '파일을 읽을게요.');
  upsertToolPart(blocks, { id: 't1', tool: 'read', status: 'running', input: { path: 'a.js' } });
  appendTextDelta(blocks, '다 읽었습니다.');
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].type, 'text');
  assert.equal(blocks[1].type, 'tool');
  assert.equal(blocks[2].type, 'text');
  assert.equal(blocks[0].raw, '파일을 읽을게요.');
  assert.equal(blocks[2].raw, '다 읽었습니다.');
});

test('upsertToolPart with same id updates in place (no duplicate cards)', () => {
  const blocks = createBlocks();
  upsertToolPart(blocks, { id: 't1', tool: 'bash', status: 'pending', input: { command: 'ls' } });
  upsertToolPart(blocks, { id: 't1', tool: 'bash', status: 'running', input: { command: 'ls' } });
  upsertToolPart(blocks, { id: 't1', tool: 'bash', status: 'completed', input: { command: 'ls' }, output: 'a.js\nb.js' });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].status, 'completed');
  assert.equal(blocks[0].output, 'a.js\nb.js');
});

test('reasoning start + multiple deltas accumulate into single block', () => {
  const blocks = createBlocks();
  upsertReasoningStart(blocks, 'r1');
  appendReasoningDelta(blocks, 'r1', '음, ');
  appendReasoningDelta(blocks, 'r1', '이렇게 하면 될 것 같다.');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'reasoning');
  assert.equal(blocks[0].text, '음, 이렇게 하면 될 것 같다.');
});

test('appendReasoningDelta without prior start still works (defensive)', () => {
  const blocks = createBlocks();
  appendReasoningDelta(blocks, 'r1', 'late start');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, 'late start');
});

test('finalizeRunning converts pending/running tool blocks, leaves completed/error untouched', () => {
  const blocks = createBlocks();
  upsertToolPart(blocks, { id: 't1', status: 'running' });
  upsertToolPart(blocks, { id: 't2', status: 'pending' });
  upsertToolPart(blocks, { id: 't3', status: 'completed' });
  upsertToolPart(blocks, { id: 't4', status: 'error' });
  finalizeRunning(blocks, 'cancelled');
  assert.equal(blocks.find((b) => b.id === 't1').status, 'cancelled');
  assert.equal(blocks.find((b) => b.id === 't2').status, 'cancelled');
  assert.equal(blocks.find((b) => b.id === 't3').status, 'completed');
  assert.equal(blocks.find((b) => b.id === 't4').status, 'error');
});

test('raw tool input/output is stored verbatim (escaping is the renderer\'s job, not state layer\'s)', () => {
  const blocks = createBlocks();
  const xss = '<img src=x onerror=alert(1)>';
  upsertToolPart(blocks, { id: 't1', status: 'completed', output: xss });
  assert.equal(blocks[0].output, xss); // 문서화: 여기서 escape하면 렌더러가 이중 escape할 위험
});

// ---------- runner ----------

let pass = 0, fail = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message}`);
    fail++;
  }
}
console.log(`\n${pass} passed, ${fail} failed, ${tests.length} total`);
process.exit(fail === 0 ? 0 : 1);
