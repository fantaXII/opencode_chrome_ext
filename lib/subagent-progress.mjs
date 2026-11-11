// 순수 함수 모듈 — chrome API / fetch / DOM 의존 없음.
// task 도구가 띄운 하위(subagent) 세션의 이벤트를 요약해, 메인 세션의 task 도구 카드에 붙일 진행 상황을 만든다.
// 하위 에이전트가 수 분간 일해도 사이드패널에는 task 카드 하나만 "실행 중"으로 남아 멈춘 것처럼 보였기 때문이다.
//
// 연결 고리(opencode 1.19.4 실측): task 도구는 하위 세션을 만든 직후 자기 파트의
// state.metadata = { parentSessionId, sessionId: <하위 세션>, model }을 기록한다.
// 하위 세션이 다시 task를 쓰면(손자 세션) session.created의 parentID로 같은 카드에 합친다.

/**
 * @param {object} opts
 * @param {string} opts.rootSessionId  사이드패널이 보고 있는 본 세션
 * @param {() => number} [opts.now]
 */
export function createSubagentTracker({ rootSessionId, now = () => Date.now() }) {
  const toolOfSession = new Map();   // 하위·손자 세션 id → 본 세션 task 파트 id
  const rootOfSession = new Map();   // 손자 세션 id → 그 손자를 품은 최상위 하위 세션 id
  const progressByRoot = new Map();  // 최상위 하위 세션 id → 진행 상황
  const seenSteps = new Set();       // step-start 파트 id (중복 집계 방지)
  // 하위 세션의 어시스턴트 메시지 id. 하위 세션 첫 user 메시지(task 프롬프트)의 text 파트를
  // "응답 작성 중"으로 오인하지 않도록 text/reasoning은 어시스턴트 메시지 것만 센다(실측).
  const assistantMessages = new Set();

  function rootOf(sessionId) {
    return rootOfSession.get(sessionId) || sessionId;
  }

  function progressFor(rootId) {
    let p = progressByRoot.get(rootId);
    if (!p) {
      p = { sessionId: rootId, agent: null, steps: 0, activity: null, startedAt: now() };
      progressByRoot.set(rootId, p);
    }
    return p;
  }

  // 사이드패널로 보낼 형태. toolId가 아직 연결되지 않았으면 null(연결될 때 한꺼번에 보낸다).
  function snapshot(rootId) {
    const toolId = toolOfSession.get(rootId);
    const p = progressByRoot.get(rootId);
    if (!toolId || !p) return null;
    return {
      kind: 'subagent',
      toolId,
      sessionId: rootId,
      agent: p.agent,
      steps: p.steps,
      activity: p.activity ? { ...p.activity } : null,
      startedAt: p.startedAt
    };
  }

  return {
    /**
     * 본 세션의 message.part.updated. task 파트가 하위 세션 id를 알려 주면 연결한다.
     * @returns 연결 직후 보낼 진행 상황(이미 쌓인 것이 있으면) 또는 null
     */
    onRootPart(part) {
      if (part?.type !== 'tool' || part.tool !== 'task' || part.sessionID !== rootSessionId) return null;
      const childId = part.state?.metadata?.sessionId;
      if (!childId || toolOfSession.get(childId) === part.id) return null;
      toolOfSession.set(childId, part.id);
      const p = progressFor(childId);
      if (!p.agent && part.state?.input?.subagent_type) p.agent = part.state.input.subagent_type;
      return snapshot(childId);
    },

    /** session.created/updated: 손자 세션을 최상위 하위 세션에 묶고, 에이전트 이름을 기록한다. */
    onSessionInfo(info) {
      if (!info?.id) return null;
      if (info.parentID && info.parentID !== rootSessionId && (toolOfSession.has(info.parentID) || rootOfSession.has(info.parentID) || progressByRoot.has(info.parentID))) {
        const root = rootOf(info.parentID);
        rootOfSession.set(info.id, root);
        const tool = toolOfSession.get(root);
        if (tool) toolOfSession.set(info.id, tool);
        return null;
      }
      if (info.parentID === rootSessionId && info.agent) {
        const p = progressFor(info.id);
        if (p.agent === info.agent) return null;
        p.agent = info.agent;
        return snapshot(info.id);
      }
      return null;
    },

    /** 하위·손자 세션의 message.updated: 어시스턴트 메시지 id를 기억한다. */
    onChildMessage(info) {
      if (info?.role === 'assistant' && info.id && info.sessionID !== rootSessionId) assistantMessages.add(info.id);
    },

    /**
     * 하위·손자 세션의 message.part.updated. 진행 상황이 바뀌었을 때만 스냅샷을 돌려준다
     * (delta마다 보내지 않는다 — 단계·활동이 바뀔 때만).
     */
    onChildPart(part) {
      if (!part?.sessionID || part.sessionID === rootSessionId) return null;
      const rootId = rootOf(part.sessionID);
      const p = progressFor(rootId);
      let activity = p.activity;
      if (part.type === 'step-start') {
        if (seenSteps.has(part.id)) return null;
        seenSteps.add(part.id);
        p.steps += 1;
        activity = { type: 'thinking' };
      } else if (part.type === 'tool') {
        const status = part.state?.status;
        activity = (status === 'pending' || status === 'running')
          ? { type: 'tool', tool: part.tool || 'tool' }
          : { type: 'thinking' };
      } else if (part.type === 'reasoning' && assistantMessages.has(part.messageID)) {
        activity = { type: 'thinking' };
      } else if (part.type === 'text' && assistantMessages.has(part.messageID)) {
        activity = { type: 'writing' };
      } else {
        return null;
      }
      const changed = part.type === 'step-start' || JSON.stringify(activity) !== JSON.stringify(p.activity);
      p.activity = activity;
      return changed ? snapshot(rootId) : null;
    }
  };
}
