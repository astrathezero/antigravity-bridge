// Antigravity Web Bridge - In-Page Automation & Extraction
// Injected into gemini.google.com to interact with the web interface,
// stream response tokens, and detect the logged-in Google Account.

(() => {
  'use strict';

  // Support hot replacement without blocking newer extension versions
  const GEN = (window.__ANTIGRAVITY_PAGE_GEN__ ?? 0) + 1;
  window.__ANTIGRAVITY_PAGE_GEN__ = GEN;

  console.log(`[Antigravity Page] Initialized in Gemini Web context (gen=${GEN})`);

  let activeObserver = null;
  let activeJobId = null;
  let idleTimer = null;

  // 1. Detect Logged-in Google Account Email
  function detectAccountEmail() {
    const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/;

    const selectors = [
      'a[aria-label*="@"]',
      'button[aria-label*="@"]',
      'img[alt*="@"]',
      'a[href*="accounts.google.com"]',
      'a[href*="SignOutOptions"]',
      '[data-profile-email]',
      '[data-user-email]',
      '[aria-label*="Google Account"]',
      '[aria-label*="บัญชี Google"]',
      'header [aria-label*="@"]',
      '.gb_d [aria-label*="@"]',
      '.gb_Fa [aria-label*="@"]',
      'div[aria-label*="@"]',
      'span[aria-label*="@"]'
    ];

    for (const sel of selectors) {
      try {
        const elements = document.querySelectorAll(sel);
        for (const el of elements) {
          const text = (
            el.getAttribute('aria-label') ||
            el.getAttribute('alt') ||
            el.getAttribute('title') ||
            el.getAttribute('data-profile-email') ||
            el.getAttribute('data-user-email') ||
            el.innerText ||
            ''
          );
          const match = text.match(emailRegex);
          if (match && match[1]) {
            return match[1].toLowerCase();
          }
        }
      } catch {}
    }

    const metaUser = document.querySelector('meta[name="user-email"]');
    if (metaUser && metaUser.content) {
      const match = metaUser.content.match(emailRegex);
      if (match && match[1]) return match[1].toLowerCase();
    }

    try {
      if (window.WIZ_global_data) {
        const str = JSON.stringify(window.WIZ_global_data);
        const match = str.match(emailRegex);
        if (match && match[1]) return match[1].toLowerCase();
      }
    } catch {}

    try {
      const header = document.querySelector('header, [role="banner"], .gb_rd, .gb_d');
      if (header) {
        const match = (header.innerHTML || '').match(emailRegex);
        if (match && match[1]) return match[1].toLowerCase();
      }
    } catch {}

    return '';
  }

  // Periodic account email announcement every 4 seconds
  setInterval(() => {
    if (window.__ANTIGRAVITY_PAGE_GEN__ !== GEN) return;
    const email = detectAccountEmail();
    if (email) {
      window.postMessage({ type: 'AG_DETECTED_EMAIL', email }, '*');
    }
  }, 4000);

  // 2. Locate the prompt input element
  function findInputElement() {
    const candidates = [
      'input-container rich-textarea .ql-editor',
      'rich-textarea .ql-editor',
      'chat-window .textarea',
      'input-container [contenteditable="true"][role="textbox"]',
      'chat-window [contenteditable="true"][role="textbox"]',
      'div.ql-editor[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'textarea[aria-label*="prompt" i]',
      'rich-textarea',
      'textarea'
    ];

    for (const sel of candidates) {
      try {
        const elements = Array.from(document.querySelectorAll(sel));
        const visible = elements.find(el => el.offsetParent !== null || el.getBoundingClientRect().width > 0);
        if (visible) return visible;
        if (elements[0]) return elements[0];
      } catch {}
    }
    return null;
  }

  // 3. Locate the send button
  const GEMINI_SEND_BUTTON_SELECTORS = [
    'chat-window button.send-button',
    'button.send-button',
    'button[aria-label*="Send" i]',
    'button[aria-label*="ส่ง" i]',
    'button[aria-label*="送出" i]',
    'button[aria-label*="傳送" i]',
    'button[aria-label*="Submit" i]',
    'button[data-test-id*="send" i]',
    'button[data-testid*="send" i]',
    '.send-button-container button',
    'button:has(mat-icon[fonticon="send"])',
    'button:has([data-mat-icon-name="send"])'
  ];

  function isSendButtonEnabled(btn) {
    if (!btn) return false;
    if (btn.disabled) return false;
    if (btn.getAttribute('aria-disabled') === 'true') return false;
    if (btn.classList.contains('mat-mdc-button-disabled')) return false;
    return true;
  }

  function isLikelySendButton(button) {
    const ariaLabel = (button.getAttribute('aria-label') || '').toLowerCase();
    const testId = (
      button.getAttribute('data-test-id') ||
      button.getAttribute('data-testid') ||
      ''
    ).toLowerCase();
    const textContent = (button.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const icon = button.querySelector('mat-icon, [data-mat-icon-name], [fonticon]');
    const iconName = (
      icon?.getAttribute('fonticon') ||
      icon?.getAttribute('data-mat-icon-name') ||
      icon?.textContent ||
      ''
    ).toLowerCase();

    const sendTokens = ['send', 'submit', 'ส่ง', 'ส่งข้อความ', '送出', '傳送', '提交'];
    return sendTokens.some((token) =>
      ariaLabel.includes(token) ||
      testId.includes(token) ||
      textContent === token ||
      iconName.includes(token)
    );
  }

  function findSendButton() {
    for (const sel of GEMINI_SEND_BUTTON_SELECTORS) {
      try {
        const btn = document.querySelector(sel);
        if (btn && (btn.offsetParent !== null || btn.getBoundingClientRect().width > 0)) {
          return btn;
        }
      } catch {}
    }
    const allButtons = Array.from(document.querySelectorAll('button'));
    return allButtons.find(btn => (btn.offsetParent !== null || btn.getBoundingClientRect().width > 0) && isLikelySendButton(btn)) || null;
  }

  // 4. Check if Gemini is actively generating a response (Stop button present)
  function isGenerating() {
    const stopSelectors = [
      'button[aria-label*="Stop" i]',
      'button[aria-label*="หยุด" i]',
      'button[aria-label*="停止" i]',
      'button.stop-button',
      'button:has(mat-icon[fonticon="stop"])',
      'button:has([data-mat-icon-name="stop"])',
      '[aria-label*="Stop response" i]'
    ];
    for (const sel of stopSelectors) {
      try {
        const btn = document.querySelector(sel);
        if (btn && (btn.offsetParent !== null || btn.getBoundingClientRect().width > 0)) {
          return true;
        }
      } catch {}
    }

    const allButtons = Array.from(document.querySelectorAll('button'));
    for (const btn of allButtons) {
      if (btn.offsetParent === null && btn.getBoundingClientRect().width === 0) continue;
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      const icon = btn.querySelector('mat-icon, [data-mat-icon-name], [fonticon]');
      const iconName = (icon?.getAttribute('fonticon') || icon?.getAttribute('data-mat-icon-name') || icon?.textContent || '').toLowerCase();
      if (aria.includes('stop') || aria.includes('หยุด') || aria.includes('停止') || iconName.includes('stop')) {
        return true;
      }
    }
    return false;
  }

  // 5. Get all response blocks on the page
  function getAllResponseBlocks() {
    // Strategy 1: Find by action buttons (Copy / Good response / Modify) present on every response
    const actionButtons = document.querySelectorAll(
      'button[aria-label*="Copy" i], button[aria-label*="คัดลอก" i], ' +
      'button[aria-label*="Good response" i], button[aria-label*="คำตอบที่ดี" i], ' +
      'button[aria-label*="Modify" i], button[aria-label*="สร้างใหม่" i]'
    );
    if (actionButtons.length > 0) {
      const blocks = [];
      for (const btn of actionButtons) {
        const container = btn.closest('model-response, response-container, .conversation-container, [data-test-id="model-response"]') ||
                          btn.parentElement?.parentElement?.parentElement;
        if (container && !blocks.includes(container)) {
          blocks.push(container);
        }
      }
      if (blocks.length > 0) return blocks;
    }

    // Strategy 2: Standard custom elements and containers
    const selectors = [
      'model-response',
      'response-container',
      '.model-response-container',
      '[data-test-id="model-response"]',
      'message-content',
      '.conversation-container:has(message-content)',
      '.conversation-container'
    ];

    for (const sel of selectors) {
      try {
        const found = Array.from(document.querySelectorAll(sel));
        if (found.length > 0) {
          if (sel === '.conversation-container') {
            const assistantOnly = found.filter(el => !el.querySelector('user-query, .user-query, .query-text, .query-text-line'));
            if (assistantOnly.length > 0) return assistantOnly;
          } else {
            return found;
          }
        }
      } catch {}
    }
    return [];
  }

  // 6. Clean and format response text (with Flash Thinking process extraction)
  function extractCleanText(el) {
    if (!el) return '';

    const mdChild = el.querySelector('.markdown, message-content, .response-container-content, [class*="markdown"]');
    const target = mdChild || el;

    const thoughtSelectors = [
      '.thought-content',
      '.thoughts-container',
      '[data-test-id*="thought"]',
      '.thinking-process',
      'details.thought',
      '.collapse-thought'
    ];

    let thoughtText = '';
    for (const tSel of thoughtSelectors) {
      try {
        const tEl = el.querySelector(tSel);
        if (tEl) {
          const rawThought = (tEl.innerText || tEl.textContent || '').trim();
          if (rawThought) {
            thoughtText = rawThought;
            break;
          }
        }
      } catch {}
    }

    // Extract text while excluding action buttons, icons, and toolbars
    let mainText = '';
    try {
      const clone = target.cloneNode(true);
      const buttonsAndToolbars = clone.querySelectorAll('button, mat-icon, response-action-buttons, message-actions, .response-container-footer, .action-button');
      buttonsAndToolbars.forEach(b => b.remove());
      mainText = (clone.innerText || clone.textContent || '').trim();
    } catch {
      mainText = (target.innerText || target.textContent || '').trim();
    }

    if (thoughtText && !mainText.startsWith('<think>')) {
      const cleanedMain = mainText.replace(thoughtText, '').trim();
      if (cleanedMain) {
        return `<think>\n${thoughtText}\n</think>\n\n${cleanedMain}`;
      }
    }

    return mainText;
  }

  // 6.5 Intelligent Model Selection (Flash Thinking / Best Available Model)
  async function selectBestModel(targetModel) {
    const desired = (targetModel || 'gemini-3.8-flash-thinking').toLowerCase();
    const preferThinking = desired.includes('thinking') || desired.includes('flash') || desired.includes('web');

    const switcherSelectors = [
      '[data-test-id="model-switcher"]',
      'button[aria-label*="model" i]',
      'button[aria-label*="โมเดล" i]',
      'button[aria-label*="select model" i]',
      'button.model-picker-btn',
      'button:has(.model-title)',
      'div[role="combobox"]',
      'button[aria-haspopup="menu"]'
    ];

    let switcherBtn = null;
    for (const sel of switcherSelectors) {
      try {
        const candidates = document.querySelectorAll(sel);
        for (const btn of candidates) {
          if (btn && (btn.offsetParent !== null || btn.getBoundingClientRect().width > 0)) {
            const text = (btn.innerText || btn.getAttribute('aria-label') || '').toLowerCase();
            if (
              text.includes('flash') ||
              text.includes('pro') ||
              text.includes('thinking') ||
              text.includes('advanced') ||
              text.includes('gemini') ||
              btn.getAttribute('data-test-id') === 'model-switcher'
            ) {
              switcherBtn = btn;
              break;
            }
          }
        }
        if (switcherBtn) break;
      } catch {}
    }

    if (!switcherBtn) {
      return;
    }

    const currentText = (switcherBtn.innerText || switcherBtn.getAttribute('aria-label') || '').toLowerCase();
    if (preferThinking && (currentText.includes('flash thinking') || currentText.includes('3.8 flash thinking') || currentText.includes('2.0 flash thinking') || currentText.includes('thinking'))) {
      console.log(`[Antigravity Page] Already on desired model: ${currentText}`);
      return;
    }

    switcherBtn.click();
    await new Promise(r => setTimeout(r, 450));

    const itemSelectors = [
      '[role="menuitem"]',
      '[role="option"]',
      'button.mat-mdc-menu-item',
      '.mat-mdc-menu-panel button',
      'div[role="listbox"] div[role="option"]',
      '.model-item'
    ];

    let menuItems = [];
    for (const s of itemSelectors) {
      try {
        const found = document.querySelectorAll(s);
        for (const it of found) {
          if (it && (it.offsetParent !== null || it.getBoundingClientRect().width > 0)) {
            menuItems.push(it);
          }
        }
      } catch {}
    }

    if (menuItems.length === 0) {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      return;
    }

    let bestItem = null;
    let highestScore = -1;

    for (const item of menuItems) {
      const label = (item.innerText || item.getAttribute('aria-label') || '').toLowerCase();
      let score = 0;
      if (label.includes('3.8 flash thinking') || label.includes('flash thinking') || label.includes('thinking')) {
        score = 100;
      } else if (label.includes('2.0 flash thinking')) {
        score = 95;
      } else if (label.includes('3.8 flash')) {
        score = 90;
      } else if (label.includes('2.0 flash')) {
        score = 80;
      } else if (label.includes('flash')) {
        score = 70;
      } else if (label.includes('pro') || label.includes('advanced')) {
        score = 60;
      }

      if (score > highestScore) {
        highestScore = score;
        bestItem = item;
      }
    }

    if (bestItem && highestScore > 0) {
      const chosenLabel = (bestItem.innerText || bestItem.getAttribute('aria-label') || '').trim();
      console.log(`[Antigravity Page] Selected model: "${chosenLabel}" (score=${highestScore})`);
      bestItem.click();
      await new Promise(r => setTimeout(r, 400));
    } else {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    }
  }

  // 7. Execute Job
  async function executeJob(job) {
    if (window.__ANTIGRAVITY_PAGE_GEN__ !== GEN) return;

    const jobId = job.jobId || job.job_id;
    activeJobId = jobId;

    console.log(`[Antigravity Page] Starting job ${jobId} (model=${job.model || 'default'})`);

    if (activeObserver) {
      activeObserver.disconnect();
      activeObserver = null;
    }
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }

    // 0. Ensure best model (Flash Thinking by default)
    try {
      await selectBestModel(job.model || 'gemini-3.8-flash-thinking');
    } catch (mErr) {
      console.warn('[Antigravity Page] Model selection warning:', mErr);
    }

    const inputEl = findInputElement();
    if (!inputEl) {
      window.postMessage({
        type: 'AG_JOB_ERROR',
        jobId,
        error: 'Unable to locate Gemini prompt input box. Please verify you are on gemini.google.com/app.'
      }, '*');
      return;
    }

    // 1. Snapshot response blocks BEFORE sending prompt
    const baselineBlocks = getAllResponseBlocks();
    const baselineCount = baselineBlocks.length;

    // 2. Set input content
    inputEl.focus();
    try {
      if (inputEl.isContentEditable) {
        const lines = (job.prompt || '').split('\n');
        inputEl.innerHTML = '';
        lines.forEach((line) => {
          const p = document.createElement('p');
          p.innerText = line;
          inputEl.appendChild(p);
        });

        try {
          const q = inputEl.__quill || inputEl.closest('rich-textarea')?.__quill;
          if (q && typeof q.setText === 'function') {
            q.setText(job.prompt);
          }
        } catch {}
      } else {
        inputEl.value = job.prompt;
      }

      inputEl.dispatchEvent(new Event('beforeinput', { bubbles: true, cancelable: true }));
      inputEl.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      inputEl.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    } catch (e) {
      console.warn('[Antigravity Page] Input dispatch error, fallback direct property:', e);
      inputEl.textContent = job.prompt;
    }

    // 3. Wait for send button to become enabled and click it
    let sendBtn = null;
    const submitStart = Date.now();
    while (Date.now() - submitStart < 3500) {
      sendBtn = findSendButton();
      if (sendBtn && isSendButtonEnabled(sendBtn)) {
        break;
      }
      await new Promise(r => setTimeout(r, 150));
    }

    if (sendBtn && isSendButtonEnabled(sendBtn)) {
      sendBtn.focus();
      sendBtn.click();
    } else {
      // Fallback: Dispatch Enter keydown
      inputEl.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      }));
      await new Promise(r => setTimeout(r, 300));
      sendBtn = findSendButton();
      if (sendBtn) {
        sendBtn.click();
      }
    }

    // 4. Wait for generation to start and capture response container
    let targetResponseEl = null;
    let fullText = '';
    let emittedLength = 0;
    const startTime = Date.now();
    const timeoutMs = (job.timeout || 600) * 1000;

    while (!targetResponseEl && (Date.now() - startTime < 45000)) {
      await new Promise(r => setTimeout(r, 350));
      const currentBlocks = getAllResponseBlocks();
      if (currentBlocks.length > baselineCount) {
        targetResponseEl = currentBlocks[currentBlocks.length - 1];
        break;
      }
      if (isGenerating()) {
        if (currentBlocks.length > 0) {
          targetResponseEl = currentBlocks[currentBlocks.length - 1];
          break;
        }
      }
    }

    if (!targetResponseEl) {
      const currentBlocks = getAllResponseBlocks();
      if (currentBlocks.length > 0) {
        targetResponseEl = currentBlocks[currentBlocks.length - 1];
      }
    }

    if (!targetResponseEl) {
      const mainChat = document.querySelector('chat-window, main, infinite-scroller, .chat-history');
      if (mainChat) {
        targetResponseEl = mainChat;
      }
    }

    if (!targetResponseEl) {
      window.postMessage({
        type: 'AG_JOB_ERROR',
        jobId,
        error: `Timeout waiting for Gemini response container to appear. (url=${window.location.pathname}, baseline=${baselineCount}, isGenerating=${isGenerating()})`
      }, '*');
      return;
    }

    console.log(`[Antigravity Page] Attached observer to response container for job ${jobId}`);

    const emitDeltas = () => {
      if (window.__ANTIGRAVITY_PAGE_GEN__ !== GEN) return;
      const currentFullText = extractCleanText(targetResponseEl);
      if (currentFullText.length > emittedLength) {
        const delta = currentFullText.slice(emittedLength);
        emittedLength = currentFullText.length;
        fullText = currentFullText;
        window.postMessage({
          type: 'AG_JOB_DELTA',
          jobId,
          delta
        }, '*');
      }
    };

    const finishJob = () => {
      if (window.__ANTIGRAVITY_PAGE_GEN__ !== GEN) return;
      if (activeObserver) {
        activeObserver.disconnect();
        activeObserver = null;
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      emitDeltas();
      console.log(`[Antigravity Page] Job ${jobId} finished. Output length: ${fullText.length}`);
      window.postMessage({
        type: 'AG_JOB_DONE',
        jobId,
        text: fullText,
        finishReason: 'stop'
      }, '*');
      activeJobId = null;
    };

    activeObserver = new MutationObserver(() => {
      emitDeltas();

      if (idleTimer) clearTimeout(idleTimer);

      if (!isGenerating()) {
        idleTimer = setTimeout(() => {
          if (!isGenerating()) {
            finishJob();
          }
        }, 1200);
      }
    });

    activeObserver.observe(targetResponseEl, {
      childList: true,
      subtree: true,
      characterData: true
    });

    const pollInterval = setInterval(() => {
      if (window.__ANTIGRAVITY_PAGE_GEN__ !== GEN) {
        clearInterval(pollInterval);
        return;
      }

      emitDeltas();

      if (Date.now() - startTime > timeoutMs) {
        clearInterval(pollInterval);
        if (activeObserver) activeObserver.disconnect();
        window.postMessage({
          type: 'AG_JOB_ERROR',
          jobId,
          error: `Execution timed out after ${job.timeout || 600}s`
        }, '*');
        activeJobId = null;
        return;
      }

      if (!isGenerating() && emittedLength > 0) {
        if (!idleTimer) {
          idleTimer = setTimeout(() => {
            if (!isGenerating()) {
              clearInterval(pollInterval);
              finishJob();
            }
          }, 1500);
        }
      }
    }, 800);
  }

  // Listen for execution commands from content script
  window.addEventListener('message', (event) => {
    if (window.__ANTIGRAVITY_PAGE_GEN__ !== GEN) return;
    if (event.source !== window || !event.data) return;

    if (event.data.type === 'AG_EXECUTE_JOB' && event.data.job) {
      executeJob(event.data.job);
    } else if (event.data.type === 'AG_CHECK_EMAIL') {
      const email = detectAccountEmail();
      window.postMessage({ type: 'AG_DETECTED_EMAIL', email }, '*');
    }
  });

  // Announce page script readiness
  const initialEmail = detectAccountEmail();
  window.postMessage({ type: 'AG_PAGE_READY', email: initialEmail }, '*');
})();
