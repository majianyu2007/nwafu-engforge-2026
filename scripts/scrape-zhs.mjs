#!/usr/bin/env node
/**
 * 知到智慧树新形态课程（examloop.zhihuishu.com）作业解析抓取脚本（Chrome CDP）。
 *
 * 使用方法：
 * 1. 使用独立配置目录并开启远程调试端口启动 Chrome：
 *    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *      --remote-debugging-port=9222 \
 *      --user-data-dir=/tmp/engforge-chrome-profile \
 *      https://www.zhihuishu.com/
 * 2. 在弹出的浏览器中登录智慧树，进入课程「任务·作业·考试 -> 作业 -> 已完成」列表页。
 * 3. 运行本脚本：
 *    node scripts/scrape-zhs.mjs
 *
 * 可选参数：
 *   --cdp=http://127.0.0.1:9222          CDP 调试地址
 *   --out=raw/homeworks-sanitized.json   输出路径（默认自动脱敏，不包含学生个人隐私与作答记录）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function getArg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const CDP_HTTP = getArg('cdp', 'http://127.0.0.1:9222');
const OUT_PATH = path.resolve(ROOT, getArg('out', 'raw/homeworks-sanitized.json'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTargets() {
  return (await fetch(`${CDP_HTTP}/json/list`)).json();
}

function sanitizeHomework(hw) {
  const oed = hw.openExamDetail || {};
  const td = hw.taskDetail || {};
  const as = hw.answerSheet || {};
  return {
    index: hw.index,
    cardTitle: hw.cardTitle,
    openExamDetail: {
      examId: oed.examId,
      examTestId: oed.examTestId,
      examName: oed.examName,
      paperId: oed.paperId,
      courseId: oed.courseId,
      examPaperType: oed.examPaperType,
      questionNum: oed.questionNum,
      totalScore: oed.totalScore,
      knowledgeNum: oed.knowledgeNum,
      isObjective: oed.isObjective,
      isAllowShowDetail: oed.isAllowShowDetail,
      startTime: oed.startTime,
      endTime: oed.endTime,
      taskType: oed.taskType,
      taskDescribe: oed.taskDescribe
    },
    taskDetail: {
      id: td.id,
      courseId: td.courseId,
      taskType: td.taskType,
      taskName: td.taskName,
      taskDescribe: td.taskDescribe,
      startTime: td.startTime,
      endTime: td.endTime
    },
    answerSheet: {
      questionCount: as.questionCount,
      partSheetVos: (as.partSheetVos || []).map((p) => ({
        id: p.id,
        name: p.name,
        questionCount: p.questionCount,
        totalScore: p.totalScore,
        sort: p.sort,
        questionSheetVos: (p.questionSheetVos || []).map((q) => ({
          parentPartId: q.parentPartId,
          questionType: q.questionType,
          questionId: q.questionId,
          version: q.version,
          sort: q.sort,
          score: q.score
        }))
      }))
    },
    questions: (hw.questions || []).map((q) => {
      const d = q.detail || {};
      return {
        partId: q.partId,
        partName: q.partName,
        sort: q.sort,
        questionId: String(q.questionId),
        questionType: q.questionType,
        score: q.score,
        detail: d.id != null
          ? {
              id: d.id,
              content: d.content,
              questionType: d.questionType,
              questionTypeName: d.questionTypeName,
              result: d.result,
              analysisVo: d.analysisVo || null,
              optionVos: (d.optionVos || []).map((o) => ({
                id: o.id,
                content: o.content,
                isCorrect: o.isCorrect,
                sort: o.sort
              }))
            }
          : null
      };
    })
  };
}

const ver = await (await fetch(`${CDP_HTTP}/json/version`)).json();
const bws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  bws.onopen = res;
  bws.onerror = rej;
});

let bid = 1;
const pending = new Map();
const sessions = new Map();
let netCapture = null;

function send(method, params = {}, sessionId = undefined) {
  return new Promise((res, rej) => {
    const mid = bid++;
    pending.set(mid, { res, rej });
    const payload = { id: mid, method, params };
    if (sessionId) payload.sessionId = sessionId;
    bws.send(JSON.stringify(payload));
  });
}

bws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) rej(msg.error);
    else res(msg.result);
    return;
  }

  if (msg.method === 'Target.attachedToTarget') {
    const { sessionId, targetInfo } = msg.params;
    sessions.set(sessionId, { targetInfo, reqs: new Map() });
    send('Network.enable', {}, sessionId).catch(() => {});
    send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
  } else if (msg.method === 'Target.detachedFromTarget') {
    sessions.delete(msg.params.sessionId);
  } else if (msg.method === 'Network.responseReceived') {
    const s = sessions.get(msg.sessionId);
    if (!s || !netCapture) return;
    const { requestId, response, type } = msg.params;
    if (type !== 'XHR' && type !== 'Fetch') return;
    const u = response.url;
    if (
      u.includes('/openExamDetail') ||
      u.includes('/task-detail-by-testId') ||
      u.includes('/getAnswerSheetInformation') ||
      u.includes('/getExamQuestionInfo')
    ) {
      s.reqs.set(requestId, { url: u, status: response.status });
    }
  } else if (msg.method === 'Network.loadingFinished') {
    const s = sessions.get(msg.sessionId);
    if (!s || !netCapture) return;
    const info = s.reqs.get(msg.params.requestId);
    if (!info) return;
    s.reqs.delete(msg.params.requestId);
    const bucket = netCapture;
    send('Network.getResponseBody', { requestId: msg.params.requestId }, msg.sessionId)
      .then((res) => {
        const json = JSON.parse(res.body);
        if (info.url.includes('/openExamDetail')) bucket.openExamDetail = json.data;
        else if (info.url.includes('/task-detail-by-testId')) bucket.taskDetail = json.data;
        else if (info.url.includes('/getAnswerSheetInformation')) bucket.answerSheet = json.data;
        else if (info.url.includes('/getExamQuestionInfo') && json.data?.id != null) {
          bucket.questionsById.set(String(json.data.id), json.data);
        }
      })
      .catch(() => {});
  }
});

await send('Target.setDiscoverTargets', { discover: true });
await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

const initialTargets = await getTargets();
const listPage = initialTargets.find((t) => t.type === 'page' && t.url.includes('taskAndExam'));
if (!listPage) {
  bws.close();
  throw new Error('未找到智慧树「任务·作业·考试」列表页（URL 应包含 taskAndExam）');
}

const listAtt = await send('Target.attachToTarget', { targetId: listPage.id, flatten: true });
const listSid = listAtt.sessionId;
sessions.set(listSid, { targetInfo: listPage, reqs: new Map() });
await send('Network.enable', {}, listSid);

const hwItemsRes = await send(
  'Runtime.evaluate',
  {
    expression: `Array.from(document.querySelectorAll('.homework-test-content-item')).map((el, i) => ({
      index: i,
      title: el.querySelector('.title')?.innerText?.trim() || el.innerText.split('\\n')[0]
    }))`,
    returnByValue: true
  },
  listSid
);
const hwItems = hwItemsRes.result.value || [];
console.log(`Found ${hwItems.length} homework items.`);

async function waitForCondition(fn, timeoutMs = 15000, intervalMs = 200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const val = await fn();
    if (val) return val;
    await sleep(intervalMs);
  }
  return null;
}

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
const allHomeworks = [];

for (let i = 0; i < hwItems.length; i++) {
  const item = hwItems[i];
  console.log(`\n[${i + 1}/${hwItems.length}] ${item.title}`);

  const bucket = {
    index: i,
    cardTitle: item.title,
    openExamDetail: null,
    taskDetail: null,
    answerSheet: null,
    questionsById: new Map()
  };
  netCapture = bucket;

  const beforeIds = new Set((await getTargets()).filter((t) => t.type === 'page').map((t) => t.id));
  await send('Page.bringToFront', {}, listSid).catch(() => {});
  await send(
    'Runtime.evaluate',
    {
      expression: `(() => {
        const el = document.querySelectorAll('.homework-test-content-item')[${i}];
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      })()`,
      userGesture: true,
      returnByValue: true
    },
    listSid
  );

  const detailTab = await waitForCondition(async () => {
    const ts = await getTargets();
    return ts.find((t) => t.type === 'page' && !beforeIds.has(t.id) && t.url.includes('/testDetail/'));
  }, 15000);
  if (!detailTab) {
    console.error(`Failed to open testDetail for ${item.title}`);
    continue;
  }

  const detailAtt = await send('Target.attachToTarget', { targetId: detailTab.id, flatten: true });
  const detailSid = detailAtt.sessionId;
  if (!sessions.has(detailSid)) {
    sessions.set(detailSid, { targetInfo: detailTab, reqs: new Map() });
    await send('Network.enable', {}, detailSid);
  }

  await waitForCondition(async () => {
    const r = await send(
      'Runtime.evaluate',
      {
        expression: `!!Array.from(document.querySelectorAll('.info-btn')).find(el => (el.innerText || '').trim().includes('查看解析'))`,
        returnByValue: true
      },
      detailSid
    ).catch(() => null);
    return r?.result?.value === true;
  }, 15000);

  await sleep(300);
  await send(
    'Runtime.evaluate',
    {
      expression: `(() => {
        const btn = Array.from(document.querySelectorAll('.info-btn')).find(el => (el.innerText || '').trim().includes('查看解析'));
        if (btn) btn.click();
        return !!btn;
      })()`,
      userGesture: true,
      returnByValue: true
    },
    detailSid
  );

  const loaded = await waitForCondition(async () => {
    const ts = await getTargets();
    const cur = ts.find((t) => t.id === detailTab.id);
    return cur?.url.includes('examloop.zhihuishu.com') && bucket.answerSheet && bucket.questionsById.size >= 1;
  }, 20000);

  if (!loaded) {
    console.error(`Timed out waiting for examloop data on ${item.title}`);
    await send('Target.closeTarget', { targetId: detailTab.id }).catch(() => {});
    continue;
  }

  const expectedQuestions = [];
  for (const part of bucket.answerSheet.partSheetVos || []) {
    for (const q of part.questionSheetVos || []) {
      expectedQuestions.push({
        partId: part.id,
        partName: part.name,
        sort: q.sort,
        questionId: String(q.questionId),
        questionType: q.questionType,
        score: q.score
      });
    }
  }

  await waitForCondition(async () => {
    const r = await send(
      'Runtime.evaluate',
      {
        expression: `Array.from(document.querySelectorAll('div.grid button')).filter(b => /^\\d+$/.test((b.innerText || '').trim())).length`,
        returnByValue: true
      },
      detailSid
    ).catch(() => null);
    return (r?.result?.value || 0) >= expectedQuestions.length;
  }, 10000);

  for (let qIdx = 0; qIdx < expectedQuestions.length; qIdx++) {
    const targetQId = expectedQuestions[qIdx].questionId;
    if (bucket.questionsById.has(targetQId)) continue;
    for (let attempt = 0; attempt < 3; attempt++) {
      await send(
        'Runtime.evaluate',
        {
          expression: `(() => {
            const btns = Array.from(document.querySelectorAll('div.grid button')).filter(b => /^\\d+$/.test((b.innerText || '').trim()));
            const b = btns[${qIdx}];
            if (b) { b.scrollIntoView({ block: 'center' }); b.click(); }
          })()`,
          userGesture: true,
          returnByValue: true
        },
        detailSid
      );
      if (await waitForCondition(() => bucket.questionsById.has(targetQId), 4000, 100)) break;
      await sleep(300);
    }
    await sleep(120);
  }

  const orderedQuestions = expectedQuestions.map((meta) => ({
    ...meta,
    detail: bucket.questionsById.get(meta.questionId) || null
  }));

  allHomeworks.push(
    sanitizeHomework({
      ...bucket,
      questions: orderedQuestions
    })
  );
  fs.writeFileSync(OUT_PATH, JSON.stringify(allHomeworks, null, 2) + '\n', 'utf8');
  console.log(`  Captured ${bucket.questionsById.size}/${expectedQuestions.length} (examPaperType=${bucket.openExamDetail?.examPaperType})`);

  await send('Target.closeTarget', { targetId: detailTab.id }).catch(() => {});
  await sleep(400);
}

console.log(`\nDone. Saved sanitized raw dataset to ${OUT_PATH}`);
bws.close();
