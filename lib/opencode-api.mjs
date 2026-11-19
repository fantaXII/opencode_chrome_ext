/**
 * opencode 서버 요청의 공통 계층 — 서버 주소와 인증(Basic Auth).
 *
 * 확장이 서버를 띄울 때 host가 실행마다 무작위 비밀번호를 만들어 OPENCODE_SERVER_PASSWORD로 넘긴다.
 * opencode는 1.x·2.x 모두 이 변수로 모든 경로(health·SSE 포함)에 Basic Auth를 건다(2.3.2·1.19.6 실측).
 * 사용자 이름은 'opencode'로 고정이다. 인증이 없는 서버는 헤더를 무시하므로, 비밀번호를 아는 포트에는
 * 버전과 관계없이 항상 헤더를 붙인다.
 *
 * 엔드포인트별 v1/v2 차이는 기능을 v2로 옮길 때 함께 정리한다(docs/opencode_v2_support_plan.md).
 */

export const SERVER_USER = 'opencode';
export const SERVER_PASSWORD_ENV = 'OPENCODE_SERVER_PASSWORD';

const LOCAL_URL_RE = /^http:\/\/127\.0\.0\.1:(\d+)(?:[/?#]|$)/;

export function basicAuthHeader(password) {
  return `Basic ${btoa(`${SERVER_USER}:${password}`)}`;
}

/** `http://127.0.0.1:<port>/…` 주소의 포트. 다른 주소면 null. */
export function portFromUrl(url) {
  const m = LOCAL_URL_RE.exec(String(url));
  return m ? Number(m[1]) : null;
}

/** fetch init에 Authorization 헤더를 더한다. 비밀번호가 없거나 이미 헤더가 있으면 그대로 둔다. */
export function withAuth(init, password) {
  if (!password) return init;
  const headers = new Headers(init?.headers || {});
  if (!headers.has('authorization')) headers.set('authorization', basicAuthHeader(password));
  return { ...(init || {}), headers };
}

/**
 * 포트별 서버 비밀번호. storage.session에 두어 SW가 다시 떠도 유지한다(브라우저를 다시 켜면 비워지고,
 * 그때는 host의 server-info가 server.json 기록으로 다시 알려 준다).
 */
export function createPasswordStore(storage, key = 'serverPasswords') {
  const map = new Map();
  const ready = storage.get(key)
    .then((data) => { for (const [port, pw] of Object.entries(data?.[key] || {})) if (!map.has(Number(port))) map.set(Number(port), pw); })
    .catch(() => {});
  const persist = () => storage.set({ [key]: Object.fromEntries(map) }).catch(() => {});
  return {
    ready,
    get: (port) => map.get(Number(port)) || null,
    set(port, password) {
      if (!port || !password || map.get(Number(port)) === password) return;
      map.set(Number(port), password);
      persist();
    },
    remove(port) {
      if (map.delete(Number(port))) persist();
    }
  };
}

/** 비밀번호 저장소를 쓰는 fetch. 127.0.0.1 주소면 그 포트의 비밀번호로 Authorization을 붙인다. */
export function createServerFetch(passwords, fetchFn = (...a) => fetch(...a)) {
  return async function serverFetch(url, init) {
    await passwords.ready;
    const port = portFromUrl(url);
    return fetchFn(url, port ? withAuth(init, passwords.get(port)) : init);
  };
}

/**
 * 예전 경로(/global/health)가 opencode 1.x 응답이 아닐 때 2.x인지 확인한다(GET /api/info).
 * 결과: { v2: false } | { v2: true, authorized: true, version } | { v2: true, authorized: false }
 * 2.x는 인증 없이 /api/*에 401 + {"_tag":"UnauthorizedError"}를 준다(2.3.2 실측).
 */
export async function probeV2(serverFetch, port, timeoutMs = 1500) {
  try {
    const res = await serverFetch(`http://127.0.0.1:${port}/api/info`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!(res.headers.get('content-type') || '').includes('application/json')) return { v2: false };
    const data = await res.json().catch(() => null);
    if (res.status === 401) {
      return data?._tag === 'UnauthorizedError' || typeof data?.message === 'string'
        ? { v2: true, authorized: false }
        : { v2: false };
    }
    if (res.ok && typeof data?.version === 'string') return { v2: true, authorized: true, version: data.version };
  } catch {}
  return { v2: false };
}
