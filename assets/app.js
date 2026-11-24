const TYPE_LABELS = {
  single: '单选',
  multiple: '多选',
  judgement: '判断',
  completion: '填空'
};

const PAGE_SIZE = 24;

const state = {
  bank: null,
  ocsMode: 'offline',
  ocsConfigs: {
    offline: '',
    online: ''
  },
  moduleFilter: 'all',
  typeFilter: 'all',
  query: '',
  visibleCount: PAGE_SIZE
};

const OCS_MODE_META = {
  offline: {
    filename: 'ocs-config.json',
    href: './data/ocs-config.json',
    download: 'engforge-2026-ocs-config.json',
    badge: (count, kb) => `${count} 题离线 · ${kb} KB · 0 警告`,
    note: '297 题内联本地匹配，无需联网且 0 安全警告（标准版 OCS 若提示白名单确认忽略即可）。',
    copied: '已复制完整离线版配置。'
  },
  online: {
    filename: 'ocs-config-online.json',
    href: './data/ocs-config-online.json',
    download: 'engforge-2026-ocs-config-online.json',
    badge: (_count, kb) => `在线请求本站 · ${kb} KB`,
    note: '逐题拉取本站静态 questions.json；OCS 保存时若提示 document 风险，点「仍要使用」即可。',
    copied: '已复制在线精简版配置。'
  }
};

const els = {
  mobileMenuBtn: document.getElementById('mobile-menu-btn'),
  globalNavLinks: document.getElementById('global-nav-links'),
  ocsModeSwitcher: document.getElementById('ocs-mode-switcher'),
  ocsFile: document.getElementById('ocs-artifact-file'),
  ocsMeta: document.getElementById('ocs-config-meta'),
  ocsModeNote: document.getElementById('ocs-mode-note'),
  downloadOcsLink: document.getElementById('download-ocs-link'),
  ocsTextarea: document.getElementById('ocs-config-textarea'),
  copyOcsBtn: document.getElementById('copy-ocs-btn'),
  copyFeedback: document.getElementById('copy-feedback'),
  searchInput: document.getElementById('bank-search-input'),
  moduleChips: document.getElementById('module-chips'),
  typeChips: document.getElementById('type-chips'),
  bankCountLabel: document.getElementById('bank-count-label'),
  resetFilterBtn: document.getElementById('reset-filter-btn'),
  questionList: document.getElementById('question-list'),
  loadMoreWrap: document.getElementById('load-more-wrap'),
  loadMoreBtn: document.getElementById('load-more-btn'),
  coverageTbody: document.getElementById('coverage-tbody'),
  coverageTfoot: document.getElementById('coverage-tfoot')
};

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback below
    }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  return ok;
}

function setupMobileNav() {
  if (!els.mobileMenuBtn || !els.globalNavLinks) return;
  els.mobileMenuBtn.addEventListener('click', () => {
    const open = els.globalNavLinks.classList.toggle('is-open');
    els.mobileMenuBtn.setAttribute('aria-expanded', String(open));
  });
  els.globalNavLinks.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') {
      els.globalNavLinks.classList.remove('is-open');
      els.mobileMenuBtn.setAttribute('aria-expanded', 'false');
    }
  });
}

function renderOcsConfig() {
  const mode = state.ocsMode;
  const text = state.ocsConfigs[mode];
  const cfg = OCS_MODE_META[mode];
  if (!text || !cfg) return;

  const sizeKb = (new Blob([text]).size / 1024).toFixed(1);
  const count = state.bank?.meta?.totalQuestions || 297;

  els.ocsFile.textContent = cfg.filename;
  els.ocsMeta.textContent = cfg.badge(count, sizeKb);
  els.ocsModeNote.textContent = cfg.note;
  els.downloadOcsLink.href = cfg.href;
  els.downloadOcsLink.setAttribute('download', cfg.download);
  els.ocsTextarea.value = text;
  els.copyOcsBtn.disabled = false;

  els.ocsModeSwitcher.querySelectorAll('button[data-mode]').forEach((btn) => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle('is-selected', active);
    btn.setAttribute('aria-selected', String(active));
  });
}

