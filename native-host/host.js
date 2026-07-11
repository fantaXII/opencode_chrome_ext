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
// opencode 경로 탐색 (Windows → WSL fallback)
// ============================================

async function findOpenCodePath() {
  const diagnostic = {
    windowsPath: { checked: true, found: false, error: null },
    wsl: { checked: false, found: false, strategies: [] }
  };

  fileLog('DEBUG', 'findOpenCodePath: Starting path detection...');

  // 1순위: Windows PATH
  try {
    fileLog('DEBUG', 'findOpenCodePath: Trying Windows PATH...');
    const windowsPath = require('which').sync('opencode');
    diagnostic.windowsPath.found = true;
    fileLog('INFO', `findOpenCodePath: Found in Windows PATH: ${windowsPath}`);
    return { path: windowsPath, isWSL: false, diagnostic };
  } catch (error) {
    diagnostic.windowsPath.error = error.message;
    fileLog('WARN', `findOpenCodePath: Not in Windows PATH - ${error.message}`);
  }

  // 2순위: WSL (최대 3회 재시도, 3가지 전략)
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

  fileLog('ERROR', 'findOpenCodePath: Not found in Windows PATH or WSL after all attempts');
  return { path: null, isWSL: false, diagnostic };
}

// ============================================
// OpenCode 서버 기동
// ============================================

async function startOpenCodeServer(preferredPort = 4096) {
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

    const found = await findOpenCodePath();

    if (!found.path) {
      const err = new Error('opencode를 찾을 수 없음 (Windows/WSL 모두 확인)');
      err.diagnostic = found.diagnostic;
      throw err;
    }

    isWSL = found.isWSL;

    if (isWSL) {
      fileLog('INFO', `startOpenCodeServer: Spawning via WSL: wsl.exe ${found.path} serve --port ${port}`);
      opencodeProcess = spawn('wsl.exe', [found.path, 'serve', '--port', port.toString()], {
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } else {
      fileLog('INFO', `startOpenCodeServer: Spawning on Windows: ${found.path} serve --port ${port}`);
      const isCmd = /\.(cmd|bat)$/i.test(found.path);
      opencodeProcess = spawn(found.path, ['serve', '--port', port.toString()], {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: isCmd
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

function stopOpenCodeServer() {
  if (opencodeProcess) {
    fileLog('INFO', `stopOpenCodeServer: Stopping, isWSL=${isWSL}`);
    opencodeProcess.kill();
    opencodeProcess = null;

    if (isWSL) {
      try {
        execSync('wsl.exe pkill -f "opencode serve"', { encoding: 'utf8' });
        fileLog('INFO', 'stopOpenCodeServer: WSL opencode process killed');
      } catch (error) {
        fileLog('DEBUG', `stopOpenCodeServer: pkill (may already be dead): ${error.message}`);
      }
    }

    isWSL = false;
  }
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
// 메시지 핸들러
// ============================================

async function handleMessage(message) {
  const { action, preferredPort } = message;
  fileLog('INFO', `handleMessage: action=${action}`);

  switch (action) {
    case 'start':
      try {
        const port = await startOpenCodeServer(preferredPort || 4096);
        fileLog('INFO', `handleMessage: start success, port=${port}, isWSL=${isWSL}`);
        return { status: 'success', port, isWSL };
      } catch (error) {
        fileLog('ERROR', `handleMessage: start failed - ${error.message}`);
        return { status: 'error', error: error.message, diagnostic: error.diagnostic || null };
      }

    case 'stop':
      stopOpenCodeServer();
      return { status: 'success' };

    case 'status': {
      const available = await checkOpenCodeServer(currentPort);
      return { status: 'success', running: available, port: currentPort };
    }

    case 'check-port': {
      const portAvailable = await findAvailablePort(preferredPort || 4096);
      return { port: portAvailable };
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

main();
