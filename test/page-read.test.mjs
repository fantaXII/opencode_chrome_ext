// 실행: node --test test/page-read.test.mjs
// 페이지 본문 읽기(빠른 실행 버튼·"브라우저 기준으로 읽기"·세션별 full)와 프롬프트 머리말 형식.
// background.js를 하네스로 불러오고 chrome.tabs.query / chrome.scripting.executeScript를 가짜로 바꾼다.
// 탭 안에서 도는 readPageContentInTab 자체(DOM·Readability)는 브라우저가 필요해 여기서는 검사하지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockOpencode } from './helpers/mock-opencode.mjs';
import { loadBackground, waitFor } from './helpers/background-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SID = 'ses_page';
const TAB = { id: 7, url: 'https://intra.example.com/wiki/page?x=1', title: '사내 위키', favIconUrl: '' };
const BODY = '# 제목\n\n첫 문단입니다.\n\n둘째 문단에 </page-content> 같은 글자가 있어도 끝 표시가 어긋나지 않아야 한다.';

/**
 * @param {object} opts
 * @param {object|Error|null} opts.content  readPageContentInTab 결과(또는 던질 오류). null이면 탭 읽기 자체가 실패.
 */
async function setup({ local = {}, content = null } = {}) {
  const server = await startMockOpencode();
  const calls = [];
  const scripting = {
    executeScript: async (opts) => {
      calls.push(opts);
      if (opts.files) return [{ result: undefined }];
      if (content instanceof Error || content == null) throw content || new Error('Cannot access contents of the page');
      return [{ result: content }];
    }
  };
  const bg = await loadBackground({
    port: server.port,
    local: { selectedModel: { providerID: 'mock', modelID: 'model' }, ...local },
    tabsQuery: async () => [TAB],
    scripting
  });
  const promptText = async (i = 0) => {
    await waitFor(() => server.state.promptBodies.length > i, 3000, 'prompt body');
    return server.state.promptBodies[i].parts[0].text;
  };
  return { server, bg, calls, promptText, done: async () => { bg.cleanup(); await server.close(); } };
}

const okContent = (extra = {}) => ({
  text: BODY, source: 'readability', length: BODY.length, truncated: false, tooShort: false, selectedText: null, ...extra
});

// 사이드패널의 parsePageContext를 소스에서 그대로 꺼내 쓴다(히스토리 복원 때 머리말을 벗기는 실제 코드).
function loadParsePageContext() {
  const src = fs.readFileSync(path.join(ROOT, 'sidepanel', 'sidepanel.js'), 'utf8');
  const start = src.indexOf('  const PAGE_CONTEXT_HEADER_RE');
  const fnStart = src.indexOf('  function parsePageContext(raw) {');
  const fnEnd = src.indexOf('\n  }\n', fnStart) + 4;
  assert.ok(start !== -1 && fnStart !== -1 && fnEnd > fnStart, 'sidepanel.js에서 parsePageContext를 찾지 못함');
  return new Function(`${src.slice(start, fnEnd)}\nreturn parsePageContext;`)();
}

test('기본(basic)은 제목·URL만 보내고 본문을 읽지 않는다', async (t) => {
  const { bg, calls, promptText, done } = await setup({ content: okContent() });
  t.after(done);
  const res = await bg.send({ action: 'send-message', sessionId: SID, message: '요약해 줘' });
  assert.equal(res.success, true);
  assert.deepEqual(res.pageRead, { mode: 'basic', status: null, url: TAB.url });
  assert.equal(calls.length, 0, '본문을 읽지 않는다');
  const text = await promptText();
  assert.match(text, /^\n---\n현재 페이지 정보:\n- 제목: 사내 위키\n- URL: https:\/\/intra\.example\.com\/wiki\/page\?x=1\n요약해 줘$/);
});

