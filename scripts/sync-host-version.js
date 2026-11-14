// release-it after:bump에서 호출: node scripts/sync-host-version.js <이전 버전> <새 버전>
// 직전 릴리스 태그 이후 native host(native-host/, installer/)가 바뀌었으면
// lib/host-version.mjs의 MIN_HOST_VERSION을 새 버전으로 올린다. 안 바뀌었으면 그대로 둔다
// → 확장만 바뀐 릴리스에서는 사용자에게 host 재설치를 안내하지 않는다.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const [latest, next] = process.argv.slice(2);
if (!latest || !next) {
  console.error('usage: node scripts/sync-host-version.js <latestVersion> <version>');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'lib', 'host-version.mjs');
const HOST_PATHS = ['native-host', 'installer'];

const changed = execFileSync('git', ['diff', '--name-only', `v${latest}`, 'HEAD', '--', ...HOST_PATHS], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean);

if (changed.length === 0) {
  console.log(`[sync-host-version] host 변경 없음 (v${latest} 이후) - MIN_HOST_VERSION 유지`);
  process.exit(0);
}

const src = fs.readFileSync(FILE, 'utf8');
const re = /export const MIN_HOST_VERSION = '[^']*';/;
if (!re.test(src)) throw new Error('MIN_HOST_VERSION 선언을 찾지 못함');
fs.writeFileSync(FILE, src.replace(re, `export const MIN_HOST_VERSION = '${next}';`));
console.log(`[sync-host-version] host 변경 ${changed.length}개 → MIN_HOST_VERSION = ${next}\n  ${changed.join('\n  ')}`);
