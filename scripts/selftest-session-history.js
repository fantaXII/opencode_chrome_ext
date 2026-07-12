// docs/session_history_plan.md §7.1 — 세션 히스토리 파싱 로직 순수 함수 유닛테스트.
// 외부 의존성 없이 Node 내장 assert만 사용한다. 실행: node scripts/selftest-session-history.js
const assert = require('node:assert');

// background.js getSessionHistory()의 변환 로직과 동일
function extractMessages(raw) {
  return (raw || [])
    .filter(m => m.info?.role === 'user' || m.info?.role === 'assistant')
    .map(m => ({
      role: m.info.role,
      id: m.info.id,
      text: (m.parts || [])
        .filter(p => p.type === 'text' && typeof p.text === 'string')
        .map(p => p.text)
        .join('')
    }));
}

// sidepanel/sidepanel.js splitAttachmentBlock()과 동일
function splitAttachmentBlock(raw) {
  const re = /^\[첨부 파일 — 필요 시 read 도구로 읽어 분석하세요\]\n((?:- .*\n)+)\n([\s\S]*)$/;
  const match = raw.match(re);
  if (!match) return { text: raw, attachments: [] };
  const attachments = match[1].split('\n').filter(Boolean).map(line => line.replace(/^- /, ''));
  return { text: match[2], attachments };
}

// sidepanel/sidepanel.js stripPageContext()와 동일
const PAGE_CONTEXT_HEADER_RE = /^\n---\n현재 페이지 정보:\n- 제목: .*\n- URL: .*\n/;
const PAGE_CONTEXT_SECTION_LABELS = ['제목들:\n', '내용 요약:\n', '선택한 텍스트:\n'];

function stripPageContext(raw) {
  const headerMatch = raw.match(PAGE_CONTEXT_HEADER_RE);
  if (!headerMatch) return raw;
  let rest = raw.slice(headerMatch[0].length);
  for (const label of PAGE_CONTEXT_SECTION_LABELS) {
    if (!rest.startsWith(label)) continue;
    const sepIndex = rest.indexOf('\n\n', label.length);
    rest = sepIndex === -1 ? '' : rest.slice(sepIndex + 2);
  }
  return rest;
}

// 골든 픽스처: 2026-07-12 로컬 opencode v1.15.10 실측 캡처 (docs/session_history_plan.md §2.2)
const FIXTURE_SINGLE_TURN = [
  {
    info: { id: 'msg_f557a4cb0001UKPcVxqh0tiPu7', sessionID: 'ses_0aa85b4e', role: 'user' },
    parts: [
      { id: 'prt_1', type: 'text', text: 'Reply with exactly the single word: PONG' }
    ]
  },
  {
    info: { id: 'msg_f557a4d6e0014oeqynOvSv1FaE', sessionID: 'ses_0aa85b4e', role: 'assistant' },
    parts: [
      { id: 'prt_2', type: 'step-start' },
      { id: 'prt_3', type: 'text', text: 'PONG' },
      { id: 'prt_4', type: 'step-finish', reason: 'stop' }
    ]
  }
];

// 첨부파일 프리픽스가 포함된 실측 패턴 (§2.1 왕복 검증에서 그대로 캡처)
const FIXTURE_ATTACHMENT_TURN = [
  {
    info: { id: 'msg_x1', sessionID: 'ses_x', role: 'user' },
    parts: [
      {
        id: 'prt_x1', type: 'text',
        text: '[첨부 파일 — 필요 시 read 도구로 읽어 분석하세요]\n- /tmp/a.txt\n- /tmp/b.txt\n\nNow reply with exactly the word: SECOND'
      }
    ]
  },
  {
    info: { id: 'msg_x2', sessionID: 'ses_x', role: 'assistant' },
    parts: [{ id: 'prt_x2', type: 'text', text: 'SECOND' }]
  }
];

// background.js sendMessage()가 실제로 만드는 pageContext 프리픽스 형태
// (헤더 + 제목들 + 내용 요약 + 선택한 텍스트, 모두 존재하는 최대 케이스)
const PAGE_CONTEXT_FULL =
  '\n---\n현재 페이지 정보:\n- 제목: 예시 페이지\n- URL: https://example.com/\n' +
  '제목들:\n첫 번째 제목\n두 번째 제목\n\n' +
  '내용 요약:\n첫 문단\n두 번째 문단\n\n' +
  '선택한 텍스트:\n사용자가 드래그한 부분\n\n';

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

