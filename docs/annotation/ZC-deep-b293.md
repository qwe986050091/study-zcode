# ZC-deep-b293：7 文件 / 98 行（全池内，池外自清 2）

> 批次：b293 ｜ 提交 `042f140e` ｜ 代码 `+98/−98` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v13（`f02be471a849`）、
> `precheck-assert.mjs`（`--start` 实盘逐行基准的第五批）、
> `capacity-estimate.mjs`、`weak-guard.mjs`、`ledger-assert.mjs`。

## 0. 交代

1. 本批 7 文件 / **98 行，全部池内**（`ownIn=98 ownOut=0 upIn=0 upOut=0 pending=0 plan=98 allow=4`）。
   4 条 `allow` 均为上游注释（`872ad960`），不在 plan 内。
2. 起笔前重跑 `own-commits-gen`（314 行 / `head=c3f38160`），白名单单独提交后才 `--start`
   （`2026-11-11T06:04:17.943Z`，7 文件 1,576 行实盘逐行基准）。
   **计时口径例外**：本批恢复会话后先写完 98 条映射再起笔，`--start` 晚于起草，
   因此 §3 的 `controllable` 只覆盖「落笔 → 提交」，与 b284/b285 同列单列，**不进入中位数**。
3. 流程：`--start` → `b293-apply.mjs`（1→1，`SAME 0`）→ 判据预判（2 轮，首轮 2 条）
   → `--scope` → `--record`（**首跑即过**，`record_runs=1`）→ `--verify` → `zc-commit v13` → `--order`。
4. 七行门禁：`expected=7 staged=7`，`+98/−98`；顺序断言
   `t-start 06:04:17.943 < t-record 06:05:17.569 ≤ t-verify 06:05:22.733 < commit 14:05:52+08:00`。
5. 第 8 行门禁第五批：`indentChanged=0 eolChanged=0`、`SAME 0`、`touched_restored=0`。
6. 本批结束重生成白名单：**316 行 / `head=042f140e`**。

## 1. 计划表

| 文件 | 池内 | 池外 own | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/shared/src/mcp.ts` | 14 | 0 | 14 | 0 |
| `packages/ui/src/ToolCallBlocks/renderers/get-workflow-run-roster.tsx` | 14 | 0 | 14 | 0 |
| `packages/desktop/scripts/mcp-apps-host-fixture/managed-main.ts` | 14 | 0 | 14 | 0 |
| `packages/desktop/scripts/mcp-apps-host-fixture/storage-checks.ts` | 14 | 0 | 14 | 0 |
| `packages/ui/src/WorkspaceSidebar/RemoteProjectConnectionDetails.tsx` | 14 | 0 | 14 | 0 |
| `packages/ui/src/WorkspaceSidebar/WorkspacePurposeSection.tsx` | 14 | 0 | 14 | 0 |
| `packages/ui/src/hooks/usePluginReferenceCatalog.ts` | 14 | 0 | 14 | 0 |
| **合计** | **98** | **0** | **98** | **0** |

## 2. 批后池

```text
done files=257（+7）  remain files=750
done lines=3777（+98）remain lines=3644（−98）
ALIGNED acct_remain=3644 pool_remain=3644 diff=0
完成度 3777 / 7421 = 50.9%
```

- 登记 98 行 == `done +98`，无池外 own 差额。
- **SELF-CLEAR n=2（均在池外）**：全仓 weak `6999 → 6899`（−100），其中 98 行由本批登记解释，
  另 2 行是 `872ad960` 的上游行由相邻改写转强（`get-workflow-run-roster.tsx:58`、
  `usePluginReferenceCatalog.ts:105`），不进 `done`。池外 `6899 − 3644 = 3255`，与 post-b292 的 3257 差 2，数字闭合。
- 档位分布（`capacity-estimate` 的 band 表）：`>=20` 归零，`10-19` 153 文件 / 1,795 行，
  `5-9` 141 / 931，`3-4` 158 / 539，`1-2` 298 / 379。
- `done 3,777` 的台账口径仍是：**「已写入 3,777 行，其中 10 行经 N/P 双读，fail 1」**。

## 3. 计时（口径例外，不进入中位数）

```text
t-start    2026-11-11T06:04:17.943Z
t-record   2026-11-11T06:05:17.569Z  sha=150c4def07f3  record_runs=1
t-verify   2026-11-11T06:05:22.733Z  sha=150c4def07f3
commit     2026-11-11T14:05:52+08:00  042f140e

