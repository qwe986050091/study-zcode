# ZC-deep-b319

> 批次：b319 ｜ 44 行 / 4 文件 ｜ 提交 `43e5e313`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 无自清、无越界

- `scope` 首跑 `out_of_scope_edits=0`；`pool-diff` 首跑 `removed=44 added=0 allowed=49 auto_self_clear=0` PASS。
- 无 `SCOPE OUT`，本批不需要判据分歧登记。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/provider-node/src/zcode-builtin-download.ts` | 11 | 1 | 11 | 1 |
| `packages/shared/src/model-config.ts` | 11 | 1 | 11 | 1 |
| `packages/ui/src/App.tsx` | 11 | 1 | 11 | 1 |
| `packages/ui/src/ElicitationDialog.tsx` | 11 | 1 | 11 | 1 |
| **合计** | **44** | **4** | **44** | **4** |

- 四个文件均 `ownOut=0 upIn=0 upOut=1`：各留 1 行**池外上游** weak（本线无改写权限），
  分别是 `zcode-builtin-download.ts:106`、`model-config.ts:49`、`App.tsx:1187`、`ElicitationDialog.tsx:1055`，
  只记数、不动，不计入本批。
- 按 §6.1 浮动规模取 4 × 11 = 44 行。

## 2. 改动内容

- `zcode-builtin-download.ts`：`AbortController` 与 20_000 毫秒定时器的建立顺序、`AbortSignal.any` 合流、
  `stage` 从 `client-config` 推进到 `cdn`、`downloadUrl` 缺失返回 `null`、
  `readJson` 的 `throwIfAborted` 前置、`credentials: "omit"` / `redirect: "error"`、
  `bytes` 累加与 10_000_000 上限、`releaseLock` 与 `cancel` 的分工、
  `DownloadBoundaryError` 的边界定位、错误消息只含 `stage` 与 `reason`、`timedOut` 区分 `timeout` / `cancelled`。
- `model-config.ts`：`optionMapSchema` 的 `min(1)` 与 `compileModelOptionMap`、`addIssue` 转字段级问题、
  `error.message` 优先、`variableName` 的两种取值、`completeModelConfigDataSchema` 三块齐备、
  `enabled` 显式布尔、`properties` / `optionSpecs` 复用 complete 模式、三层 `.strict()`、
  类型全部 `z.infer`、公共合同只含数据。
- `App.tsx`：`useShortcutCommandLabel` 空串回退、`conversationFindMatchCount` 与 `conversationFindState` 分离、
  `searchResultHighlightRequest` 不持久化、完成回调只比 `requestId`、
  完成回调晚到的保留策略、`openFeedbackTickets` 取自 store、`platform.openCommunity` 自带 no-op、
  `handleOpenAutomationConsumed` 成对清空。
- `ElicitationDialog.tsx`：空 `questions` 合成单题、三种响应键只为非空答案写入、
  `getElicitationQuestionAdvanceKind` 只看题号、`isQuestionExpanded` 的 `max-md` 折叠、
  `customInputRef` 两处共用、`selectOption` 的草稿与推进、`submit` 不补选、
  `goNextPage` 的补选与不提交、纯函数只返回动作名、`onMouseEnter` 上报悬停、折叠内容区 `max-md:hidden`。

## 3. 门禁读数（十一闸）

```text
gate: PASS scope     n=0 plan=44 allow=0 diff_old=44 diff_new=44 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=43e5e313 files=4/4 numstat=44/44 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=44 added=0 allowed=49 auto_self_clear=0
gate: PASS order     n=0 total=313.0s controllable=214.0s
GATE ALL PASS batch=b319 sha=43e5e313
```

- 十一闸首跑全绿，无补跑。

## 4. 首轮命中与返修

- 首轮 **2 / 44 = 4.5%**，均为 `L`（`、`/`，` 过多）：
  `model-config.ts:150`、`ElicitationDialog.tsx:516`。
- 返修：两处各把一个逗号改为分号，`hits=0`；`record_runs=1`，闸外只跑 `judge-generic`，未重跑 `record`。

## 5. 自清（累计第 11 批无自清；本批 0 自动、0 人工）

- `removed=44`、`added=0`，消失集合与 plan 完全重合，`POOL-SELF-CLEAR.tsv` 无新增行。
- `auto_self_clear` 仍未首次生效（b313–b319 连续 0）。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b318 5,514` → `post-b319 5,470`（**−44** = 本批落笔，无自清），文件 `1,798 → 1,798`。
- **句子级口径（工程完成度）**：`done 5,197 / remain 2,224`，`5,197 + 2,224 = 7,421`，**70.0%**。
- **逐行口径（自足性，并列观测）**：`remain ≈ 2,224 + 1,046 = 3,270`，`done ≈ 4,151 / 7,421`，**约 55.9%**。
- 池外：`5,470 − 2,224 = 3,246` 行，**永久不排期**。
- 限定语（凡引用完成度处必须同段出现）：
  「句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期」。