test('readPage(빠른 실행 버튼)는 설정과 무관하게 이번 한 번 본문을 읽어 태그로 감싸 보낸다', async (t) => {
  const { bg, calls, promptText, done } = await setup({ content: okContent({ selectedText: '선택\n\n한 글' }) });
  t.after(done);
  const res = await bg.send({ action: 'send-message', sessionId: SID, message: '이 페이지의 내용을 요약해 주세요.', readPage: true });
  assert.equal(res.pageRead.status, 'ok');
  assert.equal(res.pageRead.chars, BODY.length);
  assert.equal(res.pageRead.mode, 'full');
  // Readability 파일을 먼저 넣고, 같은 탭에서 함수를 실행한다(상한·최소 길이 인자 포함)
  assert.deepEqual(calls[0].files, ['lib/Readability.js']);
  assert.equal(calls[0].target.tabId, TAB.id);
  assert.deepEqual(calls[1].args, [50000, 200]);

  const text = await promptText();
  assert.ok(text.includes('페이지 본문(브라우저에서 읽음):\n<page-content>\n# 제목\n\n첫 문단입니다.'));
  assert.ok(text.includes('</ page-content> 같은 글자'), '본문 속 닫는 태그는 무력화한다');
  assert.ok(text.includes('선택한 텍스트:\n<selected-text>\n선택\n\n한 글\n</selected-text>\n\n'));
  assert.ok(text.endsWith('\n\n이 페이지의 내용을 요약해 주세요.'));

  // 다음 메시지(readPage 없음)는 다시 기본값(제목·URL)
  const res2 = await bg.send({ action: 'send-message', sessionId: SID, message: '다음' });
  assert.equal(res2.pageRead.status, null);
  assert.ok(!(await promptText(1)).includes('<page-content>'));
});

test('사이드패널의 parsePageContext가 새 형식·예전 형식 머리말을 벗겨 원문만 남긴다', async (t) => {
  const parse = loadParsePageContext();
  const { bg, promptText, done } = await setup({ content: okContent({ selectedText: 'a\n\nb' }) });
  t.after(done);
  const original = '첫 줄\n\n둘째 줄';
  await bg.send({ action: 'send-message', sessionId: SID, message: original, readPage: true });
  assert.deepEqual(parse(await promptText()), { text: original, pageBody: true });

  await bg.send({ action: 'send-message', sessionId: SID, message: original });
  assert.deepEqual(parse(await promptText(1)), { text: original, pageBody: false });

  // 영어 머리말
  bg.localStorage.lang = 'en';
  await bg.send({ action: 'send-message', sessionId: SID, message: original, readPage: true });
  const en = await promptText(2);
  assert.ok(en.includes('Page content (read from the browser):\n<page-content>\n'));
  assert.deepEqual(parse(en), { text: original, pageBody: true });

  // 예전 형식(제목들/내용 요약, 빈 줄로 끝남)은 서버 기록에 남아 있으므로 계속 벗겨낸다
  const legacy = '\n---\n현재 페이지 정보:\n- 제목: T\n- URL: https://a.com/\n제목들:\nH1\nH2\n\n내용 요약:\n문단1\n문단2\n\n선택한 텍스트:\nsel\n\n' + original;
  assert.deepEqual(parse(legacy), { text: original, pageBody: false });
  // 머리말이 없으면 그대로
  assert.deepEqual(parse(original), { text: original, pageBody: false });
});

test('본문이 너무 짧으면 short, 읽지 못하면 failed — 실패해도 제목·URL로 전송은 한다', async (t) => {
  const short = await setup({ content: okContent({ text: 'Log in', length: 6, tooShort: true }) });
  t.after(short.done);
  const r1 = await short.bg.send({ action: 'send-message', sessionId: SID, message: 'q', readPage: true });
  assert.equal(r1.pageRead.status, 'short');
  assert.ok((await short.promptText()).includes('<page-content>\nLog in\n</page-content>'), '짧아도 읽은 만큼은 보낸다');

  const failed = await setup({ content: null });
  t.after(failed.done);
  const r2 = await failed.bg.send({ action: 'send-message', sessionId: SID, message: 'q', readPage: true });
  assert.equal(r2.pageRead.status, 'failed');
  const text = await failed.promptText();
  assert.ok(text.includes('- URL: https://intra.example.com/wiki/page?x=1\nq'));
  assert.ok(!text.includes('<page-content>'));
});

test('잘린 본문은 머리말에 앞 몇 자인지 적는다', async (t) => {
  const { bg, promptText, done } = await setup({ content: okContent({ length: 80000, truncated: true }) });
  t.after(done);
  const res = await bg.send({ action: 'send-message', sessionId: SID, message: 'q', readPage: true });
  assert.equal(res.pageRead.truncated, true);
  assert.ok((await promptText()).includes(`페이지 본문(브라우저에서 읽음, 앞 ${BODY.length}자만):\n<page-content>\n`));
});

