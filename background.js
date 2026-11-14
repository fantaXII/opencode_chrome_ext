/**
 * OpenCode Chrome Extension - Background Service Worker
 *
 * 주요 기능:
 * - OpenCode 서버 상태 관리
 * - Native Messaging Host 통신
 * - 세션 관리
 * - 메시지 전송 및 SSE 응답 처리
 */

import { createRouterState, routeMessagePartUpdated, routeMessagePartDelta } from './lib/part-router.mjs';
import { MIN_HOST_VERSION } from './lib/host-version.mjs';
import { buildFolderList, pushRecent, folderKey, mergeFavorites, parseFavoritesFile, FAVORITES_EXPORT_TYPE } from './lib/folder-list.mjs';
import { createKeepAlive, createPendingStore, recoverPendingPrompt, sessionStatusInit } from './lib/sw-resilience.mjs';
import { createSubagentTracker } from './lib/subagent-progress.mjs';

// 응답 대기 중 SW가 30초 idle로 종료되면 SSE 스트림·타임아웃이 함께 사라져 UI가 멈춘다.
// → 대기 중에는 주기적으로 확장 API를 호출해 종료를 막고, 그래도 죽으면 재시작 시 복구한다.
const swKeepAlive = createKeepAlive({ ping: () => chrome.runtime.getPlatformInfo() });
const pendingPrompts = createPendingStore(chrome.storage.session);

// ============================================
// 상수 정의
// ============================================

const NATIVE_HOST_NAME = 'com.opencode.chrome';
const DEFAULT_PORT = 4096;
const MAX_PORT_CHECK = 10; // 4096 ~ 4105
const SERVER_START_TIMEOUT = 30000; // 30초
const SSE_RECONNECT_DELAY = 2000;
// 응답 제한 시간(무이벤트 N분이면 중단): ⚙ 설정의 chrome.storage.local.responseTimeoutMin. 0 = 없음(기본).
// 느린 사내 LLM은 첫 토큰까지 수 분이 걸릴 수 있어 기본값은 제한 없음이다. 대신 STREAM_QUIET_CHECK_MS마다
// 서버 상태를 확인해 서버가 busy인 동안은 기다리고, idle이면 완료 처리, 서버가 사라지면 오류로 끝낸다.
const RESPONSE_TIMEOUT_CHOICES_MIN = [0, 5, 10, 30];
const RESPONSE_TIMEOUT_UNIT_MS = 60000;     // 설정값(분)의 단위. 테스트 하네스가 짧게 치환한다
const STREAM_ASK_TIMEOUT_MS = 30 * 60 * 1000; // 제한 시간이 켜져 있을 때 권한/질문 응답 대기 중 상한
const STREAM_QUIET_CHECK_MS = 60000;        // 이만큼 조용하면 /session/status로 서버 상태를 확인한다
const STREAM_SERVER_LOST_CHECKS = 3;        // 상태 확인이 연속 이만큼 실패하면 서버가 사라진 것으로 본다
const QUEUE_IDLE_GRACE_MS = 3000;           // 대기 메시지가 남은 채 idle이 오면 이만큼 기다렸다 다시 확인한다
const PROMPT_SEND_TIMEOUT_MS = 15000;       // prompt_async 요청 자체의 제한

// ============================================
// 디버그 로거 (chrome.storage.local 원형버퍼)
// ============================================

const DEBUG_LOG_KEY = 'debugLogs';
const MAX_DEBUG_ENTRIES = 500;

const _debugQueue = [];
let _debugFlushPending = false;

function debugLog(level, message) {
  _debugQueue.push({ ts: new Date().toISOString(), level, msg: String(message) });
  if (_debugFlushPending) return;
  _debugFlushPending = true;
  setTimeout(async () => {
    _debugFlushPending = false;
    const entries = _debugQueue.splice(0);
    try {
      const data = await chrome.storage.local.get(DEBUG_LOG_KEY);
      const logs = data[DEBUG_LOG_KEY] || [];
      logs.push(...entries);
      if (logs.length > MAX_DEBUG_ENTRIES) logs.splice(0, logs.length - MAX_DEBUG_ENTRIES);
      await chrome.storage.local.set({ [DEBUG_LOG_KEY]: logs });
    } catch {}
  }, 0);
}

// ============================================
// 상태 관리
// ============================================

let serverState = {
  port: DEFAULT_PORT,
  available: false,
  version: null,
  checking: false,
  runtime: null // 'wsl' | 'windows' | null(미확인) - 연결된 서버가 실제로 실행 중인 환경
};

let nativeHostMissingFlag = false;
let _probedCwdPort = null; // 이 포트에 대해 이미 refreshServerCwd를 시도했는지 추적

let sessions = new Map();
let tabSessions = new Map(); // tabId → sessionId
let activeTabs = new Set();  // 사용자가 명시적으로 extension을 연 tabId 목록
let tabLastShownInfo = new Map(); // tabId → { title, url } - 패널에 마지막으로 표시된 페이지 정보
let currentActiveTabId = null;     // 현재 사이드패널이 보여주고 있는 탭
let currentSessionId = null;
let eventSources = new Map();
let selectedModel = null; // { providerID, modelID }

// 저장된 모델 복원 (SW 재시작 시에도 유지)
chrome.storage.local.get('selectedModel').then(({ selectedModel: saved }) => {
  if (saved) selectedModel = saved;
}).catch(() => {});

// 세션별 오류 안내(응답 시간 초과 등). 사이드패널은 탭 전환·재오픈 때 서버 대화 기록으로 화면을 다시 그리는데,
// 오류 문구는 서버 기록에 없어 사라졌다(다른 탭에 있는 동안 난 오류는 아예 표시되지 않았다).
// → SW가 { afterId: 오류 직전 메시지 id, text }로 보관하고 get-session-history가 함께 돌려준다.
const SESSION_NOTICES_KEY = 'sessionNotices';
const MAX_NOTICES_PER_SESSION = 20;
let sessionNotices = new Map(); // sessionId -> [{ afterId, text, at }]
chrome.storage.session.get(SESSION_NOTICES_KEY).then((data) => {
  if (data?.[SESSION_NOTICES_KEY]) sessionNotices = new Map(data[SESSION_NOTICES_KEY]);
}).catch(() => {});
function persistNotices() {
  chrome.storage.session.set({ [SESSION_NOTICES_KEY]: [...sessionNotices] }).catch(() => {});
}
function addSessionNotice(sessionId, afterId, text) {
  if (!sessionId || !text) return;
  const list = sessionNotices.get(sessionId) || [];
  list.push({ afterId: afterId || null, text, at: Date.now() });
  sessionNotices.set(sessionId, list.slice(-MAX_NOTICES_PER_SESSION));
  persistNotices();
}

// SW 재시작 시 탭/세션 상태를 storage.session에서 복원
function persistState() {
  chrome.storage.session.set({
    tabSessions: [...tabSessions],
    activeTabs: [...activeTabs],
    tabLastShownInfo: [...tabLastShownInfo],
    currentActiveTabId
  }).catch(() => {});
}

chrome.storage.session.get(['tabSessions', 'activeTabs', 'tabLastShownInfo', 'currentActiveTabId']).then((data) => {
  if (data.tabSessions) tabSessions = new Map(data.tabSessions);
  if (data.activeTabs) activeTabs = new Set(data.activeTabs);
  if (data.tabLastShownInfo) tabLastShownInfo = new Map(data.tabLastShownInfo);
  if (data.currentActiveTabId) currentActiveTabId = data.currentActiveTabId;

  // Fix 2: 활성 세션이 있으면 SW 재시작 후 서버를 즉시 초기화 (30초 idle timeout으로 SW가 재시작된 경우 빠른 복구)
  if (tabSessions.size > 0) {
    debugLog('INFO', `Service Worker restarted with ${tabSessions.size} active session(s), proactively ensuring server...`);
    ensureOpenCodeServer().catch(() => {});
  }
  recoverInterruptedPrompts().catch(() => {});
}).catch(() => {});

/** SW가 응답 도중 종료된 경우: 저장된 pending 세션의 결과를 REST로 회수해 사이드패널에 전달 */
async function recoverInterruptedPrompts() {
  const list = await pendingPrompts.list();
  for (const { sessionId, port, startedAt, directory, timeoutMs = 0 } of list) {
    if (eventSources.has(sessionId)) continue; // 이미 이 SW에서 다시 구독 중
    // 제한 시간이 있으면 그 두 배가 지난 기록은 버린다. 제한이 없으면 서버가 busy인 동안 복구를 기다린다
    // (storage.session은 브라우저를 다시 시작하면 비워진다).
    if (timeoutMs > 0 && Date.now() - startedAt > timeoutMs * 2) { await pendingPrompts.remove(sessionId); continue; }
    debugLog('WARN', `Recovering interrupted prompt after SW restart - sessionId=${sessionId}, port=${port}, ageMs=${Date.now() - startedAt}, timeoutMs=${timeoutMs || 'none'}`);
    swKeepAlive.acquire(`recover:${sessionId}`);
    recoverPendingPrompt({
      sessionId, port, startedAt, directory,
      maxAgeMs: timeoutMs,
      fetchContent: fetchFallbackContent,
      onBusy: () => {
        chrome.runtime.sendMessage({ action: 'message-part', sessionId, part: { kind: 'heartbeat', state: 'busy', at: Date.now() } }).catch(() => {});
      },
      onComplete: (content, error) => {
        debugLog(error ? 'ERROR' : 'INFO', `Interrupted prompt recovery done - sessionId=${sessionId}, chars=${content?.length || 0}, error=${error || 'none'}`);
        if (error) addSessionNotice(sessionId, null, error);
        chrome.runtime.sendMessage({ action: 'message-complete', sessionId, content, error, recovered: true }).catch(() => {});
      }
    }).catch((e) => {
      debugLog('ERROR', `Interrupted prompt recovery failed - sessionId=${sessionId}, error=${e.message}`);
      chrome.runtime.sendMessage({ action: 'message-complete', sessionId, content: '', error: '응답 복구에 실패했습니다' }).catch(() => {});
    }).finally(() => {
      swKeepAlive.release(`recover:${sessionId}`);
      pendingPrompts.remove(sessionId);
    });
  }
}

debugLog('INFO', `Service Worker started - ${new Date().toISOString()} | extensionId=${chrome.runtime.id}`);

// 탭 닫힐 때 활성 탭·탭-세션 연결 정리. TUI를 종료해도 세션이 남는 것처럼 서버의 세션(대화 기록)은 지우지 않는다
// → /sessions로 이어갈 수 있다.
chrome.tabs.onRemoved.addListener((tabId) => {
  activeTabs.delete(tabId);
  tabLastShownInfo.delete(tabId);
  const sessionId = tabSessions.get(tabId);
  if (sessionId) {
    releaseSession(sessionId, 'tab-closed').catch(() => {});
    tabSessions.delete(tabId);
  }
  persistState();
});

// ============================================
// 페이지 변경 감지 (사이드패널이 열린 탭에서 URL/title 변경 시 안내)
// ============================================

/**
 * 탭의 현재 title/url을 마지막으로 표시했던 값과 비교해 변경되었으면
 * 사이드패널에 'page-changed'를 알린다. (탭이 활성 상태일 때만 즉시 알림)
 * 최초 관찰 시에는 알림 없이 기준값만 저장한다.
 */
function notifyPageChangeIfNeeded(tabId, title, url) {
  const last = tabLastShownInfo.get(tabId);
  if (last && last.title === title && last.url === url) return;

  tabLastShownInfo.set(tabId, { title, url });
  persistState();

  if (last) {
    chrome.runtime.sendMessage({ action: 'page-changed', tabId, title, url }).catch(() => {});
  }
}

// 일반 페이지 이동 (전체 문서 로드 완료)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!activeTabs.has(tabId) || tabId !== currentActiveTabId) return;
  notifyPageChangeIfNeeded(tabId, tab.title || '', tab.url || '');
});

// SPA 라우팅 (history.pushState/replaceState 기반 URL 변경)
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return; // 최상위 프레임만
  if (!activeTabs.has(details.tabId) || details.tabId !== currentActiveTabId) return;
  // SPA에서는 title이 URL 변경 직후 비동기로 갱신되는 경우가 많아 약간 지연 후 조회
  setTimeout(() => {
    chrome.tabs.get(details.tabId).then((tab) => {
      if (tab) notifyPageChangeIfNeeded(details.tabId, tab.title || '', tab.url || details.url || '');
    }).catch(() => {});
  }, 300);
});

// ============================================
// 서버 상태 관리
// ============================================

/**
 * OpenCode 서버 상태 확인
 */
async function checkServerHealth(port) {
  console.log(`[checkServerHealth] 포트 ${port} 상태 체크 중...`);
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1500);
    const response = await fetch(`http://127.0.0.1:${port}/global/health`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    console.log(`[checkServerHealth] 포트 ${port} 응답: status=${response.status}, ok=${response.ok}`);
    if (response.ok) {
      const data = await response.json().catch(() => null);
      // 같은 포트를 쓰는 다른 프로그램을 opencode로 오인하지 않도록 응답 형태까지 확인한다.
      if (data?.healthy === true || typeof data?.version === 'string') {
        console.log(`[checkServerHealth] 포트 ${port} 성공 - version=${data.version}`);
        return { available: true, version: data.version };
      }
      debugLog('WARN', `checkServerHealth: port ${port} answered 200 but is not an opencode server`);
    } else if (response.status === 401) {
      // OPENCODE_SERVER_PASSWORD가 걸린 서버(터미널/TUI에서 직접 실행). 확장은 인증을 지원하지 않으므로 사용하지 않는다.
      debugLog('WARN', `checkServerHealth: port ${port} requires authentication (OPENCODE_SERVER_PASSWORD) - skipped`);
      return { available: false, version: null, authRequired: true };
    }
  } catch (error) {
    console.log(`[checkServerHealth] 포트 ${port} 실패:`, error.message);
  }
  return { available: false, version: null };
}

/**
 * 사용 가능한 포트 찾기
 */
/** 4096~4105에서 응답하는 opencode 서버 포트 목록(누가 띄웠는지는 따지지 않는다). */
async function scanHealthyPorts() {
  const ports = Array.from({ length: MAX_PORT_CHECK }, (_, i) => DEFAULT_PORT + i);
  const states = await Promise.all(ports.map((port) => checkServerHealth(port)));
  return ports.filter((_, i) => states[i].available);
}

// ============================================
// 확장 전용 서버
// ============================================
//
// 사이드패널은 확장이 직접 띄운 서버만 쓴다. TUI처럼 "자기 서버를 혼자 쓰기" 위해서다.
// 터미널 TUI·VS Code 등이 띄운 서버(--port 4096 등)에 붙으면 강제 재시작이 그 작업까지
// 죽이므로, 전역 MCP처럼 프로세스 재시작으로만 반영되는 설정을 마음 놓고 반영할 수 없었다.
//
// - 확장이 띄운 서버의 포트는 host의 start/restart 응답으로 알고 chrome.storage.local에 둔다.
// - 브라우저를 다시 켜면 그 포트를 다른 프로그램이 쓰고 있을 수 있으므로, SW가 그 포트에 처음 붙을 때
//   host의 server-info(server.json 기록 pid와 현재 리스너 대조)로 한 번 확인한다. 결과는
//   storage.session에 두어(브라우저 세션 동안 유지) SW가 재시작될 때마다 host를 부르지 않는다.
// - host가 없거나(개발 환경·테스트) 구버전이라 판정하지 못하면 예전처럼 아무 서버에나 붙는다.
const MANAGED_PORT_KEY = 'managedServerPort';
// 지금 연결된 서버가 확장 서버인지: true(기록·확인·직접 띄움) | false(판정 불가로 아무 서버나 고름) | null(미연결)
// false인 서버는 다른 프로그램의 서버일 수 있으므로 하드 재시작이 그 프로세스를 죽이지 않고 새 서버를 띄운다.
let serverIsManaged = null;
const MANAGED_VERIFIED_KEY = 'managedServerVerified';

/** host로 확장이 띄운 서버인지 확인한다: 'managed' | 'unmanaged' | 'unknown'(판정 불가) */
async function checkManagedServer(port) {
  try {
    const info = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { action: 'server-info', port });
    if (info?.status === 'success' && typeof info.managed === 'boolean') {
      return info.managed ? 'managed' : 'unmanaged';
    }
    debugLog('WARN', `checkManagedServer: cannot decide - port=${port}, error=${info?.error || '?'}`);
  } catch (error) {
    debugLog('WARN', `checkManagedServer: ${error.message}`);
  }
  return 'unknown';
}

/** 확장이 띄운(또는 확인한) 서버 포트를 기록한다. */
async function rememberManagedServer(port) {
  serverIsManaged = true;
  try {
    await chrome.storage.local.set({ [MANAGED_PORT_KEY]: port });
    await chrome.storage.session.set({ [MANAGED_VERIFIED_KEY]: port });
  } catch {}
}

/** 확인 결과만 지운다(포트가 내려갔을 때). 다시 붙을 때 host로 재확인한다. */
function forgetManagedVerification() {
  chrome.storage.session.remove(MANAGED_VERIFIED_KEY).catch(() => {});
}

/**
 * 사이드패널이 쓸 서버 포트. 확장이 띄운 서버가 없으면 null(→ 호출부가 새로 띄운다).
 * 다른 프로그램이 띄운 서버는 건너뛴다. host가 판정하지 못할 때만 예전처럼 아무 서버나 고른다.
 */
