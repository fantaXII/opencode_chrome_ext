# OpenCode Chrome Extension

Chrome Extension을 통해 OpenCode를 사이드패널에서 사용할 수 있도록 하는 프로젝트입니다.

## 📋 목차

1. [개요](#개요)
2. [아키텍처](#아키텍처)
3. [사전 요구사항](#사전-요구사항)
4. [디렉토리 구조](#디렉토리-구조)
5. [설계 상세](#설계-상세)
6. [구현 내용](#구현-내용)
7. [개발](#개발)
8. [빌드 및 배포](#빌드-및-배포)
9. [설치 가이드](#설치-가이드)
10. [사용 방법](#사용-방법)
11. [문제 해결 시 디버그 로그 확인](#문제-해결-시-디버그-로그-확인)

---

## 개요

### 주요 기능

- **사이드패널 채팅 UI**: Chrome 사이드패널에서 OpenCode와 채팅
- **자동 서버 실행**: Native Messaging Host를 통해 OpenCode 서버 자동 시작/관리
- **세션 관리**: 탭마다 독립적인 세션 생성
- **웹페이지 컨텍스트**: 현재 탭의 제목·URL(기본)을 컨텍스트에 포함. ⚙ 설정에서 끄거나, 페이지 읽기 권한을 허용해 본문·선택 텍스트까지 포함 가능
- **권한/질문 요청 처리**: opencode가 도구 실행 권한이나 질문을 요청하면 사이드패널에 카드로 표시해 응답
- **모델 변경**: 사용자가 모델 선택 가능
- **MCP/Skill 지원**: OpenCode의 MCP 서버 및 Skill 활용 가능
- **설정(⚙) 메뉴**: 언어(한국어/English), 실행 환경(WSL/Windows), 프록시, 서버 강제 재시작, 버전 정보·업데이트 확인

### 기술 스택

- **Chrome Extension**: Manifest V3
- **Native Messaging Host**: Node.js (Windows)
- **OpenCode Server**: REST API + SSE

---

## 아키텍처

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Windows Chrome                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌─────────────────┐    ┌─────────────────┐    ┌────────────────┐  │
│  │   Side Panel    │───▶│  Service Worker │───▶│   Native       │  │
│  │   (Chat UI)     │    │  (Background)   │    │   Messaging    │  │
│  └─────────────────┘    └─────────────────┘    │   Host         │  │
│                                                └────────┬─────────┘  │
│                                                         │            │
│                                    stdin/stdout         │            │
│                                    (JSON Protocol)      │            │
│                                                         ▼            │
│                                              ┌────────────────────┐  │
│                                              │  OpenCode Server   │  │
│                                              │  (localhost:4096)  │  │
│                                              └────────────────────┘  │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### 컴포넌트 설명

| 컴포넌트 | 역할 |
|---------|------|
| Side Panel (Chat UI) | 사용자 인터페이스 - 메시지 입력, 응답 표시 |
| Service Worker | HTTP API 통신, 이벤트 관리, 서버 상태 모니터링 |
| Native Messaging Host | OpenCode 서버 시작/중지 명령, 포트 관리 |
| OpenCode Server | AI 채팅 처리, MCP/Skill 실행, REST API 제공 |

---

## 사전 요구사항

### 개발 환경 (WSL - 코드 작성용)

```bash
- Node.js 18+
- yarn 1.22+
- Git
```

### 실행 환경 (Windows - 실제 사용)

```bash
- Windows 10/11
- Google Chrome (최신 버전)
- Node.js 18+ (Native Messaging Host 실행용)
- OpenCode CLI 설치됨
```

---

## 디렉토리 구조

```
opencode-chrome-ext/
├── manifest.json              # Chrome Extension Manifest V3
├── background.js              # Service Worker (핵심 로직)
├── lib/
│   └── part-router.mjs        # 메시지 파트(SSE) 라우팅 로직
├── sidepanel/
│   ├── sidepanel.html         # 사이드패널 HTML
│   ├── sidepanel.js           # 사이드패널 로직
│   ├── i18n.js                # UI 언어 전환 (한국어 원문을 키로 사용)
│   ├── block-state.js         # 스트리밍 블록 상태 관리
│   ├── render-scheduler.js    # 렌더링 스케줄러
│   ├── marked.min.js / highlight.min.js  # 마크다운·코드 하이라이트
│   └── styles.css             # 스타일
├── native-host/               # Native Messaging Host (Windows 전용)
│   ├── manifest.json          # Native Messaging 매니페스트
│   ├── host.js                # Node.js 호스트 프로그램
│   ├── install.ps1            # 설치 스크립트 (레지스트리 등록)
│   └── package.json           # which 패키지 의존성
├── installer/                 # NSIS 인스톨러 관련
│   ├── installer.nsi          # NSIS 스크립트
│   └── configure-extension-id.bat  # 설치 후 Extension ID 재설정 도구
├── _locales/
│   ├── ko/messages.json        # 한국어 (확장 이름/설명)
│   └── en/messages.json        # 영어
├── config.private.json.sample  # 사내용 설정 예시 (proxy / MCP 서버)
├── icons/                     # 확장 프로그램 아이콘
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
├── scripts/
│   ├── build.js               # 빌드 스크립트
│   ├── build-installer.js     # NSIS 인스톨러 빌드 스크립트
│   ├── set-webstore-key.js    # Web Store 공개키 주입 도구
│   └── set-webstore-key.bat   # 위 스크립트 Windows 래퍼
├── package.json               # npm 패키지 설정
├── release.config.js          # release-it 설정
└── README.md                  # 이 문서
```

---

## 설계 상세

### 1. OpenCode 서버 관리

#### 서버 상태 확인 로직

```javascript
async function ensureOpenCodeServer() {
  // 1. 기본 포트(4096)에서 서버 상태 확인
  for (let port = 4096; port < 4106; port++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/global/health`);
      if (res.ok) return { port, available: true };
    } catch {
      continue;
    }
  }

  // 2. 서버가 없으면 Native Messaging으로 시작 명령
  await chrome.runtime.sendNativeMessage('com.opencode.chrome', {
    action: 'start',
    preferredPort: 4096
  });

  // 3. 서버 시작 대기 후 재확인
  return await waitForServer();
}
```

#### 포트 충돌 처리

- OpenCode는 기본적으로 4096 포트 사용
- 이미 사용 중이면 **자동으로 다음 사용 가능한 포트** 할당
- Extension에서는 서버 상태를 확인하고 **실제 사용 중인 포트에 연결**

### 2. 세션 관리

#### 세션 생성 규칙

```
새 탭 열림 → 새로운 세션 생성
세션 ID: UUID 기반 (ses_xxxxxxxxxxxxxxxx)
각 세션은 독립적인 컨텍스트 유지
```

#### 메시지 전송 Flow

```javascript
async function sendMessage(sessionId, message, tabInfo) {
  // 1. 현재 페이지 정보 포함
  const fullMessage = `
현재 페이지 정보:
- URL: ${tabInfo.url}
- 제목: ${tabInfo.title}

${message}
  `;

  // 2. 메시지 전송 (POST /session/{id}/prompt)
  await fetch(`${SERVER_URL}/session/${sessionId}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parts: [{ type: 'text', text: fullMessage }]
    })
  });

  // 3. SSE로 응답 스트리밍 수신
  const eventSource = new EventSource(`${SERVER_URL}/event?session=${sessionId}`);
  // 응답 처리...
}
```

### 3. Native Messaging Host 프로토콜

#### 메시지 형식

**Chrome → Native Host (JSON)**
```json
{
  "action": "start" | "stop" | "restart" | "status" | "server-info" | "check-port"
          | "get-version" | "get-installed-proxy" | "get-home-dir"
          | "browse-for-folder" | "browse-for-file" | "read-log",
  "preferredPort": 4096,
  "preferredRuntime": "auto" | "windows" | "wsl",   // start / restart
  "proxy": { "http": "", "https": "", "noProxy": "" } // start / restart
}
```

| 액션 | 설명 |
|------|------|
| `start` / `restart` | 서버 시작 / 하드 재시작. `preferredRuntime`·`proxy`를 함께 전달 |
| `stop` | 포트를 점유한 프로세스를 찾아 종료 (host 프로세스는 메시지마다 새로 뜨므로 핸들을 쓰지 않음) |
| `server-info` | 포트 리스너 정보와 확장이 띄운 서버인지(`managed`) 여부 |
| `get-version` | 인스톨러가 기록한 `version.txt` (확장 버전과 비교해 구버전 host 안내) |
| `get-installed-proxy` | 인스톨러가 남긴 `proxy.json` (아래 [프록시 설정](#프록시-설정) 참고) |

**Native Host → Chrome (JSON)**
```json
{
  "status": "success" | "error",
  "port": 4096,
  "version": "1.14.0"
}
```

### 4. UI/UX 설계

#### 사이드패널 레이아웃

```
┌─────────────────────────────────────────────┐
│  🔧 설정  │  OpenCode Chat  │  모델 선택 ▼   │
├─────────────────────────────────────────────┤
│                                             │
│  ┌─────────────────────────────────────┐   │
│  │ 🤖 OpenCode                         │   │
│  │ 안녕하세요! 무엇을 도와드릴까요?    │   │
│  └─────────────────────────────────────┘   │
│                                             │
│  ┌─────────────────────────────────────┐   │
│  │ 👤 사용자                           │   │
│  │ 이 코드 설명해줘                    │   │
│  └─────────────────────────────────────┘   │
│                                             │
├─────────────────────────────────────────────┤
│  ┌─────────────────────────────────────┐   │
│  │ 메시지 입력...                    │📤 │
│  └─────────────────────────────────────┘   │
│                                             │
└─────────────────────────────────────────────┘
```

#### 디자인 원칙

- **미니멀**: 복잡한 기능 없이 핵심 채팅 기능만
- **반응형**: 사이드패널 크기에 맞춰自适应
- **테마**: 다크/라이트 모드 지원 (Chrome 테마 따름)

---

## 구현 내용

### manifest.json (Chrome Extension)

```json
{
  "manifest_version": 3,
  "name": "OpenCode Chat",
  "version": "1.0.0",
  "description": "OpenCode를 사이드패널에서 사용하는 Chrome 확장 프로그램",
  "permissions": [
    "sidePanel",
    "activeTab",
    "nativeMessaging"
  ],
  "host_permissions": [
    "http://127.0.0.1:*/*"
  ],
  "action": {
    "default_title": "OpenCode 열기"
  },
  "background": {
    "service_worker": "background.js"
  },
  "side_panel": {
    "default_path": "sidepanel/sidepanel.html"
  }
}
```

### background.js (Service Worker)

주요 기능:
1. OpenCode 서버 상태 관리 (Health Check)
2. Native Messaging Host 통신
3. 세션 관리 (세션 생성/삭제)
4. 메시지 전송 및 SSE 응답 처리
5. 모델 변경 API 호출

### native-host/host.js (Node.js)

주요 기능:
1. OpenCode 서버 시작 (`opencode serve`)
2. 서버 상태 모니터링
3. 포트 자동 할당
4. stdin/stdout을 통한 JSON 프로토콜 통신

### sidepanel/sidepanel.js

주요 기능:
1. 메시지 입력 및 전송
2. 응답 표시 (마크다운 렌더링)
3. 모델 선택 UI
4. 설정 패널 (언어, 실행 환경, 프록시, 서버 재시작, 버전·업데이트)

---

## 개발

### 로컬 개발 설정

```bash
# 1. 저장소 클론
git clone https://github.com/hasungkim/opencode-chrome-ext.git
cd opencode-chrome-ext

# 2. 의존성 설치
yarn install

# 3. Chrome에 확장 프로그램 로드
# - chrome://extensions 이동
# - 개발자 모드 활성화
# - "압축 해제된 확장 프로그램 로드" 클릭
# - 현재 디렉토리 선택
```

### Web Store 공개키 주입 (Extension ID 동기화)

GitHub 배포판과 Web Store 버전이 **동일한 Extension ID**를 사용하게 하려면,
Web Store 개발자 대시보드의 공개키를 `manifest.json`에 주입합니다.

```bash
# Web Store 개발자 대시보드 → 확장 프로그램 항목 → "공개키(Public key)" 복사 후:
node scripts/set-webstore-key.js "MIIB..."
# → Extension ID 출력 및 manifest.json key 필드 자동 업데이트
# → 이후 yarn build:all로 재빌드
```

> 이 단계를 거치면 GitHub zip 설치 사용자도 Web Store 버전과 동일한 Extension ID를
> 가지므로 native host manifest의 `allowed_origins`가 자동으로 일치합니다.

### NSIS 인스톨러 빌드 (Linux/WSL)

```bash
# NSIS 설치 (WSL)
sudo apt-get install nsis

# 인스톨러만 빌드 (프로젝트 루트에 .exe 생성)
yarn build:installer

# 인스톨러 + Extension zip 전체 빌드
yarn build:all
```

---

## 빌드 및 배포

### 빌드 명령

```bash
# Extension만 빌드 (dist/ 폴더 + .zip 생성)
yarn build

# NSIS 인스톨러만 빌드 (프로젝트 루트에 .exe 생성)
yarn build:installer

# 전체 빌드: 인스톨러 생성 후 Extension 빌드 (권장)
yarn build:all

# 또는 release-it 사용 (GitHub Release 포함)
yarn release-it
```

`yarn build:all` 실행 결과:
- `opencode-native-host-setup-v{version}.exe` - Windows 인스톨러 (루트에 임시 생성 후 dist로 이동)
- `dist/` - Chrome에 로드 가능한 확장 프로그램 파일
- `dist/opencode-chrome-ext-v{version}.zip` - GitHub 배포용 ZIP (.exe 포함, native-host 폴더 포함)
- `dist/opencode-chrome-ext-v{version}-webstore.zip` - Web Store 제출용 ZIP (.exe 제외, key 필드 제거)

### release-it 설정

`release.config.js`에 설정된 배포 흐름:

1. **Version Bump**: semver에 따른 버전 증가
2. **Changelog 생성**: Git 커밋 로그 기반
3. **Git Tag**: 버전 태그 생성
4. **GitHub Release**: 릴리스 노트와 함께 릴리스 생성

#### 사전 설정: GitHub Token

`.env_example`을 복사해서 `.env` 파일을 만들고 토큰을 입력합니다:

```bash
cp .env_example .env
# .env 파일을 열어 GITHUB_TOKEN 값 입력
```

GitHub Personal Access Token 발급: GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → `repo` 권한 체크

#### 릴리스 명령

```bash
# 버그 수정 (0.0.1 → 0.0.2)
yarn release patch

# 기능 추가 (0.0.1 → 0.1.0)
yarn release minor

# 호환성 변경 (0.0.1 → 1.0.0)
yarn release major
```

실행 결과: git commit + tag 생성, push, GitHub Release 자동 생성

### Chrome Web Store 배포

```bash
# 1. 빌드 실행 (dist 폴더와 .zip 자동 생성)
yarn build

# 2. Chrome Web Store 개발자 대시보드 접속
# https://chrome.google.com/webstore/developer/

# 3. 새 항목 업로드
# - dist/opencode-chrome-ext-v{version}.zip 업로드
# - Store listings 정보 입력
# - 스크린샷/설명 추가
# - 제출
```

---

## 설치 가이드

Extension 설치 경로는 세 가지입니다. 상황에 맞는 방법을 선택하세요.

---

### 방법 1: Chrome Web Store (일반 사용자 권장)

> Web Store 심사 통과 후 사용 가능한 방법입니다.

**Step 1: Extension 설치**

Chrome Web Store에서 "OpenCode Chrome Extension"을 검색하거나 링크를 통해 설치합니다.

**Step 2: Native Messaging Host 설치**

1. GitHub Releases에서 `opencode-native-host-setup-v{version}.exe` 다운로드
2. `.exe` 파일을 더블클릭해 설치 마법사 실행
   - Windows SmartScreen 경고가 뜨면 **"추가 정보" → "실행"** 클릭
3. 설치 완료 후 Chrome 재시작

**Step 3: 작동 확인**

Chrome 오른쪽 상단 확장 프로그램 아이콘 → OpenCode 클릭 → 사이드패널에서 채팅 테스트

---

### 방법 2: GitHub 배포판 (NSIS 인스톨러)

> Web Store 심사 전, 또는 직접 배포 버전을 사용하는 경우입니다.

**Step 1: 파일 다운로드**

GitHub Releases에서 아래 두 파일을 다운로드합니다:
- `opencode-chrome-ext-v{version}.zip` — Extension 파일
- `opencode-native-host-setup-v{version}.exe` — Native Host 인스톨러

**Step 2: Extension 로드**

1. `opencode-chrome-ext-v{version}.zip` 압축 해제
2. Chrome에서 `chrome://extensions` 열기
3. 우측 상단 **개발자 모드** 활성화
4. **"압축 해제된 확장 프로그램 로드"** 클릭
5. 압축 해제한 폴더 선택
6. Extension ID 확인 (32자 영소문자, 예: `jchffojdjnhpmdgnifkhpgmgokbidobi`)

**Step 3: Native Messaging Host 설치**

1. `opencode-native-host-setup-v{version}.exe` 더블클릭
   - SmartScreen 경고 시 **"추가 정보" → "실행"** 클릭
2. 설치 마법사 완료 — Extension ID가 자동으로 구성됩니다

> Extension ID가 빌드 시 주입된 ID와 다를 경우 (예: 새 PC에서 로드 시 ID가 다름):
> 설치 폴더(`%LOCALAPPDATA%\OpenCodeChrome\native-host\`)의 `configure-extension-id.bat <extension-id>` 실행

**Step 4: 작동 확인**

Chrome 재시작 후 사이드패널에서 채팅 테스트

---

### 방법 3: 로컬 개발자 설치

> 소스 코드를 수정하거나 직접 빌드하는 개발자용입니다.

**전제 조건**

- Node.js 18+, yarn, Git (WSL/Linux)
- NSIS (`sudo apt-get install nsis`)
- Windows 10/11 + Chrome (실제 사용 환경)
- WSL2 mirrored networking (WSL에서 opencode 사용 시)

**Step 1: 소스 준비 및 의존성 설치**

```bash
git clone https://github.com/hasungkim/opencode-chrome-ext.git
cd opencode-chrome-ext
yarn install
```

**Step 2: Web Store 공개키 주입 (선택사항)**

GitHub 배포판이 Web Store 버전과 동일한 Extension ID를 갖게 하려면:

```bash
# Web Store 개발자 대시보드 → 확장 프로그램 → 공개키 복사 후:
node scripts/set-webstore-key.js "MIIB..."
# → Extension ID 출력 + manifest.json key 자동 업데이트
```

**Step 3: 전체 빌드**

```bash
yarn build:all
# → opencode-native-host-setup-v{version}.exe (인스톨러)
# → dist/opencode-chrome-ext-v{version}.zip (GitHub 배포용)
# → dist/opencode-chrome-ext-v{version}-webstore.zip (Web Store 제출용)
```

**Step 4: Chrome에 Extension 로드**

```
chrome://extensions → 개발자 모드 ON
→ "압축 해제된 확장 프로그램 로드" → 프로젝트 루트 디렉토리 선택
```

**Step 5: Native Messaging Host 설치**

```powershell
# Windows PowerShell에서 (프로젝트의 native-host 폴더 기준)
powershell -ExecutionPolicy Bypass -File native-host\install.ps1
```

또는 빌드한 `.exe` 인스톨러를 Windows에서 실행합니다.

---

## WSL 지원

이 확장 프로그램은 **Windows에 opencode가 없고 WSL에만 설치된 환경**에서도 동작합니다.

### 동작 원리

```
Chrome Extension (Windows)
        │
        ▼
Native Host (host.js)
        │
        ├── 1. which opencode (Windows PATH)        ← 있으면 Windows opencode 사용
        │
        └── 2. WSL opencode 탐색 (2가지 전략 순차 시도)
                │
                ├── 전략1: wsl.exe bash -c '. ~/.nvm/nvm.sh; which opencode'
                │          (NVM 명시 로드 — bash startup 경고 없음, 안정적)
                │
                └── 전략2: wsl.exe bash -ilc 'which opencode'
                           (interactive+login — 전략1 실패 시 fallback)
                │
                └── wsl.exe <path> serve --port 4096
                        │
                        ▼
              WSL 내부에서 opencode 실행
                        │
              [WSL2 mirrored networking]
                        │
                        ▼
              127.0.0.1:4096 (Windows에서 접근 가능)
                        │
                        ▼
              Chrome Extension 포트 스캔 탐지 성공
```

> **NVM 환경 참고**: opencode가 NVM으로 설치된 경우(`~/.nvm/versions/node/.../bin/opencode`),
> `.bashrc`의 interactive 가드(`case $- in *i*) ;; *) return;; esac`) 때문에
> 단순 `bash -lc`로는 NVM PATH가 로드되지 않습니다.
> 전략1(명시적 NVM 소싱)이 이를 해결하며, `.nvm/nvm.sh`가 없어도 `2>/dev/null`로 무음 처리됩니다.

### 전제 조건

| 조건 | 필요 여부 | 비고 |
|------|----------|------|
| Windows 11 | **권장** | Windows 10도 가능하나 mirrored 모드 미지원 |
| WSL2 (버전 0.67.6+) | **필수** | mirrored 모드 지원 최소 버전 |
| WSL2 mirrored networking | **필수** | install.ps1로 자동 설정 가능 |
| WSL에 opencode 설치 | **필수** | `wsl opencode --version`으로 확인 |
| `wsl.exe` (Windows PATH) | **자동** | Windows 11/10 기본 포함 |

### 설치 방법

1. **Native Messaging Host 설치** (Windows 설치 가이드 Step 2 참조)
2. **install.ps1 실행 시 WSL 설정 안내**:
   - WSL2 mirrored networking이 설정되어 있는지 확인
   - 설정되어 있지 않으면 자동 설정 제안 (WSL 재시작 필요)
   - 수동 설정 가이드 제공

### WSL2 Mirrored Networking 설정

#### 자동 설정 (install.ps1)

```powershell
# install.ps1 실행 시 자동 안내
powershell -ExecutionPolicy Bypass -File .\install.ps1

# WSL2 mirrored networking이 없으면:
# - 설정 여부 확인 메시지 표시
# - Y 입력 시 자동 설정 + WSL 재시작
# - N 입력 시 수동 설정 가이드 표시
```

#### 수동 설정

```powershell
# 1. %USERPROFILE%\.wslconfig 파일을 열거나 새로 생성
#    예: C:\Users\<username>\.wslconfig

# 2. 아래 내용 추가:
[wsl2]
networkingMode=mirrored

# 3. 모든 WSL 창을 닫고 PowerShell에서 실행:
wsl.exe --shutdown

# 4. WSL을 다시 열면 설정이 적용됩니다.
```

### 트러블슈팅

#### `opencode를 찾을 수 없음 (Windows/WSL 모두 확인)` 에러

Native Messaging 응답으로 이 에러가 오면 아래 순서로 확인합니다.

**1단계: WSL에서 opencode 설치 확인**

```bash
# WSL 터미널에서 직접 실행
which opencode
opencode --version
```

- 경로가 나오면 설치는 정상 → 2단계로
- `command not found`이면 → opencode를 WSL에 설치

```bash
# NVM으로 설치 (권장)
npm install -g opencode@latest

# 설치 후 PATH 확인
which opencode  # 예: /home/user/.nvm/versions/node/v24.x.x/bin/opencode
```

**2단계: PATH 로딩 확인**

`.bashrc`의 interactive 가드(`case $- in *i*) ;; *) return;; esac`)로 인해
Windows Native Host에서 WSL PATH를 읽지 못할 수 있습니다. host.js는 아래 3가지
전략을 순서대로 시도합니다.

```bash
# 전략 1: 공식 설치 스크립트 기본 경로 (가장 빠름, .bashrc 무관)
env -i HOME=$HOME bash -c 'test -x "$HOME/.opencode/bin/opencode" && echo "$HOME/.opencode/bin/opencode"'

# 전략 2: NVM 환경
env -i HOME=$HOME PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  bash -c '. "$HOME/.nvm/nvm.sh" 2>/dev/null; which opencode'

# 전략 3: interactive login shell (.bashrc 전체 실행)
bash -ilc 'which opencode'
```

경로가 나오면 정상입니다.

> **참고**: 전략 3은 `.bashrc`를 전부 실행하므로, `.bashrc`에 `sudo` 호출이나
> 무거운 초기화(conda/nvm 등)가 있으면 TTY 없는 `wsl.exe` 환경에서 15초
> 타임아웃에 걸려 실패할 수 있습니다. 이 경우 `.bashrc`를 정리하거나,
> opencode를 공식 설치 스크립트 기본 경로(`~/.opencode/bin`)에 두면
> 전략 1에서 바로 탐지됩니다.

**3단계: Native Messaging Host 재설치 확인**

host.js가 최신 버전인지 확인하고, 필요 시 install.ps1을 재실행합니다.

```powershell
# Windows PowerShell에서
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

#### WSL에서 opencode를 찾지 못함 (설치 미완료)

```bash
# WSL에서 opencode 설치 확인
wsl opencode --version

# 설치되어 있지 않으면 설치:
wsl npm install -g opencode@latest
```

#### WSL2 Mirrored Networking이 작동하지 않음

```bash
# WSL 버전 확인
wsl --version

# Windows 11의 경우 버전 0.67.6 이상 필요
# 버전이 낮으면 업데이트:
wsl --update
```

#### 포트 연결 실패

```bash
# WSL2 mirrored networking이 활성화되었는지 확인:
# %USERPROFILE%\.wslconfig 파일에 networkingMode=mirrored가 있는지 확인

# WSL 재시작:
wsl.exe --shutdown

# WSL에서 포트가 열려 있는지 확인:
wsl netstat -tulpn | grep 4096
```

---

## 사용 방법

### 사이드패널 열기

사이드패널을 여는 방법은 두 가지입니다.

- **확장 프로그램 아이콘 클릭**: 현재 탭에 사이드패널이 열리고, 탭마다 독립적인 세션이 새로 생성됩니다.
- **선택한 텍스트를 OpenCode로 보내기**: 페이지에서 텍스트를 드래그해 선택한 뒤 마우스 우클릭 → 컨텍스트 메뉴에서 **"OpenCode로 보내기"** 클릭. 사이드패널이 열리면서 선택한 텍스트가 입력창에 채워집니다.

> 사이드패널은 탭별로 독립 동작합니다. 패널을 연 적 있는 탭으로 전환하면 그 탭의 대화가 그대로 표시되고, 패널을 연 적 없는 탭에서는 자동으로 열리지 않습니다.

### 기본 대화

1. 사이드패널 입력창에 메시지 입력 후 Enter 또는 전송 버튼 클릭
2. 현재 탭의 URL/제목(및 컨텍스트 메뉴로 보낸 선택 텍스트)이 자동으로 메시지에 포함되어 전달됨
3. OpenCode의 응답이 실시간 스트리밍으로 표시됨

### 페이지 이동 시 사이드패널 동작

사이드패널을 열어둔 채로 같은 탭에서 다른 페이지로 이동하거나(주소 변경) SPA 방식으로 화면 내용이 바뀌면, 사이드패널이 이를 자동으로 감지해 대화 중간에 다음과 같은 안내 메시지를 표시합니다.

> 🌐 페이지가 변경된 것을 확인했어요.
> **(새 페이지 제목)**
> (새 페이지 URL)
> 이 세션은 이전 페이지에서 이어지는 대화입니다.

- **세션은 새로 생성되지 않고 기존 대화가 그대로 이어집니다.** 이후 보내는 메시지부터는 바뀐 페이지의 URL/제목이 컨텍스트로 전달됩니다.
- 이 안내는 현재 활성 탭에서만 표시되며, 다른 탭(비활성 탭)에서 페이지가 바뀐 경우에는 그 탭으로 다시 전환했을 때 표시됩니다.

### 슬래시(`/`) 커맨드

입력창에 `/`를 입력하면 사용 가능한 커맨드 목록이 자동완성으로 표시됩니다.

| 커맨드 | 설명 |
|--------|------|
| `/help` | 사용 가능한 커맨드 목록 표시 |
| `/clear` | 채팅 히스토리 초기화 (새 세션 시작) |
| `/model <model-name>` | 사용할 모델 변경 |
| `/wd <path>` | 작업 디렉토리(working directory) 변경 |
| `/ext-log` | 디버그 로그 수집 다이얼로그 표시 — [문제 해결 시 디버그 로그 확인](#문제-해결-시-디버그-로그-확인) 참고 |

### 모델 변경

1. 사이드패널 상단 모델 선택 드롭다운 클릭
2. 사용 가능한 모델 목록에서 선택
3. 선택 즉시 새 모델로 전환

(드롭다운 대신 `/model <model-name>` 커맨드로도 변경할 수 있습니다.)

### MCP/Skill 사용

메시지에 MCP 서버 또는 Skill 이름 포함:

```
@filesystem read /path/to/file

@visualize.create-slides "presentation about: topic"

/help
```

### 설정(⚙) 메뉴

사이드패널 상단 ⚙ 버튼에서 다음을 설정합니다. 새 확장 버전이 준비되면 ⚙에 점(•)이 표시됩니다.

| 항목 | 설명 |
|------|------|
| 언어 / Language | 사이드패널 UI 언어 (한국어 기본, English 선택). 브라우저 언어와 별개로 저장됨 |
| 실행 환경 | OpenCode를 띄울 환경 우선순위: 자동(WSL 우선) / WSL / Windows. 하드 재시작이 성공한 뒤에만 저장되며, 현재와 다른 환경을 고르면 확인 후 재시작 |
| 프록시 | HTTP / HTTPS / 제외 목록(NO_PROXY). [프록시 설정](#프록시-설정) 참고 |
| ⚡ 서버 강제 재시작 | 포트 점유 프로세스를 종료하고 다시 시작 (10~30초, 포트가 바뀔 수 있음) |
| 정보 | 확장 버전·Native Host 버전 표시, 확장 업데이트 확인/적용, 구버전 host 업데이트 안내 |

#### 프록시 설정

- 입력값은 `chrome.storage.local`에 **평문**으로 저장되며(`http(s)://`, `socks5(h)://` 형식만 허용), 서버를 시작/재시작할 때 `HTTP_PROXY` 등 환경변수로 주입됩니다. 서버 프로세스의 환경변수라서 **저장만으로는 반영되지 않고 서버 재시작이 필요**합니다. 확장이 띄운 서버가 아니면 "저장만" / "그래도 재시작" 중에서 고릅니다.
- 빈 항목은 건드리지 않아 기존 시스템 환경변수가 유지됩니다.
- **사내 사용자**: `config.private.json`(`config.private.json.sample` 참고)을 인스톨러 `.exe`와 같은 폴더에 두고 실행하면 `proxy`가 사용자 환경변수에 등록되고, `proxy` 섹션은 `%LOCALAPPDATA%\OpenCodeChrome\proxy.json`으로 남습니다(`config.private.json` 자체는 설치 후 삭제됨). 확장은 저장된 프록시 설정이 한 번도 없을 때에 한해 이 값을 설정 화면으로 가져옵니다. 이미 저장된 값은 덮어쓰지 않습니다.
- ⚙를 열 때마다 저장된 값을 새로 읽으며, 읽는 동안에는 입력칸 대신 "확인 중…"이 표시되어 입력할 수 없습니다. 저장하지 않은 입력은 화면이 다시 그려져도 유지됩니다.

### 세션 관리

- 새 탭에서 확장 프로그램 아이콘을 클릭하면 자동으로 새 세션이 생성됩니다.
- 세션은 탭과 1:1로 매핑되며, OpenCode 서버에서 독립적으로 관리됩니다.
- `/clear` 커맨드로 현재 세션의 대화 내용을 지우고 새 세션을 시작할 수 있습니다.

---

## 문제 해결 시 디버그 로그 확인

서버 연결 실패, 응답이 표시되지 않거나 갑자기 멈추는 등의 문제가 발생하면, 다른 조치를 하기 전에 디버그 로그부터 확인하는 것을 권장합니다.

1. 사이드패널 입력창에 `/ext-log`를 입력하고 전송합니다.
2. "디버그 로그 수집 중..." 메시지가 잠시 표시된 뒤, 다음 두 가지 로그를 함께 보여주는 다이얼로그가 열립니다.
   - **Service Worker Logs**: `background.js`(Service Worker)가 기록한 서버 탐지, 세션 생성/삭제, 메시지 송수신, SSE 이벤트 등의 로그
   - **Native Host File Log**: Native Messaging Host가 파일에 기록한 로그 (`%LOCALAPPDATA%\OpenCodeChrome\logs\native-host.log`, 예: `C:\Users\<username>\AppData\Local\OpenCodeChrome\logs\native-host.log`)
3. 서버 연결에 실패해 입력창이 비활성화된 경우에는 연결 실패 화면의 **로그 보기** 버튼으로 같은 로그를 열 수 있습니다.
4. 다이얼로그의 **복사** 버튼을 누르면 로그 전체가 클립보드에 복사되어, GitHub 이슈 등록 시 그대로 첨부할 수 있습니다.

> Native Host File Log 영역에 "파일 로그 없음"이 표시된다면 Native Messaging Host와의 연결 자체가 실패한 것입니다. 이 경우 Service Worker Logs에서 `NativeMsg:`로 시작하는 에러 메시지(Chrome 레벨 연결 에러 또는 host.js가 반환한 에러/진단 정보)를 먼저 확인하세요.

---

## Troubleshooting

### "Specified native messaging host not found" 오류

- 레지스트리에 Native Messaging Host가 등록되지 않음
- install.reg 파일을 실행하거나 레지스트리 수동 등록

### 서버 연결 실패

```bash
# OpenCode 서버 수동 시작 테스트
opencode serve --port 4096
```

### 포트 충돌

- 이미 다른 OpenCode 인스턴스가 실행 중
- 기본적으로 다음 사용 가능한 포트 자동 탐색

---

## 라이선스

MIT License

---

## 기여

Contributions are welcome! Please read the contributing guidelines first.