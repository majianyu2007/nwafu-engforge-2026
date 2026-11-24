import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 1. Validate raw/homeworks-sanitized.json contains ZERO personal PII
const rawText = fs.readFileSync(path.join(ROOT, 'raw/homeworks-sanitized.json'), 'utf8');
for (const forbidden of ['studentName', 'studentCode', 'userAnswerVo', 'examTestUserInfo', 'traceId']) {
  assert.ok(!rawText.includes(forbidden), `Sanitized raw dataset should not contain "${forbidden}"`);
}
console.log('✓ Privacy check: raw/homeworks-sanitized.json contains zero personal PII fields');

// 2. Validate data/questions.json and data/ocs-config.json
const bank = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/questions.json'), 'utf8'));
const ocsConfigRaw = fs.readFileSync(path.join(ROOT, 'data/ocs-config.json'), 'utf8');
const ocsConfig = JSON.parse(ocsConfigRaw);

assert.equal(bank.modules.length, 11, 'Expected 11 modules');
assert.equal(bank.questions.length, 297, 'Expected 297 questions');
assert.equal(bank.meta.totalScore, 100.0, 'Expected total score 100.0');
assert.ok(Array.isArray(ocsConfig) && ocsConfig.length === 1, 'Expected 1 OCS AnswererWrapper');

// Verify no multi-blank question repeats identical semicolon-separated synonym lists across blanks
const cleanedCount = bank.questions.filter((q) => q.cleaned).length;
assert.equal(cleanedCount, 8, `Expected 8 cleaned completion questions, got ${cleanedCount}`);
for (const q of bank.questions) {
  if (q.type !== 'completion') continue;
  const semiDups = q.answers.filter((a) => a.includes('；'));
  if (semiDups.length > 1) {
    assert.ok(new Set(semiDups).size === semiDups.length, `Question ${q.id} still has duplicate semicolon blanks: ${JSON.stringify(q.answers)}`);
  }
}
console.log(`✓ Completion cleaning check: ${cleanedCount} synonym/multi-blank questions cleaned, 0 duplicate semicolon blanks`);

const wrapper = ocsConfig[0];

// 3. Validate against OCS AnswerWrapperParser rules
assert.equal(typeof wrapper.name, 'string');
assert.equal(typeof wrapper.url, 'string');
assert.equal(typeof wrapper.handler, 'string');
assert.ok(['get', 'post'].includes(wrapper.method));
assert.ok(['fetch', 'GM_xmlhttpRequest'].includes(wrapper.type));
assert.ok(['json', 'text'].includes(wrapper.contentType));

