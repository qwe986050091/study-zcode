# FIX-B118 注释被插进 JSX 渲染位（跨仓库 AST 检测 + ZCode 全量删除）

> 这不是注释质量问题，是功能缺陷：`//` 写在 JSX 子节点位置时不是注释，而是 `JsxText`，
> 会被 React 原样渲染成页面可见文本。
> 判定只走 TypeScript AST，不做文本猜测；检测工具 `_annot_baseline/zx-jsx-comment.mjs`。
> 覆盖四个仓库：ZCode（`packages/**` + `apps/**`）、claude-code-main、gemini-cli、mobx。
> 用户口述为「五个仓库」，实际只给出这四个仓库名；ZCode 的 packages/apps 按同一仓库统计。

## 1. 判据

| 类 | 判定 | 含义 | 处置 |
| --- | --- | --- | --- |
| A | `JsxText` 节点内，某行 trim 后以 `//` 开头 | 注释被当文本渲染，**功能缺陷** | 删除该行 |
| A2 | `JsxText` 行内出现 `//`（排除 `://` 协议） | 同一缺陷的行内变体，如「文字 // 说明」 | 报告，人工确认后删 |
| B | `JsxExpression` 没有任何表达式、且容器内是 `//` 行注释（`{// ...\n}`） | 写法脆弱：`}` 若同行会被注释吞掉变语法错误 | 只报不改 |

- `{/* ... */}` 是合法惯用写法（块注释、不产生输出），**不计入 B**。
- 解析失败的文件不猜测：文件级 fail-closed 记录 `parseErrorFiles`，本仓库为 0。
- 每处命中额外标注 `added`：该行是否为相对 git HEAD 的新增行。四仓库命中全部为 `added=true`，
  即全部由本注释流水线的历史批次写入，不是上游代码。

## 2. 全量结果

| 仓库 | `.tsx/.jsx` 文件 | A 行 | A 文件 | A2 | B | 解析失败文件 | A 新增/上游 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| ZCode | 1,023 | **891** | **120** | 0 | 0 | 0 | 891 / 0 |
| gemini-cli | 424 | **164** | **47** | 0 | 0 | 0 | 164 / 0 |
| claude-code | 552 | 0 | 0 | 0 | 0 | 0 | — |
| mobx | 29 | 0 | 0 | 0 | 0 | 0 | — |

合计 **1,055 行 / 167 文件**。B 类另做旁证：四个仓库 `{\s*//` 文本检索均为 0 处，与 AST 结论一致。

claude-code 有 35,290 条 `^\s*//` 注释行，但 AST 判定的 `JsxText` 命中为 0 —— 说明该仓库历史批次的注释
都落在函数体/表达式内，没有越界到 JSX 子节点。mobx 的批次清单本身只覆盖 `.ts`，29 个 `.tsx` 未参与过注释。

## 3. ZCode：批次归属（说明「当初这些批次曾把注释插进 JSX 渲染位」）

85 个批次里 65 个有命中，按命中行数降序（完整清单见 `zx-jsx-comment.json` 的 `batches`）：

| 批次 | 命中行 | 批次 | 命中行 | 批次 | 命中行 |
| --- | ---: | --- | ---: | --- | ---: |
| ZC-deep-b16 | 84 | ZC-deep-b49 | 27 | ZC-deep-b80 | 24 |
| ZC-deep-b15b | 64 | ZC-deep-b72 | 27 | ZC-deep-b65 | 24 |
| ZC-deep-b57 | 40 | ZC-deep-b62 | 25 | ZC-deep-b87 | 24 |
| ZC-deep-b66 | 35 | ZC-deep-b68 | 29 | ZC-deep-b64 | 20 |
| ZC-deep-b70 | 31 | ZC-deep-b67 | 29 | ZC-deep-b58 / b51 | 19 / 19 |
| ZC-deep-b46 | 28 | ZC-deep-b73 / b60 / b101 | 17 × 3 | ZC-deep-b47 / b78 | 16 / 16 |

