# opencode 2.x 지원 계획

## Context

opencode 2.x(2.3.2 실측)는 서버 API를 통째로 바꿨다. 경로는 `/api/` 아래로 옮겨졌고, 인증(Basic, `OPENCODE_SERVER_PASSWORD`)이 생겼으며, 이벤트는 파트 단위(`message.part.*`)에서 이벤트 소싱(`session.text.delta`, `session.tool.*`…)으로, 질문은 form으로, 대기 메시지는 inbox로 바뀌었다. 지금 확장은 2.x를 감지만 하고(`isUnsupportedApiServer`) `opencode upgrade 1.19.5`를 안내한다.

목표는 **1.x와 2.x를 모두 지원하고, 2.x에서도 1.x와 같은 기능을 제공하는 것**이다. 1.x 경로는 그대로 둔다(사용자 환경의 oh-my-openagent는 2.x에서 동작하지 않아 1.x가 계속 주 환경이다).

결정 사항:
- 범위: 1.x와 동등한 전체 기능(단계별로 개발하되, 동등해진 뒤 릴리스).
- 서버: 지금처럼 **확장 전용 `opencode serve --port N`**. v2 background service(`opencode service`)는 쓰지 않는다. 강제 재시작이 TUI 작업까지 끊기 때문이다.

## 설계 원칙

1. **사이드패널은 바꾸지 않는다(최대한).** 사이드패널은 이미 background가 정규화한 `kind` 객체(`chunk`, `tool`, `reasoning-*`, `permission`, `question`, `subagent`, `retry`, `turn-start`, `heartbeat`)와 평탄화한 목록(세션·기록·모델·명령·에이전트·MCP)만 받는다. v2 차이는 background에서 흡수한다.
2. **API 버전은 포트별로 판별한다.** 연결할 때 `checkServerHealth`가 `apiVersion: 'v1'|'v2'`를 정하고 `serverState.apiVersion`에 둔다. 기존 `isUnsupportedApiServer`를 판별 함수로 바꾼다(`/api/info`의 `version`).
3. **어댑터 계층.** 인라인 `fetch` 약 31곳을 `lib/opencode-api.mjs`의 버전별 어댑터 메서드로 모은다. 1.x 어댑터는 지금 코드를 그대로 옮긴 것이다(동작 변화 없음).

## v1 → v2 대응표 (OpenAPI `packages/protocol/openapi.json@v2.3.2`)

| 기능 | v1 (현재) | v2 |
|---|---|---|
| health | `GET /global/health` | `GET /api/info` → `{version, pid}` |
| 세션 생성 | `POST /session` + `x-opencode-directory` | `POST /api/session {title, location:{directory}, agent?, model?}` → `{data: Session.Info}` |
| 세션 조회/폴더 | `GET /session/{id}` `.directory` | `GET /api/session/{id}` `.location.directory` |
| 세션 목록 | `GET /session?roots=true&limit=1000` | `GET /api/session?directory=&limit=&cursor=` → `{data, cursor}` (페이지네이션, root 필터 = `parentID` 없음) |
| 전송 | `POST /session/{id}/prompt_async {model, parts}` | `POST /api/session/{id}/prompt {text, files, delivery?}` → inbox 항목 |
| 대기 메시지 | busy 중 prompt → 서버 큐 | 같은 prompt + `delivery:'queue'`, `session.inbox.enqueued/delivered/cancelled` |
| 중단 | `POST /session/{id}/abort` | `POST /api/session/{id}/interrupt` |
| 상태 | `GET /session/status` (폴더 instance별) | `GET /api/session/active` (`{<id>:{type:'running'}}`) + `session.execution.started/succeeded/failed/interrupted` |
| 기록 | `GET /session/{id}/message` `{info, parts}` | `GET /api/session/{id}/message` → `{data:[Session.Message.*], cursor}` |
| SSE | `GET /global/event` `{directory, payload}` | `GET /api/event` `{id, created, type, location, data, durable?}` (V2Event 100종, 세션 필터·재전송 없음) |
| 권한 | `permission.asked` / `POST /permission/{id}/reply {reply}` | `permission.asked {id, sessionID, action, resources, save}` / `POST /api/session/{sid}/permission/{rid}/reply {decision, message?}` |
| 질문 | `question.asked` / `/question/{id}/reply` | `form.created {form}` / `POST /api/session/{sid}/form/{fid}/reply {answer}`, 취소 `DELETE …/form/{fid}` |
| 대기 중 요청 목록 | `GET /permission`, `/question` | `GET /api/permission/request`, `GET /api/form` |
| 모델 목록/변경 | `/config/providers`, 전역 `PATCH /config` | `GET /api/model`(+`/api/provider`), 세션별 `POST /api/session/{id}/model` |
| 에이전트 | `GET /agent`, `PATCH /session/{id} {agent}` | `GET /api/agent`, `POST /api/session/{id}/agent` |
| 명령 | `GET /command`, `POST /session/{id}/command` | `GET /api/command`, `POST /api/session/{id}/command` (skill은 `/api/skill` 별도) |
| MCP | `GET /mcp`, `/mcp/{n}/connect` | `GET /api/mcp`, `POST /api/experimental/mcp/{n}/connect` |
| 소프트 재시작 | `POST /global/dispose` | `POST /api/location/reload` |

