import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const {
  mergeWindowsPath, parseRegistryPathOutput, windowsKnownOpenCodeDirs, withWindowsPath, windowsSpawnCommand, interpretWslResult, wslStdout, buildWslPath, wslSpawnArgs, earlyExitMessage,
} = createRequire(import.meta.url)('../native-host/host.js');

test('PATH 합치기: 빈 항목·대소문자/끝 역슬래시만 다른 중복 제거, 앞쪽 우선', () => {
  assert.equal(
    mergeWindowsPath('C:\\A;;C:\\b\\', 'c:\\a;C:\\B;C:\\C', ''),
    'C:\\A;C:\\b\\;C:\\C',
  );
});

test('PowerShell의 Machine/User PATH 두 줄(CRLF, User 비어 있음)을 하나로', () => {
  assert.equal(
    parseRegistryPathOutput('C:\\WINDOWS;C:\\Program Files\\nodejs\\\r\nC:\\Users\\홍 길동\\AppData\\Roaming\\npm;;\r\n'),
    'C:\\WINDOWS;C:\\Program Files\\nodejs\\;C:\\Users\\홍 길동\\AppData\\Roaming\\npm',
  );
  assert.equal(parseRegistryPathOutput('C:\\WINDOWS\r\n\r\n'), 'C:\\WINDOWS');
  assert.equal(parseRegistryPathOutput(''), '');
});

test('알려진 설치 폴더: npm/공식 스크립트/bun/scoop/pnpm/nvm/winget/choco', () => {
  const dirs = windowsKnownOpenCodeDirs({
    USERPROFILE: 'C:\\Users\\u',
    APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
    NVM_SYMLINK: 'C:\\nvm4w\\nodejs',
    ProgramData: 'C:\\ProgramData',
  });
  assert.deepEqual(dirs, [
    'C:\\Users\\u\\AppData\\Roaming\\npm',
    'C:\\Users\\u\\.opencode\\bin',
    'C:\\Users\\u\\.bun\\bin',
    'C:\\Users\\u\\scoop\\shims',
    'C:\\Users\\u\\AppData\\Local\\pnpm',
    'C:\\nvm4w\\nodejs',
    'C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links',
    'C:\\ProgramData\\chocolatey\\bin',
  ]);
});

test('SCOOP/PNPM_HOME이 있으면 그 위치를 쓰고, 없는 변수는 건너뛴다', () => {
  const dirs = windowsKnownOpenCodeDirs({ SCOOP: 'D:\\scoop', PNPM_HOME: 'D:\\pnpm' });
  assert.deepEqual(dirs, ['D:\\scoop\\shims', 'D:\\pnpm', 'C:\\ProgramData\\chocolatey\\bin']);
});

test('spawn env의 PATH는 대소문자 다른 키를 모두 지우고 하나만 둔다', () => {
  const env = withWindowsPath({ Path: 'old', PATH: 'old2', HTTP_PROXY: 'x' }, 'new');
  assert.deepEqual(env, { HTTP_PROXY: 'x', Path: 'new' });
});

test('.cmd/.bat은 셸로, 공백 경로가 깨지지 않게 따옴표로 감싼다. .exe는 그대로', () => {
  assert.deepEqual(
    windowsSpawnCommand('C:\\Users\\홍 길동\\AppData\\Roaming\\npm\\opencode.cmd'),
    { command: '"C:\\Users\\홍 길동\\AppData\\Roaming\\npm\\opencode.cmd"', shell: true },
  );
  assert.deepEqual(windowsSpawnCommand('C:\\x\\opencode.BAT').shell, true);
  assert.deepEqual(
    windowsSpawnCommand('C:\\Users\\u\\.bun\\bin\\opencode.exe'),
    { command: 'C:\\Users\\u\\.bun\\bin\\opencode.exe', shell: false },
  );
});

// wsl.exe 자신의 오류는 stdout에 UTF-16LE로, 종료 코드 0xFFFFFFFF로 나온다(실측).
const u16 = (s) => Buffer.from(s, 'utf16le');
const u8 = (s) => Buffer.from(s, 'utf8');

test('WSL: 리눅스 출력의 마지막 절대 경로를 찾음으로 본다', () => {
  const r = interpretWslResult({ status: 0, stdout: u8('nvm noise\n/home/u/.nvm/bin/opencode\n'), stderr: u8('') });
  assert.equal(r.kind, 'found');
  assert.equal(r.path, '/home/u/.nvm/bin/opencode');
});

test('WSL: 리눅스가 0이 아닌 코드로 "없음"이라 답하면 final(재시도 안 함)', () => {
  assert.equal(interpretWslResult({ status: 1, stdout: u8(''), stderr: u8('') }).kind, 'final');
});

test('WSL: 종료 코드 0인데 경로가 없으면 출력 유실로 보고 transient(WSL 초기화 지연 대비)', () => {
  assert.equal(interpretWslResult({ status: 0, stdout: u8(''), stderr: u8('') }).kind, 'transient');
});

test('WSL: 성공한 실행에 wsl.exe 안내문(UTF-16LE)이 앞에 붙어도 UTF-8 경로를 찾는다', () => {
  const r = interpretWslResult({
    status: 0,
    stdout: Buffer.concat([u16('wsl: notice\r\n'), u8('/home/u/bin/opencode\n')]),
    stderr: u16('wsl: another notice\r\n'),
  });
  assert.equal(r.kind, 'found');
  assert.equal(r.path, '/home/u/bin/opencode');
});