## 7. 守卫与产能

- `GUARD` 15 文件：`pre=4 post=4 新增=0 max=8` → **PASS**。
- `capacity-estimate --batch b319`：`done files=375 (+4) / lines=5,197 (+44)`，
  `REMAIN 632 files / 2,224 lines`，`ALIGNED acct_remain=2224 pool_remain=2224 diff=0`，分档合计 317 批；
  `PARTIAL 3`（`cuaDetails.tsx` 1、`script-workflow-process.ts` 1、`CoveragePanel.tsx` 2）。
- `ledger-assert`：`ACCT files 375 + 632 = 1007`、`ACCT lines 5,197 + 2,224 = 7,421` → **PASS**。
- 白名单重跑到 `43e5e313`，**398 行**。

## 8. 复算命令

```powershell
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b318-repo-post.txt
node _annot_baseline/pick-generic.mjs b319 d:/code/_annot_baseline/b319-files.txt d:/code/_annot_baseline/b318-repo-post.txt
node _annot_baseline/gate-run.mjs --batch b319 --start
node _annot_baseline/judge-generic.mjs b319
node _annot_baseline/gate-run.mjs --batch b319 --subject "注释清水 b319：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b319-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b319-guard-post.txt
node docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b318-guard-post.txt --post d:/code/_annot_baseline/b319-guard-post.txt
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b319-repo-post.txt --pre-weak d:/code/_annot_baseline/b318-repo-post.txt --batch b319
node docs/annotation/_tools/ledger-assert.mjs d:/code/ZCode
```

## 9. 计时口径（b317 §10 / INDEX §6.2 的 b319 实例）

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单提交） | 批次提交 | 313.0s | 7.11s |
| `controllable` | `--start`（16:53:33） | 批次提交（16:57:07） | 214.0s | 4.86s |
| `批墙钟` | 本批第一个工具调用（16:51:13） | 台账提交（17:00:29） | 556s | 12.64s |

- `total` / `controllable` **含选行、读码、写文案与六道闸**，不含台账收口。
  两者都是「闸内段」，**不是产能**；跨批比较一律同时给 `批墙钟`。
- `批墙钟` 是唯一端到端读数，含白名单、候选、选行、dump、写作、判据返修与收口，
  只作量级参考，不据此推算 `1,046` 行的补句成本。

## 10. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，396 行） | `551efd17` | 2 文件 |
| b319 批次本体（4 文件 1→1 改写） | `43e5e313` | `+44/−44` |
| `ZC-deep-b319-rewrite.tsv` + 白名单 398 行 + 本台账 + INDEX 同步 | 见本批台账提交 | — |

- 收口判据：A1 `remain=2,224≠0` 未到；A2 `5,197 + 2,224 = 7,421` 成立；
  A3 `ledger-assert PASS`；A4 `5,197 落笔 + 0 池内自清 + 2,224 = 7,421` 成立。
- 后续：b320 插点做「逐行探针增量普查」，只测不修。
