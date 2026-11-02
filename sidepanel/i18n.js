// 사이드패널 다국어(ko 기본, en 선택).
// 한국어 원문 자체를 키로 쓴다: t('연결됨')은 ko에서는 원문을, en에서는 EN['연결됨']을 돌려주고,
// 사전에 없으면 원문으로 fallback한다. 보간은 {name} 자리표시자 + params로 한다.
// 정적 HTML은 data-i18n(텍스트) / data-i18n-html / data-i18n-title / data-i18n-placeholder 속성으로
// 표시하고, 요소의 원래(한국어) 내용이 키가 된다.
(function (global) {
  const EN = {
    // ---- 정적 HTML ----
    'OpenCode 서버 실행 환경': 'Environment running the OpenCode server',
    'MCP 서버 관리': 'Manage MCP servers',
    '설정': 'Settings',
    '웹 페이지 AI 어시스턴트': 'AI assistant for web pages',
    '페이지 요약, 설명, 검색 등을<br>요청해보세요.': 'Ask for page summaries,<br>explanations, searches and more.',
    '메시지를 입력하거나 <kbd>/</kbd> 로 커맨드를 실행하세요.': 'Type a message or press <kbd>/</kbd> to run a command.',
    '첨부파일': 'Attach files',
    '메시지를 입력하세요...': 'Type a message...',
    'Shift+Tab으로 에이전트 변경': 'Change agent with Shift+Tab',
    '응답 대기 중...': 'Waiting for response...',
    '재연결': 'Reconnect',
    '디버그 로그': 'Debug log',
    '복사': 'Copy',
    '아래 버튼으로 인스톨러를 다운로드합니다': 'Download the installer with the button below',
    '<code>.exe</code> 파일을 실행합니다': 'Run the <code>.exe</code> file',
    'SmartScreen 경고 → <strong>추가 정보</strong> → <strong>실행</strong> 클릭': 'If SmartScreen warns you: <strong>More info</strong> → <strong>Run anyway</strong>',
    '설치 완료 후 아래 <strong>다시 연결</strong> 버튼을 누릅니다': 'After installing, press <strong>Reconnect</strong> below',
    '🏢 <strong>사내 사용자:</strong> <code>config.private.json</code> 파일을 <code>.exe</code>와 같은 폴더에 두고 실행하세요. (proxy/MCP 자동 설정)': '🏢 <strong>Corporate users:</strong> put <code>config.private.json</code> in the same folder as the <code>.exe</code> and run it. (configures proxy/MCP automatically)',
    '⬇ 인스톨러 다운로드': '⬇ Download installer',
    '↺ 다시 연결': '↺ Reconnect',
    '나중에': 'Later',

    // ---- 연결 상태 ----
    '연결됨': 'Connected',
    '연결 중...': 'Connecting...',
    '연결 안됨': 'Disconnected',
    '오류': 'Error',
    '서버 연결에 실패했습니다': 'Failed to connect to the server',
    '연결 오류가 발생했습니다': 'A connection error occurred',
    'Native Host 업데이트 필요': 'Native Host update required',
    'Native Host 설치 필요': 'Native Host installation required',
    '확장 프로그램이 업데이트되어<br>Native Host도 최신 버전이 필요합니다.': 'The extension was updated,<br>so the Native Host needs the latest version too.',
    'Chrome 확장과 OpenCode를 연결하는<br>Native Host 프로그램이 필요합니다.': 'The Native Host program that connects<br>the Chrome extension and OpenCode is required.',
    '설치된 버전: {installed} → 필요한 버전: v{required} (기존 설치 위에 그대로 설치하면 됩니다)': 'Installed: {installed} → required: v{required} (just install over the existing one)',
    '구버전': 'old version',
    '설치할 버전: v{version}': 'Version to install: v{version}',

    // ---- 작업 폴더 / 에이전트 / 모델 ----
    '폴더 없음': 'No folder',
    '기본값: {dir}': 'Default: {dir}',
    '에이전트': 'Agent',
    '모델 선택': 'Select model',
    '모델을 선택하세요:': 'Select a model:',
    '작업 디렉토리가 변경되어 새 세션을 시작합니다.': 'The working directory changed, so a new session is starting.',
    '모델 목록을 불러오지 못했습니다. 서버 연결 상태를 확인하세요.': 'Could not load the model list. Check the server connection.',

    // ---- 커맨드 ----
    '사용 가능한 커맨드 목록 표시': 'Show available commands',
    '채팅 히스토리 초기화': 'Clear chat history',
    '모델 변경 <model-name>': 'Change model <model-name>',
    '작업 디렉토리 변경 <path>': 'Change working directory <path>',
    '사용 가능한 커맨드:\n\n': 'Available commands:\n\n',
    '세션 재생성에 실패했습니다.': 'Failed to recreate the session.',
    '채팅이 초기화되었습니다.': 'Chat has been cleared.',
    '모델이 변경되었습니다: {name}': 'Model changed: {name}',
    '모델 변경 실패: {error}': 'Failed to change model: {error}',
    '모델을 찾을 수 없습니다: {name}': 'Model not found: {name}',
    '사용법: /wd <path>': 'Usage: /wd <path>',
    '작업 디렉토리가 변경되었습니다: {dir}': 'Working directory changed: {dir}',
    '디렉토리 변경 실패: {error}': 'Failed to change directory: {error}',
    '커맨드 실행 실패: {error}': 'Command failed: {error}',
    '메시지 전송에 실패했습니다.': 'Failed to send the message.',
    '[첨부 파일 — 필요 시 read 도구로 읽어 분석하세요]': '[Attached files — read them with the read tool if needed]',

    // ---- MCP ----
    'MCP 서버 없음': 'No MCP servers',
    '비활성': 'Disabled',
    '↻ 설정 다시 읽기': '↻ Reload config',
    'opencode가 config/MCP/skill/agent를 디스크에서 다시 읽습니다 (서버 프로세스 유지)': 'opencode re-reads config/MCP/skill/agent from disk (the server process keeps running)',

    // ---- 재시작 ----
    '{runtime}(으)로 서버를 재시작하는 중… (최대 30초)': 'Restarting the server on {runtime}… (up to 30s)',
    '서버를 재시작하는 중… (최대 30초)': 'Restarting the server… (up to 30s)',
    '설정을 다시 읽는 중…': 'Reloading config…',
    '실패: {error}': 'Failed: {error}',
    '알 수 없는 오류': 'Unknown error',
    ' (포트 {port})': ' (port {port})',
    '서버 재시작 완료{suffix}': 'Server restarted{suffix}',
    '설정을 다시 읽었습니다': 'Config reloaded',

    // ---- 확인 다이얼로그 ----
    '확인': 'OK',
    '취소': 'Cancel',

    // ---- 설정 메뉴 ----
    '언어 / Language': 'Language / 언어',
    '자동': 'Auto',
    '자동 (WSL 우선)': 'Auto (WSL first)',
    '서버 연결 안 됨': 'Server not connected',
    '현재 실행 중: {runtime} · :{port}': 'Running on: {runtime} · :{port}',
    '알 수 없음': 'unknown',
    '실행 환경': 'Environment',
    '프록시': 'Proxy',
    '(설정됨)': '(set)',
    '(미설정)': '(not set)',
    '제외 목록 (NO_PROXY)': 'Exclude list (NO_PROXY)',
    '계정이 필요하면 http://user:pass@host:port (비밀번호의 @ : / # % 는 %40 등으로 인코딩). 비워 두면 시스템 환경변수를 사용합니다.': 'If authentication is required use http://user:pass@host:port (encode @ : / # % in the password as %40 etc.). Leave empty to use system environment variables.',
    '계정: http://user:pass@host:port · 비우면 시스템 환경변수 사용': 'Auth: http://user:pass@host:port · empty = system env vars',
    '⚠ 입력값은 브라우저에 평문으로 저장됩니다.': '⚠ Values are stored in plain text in the browser.',
    '초기화': 'Reset',
    '저장': 'Save',
    'opencode 서버 프로세스를 종료하고 다시 시작합니다': 'Stops and restarts the opencode server process',
    '⚡ 서버 강제 재시작': '⚡ Force restart server',
    '정보': 'About',
    '확장 v{version}': 'Extension v{version}',
    '확인 중…': 'Checking…',
    '업데이트 확인': 'Check for updates',
    '업데이트': 'Update',
    '설치': 'Install',
    '미설치': 'Not installed',
    '⬆ 새 버전 v{version} 준비됨': '⬆ New version v{version} ready',
    '지금 적용': 'Apply now',
    '설정 · 새 버전 v{version} 준비됨': 'Settings · new version v{version} ready',
    '확인 실패: {error}': 'Check failed: {error}',
    '새 버전 v{version}을 받았습니다.': 'Downloaded new version v{version}.',
    '잠시 후 다시 시도해 주세요.': 'Please try again in a moment.',
    '최신 버전입니다.': 'You are up to date.',
    '업데이트 적용': 'Apply update',
    '확장이 v{version}으로 다시 로드됩니다.\n진행 중인 응답은 중단됩니다.': 'The extension will reload as v{version}.\nAny response in progress will be interrupted.',
    '저장했습니다 (다음 시작부터 적용)': 'Saved (applies from the next start)',
    '{from} → {to}(으)로 변경합니다.': 'Switching from {from} to {to}.',
    '{to} 환경으로 변경합니다.': 'Switching to {to}.',
    '실행 환경 변경': 'Change environment',
    '{change}\nOpenCode가 재시작됩니다.\n진행 중인 응답은 중단됩니다.': '{change}\nOpenCode will restart.\nAny response in progress will be interrupted.',
    '서버 강제 재시작': 'Force restart server',
    'OpenCode가 재시작됩니다.\n진행 중인 응답은 중단되며 10~30초 걸릴 수 있습니다.': 'OpenCode will restart.\nAny response in progress will be interrupted, and it can take 10–30 seconds.',
    '저장했습니다 (서버를 다시 시작하면 적용)': 'Saved (applies when the server restarts)',
    '저장했습니다 (서버 시작 시 적용)': 'Saved (applies when the server starts)',
    '\n\n⚠ 이 서버에서 응답 중인 다른 세션이 {count}개 있습니다 (TUI 등 다른 클라이언트). 재시작하면 중단됩니다.': '\n\n⚠ {count} other session(s) on this server are responding (TUI or other clients). Restarting will interrupt them.',
    '프록시 적용': 'Apply proxy',
    '프록시를 적용하려면 OpenCode 서버를 재시작해야 합니다.\n10~30초 걸리며 진행 중인 응답은 중단됩니다.{busyWarn}': 'The OpenCode server must restart to apply the proxy.\nIt takes 10–30 seconds and interrupts any response in progress.{busyWarn}',
    '지금 재시작': 'Restart now',
    '현재 연결된 서버는 이 확장이 시작한 것이 아니라서(터미널·VS Code 등에서 실행했거나 이전 버전이 시작) 프록시가 적용되지 않을 수 있습니다.': 'The connected server was not started by this extension (started from a terminal, VS Code, or an older version), so the proxy may not apply.',
    '현재 서버를 이 확장이 시작했는지 확인할 수 없습니다.': 'Cannot tell whether this extension started the current server.',
    '설정은 저장되었고, 이 확장이 서버를 새로 시작할 때 적용됩니다.\n{why}\n\n그래도 지금 서버를 종료하고 재시작할까요?{busyWarn}': 'Settings are saved and apply when this extension starts the server.\n{why}\n\nStop and restart the server now anyway?{busyWarn}',
    '그래도 재시작': 'Restart anyway',
    '저장만': 'Save only',

    // ---- 디버그 ----
    '✓ 복사됨': '✓ Copied',
    '수동으로 복사하세요': 'Copy manually',
    '디버그 로그 수집 중...': 'Collecting debug logs...',
    '디버그 로그 수집 실패: {error}': 'Failed to collect debug logs: {error}',
    '✓ 클립보드에 자동 복사됨': '✓ Automatically copied to clipboard',
    '복사 버튼을 눌러 수동으로 복사하세요': 'Press Copy to copy manually',

    // ---- 도구/블록 ----
    '대기 중': 'Pending',
    '실행 중…': 'Running…',
    '완료': 'Done',
    '취소됨': 'Cancelled',
    '중단됨': 'Interrupted',
    '💭 생각 중': '💭 Thinking',
    '입력:\n': 'Input:\n',
    '결과:\n': 'Result:\n',
    '📋 복사': '📋 Copy',
    '복사 실패': 'Copy failed',
    '제거': 'Remove',
    '첨부할 파일의 절대 경로를 입력하세요 (여러 개는 쉼표로 구분):': 'Enter absolute paths of files to attach (comma-separated):',

    // ---- background.js가 돌려주는 오류 ----
    '서버에 연결되어 있지 않습니다': 'Not connected to a server',
    '이미 재시작이 진행 중입니다': 'A restart is already in progress',
    'dispose 후 서버가 응답하지 않습니다': 'The server is not responding after dispose',
    '재시작 실패': 'Restart failed',
    '재시작 후 서버를 찾을 수 없습니다': 'Could not find the server after restart',
    'OpenCode 서버 연결 실패': 'Failed to connect to the OpenCode server',
    '세션 ID를 찾을 수 없음': 'Session ID not found',
    '세션을 찾을 수 없음': 'Session not found',
    '사용 가능한 모델이 없습니다. OpenCode에서 AI 제공자 API 키를 설정해 주세요.': 'No models available. Set an AI provider API key in OpenCode.',
    '응답 시간 초과': 'Response timed out',
    '오류가 발생했습니다': 'An error occurred',
    '파일 선택 실패': 'File selection failed',
    '잘못된 값입니다': 'Invalid value'
  };

  let lang = 'ko';

  function t(ko, params) {
    let s = lang === 'en' && Object.prototype.hasOwnProperty.call(EN, ko) ? EN[ko] : ko;
    if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m));
    return s;
  }

  // 정적 요소는 처음 본 시점의 한국어 원문을 data-i18n-key에 보관해 두고 거기서 번역한다.
  function applyStatic(root = document) {
    root.querySelectorAll('[data-i18n]').forEach((el) => {
      el.dataset.i18nKey = el.dataset.i18nKey || el.textContent.trim();
      el.textContent = t(el.dataset.i18nKey);
    });
    root.querySelectorAll('[data-i18n-html]').forEach((el) => {
      el.dataset.i18nKey = el.dataset.i18nKey || el.innerHTML.trim();
      el.innerHTML = t(el.dataset.i18nKey);
    });
    ['title', 'placeholder'].forEach((attr) => {
      const data = 'i18n' + attr[0].toUpperCase() + attr.slice(1);
      root.querySelectorAll(`[data-i18n-${attr}]`).forEach((el) => {
        const keyName = data + 'Key';
        el.dataset[keyName] = el.dataset[keyName] || el.getAttribute(attr);
        el.setAttribute(attr, t(el.dataset[keyName]));
      });
    });
    document.documentElement.lang = lang;
  }

  function setLang(next) {
    lang = next === 'en' ? 'en' : 'ko';
    chrome.storage.local.set({ lang });
    applyStatic();
  }

  const ready = chrome.storage.local.get('lang').then((v) => {
    lang = v.lang === 'en' ? 'en' : 'ko';
    applyStatic();
  }).catch(() => {});

  global.I18N = { t, ready, setLang, getLang: () => lang, applyStatic };
  global.t = t;
})(window);
