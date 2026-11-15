// 페이지 말풍선의 빠른 실행 버튼 목록 (chrome.storage.local.quickActions).
// 순수 함수 모듈 — chrome API / DOM 의존 없음. background.js가 저장·검증에 쓰고 test/quick-actions.test.mjs가 검사한다.
//
// 항목 형식 (배열 순서 = 표시 순서)
//  - 기본 버튼: { id: 'summary'|'keypoints'|'translate', builtin: true, enabled }
//      문구·프롬프트는 저장하지 않고 사이드패널이 UI 언어에 맞춰 붙인다. 삭제할 수 없고 끄기만 한다.
//  - 사용자 버튼: { id, label, prompt, sites: string[], readPage: boolean }
//      sites가 비어 있으면 모든 사이트, 아니면 호스트명이 맞는 사이트에서만 보인다.
//      readPage면 누를 때 브라우저에 열린 본문을 읽어 함께 보낸다(그 한 번만, 전역 pageContext 설정과 무관).

export const BUILTIN_QUICK_ACTION_IDS = ['summary', 'keypoints', 'translate'];
export const QUICK_ACTION_LIMITS = { label: 30, prompt: 2000, max: 30, sites: 10 };

export function defaultQuickActions() {
  return BUILTIN_QUICK_ACTION_IDS.map((id) => ({ id, builtin: true, enabled: true }));
}

/** http(s) 페이지의 호스트명(소문자). 그 외(chrome://, 새 탭, 잘못된 URL)는 ''. */
export function hostnameOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase() : '';
  } catch {
    return '';
  }
}

const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * 사이트 조건 하나를 정규화한다. 'example.com', '*.example.com', URL('https://a.example.com/x')을 받는다.
 * 잘못된 값은 null.
 */
export function normalizeSitePattern(value) {
  if (typeof value !== 'string') return null;
  let s = value.trim().toLowerCase();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    s = hostnameOf(s);
    if (!s) return null;
  }
  s = s.replace(/\.$/, '');
  const wildcard = s.startsWith('*.');
  const host = wildcard ? s.slice(2) : s;
  if (!HOST_RE.test(host)) return null;
  return wildcard ? `*.${host}` : host;
}

/** 'example.com'은 그 호스트만, '*.example.com'은 example.com과 그 하위 도메인 전부. */
export function siteMatches(pattern, hostname) {
  if (!pattern || !hostname) return false;
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2);
    return hostname === base || hostname.endsWith(`.${base}`);
  }
  return hostname === pattern;
}

/** 이 페이지(호스트명)의 말풍선에 보이는가. 꺼진 기본 버튼은 보이지 않는다. */
export function isQuickActionVisible(action, hostname) {
  if (!action || !hostname) return false;
  if (action.builtin) return action.enabled !== false;
  if (!action.sites || action.sites.length === 0) return true;
  return action.sites.some((p) => siteMatches(p, hostname));
}

/**
 * 사용자 입력(추가·편집 폼)을 검증한다.
 * @returns {{ok:true, value:{label,prompt,sites,readPage}} | {ok:false, error:string}}
 *   error는 사이드패널이 t()로 번역하는 한국어 문구다.
 */
export function validateQuickActionInput(input) {
  const label = typeof input?.label === 'string' ? input.label.trim() : '';
  const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : '';
  if (!label) return { ok: false, error: '버튼 이름을 입력하세요.' };
  if ([...label].length > QUICK_ACTION_LIMITS.label) return { ok: false, error: '버튼 이름이 너무 깁니다.' };
  if (!prompt) return { ok: false, error: '프롬프트를 입력하세요.' };
  if (prompt.length > QUICK_ACTION_LIMITS.prompt) return { ok: false, error: '프롬프트가 너무 깁니다.' };
  const rawSites = Array.isArray(input?.sites) ? input.sites : [];
  const sites = [];
  for (const s of rawSites) {
    const p = normalizeSitePattern(s);
    if (!p) return { ok: false, error: '사이트 형식이 올바르지 않습니다.' };
    if (!sites.includes(p)) sites.push(p);
  }
  if (sites.length > QUICK_ACTION_LIMITS.sites) return { ok: false, error: '사이트가 너무 많습니다.' };
  return { ok: true, value: { label, prompt, sites, readPage: input?.readPage !== false } };
}

