#!/usr/bin/env node
/**
 * 将脱敏原始题库 raw/homeworks-sanitized.json 构建为：
 * 1. data/questions.json   — 面向前端检索页与独立油猴脚本的结构化静态题库（含清洗后标准答案）
 * 2. data/ocs-config.json  — 面向 OCS 网课助手的纯前端零后端 AnswererWrapper[] 配置
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const RAW_PATH = process.env.RAW_PATH || path.join(ROOT, 'raw/homeworks-sanitized.json');
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

/**
 * 填空客观题答案清洗策略（兼顾“正常人作答习惯”与“智慧树自动批阅一次过满分”）：
 *
 * 经实测智慧树填空自动批阅机制：
 * 1. 中文分号 `；` 是智慧树填空题官方同义词/无序并列空分隔符。
 *    - 多个并列空在后台经常把整串 `A；B；C` 重复复制到 2~4 个空中（如 4 个空都存 `"拔长模膛；滚压模膛；弯曲模膛；切断模膛"`）。
 *    - 清洗规则 A（无序并列多空拆分）：当 k 个空共享同一组由 `；` 分隔的 k 个互异词条时，
 *      将其拆分为每空独立填写 1 个词条（如 `["拔长模膛","滚压模膛","弯曲模膛","切断模膛"]`）。
 *      已实测 1014779840 / 1014781312 拆分作答均获 100% 满分。
 *    - 清洗规则 B（单空同义词精选）：如 1014684444 `"CO₂；二氧化碳"`，选取最自然的中文写法 `"二氧化碳"`，
 *      避免将带分号与下标的同义词表整串照抄，同时精准命中分号拆分项。
 *    - 例外保护 1014673740 第 3 空 `"螺纹连接；键连接；销连接等"`：该空本身是单空列举题，
 *      实测改写为 `"螺纹连接、键连接、销连接"` 会被判 0 分，故保留原串以确保一次通过。
 * 2. 括号补充说明（仅涉及全库 4 题：`1015147369`、`1014775318`、`1014779841`、`1014775317`）：
 *    - 实测智慧树对单空相似度要求严格（`围栏` vs `安全围栏` 50% -> 0分；`顶尖` vs `双顶尖` 67% -> 0分；
 *      `互换装配法` vs `互换法` 60% -> 0分；仅 `排屑和输送切削液` vs `排屑和输送冷却液` 87.5% 通过）。
 *    - 去掉括号后上述 4 空字符占比仅剩 25%~67%，存在极高单次机会丢分风险，因此保留各空括号内容以优先保证一次满分。
 */
const SINGLE_BLANK_SYNONYM_PICK = {
  // 2 激光切割按工作介质可分为 ___ 激光切割和 ___ 激光切割
  1014684444: {
    0: '二氧化碳'
  }
};

function cleanCompletionAnswers(detail) {
  const sortedOpts = [...(detail.optionVos || [])].sort((a, b) => a.sort - b.sort);
  const raw = sortedOpts.map((o) => stripHtml(o.content));
  const cleaned = [...raw];
  const notes = [];

  // Rule A: detect groups of k blanks sharing the exact same k semicolon-separated parts (same order or permuted)
  const groups = new Map(); // sig -> { parts, indices[] }
  for (let i = 0; i < raw.length; i++) {
    if (!raw[i].includes('；')) continue;
    const parts = raw[i]
      .split('；')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length < 2) continue;
    const sig = [...parts].sort().join('\u0000');
    if (!groups.has(sig)) {
      groups.set(sig, { parts, indices: [] });
    }
    groups.get(sig).indices.push(i);
  }

  for (const { parts, indices } of groups.values()) {
    if (indices.length === parts.length) {
      indices.forEach((blankIdx, pos) => {
        cleaned[blankIdx] = parts[pos];
      });
      notes.push(`拆分 ${indices.length} 个无序并列空为独立答案`);
    }
  }

  // Rule B: explicit single-blank synonym picks (verified against Zhihuishu ; synonym splitting)
  const picks = SINGLE_BLANK_SYNONYM_PICK[detail.id];
  if (picks) {
    for (const [idxStr, val] of Object.entries(picks)) {
      const idx = Number(idxStr);
      if (cleaned[idx] !== val) {
        notes.push(`第 ${idx + 1} 空同义词精选（${cleaned[idx]} → ${val}）`);
        cleaned[idx] = val;
      }
    }
  }

  return {
    answers: cleaned,
    rawAnswers: raw,
    cleaned: notes.length > 0,
    cleaningNote: notes.join('；')
  };
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
const cleanedLog = [];

for (const hw of rawHomeworks) {
  const moduleName = cleanModuleName(hw.cardTitle);
  const typeCounts = { single: 0, multiple: 0, judgement: 0, completion: 0 };

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
    let cleaned = false;
    let cleaningNote = '';

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
      const resolved = cleanCompletionAnswers(d);
      answers = resolved.answers;
      rawAnswers = resolved.rawAnswers;
      cleaned = resolved.cleaned;
      cleaningNote = resolved.cleaningNote;
      ocsAnswer = answers.join('===');
      if (cleaned) {
        cleanedLog.push({ id: d.id, module: moduleName, raw: rawAnswers, cleaned: answers, note: cleaningNote });
      }
    }

    if (answers.length === 0) {
      throw new Error(`No answer resolved for question ${d.id}`);
    }

    const record = {
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
    };
    if (cleaned) {
      record.cleaned = true;
      record.cleaningNote = cleaningNote;
    }
    questions.push(record);
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
    version: '2026.1.1',
    generatedAt: '2026-11-24',
    paperMode: 'ASSIGN',
    totalModules: modules.length,
    totalQuestions: questions.length,
    cleanedQuestions: cleanedLog.length,
    totalScore,
    typeTotals
  },
  modules,
  questions
};

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'data/questions.json'), JSON.stringify(questionBank, null, 2) + '\n', 'utf8');

// Build compact OCS AnswererWrapper[] config
const compactEntries = questions.map((q) => [normalizeForKey(q.title), q.title, q.ocsAnswer]);

const keySet = new Set();
for (const [k, t] of compactEntries) {
  if (!k) throw new Error(`Empty normalized key for: ${t}`);
  if (keySet.has(k)) throw new Error(`Duplicate normalized key: ${k} (${t})`);
  keySet.add(k);
}

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
console.log(`Built data/questions.json (${(qSize / 1024).toFixed(1)} KB, ${questions.length} questions, ${cleanedLog.length} cleaned)`);
console.log(`Built data/ocs-config.json (${(oSize / 1024).toFixed(1)} KB)`);
for (const c of cleanedLog) {
  console.log(`  [cleaned] [${c.module}] ${c.id}: ${c.note}`);
  console.log(`            before: ${JSON.stringify(c.raw)}`);
  console.log(`            after : ${JSON.stringify(c.cleaned)}`);
}