test('WSL: wsl.exe 오류(UTF-16LE stdout)를 경로로 오인하지 않는다', () => {
  const notFound = interpretWslResult({
    status: 4294967295,
    stdout: u16('제공된 이름의 배포가 없습니다.\r\n오류 코드: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n'),
    stderr: Buffer.alloc(0),
  });
  assert.equal(notFound.kind, 'no-wsl');
  assert.equal(notFound.path, null);
  assert.match(notFound.message, /WSL_E_DISTRO_NOT_FOUND/);

  const service = interpretWslResult({
    status: 4294967295,
    stdout: u16('Catastrophic failure\r\nError code: Wsl/Service/E_UNEXPECTED\r\n'),
    stderr: Buffer.alloc(0),
  });
  assert.equal(service.kind, 'transient');
  assert.equal(service.path, null);
});

test('WSL: wsl.exe 없음은 no-wsl, 시간 초과·실행 오류는 transient', () => {
  assert.equal(interpretWslResult({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) }).kind, 'no-wsl');
  assert.equal(interpretWslResult({ error: Object.assign(new Error('x'), { code: 'ETIMEDOUT' }), status: null }).kind, 'transient');
  assert.equal(interpretWslResult({ status: null, stdout: u8(''), stderr: u8('') }).kind, 'transient');
});

test('wslStdout: 정상 종료일 때만 stdout을 쓰고, wsl.exe 오류(-1)·실행 오류·비정상 종료는 빈 문자열', () => {
  assert.equal(wslStdout({ status: 0, stdout: '/home/u\n' }), '/home/u\n');
  // utf8로 읽은 wsl.exe 오류 메시지: 글자 사이에 NUL이 끼고 오류 코드에 숫자가 있다
  const garbage = 'E\u0000r\u0000r\u0000 \u00000\u0000x\u00008\u00000\u00000\u00007\u0000';
  assert.equal(wslStdout({ status: 4294967295, stdout: garbage }), '');
  assert.equal(wslStdout({ status: 1, stdout: '' }), '');
  assert.equal(wslStdout({ status: null, stdout: '123' }), '');
  assert.equal(wslStdout({ error: new Error('ENOENT'), status: null, stdout: '' }), '');
});

// nvm으로 설치한 opencode는 `#!/usr/bin/env node` 스크립트라, 탐색 셸의 PATH 없이 띄우면 exit 127로 죽는다.
test('WSL: 탐색 출력의 PATH= 줄을 실행용 PATH로 돌려준다(경로는 여전히 마지막 줄)', () => {
  const r = interpretWslResult({
    status: 0,
    stdout: u8('PATH=/home/u/.nvm/versions/node/v22/bin:/usr/bin:/bin\n/home/u/.nvm/versions/node/v22/bin/opencode\n'),
    stderr: u8(''),
  });
  assert.equal(r.kind, 'found');
  assert.equal(r.path, '/home/u/.nvm/versions/node/v22/bin/opencode');
  assert.equal(r.pathEnv, '/home/u/.nvm/versions/node/v22/bin:/usr/bin:/bin');
  // PATH 줄이 없으면(전략 1: 공식 바이너리) null
  assert.equal(interpretWslResult({ status: 0, stdout: u8('/home/u/.opencode/bin/opencode\n'), stderr: u8('') }).pathEnv, null);
});

test('WSL PATH: 실행 파일 폴더를 맨 앞에, 공백·특수문자 항목과 중복은 뺀다', () => {
  assert.equal(
    buildWslPath('/home/u/.nvm/v22/bin/opencode', '/usr/bin:/home/u/.nvm/v22/bin::/mnt/c/Program Files/x:/mnt/c/WINDOWS:/a$b:/usr/bin:relative'),
    '/home/u/.nvm/v22/bin:/usr/bin:/mnt/c/WINDOWS',
  );
});

test('WSL spawn 인자: PATH가 있으면 셸 없이 env로 주입, 없으면 예전 그대로', () => {
  assert.deepEqual(
    wslSpawnArgs({ path: '/home/u/.nvm/v22/bin/opencode', pathEnv: '/usr/bin:/bin' }, 4097),
    ['--exec', 'env', 'PATH=/home/u/.nvm/v22/bin:/usr/bin:/bin', '/home/u/.nvm/v22/bin/opencode', 'serve', '--port', '4097'],
  );
  assert.deepEqual(
    wslSpawnArgs({ path: '/home/u/.opencode/bin/opencode', pathEnv: null }, 4096),
    ['/home/u/.opencode/bin/opencode', 'serve', '--port', '4096'],
  );
});

test('시작 중 종료: 종료 코드와 출력 마지막 줄을 오류 문구에 담는다', () => {
  assert.equal(
    earlyExitMessage(127, null, "noise\n/usr/bin/env: 'node': No such file or directory\n\n"),
    "opencode 프로세스가 시작 중에 종료됨 (code=127): /usr/bin/env: 'node': No such file or directory",
  );
  assert.equal(earlyExitMessage(null, 'SIGKILL', ''), 'opencode 프로세스가 시작 중에 종료됨 (signal=SIGKILL)');
});
