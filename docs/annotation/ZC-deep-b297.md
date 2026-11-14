# ZC-deep-b297：7 文件 / 91 行（全池内，池外自清 2）

> 批次：b297 ｜ 提交 `d6cf1991` ｜ 代码 `+91/−91` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v13（`f02be471a849`）、
> `precheck-assert.mjs`（`--start` 实盘逐行基准的第九批）、
> `capacity-estimate.mjs`、`weak-guard.mjs`、`ledger-assert.mjs`。

## 0. 交代

1. 本批 7 文件 / **91 行，全部池内**（`ownIn=91 ownOut=0 upIn=0 upOut=5 pending=0 plan=91 allow=0`）。
   每文件 13 行；`upOut=5` 是同一批文件里 5 条上游 weak 行，本批不碰，`--allow` 留空。
2. 起笔前重跑 `own-commits-gen`（326 行 / `head=32eb42af`），白名单单独提交（`b994fa3a`）后才 `--start`
   （`2026-11-11T06:22:01.931Z`，7 文件 2,758 行实盘逐行基准）。
   **计时口径例外（同 b293–b296）**：映射先于 `--start` 起草，`controllable` 只覆盖「落笔 → 提交」，
   **不进入中位数**。
3. 流程：`--start` → `b297-apply.mjs`（1→1，`changed=91 same=0`）→ 判据预判（首轮 5 条 → 0）
   → `--scope` → `--record`（首跑即过，`record_runs=1`）→ `--verify` → `zc-commit v13` → `--order`。
4. 七行门禁：`expected=7 staged=7`，`+91/−91`；顺序断言
   `t-start 06:22:01.931 < t-record 06:23:45.161 ≤ t-verify 06:23:50.854 < commit 14:24:12+08:00`。
5. 第 8 行门禁第九批：`indentChanged=0 eolChanged=0`、`SAME 0`、`touched_restored=0`、
   `line_drift=0`。
6. 本批结束重生成白名单：**328 行 / `head=d6cf1991` / blob `d4d3d3d409a3`**（未提交，随台账一起入账）。

## 1. 计划表

| 文件 | 池内 | 池外 own | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/settings/offPeakUiPresentation.ts` | 13 | 0 | 13 | 0 |
| `packages/ui/src/ToolCallBlocks/renderers/save-workflow.tsx` | 13 | 0 | 13 | 0 |
| `packages/ui/src/app-shell/workflow-artifacts/WorkflowArtifactBody.tsx` | 13 | 0 | 13 | 0 |
| `packages/ui/src/components/workflow-timeline/WorkflowArtifactIndex.tsx` | 13 | 0 | 13 | 0 |
| `docs/knip/docs/scripts/get-monthly-sponsorships-opencollective.ts` | 13 | 0 | 13 | 0 |
| `packages/e2e-report/src/viewer/CoveragePanel.tsx` | 13 | 0 | 13 | 2（PARTIAL） |
| `packages/formal-proof/src/main.ts` | 13 | 0 | 13 | 0 |
| **合计** | **91** | **0** | **91** | **2** |

## 2. 批后池

```text
done files=283（+6）  remain files=724
done lines=4151（+89）remain lines=3270（−89）
ALIGNED acct_remain=3270 pool_remain=3270 diff=0
完成度 4151 / 7421 = 55.9%
```

- 写入 91 行，池内口径只前移 **89 行**，差额来自 **2 条新暴露的 weak**（见下），不是漏算：
  - `CoveragePanel.tsx:72` `[权衡] 元信息不展示时间戳，报告时间由页头统一负责`（无解释）；
  - `CoveragePanel.tsx:167` `[权衡] 不为复用再抽更小单元，四个卡片的差异仅在标签`（无解释）。
  - 机制：`deep-quality` 的 `sentenceUnit()` 会把「上一行没有句末标点」的相邻注释并成整句判定。
    本批把 69–71、164–166 改写成了带句号的完整句，句子边界前移，这两条 `[权衡]` 从「被合并进长句」
    变成「独立成句」，于是各自被判「无解释」。**这是改写的真实副作用，不是口径变化**；
    该文件因此转 PARTIAL（基线 13 → 现 2），2 行按池内剩余回池排期。
- **SELF-CLEAR 2（池外）**：`WorkflowArtifactIndex.tsx:57` / `:227`（blame `872ad960` 上游），
  由相邻改写转强；`capacity-estimate` 记为 `可写桶 0 / 池外 2 / 上游桶 0`。
- PARTIAL 3：`cuaDetails.tsx`（23 → 1）、`script-workflow-process.ts`（13 → 1）、
  `CoveragePanel.tsx`（13 → 2）。
- 全仓：`6613 → 6522`（−91 = 池内净前移 89 + 池外自清 2）；池外 `6522 − 3270 = 3252`，
  与 post-b296 的 3254 差 2，与自清 2 条一一对应，闭合。
- 档位分布：`>=20` 0，`10-19` 125 文件 / 1,418 行，`5-9` 141 / 931，`3-4` 158 / 539，`1-2` 300 / 382。
- `done 4,151` 的台账口径：**「已写入 4,151 行，其中 10 行经 N/P 双读，fail 1」**。

## 3. 计时（口径例外，不进入中位数）

```text
t-start    2026-11-11T06:22:01.931Z
t-record   2026-11-11T06:23:45.161Z  sha=b7bff3aef328  record_runs=1
t-verify   2026-11-11T06:23:50.854Z  sha=b7bff3aef328
commit     2026-11-11T14:24:12+08:00  d6cf1991

