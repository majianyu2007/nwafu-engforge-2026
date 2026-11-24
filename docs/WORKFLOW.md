# EngForge 开发流程与复用指南

本文档完整记录了 `nwafu-engforge-2026` 从题目采集、固定卷/随机卷法证分析、填空答案清洗、纯前端 OCS 题库配置生成，到独立智慧树答题脚本与 GitHub Pages 发布的全流程，方便后续学期或同类智慧树新形态课程直接复用。

---

## 目录结构

```text
nwafu-engforge-2026/
├── DESIGN.md                        # Apple 极简画廊风格设计规范
├── index.html                       # GitHub Pages 静态主页
├── assets/
│   ├── styles.css                   # 严格遵循 DESIGN.md 的样式表
│   ├── app.js                       # 题库检索、筛选与一键复制交互
│   └── q-images/                    # 本地镜像的 4 张题干配图 PNG
├── raw/
│   └── homeworks-sanitized.json     # 脱敏后的智慧树原始作业接口数据（不含学生隐私）
├── data/
│   ├── questions.json               # 清洗构建后的完整静态题库（供网页与独立脚本使用）
│   └── ocs-config.json              # 纯前端免后端 OCS AnswererWrapper[] 配置
├── userscript/
│   ├── engforge-zhs.user.js         # 独立智慧树自动答题油猴脚本
│   └── engforge-zhs.meta.js         # 油猴自动更新元数据
├── scripts/
│   ├── scrape-zhs.mjs               # Chrome CDP 作业解析抓取脚本（自动脱敏）
│   ├── analyze-homeworks.mjs        # 固定卷 vs 随机抽题法证分析脚本
│   ├── build-data.mjs               # 原始数据清洗与产物构建脚本
│   └── verify-all.mjs               # 隐私/安全/OCS 297题全量回归验证脚本
└── docs/
    └── WORKFLOW.md                  # 本开发复用文档
```

---

## 1. 题目采集流程（Chrome CDP）

2026 年西北农林科技大学《工程训练》运行在知到智慧树新形态课程平台：

- 课程作业列表页：`https://ai-smart-course-student-pro.zhihuishu.com/singleCourse/taskAndExam/...`
- 作业解析与作答页：`https://examloop.zhihuishu.com/exam/{examTestId}/{courseId}/{mode}/{examPaperId}`（`mode=1` 为答题模式 `EDIT_MODE`，`mode=2` 为解析预览模式 `REVIEW_MODE`）

核心后端只读接口（浏览解析页时由页面自动发起）：

- `openExamDetail`：返回试卷元数据，包含关键字段 `examPaperType`（`"ASSIGN"` 表示教师固定组卷，`"RANDOM"` 表示随机抽题）、`paperId`、`totalScore`、`questionNum`。
- `getAnswerSheetInformation`：返回完整答题卡大题分组与全部 `questionId`。
- `getExamQuestionInfo`：返回单道题的 HTML 题干、题型、选项列表 `optionVos` 及正确答案标记 `isCorrect`。

### 复现采集步骤

1. 使用独立用户目录启动带远程调试端口的 Chrome（避免与日常浏览器冲突）：
   ```bash
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
     --remote-debugging-port=9222 \
     --user-data-dir=/tmp/engforge-chrome-profile \
     --no-first-run \
     "https://www.zhihuishu.com/"
   ```
2. 在弹出的浏览器窗口中登录账号，进入课程「任务·作业·考试 → 作业 → 已完成」。
3. 运行自动抓取脚本（需 Node.js ≥ 22，原生支持 `fetch` 与 `WebSocket`，零第三方依赖）：
   ```bash
   node scripts/scrape-zhs.mjs
   ```
   脚本会逐个打开每份作业解析页并翻阅答题卡中的所有题目，自动剥离 `studentName`、`studentCode`、`userAnswerVo`、`traceId` 等所有个人隐私字段后写入 `raw/homeworks-sanitized.json`。

---

## 2. 固定卷 vs 随机抽题核验

运行分析脚本：

```bash
node scripts/analyze-homeworks.mjs
```

2026 级工程训练核验结论：

1. **接口标志**：全部 11 项作业的 `examPaperType` 均为 `ASSIGN`（固定指定试卷），且 11 份作业卷面满分总和恰好等于 **100.0 分**（共 **297 题**，无重复 `questionId`）。
2. **`questionId` 分布**：绝大多数作业的 `questionId` 为连续自然数区间（0 空缺或仅 1 处老师删题空缺），展示顺序被打乱（`inIdOrder=false`），部分批次题干自带原序号（如 `(1)..(11)`、`1..12`）亦完整连续。
3. **结论**：所有同学拿到的均为完全相同的 297 道题，仅开启了题目乱序/选项乱序，并非从更大题库随机抽题。

---

## 3. 填空客观题清洗原则与实测批阅规则

> 作业仅有一次作答机会，清洗的首要原则是 **100% 一次判对**，其次才是贴近正常人的书写习惯。

根据已完成作业的真实批阅结果，智慧树「填空客观题（自动批阅）」的实际判分规律如下：

