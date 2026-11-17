// 실행: node --test test/installed-proxy.test.mjs
// 인스톨러는 config.private.json의 proxy를 사용자 환경변수에 쓰지 않고 proxy.json에만 남긴다.
// 그래서 ⚙를 한 번도 열지 않은 사용자도 첫 서버 기동부터 그 프록시가 적용돼야 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockOpencode } from './helpers/mock-opencode.mjs';
import { loadBackground } from './helpers/background-harness.mjs';

const MODEL = { selectedModel: { providerID: 'mock', modelID: 'model' } };
const INSTALLED = { http: 'http://proxy.corp:8080', https: 'http://proxy.corp:8080', noProxy: 'localhost' };

async function setup(t, { local = {}, installed = INSTALLED } = {}) {
  const foreign = await startMockOpencode(); // 확장이 띄우지 않은 서버 → 새로 start 한다
  const ours = await startMockOpencode();
  const calls = [];
  const bg = await loadBackground({
    port: foreign.port,
    local: { ...MODEL, ...local },
    nativeMessage: (msg) => {
      calls.push(msg);
      if (msg.action === 'get-installed-proxy') return { status: 'success', proxy: installed };
      if (msg.action === 'server-info') return { status: 'success', managed: false };
      if (msg.action === 'start') return { status: 'success', port: ours.port, isWSL: true };
      return { status: 'success' };
    }
  });
  t.after(async () => { bg.cleanup(); await foreign.close(); await ours.close(); });
  return { bg, calls };
}

test('⚙ 값이 없으면 첫 서버 start에 인스톨러 프록시를 가져와 넘기고 저장한다', async (t) => {
  const { bg, calls } = await setup(t);
  await bg.send({ action: 'init-server' });
  const start = calls.find((m) => m.action === 'start');
  assert.deepEqual(start.proxy, INSTALLED);
  assert.deepEqual(bg.localStorage.proxy, INSTALLED);
  // 이후 ⚙를 열어도 다시 묻지 않고 저장된 값을 보여 준다
  const before = calls.filter((m) => m.action === 'get-installed-proxy').length;
  const res = await bg.send({ action: 'get-proxy' });
  assert.deepEqual(res.proxy, INSTALLED);
  assert.equal(calls.filter((m) => m.action === 'get-installed-proxy').length, before);
});

test('⚙에 저장된 값(빈 값 포함)이 있으면 인스톨러 값으로 덮어쓰지 않는다', async (t) => {
  const cleared = { http: '', https: '', noProxy: '' };
  const { bg, calls } = await setup(t, { local: { proxy: cleared } });
  await bg.send({ action: 'init-server' });
  assert.deepEqual(calls.find((m) => m.action === 'start').proxy, cleared);
  assert.ok(!calls.some((m) => m.action === 'get-installed-proxy'));
});

test('proxy.json이 없으면 한 번만 묻고 프록시 없이 띄운다', async (t) => {
  const { bg, calls } = await setup(t, { installed: null });
  await bg.send({ action: 'init-server' });
  await bg.send({ action: 'get-proxy' });
  assert.equal(calls.filter((m) => m.action === 'get-installed-proxy').length, 1);
  assert.deepEqual(calls.find((m) => m.action === 'start').proxy, { http: '', https: '', noProxy: '' });
  assert.equal(bg.localStorage.proxy, undefined);
});
