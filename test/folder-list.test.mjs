// 실행: node --test test/folder-list.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFolderList, pushRecent, folderKey, pathMatchesRuntime, RECENT_LIMIT } from '../lib/folder-list.mjs';
import { startMockOpencode } from './helpers/mock-opencode.mjs';
import { loadBackground } from './helpers/background-harness.mjs';

const ses = (directory, updated, extra = {}) => ({ id: `s${updated}`, directory, time: { updated }, ...extra });

test('최근 폴더는 서버 세션 기록을 폴더별로 묶어 최근 순으로 만든다(하위 에이전트 세션 제외)', () => {
  const { recent } = buildFolderList({
    sessions: [ses('/a', 10), ses('/b', 30), ses('/a', 20), ses('/c', 99, { parentID: 'x' })],
    runtime: 'wsl'
  });
  assert.deepEqual(recent.map(r => [r.path, r.lastUsed, r.sessions]), [['/b', 30, 1], ['/a', 20, 2]]);
});

test('세션이 없는 폴더는 확장이 기록한 recent로 보충하고, 즐겨찾기·숨김은 최근에서 빠진다', () => {
  const { favorites, recent } = buildFolderList({
    sessions: [ses('/a', 10), ses('/b/', 20)],
    recent: [{ path: '/new', usedAt: 50 }],
    favorites: [{ path: '/b', name: 'B' }],
    hidden: ['/a'],
    runtime: 'wsl'
  });
  assert.deepEqual(recent.map(r => r.path), ['/new']);
  assert.deepEqual(favorites, [{ path: '/b', name: 'B', lastUsed: 20, sessions: 1, available: true }]);
});

test('서버 실행 환경과 다른 형식의 경로: 최근에서는 빼고, 즐겨찾기는 남기되 사용 불가로 표시', () => {
  const { favorites, recent } = buildFolderList({
    sessions: [ses('C:\\work', 10), ses('/home/u', 5)],
    favorites: [{ path: 'C:\\work' }],
    runtime: 'wsl'
  });
  assert.deepEqual(recent.map(r => r.path), ['/home/u']);
  assert.equal(favorites[0].available, false);
  assert.equal(pathMatchesRuntime('C:\\x', 'windows'), true);
  assert.equal(pathMatchesRuntime('/x', null), true);
});

test('folderKey/pushRecent: 구분자·끝 슬래시·드라이브 대소문자 무시, 중복 없이 맨 앞, 개수 제한', () => {
  assert.equal(folderKey('C:\\Work\\'), folderKey('c:/work'));
  let r = [];
  for (let i = 0; i < RECENT_LIMIT + 5; i++) r = pushRecent(r, `/p${i}`, i);
  r = pushRecent(r, '/p20/', 100);
  assert.equal(r.length, RECENT_LIMIT);
  assert.equal(r[0].path, '/p20/');
  assert.equal(r.filter(x => folderKey(x.path) === '/p20').length, 1);
});

test('background: 폴더 변경이 최근에 기록되고, 즐겨찾기 추가·이름·해제와 최근 숨김이 storage.local에 남는다', async (t) => {
  const server = await startMockOpencode();
  const bg = await loadBackground({ port: server.port, local: { selectedModel: { providerID: 'mock', modelID: 'model' } } });
  t.after(async () => { bg.cleanup(); await server.close(); });
  await bg.send({ action: 'init-server' });
  const s = await bg.send({ action: 'get-tab-session', tabId: 3, title: 't' });

  await bg.send({ action: 'set-working-directory', directory: '/proj/a', tabId: 3, sessionId: s.sessionId });
  assert.equal(bg.localStorage.folderRecent[0].path, '/proj/a');

  await bg.send({ action: 'set-folder-favorite', path: '/proj/a', favorite: true });
  await bg.send({ action: 'set-folder-favorite', path: '/proj/a/', favorite: true, name: '회사' });
  assert.deepEqual(bg.localStorage.folderFavorites.map(f => [f.path, f.name]), [['/proj/a', '회사']]);

  let list = await bg.send({ action: 'get-folder-list' });
  assert.deepEqual(list.favorites.map(f => f.name), ['회사']);
  assert.ok(!list.recent.some(r => folderKey(r.path) === '/proj/a'), '즐겨찾기는 최근에서 빠진다');

  await bg.send({ action: 'set-folder-favorite', path: '/proj/a', favorite: false });
  await bg.send({ action: 'hide-recent-folder', path: '/proj/a' });
  list = await bg.send({ action: 'get-folder-list' });
  assert.deepEqual(list.favorites, []);
  assert.ok(!list.recent.some(r => folderKey(r.path) === '/proj/a'), '숨긴 폴더는 최근에서 빠진다');

  // 다시 고르면 숨김이 풀린다
  await bg.send({ action: 'set-working-directory', directory: '/proj/a', tabId: 3 });
  list = await bg.send({ action: 'get-folder-list' });
  assert.ok(list.recent.some(r => r.path === '/proj/a'));
});
