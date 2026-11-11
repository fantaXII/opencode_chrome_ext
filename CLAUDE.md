# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
yarn install        # 의존성 설치
yarn build          # dist/ 폴더에 빌드 + .zip 생성 (prebuild가 dist 삭제)
yarn release        # release-it으로 버전 범프 + GitHub Release 생성
```

빌드 결과물(`dist/`)을 Chrome에 로드하려면: `chrome://extensions` → 개발자 모드 활성화 → "압축 해제된 확장 프로그램 로드" → `dist/` 선택.

## Architecture

4개 컴포넌트가 계층 구조로 통신한다:

```
sidepanel.js  ──chrome.runtime.sendMessage──▶  background.js (Service Worker)
                                                      │
                              chrome.runtime.sendNativeMessage
                                                      │
                                                native-host/host.js (Node.js)
                                                      │
                                               spawn opencode serve
                                                      │
                                          OpenCode Server (localhost:4096)
```

### background.js (Service Worker)
- `manifest.json`에서 `"type": "module"`로 선언된 ES 모듈
- 포트 4096~4105 범위를 스캔해 실행 중인 OpenCode 서버를 찾고, 없으면 Native Messaging으로 시작 요청
- Side Panel과는 `chrome.runtime.sendMessage`로 통신; 응답 청크는 `message-chunk` / `message-complete` 액션으로 역방향 push
- 세션별 SSE 연결(`EventSource`)을 `eventSources` Map으로 관리; 60초 타임아웃
- 30초마다 `periodicServerCheck`로 서버 포트 변경 감지

### sidepanel/sidepanel.js
- 모든 백엔드 통신은 `sendMessageToBackground(action, data)` 헬퍼를 통해 background로 위임
- SSE 청크는 background가 push하면 `chrome.runtime.onMessage`로 수신해 실시간 렌더링
- 초기화 순서: `init-server` → `get-models` → `create-session`

- 디버그 로그: 입력창 `/ext-log`(또는 연결 실패 화면의 "로그 보기" 버튼)로 SW 로그(`debugLogs`, 최대 500건) + host 파일 로그(`read-log`)를 다이얼로그로 표시·자동 복사한다. 새 오류 경로는 `debugLog(level, msg)`로 남긴다. `/debug`는 OpenCode 예약어와 충돌해 `/ext-log`로 바꿨다.

