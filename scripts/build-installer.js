const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function calcExtensionId(base64Key) {
  const der = Buffer.from(base64Key.trim(), 'base64');
  const hash = crypto.createHash('sha256').update(der).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (hash[i] >> 4));
    id += String.fromCharCode(97 + (hash[i] & 0xf));
  }
  return id;
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const { version } = manifest;

let extensionId = pkg.extensionId;
if (extensionId) {
  console.log('Extension ID source: package.json');
} else if (manifest.key) {
  extensionId = calcExtensionId(manifest.key);
  console.log('Extension ID source: manifest.json key (계산값)');
} else {
  console.error('ERROR: package.json에 extensionId가 없고 manifest.json에 key도 없습니다.');
  console.error('       package.json에 "extensionId": "<실제 Extension ID>" 를 추가하세요.');
  process.exit(1);
}
console.log(`Version      : ${version}`);
console.log(`Extension ID : ${extensionId}`);

// yarn v1은 자기 설정을 npm_config_* 환경변수로 자식 프로세스에 넘기는데, 이 중 npm이 모르는
// 이름이 있어 npm이 "Unknown env config" 경고를 낸다. yarn 전용 변수만 걸러서 npm에 넘긴다.
// (사용자가 환경변수로 준 registry/proxy 같은 유효한 npm_config_*는 그대로 유지한다.)
const YARN_ONLY_NPM_CONFIG = new Set([
  'npm_config_argv',
  'npm_config_ignore_path',
  'npm_config_version_tag_prefix',
  'npm_config_version_git_tag',
  'npm_config_version_git_sign',
  'npm_config_version_git_message',
  'npm_config_version_commit_hooks'
]);
const npmEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !YARN_ONLY_NPM_CONFIG.has(key.toLowerCase()))
);

// native-host node_modules 준비 (번들용)
console.log('\nnative-host npm install...');
execSync('npm install', { cwd: path.join(ROOT, 'native-host'), stdio: 'inherit', env: npmEnv });

// makensis 가용성 확인
try {
  execSync('makensis -VERSION', { stdio: 'pipe' });
} catch {
  console.error('\nERROR: makensis를 찾을 수 없습니다.');
  console.error('       sudo apt-get install nsis');
  process.exit(1);
}

const outExe = path.join(ROOT, `opencode-native-host-setup-v${version}.exe`);
const nsiScript = path.join(ROOT, 'installer', 'installer.nsi');

const args = [
  'makensis',
  `-DEXTENSION_ID=${extensionId}`,
  `-DAPP_VERSION=${version}`,
  `-DOUT_FILE=${outExe}`,
];

const privateConfigPath = path.resolve(ROOT, 'config.private.json');
if (fs.existsSync(privateConfigPath)) {
  console.log('[build] config.private.json found — will be bundled in installer');
  args.push(`-DHAS_PRIVATE_CONFIG=1`);
  args.push(`"-DPRIVATE_CONFIG_PATH=${privateConfigPath}"`);
} else {
  console.log('[build] config.private.json not found — MCP/proxy config will be skipped at install time');
}

args.push(`"${nsiScript}"`);
const cmd = args.join(' ');

console.log(`\n${cmd}\n`);
execSync(cmd, { stdio: 'inherit', cwd: ROOT });
console.log(`\nInstaller: ${outExe}`);
