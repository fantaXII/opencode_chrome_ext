(function() {
  const messagesContainer = document.getElementById('messages-container');
  const messageInput = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');
  const modelSelect = document.getElementById('model-select');
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
  const attachBtn = document.getElementById('attach-btn');
  const inputArea = document.getElementById('input-area');
  const connectingIndicator = document.getElementById('connecting-indicator');
  const connectingMessage = document.getElementById('connecting-message');
  const connectingSpinner = document.getElementById('connecting-spinner');
  const retryBtn = document.getElementById('retry-btn');
  const commandDropdown = document.getElementById('command-dropdown');
  const agentBar = document.getElementById('agent-bar');
  const agentDot = document.getElementById('agent-dot');
  const agentNameEl = document.getElementById('agent-name');

  const mcpBtn = document.getElementById('mcp-btn');
  const mcpDropdown = document.getElementById('mcp-dropdown');

  const nativeHostGuide = document.getElementById('native-host-guide');
  const guideDownloadBtn = document.getElementById('guide-download-btn');
  const guideRetryBtn = document.getElementById('guide-retry-btn');

  let currentSessionId = null;
  let currentTabId = null;
  let isLoading = false;
  let availableModels = [];
  let selectedModel = null;
  let mcpServers = {};
  let commandCatalog = [
    { id: 'local.help',  slash: '/help',  title: 'Help',        description: '사용 가능한 커맨드 목록 표시', hasArg: false },
    { id: 'local.clear', slash: '/clear', title: 'Clear',       description: '채팅 히스토리 초기화',         hasArg: false },
    { id: 'local.model', slash: '/model', title: 'Model',       description: '모델 변경 <model-name>',       hasArg: true  },
    { id: 'local.wd',    slash: '/wd',    title: 'Working Dir', description: '작업 디렉토리 변경 <path>',    hasArg: true  },
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
      workingFolderDisplay.textContent = '폴더 없음';
      workingFolderWrapper.title = '';
      workingFolderDisplay.classList.remove('default');
      return;
    }
    const parts = dir.replace(/\\/g, '/').split('/').filter(Boolean);
    const short = parts.length > 2 ? '…/' + parts.slice(-2).join('/') : dir;
    workingFolderDisplay.textContent = short;
    workingFolderWrapper.title = isDefault ? `기본값: ${dir}` : dir;
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

  workingFolderEditBtn.addEventListener('click', enterEditMode);

  folderIcon.addEventListener('click', async () => {
    const res = await sendMessageToBackground('browse-for-folder');
    if (res?.directory) {
      const result = await sendMessageToBackground('set-working-directory', { directory: res.directory, tabId: currentTabId });
      updateWorkingFolderDisplay(result.directory || res.directory);
      applyWorkingDirSessionReset(result);
      if (res.warning) {
        addErrorMessage(res.warning);
      }
    }
  });

  async function commitWorkingFolder() {
    const newPath = workingFolderInput.value.trim();
    exitEditMode();
    if (newPath !== currentWorkingDir) {
      const result = await sendMessageToBackground('set-working-directory', { directory: newPath, tabId: currentTabId });
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
    addBotMessage('작업 디렉토리가 변경되어 새 세션을 시작합니다.');
  }

  workingFolderInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') { e.preventDefault(); await commitWorkingFolder(); }
    if (e.key === 'Escape') { exitEditMode(); }
  });

  workingFolderInput.addEventListener('blur', commitWorkingFolder);

  async function reinitForTab(tab, reason = 'unknown') {
    currentTabId = tab.id;
    currentSessionId = null;
    isLoading = false;
    loadingIndicator.classList.add('hidden');
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
  const PAGE_CONTEXT_HEADER_RE = /^\n---\n현재 페이지 정보:\n- 제목: .*\n- URL: .*\n/;
  const PAGE_CONTEXT_SECTION_LABELS = ['제목들:\n', '내용 요약:\n', '선택한 텍스트:\n'];

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
    div.className = 'message bot-message';
    div.innerHTML = `
      <div class="message-avatar">🌐</div>
      <div class="message-content">
        <strong>${escapeHtml(title)}</strong><br>
        <small style="opacity:0.6;word-break:break-all">${escapeHtml(url)}</small><br><br>
        이 페이지에 대해 요약, 설명, 검색 등을 요청해보세요.
      </div>
    `;
    messagesContainer.insertBefore(div, messagesContainer.firstChild);
    scrollToBottom();
  }

  function addPageChangedMessage(title, url) {
    const div = document.createElement('div');
    div.className = 'message bot-message';
    div.innerHTML = `
      <div class="message-avatar">🌐</div>
      <div class="message-content">
        페이지가 변경된 것을 확인했어요.<br>
        <strong>${escapeHtml(title)}</strong><br>
        <small style="opacity:0.6;word-break:break-all">${escapeHtml(url)}</small><br><br>
        이 세션은 이전 페이지에서 이어지는 대화입니다.
      </div>
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
        updateModelSelect();

        const { model } = await sendMessageToBackground('get-current-model');
        console.log('[loadModels] get-current-model result:', model);
        if (model) {
          for (const option of modelSelect.options) {
            if (!option.value) continue;
            try {
              const info = JSON.parse(option.value);
              if (info.providerId === model.providerID && info.modelName === model.modelID) {
                modelSelect.value = option.value;
                selectedModel = info;
                console.log('[loadModels] model selected:', modelSelect.value);
                break;
              }
            } catch {}
          }
        } else {
          console.log('[loadModels] no model found in storage');
        }
      }
    } catch (error) {
      console.error('모델 로드 실패:', error);
    }
  }

  function updateModelSelect() {
    modelSelect.innerHTML = '<option value="">모델 선택</option>';
    
    availableModels.forEach(provider => {
      const optgroup = document.createElement('optgroup');
      optgroup.label = provider.name || provider.id;
      
      const models = Array.isArray(provider.models)
        ? provider.models
        : Object.entries(provider.models || {}).map(([id, m]) => ({ id, ...(typeof m === 'object' ? m : {}) }));

      models.forEach(model => {
        const option = document.createElement('option');
        option.value = JSON.stringify({
          providerId: provider.id,
          modelName: model.id || model.name
        });
        option.textContent = model.name || model.id;
        optgroup.appendChild(option);
      });
      
      modelSelect.appendChild(optgroup);
    });
  }

  modelSelect.addEventListener('change', async (e) => {
    if (!e.target.value) return;
    
    const modelInfo = JSON.parse(e.target.value);
    selectedModel = modelInfo;
    
    try {
      await sendMessageToBackground('set-model', {
        providerId: modelInfo.providerId,
        modelName: modelInfo.modelName
      });
    } catch (error) {
      console.error('모델 변경 실패:', error);
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
      { id: 'local.help',  slash: '/help',  title: 'Help',        description: '사용 가능한 커맨드 목록 표시',   hasArg: false },
      { id: 'local.clear', slash: '/clear', title: 'Clear',       description: '채팅 히스토리 초기화',           hasArg: false },
      { id: 'local.model', slash: '/model', title: 'Model',       description: '모델 변경 <model-name>',         hasArg: true  },
      { id: 'local.wd',    slash: '/wd',    title: 'Working Dir', description: '작업 디렉토리 변경 <path>',      hasArg: true  },
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
    const filtered = commandCatalog.filter(c =>
      c.slash.toLowerCase().startsWith(query.toLowerCase())
    );
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
      agentNameEl.textContent = '에이전트';
      return;
    }
    const fullName = agent.name.replace(/[​-‍﻿]/g, '').trim();
    agentDot.style.color = agent.color || 'var(--text-secondary)';
    agentNameEl.textContent = fullName;
  }

  async function cycleAgent() {
    if (!availableAgents.length) return;
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

  function showModelPicker() {
    removeTypingIndicator();
    if (!availableModels.length) {
      addBotMessage('모델 목록을 불러오지 못했습니다. 서버 연결 상태를 확인하세요.');
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
    title.textContent = '모델을 선택하세요:';
    picker.appendChild(title);

    availableModels.forEach(provider => {
      const models = Array.isArray(provider.models)
        ? provider.models
        : Object.entries(provider.models || {}).map(([id, m]) => ({ id, ...(typeof m === 'object' ? m : {}) }));
      if (!models.length) return;

      const group = document.createElement('div');
      group.className = 'model-picker-group';

      const providerLabel = document.createElement('span');
      providerLabel.className = 'model-picker-provider';
      providerLabel.textContent = provider.name || provider.id;
      group.appendChild(providerLabel);

      models.forEach(model => {
        const providerId = provider.id;
        const modelId = model.id || model.name;
        const modelName = model.name || model.id;
        const isCurrent = selectedModel &&
          selectedModel.providerId === providerId &&
          selectedModel.modelName === modelId;

        const btn = document.createElement('button');
        btn.className = 'model-picker-btn' + (isCurrent ? ' current' : '');
        btn.textContent = modelName + (isCurrent ? ' ✓' : '');
        btn.dataset.provider = providerId;
        btn.dataset.model = modelId;
        btn.dataset.name = modelName;

        btn.addEventListener('click', async () => {
          try {
            await sendMessageToBackground('set-model', { providerId, modelName: modelId });
            selectedModel = { providerId, modelName: modelId };
            for (const option of modelSelect.options) {
              if (!option.value) continue;
              try {
                const info = JSON.parse(option.value);
                if (info.providerId === providerId && info.modelName === modelId) {
                  modelSelect.value = option.value;
                  break;
                }
              } catch {}
            }
            messageDiv.remove();
            addBotMessage(`모델이 변경되었습니다: ${modelName}`);
          } catch (e) {
            addErrorMessage(`모델 변경 실패: ${e.message}`);
          }
        });

        group.appendChild(btn);
      });

      picker.appendChild(group);
    });

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
      addBotMessage('사용 가능한 커맨드:\n\n' + lines);
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
        addErrorMessage('세션 재생성에 실패했습니다.');
      }
      addBotMessage('채팅이 초기화되었습니다.');
      sendBtn.disabled = false;
      return;
    }

    if (slash === '/model') {
      if (!args) { showModelPicker(); sendBtn.disabled = false; return; }
      const found = findModelByName(args);
      if (!found) { addBotMessage(`모델을 찾을 수 없습니다: ${args}`); sendBtn.disabled = false; return; }
      try {
        await sendMessageToBackground('set-model', { providerId: found.providerID, modelName: found.modelID });
        addBotMessage(`모델이 변경되었습니다: ${found.modelID}`);
        for (const option of modelSelect.options) {
          if (!option.value) continue;
          try {
            const info = JSON.parse(option.value);
            if (info.providerId === found.providerID && info.modelName === found.modelID) {
              modelSelect.value = option.value;
              selectedModel = info;
              break;
            }
          } catch {}
        }
      } catch (e) {
        addErrorMessage(`모델 변경 실패: ${e.message}`);
      } finally {
        sendBtn.disabled = false;
      }
      return;
    }

    if (slash === '/wd') {
      if (!args) { addBotMessage('사용법: /wd <path>'); sendBtn.disabled = false; return; }
      try {
        const result = await sendMessageToBackground('set-working-directory', { directory: args, tabId: currentTabId });
        updateWorkingFolderDisplay(result.directory || args);
        applyWorkingDirSessionReset(result);
        addBotMessage(`작업 디렉토리가 변경되었습니다: ${result.directory || args}`);
      } catch (e) {
        addErrorMessage(`디렉토리 변경 실패: ${e.message}`);
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
        addErrorMessage(`커맨드 실행 실패: ${error.message}`);
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
      addErrorMessage('메시지 전송에 실패했습니다.');
      setLoadingState(false);
    }
  }

  async function sendMessage() {
    const message = messageInput.value.trim();
    if (isLoading) return;
    if (!message && attachedFiles.length === 0) return;

    if (message.startsWith('/')) {
      if (message.trim().toLowerCase() === '/debug') {
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

    const attachmentsForMessage = attachedFiles.slice();
    const attachmentBlock = attachmentsForMessage.length > 0
      ? `[첨부 파일 — 필요 시 read 도구로 읽어 분석하세요]\n${attachmentsForMessage.map((f) => `- ${f}`).join('\n')}\n\n`
      : '';

    addUserMessage(message, attachmentsForMessage);
    messageInput.value = '';
    messageInput.style.height = 'auto';
    attachedFiles = [];
    renderAttachments();
    setLoadingState(true);
    addTypingIndicator();

    try {
      await sendMessageToBackground('send-message', {
        sessionId: currentSessionId,
        message: attachmentBlock + message
      });
    } catch (error) {
      console.error('메시지 전송 실패:', error);
      removeTypingIndicator();
      addErrorMessage('메시지 전송에 실패했습니다.');
      setLoadingState(false);
    }
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
        item.textContent = '📎 ' + (filePath.replace(/\\/g, '/').split('/').pop() || filePath);
        list.appendChild(item);
      });
      contentDiv.appendChild(list);
    }
    messagesContainer.appendChild(messageDiv);
    scrollToBottom();
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
    contentDiv.innerHTML = typeof marked !== 'undefined' ? marked.parse(content) : escapeHtml(content);
    messageDiv.appendChild(avatar);
    messageDiv.appendChild(contentDiv);
    messagesContainer.appendChild(messageDiv);
    enhanceCodeBlocks(contentDiv);
    scrollToBottom();
  }

  function addTypingIndicator() {
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
    messagesContainer.appendChild(typingDiv);
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

  function updateConnectionStatus(status) {
    header.classList.remove('connected', 'connecting');
    inputArea.classList.remove('disabled');
    connectingIndicator.classList.add('hidden');
    connectingSpinner.classList.remove('hidden');
    retryBtn.classList.add('hidden');

    switch (status) {
      case 'connected':
        header.classList.add('connected');
        connectionText.textContent = '연결됨';
        break;
      case 'connecting':
        header.classList.add('connecting');
        connectionText.textContent = '연결 중...';
        inputArea.classList.add('disabled');
        connectingMessage.textContent = 'OpenCode server connecting...';
        connectingIndicator.classList.remove('hidden');
        break;
      case 'disconnected':
        connectionText.textContent = '연결 안됨';
        inputArea.classList.add('disabled');
        connectingMessage.textContent = '서버 연결에 실패했습니다';
        connectingSpinner.classList.add('hidden');
        retryBtn.classList.remove('hidden');
        connectingIndicator.classList.remove('hidden');
        break;
      case 'error':
        connectionText.textContent = '오류';
        inputArea.classList.add('disabled');
        connectingMessage.textContent = '연결 오류가 발생했습니다';
        connectingSpinner.classList.add('hidden');
        retryBtn.classList.remove('hidden');
        connectingIndicator.classList.remove('hidden');
        break;
    }
  }

  retryBtn.addEventListener('click', () => {
    init();
  });

  function showNativeHostGuide() {
    const { version } = chrome.runtime.getManifest();
    guideDownloadBtn.href = `https://github.com/fantaXII/opencode_chrome_ext/releases/latest/download/opencode-native-host-setup-v${version}.exe`;
    nativeHostGuide.classList.remove('hidden');
    updateConnectionStatus('disconnected');
    connectingIndicator.classList.add('hidden');
  }

  function hideNativeHostGuide() {
    nativeHostGuide.classList.add('hidden');
  }

  guideRetryBtn.addEventListener('click', () => {
    hideNativeHostGuide();
    init();
  });

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

  // MCP 목록 아래에 고정으로 붙는 서버 재시작 액션.
  // - "설정 다시 읽기": POST /global/dispose (프로세스 유지, 1~2초). MCP/skill/agent를
  //   새로 등록했을 때 TUI를 exit 후 재진입한 것과 같은 효과.
  // - "서버 강제 재시작": 프로세스 종료 후 재기동 (10~30초). 서버가 먹통일 때만.
  const MCP_ACTIONS_HTML = `
    <div class="mcp-actions">
      <button id="mcp-reload-btn" class="mcp-action-btn"
              title="opencode가 config/MCP/skill/agent를 디스크에서 다시 읽습니다 (서버 프로세스 유지)">↻ 설정 다시 읽기</button>
      <button id="mcp-hard-restart-btn" class="mcp-action-btn danger"
              title="opencode 서버 프로세스를 종료하고 다시 시작합니다">⚡ 서버 강제 재시작</button>
      <div id="mcp-action-status" class="mcp-action-status hidden"></div>
    </div>`;

  function renderMcpDropdown() {
    const entries = Object.entries(mcpServers);
    if (entries.length === 0) {
      mcpDropdown.innerHTML = '<div class="mcp-empty">MCP 서버 없음</div>' + MCP_ACTIONS_HTML;
      bindMcpActions();
      return;
    }
    mcpDropdown.innerHTML = entries.map(([name, info]) => {
      const isOn = info.status === 'connected' || info.status === 'failed';
      const dotClass = info.status === 'connected' ? 'mcp-dot-connected'
                     : info.status === 'failed'    ? 'mcp-dot-failed'
                     :                               'mcp-dot-disabled';
      const statusLabel = info.status === 'connected' ? '연결됨'
                        : info.status === 'failed'    ? `오류`
                        :                               '비활성';
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
    }).join('') + MCP_ACTIONS_HTML;

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
  // 재렌더 후에도 복원한다.
  let mcpActionStatus = null; // { text, kind }
  let restartBusy = false;
  let hardRestartArmed = false;
  let hardRestartArmTimer = null;

  function applyMcpActionStatus() {
    const el = document.getElementById('mcp-action-status');
    if (!el) return;
    if (!mcpActionStatus) {
      el.className = 'mcp-action-status hidden';
      el.textContent = '';
      return;
    }
    el.className = 'mcp-action-status' + (mcpActionStatus.kind ? ` ${mcpActionStatus.kind}` : '');
    el.textContent = mcpActionStatus.text;
  }

  function setMcpActionStatus(text, kind) {
    mcpActionStatus = text ? { text, kind } : null;
    applyMcpActionStatus();
  }

  function disarmHardRestart() {
    clearTimeout(hardRestartArmTimer);
    hardRestartArmed = false;
    const btn = document.getElementById('mcp-hard-restart-btn');
    if (btn) {
      btn.classList.remove('armed');
      btn.textContent = '⚡ 서버 강제 재시작';
    }
  }

  function bindMcpActions() {
    const reloadBtn = document.getElementById('mcp-reload-btn');
    const hardBtn = document.getElementById('mcp-hard-restart-btn');
    if (restartBusy) {
      if (reloadBtn) reloadBtn.disabled = true;
      if (hardBtn) hardBtn.disabled = true;
    }
    applyMcpActionStatus();

    reloadBtn?.addEventListener('click', () => runServerRestart('soft'));

    // 사이드패널에서는 confirm() 동작을 보장할 수 없으므로 "두 번 클릭"으로 확인을 받는다.
    hardBtn?.addEventListener('click', () => {
      if (restartBusy) return;
      if (!hardRestartArmed) {
        hardRestartArmed = true;
        hardBtn.classList.add('armed');
        hardBtn.textContent = '⚠ 한 번 더 누르면 재시작';
        setMcpActionStatus('서버 프로세스를 종료하고 다시 시작합니다 (10~30초)', null);
        clearTimeout(hardRestartArmTimer);
        hardRestartArmTimer = setTimeout(() => {
          disarmHardRestart();
          setMcpActionStatus(null);
        }, 5000);
        return;
      }
      disarmHardRestart();
      runServerRestart('hard');
    });
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

  async function runServerRestart(mode) {
    if (restartBusy) return;
    const isHard = mode === 'hard';

    restartBusy = true;
    disarmHardRestart();
    for (const id of ['mcp-reload-btn', 'mcp-hard-restart-btn']) {
      const btn = document.getElementById(id);
      if (btn) btn.disabled = true;
    }
    setMcpActionStatus(isHard ? '서버를 재시작하는 중… (최대 30초)' : '설정을 다시 읽는 중…', null);

    // 재시작하면 진행 중인 응답은 서버 쪽에서 사라진다. 로딩 상태가 영구히 남지 않도록
    // 먼저 취소해 UI를 정리한다.
    if (isLoading) await cancelMessage();

    try {
      const res = await sendMessageToBackground(isHard ? 'restart-server' : 'restart-instance');
      if (!res?.success) {
        setMcpActionStatus(`실패: ${res?.error || '알 수 없는 오류'}`, 'error');
        if (isHard) updateConnectionStatus('disconnected');
        return;
      }

      updateConnectionStatus('connected');
      await refreshServerCatalogs();

      const suffix = isHard && res.portChanged ? ` (포트 ${res.port})` : '';
      setMcpActionStatus(isHard ? `서버 재시작 완료${suffix}` : '설정을 다시 읽었습니다', 'ok');
    } catch (error) {
      setMcpActionStatus(`실패: ${error.message}`, 'error');
    } finally {
      restartBusy = false;
      // MCP 목록이 바뀌었을 수 있으므로 다시 그린다(상태 문구는 재렌더 후 복원된다).
      if (!mcpDropdown.classList.contains('hidden')) renderMcpDropdown();
      else applyMcpActionStatus();
    }
  }

  mcpBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (mcpDropdown.classList.contains('hidden')) {
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
  });

  function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
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
      sendBtn.textContent = '■';
      sendBtn.classList.add('cancel-mode');
      loadingIndicator.classList.remove('hidden');
    } else {
      sendBtn.textContent = '↑';
      sendBtn.classList.remove('cancel-mode');
      updateSendButtonState();
      loadingIndicator.classList.add('hidden');
    }
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
    setLoadingState(false);
  }

  // ============================================
  // 디버그 로그 (/debug 커맨드)
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
      debugCopyStatus.textContent = '✓ 복사됨';
      setTimeout(() => { debugCopyStatus.textContent = ''; }, 2000);
    } catch {
      debugCopyStatus.textContent = '수동으로 복사하세요';
    }
  });

  async function showDebugLog() {
    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'message bot-message';
    loadingDiv.innerHTML = `<div class="message-avatar">🔍</div><div class="message-content">디버그 로그 수집 중...</div>`;
    messagesContainer.appendChild(loadingDiv);
    scrollToBottom();

    let result;
    try {
      result = await sendMessageToBackground('get-debug-logs');
    } catch (e) {
      loadingDiv.remove();
      addErrorMessage('디버그 로그 수집 실패: ' + e.message);
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
      debugCopyStatus.textContent = '✓ 클립보드에 자동 복사됨';
    } catch {
      debugCopyStatus.textContent = '복사 버튼을 눌러 수동으로 복사하세요';
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
    pending: '대기 중',
    running: '실행 중…',
    completed: '완료',
    error: '오류',
    cancelled: '취소됨',
    interrupted: '중단됨'
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
          <span class="tool-icon">🔧</span>
          <span class="tool-name"></span>
          <span class="tool-target"></span>
          <span class="tool-status"></span>
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
      <div class="reasoning-block-header">💭 생각 중</div>
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
      el.innerHTML = typeof marked !== 'undefined'
        ? marked.parse(block.raw)
        : escapeHtml(block.raw);
      return;
    }
    if (block.type === 'tool') {
      el.dataset.status = block.status || '';
      el.querySelector('.tool-name').textContent = block.tool || 'tool';
      el.querySelector('.tool-target').textContent = toolTarget(block);
      el.querySelector('.tool-status').textContent = toolStatusLabel(block.status);
      const bodyParts = [];
      if (block.input !== undefined) {
        bodyParts.push(`입력:\n${typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2)}`);
      }
      if (block.output) {
        bodyParts.push(`결과:\n${typeof block.output === 'string' ? block.output : JSON.stringify(block.output, null, 2)}`);
      }
      el.querySelector('.tool-card-body').textContent = bodyParts.join('\n\n').slice(0, 2000);
      return;
    }
    // reasoning
    el.querySelector('.reasoning-block-body').textContent = block.text;
  }

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
      copyBtn.textContent = '📋 복사';
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(codeEl.textContent);
          copyBtn.textContent = '✓ 복사됨';
        } catch {
          copyBtn.textContent = '복사 실패';
        } finally {
          setTimeout(() => { copyBtn.textContent = '📋 복사'; }, 1500);
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
    } else if (message.action === 'message-part' && message.sessionId === currentSessionId) {
      ensureActiveBlockMessage();
      const part = message.part || {};
      if (part.kind === 'tool') {
        upsertToolPart(activeBlocks, part);
      } else if (part.kind === 'reasoning-start') {
        upsertReasoningStart(activeBlocks, part.id);
      } else if (part.kind === 'reasoning-delta') {
        appendReasoningDelta(activeBlocks, part.id, part.delta);
      }
      blockRenderScheduler.request();
    } else if (message.action === 'default-directory-updated' && !currentWorkingDir) {
      defaultWorkingDir = message.directory;
      updateWorkingFolderDisplay(message.directory, true);
    } else if (message.action === 'message-complete' && message.sessionId === currentSessionId) {
      if (message.newSessionId) {
        currentSessionId = message.newSessionId;
      }
      setLoadingState(false);
      blockRenderScheduler.flush(); // pending 프레임을 즉시 반영해 마지막 delta 누락 방지

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
        addErrorMessage(message.error);
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
    }
  });

  function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => toast.classList.remove('show'), 2500);
  }

  document.querySelector('.header-placeholder').addEventListener('click', () => {
    showToast('🚧 준비 중입니다');
  });

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
      name.textContent = '📎 ' + (filePath.replace(/\\/g, '/').split('/').pop() || filePath);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'attachment-chip-remove';
      removeBtn.title = '제거';
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
      const input = window.prompt('첨부할 파일의 절대 경로를 입력하세요 (여러 개는 쉼표로 구분):');
      if (input) addAttachedFiles(input.split(','));
    }
  });

  init();
})();