batch_wall_total        = 177.0 s（b994fa3a → d6cf1991）
batch_wall_controllable = 131.0 s（t-start → commit）
落笔段                  = 108.9 s（t-start → t-verify）
tail                    =   5.7 s（t-record → t-verify）
s/行（端到端，落笔段）    = 1.44（131.0 / 91）
```

- 起草在 `--start` 之前完成，本样本与 b284/b285/b293–b296 同列「测量口径失效」，
  **不进入新口径 n=7 的中位数（仍为 1.66 s/行）**。

## 4. 度量前后

| 文件 | weak 前→后 |
| --- | ---: |
| `offPeakUiPresentation.ts` | 13 → 0 |
| `save-workflow.tsx` | 13 → 0 |
| `WorkflowArtifactBody.tsx` | 13 → 0 |
| `WorkflowArtifactIndex.tsx` | 13 → 0 |
| `get-monthly-sponsorships-opencollective.ts` | 13 → 0 |
| `CoveragePanel.tsx` | 13 → 2 |
| `formal-proof/src/main.ts` | 13 → 0 |

- 全仓：`post-b296 6613 / 1874` → `post-b297 6522 / 1872`。
- 池内：`done 4062 / remain 3359` → `done 4151 / remain 3270`。

## 5. 门禁

```text
删本线注释 n=91   删代码 n=0   删上游注释 n=0
新增非注释行 n=0  原行搬移 n=0  标点级改写 n=0
新增注释行 n=91   判据命中 0   嵌套注释 0
numstat: +91 −91
PRECHECK SAME same_rewrites=0（record / verify 各一次）
PRECHECK SCOPE plan=91 allow=0 diff_old=91 diff_new=91 out_of_scope_edits=0
PRECHECK INDENT indentChanged=0 eolChanged=0
PRECHECK MTIME  touched_restored=0  LINE-DRIFT files=0
ORDER GATE PASS
```

- `record_runs=1`：**预检无返修**。
- 首轮预判 `hits=5`（4 W + 1 L），一轮返修后 `hits=0`：
  - W：`offPeakUiPresentation.ts:33`、`WorkflowArtifactIndex.tsx:74`、
    `WorkflowArtifactBody.tsx:185/186` —— 分别补 `theme`、`version >= 2`、`div`、`ArtifactMetadataCard`；
  - L：`formal-proof/src/main.ts:386`（`，` 出现 2 次）→ 改为分号断句并补 `budget` 锚点。
- 起草无 `SAME`（`apply` 报 `changed=91 same=0`），不构成空替换。

## 6. 收口

```text
GUARD 15文件 pre=4 post=4 新增=0 max=8 → PASS
ACCT files 283 + 724 = 1007 OK
ACCT lines 4151 + 3270 = 7421 OK
ALIGNED acct_remain=3270 pool_remain=3270 diff=0
ledger-assert ASSERT PASS（CLOSE 802 = 802，EXEMPT 2）
OWNCOMMITS rows=328 generated=328 missing=0 extra=0 text=same
WHITELIST OK head=d6cf1991 rows=328
SELF-CLEAR n=2（池外 2）
```

- 15 文件 guard 只覆盖那 15 个文件，`CoveragePanel.tsx` 不在其中；本批的 2 条新增 weak
  由全仓快照对账发现（`6613 − 6522 = 91` 与池内净前移 89 差 2），已按 PARTIAL 记账，
  **不藏在 `hits=0` 后面**。

## 7. 首轮命中率（逐批）

| 批 | 首轮 hits | 登记行 | 命中率 |
| --- | ---: | ---: | ---: |
| b291 | 9 | 97 | 9.3% |
| b292 | 10 | 98 | 10.2% |
| b293 | 2 | 98 | 2.0% |
| b294 | 6 | 98 | 6.1% |
| b295 | 8 | 97 | 8.2% |
| b296 | 10 | 91 | 11.0% |
| **b297** | **5** | **91** | **5.5%** |

- 近七批均值约 7.5%（50/670）；b297 回落到常态区间下半段，与「UI 组件 + 脚本 + 图表渲染」混合构成相符。

## 8. 剩余工作量（按 post-b297 更新）

| 口径 | 单位耗时 | 3,270 行折算 | 说明 |
| --- | ---: | ---: | --- |
| `controllable`（新口径 n=7，中位数） | 1.66 s/行 | 5,428 s ≈ 1.5 h | 只作区间 |
| 端到端（b286 实测） | 5.67 s/行 | 18,541 s ≈ **5.2 h** | 含门禁、返修、快照、台账 |
| 批次折算 | 90 行/批 | **约 36 批** | `3,270 / 90 ≈ 36` |

## 9. 池外对账

| 快照 | 提交 | weak | files | remain | 池外 |
| --- | --- | ---: | ---: | ---: | ---: |
| post-b294 | `682cf328` | 6801 | 1883 | 3546 | 3255 |
| post-b295 | `849f438f` | 6704 | 1881 | 3450 | 3254 |
| post-b296 | `b4a61ced` | 6613 | 1874 | 3359 | 3254 |
| post-b297 | `d6cf1991` | 6522 | 1872 | 3270 | 3252 |

- `6613 − 6522 = 91` = 池内净前移 89 行 + 池外自清 2 行；池外 3254 → 3252 与自清 2 条一一对应。
