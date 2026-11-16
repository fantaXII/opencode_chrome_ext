// 실행: node --test test/quick-actions.test.mjs
// 페이지 말풍선 빠른 실행 버튼 목록(lib/quick-actions.mjs)의 검증·사이트 매칭·정렬.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_QUICK_ACTION_IDS, QUICK_ACTION_LIMITS, defaultQuickActions, hostnameOf, normalizeSitePattern, siteMatches,
  isQuickActionVisible, validateQuickActionInput, normalizeQuickActions, upsertQuickAction, removeQuickAction,
  setQuickActionEnabled, enableAllBuiltins, moveQuickAction,
  QUICK_ACTIONS_EXPORT_TYPE, exportQuickActions, parseQuickActionsFile, mergeQuickActions
} from '../lib/quick-actions.mjs';

const user = (id, extra = {}) => ({ id, label: id, prompt: `p-${id}`, sites: [], readPage: true, ...extra });

test('hostnameOf: http(s)만 호스트명, 그 외는 빈 문자열', () => {
  assert.equal(hostnameOf('https://GitHub.com/a/b?x=1'), 'github.com');
  assert.equal(hostnameOf('http://localhost:3000/'), 'localhost');
  assert.equal(hostnameOf('chrome://extensions'), '');
  assert.equal(hostnameOf('chrome-extension://abc/x.html'), '');
  assert.equal(hostnameOf('not a url'), '');
  assert.equal(hostnameOf(''), '');
});

test('normalizeSitePattern: 호스트·와일드카드·URL을 받고 잘못된 값은 null', () => {
  assert.equal(normalizeSitePattern(' GitHub.com '), 'github.com');
  assert.equal(normalizeSitePattern('*.Company.com'), '*.company.com');
  assert.equal(normalizeSitePattern('https://wiki.company.com/page'), 'wiki.company.com');
  assert.equal(normalizeSitePattern('example.com.'), 'example.com');
  for (const bad of ['', '   ', 'a b.com', '*', '*.', 'http://', 'chrome://extensions', '-bad.com', 'x..com', 42, null]) {
    assert.equal(normalizeSitePattern(bad), null, String(bad));
  }
});

test('siteMatches: 정확히 일치 또는 *.도메인은 그 도메인과 하위 도메인', () => {
  assert.ok(siteMatches('github.com', 'github.com'));
  assert.ok(!siteMatches('github.com', 'gist.github.com'));
  assert.ok(siteMatches('*.company.com', 'company.com'));
  assert.ok(siteMatches('*.company.com', 'wiki.company.com'));
  assert.ok(siteMatches('*.company.com', 'a.b.company.com'));
  assert.ok(!siteMatches('*.company.com', 'evilcompany.com'), '접미사만 같은 다른 도메인은 아니다');
  assert.ok(!siteMatches('github.com', ''));
});

test('isQuickActionVisible: 꺼진 기본 버튼은 숨기고, sites가 있으면 맞는 사이트에서만', () => {
  assert.ok(isQuickActionVisible({ id: 'summary', builtin: true, enabled: true }, 'a.com'));
  assert.ok(!isQuickActionVisible({ id: 'summary', builtin: true, enabled: false }, 'a.com'));
  assert.ok(isQuickActionVisible(user('x'), 'a.com'));
  assert.ok(isQuickActionVisible(user('x', { sites: ['github.com'] }), 'github.com'));
  assert.ok(!isQuickActionVisible(user('x', { sites: ['github.com'] }), 'gitlab.com'));
  assert.ok(!isQuickActionVisible(user('x'), ''), 'http(s)가 아닌 페이지에는 보이지 않는다');
});

test('validateQuickActionInput: 이름·프롬프트 필수, 길이 제한, 사이트 정규화, readPage 기본 true', () => {
  const ok = validateQuickActionInput({ label: ' 리뷰 ', prompt: ' 요약해 ', sites: ['GitHub.com', 'github.com'] });
  assert.deepEqual(ok, { ok: true, value: { label: '리뷰', prompt: '요약해', sites: ['github.com'], readPage: true } });
  assert.equal(validateQuickActionInput({ label: 'a', prompt: 'b', readPage: false }).value.readPage, false);
  assert.equal(validateQuickActionInput({ label: '', prompt: 'b' }).error, '버튼 이름을 입력하세요.');
  assert.equal(validateQuickActionInput({ label: 'a', prompt: '  ' }).error, '프롬프트를 입력하세요.');
  assert.equal(validateQuickActionInput({ label: 'x'.repeat(QUICK_ACTION_LIMITS.label + 1), prompt: 'b' }).error, '버튼 이름이 너무 깁니다.');
  // 이모지는 한 글자로 센다(서로게이트 쌍)
  assert.ok(validateQuickActionInput({ label: '🔍'.repeat(QUICK_ACTION_LIMITS.label), prompt: 'b' }).ok);
  assert.equal(validateQuickActionInput({ label: 'a', prompt: 'x'.repeat(QUICK_ACTION_LIMITS.prompt + 1) }).error, '프롬프트가 너무 깁니다.');
  assert.equal(validateQuickActionInput({ label: 'a', prompt: 'b', sites: ['not a host'] }).error, '사이트 형식이 올바르지 않습니다.');
});