test('빈 세션(빈 배열) → 빈 결과', () => {
  assert.deepStrictEqual(extractMessages([]), []);
});

test('user/assistant 역할이 순서대로 보존된다', () => {
  const result = extractMessages(FIXTURE_SINGLE_TURN);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].role, 'user');
  assert.strictEqual(result[1].role, 'assistant');
});

test('assistant 메시지에서 step-start/step-finish는 제거되고 text만 합쳐진다', () => {
  const result = extractMessages(FIXTURE_SINGLE_TURN);
  assert.strictEqual(result[1].text, 'PONG');
});

test('user 메시지 텍스트가 그대로 보존된다', () => {
  const result = extractMessages(FIXTURE_SINGLE_TURN);
  assert.strictEqual(result[0].text, 'Reply with exactly the single word: PONG');
});

test('알 수 없는 role(system 등)은 결과에서 제외된다', () => {
  const withSystem = [{ info: { id: 's1', role: 'system' }, parts: [{ type: 'text', text: 'x' }] }, ...FIXTURE_SINGLE_TURN];
  const result = extractMessages(withSystem);
  assert.strictEqual(result.length, 2);
});

test('첨부파일 프리픽스가 있으면 attachments와 본문이 분리된다', () => {
  const userText = extractMessages(FIXTURE_ATTACHMENT_TURN)[0].text;
  const { text, attachments } = splitAttachmentBlock(userText);
  assert.strictEqual(text, 'Now reply with exactly the word: SECOND');
  assert.deepStrictEqual(attachments, ['/tmp/a.txt', '/tmp/b.txt']);
});

test('첨부파일 프리픽스가 없으면 원본 그대로 반환된다(attachments는 빈 배열)', () => {
  const { text, attachments } = splitAttachmentBlock('그냥 평범한 메시지입니다');
  assert.strictEqual(text, '그냥 평범한 메시지입니다');
  assert.deepStrictEqual(attachments, []);
});

test('첨부 프리픽스만 있고 본문이 빈 경우도 안전하게 처리된다', () => {
  const { text, attachments } = splitAttachmentBlock('[첨부 파일 — 필요 시 read 도구로 읽어 분석하세요]\n- /tmp/a.txt\n\n');
  assert.strictEqual(text, '');
  assert.deepStrictEqual(attachments, ['/tmp/a.txt']);
});

test('페이지 정보 프리픽스(헤더+제목들+내용 요약+선택한 텍스트)가 모두 제거되고 원문만 남는다', () => {
  const result = stripPageContext(PAGE_CONTEXT_FULL + '지금 워킹 폴더 위치 알려줘.');
  assert.strictEqual(result, '지금 워킹 폴더 위치 알려줘.');
});

test('페이지 정보 헤더만 있고 pageContent 섹션이 없는 경우도 처리된다', () => {
  const raw = '\n---\n현재 페이지 정보:\n- 제목: 예시\n- URL: https://example.com/\n원문 질문';
  assert.strictEqual(stripPageContext(raw), '원문 질문');
});

test('일부 섹션만 있는 경우(제목들 없음) 순서를 건너뛰고 정확히 제거된다', () => {
  const raw =
    '\n---\n현재 페이지 정보:\n- 제목: 예시\n- URL: https://example.com/\n' +
    '내용 요약:\n문단1\n\n' +
    '질문 내용';
  assert.strictEqual(stripPageContext(raw), '질문 내용');
});

test('페이지 정보 프리픽스가 없으면 원본을 그대로 반환한다', () => {
  assert.strictEqual(stripPageContext('그냥 평범한 메시지입니다'), '그냥 평범한 메시지입니다');
});

test('저장 순서(pageContext + attachmentBlock + 원문)대로 두 프리픽스를 순차 제거하면 원문과 첨부만 남는다', () => {
  const stored = PAGE_CONTEXT_FULL +
    '[첨부 파일 — 필요 시 read 도구로 읽어 분석하세요]\n- /tmp/a.txt\n\n실제 질문입니다';
  const { text, attachments } = splitAttachmentBlock(stripPageContext(stored));
  assert.strictEqual(text, '실제 질문입니다');
  assert.deepStrictEqual(attachments, ['/tmp/a.txt']);
});

if (process.exitCode !== 1) console.log('\n전체 통과');
