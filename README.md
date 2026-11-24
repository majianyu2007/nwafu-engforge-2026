# EngForge

**Engineering Training Question Bank** — 西北农林科技大学 2026 年 11 月开展的工程训练智慧树课程题库。

- **在线站点**：[https://mjy.js.org/nwafu-engforge-2026/](https://mjy.js.org/nwafu-engforge-2026/)
- **静态题库 JSON**：`https://mjy.js.org/nwafu-engforge-2026/data/questions.json`
- **OCS 题库配置（完整离线版）**：`https://mjy.js.org/nwafu-engforge-2026/data/ocs-config.json`
- **OCS 题库配置（在线精简版）**：`https://mjy.js.org/nwafu-engforge-2026/data/ocs-config-online.json`
- **独立自动答题脚本**：`https://mjy.js.org/nwafu-engforge-2026/userscript/engforge-zhs.user.js`
- **开发与复用指南**：[docs/WORKFLOW.md](./docs/WORKFLOW.md)

## 题库概览

收录全部 11 个工种作业共 **297 道原题**（卷面满分合计 **100.0 分**），经验证全部 11 份作业均为固定组卷（`examPaperType: "ASSIGN"`，仅开启题目乱序），覆盖率 100%：

- 单选题：111 题
- 多选题：6 题
- 判断题：64 题
- 填空客观题（自动批阅）：116 题（含 4 道配图题；已对 8 道多空重复/同义词分号题完成自然作答清洗）

## 使用方式

1. **接入现有 OCS 网课助手**：打开主页按需切换并一键复制 OCS 题库配置，粘贴到 OCS「通用 → 全局设置 → 题库配置（自定义题库）」保存即可：
   - **完整离线版**（`ocs-config.json`）：297 题内联本地匹配，零网络请求、0 安全警告。
   - **在线精简版**（`ocs-config-online.json`）：仅约 2 KB，每答一题向本站请求一次 `data/questions.json`，题库更新自动生效（OCS 保存时会弹一次 `document` 安全提示，点确认即可）。
2. **安装独立答题脚本**：打开主页点击「安装脚本」，通过 ScriptCat 或 Tampermonkey 安装精简版智慧树自动答题脚本，进入作业页点击悬浮窗「开始自动答题」即可（不自动交卷）。

## 仓库目录与维护命令

- `raw/homeworks-sanitized.json`：脱敏后的智慧树原始作业接口数据（已移除个人学号、姓名与作答记录）
- `scripts/scrape-zhs.mjs`：Chrome CDP 作业解析抓取脚本（自动脱敏，供后续复用）
- `scripts/analyze-homeworks.mjs`：固定卷/随机卷与题型法证分析脚本
- `scripts/build-data.mjs`：答案清洗与 `data/questions.json`、`data/ocs-config.json`、`data/ocs-config-online.json` 构建脚本
- `scripts/verify-all.mjs`：隐私脱敏、OCS 安全检测、297/297 题双模式 OCS 仿真与语法全量校验
- `docs/WORKFLOW.md`：完整开发流程、清洗依据与技术架构说明

```bash
node scripts/analyze-homeworks.mjs
node scripts/build-data.mjs
node scripts/verify-all.mjs
```

## License

MIT — 独立自动答题脚本基于 [OCSJS](https://github.com/ocsjs/ocsjs) 智慧树答题逻辑精简改编。
