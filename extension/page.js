// Antigravity Web Bridge - In-Page Automation & Extraction
// Injected into gemini.google.com to interact with the web interface,
// stream response tokens, and detect the logged-in Google Account.

(() => {
  'use strict';

  if (window.__ANTIGRAVITY_PAGE_LOADED__) {
    console.log('[Antigravity Page] Already loaded in Gemini Web context');
    return;
  }
  window.__ANTIGRAVITY_PAGE_LOADED__ = true;

  console.log('[Antigravity Page] Initialized in Gemini Web context');

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
    const inputArea = document.querySelector('input-container, rich-textarea, .input-area, form.chat-input, .send-button-container');
    const stopInInput = inputArea?.querySelector(
      'button[aria-label*="Stop response" i], button[aria-label*="หยุดการตอบกลับ" i], ' +
      'button.stop-button, button[aria-label="Stop" i], button[aria-label="หยุด" i]'
    );
    if (stopInInput && (stopInInput.offsetParent !== null || stopInInput.getBoundingClientRect().width > 0)) {
      return true;
    }

    const chatRoot = document.querySelector('chat-window, main, .chat-history, infinite-scroller') || document.body;
    const stopBtn = chatRoot.querySelector(
      'button.stop-button, button[aria-label="Stop response" i], button[aria-label="หยุดการตอบกลับ" i]'
    );
    if (stopBtn && (stopBtn.offsetParent !== null || stopBtn.getBoundingClientRect().width > 0)) {
      return true;
    }

    return false;
  }

  // 4.1 Check if Gemini has rendered final response action buttons (Copy / Feedback)
  function hasResponseFinished(targetEl) {
    if (!targetEl) return false;
    const hasActions = targetEl.querySelector(
      'button[aria-label*="Copy" i], button[aria-label*="คัดลอก" i], ' +
      'button[aria-label*="Good response" i], button[aria-label*="คำตอบที่ดี" i], ' +
      'response-action-buttons, .response-container-footer, message-actions'
    );
    return Boolean(hasActions);
  }

  // 5. Get all response blocks on the page
  function getAllResponseBlocks() {
    // Strategy 1: Standard model response custom elements and containers (present immediately upon turn start)
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

    // Strategy 2: Find by action buttons (Copy / Good response / Modify)
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

    return [];
  }

  // 6. Clean and format response text (with Flash Thinking process extraction)
  function extractCleanText(el) {
    if (!el) return '';

    const mdChild = el.querySelector('.markdown, message-content, .response-container-content, [class*="markdown"], .model-response-text');
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

    // Extract text while excluding action buttons, icons, toolbars, and thinking container
    let mainText = '';
    try {
      const clone = target.cloneNode(true);
      const buttonsAndToolbars = clone.querySelectorAll(
        'button, mat-icon, response-action-buttons, message-actions, .response-container-footer, .action-button, ' +
        '.thought-content, .thoughts-container, [data-test-id*="thought"], .thinking-process, details.thought, .collapse-thought, ' +
        '.visually-hidden, [class*="visually-hidden"], [class*="sr-only"], .speaker-label, [aria-hidden="true"]'
      );
      buttonsAndToolbars.forEach(b => b.remove());
      mainText = (clone.innerText || clone.textContent || '').trim();
    } catch {
      mainText = (target.innerText || target.textContent || '').trim();
    }

    if (!mainText) {
      mainText = (target.innerText || target.textContent || '').trim();
    }

    // Strip out any remaining localized speaker indicator like "Gemini บอกว่า" or "Gemini says:"
    mainText = mainText.replace(/^(?:Gemini\s*(?:บอกว่า|says)[\s:]*)+/i, '').trim();

    // Strip Antigravity status footer that Gemini may append when Canvas session has prior context
    // Pattern: "\n---\n> ⚡ Antigravity Profile: ..." or similar blockquote separator footers
    mainText = mainText.replace(/\n[-—]{2,}\n(?:>\s*.*\n?)*$/m, '').trim();
    // Also strip trailing blockquote lines with profile/quota info
    mainText = mainText.replace(/(\n>[ \t]*[⚡🔋📊🟢].+)+$/g, '').trim();

    if (thoughtText && !mainText.startsWith('<think>')) {
      mainText = `<think>\n${thoughtText}\n</think>\n\n${mainText}`;
    }

    // Extract Canvas Workspace Content (if open and contains document/code)
    const canvasContent = extractCanvasContent();
    if (canvasContent && canvasContent.length > 30 && !mainText.includes(canvasContent.slice(0, 40))) {
      mainText = `${mainText}\n\n${canvasContent}`;
    }

    return mainText;
  }

  // 6.3 Canvas Workspace Content Extraction
  function extractCanvasContent() {
    try {
      const canvasPanels = document.querySelectorAll(
        'canvas-workspace, canvas-editor, .canvas-container, [data-test-id*="canvas-content"], ' +
        '.canvas-document, .canvas-code, .workspace-content, mat-card.canvas-card, .canvas-body'
      );
      for (const panel of canvasPanels) {
        if (panel && (panel.offsetParent !== null || panel.getBoundingClientRect().width > 0)) {
          const codeEl = panel.querySelector('code, pre, .monaco-editor, textarea, .code-viewer');
          if (codeEl) {
            const codeText = (codeEl.innerText || codeEl.textContent || '').trim();
            if (codeText.length > 20) return codeText;
          }
          const text = (panel.innerText || panel.textContent || '').trim();
          if (text.length > 20) return text;
        }
      }
    } catch {}
    return '';
  }

  // 6.4 Canvas Mode Enforcement
  // IMPORTANT: Never use window.location.href here — it reloads the page and kills the in-flight job.
  // Instead, only attempt in-page Canvas button click. If no canvas button found, proceed normally.
  async function ensureCanvasMode() {
    const isCanvasUrl = window.location.pathname.includes('/canvas');

    if (isCanvasUrl) {
      // Already on canvas path — nothing to do
      console.log('[Antigravity Page] Already on /canvas path, skipping canvas navigation.');
      return;
    }

    // Try to find and click the Canvas attachment/mode button in the input area
    // (the button that prepares the response as a Canvas document)
    const canvasBtn = Array.from(document.querySelectorAll(
      'button, gem-button, [data-test-id], mat-icon-button'
    )).find(b => {
      const label = (b.innerText || b.getAttribute('aria-label') || b.getAttribute('data-test-id') || '').toLowerCase();
      return /canvas|แคนวาส/i.test(label) &&
             !label.includes('ยกเลิก') &&
             !label.includes('deselect') &&
             (b.offsetParent !== null || b.getBoundingClientRect().width > 0);
    });

    if (canvasBtn) {
      console.log('[Antigravity Page] Found Canvas button, clicking to enable Canvas mode.');
      canvasBtn.click();
      await new Promise(r => setTimeout(r, 600));
    } else {
      console.log('[Antigravity Page] Canvas button not found in current view, proceeding without canvas navigation.');
    }
  }

  // 6.5 New Chat Reset — always start fresh to avoid context bleed between API calls
  async function ensureFreshChatIfNeeded() {
    // Always try to start a new chat so each API call is context-free
    // Look for the new chat / sparkle button in the sidebar
    const newChatBtn = document.querySelector(
      '[data-test-id="new-chat-button"], ' +
      'gem-nav-list-item[data-test-id="new-chat-button"], ' +
      'a[data-test-id="side-nav-sparkle-button"], ' +
      'button[aria-label*="แชทใหม่" i], ' +
      'button[aria-label*="New chat" i], ' +
      'a[aria-label*="New chat" i]'
    );

    if (newChatBtn) {
      console.log('[Antigravity Page] Clicking New Chat button for fresh conversation.');
      newChatBtn.click();
      await new Promise(r => setTimeout(r, 1500));
    } else {
      // Fallback: check if we're on a thread path and log a warning
      const pathParts = window.location.pathname.replace(/\/u\/\d+\//, '/').split('/').filter(Boolean);
      const isOnThread = pathParts.length > 1 && !pathParts.includes('canvas') && !pathParts.includes('app');
      if (isOnThread) {
        console.warn('[Antigravity Page] On a thread but could not find New Chat button. Response may include prior context.');
      }
    }
  }

  // 6.6 Intelligent Model Selection (Flash Thinking / Best Available Model)
  async function selectBestModel(targetModel) {
    let desired = (targetModel || 'gemini-3.8-flash-thinking').toLowerCase().trim();
    if (desired === 'gemini-web' || desired === 'default' || !desired) {
      desired = 'gemini-3.8-flash-thinking';
    }

    // Determine intent flags — mutually exclusive categories
    const wantPro = (desired.includes('pro') || desired.includes('advanced')) && !desired.includes('flash');
    const wantProThinking = wantPro && (desired.includes('thinking') || desired.includes('extended') || desired.includes('reason'));
    const wantFlashThinking = !wantPro && (desired.includes('thinking') || desired.includes('extended') || desired.includes('reason'));
    const wantLite = desired.includes('lite') || desired.includes('fast');
    const wantFlashStandard = !wantPro && !wantFlashThinking && !wantLite;

    console.log(`[Antigravity Page] selectBestModel: desired="${desired}" → wantFlashThinking=${wantFlashThinking}, wantProThinking=${wantProThinking}, wantPro=${wantPro}, wantLite=${wantLite}`);

    const switcherSelectors = [
      '[data-test-id="bard-mode-menu-button"]',
      'button.model-picker-btn',
      'button:has([data-test-id="logo-pill-label-container"])',
      '[data-test-id="model-switcher"]',
      'button[aria-label*="model" i]',
      'button[aria-label*="โมเดล" i]',
      'button[aria-label*="โหมด" i]',
      'div[role="combobox"]'
    ];

    let switcherBtn = null;
    for (const sel of switcherSelectors) {
      try {
        const found = document.querySelector(sel);
        if (found && (found.offsetParent !== null || found.getBoundingClientRect().width > 0)) {
          switcherBtn = found;
          break;
        }
      } catch {}
    }

    if (!switcherBtn) {
      console.log('[Antigravity Page] Model switcher button not found on this view.');
      return;
    }

    const currentText = (switcherBtn.innerText + ' ' + (switcherBtn.getAttribute('aria-label') || '')).toLowerCase();

    // Check if already in the correct target state (must be specific enough to avoid false positives)
    if (wantFlashThinking) {
      const alreadyFlashThinking = (currentText.includes('flash') || currentText.includes('3.8')) &&
        (currentText.includes('thinking') || currentText.includes('extended') || currentText.includes('คิดที่นานขึ้น'));
      if (alreadyFlashThinking) {
        console.log(`[Antigravity Page] Already in Flash Thinking mode: "${currentText}"`);
        return;
      }
    } else if (wantProThinking) {
      const alreadyProThinking = currentText.includes('pro') &&
        (currentText.includes('thinking') || currentText.includes('extended'));
      if (alreadyProThinking) {
        console.log(`[Antigravity Page] Already in Pro Thinking mode: "${currentText}"`);
        return;
      }
    } else if (wantPro) {
      if (currentText.includes('pro') && !currentText.includes('thinking')) {
        console.log(`[Antigravity Page] Already in Pro mode: "${currentText}"`);
        return;
      }
    } else if (wantLite) {
      if (currentText.includes('lite')) {
        console.log(`[Antigravity Page] Already in Flash-Lite mode: "${currentText}"`);
        return;
      }
    } else if (wantFlashStandard) {
      if (currentText.includes('flash') && !currentText.includes('thinking') && !currentText.includes('extended') && !currentText.includes('lite') && !currentText.includes('pro')) {
        console.log(`[Antigravity Page] Already in standard Flash mode: "${currentText}"`);
        return;
      }
    }

    // Open model menu
    switcherBtn.click();
    await new Promise(r => setTimeout(r, 500));

    const itemSelectors = [
      'gem-menu-item',
      '[role="menuitem"]',
      '[role="option"]',
      '.mat-mdc-menu-item',
      'mat-option'
    ];

    const menuItems = Array.from(document.querySelectorAll(itemSelectors.join(',')))
      .filter(it => it.offsetParent !== null || it.getBoundingClientRect().width > 0);

    if (menuItems.length === 0) {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      return;
    }

    // Log all menu items for debugging
    console.log('[Antigravity Page] Available menu items:', menuItems.map(it => (it.innerText || '').trim().slice(0, 60)));

    let targetItem = null;

    if (wantFlashThinking) {
      // Must match Flash/3.8 AND thinking/extended — explicitly exclude pro
      targetItem = menuItems.find(it => {
        const t = (it.innerText + ' ' + (it.getAttribute('aria-label') || '')).toLowerCase();
        const hasThinking = t.includes('thinking') || t.includes('extended') || t.includes('คิดที่นานขึ้น');
        const hasFlash = t.includes('flash') || t.includes('3.8');
        const isPro = t.includes('pro') || t.includes('advanced') || t.includes('เหตุผลขั้นสูง');
        return hasThinking && (hasFlash || !isPro);
      });
      // Fallback: any thinking item that is NOT pro
      if (!targetItem) {
        targetItem = menuItems.find(it => {
          const t = (it.innerText + ' ' + (it.getAttribute('aria-label') || '')).toLowerCase();
          const hasThinking = t.includes('thinking') || t.includes('extended') || t.includes('คิดที่นานขึ้น');
          const isPro = t.includes('pro') || t.includes('advanced');
          return hasThinking && !isPro;
        });
      }
    } else if (wantProThinking) {
      targetItem = menuItems.find(it => {
        const t = (it.innerText + ' ' + (it.getAttribute('aria-label') || '')).toLowerCase();
        return t.includes('pro') && (t.includes('thinking') || t.includes('extended'));
      });
    } else if (wantPro) {
      targetItem = menuItems.find(it => {
        const t = (it.innerText + ' ' + (it.getAttribute('aria-label') || '')).toLowerCase();
        return (t.includes('3.1 pro') || t.includes('pro') || t.includes('เหตุผลขั้นสูง')) && !t.includes('thinking');
      });
    } else if (wantLite) {
      targetItem = menuItems.find(it => {
        const t = (it.innerText + ' ' + (it.getAttribute('aria-label') || '')).toLowerCase();
        return t.includes('lite') || t.includes('3.5 flash-lite');
      });
    } else {
      // Standard Flash — no thinking, no lite, no pro
      targetItem = menuItems.find(it => {
        const t = (it.innerText + ' ' + (it.getAttribute('aria-label') || '')).toLowerCase();
        return (t.includes('3.8 flash') || t.includes('flash')) &&
               !t.includes('lite') && !t.includes('thinking') &&
               !t.includes('extended') && !t.includes('คิด') && !t.includes('pro');
      });
    }

    if (targetItem) {
      const chosenLabel = (targetItem.innerText || targetItem.getAttribute('aria-label') || '').trim();
      console.log(`[Antigravity Page] Switching to model: "${chosenLabel}"`);
      targetItem.click();
      await new Promise(r => setTimeout(r, 600));
    } else {
      console.warn(`[Antigravity Page] No menu item matched for: "${desired}". Items: ${menuItems.map(it => (it.innerText || '').trim().slice(0, 40)).join(' | ')}`);
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    }
  }

  // 7. Execute Job
  async function executeJob(job) {
    const jobId = job.jobId || job.job_id;
    activeJobId = jobId;

    console.log(`[Antigravity Page] Starting job ${jobId} (model=${job.model || 'default'}, canvas=${job.canvas})`);

    if (activeObserver) {
      activeObserver.disconnect();
      activeObserver = null;
    }
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }

    // 0. Ensure fresh chat if on locked thread
    try {
      await ensureFreshChatIfNeeded();
    } catch (fErr) {}

    // 0.1 Ensure Canvas mode if requested
    if (job.canvas !== false) {
      try {
        await ensureCanvasMode();
      } catch (cErr) {
        console.warn('[Antigravity Page] Canvas mode setup warning:', cErr);
      }
    }

    // 0.2 Ensure target model (Flash Thinking by default)
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
        error: 'Unable to locate Gemini prompt input box. Please verify you are on gemini.google.com/app or /canvas.'
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
        try {
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(inputEl);
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('insertText', false, job.prompt);
        } catch {}

        if (!inputEl.innerText || !inputEl.innerText.trim()) {
          const lines = (job.prompt || '').split('\n');
          inputEl.innerHTML = '';
          lines.forEach((line) => {
            const p = document.createElement('p');
            p.innerText = line;
            inputEl.appendChild(p);
          });
        }

        try {
          const q = inputEl.__quill || inputEl.closest('rich-textarea')?.__quill;
          if (q && typeof q.setText === 'function') {
            q.setText(job.prompt);
          }
        } catch {}
      } else {
        inputEl.value = job.prompt;
      }

      try {
        inputEl.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: job.prompt }));
        inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: job.prompt }));
      } catch {}
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
      // Fallback: Dispatch Enter keydown and keyup
      inputEl.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
        composed: true
      }));
      inputEl.dispatchEvent(new KeyboardEvent('keyup', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
        composed: true
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

    let lastTextChangeTime = Date.now();

    const emitDeltas = () => {
      const currentFullText = extractCleanText(targetResponseEl);
      if (currentFullText.length > emittedLength) {
        const delta = currentFullText.slice(emittedLength);
        emittedLength = currentFullText.length;
        fullText = currentFullText;
        lastTextChangeTime = Date.now();
        window.postMessage({
          type: 'AG_JOB_DELTA',
          jobId,
          delta
        }, '*');
      }
    };

    let isFinished = false;
    const finishJob = () => {
      if (isFinished) return;
      isFinished = true;
      if (activeObserver) {
        activeObserver.disconnect();
        activeObserver = null;
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      clearInterval(pollInterval);
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

      if (hasResponseFinished(targetResponseEl) && emittedLength > 0) {
        if (!idleTimer) {
          idleTimer = setTimeout(() => {
            finishJob();
          }, 400);
        }
        return;
      }

      if (!isGenerating()) {
        if (idleTimer) clearTimeout(idleTimer);
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
      emitDeltas();

      const timeSinceChange = Date.now() - lastTextChangeTime;

      // Completion Condition 1: Action buttons have appeared (definitive indicator that Gemini finished)
      if (hasResponseFinished(targetResponseEl) && emittedLength > 0 && timeSinceChange > 500) {
        clearInterval(pollInterval);
        finishJob();
        return;
      }

      // Completion Condition 2: Not generating and no new text for 2.0s
      if (emittedLength > 0 && !isGenerating() && timeSinceChange > 2000) {
        clearInterval(pollInterval);
        finishJob();
        return;
      }

      // Completion Condition 3: Absolute text stall (no change for 5s)
      if (emittedLength > 0 && timeSinceChange > 5000) {
        clearInterval(pollInterval);
        finishJob();
        return;
      }

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
    }, 400);
  }

  // Listen for execution commands from content script
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;

    if (event.data.type === 'AG_EXECUTE_JOB' && event.data.job) {
      executeJob(event.data.job);
    } else if (event.data.type === 'AG_CHECK_EMAIL') {
      const email = detectAccountEmail();
      window.postMessage({ type: 'AG_DETECTED_EMAIL', email }, '*');
    }
  });

  // Announce page script readiness and poll for email if not found immediately
  let detectedEmail = detectAccountEmail();
  if (detectedEmail) {
    window.postMessage({ type: 'AG_PAGE_READY', email: detectedEmail }, '*');
    window.postMessage({ type: 'AG_DETECTED_EMAIL', email: detectedEmail }, '*');
  } else {
    let attempts = 0;
    const emailPoller = setInterval(() => {
      attempts++;
      detectedEmail = detectAccountEmail();
      if (detectedEmail || attempts > 20) {
        clearInterval(emailPoller);
        if (detectedEmail) {
          window.postMessage({ type: 'AG_PAGE_READY', email: detectedEmail }, '*');
          window.postMessage({ type: 'AG_DETECTED_EMAIL', email: detectedEmail }, '*');
        }
      }
    }, 1000);
  }
})();
