// ==UserScript==
// @name         EngForge 2026 工程训练智慧树自动答题
// @namespace    https://mjy.js.org/nwafu-engforge-2026/
// @version      1.0.0
// @description  基于 OCS 网课助手智慧树答题逻辑精简，内置西北农林科技大学 2026 工程训练全部 11 项作业 297 题静态题库，进入智慧树新形态作业页即可自动答题（不自动交卷）。
// @author       EngForge (majianyu2007)
// @homepageURL  https://mjy.js.org/nwafu-engforge-2026/
// @supportURL   https://github.com/majianyu2007/nwafu-engforge-2026/issues
// @updateURL    https://mjy.js.org/nwafu-engforge-2026/userscript/engforge-zhs.meta.js
// @downloadURL  https://mjy.js.org/nwafu-engforge-2026/userscript/engforge-zhs.user.js
// @match        https://examloop.zhihuishu.com/exam/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      mjy.js.org
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  const BANK_URL = 'https://mjy.js.org/nwafu-engforge-2026/data/questions.json';
  const HOMEPAGE_URL = 'https://mjy.js.org/nwafu-engforge-2026/';
  const CACHE_KEY = 'engforge_2026_bank_cache_v1';
  const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- Text normalization & matching (aligned with OCS core resolvers) ----------

  function normalizeText(str) {
    return String(str || '')
      .replace(/https?:\/\/\S+/gi, '')
      .replace(/\[图片\d+\]/g, '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, '');
  }

  function stripLeadingNumber(normStr) {
    return normStr.replace(/^\d+/, '');
  }

  function removeOptionPrefix(str) {
    return String(str || '')
      .trim()
      .replace(/^[A-Z][\s.、)）:：]+/, '')
      .replace(/^[A-Z](?=[\u4e00-\u9fff])/, '')
      .trim();
  }

  function bigrams(str) {
    const map = new Map();
    for (let i = 0; i < str.length - 1; i++) {
      const g = str.slice(i, i + 2);
      map.set(g, (map.get(g) || 0) + 1);
    }
    return map;
  }

  function diceSimilarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const am = bigrams(a);
    const bm = bigrams(b);
    let hits = 0;
    for (const [g, count] of am) {
      const bc = bm.get(g);
      if (bc) hits += count < bc ? count : bc;
    }
    return (2 * hits) / (a.length + b.length - 2);
  }

  function extractElementText(root) {
    if (!root) return '';
    const parts = [];
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push(node.textContent || '');
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node;
      if (el.tagName === 'IMG') {
        if (el.src) parts.push(` ${el.src} `);
        return;
      }
      if (el.tagName === 'BR') {
        parts.push('\n');
        return;
      }
      try {
        if (el.isConnected && getComputedStyle(el).display === 'none') return;
      } catch {
        // ignore
      }
      for (const child of el.childNodes) walk(child);
    };
    walk(root);
    return parts.join('').replace(/\s+/g, ' ').trim();
  }

  const CORRECT_WORDS = new Set([
    '是', '对', '正确', '确定', '√', '对的', '是的', '正确的', 'true', 't', 'yes', '1'
  ]);
  const INCORRECT_WORDS = new Set([
    '非', '否', '错', '错误', '×', 'x', '错的', '不对', '不正确的', '不正确', '不是', '不是的', 'false', 'f', 'no', '0'
  ]);

  function judgePolarity(text) {
    const cleaned = removeOptionPrefix(text)
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}√×]/gu, '');
    if (CORRECT_WORDS.has(cleaned)) return 'true';
    if (INCORRECT_WORDS.has(cleaned)) return 'false';
    return null;
  }

  // ---------- Question Bank Loader ----------

  let indexedBank = [];
  let bankMeta = null;

  function buildIndex(bankData) {
    bankMeta = bankData.meta || null;
    indexedBank = (bankData.questions || []).map((q) => {
      const norm = normalizeText(q.title);
      return {
        ...q,
        _norm: norm,
        _normNoNum: stripLeadingNumber(norm)
      };
    });
    return indexedBank;
  }

  function requestJson(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          timeout: 15000,
          onload: (res) => {
            if (res.status >= 200 && res.status < 300) {
              try {
                resolve(JSON.parse(res.responseText));
              } catch (err) {
                reject(err);
              }
            } else {
              reject(new Error(`HTTP ${res.status}`));
            }
          },
          onerror: () => reject(new Error('网络请求失败')),
          ontimeout: () => reject(new Error('题库加载超时'))
        });
      } else {
        fetch(url)
          .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
          })
          .then(resolve, reject);
      }
    });
  }

  async function loadBank(forceRefresh = false) {
    if (!forceRefresh && typeof GM_getValue === 'function') {
      try {
        const cached = GM_getValue(CACHE_KEY, null);
        if (cached && cached.data && Date.now() - cached.ts < CACHE_TTL_MS) {
          buildIndex(cached.data);
          return { source: 'cache', count: indexedBank.length, meta: bankMeta };
        }
      } catch {
        // ignore cache read error
      }
    }

    const url = forceRefresh ? `${BANK_URL}?t=${Date.now()}` : BANK_URL;
    const data = await requestJson(url);
    buildIndex(data);
    if (typeof GM_setValue === 'function') {
      try {
        GM_setValue(CACHE_KEY, { ts: Date.now(), data });
      } catch {
        // ignore cache write error
      }
    }
    return { source: 'remote', count: indexedBank.length, meta: bankMeta };
  }

  function findQuestion(rawTitle) {
    const q = normalizeText(rawTitle);
    if (!q) return null;

    // 1. Exact normalized title match
    for (const item of indexedBank) {
      if (item._norm === q) return { item, score: 1.0, strategy: 'exact' };
    }

    // 2. Match ignoring leading question number prefix
    const qNoNum = stripLeadingNumber(q);
    if (qNoNum.length >= 6) {
      for (const item of indexedBank) {
        if (item._normNoNum === qNoNum) return { item, score: 0.99, strategy: 'no-prefix' };
      }
    }

    // 3. Substring containment or Dice bigram similarity
    let best = null;
    let bestScore = 0;
    for (const item of indexedBank) {
      const k = item._norm;
      if (q.length >= 8 && (k.includes(q) || q.includes(k))) {
        const ratio = Math.min(q.length, k.length) / Math.max(q.length, k.length);
        if (ratio > bestScore) {
          bestScore = ratio;
          best = item;
        }
        continue;
      }
      const sc = diceSimilarity(q, k);
      if (sc > bestScore) {
        bestScore = sc;
        best = item;
      }
    }

    if (best && bestScore >= 0.65) {
      return { item: best, score: bestScore, strategy: 'fuzzy' };
    }
    return null;
  }

  // ---------- Zhihuishu examloop DOM adapter (stripped from OCS zhs.ts smartExam) ----------

  const nativeInputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;

  function isReviewMode() {
    if (document.querySelector('[mode="REVIEW_MODE"]')) return true;
    // ExamPage.js URL pattern: /exam/{examTestId}/{courseId}/{mode}/{examPaperId} where 1=EDIT, 2=REVIEW
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts[0] === 'exam' && parts[3] === '2') return true;
    const area = document.querySelector('.question-area-content');
    if (area) {
      const inputs = Array.from(area.querySelectorAll('input'));
      if (inputs.length > 0 && inputs.every((inp) => inp.disabled)) return true;
      const labels = Array.from(area.querySelectorAll('label.user-select.group'));
      if (labels.length > 0 && labels.every((lb) => lb.classList.contains('cursor-default'))) return true;
    }
    return false;
  }

  function detectQuestionDom() {
    const root = document.querySelector('.question-area-content');
    if (!root) return null;

    const typeEl = root.querySelector('div.flex.items-center.mb-\\[16px\\]');
    const titleEl = root.querySelector('div.flex-1 .mb-\\[32px\\] .text-mainText.font-medium');
    const optionEls = Array.from(root.querySelectorAll('label.user-select.group, div.real-editor'));

    const typeText = (typeEl?.textContent || '').trim();
    const titleText = extractElementText(titleEl);

    let type = null;
    if (typeText.includes('单选')) type = 'single';
    else if (typeText.includes('多选')) type = 'multiple';
    else if (typeText.includes('判断')) type = 'judgement';
    else if (typeText.includes('填空') || typeText.includes('问答')) type = 'completion';

    const sortMatch = typeText.match(/^(\d+)[、.．]/);
    const sortNum = sortMatch ? Number(sortMatch[1]) : null;

    return { root, typeEl, titleEl, optionEls, type, typeText, titleText, sortNum };
  }

  function getOptionText(optionEl) {
    // QuestionSingleChoice / MultipleChoice / Judge render letter badge in div.notranslate and content in span
    const span = optionEl.querySelector(':scope > span');
    if (span) return extractElementText(span);
    return removeOptionPrefix(extractElementText(optionEl));
  }

  function isOptionSelected(optionEl) {
    return optionEl.querySelector('div.bg-mainBg') !== null;
  }

  function matchChoiceOptionIndices(answers, optionEls) {
    const optTexts = optionEls.map(getOptionText);
    const normOpts = optTexts.map((t) => normalizeText(removeOptionPrefix(t)));
    const normAns = answers.map((a) => normalizeText(removeOptionPrefix(a))).filter(Boolean);

    const matched = new Set();

    for (const ans of normAns) {
      // Exact normalized match
      let idx = normOpts.findIndex((o) => o && o === ans);
      if (idx !== -1) {
        matched.add(idx);
        continue;
      }
      // Best Dice similarity (> 0.6)
      let bestIdx = -1;
      let bestScore = 0;
      for (let i = 0; i < normOpts.length; i++) {
        if (!normOpts[i]) continue;
        const sc = diceSimilarity(ans, normOpts[i]);
        if (sc > bestScore) {
          bestScore = sc;
          bestIdx = i;
        }
      }
      if (bestIdx !== -1 && bestScore > 0.6) {
        matched.add(bestIdx);
      }
    }

    return Array.from(matched);
  }

  function setInputValue(input, value) {
    if (nativeInputSetter) {
      nativeInputSetter.call(input, value);
    } else {
      input.value = value;
    }
    try {
      Reflect.set(input, 'composition', true);
    } catch {
      // ignore
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function answerCurrentQuestion() {
    const dom = detectQuestionDom();
    if (!dom || !dom.titleText) {
      return { ok: false, reason: '未检测到当前题目', title: '' };
    }

    const match = findQuestion(dom.titleText);
    if (!match) {
      return { ok: false, reason: '题库未命中', title: dom.titleText, sortNum: dom.sortNum };
    }

    const { item } = match;
    const answers = item.answers || [];
    const qType = dom.type || item.type;

    if (qType === 'judgement') {
      const targetPol = judgePolarity(answers[0] || '');
      let targetEl = null;
      for (const opt of dom.optionEls) {
        if (judgePolarity(getOptionText(opt)) === targetPol) {
          targetEl = opt;
          break;
        }
      }
      if (!targetEl) {
        return { ok: false, reason: '未匹配到判断选项', title: dom.titleText, sortNum: dom.sortNum };
      }
      if (!isOptionSelected(targetEl)) {
        targetEl.click();
        await sleep(180);
      }
      return { ok: true, answerText: answers.join(' / '), title: dom.titleText, sortNum: dom.sortNum, module: item.module };
    }

    if (qType === 'single') {
      const indices = matchChoiceOptionIndices(answers, dom.optionEls);
      if (indices.length === 0) {
        return { ok: false, reason: '未匹配到单选选项', title: dom.titleText, sortNum: dom.sortNum };
      }
      const targetEl = dom.optionEls[indices[0]];
      if (!isOptionSelected(targetEl)) {
        targetEl.click();
        await sleep(180);
      }
      return { ok: true, answerText: answers[0], title: dom.titleText, sortNum: dom.sortNum, module: item.module };
    }

    if (qType === 'multiple') {
      const indices = matchChoiceOptionIndices(answers, dom.optionEls);
      if (indices.length === 0) {
        return { ok: false, reason: '未匹配到多选选项', title: dom.titleText, sortNum: dom.sortNum };
      }
      const targetSet = new Set(indices);
      for (let i = 0; i < dom.optionEls.length; i++) {
        const opt = dom.optionEls[i];
        const selected = isOptionSelected(opt);
        if (targetSet.has(i) && !selected) {
          opt.click();
          await sleep(160);
        } else if (!targetSet.has(i) && selected) {
          opt.click();
          await sleep(160);
        }
      }
      return { ok: true, answerText: answers.join('；'), title: dom.titleText, sortNum: dom.sortNum, module: item.module };
    }

    if (qType === 'completion') {
      const blankEls = dom.optionEls;
      if (blankEls.length === 0) {
        return { ok: false, reason: '未找到填空输入框', title: dom.titleText, sortNum: dom.sortNum };
      }
      const fillList = blankEls.length === 1 && answers.length > 1 ? [answers.join(' ')] : answers;
      if (fillList.length !== blankEls.length) {
        return {
          ok: false,
          reason: `填空数量不匹配（页面 ${blankEls.length} 空，题库 ${fillList.length} 空）`,
          title: dom.titleText,
          sortNum: dom.sortNum
        };
      }
      for (let i = 0; i < blankEls.length; i++) {
        const el = blankEls[i];
        const val = String(fillList[i] ?? '');
        if (el.classList.contains('real-editor') && el.ckeditorInstance) {
          el.ckeditorInstance.data.set(val);
        } else {
          const input = el.querySelector('input, textarea');
          if (input) {
            if (input.disabled) {
              return { ok: false, reason: '输入框为只读状态', title: dom.titleText, sortNum: dom.sortNum };
            }
            setInputValue(input, val);
          }
        }
        await sleep(100);
      }
      return { ok: true, answerText: fillList.join(' | '), title: dom.titleText, sortNum: dom.sortNum, module: item.module };
    }

    return { ok: false, reason: `暂不支持的题型：${dom.typeText}`, title: dom.titleText, sortNum: dom.sortNum };
  }

  function getAnswerSheetButtons() {
    return Array.from(document.querySelectorAll('div.grid button')).filter((b) =>
      /^\d+$/.test((b.innerText || '').trim())
    );
  }

  function getNextButton() {
    return Array.from(document.querySelectorAll('button')).find((b) =>
      (b.textContent || '').trim().includes('下一题')
    );
  }

  async function waitForQuestionChange(prevSignature, timeoutMs = 4500) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const dom = detectQuestionDom();
      const sig = dom ? `${dom.sortNum}|${dom.titleText}` : '';
      if (dom && dom.titleText && sig !== prevSignature) {
        await sleep(180);
        return true;
      }
      await sleep(120);
    }
    return false;
  }

  async function waitForPageReady(timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (document.querySelector('.question-area-content')) return true;
      await sleep(250);
    }
    return false;
  }

  // ---------- Minimal Apple-style Floating HUD ----------

  function mountHud() {
    if (document.getElementById('engforge-hud')) return;

    const style = document.createElement('style');
    style.textContent = `
      #engforge-hud {
        position: fixed;
        top: 72px;
        right: 24px;
        width: 320px;
        z-index: 999999;
        font-family: "SF Pro Text", -apple-system, BlinkMacSystemFont, "PingFang SC", system-ui, sans-serif;
        color: #1d1d1f;
        background: rgba(255, 255, 255, 0.92);
        -webkit-backdrop-filter: saturate(180%) blur(20px);
        backdrop-filter: saturate(180%) blur(20px);
        border: 1px solid rgba(0, 0, 0, 0.08);
        border-radius: 18px;
        overflow: hidden;
        user-select: none;
      }
      #engforge-hud.ef-collapsed {
        width: auto;
        border-radius: 9999px;
      }
      #engforge-hud.ef-collapsed .ef-body { display: none; }
      #engforge-hud .ef-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        background: rgba(245, 245, 247, 0.85);
        border-bottom: 1px solid rgba(0, 0, 0, 0.06);
        cursor: move;
      }
      #engforge-hud.ef-collapsed .ef-header { border-bottom: none; padding: 10px 16px; gap: 10px; }
      #engforge-hud .ef-title {
        font-size: 14px;
        font-weight: 600;
        letter-spacing: -0.224px;
        color: #1d1d1f;
      }
      #engforge-hud .ef-badge {
        font-size: 12px;
        color: #7a7a7a;
        margin-left: 6px;
        font-weight: 400;
      }
      #engforge-hud .ef-toggle {
        background: #fafafc;
        border: 1px solid #e0e0e0;
        border-radius: 9999px;
        color: #333333;
        font-size: 12px;
        padding: 3px 10px;
        cursor: pointer;
        transition: transform 0.12s ease;
      }
      #engforge-hud .ef-toggle:active { transform: scale(0.95); }
      #engforge-hud .ef-body { padding: 16px; }
      #engforge-hud .ef-status {
        font-size: 14px;
        line-height: 1.43;
        letter-spacing: -0.224px;
        color: #1d1d1f;
        margin-bottom: 12px;
      }
      #engforge-hud .ef-meta {
        font-size: 12px;
        color: #7a7a7a;
        margin-bottom: 12px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      #engforge-hud .ef-progress-track {
        height: 4px;
        background: #f0f0f0;
        border-radius: 9999px;
        overflow: hidden;
        margin-bottom: 14px;
      }
      #engforge-hud .ef-progress-bar {
        height: 100%;
        width: 0%;
        background: #0066cc;
        transition: width 0.25s ease;
      }
      #engforge-hud .ef-actions {
        display: flex;
        gap: 8px;
        margin-bottom: 10px;
      }
      #engforge-hud .ef-btn-primary {
        flex: 1;
        background: #0066cc;
        color: #ffffff;
        border: none;
        border-radius: 9999px;
        padding: 9px 16px;
        font-size: 14px;
        font-weight: 400;
        letter-spacing: -0.224px;
        cursor: pointer;
        transition: transform 0.12s ease, opacity 0.15s ease;
      }
      #engforge-hud .ef-btn-primary:active { transform: scale(0.95); }
      #engforge-hud .ef-btn-primary:disabled { opacity: 0.45; cursor: not-allowed; }
      #engforge-hud .ef-btn-secondary {
        background: #ffffff;
        color: #0066cc;
        border: 1px solid #0066cc;
        border-radius: 9999px;
        padding: 9px 14px;
        font-size: 14px;
        letter-spacing: -0.224px;
        cursor: pointer;
        transition: transform 0.12s ease;
      }
      #engforge-hud .ef-btn-secondary:active { transform: scale(0.95); }
      #engforge-hud .ef-btn-secondary:disabled { opacity: 0.45; cursor: not-allowed; }
      #engforge-hud .ef-speed {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 12px;
        color: #7a7a7a;
        margin-bottom: 10px;
      }
      #engforge-hud .ef-speed select {
        font-size: 12px;
        color: #1d1d1f;
        background: #f5f5f7;
        border: 1px solid #e0e0e0;
        border-radius: 8px;
        padding: 3px 8px;
      }
      #engforge-hud .ef-log {
        max-height: 180px;
        overflow-y: auto;
        background: #f5f5f7;
        border-radius: 11px;
        padding: 8px 10px;
        font-size: 12px;
        line-height: 1.5;
        color: #333333;
      }
      #engforge-hud .ef-log-item {
        padding: 4px 0;
        border-bottom: 1px solid rgba(0, 0, 0, 0.05);
        word-break: break-word;
      }
      #engforge-hud .ef-log-item:last-child { border-bottom: none; }
      #engforge-hud .ef-log-ok { color: #1d1d1f; }
      #engforge-hud .ef-log-fail { color: #7a7a7a; }
      #engforge-hud .ef-foot {
        margin-top: 10px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 12px;
        color: #7a7a7a;
      }
      #engforge-hud .ef-link {
        color: #0066cc;
        text-decoration: none;
        cursor: pointer;
      }
      #engforge-hud .ef-link:hover { text-decoration: underline; }
    `;
    document.head.appendChild(style);

    const hud = document.createElement('div');
    hud.id = 'engforge-hud';
    hud.innerHTML = `
      <div class="ef-header" id="ef-drag-handle">
        <div>
          <span class="ef-title">EngForge</span>
          <span class="ef-badge" id="ef-bank-badge">加载题库中…</span>
        </div>
        <button class="ef-toggle" id="ef-collapse-btn" type="button">收起</button>
      </div>
      <div class="ef-body">
        <div class="ef-status" id="ef-status">正在初始化静态题库…</div>
        <div class="ef-meta">
          <span id="ef-progress-text">进度 0 / 0</span>
          <span id="ef-hit-text">命中 0</span>
        </div>
        <div class="ef-progress-track"><div class="ef-progress-bar" id="ef-progress-bar"></div></div>
        <div class="ef-actions">
          <button class="ef-btn-primary" id="ef-start-btn" type="button" disabled>开始自动答题</button>
          <button class="ef-btn-secondary" id="ef-one-btn" type="button" disabled>答当前题</button>
        </div>
        <div class="ef-speed">
          <span>切题间隔（不自动交卷）</span>
          <select id="ef-delay-select">
            <option value="600">0.6 秒（快速）</option>
            <option value="1200" selected>1.2 秒（推荐）</option>
            <option value="2200">2.2 秒（稳妥）</option>
          </select>
        </div>
        <div class="ef-log" id="ef-log">
          <div class="ef-log-item">等待操作…</div>
        </div>
        <div class="ef-foot">
          <a class="ef-link" id="ef-refresh-btn">刷新题库</a>
          <a class="ef-link" href="${HOMEPAGE_URL}" target="_blank" rel="noopener">题库主页 ↗</a>
        </div>
      </div>
    `;
    document.body.appendChild(hud);

    // Drag support
    const handle = hud.querySelector('#ef-drag-handle');
    let dragging = false;
    let dx = 0;
    let dy = 0;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true;
      const rect = hud.getBoundingClientRect();
      dx = e.clientX - rect.left;
      dy = e.clientY - rect.top;
      hud.style.right = 'auto';
      hud.style.left = `${rect.left}px`;
      hud.style.top = `${rect.top}px`;
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const x = Math.max(8, Math.min(window.innerWidth - 120, e.clientX - dx));
      const y = Math.max(8, Math.min(window.innerHeight - 60, e.clientY - dy));
      hud.style.left = `${x}px`;
      hud.style.top = `${y}px`;
    });
    window.addEventListener('mouseup', () => {
      dragging = false;
    });

    const collapseBtn = hud.querySelector('#ef-collapse-btn');
    collapseBtn.addEventListener('click', () => {
      const collapsed = hud.classList.toggle('ef-collapsed');
      collapseBtn.textContent = collapsed ? '展开' : '收起';
    });

    return {
      hud,
      badge: hud.querySelector('#ef-bank-badge'),
      status: hud.querySelector('#ef-status'),
      progressText: hud.querySelector('#ef-progress-text'),
      hitText: hud.querySelector('#ef-hit-text'),
      progressBar: hud.querySelector('#ef-progress-bar'),
      startBtn: hud.querySelector('#ef-start-btn'),
      oneBtn: hud.querySelector('#ef-one-btn'),
      delaySelect: hud.querySelector('#ef-delay-select'),
      logBox: hud.querySelector('#ef-log'),
      refreshBtn: hud.querySelector('#ef-refresh-btn')
    };
  }

  // ---------- Main Controller ----------

  async function init() {
    const ready = await waitForPageReady();
    if (!ready) return;

    const ui = mountHud();
    if (!ui) return;

    let running = false;
    let stopRequested = false;

    const appendLog = (text, ok = true) => {
      if (ui.logBox.children.length === 1 && ui.logBox.textContent.includes('等待操作')) {
        ui.logBox.innerHTML = '';
      }
      const div = document.createElement('div');
      div.className = `ef-log-item ${ok ? 'ef-log-ok' : 'ef-log-fail'}`;
      div.textContent = text;
      ui.logBox.prepend(div);
    };

    const setBankReady = async (force = false) => {
      ui.badge.textContent = '同步中…';
      ui.startBtn.disabled = true;
      ui.oneBtn.disabled = true;
      try {
        const res = await loadBank(force);
        ui.badge.textContent = `${res.count} 题就绪`;
        if (isReviewMode()) {
          ui.status.textContent = '当前为解析预览模式（只读），无需作答。';
          ui.startBtn.disabled = true;
          ui.oneBtn.disabled = true;
        } else {
          ui.status.textContent = `题库已就绪（共 ${res.count} 题），点击下方按钮开始自动答题。`;
          ui.startBtn.disabled = false;
          ui.oneBtn.disabled = false;
        }
      } catch (err) {
        ui.badge.textContent = '加载失败';
        ui.status.textContent = `题库加载失败：${err.message || err}，请点击「刷新题库」重试。`;
      }
    };

    ui.refreshBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (!running) setBankReady(true);
    });

    ui.oneBtn.addEventListener('click', async () => {
      if (running || isReviewMode()) return;
      ui.oneBtn.disabled = true;
      const res = await answerCurrentQuestion();
      const idxLabel = res.sortNum ? `第 ${res.sortNum} 题` : '当前题';
      if (res.ok) {
        ui.status.textContent = `${idxLabel}已作答（${res.module || '题库命中'}）`;
        appendLog(`✓ ${idxLabel}：${String(res.answerText || '').slice(0, 42)}`, true);
      } else {
        ui.status.textContent = `${idxLabel}未完成：${res.reason}`;
        appendLog(`✕ ${idxLabel}：${res.reason}`, false);
      }
      ui.oneBtn.disabled = false;
    });

    ui.startBtn.addEventListener('click', async () => {
      if (isReviewMode()) {
        ui.status.textContent = '当前为解析预览模式（只读），无法作答。';
        return;
      }

      if (running) {
        stopRequested = true;
        ui.startBtn.disabled = true;
        ui.status.textContent = '正在停止…';
        return;
      }

      running = true;
      stopRequested = false;
      ui.startBtn.textContent = '暂停答题';
      ui.oneBtn.disabled = true;
      ui.logBox.innerHTML = '';

      const delayMs = Number(ui.delaySelect.value) || 1200;
      const sheetBtns = getAnswerSheetButtons();
      const total = sheetBtns.length;
      let done = 0;
      let hits = 0;

      const updateProgress = () => {
        const denom = total || done || 1;
        ui.progressText.textContent = `进度 ${done} / ${total || '?'}`;
        ui.hitText.textContent = `命中 ${hits}`;
        ui.progressBar.style.width = `${Math.min(100, Math.round((done / denom) * 100))}%`;
      };

      try {
        if (sheetBtns.length > 0) {
          for (let i = 0; i < sheetBtns.length; i++) {
            if (stopRequested) break;

            const currentButtons = getAnswerSheetButtons();
            const btn = currentButtons[i];
            if (btn) {
              const curDom = detectQuestionDom();
              const targetSort = Number((btn.innerText || '').trim());
              if (!curDom || curDom.sortNum !== targetSort) {
                const prevSig = curDom ? `${curDom.sortNum}|${curDom.titleText}` : '';
                btn.click();
                await waitForQuestionChange(prevSig);
              }
            }

            if (stopRequested) break;

            const res = await answerCurrentQuestion();
            done++;
            if (res.ok) {
              hits++;
              appendLog(`✓ 第 ${i + 1} 题：${String(res.answerText || '').slice(0, 42)}`, true);
            } else {
              appendLog(`✕ 第 ${i + 1} 题：${res.reason}`, false);
            }
            updateProgress();
            ui.status.textContent = `正在自动作答：第 ${done} / ${total} 题…`;

            if (i < sheetBtns.length - 1 && !stopRequested) {
              await sleep(delayMs);
            }
          }
        } else {
          // Fallback loop using 下一题 button if answer sheet is collapsed
          let step = 0;
          while (!stopRequested && step < 200) {
            step++;
            const curDom = detectQuestionDom();
            const prevSig = curDom ? `${curDom.sortNum}|${curDom.titleText}` : '';
            const res = await answerCurrentQuestion();
            done++;
            if (res.ok) {
              hits++;
              appendLog(`✓ 第 ${done} 题：${String(res.answerText || '').slice(0, 42)}`, true);
            } else {
              appendLog(`✕ 第 ${done} 题：${res.reason}`, false);
            }
            updateProgress();

            const nextBtn = getNextButton();
            if (!nextBtn || nextBtn.disabled) break;
            await sleep(delayMs);
            if (stopRequested) break;
            nextBtn.click();
            const changed = await waitForQuestionChange(prevSig);
            if (!changed) break;
          }
        }

        if (stopRequested) {
          ui.status.textContent = `已暂停（已完成 ${done} 题，命中 ${hits} 题）。`;
        } else {
          ui.status.textContent = `全部完成：共处理 ${done} 题，命中 ${hits} 题。请核对后手动提交。`;
        }
      } catch (err) {
        ui.status.textContent = `运行出错：${err.message || err}`;
        appendLog(`✕ 异常：${err.message || err}`, false);
      } finally {
        running = false;
        stopRequested = false;
        ui.startBtn.textContent = '重新自动答题';
        ui.startBtn.disabled = false;
        ui.oneBtn.disabled = false;
      }
    });

    await setBankReady(false);
  }

  init();
})();