스트림 이벤트 대응(v2 → 기존 `onPart` kind):
- `session.text.started/delta/ended` → 텍스트 `chunk`(키 = `assistantMessageID`+`ordinal`)
- `session.reasoning.*` → `reasoning-start/delta`
- `session.tool.input.started` / `called` / `progress` / `success` / `failed` → `tool` (`pending`/`running`/`completed`/`error`, `input`·`content`·`metadata`)
- `session.step.started` → 턴/단계 시작(하위 에이전트 단계 수), `session.step.failed` → 오류
- `session.retry.scheduled {attempt, at, error}` → `retry`
- `session.execution.succeeded` → 완료, `failed` → 오류 문구, `interrupted` → 중단 (`session.status`·`session.idle`은 실측에서 한 번도 오지 않았다)
- `session.created {parentID}` + 부모의 `session.tool.progress {metadata.sessionID}` → 하위 세션 추적(`lib/subagent-progress.mjs`)
- `form.created` → `question`, `permission.asked` → `permission`
- `session.inbox.delivered` → `turn-start`(대기 메시지 소비). 항목 종류가 `synthetic`(하위 에이전트 결과)이면 사용자 말풍선 없이 새 응답 말풍선만 연다

## 단계

### 0단계: 실측 스파이크 (코드 변경 없음) — 완료, 결과는 아래 "0단계 실측 결과" 절
`~/.opencode/bin/opencode-2.3.2.bak serve --port 4110`을 비밀번호와 함께 따로 띄워(1.19.6 서버와 별개) 다음을 확인하고 이 문서에 "실측" 절로 남긴다. 확인할 것:
- SSE 프레임 형식(`event:`/`data:`/`id:`, 재연결 `Last-Event-ID`), 세션 필터가 있는지(없으면 클라이언트에서 `sessionID`로 거른다)
- `location` 지정 방식(세션 생성 시 `{directory}`만으로 되는지, Windows 경로·WSL 경로), 없는 폴더일 때 `LocationNotFoundError`
- 한 턴의 실제 이벤트 순서(텍스트·도구·권한·form·하위 에이전트·retry·대기 메시지)
- `/api/session/{id}/message` 항목 형식과 user/assistant 연결(`parentID` 대응)
- 1.x 세션이 2.x에서 보이는지(`/api/experimental/migration/v1`), 1.x·2.x 서버가 동시에 같은 DB를 쓰는지
- 비밀번호 출력 형식(stdout `server password …`), 비밀번호를 env로 고정했을 때 출력 여부
- 1.19.6에 `OPENCODE_SERVER_PASSWORD`를 주고 띄웠을 때: 인증이 걸리는 경로(전 경로인지, `/global/health`도인지), 401 응답 형식, SSE(`/global/event`)에도 Basic이 필요한지, 사용자 이름(`opencode`)이 같은지
- 확장 SW `fetch`에 CORS 문제가 없는지(`host_permissions`로 충분한지)

### 0단계 실측 결과 (2026-11-19, WSL, opencode 2.3.2 / 1.19.6)

방법: 2.3.2를 4110, 1.19.6을 4111 포트에 각각 `OPENCODE_SERVER_PASSWORD`를 주고 따로 띄움. 모델은 무료 기본 모델(`opencode/tidepool-alpha-free`). 테스트 세션은 끝난 뒤 모두 지웠다.

