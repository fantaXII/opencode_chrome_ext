/**
 * OpenCode Chrome Extension - Background Service Worker
 * 
 * 주요 기능:
 * - OpenCode 서버 상태 관리
 * - Native Messaging Host 통신
 * - 세션 관리
 * - 메시지 전송 및 SSE 응답 처리
 */

// ============================================
// 상수 정의
// ============================================

const NATIVE_HOST_NAME = 'com.opencode.chrome';
const DEFAULT_PORT = 4096;
const MAX_PORT_CHECK = 10; // 4096 ~ 4105
const SERVER_START_TIMEOUT = 30000; // 30초
const SSE_RECONNECT_DELAY = 2000;

// ============================================
// 디버그 로거 (chrome.storage.local 원형버퍼)
// ============================================

const DEBUG_LOG_KEY = 'debugLogs';
const MAX_DEBUG_ENTRIES = 200;

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
  checking: false
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
}).catch(() => {});

debugLog('INFO', `Service Worker started - ${new Date().toISOString()} | extensionId=${chrome.runtime.id}`);

// 탭 닫힐 때 세션 및 활성 탭 정리
chrome.tabs.onRemoved.addListener((tabId) => {
  activeTabs.delete(tabId);
  tabLastShownInfo.delete(tabId);
  const sessionId = tabSessions.get(tabId);
  if (sessionId) {
    deleteSession(sessionId).catch(() => {});
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
      const data = await response.json();
      console.log(`[checkServerHealth] 포트 ${port} 성공 - version=${data.version}`);
      return { available: true, version: data.version };
    }
  } catch (error) {
    console.log(`[checkServerHealth] 포트 ${port} 실패:`, error.message);
  }
  return { available: false, version: null };
}

/**
 * 사용 가능한 포트 찾기
 */
async function findAvailablePort() {
  console.log(`[findAvailablePort] ${DEFAULT_PORT} ~ ${DEFAULT_PORT + MAX_PORT_CHECK - 1} 범위 포트 스캔 시작`);
  for (let port = DEFAULT_PORT; port < DEFAULT_PORT + MAX_PORT_CHECK; port++) {
    const state = await checkServerHealth(port);
    if (state.available) {
      console.log(`[findAvailablePort] 포트 ${port} 발견!`);
      return port;
    }
  }
  console.log(`[findAvailablePort] 모든 포트 실패 - 사용 가능한 서버 없음`);
  return null;
}

/**
 * Native Messaging Host를 통해 서버 시작
 */
