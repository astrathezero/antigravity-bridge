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
  let activePollInterval = null;
  // Monotonic job counter. Every timer and callback belonging to a job checks its token
  // against this, so a job that has been superseded stops touching shared state instead of
  // racing the new one and reporting the wrong tab content under its own job id.
  let jobSequence = 0;

  // Tear down every timer/observer owned by the previous job. The poll interval used to be a
  // closure-local const that nothing outside the job could reach, so a superseded job kept
  // polling for the full timeout and read the *next* job's response element.
  function cleanupActiveJob() {
    if (activeObserver) {
      try { activeObserver.disconnect(); } catch {}
      activeObserver = null;
    }
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (activePollInterval) {
      clearInterval(activePollInterval);
      activePollInterval = null;
    }
  }

  // 1. Detect Logged-in Google Account Email
  function isValidUserEmail(candidate) {
    if (!candidate) return false;
    const c = candidate.toLowerCase().trim();
    if (c === 'googlers@google.com' || c === 'user@example.com') return false;
    return true;
  }

  function detectAccountEmail() {
    const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/;

    const selectors = [
      'a[aria-label*="บัญชี Google"]',
      'a[aria-label*="Google Account"]',
      'button[aria-label*="บัญชี Google"]',
      'button[aria-label*="Google Account"]',
      'a[href*="SignOutOptions"]',
      'a[aria-label*="@"]',
      'button[aria-label*="@"]',
      'img[alt*="@"]',
      'a[href*="accounts.google.com"]',
      '[data-profile-email]',
      '[data-user-email]',
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
          if (match && match[1] && isValidUserEmail(match[1])) {
            return match[1].toLowerCase();
          }
        }
      } catch {}
    }

    const metaUser = document.querySelector('meta[name="user-email"]');
    if (metaUser && metaUser.content) {
      const match = metaUser.content.match(emailRegex);
      if (match && match[1] && isValidUserEmail(match[1])) return match[1].toLowerCase();
    }

    try {
      const header = document.querySelector('header, [role="banner"], .gb_rd, .gb_d');
      if (header) {
        const match = (header.innerHTML || '').match(emailRegex);
        if (match && match[1] && isValidUserEmail(match[1])) return match[1].toLowerCase();
      }
    } catch {}

    return '';
  }

  // Initial and periodic account email announcement every 3 seconds
  const announceEmail = () => {
    const email = detectAccountEmail();
    if (email) {
      window.postMessage({ type: 'AG_DETECTED_EMAIL', email }, '*');
    }
  };
  setTimeout(announceEmail, 500);
  setTimeout(announceEmail, 2000);
  setInterval(announceEmail, 3000);

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
    return allButtons.find(btn => isElementVisible(btn) && isLikelySendButton(btn)) || null;
  }

  // 4. Check if Gemini is actively generating a response (Stop button present)
  //
  // Detection is best-effort — Google renames these labels and classes regularly. A `true`
  // result is trustworthy (we found a real Stop button), but a `false` result is ambiguous:
  // it means either "finished" or "we cannot see the button any more". Callers that treat
  // `false` as "finished" MUST also check isGeneratingDetectionReliable(), otherwise a single
  // renamed label makes every response finish instantly and come back empty or truncated.
  const STOP_BUTTON_SELECTORS = [
    'button.stop-button',
    'button.stop',
    'button[aria-label*="Stop response" i]',
    'button[aria-label*="Stop generating" i]',
    'button[aria-label="Stop" i]',
    'button[aria-label*="หยุดการตอบกลับ" i]',
    'button[aria-label*="หยุดการสร้าง" i]',
    'button[aria-label*="หยุดสร้าง" i]',
    'button[aria-label="หยุด" i]',
    'button[data-test-id*="stop" i]',
    'button[data-testid*="stop" i]',
    'button:has(mat-icon[fonticon="stop"])',
    'button:has([data-mat-icon-name="stop"])',
    'button:has(mat-icon[fonticon="pause"])',
    'button:has([data-mat-icon-name="pause"])'
  ];

  const STOP_TOKENS = ['stop', 'หยุด', '停止', '중지', 'arrêter', 'detener', 'parar', 'anhalten'];

  let stopButtonEverSeen = false;
  let stopDetectionWarned = false;

  function isElementVisible(el) {
    if (!el) return false;
    try {
      return el.offsetParent !== null || el.getBoundingClientRect().width > 0;
    } catch {
      return false;
    }
  }

  function isLikelyStopButton(button) {
    const ariaLabel = (button.getAttribute('aria-label') || '').toLowerCase();
    const testId = (
      button.getAttribute('data-test-id') ||
      button.getAttribute('data-testid') ||
      ''
    ).toLowerCase();
    const icon = button.querySelector('mat-icon, [data-mat-icon-name], [fonticon]');
    const iconName = (
      icon?.getAttribute('fonticon') ||
      icon?.getAttribute('data-mat-icon-name') ||
      icon?.textContent ||
      ''
    ).toLowerCase();

    return STOP_TOKENS.some((token) =>
      ariaLabel.includes(token) ||
      testId.includes(token) ||
      iconName.includes(token)
    );
  }

  function findStopButton() {
    const searchRoots = [
      document.querySelector('input-container, .input-area, form.chat-input, .send-button-container'),
      document.querySelector('chat-window, main, .chat-history, infinite-scroller'),
      document.body
    ].filter(Boolean);

    for (const root of searchRoots) {
      for (const sel of STOP_BUTTON_SELECTORS) {
        try {
          const btn = root.querySelector(sel);
          if (isElementVisible(btn)) return btn;
        } catch {}
      }
    }

    // Fallback: token scan, scoped to the composer so unrelated buttons elsewhere in the page
    // cannot false-positive. Biased towards reporting "generating" — a false positive only
    // delays completion to the stall timeout, while a false negative truncates the answer.
    const composer = document.querySelector('input-container, .input-area, form.chat-input, .send-button-container');
    if (composer) {
      try {
        const btn = Array.from(composer.querySelectorAll('button'))
          .find(b => isElementVisible(b) && isLikelyStopButton(b));
        if (btn) return btn;
      } catch {}
    }

    return null;
  }

  function isGenerating() {
    const btn = findStopButton();
    if (btn) {
      stopButtonEverSeen = true;
      return true;
    }
    return false;
  }

  // True once a Stop button has actually been observed in this page session. Until then a
  // `false` from isGenerating() carries no information and must not be used to end a job.
  function isGeneratingDetectionReliable() {
    return stopButtonEverSeen;
  }

  function warnStopDetectionOnce() {
    if (stopDetectionWarned) return;
    stopDetectionWarned = true;
    console.warn(
      '[Antigravity Page] Never saw a Gemini Stop button during this job — generation-state ' +
      'detection is unreliable (Gemini DOM likely changed). Falling back to text-stall timing. ' +
      'Update STOP_BUTTON_SELECTORS in page.js if responses look truncated.'
    );
  }

  // 4.1 Check if Gemini has rendered final response action buttons (Copy / Feedback / Complete)
  function hasResponseFinished(targetEl) {
    if (!targetEl) return false;

    // Check for actual final action buttons that are rendered and visible to the user:
    // (Note: static containers like .response-container-footer and message-actions are present
    // from turn start in Angular templates and MUST NOT be treated as completion indicators)
    const copyBtn = targetEl.querySelector('button[aria-label*="Copy" i], button[aria-label*="คัดลอก" i]');
    if (copyBtn && isElementVisible(copyBtn)) return true;

    const goodBtn = targetEl.querySelector('button[aria-label*="Good response" i], button[aria-label*="คำตอบดี" i]');
    if (goodBtn && isElementVisible(goodBtn)) return true;

    const completeFooter = targetEl.querySelector('.response-footer.complete, .complete');
    if (completeFooter && isElementVisible(completeFooter)) return true;

    return false;
  }

  // Check if text is only an ephemeral thinking state indicator and lacks actual answer content
  function isOnlyThinkingSoFar(text) {
    if (!text) return true;
    const textWithoutThink = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (textWithoutThink.length === 0) return true;
    const thinkingHeadersRegex = /^(?:Interpreting the Prompt|Assessing the Prompt|Reviewing the Input|Considering the Prompt|Evaluating the Math|Formulating the Response|Thinking\.{0,3}|กำลังคิด\.{0,3})$/i;
    return thinkingHeadersRegex.test(textWithoutThink);
  }

  // Markers that identify a block as the user's own prompt rather than Gemini's answer.
  const USER_QUERY_SELECTOR = 'user-query, .user-query, .query-text, .query-text-line, [data-test-id="user-query"]';

  // A block is only a candidate answer container if it neither is nor contains a user query.
  // This filter used to be applied to `.conversation-container` alone, so whenever an earlier
  // selector matched first (`message-content` in particular, which Gemini also uses for the
  // user's own bubble) the user's prompt could be picked as the "response" element. That
  // element never mutates again, so the observer never fires and the job hangs until timeout.
  function isAssistantBlock(el) {
    if (!el) return false;
    try {
      if (el.matches(USER_QUERY_SELECTOR)) return false;
      if (el.querySelector(USER_QUERY_SELECTOR)) return false;
    } catch {}
    return true;
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
        const found = Array.from(document.querySelectorAll(sel)).filter(isAssistantBlock);
        if (found.length > 0) return found;
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
        if (container && isAssistantBlock(container) && !blocks.includes(container)) {
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
      'thinking-overlay',
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
        'thinking-overlay, .thought-content, .thoughts-container, [data-test-id*="thought"], .thinking-process, details.thought, .collapse-thought, ' +
        '.model-response-label-announcer, [class*="model-response-label"], [class*="screen-reader"], ' +
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
    mainText = mainText.replace(/(?:Gemini\s*(?:บอกว่า|says)[\s:]*)/gi, '').trim();

    // Strip ephemeral thinking state headers (e.g., "Interpreting the Prompt", "Assessing the Prompt", "Reviewing the Input")
    mainText = mainText.replace(/^(?:Interpreting the Prompt|Assessing the Prompt|Reviewing the Input|Considering the Prompt|Evaluating the Math|Formulating the Response|Thinking\.{0,3}|กำลังคิด\.{0,3})\s*/i, '').trim();

    // Strip Antigravity status footer that Gemini may append when Canvas session has prior context
    // Pattern: "\n---\n> ⚡ Antigravity Profile: ..." or similar blockquote separator footers
    mainText = mainText.replace(/\n[-—]{2,}\n(?:>\s*.*\n?)*$/m, '').trim();
    // Also strip trailing blockquote lines with profile/quota info
    mainText = mainText.replace(/(\n>[ \t]*[⚡🔋📊🟢].+)+$/g, '').trim();

    if (thoughtText && !mainText.startsWith('<think>')) {
      mainText = `<think>\n${thoughtText}\n</think>\n\n${mainText}`.trim();
    }

    // Extract Canvas Workspace Content (if open and contains document/code)
    const canvasContent = extractCanvasContent();
    if (canvasContent && canvasContent.length > 30 && !mainText.includes(canvasContent.slice(0, 40))) {
      mainText = `${mainText}\n\n${canvasContent}`;
    }

    return mainText;
  }

  // 6.3 Canvas Workspace Content Extraction
  //
  // In Canvas mode Gemini puts the substantive answer in the side panel and leaves only a
  // one-line acknowledgement in the chat bubble ("I've created the document"). If none of
  // these selectors match, the bridge silently returns that stub as the whole answer — which
  // is what produced the 11-25 character responses in the bridge log. Gemini has shipped
  // several names for this panel, so try all of them rather than one generation's markup.
  const CANVAS_PANEL_SELECTORS = [
    'canvas-workspace',
    'canvas-editor',
    'immersive-editor',
    'code-immersive-panel',
    'text-immersive-panel',
    '.immersive-editor',
    '[data-test-id*="immersive"]',
    '[data-test-id*="canvas-content"]',
    '.canvas-container',
    '.canvas-document',
    '.canvas-code',
    '.workspace-content',
    'mat-card.canvas-card',
    '.canvas-body'
  ];

  let canvasMissWarned = false;

  function extractCanvasContent() {
    try {
      const canvasPanels = document.querySelectorAll(CANVAS_PANEL_SELECTORS.join(', '));
      for (const panel of canvasPanels) {
        if (!isElementVisible(panel)) continue;
        const codeEl = panel.querySelector('code, pre, .monaco-editor, .cm-content, textarea, .code-viewer');
        if (codeEl) {
          const codeText = (codeEl.innerText || codeEl.textContent || '').trim();
          if (codeText.length > 20) return codeText;
        }
        const text = (panel.innerText || panel.textContent || '').trim();
        if (text.length > 20) return text;
      }
    } catch {}
    return '';
  }

  function commonPrefixLength(a, b) {
    const max = Math.min(a.length, b.length);
    let i = 0;
    while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    return i;
  }

  // Decide what to report as the answer once a job ends.
  //
  // `streamed` is everything we sent as deltas; `onScreen` is the final reading of the page.
  // They diverge whenever Gemini re-renders mid-answer, and neither is reliably the complete
  // one: the screen drops the thoughts panel we already streamed, while the streamed copy
  // misses text that only appeared after the re-render. The common case is exactly that —
  // thinking collapses away as the answer lands — so re-attach the thinking we streamed to
  // the answer that is actually on screen instead of discarding one of them.
  function reconcileFinalText(streamed, onScreen) {
    if (!onScreen) return streamed;
    if (!streamed) return onScreen;
    if (onScreen.startsWith(streamed)) return onScreen;

    const think = /^<think>[\s\S]*?<\/think>\n\n/.exec(streamed);
    if (think && !onScreen.startsWith('<think>')) {
      return think[0] + onScreen;
    }
    return onScreen.length >= streamed.length ? onScreen : streamed;
  }

  // Canvas is open (a panel element exists) but nothing could be read out of it — the panel
  // markup has changed. Say so once, loudly, instead of silently returning the chat stub.
  function warnCanvasMissOnce() {
    if (canvasMissWarned) return;
    canvasMissWarned = true;
    console.warn(
      '[Antigravity Page] Canvas appears to be in use but no content could be extracted from ' +
      'the Canvas panel. The answer will be truncated to whatever the chat bubble contains. ' +
      'Update CANVAS_PANEL_SELECTORS in page.js, or disable Canvas mode in the extension popup.'
    );
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
      // Wait for the previous thread to actually be torn down rather than sleeping a fixed
      // 1500ms. If the SPA is still mid-teardown when the caller snapshots the baseline, the
      // baseline captures the *old* thread's blocks and no new block can ever exceed it.
      const settleStart = Date.now();
      let stableSince = 0;
      let lastCount = -1;
      while (Date.now() - settleStart < 8000) {
        await new Promise(r => setTimeout(r, 200));
        const count = getAllResponseBlocks().length;
        if (count !== lastCount) {
          lastCount = count;
          stableSince = Date.now();
          continue;
        }
        if (count === 0) break;                          // empty thread: ready immediately
        if (Date.now() - stableSince > 1000) break;      // count settled; proceed with it
      }
      console.log(`[Antigravity Page] New chat settled after ${Date.now() - settleStart}ms (blocks=${lastCount}).`);
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
      .filter(it => isElementVisible(it));

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
    const jobToken = ++jobSequence;
    // True only while this job is still the newest one in this tab. Every timer and callback
    // below checks it, so a superseded job goes quiet instead of reporting the next job's
    // response under its own id.
    const isCurrentJob = () => jobToken === jobSequence;

    activeJobId = jobId;

    console.log(`[Antigravity Page] Starting job ${jobId} (model=${job.model || 'default'}, canvas=${job.canvas})`);

    cleanupActiveJob();

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
    // Identity snapshot, not just a count. Counting alone breaks whenever the baseline is
    // taken before the previous thread finishes tearing down: the old count stays higher than
    // anything the new thread can reach, so "a new block appeared" never becomes true.
    const baselineBlocks = getAllResponseBlocks();
    const baselineCount = baselineBlocks.length;
    const baselineSet = new WeakSet(baselineBlocks);

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
    const startTime = Date.now();
    const timeoutMs = (job.timeout || 600) * 1000;

    while (!targetResponseEl && (Date.now() - startTime < 45000)) {
      await new Promise(r => setTimeout(r, 350));
      if (!isCurrentJob()) return;

      const currentBlocks = getAllResponseBlocks();

      // Preferred signal: a block that was not present when we sent the prompt.
      const fresh = currentBlocks.filter(el => !baselineSet.has(el));
      if (fresh.length > 0) {
        targetResponseEl = fresh[fresh.length - 1];
        break;
      }

      if (isGenerating() && currentBlocks.length > 0) {
        targetResponseEl = currentBlocks[currentBlocks.length - 1];
        break;
      }
    }

    if (!targetResponseEl) {
      const currentBlocks = getAllResponseBlocks();
      if (currentBlocks.length > 0) {
        targetResponseEl = currentBlocks[currentBlocks.length - 1];
      }
    }

    // Deliberately no "observe the whole chat window" fallback here. It used to assign
    // `chat-window` / `main` as the response element, which made extractCleanText return the
    // entire conversation — every previous turn plus the user's own prompt — and
    // hasResponseFinished() was instantly true because some old turn still had a Copy button.
    // That produced a confidently wrong answer. Failing loudly is better: the bridge can fall
    // back to another profile or channel, and the error names what to fix.
    if (!targetResponseEl) {
      window.postMessage({
        type: 'AG_JOB_ERROR',
        jobId,
        error: `Timeout waiting for Gemini response container to appear. ` +
               `(url=${window.location.pathname}, baseline=${baselineCount}, ` +
               `isGenerating=${isGenerating()}, stopDetectionReliable=${isGeneratingDetectionReliable()}). ` +
               `The response container selectors in page.js are likely out of date.`
      }, '*');
      activeJobId = null;
      return;
    }

    console.log(`[Antigravity Page] Attached observer to response container for job ${jobId}`);

    let lastTextChangeTime = Date.now();
    // What we have actually streamed to the bridge. Tracking the string rather than only its
    // length is what makes the slice below correct: the old code kept an integer offset and
    // sliced whatever text was on screen at that offset, so as soon as the DOM re-rendered
    // shorter (Gemini collapses the thoughts panel when the answer lands) every later slice
    // cut into the middle of the answer and dropped a chunk.
    let emittedText = '';
    let lastExtraction = '';
    let sawAnyText = false;
    let sawRerender = false;

    const emitDeltas = () => {
      if (!isCurrentJob()) return;

      // If targetResponseEl is missing or was detached by an SPA navigation/re-render, re-acquire
      if (!targetResponseEl || !targetResponseEl.isConnected) {
        const currentBlocks = getAllResponseBlocks();
        if (currentBlocks.length > 0) {
          targetResponseEl = currentBlocks[currentBlocks.length - 1];
          if (activeObserver) {
            try { activeObserver.disconnect(); } catch {}
            activeObserver.observe(targetResponseEl, { childList: true, subtree: true, characterData: true });
          }
        }
      }

      const current = extractCleanText(targetResponseEl);

      // Any change at all counts as activity, including the text getting shorter. The old
      // code only refreshed this on growth, so a re-render froze the stall clock and the job
      // ended via the 5s stall timer holding pre-re-render text.
      if (current !== lastExtraction) {
        lastExtraction = current;
        lastTextChangeTime = Date.now();
      }

      if (!current) return;
      sawAnyText = true;

      // If emittedText contains a <think> block that has since collapsed from the on-screen DOM,
      // re-anchor current with that <think> block so the shared prefix comparison remains stable
      // and doesn't fall back to shared=0 (which would re-slice and duplicate the answer text).
      let normalizedCurrent = current;
      const thinkMatch = /^<think>[\s\S]*?<\/think>\n\n/.exec(emittedText);
      if (thinkMatch && !normalizedCurrent.startsWith('<think>')) {
        normalizedCurrent = thinkMatch[0] + normalizedCurrent;
      }

      // `emittedText` is a high-water mark, never rewound. Gemini rewrites text in place as
      // well as appending — the thoughts panel edits itself while it reasons, and markdown
      // re-renders — so the screen regularly holds *less* than we have already streamed.
      // Nothing new to say in that case; the authoritative text goes out with AG_JOB_DONE.
      if (normalizedCurrent.length <= emittedText.length) {
        if (normalizedCurrent !== emittedText) sawRerender = true;
        return;
      }

      // There is more text on screen than we have sent. Resynchronise on the common prefix
      // rather than slicing at the old offset: after an in-place edit the two strings diverge
      // partway through, and slicing at the stale offset splices a chunk out of the answer.
      const shared = commonPrefixLength(emittedText, normalizedCurrent);
      if (shared < emittedText.length) sawRerender = true;
      const delta = normalizedCurrent.slice(shared);
      emittedText = normalizedCurrent;
      window.postMessage({ type: 'AG_JOB_DELTA', jobId, delta }, '*');
    };

    let isFinished = false;
    const finishJob = () => {
      if (isFinished || !isCurrentJob()) return;
      isFinished = true;
      cleanupActiveJob();
      emitDeltas();

      const finalExtraction = extractCleanText(targetResponseEl) || '';
      const finalText = reconcileFinalText(emittedText, finalExtraction);

      if (job.canvas !== false && finalText.length > 0 && finalText.length < 80 && !extractCanvasContent()) {
        warnCanvasMissOnce();
      }

      console.log(
        `[Antigravity Page] Job ${jobId} finished. streamed=${emittedText.length} ` +
        `final=${finalExtraction.length} sent=${finalText.length} rerendered=${sawRerender}`
      );
      window.postMessage({
        type: 'AG_JOB_DONE',
        jobId,
        text: finalText,
        finishReason: 'stop'
      }, '*');
      activeJobId = null;
    };

    activeObserver = new MutationObserver(() => {
      if (!isCurrentJob()) return;
      emitDeltas();

      if (hasResponseFinished(targetResponseEl) && sawAnyText && !isOnlyThinkingSoFar(emittedText)) {
        if (!idleTimer) {
          idleTimer = setTimeout(() => {
            if (hasResponseFinished(targetResponseEl) && !isOnlyThinkingSoFar(emittedText)) {
              finishJob();
            }
          }, 800);
        }
        return;
      }

      // Two guards, both required. `sawAnyText` stops the empty response shell
      // (avatar/skeleton/action-bar placeholders, rendered before the first token) from
      // finishing the job with an empty string. isGeneratingDetectionReliable() stops a
      // renamed Stop button from reading as "finished" on the very first mutation.
      // The other three completion conditions in the poll below already carry the first
      // guard; this branch was the only one missing it.
      if (sawAnyText && isGeneratingDetectionReliable() && !isGenerating() && !isOnlyThinkingSoFar(emittedText)) {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (!isGenerating() && !isOnlyThinkingSoFar(emittedText)) {
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
      // Registered on the module so a superseding job can stop it; see cleanupActiveJob().
      if (!isCurrentJob()) { clearInterval(pollInterval); return; }
      emitDeltas();

      const timeSinceChange = Date.now() - lastTextChangeTime;

      // Completion Condition 1: Action buttons have appeared (definitive indicator that Gemini finished)
      // and we have actual answer content (not just thinking header)
      if (hasResponseFinished(targetResponseEl) && sawAnyText && !isOnlyThinkingSoFar(emittedText) && timeSinceChange > 800) {
        clearInterval(pollInterval);
        finishJob();
        return;
      }

      // Completion Condition 2: Not generating and no new text for 2.5s (only if not in pure thinking phase)
      if (sawAnyText && isGeneratingDetectionReliable() && !isGenerating() && !isOnlyThinkingSoFar(emittedText) && timeSinceChange > 2500) {
        clearInterval(pollInterval);
        finishJob();
        return;
      }
      if (sawAnyText && !isGeneratingDetectionReliable()) {
        warnStopDetectionOnce();
      }

      // Completion Condition 3: Absolute text stall.
      // If we are in the thinking phase, allow up to 45s of reasoning before considering it stalled.
      // If we already have the answer text, allow 10s (or 20s if stop button visible).
      const stallThreshold = isOnlyThinkingSoFar(emittedText) ? 45000 : (isGenerating() ? 20000 : 10000);
      if (sawAnyText && timeSinceChange > stallThreshold) {
        console.warn(`[Antigravity Page] Job ${jobId}: generation stalled (no change for ${timeSinceChange}ms, thinkingOnly=${isOnlyThinkingSoFar(emittedText)}). Finishing job.`);
        clearInterval(pollInterval);
        finishJob();
        return;
      }

      // Failure Condition: Gemini has clearly finished (action buttons rendered) but the
      // extractor never produced a single character.
      if (!sawAnyText && Date.now() - startTime > 15000) {
        // Last-chance check: see if any response block in the page has finished text
        const latestBlocks = getAllResponseBlocks();
        const latestEl = latestBlocks.length > 0 ? latestBlocks[latestBlocks.length - 1] : null;
        const lastChance = latestEl ? extractCleanText(latestEl) : '';
        if (lastChance) {
          targetResponseEl = latestEl;
          sawAnyText = true;
          clearInterval(pollInterval);
          finishJob();
          return;
        }

        if (hasResponseFinished(targetResponseEl) || (latestEl && hasResponseFinished(latestEl))) {
          clearInterval(pollInterval);
          cleanupActiveJob();
          isFinished = true;
          console.warn(`[Antigravity Page] Job ${jobId}: response appears complete but extraction returned no text.`);
          window.postMessage({
            type: 'AG_JOB_ERROR',
            jobId,
            error: `Gemini finished responding but no text could be extracted from the page ` +
                   `(url=${window.location.pathname}, canvas=${job.canvas !== false}). ` +
                   `The response DOM selectors in page.js are likely out of date.`
          }, '*');
          activeJobId = null;
          return;
        }
      }

      if (Date.now() - startTime > timeoutMs) {
        clearInterval(pollInterval);
        cleanupActiveJob();
        isFinished = true;
        window.postMessage({
          type: 'AG_JOB_ERROR',
          jobId,
          error: `Execution timed out after ${job.timeout || 600}s`
        }, '*');
        activeJobId = null;
        return;
      }
    }, 400);

    activePollInterval = pollInterval;
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