async function findAvailablePort() {
  let stored = null;
  let verified = null;
  try {
    stored = (await chrome.storage.local.get(MANAGED_PORT_KEY))[MANAGED_PORT_KEY] ?? null;
    verified = (await chrome.storage.session.get(MANAGED_VERIFIED_KEY))[MANAGED_VERIFIED_KEY] ?? null;
  } catch {}

  // 1. 기록된 확장 서버
  if (stored && (await checkServerHealth(stored)).available) {
    if (verified === stored) { serverIsManaged = true; return stored; }
    const verdict = await checkManagedServer(stored);
    if (verdict !== 'unmanaged') {
      // unknown(host 없음·구버전)이면 기록을 믿는다.
      chrome.storage.session.set({ [MANAGED_VERIFIED_KEY]: stored }).catch(() => {});
      debugLog('INFO', `findAvailablePort: managed server on port ${stored} (${verdict})`);
      serverIsManaged = true;
      return stored;
    }
    debugLog('WARN', `findAvailablePort: port ${stored} is now used by another opencode server - ignoring`);
    chrome.storage.local.remove(MANAGED_PORT_KEY).catch(() => {});
  }

  // 2. 기록이 없거나 맞지 않음: 범위 안의 서버 중 확장이 띄운 것을 찾는다
  //    (이 기능 이전 버전이 띄운 서버도 server.json 기록이 있어 여기서 이어받는다).
  const healthy = await scanHealthyPorts();
  if (healthy.length === 0) {
    console.log(`[findAvailablePort] 사용 가능한 서버 없음`);
    return null;
  }
  for (const port of healthy) {
    const verdict = await checkManagedServer(port);
    if (verdict === 'managed') {
      await rememberManagedServer(port);
      debugLog('INFO', `findAvailablePort: adopted managed server on port ${port}`);
      return port;
    }
    if (verdict === 'unknown') {
      // 판정할 수 없으면 예전 동작(아무 서버나)으로 돌아간다. 이 포트는 확장 서버로 기록하지 않는다.
      debugLog('WARN', `findAvailablePort: host cannot identify servers - legacy selection among ${JSON.stringify(healthy)}`);
      serverIsManaged = false;
      return pickPreferredServer(healthy);
    }
  }
  debugLog('INFO', `findAvailablePort: ignoring servers not started by the extension ${JSON.stringify(healthy)}`);
  return null;
}

/** (판정 불가 시) 서버가 여러 개면 실행 환경 우선순위에 맞는 것을 고른다. */
async function pickPreferredServer(healthy) {
  if (healthy.length === 1) {
    console.log(`[findAvailablePort] 포트 ${healthy[0]} 발견!`);
    return healthy[0];
  }

  // 서버가 여러 개(WSL + Windows)면 우선순위 설정에 맞는 환경의 서버를 고른다.
  // 'auto'는 WSL 우선. 환경을 못 알아내면 가장 낮은 포트로 fallback.
  const preferred = await getPreferredRuntime();
  const want = preferred === 'windows' ? 'windows' : 'wsl';
  const runtimes = await Promise.all(healthy.map(async (port) => runtimeFromDirectory(await probeServerDirectory(port))));
  const idx = runtimes.indexOf(want);
  const chosen = idx >= 0 ? healthy[idx] : healthy[0];
  debugLog('INFO', `pickPreferredServer: multiple servers ${JSON.stringify(healthy.map((p, i) => ({ port: p, runtime: runtimes[i] })))} - preferred=${preferred}, chosen=${chosen}`);
  return chosen;
}

// "1.2.3" 형식 비교: a<b → -1, a==b → 0, a>b → 1
function compareVersions(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * 설치된 native host 버전을 MIN_HOST_VERSION(host가 마지막으로 바뀐 릴리스)과 비교한다.
 * 확장 버전과 비교하면 host가 그대로인 릴리스에서도 매번 재설치를 안내하게 된다.
 * state: 'ok' | 'outdated' | 'missing'(host 미설치) | 'unknown'(판단 불가 - 안내하지 않음)
 * get-version이 없는 구버전 host는 'Unknown action'을 돌려주므로 outdated로 본다.
 */
async function checkHostVersion() {
  const required = MIN_HOST_VERSION;
  try {
    const res = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { action: 'get-version' });
    let result;
    if (res?.status === 'success') {
      result = res.version
        ? { state: compareVersions(res.version, required) < 0 ? 'outdated' : 'ok', hostVersion: res.version }
        : { state: 'unknown', hostVersion: null }; // version.txt 없음(개발 환경)
    } else if (res?.error === 'Unknown action') {
      result = { state: 'outdated', hostVersion: null };
    } else {
      result = { state: 'unknown', hostVersion: null };
    }
    debugLog('INFO', `checkHostVersion: ${JSON.stringify(result)} required=${required}`);
    return { ...result, required };
  } catch (error) {
    const missing = error.message?.includes('native messaging host not found');
    debugLog(missing ? 'WARN' : 'ERROR', `checkHostVersion: ${error.message}`);
    return { state: missing ? 'missing' : 'unknown', hostVersion: null, required };
  }
}

const RUNTIME_PREFERENCES = ['auto', 'wsl', 'windows'];

/** 저장된 실행 환경 우선순위. 'auto'는 Windows 우선(기존 동작). */
async function getPreferredRuntime() {
  try {
    const { preferredRuntime } = await chrome.storage.local.get('preferredRuntime');
    return RUNTIME_PREFERENCES.includes(preferredRuntime) ? preferredRuntime : 'auto';
  } catch {
    return 'auto';
  }
}

const PROXY_KEYS = ['http', 'https', 'noProxy'];

/** 저장된 프록시 설정. 비어 있으면 host가 기존 시스템 환경변수를 그대로 쓴다. */
async function getProxy() {
  const out = { http: '', https: '', noProxy: '' };
  try {
    const { proxy } = await chrome.storage.local.get('proxy');
    for (const k of PROXY_KEYS) out[k] = typeof proxy?.[k] === 'string' ? proxy[k].trim() : '';
  } catch {}
  return out;
}

/** 프록시 주소 검증. 문제가 없으면 null, 있으면 사유 문자열. (http/https/socks5[h] 스킴만 허용) */
function validateProxyUrl(value) {
  if (!value) return null;
  try {
    const u = new URL(value);
    if (!/^(https?|socks5h?):$/.test(u.protocol) || !u.hostname) throw new Error('scheme');
    return null;
  } catch {
    return `'${value.replace(/\/\/[^@/]*@/, '//***@')}' 형식이 올바르지 않습니다 (예: http://host:8080)`;
  }
}

/**
 * Native Messaging Host를 통해 서버 시작
 */
async function startServerWithNativeMessaging(preferredPort = DEFAULT_PORT) {
  const MAX_RETRIES = 3;
  const preferredRuntime = await getPreferredRuntime();
  const proxy = await getProxy();
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    debugLog('INFO', `NativeMsg: attempt ${attempt}/${MAX_RETRIES}, preferredPort=${preferredPort}, preferredRuntime=${preferredRuntime}`);
    console.log(`[startServerWithNativeMessaging] 시도 ${attempt}/${MAX_RETRIES} - preferredPort=${preferredPort}`);
    try {
      const response = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, {
        action: 'start',
        preferredPort: preferredPort,
        preferredRuntime,
        proxy
      });

      console.log(`[startServerWithNativeMessaging] Native Messaging 응답:`, response);
      if (response.status === 'success') {
        debugLog('INFO', `NativeMsg: success, port=${response.port}, isWSL=${response.isWSL}`);
        console.log(`[startServerWithNativeMessaging] 성공 - port=${response.port}`);
        if (typeof response.isWSL === 'boolean') {
          chrome.storage.local.set({ serverIsWSL: response.isWSL }).catch(() => {});
          serverState.runtime = response.isWSL ? 'wsl' : 'windows';
        }
        return response.port;
      }
      // host.js가 반환한 에러 + 진단 정보 기록
      const diagStr = response.diagnostic ? ` | diagnostic: ${JSON.stringify(response.diagnostic)}` : '';
      debugLog('ERROR', `NativeMsg: host error - ${response.error}${diagStr}`);
      console.error(`[startServerWithNativeMessaging] 실패 - status=${response.status}, error=${response.error}`);
    } catch (error) {
      // Chrome 레벨 Native Messaging 에러 (연결 자체 실패)
      debugLog('ERROR', `NativeMsg: Chrome error attempt ${attempt}/${MAX_RETRIES} - ${error.message}`);
      console.error(`[startServerWithNativeMessaging] 시도 ${attempt} 실패:`, error);
      if (error.message && error.message.includes('native messaging host not found')) {
        nativeHostMissingFlag = true;
        return null;
      }
    }

    if (attempt < MAX_RETRIES) {
      const delay = attempt * 2000;
      debugLog('INFO', `NativeMsg: retrying in ${delay}ms...`);
      console.log(`[startServerWithNativeMessaging] ${delay}ms 후 재시도...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  debugLog('ERROR', `NativeMsg: all ${MAX_RETRIES} attempts failed`);
  console.error(`[startServerWithNativeMessaging] ${MAX_RETRIES}회 시도 모두 실패`);
  return null;
}

/**
 * 서버가 사용 가능할 때까지 대기
 */
async function waitForServer(expectedPort, timeout = SERVER_START_TIMEOUT) {
  const startTime = Date.now();
  console.log(`[waitForServer] 포트 ${expectedPort} 서버 시작 대기 - timeout=${timeout}ms`);

  // host가 알려준 그 포트만 본다. 범위를 다시 훑으면 다른 프로그램(TUI 등)의 서버를 고를 수 있다.
  while (Date.now() - startTime < timeout) {
    const port = (await checkServerHealth(expectedPort)).available ? expectedPort : null;
    if (port) {
      console.log(`[waitForServer] 서버 발견! 포트 ${port}`);
      return port;
    }
    console.log(`[waitForServer] 서버 못 찾음. 1초 후 재시도... (경과: ${Date.now() - startTime}ms)`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log(`[waitForServer] 타임아웃 - ${timeout}ms 내 서버 없음`);
  return null;
}

// 진행 중인 ensureOpenCodeServer() 호출을 공유해 레이스 컨디션 방지
let _ensureServerPromise = null;

/**
 * OpenCode 서버 초기화
 */
async function ensureOpenCodeServer() {
  // 하드 재시작 중에는 서버가 잠시 사라진다. 여기서 새 서버를 띄우면 재시작이 띄운 서버와
  // 겹쳐 두 개가 되므로, 재시작이 끝날 때까지 기다렸다가 그 결과를 쓴다.
  if (_hardRestartPromise) {
    debugLog('INFO', 'ensureOpenCodeServer: waiting for hard restart to finish');
    await _hardRestartPromise.catch(() => {});
    return serverState.available ? serverState.port : null;
  }

  if (_ensureServerPromise) {
    console.log(`[ensureOpenCodeServer] 진행 중인 확인 작업에 합류`);
    return _ensureServerPromise;
  }

  if (serverState.checking) {
    const knownPort = serverState.available ? serverState.port : null;
    console.log(`[ensureOpenCodeServer] 이미 checking 중입니다. 기존 포트 ${knownPort} 반환`);
    return knownPort;
  }

  serverState.checking = true;
  console.log(`[ensureOpenCodeServer] checking=true - 서버 확인 시작`);

  _ensureServerPromise = (async () => {
  try {
    let port = null;

    const existingPort = await findAvailablePort();
    if (existingPort) {
      serverState.port = existingPort;
      serverState.available = true;
      const health = await checkServerHealth(existingPort);
      serverState.version = health.version;
      debugLog('INFO', `Server: existing server found on port ${existingPort}, version=${health.version}`);
      console.log(`[ensureOpenCodeServer] 기존 OpenCode 서버 발견: 포트 ${existingPort}, version=${health.version}`);
      port = existingPort;
    } else {
      debugLog('INFO', 'Server: no running server, requesting start via NativeMsg...');
      console.log(`[ensureOpenCodeServer] OpenCode 서버 없음, Native Messaging으로 시작 시도...`);
      const startedPort = await startServerWithNativeMessaging();
      console.log(`[ensureOpenCodeServer] Native Messaging 결과: startedPort=${startedPort}`);

      if (startedPort) {
        port = await waitForServer(startedPort);
        if (port) {
          await rememberManagedServer(port);
          serverState.port = port;
          serverState.available = true;
          const health = await checkServerHealth(port);
          serverState.version = health.version;
          console.log(`[ensureOpenCodeServer] OpenCode 서버 시작 완료: 포트 ${port}, version=${health.version}`);
        }
      }
    }

    if (port && !selectedModel) {
      console.log(`[ensureOpenCodeServer] 모델 동기화 시작...`);
      await syncModelFromServer(port);
    }

    // working directory 설정이 실제 서버(WSL/Windows 네이티브) 경로 포맷과
    // 어긋나지 않도록, 서버 연결 확인 즉시(첫 채팅 이전이라도) 실측 cwd를 한 번 조회한다.
    if (port && port !== _probedCwdPort) {
      _probedCwdPort = port;
      refreshServerCwd(port).catch(() => {});
    }

    if (port) {
      console.log(`[ensureOpenCodeServer] 성공 - 포트 ${port} 반환`);
      return port;
    }

    console.error(`[ensureOpenCodeServer] OpenCode 서버 시작 실패`);
    return null;
  } finally {
    serverState.checking = false;
    _ensureServerPromise = null;
    console.log(`[ensureOpenCodeServer] checking=false - 작업 완료`);
  }
  })();

  return _ensureServerPromise;
}

/**
 * 서버 상태Periodic 확인
 */
async function periodicServerCheck() {
  // 하드 재시작 중에는 서버가 일시적으로 사라진다. 이때 자동 복구가 끼어들면
  // 두 번째 서버가 다른 포트에 떠버리므로 재시작이 끝날 때까지 건너뛴다.
  if (_restartInProgress) {
    console.log(`[periodicServerCheck] 재시작 진행 중 - 건너뜀`);
    return;
  }
  console.log(`[periodicServerCheck] 주기 체크 시작 - 현재 serverState.port=${serverState.port}, available=${serverState.available}`);
  // 연결된 서버(확장 서버)만 확인한다. 범위를 훑으면 다른 프로그램이 띄운 서버로 옮겨 붙을 수 있다.
  // 연결되지 않은 상태에서의 연결은 사이드패널 요청(ensureOpenCodeServer)이 맡는다.
  if (!serverState.available || !serverState.port) return;
  const port = (await checkServerHealth(serverState.port)).available ? serverState.port : null;
  if (!port) forgetManagedVerification();
  if (port !== serverState.port) {
    const wasAvailable = serverState.available;
    console.log(`[periodicServerCheck] 서버 포트 변경 감지! ${serverState.port} → ${port}`);
    serverState.port = port;
    serverState.available = !!port;
    console.log(`[periodicServerCheck] 상태 업데이트 완료 - port=${port}, available=${serverState.available}`);

    // Fix 1: 서버가 다운됐으면 즉시 자동 재시작 시도
    if (wasAvailable && !port) {
      debugLog('INFO', 'Server: periodic check detected server went down, attempting auto-restart...');
      ensureOpenCodeServer().catch(() => {});
    } else if (!wasAvailable && port) {
      // Fix 3: 서버 복구도 debugLog로 기록
      debugLog('INFO', `Server: periodic check detected server came up on port ${port}`);
    }
  } else {
    console.log(`[periodicServerCheck] 포트 변경 없음 (${port})`);
  }
}

// Periodic 체크 설정 (chrome.alarms 사용 — setInterval은 MV3 SW 종료 시 소멸)
// SW 재시작마다 create를 호출하면 기존 알람이 리셋되므로 없을 때만 생성
chrome.alarms.get('periodicServerCheck', (existing) => {
  if (!existing) chrome.alarms.create('periodicServerCheck', { periodInMinutes: 1 });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'periodicServerCheck') periodicServerCheck();
});

// ============================================
// 서버 재시작
// ============================================
//
// 두 단계로 나뉜다.
//
// (A) 소프트 재시작 = POST /global/dispose
//     opencode는 config/MCP/skill/agent를 "Instance" 단위로 캐시하며, dispose는 그
//     Instance만 버린다(프로세스·포트·디스크 세션 유지). 다음 요청에서 Instance가
//     새로 만들어질 때 config를 디스크에서 다시 읽으므로, TUI를 exit 후 재진입한
//     것과 동일한 효과다. MCP/skill/agent를 새로 등록한 경우 이것으로 충분하다.
//     단, 서버가 열려 있는 SSE 스트림을 끊고 'server.instance.disposed'를 내보낸다.
//
// (B) 하드 재시작 = Native Host가 포트 점유 프로세스를 죽이고 다시 spawn
//     서버가 응답하지 않거나 상태가 깨졌을 때 쓴다. 포트가 바뀔 수 있다.

let _restartInProgress = false;
// 하드 재시작이 진행 중이면 그 Promise. ensureOpenCodeServer가 기다리는 데 쓴다.
let _hardRestartPromise = null;

function abortAllEventSources(reason) {
  const sessionIds = [...eventSources.keys()];
  for (const controller of eventSources.values()) {
    try { controller.abort(); } catch {}
  }
  eventSources.clear();
  if (sessionIds.length) {
    debugLog('INFO', `${reason}: aborted ${sessionIds.length} in-flight SSE connection(s)`);
  }
  return sessionIds;
}

// 재시작 직후 서버 상태를 다시 읽어 serverState/모델/cwd 캐시를 맞춘다.
// dispose 후 첫 요청에서 Instance가 재생성되므로, 여기서 미리 워밍업하는 효과도 있다.
async function resyncAfterRestart(port) {
  const health = await checkServerHealth(port);
  serverState.port = port;
  serverState.available = health.available;
  serverState.version = health.version;
  if (!health.available) return health;

  await syncModelFromServer(port).catch(() => {});
  _probedCwdPort = port;
  refreshServerCwd(port).catch(() => {});
  return health;
}

/**
 * (A) 소프트 재시작 - opencode Instance만 폐기해 설정을 다시 읽게 한다.
 */
async function restartServerInstance() {
  const port = serverState.port;
  if (!port || !serverState.available) {
    return { success: false, error: '서버에 연결되어 있지 않습니다' };
  }
  if (_restartInProgress) {
    return { success: false, error: '이미 재시작이 진행 중입니다' };
  }

  _restartInProgress = true;
  try {
    const interrupted = abortAllEventSources('restart-instance');
    debugLog('INFO', `restart-instance: POST /global/dispose on port ${port}`);

    const response = await fetch(`http://127.0.0.1:${port}/global/dispose`, { method: 'POST' });
    if (!response.ok) {
      debugLog('ERROR', `restart-instance: dispose returned ${response.status}`);
      return { success: false, error: `dispose 실패: ${response.status}`, interrupted: interrupted.length };
    }

    const health = await resyncAfterRestart(port);
    debugLog('INFO', `restart-instance: done - port=${port}, healthy=${health.available}, version=${health.version}, interruptedSSE=${interrupted.length}`);

    return health.available
      ? { success: true, mode: 'soft', port, version: health.version, interrupted: interrupted.length }
      : { success: false, error: 'dispose 후 서버가 응답하지 않습니다', interrupted: interrupted.length };
  } catch (error) {
    debugLog('ERROR', `restart-instance: failed - ${error.message}`);
    return { success: false, error: error.message };
  } finally {
    _restartInProgress = false;
  }
}

/**
 * (B) 하드 재시작 - Native Host를 통해 서버 프로세스를 종료하고 다시 시작한다.
 */