/**
 * 저장된 값을 읽을 때 정리한다: 잘못된 항목·중복 id는 버리고, 빠진 기본 버튼은 앞쪽에 채우고, 최대 개수로 자른다.
 * 저장된 적이 없으면(undefined) 기본 목록.
 */
export function normalizeQuickActions(raw) {
  if (!Array.isArray(raw)) return defaultQuickActions();
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || seen.has(item.id)) continue;
    if (BUILTIN_QUICK_ACTION_IDS.includes(item.id)) {
      out.push({ id: item.id, builtin: true, enabled: item.enabled !== false });
      seen.add(item.id);
      continue;
    }
    if (item.builtin) continue; // 모르는 기본 버튼(이후 버전에서 없어진 것 등)
    const v = validateQuickActionInput(item);
    if (!v.ok) continue;
    out.push({ id: item.id, ...v.value });
    seen.add(item.id);
  }
  const missing = BUILTIN_QUICK_ACTION_IDS.filter((id) => !seen.has(id))
    .map((id) => ({ id, builtin: true, enabled: true }));
  const builtins = out.filter((a) => a.builtin).length + missing.length;
  return [...missing, ...out].slice(0, QUICK_ACTION_LIMITS.max + builtins);
}

/**
 * 사용자 버튼을 추가하거나(id가 없거나 목록에 없으면) 고친다.
 * @returns {{ok:true, list, action} | {ok:false, error}}
 */
export function upsertQuickAction(list, input, { now = Date.now() } = {}) {
  const v = validateQuickActionInput(input);
  if (!v.ok) return v;
  const idx = typeof input.id === 'string' ? list.findIndex((a) => a.id === input.id) : -1;
  if (idx !== -1) {
    if (list[idx].builtin) return { ok: false, error: '기본 버튼은 고칠 수 없습니다.' };
    const action = { id: list[idx].id, ...v.value };
    const next = list.slice();
    next[idx] = action;
    return { ok: true, list: next, action };
  }
  if (list.filter((a) => !a.builtin).length >= QUICK_ACTION_LIMITS.max) {
    return { ok: false, error: '버튼은 최대 {max}개까지 만들 수 있습니다.', params: { max: QUICK_ACTION_LIMITS.max } };
  }
  let id = `qa_${now}`;
  for (let n = 1; list.some((a) => a.id === id); n++) id = `qa_${now}_${n}`;
  const action = { id, ...v.value };
  return { ok: true, list: [...list, action], action };
}

/** 사용자 버튼을 지운다. 기본 버튼은 지우지 않는다(끄기만). */
export function removeQuickAction(list, id) {
  return list.filter((a) => a.id !== id || a.builtin);
}

export function setQuickActionEnabled(list, id, enabled) {
  return list.map((a) => (a.id === id && a.builtin ? { ...a, enabled: !!enabled } : a));
}

/** 꺼 둔 기본 버튼을 모두 다시 켠다. */
export function enableAllBuiltins(list) {
  return list.map((a) => (a.builtin ? { ...a, enabled: true } : a));
}

/**
 * 이 페이지에서 보이는 버튼 기준으로 한 칸 옮긴다(dir: -1 앞으로, 1 뒤로).
 * 다른 사이트 전용이라 지금 안 보이는 버튼과 자리를 바꾸면 화면에서 아무 변화가 없으므로, 보이는 이웃과 바꾼다.
 */
export function moveQuickAction(list, id, dir, hostname) {
  const from = list.findIndex((a) => a.id === id);
  if (from === -1 || (dir !== -1 && dir !== 1)) return list;
  let to = from + dir;
  while (to >= 0 && to < list.length && !isQuickActionVisible(list[to], hostname)) to += dir;
  if (to < 0 || to >= list.length) return list;
  const next = list.slice();
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}
