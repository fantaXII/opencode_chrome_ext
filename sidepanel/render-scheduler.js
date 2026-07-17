// 순수 상태 관리 모듈 — DOM 의존 없음. block-state.js와 동일하게 브라우저에서는
// <script src="render-scheduler.js"></script>로 로드해 전역 함수로 쓰고,
// Node 테스트에서는 module.exports로 동일 함수를 그대로 가져와 검증한다.
//
// requestAnimationFrame 코얼레싱: 짧은 시간에 여러 번 request()가 호출돼도
// 실제 render는 프레임당 최대 1회만 실행되게 한다(스트리밍 delta로 인한
// O(n^2) 마크다운 재파싱 방지 — docs/copy_markdown_enhancement_plan.md #4).

function createRenderScheduler({ render, requestFrame, cancelFrame }) {
  let handle = null;

  function request() {
    if (handle !== null) return;
    handle = requestFrame(() => {
      handle = null;
      render();
    });
  }

  function flush() {
    if (handle !== null) {
      cancelFrame(handle);
      handle = null;
    }
    render();
  }

  function isPending() {
    return handle !== null;
  }

  return { request, flush, isPending };
}

function extractLangFromClassName(className) {
  const m = /language-(\S+)/.exec(className || '');
  return m ? m[1] : '';
}

if (typeof module !== 'undefined') {
  module.exports = { createRenderScheduler, extractLangFromClassName };
}