async function hardRestartServer(requestedRuntime) {
  if (_restartInProgress) {
    return { success: false, error: '이미 재시작이 진행 중입니다' };
  }

  // 열려 있는 모든 사이드패널(다른 창 포함)이 입력을 막고 "재시작 중"을 표시하도록 알린다.
  const notify = (data) => chrome.runtime.sendMessage({ action: 'server-restart-state', ...data }).catch(() => {});
  const promise = runHardRestart(requestedRuntime);
  _hardRestartPromise = promise;
  notify({ restarting: true });
  let result;
  try {
    result = await promise;
    return result;
  } finally {
    _hardRestartPromise = null;
    notify({ restarting: false, success: !!result?.success, port: result?.port ?? null });
  }
}

async function runHardRestart(requestedRuntime) {
  if (_restartInProgress) {
    return { success: false, error: '이미 재시작이 진행 중입니다' };
  }

  _restartInProgress = true;
  const oldPort = serverState.port;
  try {
    // 서버가 Windows 네이티브인지 WSL인지에 따라 종료 방법이 달라진다. 확실치 않으므로
    // 힌트만 넘기고(host.js가 양쪽 다 시도한다) 실패 판정은 host.js가 포트로 확인한다.
    const { serverIsWSL } = await chrome.storage.local.get('serverIsWSL');
    const preferredRuntime = RUNTIME_PREFERENCES.includes(requestedRuntime)
      ? requestedRuntime
      : await getPreferredRuntime();
    const interrupted = abortAllEventSources('restart-server');
    serverState.available = false;

    debugLog('INFO', `restart-server: requesting native host restart - port=${oldPort}, isWSLHint=${serverIsWSL === true}, preferredRuntime=${preferredRuntime}, interruptedSSE=${interrupted.length}`);

    // 확장 서버인지 확인하지 못한 서버(다른 프로그램의 서버일 수 있음)는 죽이지 않고 새 확장 서버를 띄운다.
    const replaceOnly = serverIsManaged === false;
    if (replaceOnly) debugLog('WARN', `restart-server: port ${oldPort} is not a confirmed extension server - starting a new server instead of killing it`);

    let response;
    try {
      response = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, replaceOnly
        ? { action: 'start', preferredPort: DEFAULT_PORT, preferredRuntime, proxy: await getProxy() }
        : {
          action: 'restart',
          port: oldPort,
          isWSL: serverIsWSL === true,
          preferredRuntime,
          proxy: await getProxy()
        });
    } catch (error) {
      debugLog('ERROR', `restart-server: native messaging error - ${error.message}`);
      const reason = error.message?.includes('native messaging host not found') ? 'native-host-missing' : undefined;
      return { success: false, error: error.message, reason };
    }

    const attemptsStr = response?.attempts ? ` | attempts=${JSON.stringify(response.attempts)}` : '';
    if (response?.status !== 'success') {
      debugLog('ERROR', `restart-server: host error - ${response?.error}${attemptsStr}`);
      return { success: false, error: response?.error || '재시작 실패' };
    }
    if (typeof response.isWSL === 'boolean') {
      chrome.storage.local.set({ serverIsWSL: response.isWSL }).catch(() => {});
      serverState.runtime = response.isWSL ? 'wsl' : 'windows';
    }
    // 재시작이 성공한 뒤에만 선택을 저장한다(실패하면 이전 설정이 유지된다).
    if (RUNTIME_PREFERENCES.includes(requestedRuntime)) {
      chrome.storage.local.set({ preferredRuntime: requestedRuntime }).catch(() => {});
    }

    const port = response.port ? await waitForServer(response.port) : null;
    if (!port) {
      serverState.available = false;
      debugLog('ERROR', `restart-server: server not reachable after restart${attemptsStr}`);
      return { success: false, error: '재시작 후 서버를 찾을 수 없습니다' };
    }

    await rememberManagedServer(port);
    const health = await resyncAfterRestart(port);

    // 포트가 바뀌었을 수 있다. 세션 자체는 서버 디스크에 남아 있으므로 유지하고
    // 캐시된 포트만 갱신한다.
    if (port !== oldPort) {
      for (const session of sessions.values()) session.port = port;
    }

    debugLog('INFO', `restart-server: done - oldPort=${oldPort}, newPort=${port}, version=${health.version}${attemptsStr}`);
    return { success: true, mode: 'hard', port, version: health.version, portChanged: port !== oldPort };
  } catch (error) {
    debugLog('ERROR', `restart-server: failed - ${error.message}`);
    return { success: false, error: error.message };
  } finally {
    _restartInProgress = false;
  }
}

/**
 * 새 세션에 쓸 기본 작업 폴더(chrome.storage.local.workingDirectory, 마지막으로 고른 폴더). 비어 있으면 서버 cwd.
 * 이미 있는 세션의 폴더는 getSessionDirectory로 구한다 — opencode는 세션을 만든 폴더에 세션을 고정하고,
 * 다른 x-opencode-directory 헤더로 보내도 원래 폴더에서 실행한다(1.19.5 실측, git/비git 모두).
 */
async function getWorkingDirectory() {
  try {
    const result = await chrome.storage.local.get('workingDirectory');
    return result.workingDirectory || '';
  } catch {
    return '';
  }
}

// 세션별 작업 폴더(서버가 세션 생성 때 고정한 session.directory). sessionId -> directory.
// 탭 A에서 폴더를 바꿔도 탭 B의 세션은 원래 폴더로 동작하므로, 프롬프트·상태 확인·권한 응답은 이 값으로 보낸다.
// (전역 값으로 보내면 상태가 다른 instance에서 조회돼 응답 중인 세션이 idle로 보인다.)
const SESSION_DIRS_KEY = 'sessionDirectories';
let sessionDirectories = new Map();
chrome.storage.session.get(SESSION_DIRS_KEY).then((data) => {
  if (data?.[SESSION_DIRS_KEY]) sessionDirectories = new Map([...data[SESSION_DIRS_KEY], ...sessionDirectories]);
}).catch(() => {});
function persistSessionDirectories() {
  chrome.storage.session.set({ [SESSION_DIRS_KEY]: [...sessionDirectories] }).catch(() => {});
}
function rememberSessionDirectory(sessionId, directory) {
  if (!sessionId || !directory || sessionDirectories.get(sessionId) === directory) return;
  sessionDirectories.set(sessionId, directory);
  persistSessionDirectories();
}
function forgetSessionDirectory(sessionId) {
  if (sessionDirectories.delete(sessionId)) persistSessionDirectories();
}

/** 세션의 작업 폴더. 모르면 GET /session/{id}의 directory로 확인하고, 그것도 안 되면 기본 폴더. */
async function getSessionDirectory(sessionId, port = null) {
  if (!sessionId) return getWorkingDirectory();
  if (sessionDirectories.has(sessionId)) return sessionDirectories.get(sessionId);
  const p = port ?? sessions.get(sessionId)?.port ?? serverState.port;
  if (p) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/session/${encodeURIComponent(sessionId)}`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const directory = (await res.json())?.directory;
        if (directory) {
          rememberSessionDirectory(sessionId, directory);
          return directory;
        }
      }
    } catch (e) {
      debugLog('WARN', `getSessionDirectory: lookup failed - sessionId=${sessionId}, error=${e.message}`);
    }
  }
  return getWorkingDirectory();
}

/** 두 경로가 같은 폴더인지(구분자·끝 슬래시 차이 무시, 드라이브 경로는 대소문자 무시). */
function sameDirectory(a, b) {
  const norm = (p) => {
    const v = (p || '').replace(/\\/g, '/').replace(/\/+$/, '');
    return /^[A-Za-z]:/.test(v) ? v.toLowerCase() : v;
  };
  return norm(a) === norm(b);
}

// 작업 폴더 즐겨찾기·최근·숨김(chrome.storage.local — 확장 업데이트로는 지워지지 않는다). lib/folder-list.mjs 참고.
const FOLDER_FAVORITES_KEY = 'folderFavorites';
const FOLDER_RECENT_KEY = 'folderRecent';
const FOLDER_HIDDEN_KEY = 'folderHidden';

/** 고른 폴더를 최근 목록 맨 앞에 넣고, 숨겨 둔 폴더였으면 숨김을 푼다. */
async function recordRecentFolder(path) {
  try {
    const key = folderKey(path);
    const store = await chrome.storage.local.get([FOLDER_RECENT_KEY, FOLDER_HIDDEN_KEY]);
    await chrome.storage.local.set({
      [FOLDER_RECENT_KEY]: pushRecent(store[FOLDER_RECENT_KEY], path),
      [FOLDER_HIDDEN_KEY]: (store[FOLDER_HIDDEN_KEY] || []).filter(h => folderKey(h) !== key)
    });
  } catch (e) {
    debugLog('WARN', `recordRecentFolder: ${e.message}`);
  }
}

/**
 * 폴더 instance별 목록(MCP·명령·skill·에이전트) 조회용 헤더: 세션의 폴더, 세션이 없으면 새 세션의 기본 폴더.
 * 프로젝트(.opencode/, opencode.json)의 항목은 그 폴더 instance에만 있어서, 헤더 없이 물으면
 * 서버 cwd 폴더 기준 목록이 와서 작업 폴더에 추가한 항목이 보이지 않는다(1.19.4 실측).
 */
async function sessionDirectoryHeaders(sessionId, port) {
  const dir = sessionId ? await getSessionDirectory(sessionId, port) : await getWorkingDirectory();
  const dirHeader = buildDirectoryHeader(dir);
  return dirHeader ? { 'x-opencode-directory': dirHeader } : {};
}

/**
 * x-opencode-directory 헤더 값 생성.
 * HTTP 헤더는 ISO-8859-1만 허용하므로 비-Latin 경로는 URL-encode 필요.
 */
function buildDirectoryHeader(workingDir) {
  if (!workingDir) return null;
  const isLatin = /^[\x00-\xFF]*$/.test(workingDir);
  return isLatin ? workingDir : encodeURIComponent(workingDir);
}

async function getDefaultDirectory() {
  // 1. 실측값 우선: SSE/probe로 확인된 실제 서버 cwd (형식이 확실함)
  try {
    const stored = await chrome.storage.local.get('serverCwd');
    if (stored.serverCwd) return stored.serverCwd;
  } catch {}

  // 2. Native host 추정값 (서버가 WSL인지 Windows 네이티브인지 모르는 상태의 fallback)
  try {
    const response = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { action: 'get-home-dir' });
    if (response?.directory) return response.directory;
  } catch {}

  return '';
}

function isWindowsDrivePath(p) {
  return /^[A-Za-z]:[\\\/]/.test(p || '');
}

// Windows 경로(C:\...) → WSL 경로(/mnt/c/...) 변환
function toWSLPath(p) {
  if (!p) return '';
  // \\wsl$\<distro>\... 또는 \\wsl.localhost\<distro>\... : WSL 파일시스템을 직접 가리키는 UNC 경로
  const unc = p.match(/^\\\\(?:wsl\$|wsl\.localhost)\\[^\\]+(\\.*)?$/i);
  if (unc) {
    const rest = (unc[1] || '').replace(/\\/g, '/');
    return rest || '/';
  }
  const m = p.match(/^([A-Za-z]):[\\\/](.*)/);
  if (!m) return p.replace(/\\/g, '/');
  const drive = m[1].toLowerCase();
  const rest = m[2].replace(/\\/g, '/').replace(/\/$/, '');
  return `/mnt/${drive}/${rest}`;
}

/**
 * 연결된 opencode 서버가 POSIX(WSL)인지 Windows 네이티브인지 저장된 실측값으로 판별한다.
 * 반환: { serverIsPosix: true | false | null(알 수 없음), source }
 */
async function detectServerIsPosix() {
  let serverIsPosix = null;
  let source = 'unknown';
  try {
    const { serverCwd } = await chrome.storage.local.get('serverCwd');
    if (serverCwd) {
      serverIsPosix = !isWindowsDrivePath(serverCwd);
      source = `serverCwd=${serverCwd}`;
    }
  } catch {}

  if (serverIsPosix === null) {
    try {
      const { serverIsWSL } = await chrome.storage.local.get('serverIsWSL');
      if (typeof serverIsWSL === 'boolean') {
        serverIsPosix = serverIsWSL;
        source = `serverIsWSL=${serverIsWSL}`;
      }
    } catch {}
  }
  return { serverIsPosix, source };
}

/**
 * native host에 작업 디렉터리를 변환·검증시킨다 (host의 resolve-directory).
 * 반환: { checked: false } (host가 구버전이거나 호출 실패 → 검증 생략)
 *     | { checked: true, exists, path, converted, note }
 */
async function resolveDirectoryViaHost(rawPath) {
  const { serverIsPosix } = await detectServerIsPosix();
  const runtime = serverIsPosix === false ? 'windows' : 'wsl';
  try {
    const res = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, {
      action: 'resolve-directory', path: rawPath, runtime
    });
    if (res?.status === 'success' && typeof res.exists === 'boolean') {
      return { checked: true, exists: res.exists, path: res.path, converted: !!res.converted, note: res.note || null };
    }
    debugLog('WARN', `resolve-directory: 검증 생략 - ${res?.error || 'unexpected response'}`);
  } catch (e) {
    debugLog('WARN', `resolve-directory: 검증 생략 - ${e.message}`);
  }
  return { checked: false };
}

/**
 * 사용자가 지정한 working directory를 "실제 실행 중인 opencode 서버"가 이해하는
 * 경로 포맷으로 정규화한다.
 *
 * host.js는 preferredRuntime 순서(기본 WSL 우선)로 opencode를 찾아 기동하므로 서버가
 * WSL일 수도 Windows일 수도 있다(native-host/host.js findOpenCodePath). 따라서 서버가 항상 WSL이라고 가정하고
 * C:\... 를 /mnt/c/... 로 강제 변환하면, Windows 네이티브로 뜬 서버에는 존재하지
 * 않는 경로를 보내게 되어 working directory 설정이 조용히 무시된다.
 *
 * 판단 우선순위:
 *   1. serverCwd (SSE/probe로 실측한 서버의 실제 cwd 포맷) — 가장 신뢰도 높음
 *   2. serverIsWSL (이번 세션에 native host가 직접 서버를 띄우며 기록한 값)
 *   3. 둘 다 모르면 변환하지 않음
 */
async function normalizeWorkingDirectory(rawPath) {
  if (!rawPath) return '';
  if (!isWindowsDrivePath(rawPath)) {
    return rawPath.replace(/\\/g, '/').replace(/\/$/, '');
  }

  const { serverIsPosix, source } = await detectServerIsPosix();

  if (serverIsPosix === true) {
    const converted = toWSLPath(rawPath);
    debugLog('INFO', `normalizeWorkingDirectory: WSL server (${source}) - ${rawPath} -> ${converted}`);
    return converted;
  }

  // false(Windows 네이티브 확인됨) 또는 null(알 수 없음) — 드라이브 경로 그대로 유지
  const normalized = rawPath.replace(/\\/g, '/').replace(/\/$/, '');
  const level = serverIsPosix === false ? 'INFO' : 'WARN';
  debugLog(level, `normalizeWorkingDirectory: native/unknown server (${source}) - keep drive path, ${rawPath} -> ${normalized}`);
  return normalized;
}

/**
 * /global/event SSE의 첫 이벤트에서 서버의 실제 directory 값을 즉시 한 번 조회한다.
 * 채팅 메시지를 보내기 전(=subscribeToEvents가 아직 안 붙기 전)에도 서버가 실제로
 * 어떤 경로 포맷을 쓰는지 알 수 있도록, 서버 연결이 확인되는 즉시 호출한다.
 */
async function probeServerDirectory(port) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/global/event`, { signal: controller.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const parts = pending.split('\n\n');
      pending = parts.pop();
      for (const part of parts) {
        for (const line of part.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            const raw = JSON.parse(line.slice(5).trim());
            if (raw.directory) {
              reader.cancel().catch(() => {});
              return raw.directory;
            }
          } catch {}
        }
      }
    }
  } catch {
    // 타임아웃/연결 실패 시 조용히 포기 (fallback은 normalizeWorkingDirectory 쪽에서 처리)
  } finally {
    clearTimeout(timeoutId);
  }
  return null;
}

// 서버가 보고한 cwd 형식으로 실행 환경 추정: C:\... → Windows, /... → WSL
function runtimeFromDirectory(directory) {
  if (!directory) return null;
  if (isWindowsDrivePath(directory)) return 'windows';
  return directory.startsWith('/') ? 'wsl' : null;
}

/**
 * cwd 프로브가 실패하거나 SW가 재시작돼 실행 환경을 모를 때의 폴백.
 * host의 server-info가 포트 리스너가 있는 쪽(windows/wsl)을 알려준다. powershell/wsl.exe를
 * 실행해 느리므로 백그라운드로만 호출하고, 동시에 여러 번 돌지 않게 한다.
 * 프로브 등으로 이미 확정된 값은 덮어쓰지 않는다.
 */
let _runtimeDetect = null;
function detectRuntimeFromHost(port) {
  if (_runtimeDetect) return _runtimeDetect;
  _runtimeDetect = (async () => {
    try {
      const info = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { action: 'server-info', port });
      const side = info?.status === 'success' ? info.listener?.side : null;
      const runtime = side === 'wsl' || side === 'windows' ? side : null;
      if (!runtime) {
        debugLog('WARN', `detectRuntimeFromHost: listener side unknown - port=${port}`);
        return;
      }
      if (serverState.runtime || serverState.port !== port) return; // 그 사이 확정/변경됨
      serverState.runtime = runtime;
      chrome.storage.local.set({ serverIsWSL: runtime === 'wsl' }).catch(() => {});
      chrome.runtime.sendMessage({ action: 'server-runtime-updated', runtime }).catch(() => {});
      debugLog('INFO', `detectRuntimeFromHost: server runtime detected via host - ${runtime}`);
    } catch (e) {
      debugLog('WARN', `detectRuntimeFromHost: failed - ${e.message}`);
    } finally {
      _runtimeDetect = null;
    }
  })();
  return _runtimeDetect;
}

