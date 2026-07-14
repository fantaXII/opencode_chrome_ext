// 순수 상태 관리 모듈 — DOM 의존 없음. sidepanel.js는 이 블록 배열을 받아
// message-blocks 안의 실제 DOM 노드로 렌더링만 담당한다(별도 render 함수).
// 브라우저에서는 <script src="block-state.js"></script>로 로드해 전역 함수로 쓰고,
// Node 테스트에서는 module.exports로 동일 함수를 그대로 가져와 검증한다.

function createBlocks() {
  return [];
}

function appendTextDelta(blocks, delta) {
  const last = blocks[blocks.length - 1];
  if (last && last.type === 'text') {
    last.raw += delta;
  } else {
    blocks.push({ type: 'text', raw: delta });
  }
  return blocks;
}

function upsertToolPart(blocks, part) {
  const existing = blocks.find((b) => b.type === 'tool' && b.id === part.id);
  if (existing) {
    existing.tool = part.tool ?? existing.tool;
    existing.status = part.status ?? existing.status;
    existing.input = part.input ?? existing.input;
    existing.output = part.output ?? existing.output;
    existing.title = part.title ?? existing.title;
  } else {
    blocks.push({
      type: 'tool',
      id: part.id,
      tool: part.tool,
      status: part.status,
      input: part.input,
      output: part.output,
      title: part.title,
    });
  }
  return blocks;
}

function upsertReasoningStart(blocks, id) {
  const existing = blocks.find((b) => b.type === 'reasoning' && b.id === id);
  if (!existing) {
    blocks.push({ type: 'reasoning', id, text: '' });
  }
  return blocks;
}

function appendReasoningDelta(blocks, id, delta) {
  let block = blocks.find((b) => b.type === 'reasoning' && b.id === id);
  if (!block) {
    block = { type: 'reasoning', id, text: '' };
    blocks.push(block);
  }
  block.text += delta;
  return blocks;
}

function finalizeRunning(blocks, finalStatus) {
  for (const b of blocks) {
    if (b.type === 'tool' && (b.status === 'pending' || b.status === 'running')) {
      b.status = finalStatus;
    }
  }
  return blocks;
}

if (typeof module !== 'undefined') {
  module.exports = {
    createBlocks,
    appendTextDelta,
    upsertToolPart,
    upsertReasoningStart,
    appendReasoningDelta,
    finalizeRunning,
  };
}
