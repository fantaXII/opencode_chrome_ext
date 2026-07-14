// 순수 함수 모듈 — chrome API / fetch / DOM 의존 없음.
// background.js의 SSE switch(message.part.updated / message.part.delta)에서
// "이 이벤트로 무엇을 해야 하는가"만 결정하고, 실제 side effect(onChunk 호출,
// onPart 호출, debugLog, buffer 누적)는 호출자(background.js)가 수행한다.

export function createRouterState() {
  return { partTypes: new Map() }; // partId -> 'text' | 'tool' | 'reasoning' | (기타 원본 타입 문자열)
}

/**
 * message.part.updated 이벤트 처리.
 * @returns {null | {action:'track-text'} | {action:'part', part:object} | {action:'debug', partType:string}}
 *   null            → 무시 (다른 메시지의 파트)
 *   track-text      → 기존 textPartIds.add(part.id)와 동일한 의미, side effect 없음
 *   part            → onPart(part) 호출 필요
 *   debug           → 기존 debugLog('INFO', 'Non-text part...') 폴백 유지
 */
export function routeMessagePartUpdated(state, part, assistantMessageId) {
  if (!part || part.messageID !== assistantMessageId) return null;

  state.partTypes.set(part.id, part.type);

  if (part.type === 'text') {
    return { action: 'track-text' };
  }

  if (part.type === 'tool') {
    return {
      action: 'part',
      part: {
        kind: 'tool',
        id: part.id,
        tool: part.tool,
        status: part.state?.status,
        input: part.state?.input,
        output: part.state?.output,
        title: part.state?.title,
      },
    };
  }

  if (part.type === 'reasoning') {
    // reasoning 텍스트가 delta로 스트리밍된다는 가정(Phase 0 검증 대상).
    // updated 이벤트 시점엔 아직 텍스트가 없을 수 있으므로 시작 신호만 보낸다.
    return { action: 'part', part: { kind: 'reasoning-start', id: part.id } };
  }

  // 미지원 파트 타입(step-start 등) — 기존 폴백 동작 유지
  return { action: 'debug', partType: part.type };
}

/**
 * message.part.delta 이벤트 처리.
 * @returns {null | {action:'chunk', delta:string} | {action:'part', part:object}}
 *   null   → 추적되지 않는 partID (unknown, 또는 non-text/non-reasoning) → 무시
 *   chunk  → 기존 onChunk(delta) 호출 필요 (buffer 누적 포함, 호출자 책임)
 *   part   → onPart(part) 호출 필요 (reasoning delta)
 */
export function routeMessagePartDelta(state, props) {
  if (!props) return null;
  const type = state.partTypes.get(props.partID);

  if (type === 'text' && props.delta) {
    return { action: 'chunk', delta: props.delta };
  }

  if (type === 'reasoning' && props.delta) {
    return { action: 'part', part: { kind: 'reasoning-delta', id: props.partID, delta: props.delta } };
  }

  return null;
}
