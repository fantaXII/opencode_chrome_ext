// 실제 background.js를 Node에서 불러오는 하네스.
// - chrome API는 메모리 스텁으로 대체하고, runtime.onMessage 리스너를 잡아 사이드패널처럼 메시지를 보낸다.
// - 서버 탐색 포트와 타임아웃 상수만 소스 치환으로 바꾼다(로직은 손대지 않는다).
// background.js 모듈 상태(sessions, eventSources 등)는 load()마다 새로 만들어진다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let loadSeq = 0;

function createStorageArea(initial = {}) {
  const data = { ...initial };
  const pick = (keys) => {
    if (keys == null) return { ...data };
    if (typeof keys === 'string') return keys in data ? { [keys]: data[keys] } : {};
    if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));
    return Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in data ? data[k] : d]));
  };
  return {
    data,
    get: async (keys) => pick(keys),
    set: async (obj) => { Object.assign(data, obj); },
    remove: async (keys) => { for (const k of [].concat(keys)) delete data[k]; }
  };
}

// 정의하지 않은 API(chrome.contextMenus.create, chrome.tabs.onUpdated.addListener 등)는 아무 일도 하지 않는다.
function noopApi() {
  const fn = () => Promise.resolve(undefined);
  return new Proxy(fn, { get: (t, k) => (k === 'then' ? undefined : noopApi()), apply: () => Promise.resolve(undefined) });
}

function createChromeStub({ local = {} } = {}) {
  const sent = [];       // background → 사이드패널로 보낸 메시지 (chrome.runtime.sendMessage)
  let onMessage = null;
  const runtime = {
    id: 'test-extension',
    lastError: undefined,
    getManifest: () => ({ version: '0.0.0' }),
    getPlatformInfo: async () => ({ os: 'linux' }),
    sendMessage: (msg) => { sent.push({ at: Date.now(), ...msg }); return Promise.resolve(); },
    sendNativeMessage: async () => { throw new Error('native messaging host not found'); },
    onMessage: { addListener: (fn) => { onMessage = fn; } },
    onInstalled: noopApi(), onStartup: noopApi(), onUpdateAvailable: noopApi(),
    requestUpdateCheck: noopApi(), reload: noopApi()
  };
  const chrome = new Proxy({
    runtime,
    storage: { local: createStorageArea(local), session: createStorageArea(), onChanged: noopApi() },
    tabs: new Proxy({ query: async () => [] }, { get: (t, k) => t[k] ?? noopApi() })
  }, { get: (t, k) => t[k] ?? noopApi() });
  return { chrome, sent, getOnMessage: () => onMessage };
}

/**
 * @param {object} opts
 * @param {number} opts.port      가짜 opencode 서버 포트 (이 포트만 스캔한다)
 * @param {Record<string, number>} [opts.constants]  `const NAME = 값;` 형태 상수 치환 (예: STREAM_IDLE_TIMEOUT_MS)
 */
export async function loadBackground({ port, constants = {}, local = {}, sourcePath = path.join(ROOT, 'background.js') }) {
  let src = fs.readFileSync(sourcePath, 'utf8');
  const replace = (re, to, label) => {
    if (!re.test(src)) throw new Error(`harness: background.js에서 ${label}을(를) 찾지 못했다`);
    src = src.replace(re, to);
  };
  replace(/const DEFAULT_PORT = \d+;/, `const DEFAULT_PORT = ${port};`, 'DEFAULT_PORT');
  replace(/const MAX_PORT_CHECK = \d+;/, 'const MAX_PORT_CHECK = 1;', 'MAX_PORT_CHECK');
  for (const [name, value] of Object.entries(constants)) {
    replace(new RegExp(`const ${name} = [^;]+;`), `const ${name} = ${value};`, name);
  }
  src = src.replace(/from '\.\/lib\//g, `from '${pathToFileURL(path.join(ROOT, 'lib')).href}/`);
  src += '\nexport const __test = { sessions, eventSources };\n';

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-harness-'));
  const file = path.join(dir, `background.${++loadSeq}.mjs`);
  fs.writeFileSync(file, src);

  const stub = createChromeStub({ local });
  globalThis.chrome = stub.chrome;
  // background.js는 console.log를 많이 남긴다. 테스트 출력이 묻히지 않게 끈다.
  const origLog = console.log;
  console.log = () => {};
  const mod = await import(pathToFileURL(file).href);
  console.log = origLog;

  /** 사이드패널처럼 background에 메시지를 보내고 sendResponse 값을 돌려받는다. */
  function send(message) {
    return new Promise((resolve) => {
      const keep = stub.getOnMessage()(message, { id: 'test-extension' }, resolve);
      if (keep !== true) resolve(undefined);
    });
  }

  return {
    send,
    sent: stub.sent,
    internals: mod.__test,
    /** 다음 SW 로그를 읽는다 (debugLog는 chrome.storage.local.debugLogs에 쌓인다). */
    logs: () => (stub.chrome.storage.local.data.debugLogs || []).map((e) => `${e.level} ${e.msg}`),
    cleanup: () => {
      for (const c of mod.__test.eventSources.values()) c.abort();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** cond()가 참이 될 때까지 기다린다(최대 timeoutMs). */
export async function waitFor(cond, timeoutMs = 3000, label = 'condition') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await sleep(10);
  }
  throw new Error(`waitFor timeout: ${label}`);
}