**인증**
- 2.3.2: env로 비밀번호를 주면 stdout에 `server listening on http://127.0.0.1:4110` 한 줄만 나오고 **비밀번호는 출력되지 않는다**. 인증 없는 `/api/*`는 401 + `www-authenticate: Basic` + `{"_tag":"UnauthorizedError","message":"Authentication required"}`. 예전 경로(`/global/health`)는 인증과 무관하게 200 웹 UI HTML.
- 1.19.6: 같은 env로 **모든 경로**(`/global/health`, `/session/status`, `/global/event`)에 Basic Auth가 걸린다. 401 본문은 비어 있다. 사용자 이름은 `opencode`(다른 이름은 401). 인증하면 `{"healthy":true,"version":"1.19.6"}`.
- 비밀번호를 env로 고정하면 log 마스킹은 방어용으로만 남겨도 된다(출력되는 경로가 없다).
- CORS: 두 버전 모두 preflight에 `access-control-allow-headers: authorization`으로 204를 주지만 `chrome-extension://` origin에 `allow-origin`은 주지 않는다. SW의 `fetch`는 `host_permissions`(127.0.0.1:4096–4105)로 CORS를 우회하므로 문제없다(지금과 같다).

**서버 정보**: `GET /api/info` → `{version:"2.3.2", pid, hostname, urls, paths, capabilities}`. 버전 판별에 충분하다.

**location(작업 폴더)**
- 세션 생성 `POST /api/session {title, location:{directory}}` → `{data:{id, projectID, title, time, location:{directory}, …}}`.
- 폴더 지정은 쿼리 `location[directory]=<경로>`(deepObject)와 **예전 헤더 `x-opencode-directory`가 둘 다 동작**한다. 지정하지 않으면 서버 cwd.
- **없는 폴더로도 세션이 200으로 만들어진다.** `GET /api/location`만 `LocationNotFoundError`를 준다. 그래서 `set-working-directory`의 host `resolve-directory` 확인은 v2에서도 그대로 필요하다.
- 대기 중 권한·form 목록(`/api/permission/request`, `/api/form`)은 **location별**이다. 다른 폴더로 물으면 빈 목록. → 1.x처럼 세션 폴더(`getSessionDirectory`)를 붙여 묻는다.
- Windows 경로(`C:\…`)는 WSL에서 확인하지 못했다(Windows native 서버에서 따로 확인).

**SSE (`GET /api/event`)**
- 프레임은 `data: {json}\n\n`만 온다. **`id:` 줄이 없고** 이벤트 id는 JSON의 `id`(`evt_…`). 주석 `: heartbeat`가 주기적으로 온다. 첫 이벤트는 `server.connected`.
- 이벤트 형식: `{id, created, type, location:{directory}, data:{sessionID, …}, durable?:{aggregateID, seq, version}}`. delta 이벤트에는 `durable`이 없다.
- **세션 필터가 없다.** 모든 세션·폴더의 이벤트가 한 스트림에 섞여 온다 → 클라이언트에서 `data.sessionID`(+하위 세션)로 거른다(지금 1.x 처리와 같다). `?types=`로 종류를 거를 수 있다.
- **`Last-Event-ID`를 줘도 놓친 이벤트를 다시 보내지 않는다.** 재연결 뒤에는 `/api/session/active`와 대화 기록으로 상태를 맞춘다(지금 1.x의 `checkIdleAfterReconnect`와 같은 방식).

**한 턴의 이벤트 순서** (도구 1회 + 답변)
```
session.inbox.enqueued → session.execution.started → session.instructions.updated
→ session.inbox.delivered (= 턴 시작)
→ session.step.started {assistantMessageID A, agent, model}
→ session.step.first-token → session.reasoning.started/delta…
→ session.tool.input.started {id, name} → session.reasoning.ended
→ session.tool.input.ended → session.tool.called {input}
→ session.step.streamed → session.tool.success {content:[{type:'text',text}], metadata}
→ session.step.ended {finish:'tool-calls'} → session.usage.updated
→ session.step.started {assistantMessageID B} → … session.text.started/delta…/ended
→ session.step.ended {finish:'stop'} → session.execution.succeeded
```
- 단계(step)마다 assistant 메시지 id가 새로 생긴다. 텍스트·reasoning은 `(assistantMessageID, ordinal)`로 구분.
- 권한이 필요한 도구는 `session.tool.called` 다음에 `permission.asked`가 오고, 응답 뒤 `permission.replied` → `session.tool.progress` → `session.tool.success`.
- `POST /api/session/{id}/prompt`는 바로(약 40ms) 200과 inbox 항목 `{id, type:'user', payload:{text}, delivery}`을 돌려준다(비동기).
- `/api/session/active`는 실행 중일 때 `{data:{<sessionID>:{type:'running'}}}`, 끝나면 `{data:{}}`. 권한·질문을 기다리는 동안에도 `running`.