// 4. Validate against OCS answer-wrapper-security.ts DANGEROUS_PATTERNS & string checks
const DANGEROUS_PATTERNS = [
  [/\beval\b/, 'eval'],
  [/\bFunction\s*\(/, 'Function()'],
  [/\bfetch\s*\(/, 'fetch'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bGM_xmlhttpRequest\b|\bGM\s*\.\s*xmlHttpRequest\b/, 'GM_xmlhttpRequest'],
  [/\bGM_\w+|\bGM\s*\.\s*\w+/, 'GM API'],
  [/\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/, 'localStorage/sessionStorage/indexedDB'],
  [/\bcookie\b/i, 'cookie'],
  [/\bsendBeacon\b/, 'sendBeacon'],
  [/\bWebSocket\b|\bEventSource\b/, 'WebSocket/EventSource'],
  [/\blocation\b/, 'location'],
  [/\bwindow\b|\bglobalThis\b|\bunsafeWindow\b|\btop\b|\bparent\b|\bopener\b/, 'global object'],
  [/\bdocument\b/, 'document'],
  [/\bpostMessage\b/, 'postMessage'],
  [/\bimport\s*\(/, 'import()'],
  [/\brequire\s*\(/, 'require()'],
  [/\.constructor\b|\b__proto__\b/, 'prototype access'],
  [/\bfromCharCode\b|\batob\b|\bunescape\b/, 'decode func'],
  [/\bWorker\b/, 'Worker'],
  [/\[\s*['"`][^\]'"]*['"`]\s*\+|\+\s*['"`][^\]'"]*['"`]\s*\]/, 'concat prop access']
];

function stripCommentsAndStrings(code) {
  const findings = [];
  let stripped = '';
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];
    if (ch === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      let str = '';
      i++;
      while (i < code.length && code[i] !== quote) {
        if (code[i] === '\\') {
          str += code[i] + (code[i + 1] || '');
          i += 2;
          continue;
        }
        if (quote !== '`' && code[i] === '\n') break;
        str += code[i];
        i++;
      }
      i++;
      if (/\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}|\\u\{[0-9a-fA-F]+\}/.test(str)) {
        findings.push(`escape in string: ${str.slice(0, 40)}`);
      }
      if (str.length > 100 && /^[A-Za-z0-9+/=\s]+$/.test(str)) {
        findings.push(`long base64-like string: ${str.slice(0, 40)}`);
      }
      stripped += '""';
      continue;
    }
    stripped += ch;
    i++;
  }
  return { stripped, findings };
}

const { stripped, findings } = stripCommentsAndStrings(wrapper.handler);
for (const [re, name] of DANGEROUS_PATTERNS) {
  if (re.test(stripped)) findings.push(`DANGEROUS_PATTERN: ${name}`);
}
assert.deepEqual(findings, [], `OCS security scanner flagged handler: ${findings.join('; ')}`);
console.log('✓ OCS security scanner check: 0 findings');

// 5. Simulate OCS defaultAnswerWrapperHandler + splitAnswer + resolvers on ALL 297 questions
const responseHandler = Function(wrapper.handler)();
assert.equal(typeof responseHandler, 'function', 'OCS handler must return a function');

function ocsSplitAnswer(answer, separators = ['===', '#', '---', '###', '|', ';', '；']) {
  answer = answer.trim();
  if (!answer) return [];
  for (const sep of separators) {
    if (answer.split(sep).length > 1) {
      return answer.split(sep).map((s) => s.trim()).filter(Boolean);
    }
  }
  return [answer];
}

let ocsExactHits = 0;
let ocsNoPrefixHits = 0;
let ocsImageUrlHits = 0;

for (const q of bank.questions) {
  const simulatedUrl = new URL(wrapper.url.replace('${title}', encodeURIComponent(q.title)));
  const decodedPayload = decodeURIComponent(simulatedUrl.pathname.replace(/^text\/plain;charset=utf-8,/, ''));
  assert.equal(decodedPayload, q.title, `data: URI roundtrip failed for ${q.id}`);

  const info = responseHandler(decodedPayload);
  assert.ok(Array.isArray(info) && info.length === 2, `OCS handler missed question ${q.id}: ${q.title}`);
  const [, ansStr] = info;
  assert.equal(ansStr, q.ocsAnswer, `Wrong answer returned for ${q.id}`);

  if (q.type === 'completion') {
    const parts = ocsSplitAnswer(ansStr);
    assert.equal(
      parts.length,
      q.answers.length,
      `OCS splitAnswer mismatch on completion ${q.id}: got ${parts.length}, expected ${q.answers.length} (${ansStr})`
    );
    assert.deepEqual(parts, q.answers, `OCS splitAnswer content mismatch on ${q.id}`);
  } else if (q.type === 'multiple') {
    const parts = ocsSplitAnswer(ansStr);
    assert.deepEqual(parts, q.answers, `OCS splitAnswer mismatch on multiple ${q.id}`);
  } else {
    assert.equal(ansStr, q.answers[0], `Answer mismatch on ${q.type} ${q.id}`);
  }
  ocsExactHits++;

  if (q.images.length > 0) {
    const titleWithUrl = `${q.title.slice(0, 10)} ${q.images[0]} ${q.title.slice(10)}`;
    const infoImg = responseHandler(titleWithUrl);
    assert.ok(infoImg && infoImg[1] === q.ocsAnswer, `Image-URL title failed for ${q.id}`);
    ocsImageUrlHits++;
  }

  const strippedNumTitle = q.title.replace(/^(?:[（(]\d+[）)]|\d+[.、\s．])/, '').trim();
  if (strippedNumTitle !== q.title && strippedNumTitle.length >= 6) {
    const infoNoNum = responseHandler(strippedNumTitle);
    assert.ok(infoNoNum && infoNoNum[1] === q.ocsAnswer, `No-prefix title failed for ${q.id}`);
    ocsNoPrefixHits++;
  }
}

console.log(`✓ OCS handler + resolver simulation: ${ocsExactHits}/297 exact (100.0%), ${ocsImageUrlHits}/4 image-URL titles, ${ocsNoPrefixHits} prefix-stripped titles`);

// 6. Verify all 4 local question images exist and are valid PNGs
for (const q of bank.questions) {
  for (const rel of q.localImages || []) {
    const abs = path.join(ROOT, rel);
    assert.ok(fs.existsSync(abs), `Missing local image: ${rel}`);
    const buf = fs.readFileSync(abs);
    assert.ok(buf.length > 1000 && buf[0] === 0x89 && buf[1] === 0x50, `Invalid PNG: ${rel}`);
  }
}
console.log('✓ Local question images: all 4 PNGs verified');

// 7. Verify JS syntax of all repo scripts
for (const rel of [
  'userscript/engforge-zhs.user.js',
  'assets/app.js',
  'scripts/scrape-zhs.mjs',
  'scripts/analyze-homeworks.mjs',
  'scripts/build-data.mjs'
]) {
  execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]);
}
console.log('✓ JS syntax check passed for all scripts & frontend assets');

// 8. Verify userscript header matches meta.js
const userJs = fs.readFileSync(path.join(ROOT, 'userscript/engforge-zhs.user.js'), 'utf8');
const metaJs = fs.readFileSync(path.join(ROOT, 'userscript/engforge-zhs.meta.js'), 'utf8').trim();
assert.ok(userJs.startsWith(metaJs), 'engforge-zhs.user.js header does not match engforge-zhs.meta.js');
console.log('✓ Userscript metadata matches engforge-zhs.meta.js');

console.log('\nALL CHECKS PASSED!');
