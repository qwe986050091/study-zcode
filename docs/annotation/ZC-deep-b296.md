# ZC-deep-b296：7 文件 / 91 行（全池内，无池外自清）

> 批次：b296 ｜ 提交 `b4a61ced` ｜ 代码 `+91/−91` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v13（`f02be471a849`）、
> `precheck-assert.mjs`（`--start` 实盘逐行基准的第八批）、
> `capacity-estimate.mjs`、`weak-guard.mjs`、`ledger-assert.mjs`。

## 0. 交代

1. 本批 7 文件 / **91 行，全部池内**（`ownIn=91 ownOut=0 upIn=0 upOut=0 pending=0 plan=91 allow=0`）。
   每文件 13 行，`91 = 7 × 13`，无缺口。
2. 起笔前重跑 `own-commits-gen`（322 行 / `head=306f2166`），白名单单独提交后才 `--start`
   （`2026-11-11T06:17:21.096Z`，7 文件实盘逐行基准）。
   **计时口径例外（同 b293/b294/b295）**：映射先于 `--start` 起草，`controllable` 只覆盖「落笔 → 提交」，
   **不进入中位数**。
3. 流程：`--start` → `b296-apply.mjs`（1→1）→ 判据预判（首轮 10 条 → 二轮 3 条 → 0）
   → `--scope` → `--record`（首跑即过，`record_runs=1`）→ `--verify` → `zc-commit v13` → `--order`。
4. **本批 `apply` 首跑有两处操作失误，均当场纠正，未落盘**：
   - `project-access-token.ts` 计划键按阅读窗口猜成 27–29 一段，实际 `plan.tsv` 是
     32 / 36 / 114–119 / 137–139 / 231 / 233；修正 NEXT 键后重跑；
   - 重跑时前 3 个文件已被上一轮写入，`OLD MISMATCH` 分支改为 `SKIP-APPLIED` 语义，
     跳过 3 条已应用行，最终 91 条全部落盘、`SAME 0`。
5. 七行门禁：`expected=7 staged=7`，`+91/−91`；顺序断言
   `t-start 06:17:21.096 < t-record 06:18:16.367 ≤ t-verify 06:18:18.611 < commit 14:18:41+08:00`。
6. 第 8 行门禁第八批：`indentChanged=0 eolChanged=0`、`SAME 0`、`touched_restored=0`。
   `result-display.ts` 实盘为 **LF**，git 报 `LF will be replaced by CRLF` 警告；门禁仍读 `eolChanged=0`，
   这是「按实盘字节比较、而非按 smudge 结果比较」的负控证据，与 b288 `cron.ts` 的假阳性相反。
7. 本批结束重生成白名单：**325 行 / `head=b4a61ced` / blob `f9d4bc294285`**。

## 1. 计划表

| 文件 | 池内 | 池外 own | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `apps/zcode-cli/packages/cli/src/command-center/slash-command-types.ts` | 13 | 0 | 13 | 0 |
| `apps/zcode-cli/packages/core/src/tool/executor/result-display.ts` | 13 | 0 | 13 | 0 |
| `apps/zcode-cli/packages/core/src/tool/handlers/bash-read-file-state.ts` | 13 | 0 | 13 | 0 |
| `apps/zcode-cli/packages/dynamic-workflow/src/testing/journal-contract-nodes.ts` | 13 | 0 | 13 | 0 |
| `packages/desktop/src/host/remotePromptAttachments.ts` | 13 | 0 | 13 | 0 |
| `packages/services/src/bots/replyFormatter.ts` | 13 | 0 | 13 | 0 |
| `packages/shared/src/project-access-token.ts` | 13 | 0 | 13 | 0 |
| **合计** | **91** | **0** | **91** | **0** |

## 2. 批后池

```text
done files=277（+7）  remain files=730
done lines=4062（+91）remain lines=3359（−91）
ALIGNED acct_remain=3359 pool_remain=3359 diff=0
完成度 4062 / 7421 = 54.7%
```

- 写入 91 行、池内前移 91 行，**一一对应**：本批无 PARTIAL、无池外自清，`record_runs=1` 且门禁首跑即过。
- PARTIAL 仍为 2（`cuaDetails.tsx` 23 → 1、`script-workflow-process.ts` 13 → 1），本批未新增。
- 全仓：`6704 → 6613`（−91 = 池内登记 91）；池外 `6613 − 3359 = 3254`，与 post-b295 持平，闭合。
- 档位分布：`>=20` 0，`10-19` 134 文件 / 1,540 行，`5-9` 139 / 919，`3-4` 158 / 539，`1-2` 299 / 380。
- `done 4,062` 的台账口径：**「已写入 4,062 行，其中 10 行经 N/P 双读，fail 1」**。

## 3. 计时（口径例外，不进入中位数）

```text
t-start    2026-11-11T06:17:21.096Z
t-record   2026-11-11T06:18:16.367Z  sha=453cc2d43856  record_runs=1
t-verify   2026-11-11T06:18:18.611Z  sha=453cc2d43856
commit     2026-11-11T14:18:41+08:00  b4a61ced

batch_wall_total        = 156.0 s（9c60218d → b4a61ced）
batch_wall_controllable =  80.0 s（t-start → commit）
落笔段                  =  57.5 s（t-start → t-verify）
tail                    =   2.2 s（t-record → t-verify）
s/行（端到端，落笔段）    = 0.88（80.0 / 91）
```

