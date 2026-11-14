// 실행: node --test test/managed-server.test.mjs
// 사이드패널은 확장이 띄운 서버만 쓴다. 다른 프로그램(TUI 등)이 띄운 서버에 붙으면 강제 재시작이
// 그 작업까지 죽이기 때문이다. host가 판정하지 못하면(미설치·구버전) 예전처럼 아무 서버에나 붙는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockOpencode } from './helpers/mock-opencode.mjs';
import { loadBackground } from './helpers/background-harness.mjs';

const MODEL = { selectedModel: { providerID: 'mock', modelID: 'model' } };

test('확장이 띄우지 않은 서버는 건너뛰고 새 서버를 띄워 그 포트만 쓴다', async (t) => {
  const foreign = await startMockOpencode(); // 스캔 범위 안의 TUI 서버
  const ours = await startMockOpencode();    // host가 새로 띄운 서버
  const calls = [];
  const bg = await loadBackground({
    port: foreign.port,
    local: MODEL,
    nativeMessage: (msg) => {
      calls.push(msg.action);
      if (msg.action === 'server-info') return { status: 'success', managed: false, listener: { side: 'wsl', pid: 1 } };
      if (msg.action === 'start') return { status: 'success', port: ours.port, isWSL: true };
      return { status: 'success' };
    }
  });
  t.after(async () => { bg.cleanup(); await foreign.close(); await ours.close(); });

  const res = await bg.send({ action: 'init-server' });
  assert.equal(res.port, ours.port);
  assert.ok(calls.includes('start'), '확장 서버가 없으면 새로 띄운다');
  assert.equal(bg.localStorage.managedServerPort, ours.port, '띄운 포트를 기록한다');
});

test('기록된 확장 서버가 살아 있으면 host 확인 후 그대로 쓴다(브라우저 세션 동안 재확인하지 않음)', async (t) => {
  const ours = await startMockOpencode();
  const foreign = await startMockOpencode();
  const calls = [];
  const bg = await loadBackground({
    port: foreign.port,
    local: { ...MODEL, managedServerPort: ours.port },
    nativeMessage: (msg) => {
      calls.push(msg);
      if (msg.action === 'server-info') return { status: 'success', managed: msg.port === ours.port };
      throw new Error('unexpected ' + msg.action);
    }
  });
  t.after(async () => { bg.cleanup(); await foreign.close(); await ours.close(); });

  const res = await bg.send({ action: 'init-server' });
  assert.equal(res.port, ours.port);
  assert.deepEqual(calls.map((m) => [m.action, m.port]), [['server-info', ours.port]]);
  assert.equal(bg.sessionStorage.managedServerVerified, ours.port);
});

test('기록된 포트를 다른 서버가 쓰고 있으면 버리고, 범위 안의 확장 서버(server.json 기록)를 이어받는다', async (t) => {
  const reused = await startMockOpencode(); // 예전 확장 포트를 지금은 TUI가 사용
  const ours = await startMockOpencode();
  const bg = await loadBackground({
    port: ours.port,
    local: { ...MODEL, managedServerPort: reused.port },
    nativeMessage: (msg) => {
      if (msg.action === 'server-info') return { status: 'success', managed: msg.port === ours.port };
      throw new Error('unexpected ' + msg.action);
    }
  });
  t.after(async () => { bg.cleanup(); await reused.close(); await ours.close(); });

  const res = await bg.send({ action: 'init-server' });
  assert.equal(res.port, ours.port);
  assert.equal(bg.localStorage.managedServerPort, ours.port);
});

test('host가 판정하지 못하면(구버전: Unknown action) 예전처럼 범위 안의 서버에 붙고, 확장 서버로 기록하지 않는다', async (t) => {
  const server = await startMockOpencode();
  const bg = await loadBackground({
    port: server.port,
    local: MODEL,
    nativeMessage: () => ({ status: 'error', error: 'Unknown action' })
  });
  t.after(async () => { bg.cleanup(); await server.close(); });

  const res = await bg.send({ action: 'init-server' });
  assert.equal(res.port, server.port);
  assert.equal(bg.localStorage.managedServerPort, undefined);
});

