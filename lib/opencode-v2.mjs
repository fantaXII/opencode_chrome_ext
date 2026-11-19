/**
 * opencode 2.x(v2 API) 응답·이벤트를 1.x 모양으로 바꾸는 순수 함수 모듈 — chrome API / fetch 의존 없음.
 *
 * background.js의 스트림 처리(subscribeToEvents: 타임아웃·quiet check·재시도·대기 메시지·스냅샷)는 1.x 이벤트
 * (message.updated / message.part.updated / message.part.delta / session.status / session.idle / session.error)를
 * 기준으로 짜여 있다. v2 이벤트를 같은 모양으로 바꿔 넣으면 그 로직을 그대로 쓴다.
 * 형식은 opencode 2.3.2 실측(docs/opencode_v2_support_plan.md "0단계 실측 결과").
 */

// v2에서 이름이 바뀐 도구 → 1.x 이름. 사이드패널은 도구 이름·입력 필드로 표시를 정한다.
const TOOL_NAME_V1 = { shell: 'bash', subagent: 'task' };

export function v1ToolName(name) {
  return TOOL_NAME_V1[name] || name;
}

/** v2 도구 입력 → 1.x 필드 이름(사이드패널·subagent-progress가 읽는 이름)을 함께 채운다. */
export function v1ToolInput(name, input) {
  if (!input || typeof input !== 'object') return input ?? {};
  const out = { ...input };
  if (name === 'read' || name === 'write' || name === 'edit') {
    if (out.path && !out.filePath) out.filePath = out.path;
  }
  if (name === 'subagent' && out.agent && !out.subagent_type) out.subagent_type = out.agent;
  return out;
}

/** v2 도구 metadata → 1.x(하위 세션 연결 키는 1.x가 sessionId, v2가 sessionID). */
function v1ToolMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return metadata;
  return metadata.sessionID && !metadata.sessionId ? { ...metadata, sessionId: metadata.sessionID } : metadata;
}

/** 도구 결과 content([{type:'text', text}]) → 문자열 */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('');
}

function errorText(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  return error.message || error.data?.message || error.type || error.name || '';
}

/**
 * v2 권한 요청(permission.asked의 data, GET /api/permission/request 항목) → 1.x permission.asked properties.
 * v2 {id, sessionID, action, resources, save} — 응답값(once/always/reject)은 1.x와 같다(실측).
 */
export function v2PermissionToAsk(d) {
  if (!d?.id) return null;
  return {
    id: d.id,
    sessionID: d.sessionID,
    permission: d.action || d.permission || '',
    patterns: Array.isArray(d.resources) ? d.resources : (Array.isArray(d.patterns) ? d.patterns : []),
    always: Array.isArray(d.save) ? d.save : (Array.isArray(d.always) ? d.always : [])
  };
}

// 질문 카드로 그릴 수 있는 form 필드 종류(question 도구가 만드는 것. 실측)
const QUESTION_FIELD_TYPES = new Set(['string', 'multiselect']);

/**
 * v2 form(form.created의 data.form, GET /api/form 항목) → 1.x question.asked properties.
 * question 도구의 form(metadata.kind 'question')은 필드 하나가 질문 하나다: title→header, description→question,
 * options[{value,label,description}], type 'multiselect'→multiple, custom. 응답을 {answer:{<key>: …}}로 만들
 * 수 있게 필드 정보(fields)를 함께 둔다. 그 밖의 form(다른 필드 종류)은 확장에서 응답할 수 없어 unsupported로
 * 표시한다 — 사이드패널은 안내와 건너뛰기(거절)만 보인다.
 */
