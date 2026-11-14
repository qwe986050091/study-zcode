# ZC-DEEP-B218（4 文件，+120 行）

> 范围：MCP 连通性探测、引导流程 AGENTS 迁移步骤、插件 UI 工具投喂、侧栏任务动作适配（合计 447 代码行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b218\orig`；清单：`ZC-deep-b218-files.txt`。
> 目标密度 31%~32%，实际落点 31.52%~32.99%。

## 1. 验收输出

```text
[ok] packages/ui/src/lib/mcpStatusProbe.ts: 14 blocks, 30 lines
[ok] packages/ui/src/onboarding/OnboardingAgentsFileStep.tsx: 14 blocks, 30 lines
[ok] packages/ui/src/plugin-ui/domain/pluginUiToolFeed.ts: 14 blocks, 30 lines
[ok] packages/ui/src/project-sidebar/useProjectTaskActions.ts: 14 blocks, 30 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=120
TOTAL added=120 hardBad=0 suspicious=0
```

逐文件密度（`codeRatio` = 注释 ÷ 代码）：

```text
31.52% code=165 comment=52 packages/ui/src/plugin-ui/domain/pluginUiToolFeed.ts
32.26% code=93 comment=30 packages/ui/src/lib/mcpStatusProbe.ts
32.61% code=92 comment=30 packages/ui/src/onboarding/OnboardingAgentsFileStep.tsx
32.99% code=97 comment=32 packages/ui/src/project-sidebar/useProjectTaskActions.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/lib/mcpStatusProbe.ts` | 连通性探测 | 只读探测、类型推断、SSE/OPTIONS、2xx~4xx 可达、超时与 finally、缺 url、stdio 只校验命令、耗时口径 | 30 |
| `ui/src/onboarding/OnboardingAgentsFileStep.tsx` | AGENTS 迁移步骤 | 只读状态、supported 与 selected、loading 约束、错误条独立、整卡入口、透明勾选、路径回落、警告时机 | 30 |
| `ui/src/plugin-ui/domain/pluginUiToolFeed.ts` | 工具投喂 | 纯函数、未完成不产出、stopped 走 cancelled、内容数组优先、截断只写 _meta、三重匹配、引用稳定 | 30 |
| `ui/src/project-sidebar/useProjectTaskActions.ts` | 任务动作适配 | 不存事实、成功才刷新、失败统一 report、onPin 钩子、归档清理、已读时间戳、memo 依赖 | 30 |

## 3. 说明

- `mcpStatusProbe.ts` 原 0 注释（0.00%），块锚定超时常量、规整函数、command/url 推断、探测方法、可达区间、缺 url、超时器、fetch、错误文案、clearTimeout、stdio 校验、URL 分派。
- `OnboardingAgentsFileStep.tsx` 原 0 注释（0.00%），首行 `import {` 与第 8 行同名，用 `firstNth: 1` 锚定文件头；块锚定入口、supported、selected、扫描按钮禁用、加载图标、错误条、整卡禁用、点击切换、勾选框样式整行、两处路径回落、警告条件与图标。
- `pluginUiToolFeed.ts` 原 22 行（13.33%），块锚定输入读取、取消判定、空值早退、未完成早退、rawContent、内容数组、mergedMeta、isError 合并、surface 三重匹配、`(presentation.serverName !== binding.serverName ||`、rowId 前进、isError 过滤、末尾引用相等。
- `useProjectTaskActions.ts` 原 2 行（2.06%），块锚定入口、target memo、mutate、日志、toast、`await refresh();`（`nth: 1`）、onPin 分支、onPin 调用、pin 失败、归档取反、任务态清理、已读时间戳、返回值。
- 本批两次锚点不匹配：勾选框样式实际是整行 `className={...}` 模板串，binding 行首带 `(`；失败文件未落盘，修正后重插，`deletedNonZero=0`。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1850 needLines=26025 min=0.00 median=31.35
本会话范围 files=4562 coreBelow30=1846 needLines=21433
```

累计 1,378 文件 / 126,969 行。

## 提交回填（2026-11-10）

```text
ZC-deep-b218 | 提交 a8784b7e | numstat 114 0 | 门禁 未通过（现行 W/POEM/L 判据：waterLines=17 / 114）
```

口径与边界：

- **提交边界不代表批次边界。** 本批注释在安全快照 `a8784b7e` 里入库，与其余 1,700 余个文件同属一次提交，无法从提交历史还原批次边界。
- 门禁以 `8f7daaf0` 为基线重跑（`--base` / `--diff-base`），以复原落盘时的判据条件；若用 HEAD 作基线会得到 0 行假 PASS。
- 六件套原始 SUMMARY：

```text
deep-gate    SUMMARY files=4 badFiles=4 addedCommentLines=114 waterLines=17 waterRate=14.91% [exit!=1]
zc-verify    SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=114
code-tokens  SUMMARY files=4 codeTokenDiff=0
in-strings   SUMMARY files=4 scanned=4 stringRanges=155 violations=0 addedViolations=0
boilerplate  SUMMARY groups=0 lines=0 files=0 dups=0 dupLines=0 singles=0 mode=diff
upstream     SUMMARY files=4 checked=4 upstreamComments=139 missing=0
```

- 结论：**六件套未全通过**。waterLines=17 说明按现行判据仍有水句，需按 §2.16 逐行改写后重新门禁；本批状态为「已提交、门禁未通过」。
