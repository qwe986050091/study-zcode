# ZC-deep-b290：6 文件 / 90 行（全池内，无自清）

> 批次：b290 ｜ 提交 `02af44fa` ｜ 代码 `+90/−90` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v13（`f02be471a849`）、
> `precheck-assert.mjs`（`--start` 实盘逐行基准的第二批）、
> `capacity-estimate.mjs`、`weak-guard.mjs`、`ledger-assert.mjs`。

## 0. 交代

1. 本批 6 文件 / **90 行，全部池内**（`ownIn=90 ownOut=0 upIn=0 upOut=0 pending=0 plan=90 allow=0`）。
2. 起笔前先重跑 `own-commits-gen`（305 行 / `head=5659a316`），白名单更新单独提交 `ff356c85`，
   工作树干净后才 `--start`（`2026-11-11T05:44:31.774Z`，6 文件 1,492 行实盘逐行基准）。
3. 流程：`--start` → 起草 → `b290-apply.mjs`（1→1，`SAME 0`）→ 判据预判（2 轮，首轮 6 条）
   → `--scope` → `--record`（**首跑即过**，`record_runs=1`）→ `--verify` → `zc-commit v13` → `--order`。
4. 七行门禁：`expected=6 staged=6`，`+90/−90`；顺序断言 `t-start < t-record ≤ t-verify < commit`。
5. 第 8 行门禁第二批（b289 起改用 `--start` 实盘基准）：`indentChanged=0 eolChanged=0`，
   `SAME 0`；b288 的 `eolChanged=15` 假阳性继续未复现。
6. 本批结束重生成白名单：**307 行 / `head=02af44fa`**（b289 为 305 行）。

## 1. 计划表

| 文件 | 池内 | 池外 own | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `apps/zcode-cli/packages/tui/src/app-shiki-diff-view.tsx` | 15 | 0 | 15 | 0 |
| `packages/server/src/source-server/sourceServerTransportRuntime.ts` | 15 | 0 | 15 | 0 |
| `packages/shared/src/rendererActionTrace.ts` | 15 | 0 | 15 | 0 |
| `packages/ui/src/ChatMediaAttachmentPreviewDialog.tsx` | 15 | 0 | 15 | 0 |
| `packages/ui/src/hooks/useGlobalTaskList.ts` | 15 | 0 | 15 | 0 |
| `packages/ui/src/plugin-ui/app/pluginUiPageManager.ts` | 15 | 0 | 15 | 0 |
| **合计** | **90** | **0** | **90** | **0** |

## 2. 批后池

```text
done files=236（+6）  remain files=771
done lines=3484（+90）remain lines=3937（−90）
ALIGNED acct_remain=3937 pool_remain=3937 diff=0
完成度 3484 / 7421 = 47.0%
```

- 登记 90 行 == `done +90`，无池外 own 差额。
- **本批无 SELF-CLEAR**：全仓 weak `7287 → 7197`（−90）完全由池内 90 行解释；
  池外 `7197 − 3937 = 3260`，与 post-b289 的 3260 相同。
- `done 3,484` 的台账口径：**「已写入 3,484 行，其中 10 行经 N/P 双读，fail 1」**；
  抽检 fail 率**不参与 `remain`**，只回答这个数可信到什么程度（见 `ZC-semantic-audit-01.md` §6）。
- 语义抽检节奏：上一条插在 b289 之后（`ZC-semantic-audit-01.md`，10 行 N/P 双读），
  按「每 100 批左右」下一轮约在 b390，本批不插。

## 3. 计时（新口径 n=5）

```text
t-start    2026-11-11T05:44:31.774Z
t-record   2026-11-11T05:47:16.395Z  sha=511963d8ce68  record_runs=1
t-verify   2026-11-11T05:47:21.038Z
commit     2026-11-11T13:47:51+08:00  02af44fa

batch_wall_total        = 233.0 s（上一提交 ff356c85 13:43:58 → 本提交）
batch_wall_controllable = 199.2 s（t-start → commit，含起草时间）
落笔段                  = 164.6 s（t-start → t-record，含起草时间）
tail                    =  30.0 s（t-verify → commit）
s/行（新口径，端到端）  = 2.21（199.2 / 90）
```

- 新口径样本到 **n=5**：3.26 / 1.62 / 2.57 / 1.66 / 2.21，中位数 **2.21**；
  仍只作区间用，不与旧口径 1.59 比快慢。
- `batch_wall_total` 含批间非改写动作（本批为白名单提交 `ff356c85`），不得除以行数当改写成本。

## 4. 度量前后

| 文件 | weak 前→后 |
| --- | ---: |
| `app-shiki-diff-view.tsx` | 15 → 0 |
| `sourceServerTransportRuntime.ts` | 15 → 0 |
| `rendererActionTrace.ts` | 15 → 0 |
| `ChatMediaAttachmentPreviewDialog.tsx` | 15 → 0 |
| `useGlobalTaskList.ts` | 15 → 0 |
| `pluginUiPageManager.ts` | 15 → 0 |
| **合计** | **90 → 0** |

