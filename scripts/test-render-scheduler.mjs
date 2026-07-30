import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createRenderScheduler, extractLangFromClassName } = require('../sidepanel/render-scheduler.js');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function makeFakeFrames() {
  let queue = [];
  let nextId = 1;
  return {
    requestFrame: (cb) => { const id = nextId++; queue.push({ id, cb }); return id; },
    cancelFrame: (id) => { queue = queue.filter((f) => f.id !== id); },
    flushAll: () => { const q = queue; queue = []; q.forEach((f) => f.cb()); },
    pendingCount: () => queue.length,
  };
}

test('request() 여러 번 호출해도 프레임은 1개만 예약된다', () => {
  const frames = makeFakeFrames();
  let renderCalls = 0;
  const s = createRenderScheduler({ render: () => renderCalls++, requestFrame: frames.requestFrame, cancelFrame: frames.cancelFrame });
  s.request(); s.request(); s.request(); s.request(); s.request();
  assert.equal(frames.pendingCount(), 1);
  frames.flushAll();
  assert.equal(renderCalls, 1);
});

test('render()는 프레임 발화 시점의 "최신" 상태를 본다 (호출별 스냅샷이 아님)', () => {
  const frames = makeFakeFrames();
  let state = 0;
  const seen = [];
  const s = createRenderScheduler({ render: () => seen.push(state), requestFrame: frames.requestFrame, cancelFrame: frames.cancelFrame });
  s.request(); state = 1;
  s.request(); state = 2; // 이미 예약돼 있으므로 새 프레임을 추가로 잡지 않음
  s.request();
  frames.flushAll();
  assert.deepEqual(seen, [2]);
});

test('flush()는 pending 프레임이 없어도 즉시 동기적으로 render를 1회 호출한다', () => {
  const frames = makeFakeFrames();
  let renderCalls = 0;
  const s = createRenderScheduler({ render: () => renderCalls++, requestFrame: frames.requestFrame, cancelFrame: frames.cancelFrame });
  s.flush();
  assert.equal(renderCalls, 1);
  assert.equal(frames.pendingCount(), 0);
});

test('flush()는 pending 프레임을 취소하고 즉시 렌더해 중복 렌더가 발생하지 않는다', () => {
  const frames = makeFakeFrames();
  let renderCalls = 0;
  const s = createRenderScheduler({ render: () => renderCalls++, requestFrame: frames.requestFrame, cancelFrame: frames.cancelFrame });
  s.request();
  s.flush();
  assert.equal(renderCalls, 1); // flush 시점 1회
  frames.flushAll(); // 원래 예약됐던 프레임이 살아있었다면 여기서 2번째 호출이 발생했을 것
  assert.equal(renderCalls, 1);
});

test('flush() 이후 request()는 새 프레임을 다시 예약한다', () => {
  const frames = makeFakeFrames();
  let renderCalls = 0;
  const s = createRenderScheduler({ render: () => renderCalls++, requestFrame: frames.requestFrame, cancelFrame: frames.cancelFrame });
  s.flush();
  s.request();
  assert.equal(frames.pendingCount(), 1);
  frames.flushAll();
  assert.equal(renderCalls, 2);
});

test('isPending()이 예약 상태를 정확히 반영한다', () => {
  const frames = makeFakeFrames();
  const s = createRenderScheduler({ render: () => {}, requestFrame: frames.requestFrame, cancelFrame: frames.cancelFrame });
  assert.equal(s.isPending(), false);
  s.request();
  assert.equal(s.isPending(), true);
  frames.flushAll();
  assert.equal(s.isPending(), false);
});

test('extractLangFromClassName: "language-js" → "js"', () => {
  assert.equal(extractLangFromClassName('language-js'), 'js');
});

test('extractLangFromClassName: 다른 클래스와 섞여 있어도 추출', () => {
  assert.equal(extractLangFromClassName('hljs language-typescript'), 'typescript');
});

test('extractLangFromClassName: language- 클래스가 없으면 빈 문자열', () => {
  assert.equal(extractLangFromClassName('hljs'), '');
});

test('extractLangFromClassName: null/undefined 입력에도 예외 없이 빈 문자열', () => {
  assert.equal(extractLangFromClassName(null), '');
  assert.equal(extractLangFromClassName(undefined), '');
});

// ---------- runner ----------
let pass = 0, fail = 0;
for (const { name, fn } of tests) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}`); console.log(`        ${e.message}`); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed, ${tests.length} total`);
process.exit(fail === 0 ? 0 : 1);
