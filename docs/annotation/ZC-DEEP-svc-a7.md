# ZC-DEEP-svc-a7：序列化兼容与用户文件回写

## 结果表

| 文件 | 代码行 | 内文率 前 → 后 | 净增注释行 |
| --- | ---: | ---: | ---: |
| packages/services/src/model-provider/legacyModelProviderSerialized.ts | 421 | 5.94% → 31.35% | +107 |
| packages/services/src/output-style/outputStyleService.ts | 162 | 14.81% → 36.42% | +35 |
| packages/services/src/session/fileChangeTracker.ts | 126 | 7.14% → 38.10% | +39 |
| packages/services/src/subagents/subagentMarkdown.ts | 336 | 9.52% → 41.96% | +109 |

函数级最低值 17.6%（`getModelProviderEndpointKinds`、`getDefaultModelSupportedFormatsFromEndpoints`），无函数低于 15%；文件级最低 31.35%。

另外改写 44 行历史水线（`git show HEAD:` 中不存在，属可改写范围）：20 行 L、24 行 W。全部保留原意，仅补足标识符/谓词锚点，未删任何上游注释。批量开始前 waterRate 为 13.25%，结束后为 0.00%。

## 补深方式

按「语句组/分支/字段」落笔，不写函数签名复述：

- `legacyModelProviderSerialized.ts`：旧 store 解码链路逐段说明——`reasoning.levels` 为何清空 patch、`contextWindow` 的 `typeof` + `Number.isFinite` 双检、`deleted !== true` 的严格比较、`openai`/`openai-compatible` 两组枚举语义交叉、`baseURL`+`paths` 的 origin 共享与 `suffixes` 剥离顺序、`providerMappings` 迁移即清理 claude 槽位。
- `outputStyleService.ts`：settings.json 回写的边界——`...(existingSettings)` 展开顺序保证只覆盖 `outputStyle`、`mkdir recursive` 的幂等性、id 前缀 `custom-` 与文件名反推、`rm force` 的删除幂等。
- `fileChangeTracker.ts`：首尾合并（`beforeContent` 取首次、`afterContent` 取末次）、`rewindOps` 的 null 语义、`fileState` 缺省 `applied`、`truncateAfterTurn` 与 fork/retry 的编号空洞。
- `subagentMarkdown.ts`：frontmatter 解析两层（loose → yaml）的优先级、块状列表 `pendingListKey` 游标、引号/括号深度计数、序列化侧 `appendScalar`/`appendUnknownList` 的取舍、损坏文件降级成 diagnostic 而非空 agent。

## 四条命令真实输出

```
$ node d:/code/_annot_baseline/zc-verify.mjs --rewrite ZC-deep-svc-a7
SUMMARY files=4 rewrittenSegments=37 deletedOwnCommentLines=45 codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0

$ node d:/code/_annot_baseline/zc-gate.mjs --scan d:/code/_annot_baseline/ZC-deep-svc-a7/_files.txt
SUMMARY files=4 badFiles=0 addedCommentLines=622 waterLines=0 waterRate=0.00%

$ node d:/code/_annot_baseline/zc-inner.mjs --repo D:/code/ZCode --roots packages/services/src --only <4 files> --threshold 15 --fns 30
SUMMARY files=4 innerCode=1045 innerZh=380 below15=0 min=31.35 median=38.10
31.35% 132/421 legacyModelProviderSerialized.ts
36.42%  59/162 outputStyleService.ts
38.10%  48/126 fileChangeTracker.ts
41.96% 141/336 subagentMarkdown.ts

$ node d:/code/_annot_baseline/deep-quality.mjs D:/code/ZCode --files <4 files> --quiet --top 20
SUMMARY files=4 units=854 coverage=35.1% branch=38.9% field=8.6% comments=760 substance=85.1% explain=98.9% filler=0.0% weak=1.1%
```

`zc-insert` 落盘：67 + 25 + 30 + 63 块，共 290 行新增注释，一次通过插入侧门禁（首轮 18 行 L/W 已按判据改写后重跑）。

## 锚定不变量

1. anchor 必须与该行 `trim()` 后全文完全相等，不做前缀/模糊匹配；插入位置是锚点行之前，缩进自动继承锚点行。
2. 重复行一律显式给 `nth`（1-based）；同一 anchor 的多个条目必须落在不同下标，否则 `duplicate insert index` 整批拒绝。
3. 禁止锚在多行模板字符串、YAML 文本块或正则字面量内部：注释会变成字符串内容，`codeTokenDiff` 立刻非零。本批因此避开 `serializeSubagentMarkdown` 的返回模板与 `outputStyleService` 的 `content` 模板。
4. 任一锚点不匹配则整批不落盘（先全算后统一写），所以 spec 必须与当前磁盘内容同源。
5. 只允许 `//` 整行、且不得含 `*/`；verify 以「base 快照 vs 当前」比对，删除只允许 `git HEAD` 之后新增的注释行。

## 看似该改其实不能改

- `enabled: true`（subagentMarkdown）：看似应回读 frontmatter 的 `enabled`，但「md 存在即启用」是既定语义，禁用状态由 UI 独立维护；写入该键会与 runtime 的文件发现冲突。
- `...(existingSettings,` 浅展开（outputStyleService）：看似应改深合并，但浅展开正是「只覆盖 `outputStyle`、hooks/permissions 整键保留」的实现，深合并会把数组配置拼接成重复项。
- `beforeContent` 的 `null` 与 `""`（fileChangeTracker）：看似可统一成 null，但两者分别表示「新建文件待删除」与「原为空文件待清空」，合并会让 rewind 误删空文件。
- 三处 `return "openai-compatible"`：分属 supported-format 映射、默认 kind 推导、apiFormat 反向映射，看似可抽公共函数，合并会把三条语义不同的分支绑死。
- `resolveModelProviderBaseUrl` 里 `kind` 由 apiFormat 推导：看似该读 `defaultKind`，但该函数要回答「当前实际使用的协议」，`defaultKind` 只是偏好。
- `nonEmptyList`、`formatBody`、`isObjectRecord` 等 1~2 行工具函数：注释会退化成函数名复述，且不参与 15% 判定（代码行 < 5），按「不注水」要求放弃。
