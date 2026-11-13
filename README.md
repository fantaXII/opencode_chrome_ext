# OpenCode Chrome Extension

내 PC에서 실행되는 AI 코딩 에이전트 [OpenCode](https://opencode.ai)를 Chrome 사이드패널에서 사용하는 확장 프로그램입니다. 확장이 로컬 OpenCode 서버(`opencode serve`)를 찾거나 직접 띄워서 연결하므로, 터미널을 열지 않고 브라우저에서 바로 대화할 수 있습니다.

## 목차

1. [주요 기능](#주요-기능)
2. [아키텍처](#아키텍처)
3. [요구사항](#요구사항)
4. [설치](#설치)
5. [사용 방법](#사용-방법)
6. [설정(⚙) 메뉴](#설정-메뉴)
7. [WSL 지원](#wsl-지원)
8. [문제 해결](#문제-해결)
9. [개발](#개발)
10. [빌드 및 배포](#빌드-및-배포)
11. [개인정보](#개인정보)

---

## 주요 기능

- **사이드패널 채팅**: 응답을 실시간 스트리밍으로 표시합니다. 마크다운·코드 하이라이트, 도구 실행 상태, 추론(reasoning) 블록을 함께 보여줍니다.
- **서버 자동 관리**: 포트 4096~4105에서 실행 중인 OpenCode 서버를 찾고, 없으면 Native Messaging Host로 직접 시작합니다. 서버를 Windows에 띄울지 WSL에 띄울지 고를 수 있습니다.
- **탭별 세션**: 탭마다 독립된 세션을 만듭니다. TUI처럼 탭을 닫거나 `exit`로 패널을 닫거나 작업 폴더를 바꿔도 대화 기록은 서버에 남고, `/sessions`로 불러와 이어갈 수 있습니다(불러온 세션은 원래 작업 폴더로 동작합니다).
- **페이지 컨텍스트**: 메시지를 보낼 때 현재 탭의 제목·URL을 붙입니다(기본값). 끄거나, 권한을 허용해 본문 일부와 선택 텍스트까지 보낼 수 있습니다.
- **모델 선택**: 최근 사용한 모델은 펼쳐서, 나머지는 제공자(provider)별로 접어서 보여줍니다.
- **에이전트 전환**: `Shift+Tab` 또는 에이전트 칩 클릭으로 OpenCode 에이전트(build/plan 등)를 바꿉니다.
- **권한·질문 요청**: OpenCode가 도구 실행 권한을 묻거나 질문하면 카드로 표시하고 그 자리에서 응답합니다(하위 에이전트 요청 포함). 응답한 뒤 이어지는 내용은 카드 아래의 새 말풍선에 표시됩니다.
- **MCP 관리**: MCP 서버 목록을 보고 연결을 켜고 끕니다. 새로 등록한 MCP/skill/agent는 "설정 다시 읽기"로 반영합니다.
- **파일 첨부·작업 폴더**: 파일을 첨부하고 OpenCode가 작업할 폴더를 지정합니다(폴더 선택 대화상자 지원).
- **슬래시 커맨드**: 확장 자체 커맨드와 OpenCode 서버에 등록된 커맨드를 자동완성으로 실행합니다.
- **입력 기록**: TUI처럼 입력창에서 `↑`/`↓`로 현재 세션에서 보낸 입력을 다시 불러옵니다.
- **단축키**: `chrome://extensions/shortcuts`에서 사이드패널 열기 키를 직접 지정할 수 있습니다(기본 키 없음).
- **설정(⚙)**: 언어(한국어/English), 페이지 컨텍스트, 응답 제한 시간, 실행 환경, 프록시, 서버 강제 재시작, 버전·업데이트 확인
- **디버그 로그**: `/ext-log`로 Service Worker 로그와 Native Host 파일 로그를 한 번에 보고 복사합니다.

---

## 아키텍처

```
┌──────────────── Chrome (Windows) ────────────────┐
│                                                  │
│  Side Panel ──sendMessage──▶ Service Worker      │
│  (sidepanel.js)  ◀──push────  (background.js)    │
│                                │        │        │
└────────────────────────────────┼────────┼────────┘
                 sendNativeMessage│        │ REST + SSE
                                  ▼        │ (127.0.0.1:4096~4105)
                       Native Host         │
                       (native-host/host.js, Node.js)
                                  │        │
                       spawn opencode serve│
                                  ▼        ▼
                         OpenCode Server (Windows 또는 WSL)
                                  │
                                  ▼
                       OpenCode에 설정한 AI 제공자
```

| 컴포넌트 | 역할 |
|---------|------|
| Side Panel (`sidepanel/`) | 채팅 UI. 모든 백엔드 통신을 Service Worker에 위임하고, 스트리밍 청크는 push로 받아 렌더링 |
| Service Worker (`background.js`) | 서버 탐색·상태 감시(30초 주기), 세션 관리, OpenCode REST API 호출, 세션별 SSE 구독 |
| Native Host (`native-host/host.js`) | OpenCode 서버 시작/종료/재시작, 폴더·파일 선택 대화상자, 경로 검증, 로그 파일. 메시지마다 새 프로세스로 실행됨 |
| OpenCode Server | AI 대화, 도구·MCP·skill 실행, REST API + SSE 제공 |

### 사용하는 OpenCode REST API

| 엔드포인트 | 용도 |
|-----------|------|
| `GET /global/health` | 서버 상태 확인 |
| `POST /session`, `GET /session/{id}` | 세션 생성 / 세션 작업 폴더 확인 |
| `POST /session/{id}/prompt` | 메시지 전송 |
| `GET /event` | SSE 이벤트 스트림 |
| `GET /session/status` | 세션 busy/idle 확인 (재연결·SW 재시작 복구) |
| `GET /config/providers`, `PATCH /config` | 모델 목록 / 모델 변경 |
| `POST /permission/{id}/reply`, `POST /question/{id}/reply` | 권한·질문 요청 응답 |
| `POST /global/dispose` | 소프트 재시작 (config/MCP/skill/agent 다시 읽기) |

### 서버 재시작 (2단계)

OpenCode는 새로 등록한 MCP/skill/agent를 자동으로 반영하지 않습니다(설정이 instance 단위로 캐시됨). 그래서 재시작을 두 가지로 나눴습니다.

| | 설정 다시 읽기 (소프트) | 서버 강제 재시작 (하드) |
|---|---|---|
| 위치 | MCP 메뉴의 "↻ 설정 다시 읽기" | ⚙ 설정의 "서버 강제 재시작" |
| 방법 | `POST /global/dispose` | Native Host가 포트를 점유한 프로세스를 종료하고 다시 실행 |
| 소요 | 1~2초 | 10~30초 |
| 프로세스·포트 | 유지 | 새로 생성, **포트가 바뀔 수 있음** |
| 용도 | MCP/skill/agent 등록 반영 | 서버가 응답하지 않을 때, 실행 환경·프록시 변경 적용 |

두 경우 모두 진행 중이던 응답은 중단됩니다. 하드 재시작 중에는 처음 연결할 때처럼 입력이 막히고 "재시작 중..."이 표시되며, 다른 창의 사이드패널도 함께 막힙니다.

---

## 요구사항

### 사용 환경

- Windows 10/11 + Google Chrome
- [OpenCode CLI](https://opencode.ai) — Windows 또는 WSL 중 한 곳 이상에 설치
- Node.js 18+ (Native Host 실행용. 없으면 인스톨러가 winget으로 LTS 설치를 시도합니다)
- WSL에서 OpenCode를 쓰는 경우: WSL2 + mirrored networking ([WSL 지원](#wsl-지원) 참고)

### 개발 환경

- Node.js 18+, yarn 1.22+, Git (WSL/Linux에서 개발 가능)
- 인스톨러를 빌드하려면 NSIS (`sudo apt-get install nsis`)

---

## 설치

### 1. 확장 프로그램 설치

Chrome Web Store에서 **OpenCode Chrome Extension**을 설치합니다. 확장 업데이트는 Web Store를 통해 자동으로 이루어집니다.

### 2. Native Messaging Host 설치

1. [GitHub Releases](https://github.com/fantaXII/opencode_chrome_ext/releases)에서 확장과 **같은 버전**의 `opencode-native-host-setup-v{버전}.exe`를 내려받습니다.
2. 실행해 설치 마법사를 완료합니다. SmartScreen 경고가 뜨면 **"추가 정보" → "실행"**을 누릅니다.
   - 설치 위치: `%LOCALAPPDATA%\OpenCodeChrome\native-host\`
   - Chrome Native Messaging 레지스트리(HKCU)를 등록하고, 필요하면 WSL mirrored networking 설정을 안내합니다.
3. Chrome을 다시 시작합니다.

Native Host가 없으면 사이드패널이 설치 안내와 다운로드 링크를 보여줍니다. 설치된 host가 확장보다 구버전이면 업데이트 안내가 뜹니다(host는 Web Store가 갱신하지 못하므로 새 `.exe`를 기존 설치 위에 다시 설치하면 됩니다).

> **사내 사용자**: `config.private.json`(`config.private.json.sample` 참고)을 `.exe`와 같은 폴더에 두고 실행하면 프록시·MCP 설정이 함께 적용됩니다. 파일은 설치가 끝나면 삭제되고, 프록시 값은 `%LOCALAPPDATA%\OpenCodeChrome\proxy.json`에 남아 확장의 ⚙ 설정으로 한 번 가져옵니다.

### 3. 작동 확인

툴바의 확장 아이콘을 눌러 사이드패널을 열고, 헤더가 "연결됨"이 되면 메시지를 보내 봅니다.

---

## 사용 방법

### 사이드패널 열기

- **확장 아이콘 클릭**: 현재 탭에 사이드패널이 열리고, 그 탭의 세션이 만들어집니다.
- **선택 텍스트 보내기**: 페이지에서 텍스트를 선택하고 우클릭 → **"OpenCode로 보내기"**. 사이드패널이 열리며 선택한 텍스트가 입력창에 채워집니다.
- **단축키**: 기본 단축키는 없습니다. `chrome://extensions/shortcuts`에서 OpenCode Chat 항목에 원하는 키를 지정하면, 그 키로 아이콘을 클릭한 것과 똑같이 사이드패널이 열립니다(열기만 되고, 같은 키로 닫히지는 않습니다). Chrome 기본 단축키(예: `Ctrl+Shift+O` 북마크 관리자)와 겹치는 키는 지정할 수 없습니다.

사이드패널은 탭별로 동작합니다. 패널을 연 적 있는 탭으로 돌아가면 그 탭의 대화가 그대로 보이고, 연 적 없는 탭에서는 자동으로 열리지 않습니다.

### 대화하기

1. 입력창에 메시지를 입력하고 Enter(줄바꿈은 Shift+Enter) 또는 전송 버튼을 누릅니다.
2. 페이지 컨텍스트 설정에 따라 현재 탭의 제목·URL(또는 본문·선택 텍스트)이 함께 전달됩니다.
3. 응답이 스트리밍으로 표시됩니다. 응답 중에는 전송 버튼이 중지 버튼으로 바뀝니다.
4. 입력창 위의 진행 표시에 현재 단계(모델 응답 대기 / 생각 중 / 응답 작성 중 / 도구 실행 중 / 하위 에이전트 작업 중)와 경과 시간이 나옵니다. 30초 이상 아무 진행이 없으면 마지막 활동 시각이 함께 표시되고, 서버에 상태를 물어 "서버 처리 중 확인됨"인지 알려 줍니다. 그래서 느린 모델도 멈춘 것인지 아직 일하는 중인지 구분할 수 있습니다.
5. 응답 중에도 메시지를 입력하고 Enter를 누르면 **대기 메시지**로 서버 큐에 들어갑니다. 말풍선에 "대기 중"이 표시되고, 현재 응답이 끝나면 모델이 이어서 처리하며 그 아래에 새 응답이 나옵니다. 중지 버튼을 누르면 대기 메시지는 처리되지 않습니다. 이때 말풍선에 "처리되지 않음"이 표시되지만, 메시지는 서버 기록에 남아 다음 대화의 맥락에 포함될 수 있습니다. 응답 중에는 슬래시 커맨드를 실행할 수 없습니다.

같은 탭에서 다른 페이지로 이동하면(SPA 화면 전환 포함) 대화 중간에 "페이지가 변경되었습니다" 안내가 표시됩니다. 세션은 그대로 이어지고, 이후 메시지부터 새 페이지 정보가 전달됩니다.

### 입력창 위의 칩

| 칩 | 동작 |
|----|------|
| 에이전트 | 클릭 또는 `Shift+Tab`으로 다음 에이전트로 전환 |
| 모델 | 클릭하면 모델 목록이 열립니다. **최근 사용**(최대 5개)은 펼쳐져 있고, 나머지는 **제공자별로 접혀** 있어 제공자를 눌러 펼칩니다. 현재 모델은 ✓, 그 모델의 제공자에는 점(•)이 표시됩니다 |
| 작업 폴더 | OpenCode가 작업할 디렉터리. ✎로 직접 입력하거나 폴더 아이콘으로 선택합니다. 존재하지 않는 경로는 저장되지 않습니다. 폴더는 세션마다 따로 적용됩니다. 바꾸면 그 탭은 새 폴더로 새 세션을 시작하고(이전 대화는 `/sessions`로 다시 열 수 있습니다), 다른 탭의 기존 대화는 원래 폴더로 계속 동작합니다. 다른 탭에서는 새 세션을 시작할 때(`/new` 등)부터 바꾼 폴더가 적용됩니다 |
| ＋ (첨부) | 파일 선택 대화상자로 파일을 첨부합니다 |

### 슬래시(`/`) 커맨드

입력창에 `/`를 입력하면 자동완성 목록이 열립니다.

| 커맨드 | 설명 |
|--------|------|
| `/help` | 사용 가능한 커맨드 목록 |
| `/clear` | 채팅 히스토리 초기화 |
| `/new` | 새 세션 시작 |
| `/sessions`, `/resume` | 이전 세션 목록에서 골라 대화 이어가기 |
| `/model [이름]` | 이름 없이 입력하면 모델 선택 목록, 이름을 주면 바로 변경 |
| `/wd <경로>` | 작업 디렉터리 변경 |
| `/ext-log` | 디버그 로그 표시·복사 ([문제 해결](#디버그-로그-확인) 참고) |
| `exit` (`/exit`, `quit`) | 사이드패널을 닫습니다. 응답 중이면 먼저 중단합니다. 대화 기록은 서버에 남아 `/sessions`로 이어갈 수 있고, 이 탭에서 다시 열면 새 세션으로 시작합니다. 입력 전체가 정확히 일치할 때만 동작합니다 |

이 밖에 OpenCode 서버에 등록된 커맨드(사용자 정의 커맨드, 플러그인 커맨드 등)도 목록에 함께 나오며 그대로 실행됩니다.

### 권한·질문 요청

OpenCode가 파일 수정이나 명령 실행 권한을 요청하면 "한 번 허용 / 항상 허용 / 거부" 카드가, 질문을 하면 선택지 카드가 표시됩니다. 응답을 기다리는 동안에는 무응답 타임아웃이 적용되지 않습니다.

### MCP 메뉴

헤더의 MCP 버튼에서 MCP 서버별 연결 상태를 보고 켜고 끌 수 있습니다. OpenCode 설정에 MCP/skill/agent를 새로 추가했다면 **↻ 설정 다시 읽기**를 누릅니다.

---

## 설정 메뉴

헤더의 ⚙ 버튼에서 설정합니다. 새 확장 버전이 준비되면 ⚙에 점(•)이 표시됩니다.

| 항목 | 설명 |
|------|------|
| 언어 / Language | 사이드패널 UI 언어(한국어 기본, English). 브라우저 언어와 별도로 저장 |
| 페이지 컨텍스트 | 보내지 않음 / 제목·URL(기본) / 제목·URL·본문·선택 텍스트. 마지막 항목은 페이지 읽기 권한(`<all_urls>`)을 요청하며, 거부하면 제목·URL로 저장됩니다 |
| 응답 제한 시간 | 없음(기본) / 5분 / 10분 / 30분. 그 시간 동안 아무 진행이 없으면 응답을 중단합니다. "없음"이면 시간으로 끊지 않고, 1분 이상 조용할 때마다 서버 상태를 확인합니다. 서버가 처리 중이면 계속 기다리고, 끝났으면 완료 처리하며, 서버에 연결할 수 없으면 오류로 끝냅니다. 다음 메시지부터 적용됩니다 |
| 실행 환경 | 서버를 띄울 환경 우선순위: 자동(WSL 우선) / WSL / Windows. 현재와 다른 환경을 고르면 확인 후 하드 재시작하며, 재시작이 성공해야 저장됩니다 |
| 프록시 | HTTP / HTTPS / 제외 목록(NO_PROXY). 아래 참고 |
| 서버 강제 재시작 | 하드 재시작(10~30초, 포트가 바뀔 수 있음) |
| 정보 | 확장·Native Host 버전, 확장 업데이트 확인/적용 |

### 프록시 설정

- 값은 `chrome.storage.local`에 **평문**으로 저장됩니다. `http(s)://`, `socks5(h)://` 형식만 허용하며, 계정이 필요하면 `http://user:pass@host:port` 형식으로 씁니다.
- 서버를 시작/재시작할 때 OpenCode 프로세스의 `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` 환경변수로 주입됩니다. 프로세스 환경변수이므로 **저장 후 하드 재시작해야 반영**됩니다.
  - 확장이 띄운 서버면 바로 재시작할지 묻습니다.
  - 터미널이나 VS Code 등에서 띄운 서버면 "저장만" / "그래도 재시작" 중에서 고릅니다.
- 빈 항목은 건드리지 않아 기존 시스템 환경변수가 그대로 쓰입니다.
- WSL 서버에는 `WSLENV`를 통해 대문자 이름의 변수만 전달됩니다.

---

## WSL 지원

Windows에 OpenCode가 없고 WSL에만 설치된 환경에서도 동작합니다. Native Host가 `wsl.exe`로 WSL 안의 OpenCode를 실행하고, WSL2 mirrored networking 덕분에 Windows의 Chrome이 `127.0.0.1:4096`으로 접근합니다.

### 실행 환경 선택

- ⚙의 **실행 환경** 값에 따라 탐색 순서가 정해집니다. `windows`면 Windows → WSL, `자동`·`wsl`이면 WSL → Windows 순서이고, 한쪽에서 못 찾으면 반대쪽으로 넘어갑니다.
- 이미 서버가 여러 개 떠 있으면 각 서버의 작업 디렉터리 형식(`C:\` → Windows, `/` → WSL)으로 환경을 판별해 같은 우선순위로 고릅니다.
- 연결된 서버의 환경은 헤더에 배지로 표시됩니다.

### WSL에서 opencode 찾는 순서

`.bashrc`의 interactive 가드 때문에 비대화형 셸에서는 PATH가 다 로드되지 않을 수 있어, 다음 순서로 시도합니다.

1. 공식 설치 스크립트 기본 경로: `$HOME/.opencode/bin/opencode`
2. NVM 환경: `. "$HOME/.nvm/nvm.sh"; which opencode`
3. interactive login 셸: `bash -ilc 'which opencode'`

> 3번은 `.bashrc` 전체를 실행하므로 `sudo`나 무거운 초기화가 있으면 타임아웃으로 실패할 수 있습니다. OpenCode를 `~/.opencode/bin`에 설치해 두면 1번에서 바로 찾습니다.

### WSL2 mirrored networking 설정

인스톨러가 설정 여부를 확인하고 자동 설정을 제안합니다. 직접 설정하려면:

```ini
# %USERPROFILE%\.wslconfig
[wsl2]
networkingMode=mirrored
```

저장한 뒤 PowerShell에서 `wsl.exe --shutdown`을 실행하고 WSL을 다시 엽니다. mirrored 모드는 Windows 11과 WSL 0.67.6 이상이 필요합니다(`wsl --version`, 낮으면 `wsl --update`).

---

## 문제 해결

### 디버그 로그 확인

문제가 생기면 먼저 로그를 확인하세요.

1. 입력창에 `/ext-log`를 입력해 전송합니다. 서버 연결에 실패한 화면에서는 **로그 보기** 버튼을 누릅니다.
2. 다이얼로그에 두 가지 로그가 표시됩니다.
   - **Service Worker Logs**: 서버 탐지, 세션, 메시지 송수신, SSE 이벤트 등(최대 500건)
   - **Native Host File Log**: `%LOCALAPPDATA%\OpenCodeChrome\logs\native-host.log`
3. **복사** 버튼으로 전체 로그를 복사해 GitHub 이슈에 첨부할 수 있습니다.

> Native Host File Log에 "파일 로그 없음"이 보이면 Native Host 연결 자체가 실패한 것입니다. Service Worker Logs에서 `NativeMsg:`로 시작하는 오류를 먼저 확인하세요.

### 증상별 확인

| 증상 | 확인할 것 |
|------|----------|
| "Native Messaging Host가 설치되지 않음" 안내 | 인스톨러를 실행했는지, Chrome을 재시작했는지 확인 |
| `opencode를 찾을 수 없음 (Windows/WSL 모두 확인)` | Windows: `where opencode` / WSL: `which opencode`, `opencode --version`. WSL이면 [찾는 순서](#wsl에서-opencode-찾는-순서) 참고 |
| 서버 연결 실패 (WSL) | `.wslconfig`의 `networkingMode=mirrored`, `wsl.exe --shutdown` 후 재시도, `wsl ss -ltnp \| grep 4096`으로 포트 확인 |
| 서버를 직접 띄워 확인 | `opencode serve --port 4096` 실행 후 사이드패널의 **재연결** |
| 응답이 비어 있음 | 작업 폴더가 서버 환경(Windows/WSL)에 실제로 있는지, 모델·API 키 설정 확인 |
| 새 MCP/skill이 안 보임 | MCP 메뉴의 **↻ 설정 다시 읽기** |
| 서버가 응답하지 않음 | ⚙ → **서버 강제 재시작** |
| 확장을 다른 ID로 로드함(개발용) | `%LOCALAPPDATA%\OpenCodeChrome\native-host\configure-extension-id.bat <확장 ID>` |

---

## 개발

### 디렉터리 구조

```
opencode_chrome_ext/
├── manifest.json               # Manifest V3 (service worker는 ES module)
├── background.js               # Service Worker: 서버·세션·REST·SSE·Native Messaging
├── lib/
│   ├── part-router.mjs         # SSE 메시지 파트 라우팅
│   └── sw-resilience.mjs       # SW 종료 대응(keepalive, 중단된 프롬프트 복구)
├── sidepanel/
│   ├── sidepanel.html / sidepanel.js / styles.css
│   ├── i18n.js                 # UI 언어 전환 (한국어 원문을 키로 사용)
│   ├── block-state.js          # 스트리밍 블록 상태
│   ├── render-scheduler.js     # 렌더링 스케줄러
│   └── marked / purify / highlight .min.js  # 마크다운 → DOMPurify 정화, 코드 하이라이트
├── native-host/                # Native Messaging Host (Windows)
│   ├── host.js                 # 호스트 프로그램 (Node.js)
│   ├── install.ps1             # 레지스트리 등록, Node.js·WSL 설정
│   ├── install.bat / install.reg / uninstall.reg
│   ├── manifest.json           # allowed_origins = Web Store 확장 ID
│   └── package.json            # which 의존성
├── installer/
│   ├── installer.nsi           # NSIS 인스톨러 스크립트
│   └── configure-extension-id.bat
├── _locales/{ko,en}/messages.json  # 확장 이름/설명
├── scripts/
│   ├── build.js                # dist/ 복사 + zip 생성
│   ├── build-installer.js      # NSIS 인스톨러 빌드
│   ├── set-webstore-key.js(.bat)   # Web Store 공개키 주입
│   └── bump-version.js, generate-icons.js, test-*.mjs, selftest-*.js
├── test/                       # node --test 테스트
├── docs/                       # 설계 문서
├── config.private.json.sample  # 사내 배포용 설정 예시 (proxy / MCP)
├── PRIVACY.md                  # 개인정보처리방침
└── CHANGELOG.md
```

### 로컬 개발

```bash
git clone https://github.com/fantaXII/opencode_chrome_ext.git
cd opencode_chrome_ext
yarn install
yarn build
```

`chrome://extensions` → 개발자 모드 → **압축 해제된 확장 프로그램 로드** → `dist/` 선택. 소스를 고친 뒤에는 `yarn build`를 다시 하고 확장을 새로고침합니다.

- **빌드 파이프라인 없음**: Webpack/Vite를 쓰지 않습니다. `scripts/build.js`는 파일을 복사하고 zip을 만듭니다.
- **확장 ID**: `manifest.json`의 `key`가 Web Store와 같은 ID(`jchffojdjnhpmdgnifkhpgmgokbidobi`)를 만들어, 로컬로 로드해도 Native Host의 `allowed_origins`와 맞습니다. 공개키를 바꿀 때는 `node scripts/set-webstore-key.js "MIIB..."`를 씁니다.
- **Native Host**: Windows에서만 동작합니다. WSL에서는 개발만 하고, 테스트는 빌드한 인스톨러를 Windows에서 실행하거나 `powershell -ExecutionPolicy Bypass -File native-host\install.ps1`로 설치합니다.
- **보안**: 모델 응답은 신뢰할 수 없는 입력으로 취급합니다. 마크다운은 반드시 `renderMarkdown()`(marked → DOMPurify)으로 그리고, manifest CSP로 원격 이미지·iframe을 막습니다.
- **i18n**: 새 UI 문자열은 한국어로 `t('원문')`을 쓰고 `sidepanel/i18n.js`의 `EN`에 번역을 추가합니다.

### 테스트

```bash
yarn test   # node --test (SW 종료 대응, host 디렉터리 처리)
```

---

## 빌드 및 배포

```bash
yarn build             # dist/ + zip 생성 (prebuild가 dist를 지움)
yarn build:installer   # NSIS 인스톨러 (.exe, 프로젝트 루트)
yarn build:all         # 인스톨러 + 확장 전체 빌드
yarn release           # 버전 올림 + CHANGELOG + 태그 + GitHub Release
```

`yarn build:all` 결과:

| 파일 | 용도 |
|------|------|
| `opencode-native-host-setup-v{버전}.exe` | Native Host 인스톨러 (GitHub Release에 첨부) |
| `dist/` | Chrome에 로드할 확장 파일 |
| `dist/opencode-chrome-ext-v{버전}-webstore.zip` | Web Store 제출용 (`key` 제거, 인스톨러 제외) |
| `dist/opencode-chrome-ext-v{버전}.zip` | 인스톨러를 포함한 전체 묶음 |

인스톨러는 확장과 같은 버전을 `version.txt`로 기록하고, 확장은 이 값으로 구버전 host를 판별합니다. 그래서 **확장과 인스톨러는 항상 같은 버전으로 함께 배포**해야 합니다.

### 릴리스

1. `.env_example`을 `.env`로 복사하고 `GITHUB_TOKEN`(repo 권한)을 넣습니다.
2. `yarn release` 실행 → 버전 선택(patch/minor/major).
   - `manifest.json`·`package.json` 버전 동기화
   - 인스톨러·확장 재빌드
   - `CHANGELOG.md` 갱신(conventional commits), 커밋·태그·push
   - GitHub Release 생성 (webstore zip과 `.exe` 첨부)
3. `dist/opencode-chrome-ext-v{버전}-webstore.zip`을 [Chrome Web Store 개발자 대시보드](https://chrome.google.com/webstore/devconsole)에 올립니다.

---

## 개인정보

확장에는 자체 서버가 없고 개발자는 사용자 데이터를 수집하지 않습니다. 메시지와 (설정에 따라) 페이지 정보는 내 PC의 OpenCode 서버로만 가며, OpenCode가 사용자가 설정한 AI 제공자에게 전달합니다. 자세한 내용은 [PRIVACY.md](PRIVACY.md)를 참고하세요.

## 라이선스

MIT License
