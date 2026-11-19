// 실행: node --test test/opencode-api.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { basicAuthHeader, portFromUrl, withAuth, createPasswordStore, createServerFetch, probeV2 } from '../lib/opencode-api.mjs';

const { withServerPassword, maskServerSecret, generateServerPassword } = createRequire(import.meta.url)('../native-host/host.js');

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get: async (k) => (k in data ? { [k]: data[k] } : {}),
    set: async (obj) => { Object.assign(data, obj); }
  };
}

test('Basic 헤더는 사용자 opencode로 만든다', () => {
  assert.equal(basicAuthHeader('pw'), `Basic ${Buffer.from('opencode:pw').toString('base64')}`);
});

test('portFromUrl은 127.0.0.1 주소에서만 포트를 꺼낸다', () => {
  assert.equal(portFromUrl('http://127.0.0.1:4096/global/health'), 4096);
  assert.equal(portFromUrl('http://127.0.0.1:4097?x=1'), 4097);
  assert.equal(portFromUrl('http://127.0.0.1:4098'), 4098);
  assert.equal(portFromUrl('https://example.com:4096/'), null);
  assert.equal(portFromUrl('http://127.0.0.10:4096/'), null);
});

test('withAuth는 기존 헤더를 지키고, 비밀번호가 없거나 Authorization이 이미 있으면 바꾸지 않는다', () => {
  const init = { method: 'POST', headers: { 'x-opencode-directory': '/w' } };
  const out = withAuth(init, 'pw');
  assert.equal(out.method, 'POST');
  assert.equal(out.headers.get('x-opencode-directory'), '/w');
  assert.equal(out.headers.get('authorization'), basicAuthHeader('pw'));
  assert.equal(withAuth(init, null), init);
  assert.equal(withAuth({ headers: { Authorization: 'Bearer x' } }, 'pw').headers.get('authorization'), 'Bearer x');
  assert.equal(withAuth(undefined, 'pw').headers.get('authorization'), basicAuthHeader('pw'));
});

test('비밀번호 저장소는 storage에서 복원하고 바뀔 때만 저장한다', async () => {
  const storage = memoryStorage({ serverPasswords: { 4096: 'old' } });
  const store = createPasswordStore(storage);
  await store.ready;
  assert.equal(store.get(4096), 'old');
  assert.equal(store.get('4096'), 'old');
  store.set(4097, 'new');
  assert.deepEqual(storage.data.serverPasswords, { 4096: 'old', 4097: 'new' });
  store.remove(4096);
  assert.deepEqual(storage.data.serverPasswords, { 4097: 'new' });
  assert.equal(store.get(4100), null);
});

test('serverFetch는 비밀번호를 아는 로컬 포트에만 헤더를 붙인다', async () => {
  const seen = [];
  const store = createPasswordStore(memoryStorage({ serverPasswords: { 4096: 'pw' } }));
  const f = createServerFetch(store, async (url, init) => { seen.push([url, init?.headers?.get?.('authorization') ?? null]); return 'ok'; });
  await f('http://127.0.0.1:4096/session', { headers: { a: '1' } });
  await f('http://127.0.0.1:4097/session');
  await f('https://example.com/x');
  assert.deepEqual(seen, [
    ['http://127.0.0.1:4096/session', basicAuthHeader('pw')],
    ['http://127.0.0.1:4097/session', null],
    ['https://example.com/x', null]
  ]);
});

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

test('probeV2: 2.x 401(UnauthorizedError)·인증 성공·1.x/다른 서버를 구분한다', async (t) => {
  const PW = 'pw2';
  const v2 = await serve((req, res) => {
    const ok = req.headers.authorization === basicAuthHeader(PW);
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { version: '2.3.2', pid: 1 } : { _tag: 'UnauthorizedError', message: 'Authentication required' }));
  });
  const other = await serve((req, res) => { res.writeHead(404, { 'content-type': 'text/html' }); res.end('nope'); });
  t.after(async () => { await v2.close(); await other.close(); });

  const store = createPasswordStore(memoryStorage());
  const f = createServerFetch(store);
  assert.deepEqual(await probeV2(f, v2.port), { v2: true, authorized: false });
  store.set(v2.port, PW);
  assert.deepEqual(await probeV2(f, v2.port), { v2: true, authorized: true, version: '2.3.2' });
  assert.deepEqual(await probeV2(f, other.port), { v2: false });
});

test('host: 비밀번호를 env와 WSLENV에 넣고, 기존 대소문자 변형을 지운다', () => {
  const env = withServerPassword({ PATH: 'p', opencode_server_password: 'user-set', WSLENV: 'HTTP_PROXY:OPENCODE_SERVER_PASSWORD/u' }, 'NEW');
  assert.equal(env.OPENCODE_SERVER_PASSWORD, 'NEW');
  assert.equal(env.opencode_server_password, undefined);
  assert.equal(env.WSLENV, 'HTTP_PROXY:OPENCODE_SERVER_PASSWORD');
  assert.equal(env.PATH, 'p');
  const untouched = { OPENCODE_SERVER_PASSWORD: 'user-set' };
  assert.equal(withServerPassword(untouched, null), untouched, 'auth를 요청하지 않으면 사용자 환경을 그대로 둔다');
});

test('host: 로그에서 비밀번호와 "server password" 줄을 가린다', () => {
  assert.equal(maskServerSecret('a SECRET b SECRET', 'SECRET'), 'a *** b ***');
  assert.equal(maskServerSecret('server password: abc123 (use it)', null), 'server password: *** (use it)');
  assert.equal(maskServerSecret('nothing here', 'x'.repeat(24)), 'nothing here');
});

test('host: 비밀번호는 매번 다르고 env·URL에 안전한 문자만 쓴다', () => {
  const a = generateServerPassword();
  const b = generateServerPassword();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{24}$/);
});