其余 43 个批次合计 190 行（单批 ≤14）。头部 `ZC-deep-b16`、`ZC-deep-b15b` 两批就占 148 行（16.6%），
且正是「每文件插 10–25 行」的高密度阶段 —— 与注水高发区间 B1-180 重合。

文件维度前 8（共 120 文件，27 个文件 ≥10 行）：

| 文件 | 行 | 文件 | 行 |
| --- | ---: | --- | ---: |
| `packages/ui/src/RemoteConnectionFields.tsx` | 36 | `packages/ui/src/ToolCallBlocks/ToolCallBody.tsx` | 21 |
| `packages/ui/src/settings/usage-stats/CodingPlanUsagePanel.tsx` | 33 | `packages/ui/src/MessageChangeSummaryPanel.tsx` | 19 |
| `packages/ui/src/settings/SkillsSection.tsx` | 32 | `packages/ui/src/WorkspaceHeader.tsx` | 17 |
| `packages/ui/src/BotsDialog.tsx` | 28 | `packages/ui/src/GitPaneChangeCard.tsx` | 16 |
| `packages/ui/src/components/workflow-timeline/WorkflowSaveFields.tsx` | 24 | `packages/ui/src/feedback/FeedbackScreenshotPicker.tsx` | 16 |

典型现场（`webRemoteControlConnectionSheet.tsx:145`，已删）：

```tsx
<ul>
  // 版本号存在则显示 ZCode 加版本，否则只显示 ZCode。
  // 启动时间经本地化相对时间格式化后展示。
  // 尾部截取连接标识后六位，便于人工区分同机实例。
  //
  {device.onlineConnections.map(...)}
```

这四行不是注释，是 `<ul>` 的第一个文本子节点，会渲染在列表顶部。

## 4. ZCode 修复：ZC-fix-b118（120 文件 / 891 行）

按文件聚合，一个文件一次改完；每行删除前断言 trim 后以 `//` 开头（fail-closed），
快照落在 `_annot_baseline/ZC-fix-b118/orig/**`，清单 `_files.txt`，逐文件计数 `_jsx-fix.json`。

```
node zc-verify.mjs --rewrite ZC-fix-b118
SUMMARY files=120 rewrittenSegments=319 deletedOwnCommentLines=891 codeTokenDiff=0 headTokenDrift=0
        codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0
        starSlash=0 syntaxErrorFiles=0
```

`deletedOwnCommentLines=891` 与检测命中数逐行相等；`codeTokenDiff=0` 是安全的根因 ——
`zc-verify` 的代码 token 流本就把 `JsxText` 中以 `//` 开头的行剔除，删它们不改代码 token。

删除前后复扫（同一 120 文件集合）：

| 指标 | 删除前 | 删除后 |
| --- | ---: | ---: |
| `addedCommentLines` | 9,990 | 9,099（−891） |
| `waterLines` | 1,878 | 1,587（−291） |
| `waterRate` | 18.80% | 17.44% |
| `zx-jsx-comment` A 类 | 891 | **0** |

注水率只降 1.36 个百分点：891 行里仅 291 行被注水判据命中，其余 600 行本身带谓词/锚点，
但**无论内容质量如何，位于 `JsxText` 就必须删**。这 891 行不计入「清注水」业绩，单独记账（bug 修复）。

### 4.1 归因：不是注水，是位置错误

600 / 891（67%）的行内容合格——有谓词、有后果、有标识符，放进普通语句块完全成立；它们唯一的问题是被
放进了 JSX children。根因在插入脚本：选锚点时只找"最近的代码行"，没有判"这个位置是不是 JSX 子节点"，
注释就顺着缩进插到了 `<div>`、`<ul>`、`<>` 的文本位置。所以这是一次**位置错误**，不是水率问题，
用注水判据重扫只能抓到其中三分之一，必须用 AST 的 `JsxText` 判定才完整。

已落地的根因防线（本轮）：

