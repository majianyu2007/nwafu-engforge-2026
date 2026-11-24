#!/usr/bin/env node
/**
 * 对脱敏后的原始作业数据进行组卷模式（固定卷 ASSIGN vs 随机抽题 RANDOM）、
 * 题号连续性、题型分布、配图题与填空答案清洗候选的法证分析。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RAW_PATH = process.env.RAW_PATH || path.join(ROOT, 'raw/homeworks-sanitized.json');

const data = JSON.parse(fs.readFileSync(RAW_PATH, 'utf8'));

function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

let totalQ = 0;
let totalScore = 0;
let imgCount = 0;
const typeTotals = new Map();

console.log(`Analyzing ${data.length} homeworks from ${path.relative(ROOT, RAW_PATH)}\n`);

for (const hw of data) {
  const qs = hw.questions || [];
  totalQ += qs.length;
  totalScore += Number(hw.openExamDetail?.totalScore || 0);

  const ids = qs.map((q) => Number(q.questionId));
  const sortedIds = [...ids].sort((a, b) => a - b);
  const inIdOrder = ids.every((v, i) => i === 0 || v > ids[i - 1]);

  console.log(
    `[${String(hw.index + 1).padStart(2, '0')}] ${hw.cardTitle} | type=${hw.openExamDetail?.examPaperType} | n=${qs.length} | score=${hw.openExamDetail?.totalScore} | inIdOrder=${inIdOrder}`
  );

  const byPart = new Map();
  for (const q of qs) {
    const d = q.detail;
    const tKey = `${d.questionType}:${d.questionTypeName}`;
    typeTotals.set(tKey, (typeTotals.get(tKey) || 0) + 1);
    if (/<img\b/i.test(d.content || '')) imgCount++;
    if (!byPart.has(q.partName)) byPart.set(q.partName, []);
    byPart.get(q.partName).push(Number(q.questionId));
  }

  for (const [partName, pIds] of byPart.entries()) {
    pIds.sort((a, b) => a - b);
    const clusters = [];
    for (const id of pIds) {
      if (!clusters.length || id - clusters[clusters.length - 1].at(-1) > 20) {
        clusters.push([id]);
      } else {
        clusters[clusters.length - 1].push(id);
      }
    }
    const clusterDesc = clusters
      .map((c) => (c.length === 1 ? `${c[0]}` : `${c[0]}..${c.at(-1)}(n=${c.length},span=${c.at(-1) - c[0] + 1})`))
      .join(' + ');
    console.log(`     - ${partName} (n=${pIds.length}): ${clusterDesc}`);
  }
}

console.log('\n=== SUMMARY ===');
console.log(`Homeworks: ${data.length}, Questions: ${totalQ}, Total Score: ${totalScore.toFixed(1)}, Image Questions: ${imgCount}`);
for (const [k, v] of typeTotals.entries()) {
  console.log(`  ${k}: ${v}`);
}
