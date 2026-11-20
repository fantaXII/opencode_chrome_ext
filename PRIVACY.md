# Privacy Policy / 개인정보처리방침

**Last updated / 최종 수정일: 2026-11-20**

---

## English

**OpenCode Chrome Extension** is a side-panel client for [OpenCode](https://opencode.ai), an AI coding agent that runs on your own computer. The extension itself has no server, and the developer does not receive, collect, or store any of your data.

### What data the extension handles

| Data | When | Where it goes |
|------|------|---------------|
| Messages you type, files you attach (file paths) | When you send a message | The OpenCode server on your computer (`127.0.0.1`) |
| Current tab's **title and URL** | When you send a message (default setting "Title & URL") | Same as above |
| Current tab's **page content** (main text extracted from the page as shown in your browser, up to 50,000 characters) and **selected text** | Only when (a) you choose "Title, URL, content & selection" in ⚙ Settings, (b) you click a quick action button on the page bubble (e.g. "Summary") that is set to send page content, or (c) you choose "Read this time" / "Keep for this session" after the server failed to fetch the page — **and** you granted page access (for that site or all sites) | Same as above |
| Settings (model, working folder, language, runtime, proxy, quick action buttons you created), debug log | Stored on your device | `chrome.storage` in your browser, and a local log file of the native host |
| Local server password (a random value the native host generates each time it starts the OpenCode server, so that only this extension can connect to it) | Created when the server starts | Your browser's session storage (`chrome.storage.session`, cleared when the browser closes) and a file on your computer (`%LOCALAPPDATA%\OpenCodeChrome\server.json`). Sent only to the OpenCode server on your computer (`127.0.0.1`) |

### Data sent to third parties

OpenCode forwards your messages, including any page title/URL/content attached as above, to the **AI model provider you configured in OpenCode** (e.g. Anthropic, OpenAI, a company-internal gateway) to generate responses. That transfer is made by OpenCode under your own account and is governed by that provider's privacy policy. The extension does not send data to any other server.

You can turn off page information entirely by choosing "Do not send" for **Page context** in ⚙ Settings.

### What the extension does not do

- No analytics, tracking, advertising, or telemetry.
- Data is not sold, and is not used for any purpose other than the chat feature you are using.
- Page content is read only at the moment you send a message, only from the active tab, and only if you enabled it or clicked a button that sends it. The extension does not monitor your browsing in the background.

### Native messaging host

The optional Windows native host (installed separately) only starts/stops the local OpenCode server (with a random password it generates), opens folder/file pickers, and reads its own log file. It does not send any data to the internet. Its installer may download Node.js from the official site (nodejs.org) if Node.js is not already installed.

---

## 한국어

**OpenCode Chrome Extension**은 사용자 PC에서 실행되는 AI 코딩 에이전트 [OpenCode](https://opencode.ai)를 사이드패널에서 사용하기 위한 클라이언트입니다. 확장 프로그램 자체에는 서버가 없으며, 개발자는 사용자 데이터를 수신·수집·보관하지 않습니다.

### 확장 프로그램이 다루는 데이터

| 데이터 | 시점 | 전달 위치 |
|--------|------|-----------|
| 입력한 메시지, 첨부한 파일(경로) | 메시지를 보낼 때 | 사용자 PC의 OpenCode 서버(`127.0.0.1`) |
| 현재 탭의 **제목·URL** | 메시지를 보낼 때 (기본 설정 "제목·URL") | 위와 같음 |
| 현재 탭의 **페이지 내용**(브라우저에 보이는 페이지에서 추출한 본문, 최대 50,000자)과 **선택한 텍스트** | (가) ⚙ 설정에서 "제목·URL·본문·선택 텍스트"를 골랐거나, (나) 페이지 말풍선의 빠른 실행 버튼(예: "요약") 중 본문을 함께 보내도록 된 버튼을 눌렀거나, (다) 서버가 페이지를 가져오지 못했을 때 "이번만 읽기"/"이 세션에서 계속"을 고른 경우로서, **페이지 읽기 권한(그 사이트 또는 모든 사이트)을 허용한 경우에만** | 위와 같음 |
| 설정값(모델, 작업 폴더, 언어, 실행 환경, 프록시, 직접 만든 빠른 실행 버튼), 디버그 로그 | 기기에 저장 | 브라우저의 `chrome.storage`, Native Host의 로컬 로그 파일 |
| 로컬 서버 비밀번호(이 확장만 서버에 접속할 수 있도록 Native Host가 OpenCode 서버를 띄울 때마다 새로 만드는 무작위 값) | 서버를 시작할 때 생성 | 브라우저의 세션 저장소(`chrome.storage.session`, 브라우저를 닫으면 지워짐)와 PC의 파일(`%LOCALAPPDATA%\OpenCodeChrome\server.json`). 사용자 PC의 OpenCode 서버(`127.0.0.1`)로만 전송 |

### 제3자에게 전달되는 데이터

OpenCode는 응답을 생성하기 위해 메시지(위와 같이 첨부된 페이지 제목·URL·내용 포함)를 **사용자가 OpenCode에 설정한 AI 모델 제공자**(예: Anthropic, OpenAI, 사내 게이트웨이)에게 전송합니다. 이 전송은 사용자 본인의 계정으로 OpenCode가 수행하며, 해당 제공자의 개인정보처리방침이 적용됩니다. 확장 프로그램은 그 밖의 어떤 서버로도 데이터를 보내지 않습니다.

⚙ 설정의 **페이지 컨텍스트**를 "보내지 않음"으로 바꾸면 페이지 정보를 전혀 보내지 않습니다.

### 하지 않는 것

- 분석, 추적, 광고, 원격 측정(telemetry)을 사용하지 않습니다.
- 데이터를 판매하지 않으며, 사용 중인 채팅 기능 외의 목적으로 사용하지 않습니다.
- 페이지 내용은 사용자가 켰거나 본문을 보내는 버튼을 누른 경우에만, 메시지를 보내는 순간에, 활성 탭에서만 읽습니다. 백그라운드에서 브라우징을 감시하지 않습니다.

### Native Messaging Host

별도로 설치하는 Windows용 Native Host는 로컬 OpenCode 서버 시작(무작위 비밀번호 생성 포함)·종료, 폴더/파일 선택 창 열기, 자체 로그 파일 읽기만 수행하며 인터넷으로 데이터를 보내지 않습니다. 인스톨러는 Node.js가 설치되어 있지 않으면 공식 사이트(nodejs.org)에서 내려받을 수 있습니다.

---

## Contact / 문의

GitHub Issues: https://github.com/fantaXII/opencode_chrome_ext/issues
