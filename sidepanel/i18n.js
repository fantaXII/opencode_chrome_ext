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
    '<strong>사내 사용자:</strong> <code>config.private.json</code> 파일을 <code>.exe</code>와 같은 폴더에 두고 실행하세요. (proxy/MCP 자동 설정)': '<strong>Corporate users:</strong> put <code>config.private.json</code> in the same folder as the <code>.exe</code> and run it. (configures proxy/MCP automatically)',
    '⬇ 인스톨러 다운로드': '⬇ Download installer',
    '↺ 다시 연결': '↺ Reconnect',
    '나중에': 'Later',

    // ---- 연결 상태 ----
    '로그 보기': 'View log',
    '확장 디버그 로그 표시·복사 (문제 신고 시 첨부)': 'Show and copy the extension debug log (attach when reporting issues)',
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
    '최근 사용': 'Recent',
    '재시작 중...': 'Restarting...',
    '서버 재시작 실패: {error}': 'Server restart failed: {error}',
    '제공자': 'Providers',
    '디렉토리를 찾을 수 없습니다: {path}': 'Directory not found: {path}',
    '작업 디렉토리가 변경되어 새 세션을 시작합니다. 이전 대화는 /sessions로 다시 열 수 있습니다.': 'The working directory changed, so a new session was started. Reopen the previous conversation with /sessions.',
    '모델 목록을 불러오지 못했습니다. 서버 연결 상태를 확인하세요.': 'Could not load the model list. Check the server connection.',

    // ---- 커맨드 ----
    '사용 가능한 커맨드 목록 표시': 'Show available commands',
    '채팅 히스토리 초기화': 'Clear chat history',
    '모델 변경 <model-name>': 'Change model <model-name>',
    '작업 디렉토리 변경 <path>': 'Change working directory <path>',
    '사용 가능한 커맨드:\n\n': 'Available commands:\n\n',
    '세션 재생성에 실패했습니다.': 'Failed to recreate the session.',
    '채팅이 초기화되었습니다.': 'Chat has been cleared.',
    '새 세션 시작': 'Start a new session',
    '이전 세션 목록에서 선택해 대화 이어가기': 'Pick a previous session to continue',
    '/sessions와 동일': 'Same as /sessions',
    '응답 중에는 새 세션을 시작할 수 없습니다.': 'Cannot start a new session while a response is in progress.',
    '새 세션을 시작했습니다.': 'Started a new session.',
    '응답 중에는 세션을 전환할 수 없습니다.': 'Cannot switch sessions while a response is in progress.',
    '세션 목록 조회 실패: {error}': 'Failed to load sessions: {error}',
    '이어갈 수 있는 이전 세션이 없습니다.': 'No previous sessions to continue.',
    '이어갈 세션을 선택하세요:': 'Select a session to continue:',
    '(제목 없음)': '(untitled)',
    '세션을 불러왔습니다: {title}': 'Session loaded: {title}',
    '세션 전환 실패: {error}': 'Failed to switch session: {error}',
    '세션을 찾을 수 없습니다': 'Session not found',
    '모델이 변경되었습니다: {name}': 'Model changed: {name}',
    '모델 변경 실패: {error}': 'Failed to change model: {error}',
    '모델을 찾을 수 없습니다: {name}': 'Model not found: {name}',
    '사용법: /wd <path>': 'Usage: /wd <path>',
    '작업 디렉토리가 변경되었습니다: {dir}': 'Working directory changed: {dir}',
    '디렉토리 변경 실패: {error}': 'Failed to change directory: {error}',
    '작업 폴더 변경 중…': 'Changing working folder…',
    '작업 폴더 변경': 'Change working folder',
    '응답이 진행 중입니다. 응답을 중단하고 작업 폴더를 바꿀까요?': 'A response is in progress. Stop it and change the working folder?',
    '중단하고 변경': 'Stop and change',
    '커맨드 실행 실패: {error}': 'Command failed: {error}',
    '메시지 전송에 실패했습니다.': 'Failed to send the message.',
    '[첨부 파일 — 필요 시 read 도구로 읽어 분석하세요]': '[Attached files — read them with the read tool if needed]',

    // ---- 작업 폴더 즐겨찾기·최근 ----
    '즐겨찾기·최근 폴더': 'Favorite & recent folders',
    '지금 서버 실행 환경에서 쓸 수 없는 경로입니다: {path}': 'This path cannot be used by the current server runtime: {path}',
    '이름 바꾸기': 'Rename',
    '즐겨찾기에서 빼기': 'Remove from favorites',
    '즐겨찾기에 추가': 'Add to favorites',
    '최근 목록에서 지우기 (대화 기록은 남습니다)': 'Remove from recent (conversations are kept)',
    '불러오는 중…': 'Loading…',
    '즐겨찾기': 'Favorites',
    '☆를 눌러 자주 쓰는 폴더를 추가하세요': 'Click ☆ to add folders you use often',
    '최근 폴더': 'Recent folders',
    '☆ 현재 폴더 추가': '☆ Add current folder',
    '다른 폴더 열기…': 'Open another folder…',
    '경로 입력': 'Type a path',

    // ---- MCP ----
    'MCP 서버 없음': 'No MCP servers',
    '비활성': 'Disabled',
    '↻ 설정 다시 읽기': '↻ Reload config',
    '작업 폴더의 MCP와 skill/agent를 다시 읽습니다 (서버 프로세스 유지). 전역 설정의 MCP는 서버 재시작이 필요합니다': 'Re-reads the working folder\'s MCP and skills/agents (the server process keeps running). MCP in the global config needs a server restart',
    '⟳ 서버 재시작 (전역 MCP 포함)': '⟳ Restart server (incl. global MCP)',
    '서버를 다시 시작해 전역 설정까지 모두 다시 읽습니다 (10~30초)': 'Restarts the server and re-reads everything, including the global config (10–30s)',
    '다른 탭에서 응답 중': 'Responding in another tab',
    '다른 탭에서 진행 중인 응답이 {count}개 있습니다.\n지금 재시작하면 그 응답이 중단됩니다.': '{count} response(s) are in progress in other tabs.\nRestarting now will stop them.',
    '끝난 뒤 재시작': 'Restart when done',
    '지금 재시작': 'Restart now',
    '다른 탭의 응답 {count}개가 끝나면 재시작합니다…': 'Will restart when {count} response(s) in other tabs finish…',
    '재시작을 취소했습니다': 'Restart cancelled',
    '대기 취소': 'Cancel wait',

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
    '전송 중…': 'Sending…',
    '응답을 보냈습니다.': 'Response sent.',
    '권한 요청: {permission}': 'Permission request: {permission}',
    '하위 에이전트의 요청입니다.': 'Requested by a subagent.',
    '한 번 허용': 'Allow once',
    '항상 허용': 'Always allow',
    '거부': 'Reject',
    '에이전트의 질문': 'Question from the agent',
    '직접 입력 (선택)': 'Type your own (optional)',
    '답변 보내기': 'Send answer',
    '모든 질문에 답해 주세요.': 'Please answer every question.',
    '건너뛰기': 'Skip',
    '거부됨': 'Rejected',
    '항상 허용됨': 'Always allowed',
    '허용됨': 'Allowed',
    '응답 완료': 'Answered',
    '요청이 만료되었습니다.': 'This request has expired.',
    '페이지 컨텍스트': 'Page context',
    '응답 복구에 실패했습니다': 'Failed to recover the response',
    '메시지 전송 시간 초과 (15s)': 'Message send timed out (15s)',
    '재시도 대기 ({attempt}회차) · {secs}초 후': 'Retry #{attempt} · in {secs}s',
    '재시도 중 ({attempt}회차)...': 'Retrying (attempt {attempt})...',

    // ---- 응답 진행 표시 / 응답 제한 시간 ----
    '도구 실행 중: {tool}': 'Running tool: {tool}',
    '하위 에이전트 작업 중: {agent}': 'Subagent working: {agent}',
    '사용자 응답 대기 중': 'Waiting for your reply',
    '모델 응답 대기 중': 'Waiting for the model',
    '마지막 활동 {ago} 전': 'last activity {ago} ago',
    '서버 처리 중 확인됨': 'server confirmed busy',
    '서버 응답 없음 — 다시 확인 중': 'server not responding — rechecking',
    '대기 메시지 {count}개': '{count} queued',
    '응답 제한 시간': 'Response timeout',
    '{min}분': '{min} min',
    '응답이 오래 걸려도 끊지 않습니다. 서버가 처리 중인지 주기적으로 확인하고, 멈추면 ■로 중단하세요.': 'Slow responses are never cut off. The server is checked periodically; press ■ to stop if it seems stuck.',
    '이 시간 동안 아무 진행이 없으면 응답을 중단합니다. 다음 메시지부터 적용됩니다.': 'Stops the response if nothing happens for this long. Applies from the next message.',
    '응답 시간 초과 — ⚙ 설정에서 응답 제한 시간을 늘리거나 끌 수 있습니다.': 'Response timed out — you can raise or turn off the response timeout in ⚙ Settings.',
    '서버에 연결할 수 없어 응답 대기를 중단했습니다. ⚙에서 서버를 재시작해 보세요.': 'Stopped waiting because the server is unreachable. Try restarting the server in ⚙.',
    '서버가 응답을 시작하지 않았습니다. 다시 보내 보세요. 반복되면 /ext-log로 로그를 확인하세요.': 'The server never started responding. Try sending again; if it keeps happening, check the log with /ext-log.',

    // ---- 대기(pending) 메시지 ----
    '응답 중 — 입력하면 대기 메시지로 보냅니다': 'Responding — new messages will be queued',
    '응답 중에는 명령을 실행할 수 없습니다. 끝난 뒤 다시 시도하세요.': 'Commands cannot run while responding. Try again when it finishes.',
    '⏳ 대기 중 — 현재 응답이 끝나면 처리됩니다': '⏳ Queued — will be processed after the current response',
    '처리되지 않음 — 다시 보내 주세요': 'Not processed — please send again',
    '서버 기록에는 남아 있어 다음 대화의 맥락에 포함될 수 있습니다.': 'It remains in the server history and may be included as context in the next turn.',
    '전송 실패': 'Send failed',
    '사이드패널 닫기 (대화는 /sessions로 다시 열 수 있음)': 'Close the side panel (reopen the conversation with /sessions)',
    '대기 메시지 전송에 실패했습니다: {error}': 'Failed to queue the message: {error}',
    '이 페이지에 대해 요약, 설명, 검색 등을 요청해보세요.': 'Ask for a summary, explanation or search about this page.',
    '페이지가 변경되었습니다. 이 세션은 이전 페이지에서 이어지는 대화입니다.': 'The page changed. This session continues the conversation from the previous page.',
    '보내기': 'Send',
    '중단': 'Stop',
    '보내지 않음': 'Do not send',
    '제목·URL': 'Title & URL',
    '제목·URL·본문·선택 텍스트': 'Title, URL, content & selection',
    '메시지를 보낼 때 현재 탭 정보를 함께 보냅니다. 이 정보는 OpenCode를 거쳐 설정한 AI 제공자에게 전달됩니다.': 'Current tab info is sent with each message. It is passed through OpenCode to the AI provider you configured.',
    '⚠ 페이지 읽기 권한이 없어 제목·URL만 보냅니다. 다시 선택하면 권한을 요청합니다.': '⚠ Page access is not granted, so only the title and URL are sent. Select it again to request access.',
    '페이지 읽기 권한이 허용되지 않아 제목·URL만 보냅니다.': 'Page access was not granted; only the title and URL will be sent.',
    '초기화': 'Reset',
    '저장': 'Save',
    'opencode 서버 프로세스를 종료하고 다시 시작합니다': 'Stops and restarts the opencode server process',
    '서버 강제 재시작': 'Force restart server',
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
    '생각 중': 'Thinking',
    '{tool} 실행 중': 'running {tool}',
    '응답 작성 중': 'writing response',
    '{n}단계': '{n} steps',
    '하위 에이전트': 'subagent',
    '입력:\n': 'Input:\n',
    '결과:\n': 'Result:\n',
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
    '서버에 적용된 프록시': 'Proxy applied to the server',
    '서버에서 읽어 옴': 'Read from server',
    '확인할 수 없음': 'Unavailable',
    '없음': 'None',
    '적용된 프록시가 없습니다.': 'No proxy is applied.',
    '확장이 서버를 시작할 때 전달한 값입니다.': 'Value the extension passed when it started the server.',
    '서버 프로세스를 찾지 못했습니다.': 'Could not find the server process.',
    'WSL 프로세스의 환경변수를 읽지 못했습니다 (다른 사용자·다른 WSL 배포판에서 실행 중일 수 있음).': 'Could not read the WSL process environment (it may be running as another user or in another WSL distro).',
    '확장이 시작하지 않은 Windows 서버는 환경변수를 조회할 수 없습니다. 확장으로 재시작하면 확인할 수 있습니다.': 'Environment variables of a Windows server not started by the extension cannot be read. Restart it from the extension to check.',
    '이전 버전 확장이 시작한 서버라 조회할 수 없습니다. 재시작하면 확인할 수 있습니다.': 'The server was started by an older extension version, so it cannot be inspected. Restart it to check.',
    '서버에서 프록시 정보를 받지 못했습니다.': 'No proxy information was returned by the server.',
    '응답 시간 초과': 'Response timed out',
    '도구 실행이 멈춰 세션을 중단했습니다. 같은 문제가 반복되면 /new로 새 세션을 시작하거나 ⚙에서 서버를 재시작하세요.': 'A tool got stuck, so the session was aborted. If this keeps happening, start a new session with /new or restart the server from ⚙.',
    '모델이 빈 응답을 반환했습니다. 서버/모델 설정을 확인하거나 /ext-log로 로그를 확인하세요.': 'The model returned an empty response. Check the server/model settings or view logs with /ext-log.',
    '오류가 발생했습니다': 'An error occurred',
    '파일 선택 실패': 'File selection failed',
    '잘못된 값입니다': 'Invalid value'
  };

  let lang = 'ko';

  // background가 상태 코드 등을 붙여 보내는 오류 문구('세션 생성 실패: 500')는 사전 키와 정확히 맞지 않으므로
  // 앞부분 패턴으로 번역한다. $1 = 뒤에 붙은 상세 내용(그대로 둔다).
  const EN_PATTERNS = [
    [/^세션 생성 실패: (.*)$/s, 'Failed to create session: $1'],
    [/^세션 목록 조회 실패: (.*)$/s, 'Failed to list sessions: $1'],
    [/^메시지 전송 실패: (.*)$/s, 'Failed to send message: $1'],
    [/^응답 전송 실패: (.*)$/s, 'Failed to send response: $1'],
    [/^dispose 실패: (.*)$/s, 'Dispose failed: $1'],
  ];

  function t(ko, params) {
    let s = ko;
    if (lang === 'en') {
      if (Object.prototype.hasOwnProperty.call(EN, ko)) s = EN[ko];
      else if (typeof ko === 'string') {
        for (const [re, en] of EN_PATTERNS) {
          if (re.test(ko)) { s = ko.replace(re, en); break; }
        }
      }
    }
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
    ['title', 'placeholder', 'aria-label'].forEach((attr) => {
      // data-i18n-aria-label → dataset.i18nAriaLabel
      const data = 'i18n' + attr.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('');
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
