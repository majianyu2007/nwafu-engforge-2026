const TYPE_LABELS = {
  single: '单选题',
  multiple: '多选题',
  judgement: '判断题',
  completion: '填空客观题'
};

const PAGE_SIZE = 24;

const state = {
  bank: null,
  ocsText: '',
  moduleFilter: 'all',
  typeFilter: 'all',
  query: '',
  visibleCount: PAGE_SIZE
};

const els = {
  mobileMenuBtn: document.getElementById('mobile-menu-btn'),
  globalNavLinks: document.getElementById('global-nav-links'),
  metricModules: document.getElementById('metric-modules'),
  metricQuestions: document.getElementById('metric-questions'),
  metricScore: document.getElementById('metric-score'),
  ocsMeta: document.getElementById('ocs-config-meta'),
  ocsTextarea: document.getElementById('ocs-config-textarea'),
  ocsRawDrawer: document.getElementById('ocs-raw-drawer'),
  toggleRawOcsBtn: document.getElementById('toggle-raw-ocs-btn'),
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

function renderCoverageTable(bank) {
  const { modules, meta } = bank;
  els.coverageTbody.innerHTML = modules
    .map(
      (m) => `
      <tr>
        <td>${escapeHtml(m.name)}</td>
        <td>${escapeHtml(m.examPaperType)}</td>
        <td class="num">${m.counts.single}</td>
        <td class="num">${m.counts.multiple}</td>
        <td class="num">${m.counts.judgement}</td>
        <td class="num">${m.counts.completion}</td>
        <td class="num">${m.questionCount}</td>
        <td class="num">${m.totalScore.toFixed(1)} 分</td>
      </tr>`
    )
    .join('');

  els.coverageTfoot.innerHTML = `
    <tr>
      <td>总计（${meta.totalModules} 项）</td>
      <td>全部固定卷</td>
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
    `<button class="configurator-option-chip is-selected" type="button" data-module="all">全部工种 (${bank.meta.totalQuestions})</button>`,
    ...bank.modules.map(
      (m) =>
        `<button class="configurator-option-chip" type="button" data-module="${escapeHtml(m.name)}">${escapeHtml(m.name)} (${m.questionCount})</button>`
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

function renderQuestionCard(q, idx) {
  const typeLabel = TYPE_LABELS[q.type] || q.typeName;
  const metaParts = [
    escapeHtml(q.module),
    `<span class="question-meta-accent">${escapeHtml(typeLabel)}</span>`,
    `${q.score} 分`
  ];
  if (q.cleaned) {
    metaParts.push(`<span title="${escapeHtml(q.cleaningNote || '已自然化清洗')}">已清洗</span>`);
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
           <span class="answer-prefix">参考答案（${q.answers.length} 空）</span>
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
           <span class="answer-prefix">参考答案</span>${escapeHtml(q.answers.join(' / '))}
         </div>`;

  return `
    <article class="question-card" data-qid="${q.id}">
      <div class="question-meta">
        <span>${metaParts.join(' · ')}</span>
        <span class="question-meta-id">#${idx + 1} · ${q.id}</span>
      </div>
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
    els.bankCountLabel.textContent = '未找到匹配的题目';
    els.questionList.innerHTML = '<div class="empty-state">未找到符合条件的题目，请缩短关键词或重置筛选。</div>';
    els.loadMoreWrap.hidden = true;
    return;
  }

  const slice = filtered.slice(0, state.visibleCount);
  els.bankCountLabel.textContent = `显示 ${slice.length} / 共匹配 ${filtered.length} 题（总题库 ${state.bank.meta.totalQuestions} 题）`;
  els.questionList.innerHTML = slice.map((q, i) => renderQuestionCard(q, i)).join('');

  if (filtered.length > slice.length) {
    els.loadMoreWrap.hidden = false;
    els.loadMoreBtn.textContent = `加载更多（剩余 ${filtered.length - slice.length} 题）`;
  } else {
    els.loadMoreWrap.hidden = true;
  }
}

function bindEvents() {
  els.copyOcsBtn.addEventListener('click', async () => {
    if (!state.ocsText) return;
    const ok = await copyText(state.ocsText);
    if (ok) {
      els.copyOcsBtn.textContent = '已复制到剪贴板';
      els.copyFeedback.textContent = '已复制完整配置（含 297 题本地匹配引擎），请直接粘贴到 OCS「自定义题库」保存。';
      setTimeout(() => {
        els.copyOcsBtn.textContent = '一键复制配置';
      }, 2400);
    } else {
      els.ocsRawDrawer.hidden = false;
      els.toggleRawOcsBtn.setAttribute('aria-expanded', 'true');
      els.toggleRawOcsBtn.textContent = '收起完整 JSON';
      els.ocsTextarea.focus();
      els.ocsTextarea.select();
      els.copyFeedback.textContent = '已为你展开并全选完整配置，请按 Cmd/Ctrl + C 复制。';
    }
  });

  els.toggleRawOcsBtn.addEventListener('click', () => {
    const willShow = els.ocsRawDrawer.hidden;
    els.ocsRawDrawer.hidden = !willShow;
    els.toggleRawOcsBtn.setAttribute('aria-expanded', String(willShow));
    els.toggleRawOcsBtn.textContent = willShow ? '收起完整 JSON' : '查看完整 JSON';
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
    els.typeChips.querySelectorAll('button').forEach((b) => b.classList.toggle('is-selected', b === btn));
    renderQuestionList();
  });

  els.resetFilterBtn.addEventListener('click', () => {
    state.moduleFilter = 'all';
    state.typeFilter = 'all';
    state.query = '';
    state.visibleCount = PAGE_SIZE;
    els.searchInput.value = '';
    els.moduleChips.querySelectorAll('button').forEach((b) => b.classList.toggle('is-selected', b.dataset.module === 'all'));
    els.typeChips.querySelectorAll('button').forEach((b) => b.classList.toggle('is-selected', b.dataset.type === 'all'));
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
    const [bankRes, ocsRes] = await Promise.all([
      fetch('./data/questions.json'),
      fetch('./data/ocs-config.json')
    ]);
    if (!bankRes.ok) throw new Error(`题库加载失败 (HTTP ${bankRes.status})`);
    if (!ocsRes.ok) throw new Error(`OCS 配置加载失败 (HTTP ${ocsRes.status})`);

    const bank = await bankRes.json();
    const ocsText = (await ocsRes.text()).trim();

    state.bank = bank;
    state.ocsText = ocsText;

    els.metricModules.textContent = `${bank.meta.totalModules} 项`;
    els.metricQuestions.textContent = `${bank.meta.totalQuestions} 题`;
    els.metricScore.textContent = `${bank.meta.totalScore.toFixed(1)} 分`;

    const sizeKb = (new Blob([ocsText]).size / 1024).toFixed(1);
    els.ocsMeta.textContent = `${bank.meta.totalQuestions} 题内联 · ${sizeKb} KB · 0 安全警告`;
    els.ocsTextarea.value = ocsText;
    els.copyOcsBtn.disabled = false;

    renderModuleChips(bank);
    renderCoverageTable(bank);
    renderQuestionList();
  } catch (err) {
    els.ocsMeta.textContent = `加载失败：${err.message}`;
    els.bankCountLabel.textContent = `加载失败：${err.message}`;
  }
}

bootstrap();