async function refreshServerCwd(port) {
  const directory = await probeServerDirectory(port);
  if (!directory) {
    debugLog('WARN', `refreshServerCwd: probe failed or timed out - port=${port}`);
    if (!serverState.runtime) detectRuntimeFromHost(port);
    return;
  }
  // 서버가 보고한 cwd 형식으로 실제 실행 환경을 확정한다(C:\ → Windows, / → WSL).
  const runtime = runtimeFromDirectory(directory);
  if (runtime && runtime !== serverState.runtime) {
    serverState.runtime = runtime;
    chrome.storage.local.set({ serverIsWSL: runtime === 'wsl' }).catch(() => {});
    chrome.runtime.sendMessage({ action: 'server-runtime-updated', runtime }).catch(() => {});
    debugLog('INFO', `refreshServerCwd: server runtime detected - ${runtime}`);
  }
  const { serverCwd } = await chrome.storage.local.get('serverCwd');
  if (serverCwd === directory) return;
  await chrome.storage.local.set({ serverCwd: directory }).catch(() => {});
  debugLog('INFO', `refreshServerCwd: server directory probed - ${directory}`);
  chrome.runtime.sendMessage({ action: 'default-directory-updated', directory }).catch(() => {});
}

// ============================================
// 세션 관리
// ============================================

/**
 * UUID 생성
 */
function generateUUID() {
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * 새 세션 생성
 */
async function createSession(title = 'New Chat') {
  const port = await ensureOpenCodeServer();
  if (!port) {
    throw new Error('OpenCode 서버 연결 실패');
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    const workingDir = await getWorkingDirectory();
    const dirHeader = buildDirectoryHeader(workingDir);
    if (dirHeader) {
      headers['x-opencode-directory'] = dirHeader;
      debugLog('INFO', `createSession: x-opencode-directory set - dir=${workingDir}, encoded=${dirHeader !== workingDir}`);
    }

    const response = await fetch(`http://127.0.0.1:${port}/session`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title })
    });

    if (!response.ok) {
      throw new Error(`세션 생성 실패: ${response.status}`);
    }

    const sessionData = await response.json();
    const sessionId = sessionData.id || sessionData.session?.id;

    if (!sessionId) {
      throw new Error('세션 ID를 찾을 수 없음');
    }

    sessions.set(sessionId, {
      id: sessionId,
      created: Date.now(),
      port: port,
      active: true
    });
    rememberSessionDirectory(sessionId, sessionData.directory || workingDir);

    console.log(`세션 생성 완료: ${sessionId}`);
    return sessionId;
  } catch (error) {
    debugLog('ERROR', `Session create failed - ${error.message}`);
    console.error('세션 생성 오류:', error);
    throw error;
  }
}

/**
 * 탭과의 연결이 끝난 세션을 정리한다(탭 닫기·작업 폴더 변경). TUI처럼 서버의 세션(대화 기록)은 지우지 않으므로
 * /sessions로 이어갈 수 있고, 불러오면 그 세션의 원래 폴더가 적용된다. 응답 중이었다면 중단한다
 * (TUI를 종료하면 진행 중인 작업도 멈춘다. 아무도 보지 않는 응답이 서버에서 계속 돌지 않게).
 */
async function releaseSession(sessionId, reason) {
  if (eventSources.has(sessionId)) {
    stopPromptStream(sessionId);
    const port = sessions.get(sessionId)?.port ?? serverState.port;
    if (port) await abortServerSession(port, sessionId);
  }
  pendingInteractions.delete(sessionId);
  debugLog('INFO', `Session released (${reason}) - sessionId=${sessionId}, kept on server`);
}

/**
 * 프롬프트에 붙일 현재 페이지 정보의 범위 (chrome.storage.local.pageContext)
 *  - 'off'   : 아무것도 붙이지 않음
 *  - 'basic' : 제목·URL (기본값)
 *  - 'full'  : 제목·URL + 본문 일부(제목들, 문단 10개) + 선택한 텍스트.
 *              페이지를 읽으려면 선택적 호스트 권한(<all_urls>)이 필요하고, 사이드패널 설정에서 사용자가 허용한다.
 */
const PAGE_CONTEXT_MODES = ['off', 'basic', 'full'];

// 프롬프트 앞에 붙이는 페이지 정보 머리말. sidepanel.js PAGE_CONTEXT_* 패턴과 반드시 같이 고친다.
const PAGE_CONTEXT_LABELS = {
  ko: { header: '현재 페이지 정보:', title: '제목:', headings: '제목들:', paragraphs: '내용 요약:', selection: '선택한 텍스트:' },
  en: { header: 'Current page:', title: 'Title:', headings: 'Headings:', paragraphs: 'Content excerpt:', selection: 'Selected text:' }
};

async function getUiLang() {
  try {
    return (await chrome.storage.local.get('lang')).lang === 'en' ? 'en' : 'ko';
  } catch {
    return 'ko';
  }
}
/** 응답 제한 시간(ms). 0이면 제한 없음. */
async function getResponseTimeoutMs() {
  try {
    const { responseTimeoutMin } = await chrome.storage.local.get('responseTimeoutMin');
    const min = Number(responseTimeoutMin);
    return RESPONSE_TIMEOUT_CHOICES_MIN.includes(min) ? min * RESPONSE_TIMEOUT_UNIT_MS : 0;
  } catch {
    return 0;
  }
}
async function getPageContextMode() {
  try {
    const { pageContext } = await chrome.storage.local.get('pageContext');
    return PAGE_CONTEXT_MODES.includes(pageContext) ? pageContext : 'basic';
  } catch {
    return 'basic';
  }
}

// 탭 안에서 실행되는 함수 — 바깥 스코프를 참조할 수 없다(executeScript가 직렬화해 주입).
function readPageContentInTab() {
  const sel = (window.getSelection()?.toString() || '').trim();
  return {
    headings: Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 30).map(h => h.innerText.trim()).filter(Boolean),
    paragraphs: Array.from(document.querySelectorAll('p')).slice(0, 10).map(p => p.innerText.trim()).filter(Boolean),
    selectedText: sel ? sel.slice(0, 20000) : null
  };
}

/**
 * 현재 탭 정보를 가져오기
 * @param {{ forPrompt?: boolean }} opts forPrompt면 pageContext 설정에 따라 전송할 범위만 담는다.
 */
async function getCurrentTabInfo({ forPrompt = false } = {}) {
  const empty = { tabId: null, url: '', title: '', favIconUrl: '' };
  try {
    const mode = forPrompt ? await getPageContextMode() : 'basic';
    if (mode === 'off') return empty;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return empty;

    const result = {
      tabId: tab.id,
      url: tab.url,
      title: tab.title,
      favIconUrl: tab.favIconUrl
    };

    if (mode === 'full') {
      try {
        // <all_urls> 선택 권한(또는 activeTab)이 있을 때만 성공한다. chrome://, Web Store 등은 실패 → 제목·URL만 보낸다.
        const [injection] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: readPageContentInTab
        });
        if (injection?.result) result.pageContent = injection.result;
      } catch (e) {
        debugLog('INFO', `page content not read - ${e.message}`);
      }
    }

    return result;
  } catch (error) {
    console.error('getCurrentTabInfo 오류:', error);
    return empty;
  }
}

// ============================================
// 메시지 전송 및 응답 처리
// ============================================

/**
 * 메시지 전송
 */
/** 선택된 모델이 없으면 서버 설정 → 첫 번째 사용 가능 모델 순으로 정한다. */
async function ensureSelectedModel(port) {
  if (selectedModel) return;
  await syncModelFromServer(port);
  if (selectedModel) return;
  const models = await getAvailableModels();
  if (models.length > 0 && models[0].models) {
    const provider = models[0];
    const firstModel = Array.isArray(provider.models)
      ? provider.models[0]
      : Object.values(provider.models)[0];
    if (firstModel) {
      selectedModel = { providerID: provider.id, modelID: firstModel.id || firstModel.name };
      chrome.storage.local.set({ selectedModel });
      debugLog('INFO', `Auto-selected model before send: ${selectedModel.providerID}/${selectedModel.modelID}`);
    }
  }
  if (!selectedModel) {
    throw new Error('사용 가능한 모델이 없습니다. OpenCode에서 AI 제공자 API 키를 설정해 주세요.');
  }
}

/** 프롬프트 요청(헤더·본문)을 만든다. 작업 폴더 헤더와 페이지 정보 머리말을 붙인다. */
async function buildPromptRequest(sessionId, message, tabInfo) {
  const workingDir = await getSessionDirectory(sessionId);
  const headers = { 'Content-Type': 'application/json' };
  const dirHeader = buildDirectoryHeader(workingDir);
  if (dirHeader) {
    headers['x-opencode-directory'] = dirHeader;
    debugLog('INFO', `x-opencode-directory set - dir=${workingDir}, encoded=${dirHeader !== workingDir}, sessionId=${sessionId}`);
  } else {
    debugLog('INFO', `x-opencode-directory not set (no saved working dir) - sessionId=${sessionId}`);
  }
  let fullMessage = message;
  if (tabInfo?.url || tabInfo?.pageContent) {
    // 머리말 언어가 모델의 답변 언어에 영향을 주므로 사이드패널 언어 설정을 따른다.
    // 형식은 sidepanel.js의 stripPageContext()가 히스토리 복원 때 벗겨내는 패턴과 짝이다(양쪽 언어 모두 인식).
    const L = (await getUiLang()) === 'en' ? PAGE_CONTEXT_LABELS.en : PAGE_CONTEXT_LABELS.ko;
    let pageContext = '';
    if (tabInfo.url) {
      pageContext += `
---
${L.header}
- ${L.title} ${tabInfo.title}
- URL: ${tabInfo.url}
`;
    }
    if (tabInfo.pageContent) {
      const content = tabInfo.pageContent;
      if (content.headings?.length) {
        pageContext += `${L.headings}\n${content.headings.join('\n')}\n\n`;
      }
      if (content.paragraphs?.length) {
        pageContext += `${L.paragraphs}\n${content.paragraphs.join('\n')}\n\n`;
      }
      if (content.selectedText) {
        pageContext += `${L.selection}\n${content.selectedText}\n\n`;
      }
    }
    fullMessage = pageContext + message;
  }

  const body = JSON.stringify({
    ...(selectedModel && { model: selectedModel }),
    parts: [{ type: 'text', text: fullMessage }]
  });
  return { headers, body, dirHeader };
}

/**
 * POST /session/{id}/prompt_async. 서버는 세션이 응답 중이어도 204로 접수하고 큐에 넣는다(opencode 1.19.5 실측).
 * 실패·시간 초과면 throw한다. timedOut 오류에는 err.timedOut = true를 붙인다.
 */
async function postPrompt(port, sessionId, { headers, body }) {
  const promptCtrl = new AbortController();
  const promptTimeout = setTimeout(() => promptCtrl.abort(), PROMPT_SEND_TIMEOUT_MS);
  let promptResponse;
  try {
    promptResponse = await fetch(
      `http://127.0.0.1:${port}/session/${sessionId}/prompt_async`,
      { method: 'POST', headers, signal: promptCtrl.signal, body }
    );
  } catch (fetchErr) {
    const timedOut = fetchErr.name === 'AbortError';
    debugLog('ERROR', timedOut
      ? `Prompt fetch timeout (${PROMPT_SEND_TIMEOUT_MS}ms) - sessionId=${sessionId}`
      : `Prompt fetch error - ${fetchErr.message}, sessionId=${sessionId}`);
    if (!timedOut) throw fetchErr;
    const err = new Error(`메시지 전송 시간 초과 (${Math.round(PROMPT_SEND_TIMEOUT_MS / 1000)}s)`);
    err.timedOut = true;
    throw err;
  } finally {
    clearTimeout(promptTimeout);
  }
  if (promptResponse.status !== 204 && promptResponse.status !== 202 && !promptResponse.ok) {
    const text = await promptResponse.text().catch(() => '');
    debugLog('ERROR', `REST /prompt failed - status=${promptResponse.status}, body=${text}, sessionId=${sessionId}`);
    throw new Error(`메시지 전송 실패: ${promptResponse.status} - ${text}`);
  }
  debugLog('INFO', `Prompt sent - sessionId=${sessionId}, status=${promptResponse.status}, model=${selectedModel ? `${selectedModel.providerID}/${selectedModel.modelID}` : 'default'}`);
}

async function sendMessage(sessionId, message, tabInfo, onChunk, onComplete, onPart) {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error('세션을 찾을 수 없음');
  }

  const port = await ensureOpenCodeServer();
  if (!port) {
    throw new Error('OpenCode 서버 연결 실패');
  }
  await ensureSelectedModel(port);

  const request = await buildPromptRequest(sessionId, message, tabInfo);
  const idleTimeoutMs = await getResponseTimeoutMs();

  // prompt 전송 전에 SSE 구독을 먼저 연결 (server.connected 또는 5초 타임아웃까지 대기)
  // /global/event 는 연결 시점 이후 이벤트만 전달하므로, prompt 전송이 먼저
  // 이루어지면 응답이 빠른 모델의 경우 message.part.* 이벤트를 놓칠 수 있음
  const subscribeStart = Date.now();
  await subscribeToEvents(sessionId, port, onChunk, onComplete, onPart, { directory: request.dirHeader, idleTimeoutMs });
  debugLog('INFO', `SSE pre-connected before prompt - sessionId=${sessionId}, elapsedMs=${Date.now() - subscribeStart}, responseTimeoutMs=${idleTimeoutMs || 'none'}`);

  try {
    await postPrompt(port, sessionId, request);
  } catch (err) {
    // 사이드패널에는 전송 실패로 알리므로 이 프롬프트의 스트림을 끝낸다. 서버가 느려서 늦게라도 접수했다면
    // 응답이 실패 표시 뒤에 섞여 들어오므로(그리고 사용자가 다시 보낸 프롬프트와 겹치므로) 서버에도 중단을 요청한다(접수 전에 도착하면 효과 없음 — 최선 노력).
    stopPromptStream(sessionId);
    if (err.timedOut) await abortServerSession(port, sessionId);
    throw err;
  }
}

/**
 * 응답 중인 세션에 대기(pending) 메시지를 보낸다. 서버가 큐에 넣었다가 현재 응답이 끝나면 처리하고,
 * 진행 중인 SSE 구독이 그 응답까지 이어서 받는다(turn-start로 사이드패널이 새 말풍선을 연다).
 * 진행 중인 구독이 없으면(직전에 끝남) { queued: false }를 돌려주고, 사이드패널이 일반 전송으로 보낸다.
 */
async function queueMessage(sessionId, message, tabInfo) {
  const stream = eventSources.get(sessionId)?.queue;
  if (!stream) return { queued: false };
  const request = await buildPromptRequest(sessionId, message, tabInfo);
  // 접수 전에 idle이 와도 완료로 처리하지 않도록 먼저 센다
  stream.add();
  try {
    await postPrompt(stream.port, sessionId, request);
  } catch (err) {
    stream.remove();
    throw err;
  }
  debugLog('INFO', `Queued message sent - sessionId=${sessionId}, queued=${stream.outstanding()}`);
  return { queued: true };
}

/** 세션의 응답 스트림 구독(SSE + 무응답 타이머)을 끝낸다. */
function stopPromptStream(sessionId) {
  const ctrl = eventSources.get(sessionId);
  if (!ctrl) return;
  ctrl.abort();
  eventSources.delete(sessionId);
}

/**
 * 서버의 세션 실행을 중단한다 (POST /session/{id}/abort).
 * 로컬 SSE만 끊으면 서버에서는 hang된 tool이 남아 세션이 계속 busy라
 * 이후 프롬프트가 큐에서 대기만 한다. abort는 실행 중 tool을 종료하고 대기 큐도 비운다(실측).
 */
async function abortServerSession(port, sessionId) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/session/${sessionId}/abort`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000)
    });
    debugLog('INFO', `Server session abort - sessionId=${sessionId}, status=${res.status}`);
    return res.ok;
  } catch (e) {
    debugLog('WARN', `Server session abort failed - sessionId=${sessionId}, error=${e.message}`);
    return false;
  }
}

/**
 * 세션의 마지막 assistant 메시지를 REST로 조회해 텍스트 파트를 추출
 * SSE에서 message.part.* 이벤트를 놓쳤을 때 (idle/timeout 시 buffer가 빈 경우) 안전망으로 사용
 */
async function fetchFallbackContent(port, sessionId) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/session/${sessionId}/message`);
    if (!res.ok) return { content: '', partTypes: [], lastMessageId: null };

    const messages = await res.json();
    const assistantMessages = (messages || []).filter(m => m?.info?.role === 'assistant');
    const last = assistantMessages[assistantMessages.length - 1];
    if (!last) return { content: '', partTypes: [], lastMessageId: null };

    const parts = last.parts || [];
    const partTypes = parts.map(p => p.type);
    // tool이 pending/running으로 남아 있으면 서버가 도구 실행에서 멈춘 것 (실측: state.status)
    const hasUnfinishedTool = parts.some(p => p.type === 'tool' && ['pending', 'running'].includes(p.state?.status));
    const content = parts
      .filter(p => p.type === 'text' && p.text)
      .map(p => p.text)
      .join('');

    const e = last.info?.error;
    const errorMessage = e?.data?.message || e?.message || e?.name || null;
    return { content, partTypes, lastMessageId: last.info?.id || null, errorMessage, hasUnfinishedTool };
  } catch (e) {
    return { content: '', partTypes: [], lastMessageId: null, error: e.message };
  }
}

/**
 * 세션의 전체 대화 내역을 패널 렌더링용 형태로 변환해 반환한다.
 * 실측된 실제 응답 스키마(info.role, parts[].type)를 그대로 사용
 * (docs/session_history_plan.md §2.1).
 */
async function getSessionHistory(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return { success: false, messages: [], error: 'unknown session' };

  try {
    const res = await fetch(`http://127.0.0.1:${session.port}/session/${sessionId}/message`);
    if (!res.ok) return { success: false, messages: [], error: `status ${res.status}` };

    const raw = await res.json();
    const messages = (raw || [])
      .filter(m => m.info?.role === 'user' || m.info?.role === 'assistant')
      .map(m => ({
        role: m.info.role,
        id: m.info.id,
        parentID: m.info.parentID || null,
        text: (m.parts || [])
          .filter(p => p.type === 'text' && typeof p.text === 'string')
          .map(p => p.text)
          .join('')
      }));

    // 진행 중인 응답이 있으면 사이드패널이 이어 그릴 수 있게 상태를 함께 준다(기록을 읽은 뒤에 찍어 더 최신이다).
    const ctrl = eventSources.get(sessionId);
    const stream = ctrl && !ctrl.signal.aborted && ctrl.snapshot ? ctrl.snapshot() : null;
    return { success: true, messages, notices: sessionNotices.get(sessionId) || [], stream };
  } catch (e) {
    debugLog('ERROR', `getSessionHistory: failed - sessionId=${sessionId}, error=${e.message}`);
    return { success: false, messages: [], error: e.message };
  }
}