test('MCP 조회·켜기/끄기는 세션의 작업 폴더로 묻는다(한글 경로는 인코딩)', async (t) => {
  const server = await startMockOpencode();
  const bg = await loadBackground({ port: server.port, local: MODEL });
  t.after(async () => { bg.cleanup(); await server.close(); });

  await bg.send({ action: 'init-server' });
  const dir = '/home/user/프로젝트';
  bg.localStorage.workingDirectory = dir;
  const s = await bg.send({ action: 'get-tab-session', tabId: 7, title: 't' });
  assert.equal(server.state.sessionDirs[s.sessionId], dir);
  bg.localStorage.workingDirectory = '/other'; // 새 세션의 기본값이 바뀌어도 세션 폴더를 따른다

  await bg.send({ action: 'get-mcp-status', sessionId: s.sessionId });
  await bg.send({ action: 'toggle-mcp', name: 'x', connect: true, sessionId: s.sessionId });
  const enc = encodeURIComponent(dir);
  assert.deepEqual(server.state.mcpRequests, [
    ['GET', '/mcp', enc],
    ['POST', '/mcp/x/connect', enc],
    ['GET', '/mcp', enc]
  ]);
});

test('하드 재시작은 host가 알려준 새 포트만 기다리고 확장 서버로 기록한다(범위의 다른 서버를 고르지 않는다)', async (t) => {
  const old = await startMockOpencode();      // 재시작 전 확장 서버(스캔 범위 안)
  const restarted = await startMockOpencode();
  const bg = await loadBackground({
    port: old.port,
    local: { ...MODEL, managedServerPort: old.port },
    nativeMessage: (msg) => {
      if (msg.action === 'server-info') return { status: 'success', managed: true };
      if (msg.action === 'restart') return { status: 'success', port: restarted.port, isWSL: true };
      throw new Error('unexpected ' + msg.action);
    }
  });
  t.after(async () => { bg.cleanup(); await old.close(); await restarted.close(); });

  await bg.send({ action: 'init-server' });
  const res = await bg.send({ action: 'restart-server' });
  assert.equal(res.success, true);
  assert.equal(res.port, restarted.port);
  assert.equal(bg.localStorage.managedServerPort, restarted.port);
});

test('get-active-streams: 진행 중인 응답 구독 목록을 돌려준다', async (t) => {
  const server = await startMockOpencode();
  const bg = await loadBackground({ port: server.port, local: MODEL });
  t.after(async () => { bg.cleanup(); await server.close(); });
  const empty = await bg.send({ action: 'get-active-streams' });
  assert.deepEqual(empty.sessionIds, []);
  bg.internals.eventSources.set('ses_x', new AbortController());
  const one = await bg.send({ action: 'get-active-streams' });
  assert.deepEqual(one.sessionIds, ['ses_x']);
});

test('확장 서버인지 확인하지 못한 서버는 하드 재시작이 죽이지 않고(restart 대신 start) 새 서버로 옮긴다', async (t) => {
  const unknown = await startMockOpencode(); // 누가 띄웠는지 모르는 서버(TUI일 수 있음)
  const fresh = await startMockOpencode();
  const calls = [];
  let infoFails = true;
  const bg = await loadBackground({
    port: unknown.port,
    local: MODEL,
    nativeMessage: (msg) => {
      calls.push(msg.action);
      if (msg.action === 'server-info' && infoFails) return { status: 'error', error: 'powershell failed' };
      if (msg.action === 'start') return { status: 'success', port: fresh.port, isWSL: true };
      throw new Error('unexpected ' + msg.action);
    }
  });
  t.after(async () => { bg.cleanup(); await unknown.close(); await fresh.close(); });

  const init = await bg.send({ action: 'init-server' });
  assert.equal(init.port, unknown.port, '판정 불가면 예전처럼 붙는다');
  infoFails = false;
  const res = await bg.send({ action: 'restart-server' });
  assert.equal(res.success, true);
  assert.ok(!calls.includes('restart'), '포트를 점유한 프로세스를 죽이는 restart를 보내지 않는다');
  assert.ok(calls.includes('start'));
  assert.equal(res.port, fresh.port);
  assert.equal(bg.localStorage.managedServerPort, fresh.port);
});

test('명령(skill 포함)·에이전트 목록도 세션의 작업 폴더로 묻는다', async (t) => {
  const server = await startMockOpencode();
  const bg = await loadBackground({ port: server.port, local: MODEL });
  t.after(async () => { bg.cleanup(); await server.close(); });

  await bg.send({ action: 'init-server' });
  const dir = '/home/user/프로젝트';
  bg.localStorage.workingDirectory = dir;
  const s = await bg.send({ action: 'get-tab-session', tabId: 8, title: 't' });
  bg.localStorage.workingDirectory = '/other';

  const cmds = await bg.send({ action: 'get-commands', sessionId: s.sessionId });
  const agents = await bg.send({ action: 'get-agents', sessionId: s.sessionId });
  assert.deepEqual(cmds.commands.map((c) => c.name), ['workcmd']);
  assert.deepEqual(agents.agents.map((a) => a.name), ['build']);
  const enc = encodeURIComponent(dir);
  assert.deepEqual(server.state.catalogRequests, [['/command', enc], ['/agent', enc]]);
});