**대기 메시지(inbox)**: 실행 중에 `delivery:"queue"`로 보내면 `session.inbox.enqueued`가 오고, 현재 응답의 `step.ended {finish:'stop'}` 뒤에 `session.inbox.delivered`로 다음 턴이 시작된다. **`execution.succeeded`는 큐가 빈 뒤 한 번만** 온다(1.x와 같다). `delivery`를 생략하면 `steer`다. steer는 실행 중인 턴에 끼워 넣는 방식이라 1.x 대기 메시지와 다르다 → 확장은 항상 `queue`를 명시한다.

**중단**: `POST /api/session/{id}/interrupt` → `{"interrupted":true}`. 이벤트는 `session.step.failed` → `session.execution.interrupted {reason:'user'}`. 기록에는 assistant `{finish:'error', error:{type:'aborted', message:'Step interrupted'}}` + `idle {outcome:'interrupted'}`.

**대화 기록 (`GET /api/session/{id}/message`)**
- `{data:[…], cursor:{previous, next}}`, **기본 정렬이 최신순(desc)**. `?order=asc` 가능.
- 항목 종류: `user {id, text, time}`, `assistant {id, agent, model, content[], finish, rawFinish, cost, tokens, time, error?}`, `idle {id, outcome:'succeeded'|'interrupted'|…}`.
- assistant `content[]`: `reasoning {text}`, `text {text}`, `tool {id, name, state:{status, input, content[], metadata}, time}`.
- **`parentID`가 없다.** 턴은 순서로만 나뉜다: `user` → assistant 여러 개 → `idle`. 탭 전환 복원의 `turnParentId`는 "마지막 user 메시지 id"로 바꿔 계산해야 한다.

**권한**
- 기본 build 에이전트는 모든 동작을 허용한다(작업 폴더 밖 파일 읽기도 묻지 않았다). 세션의 `permissions` 규칙(`[{action, resource, effect:'ask'}]`)이나 설정으로 `ask`가 걸릴 때만 요청이 온다.
- `permission.asked.data`: `{id:'per_…', sessionID, action:'shell', resources:['echo spike-bash'], save:['echo *'], source:{type:'tool', messageID, id}}`. → 카드의 `permission`=`action`, `patterns`=`resources`, `always`=`save`.
- 응답 `POST /api/session/{sid}/permission/{rid}/reply {decision:'once'|'always'|'reject'}` → 204, `permission.replied {requestID, reply}`.

**질문(form)**
- question 도구는 `form.created {form:{id:'frm_…', sessionID, title:'Questions', metadata:{kind:'question', tool:{messageID, id}}, fields:[…]}}`를 만든다.
- 필드: `{key:'q0', title(=header), description(=질문), type:'string', options:[{value, label, description}], custom:true}`. 여러 개 고르기는 `type:'multiselect'`. → 기존 질문 카드로 바로 대응된다. `metadata.kind`가 `question`이 아닌 form(다른 필드 종류)만 따로 처리하면 된다.
- 응답 `POST /api/session/{sid}/form/{fid}/reply {answer:{q0:'Blue'}}` → 204, `form.replied`. 목록은 `GET /api/form`(location별).

