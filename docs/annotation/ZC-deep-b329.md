# ZC-deep-b329

> 批次：b329 ｜ 40 行 / 4 文件 ｜ 提交 `b2057e5d`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 无自清、无越界；基准默认解析（未复制快照）

- `gate: PASS start ... pre-weak=b328-repo-post.txt`——基准由 `b{批号-1}` 默认规则解析，未复制任何快照。
- 六闸全部 PASS：`out_of_scope_edits=0`、`record_runs=1`、`numstat=40/40`、
  `pool-diff removed=40 added=0 allowed=46 auto_self_clear=0`。
- 首轮 1 hit（`L` 列举），返修后 `hits=0`；`git diff --stat` 始终 `40 insertions / 40 deletions`，无连带。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/lib/taskMainActivity.ts` | 10 | 0 | 10 | 0 |
| `packages/ui/src/mentions/nodes/mentionIconDom.ts` | 10 | 0 | 10 | 0 |
| `packages/ui/src/presentation/presentationPdfPrintExport.ts` | 10 | 0 | 10 | 0 |
| `packages/ui/src/settings/RemotePluginSyncDialog.tsx` | 10 | 0 | 10 | 0 |
| **合计** | **40** | **0** | **40** | **0** |

- 四个文件 `upOut=0`，批后 weak 全清零；文件数 1,769 → 1,765。
- 10 × 4 = 40，落在 33–44 浮动区间内。

## 2. 改动内容

- `taskMainActivity.ts`：`task_run_started`/`goal_iteration_started` 算激活、两个 chunk 事件要求 `event.content` 非空、
  `tool_call` 系列只认 `isMainAgentStreamEvent`、`default` 分支返回 `false`；
  `message.role`/`message.streaming` 两个前置条件、`isTaskChatTimelineMessage` 排除占位；
  `creating`/`restoring` 直接忙碌、`streaming` 同算、最后合并 `hasForegroundActivityFromMessages`。
- `mentionIconDom.ts`：`SVG_NS` 单点声明与复用、`tagName`/`attrs` 取自常量表、`satisfies` 拦错；
  三种基础图形标签是唯一允许值、`attrs` 为 `Readonly<Record<string, string>>`、`readonly` 双层不可变；
  `createElementNS` 建根、`appendChild` 生成子节点、返回 `root`。
- `presentationPdfPrintExport.ts`：`SYMBOL_PROBE` 取样范围、`PRINT_LOSSY_FONTS` 只收打印丢字字体、
  `normalizeFontFamily` 不调 `toLowerCase`、`isChineseLike` 的混排判据、`symbol` 分支优先、
  `fontFamilyForChinese` 只分 `serif`/`sans-serif`、`isFontAvailableForPrint` 的通用族名短路、
  通用族名不参与 `measureText`、`PRINT_STYLE` 的打印约定、`document.fonts` 的二次等待。
- `RemotePluginSyncDialog.tsx`：默认全选 `exists` 为假的项、无中断源时 `abortRef` 为空的短路、
  逐项再查 `stopRequested`、`pluginId` 重试不互相取消、`RemotePluginSyncTargetRow` 组成、
  `RemotePluginSyncSelectAll` 的 `checked`/`indeterminate`、`open` 转真时重新 `load`、
  `preflight` 的前置提示、`selectedIds` 与 `visibleRows` 的区分。

## 3. 门禁读数

```text
gate: PASS scope     n=0 plan=40 allow=0 diff_old=40 diff_new=40 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=b2057e5d files=4/4 numstat=40/40 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=40 added=0 allowed=46 auto_self_clear=0
gate: PASS order     total=132.0s controllable=119.0s
```

## 4. 首轮命中与返修

- 首轮 **1 / 40**：`presentationPdfPrintExport.ts:405` `L/无信息列举`——
  `含屏外承载与打印铺平，每页固定尺寸且末页不分页` 里「与」被计作列举连接词。
- 改为 `PRINT_STYLE 固定打印管线的全部约定，每页按固定尺寸铺平且末页不分页。` 后 `hits=0`。

## 5. 自清（累计第 19 批无自清；本批 0 自动、0 人工）

- `removed=40`、`added=0`，与 plan 完全重合，`POOL-SELF-CLEAR.tsv` 无新增（`allowed=46`）。
- 本批 `auto_self_clear=0`。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b328 5,141` → `post-b329 5,101`（**−40**），文件 `1,769 → 1,765`。
- **句子级口径**：`done 5,565 / remain 1,856`，`5,565 + 1,856 = 7,421`，**75.0%**。
- **逐行口径**：`remain ≈ 1,856 + 1,046 = 2,902`，`done ≈ 4,519 / 7,421`，约 **60.9%**。
- 池外：`5,101 − 1,856 = 3,245`，永久不排期。
- 限定语：「句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期」。

## 7. 守卫与产能

- `GUARD` 15 文件：`pre=4 post=4 新增=0 max=8` → **PASS**（pre 复用 `b328-guard-post.txt`）。
- `capacity-estimate --batch b329`：`done files=411 (+4) / lines=5,565 (+40)`，
  `REMAIN 596 files / 1,856 lines`，`ALIGNED acct_remain=1856 pool_remain=1856 diff=0`，分档合计 299 批；
  `PARTIAL 3` 不变（`cuaDetails.tsx:1`、`script-workflow-process.ts:1`、`CoveragePanel.tsx:2`）。
- `ledger-assert`：`411 + 596 = 1,007`、`5,565 + 1,856 = 7,421` → **PASS**（`ROLL` 144/658/802 全 0 剩余）。
- 白名单重跑到 `b2057e5d`，**437 行**（开批前 435 行 + 本批批次提交与开批白名单提交两条）。

## 8. 复算命令

```powershell
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b328-repo-post.txt
node _annot_baseline/pick-generic.mjs b329 d:/code/_annot_baseline/b329-files.txt d:/code/_annot_baseline/b328-repo-post.txt
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node _annot_baseline/gate-run.mjs --batch b329 --start
node _annot_baseline/judge-generic.mjs b329
node _annot_baseline/gate-run.mjs --batch b329 --subject "注释清水 b329：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b329-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b329-guard-post.txt
node d:/code/ZCode/docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b328-guard-post.txt --post d:/code/_annot_baseline/b329-guard-post.txt
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b329-repo-post.txt --pre-weak d:/code/_annot_baseline/b328-repo-post.txt --batch b329
```

## 9. 计时口径

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单 `4af7b282`，17:45:34） | 批次提交 `b2057e5d`（17:47:46） | 132.0s | 3.30s |
| `controllable` | `--start`（17:45:47） | 批次提交（17:47:46） | 119.0s | 2.98s |
| `批墙钟` | 本批最早可观测产物 `b329-files.txt`（17:45:38） | 台账提交 `c47e66c2`（17:48:48） | 190s | 4.75s |

- `controllable` 含读码、写作、apply 与六道闸，不含选行与台账收口；**不是产能**，跨批只认 `批墙钟`。

## 10. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，435 行） | `4af7b282` | 2 文件 |
| 批次本体（4 文件 1→1 改写） | `b2057e5d` | `+40/−40` |
| `ZC-deep-b329-rewrite.tsv` + 白名单 437 行 + 本台账 + INDEX 同步 | `c47e66c2` | — |

- 收口判据：A1 `remain=1,856≠0`；A2 `5,565 + 1,856 = 7,421` 成立；A3 `ledger-assert PASS`；
  A4 `5,565 + 0 + 1,856 = 7,421` 成立。