function renderCoverageTable(bank) {
  const { modules, meta } = bank;
  const numCell = (n) => `<td class="num${n === 0 ? ' is-zero' : ''}">${n}</td>`;
  els.coverageTbody.innerHTML = modules
    .map(
      (m) => `
      <tr>
        <td>${escapeHtml(m.name)}</td>
        <td title="examPaperType: ${escapeHtml(m.examPaperType)}">固定卷</td>
        ${numCell(m.counts.single)}
        ${numCell(m.counts.multiple)}
        ${numCell(m.counts.judgement)}
        ${numCell(m.counts.completion)}
        <td class="num">${m.questionCount}</td>
        <td class="num">${m.totalScore.toFixed(1)} 分</td>
      </tr>`
    )
    .join('');

  els.coverageTfoot.innerHTML = `
    <tr>
      <td>总计（${meta.totalModules} 项）</td>
      <td>全部固定</td>
      <td class="num">${meta.typeTotals.single}</td>
      <td class="num">${meta.typeTotals.multiple}</td>
      <td class="num">${meta.typeTotals.judgement}</td>
      <td class="num">${meta.typeTotals.completion}</td>
      <td class="num">${meta.totalQuestions}</td>
      <td class="num">${meta.totalScore.toFixed(1)} 分</td>
    </tr>`;
}

function renderModuleChips(bank) {
  const chips = [
    `<button class="filter-pill is-selected" type="button" data-module="all">全部 (${bank.meta.totalQuestions})</button>`,
    ...bank.modules.map(
      (m) =>
        `<button class="filter-pill" type="button" data-module="${escapeHtml(m.name)}">${escapeHtml(m.name)} (${m.questionCount})</button>`
    )
  ];
  els.moduleChips.innerHTML = chips.join('');
}

function getFilteredQuestions() {
  if (!state.bank) return [];
  const kw = state.query.trim().toLowerCase();
  return state.bank.questions.filter((q) => {
    if (state.moduleFilter !== 'all' && q.module !== state.moduleFilter) return false;
    if (state.typeFilter !== 'all' && q.type !== state.typeFilter) return false;
    if (!kw) return true;
    if (q.title.toLowerCase().includes(kw)) return true;
    if (q.module.toLowerCase().includes(kw)) return true;
    if (q.answers.some((a) => a.toLowerCase().includes(kw))) return true;
    if (q.options.some((o) => o.text.toLowerCase().includes(kw))) return true;
    return false;
  });
}

function renderQuestionCard(q) {
  const typeLabel = TYPE_LABELS[q.type] || q.typeName;
  const metaParts = [
    escapeHtml(q.module),
    `<span class="question-meta-accent">${escapeHtml(typeLabel)}</span>`,
    `${q.score} 分`
  ];
  if (q.cleaned) {
    metaParts.push(`<span title="${escapeHtml(q.cleaningNote || '已清洗')}">已清洗</span>`);
  }

  const imagesHtml =
    q.localImages && q.localImages.length
      ? `<div class="question-images">${q.localImages
          .map((src, i) => `<img src="./${escapeHtml(src)}" alt="题干配图 ${i + 1}" loading="lazy" />`)
          .join('')}</div>`
      : '';

  const optionsHtml =
    q.options && q.options.length
      ? `<ul class="question-options">${q.options
          .map(
            (o) => `
          <li class="question-option ${o.isCorrect ? 'is-correct' : ''}">
            <span class="option-label">${escapeHtml(o.label)}.</span>${escapeHtml(o.text)}
          </li>`
          )
          .join('')}</ul>`
      : '';

  const answerCopyStr = q.answers.join(q.type === 'completion' ? ' | ' : ' / ');
  const answerBodyHtml =
    q.type === 'completion'
      ? `<div class="question-answer-content">
           <span class="answer-prefix">答案</span>
           <div class="answer-blanks">
             ${q.answers
               .map(
                 (a, i) =>
                   `<span class="blank-pill"><span class="blank-idx">(${i + 1})</span>${escapeHtml(a)}</span>`
               )
               .join('')}
           </div>
         </div>`
      : `<div class="question-answer-content">
           <span class="answer-prefix">答案</span>${escapeHtml(q.answers.join(' / '))}
         </div>`;

  return `
    <article class="question-card" data-qid="${q.id}">
      <div class="question-meta">${metaParts.join(' · ')}</div>
      <h3 class="question-title">${escapeHtml(q.title)}</h3>
      ${imagesHtml}
      ${optionsHtml}
      <div class="question-answer-row">
        ${answerBodyHtml}
        <button class="button-pearl-capsule copy-ans-btn" type="button" data-answer="${escapeHtml(answerCopyStr)}">复制答案</button>
      </div>
    </article>`;
}

function renderQuestionList() {
  const filtered = getFilteredQuestions();
  const hasFilter = state.moduleFilter !== 'all' || state.typeFilter !== 'all' || state.query.trim() !== '';
  els.resetFilterBtn.hidden = !hasFilter;

  if (filtered.length === 0) {
    els.bankCountLabel.textContent = '未找到匹配题目';
    els.questionList.innerHTML = '<div class="empty-state">未找到符合条件的题目。</div>';
    els.loadMoreWrap.hidden = true;
    return;
  }

  const slice = filtered.slice(0, state.visibleCount);
  els.bankCountLabel.textContent = `显示 ${slice.length} / ${filtered.length} 题`;
  els.questionList.innerHTML = slice.map((q) => renderQuestionCard(q)).join('');

  if (filtered.length > slice.length) {
    els.loadMoreWrap.hidden = false;
    els.loadMoreBtn.textContent = `加载更多（剩余 ${filtered.length - slice.length} 题）`;
  } else {
    els.loadMoreWrap.hidden = true;
  }
}

