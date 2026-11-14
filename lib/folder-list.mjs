// 작업 폴더 즐겨찾기·최근 목록 (순수 함수 — 테스트 대상).
//
// - 최근 폴더는 따로 저장하지 않고 서버 세션 기록(session.directory, time.updated)에서 만든다.
//   TUI에서 작업한 폴더도 보이고, 확장을 업데이트·재설치해도 사라지지 않는다.
// - 세션이 아직 없는 폴더(골랐지만 대화하지 않음)는 확장이 기록한 recent로 보충한다.
// - 즐겨찾기·숨김·recent는 chrome.storage.local에 둔다(확장 업데이트로는 지워지지 않고 삭제할 때만 지워진다).

/** 경로 비교용 키: 구분자 통일, 끝 슬래시 제거, 드라이브 경로는 대소문자 무시. */
export function folderKey(p) {
  const v = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:/.test(v) ? v.toLowerCase() : v;
}

/** 경로가 서버 실행 환경에서 쓸 수 있는 형식인지. runtime을 모르면 모두 허용. */
export function pathMatchesRuntime(p, runtime) {
  if (runtime === 'wsl') return String(p).startsWith('/');
  if (runtime === 'windows') return /^[A-Za-z]:[\\/]|^\\\\/.test(String(p));
  return true;
}

export const RECENT_LIMIT = 20;

/**
 * @param {object} o
 * @param {Array<{directory?:string, time?:{updated?:number,created?:number}, parentID?:string}>} o.sessions 서버 세션 목록
 * @param {Array<{path:string, usedAt:number}>} o.recent 확장이 기록한 최근 폴더
 * @param {Array<{path:string, name?:string, addedAt?:number}>} o.favorites
 * @param {string[]} o.hidden 최근 목록에서 숨긴 폴더
 * @param {'wsl'|'windows'|null} o.runtime
 * @param {number} [o.limit]
 * @returns {{favorites: Array<{path,name,lastUsed,sessions,available}>, recent: Array<{path,lastUsed,sessions}>}}
 */
export function buildFolderList({ sessions = [], recent = [], favorites = [], hidden = [], runtime = null, limit = 15 }) {
  const stats = new Map(); // key -> { path, lastUsed, sessions }
  const touch = (path, at, countSession) => {
    if (!path) return;
    const key = folderKey(path);
    const s = stats.get(key) || { path, lastUsed: 0, sessions: 0 };
    if (at > s.lastUsed) { s.lastUsed = at; s.path = path; }
    if (countSession) s.sessions += 1;
    stats.set(key, s);
  };
  for (const s of sessions) {
    if (!s || s.parentID) continue; // 하위 에이전트 세션은 부모와 같은 폴더
    touch(s.directory, s.time?.updated || s.time?.created || 0, true);
  }
  for (const r of recent) touch(r.path, r.usedAt || 0, false);

  const hiddenKeys = new Set(hidden.map(folderKey));
  const favKeys = new Set(favorites.map(f => folderKey(f.path)));

  const favs = favorites.map(f => {
    const s = stats.get(folderKey(f.path));
    return {
      path: f.path,
      name: f.name || '',
      lastUsed: s?.lastUsed || 0,
      sessions: s?.sessions || 0,
      // 다른 실행 환경(WSL ↔ Windows) 경로는 지금 서버에서 쓸 수 없다. 지우지 않고 흐리게 보여준다.
      available: pathMatchesRuntime(f.path, runtime)
    };
  });

  const rec = [...stats.entries()]
    .filter(([key, s]) => !favKeys.has(key) && !hiddenKeys.has(key) && pathMatchesRuntime(s.path, runtime))
    .map(([, s]) => s)
    .sort((a, b) => b.lastUsed - a.lastUsed)
    .slice(0, limit);

  return { favorites: favs, recent: rec };
}

/** recent 목록 맨 앞에 path를 넣는다(중복 제거, RECENT_LIMIT개 유지). */
export function pushRecent(recent, path, now = Date.now()) {
  const key = folderKey(path);
  return [{ path, usedAt: now }, ...(recent || []).filter(r => folderKey(r.path) !== key)].slice(0, RECENT_LIMIT);
}

export const FAVORITES_EXPORT_TYPE = 'opencode-chrome-ext/folder-favorites';
export const FAVORITES_LIMIT = 200;

/**
 * 가져온 즐겨찾기를 기존 목록에 합친다. 내보낸 형식({type, favorites})이 아니어도
 * 경로 문자열 배열이나 {path, name} 배열이면 받는다. 이미 있는 폴더는 순서와 이름을 유지하되,
 * 기존 이름이 비어 있으면 가져온 이름을 쓴다. 잘못된 항목은 건너뛴다.
 * @returns {{merged: Array<{path,name,addedAt}>, added: number}}
 */
export function mergeFavorites(existing, incoming, now = Date.now()) {
  const merged = (existing || []).map(f => ({ ...f }));
  const index = new Map(merged.map((f, i) => [folderKey(f.path), i]));
  let added = 0;
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    const path = typeof raw === 'string' ? raw : raw?.path;
    if (typeof path !== 'string') continue;
    const p = path.trim();
    if (!p || p.length > 1024 || /[\u0000-\u001f]/.test(p)) continue;
    const name = typeof raw?.name === 'string' ? raw.name.trim().slice(0, 60) : '';
    const key = folderKey(p);
    if (index.has(key)) {
      const f = merged[index.get(key)];
      if (!f.name && name) f.name = name;
      continue;
    }
    if (merged.length >= FAVORITES_LIMIT) break;
    index.set(key, merged.length);
    merged.push({ path: p, name, addedAt: now });
    added += 1;
  }
  return { merged, added };
}

/** 가져오기 파일 내용(JSON 텍스트) → 항목 배열. 형식이 틀리면 throw. */
export function parseFavoritesFile(text) {
  const data = JSON.parse(text);
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.favorites)) return data.favorites;
  throw new Error('invalid-format');
}
