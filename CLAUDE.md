# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
yarn install        # 의존성 설치
yarn build          # dist/ 폴더에 빌드 + .zip 생성 (prebuild가 dist 삭제)
yarn release        # release-it으로 버전 범프 + GitHub Release 생성
```

> **릴리스 주의 (같은 실수가 2번 발생)**: `release-it`에 **`--no-npm`을 붙이지 말 것.** 이 프로젝트는 `package.json`이 버전의 기준이다(`scripts/build.js`가 파일명과 `dist/manifest.json` 버전을 `package.json`에서 읽는다). `--no-npm`은 publish뿐 아니라 `package.json` 버전 범프도 막아서, 릴리스 자산이 이전 버전(`...-v2.14.0-webstore.zip` 등)으로 만들어진다. publish는 `.release-it.json`의 `npm.publish: false`로 이미 꺼져 있다. `.env_example`의 `yarn release-it --ci --no-npm` 안내는 낡은 것이므로 따르지 말고 `yarn release-it --ci`(또는 `yarn release`)를 쓴다. 릴리스 후에는 `package.json`·`manifest.json` 버전과 Release 자산 파일명이 모두 새 버전인지 확인한다. (`after:bump` 훅이 두 파일을 다시 맞추지만 방어용일 뿐이다.)

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
- **확장 전용 서버**: 확장이 직접 띄운 서버만 쓴다(TUI가 자기 서버를 혼자 쓰는 것과 같다). 터미널 TUI·VS Code 등이 4096~4105에 띄운 서버에 붙으면 강제 재시작이 그 작업까지 죽이기 때문이다. host의 `start`/`restart` 응답 포트를 `chrome.storage.local.managedServerPort`에 두고, SW가 그 포트에 처음 붙을 때 `server-info`의 `managed`(server.json 대조)로 한 번 확인해 `storage.session.managedServerVerified`에 남긴다(브라우저를 다시 켜면 재확인). 기록이 없거나 그 포트를 다른 서버가 쓰면 범위 안에서 `managed`인 서버를 이어받고, 없으면 host `start`로 새로 띄운다(host는 opencode가 응답하는 포트를 건너뛰므로 TUI가 4096을 쓰면 4097 등에 뜬다). 서버를 띄운 뒤에는 host가 알려준 포트만 기다린다(`waitForServer(port)`). host가 판정하지 못하면(미설치·`Unknown action`·오류) 예전처럼 아무 서버에나 붙고 확장 서버로 기록하지 않는다. 서버가 2개여도 세션은 같은 DB를 써서 `/sessions`에 함께 보인다(1.19.4 실측).
- Side Panel과는 `chrome.runtime.sendMessage`로 통신; 응답 청크는 `message-chunk` / `message-complete` 액션으로 역방향 push
- 세션별 SSE 연결(`EventSource`)을 `eventSources` Map으로 관리; 60초 타임아웃
- 1분마다 `periodicServerCheck`가 연결된 서버 포트의 health만 확인한다(범위를 다시 훑지 않는다). 내려갔으면 확인 기록을 지우고 `ensureOpenCodeServer`로 다시 연결한다.

### sidepanel/sidepanel.js
- 모든 백엔드 통신은 `sendMessageToBackground(action, data)` 헬퍼를 통해 background로 위임
- SSE 청크는 background가 push하면 `chrome.runtime.onMessage`로 수신해 실시간 렌더링
- 초기화 순서: `init-server` → `get-models` → `create-session`

- **세션은 지우지 않는다(TUI와 같은 개념)**: 탭 닫기·`exit`·작업 폴더 변경 모두 탭-세션 연결만 끊는다. 서버의 세션은 남아 `/sessions`로 원래 폴더 그대로 이어갈 수 있다. 응답 중이었다면 `releaseSession`이 구독을 끝내고 서버 세션을 `abort`한다. `DELETE /session`은 쓰지 않는다.
- `exit`/`/exit`/`quit`(입력 전체가 일치할 때만): 응답 중이면 `cancel-message` 후 `exit-panel`을 보낸다. background는 이 탭의 `tabSessions`·`activeTabs` 연결을 끊고 `sidePanel.setOptions({tabId, enabled:false})`로 패널을 닫는다. 서버 세션은 지우지 않는다. 그래서 `/sessions`로 이어갈 수 있고, 다시 열면 `get-tab-session`이 새 세션을 만든다. 패널이 남아 있으면 사이드패널이 `window.close()`로 닫는다.
- **입력 기록(↑/↓, TUI와 같은 개념)**: 현재 세션에서 보낸 입력을 다시 불러온다. 따로 저장하지 않고 화면의 사용자 말풍선(`addUserMessage`가 붙이는 `data-prompt`)에서 읽으므로, 세션·탭이 바뀌어 화면이 다시 그려지면 자동으로 그 세션 기준이 된다(서버 기록에서 복원한 입력은 페이지 컨텍스트·첨부 블록을 벗긴 원문). 불러온 뒤 고치지 않았으면 커서 위치와 무관하게 넘기고, 직접 입력 중이면 ↑는 첫 줄·↓는 마지막 줄에서만 동작한다. 한글 조합 중(`isComposing`)이나 명령 드롭다운이 열려 있으면 동작하지 않으며, 최신보다 더 내려가면 작성 중이던 내용(`historyDraft`)을 되돌린다.
- 디버그 로그: 입력창 `/ext-log`(또는 연결 실패 화면의 "로그 보기" 버튼)로 SW 로그(`debugLogs`, 최대 500건) + host 파일 로그(`read-log`)를 다이얼로그로 표시·자동 복사한다. 새 오류 경로는 `debugLog(level, msg)`로 남긴다. `/debug`는 OpenCode 예약어와 충돌해 `/ext-log`로 바꿨다.

### native-host/host.js
- Chrome Native Messaging 프로토콜: stdin/stdout, 메시지 앞에 4바이트 LE 길이 헤더
- `opencode` 경로 탐색 후 `spawn(<경로>, ['serve', '--port', port])`. WSL은 `~/.opencode/bin` → nvm → 로그인 셸(`bash -ilc`) 순으로 찾는다. Windows도 같은 수준으로 찾는다(`findWindowsOpenCode`). host는 **Chrome이 시작될 때의 PATH**를 물려받으므로, 그 뒤에 설치한 opencode는 물려받은 PATH로 못 찾는다. 그래서 물려받은 PATH → 레지스트리의 현재 Machine+User PATH(PowerShell) → 알려진 설치 폴더(`%APPDATA%\npm`, `~\.opencode\bin`, `~\.bun\bin`, scoop, pnpm, nvm-windows, WinGet Links, chocolatey) 순으로 찾는다. 2·3단계에서 찾았으면 그 PATH를 spawn env에도 넣는다(npm `opencode.cmd`가 PATH에서 `node`를 찾기 때문). `.cmd`/`.bat`은 `shell:true`로 띄우고 경로를 따옴표로 감싼다. 감싸지 않으면 공백이 있는 사용자 폴더에서 실행이 깨진다.
  - **wsl.exe 출력 해석(`interpretWslResult`)**: wsl.exe 자신의 실패(배포판 없음, 서비스 오류)는 종료 코드 `0xFFFFFFFF`이고 메시지를 **stdout에 UTF-16LE로** 쓴다(실측). 그래서 Buffer로 받는다. 종료 코드가 `0xFFFFFFFF`일 때만 UTF-16LE로 읽고, 그 외에는 UTF-8로 읽는다. 경로는 `/`로 시작하는 줄만 인정한다. 예전에는 이 오류 출력(`"\u0000"`)을 "WSL에서 찾음"으로 오인해 Windows 탐색을 건너뛰었다. 재시도는 일시적 실패일 때만 한다. 일시적 실패는 시간 초과, 실행 오류, wsl.exe 자체 오류, 그리고 종료 코드가 0인데 경로가 없는 경우다(WSL 초기화 지연으로 출력이 유실된 것으로 본다). "없음"이라는 확실한 답은 그 전략을 다시 시도하지 않고, 배포판이 없거나 wsl.exe가 없으면 WSL 탐색을 바로 끝낸다.
  - `install.ps1`도 같은 순서로 양쪽을 찾는다(`Find-WindowsOpenCode`/`Find-WslOpenCode`). Windows에만 opencode가 있으면 WSL mirrored 네트워크 설정(WSL 재시작) 안내를 건너뛴다. wsl.exe 인자는 `Invoke-WslCommand`가 원문 문자열로 넘긴다. PowerShell 5.1의 네이티브 인자 전달은 안쪽 `"`를 이스케이프하지 않아 깨지기 때문이다.