export function v2FormToAsk(form) {
  if (!form?.id) return null;
  const rawFields = Array.isArray(form.fields) ? form.fields : [];
  const supported = form.metadata?.kind === 'question' && rawFields.length > 0
    && rawFields.every((f) => f?.key && QUESTION_FIELD_TYPES.has(f.type || 'string'));
  const base = { id: form.id, sessionID: form.sessionID, v2Form: true, title: form.title || '' };
  if (!supported) {
    return { ...base, unsupported: true, questions: [], fields: [] };
  }
  const options = (f) => (Array.isArray(f.options) ? f.options : []).map((o) => ({
    label: o?.label ?? String(o?.value ?? ''),
    value: o?.value ?? o?.label ?? '',
    description: o?.description || ''
  }));
  return {
    ...base,
    questions: rawFields.map((f) => ({
      header: f.title || '',
      question: f.description || '',
      options: options(f).map(({ label, description }) => ({ label, description })),
      multiple: f.type === 'multiselect',
      custom: f.custom !== false
    })),
    fields: rawFields.map((f) => ({ key: f.key, multiple: f.type === 'multiselect', options: options(f).map(({ label, value }) => ({ label, value })) }))
  };
}

/**
 * 사이드패널의 답(질문 순서대로 고른 라벨·직접 입력 문자열 배열) → v2 form 응답 {<key>: value | [values]}.
 * 고른 라벨은 옵션 value로 바꾸고, 직접 입력은 그대로 보낸다. 한 개만 고르는 질문에 옵션과 직접 입력이 함께 오면
 * 직접 입력(사이드패널이 마지막에 넣는다)을 쓴다.
 */
export function v2FormAnswer(fields, answers) {
  const out = {};
  (fields || []).forEach((f, i) => {
    const picked = (Array.isArray(answers?.[i]) ? answers[i] : []).map(String);
    const values = picked.map((s) => f.options?.find((o) => o.label === s)?.value ?? s);
    if (f.multiple) out[f.key] = values;
    else if (values.length) out[f.key] = values[values.length - 1];
  });
  return out;
}

/** 목록 응답(배열 또는 {data:[…]}) → 배열 */
export function v2List(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data)) return body.data;
  return [];
}

// form이 응답 없이 끝난 이벤트(DELETE 후 이름은 실측하지 못했다 — form.replied만 확인)
const FORM_CLOSED_EVENTS = new Set(['form.cancelled', 'form.canceled', 'form.rejected', 'form.deleted', 'form.dismissed']);

const textPartId = (amid, ordinal) => `${amid}#text${ordinal ?? 0}`;
const reasoningPartId = (amid, ordinal) => `${amid}#reasoning${ordinal ?? 0}`;

/**
 * v2 SSE 이벤트(`data: {id, created, type, location, data, durable?}`)를 1.x 이벤트 목록으로 바꾼다.
 * 상태(세션별 현재 턴의 user 메시지 id, inbox 항목 종류, 도구 호출 상태)를 가진다 — 스트림마다 하나씩 만든다.
 *
 * - inbox 항목이 전달되면(session.inbox.delivered) 그것이 사용자 프롬프트(type 'user')일 때만 user
 *   message.updated를 만든다. 이후 assistant 메시지의 parentID가 이 id라서 1.x의 대기 메시지 처리(부모가 바뀌면
 *   새 턴)가 그대로 동작한다. 하위 에이전트 결과(type 'synthetic')는 같은 턴을 잇는 것으로 본다.
 * - 처리 완료는 session.execution.succeeded/interrupted → session.idle, failed → session.error.
 *   (v2는 session.status·session.idle을 보내지 않았다 — 실측.)
 */
