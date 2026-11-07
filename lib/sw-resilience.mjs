/**
 * MV3 Service Worker 종료 대응 유틸 (chrome API에 직접 의존하지 않아 Node에서 테스트 가능)
 *
 * 배경: SW는 확장 API 이벤트 없이 ~30초가 지나면 종료되고, 진행 중인 fetch 스트림(SSE)과
 * 타임아웃 타이머는 함께 사라져 사이드패널이 영원히 응답을 기다린다.
 *  1) createKeepAlive: 응답 대기 중 주기적으로 확장 API를 호출해 SW 종료를 막는다.
 *  2) createPendingStore: 응답 중인 세션을 저장해 SW가 죽어도 재시작 후 복구할 수 있게 한다.
 *  3) recoverPendingPrompt: 재시작 후 서버 상태를 폴링해 결과를 REST로 회수한다.
 */

export const KEEPALIVE_INTERVAL_MS = 20000;
export const PENDING_KEY = 'pendingPrompts';
export const PENDING_MAX_AGE_MS = 180000;

/** 참조 카운트 방식 keepalive. 하나라도 acquire 상태면 ping 타이머가 돈다. */
export function createKeepAlive({
  ping,
  intervalMs = KEEPALIVE_INTERVAL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
}) {
  const holders = new Set();
  let timer = null;
  return {
    acquire(id) {
      holders.add(id);
      if (!timer) timer = setIntervalFn(() => { try { Promise.resolve(ping()).catch(() => {}); } catch {} }, intervalMs);
    },
    release(id) {
      holders.delete(id);
      if (holders.size === 0 && timer) { clearIntervalFn(timer); timer = null; }
    },
    get active() { return holders.size > 0; }
  };
}

/** storage(get/set 지원)에 { [sessionId]: { port, startedAt } } 형태로 저장 */
export function createPendingStore(storage, now = () => Date.now()) {
  async function read() {
    try { return (await storage.get(PENDING_KEY))[PENDING_KEY] || {}; } catch { return {}; }
  }
  async function write(map) {
    try { await storage.set({ [PENDING_KEY]: map }); } catch {}
  }
  // read-modify-write 경합(add/remove 동시 호출)으로 항목이 유실되지 않도록 직렬화
  let queue = Promise.resolve();
  const serial = (fn) => (queue = queue.then(fn, fn));
  return {
    add: (sessionId, port) => serial(async () => {
      const map = await read();
      map[sessionId] = { port, startedAt: now() };
      await write(map);
    }),
    remove: (sessionId) => serial(async () => {
      const map = await read();
      if (!(sessionId in map)) return;
      delete map[sessionId];
      await write(map);
    }),
    async list() {
      const map = await read();
      return Object.entries(map).map(([sessionId, v]) => ({ sessionId, ...v }));
    }
  };
}

/**
 * 끊긴 응답 복구: /session/status 에서 세션이 busy가 아니게 될 때까지 폴링한 뒤
 * 마지막 assistant 텍스트를 가져온다. 결과는 onComplete(content, error)로 전달.
 */
export async function recoverPendingPrompt({
  sessionId, port, startedAt,
  fetchFn = fetch,
  fetchContent,
  onComplete,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  pollMs = 3000,
  maxAgeMs = PENDING_MAX_AGE_MS
}) {
  while (true) {
    let busy = false;
    let reachable = true;
    try {
      const res = await fetchFn(`http://127.0.0.1:${port}/session/status`);
      if (res.ok) busy = sessionId in (await res.json());
      else reachable = false;
    } catch { reachable = false; }

    if (reachable && !busy) {
      const fb = await fetchContent(port, sessionId);
      if (fb.content) return onComplete(fb.content, null);
      return onComplete('', '응답 수신 중 연결이 끊겼고 서버에서도 결과를 찾지 못했습니다. 다시 시도해 주세요.');
    }
    if (now() - startedAt >= maxAgeMs) {
      if (reachable) {
        const fb = await fetchContent(port, sessionId);
        if (fb.content) return onComplete(fb.content, null);
      }
      return onComplete('', '응답 시간 초과');
    }
    await sleep(pollMs);
  }
}