test('normalizeQuickActions: 저장된 적 없으면 기본 3개, 잘못된 항목·중복은 버리고 빠진 기본 버튼은 채운다', () => {
  assert.deepEqual(normalizeQuickActions(undefined), defaultQuickActions());
  assert.deepEqual(defaultQuickActions().map((a) => a.id), BUILTIN_QUICK_ACTION_IDS);
  const list = normalizeQuickActions([
    user('u1'),
    { id: 'keypoints', builtin: true, enabled: false },
    { id: 'u1', label: 'dup', prompt: 'dup' },          // 중복 id
    { id: 'u2', label: '', prompt: 'x' },               // 잘못된 항목
    { id: 'gone', builtin: true, enabled: true },       // 모르는 기본 버튼
    null, 'x',
    user('u3', { sites: ['*.company.com'] })
  ]);
  assert.deepEqual(list.map((a) => a.id), ['summary', 'translate', 'u1', 'keypoints', 'u3']);
  assert.equal(list.find((a) => a.id === 'keypoints').enabled, false, '끈 상태는 유지');
  assert.equal(list.find((a) => a.id === 'u1').label, 'u1');
});

test('upsertQuickAction: 새 버튼은 끝에 붙고 id를 받으며, 기존 버튼은 그 자리에서 고친다', () => {
  let list = defaultQuickActions();
  const r1 = upsertQuickAction(list, { label: '리뷰', prompt: '요약', sites: ['github.com'] }, { now: 1000 });
  assert.ok(r1.ok);
  assert.equal(r1.action.id, 'qa_1000');
  list = r1.list;
  const r2 = upsertQuickAction(list, { label: '또', prompt: '다른' }, { now: 1000 });
  assert.equal(r2.action.id, 'qa_1000_1', '같은 시각에 만들어도 id가 겹치지 않는다');
  list = r2.list;
  const r3 = upsertQuickAction(list, { id: 'qa_1000', label: '리뷰2', prompt: '요약2', sites: [] });
  assert.ok(r3.ok);
  assert.deepEqual(r3.list.map((a) => a.id), ['summary', 'keypoints', 'translate', 'qa_1000', 'qa_1000_1']);
  assert.equal(r3.list[3].label, '리뷰2');
  assert.deepEqual(r3.list[3].sites, []);
  assert.equal(upsertQuickAction(list, { id: 'summary', label: 'x', prompt: 'y' }).error, '기본 버튼은 고칠 수 없습니다.');
  assert.equal(upsertQuickAction(list, { label: '', prompt: 'y' }).ok, false);
});

test('upsertQuickAction: 사용자 버튼은 최대 개수까지만', () => {
  let list = defaultQuickActions();
  for (let i = 0; i < QUICK_ACTION_LIMITS.max; i++) list = upsertQuickAction(list, { label: `b${i}`, prompt: 'p' }, { now: i }).list;
  const over = upsertQuickAction(list, { label: 'over', prompt: 'p' }, { now: 999 });
  assert.equal(over.ok, false);
  assert.deepEqual(over.params, { max: QUICK_ACTION_LIMITS.max });
  // 다시 읽어도 잘리지 않는다(기본 3개 + 사용자 max개)
  assert.equal(normalizeQuickActions(list).length, QUICK_ACTION_LIMITS.max + BUILTIN_QUICK_ACTION_IDS.length);
});

test('removeQuickAction은 기본 버튼을 지우지 않고, 숨김/다시 표시는 기본 버튼에만', () => {
  const list = [...defaultQuickActions(), user('u1')];
  assert.deepEqual(removeQuickAction(list, 'u1').map((a) => a.id), BUILTIN_QUICK_ACTION_IDS);
  assert.deepEqual(removeQuickAction(list, 'summary').map((a) => a.id), list.map((a) => a.id));
  const hidden = setQuickActionEnabled(list, 'summary', false);
  assert.equal(hidden[0].enabled, false);
  assert.deepEqual(setQuickActionEnabled(list, 'u1', false)[3], list[3], '사용자 버튼에는 enabled가 없다');
  assert.ok(enableAllBuiltins(hidden).filter((a) => a.builtin).every((a) => a.enabled));
});

