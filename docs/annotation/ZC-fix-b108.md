# ZC-FIX-B108（6 文件 / 34 处命中）

> B108 命中全部清完；同一文件多处一次改完。
> 基线：`d:\code\_annot_baseline\ZC-fix-b108\orig`。
> 改写只删本工程新增的注释行；上游原有注释（HEAD 已存在）逐行保留。

## 1. 验收输出

```text
SUMMARY files=6 rewrittenSegments=35 deletedOwnCommentLines=138 codeTokenDiff=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0
```

三项单独计数：`rewrittenSegments=35`、`deletedOwnCommentLines=138`、`codeTokenDiff=0`。

## 2. 分文件计数

| 文件 | 改写段 | 删自有注释行 | numstat（对基线） |
| --- | ---: | ---: | --- |
| `apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-flags-file.ts` | 6 | 24 | +6 / −24 |
| `apps/zcode-cli/packages/core/src/tool/handlers/off-peak.ts` | 6 | 25 | +6 / −25 |
| `apps/zcode-cli/packages/ios-simulator-plugin/src/mcp/server.ts` | 4 | 14 | +4 / −14 |
| `apps/zcode-cli/packages/office-runtime/ui/viewers/DocxView.tsx` | 7 | 27 | +7 / −27 |
| `packages/ui/src/settings/model-provider-section/ProviderTemplatePicker.tsx` | 6 | 24 | +6 / −24 |
| `packages/ui/src/ToolCallBlocks/renderers/list-workflow-runs.tsx` | 6 | 24 | +6 / −24 |
| **合计** | **35** | **138** | **+35 / −138** |

## 3. 改写要点

### bash-readonly-policy-flags-file.ts

- `FD_SAFE_FLAGS`：不收录 `-x/--exec`、`-X/--exec-batch`，argv 层查不到即判写；其余只放纯查询/格式化项。
- `SORT_SAFE_FLAGS`：`-o/--output` 缺席即判写；表内保留 `-k/--key`、`-t/--field-separator`、`-s/--stable`，`-c/--check` 只校验。
- `BASE64_SAFE_FLAGS`：`-d/--decode`、`--ignore-garbage`、`-w/--wrap`、`-i/--input` 只读，结果仍写标准输出。
- `SHA_SUM_SAFE_FLAGS`：`-c/--check` 只读清单，`-b/--binary`、`-t/--text` 只改读取方式，`--strict` 失败不写文件。
- `DATE_SAFE_FLAGS`：`-d/--date`、`-r/--reference`、`--iso-8601` 不改系统时钟；`-s/--set` 缺席。
- `HOSTNAME_SAFE_FLAGS`：只收 `-A/--all-fqdns`、`-I/--all-ip-addresses`、`-d/--domain`；`-F/--file`、`-b/--boot` 缺席。
- 上游原有的 2/1/1/2 行排除说明原位保留，自有注释只补充 argv 层判定与 insert 行内容。

### off-peak.ts

- `assertNotOffPeakTurn`：只读 `context.offPeakTurn`，`recoverable` 默认 `false`，上下文只带 `toolCallId`/`toolName`。
- `assertOffPeakPort`：`asserts` 收窄，缺失抛 `CoreErrorType.ConfigurationError`。
- `throwOffPeakCreateFailure`：按 `errorCategory`/`errorCode` 分支，写入 `failureStage`。
- `offPeakCreateHandler`：`assertNotOffPeakTurn` → `schema.parse` → `assertOffPeakPort`，固定 `sessionId: context.sessionId`。
- `offPeakListHandler`：只校验结构，`list()` 结果不二次排序。
- `offPeakPermission`：固定 `medium`/`workspace`，`needsApproval` 时禁用按工具名永久放行。

### ios-simulator-plugin/src/mcp/server.ts

- `McpServer`：`name`/`version` 决定客户端插件身份，模块加载时创建一次。
- `ios_build_and_run`：`{ ...build, launchArgs }` 复用 schema，链路由 `guard` 收敛。
- `guard`：统一 try/catch，只取 `err.message`，非 Error 用 `String(err)`。
- `file(raw)`：绝对路径放行，相对路径经 `inside(process.cwd(), raw)` 防穿越。

### office-runtime/ui/viewers/DocxView.tsx

- `elementsFor`：`parseLocator("docx", at)` 分支，段落区间、整表、单元格越界回退，找不到返回 `[]`。
- `fixSymbolBullets`：只改 `styles` 内 `<style>` 文本，`SYMBOL_BULLETS` 映射，`next === text` 不写回。
- `rowsOf`：`row.closest("table") === table` 过滤嵌套表。
- `DocxView`：`scrollRef`/`bodyRef`/`styleRef`，`zoom.mode`、`natural`、`callbacks.current` 每帧同步。
- `renderAsync`：分页/页眉页脚/脚注开启，批注修订关闭，页数 `Math.max(1, ...)`。
- `annotate`：`P` 与 `H1-H6` 块级锚点，`TABLE` 整表一个锚点。
- `useLayoutEffect`：按 `scale / previousScale.current` 换算滚动位置。

### ProviderTemplatePicker.tsx

- `zhipuIds`：四个模板 id 与 `flatMap` 顺序；只做展示归类。
- `groups`：`zhipu` 保持 `zhipuIds` 顺序，`other` 保留服务端顺序。
- `createWithFeedback`：先 `dismissFeedback`，`catch` 里 `logger.error` + `showFeedback`，`retry` 复用闭包。
- `groups.map`：`testId(...)` 生成测试标识与 key，`creating` 统一传入。
- 自定义卡 `onClick`：`createWithFeedback(() => onCreateCustom(customLabel))`，`void` 显式忽略 Promise。
- `ProviderTemplateCard`：受控展示，`disabled`/`onClick` 直传，`icon` 容器 `shrink-0`。

### ToolCallBlocks/renderers/list-workflow-runs.tsx

- `LIST_WORKFLOW_RUNS_TOOL_ICON`：模块加载时创建一次。
- `ListWorkflowRunsToolCallBlock`：`primaryText` 依赖 `[countLabel, emptyLabel, runCount]`。
- `primaryText`：`runCount === 0` 用 `emptyLabel`。
- `renderContent`：结构化优先，`truncated` 追加说明，`fallbackText` 为空返回 `undefined`。
- `hasDetails`：结构有 run 或纯文本非空才可展开。
- `ListWorkflowRunsBody`：空列表用 `listRuns.empty`，key 用 `run.runId`，状态由 `run.status` 派生。

## 4. 质量修正记录

`ProviderTemplatePicker.tsx` 原有 4 行注释被插入在 JSX 子节点位置（`<div className="space-y-6">` 之后），在 JSX 中会作为文本节点渲染出可见的 `// ...`。本次把这 4 行删除，并在 `return (` 之前补写一条真正的 JS 注释 `groups.map ...`。删除行均为本工程新增行，代码 token 比对仍为 0；同时消除了界面上的错误文本。
