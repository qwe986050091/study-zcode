# ZC-FIX-B114（清单 6 文件 / 实际改写 2 文件 / 37 处命中）

> 基线：`d:\code\_annot_baseline\ZC-fix-b114\orig`（改写前的当前工作树）。
> 上一回合在 20:28 建好快照后被打断：`featureSuggestedPrompts.ts` 与 `taskChangeSummary.ts` 已落盘，
> 其余 4 个文件未动，本索引为补写并复跑验收。
> 复跑时发现 1 处越界删除（`taskChangeSummary.ts` 里「Windows 路径大小写降级匹配」的那条**上游**注释被我们的两行解释替换），
> 已把上游注释原样放回、删去两行替身，`upstreamCommentDeleted` 归 0。

## 1. 验收输出

```text
SUMMARY files=6 rewrittenSegments=37 deletedOwnCommentLines=143 codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0
```

三项单独计数：`rewrittenSegments=37`、`deletedOwnCommentLines=143`、`codeTokenDiff=0`。
代码删除、上游注释删除、字符串字面量删除均为 0。

## 2. 分文件计数

| 文件 | 改写段 | numstat（对基线） |
| --- | ---: | --- |
| `packages/ui/src/v4/featureSuggestedPrompts.ts` | 29 | +60 / −110 |
| `packages/ui/src/lib/taskChangeSummary.ts` | 8 | +18 / −33 |
| `packages/ui/src/hooks/useBuiltinAgentCli.ts` | 0 | 未改动（顺延 FIX-B115） |
| `packages/ui/src/RemoteConnectionDialogContent.tsx` | 0 | 未改动（顺延 FIX-B115） |
| `packages/ui/src/settings/SettingsPageParts.tsx` | 0 | 未改动（顺延 FIX-B115） |
| `packages/ui/src/v4/replaceableConversationTransport.ts` | 0 | 未改动（顺延 FIX-B115） |
| **合计** | **37** | **+78 / −143** |

## 3. 改写要点

### featureSuggestedPrompts.ts

- 每条推荐的注释都改成「点名 `feature-…` 标识 + 插件名 + 不可反转的顺序 + 删掉后会出现什么」：
  例如 `feature-office-browser-economic-data` 要求统计时间、数据变化、个人解读分开并附官方链接；
  `feature-recvvsPdvcUwzl` 固定「补背景 → 核心观点与叙事 → 生成幻灯片」，顺序打乱会先生成结构再硬填内容。
- 失败路径显式写进注释：`feature-recvvsPdvcA0k8` 在插件未启用或权限缺失时先说明配置，
  删掉该分支会让日报凭空补进展；`feature-recvvsPdvciNsr` 要求无记录依据不补写。
- 合规底线单独点名：`feature-recvvsV4e4ivrd` 没有数据就留空而不是补估值、不给买卖建议；
  `feature-recvvsV4e4AtLY` 风险记录不等于违法结论。
- `feature-recvvsV4e4FqWU` 说明为何不写 `plugin` 字段：`prompt.cn` 同时含
  `plugin://wind`、`plugin://hexin`、`plugin://tianyancha`，绑定单一插件会让另两个源在 @ 补全里失效。
- `getRecommendedPromptPool` 注释点明：只按 `isOfficeMode` 过滤 `office/coding` 池，
  返回的是元素引用而不是副本，调用方原地修改会污染模块级 `featureSuggestedPrompts`。

### taskChangeSummary.ts

- `task?.changeSummary` 缺失或 `files.length === 0` 都返回 `null`：旧版本任务没有该字段，
  INV-01 要求「0 文件」摘要不得进入列表；守卫同时挡住「摘要已建但 `files` 未填充」的中间态，
  并写明不要在此补生成空摘要，否则下游「无摘要」分支变成死代码。
- `formatTaskTitleWithChanges` 的后缀固定为 `title (统计)`，括号与空格由本函数决定；
  `summary` 为空原样返回 `title`，不截断，长度交给调用方布局。
- `toWorkspaceRelativePath` 只对 `workspacePath` 去尾分隔符，`filePath` 保留原样：
  若也 trim 文件路径，目录级快照会被误判成父目录；大小写转换只发生在比较副本上，切片保留原始大小写。
- `formatTaskChangedFileLabel` 只拼 `> 0` 的 `file.added` / `file.removed`，两者都为 0 时只返回
  路径结果、不带尾随空格；顺序固定 `+added` 在前、`-removed` 在后；裁剪失败返回绝对路径属可接受降级。
- `buildPerTurnFileChangeMap` 只为 `turn.snapshots.length > 0` 建条目并存入 `turn` 引用；
  空快照轮次不写空数组，调用方按键存在性区分「无数据」与「无改动」（INV-04），同一 `turnIndex` 后者覆盖前者。
- `buildTaskChangeSummary` 的任务级口径：每个 `snapshot.path` 只保留首个 `beforeContent` 与末个 `afterContent`，
  行数差经 `computeLineChangeStat` 重算而不是累加单次补丁（INV-14）；`writeCount` / `lastTurnIndex` 原样带出；
  路径不做大小写归一，同一文件的不同写法会算成两个条目。

## 4. 断点核对与顺延

- 复跑命令：`node zc-verify.mjs --rewrite ZC-fix-b114`（首次非零退出，修好后全绿）。
- 首次命中：`UPSTREAM COMMENT DELETED: packages/ui/src/lib/taskChangeSummary.ts ::
  // Windows 路径在不同来源下大小写可能不一致，这里做一次只用于比较的降级匹配。`
  该行在 `git show HEAD:packages/ui/src/lib/taskChangeSummary.ts` 中存在，不是本工程新增行，已原样恢复。
- 其余 4 个文件在快照之后没有任何写入（对基线 `numstat` 为空），不存在「已插入未写索引」的反向遗漏；
  它们连同各自命中数顺延到 FIX-B115：`useBuiltinAgentCli.ts`(43)、`RemoteConnectionDialogContent.tsx`(53)、
  `SettingsPageParts.tsx`(18)、`replaceableConversationTransport.ts`(13)。