function bindEvents() {
  els.ocsModeSwitcher.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    state.ocsMode = btn.dataset.mode;
    els.copyFeedback.textContent = '';
    renderOcsConfig();
  });

  els.copyOcsBtn.addEventListener('click', async () => {
    const text = state.ocsConfigs[state.ocsMode];
    if (!text) return;
    const ok = await copyText(text);
    if (ok) {
      els.copyOcsBtn.textContent = '已复制';
      els.copyFeedback.textContent = OCS_MODE_META[state.ocsMode].copied;
      setTimeout(() => {
        els.copyOcsBtn.textContent = '一键复制配置';
      }, 2400);
    } else {
      els.ocsTextarea.focus();
      els.ocsTextarea.select();
      els.copyFeedback.textContent = '已全选配置，请按 Cmd/Ctrl + C 复制。';
    }
  });

  els.ocsTextarea.addEventListener('focus', () => {
    els.ocsTextarea.select();
  });

  let searchTimer = null;
  els.searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = els.searchInput.value;
      state.visibleCount = PAGE_SIZE;
      renderQuestionList();
    }, 120);
  });

  els.moduleChips.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-module]');
    if (!btn) return;
    state.moduleFilter = btn.dataset.module;
    state.visibleCount = PAGE_SIZE;
    els.moduleChips.querySelectorAll('button').forEach((b) => b.classList.toggle('is-selected', b === btn));
    renderQuestionList();
  });

  els.typeChips.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-type]');
    if (!btn) return;
    state.typeFilter = btn.dataset.type;
    state.visibleCount = PAGE_SIZE;
    els.typeChips.querySelectorAll('button').forEach((b) => {
      const active = b === btn;
      b.classList.toggle('is-selected', active);
      b.setAttribute('aria-selected', String(active));
    });
    renderQuestionList();
  });

  els.resetFilterBtn.addEventListener('click', () => {
    state.moduleFilter = 'all';
    state.typeFilter = 'all';
    state.query = '';
    state.visibleCount = PAGE_SIZE;
    els.searchInput.value = '';
    els.moduleChips.querySelectorAll('button').forEach((b) => b.classList.toggle('is-selected', b.dataset.module === 'all'));
    els.typeChips.querySelectorAll('button').forEach((b) => {
      const active = b.dataset.type === 'all';
      b.classList.toggle('is-selected', active);
      b.setAttribute('aria-selected', String(active));
    });
    renderQuestionList();
  });

  els.loadMoreBtn.addEventListener('click', () => {
    state.visibleCount += PAGE_SIZE;
    renderQuestionList();
  });

  els.questionList.addEventListener('click', async (e) => {
    const btn = e.target.closest('.copy-ans-btn');
    if (!btn) return;
    const ans = btn.dataset.answer || '';
    const ok = await copyText(ans);
    if (ok) {
      const orig = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(() => {
        btn.textContent = orig;
      }, 1500);
    }
  });
}

async function bootstrap() {
  setupMobileNav();
  bindEvents();

  try {
    const [bankRes, ocsOfflineRes, ocsOnlineRes] = await Promise.all([
      fetch('./data/questions.json'),
      fetch('./data/ocs-config.json'),
      fetch('./data/ocs-config-online.json')
    ]);
    if (!bankRes.ok) throw new Error(`题库加载失败 (HTTP ${bankRes.status})`);
    if (!ocsOfflineRes.ok) throw new Error(`OCS 离线配置加载失败 (HTTP ${ocsOfflineRes.status})`);
    if (!ocsOnlineRes.ok) throw new Error(`OCS 在线配置加载失败 (HTTP ${ocsOnlineRes.status})`);

    const bank = await bankRes.json();
    state.bank = bank;
    state.ocsConfigs.offline = (await ocsOfflineRes.text()).trim();
    state.ocsConfigs.online = (await ocsOnlineRes.text()).trim();

    renderOcsConfig();
    renderModuleChips(bank);
    renderCoverageTable(bank);
    renderQuestionList();
  } catch (err) {
    els.ocsMeta.textContent = `加载失败：${err.message}`;
    els.ocsTextarea.value = `加载失败：${err.message}`;
    els.bankCountLabel.textContent = `加载失败：${err.message}`;
  }
}

bootstrap();