- 지원 액션: `start` / `stop` / `restart` / `status` / `server-info` / `check-port` / `get-home-dir` / `browse-for-folder` / `browse-for-file` / `read-log` / `resolve-directory`
- `sendNativeMessage`는 메시지마다 host 프로세스를 새로 띄우므로 모듈 전역 상태(`opencodeProcess`/`isWSL`)는 요청 간 유지되지 않는다. `stop`/`restart`는 프로세스 핸들이 아니라 **포트를 점유한 프로세스**를 찾아서 종료한다(Windows: `Get-NetTCPConnection` → `taskkill /T /F`, WSL: `wsl.exe ss -ltnpH` → `wsl.exe kill`). 서버가 어느 쪽에 있는지 알 수 없으므로 양쪽을 모두 시도하고, 성공 판정은 포트의 health로만 한다.
- **실행 환경 우선순위**: `start`/`restart` 메시지의 `preferredRuntime`(`auto`|`windows`|`wsl`)이 `findOpenCodePath`의 탐색 순서를 정한다(`windows`면 Windows → WSL, `auto`·`wsl`은 WSL → Windows; 못 찾으면 반대편으로 fallback). 이미 떠 있는 서버가 여러 개면 `findAvailablePort`가 각 서버의 cwd 형식(`C:\` → Windows, `/` → WSL)으로 환경을 판별해 같은 우선순위로 고른다. 연결된 서버의 환경은 `serverState.runtime`에 보관하고 헤더 배지로 표시한다. 값은 `chrome.storage.local.preferredRuntime`에 저장되며, 사이드패널 ⚙ 설정에서 바꾼다. 하드 재시작이 성공한 뒤에만 저장되고, 현재와 다른 환경을 고르면 확인 다이얼로그 후 하드 재시작한다.
- **host 버전 확인**: 인스톨러가 설치 폴더에 `version.txt`(= 확장과 같은 릴리스 버전)를 기록하고, host의 `get-version` 액션이 이를 돌려준다. 확장(`checkHostVersion`)은 서버 연결 후 이 값을 `lib/host-version.mjs`의 `MIN_HOST_VERSION`(host가 마지막으로 바뀐 릴리스)과 비교한다. 확장 버전과 비교하면 host가 그대로인 릴리스에서도 매번 재설치를 안내하기 때문이다. `MIN_HOST_VERSION`은 손으로 고치지 않는다: release-it `after:bump`의 `scripts/sync-host-version.js`가 직전 태그 이후 `native-host/`·`installer/`가 바뀌었을 때만 새 버전으로 올린다. 낮으면 사이드패널에 버전 고정 다운로드 링크(`releases/download/v<버전>/...`)와 업데이트 안내를 띄운다. `get-version`을 모르는 구버전 host는 `Unknown action`을 반환하므로 outdated로 본다. 개발 환경처럼 `version.txt`가 없으면(null) 판단하지 않는다.
- **확장 업데이트**: 확장은 Web Store로만 갱신된다(GitHub에서 수동 설치하는 사용자는 없다고 가정). 그래서 새 버전을 직접 조회하지 않고 Chrome 내장 API만 쓴다. `onUpdateAvailable`을 받으면 `chrome.storage.local.pendingUpdate`에 저장해 ⚙에 점(•)을 찍고, 설정의 "정보" 섹션에서 `check-extension-update`(= `requestUpdateCheck`)로 수동 확인, `apply-extension-update`(= `runtime.reload`)로 적용한다. 적용하면 SSE/진행 중 프롬프트가 끊기므로 확인 다이얼로그 후 `cancel-message`로 UI를 먼저 정리한다. 압축 해제로 로드한 개발용 확장은 `requestUpdateCheck`가 의미 있는 결과를 주지 않는다. native host(.exe)는 스토어가 갱신하지 못하므로 위 `checkHostVersion` 흐름으로 안내한다.
- **프록시 설정**: 사이드패널 ⚙ 설정의 `HTTP`/`HTTPS`/`NO_PROXY` 입력값은 `chrome.storage.local.proxy`에 저장되고(`set-proxy`가 `http(s)://`·`socks5(h)://` 형식만 허용), `start`/`restart` 메시지의 `proxy` 필드로 host에 전달되어 opencode 프로세스의 환경변수(`HTTP_PROXY` 등)로 주입된다. 서버 프로세스의 환경변수라서 **저장만으로는 반영되지 않고 하드 재시작이 필요**하다(소프트 `dispose`는 프로세스 env를 바꾸지 못한다). 빈 항목은 건드리지 않아 기존 시스템 환경변수가 유지된다. Windows 환경변수는 대소문자를 구분하지 않으므로 대문자 이름 하나만 설정하고 같은 이름의 기존 소문자 변수는 spawn env에서 제거한다. WSL 쪽은 `wsl.exe`가 `WSLENV`에 적힌 이름(대소문자 정확히 일치)만 넘겨주므로 `buildProxyEnv`가 `WSLENV`에 이름을 추가한다(WSL 안의 소문자 `http_proxy` 변수는 설정되지 않는다).
- **config.private.json 프록시 가져오기**: 인스톨러(`install.ps1`)는 config.private.json을 설치 끝에 삭제하므로, 삭제 전에 `proxy` 섹션만 `%LOCALAPPDATA%\OpenCodeChrome\proxy.json`에 남긴다. `get-proxy`는 `chrome.storage.local.proxy`가 한 번도 저장된 적 없을 때만 host의 `get-installed-proxy`로 이 값을 가져와 저장한다(이미 저장된 값이 있으면 덮어쓰지 않는다). 사이드패널은 ⚙를 열 때마다 값을 새로 읽고, 읽는 동안에는 입력칸 대신 "확인 중…"만 보여 입력이 불가능하며, 재렌더 시 저장하지 않은 입력(`proxyDraft`)은 유지한다.
- **확장이 띄운 서버 식별**: host가 서버 기동 후 포트의 리스너 pid를 `%LOCALAPPDATA%\OpenCodeChrome\server.json`에 기록하고, `server-info` 액션이 현재 리스너와 대조해 `managed`를 돌려준다. 프록시를 저장하면 사이드패널이 `get-server-origin`(= `server-info` + `GET /session/status`의 응답 중 세션 수)으로 재시작 안내를 달리한다: 확장이 띄운 서버면 재시작 확인, 아니면(터미널/VS Code TUI가 띄웠거나 이 기능 이전 버전이 띄운 서버) "저장만"/"그래도 재시작" 선택.
- **작업 디렉터리 검증**: 존재하지 않는 경로를 `x-opencode-directory`로 보내면 opencode는 오류 없이 파트 0개의 빈 응답만 돌려준다. 그래서 `set-working-directory`는 저장 전에 host의 `resolve-directory`(서버 환경에 맞게 변환 + `wsl.exe test -d`/`fs.statSync`로 존재 확인)를 거쳐, 없으면 저장하지 않고 `dir-not-found`를 돌려준다. `/mnt/z/...`처럼 WSL에 없는 마운트는 `Z:`가 `\\wsl$`를 가리키는 네트워크 드라이브면 `/home/...`으로 복구한다. 구버전 host(`Unknown action`)면 검증을 생략한다. 빈 응답이 오면 `session.idle` 폴백이 메시지의 `info.error` 또는 기본 문구를 오류로 표시한다.
- **작업 폴더는 세션별**: opencode는 세션을 만든 폴더(`session.directory`)에 세션을 고정한다. 다른 `x-opencode-directory`로 프롬프트를 보내도 원래 폴더에서 실행하고, 세션 상태도 원래 폴더 instance에만 보인다(1.19.5 실측, git/비git 모두). 그래서:
  - `chrome.storage.local.workingDirectory`는 **새 세션의 기본 폴더**일 뿐이다.
  - 기존 세션에 보내는 요청(프롬프트·`/session/status`·권한/질문 조회·응답)은 `getSessionDirectory(sessionId)`로 보낸다. 값은 `sessionDirectories`(`storage.session`)에 있고, 없으면 `GET /session/{id}`로 확인한다.
  - 폴더를 바꾸면 그 탭의 세션만 새로 만든다(이전 세션은 지우지 않는다). 다른 탭의 세션은 원래 폴더로 계속 동작하다가, 새 세션(`/new`, exit 후 다시 열기 등)부터 새 기본값을 쓴다.
  - 사이드패널은 여러 탭이 한 화면을 같이 쓰므로, 세션이 바뀔 때마다 `refreshWorkingDirectory()`로 현재 세션의 폴더를 표시한다.
  - 사이드패널의 폴더 변경(📁·✏️·`/wd`)은 모두 `changeWorkingDirectory()` 하나를 거친다. 변경 중(`workingDirBusy`)에는 폴더 표시줄에 스피너와 "작업 폴더 변경 중…"을 띄우고, 입력·전송·폴더 조작을 막고, 겹친 요청은 무시한다. 응답 중이면 확인 다이얼로그를 띄운 뒤 `cancelMessage()`로 UI를 정리하고 바꾼다(`/wd`는 다른 명령처럼 응답 중에는 실행되지 않는다).
  - **즐겨찾기·최근 폴더**: 폴더 표시줄(경로 글자 또는 ★ 버튼)을 누르면 드롭다운이 열린다(즐겨찾기 → 최근 폴더 → "☆ 현재 폴더 추가"/"다른 폴더 열기…"/"경로 입력"). 고르면 위와 같은 `changeWorkingDirectory()`를 탄다. `/wd ` 뒤에는 같은 목록이 자동완성으로 나온다. 목록은 `get-folder-list`가 `lib/folder-list.mjs`의 `buildFolderList`로 만든다: **최근 폴더는 서버 세션 기록**(`GET /session`의 `directory`·`time.updated`, 하위 세션 제외)을 폴더별로 묶은 것이라 TUI에서 쓴 폴더도 보이고 확장을 다시 설치해도 남는다. 세션이 아직 없는 폴더는 `set-working-directory` 때 기록하는 `folderRecent`(최대 20개)로 보충한다. 즐겨찾기(`folderFavorites`, `{path,name,addedAt}`)·숨김(`folderHidden`)은 `chrome.storage.local`에 둔다(확장 업데이트로는 지워지지 않고 삭제할 때만 지워진다). 최근에서 "×"는 세션을 지우지 않고 숨김으로만 기록하며, 그 폴더를 다시 고르면 숨김이 풀린다. 서버 실행 환경(`serverState.runtime`)과 다른 형식의 경로(WSL에서 `C:\…` 등)는 최근에서 빼고, 즐겨찾기는 남기되 흐리게(선택 불가) 보여준다.
  - 예전에는 전역 값으로 보내서, 다른 탭에서 폴더를 바꾸면 화면엔 새 폴더가 보이는데 실제로는 원래 폴더로 동작했다. 상태 확인이 다른 instance로 가서 응답 중인 세션을 idle로 오인할 수도 있었다.
- `wsl.exe`에는 `bash -c "<스크립트>"` 대신 argv만 넘긴다(따옴표·`$` 확장이 인자 전달 과정에서 깨질 수 있음). 출력 파싱은 Node에서 처리한다. 결과를 읽을 때는 `wslStdout(result)`처럼 종료 코드 0을 먼저 확인한다. wsl.exe가 실패하면 stdout에 UTF-16LE 오류 메시지가 나와서, 그대로 읽으면 깨진 문자열이 홈 폴더가 되거나 오류 코드 속 숫자가 pid가 된다.

### OpenCode REST API (background.js가 직접 호출)
| 엔드포인트 | 용도 |
|-----------|------|
| `GET /global/health` | 서버 상태 확인 |
| `POST /session` | 세션 생성 |
| `GET /session/{id}` | 세션 존재·작업 폴더(`directory`) 확인 |
| `POST /session/{id}/prompt` | 메시지 전송 |
| `GET /event?session={id}` | SSE 스트림 구독 |
| `GET /config/providers` | 모델 목록 |
| `PATCH /config` | 모델 변경 |
| `POST /global/dispose` | **소프트 재시작** — opencode instance를 폐기해 config/MCP/skill/agent를 디스크에서 다시 읽게 한다 |

### 서버 재시작 (2단계)

MCP/skill/agent를 새로 등록하면 opencode는 이를 자동 반영하지 않는다. 프로젝트 설정·skill은 instance 단위로 캐시돼 `POST /global/dispose`로 다시 읽지만, **전역 설정(`~/.config/opencode/opencode.json`)은 프로세스 수명 동안 캐시돼 dispose로 반영되지 않는다**(1.19.4 실측: 전역 MCP는 처음 여는 폴더에서도 안 보임). TUI의 exit → 재진입은 TUI 프로세스(와 그 안의 서버)를 새로 띄우는 것이라 하드 재시작에 해당한다. `PATCH /global/config {}`도 전역 설정을 다시 읽지만, 파일을 다시 써서 주석·포맷이 사라지므로 쓰지 않는다.

| | 소프트 (`restart-instance`) | 하드 (`restart-server`) |
|---|---|---|
| 방법 | `POST /global/dispose` | Native Host가 포트 점유 프로세스 종료 후 재spawn |
| 소요 | 1~2초 | 10~30초 |
| 프로세스/포트 | 유지 | 재생성, **포트가 바뀔 수 있음** |
| 용도 | 프로젝트 설정의 MCP, skill/agent 등록 반영 | 전역 설정(MCP 등) 반영, 서버가 응답하지 않을 때 |
| 위치 | MCP 메뉴 "↻ 설정 다시 읽기" | MCP 메뉴 "⟳ 서버 재시작", ⚙ "서버 강제 재시작" |

둘 다 서버의 모든 진행 중 응답을 끊는다. 그래서 `runServerRestart`는 먼저 `get-active-streams`(SW가 구독 중인 `eventSources`, 확장 전용 서버라 이것이 진행 중 응답 전부다)로 다른 탭의 응답을 확인하고, 있으면 "끝난 뒤 재시작"(2초마다 확인, 상태 문구 옆 "대기 취소")/"지금 재시작"/취소를 고르게 한다(`showConfirm`의 `altText`).

하드 재시작 중에는 사이드패널이 `restarting` 상태(처음 연결할 때와 같은 오버레이 + 입력/에이전트 전환/MCP·설정 메뉴 차단)가 되고, background는 `server-restart-state`를 모든 패널에 broadcast한다. `ensureOpenCodeServer`는 `_hardRestartPromise`가 있으면 새 서버를 띄우지 않고 재시작이 끝나기를 기다린다(두 번째 서버가 뜨는 레이스 방지). 소프트 재시작은 막지 않는다.

폴더 instance별 목록 — MCP(`get-mcp-status`/`toggle-mcp`), 명령(`get-commands`, opencode는 skill도 이 목록에 넣는다), 에이전트(`get-agents`) — 은 `sessionDirectoryHeaders`로 현재 세션의 폴더(`getSessionDirectory`)를 `x-opencode-directory`에 붙여 묻는다. 작업 폴더의 `.opencode/`·`opencode.json` 항목은 그 폴더 instance에만 있어서, 헤더 없이 물으면 서버 cwd 기준 목록이 나와 작업 폴더의 MCP·skill·command·agent가 보이지 않았다(1.19.4 실측. 실행 자체는 세션 폴더 기준이라 됐다). 사이드패널은 세션이 바뀔 때(`refreshWorkingDirectory`) 세 목록을, MCP 메뉴를 열 때 MCP 목록을 다시 읽는다. `loadAgents`는 고른 에이전트가 새 목록에 있으면 유지하고 없으면 첫 번째로 돌린다.

dispose는 열려 있는 SSE 스트림을 끊고 `server.instance.disposed` 이벤트를 내보낸다. `subscribeToEvents()`의 Last-Event-ID 재연결 경로가 자동으로 다시 붙지만, 진행 중이던 프롬프트는 instance와 함께 사라진다(사이드패널이 재시작 전에 `cancel-message`로 UI를 정리한다).

### 페이지 컨텍스트 / 렌더링 보안 (Web Store 심사 관련)
- 상시 콘텐츠 스크립트는 없다. `chrome.storage.local.pageContext`(`off`|`basic`(기본)|`full`)에 따라 `getCurrentTabInfo({ forPrompt: true })`가 메시지를 보낼 때만 제목·URL을 붙이고, `full`이면 `scripting.executeScript`로 그 순간 본문 일부·선택 텍스트를 읽는다. `full`은 `optional_host_permissions: ["<all_urls>"]`를 사이드패널 ⚙에서 `permissions.request`로 받아야 동작한다(거부되면 `basic`으로 저장). 페이지 내용은 opencode를 거쳐 AI 제공자로 가므로 `PRIVACY.md`에 이 흐름을 명시해 두었다 — 전송 범위를 바꾸면 방침도 같이 고친다.
- 모델 응답은 신뢰할 수 없는 입력(프롬프트 인젝션)이다. 마크다운은 반드시 `renderMarkdown()`(marked → DOMPurify, 원격 이미지는 링크로 치환, 링크는 http(s)/mailto만 새 탭)으로 그린다. manifest CSP도 `img-src 'self' data:`, `frame-src 'none'`으로 막는다. `marked.parse` 결과를 `innerHTML`에 직접 넣지 않는다.

### 권한/질문 요청 (permission.asked / question.asked)
- `subscribeToEvents`가 본 세션과 하위(subagent, `session.created`의 `parentID`) 세션의 요청을 `onPart({kind:'permission'|'question'})`로 사이드패널에 넘기고, 카드의 응답은 `reply-permission`(`POST /permission/{id}/reply {reply}`, 404면 구버전 `/session/{sid}/permissions/{id}`) / `reply-question`(`POST /question/{id}/reply {answers}`) / `reject-question`으로 보낸다. 요청이 남아 있는 동안에는 무응답 제한 대신 30분 상한만 둔다(제한 시간이 켜져 있을 때).
- **탭 전환·재오픈 복원**: 사이드패널은 하나의 화면을 여러 탭이 같이 쓰고, `reinitForTab`이 서버 대화 기록으로 다시 그린다. 그래서 진행 중이던 응답 표시와 오류 문구가 사라졌다.
  - `get-session-history`가 진행 중 구독의 `controller.snapshot()`(현재 턴 텍스트 `buffer`, 청크 순번 `seq`, `turnParentId`, 턴 시작·마지막 활동 시각, retry, 대기 메시지 수)을 `stream`으로 함께 준다.
  - 사이드패널은 그 턴의 assistant 메시지(`parentID === turnParentId`)를 기록에서 빼고, 스냅샷 텍스트로 말풍선·진행 표시·■ 버튼을 복원한다(`restoreActiveStream`).
  - 다시 그리는 동안 온 응답 이벤트는 `deferredStreamEvents`에 모았다가 재생한다. `seq ≤ snapshot.seq`인 청크는 건너뛴다.
  - 오류 문구는 서버 기록에 없으므로 SW가 `sessionNotices`(`storage.session`, `{afterId, text}`)에 남기고, 기록과 함께 돌려줘 같은 자리에 다시 그린다.
- **카드 위치**: 카드는 대화 목록 맨 끝에 붙는다. 예전에는 응답 말풍선이 카드 위에 남아 있어서, 답한 뒤 이어지는 응답이 카드 위에 쌓여 안 보였다. 지금은 카드를 붙이기 전에 `splitActiveMessage()`가 현재 말풍선을 `earlierSegments`로 넘겨 마무리하고, 카드 아래에 typing indicator를 둔다. 이후 내용은 카드 아래 새 말풍선에 그린다. 앞 말풍선에 이미 있는 도구·reasoning·subagent 블록의 후속 갱신(권한을 요청한 도구의 완료 등)은 `earlierSegmentFor`로 찾아 원래 자리에서 갱신한다. 완료·중단·다음 턴에서는 `settleEarlierSegments`로 실행 중 표시를 정리한다. 완료 시 REST 폴백 텍스트는 어느 말풍선에도 텍스트가 없을 때만 붙인다(`responseHasText`).
- 타임아웃은 텍스트 delta뿐 아니라 도구 상태 변경(`message.part.updated`), `message.updated`, `session.status`(busy/retry), 하위 세션 활동에서도 리셋된다. 완료는 `session.idle` 또는 `session.status` idle(어시스턴트 메시지를 본 뒤)이며, SSE 재연결 직후에는 `/session/status`로 놓친 idle을 확인한다.
- **응답 제한 시간**: ⚙의 `chrome.storage.local.responseTimeoutMin`(`0`(없음, 기본)|5|10|30분, `RESPONSE_TIMEOUT_CHOICES_MIN`은 background·sidepanel 양쪽에 있다). 느린 사내 LLM은 첫 토큰까지 수 분이 걸려 예전 고정 180초 제한에 끊겼다. 값은 프롬프트를 보낼 때 읽어 `subscribeToEvents({idleTimeoutMs})`와 `pendingPrompts`(SW 재시작 복구의 `maxAgeMs`)에 넘긴다. 설정과 무관하게 `STREAM_QUIET_CHECK_MS`(60초) 동안 이벤트가 없으면 `checkQuiet`가 `/session/status`(작업 폴더 instance)를 묻는다. busy/retry면 계속 기다리며 `onPart({kind:'heartbeat', state:'busy'})`, idle이면 완료 처리한다(응답이 시작조차 안 됐으면 2회 연속 확인 후 오류). 연결 실패가 3회 이어지면 오류로 끝낸다. 복구 폴링도 서버에 60초간 연결하지 못하면 포기한다. 사이드패널은 이벤트 종류로 단계(모델 대기/생각/작성/도구/하위 에이전트/사용자 응답 대기)를 정하고, 경과 시간·마지막 활동·heartbeat 결과를 1초마다 그린다(`renderProgress`).
- **대기(pending) 메시지**: 응답 중 Enter는 `queue-message`로 같은 세션에 `prompt_async`만 보낸다(SSE 구독은 유지). opencode는 busy 세션의 프롬프트를 204로 받아 큐에 넣고, 현재 응답이 끝나면 처리한다. 새 assistant 메시지의 `parentID`가 그 대기 user 메시지이고, idle은 큐가 다 빈 뒤 한 번만 온다(1.19.5 실측). background는 user 메시지 id 순서로 부모를 찾아 `onPart({kind:'turn-start', consumed, newBubble})`를 보내고 `buffer`를 새 턴 기준으로 비운다. 사이드패널은 이 신호에 대기 배지를 지우고 그 말풍선 아래에 새 응답 말풍선을 연다. 처리 전에 idle이 오면 `QUEUE_IDLE_GRACE_MS` 뒤 상태를 다시 보고, 그래도 idle이면 완료 처리한다(남은 말풍선은 "처리되지 않음"). abort는 대기 메시지도 처리하지 않지만, 메시지는 서버 기록에 남는다(실측). 진행 중인 구독이 없으면 `{queued:false}`를 돌려주고, 사이드패널이 완료 후 일반 전송한다.
- **제공자 재시도**: `session.status` retry(`{attempt, message, next}`, `next` = 다음 시도 epoch ms)는 대기 중 이벤트가 없고 `Retry-After`에 상한이 없어 응답 제한 시간보다 길 수 있다. 그래서 `next + 제한 시간`까지 타임아웃을 연장하고, `onPart({kind:'retry'})`로 사이드패널 로딩 표시를 "재시도 대기 (N회차) · M초 후"로 바꾼다. busy·delta·도구/텍스트 파트가 오면 `retry-cleared`로 되돌린다(`message.updated`·retry 파트는 대기 중에도 오므로 해제 신호가 아니다). 하위 세션의 retry도 같은 방식으로 처리한다.
- **하위 에이전트 진행 표시**: task 도구가 띄운 하위 세션은 수 분간 일할 수 있는데(타이머는 하위 활동으로 계속 연장된다) 화면에는 task 카드 하나만 "실행 중…"으로 남아 멈춘 것처럼 보였다. `lib/subagent-progress.mjs`가 하위·손자 세션 이벤트를 요약해 `onPart({kind:'subagent', toolId, agent, steps, activity, startedAt})`로 보내고, 사이드패널이 task 카드 아래에 "explore · bash 실행 중 · 12단계 · 3:42"를 그린다(경과 시간은 1초마다 갱신, 끝나면 고정). 연결 고리는 실행 중인 task 파트의 `state.metadata.sessionId`(실측)이고, 손자 세션은 `session.created`의 `parentID`로 같은 카드에 합친다. 하위 세션의 첫 user 메시지(task 프롬프트) text 파트는 활동으로 세지 않는다. 하위 에이전트 실행 시간에 상한은 두지 않는다.
- 스트림 컨트롤러가 `abort`되면(중단 버튼, 전송 실패, 새 프롬프트가 구독을 대체) 무응답 타이머도 함께 끝난다. 남은 타이머가 뒤늦게 돌면 서버 세션을 `abort`해 다음 프롬프트까지 죽이기 때문이다. `prompt_async`가 `PROMPT_SEND_TIMEOUT_MS` 안에 응답하지 않으면 구독을 끝내 늦게 접수된 응답이 실패 표시 뒤에 섞이지 않게 하고, 서버 세션에도 `abort`를 요청한다(접수 전에 도착하면 효과가 없는 최선 노력이라 프롬프트가 서버 기록에 남을 수 있다).
- **세션 상태는 디렉터리 instance별**: opencode는 `?directory=` → `x-opencode-directory` → 서버 cwd 순으로 instance를 고르고, `/session/status`는 그 instance의 상태만 돌려준다(헤더 없이 물으면 작업 폴더 세션이 `{}` = idle로 보인다, 1.19.4 실측). 그래서 재연결 후 idle 확인과 SW 재시작 복구(`pendingPrompts`에 `directory` 저장)는 프롬프트를 보낸 디렉터리로 묻는다(`sessionStatusInit`). `abort`는 헤더 없이도 동작한다(실측).

## Key Constraints

- **빌드 파이프라인 없음**: Webpack/Vite 미사용. `scripts/build.js`는 단순 파일 복사 + zip. 소스 파일을 직접 수정하면 빌드에 반영됨.
- **테스트**: 프레임워크 없이 Node 내장 러너만 사용(`yarn test`). `lib/sw-resilience.mjs`(SW 종료 대응) 단위 테스트와, `test/subagent-progress.test.mjs`, `test/stream-stall.test.mjs`(실제 `background.js`를 `test/helpers/background-harness.mjs`로 chrome 스텁과 함께 불러와 `test/helpers/mock-opencode.mjs` 가짜 서버로 retry/전송 지연/중단을 재현)가 있다. 하네스는 `DEFAULT_PORT`·`MAX_PORT_CHECK`와 `const NAME = 값;` 형태 상수(`RESPONSE_TIMEOUT_UNIT_MS`·`STREAM_QUIET_CHECK_MS`·`QUEUE_IDLE_GRACE_MS` 등)만 소스 치환하므로 이 선언 형태를 바꾸면 하네스도 같이 고친다.
- **SW 종료 대응**: 응답 대기 중 MV3 SW가 30초 idle로 죽으면 SSE·타임아웃이 사라져 UI가 멈춘다. `subscribeToEvents`가 keepalive(20초 ping)와 `storage.session.pendingPrompts` 기록을 걸고, SW 재시작 시 `recoverInterruptedPrompts`가 `/session/status` 폴링 → REST 내용으로 `message-complete`를 보낸다.
- **Windows 전용 Native Host**: `native-host/`는 Windows 레지스트리(`install.reg`)에 경로를 등록해야 동작. WSL에서는 개발만 가능.
- **native-host/manifest.json의 `allowed_origins`**: Web Store 확장 ID(`jchffojdjnhpmdgnifkhpgmgokbidobi`)로 고정. manifest의 `key`가 이 ID를 만들며, Web Store용 zip에서는 `key`를 제거한다.
- **i18n**: `manifest.json`의 이름/설명은 `_locales/{ko,en}/messages.json`의 `__MSG_*__`(브라우저 언어를 따름). 사이드패널 UI 언어는 `chrome.i18n`으로 런타임 전환이 안 되므로 `sidepanel/i18n.js`가 따로 처리한다: **한국어 원문을 키로** 쓰는 `t('원문', {param})`(사전 `EN`에 없으면 원문 그대로 → 기본 ko), 정적 HTML은 `data-i18n`/`data-i18n-html`/`data-i18n-title`/`data-i18n-placeholder`(요소의 원래 한국어가 키). 선택값은 `chrome.storage.local.lang`(`ko`|`en`)이고 ⚙ 설정 맨 위에서 바꾼다. 새 UI 문자열을 추가하면 한국어로 `t()`/속성을 쓰고 `i18n.js`의 `EN`에 번역을 넣는다. background가 돌려주는 오류 문구는 사이드패널에서 `t(error)`로 감싸 번역한다. `/debug` 로그와 모델에 보내는 프롬프트는 번역하지 않는다.