**하위 에이전트**
- 도구 이름이 `task`가 아니라 **`subagent`**다(입력 `{agent, description, prompt}`).
- 연결 키: 하위 세션의 `session.created {parentID}`와, 부모 도구의 `session.tool.progress {id, metadata:{sessionID, status:'running'}}`.
- **백그라운드 실행**: `subagent` 도구는 바로 `session.tool.success`("working in the background")로 끝나고, 부모는 다음 단계로 넘어간다. 하위 세션이 끝나면 결과가 부모 inbox에 `synthetic` 항목(`<subagent sessionID=… state="completed">…</subagent>`)으로 들어오고, 부모가 `session.inbox.delivered` 뒤 새 단계로 답한다. 부모의 `execution.succeeded`는 그 뒤에 온다. → 진행 표시는 도구 카드가 끝난 뒤에도 하위 세션 이벤트로 계속 갱신해야 하고, synthetic 턴은 사용자 말풍선 없이 그린다.

**도구 이름**: bash가 **`shell`**(`input.command`, `metadata.exit`)로 바뀌었다. read는 `read`(`input.path`, 1.x는 `filePath`), question은 `question`. 사이드패널의 도구 표시(`input.command`·`input.path`·`input.filePath`)와 webfetch 폴백(`webfetch` 이름·`input.url`)은 v2 이름 대응표가 필요하다 → 나머지 도구(edit/write/webfetch/grep 등) 이름은 1단계에서 실제 호출로 확인한다.

**목록 API**
- `GET /api/agent` → 배열 `{id, name, description, mode:'primary'|…, hidden, permissions}` (1.x의 `name` 대신 `id`가 키).
- `GET /api/command` → `{name, description}` 배열(3개), `GET /api/skill` → `{id, name, description}` 배열(16개). skill이 명령 목록과 분리됐다.
- `GET /api/mcp` → `{location, data:[]}`(사용자 설정에 MCP가 없어 빈 목록. 항목 형식은 MCP가 있는 환경에서 확인).
- `GET /api/plugin` → oh-my-openagent가 `state:'active'`로 보인다(실제로는 기능이 꺼져 있다 — 플러그인 안내 참고).
- `GET /api/session?directory=…` → 하위 세션도 함께 나온다(`parentID`로 구분해 root만 고른다). `{data, cursor}` 페이지네이션.
- 세션별 변경: `POST /api/session/{id}/model {model:{id, providerID}}` → 204(세션 `model`에 `variant:'default'`가 붙음), `POST /api/session/{id}/agent {agent}` → 204. `POST /api/location/reload` → 204.
- `GET /api/model` 76개, `GET /api/model/default` → 기본 모델 하나. 모델 항목은 `{id, providerID, name, cost, limit, variants[], enabled, status}` — `providerID`로 묶어 기존 `providers[]` 형식을 만든다.

**1.x·2.x 데이터 공유**: **실시간으로 공유하지 않는다.** 1.19.6에서 만든 세션은 2.3.2에서 `SessionNotFoundError`, 반대도 `NotFoundError`. 2.x는 처음 실행될 때 1.x 세션을 한 번 복사했다(`/api/experimental/migration/v1` → `{"status":"completed"}`, 그 시점까지의 1.x 세션은 2.x에 보인다). → 사용자가 1.x↔2.x를 오가면 `/sessions` 목록·최근 폴더가 달라진다. 확장에 저장한 세션 id(`tabSessions` 등)는 서버 버전이 바뀌면 무효가 될 수 있으므로 404를 새 세션 생성으로 처리한다(지금 `checkSessionExists`와 같은 경로).

**확인하지 못한 것**: 제공자 재시도(`session.retry.scheduled`, 재현 어려움 — 스키마 `{attempt, at, error}`로만 구현), Windows native 2.x 서버의 경로 형식, MCP 항목 형식, `/api/location/reload`가 전역 설정을 다시 읽는지, 하위 에이전트 안에서 뜬 권한 요청의 `sessionID`.