- 全仓：`post-b289 7287 / 1912` → `post-b290 7197 / 1906`（−90 行 / −6 文件）。
- 池内：`post-b289 done 3394 / remain 4027` → `post-b290 done 3484 / remain 3937`（−90）。
- 池外：post-b290 为 `7197 − 3937 = 3260`，post-b289 为 3260，**零变动**。

## 5. 门禁

```text
删本线注释 n=90   删代码 n=0   删上游注释 n=0
新增非注释行 n=0  原行搬移 n=0  标点级改写 n=0
新增注释行 n=90   判据命中 0   嵌套注释 0
numstat: +90 −90
PRECHECK SAME same_rewrites=0（record / verify 各一次）
PRECHECK SCOPE plan=90 allow=0 diff_old=90 diff_new=90 out_of_scope_edits=0
PRECHECK INDENT indentChanged=0 eolChanged=0
PRECHECK MTIME  touched_restored=0
ORDER GATE PASS
```

- `record_runs=1`：本批**无返修**，第 8 行门禁首跑即过。
- 首轮预判 `hits=6`（3 W + 3 L），第二轮 `hits=0`；`b290-apply.mjs` 报 `SAME 0`：
  - W（缺 ASCII 锚点，纯中文）：`sourceServerTransportRuntime.ts:34`（`'"'"'` 里没有标识符）、
    `useGlobalTaskList.ts:48`、`ChatMediaAttachmentPreviewDialog.tsx:112`——分别补 `replaceAll` /
    `workspaceIdentity` / `pdfViewerLabels`。
  - L（并列符 ≥2 且无谓词）：`useGlobalTaskList.ts:46`（`[identity||path, path]` 的 `,` 与 `，` 合计 2 个）、
    `useGlobalTaskList.ts:120`（四个 `、`）、`app-shiki-diff-view.tsx:208`（`Math.max(a, b)` 的 `,` 与 `，`）
    ——改为「由…决定 / 由…组成」句式。
  - 返修只补锚点与谓词，未改语义。

## 6. 收口

```text
GUARD 15文件 pre=4 post=4 新增=0 max=8 → PASS
ACCT files 236 + 771 = 1007 OK
ACCT lines 3484 + 3937 = 7421 OK
ALIGNED acct_remain=3937 pool_remain=3937 diff=0
ledger-assert ASSERT PASS（CLOSE 802 = 802，EXEMPT 2）
OWNCOMMITS rows=307 generated=307 missing=0 extra=0 text=same
WHITELIST OK head=02af44faa289 rows=307
PARTIAL 1：cuaDetails.tsx 基线 23 → 现 1
SELF-CLEAR n=0
```

- 全仓快照按 **post-b289 的 9,504 文件同一域**生成（`b290-same-domain-files.txt`），
  保证 `weak` 前后可比；直接以 `--root .` 全量扫描会多出 1,624 个文件，数字不可比，故弃用。

## 7. 首轮命中率（逐批）

| 批 | 首轮 hits | 登记行 | 命中率 |
| --- | ---: | ---: | ---: |
| b283 | 3 | 96 | 3.1% |
| b284 | 7 | 100 | 7.0% |
| b285 | 1 | 70 | 1.4% |
| b286 | 8 | 97 | 8.2% |
| b287 | 2 | 92 | 2.2% |
| b288 | 6 | 90 | 6.7% |
| b289 | 7 | 90 | 7.8% |
| **b290** | **6** | **90** | **6.7%** |

- 八批均值约 5.4%。b290 的 6 条里 3 条 W（纯中文短句）、3 条 L（`、`/`,` 达 2 个），
  都集中在「一行一个短句」的旧写法上；补锚点与谓词后第二轮清零。

## 8. 剩余工作量（按 post-b290 更新）

| 口径 | 单位耗时 | 3,937 行折算 | 说明 |
| --- | ---: | ---: | --- |
| `controllable`（新口径 n=5，中位数） | 2.21 s/行 | 8,701 s ≈ 2.4 h | 只作区间，不取单点 |
| 端到端（b286 实测） | 5.67 s/行 | 22,323 s ≈ **6.2 h** | 含门禁、返修、快照、台账 |
| 批次折算 | 90 行/批 | **约 44 批** | `3,937 / 90 ≈ 44` |

## 9. 池外对账

| 快照 | 提交 | weak | files | remain | 池外 |
| --- | --- | ---: | ---: | ---: | ---: |
| post-b288 | `e5da2497` | 7380 | 1918 | 4117 | 3263 |
| post-b289 | `a307ec35` | 7287 | 1912 | 4027 | 3260 |
| post-b290 | `02af44fa` | 7197 | 1906 | 3937 | 3260 |

- `7287 − 7197 = 90` = 池内登记行数；池外 3260 未变，本批无自清、无池外改写。
