// 실행: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeepAlive, createPendingStore, recoverPendingPrompt } from '../lib/sw-resilience.mjs';

const memStorage = () => { const d = {}; return { get: async (k) => ({ [k]: d[k] }), set: async (o) => Object.assign(d, o), d }; };

// ── 재현: MV3 SW 모델 ──────────────────────────────────────────────
// 가짜 SW: 마지막 "확장 API 활동" 후 30초가 지나면 종료. ping이 활동으로 계산된다.
function simulateSW({ withKeepAlive, quietMs }) {
  let t = 0, lastActivity = 0, alive = true, timers = [];
  const setI = (fn, ms) => { const h = { fn, ms, next: ms }; timers.push(h); return h; };
  const clrI = (h) => { timers = timers.filter((x) => x !== h); };
  const ka = createKeepAlive({ ping: () => { lastActivity = t; }, setIntervalFn: setI, clearIntervalFn: clrI });
  if (withKeepAlive) ka.acquire('ses');
  while (t < quietMs) {
    t += 1000;
    for (const h of timers) if (t >= h.next) { h.fn(); h.next += h.ms; }
    if (t - lastActivity >= 30000) { alive = false; break; }   // 30s idle → 종료
  }
  return alive;
}

test('재현: keepalive 없으면 프롬프트 응답 대기 중(90s 무이벤트) SW가 종료된다', () => {
  assert.equal(simulateSW({ withKeepAlive: false, quietMs: 90000 }), false);
});
test('수정: keepalive가 있으면 90s 무이벤트에도 SW가 유지된다', () => {
  assert.equal(simulateSW({ withKeepAlive: true, quietMs: 90000 }), true);
});

test('keepalive: 마지막 holder가 release되면 타이머가 해제된다', () => {
  let cleared = 0;
  const ka = createKeepAlive({ ping() {}, setIntervalFn: () => 1, clearIntervalFn: () => { cleared++; } });
  ka.acquire('a'); ka.acquire('b');
  ka.release('a'); assert.equal(ka.active, true); assert.equal(cleared, 0);
  ka.release('b'); assert.equal(ka.active, false); assert.equal(cleared, 1);
  ka.release('b'); assert.equal(cleared, 1); // 멱등
});

test('pending store: 동시 add/remove에도 항목이 유실되지 않는다', async () => {
  const st = memStorage(); const store = createPendingStore(st);
  await Promise.all([store.add('a', 4096), store.add('b', 4096), store.remove('a'), store.add('c', 4097)]);
  const ids = (await store.list()).map((x) => x.sessionId).sort();
  assert.deepEqual(ids, ['b', 'c']);
});

// ── 복구 ──────────────────────────────────────────────────────────
const statusFetch = (seq) => async () => ({ ok: true, json: async () => seq.shift() ?? {} });

test('복구: busy 동안 폴링하다 idle이 되면 REST 내용으로 완료 처리', async () => {
  let t = 0; const out = [];
  await recoverPendingPrompt({
    sessionId: 's1', port: 4096, startedAt: 0,
    fetchFn: statusFetch([{ s1: {} }, { s1: {} }, {}]),
    fetchContent: async () => ({ content: '답변' }),
    onComplete: (c, e) => out.push([c, e]),
    now: () => t, sleep: async (ms) => { t += ms; }
  });
  assert.deepEqual(out, [['답변', null]]);
});

test('복구: 작업 폴더로 보낸 프롬프트는 그 디렉터리 instance의 상태로 판단한다', async () => {
  // opencode는 세션 상태를 디렉터리 instance별로 둔다. 헤더 없이 물으면 {}(= idle)로 보여 응답 도중 끊는다.
  let t = 0; const out = []; const seen = [];
  const fetchFn = async (url, init = {}) => {
    const dir = init.headers?.['x-opencode-directory'] || null;
    seen.push(dir);
    const busy = dir === '/work' && t < 6000;   // 이 instance에서만 busy가 보인다
    return { ok: true, json: async () => (busy ? { s1: { type: 'busy' } } : {}) };
  };
  await recoverPendingPrompt({
    sessionId: 's1', port: 4096, startedAt: 0, directory: '/work', fetchFn,
    fetchContent: async () => ({ content: t >= 6000 ? '완성된 답변' : '잘린 답' }),
    onComplete: (c, e) => out.push([c, e]),
    now: () => t, sleep: async (ms) => { t += ms; }
  });
  assert.deepEqual(out, [['완성된 답변', null]]);
  assert.ok(seen.every((d) => d === '/work'));
});