test('moveQuickAction: 이 페이지에서 보이는 이웃과 자리를 바꾼다', () => {
  const list = [
    { id: 'summary', builtin: true, enabled: true },
    user('gh', { sites: ['github.com'] }),          // a.com에서는 안 보임
    { id: 'keypoints', builtin: true, enabled: false }, // 꺼짐
    user('all')
  ];
  // a.com에서 'all'을 앞으로 → 보이지 않는 두 항목을 건너뛰고 summary와 바꾼다
  assert.deepEqual(moveQuickAction(list, 'all', -1, 'a.com').map((a) => a.id), ['all', 'gh', 'keypoints', 'summary']);
  // github.com에서는 gh가 보이므로 gh와 바꾼다
  assert.deepEqual(moveQuickAction(list, 'all', -1, 'github.com').map((a) => a.id), ['summary', 'all', 'keypoints', 'gh']);
  // 끝에서 더 갈 곳이 없으면 그대로
  assert.equal(moveQuickAction(list, 'all', 1, 'a.com'), list);
  assert.equal(moveQuickAction(list, 'summary', -1, 'a.com'), list);
  assert.equal(moveQuickAction(list, 'nope', 1, 'a.com'), list);
  assert.equal(moveQuickAction(list, 'all', 2, 'a.com'), list);
});

test('exportQuickActions: 사용자 버튼만, id 없이 내보낸다', () => {
  const list = [...defaultQuickActions(), user('qa_1', { sites: ['github.com'], readPage: false })];
  const data = exportQuickActions(list, new Date('2026-01-01T00:00:00Z'));
  assert.equal(data.type, QUICK_ACTIONS_EXPORT_TYPE);
  assert.equal(data.exportedAt, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(data.quickActions, [{ label: 'qa_1', prompt: 'p-qa_1', sites: ['github.com'], readPage: false }]);
});

test('parseQuickActionsFile: 내보낸 형식·배열을 받고, 그 외는 throw', () => {
  assert.deepEqual(parseQuickActionsFile('{"quickActions":[{"label":"a"}]}'), [{ label: 'a' }]);
  assert.deepEqual(parseQuickActionsFile('[1]'), [1]);
  assert.throws(() => parseQuickActionsFile('{"favorites":[]}'));
  assert.throws(() => parseQuickActionsFile('not json'));
});

test('mergeQuickActions: 내보낸 파일을 다시 가져오면 왕복되고, 같은 버튼은 건너뛴다', () => {
  const src = [...defaultQuickActions(), user('qa_1', { sites: ['*.example.com'] }), user('qa_2')];
  const file = JSON.stringify(exportQuickActions(src));
  // 빈 목록(새 PC)에 가져오기
  const fresh = mergeQuickActions(defaultQuickActions(), parseQuickActionsFile(file), { now: 5 });
  assert.equal(fresh.added, 2);
  assert.equal(fresh.skipped, 0);
  assert.deepEqual(exportQuickActions(fresh.list).quickActions, exportQuickActions(src).quickActions);
  assert.deepEqual(fresh.list.filter((a) => !a.builtin).map((a) => a.id), ['qa_5', 'qa_5_1']);
  // 같은 파일을 다시 가져오면 아무것도 추가되지 않는다
  const again = mergeQuickActions(fresh.list, parseQuickActionsFile(file), { now: 6 });
  assert.equal(again.added, 0);
  assert.equal(again.skipped, 2);
  assert.deepEqual(again.list, fresh.list);
});

test('mergeQuickActions: 기존 순서·숨김은 유지, 잘못된 항목·기본 버튼·최대 초과는 건너뛴다', () => {
  const base = setQuickActionEnabled([...defaultQuickActions(), user('mine')], 'translate', false);
  const incoming = [
    { builtin: true, id: 'summary' }, null, 'x', { label: '', prompt: 'p' }, { label: 'L', prompt: 'p', sites: ['bad host!'] },
    { label: 'ok', prompt: 'do it', sites: ['https://A.example.com/path'] },
    { id: 'mine', label: 'other', prompt: 'p2' } // 파일의 id는 무시하고 새 버튼으로 추가
  ];
  const res = mergeQuickActions(base, incoming, { now: 1 });
  assert.equal(res.added, 2);
  assert.equal(res.skipped, 5);
  assert.deepEqual(res.list.slice(0, 4), base);
  assert.deepEqual(res.list[4], { id: 'qa_1', label: 'ok', prompt: 'do it', sites: ['a.example.com'], readPage: true });
  assert.equal(res.list[5].label, 'other');
  assert.notEqual(res.list[5].id, 'mine');

  const many = Array.from({ length: QUICK_ACTION_LIMITS.max + 3 }, (_, i) => ({ label: `b${i}`, prompt: 'p' }));
  const full = mergeQuickActions(defaultQuickActions(), many, { now: 2 });
  assert.equal(full.added, QUICK_ACTION_LIMITS.max);
  assert.equal(full.skipped, 3);
});