/**
 * 세션이 서버에 실제로 아직 존재하는지 가볍게 확인한다.
 * GET /session/{id}는 존재 시 200, 없으면 404를 반환한다(실측 확인).
 */
async function checkSessionExists(port, sessionId) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/session/${sessionId}`);
    return res.ok;
  } catch {
    return false;
  }
}

// 사용자 응답을 기다리는 권한/질문 요청: sessionId -> Map(requestId -> part).
// 사이드패널이 탭 전환·재오픈으로 카드를 잃어도 다시 그릴 수 있게 SW가 보관한다(get-pending-interactions).
const pendingInteractions = new Map();

/**
 * SSE 이벤트 구독 (/global/event + Last-Event-ID 재연결)
 * server.connected 수신 시 resolve → 이후 prompt_async 전송
 * 스트림 종료 시 Last-Event-ID로 재연결하여 응답 이벤트 수신
 * directory: 프롬프트를 보낸 x-opencode-directory 값. 세션 상태(/session/status)는 디렉터리 instance별이라
 *            재연결 후 idle 확인·SW 재시작 복구에서 같은 값으로 물어야 한다.
 * idleTimeoutMs: 무이벤트 제한(⚙ 응답 제한 시간). 0이면 시간으로 끊지 않고 서버 상태 확인(checkQuiet)만 한다.
 */
function subscribeToEvents(sessionId, port, onChunk, onComplete, onPart, { directory = null, idleTimeoutMs = 0 } = {}) {
  const existing = eventSources.get(sessionId);
  if (existing) existing.abort();

  const controller = new AbortController();
  eventSources.set(sessionId, controller);

  // 응답 대기 동안 SW 유지 + 재시작 복구용 기록. 모든 종료 경로가 abort()를 거치므로 abort에서 해제한다.
  swKeepAlive.acquire(sessionId);
  pendingPrompts.add(sessionId, port, directory, idleTimeoutMs);
  controller.signal.addEventListener('abort', () => {
    swKeepAlive.release(sessionId);
    pendingPrompts.remove(sessionId);
    pendingInteractions.delete(sessionId);
  }, { once: true });

  return new Promise((resolveConnected) => {
    let resolved = false;
    let buffer = '';
    let completed = false;
    // 청크 순번. 사이드패널이 탭 전환 후 스냅샷(snapshot().text)으로 말풍선을 다시 그릴 때, 스냅샷에 이미 포함된
    // 청크(seq ≤ snapshot.seq)를 걸러 중복을 막는다.
    let chunkSeq = 0;
    const emitChunk = (delta) => onChunk(delta, ++chunkSeq);
    // 완료 콜백에 오류 위치(직전 메시지 id)를 붙인다 → send-message가 오류 안내를 세션에 기록한다.
    const complete = (content, error) => onComplete(content, error, {
      anchorId: assistantMessageId || turnParentId || userMessageIds.at(-1) || null
    });
    let assistantMessageId = null;
    let routerState = createRouterState();
    // 이 프롬프트에 속한 세션들: 본 세션 + task 도구가 만든 하위(subagent) 세션.
    // 하위 세션의 이벤트는 화면에 그리지 않지만, 진행 신호(타임아웃 리셋)와 권한/질문 요청은 처리해야 한다.
    const relatedSessions = new Set([sessionId]);
    // 하위 세션 진행 상황(단계 수·현재 활동)을 task 도구 카드에 붙여 보여 준다. 안 보이면 수 분간 멈춘 것처럼 보인다.
    const subagents = createSubagentTracker({ rootSessionId: sessionId });
    const emitSubagent = (progress) => { if (progress) onPart?.(progress); };
    // 사용자 응답을 기다리는 권한/질문 요청 id. 남아 있는 동안에는 무응답 타임아웃을 걸지 않는다.
    const pendingAsks = new Set();

    // 제공자 재시도(레이트 리밋·과부하) 대기 중이면 다음 시도 시각(epoch ms). 대기 중에는 서버가 이벤트를
    // 보내지 않는데, Retry-After에는 상한이 없어 무응답 제한보다 길 수 있다 → 그 시각까지는 기다려 준다.
    let retryUntil = 0;

    // 대기(pending) 메시지: 응답 중에 queue-message로 보낸 프롬프트. 서버가 큐에 넣었다가 현재 응답 뒤에 처리한다.
    // 처리 시작은 "부모(user 메시지)가 다른 assistant 메시지"로 안다(같은 턴의 여러 단계는 부모가 같다).
    // userMessageIds[0] = 원래 프롬프트, [k] = k번째 대기 메시지(서버가 받은 순서).
    const userMessageIds = [];
    let turnParentId = null;
    let queuedSent = 0;      // 접수 요청한 대기 메시지 수
    let queuedConsumed = 0;  // 서버가 처리를 시작한 대기 메시지 수
    let queueGraceTimer = null;
    // 사이드패널이 탭 전환·재오픈 후 진행 중인 응답을 이어 그리기 위한 현재 상태(get-session-history의 stream).
    controller.snapshot = () => ({
      turnParentId,
      text: buffer,
      seq: chunkSeq,
      turnStartedAt,
      lastActivityAt,
      retry: retryUntil && retryUntil > Date.now() ? lastRetry : null,
      queuedConsumed,
      queuedOutstanding: queuedSent - queuedConsumed
    });
    controller.queue = {
      port,
      add() { if (completed || controller.signal.aborted) return false; queuedSent++; return true; },
      remove() { queuedSent = Math.max(queuedConsumed, queuedSent - 1); },
      outstanding: () => queuedSent - queuedConsumed
    };

    let timeoutId = null;
    let lastActivityAt = Date.now();
    let turnStartedAt = Date.now();
    let lastRetry = null; // 사이드패널 복원용 마지막 retry 파트
    // 스트림이 어떤 경로로든 끝나면(cancel-message, 전송 실패, 새 프롬프트가 기존 구독을 대체 등) 타이머도 끝낸다.
    // 안 그러면 남은 타이머가 뒤늦게 "응답 시간 초과"를 보내고 서버 세션을 abort해 다음 프롬프트까지 죽인다.
    controller.signal.addEventListener('abort', () => {
      completed = true;
      clearTimeout(timeoutId);
      clearTimeout(queueGraceTimer);
      clearInterval(quietTimer);
    }, { once: true });
    // 이 구독이 아직 eventSources에 등록된 것일 때만 지운다(새 프롬프트가 대체한 구독을 지우지 않게).
    function detach() {
      if (eventSources.get(sessionId) === controller) eventSources.delete(sessionId);
    }
    function resetTimeout() {
      lastActivityAt = Date.now();
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = null;
      if (completed || controller.signal.aborted) return;
      // 제한 없음(기본): 시간으로 끊지 않는다. 멈춤 판단은 checkQuiet가 서버 상태로 한다.
      if (!idleTimeoutMs) return;
      // 사용자 응답 대기 중에는 무응답 제한 대신 넉넉한 상한(30분)만 둔다.
      // 카드가 어떤 이유로든 사라져도 세션이 영원히 멈추지 않게 하기 위함.
      const baseMs = pendingAsks.size > 0 ? Math.max(STREAM_ASK_TIMEOUT_MS, idleTimeoutMs) : idleTimeoutMs;
      // 재시도 대기 중이면 "다음 시도 시각 + 기본 제한"까지 연장한다(그 뒤에도 조용하면 정말 멈춘 것).
      const limitMs = retryUntil ? Math.max(baseMs, retryUntil - Date.now() + baseMs) : baseMs;
      timeoutId = setTimeout(async () => {
        if (!completed) {
          controller.abort();
          detach();
          debugLog('ERROR', `SSE timeout (${idleTimeoutMs}ms setting) - sessionId=${sessionId}, assistantMessageId=${assistantMessageId || 'none'}, bufferLength=${buffer.length}`);

          let finalContent = buffer || '';
          let errMsg = '응답 시간 초과 — ⚙ 설정에서 응답 제한 시간을 늘리거나 끌 수 있습니다.';
          if (finalContent.length === 0) {
            debugLog('WARN', `Empty buffer at timeout - falling back to REST /session/${sessionId}/message`);
            const fallback = await fetchFallbackContent(port, sessionId);
            if (fallback.content) {
              debugLog('INFO', `REST fallback recovered ${fallback.content.length} chars - sessionId=${sessionId}, lastMessageId=${fallback.lastMessageId}, partTypes=${JSON.stringify(fallback.partTypes)}`);
              finalContent = fallback.content;
              errMsg = null;
            } else {
              debugLog('INFO', `REST fallback found no text parts - sessionId=${sessionId}, lastMessageId=${fallback.lastMessageId || 'none'}, partTypes=${JSON.stringify(fallback.partTypes)}, unfinishedTool=${!!fallback.hasUnfinishedTool}`);
              if (fallback.hasUnfinishedTool) errMsg = '도구 실행이 멈춰 세션을 중단했습니다. 같은 문제가 반복되면 /new로 새 세션을 시작하거나 ⚙에서 서버를 재시작하세요.';
            }
          }
          // 타임아웃 = 설정한 시간 동안 이벤트 없음. 서버에 busy 세션이 남지 않도록 항상 abort한다
          // (이미 idle인 세션에는 무해). 안 하면 다음 프롬프트가 큐에서 영원히 대기한다.
          await abortServerSession(port, sessionId);
          complete(finalContent, errMsg);
        }
      }, limitMs);
    }
    resetTimeout();

    function resolveOnce() {
      if (!resolved) { resolved = true; resolveConnected(); }
    }

    // session.status retry: 대기 시각을 기록하고 사이드패널에 "재시도 중"을 알린다(하위 세션 것도 포함).
    function noteRetry(st, evtSessionId) {
      const next = Number(st.next);
      retryUntil = Number.isFinite(next) ? next : 0;
      debugLog('WARN', `Session retry - sessionId=${evtSessionId}${evtSessionId !== sessionId ? ` (subagent of ${sessionId})` : ''}, attempt=${st.attempt}, next=${retryUntil ? new Date(retryUntil).toISOString() : 'none'}, message=${st.message || ''}`);
      lastRetry = {
        kind: 'retry',
        attempt: st.attempt,
        message: st.message || '',
        next: retryUntil || null,
        fromSubagent: evtSessionId !== sessionId
      };
      onPart?.(lastRetry);
      resetTimeout();
    }

    // 재시도 후 실제 진행(busy/delta/도구·텍스트 파트)이 보이면 대기 상태를 해제한다.
    // message.updated나 retry 파트는 재시도 대기 중에도 올 수 있어 해제 신호로 쓰지 않는다.
    function clearRetry() {
      if (!retryUntil) return;
      retryUntil = 0;
      onPart?.({ kind: 'retry-cleared' });
    }

    // 응답 완료 처리(session.idle 또는 재연결 후 idle 확인). 텍스트가 비면 REST로 복구한다.
    // 대기 메시지가 아직 처리되지 않았으면 완료하지 않는다: 접수가 idle 직후였다면 서버가 곧 다시 busy가 된다.
    // QUEUE_IDLE_GRACE_MS 뒤에도 idle이면 대기 메시지는 처리되지 않은 것으로 보고 완료한다(사이드패널이 표시).
    async function completeAsIdle(reason, { force = false } = {}) {
      if (completed) return;
      if (!force && queuedSent > queuedConsumed) {
        if (queueGraceTimer) return;
        debugLog('INFO', `Idle with queued messages outstanding (${reason}) - sessionId=${sessionId}, outstanding=${queuedSent - queuedConsumed}`);
        queueGraceTimer = setTimeout(async () => {
          queueGraceTimer = null;
          if (completed || controller.signal.aborted || queuedSent <= queuedConsumed) return;
          const { reachable, status } = await fetchSessionStatus();
          if (completed || controller.signal.aborted || queuedSent <= queuedConsumed) return;
          if (reachable && status && status.type !== 'idle') return; // 대기 메시지 처리 시작 → 이벤트가 이어진다
          debugLog('WARN', `Queued messages not processed - sessionId=${sessionId}, outstanding=${queuedSent - queuedConsumed}`);
          await completeAsIdle(`${reason}+queue-unprocessed`, { force: true });
        }, QUEUE_IDLE_GRACE_MS);
        return;
      }
      completed = true;
      clearTimeout(timeoutId);
      controller.abort();
      detach();
      debugLog('INFO', `Session idle (${reason}) - sessionId=${sessionId}, assistantMessageId=${assistantMessageId || 'none'}, trackedParts=${routerState.partTypes.size}, bufferLength=${buffer.length}`);

      let finalContent = buffer;
      let idleError = null;
      if (buffer.length === 0) {
        debugLog('WARN', `Empty buffer at idle - falling back to REST /session/${sessionId}/message`);
        const fallback = await fetchFallbackContent(port, sessionId);
        if (fallback.content) {
          debugLog('INFO', `REST fallback recovered ${fallback.content.length} chars - sessionId=${sessionId}, lastMessageId=${fallback.lastMessageId}, partTypes=${JSON.stringify(fallback.partTypes)}`);
          finalContent = fallback.content;
        } else {
          debugLog('INFO', `REST fallback found no text parts - sessionId=${sessionId}, lastMessageId=${fallback.lastMessageId || 'none'}, partTypes=${JSON.stringify(fallback.partTypes)}, error=${fallback.errorMessage || 'none'}`);
          if (fallback.partTypes.length === 0) {
            idleError = fallback.errorMessage || '모델이 빈 응답을 반환했습니다. 서버/모델 설정을 확인하거나 /ext-log로 로그를 확인하세요.';
          }
        }
      }
      if (idleError) { complete(null, idleError); return; }
      complete(finalContent);
    }

    // 새 assistant 메시지가 시작됐다. 부모(user 메시지)가 바뀌었으면 대기 메시지의 응답이 시작된 것이다.
    function noteAssistantTurn(parentId) {
      if (!parentId || parentId === turnParentId) return;
      const first = turnParentId === null;
      turnParentId = parentId;
      const idx = userMessageIds.indexOf(parentId);
      // 부모의 user 이벤트를 놓쳤으면 다음 대기 메시지로 본다
      const consumed = Math.min(queuedSent, idx >= 0 ? idx : queuedConsumed + (first ? 0 : 1));
      if (consumed <= queuedConsumed && first) return; // 원래 프롬프트의 응답 시작
      queuedConsumed = Math.max(queuedConsumed, consumed);
      // 첫 응답이 곧바로 대기 메시지에 대한 것(서버가 둘을 한 번에 처리)이면 새 말풍선 없이 배지만 정리한다
      const newBubble = !first;
      if (newBubble) { buffer = ''; turnStartedAt = Date.now(); } // buffer = 현재 턴의 텍스트(완료 시 마지막 말풍선의 REST 폴백 판단에 쓴다)
      debugLog('INFO', `Queued message turn started - sessionId=${sessionId}, parentId=${parentId}, consumed=${queuedConsumed}/${queuedSent}, newBubble=${newBubble}`);
      onPart?.({ kind: 'turn-start', consumed: queuedConsumed, newBubble });
    }

    async function fetchSessionStatus() {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/session/status`, { ...sessionStatusInit(directory), signal: AbortSignal.timeout(5000) });
        if (!res.ok) return { reachable: false };
        return { reachable: true, status: (await res.json())?.[sessionId] || null };
      } catch {
        return { reachable: false };
      }
    }

    // 이벤트가 STREAM_QUIET_CHECK_MS 이상 없으면 서버에 세션 상태를 묻는다(응답 제한 시간 설정과 무관하게 항상).
    //  - busy/retry: 서버가 아직 일하는 중 → 계속 기다리고 사이드패널에 "서버 처리 중 확인"을 알린다(heartbeat).
    //  - idle: 완료 신호를 놓쳤다 → 완료 처리. 응답이 한 번도 시작되지 않았으면 두 번 연속 확인 뒤 오류로 끝낸다.
    //  - 연결 실패가 STREAM_SERVER_LOST_CHECKS번 이어지면 서버가 사라진 것으로 보고 오류로 끝낸다.
    let quietFails = 0;
    let quietIdleNoAssistant = 0;
    let lastQuietCheckAt = 0;
    let quietChecking = false;
    async function checkQuiet() {
      if (completed || controller.signal.aborted || quietChecking) return;
      const now = Date.now();
      if (now - lastActivityAt < STREAM_QUIET_CHECK_MS || now - lastQuietCheckAt < STREAM_QUIET_CHECK_MS) return;
      quietChecking = true;
      lastQuietCheckAt = now;
      try {
        const { reachable, status } = await fetchSessionStatus();
        if (completed || controller.signal.aborted) return;
        const quietSec = Math.round((Date.now() - lastActivityAt) / 1000);
        if (!reachable) {
          quietFails++;
          debugLog('WARN', `Quiet check: server unreachable (${quietFails}/${STREAM_SERVER_LOST_CHECKS}) - sessionId=${sessionId}, quietSec=${quietSec}`);
          onPart?.({ kind: 'heartbeat', state: 'unreachable', at: Date.now() });
          if (quietFails >= STREAM_SERVER_LOST_CHECKS) {
            finishWithError('서버에 연결할 수 없어 응답 대기를 중단했습니다. ⚙에서 서버를 재시작해 보세요.');
          }
          return;
        }
        quietFails = 0;
        if (status && status.type !== 'idle') {
          quietIdleNoAssistant = 0;
          debugLog('INFO', `Quiet check: server still ${status.type} - sessionId=${sessionId}, quietSec=${quietSec}`);
          onPart?.({ kind: 'heartbeat', state: 'busy', at: Date.now() });
          return;
        }
        if (pendingAsks.size > 0) return; // 사용자 응답 대기 카드가 있으면 건드리지 않는다
        if (assistantMessageId) {
          debugLog('WARN', `Quiet check: session idle but no completion event - sessionId=${sessionId}, quietSec=${quietSec}`);
          await completeAsIdle('quiet-check');
          return;
        }
        if (++quietIdleNoAssistant >= 2) {
          debugLog('ERROR', `Quiet check: session idle and response never started - sessionId=${sessionId}, quietSec=${quietSec}`);
          finishWithError('서버가 응답을 시작하지 않았습니다. 다시 보내 보세요. 반복되면 /ext-log로 로그를 확인하세요.');
        }
      } finally {
        quietChecking = false;
      }
    }
    const quietTimer = setInterval(() => { checkQuiet().catch(() => {}); }, Math.max(10, STREAM_QUIET_CHECK_MS / 4));

    function finishWithError(errMsg) {
      if (completed) return;
      completed = true;
      controller.abort();
      detach();
      complete(buffer || null, errMsg);
    }

    function emitAsk(part) {
      if (!pendingInteractions.has(sessionId)) pendingInteractions.set(sessionId, new Map());
      pendingInteractions.get(sessionId).set(part.id, part);
      onPart?.(part);
    }

    // permission.asked / question.asked 와 그 응답 이벤트를 사이드패널로 전달한다.
    // 처리했으면 true. (v2 이벤트는 아직 opencode 기본 경로가 아니라 다루지 않는다.)
    function handleInteractionEvent(evt) {
      const p = evt.properties || {};
      switch (evt.type) {
        case 'permission.asked':
          pendingAsks.add(p.id);
          resetTimeout();
          debugLog('INFO', `Permission asked - sessionId=${p.sessionID}, requestId=${p.id}, permission=${p.permission}`);
          emitAsk({
            kind: 'permission',
            id: p.id,
            sessionID: p.sessionID,
            fromSubagent: p.sessionID !== sessionId,
            permission: p.permission,
            patterns: Array.isArray(p.patterns) ? p.patterns : [],
            always: Array.isArray(p.always) ? p.always : []
          });
          return true;
        case 'question.asked':
          pendingAsks.add(p.id);
          resetTimeout();
          debugLog('INFO', `Question asked - sessionId=${p.sessionID}, requestId=${p.id}, count=${p.questions?.length || 0}`);
          emitAsk({
            kind: 'question',
            id: p.id,
            sessionID: p.sessionID,
            fromSubagent: p.sessionID !== sessionId,
            questions: Array.isArray(p.questions) ? p.questions : []
          });
          return true;
        case 'permission.replied':
        case 'question.replied':
        case 'question.rejected': {
          const requestId = p.requestID;
          if (!pendingAsks.delete(requestId)) return true; // 다른 프롬프트의 요청
          pendingInteractions.get(sessionId)?.delete(requestId);
          resetTimeout();
          debugLog('INFO', `${evt.type} - requestId=${requestId}, reply=${p.reply || ''}`);
          onPart?.({ kind: 'interaction-resolved', id: requestId, reply: p.reply || (evt.type === 'question.rejected' ? 'reject' : 'answered') });
          return true;
        }
      }
      return false;
    }

    async function connect(lastEventId = '', isReconnect = false) {
      if (completed || controller.signal.aborted) return;
      // catch(네트워크 오류) 경로에서도 마지막으로 받은 이벤트 id로 재연결해야 하므로 try 밖에 둔다.
      let currentId = lastEventId;

      try {
        const headers = { 'Accept': 'text/event-stream', 'Cache-Control': 'no-cache' };
        if (lastEventId) headers['Last-Event-ID'] = lastEventId;

        const response = await fetch(
          `http://127.0.0.1:${port}/global/event`,
          { headers, signal: controller.signal }
        );

        if (!response.ok) {
          debugLog('ERROR', `SSE connect failed - status=${response.status}, sessionId=${sessionId}`);
          resolveOnce();
          clearTimeout(timeoutId);
          controller.abort();
          detach();
          complete('', `SSE 연결 실패: ${response.status}`);
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // SSE 규격상 줄바꿈은 \n, \r\n, \r 모두 가능하다. 청크 경계에서 \r\n이 갈리지 않도록 끝의 \r은 남겨 둔다.
          pending += decoder.decode(value, { stream: true });
          const tail = pending.endsWith('\r') ? '\r' : '';
          pending = (tail ? pending.slice(0, -1) : pending).replace(/\r\n?/g, '\n');

          // SSE 이벤트는 빈 줄(\n\n)로 구분
          const parts = pending.split('\n\n');
          pending = parts.pop() + tail;

          for (const part of parts) {
            let sseId = '';
            const dataLines = [];

            for (const line of part.split('\n')) {
              if (line.startsWith('id:')) sseId = line.slice(3).trim();
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
            }
            // 여러 줄 data:는 \n으로 이어 붙인다(규격).
            const sseData = dataLines.join('\n').trim();

            if (sseId) currentId = sseId;
            if (!sseData) continue;

            try {
              const raw = JSON.parse(sseData);
              // /global/event 는 { directory, payload } 래퍼
              const evt = raw.payload || raw;
              // id 가 SSE id: 필드 없이 JSON 안에 있을 경우 fallback
              if (!currentId && raw.id) currentId = raw.id;
              // 서버 cwd 를 storage 에 캐시하고 sidepanel 에 즉시 알림 (기본 폴더 표시용)
              if (raw.directory) {
                chrome.storage.local.get('serverCwd').then(({ serverCwd }) => {
                  if (serverCwd !== raw.directory) {
                    chrome.storage.local.set({ serverCwd: raw.directory }).catch(() => {});
                    chrome.runtime.sendMessage({ action: 'default-directory-updated', directory: raw.directory }).catch(() => {});
                  }
                }).catch(() => {});
              }


              if (evt.type === 'server.connected') {
                debugLog('INFO', `SSE connected - sessionId=${sessionId}${isReconnect ? ' (reconnect)' : ''}`);
                resolveOnce();
                // 끊긴 사이에 session.idle이 지나갔을 수 있다(서버가 Last-Event-ID로 재전송하지 않으면 유실).
                if (isReconnect) checkIdleAfterReconnect();
                continue;
              }

              // 하위(subagent) 세션 추적: task 도구가 만든 세션은 parentID가 관련 세션을 가리킨다.
              if (evt.type === 'session.created' || evt.type === 'session.updated') {
                const sInfo = evt.properties?.info;
                if (sInfo?.id && sInfo.parentID && relatedSessions.has(sInfo.parentID)) {
                  relatedSessions.add(sInfo.id);
                  emitSubagent(subagents.onSessionInfo(sInfo));
                }
              }

              // 세션 ID 필터
              const evtSession = evt.properties?.sessionID
                || evt.properties?.part?.sessionID
                || evt.properties?.info?.sessionID;
              if (evtSession && !relatedSessions.has(evtSession)) continue;

              // 권한/질문 요청은 하위 세션에서 와도 사용자에게 보여야 한다(안 보이면 서버가 영원히 대기).
              if (handleInteractionEvent(evt)) continue;

              if (evtSession && evtSession !== sessionId) {
                // 하위 세션 활동 = 본 세션의 task 도구가 아직 일하는 중
                const childStatus = evt.type === 'session.status' ? evt.properties?.status : null;
                if (childStatus?.type === 'retry') { noteRetry(childStatus, evtSession); continue; }
                if (childStatus?.type === 'busy' || evt.type === 'message.part.delta') clearRetry();
                if (evt.type === 'message.updated') subagents.onChildMessage(evt.properties?.info);
                if (evt.type === 'message.part.updated') emitSubagent(subagents.onChildPart(evt.properties?.part));
                resetTimeout();
                continue;
              }

              switch (evt.type) {
                case 'message.updated': {
                  const info = evt.properties?.info;
                  if (info?.sessionID === sessionId) resetTimeout();
                  if (info?.role === 'user' && info?.sessionID === sessionId && info.id && !userMessageIds.includes(info.id)) {
                    userMessageIds.push(info.id);
                  }
                  if (info?.role === 'assistant' && info?.sessionID === sessionId) {
                    if (info.id !== assistantMessageId) noteAssistantTurn(info.parentID || null);
                    assistantMessageId = info.id;
                    debugLog('INFO', `Assistant message started - sessionId=${sessionId}, messageId=${info.id}, model=${info.providerID || '?'}/${info.modelID || '?'}`);

                    // 현재 선택된 모델 정보 감지 및 저장
                    if (info.modelID && info.providerID) {
                      selectedModel = { providerID: info.providerID, modelID: info.modelID };
                      chrome.storage.local.set({ selectedModel }).catch(() => {});
                      console.log('모델 정보 저장됨:', selectedModel);
                    }
                  }
                  break;
                }
                case 'message.part.updated': {
                  const part = evt.properties?.part;
                  // 도구 상태 변경(pending→running→completed)도 진행 신호다. 긴 bash 실행 중엔 delta가 없다.
                  if (part?.sessionID === sessionId) {
                    if (part.type !== 'retry') clearRetry();
                    resetTimeout();
                  }
                  const routed = routeMessagePartUpdated(routerState, part, assistantMessageId);
                  if (routed?.action === 'part') {
                    onPart?.(routed.part);
                  } else if (routed?.action === 'debug') {
                    debugLog('INFO', `Non-text part for assistant message - sessionId=${sessionId}, messageId=${assistantMessageId}, partId=${part.id}, partType=${routed.partType}`);
                  }
                  // 카드(routed.part)가 먼저 그려진 뒤에 진행 상황을 붙인다
                  if (part?.sessionID === sessionId) emitSubagent(subagents.onRootPart(part));
                  break;
                }
                case 'message.part.delta': {
                  const routed = routeMessagePartDelta(routerState, evt.properties);
                  if (routed?.action === 'chunk') {
                    clearRetry();
                    buffer += routed.delta;
                    emitChunk(routed.delta);
                    resetTimeout();
                  } else if (routed?.action === 'part') {
                    clearRetry();
                    onPart?.(routed.part);
                    resetTimeout();
                  }
                  break;
                }
                case 'session.idle': {
                  await completeAsIdle('idle');
                  if (completed) return;
                  break; // 대기 메시지가 남아 완료를 미뤘다 → 계속 받는다
                }
                case 'session.status': {
                  // busy/retry = 서버가 아직 처리 중. retry는 제공자 재시도(레이트 리밋 등) 안내를 남긴다.
                  const st = evt.properties?.status;
                  if (st?.type === 'retry') { noteRetry(st, sessionId); break; }
                  if (st?.type === 'busy') { clearRetry(); resetTimeout(); }
                  // session.idle은 deprecated 경로라 status idle도 완료 신호로 받는다(프롬프트 처리를 본 뒤에만).
                  if (st?.type === 'idle' && assistantMessageId && evt.properties?.sessionID === sessionId) {
                    await completeAsIdle('status-idle');
                    if (completed) return;
                  }
                  break;
                }
                case 'server.instance.disposed': {
                  // 소프트 재시작(POST /global/dispose) 시 서버가 SSE 스트림을 끊는다.
                  // 아래 "스트림 정상 종료 → Last-Event-ID 재연결" 경로가 자동으로 다시
                  // 붙으므로 여기서는 진단용 기록만 남긴다. 단, 진행 중이던 프롬프트는
                  // Instance와 함께 사라지므로 응답은 오지 않는다(타임아웃 폴백에 맡긴다).
                  debugLog('INFO', `Server instance disposed - directory=${evt.properties?.directory || '?'}, sessionId=${sessionId}`);
                  break;
                }
                case 'session.error': {
                  completed = true;
                  clearTimeout(timeoutId);
                  controller.abort();
                  detach();
                  const errMsg = evt.properties?.error?.data?.message
                    || evt.properties?.error?.message
                    || evt.properties?.error?.name
                    || '오류가 발생했습니다';
                  debugLog('ERROR', `Session error - sessionId=${sessionId}, error=${errMsg}`);
                  complete(null, errMsg);
                  return;
                }
              }
            } catch (e) {
              console.error('SSE 파싱 오류:', e, sseData);
              debugLog('ERROR', `SSE parse error - sessionId=${sessionId}, error=${e.message}`);
            }
          }
        }

        // 스트림 정상 종료 → Last-Event-ID 로 재연결
        if (!completed && !controller.signal.aborted) {
          await new Promise(r => setTimeout(r, 500));
          connect(currentId, true);
        }
      } catch (error) {
        if (error.name === 'AbortError') return;
        debugLog('ERROR', `SSE error - ${error.message}, sessionId=${sessionId}`);
        console.error('SSE 오류:', error);
        resolveOnce();
        if (!completed && !controller.signal.aborted) {
          await new Promise(r => setTimeout(r, 2000));
          connect(currentId, true);
        }
      }
    }

    // 재연결 직후 세션이 이미 idle이면(= 끊긴 사이 완료) 완료 처리한다.
    // 사용자 응답 대기 중인 요청이 있으면 서버는 busy이므로 건드리지 않는다.
    async function checkIdleAfterReconnect() {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/session/status`, { ...sessionStatusInit(directory), signal: AbortSignal.timeout(3000) });
        // 어시스턴트 메시지를 아직 못 봤다면 프롬프트가 처리되기 전일 수 있다 → idle을 완료로 보지 않는다(타임아웃 폴백에 맡김).
        if (!res.ok || completed || !assistantMessageId) return;
        const statusMap = await res.json();
        const st = statusMap?.[sessionId];
        if (!st || st.type === 'idle') await completeAsIdle('reconnect-check');
      } catch (e) {
        debugLog('WARN', `Idle check after reconnect failed - sessionId=${sessionId}, error=${e.message}`);
      }
    }

    connect();
    // 5초 내 server.connected 없으면 강제 resolve
    setTimeout(resolveOnce, 5000);
  });
}

/**
 * 현재 서버 설정 가져오기
 */
async function getCurrentServerConfig() {
  const port = await ensureOpenCodeServer();
  if (!port) return null;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/config`);
    if (response.ok) {
      return await response.json();
    }
  } catch (error) {
    console.error('서버 설정 가져오기 실패:', error);
  }
  return null;
}