async function startServerWithNativeMessaging(preferredPort = DEFAULT_PORT) {
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    debugLog('INFO', `NativeMsg: attempt ${attempt}/${MAX_RETRIES}, preferredPort=${preferredPort}`);
    console.log(`[startServerWithNativeMessaging] 시도 ${attempt}/${MAX_RETRIES} - preferredPort=${preferredPort}`);
    try {
      const response = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, {
        action: 'start',
        preferredPort: preferredPort
      });

      console.log(`[startServerWithNativeMessaging] Native Messaging 응답:`, response);
      if (response.status === 'success') {
        debugLog('INFO', `NativeMsg: success, port=${response.port}, isWSL=${response.isWSL}`);
        console.log(`[startServerWithNativeMessaging] 성공 - port=${response.port}`);
        if (typeof response.isWSL === 'boolean') {
          chrome.storage.local.set({ serverIsWSL: response.isWSL }).catch(() => {});
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
async function waitForServer(timeout = SERVER_START_TIMEOUT) {
  const startTime = Date.now();
  console.log(`[waitForServer] 서버 시작 대기 시작 - timeout=${timeout}ms`);

  while (Date.now() - startTime < timeout) {
    const port = await findAvailablePort();
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
        port = await waitForServer();
        if (port) {
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
  console.log(`[periodicServerCheck] 주기 체크 시작 - 현재 serverState.port=${serverState.port}, available=${serverState.available}`);
  const port = await findAvailablePort();
  console.log(`[periodicServerCheck] findAvailablePort 결과: port=${port}, 기존 serverState.port=${serverState.port}`);
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

async function getWorkingDirectory() {
  try {
    const result = await chrome.storage.local.get('workingDirectory');
    return result.workingDirectory || '';
  } catch {
    return '';
  }
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
 * 사용자가 지정한 working directory를 "실제 실행 중인 opencode 서버"가 이해하는
 * 경로 포맷으로 정규화한다.
 *
 * host.js는 Windows PATH를 1순위, WSL을 2순위 fallback으로 opencode를 찾아 기동한다
 * (native-host/host.js findOpenCodePath). 따라서 서버가 항상 WSL이라고 가정하고
 * C:\... 를 /mnt/c/... 로 강제 변환하면, Windows 네이티브로 뜬 서버에는 존재하지
 * 않는 경로를 보내게 되어 working directory 설정이 조용히 무시된다.
 *
 * 판단 우선순위:
 *   1. serverCwd (SSE/probe로 실측한 서버의 실제 cwd 포맷) — 가장 신뢰도 높음
 *   2. serverIsWSL (이번 세션에 native host가 직접 서버를 띄우며 기록한 값)
 *   3. 둘 다 모르면 변환하지 않음 (host.js의 Windows-우선 탐색과 일치하는 기본값)
 */
async function normalizeWorkingDirectory(rawPath) {
  if (!rawPath) return '';
  if (!isWindowsDrivePath(rawPath)) {
    return rawPath.replace(/\\/g, '/').replace(/\/$/, '');
  }

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

async function refreshServerCwd(port) {
  const directory = await probeServerDirectory(port);
  if (!directory) {
    debugLog('WARN', `refreshServerCwd: probe failed or timed out - port=${port}`);
    return;
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

    console.log(`세션 생성 완료: ${sessionId}`);
    return sessionId;
  } catch (error) {
    debugLog('ERROR', `Session create failed - ${error.message}`);
    console.error('세션 생성 오류:', error);
    throw error;
  }
}

/**
 * 세션 삭제
 */
async function deleteSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  try {
    await fetch(`http://127.0.0.1:${session.port}/session/${sessionId}`, {
      method: 'DELETE'
    });
  } catch (error) {
    console.error('세션 삭제 오류:', error);
  }

  sessions.delete(sessionId);

  // SSE 연결 정리 (eventSources는 fetch 기반 AbortController를 담는다)
  const controller = eventSources.get(sessionId);
  if (controller) {
    controller.abort();
    eventSources.delete(sessionId);
  }
}

/**
 * 현재 탭 정보를 가져오기
 */
async function getCurrentTabInfo() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      return { tabId: null, url: '', title: '', favIconUrl: '' };
    }

    const result = {
      tabId: tab.id,
      url: tab.url,
      title: tab.title,
      favIconUrl: tab.favIconUrl
    };

    try {
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'get-page-content' });
      if (response?.success) {
        result.pageContent = response.content;
      }
    } catch (e) {
      console.log('content script 호출 실패 (일반적인 웹페이지가 아님):', e.message);
    }

    return result;
  } catch (error) {
    console.error('getCurrentTabInfo 오류:', error);
    return { tabId: null, url: '', title: '', favIconUrl: '' };
  }
}

// ============================================
// 메시지 전송 및 응답 처리
// ============================================

/**
 * 메시지 전송
 */
async function sendMessage(sessionId, message, tabInfo, onChunk, onComplete) {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error('세션을 찾을 수 없음');
  }

  const port = await ensureOpenCodeServer();
  if (!port) {
    throw new Error('OpenCode 서버 연결 실패');
  }

  if (!selectedModel) {
    await syncModelFromServer(port);
    if (!selectedModel) {
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
  }

  try {
    const workingDir = await getWorkingDirectory();
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
      let pageContext = '';
      if (tabInfo.url) {
        pageContext += `
---
현재 페이지 정보:
- 제목: ${tabInfo.title}
- URL: ${tabInfo.url}
`;
      }
      if (tabInfo.pageContent) {
        const content = tabInfo.pageContent;
        if (content.headings?.length) {
          pageContext += `제목들:\n${content.headings.join('\n')}\n\n`;
        }
        if (content.paragraphs?.length) {
          pageContext += `내용 요약:\n${content.paragraphs.join('\n')}\n\n`;
        }
        if (content.selectedText) {
          pageContext += `선택한 텍스트:\n${content.selectedText}\n\n`;
        }
      }
      fullMessage = pageContext + message;
    }

    // prompt 전송 전에 SSE 구독을 먼저 연결 (server.connected 또는 5초 타임아웃까지 대기)
    // /global/event 는 연결 시점 이후 이벤트만 전달하므로, prompt 전송이 먼저
    // 이루어지면 응답이 빠른 모델의 경우 message.part.* 이벤트를 놓칠 수 있음
    const subscribeStart = Date.now();
    await subscribeToEvents(sessionId, port, onChunk, onComplete);
    debugLog('INFO', `SSE pre-connected before prompt - sessionId=${sessionId}, elapsedMs=${Date.now() - subscribeStart}`);

    const promptCtrl = new AbortController();
    const promptTimeout = setTimeout(() => promptCtrl.abort(), 15000);
    let promptResponse;
    try {
      promptResponse = await fetch(
        `http://127.0.0.1:${port}/session/${sessionId}/prompt_async`,
        {
          method: 'POST',
          headers,
          signal: promptCtrl.signal,
          body: JSON.stringify({
            ...(selectedModel && { model: selectedModel }),
            parts: [{ type: 'text', text: fullMessage }]
          })
        }
      );
    } catch (fetchErr) {
      clearTimeout(promptTimeout);
      const errMsg = fetchErr.name === 'AbortError'
        ? `Prompt fetch timeout (15s) - sessionId=${sessionId}`
        : `Prompt fetch error - ${fetchErr.message}, sessionId=${sessionId}`;
      debugLog('ERROR', errMsg);
      throw fetchErr.name === 'AbortError'
        ? new Error(`메시지 전송 시간 초과 (15s)`)
        : fetchErr;
    }
    clearTimeout(promptTimeout);
    if (promptResponse.status !== 204 && promptResponse.status !== 202 && !promptResponse.ok) {
      const body = await promptResponse.text().catch(() => '');
      debugLog('ERROR', `REST /prompt failed - status=${promptResponse.status}, body=${body}, sessionId=${sessionId}`);
      throw new Error(`메시지 전송 실패: ${promptResponse.status} - ${body}`);
    }
    debugLog('INFO', `Prompt sent - sessionId=${sessionId}, status=${promptResponse.status}, model=${selectedModel ? `${selectedModel.providerID}/${selectedModel.modelID}` : 'default'}`);
  } catch (error) {
    console.error('메시지 전송 오류:', error);
    throw error;
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
    const content = parts
      .filter(p => p.type === 'text' && p.text)
      .map(p => p.text)
      .join('');

    return { content, partTypes, lastMessageId: last.info?.id || null };
  } catch (e) {
    return { content: '', partTypes: [], lastMessageId: null, error: e.message };
  }
}

/**
 * SSE 이벤트 구독 (/global/event + Last-Event-ID 재연결)
 * server.connected 수신 시 resolve → 이후 prompt_async 전송
 * 스트림 종료 시 Last-Event-ID로 재연결하여 응답 이벤트 수신
 */
function subscribeToEvents(sessionId, port, onChunk, onComplete) {
  const existing = eventSources.get(sessionId);
  if (existing) existing.abort();

  const controller = new AbortController();
  eventSources.set(sessionId, controller);

  return new Promise((resolveConnected) => {
    let resolved = false;
    let buffer = '';
    let completed = false;
    let assistantMessageId = null;
    let textPartIds = new Set();

    let timeoutId = null;
    function resetTimeout() {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(async () => {
        if (!completed) {
          controller.abort();
          eventSources.delete(sessionId);
          debugLog('ERROR', `SSE timeout - sessionId=${sessionId}, assistantMessageId=${assistantMessageId || 'none'}, bufferLength=${buffer.length}`);

          let finalContent = buffer || '';
          let errMsg = '응답 시간 초과';
          if (finalContent.length === 0) {
            debugLog('WARN', `Empty buffer at timeout - falling back to REST /session/${sessionId}/message`);
            const fallback = await fetchFallbackContent(port, sessionId);
            if (fallback.content) {
              debugLog('INFO', `REST fallback recovered ${fallback.content.length} chars - sessionId=${sessionId}, lastMessageId=${fallback.lastMessageId}, partTypes=${JSON.stringify(fallback.partTypes)}`);
              finalContent = fallback.content;
              errMsg = null;
            } else {
              debugLog('INFO', `REST fallback found no text parts - sessionId=${sessionId}, lastMessageId=${fallback.lastMessageId || 'none'}, partTypes=${JSON.stringify(fallback.partTypes)}`);
            }
          }
          onComplete(finalContent, errMsg);
        }
      }, 180000);
    }
    resetTimeout();

    function resolveOnce() {
      if (!resolved) { resolved = true; resolveConnected(); }
    }

    async function connect(lastEventId = '') {
      if (completed || controller.signal.aborted) return;

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
          onComplete('', `SSE 연결 실패: ${response.status}`);
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = '';
        let currentId = lastEventId;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          pending += decoder.decode(value, { stream: true });

          // SSE 이벤트는 \n\n 으로 구분
          const parts = pending.split('\n\n');
          pending = parts.pop();

          for (const part of parts) {
            let sseId = '';
            let sseData = '';

            for (const line of part.split('\n')) {
              if (line.startsWith('id:')) sseId = line.slice(3).trim();
              else if (line.startsWith('data:')) sseData = line.slice(5).trim();
            }

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
                debugLog('INFO', `SSE connected - sessionId=${sessionId}`);
                resolveOnce();
                continue;
              }

              // 세션 ID 필터
              const evtSession = evt.properties?.sessionID
                || evt.properties?.part?.sessionID
                || evt.properties?.info?.sessionID;
              if (evtSession && evtSession !== sessionId) continue;

              switch (evt.type) {
                case 'message.updated': {
                  const info = evt.properties?.info;
                  if (info?.role === 'assistant' && info?.sessionID === sessionId) {
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
                  if (part?.messageID === assistantMessageId) {
                    if (part.type === 'text') {
                      textPartIds.add(part.id);
                    } else {
                      debugLog('INFO', `Non-text part for assistant message - sessionId=${sessionId}, messageId=${assistantMessageId}, partId=${part.id}, partType=${part.type}`);
                    }
                  }
                  break;
                }
                case 'message.part.delta': {
                  const props = evt.properties;
                  if (textPartIds.has(props?.partID) && props?.delta) {
                    buffer += props.delta;
                    onChunk(props.delta);
                    resetTimeout();
                  }
                  break;
                }
                case 'session.idle': {
                  completed = true;
                  clearTimeout(timeoutId);
                  controller.abort();
                  eventSources.delete(sessionId);
                  debugLog('INFO', `Session idle - sessionId=${sessionId}, assistantMessageId=${assistantMessageId || 'none'}, textParts=${textPartIds.size}, bufferLength=${buffer.length}`);

                  let finalContent = buffer;
                  if (buffer.length === 0) {
                    debugLog('WARN', `Empty buffer at idle - falling back to REST /session/${sessionId}/message`);
                    const fallback = await fetchFallbackContent(port, sessionId);
                    if (fallback.content) {
                      debugLog('INFO', `REST fallback recovered ${fallback.content.length} chars - sessionId=${sessionId}, lastMessageId=${fallback.lastMessageId}, partTypes=${JSON.stringify(fallback.partTypes)}`);
                      finalContent = fallback.content;
                    } else {
                      debugLog('INFO', `REST fallback found no text parts - sessionId=${sessionId}, lastMessageId=${fallback.lastMessageId || 'none'}, partTypes=${JSON.stringify(fallback.partTypes)}`);
                    }
                  }
                  onComplete(finalContent);
                  return;
                }
                case 'session.error': {
                  completed = true;
                  clearTimeout(timeoutId);
                  controller.abort();
                  eventSources.delete(sessionId);
                  const errMsg = evt.properties?.error?.data?.message
                    || evt.properties?.error?.message
                    || evt.properties?.error?.name
                    || '오류가 발생했습니다';
                  debugLog('ERROR', `Session error - sessionId=${sessionId}, error=${errMsg}`);
                  onComplete(null, errMsg);
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
          connect(currentId);
        }
      } catch (error) {
        if (error.name === 'AbortError') return;
        debugLog('ERROR', `SSE error - ${error.message}, sessionId=${sessionId}`);
        console.error('SSE 오류:', error);
        resolveOnce();
        if (!completed && !controller.signal.aborted) {
          await new Promise(r => setTimeout(r, 2000));
          connect(lastEventId);
        }
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
          sendResponse({ success: true, sessionId });
          break;

        case 'cancel-message': {
          const ctrl = eventSources.get(message.sessionId);
          if (ctrl) {
            ctrl.abort();
            eventSources.delete(message.sessionId);
          }
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
          const tabInfo = await getCurrentTabInfo();
          let replacedSessionId = null;

          const doSendMessage = async (sid) => {
            await sendMessage(
              sid,
              message.message,
              tabInfo,
              (chunk) => {
                chrome.runtime.sendMessage({
                  action: 'message-chunk',
                  sessionId: message.sessionId,
                  chunk: chunk
                }).catch(() => {});
              },
              (final, error) => {
                chrome.runtime.sendMessage({
                  action: 'message-complete',
                  sessionId: message.sessionId,
                  content: final,
                  error: error,
                  ...(replacedSessionId && { newSessionId: replacedSessionId })
                });
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

        case 'has-tab-session':
          sendResponse({ has: tabSessions.has(message.tabId) });
          break;

        case 'get-tab-session': {
          const tabId = message.tabId;
          const existingId = tabId ? tabSessions.get(tabId) : null;
          if (existingId && sessions.has(existingId)) {
            sendResponse({ success: true, sessionId: existingId, isNew: false });
          } else {
            const newId = await createSession(message.title || 'New Chat');
            if (tabId) { tabSessions.set(tabId, newId); persistState(); }
            currentSessionId = newId;
            sendResponse({ success: true, sessionId: newId, isNew: true });
          }
          break;
        }

        case 'get-working-directory':
          sendResponse({ directory: await getWorkingDirectory() });
          break;

        case 'get-default-directory':
          sendResponse({ directory: await getDefaultDirectory() });
          break;

        case 'set-working-directory': {
          const normalized = await normalizeWorkingDirectory(message.directory || '');
          const previous = await getWorkingDirectory();
          await chrome.storage.local.set({ workingDirectory: normalized });

          // opencode 세션은 생성 시점의 x-opencode-directory 헤더로 디렉토리가
          // 고정되며, 이후 헤더 값을 바꿔도 반영되지 않는다. 따라서 디렉토리가
          // 실제로 바뀐 경우, 기존 세션을 버리고 새 세션을 만들어야 새 디렉토리가 적용된다.
          let newSessionId = null;
          if (normalized !== previous) {
            const tabId = message.tabId;
            const oldSessionId = tabId ? tabSessions.get(tabId) : null;
            if (oldSessionId) {
              try {
                await deleteSession(oldSessionId);
                newSessionId = await createSession('Chrome Extension Chat');
                tabSessions.set(tabId, newSessionId);
                persistState();
                debugLog('INFO', `Working directory changed - session recreated (old=${oldSessionId}, new=${newSessionId}, dir=${normalized})`);
              } catch (e) {
                debugLog('ERROR', `Working directory changed but session recreate failed - ${e.message}`);
              }
            }
          }

          sendResponse({ success: true, directory: normalized, newSessionId });
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
          const cmdRes = await fetch(`http://127.0.0.1:${cmdPort}/command`);
          if (!cmdRes.ok) { sendResponse({ commands: [] }); break; }
          const cmdData = await cmdRes.json();
          const commands = Array.isArray(cmdData) ? cmdData : (cmdData.commands || cmdData.items || []);
          sendResponse({ success: true, commands });
          break;
        }

        case 'get-agents': {
          const agentPort = serverState.port;
          if (!agentPort) { sendResponse({ agents: [] }); break; }
          const agentRes = await fetch(`http://127.0.0.1:${agentPort}/agent`);
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
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: message.commandId })
            }
          );
          sendResponse({ success: runRes.ok, status: runRes.status });
          break;
        }

        case 'get-mcp-status': {
          const mcpPort = serverState.port;
          if (!mcpPort) { sendResponse({ success: false, servers: {} }); break; }
          const mcpRes = await fetch(`http://127.0.0.1:${mcpPort}/mcp`);
          if (!mcpRes.ok) { sendResponse({ success: false, servers: {} }); break; }
          sendResponse({ success: true, servers: await mcpRes.json() });
          break;
        }

        case 'toggle-mcp': {
          const togglePort = serverState.port;
          if (!togglePort) { sendResponse({ success: false }); break; }
          const action = message.connect ? 'connect' : 'disconnect';
          const toggleRes = await fetch(
            `http://127.0.0.1:${togglePort}/mcp/${encodeURIComponent(message.name)}/${action}`,
            { method: 'POST' }
          );
          const statusRes = await fetch(`http://127.0.0.1:${togglePort}/mcp`);
          const servers = statusRes.ok ? await statusRes.json() : {};
          sendResponse({ success: toggleRes.ok, servers });
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

function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'send-to-opencode',
      title: 'OpenCode로 보내기',
      contexts: ['selection']
    });
  });
}

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