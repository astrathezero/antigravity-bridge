// Antigravity Web Bridge - In-Page Automation & Extraction
// Injected into gemini.google.com to interact with the web interface,
// stream response tokens, and detect the logged-in Google Account.

(() => {
  'use strict';

  if (window.__ANTIGRAVITY_PAGE_LOADED__) return;
  window.__ANTIGRAVITY_PAGE_LOADED__ = true;

  console.log('[Antigravity Page] Initialized in Gemini Web context');

  let activeObserver = null;
  let activeJobId = null;
  let idleTimer = null;

  // 1. Detect Logged-in Google Account Email
  function detectAccountEmail() {
    // Strategy A: Check user account avatar buttons and links with aria-labels
    const selectors = [
      'a[aria-label*="@"]',
      'button[aria-label*="@"]',
      'img[alt*="@"]',
      '[data-profile-email]',
      '[aria-label*="Google Account"]',
      '[aria-label*="บัญชี Google"]'
    ];

    const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/;

    for (const sel of selectors) {
      const elements = document.querySelectorAll(sel);
      for (const el of elements) {
        const text = (el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('data-profile-email') || el.innerText || '');
        const match = text.match(emailRegex);
        if (match && match[1]) {
          return match[1].toLowerCase();
        }
      }
    }

    // Strategy B: Search entire document meta and raw text for email pattern
    const metaUser = document.querySelector('meta[name="user-email"]');
    if (metaUser && metaUser.content) {
      return metaUser.content.toLowerCase();
    }

    return '';
  }

  // Periodic account email detection announcement
  setInterval(() => {
    const email = detectAccountEmail();
    if (email) {
      window.postMessage({ type: 'AG_DETECTED_EMAIL', email }, '*');
    }
  }, 10000);

  // 2. Locate the prompt input element
  function findInputElement() {
    const candidates = [
      'rich-textarea .ql-editor',
      'rich-textarea div[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'div.ql-editor[contenteditable="true"]',
      'div[contenteditable="true"]',
      'textarea[aria-label*="prompt" i]',
      'rich-textarea',
      'textarea'
    ];

    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) { // must be visible
        return el;
      }
    }
    return null;
  }

  // 3. Locate the send button
  function findSendButton() {
    const sendSelectors = [
      'button[aria-label*="Send" i]',
      'button[aria-label*="ส่ง" i]',
      'button.send-button',
      'button[data-test-id="send-button"]',
      '.send-button-container button',
      'button:has(mat-icon[fonticon="send"])'
    ];

    for (const sel of sendSelectors) {
      try {
        const btn = document.querySelector(sel);
        if (btn && btn.offsetParent !== null && !btn.disabled) {
          return btn;
        }
      } catch {}
    }
    return null;
  }

  // 4. Check if Gemini is actively generating a response (Stop button present)
  function isGenerating() {
    const stopSelectors = [
      'button[aria-label*="Stop" i]',
      'button[aria-label*="หยุด" i]',
      'button.stop-button',
      'button:has(mat-icon[fonticon="stop"])',
      '[aria-label*="Stop response" i]'
    ];
    for (const sel of stopSelectors) {
      try {
        const btn = document.querySelector(sel);
        if (btn && btn.offsetParent !== null) {
          return true;
        }
      } catch {}
    }
    return false;
  }

  // 5. Get the latest response container
  function getLatestResponseElement() {
    const selectors = [
      'message-content',
      '.model-response-text',
      '[data-test-id="model-response"]',
      '.response-container-content',
      '.markdown',
      'model-response'
    ];

    for (const sel of selectors) {
      const items = document.querySelectorAll(sel);
      if (items.length > 0) {
        return items[items.length - 1];
      }
    }
    return null;
  }

  // 6. Clean and format response text (with Flash Thinking process extraction)
  function extractCleanText(el) {
    if (!el) return '';

    // Check for thinking / reasoning containers (e.g. Gemini 2.0 Flash Thinking thoughts block)
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

    let mainText = (el.innerText || el.textContent || '').trim();

    // If thoughtText is isolated, format as standard reasoning block
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

    // Selectors for model switcher dropdown in Gemini Web UI
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
          if (btn && btn.offsetParent !== null) {
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
    // If already on Flash Thinking, no need to toggle
    if (preferThinking && (currentText.includes('flash thinking') || currentText.includes('3.8 flash thinking') || currentText.includes('2.0 flash thinking') || currentText.includes('thinking'))) {
      console.log(`[Antigravity Page] Already on desired model: ${currentText}`);
      return;
    }

    // Open model menu
    switcherBtn.click();
    await new Promise(r => setTimeout(r, 450));

    // Look for options in open menu
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
          if (it && it.offsetParent !== null) {
            menuItems.push(it);
          }
        }
      } catch {}
    }

    if (menuItems.length === 0) {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      return;
    }

    // Score candidates: 3.8 Flash Thinking / Flash Thinking > 2.0 Flash Thinking > Flash > Pro
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
      await selectBestModel(job.model || 'gemini-2.0-flash-thinking');
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

    // Set input content
    inputEl.focus();
    try {
      // Clear existing content
      if (inputEl.isContentEditable) {
        inputEl.innerHTML = '';
        const p = document.createElement('p');
        p.textContent = job.prompt;
        inputEl.appendChild(p);
      } else {
        inputEl.value = job.prompt;
      }
      
      inputEl.dispatchEvent(new Event('beforeinput', { bubbles: true }));
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {
      console.warn('[Antigravity Page] Input dispatch error, fallback direct property:', e);
      inputEl.textContent = job.prompt;
    }

    await new Promise(r => setTimeout(r, 400));

    // Click send button
    const sendBtn = findSendButton();
    if (sendBtn) {
      sendBtn.click();
    } else {
      // Fallback to Enter keydown
      inputEl.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true
      }));
    }

    // Wait for generation to start and capture response
    const baselineResponseCount = document.querySelectorAll('message-content, .model-response-text').length;
    let targetResponseEl = null;
    let fullText = '';
    let emittedLength = 0;
    const startTime = Date.now();
    const timeoutMs = (job.timeout || 600) * 1000;

    // Wait until new response element is attached to DOM
    while (!targetResponseEl && (Date.now() - startTime < 30000)) {
      await new Promise(r => setTimeout(r, 300));
      const currentResponses = document.querySelectorAll('message-content, .model-response-text, model-response');
      if (currentResponses.length > baselineResponseCount) {
        targetResponseEl = currentResponses[currentResponses.length - 1];
        break;
      }
      // If stop button is visible, latest element is our target
      if (isGenerating()) {
        targetResponseEl = getLatestResponseElement();
        if (targetResponseEl) break;
      }
    }

    if (!targetResponseEl) {
      // Fallback: use getLatestResponseElement directly
      targetResponseEl = getLatestResponseElement();
    }

    if (!targetResponseEl) {
      window.postMessage({
        type: 'AG_JOB_ERROR',
        jobId,
        error: 'Timeout waiting for Gemini response container to appear.'
      }, '*');
      return;
    }

    console.log(`[Antigravity Page] Attached observer to response container for job ${jobId}`);

    const emitDeltas = () => {
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

      // Check if finished: no stop button and idle for 1200ms
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

    // Safety polling loop to catch stop button toggle or page errors
    const pollInterval = setInterval(() => {
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
        // Stop button gone and we have content
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