/**
 * 모델 목록 가져오기
 */
async function getAvailableModels() {
  const port = await ensureOpenCodeServer();
  if (!port) return [];

  try {
    const response = await fetch(`http://127.0.0.1:${port}/config/providers`);
    if (response.ok) {
      const data = await response.json();
      return data.providers || [];
    }
    debugLog('WARN', `REST /config/providers failed - status=${response.status}`);
  } catch (error) {
    debugLog('WARN', `REST /config/providers error - ${error.message}`);
    console.error('모델 목록 가져오기 실패:', error);
  }
  return [];
}

/**
 * 모델 변경
 */
async function setModel(providerId, modelName) {
  const port = await ensureOpenCodeServer();
  if (!port) return false;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: providerId,
        model: modelName
      })
    });
    return response.ok;
  } catch (error) {
    console.error('모델 변경 실패:', error);
    return false;
  }
}

/**
 * 서버의 현재 모델 정보를 동기화
 */
async function syncModelFromServer(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/config`);
    if (response.ok) {
      const config = await response.json();
      // config.model은 "providerID/modelID" 형식의 문자열. config.provider는 선택된
      // provider가 아니라 opencode.json에 정의된 커스텀 provider 목록 객체이므로 사용하지 않는다.
      if (typeof config.model === 'string' && config.model.includes('/')) {
        const separatorIndex = config.model.indexOf('/');
        const providerID = config.model.slice(0, separatorIndex);
        const modelID = config.model.slice(separatorIndex + 1);
        selectedModel = { providerID, modelID };
        chrome.storage.local.set({ selectedModel });
        console.log('서버 모델 동기화됨:', selectedModel);
      }
    }
  } catch (error) {
    console.log('서버 모델 동기화 실패:', error);
  }
}

// ============================================
// Chrome 메시징 (Side Panel과 통신)
// ============================================

// 메시지 핸들러
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.action) {
        case 'init-server':
          const port = await ensureOpenCodeServer();
          if (port && !selectedModel) {
            await syncModelFromServer(port);
            if (!selectedModel) {
              const models = await getAvailableModels();
              if (models.length > 0 && models[0].models) {
                const provider = models[0];
                const firstModel = Array.isArray(provider.models)
                  ? provider.models[0]
                  : Object.values(provider.models)[0];
                if (firstModel) {
                  selectedModel = {
                    providerID: provider.id,
                    modelID: firstModel.id || firstModel.name
                  };
                  chrome.storage.local.set({ selectedModel });
                  console.log('첫 번째 model 자동 선택:', selectedModel);
                }
              }
            }
          }
          const reason = !port && nativeHostMissingFlag ? 'native-host-missing' : undefined;
          nativeHostMissingFlag = false;
          sendResponse({ success: !!port, available: !!port, port, version: serverState.version, reason });
          break;

        case 'create-session':
          const sessionId = await createSession(message.title || 'New Chat');
          currentSessionId = sessionId;
          if (message.tabId) { tabSessions.set(message.tabId, sessionId); persistState(); }
          sendResponse({ success: true, sessionId });
          break;

        case 'list-sessions': {
          const port = await ensureOpenCodeServer();
          if (!port) { sendResponse({ success: false, error: 'OpenCode 서버 연결 실패' }); break; }
          const headers = {};
          const dirHeader = buildDirectoryHeader(await getWorkingDirectory());
          if (dirHeader) headers['x-opencode-directory'] = dirHeader;
          // 폴더를 지정하면(폴더 목록의 🕘) 그 폴더의 세션만 보여준다. 기본 목록은 최근 100개뿐이라
          // 오래 안 쓴 폴더의 세션이 빠지므로 넉넉히 받는다(roots: 하위 에이전트 세션은 서버에서 뺀다).
          const filterKey = message.directory ? folderKey(message.directory) : null;
          const listUrl = `http://127.0.0.1:${port}/session` + (filterKey ? '?roots=true&limit=1000' : '');
          const listRes = await fetch(listUrl, { headers, signal: AbortSignal.timeout(5000) });
          if (!listRes.ok) { sendResponse({ success: false, error: `세션 목록 조회 실패: ${listRes.status}` }); break; }
          const raw = await listRes.json();
          // 패널을 열 때마다 빈 세션이 만들어지므로, 메시지가 하나라도 있는 세션만 보여준다.
          // (x-opencode-directory 헤더는 목록을 필터링하지 않아 모든 디렉터리의 세션이 온다.)
          const candidates = (Array.isArray(raw) ? raw : [])
            .filter(x => x?.id && !x.parentID) // 서브에이전트 세션 제외
            .filter(x => !filterKey || folderKey(x.directory) === filterKey)
            .sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))
            .slice(0, 60);
          const hasMsg = await Promise.all(candidates.map(async x => {
            try {
              const r = await fetch(`http://127.0.0.1:${port}/session/${x.id}/message?limit=1`, { signal: AbortSignal.timeout(3000) });
              if (!r.ok) return false;
              const arr = await r.json();
              return Array.isArray(arr) && arr.length > 0;
            } catch { return false; }
          }));
          const list = candidates
            .filter((_, i) => hasMsg[i])
            .slice(0, 30)
            .map(x => ({
              id: x.id,
              title: x.title || '',
              updated: x.time?.updated || x.time?.created || 0,
              dir: (x.directory || '').split(/[\\/]/).filter(Boolean).pop() || '',
              directory: x.directory || ''
            }));
          sendResponse({ success: true, sessions: list });
          break;
        }

        case 'switch-session': {
          const port = await ensureOpenCodeServer();
          if (!port) { sendResponse({ success: false, error: 'OpenCode 서버 연결 실패' }); break; }
          if (!(await checkSessionExists(port, message.sessionId))) {
            sendResponse({ success: false, error: '세션을 찾을 수 없습니다' });
            break;
          }
          sessions.set(message.sessionId, { id: message.sessionId, created: Date.now(), port, active: true });
          if (message.tabId) { tabSessions.set(message.tabId, message.sessionId); persistState(); }
          currentSessionId = message.sessionId;
          debugLog('INFO', `switch-session: tabId=${message.tabId}, sessionId=${message.sessionId}`);
          sendResponse({ success: true, sessionId: message.sessionId });
          break;
        }

        case 'cancel-message': {
          const ctrl = eventSources.get(message.sessionId);
          if (ctrl) {
            ctrl.abort();
            eventSources.delete(message.sessionId);
          }
          // 로컬 SSE만 끊으면 서버 tool이 계속 돌아 세션이 busy로 남는다 → 서버도 중단
          const abortPort = sessions.get(message.sessionId)?.port ?? serverState.port;
          if (abortPort) await abortServerSession(abortPort, message.sessionId);
          sendResponse({ success: true });
          break;
        }

        // 사이드패널이 다시 그릴 때 대기 중인 권한/질문 카드를 복원한다.
        // SW가 재시작돼 메모리가 비었으면 서버의 대기 목록(GET /permission, /question)에서 본 세션 것만 가져온다.
        case 'get-pending-interactions': {
          const sid = message.sessionId;
          const known = pendingInteractions.get(sid);
          if (known?.size) {
            sendResponse({ success: true, items: [...known.values()] });
            break;
          }
          const listPort = sessions.get(sid)?.port ?? serverState.port;
          const items = [];
          if (sid && listPort) {
            const headers = {};
            const dirHeader = buildDirectoryHeader(await getSessionDirectory(sid, listPort));
            if (dirHeader) headers['x-opencode-directory'] = dirHeader;
            const list = async (path) => {
              try {
                const r = await fetch(`http://127.0.0.1:${listPort}${path}`, { headers, signal: AbortSignal.timeout(3000) });
                return r.ok ? await r.json() : [];
              } catch { return []; }
            };
            for (const p of await list('/permission')) {
              if (p?.sessionID !== sid) continue;
              items.push({ kind: 'permission', id: p.id, sessionID: p.sessionID, fromSubagent: false,
                permission: p.permission, patterns: p.patterns || [], always: p.always || [] });
            }
            for (const q of await list('/question')) {
              if (q?.sessionID !== sid) continue;
              items.push({ kind: 'question', id: q.id, sessionID: q.sessionID, fromSubagent: false, questions: q.questions || [] });
            }
          }
          sendResponse({ success: true, items });
          break;
        }

        // 권한/질문 요청에 대한 사용자 응답. 요청은 instance(디렉터리) 단위로 보관되므로 프롬프트와 같은 디렉터리 헤더를 보낸다.
        case 'reply-permission':
        case 'reply-question':
        case 'reject-question': {
          const replyPort = sessions.get(message.sessionId)?.port ?? serverState.port;
          if (!replyPort) throw new Error('OpenCode 서버 연결 실패');
          const requestId = encodeURIComponent(message.requestId || '');
          const headers = { 'Content-Type': 'application/json' };
          const dirHeader = buildDirectoryHeader(await getSessionDirectory(message.sessionId, replyPort));
          if (dirHeader) headers['x-opencode-directory'] = dirHeader;
          const post = (path, body) => fetch(`http://127.0.0.1:${replyPort}${path}`, {
            method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(5000)
          });

          let res;
          if (message.action === 'reply-permission') {
            const reply = ['once', 'always', 'reject'].includes(message.reply) ? message.reply : 'reject';
            res = await post(`/permission/${requestId}/reply`, { reply });
            // 구버전 opencode는 세션 하위 경로만 있다.
            if (res.status === 404 && message.requestSessionId) {
              res = await post(`/session/${encodeURIComponent(message.requestSessionId)}/permissions/${requestId}`, { response: reply });
            }
          } else if (message.action === 'reply-question') {
            const answers = Array.isArray(message.answers)
              ? message.answers.map(a => (Array.isArray(a) ? a.map(String) : []))
              : [];
            res = await post(`/question/${requestId}/reply`, { answers });
          } else {
            res = await post(`/question/${requestId}/reject`, {});
          }
          const body = res.ok ? '' : await res.text().catch(() => '');
          debugLog(res.ok ? 'INFO' : 'ERROR', `${message.action} - requestId=${message.requestId}, status=${res.status}${body ? `, body=${body.slice(0, 300)}` : ''}`);
          if (!res.ok) throw new Error(`응답 전송 실패: ${res.status}`);
          sendResponse({ success: true });
          break;
        }

        case 'send-message': {
          if (!sessions.has(message.sessionId)) {
            const recoveredPort = await ensureOpenCodeServer();
            if (recoveredPort) {
              sessions.set(message.sessionId, {
                id: message.sessionId,
                port: recoveredPort,
                active: true
              });
            }
          }
          const tabInfo = await getCurrentTabInfo({ forPrompt: true });
          let replacedSessionId = null;

          const doSendMessage = async (sid) => {
            await sendMessage(
              sid,
              message.message,
              tabInfo,
              (chunk, seq) => {
                chrome.runtime.sendMessage({
                  action: 'message-chunk',
                  sessionId: message.sessionId,
                  chunk: chunk,
                  seq
                }).catch(() => {});
              },
              (final, error, meta) => {
                // 오류는 화면을 다시 그려도 남도록 세션에 기록한다(다른 탭에 있는 동안 난 오류도 돌아오면 보인다).
                if (error) addSessionNotice(sid, meta?.anchorId, error);
                chrome.runtime.sendMessage({
                  action: 'message-complete',
                  sessionId: message.sessionId,
                  content: final,
                  error: error,
                  ...(replacedSessionId && { newSessionId: replacedSessionId })
                });
              },
              (part) => {
                chrome.runtime.sendMessage({
                  action: 'message-part',
                  sessionId: message.sessionId,
                  part
                }).catch(() => {});
              }
            );
          };

          try {
            await doSendMessage(message.sessionId);
          } catch (err) {
            if (err.message && err.message.includes('400')) {
              const oldCtrl = eventSources.get(message.sessionId);
              if (oldCtrl) { oldCtrl.abort(); eventSources.delete(message.sessionId); }
              sessions.delete(message.sessionId);

              debugLog('INFO', `Session stale (400), recreating - oldSessionId=${message.sessionId}`);
              const newId = await createSession('New Chat');
              replacedSessionId = newId;

              for (const [tabId, sid] of tabSessions) {
                if (sid === message.sessionId) { tabSessions.set(tabId, newId); break; }
              }
              persistState();

              await doSendMessage(newId);
            } else {
              debugLog('ERROR', `send-message failed (non-400) - ${err.message}, sessionId=${message.sessionId}`);
              throw err;
            }
          }
          sendResponse({ success: true });
          break;
        }

        // 사이드패널의 exit: 이 탭의 패널을 닫고 세션 연결을 끊는다. 서버 세션(대화 기록)은 지우지 않는다
        // (탭을 닫을 때와 다름) → /sessions로 이어갈 수 있고, 다음에 패널을 열면 get-tab-session이 새 세션을 만든다.
        case 'exit-panel': {
          const { tabId, sessionId } = message;
          if (sessionId) {
            stopPromptStream(sessionId); // 응답 중이었다면 사이드패널이 cancel-message로 이미 중단했다
            pendingInteractions.delete(sessionId);
          }
          if (tabId != null) {
            tabSessions.delete(tabId);
            activeTabs.delete(tabId);
            tabLastShownInfo.delete(tabId);
            persistState();
          }
          debugLog('INFO', `exit-panel: tabId=${tabId ?? 'none'}, sessionId=${sessionId || 'none'} (session kept on server)`);
          sendResponse({ success: true });
          // 이 탭 전용 패널을 비활성화하면 패널이 닫힌다(탭 전환 때와 같은 방식). 응답을 먼저 보낸 뒤 닫는다.
          if (tabId != null && chrome.sidePanel) {
            chrome.sidePanel.setOptions({ tabId, enabled: false }).catch((e) => {
              debugLog('WARN', `exit-panel: sidePanel.setOptions failed - ${e.message}`);
            });
          }
          break;
        }

        // 응답 중에 보낸 메시지: 진행 중인 구독을 유지한 채 서버 큐에 넣는다(queueMessage 참고).
        case 'queue-message': {
          const tabInfo = await getCurrentTabInfo({ forPrompt: true });
          const result = await queueMessage(message.sessionId, message.message, tabInfo);
          sendResponse({ success: true, ...result });
          break;
        }

        case 'has-tab-session':
          sendResponse({ has: tabSessions.has(message.tabId) });
          break;

        case 'get-tab-session': {
          const tabId = message.tabId;
          const reason = message.reason || 'unknown';
          const existingId = tabId ? tabSessions.get(tabId) : null;
          let hasInSessions = existingId ? sessions.has(existingId) : false;

          // 인메모리 sessions Map은 SW 재시작 시 소실되지만 tabSessions(storage.session)는
          // 유지된다. 이 경우 서버에 세션이 실제로 남아있는지 먼저 확인해, 있는데도
          // 불필요하게 폐기하고 새로 만드는 것(=대화 내역 접근 경로 상실)을 막는다.
          if (existingId && !hasInSessions) {
            const port = await ensureOpenCodeServer();
            if (port) {
              const alive = await checkSessionExists(port, existingId);
              if (alive) {
                sessions.set(existingId, { id: existingId, created: Date.now(), port, active: true });
                hasInSessions = true;
                debugLog('INFO', `get-tab-session: recovered orphaned session after SW restart - sessionId=${existingId}`);
              }
            }
          }

          debugLog('INFO', `get-tab-session: reason=${reason}, tabId=${tabId}, existingId=${existingId || 'none'}, hasInSessions=${hasInSessions}`);
          if (existingId && hasInSessions) {
            sendResponse({ success: true, sessionId: existingId, isNew: false });
          } else {
            debugLog('WARN', `get-tab-session: recreating - reason=${reason}, tabId=${tabId}, discardedSessionId=${existingId || 'none'}, cause=${!existingId ? 'no tabSessions entry' : 'not in sessions map, server confirmed gone'}`);
            const newId = await createSession(message.title || 'New Chat');
            if (tabId) { tabSessions.set(tabId, newId); persistState(); }
            currentSessionId = newId;
            debugLog('INFO', `get-tab-session: recreated - reason=${reason}, tabId=${tabId}, oldSessionId=${existingId || 'none'}, newSessionId=${newId}`);
            sendResponse({ success: true, sessionId: newId, isNew: true });
          }
          break;
        }

        case 'get-session-history': {
          const result = await getSessionHistory(message.sessionId);
          sendResponse(result);
          break;
        }

        // sessionId가 있으면 그 세션의 폴더(탭마다 다를 수 있다), 없으면 새 세션의 기본 폴더.
        // isDefault: 서버 cwd와 같은 폴더(사이드패널이 "기본값"으로 흐리게 표시).
        case 'get-working-directory': {
          if (!message.sessionId) {
            sendResponse({ directory: await getWorkingDirectory() });
            break;
          }
          const directory = await getSessionDirectory(message.sessionId);
          const defaultDirectory = await getDefaultDirectory();
          sendResponse({ directory, isDefault: !directory || sameDirectory(directory, defaultDirectory), defaultDirectory });
          break;
        }

        case 'get-default-directory':
          sendResponse({ directory: await getDefaultDirectory() });
          break;

        case 'set-working-directory': {
          let normalized = await normalizeWorkingDirectory(message.directory || '');
          // 존재하지 않는 경로를 저장하면 opencode가 오류 없이 빈 응답만 돌려주므로,
          // 저장 전에 host로 변환·검증한다. host가 구버전이면 검증을 생략한다.
          if (normalized) {
            const check = await resolveDirectoryViaHost(message.directory || normalized);
            if (check.checked) {
              if (!check.exists) {
                debugLog('WARN', `set-working-directory: 디렉토리 없음 - input=${message.directory}, resolved=${check.path}`);
                sendResponse({ success: false, error: 'dir-not-found', path: check.path || normalized });
                break;
              }
              if (check.converted) {
                debugLog('INFO', `set-working-directory: host 변환 - ${normalized} -> ${check.path}${check.note ? ` (${check.note})` : ''}`);
                normalized = check.path;
              }
            }
          }
          // 바꾼 폴더는 새 세션의 기본값이 된다. 다른 탭의 기존 세션은 원래 폴더로 계속 동작하고,
          // 그 탭에서 새 세션을 시작할 때(/new, exit 후 다시 열기 등)부터 이 폴더가 적용된다.
          await chrome.storage.local.set({ workingDirectory: normalized });
          if (normalized) await recordRecentFolder(normalized);

          // opencode 세션은 생성 시점의 x-opencode-directory 헤더로 디렉토리가
          // 고정되며, 이후 헤더 값을 바꿔도 반영되지 않는다. 따라서 이 탭 세션의 폴더와
          // 다르면, 기존 세션을 버리고 새 세션을 만들어야 새 디렉토리가 적용된다.
          let newSessionId = null;
          const tabId = message.tabId;
          const oldSessionId = message.sessionId || (tabId ? tabSessions.get(tabId) : null);
          const previous = oldSessionId ? await getSessionDirectory(oldSessionId) : '';
          const effective = normalized || await getDefaultDirectory();
          if (oldSessionId && !sameDirectory(effective, previous)) {
            try {
              // 이전 대화는 서버에 남긴다(/sessions로 다시 불러오면 원래 폴더로 이어진다)
              await releaseSession(oldSessionId, 'working-directory-changed');
              newSessionId = await createSession('Chrome Extension Chat');
              if (tabId) tabSessions.set(tabId, newSessionId);
              persistState();
              debugLog('INFO', `Working directory changed - session recreated (old=${oldSessionId} @ ${previous}, new=${newSessionId} @ ${effective})`);
            } catch (e) {
              debugLog('ERROR', `Working directory changed but session recreate failed - ${e.message}`);
            }
          }

          sendResponse({ success: true, directory: normalized, newSessionId });
          break;
        }

        // ---- 작업 폴더 즐겨찾기·최근 목록 ----
        case 'get-folder-list': {
          const store = await chrome.storage.local.get([FOLDER_FAVORITES_KEY, FOLDER_RECENT_KEY, FOLDER_HIDDEN_KEY]);
          let serverSessions = [];
          // SW가 다시 떠서 serverState를 잃었어도 서버 기록을 읽도록 연결을 확인한다.
          const port = await ensureOpenCodeServer();
          if (port) {
            try {
              // 기본 목록은 최근 100개라 오래된 폴더가 빠진다. 하위 에이전트 세션은 서버에서 빼고(roots) 넉넉히 받는다.
              const r = await fetch(`http://127.0.0.1:${port}/session?roots=true&limit=1000`, { signal: AbortSignal.timeout(5000) });
              if (r.ok) serverSessions = await r.json();
            } catch (e) {
              debugLog('WARN', `get-folder-list: session list failed - ${e.message}`);
            }
          }
          const list = buildFolderList({
            sessions: Array.isArray(serverSessions) ? serverSessions : [],
            recent: store[FOLDER_RECENT_KEY] || [],
            favorites: store[FOLDER_FAVORITES_KEY] || [],
            hidden: store[FOLDER_HIDDEN_KEY] || [],
            runtime: serverState.runtime || null
          });
          sendResponse({ success: true, ...list });
          break;
        }

        case 'set-folder-favorite': {
          const path = String(message.path || '').trim();
          if (!path) { sendResponse({ success: false }); break; }
          const key = folderKey(path);
          const favs = (await chrome.storage.local.get(FOLDER_FAVORITES_KEY))[FOLDER_FAVORITES_KEY] || [];
          const rest = favs.filter(f => folderKey(f.path) !== key);
          const existing = favs.find(f => folderKey(f.path) === key);
          let next = rest;
          if (message.favorite) {
            const name = typeof message.name === 'string' ? message.name.trim().slice(0, 60) : (existing?.name || '');
            const entry = { path: existing?.path || path, name, addedAt: existing?.addedAt || Date.now() };
            // 이미 있으면 자리를 유지(이름만 바꿈), 새로 넣으면 맨 뒤
            next = existing ? favs.map(f => (folderKey(f.path) === key ? entry : f)) : [...favs, entry];
          }
          await chrome.storage.local.set({ [FOLDER_FAVORITES_KEY]: next });
          sendResponse({ success: true });
          break;
        }

        // 즐겨찾기 내보내기/가져오기(⚙). 확장을 삭제하면 storage.local이 지워지므로 백업용이다.
        case 'export-folder-favorites': {
          const favs = (await chrome.storage.local.get(FOLDER_FAVORITES_KEY))[FOLDER_FAVORITES_KEY] || [];
          sendResponse({ success: true, data: { type: FAVORITES_EXPORT_TYPE, version: 1, exportedAt: new Date().toISOString(), favorites: favs } });
          break;
        }

        case 'import-folder-favorites': {
          let incoming;
          try {
            if (typeof message.text !== 'string' || message.text.length > 1_000_000) throw new Error('invalid-format');
            incoming = parseFavoritesFile(message.text);
          } catch {
            sendResponse({ success: false, error: '즐겨찾기 파일 형식이 올바르지 않습니다' });
            break;
          }
          const favs = (await chrome.storage.local.get(FOLDER_FAVORITES_KEY))[FOLDER_FAVORITES_KEY] || [];
          const { merged, added } = mergeFavorites(favs, incoming);
          await chrome.storage.local.set({ [FOLDER_FAVORITES_KEY]: merged });
          debugLog('INFO', `import-folder-favorites: added=${added}, total=${merged.length}`);
          sendResponse({ success: true, added, total: merged.length });
          break;
        }

        // 최근 목록에서 지우기. 최근 목록은 서버 세션 기록에서 만들어지므로 지울 수 없어 숨김으로 기록한다
        // (그 폴더를 다시 고르면 숨김이 풀린다). 세션 자체는 지우지 않는다.
        case 'hide-recent-folder': {
          const key = folderKey(message.path);
          const store = await chrome.storage.local.get([FOLDER_RECENT_KEY, FOLDER_HIDDEN_KEY]);
          const hidden = (store[FOLDER_HIDDEN_KEY] || []).filter(h => folderKey(h) !== key);
          hidden.push(message.path);
          await chrome.storage.local.set({
            [FOLDER_HIDDEN_KEY]: hidden.slice(-200),
            [FOLDER_RECENT_KEY]: (store[FOLDER_RECENT_KEY] || []).filter(r => folderKey(r.path) !== key)
          });
          sendResponse({ success: true });
          break;
        }

        case 'browse-for-folder': {
          try {
            const res = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { action: 'browse-for-folder' });
            if (res?.directory) {
              // 실제 변환은 sidepanel이 이어서 호출하는 set-working-directory 한 곳에서만 수행
              debugLog('INFO', `browse-for-folder: selected=${res.directory}`);
              sendResponse({ directory: res.directory, warning: res.warning || null });
            } else {
              debugLog('INFO', 'browse-for-folder: cancelled or no directory returned');
              sendResponse({ directory: null });
            }
          } catch (e) {
            debugLog('ERROR', `browse-for-folder: ${e.message}`);
            sendResponse({ directory: null, error: e.message });
          }
          break;
        }

        case 'browse-for-file': {
          try {
            const res = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { action: 'browse-for-file' });
            if (res?.status === 'error') {
              debugLog('ERROR', `browse-for-file: native host reported error - ${res.error}`);
              sendResponse({ files: [], error: res.error || '파일 선택 실패' });
              break;
            }
            const files = res?.files || [];
            debugLog('INFO', `browse-for-file: selected=${files.length} file(s)`);
            sendResponse({ files, warnings: res?.warnings || [] });
          } catch (e) {
            debugLog('ERROR', `browse-for-file: ${e.message}`);
            sendResponse({ files: [], error: e.message });
          }
          break;
        }

        case 'get-models':
          const models = await getAvailableModels();
          sendResponse({ success: true, models });
          break;

        case 'get-current-model':
          sendResponse({ model: selectedModel });
          break;

        case 'set-model':
          selectedModel = { providerID: message.providerId, modelID: message.modelName };
          chrome.storage.local.set({ selectedModel }).catch(() => {});
          sendResponse({ success: true });
          break;

        case 'get-server-state':
          sendResponse({
            available: serverState.available,
            port: serverState.port,
            version: serverState.version
          });
          break;

        case 'get-tab-info':
          const currentTabInfo = await getCurrentTabInfo();
          sendResponse(currentTabInfo);
          break;

        case 'get-session':
          const session = sessions.get(message.sessionId);
          sendResponse(session || null);
          break;

        case 'get-commands': {
          const cmdPort = serverState.port;
          if (!cmdPort) { sendResponse({ commands: [] }); break; }
          // skill도 이 목록에 들어 있다. 작업 폴더의 command/skill이 보이도록 세션 폴더로 묻는다.
          const cmdRes = await fetch(`http://127.0.0.1:${cmdPort}/command`, { headers: await sessionDirectoryHeaders(message.sessionId, cmdPort) });
          if (!cmdRes.ok) { sendResponse({ commands: [] }); break; }
          const cmdData = await cmdRes.json();
          const commands = Array.isArray(cmdData) ? cmdData : (cmdData.commands || cmdData.items || []);
          sendResponse({ success: true, commands });
          break;
        }

        case 'get-agents': {
          const agentPort = serverState.port;
          if (!agentPort) { sendResponse({ agents: [] }); break; }
          const agentRes = await fetch(`http://127.0.0.1:${agentPort}/agent`, { headers: await sessionDirectoryHeaders(message.sessionId, agentPort) });
          if (!agentRes.ok) { sendResponse({ agents: [] }); break; }
          const agentData = await agentRes.json();
          const agents = Array.isArray(agentData)
            ? agentData.filter(a => (a.mode === 'primary' || a.mode === 'all') && !a.hidden)
            : [];
          sendResponse({ success: true, agents });
          break;
        }

        case 'set-agent': {
          const agentSessionId = message.sessionId;
          const agentName = message.agentName;
          const agentSetPort = serverState.port;
          if (!agentSetPort) { sendResponse({ error: 'Server not available' }); break; }
          const agentSetRes = await fetch(
            `http://127.0.0.1:${agentSetPort}/session/${agentSessionId}`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ agent: agentName })
            }
          );
          const agentSetData = await agentSetRes.json();
          sendResponse({ success: agentSetRes.ok, agent: agentSetData.agent });
          break;
        }

        case 'run-command': {
          const runPort = serverState.port || await ensureOpenCodeServer();
          if (!runPort) { sendResponse({ error: 'Server not available' }); break; }
          if (!sessions.has(message.sessionId)) { sendResponse({ error: 'Invalid session' }); break; }
          const runRes = await fetch(
            `http://127.0.0.1:${runPort}/session/${message.sessionId}/command`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...(await sessionDirectoryHeaders(message.sessionId, runPort)) },
              body: JSON.stringify({ id: message.commandId })
            }
          );
          sendResponse({ success: runRes.ok, status: runRes.status });
          break;
        }

        // MCP는 폴더 instance마다 따로 뜬다(프로젝트 opencode.json의 MCP는 그 폴더에만 있다).
        // 그래서 현재 세션의 폴더(없으면 새 세션의 기본 폴더)로 묻고 켜고 끈다(sessionDirectoryHeaders).
        case 'get-mcp-status': {
          const mcpPort = serverState.port;
          if (!mcpPort) { sendResponse({ success: false, servers: {} }); break; }
          const mcpHeaders = await sessionDirectoryHeaders(message.sessionId, mcpPort);
          const mcpRes = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, { headers: mcpHeaders });
          if (!mcpRes.ok) { sendResponse({ success: false, servers: {} }); break; }
          sendResponse({ success: true, servers: await mcpRes.json() });
          break;
        }

        case 'toggle-mcp': {
          const togglePort = serverState.port;
          if (!togglePort) { sendResponse({ success: false }); break; }
          const toggleHeaders = await sessionDirectoryHeaders(message.sessionId, togglePort);
          const action = message.connect ? 'connect' : 'disconnect';
          const toggleRes = await fetch(
            `http://127.0.0.1:${togglePort}/mcp/${encodeURIComponent(message.name)}/${action}`,
            { method: 'POST', headers: toggleHeaders }
          );
          const statusRes = await fetch(`http://127.0.0.1:${togglePort}/mcp`, { headers: toggleHeaders });
          const servers = statusRes.ok ? await statusRes.json() : {};
          sendResponse({ success: toggleRes.ok, servers });
          break;
        }

        // 재시작 전에 다른 탭에서 진행 중인 응답이 있는지 본다. 확장 전용 서버라 진행 중인 응답은
        // 모두 이 SW가 구독 중인 스트림이다(완료·중단되면 eventSources에서 빠진다).
        case 'get-active-streams':
          sendResponse({ success: true, sessionIds: [...eventSources.keys()] });
          break;

        // 소프트 재시작: MCP/skill/agent 등 config 변경을 반영 (프로세스 유지)
        case 'restart-instance': {
          sendResponse(await restartServerInstance());
          break;
        }

        // 하드 재시작: 서버가 응답하지 않거나 상태가 깨졌을 때
        case 'restart-server': {
          sendResponse(await hardRestartServer(message.preferredRuntime));
          break;
        }

        // 설정 화면용: 저장된 우선순위 + 마지막으로 확인된 실행 환경(WSL 여부)
        case 'get-runtime-info': {
          // SW 재시작 등으로 환경을 모르면 host에 물어 확정한다(끝나면 server-runtime-updated로 배지 갱신).
          if (serverState.available && serverState.port && !serverState.runtime) detectRuntimeFromHost(serverState.port);
          const { serverIsWSL } = await chrome.storage.local.get('serverIsWSL');
          sendResponse({
            success: true,
            preferredRuntime: await getPreferredRuntime(),
            serverIsWSL: serverState.runtime
              ? serverState.runtime === 'wsl'
              : (typeof serverIsWSL === 'boolean' ? serverIsWSL : null),
            port: serverState.available ? serverState.port : null
          });
          break;
        }

        // 설치된 native host가 현재 확장 버전보다 낮은지 확인
        case 'check-host-version': {
          sendResponse(await checkHostVersion());
          break;
        }

        // Web Store에 새 버전이 있는지 Chrome에 확인을 요청한다(받아 두기만 하고 적용은 reload 때).
        // 압축 해제로 로드한 개발용 확장은 항상 no_update/에러가 돌아온다.
        case 'check-extension-update': {
          try {
            const { status, details } = await chrome.runtime.requestUpdateCheck();
            const version = details?.version || null;
            if (status === 'update_available' && version) {
              await chrome.storage.local.set({ pendingUpdate: { version } });
            }
            debugLog('INFO', `check-extension-update: ${status} ${version || ''}`);
            sendResponse({ success: true, status, version });
          } catch (error) {
            debugLog('WARN', `check-extension-update: ${error.message}`);
            sendResponse({ success: false, error: error.message });
          }
          break;
        }

        // 받아 둔 새 버전을 적용한다. 응답을 먼저 돌려준 뒤 확장을 다시 로드한다.
        case 'apply-extension-update': {
          sendResponse({ success: true });
          setTimeout(() => chrome.runtime.reload(), 200);
          break;
        }

        // 서버를 재시작하지 않고 우선순위만 저장 (다음 시작부터 적용)
        case 'set-runtime-preference': {
          if (!RUNTIME_PREFERENCES.includes(message.preferredRuntime)) {
            sendResponse({ success: false, error: '잘못된 값입니다' });
            break;
          }
          await chrome.storage.local.set({ preferredRuntime: message.preferredRuntime });
          sendResponse({ success: true });
          break;
        }

        // 프록시 설정 조회
        case 'get-proxy': {
          // 저장된 값이 한 번도 없으면 인스톨러가 남긴 config.private.json의 proxy를 가져와 저장한다.
          let imported = false;
          try {
            const { proxy: stored } = await chrome.storage.local.get('proxy');
            if (stored === undefined) {
              const res = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { action: 'get-installed-proxy' });
              const p = res?.status === 'success' ? res.proxy : null;
              if (p && !validateProxyUrl(p.http) && !validateProxyUrl(p.https)) {
                const next = {};
                for (const k of PROXY_KEYS) next[k] = typeof p[k] === 'string' ? p[k].trim() : '';
                await chrome.storage.local.set({ proxy: next });
                imported = true;
                debugLog('INFO', 'Proxy: config.private.json 값을 가져와 저장');
              }
            }
          } catch (e) {
            debugLog('WARN', `Proxy: 설치된 proxy 조회 실패 - ${e.message}`);
          }
          sendResponse({ success: true, proxy: await getProxy(), imported });
          break;
        }

        // 프록시 설정만 저장 (서버를 재시작해야 반영된다)
        case 'set-proxy': {
          const next = {};
          for (const k of PROXY_KEYS) next[k] = typeof message.proxy?.[k] === 'string' ? message.proxy[k].trim() : '';
          const bad = validateProxyUrl(next.http) || validateProxyUrl(next.https);
          if (bad) {
            sendResponse({ success: false, error: bad });
            break;
          }
          await chrome.storage.local.set({ proxy: next });
          sendResponse({ success: true });
          break;
        }

        // 프록시 적용(재시작) 전 확인용: 연결된 서버를 확장이 띄웠는지, 진행 중인 작업이 있는지
        case 'get-server-origin': {
          if (!serverState.available) {
            sendResponse({ success: true, connected: false });
            break;
          }
          const result = { success: true, connected: true, port: serverState.port, managed: null, busy: null, proxyEnv: null, proxyEnvSource: null, proxyEnvReason: null };
          try {
            const info = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { action: 'server-info', port: serverState.port });
            if (info?.status === 'success') {
              result.managed = info.managed === true;
              result.proxyEnv = info.proxyEnv || null;
              result.proxyEnvSource = info.proxyEnvSource || null;
              result.proxyEnvReason = info.proxyEnvReason || null;
            }
          } catch {}
          try {
            // 응답 생성 중인 세션만 키로 들어오는 맵 (idle이면 {})
            const res = await fetch(`http://127.0.0.1:${serverState.port}/session/status`, { signal: AbortSignal.timeout(3000) });
            if (res.ok) result.busy = Object.keys(await res.json()).length;
          } catch {}
          sendResponse(result);
          break;
        }

        case 'get-debug-logs': {
          const data = await chrome.storage.local.get(DEBUG_LOG_KEY);
          const swLogs = data[DEBUG_LOG_KEY] || [];
          let fileLog = { content: null, path: null };
          try {
            const res = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { action: 'read-log' });
            if (res?.status === 'success') {
              fileLog.content = res.content;
              fileLog.path = res.path;
            }
          } catch {}
          sendResponse({ success: true, swLogs, fileLog });
          break;
        }

        default:
          sendResponse({ error: 'Unknown action' });
      }
    } catch (error) {
      sendResponse({ error: error.message });
    }
  })();

  return true; // 비동기 응답
});