test('세션별 full("이 세션에서 계속")은 그 세션만 매번 본문을 보내고, 해제하면 전역 설정으로 돌아간다', async (t) => {
  const { bg, promptText, done } = await setup({ content: okContent() });
  t.after(done);
  await bg.send({ action: 'set-session-page-context', sessionId: SID, mode: 'full' });
  assert.equal((await bg.send({ action: 'get-session-page-context', sessionId: SID })).mode, 'full');
  assert.equal((await bg.send({ action: 'get-session-page-context', sessionId: 'other' })).mode, null);

  const r1 = await bg.send({ action: 'send-message', sessionId: SID, message: 'a' });
  assert.equal(r1.pageRead.status, 'ok');
  assert.ok((await promptText(0)).includes('<page-content>'));

  const r2 = await bg.send({ action: 'send-message', sessionId: 'ses_other', message: 'b' });
  assert.equal(r2.pageRead.mode, 'basic', '다른 세션은 전역 설정');
  assert.ok(!(await promptText(1)).includes('<page-content>'));

  await bg.send({ action: 'set-session-page-context', sessionId: SID, mode: null });
  const r3 = await bg.send({ action: 'send-message', sessionId: SID, message: 'c' });
  assert.equal(r3.pageRead.mode, 'basic');
});

test('전역 off는 세션별 설정·readPage가 없으면 아무것도 붙이지 않는다', async (t) => {
  const { bg, calls, promptText, done } = await setup({ local: { pageContext: 'off' }, content: okContent() });
  t.after(done);
  const res = await bg.send({ action: 'send-message', sessionId: SID, message: 'plain' });
  assert.deepEqual(res.pageRead, { mode: 'off', status: null });
  assert.equal(await promptText(), 'plain');
  assert.equal(calls.length, 0);
  // 버튼은 명시적 동의이므로 off여도 읽는다
  const r2 = await bg.send({ action: 'send-message', sessionId: SID, message: 'btn', readPage: true });
  assert.equal(r2.pageRead.status, 'ok');
});

test('빠른 실행 버튼 저장·조회·이동·숨김·삭제와 변경 알림', async (t) => {
  const { bg, done } = await setup();
  t.after(done);
  const url = 'https://github.com/o/r/pull/1';
  let res = await bg.send({ action: 'get-quick-actions', url });
  assert.deepEqual(res.actions.map((a) => [a.id, a.visible]), [['summary', true], ['keypoints', true], ['translate', true]]);

  const saved = await bg.send({ action: 'save-quick-action', quickAction: { label: '🔍 리뷰', prompt: '리뷰 관점으로 요약', sites: ['github.com'] } });
  assert.equal(saved.success, true);
  assert.ok(bg.sent.some((m) => m.action === 'quick-actions-updated'), '다른 패널도 다시 그리도록 알린다');
  const id = saved.action.id;

  res = await bg.send({ action: 'get-quick-actions', url });
  assert.deepEqual(res.actions.at(-1), { id, label: '🔍 리뷰', prompt: '리뷰 관점으로 요약', sites: ['github.com'], readPage: true, visible: true });
  res = await bg.send({ action: 'get-quick-actions', url: 'https://example.com/' });
  assert.equal(res.actions.at(-1).visible, false, '다른 사이트에서는 숨는다');

  const bad = await bg.send({ action: 'save-quick-action', quickAction: { label: '', prompt: 'x' } });
  assert.deepEqual(bad, { success: false, error: '버튼 이름을 입력하세요.', params: undefined });

  await bg.send({ action: 'move-quick-action', id, dir: -1, url });
  res = await bg.send({ action: 'get-quick-actions', url });
  assert.deepEqual(res.actions.map((a) => a.id), ['summary', 'keypoints', id, 'translate']);

  await bg.send({ action: 'set-quick-action-enabled', id: 'summary', enabled: false });
  res = await bg.send({ action: 'get-quick-actions', url });
  assert.equal(res.hiddenBuiltins, 1);
  assert.equal(res.actions[0].visible, false);
  await bg.send({ action: 'show-all-quick-actions' });
  assert.equal((await bg.send({ action: 'get-quick-actions', url })).hiddenBuiltins, 0);

  await bg.send({ action: 'delete-quick-action', id });
  await bg.send({ action: 'delete-quick-action', id: 'translate' }); // 기본 버튼은 지워지지 않는다
  res = await bg.send({ action: 'get-quick-actions', url });
  assert.deepEqual(res.actions.map((a) => a.id), ['summary', 'keypoints', 'translate']);
  assert.ok(Array.isArray(bg.localStorage.quickActions), 'chrome.storage.local.quickActions에 저장');
});