- 起草在 `--start` 之前完成，本样本与 b284/b285/b293/b294/b295 同列「测量口径失效」，
  **不进入新口径 n=7 的中位数（仍为 1.66 s/行）**。

## 4. 度量前后

| 文件 | weak 前→后 |
| --- | ---: |
| `slash-command-types.ts` | 13 → 0 |
| `result-display.ts` | 13 → 0 |
| `bash-read-file-state.ts` | 13 → 0 |
| `journal-contract-nodes.ts` | 13 → 0 |
| `remotePromptAttachments.ts` | 13 → 0 |
| `replyFormatter.ts` | 13 → 0 |
| `project-access-token.ts` | 13 → 0 |

- 全仓：`post-b295 6704 / 1881` → `post-b296 6613 / 1874`。
- 池内：`done 3971 / remain 3450` → `done 4062 / remain 3359`。

## 5. 门禁

```text
删本线注释 n=91   删代码 n=0   删上游注释 n=0
新增非注释行 n=0  原行搬移 n=0  标点级改写 n=0
新增注释行 n=91   判据命中 0   嵌套注释 0
numstat: +91 −91
PRECHECK SAME same_rewrites=0（record / verify 各一次）
PRECHECK SCOPE plan=91 allow=0 diff_old=91 diff_new=91 out_of_scope_edits=0
PRECHECK INDENT indentChanged=0 eolChanged=0
PRECHECK MTIME  touched_restored=0
ORDER GATE PASS
```

- `record_runs=1`：**预检无返修**。
- 首轮预判 `hits=10`（8 W + 1 L + 1 POEM），返修两轮后 `hits=0`：
  - 首轮 W：纯中文短句缺 ASCII 锚点，补 `SlashCommandKind`、`ExtraFields`、
    `RESULT_DISPLAY_LIMITS`、`session.previousReads`、`mtimeMs`、`uploadedCount`、
    `replyFormatter`、`scopeKey` 一类标识符；
  - 首轮 L：`、` 并列符达 2 个，改 `/` 或分号断句；
  - 首轮 POEM：连续 3 行短句，合并为一句并补一个标识符。
- 二轮残留 3 条，逐条定点修：
  - `slash-command-types.ts:28`（两个并列符）→ 「已知分支按 name 逐命令展开，如 "compact" 或 "effort"。」；
  - `slash-command-types.ts:164`（无 ASCII）→ 「查找与提示统一交给 handler 的自定义命令注册表处理。」；
  - `remotePromptAttachments.ts:201`（无 ASCII）→ 「每一段都过 sanitizePathSegment() 白名单清洗并限长。」。
- 返修只补锚点与句式，未改语义；`SAME 0`，不构成空替换。

## 6. 收口

```text
GUARD 15文件 pre=4 post=4 新增=0 max=8 → PASS
ACCT files 277 + 730 = 1007 OK
ACCT lines 4062 + 3359 = 7421 OK
ALIGNED acct_remain=3359 pool_remain=3359 diff=0
ledger-assert ASSERT PASS（CLOSE 802 = 802，EXEMPT 2）
OWNCOMMITS rows=325 generated=325 missing=0 extra=0 text=same
WHITELIST OK head=b4a61ced rows=325
SELF-CLEAR n=0
```

## 7. 首轮命中率（逐批）

| 批 | 首轮 hits | 登记行 | 命中率 |
| --- | ---: | ---: | ---: |
| b290 | 6 | 90 | 6.7% |
| b291 | 9 | 97 | 9.3% |
| b292 | 10 | 98 | 10.2% |
| b293 | 2 | 98 | 2.0% |
| b294 | 6 | 98 | 6.1% |
| b295 | 8 | 97 | 8.2% |
| **b296** | **10** | **91** | **11.0%** |

- 七批均值约 7.7%（51/669）。b296 为七批最高，但文件构成是「声明/类型/格式化器」为主，
  结构行与短接口声明占比高，符合「先查文件类型构成再归因」的既有约定，不单看比值。

## 8. 剩余工作量（按 post-b296 更新）

| 口径 | 单位耗时 | 3,359 行折算 | 说明 |
| --- | ---: | ---: | --- |
| `controllable`（新口径 n=7，中位数） | 1.66 s/行 | 5,576 s ≈ 1.6 h | 只作区间 |
| 端到端（b286 实测） | 5.67 s/行 | 19,046 s ≈ **5.3 h** | 含门禁、返修、快照、台账 |
| 批次折算 | 90 行/批 | **约 38 批** | `3,359 / 90 ≈ 38` |

## 9. 池外对账

| 快照 | 提交 | weak | files | remain | 池外 |
| --- | --- | ---: | ---: | ---: | ---: |
| post-b293 | `042f140e` | 6899 | 1890 | 3644 | 3255 |
| post-b294 | `682cf328` | 6801 | 1883 | 3546 | 3255 |
| post-b295 | `849f438f` | 6704 | 1881 | 3450 | 3254 |
| post-b296 | `b4a61ced` | 6613 | 1874 | 3359 | 3254 |

- `6704 − 6613 = 91` = 池内登记 91 行；本批无自清，池外维持 3254。