export function createV2EventAdapter() {
  const parentOf = new Map();    // sessionID -> 현재 턴의 user 메시지 id
  const inboxType = new Map();   // inboxID -> 'user' | 'synthetic' | …
  const tools = new Map();       // tool call id -> { tool, name, input, messageID, sessionID, metadata }
  const textOpen = new Set();    // 이미 part.updated를 낸 텍스트·reasoning 파트 id

  function toolEvent(d, status, extra = {}) {
    const prev = tools.get(d.id) || { name: d.name, input: {}, messageID: d.assistantMessageID, sessionID: d.sessionID };
    const name = d.name || prev.name;
    const t = {
      ...prev,
      name,
      messageID: d.assistantMessageID || prev.messageID,
      sessionID: d.sessionID || prev.sessionID,
      input: d.input !== undefined ? v1ToolInput(name, d.input) : prev.input,
      metadata: d.metadata !== undefined ? v1ToolMetadata(d.metadata) : prev.metadata
    };
    tools.set(d.id, t);
    return partUpdated({
      id: d.id,
      type: 'tool',
      tool: v1ToolName(name),
      messageID: t.messageID,
      sessionID: t.sessionID,
      state: { status, input: t.input, ...(t.metadata !== undefined && { metadata: t.metadata }), ...extra }
    });
  }

  function partUpdated(part) {
    return { type: 'message.part.updated', properties: { sessionID: part.sessionID, part } };
  }

  function openPart(id, type, d) {
    if (textOpen.has(id)) return [];
    textOpen.add(id);
    return [partUpdated({ id, type, messageID: d.assistantMessageID, sessionID: d.sessionID })];
  }

  return {
    translate(raw) {
      const type = raw?.type;
      const d = raw?.data || {};
      const sid = d.sessionID;
      const busy = () => ({ type: 'session.status', properties: { sessionID: sid, status: { type: 'busy' } } });
      switch (type) {
        case 'server.connected':
          return [{ type: 'server.connected', properties: {} }];

        case 'session.created':
          return [{ type: 'session.created', properties: { sessionID: sid, info: { id: sid, parentID: d.parentID || undefined, agent: d.agent, title: d.title } } }];

        case 'session.inbox.enqueued':
          if (d.inboxID) inboxType.set(d.inboxID, d.item?.type || 'user');
          return [];

        case 'session.inbox.delivered': {
          const kind = inboxType.get(d.inboxID) || 'user';
          inboxType.delete(d.inboxID);
          if (kind !== 'user') return [busy()];
          parentOf.set(sid, d.inboxID);
          return [{ type: 'message.updated', properties: { sessionID: sid, info: { id: d.inboxID, sessionID: sid, role: 'user' } } }, busy()];
        }

        case 'session.execution.started':
          return [busy()];

        case 'session.step.started':
          return [
            {
              type: 'message.updated',
              properties: {
                sessionID: sid,
                info: {
                  id: d.assistantMessageID,
                  sessionID: sid,
                  role: 'assistant',
                  parentID: parentOf.get(sid) || undefined,
                  providerID: d.model?.providerID,
                  modelID: d.model?.id,
                  agent: d.agent
                }
              }
            },
            // 하위 에이전트 단계 수(lib/subagent-progress.mjs는 step-start 파트를 센다)
            partUpdated({ id: `${d.assistantMessageID}#step`, type: 'step-start', messageID: d.assistantMessageID, sessionID: sid }),
            busy()
          ];

        case 'session.step.first-token':
        case 'session.step.streamed':
          return [busy()];

        case 'session.text.started':
          return openPart(textPartId(d.assistantMessageID, d.ordinal), 'text', d);
        case 'session.text.delta': {
          const id = textPartId(d.assistantMessageID, d.ordinal);
          return [...openPart(id, 'text', d), { type: 'message.part.delta', properties: { sessionID: sid, messageID: d.assistantMessageID, partID: id, field: 'text', delta: d.delta } }];
        }

        case 'session.reasoning.started':
          return openPart(reasoningPartId(d.assistantMessageID, d.ordinal), 'reasoning', d);
        case 'session.reasoning.delta': {
          const id = reasoningPartId(d.assistantMessageID, d.ordinal);
          return [...openPart(id, 'reasoning', d), { type: 'message.part.delta', properties: { sessionID: sid, messageID: d.assistantMessageID, partID: id, field: 'text', delta: d.delta } }];
        }

        case 'session.tool.input.started':
          return [toolEvent(d, 'pending')];
        case 'session.tool.called':
          return [toolEvent(d, 'running')];
        case 'session.tool.progress':
          return [toolEvent(d, 'running')];
        case 'session.tool.success':
          return [toolEvent(d, 'completed', { output: contentText(d.content) })];
        case 'session.tool.failed':
          return [toolEvent(d, 'error', { output: contentText(d.content), error: errorText(d.error) })];

        case 'session.retry.scheduled':
          return [{ type: 'session.status', properties: { sessionID: sid, status: { type: 'retry', attempt: d.attempt, message: errorText(d.error), next: d.at } } }];

        case 'session.execution.succeeded':
        case 'session.execution.interrupted':
          return [{ type: 'session.idle', properties: { sessionID: sid, ...(type.endsWith('interrupted') && { interrupted: true, reason: d.reason }) } }];

        case 'session.execution.failed':
          return [{ type: 'session.error', properties: { sessionID: sid, error: { message: errorText(d.error) || '오류가 발생했습니다' } } }];

        // 권한·질문(form): background의 handleInteractionEvent가 1.x 이벤트로 처리한다.
        case 'permission.asked': {
          const ask = v2PermissionToAsk(d);
          return ask ? [{ type: 'permission.asked', properties: ask }] : [];
        }
        case 'permission.replied':
          return [{ type: 'permission.replied', properties: { sessionID: sid, requestID: d.requestID || d.id, reply: d.reply || d.decision } }];
        case 'form.created': {
          // 세션 id는 data.form.sessionID에 있다 — properties.sessionID로 올려야 세션 필터가 동작한다.
          const ask = v2FormToAsk(d.form || d);
          return ask ? [{ type: 'question.asked', properties: ask }] : [];
        }
        case 'form.replied':
          return [{ type: 'question.replied', properties: { sessionID: sid || d.form?.sessionID, requestID: d.formID || d.form?.id || d.id } }];

        default:
          if (FORM_CLOSED_EVENTS.has(type)) {
            return [{ type: 'question.rejected', properties: { sessionID: sid || d.form?.sessionID, requestID: d.formID || d.form?.id || d.id } }];
          }
          return [];
      }
    }
  };
}