// ============================================
// 컨텍스트 메뉴 (우클릭 → 선택 텍스트 전송)
// ============================================

// onInstalled / onStartup / 언어 변경이 겹쳐 호출될 수 있다. removeAll→create를 병렬로 돌리면
// removeAll 둘이 먼저 처리된 뒤 create가 두 번 실행되어 "duplicate id" 오류가 나므로 한 번에 하나씩만 실행한다.
let _contextMenuChain = Promise.resolve();

function createContextMenus() {
  _contextMenuChain = _contextMenuChain.then(async () => {
    // 사이드패널 언어 설정(storage.local.lang)을 따른다. 기본은 한국어.
    let lang = 'ko';
    try { lang = (await chrome.storage.local.get('lang')).lang === 'en' ? 'en' : 'ko'; } catch {}
    await new Promise((resolve) => {
      chrome.contextMenus.removeAll(() => {
        void chrome.runtime.lastError;
        chrome.contextMenus.create({
          id: 'send-to-opencode',
          title: lang === 'en' ? 'Send to OpenCode' : 'OpenCode로 보내기',
          contexts: ['selection']
        }, () => {
          // lastError를 읽지 않으면 "Unchecked runtime.lastError"가 콘솔에 남는다.
          const err = chrome.runtime.lastError;
          if (err) debugLog('WARN', `contextMenus.create: ${err.message}`);
          resolve();
        });
      });
    });
  }).catch(() => {});
  return _contextMenuChain;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.lang) createContextMenus();
});