### native-host/host.js
- Chrome Native Messaging 프로토콜: stdin/stdout, 메시지 앞에 4바이트 LE 길이 헤더
- `which` 모듈로 `opencode` 바이너리 경로 탐색 후 `spawn('opencode', ['serve', '--port', port])`
- 지원 액션: `start` / `stop` / `restart` / `status` / `server-info` / `check-port` / `get-home-dir` / `browse-for-folder` / `browse-for-file` / `read-log` / `resolve-directory`
- `sendNativeMessage`는 메시지마다 host 프로세스를 새로 띄우므로 모듈 전역 상태(`opencodeProcess`/`isWSL`)는 요청 간 유지되지 않는다. `stop`/`restart`는 프로세스 핸들이 아니라 **포트를 점유한 프로세스**를 찾아서 종료한다(Windows: `Get-NetTCPConnection` → `taskkill /T /F`, WSL: `wsl.exe ss -ltnpH` → `wsl.exe kill`). 서버가 어느 쪽에 있는지 알 수 없으므로 양쪽을 모두 시도하고, 성공 판정은 포트의 health로만 한다.
- **실행 환경 우선순위**: `start`/`restart` 메시지의 `preferredRuntime`(`auto`|`windows`|`wsl`)이 `findOpenCodePath`의 탐색 순서를 정한다(`windows`면 Windows → WSL, `auto`·`wsl`은 WSL → Windows; 못 찾으면 반대편으로 fallback). 이미 떠 있는 서버가 여러 개면 `findAvailablePort`가 각 서버의 cwd 형식(`C:\` → Windows, `/` → WSL)으로 환경을 판별해 같은 우선순위로 고른다. 연결된 서버의 환경은 `serverState.runtime`에 보관하고 헤더 배지로 표시한다. 값은 `chrome.storage.local.preferredRuntime`에 저장되며, 사이드패널 ⚙ 설정에서 바꾼다. 하드 재시작이 성공한 뒤에만 저장되고, 현재와 다른 환경을 고르면 확인 다이얼로그 후 하드 재시작한다.
- **host 버전 확인**: 인스톨러가 설치 폴더에 `version.txt`(= 확장과 같은 릴리스 버전)를 기록하고, host의 `get-version` 액션이 이를 돌려준다. 확장(`checkHostVersion`)은 서버 연결 후 이 값을 `chrome.runtime.getManifest().version`과 비교해, 낮으면 사이드패널에 버전 고정 다운로드 링크(`releases/download/v<버전>/...`)와 업데이트 안내를 띄운다. `get-version`을 모르는 구버전 host는 `Unknown action`을 반환하므로 outdated로 본다. 개발 환경처럼 `version.txt`가 없으면(null) 판단하지 않는다.
- **확장 업데이트**: 확장은 Web Store로만 갱신된다(GitHub에서 수동 설치하는 사용자는 없다고 가정). 그래서 새 버전을 직접 조회하지 않고 Chrome 내장 API만 쓴다. `onUpdateAvailable`을 받으면 `chrome.storage.local.pendingUpdate`에 저장해 ⚙에 점(•)을 찍고, 설정의 "정보" 섹션에서 `check-extension-update`(= `requestUpdateCheck`)로 수동 확인, `apply-extension-update`(= `runtime.reload`)로 적용한다. 적용하면 SSE/진행 중 프롬프트가 끊기므로 확인 다이얼로그 후 `cancel-message`로 UI를 먼저 정리한다. 압축 해제로 로드한 개발용 확장은 `requestUpdateCheck`가 의미 있는 결과를 주지 않는다. native host(.exe)는 스토어가 갱신하지 못하므로 위 `checkHostVersion` 흐름으로 안내한다.
- **프록시 설정**: 사이드패널 ⚙ 설정의 `HTTP`/`HTTPS`/`NO_PROXY` 입력값은 `chrome.storage.local.proxy`에 저장되고(`set-proxy`가 `http(s)://`·`socks5(h)://` 형식만 허용), `start`/`restart` 메시지의 `proxy` 필드로 host에 전달되어 opencode 프로세스의 환경변수(`HTTP_PROXY` 등)로 주입된다. 서버 프로세스의 환경변수라서 **저장만으로는 반영되지 않고 하드 재시작이 필요**하다(소프트 `dispose`는 프로세스 env를 바꾸지 못한다). 빈 항목은 건드리지 않아 기존 시스템 환경변수가 유지된다. Windows 환경변수는 대소문자를 구분하지 않으므로 대문자 이름 하나만 설정하고 같은 이름의 기존 소문자 변수는 spawn env에서 제거한다. WSL 쪽은 `wsl.exe`가 `WSLENV`에 적힌 이름(대소문자 정확히 일치)만 넘겨주므로 `buildProxyEnv`가 `WSLENV`에 이름을 추가한다(WSL 안의 소문자 `http_proxy` 변수는 설정되지 않는다).
- **config.private.json 프록시 가져오기**: 인스톨러(`install.ps1`)는 config.private.json을 설치 끝에 삭제하므로, 삭제 전에 `proxy` 섹션만 `%LOCALAPPDATA%\OpenCodeChrome\proxy.json`에 남긴다. `get-proxy`는 `chrome.storage.local.proxy`가 한 번도 저장된 적 없을 때만 host의 `get-installed-proxy`로 이 값을 가져와 저장한다(이미 저장된 값이 있으면 덮어쓰지 않는다). 사이드패널은 ⚙를 열 때마다 값을 새로 읽고, 읽는 동안에는 입력칸 대신 "확인 중…"만 보여 입력이 불가능하며, 재렌더 시 저장하지 않은 입력(`proxyDraft`)은 유지한다.
- **확장이 띄운 서버 식별**: host가 서버 기동 후 포트의 리스너 pid를 `%LOCALAPPDATA%\OpenCodeChrome\server.json`에 기록하고, `server-info` 액션이 현재 리스너와 대조해 `managed`를 돌려준다. 프록시를 저장하면 사이드패널이 `get-server-origin`(= `server-info` + `GET /session/status`의 응답 중 세션 수)으로 재시작 안내를 달리한다: 확장이 띄운 서버면 재시작 확인, 아니면(터미널/VS Code TUI가 띄웠거나 이 기능 이전 버전이 띄운 서버) "저장만"/"그래도 재시작" 선택.
- **작업 디렉터리 검증**: 존재하지 않는 경로를 `x-opencode-directory`로 보내면 opencode는 오류 없이 파트 0개의 빈 응답만 돌려준다. 그래서 `set-working-directory`는 저장 전에 host의 `resolve-directory`(서버 환경에 맞게 변환 + `wsl.exe test -d`/`fs.statSync`로 존재 확인)를 거쳐, 없으면 저장하지 않고 `dir-not-found`를 돌려준다. `/mnt/z/...`처럼 WSL에 없는 마운트는 `Z:`가 `\\wsl$`를 가리키는 네트워크 드라이브면 `/home/...`으로 복구한다. 구버전 host(`Unknown action`)면 검증을 생략한다. 빈 응답이 오면 `session.idle` 폴백이 메시지의 `info.error` 또는 기본 문구를 오류로 표시한다.
- `wsl.exe`에는 `bash -c "<스크립트>"` 대신 argv만 넘긴다(따옴표·`$` 확장이 인자 전달 과정에서 깨질 수 있음). 출력 파싱은 Node에서 처리한다.

### OpenCode REST API (background.js가 직접 호출)
| 엔드포인트 | 용도 |
|-----------|------|
| `GET /global/health` | 서버 상태 확인 |
| `POST /session` | 세션 생성 |
| `DELETE /session/{id}` | 세션 삭제 |
| `POST /session/{id}/prompt` | 메시지 전송 |
| `GET /event?session={id}` | SSE 스트림 구독 |
| `GET /config/providers` | 모델 목록 |
| `PATCH /config` | 모델 변경 |
| `POST /global/dispose` | **소프트 재시작** — opencode instance를 폐기해 config/MCP/skill/agent를 디스크에서 다시 읽게 한다 |

### 서버 재시작 (2단계)

MCP/skill/agent를 새로 등록하면 opencode는 이를 자동 반영하지 않는다(config가 instance 단위로 캐시됨). TUI의 exit → 재진입에 대응하는 동작이 `POST /global/dispose`다.

| | 소프트 (`restart-instance`) | 하드 (`restart-server`) |
|---|---|---|
| 방법 | `POST /global/dispose` | Native Host가 포트 점유 프로세스 종료 후 재spawn |
| 소요 | 1~2초 | 10~30초 |
| 프로세스/포트 | 유지 | 재생성, **포트가 바뀔 수 있음** |
| 용도 | MCP/skill/agent 등록 반영 | 서버가 응답하지 않을 때 |

하드 재시작 중에는 사이드패널이 `restarting` 상태(처음 연결할 때와 같은 오버레이 + 입력/에이전트 전환/MCP·설정 메뉴 차단)가 되고, background는 `server-restart-state`를 모든 패널에 broadcast한다. `ensureOpenCodeServer`는 `_hardRestartPromise`가 있으면 새 서버를 띄우지 않고 재시작이 끝나기를 기다린다(두 번째 서버가 뜨는 레이스 방지). 소프트 재시작은 막지 않는다.

dispose는 열려 있는 SSE 스트림을 끊고 `server.instance.disposed` 이벤트를 내보낸다. `subscribeToEvents()`의 Last-Event-ID 재연결 경로가 자동으로 다시 붙지만, 진행 중이던 프롬프트는 instance와 함께 사라진다(사이드패널이 재시작 전에 `cancel-message`로 UI를 정리한다).

### 페이지 컨텍스트 / 렌더링 보안 (Web Store 심사 관련)
- 상시 콘텐츠 스크립트는 없다. `chrome.storage.local.pageContext`(`off`|`basic`(기본)|`full`)에 따라 `getCurrentTabInfo({ forPrompt: true })`가 메시지를 보낼 때만 제목·URL을 붙이고, `full`이면 `scripting.executeScript`로 그 순간 본문 일부·선택 텍스트를 읽는다. `full`은 `optional_host_permissions: ["<all_urls>"]`를 사이드패널 ⚙에서 `permissions.request`로 받아야 동작한다(거부되면 `basic`으로 저장). 페이지 내용은 opencode를 거쳐 AI 제공자로 가므로 `PRIVACY.md`에 이 흐름을 명시해 두었다 — 전송 범위를 바꾸면 방침도 같이 고친다.
- 모델 응답은 신뢰할 수 없는 입력(프롬프트 인젝션)이다. 마크다운은 반드시 `renderMarkdown()`(marked → DOMPurify, 원격 이미지는 링크로 치환, 링크는 http(s)/mailto만 새 탭)으로 그린다. manifest CSP도 `img-src 'self' data:`, `frame-src 'none'`으로 막는다. `marked.parse` 결과를 `innerHTML`에 직접 넣지 않는다.

### 권한/질문 요청 (permission.asked / question.asked)
- `subscribeToEvents`가 본 세션과 하위(subagent, `session.created`의 `parentID`) 세션의 요청을 `onPart({kind:'permission'|'question'})`로 사이드패널에 넘기고, 카드의 응답은 `reply-permission`(`POST /permission/{id}/reply {reply}`, 404면 구버전 `/session/{sid}/permissions/{id}`) / `reply-question`(`POST /question/{id}/reply {answers}`) / `reject-question`으로 보낸다. 요청이 남아 있는 동안에는 180초 무응답 타임아웃을 걸지 않는다.
- 타임아웃은 텍스트 delta뿐 아니라 도구 상태 변경(`message.part.updated`), `message.updated`, `session.status`(busy/retry), 하위 세션 활동에서도 리셋된다. 완료는 `session.idle` 또는 `session.status` idle(어시스턴트 메시지를 본 뒤)이며, SSE 재연결 직후에는 `/session/status`로 놓친 idle을 확인한다.
- **제공자 재시도**: `session.status` retry(`{attempt, message, next}`, `next` = 다음 시도 epoch ms)는 대기 중 이벤트가 없고 `Retry-After`에 상한이 없어 무응답 제한(`STREAM_IDLE_TIMEOUT_MS`)보다 길 수 있다. 그래서 `next + 무응답 제한`까지 타임아웃을 연장하고, `onPart({kind:'retry'})`로 사이드패널 로딩 표시를 "재시도 대기 (N회차) · M초 후"로 바꾼다. busy·delta·도구/텍스트 파트가 오면 `retry-cleared`로 되돌린다(`message.updated`·retry 파트는 대기 중에도 오므로 해제 신호가 아니다). 하위 세션의 retry도 같은 방식으로 처리한다.
- 스트림 컨트롤러가 `abort`되면(중단 버튼, 전송 실패, 새 프롬프트가 구독을 대체) 무응답 타이머도 함께 끝난다. 남은 타이머가 뒤늦게 돌면 서버 세션을 `abort`해 다음 프롬프트까지 죽이기 때문이다. `prompt_async`가 `PROMPT_SEND_TIMEOUT_MS` 안에 응답하지 않으면 구독을 끝내 늦게 접수된 응답이 실패 표시 뒤에 섞이지 않게 하고, 서버 세션에도 `abort`를 요청한다(접수 전에 도착하면 효과가 없는 최선 노력이라 프롬프트가 서버 기록에 남을 수 있다).
- **세션 상태는 디렉터리 instance별**: opencode는 `?directory=` → `x-opencode-directory` → 서버 cwd 순으로 instance를 고르고, `/session/status`는 그 instance의 상태만 돌려준다(헤더 없이 물으면 작업 폴더 세션이 `{}` = idle로 보인다, 1.19.4 실측). 그래서 재연결 후 idle 확인과 SW 재시작 복구(`pendingPrompts`에 `directory` 저장)는 프롬프트를 보낸 디렉터리로 묻는다(`sessionStatusInit`). `abort`는 헤더 없이도 동작한다(실측).

## Key Constraints

- **빌드 파이프라인 없음**: Webpack/Vite 미사용. `scripts/build.js`는 단순 파일 복사 + zip. 소스 파일을 직접 수정하면 빌드에 반영됨.
- **테스트**: 프레임워크 없이 Node 내장 러너만 사용(`yarn test`). `lib/sw-resilience.mjs`(SW 종료 대응) 단위 테스트와, `test/stream-stall.test.mjs`(실제 `background.js`를 `test/helpers/background-harness.mjs`로 chrome 스텁과 함께 불러와 `test/helpers/mock-opencode.mjs` 가짜 서버로 retry/전송 지연/중단을 재현)가 있다. 하네스는 `DEFAULT_PORT`·`MAX_PORT_CHECK`와 `const NAME = 값;` 형태 상수만 소스 치환하므로 이 선언 형태를 바꾸면 하네스도 같이 고친다.
- **SW 종료 대응**: 응답 대기 중 MV3 SW가 30초 idle로 죽으면 SSE·타임아웃이 사라져 UI가 멈춘다. `subscribeToEvents`가 keepalive(20초 ping)와 `storage.session.pendingPrompts` 기록을 걸고, SW 재시작 시 `recoverInterruptedPrompts`가 `/session/status` 폴링 → REST 내용으로 `message-complete`를 보낸다.
- **Windows 전용 Native Host**: `native-host/`는 Windows 레지스트리(`install.reg`)에 경로를 등록해야 동작. WSL에서는 개발만 가능.
- **native-host/manifest.json의 `allowed_origins`**: Web Store 확장 ID(`jchffojdjnhpmdgnifkhpgmgokbidobi`)로 고정. manifest의 `key`가 이 ID를 만들며, Web Store용 zip에서는 `key`를 제거한다.
- **i18n**: `manifest.json`의 이름/설명은 `_locales/{ko,en}/messages.json`의 `__MSG_*__`(브라우저 언어를 따름). 사이드패널 UI 언어는 `chrome.i18n`으로 런타임 전환이 안 되므로 `sidepanel/i18n.js`가 따로 처리한다: **한국어 원문을 키로** 쓰는 `t('원문', {param})`(사전 `EN`에 없으면 원문 그대로 → 기본 ko), 정적 HTML은 `data-i18n`/`data-i18n-html`/`data-i18n-title`/`data-i18n-placeholder`(요소의 원래 한국어가 키). 선택값은 `chrome.storage.local.lang`(`ko`|`en`)이고 ⚙ 설정 맨 위에서 바꾼다. 새 UI 문자열을 추가하면 한국어로 `t()`/속성을 쓰고 `i18n.js`의 `EN`에 번역을 넣는다. background가 돌려주는 오류 문구는 사이드패널에서 `t(error)`로 감싸 번역한다. `/debug` 로그와 모델에 보내는 프롬프트는 번역하지 않는다.