test('pending store: 디렉터리를 함께 저장한다', async () => {
  const store = createPendingStore(memStorage(), () => 5);
  await store.add('s1', 4096, '/work'); await store.add('s2', 4096);
  assert.deepEqual(await store.list(), [
    { sessionId: 's1', port: 4096, startedAt: 5, directory: '/work' },
    { sessionId: 's2', port: 4096, startedAt: 5 }
  ]);
});

test('복구: idle인데 내용이 없으면 UI가 풀리도록 오류로 완료 처리', async () => {
  const out = [];
  await recoverPendingPrompt({
    sessionId: 's1', port: 4096, startedAt: 0,
    fetchFn: statusFetch([{}]), fetchContent: async () => ({ content: '' }),
    onComplete: (c, e) => out.push([c, e]), now: () => 0, sleep: async () => {}
  });
  assert.equal(out.length, 1); assert.ok(out[0][1]);
});

test('복구: 제한 시간이 없으면 서버가 busy인 동안 계속 기다리고, 끝나면 내용을 받는다', async () => {
  // 느린 LLM: 10분 넘게 busy. 예전 180초 상한이면 여기서 끊겼다.
  let t = 0; const out = []; let busyCalls = 0;
  await recoverPendingPrompt({
    sessionId: 's1', port: 4096, startedAt: 0,
    fetchFn: async () => ({ ok: true, json: async () => (t < 600000 ? { s1: { type: 'busy' } } : {}) }),
    fetchContent: async () => ({ content: '늦은 답변' }),
    onBusy: () => { busyCalls++; },
    onComplete: (c, e) => out.push([c, e]), now: () => t, sleep: async (ms) => { t += ms; }
  });
  assert.deepEqual(out, [['늦은 답변', null]]);
  assert.ok(busyCalls > 0, '대기 중에는 진행 표시용 onBusy가 불린다');
});

test('복구: 제한 시간을 설정했으면 그 시간 뒤에 시간 초과로 완료 처리', async () => {
  let t = 0; const out = [];
  await recoverPendingPrompt({
    sessionId: 's1', port: 4096, startedAt: 0, maxAgeMs: 300000,
    fetchFn: async () => ({ ok: true, json: async () => ({ s1: {} }) }),
    fetchContent: async () => ({ content: '' }),
    onComplete: (c, e) => out.push([c, e]), now: () => t, sleep: async (ms) => { t += ms; }
  });
  assert.deepEqual(out, [['', '응답 시간 초과']]);
  assert.ok(t >= 300000);
});

test('복구: 서버에 계속 접속할 수 없으면 제한 시간이 없어도 포기한다', async () => {
  let t = 0; const out = [];
  await recoverPendingPrompt({
    sessionId: 's1', port: 4096, startedAt: 0,
    fetchFn: async () => { throw new Error('refused'); }, fetchContent: async () => ({ content: 'x' }),
    onComplete: (c, e) => out.push([c, e]), now: () => t, sleep: async (ms) => { t += ms; }
  });
  assert.equal(out.length, 1);
  assert.equal(out[0][0], '');
  assert.match(out[0][1], /서버에 연결할 수 없어/);
  assert.ok(t >= 60000 && t < 70000, `unreachable 한도(60s) 근처에서 포기해야 한다: ${t}`);
});

test('pending store: 응답 제한 시간을 함께 저장한다(0이면 생략)', async () => {
  const store = createPendingStore(memStorage(), () => 5);
  await store.add('s1', 4096, null, 300000); await store.add('s2', 4096, null, 0);
  assert.deepEqual(await store.list(), [
    { sessionId: 's1', port: 4096, startedAt: 5, timeoutMs: 300000 },
    { sessionId: 's2', port: 4096, startedAt: 5 }
  ]);
});
