// 실행: node --test test/exit-panel.test.mjs
// 사이드패널에서 exit를 보내면 background가 이 탭의 패널을 닫고 세션 연결만 끊는다(서버 세션은 남긴다).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockOpencode } from './helpers/mock-opencode.mjs';
import { loadBackground, waitFor } from './helpers/background-harness.mjs';

const TAB = 42;

test('exit-panel: 패널을 닫고 탭-세션 연결을 끊되 서버 세션은 지우지 않는다. 다시 열면 새 세션', async (t) => {
  const server = await startMockOpencode();
  const bg = await loadBackground({ port: server.port, local: { selectedModel: { providerID: 'mock', modelID: 'model' } } });
  t.after(async () => { bg.cleanup(); await server.close(); });

  const first = await bg.send({ action: 'get-tab-session', tabId: TAB, title: 't' });
  assert.equal(first.isNew, true);

  const res = await bg.send({ action: 'exit-panel', tabId: TAB, sessionId: first.sessionId });
  assert.deepEqual(res, { success: true });
  await waitFor(() => bg.sidePanelCalls.some((o) => o.tabId === TAB && o.enabled === false), 1000, 'panel disabled');
  assert.deepEqual(server.state.deleted, [], '서버 세션(대화 기록)은 지우지 않는다');
  assert.equal(server.state.aborts.length, 0);
  await waitFor(() => !(bg.sessionStorage.tabSessions || []).some?.(([id]) => id === TAB), 1000, 'tabSessions persisted');
  assert.ok(!(bg.sessionStorage.activeTabs || []).includes(TAB), '패널을 연 탭 목록에서도 빠진다');

  // 다시 열면(get-tab-session) 새 세션으로 시작한다
  const again = await bg.send({ action: 'get-tab-session', tabId: TAB, title: 't' });
  assert.equal(again.isNew, true);
  assert.notEqual(again.sessionId, first.sessionId);
});

test('탭을 닫아도 서버 세션(대화 기록)은 지우지 않는다(TUI와 같은 개념)', async (t) => {
  const server = await startMockOpencode();
  const bg = await loadBackground({ port: server.port, local: { selectedModel: { providerID: 'mock', modelID: 'model' } } });
  t.after(async () => { bg.cleanup(); await server.close(); });

  const s = await bg.send({ action: 'get-tab-session', tabId: TAB, title: 't' });
  bg.closeTab(TAB);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(server.state.deleted, [], '세션을 삭제하면 /sessions로 이어갈 수 없다');
  assert.ok(!(bg.sessionStorage.tabSessions || []).some(([id]) => id === TAB), '탭-세션 연결은 끊는다');
  // /sessions로 다시 불러올 수 있다
  const sw = await bg.send({ action: 'switch-session', sessionId: s.sessionId, tabId: 99 });
  assert.equal(sw.success, true);
});