/** GET /api/session/active의 data({sid: {type:'running'}}) → 1.x /session/status 모양({sid: {type:'busy'}}). */
export function v2ActiveToStatusMap(data) {
  const out = {};
  for (const [sid, st] of Object.entries(data || {})) {
    if (!st || st.type === 'idle') continue;
    out[sid] = { ...st, type: 'busy' };
  }
  return out;
}

/** assistant 메시지의 content[] 중 text를 잇는다. */
function assistantText(m) {
  return (m?.content || []).filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('');
}

/**
 * v2 대화 기록(오래된 순) → 사이드패널 형식 [{role, id, parentID, text}].
 * v2 기록에는 parentID가 없다. 턴은 순서로만 나뉘므로(user → assistant 여러 개 → idle) assistant의 parentID를
 * 바로 앞 user 메시지 id로 채운다(탭 전환 복원이 turnParentId로 진행 중 턴을 찾는다).
 */
export function flattenV2History(messages) {
  const out = [];
  let lastUser = null;
  for (const m of messages || []) {
    if (m?.type === 'user') {
      lastUser = m.id;
      out.push({ role: 'user', id: m.id, parentID: null, text: typeof m.text === 'string' ? m.text : '' });
    } else if (m?.type === 'assistant') {
      out.push({ role: 'assistant', id: m.id, parentID: lastUser, text: assistantText(m) });
    }
  }
  return out;
}

/**
 * 1.x fetchFallbackContent와 같은 결과를 v2 기록(최신순이든 오래된 순이든)에서 만든다.
 * 마지막 assistant 메시지(단계) 기준: { content, partTypes, lastMessageId, errorMessage, hasUnfinishedTool }
 */
export function v2FallbackFromMessages(messages) {
  const list = (messages || []).filter((m) => m?.type === 'assistant');
  if (!list.length) return { content: '', partTypes: [], lastMessageId: null };
  const last = list.reduce((a, b) => ((b.time?.created ?? 0) >= (a.time?.created ?? 0) ? b : a));
  const content = last.content || [];
  return {
    content: assistantText(last),
    partTypes: content.map((c) => c?.type),
    lastMessageId: last.id || null,
    errorMessage: errorText(last.error) || null,
    hasUnfinishedTool: content.some((c) => c?.type === 'tool' && ['pending', 'running', 'streaming'].includes(c.state?.status))
  };
}