### 1단계: 기반 — 어댑터·판별·인증
- **`lib/opencode-api.mjs`(신규)**: `createApi({port, apiVersion, password})` → `health`, `createSession`, `getSession`, `listSessions`, `prompt`, `interrupt`, `status`, `messages`, `events`, `replyPermission`, `replyQuestion`, `rejectQuestion`, `pending`, `models`, `setModel`, `agents`, `setAgent`, `commands`, `runCommand`, `mcp`, `toggleMcp`, `reload`. v1 구현은 `background.js`의 현재 요청을 그대로 옮긴다(`buildDirectoryHeader`·`sessionDirectoryHeaders` 재사용). v2는 `/api` + `Authorization: Basic base64("opencode:"+pw)`.
- **판별**: `checkServerHealth`가 v1 health 실패 시 `/api/info`로 `apiVersion:'v2'`를 돌려준다(기존 `isUnsupportedApiServer` 대체). `serverState.apiVersion` 저장. 거부 로직(`unsupportedServer`, `UNSUPPORTED_RETRY_COOLDOWN_MS`, `opencode-unsupported`, 사이드패널 `showUnsupportedOpencodeGuide`)은 v2 지원이 완성되는 단계에서 제거한다. 그 전까지는 플래그(`V2_ENABLED`)로 막아 둔다.
- **401 처리**: 지금 `checkServerHealth`는 401을 `authRequired`로 보고 그 서버를 건너뛴다. 비밀번호를 쓰면 확장이 띄운 1.x 서버도 401을 주므로, 알고 있는 비밀번호(`storage.session` 또는 `server-info`)로 Basic을 붙여 한 번 더 묻는다. 그래도 401이면 지금처럼 다른 프로그램의 서버로 보고 건너뛴다. `scanHealthyPorts`·`waitForServer`·`periodicServerCheck`가 모두 같은 경로를 탄다.
- **비밀번호**: host가 `start`/`restart` 때 무작위 비밀번호를 만들어 env `OPENCODE_SERVER_PASSWORD`로 넘긴다(WSL은 `buildProxyEnv`처럼 `WSLENV`에 추가. `--exec env PW=…`는 로그된 인자에 남으므로 쓰지 않는다). `server.json`(`recordServerListener`)에 저장하고 `start`/`restart`/`server-info` 응답으로 돌려준다. background는 `storage.session`에 둔다(SW 재시작 대비, 브라우저 재시작 시에는 `server-info`로 다시 받는다). **1.x도 이 변수로 Basic Auth를 켠다**(1.x 문서 `docs/v1/content/web.mdx`). 그래서 비밀번호는 버전과 무관하게 항상 넘기고, **v1 어댑터에도 Basic 헤더를 붙인다.** 서버 버전을 모르는 시점(health·판별)에도 헤더를 붙여 보낸다. 인증이 없는 서버는 헤더를 무시하므로 해가 없다. SSE도 `fetch`로 읽으므로 같은 헤더를 붙일 수 있다. 1.19.6은 env를 받으면 모든 경로(health·SSE 포함)에 인증을 건다(실측).
- **host 수정**: `checkOpenCodeServer`는 지금 `statusCode===200`만 "살아 있음"으로 본다. 비밀번호가 걸린 1.x 서버는 `/global/health`에 401을 주므로, 그대로 두면 host가 포트가 비었다고 보고 같은 포트에 서버를 또 띄우거나(`findAvailablePort`), 시작 대기·`stop` 확인(`waitForPortFree`)을 잘못 판단한다. **200·401 모두 "살아 있음"**으로 바꾼다(200 HTML인 v2도 계속 살아 있음). stdout 로그에서 비밀번호를 가린다(`maskProxyValue` 방식). 실측상 env로 준 비밀번호는 출력되지 않으므로 방어용이다. host가 바뀌므로 `MIN_HOST_VERSION`이 릴리스 때 자동으로 올라간다(`scripts/sync-host-version.js`). 구버전 host(비밀번호 미지원)로 v2 서버를 띄운 경우는 인증 실패 → "host 업데이트 필요" 안내.
- `background.js`의 인라인 fetch를 모두 어댑터 호출로 바꾼다. v1 동작은 기존 테스트 전부 통과로 확인.