- `zc-gate.mjs` 新增 `scanJsxTextComments()`（AST，`JsxText` 内 `//`），并进 `gateInsertion()`；
  `zc-insert.mjs` 落盘前调用，命中即 `JSX_TEXT` 违规、整批不写盘；解析失败 fail-closed。
- 负向验证：临时 `<div><span>hi</span></div>` 夹具，锚定 `<span>hi</span>` 插一行 →
  `exit=1`、文件 MD5 不变、输出定位 `:3 JSX_TEXT`；正向对照（锚定 `export const X` 的声明行）→ `exit=0` 正常落盘。
- 硬约束已写进规范母本 `DEEP-SPEC.md` §5 第 7 条：插入点必须在语句/声明之前，不得落在
  JSX 子节点、字符串、模板字面量内部。

## 5. gemini-cli 清单（164 行 / 47 文件，未改动）

`d:\code\opensource\gemini-cli`，全部为历史批次新增行。按文件（前 12）：

| 文件 | 行 | 文件 | 行 |
| --- | ---: | --- | ---: |
| `packages/cli/src/ui/components/triage/TriageIssues.tsx` | 17 | `packages/cli/src/ui/components/messages/SubagentProgressDisplay.tsx` | 6 |
| `packages/cli/src/ui/components/EmptyWalletDialog.tsx` | 10 | `packages/cli/src/ui/layouts/DefaultAppLayout.tsx` | 6 |
| `packages/cli/src/ui/components/OverageMenuDialog.tsx` | 10 | `packages/cli/src/ui/components/AlternateBufferQuittingDisplay.tsx` | 5 |
| `packages/cli/src/ui/components/views/AgentsStatus.tsx` | 8 | `packages/cli/src/ui/components/AppHeader.tsx` | 5 |
| `packages/cli/src/ui/components/QuotaStatsInfo.tsx` | 7 | `packages/cli/src/ui/components/views/ExtensionsList.tsx` | 5 |
| `packages/cli/src/ui/components/Table.tsx` | 7 | `packages/cli/src/ui/components/views/ToolsList.tsx` | 5 |

其余 35 文件各 1–4 行，完整逐行清单：`_annot_baseline/zx-jsx-comment.json` 中
`results[repo=gemini-cli].hits[kind=A]`（含 `file/line/col/text/batches`）。

批次归属（21 批）：b42=19、b46=18、b90=18、b47=17、b43=12、b37=10、b29=9、b40=9、
b35=8、b48=8、b44=7、b36=6、b41=6、b65=6，b27/b32/b34/b39/b82 各 1，b33/b45/b60 各 2。

## 6. 工具

- `_annot_baseline/zx-jsx-comment.mjs`：四仓库全量 AST 扫描。
  `node zx-jsx-comment.mjs [--only ZCode|claude-code|gemini-cli|mobx] [--json out.json]`
  输出控制台表 + JSON（`summary` / `batches` / `results.hits`）。ZCode 约 7–10s，四仓库约 15s。
- `_annot_baseline/zx-jsx-fix.mjs`：按检测 JSON 删 ZCode 的 A 类行并建批（默认 `ZC-fix-b118`）。
- 判定复用 `D:/code/ZCode/node_modules/typescript`（5.x），`ts.ScriptKind.TSX/JSX`，
  `sf.parseDiagnostics` 做语法 fail-closed。

## 7. 遗留

- gemini-cli 的 164 行按用户要求只出清单，未改代码；删除方式与 ZCode 相同（注释行删除 + `codeTokenDiff=0`）。
- claude-code / mobx 当前为 0，但检测器已纳入常规回归：任何 `.tsx` 批次落盘后应复跑一次。
- B 类（`{// ...}`）四仓库均为 0，未做改动；如后续出现，按「只报不改」处理，优先改成 `{/* */}`。
- 插入侧尚未加 AST 自检：`zc-gate.mjs` 目前只判注水，不判「注释是否落在 JSX 子节点」。
  建议把本检测器的 A 类判定并入落盘前自检（命中即整批不落盘），与注水门禁同一处拦截。