// Chrome이 Web Store에서 새 버전을 받아 두면 알려준다. 적용(reload)은 사용자가 고른 시점에 한다.
chrome.runtime.onUpdateAvailable.addListener((details) => {
  debugLog('INFO', `onUpdateAvailable: ${details.version}`);
  chrome.storage.local.set({ pendingUpdate: { version: details.version } });
});

// 이미 적용돼 현재 버전 이하가 된 pendingUpdate는 지운다.
(async () => {
  try {
    const { pendingUpdate } = await chrome.storage.local.get('pendingUpdate');
    if (pendingUpdate && compareVersions(pendingUpdate.version, chrome.runtime.getManifest().version) <= 0) {
      await chrome.storage.local.remove('pendingUpdate');
    }
  } catch {}
})();

chrome.runtime.onInstalled.addListener(createContextMenus);
chrome.runtime.onStartup.addListener(createContextMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'send-to-opencode') return;

  const selectionText = info.selectionText;
  if (!selectionText || !tab?.id) return;

  // user gesture 컨텍스트 안에서 await 없이 동기 호출
  chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: 'sidepanel/sidepanel.html',
    enabled: true
  });
  chrome.sidePanel.open({ tabId: tab.id }).catch((e) => {
    console.error('사이드패널 열기 실패:', e.message);
  });
  activeTabs.add(tab.id);
  currentActiveTabId = tab.id;
  tabLastShownInfo.set(tab.id, { title: tab.title || '', url: tab.url || '' });
  persistState();

  // 비동기 작업은 패널 열기 이후에
  chrome.storage.local.set({ pendingContextText: { tabId: tab.id, text: selectionText } })
    .then(() => {
      setTimeout(() => {
        chrome.runtime.sendMessage({ action: 'reinit-for-tab', tabId: tab.id }).catch(() => {});
      }, 300);
    });
});

// ============================================
// 사이드패널 이벤트 (탭별 독립 제어)
// ============================================

// 아이콘 클릭 시 해당 탭에만 Panel 활성화
try {
  if (chrome.sidePanel) {
    // 전역 자동 열기 비활성화 — 탭별로 수동 제어
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
    // 전역 기본값: 비활성
    chrome.sidePanel.setOptions({ enabled: false }).catch(() => {});
  }
} catch (e) {}

// async/await 없이 동기 호출 — user gesture 컨텍스트 유지 필수
chrome.action.onClicked.addListener((tab) => {
  if (!chrome.sidePanel) return;
  // enabled: true 먼저 (await 없음)
  chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: 'sidepanel/sidepanel.html',
    enabled: true
  });
  // open()은 바로 호출 — 여전히 gesture 컨텍스트 안
  chrome.sidePanel.open({ tabId: tab.id }).catch((e) => {
    console.error('사이드패널 열기 실패:', e.message);
  });
  activeTabs.add(tab.id);
  currentActiveTabId = tab.id;
  tabLastShownInfo.set(tab.id, { title: tab.title || '', url: tab.url || '' });
  persistState();
  chrome.runtime.sendMessage({ action: 'reinit-for-tab', tabId: tab.id }).catch(() => {});
});

// 탭 전환 시 — 활성 탭이면 Panel 유지, 아니면 닫기
chrome.tabs.onActivated.addListener(({ tabId }) => {
  currentActiveTabId = tabId;
  persistState();

  if (activeTabs.has(tabId)) {
    // 비활성 상태에서 페이지가 바뀌었을 수 있으니 복귀 시점에 비교
    chrome.tabs.get(tabId).then((tab) => {
      if (tab) notifyPageChangeIfNeeded(tabId, tab.title || '', tab.url || '');
    }).catch(() => {});
  }

  if (!chrome.sidePanel) return;
  if (activeTabs.has(tabId)) {
    chrome.sidePanel.setOptions({ tabId, path: 'sidepanel/sidepanel.html', enabled: true }).catch(() => {});
  } else {
    chrome.sidePanel.setOptions({ tabId, enabled: false }).catch(() => {});
  }
});

// ============================================
// Native Messaging 연결 테스트
// ============================================

// Native Messaging 호스트 연결 테스트
async function testNativeMessaging() {
  try {
    const response = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, {
      action: 'status'
    });
    console.log('Native Messaging 연결 성공:', response);
    return true;
  } catch (error) {
    console.log('Native Messaging 연결 실패:', error.message);
    return false;
  }
}

console.log('OpenCode Chrome Extension Background Service Worker 로드 완료');