### 2단계: 대화 흐름
- 세션 생성/조회/폴더(`getSessionDirectory`, `createSession`, `set-working-directory`의 `resolve-directory` 유지)
- 전송·중단·SSE: `subscribeToEvents`의 이벤트 해석을 버전별로 분리. **`lib/event-router-v2.mjs`(신규)**가 V2Event를 받아 기존 `onPart` kind와 완료/오류 신호로 바꾼다(`lib/part-router.mjs`와 같은 역할). 타임아웃 리셋·quiet check(`checkQuiet`)·재연결 후 idle 확인은 어댑터의 `status`로.
- SW 재시작 복구: `lib/sw-resilience.mjs`의 `recoverPendingPrompt`가 `fetchFn` 대신 어댑터 `status`/`messages`를 받게.
- 기록: `getSessionHistory`·`fetchFallbackContent`가 v2 메시지(최신순이므로 `order=asc`, 커서로 끝까지)를 `{role, id, parentID, text}`로 평탄화한다. v2에는 `parentID`가 없으므로 **assistant의 `parentID`를 바로 앞 user 메시지 id로 채운다**. `idle` 항목은 버리되 `outcome:'interrupted'`면 중단 표시. 사이드패널 `parsePageContext` 그대로 사용.
- 탭 전환 복원(`controller.snapshot()`, `turnParentId`): `turnParentId`를 `session.inbox.delivered`의 `inboxID`(= user 메시지 id)로 정한다. synthetic 턴은 inboxID가 기록의 user 메시지와 맞지 않으므로 직전 user 기준으로 묶는다.
- 완료 판정: `session.execution.succeeded/failed/interrupted`만 쓴다(`session.status`·`session.idle`은 오지 않았다). quiet check·재연결 후 확인은 `/api/session/active`에 세션이 없으면 idle.
- 전송은 항상 `delivery`를 명시한다(평소 `queue`, 기본값 `steer`는 실행 중 턴에 끼워 넣는다).

### 3단계: 상호작용
- 권한 카드: `permission.asked`의 `action`/`resources`/`save` → 사이드패널이 쓰는 `permission`/`patterns`/`always`로 변환. 응답값은 1.x와 같은 `once`/`always`/`reject`(실측).
- 질문: `metadata.kind:'question'` form은 필드마다 기존 질문 하나로 변환한다(`title`→`header`, `description`→`question`, `options[].label/description`, `type:'multiselect'`→`multiple`, `custom`). 응답은 `{answer:{<key>: label | [labels]}}`. 그 밖의 form(boolean/number/external 필드)은 1차에서 "TUI에서 응답" 안내 + 거절 버튼만 둔다.
- 대기 메시지: `queue-message`는 `delivery:'queue'`로 보내고, `session.inbox.delivered`의 `inboxID`로 대기 말풍선을 찾아 `turn-start`를 보낸다(1.x의 "user 메시지 id 순서로 부모 찾기"보다 단순하다). 큐가 빈 뒤 완료가 한 번만 오는 점은 1.x와 같아서 `QUEUE_IDLE_GRACE_MS` 처리는 그대로 둔다.
- `get-pending-interactions`(재오픈 시 카드 복원).

### 4단계: 나머지 기능
- 모델: `/api/model` 목록 → 기존 `providers[]` 형식으로 변환. v2는 **세션별 모델**이므로 `setModel`은 현재 세션에 적용하고, 새 세션 생성 시 선택 모델을 `model`로 넘긴다(전역 기본값은 `chrome.storage.local`에 둠).
- 에이전트(`/api/agent`의 `id`를 `name`으로)·명령·skill(`/api/skill`을 명령 목록에 합침)·MCP 목록/토글(experimental 경로)·소프트 재시작(`/api/location/reload`, 전역 설정 반영 여부 실측).
- 폴더 목록(`get-folder-list` → `lib/folder-list.mjs`): 세션 목록 페이지네이션을 따라 최근 1000개까지 모음.
- 하위 에이전트 진행(`lib/subagent-progress.mjs`): 도구 이름 `subagent`, 연결 키는 `session.tool.progress`의 `metadata.sessionID`, 에이전트 이름은 `input.agent`. 단계 수는 하위 세션의 `session.step.started`, 활동은 `session.tool.input.started {name}`. v2는 백그라운드 실행이라 도구 카드가 끝난 뒤에도 하위 세션이 끝날 때(`session.execution.succeeded`)까지 진행 표시를 유지한다.
- 도구 이름 대응: `shell`(1.x `bash`), `read`의 `input.path`(1.x `filePath`), `subagent`(1.x `task`). 사이드패널은 이름·입력 필드에 기대므로 background가 v2 도구 파트를 1.x 이름·필드로 바꿔 넘긴다(표시 문구가 바뀌지 않게).
- `get-server-origin`(프록시 저장 시 재시작 안내)의 세션 수를 `/api/session/active`로.
- 헤더에 서버 버전 배지(v1/v2) 표시 — `serverState.runtime` 배지 옆.

