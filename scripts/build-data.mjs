import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const RAW_PATH =
  process.env.RAW_PATH ||
  '/Users/majianyu/.gemini/antigravity-cli/brain/22ed1aec-1ce3-443e-8434-ca8458d86dab/scratch/all-homeworks-raw.json';

const SITE_URL = 'https://mjy.js.org/nwafu-engforge-2026/';

function decodeEntities(str) {
  return String(str || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\u00a0/g, ' ');
}

function stripHtml(html) {
  if (!html) return '';
  return decodeEntities(
    String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>\s*<p[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractImages(html) {
  const imgs = [];
  const re = /<img[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html || '')) !== null) {
    imgs.push(m[1]);
  }
  return imgs;
}

// Keep in exact sync with OCS handler & userscript normalize logic
function normalizeForKey(str) {
  return String(str || '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\[图片\d+\]/g, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

// Empirically verified fill-in-the-blank overrides where multi-blank semicolon synonym groups
// were confirmed full-score in Zhihuishu's live grader. All other completion questions use
// the exact optionVos[].content which was verified 93/93 (100%) against Zhihuishu's grader.
const SPLIT_SYNONYM_COMPLETION_IDS = new Set([1014779840, 1014781312]);

function resolveCompletionAnswers(detail) {
  const sortedOpts = [...(detail.optionVos || [])].sort((a, b) => a.sort - b.sort);
  const raw = sortedOpts.map((o) => stripHtml(o.content));

  if (SPLIT_SYNONYM_COMPLETION_IDS.has(detail.id)) {
    // Group consecutive identical/permuted semicolon option sets and pick distinct entries
    const out = [];
    const usedInGroup = new Map();
    for (const item of raw) {
      const parts = item.split('；').map((s) => s.trim()).filter(Boolean);
      const sig = [...parts].sort().join('|');
      const idx = usedInGroup.get(sig) || 0;
      out.push(parts[idx] ?? parts[0] ?? item);
      usedInGroup.set(sig, idx + 1);
    }
    return { answers: out, rawAnswers: raw };
  }

  return { answers: raw, rawAnswers: raw };
}

function cleanModuleName(cardTitle) {
  return String(cardTitle || '')
    .replace(/^作业任务/, '')
    .replace(/作业$/, '')
    .trim();
}

function mapType(questionType) {
  switch (questionType) {
    case 1:
      return 'single';
    case 2:
      return 'multiple';
    case 14:
      return 'judgement';
    case 3:
      return 'completion';
    default:
      return 'unknown';
  }
}

const rawHomeworks = JSON.parse(fs.readFileSync(RAW_PATH, 'utf8'));

const modules = [];
const questions = [];

// Order modules cleanly by original course order (keep rawHomeworks order)
for (const hw of rawHomeworks) {
  const moduleName = cleanModuleName(hw.cardTitle);
  const typeCounts = { single: 0, multiple: 0, judgement: 0, completion: 0 };

  // Sort questions within each module by original questionId ascending so browsing is tidy & deterministic
  const sortedQs = [...hw.questions].sort((a, b) => Number(a.questionId) - Number(b.questionId));

  for (const q of sortedQs) {
    const d = q.detail;
    if (!d) throw new Error(`Missing question detail for ${q.questionId}`);

    const type = mapType(d.questionType);
    if (type in typeCounts) typeCounts[type]++;

    const titleText = stripHtml(d.content);
    const images = extractImages(d.content);
    const localImages = images.map(() => `assets/q-images/${d.id}.png`);
    const sortedOpts = [...(d.optionVos || [])].sort((a, b) => a.sort - b.sort);

    let options = [];
    let answers = [];
    let rawAnswers = [];
    let ocsAnswer = '';

    if (type === 'single' || type === 'multiple' || type === 'judgement') {
      options = sortedOpts.map((o, idx) => ({
        label: String.fromCharCode(65 + idx),
        text: stripHtml(o.content),
        isCorrect: o.isCorrect === 1
      }));
      answers = options.filter((o) => o.isCorrect).map((o) => o.text);
      rawAnswers = answers;
      ocsAnswer = answers.join('===');
    } else if (type === 'completion') {
      const resolved = resolveCompletionAnswers(d);
      answers = resolved.answers;
      rawAnswers = resolved.rawAnswers;
      ocsAnswer = answers.join('===');
    }

    if (answers.length === 0) {
      throw new Error(`No answer resolved for question ${d.id}`);
    }

    questions.push({
      id: d.id,
      module: moduleName,
      homeworkTitle: hw.cardTitle,
      type,
      typeName: d.questionTypeName,
      score: Number(q.score),
      title: titleText,
      images,
      localImages: images.length ? localImages : [],
      options,
      answers,
      rawAnswers,
      ocsAnswer
    });
  }

  modules.push({
    id: hw.openExamDetail?.examTestId,
    paperId: hw.openExamDetail?.paperId,
    name: moduleName,
    homeworkTitle: hw.cardTitle,
    examPaperType: hw.openExamDetail?.examPaperType || 'ASSIGN',
    questionCount: hw.questions.length,
    totalScore: Number(hw.openExamDetail?.totalScore || 0),
    counts: typeCounts
  });
}

const totalScore = Number(modules.reduce((acc, m) => acc + m.totalScore, 0).toFixed(1));
const typeTotals = questions.reduce(
  (acc, q) => {
    acc[q.type] = (acc[q.type] || 0) + 1;
    return acc;
  },
  { single: 0, multiple: 0, judgement: 0, completion: 0 }
);

const questionBank = {
  meta: {
    project: 'EngForge',
    fullName: 'Engineering Training Question Bank',
    course: '西北农林科技大学 · 工程训练（2026年秋冬学期）',
    platform: '知到智慧树新形态课程 (examloop.zhihuishu.com)',
    version: '2026.1.0',
    generatedAt: '2026-11-24',
    paperMode: 'ASSIGN',
    totalModules: modules.length,
    totalQuestions: questions.length,
    totalScore,
    typeTotals
  },
  modules,
  questions
};

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'data/questions.json'), JSON.stringify(questionBank, null, 2) + '\n', 'utf8');

// Build compact OCS AnswererWrapper[] config
// Uses pure frontend data: URI echo + type:"fetch" + embedded bank:
// - Zero backend server required
// - Zero @connect block in both official OCS and 全域名通用版
// - Zero security warnings in OCS answer-wrapper-security.ts
const compactEntries = questions.map((q) => [normalizeForKey(q.title), q.title, q.ocsAnswer]);

// Sanity check: ensure no key collisions
const keySet = new Set();
for (const [k, t] of compactEntries) {
  if (!k) throw new Error(`Empty normalized key for: ${t}`);
  if (keySet.has(k)) throw new Error(`Duplicate normalized key: ${k} (${t})`);
  keySet.add(k);
}

// Pure, readable, zero-risk-pattern handler (no eval/Function/fetch/window/document/top/fromCharCode/\u escapes)
const ocsHandlerCode =
  `return (res) => {` +
  `const B=${JSON.stringify(compactEntries)};` +
  `const n=(s)=>String(s||'').replace(/https?:\\/\\/\\S+/gi,'').replace(/\\[图片\\d+\\]/g,'').normalize('NFKC').toLowerCase().replace(/[^\\p{L}\\p{N}]/gu,'');` +
  `const s0=(s)=>s.replace(/^\\d+/,'');` +
  `const q=n(res);if(!q)return undefined;` +
  `for(let i=0;i<B.length;i++){if(B[i][0]===q)return [B[i][1],B[i][2]];}` +
  `const qs=s0(q);` +
  `if(qs.length>=6){for(let i=0;i<B.length;i++){if(s0(B[i][0])===qs)return [B[i][1],B[i][2]];}}` +
  `let best=null,bestScore=0;` +
  `const bi=(s)=>{const m=new Map();for(let i=0;i<s.length-1;i++){const g=s.slice(i,i+2);m.set(g,(m.get(g)||0)+1);}return m;};` +
  `const qm=bi(q);` +
  `for(let i=0;i<B.length;i++){` +
  `const k=B[i][0];` +
  `if(q.length>=8&&(k.includes(q)||q.includes(k))){const r=Math.min(q.length,k.length)/Math.max(q.length,k.length);if(r>bestScore){bestScore=r;best=B[i];}continue;}` +
  `if(q.length<2||k.length<2)continue;` +
  `const km=bi(k);let hit=0;for(const [g,c] of qm){const kc=km.get(g);if(kc)hit+=c<kc?c:kc;}` +
  `const sc=(2*hit)/(q.length+k.length-2);if(sc>bestScore){bestScore=sc;best=B[i];}` +
  `}` +
  `return best&&bestScore>=0.65?[best[1],best[2]]:undefined;` +
  `}`;

const ocsConfig = [
  {
    name: 'EngForge 2026 工程训练题库',
    homepage: SITE_URL,
    url: 'data:text/plain;charset=utf-8,${title}',
    method: 'get',
    type: 'fetch',
    contentType: 'text',
    responseType: 'text',
    headers: {},
    handler: ocsHandlerCode
  }
];

fs.writeFileSync(path.join(ROOT, 'data/ocs-config.json'), JSON.stringify(ocsConfig, null, 2) + '\n', 'utf8');

const qSize = fs.statSync(path.join(ROOT, 'data/questions.json')).size;
const oSize = fs.statSync(path.join(ROOT, 'data/ocs-config.json')).size;
console.log(`Built data/questions.json (${(qSize / 1024).toFixed(1)} KB, ${questions.length} questions, ${modules.length} modules, ${totalScore} pts)`);
console.log(`Built data/ocs-config.json (${(oSize / 1024).toFixed(1)} KB)`);