batch_wall_total        = 202.0 s（75f27b00 → 042f140e）
batch_wall_controllable =  95.0 s（t-start → commit）
落笔段                  =  64.8 s（t-start → t-verify）
tail                    =   5.2 s（t-record → t-verify）
s/行（端到端，仅落笔段） = 0.97（95.0 / 98）
```

- 起草在 `--start` 之前完成，本样本与 b284/b285 同列「测量口径失效」，
  **不进入新口径 n=7 的中位数（仍为 1.66 s/行）**。

## 4. 度量前后

| 文件 | weak 前→后 |
| --- | ---: |
| `mcp.ts` | 14 → 0 |
| `get-workflow-run-roster.tsx` | 14 → 0 |
| `managed-main.ts` | 14 → 0 |
| `storage-checks.ts` | 14 → 0 |
| `RemoteProjectConnectionDetails.tsx` | 14 → 0 |
| `WorkspacePurposeSection.tsx` | 14 → 0 |
| `usePluginReferenceCatalog.ts` | 14 → 0 |

- 全仓：`post-b292 6999 / 1895` → `post-b293 6899 / 1890`。
- 池内：`done 3679 / remain 3742` → `done 3777 / remain 3644`。
- PARTIAL 仍为 1：`cuaDetails.tsx` 基线 23 → 现 1。

## 5. 门禁

```text
删本线注释 n=98   删代码 n=0   删上游注释 n=0
新增非注释行 n=0  原行搬移 n=0  标点级改写 n=0
新增注释行 n=98   判据命中 0   嵌套注释 0
numstat: +98 −98
PRECHECK SAME same_rewrites=0（record / verify 各一次）
PRECHECK SCOPE plan=98 allow=4 diff_old=98 diff_new=98 out_of_scope_edits=0
PRECHECK INDENT indentChanged=0 eolChanged=0
PRECHECK MTIME  touched_restored=0
ORDER GATE PASS
```

- `record_runs=1`：**无返修**。
- 首轮预判 `hits=2`：
  - W：`managed-main.ts:48`「现场覆盖请求、审批…」纯中文无 ASCII 锚点
    —— 改为 `managed-failure.json` + `requests / approvals / events / notifications` 四段字段名。
  - L：`get-workflow-run-roster.tsx:158` 两个 `，` 无谓词
    —— 改为「由 … 处理；其余 … 由 … 处理」。
  - 返修只补锚点与谓词，未改语义。
- 本批原文多为「一行一句」的短断言（W 类高发），改写后统一补上
  函数名 / 字段名 / 常量名，判据首轮即降到 2 条。

## 6. 收口

```text
GUARD 15文件 pre=4 post=4 新增=0 max=8 → PASS
ACCT files 257 + 750 = 1007 OK
ACCT lines 3777 + 3644 = 7421 OK
ALIGNED acct_remain=3644 pool_remain=3644 diff=0
ledger-assert ASSERT PASS（CLOSE 802 = 802，EXEMPT 2）
OWNCOMMITS rows=316 generated=316 missing=0 extra=0 text=same
WHITELIST OK head=042f140e8574 rows=316
SELF-CLEAR n=2（池外 2）
```

## 7. 首轮命中率（逐批）

| 批 | 首轮 hits | 登记行 | 命中率 |
| --- | ---: | ---: | ---: |
| b287 | 2 | 92 | 2.2% |
| b288 | 6 | 90 | 6.7% |
| b289 | 7 | 90 | 7.8% |
| b290 | 6 | 90 | 6.7% |
| b291 | 9 | 97 | 9.3% |
| b292 | 10 | 98 | 10.2% |
| **b293** | **2** | **98** | **2.0%** |

- 七批均值约 6.4%（42/655），本批是全序列最低。
  命中数与文件类型相关：本批改的是短断言型注释，补锚点后一轮清零，不作为质量趋势点。

## 8. 剩余工作量（按 post-b293 更新）

| 口径 | 单位耗时 | 3,644 行折算 | 说明 |
| --- | ---: | ---: | --- |
| `controllable`（新口径 n=7，中位数） | 1.66 s/行 | 6,049 s ≈ 1.7 h | 只作区间 |
| 端到端（b286 实测） | 5.67 s/行 | 20,662 s ≈ **5.7 h** | 含门禁、返修、快照、台账 |
| 批次折算 | 90 行/批 | **约 41 批** | `3,644 / 90 ≈ 41` |

## 9. 池外对账

| 快照 | 提交 | weak | files | remain | 池外 |
| --- | --- | ---: | ---: | ---: | ---: |
| post-b290 | `02af44fa` | 7197 | 1906 | 3937 | 3260 |
| post-b291 | `4d7d84ed` | 7097 | 1902 | 3840 | 3257 |
| post-b292 | `2bdd2e41` | 6999 | 1895 | 3742 | 3257 |
| post-b293 | `042f140e` | 6899 | 1890 | 3644 | 3255 |

- `6999 − 6899 = 100` = 池内登记 98 行 + 池外自清 2 行；池外 3257 → 3255 与自清 2 条一一对应。