### 5단계: 마무리·릴리스
- 거부 로직·`showUnsupportedOpencodeGuide` 제거(또는 "지원하지 않는 3.x 이상" 감지로 전환).
- `CLAUDE.md`: "opencode 2.x는 아직 지원하지 않는다" 절을 v1/v2 어댑터 구조 설명으로 교체, REST API 표에 v2 열 추가.
- `README`/`PRIVACY.md` 확인(로컬 비밀번호 저장 언급).
- i18n: 새 문구는 `t('한국어')` + `sidepanel/i18n.js` `EN`.

## 수정할 주요 파일
- `background.js` — fetch 호출부 전부, `checkServerHealth`, `subscribeToEvents`, `ensureOpenCodeServer`/`waitForServer`(v2 거부 제거), 각 메시지 핸들러
- `lib/opencode-api.mjs`(신규), `lib/event-router-v2.mjs`(신규)
- `lib/sw-resilience.mjs`, `lib/subagent-progress.mjs`, `lib/folder-list.mjs`(입력 형식만)
- `native-host/host.js` — 비밀번호 생성·env 주입·`server.json` 기록·로그 마스킹
- `sidepanel/sidepanel.js` — 거부 안내 제거, 버전 배지, (필요 시) form 필드 확장
- `test/helpers/mock-opencode.mjs` — `startMockOpencode({api:'v1'|'v2', password})`
- `test/unsupported-opencode.test.mjs` → v2 지원 테스트로 교체

## 위험·미확인
- **v2 API가 아직 "Experimental HttpApi"**(OpenAPI `info.description`). MCP 토글 등은 `experimental` 경로라 마이너 버전에서 바뀔 수 있다. 어댑터에 v2 버전 범위를 두고, 알 수 없는 응답은 `debugLog`로 남긴다.
- 1.x와 2.x 이벤트 의미 차이(턴 경계, 대기 메시지 처리 순서)로 탭 전환 복원·대기 배지 같은 세밀한 UI가 어긋날 수 있다 → 0단계 실측을 테스트 픽스처로 고정.
- **1.x·2.x는 세션 DB를 공유하지 않는다(실측).** 2.x는 처음 실행할 때 1.x 세션을 한 번 복사할 뿐이다. 1.x↔2.x를 오가면 `/sessions`·최근 폴더가 버전마다 다르다. 사이드패널에 서버 버전 배지를 두고, 버전이 바뀌면 저장된 탭-세션 연결을 확인 후 정리한다. TUI(1.x)와 확장(2.x)을 함께 쓰면 서로의 세션이 안 보인다는 점을 README에 적는다.
- v2 하위 에이전트가 백그라운드로 돌아 턴 구조가 1.x와 다르다(synthetic 턴). 탭 전환 복원·대기 배지·진행 표시가 가장 어긋나기 쉬운 곳이다.
- oh-my-openagent 등 1.x 플러그인은 2.x에서 동작하지 않는다(확장 범위 밖이지만 안내 문구에 반영 검토).

## 검증
- `yarn test`: 기존 1.x 테스트 전부 통과(어댑터 리팩터링 후 동작 변화 없음). v2 mock으로 `stream-stall`·`page-read`·대기 메시지·권한/form·SW 복구 테스트를 v1과 같은 시나리오로 추가(`test/helpers/background-harness.mjs` + `startMockOpencode({api:'v2'})`).
- 비밀번호 테스트: mock에 `password`를 주면 Basic이 없는 요청에 401을 준다. v1·v2 양쪽에서 health·판별·SSE·전송이 헤더를 붙이는지, 모르는 비밀번호의 서버(다른 프로그램)는 건너뛰는지 확인.
- 실제 서버 E2E(WSL): 1.19.6과 2.3.2(`opencode-2.3.2.bak`)를 각각 확장으로 연결해 체크리스트 수행 — 연결·전송·스트리밍·도구·reasoning·권한 카드·질문(form)·대기 메시지·중단·탭 전환 복원·`/sessions`·폴더 변경·모델/에이전트 변경·MCP 토글·소프트/하드 재시작·SW 종료 후 복구·`/ext-log`에 비밀번호가 보이지 않는지.
- Windows native 2.x 서버에서도 연결·하드 재시작 확인(인스톨러 host로).