| 场景 | 真实提交样本 | 标准答案 | 实测得分 | 结论 |
|---|---|---|---|---|
| 相似度不足（略写/改写） | `围栏` vs `安全围栏`（50%） | `安全围栏` | **0 / 0.6** | 自动批阅相似度阈值较高，短词删字极易 0 分 |
| 相似度不足（略写） | `顶尖` vs `双顶尖`（67%） | `双顶尖` | **0 / 0.6** | 67% 仍会判错 |
| 相似度不足（多字） | `互换装配法` vs `互换法`（60%） | `互换法` | **0 / 0.6** | 不可随意加减词缀 |
| 高相似度（1 字差异） | `排屑和输送切削液` vs `排屑和输送冷却液`（87.5%） | `排屑和输送冷却液` | **0.6 / 0.6** | 仅极高相似度（约 ≥85%）才放行 |
| 无序并列多空（`；` 分隔） | `顺向` / `交叉` / `推` | 3 空均存 `顺向；交叉；推` | **0.6 / 0.6** | 中文分号 `；` 是官方等价/同义答案分隔符，拆开填各词 100% 满分 |
| 单空列举改标点 | `螺纹连接、键连接、销连接` | `螺纹连接；键连接；销连接等` | **0.4 / 0.6（该空 0 分）** | 单空含 `；` 不可擅自改标点或省略 `等` |

### `scripts/build-data.mjs` 中的清洗规则

1. **自动拆分无序并列多空（7 题）**：当 `k` 个空共享同一组由 `；` 分隔的 `k` 个词条时（包括顺序置换），拆分为每空独立填写 1 个词条，杜绝把整段带分号的串重复填 2～4 遍的异常现象：
   - `1014775317`（焊接）：药皮 3 个作用拆为 3 空独立作答
   - `1014779841`（钳工）：锥柄 2 个作用拆为 `夹持固定`、`定心并传递轴向力和扭矩`
   - `1014779840`（钳工）：拆为 `顺向`、`交叉`、`推`、`内螺纹`、`外螺纹`
   - `1014779838`（钳工）：拆为 `加工界限`、`平面`、`立体`
   - `1014780966`（锻压）：4 个制坯模膛拆为 `拔长模膛`、`滚压模膛`、`弯曲模膛`、`切断模膛`
   - `1014781312`（锻压）：拆为 `退火`、`正火`、`淬火`、`回火`
   - `1014780958`（锻压）：拆为 `氧化`、`脱碳`、`过热或过烧`
2. **单空同义词精选（1 题）**：
   - `1014684444`（特种加工）：`"CO₂；二氧化碳"` → `"二氧化碳"`（命中分号拆分项，避免下标字符和整串同义表照抄）。
3. **保守保留单空括号补充说明（4 题，优先保证一次满分）**：
   - `1015147369`（铸造）：`"缩孔 (缩松)"`（删括号仅剩 50%，参考 `围栏`/`顶尖` 实测有高判错风险）
   - `1014775318`（焊接）：`"酸性焊条（钛钙型药皮）"`（删括号仅剩 44%）
   - `1014779841`（钳工）：`"钻套（或过渡锥套）"`（删括号仅剩 28%）
   - `1014775317`（焊接）：拆分后的 3 空保留各自括号（删括号后最短仅剩 25%）
   - `1014673740`（装配）：单空 `"螺纹连接；键连接；销连接等"` 保持原样（改写已实测 0 分）

若后续测试确认平台对括号项放宽，只需调整 `scripts/build-data.mjs` 中的清洗函数并重新构建即可。

---

## 4. 纯前端 OCS 题库配置原理

通过阅读 `ocsjs/ocsjs` 源码（`defaultAnswerWrapperHandler`、`request.ts`、`answer-wrapper-security.ts`）确认：

1. OCS 的 `handler(responseData)` **只接收响应体，不接收 `env.title`**；
2. 静态 GitHub Pages 不支持服务端动态检索，且按完整题干作为文件路径容易受 `/`、长文件名限制和空格差异影响；
3. 利用 `url: "data:text/plain;charset=utf-8,${title}"` 搭配 `type: "fetch"` + `contentType: "text"`：
   - OCS 替换 `${title}` 为 `encodeURIComponent(title)` 后，浏览器原生 `fetch()` 直接零延迟本地回显解码后的原题干给 `handler(res)`；
   - `handler` 内部携带归一化索引（297 题总配置仅约 56 KB），支持精确归一化、去题号前缀、去图片 URL（适配 4 道配图题）和 Bigram Dice 模糊匹配；
   - 多空/多选答案使用 OCS 第一优先级分隔符 `===` 拼接，防止答案内容中的 `；` 被误拆分；
   - 严格避开 OCS `answer-wrapper-security.ts` 全部 `DANGEROUS_PATTERNS` 与 `\u` 字符串转义检测，实现 **0 安全警告**；
   - `type: "fetch"` 不受标准版 OCS `@connect` 白名单拦截（在 `examloop.zhihuishu.com` 真机 Chrome 中实测 297/297 全部通过）。

---

## 5. 独立脚本与构建校验命令

独立脚本 `userscript/engforge-zhs.user.js` 基于 OCS `zhs.ts` 的 `smartExam` 与智慧树 `examloop.zhihuishu.com` 四个 Vue 3 题型组件（`QuestionSingleChoice` / `QuestionMultipleChoice` / `QuestionJudge` / `QuestionFillBlankObjective`）精确适配：

- 自动区分 `EDIT_MODE`（`/exam/.../1/...`）与 `REVIEW_MODE`（`/exam/.../2/...`）；
- 填空框通过原生 `HTMLInputElement.prototype.value` setter + `input`/`change` 事件驱动 Vue 3 `v-model` 与 `answer-change` 自动保存；
- 从 `https://mjy.js.org/nwafu-engforge-2026/data/questions.json` 拉取最新静态题库并本地缓存，不自动交卷。

### 一键构建与全量验证

```bash
# 1. 从脱敏原始数据重新生成 data/questions.json 和 data/ocs-config.json
node scripts/build-data.mjs

# 2. 运行全量校验（隐私脱敏、清洗规则、OCS 安全扫描 0 警告、297/297 题 OCS 仿真、脚本语法与配图）
node scripts/verify-all.mjs

# 3. 组卷与题号法证分析
node scripts/analyze-homeworks.mjs
```
