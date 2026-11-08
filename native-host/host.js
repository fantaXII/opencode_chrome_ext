const { spawn, execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

let opencodeProcess = null;
let currentPort = 4096;
let isWSL = false;

// ============================================
// 파일 로거 (로테이션: 500KB × 3파일 = 최대 1.5MB)
// ============================================

const LOG_DIR = path.join(
  process.env.LOCALAPPDATA || process.env.APPDATA || os.homedir(),
  'OpenCodeChrome', 'logs'
);
const LOG_FILE = path.join(LOG_DIR, 'native-host.log');
const MAX_LOG_SIZE = 500 * 1024;
const MAX_LOG_BACKUPS = 2;

function ensureLogDir() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {}
}

function rotateIfNeeded() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    if (fs.statSync(LOG_FILE).size < MAX_LOG_SIZE) return;
    for (let i = MAX_LOG_BACKUPS; i >= 1; i--) {
      const from = `${LOG_FILE}.${i}`;
      if (i === MAX_LOG_BACKUPS) {
        if (fs.existsSync(from)) fs.unlinkSync(from);
      } else {
        if (fs.existsSync(from)) fs.renameSync(from, `${LOG_FILE}.${i + 1}`);
      }
    }
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {}
}

function fileLog(level, message) {
  try {
    ensureLogDir();
    rotateIfNeeded();
    const line = `${new Date().toISOString()} [${level.padEnd(5)}] ${message}\n`;
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch {}
  process.stderr.write(`[NativeHost][${level}] ${message}\n`);
}

// ============================================
// 서버 상태 확인
// ============================================

async function checkOpenCodeServer(port) {
  try {
    const http = require('http');
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/global/health`, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(2000, () => { req.destroy(); resolve(false); });
    });
  } catch {
    return false;
  }
}

async function findAvailablePort(startPort = 4096) {
  for (let port = startPort; port < startPort + 10; port++) {
    const available = await checkOpenCodeServer(port);
    if (!available) return port;
  }
  return null;
}

// ============================================
// opencode 경로 탐색 (preferredRuntime 순서, 못 찾으면 반대편 fallback)
// ============================================

function findWindowsOpenCode(diagnostic) {
  diagnostic.windowsPath.checked = true;
  try {
    fileLog('DEBUG', 'findOpenCodePath: Trying Windows PATH...');
    const windowsPath = require('which').sync('opencode');
    diagnostic.windowsPath.found = true;
    fileLog('INFO', `findOpenCodePath: Found in Windows PATH: ${windowsPath}`);
    return { path: windowsPath, isWSL: false, diagnostic };
  } catch (error) {
    diagnostic.windowsPath.error = error.message;
    fileLog('WARN', `findOpenCodePath: Not in Windows PATH - ${error.message}`);
    return null;
  }
}

// WSL (최대 3회 재시도, 3가지 전략)
async function findWslOpenCode(diagnostic) {
  diagnostic.wsl.checked = true;
  const wslStrategies = [
    ['bash', '-c', 'test -x "$HOME/.opencode/bin/opencode" && echo "$HOME/.opencode/bin/opencode"'],
    ['bash', '-c', '. "$HOME/.nvm/nvm.sh" 2>/dev/null; which opencode 2>/dev/null'],
    ['bash', '-ilc', 'which opencode 2>/dev/null'],
  ];

  for (let attempt = 1; attempt <= 3; attempt++) {
    for (let si = 0; si < wslStrategies.length; si++) {
      try {
        fileLog('DEBUG', `findOpenCodePath: WSL strategy ${si + 1}/${wslStrategies.length}, attempt ${attempt}/3...`);
        const result = spawnSync('wsl.exe', wslStrategies[si], { encoding: 'utf8', timeout: 15000 });
        const wslPath = (result.stdout || '').split('\n').map(l => l.trim()).filter(Boolean).pop() || '';
        const stderr = (result.stderr || '').trim().substring(0, 200);

        diagnostic.wsl.strategies.push({ id: si + 1, attempt, found: !!wslPath, stderr, exitCode: result.status });
        fileLog('DEBUG', `findOpenCodePath: WSL s${si + 1}/a${attempt}: path="${wslPath}", exitCode=${result.status}, stderr="${stderr}"`);

        if (wslPath) {
          diagnostic.wsl.found = true;
          fileLog('INFO', `findOpenCodePath: Found in WSL: ${wslPath}`);
          return { path: wslPath, isWSL: true, diagnostic };
        }
      } catch (error) {
        diagnostic.wsl.strategies.push({ id: si + 1, attempt, found: false, stderr: error.message, exitCode: null });
        fileLog('WARN', `findOpenCodePath: WSL s${si + 1}/a${attempt} exception: ${error.message}`);
      }
    }

    if (attempt < 3) {
      fileLog('DEBUG', 'findOpenCodePath: Retrying WSL in 2s...');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  return null;
}

// preferredRuntime: 'auto'·'wsl'(WSL 우선) | 'windows'(Windows 우선)
async function findOpenCodePath(preferredRuntime = 'auto') {
  const diagnostic = {
    windowsPath: { checked: false, found: false, error: null },
    wsl: { checked: false, found: false, strategies: [] }
  };

  const order = preferredRuntime === 'windows' ? ['windows', 'wsl'] : ['wsl', 'windows'];
  fileLog('DEBUG', `findOpenCodePath: preferredRuntime=${preferredRuntime}, order=${order.join('>')}`);

  for (const side of order) {
    const found = side === 'wsl' ? await findWslOpenCode(diagnostic) : findWindowsOpenCode(diagnostic);
    if (found) return found;
  }

  fileLog('ERROR', 'findOpenCodePath: Not found in Windows PATH or WSL after all attempts');
  return { path: null, isWSL: false, diagnostic };
}

// ============================================
// Proxy 환경변수 (확장 설정 메뉴 → start/restart 메시지의 proxy 필드)
// ============================================

// Windows 환경변수는 대소문자를 구분하지 않아 HTTP_PROXY와 http_proxy가 같은 변수다.
// 그래서 대문자 이름 하나만 설정하고, 사용자가 이미 소문자(no_proxy 등)로 등록해 둔
// 같은 변수는 먼저 지워 중복·충돌을 막는다. (WSL은 WSLENV에 적힌 이름과 정확히 같은
// 대소문자의 변수만 받으므로, 소문자로 남아 있으면 대문자 WSLENV가 값을 못 찾는다.)
const PROXY_FIELDS = [
  ['http', 'HTTP_PROXY'],
  ['https', 'HTTPS_PROXY'],
  ['noProxy', 'NO_PROXY']
];

/** 메시지로 받은 proxy 값을 문자열 3개로 정규화한다(제어문자 제거, 빈 값은 ''). */
function normalizeProxy(proxy) {
  const out = { http: '', https: '', noProxy: '' };
  if (!proxy || typeof proxy !== 'object') return out;
  for (const [key] of PROXY_FIELDS) {
    const v = proxy[key];
    out[key] = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  }
  return out;
}

/**
 * opencode 프로세스에 줄 환경변수를 만든다. 값이 빈 항목은 건드리지 않아 기존
 * 시스템 환경변수가 그대로 유지된다. WSL 쪽은 wsl.exe가 WSLENV에 등록된 변수만
 * 넘겨주므로 설정한 이름을 WSLENV에 추가한다.
 */
function buildProxyEnv(baseEnv, proxy) {
  const env = { ...baseEnv };
  const p = normalizeProxy(proxy);
  const names = [];
  for (const [key, name] of PROXY_FIELDS) {
    if (!p[key]) continue;
    for (const k of Object.keys(env)) {
      if (k.toUpperCase() === name) delete env[k];
    }
    env[name] = p[key];
    names.push(name);
  }
  if (names.length) {
    // 같은 변수를 다른 대소문자로 등록한 기존 항목은 값을 못 찾으므로 빼고 대문자로 다시 넣는다.
    const upper = new Set(names);
    const kept = (baseEnv.WSLENV || '').split(':').filter(Boolean)
      .filter(e => !upper.has(e.split('/')[0].toUpperCase()));
    env.WSLENV = kept.concat(names).join(':');
  }
  return env;
}

// ============================================
// OpenCode 서버 기동
// ============================================

async function startOpenCodeServer(preferredPort = 4096, preferredRuntime = 'auto', proxy = null) {
  if (opencodeProcess) {
    fileLog('INFO', `startOpenCodeServer: Already running on port ${currentPort}`);
    return currentPort;
  }

  fileLog('INFO', 'startOpenCodeServer: Starting...');

  try {
    const port = await findAvailablePort(preferredPort);
    if (!port) throw new Error('사용 가능한 포트를 찾을 수 없음');

    currentPort = port;
    fileLog('INFO', `startOpenCodeServer: Using port ${port}`);

    const found = await findOpenCodePath(preferredRuntime);

    if (!found.path) {
      const err = new Error('opencode를 찾을 수 없음 (Windows/WSL 모두 확인)');
      err.diagnostic = found.diagnostic;
      throw err;
    }

    isWSL = found.isWSL;

    const spawnEnv = buildProxyEnv(process.env, proxy);
    const p = normalizeProxy(proxy);
    // 값(계정 포함 가능)은 로그에 남기지 않고 어떤 항목이 설정됐는지만 기록한다.
    fileLog('INFO', `startOpenCodeServer: proxy http=${!!p.http} https=${!!p.https} noProxy=${!!p.noProxy}`);

    if (isWSL) {
      fileLog('INFO', `startOpenCodeServer: Spawning via WSL: wsl.exe ${found.path} serve --port ${port}`);
      opencodeProcess = spawn('wsl.exe', [found.path, 'serve', '--port', port.toString()], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: spawnEnv
      });
    } else {
      fileLog('INFO', `startOpenCodeServer: Spawning on Windows: ${found.path} serve --port ${port}`);
      const isCmd = /\.(cmd|bat)$/i.test(found.path);
      opencodeProcess = spawn(found.path, ['serve', '--port', port.toString()], {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: isCmd,
        env: spawnEnv
      });
    }

    opencodeProcess.stdout.on('data', (data) => {
      fileLog('INFO', `[opencode] ${data.toString().trimEnd()}`);
    });
    opencodeProcess.stderr.on('data', (data) => {
      fileLog('INFO', `[opencode] ${data.toString().trimEnd()}`);
    });
    opencodeProcess.on('exit', (code, signal) => {
      fileLog(code === 0 ? 'INFO' : 'ERROR', `OpenCode process exited: code=${code}, signal=${signal}`);
      opencodeProcess = null;
    });
    opencodeProcess.on('error', (error) => {
      fileLog('ERROR', `OpenCode process spawn error: ${error.message}`);
      opencodeProcess = null;
    });

    let attempts = 0;
    const maxAttempts = 30;
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const available = await checkOpenCodeServer(port);
      if (available) {
        fileLog('INFO', `startOpenCodeServer: Server ready on port ${port} after ${attempts + 1}s`);
        recordServerListener(port);
        return port;
      }
      attempts++;
      if (attempts % 5 === 0) fileLog('DEBUG', `startOpenCodeServer: Waiting... ${attempts}/${maxAttempts}s`);
    }

    throw new Error('서버 시작 시간 초과');
  } catch (error) {
    fileLog('ERROR', `startOpenCodeServer: Failed - ${error.message}`);
    throw error;
  }
}

// ============================================
// 서버 종료 / 재시작 (포트 점유 프로세스 기준)
// ============================================

// background.js는 chrome.runtime.sendNativeMessage(one-shot)만 사용하므로 메시지마다
// 이 호스트 프로세스가 새로 뜬다. 즉 종료/재시작 요청이 들어온 시점에는 모듈 전역
// opencodeProcess/isWSL이 항상 초기값이다. 따라서 프로세스 핸들이 아니라 "그 포트를
// 점유한 프로세스"를 찾아 종료해야 한다. 서버가 Windows 네이티브인지 WSL인지도 알 수
// 없으므로 양쪽을 모두 시도하고, 성공 판정은 "포트가 정말 죽었는지"로만 한다.

// WSL2 localhost forwarding에서 WSL 내부 리스너를 Windows 쪽에서 대리 점유하는
// 프로세스들. 이 이름이 나오면 실제 opencode는 WSL 안에 있다.
const WSL_RELAY_PROCESSES = /^(wslrelay|wslhost|wslservice|svchost|System|Idle)$/i;

// 포트 리스너 조회. relay는 WSL 포트 포워딩 대리 점유 프로세스(실제 서버는 WSL 안).
function findWindowsListener(port) {
  try {
    const ps = [
      `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1;`,
      'if ($c) {',
      '  $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue;',
      '  if ($p) { $p.Id; $p.ProcessName }',
      '}',
      'exit 0' // 리스너가 없을 때 Get-NetTCPConnection의 오류 때문에 종료 코드가 1이 되는 것을 막는다
    ].join(' ');
    const out = execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8', timeout: 15000 }).trim();
    const [pid, name] = out.split(/\r?\n/).map(s => s.trim());
    if (!pid) return null;
    return { pid: Number(pid), name: name || '', relay: WSL_RELAY_PROCESSES.test(name || '') };
  } catch (error) {
    fileLog('DEBUG', `findWindowsListener: ${error.message}`);
    return { error: error.message.substring(0, 120) };
  }
}

function killWindowsListener(port) {
  try {
    const l = findWindowsListener(port);
    if (l?.error) return { side: 'windows', killed: false, reason: l.error };
    if (!l) return { side: 'windows', killed: false, reason: 'no-listener' };
    if (l.relay) {
      fileLog('INFO', `killWindowsListener: port ${port} held by relay ${l.name} (pid=${l.pid}) -> listener is inside WSL`);
      return { side: 'windows', killed: false, reason: `relay:${l.name}` };
    }

    // opencode가 .cmd/.bat 래퍼로 설치된 경우 실제 리스너는 node/bun 자식이므로
    // /T로 프로세스 트리를 함께 종료한다.
    execSync(`taskkill /PID ${l.pid} /T /F`, { encoding: 'utf8', timeout: 15000 });
    fileLog('INFO', `killWindowsListener: killed pid=${l.pid} (${l.name}) on port ${port}`);
    return { side: 'windows', killed: true, pid: l.pid, name: l.name };
  } catch (error) {
    fileLog('DEBUG', `killWindowsListener: ${error.message}`);
    return { side: 'windows', killed: false, reason: error.message.substring(0, 120) };
  }
}

// wsl.exe에는 셸 스크립트가 아니라 argv만 넘긴다. `wsl.exe bash -c "<스크립트>"` 형태는
// 인자가 Windows 커맨드라인 파싱과 WSL interop을 거치는 동안 따옴표나 $ 확장이 깨질 수
// 있어서(실측으로 깨지는 조합을 확인함) 파싱은 전부 Node 쪽에서 처리한다.
// ss 출력 예: LISTEN 0 512 127.0.0.1:4096 0.0.0.0:* users:(("opencode",pid=1234,fd=19))
function parseSsListener(output, port) {
  for (const line of (output || '').split('\n')) {
    const localAddress = line.trim().split(/\s+/)[3] || '';
    if (!localAddress.endsWith(`:${port}`)) continue;
    const m = line.match(/\("([^"]*)",pid=(\d+)/);
    if (m) return { pid: Number(m[2]), name: m[1] };
  }
  return null;
}

function findWSLListener(port) {
  const ss = spawnSync('wsl.exe', ['ss', '-ltnpH'], { encoding: 'utf8', timeout: 15000 });
  const parsed = parseSsListener(ss.stdout, port);
  if (parsed) return parsed;

  // ss가 없거나 pid 정보를 못 얻은 경우 폴백. fuser는 pid를 stdout에,
  // "4096/tcp:" 헤더를 stderr에 쓰므로 stdout만 본다.
  const fuser = spawnSync('wsl.exe', ['fuser', `${port}/tcp`], { encoding: 'utf8', timeout: 15000 });
  const fuserMatch = (fuser.stdout || '').match(/\d+/);
  return fuserMatch ? { pid: Number(fuserMatch[0]), name: '' } : null;
}

function findWSLListenerPid(port) {
  return findWSLListener(port)?.pid ?? null;
}

function killWSLListener(port, force) {
  try {
    const pid = findWSLListenerPid(port);
    if (!pid) return { side: 'wsl', killed: false, reason: 'no-listener' };

    const signal = force ? '-KILL' : '-TERM';
    const result = spawnSync('wsl.exe', ['kill', signal, String(pid)], { encoding: 'utf8', timeout: 15000 });
    if (result.status !== 0) {
      const stderr = (result.stderr || '').trim().substring(0, 120);
      return { side: 'wsl', killed: false, pid, reason: stderr || `kill exit=${result.status}` };
    }

    fileLog('INFO', `killWSLListener: sent ${signal} to WSL pid=${pid} on port ${port}`);
    return { side: 'wsl', killed: true, pid, force: !!force };
  } catch (error) {
    fileLog('DEBUG', `killWSLListener: ${error.message}`);
    return { side: 'wsl', killed: false, reason: error.message.substring(0, 120) };
  }
}

async function waitForPortFree(port, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!(await checkOpenCodeServer(port))) return true;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  return false;
}

/**
 * 포트를 점유한 opencode 서버를 종료한다.
 * WSL 우선(isWSLHint) → 반대편 → 강제(SIGKILL) 순으로 올라가며, 매 단계마다
 * 포트가 실제로 비었는지 health로 확인한다.
 */
async function stopOpenCodeServer(port = currentPort, isWSLHint = false) {
  const attempts = [];

  if (opencodeProcess) {
    try { opencodeProcess.kill(); } catch {}
    opencodeProcess = null;
  }

  if (!(await checkOpenCodeServer(port))) {
    fileLog('INFO', `stopOpenCodeServer: port ${port} already free`);
    return { stopped: true, attempts };
  }

  const order = isWSLHint ? ['wsl', 'windows'] : ['windows', 'wsl'];
  for (const force of [false, true]) {
    for (const side of order) {
      if (!(await checkOpenCodeServer(port))) break;
      const result = side === 'wsl' ? killWSLListener(port, force) : killWindowsListener(port);
      attempts.push({ ...result, force });
      if (result.killed) await waitForPortFree(port, 5000);
    }
    if (!(await checkOpenCodeServer(port))) break;
  }

  const stopped = !(await checkOpenCodeServer(port));
  fileLog(stopped ? 'INFO' : 'ERROR',
    `stopOpenCodeServer: port=${port}, stopped=${stopped}, attempts=${JSON.stringify(attempts)}`);
  isWSL = false;
  return { stopped, attempts };
}

// ============================================
// 확장이 띄운 서버 식별 (host는 요청마다 새 프로세스라 파일로 남긴다)
// ============================================

const SERVER_RECORD_FILE = path.join(path.dirname(LOG_DIR), 'server.json');

/** 포트의 실제 리스너(서버 프로세스) 조회. 결과: { side, pid, name } | null */
function getListener(port) {
  const win = findWindowsListener(port);
  if (win && !win.error && !win.relay) return { side: 'windows', pid: win.pid, name: win.name };
  const wsl = findWSLListener(port);
  return wsl ? { side: 'wsl', ...wsl } : null;
}

/** 방금 띄운 서버의 리스너 pid를 기록한다. 실패해도 서버 기동은 막지 않는다. */
function recordServerListener(port) {
  try {
    const l = getListener(port);
    if (!l) return;
    fs.mkdirSync(path.dirname(SERVER_RECORD_FILE), { recursive: true });
    fs.writeFileSync(SERVER_RECORD_FILE, JSON.stringify({ port, side: l.side, pid: l.pid, startedAt: Date.now() }));
    fileLog('INFO', `recordServerListener: port=${port} side=${l.side} pid=${l.pid}`);
  } catch (error) {
    fileLog('DEBUG', `recordServerListener: ${error.message}`);
  }
}

function readServerRecord() {
  try {
    return JSON.parse(fs.readFileSync(SERVER_RECORD_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** 기록과 현재 리스너를 대조: 같으면 확장이 띄운 서버. */
function isManagedListener(record, listener, port) {
  return !!(record && listener
    && record.port === port
    && record.side === listener.side
    && record.pid === listener.pid);
}

/** 프록시 URL의 계정 정보(user:pass@)를 가린다. 표시 전용이므로 원문은 밖으로 내보내지 않는다. */
function maskProxyValue(value) {
  return String(value).replace(/\/\/[^@/\s]*@/g, '//***@');
}

/**
 * /proc/<pid>/environ 원문(NUL 구분)에서 프록시 변수 3개만 뽑는다. 대소문자 변형은
 * 대문자 쪽을 우선한다. 다른 환경변수(API 키 등)는 버린다.
 */
function parseProxyEnviron(raw) {
  const out = { http: '', https: '', noProxy: '' };
  const lower = { http: '', https: '', noProxy: '' };
  for (const entry of String(raw || '').split('\0')) {
    const i = entry.indexOf('=');
    if (i < 1) continue;
    const name = entry.slice(0, i);
    const field = PROXY_FIELDS.find(([, n]) => n === name.toUpperCase())?.[0];
    if (!field) continue;
    const value = maskProxyValue(entry.slice(i + 1).replace(/[\u0000-\u001f\u007f]/g, '').trim());
    if (name === name.toUpperCase()) out[field] = value; else lower[field] = value;
  }
  for (const k of Object.keys(out)) if (!out[k]) out[k] = lower[k];
  return out;
}

/** 실행 중인 서버 프로세스가 실제로 가진 프록시 환경변수. 읽을 수 없으면 null (WSL만 지원). */
function readListenerProxyEnv(listener) {
  if (!listener || listener.side !== 'wsl' || !listener.pid) return null;
  try {
    const r = spawnSync('wsl.exe', ['cat', `/proc/${listener.pid}/environ`], { encoding: 'utf8', timeout: 5000 });
    if (r.status !== 0) return null;
    return parseProxyEnviron(r.stdout);
  } catch (error) {
    fileLog('DEBUG', `readListenerProxyEnv: ${error.message}`);
    return null;
  }
}

function getServerInfo(port) {
  const listener = getListener(port);
  return {
    listener: listener ? { side: listener.side, pid: listener.pid, name: listener.name } : null,
    managed: isManagedListener(readServerRecord(), listener, port),
    proxyEnv: readListenerProxyEnv(listener)
  };
}

async function restartOpenCodeServer(port = currentPort, isWSLHint = false, preferredRuntime = 'auto', proxy = null) {
  fileLog('INFO', `restartOpenCodeServer: port=${port}, isWSLHint=${isWSLHint}, preferredRuntime=${preferredRuntime}`);
  const { stopped, attempts } = await stopOpenCodeServer(port, isWSLHint);
  if (!stopped) {
    const error = new Error(`포트 ${port}의 서버를 종료할 수 없습니다`);
    error.attempts = attempts;
    throw error;
  }

  opencodeProcess = null;
  const newPort = await startOpenCodeServer(port, preferredRuntime, proxy);
  return { port: newPort, attempts };
}

// 드라이브 문자가 네트워크 드라이브면 매핑 대상 UNC 경로를 반환, 로컬 고정 디스크면 null
function resolveNetworkDriveRoot(driveLetter) {
  try {
    const ps = `(Get-PSDrive -Name '${driveLetter}' -ErrorAction SilentlyContinue).DisplayRoot`;
    const out = execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8' }).trim();
    return out || null;
  } catch {
    return null;
  }
}

// 드라이브 문자 경로를 필요 시 WSL 절대경로로 치환. 변환 안 되면 원본 경로 그대로 반환하고 warning을 채움
// driveRootCache: 다중 파일 선택 시 같은 드라이브 문자에 대해 powershell을 반복 호출하지 않도록 호출자가 넘기는 캐시
function resolveDrivePath(rawPath, driveRootCache) {
  const driveMatch = rawPath.match(/^([A-Za-z]):[\\\/](.*)$/);
  if (!driveMatch) return { path: rawPath, warning: null };

  const driveLetter = driveMatch[1];
  const rest = driveMatch[2];
  let displayRoot;
  if (driveRootCache && driveRootCache.has(driveLetter)) {
    displayRoot = driveRootCache.get(driveLetter);
  } else {
    displayRoot = resolveNetworkDriveRoot(driveLetter);
    if (driveRootCache) driveRootCache.set(driveLetter, displayRoot);
  }
  if (!displayRoot) return { path: rawPath, warning: null };

  // 네트워크 드라이브가 WSL 파일시스템(\\wsl$\<distro>\... 또는 \\wsl.localhost\<distro>\...)을
  // 되돌아 가리키는 경우: 드라이브 문자 대신 실제 리눅스 절대경로로 치환
  const wslRootMatch = displayRoot.match(/^\\\\(?:wsl\$|wsl\.localhost)\\[^\\]+(\\.*)?$/i);
  if (wslRootMatch) {
    const basePath = (wslRootMatch[1] || '').replace(/\\/g, '/');
    const restPath = rest ? `/${rest.replace(/\\/g, '/')}` : '';
    return { path: (basePath + restPath) || '/', warning: null };
  }

  return {
    path: rawPath,
    warning: `선택한 항목(${driveLetter}:)은 네트워크 드라이브(${displayRoot})이며, opencode 서버(WSL)에서 접근하지 못할 수 있습니다.`
  };
}

// ============================================
// 작업 디렉터리 검증/변환 (resolve-directory)
// ============================================

const WSL_UNC_ROOT = /^\\\\(?:wsl\$|wsl\.localhost)\\[^\\]+(\\.*)?$/i;

/**
 * /mnt/<드라이브>/... 형태인데 WSL에 그 마운트가 없을 때, 해당 드라이브가 WSL 파일시스템을
 * 가리키는 네트워크 드라이브(\\wsl$\...)라면 리눅스 절대경로로 되돌린다. 아니면 null.
 * displayRoot: 해당 드라이브의 DisplayRoot (예: \\wsl.localhost\Ubuntu\)
 */
function mapMntToWslPath(posixPath, displayRoot) {
  const m = String(posixPath || '').match(/^\/mnt\/([A-Za-z])(\/.*)?$/);
  if (!m || !displayRoot) return null;
  const root = displayRoot.match(WSL_UNC_ROOT);
  if (!root) return null;
  const base = (root[1] || '').replace(/\\/g, '/').replace(/\/$/, '');
  const rest = (m[2] || '').replace(/\/$/, '');
  return (base + rest) || '/';
}

function wslDirExists(p) {
  // argv만 넘긴다(셸 따옴표 문제 회피). 종료 코드 0이면 존재.
  const r = spawnSync('wsl.exe', ['test', '-d', p], { encoding: 'utf8', timeout: 8000 });
  return r.status === 0;
}

/**
 * 사용자가 지정한 작업 디렉터리를 서버 환경에 맞게 변환하고 실제로 존재하는지 확인한다.
 * runtime: 'wsl' | 'windows'. 반환: { path, exists, converted, note }
 */
function resolveWorkingDirectory(rawPath, runtime) {
  const input = String(rawPath || '').trim();
  if (!input) return { path: '', exists: true, converted: false, note: null };

  if (runtime === 'windows') {
    let exists = false;
    try { exists = fs.statSync(input).isDirectory(); } catch {}
    return { path: input, exists, converted: false, note: null };
  }

  let candidate = input;
  if (/^[A-Za-z]:[\\\/]/.test(input)) {
    candidate = resolveDrivePath(input).path;
    if (/^[A-Za-z]:[\\\/]/.test(candidate)) {
      // 네트워크 드라이브가 아니라면 wslpath로 /mnt/<x>/... 변환
      const r = spawnSync('wsl.exe', ['wslpath', '-u', input], { encoding: 'utf8', timeout: 8000 });
      const out = (r.stdout || '').trim();
      if (r.status === 0 && out) candidate = out;
    }
  } else if (/^\\\\/.test(input)) {
    const unc = input.match(WSL_UNC_ROOT);
    if (unc) candidate = (unc[1] || '').replace(/\\/g, '/') || '/';
  } else {
    candidate = input.replace(/\\/g, '/');
  }
  candidate = candidate.length > 1 ? candidate.replace(/\/+$/, '') : candidate;

  let exists = wslDirExists(candidate);
  let note = null;
  if (!exists) {
    // /mnt/z/... 처럼 WSL에 없는 마운트: 드라이브가 WSL을 가리키면 리눅스 경로로 복구 시도
    const mnt = candidate.match(/^\/mnt\/([A-Za-z])(\/|$)/);
    if (mnt) {
      const alt = mapMntToWslPath(candidate, resolveNetworkDriveRoot(mnt[1].toUpperCase()));
      if (alt && wslDirExists(alt)) {
        candidate = alt;
        exists = true;
        note = 'mapped-drive';
      }
    }
  }
  return { path: candidate, exists, converted: candidate !== input, note };
}

// ============================================
// host 버전 (인스톨러가 설치 폴더에 version.txt로 기록한다. 개발 환경에는 없음 → null)
// ============================================

function readHostVersion() {
  try {
    return fs.readFileSync(path.join(__dirname, 'version.txt'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** 인스톨러가 config.private.json의 proxy 섹션만 남겨 둔 proxy.json. 없거나 비어 있으면 null. */
function readInstalledProxy() {
  try {
    const raw = fs.readFileSync(path.join(path.dirname(LOG_DIR), 'proxy.json'), 'utf8').replace(/^﻿/, '');
    const p = normalizeProxy(JSON.parse(raw));
    return p.http || p.https || p.noProxy ? p : null;
  } catch {
    return null;
  }
}

// ============================================
// 메시지 핸들러
// ============================================

async function handleMessage(message) {
  const { action, preferredPort } = message;
  const preferredRuntime = ['auto', 'wsl', 'windows'].includes(message.preferredRuntime) ? message.preferredRuntime : 'auto';
  // 종료/재시작 요청은 background.js가 실측한 포트와 WSL 여부 힌트를 함께 보낸다.
  const proxy = message.proxy || null;
  const targetPort = message.port || currentPort;
  const isWSLHint = message.isWSL === true;
  fileLog('INFO', `handleMessage: action=${action}`);

  switch (action) {
    case 'start':
      try {
        const port = await startOpenCodeServer(preferredPort || 4096, preferredRuntime, proxy);
        fileLog('INFO', `handleMessage: start success, port=${port}, isWSL=${isWSL}`);
        return { status: 'success', port, isWSL };
      } catch (error) {
        fileLog('ERROR', `handleMessage: start failed - ${error.message}`);
        return { status: 'error', error: error.message, diagnostic: error.diagnostic || null };
      }

    case 'stop': {
      const { stopped, attempts } = await stopOpenCodeServer(targetPort, isWSLHint);
      return stopped
        ? { status: 'success', attempts }
        : { status: 'error', error: `포트 ${targetPort}의 서버를 종료할 수 없습니다`, attempts };
    }

    case 'restart':
      try {
        const result = await restartOpenCodeServer(targetPort, isWSLHint, preferredRuntime, proxy);
        fileLog('INFO', `handleMessage: restart success, port=${result.port}, isWSL=${isWSL}`);
        return { status: 'success', port: result.port, isWSL, attempts: result.attempts };
      } catch (error) {
        fileLog('ERROR', `handleMessage: restart failed - ${error.message}`);
        return {
          status: 'error',
          error: error.message,
          attempts: error.attempts || null,
          diagnostic: error.diagnostic || null
        };
      }

    case 'server-info':
      return { status: 'success', ...getServerInfo(targetPort) };

    case 'get-version':
      return { status: 'success', version: readHostVersion() };

    case 'get-installed-proxy':
      return { status: 'success', proxy: readInstalledProxy() };

    case 'status': {
      const available = await checkOpenCodeServer(currentPort);
      return { status: 'success', running: available, port: currentPort };
    }

    case 'check-port': {
      const portAvailable = await findAvailablePort(preferredPort || 4096);
      return { port: portAvailable };
    }

    case 'resolve-directory': {
      const runtime = message.runtime === 'windows' ? 'windows' : 'wsl';
      try {
        const r = resolveWorkingDirectory(message.path, runtime);
        fileLog('INFO', `resolve-directory: runtime=${runtime}, in=${message.path}, out=${r.path}, exists=${r.exists}${r.note ? ', ' + r.note : ''}`);
        return { status: 'success', ...r };
      } catch (e) {
        fileLog('ERROR', `resolve-directory: Failed - ${e.message}`);
        return { status: 'error', error: e.message };
      }
    }

    case 'get-home-dir': {
      try {
        const result = spawnSync('wsl.exe', ['sh', '-c', 'echo $HOME'], { encoding: 'utf8', timeout: 3000 });
        const wslHome = (result.stdout || '').trim();
        if (wslHome) return { status: 'success', directory: wslHome };
      } catch {}
      return { status: 'success', directory: os.homedir() };
    }

    case 'browse-for-folder': {
      fileLog('INFO', 'browse-for-folder: Opening FolderBrowserDialog...');
      try {
        const ps = [
          'Add-Type -AssemblyName System.Windows.Forms;',
          '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
          "$d.Description = 'Select working directory';",
          "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath } else { '' }"
        ].join(' ');
        let dir = execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8' }).trim();
        if (!dir) {
          fileLog('INFO', 'browse-for-folder: Cancelled by user');
          return { status: 'success', directory: null };
        }
        fileLog('INFO', `browse-for-folder: Selected - ${dir}`);

        const resolved = resolveDrivePath(dir);
        if (resolved.path !== dir) {
          fileLog('INFO', `browse-for-folder: network drive -> WSL path - ${resolved.path}`);
        } else if (resolved.warning) {
          fileLog('WARN', `browse-for-folder: ${resolved.warning}`);
        }

        return { status: 'success', directory: resolved.path, warning: resolved.warning };
      } catch (e) {
        fileLog('ERROR', `browse-for-folder: Failed - ${e.message}`);
        return { status: 'error', error: e.message, directory: null };
      }
    }

    case 'browse-for-file': {
      fileLog('INFO', 'browse-for-file: Opening OpenFileDialog...');
      try {
        const ps = [
          'Add-Type -AssemblyName System.Windows.Forms;',
          '$d = New-Object System.Windows.Forms.OpenFileDialog;',
          "$d.Title = 'Select file(s) to attach';",
          '$d.Multiselect = $true;',
          "if ($d.ShowDialog() -eq 'OK') { $d.FileNames -join [char]10 } else { '' }"
        ].join(' ');
        const out = execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8' }).trim();
        if (!out) {
          fileLog('INFO', 'browse-for-file: Cancelled by user');
          return { status: 'success', files: [] };
        }

        const rawFiles = out.split('\n').map(l => l.trim()).filter(Boolean);
        fileLog('INFO', `browse-for-file: Selected ${rawFiles.length} file(s)`);

        const files = [];
        const warnings = [];
        const driveRootCache = new Map();
        for (const rawPath of rawFiles) {
          const resolved = resolveDrivePath(rawPath, driveRootCache);
          if (resolved.path !== rawPath) {
            fileLog('INFO', `browse-for-file: network drive -> WSL path - ${resolved.path}`);
          } else if (resolved.warning) {
            fileLog('WARN', `browse-for-file: ${resolved.warning}`);
            warnings.push(resolved.warning);
          }
          files.push(resolved.path);
        }

        return { status: 'success', files, warnings };
      } catch (e) {
        fileLog('ERROR', `browse-for-file: Failed - ${e.message}`);
        return { status: 'error', error: e.message, files: [] };
      }
    }

    case 'read-log': {
      try {
        if (!fs.existsSync(LOG_FILE)) {
          return { status: 'success', content: '(로그 파일 없음)', path: LOG_FILE };
        }
        const content = fs.readFileSync(LOG_FILE, 'utf8');
        const lines = content.split('\n').filter(l => l.trim());
        const last100 = lines.slice(-100).join('\n');
        return { status: 'success', content: last100, path: LOG_FILE };
      } catch (error) {
        return { status: 'error', error: error.message };
      }
    }

    default:
      fileLog('WARN', `handleMessage: Unknown action - ${action}`);
      return { status: 'error', error: 'Unknown action' };
  }
}

// ============================================
// Native Messaging 프로토콜 (stdin/stdout)
// ============================================

function readMessage() {
  return new Promise((resolve, reject) => {
    let headerBuf = Buffer.alloc(4);
    let headerBytes = 0;
    let msgBuf = null;
    let msgBytes = 0;

    const onData = (chunk) => {
      let offset = 0;

      while (offset < chunk.length && headerBytes < 4) {
        headerBuf[headerBytes++] = chunk[offset++];
      }
      if (headerBytes < 4) return;

      if (!msgBuf) {
        const length = headerBuf.readUInt32LE(0);
        if (length > 1024 * 1024) {
          process.stdin.removeListener('data', onData);
          return reject(new Error('메시지 너무 큼'));
        }
        msgBuf = Buffer.alloc(length);
      }

      while (offset < chunk.length && msgBytes < msgBuf.length) {
        msgBuf[msgBytes++] = chunk[offset++];
      }

      if (msgBytes === msgBuf.length) {
        process.stdin.removeListener('data', onData);
        try {
          resolve(JSON.parse(msgBuf.toString('utf8')));
        } catch {
          reject(new Error('잘못된 JSON'));
        }
      }
    };

    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}

function writeMessage(message) {
  const jsonBuffer = Buffer.from(JSON.stringify(message), 'utf8');
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32LE(jsonBuffer.length, 0);
  process.stdout.write(lengthBuffer);
  process.stdout.write(jsonBuffer);
}

async function main() {
  fileLog('INFO', `Native Messaging Host started - Node ${process.version}, platform=${process.platform}`);
  fileLog('INFO', `Log file: ${LOG_FILE}`);

  while (true) {
    try {
      const message = await readMessage();
      const response = await handleMessage(message);
      writeMessage(response);
    } catch (error) {
      fileLog('ERROR', `main loop error: ${error.message}`);
      writeMessage({ status: 'error', error: error.message });
    }
  }
}

if (require.main === module) {
  main();
} else {
  // 검증용(require로 불러올 때는 main 루프를 돌리지 않는다)
  module.exports = { normalizeProxy, buildProxyEnv, parseSsListener, isManagedListener, parseProxyEnviron, maskProxyValue, mapMntToWslPath, resolveWorkingDirectory };
}
