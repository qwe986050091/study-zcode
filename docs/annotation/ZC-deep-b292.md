# ZC-deep-b292：7 文件 / 98 行（全池内，无自清）

> 批次：b292 ｜ 提交 `2bdd2e41` ｜ 代码 `+98/−98` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v13（`f02be471a849`）、
> `precheck-assert.mjs`（`--start` 实盘逐行基准的第四批）、
> `capacity-estimate.mjs`、`weak-guard.mjs`、`ledger-assert.mjs`。

## 0. 交代

1. 本批 7 文件 / **98 行，全部池内**（`ownIn=98 ownOut=0 upIn=0 upOut=0 pending=0 plan=98 allow=0`）。
2. 起笔前重跑 `own-commits-gen`（311 行 / `head=7d9ad315`），白名单单独提交后才 `--start`
   （`2026-11-11T05:58:39.074Z`，7 文件 1,610 行实盘逐行基准）。
3. 流程：`--start` → 起草 → `b292-apply.mjs`（1→1，`SAME 0`）→ 判据预判（2 轮，首轮 10 条）
   → `--scope` → `--record`（**首跑即过**，`record_runs=1`）→ `--verify` → `zc-commit v13` → `--order`。
4. 七行门禁：`expected=7 staged=7`，`+98/−98`；顺序断言
   `t-start 05:58:39.074 < t-record 06:00:07.068 ≤ t-verify 06:00:08.426 < commit 14:00:29+08:00`。
5. 第 8 行门禁第四批：`indentChanged=0 eolChanged=0`、`SAME 0`、`touched_restored=0`。
6. 本批结束重生成白名单：**313 行 / `head=2bdd2e41`**。

## 1. 计划表

| 文件 | 池内 | 池外 own | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `apps/zcode-cli/packages/bootstrap/src/app/legacy-cli-personal-provider-config-importer.ts` | 14 | 0 | 14 | 0 |
| `apps/zcode-cli/packages/core/src/runtime/methods/workspace-checkpoint-persistence.ts` | 14 | 0 | 14 | 0 |
| `apps/zcode-cli/packages/core/src/tool/handlers/guarded/git.ts` | 14 | 0 | 14 | 0 |
| `apps/zcode-cli/packages/tui/src/app-effort-suggestion-panel.tsx` | 14 | 0 | 14 | 0 |
| `packages/server/src/remote/remoteAssetCdn.ts` | 14 | 0 | 14 | 0 |
| `packages/stream-animate/src/server/frameForecast.ts` | 14 | 0 | 14 | 0 |
| `packages/ui/src/BotsDialog/WorkspaceAccessCard.tsx` | 14 | 0 | 14 | 0 |
| **合计** | **98** | **0** | **98** | **0** |

## 2. 批后池

```text
done files=250（+7）  remain files=757
done lines=3679（+98）remain lines=3742（−98）
ALIGNED acct_remain=3742 pool_remain=3742 diff=0
完成度 3679 / 7421 = 49.6%
```

- 登记 98 行 == `done +98`，无池外 own 差额。
- **SELF-CLEAR n=0**：全仓 weak `7097 → 6999`（−98）完全由池内 98 行解释；
  池外 `6999 − 3742 = 3257`，与 post-b291 的 3257 相同。
- 档位分布（`capacity-estimate` 的 band 表）：`>=20` 归零，`10-19` 160 文件 / 1,893 行，
  `5-9` 141 / 931，`3-4` 158 / 539，`1-2` 298 / 379。
- `done 3,679` 的台账口径仍是：**「已写入 3,679 行，其中 10 行经 N/P 双读，fail 1」**。

## 3. 计时（新口径 n=7）

```text
t-start    2026-11-11T05:58:39.074Z
t-record   2026-11-11T06:00:07.068Z  sha=14072118486f  record_runs=1
t-verify   2026-11-11T06:00:08.426Z  sha=14072118486f
commit     2026-11-11T14:00:29+08:00  2bdd2e41

batch_wall_total        = 133.0 s（59058d3b → 2bdd2e41）
batch_wall_controllable = 110.0 s（t-start → commit）
落笔段                  =  89.4 s（t-start → t-verify）
tail                    =   1.4 s（t-record → t-verify）
s/行（新口径，端到端）  = 1.12（110.0 / 98）
```

- 新口径样本 n=7：3.26 / 1.62 / 2.57 / 1.66 / 2.21 / 1.60 / 1.12，中位数 **1.66**。
  仍是区间读数，不与旧口径 1.59 比快慢。

## 4. 度量前后

| 文件 | weak 前→后 |
| --- | ---: |
| `legacy-cli-personal-provider-config-importer.ts` | 14 → 0 |
| `workspace-checkpoint-persistence.ts` | 14 → 0 |
| `guarded/git.ts` | 14 → 0 |
| `app-effort-suggestion-panel.tsx` | 14 → 0 |
| `remoteAssetCdn.ts` | 14 → 0 |
| `frameForecast.ts` | 14 → 0 |
| `WorkspaceAccessCard.tsx` | 14 → 0 |

- 全仓：`post-b291 7097 / 1902` → `post-b292 6999 / 1895`。
- 池内：`done 3581 / remain 3840` → `done 3679 / remain 3742`。
- PARTIAL 仍为 1：`cuaDetails.tsx` 基线 23 → 现 1。

## 5. 门禁

```text
删本线注释 n=98   删代码 n=0   删上游注释 n=0
新增非注释行 n=0  原行搬移 n=0  标点级改写 n=0
新增注释行 n=98   判据命中 0   嵌套注释 0
numstat: +98 −98
PRECHECK SAME same_rewrites=0（record / verify 各一次）
PRECHECK SCOPE plan=98 allow=0 diff_old=98 diff_new=98 out_of_scope_edits=0
PRECHECK INDENT indentChanged=0 eolChanged=0
PRECHECK MTIME  touched_restored=0
ORDER GATE PASS
```

- `record_runs=1`：**无返修**。
- 首轮预判 `hits=10`（5 W + 3 L + 2 W）——逐条：
  - W：`app-effort-suggestion-panel.tsx:62/63`、`frameForecast.ts:63/94/95/96`、
    `legacy-cli-personal-provider-config-importer.ts:199`、`workspace-checkpoint-persistence.ts:235`
    —— 纯中文短句，补 `No matching efforts.`、`efforts.length`、`buckets`、`recent`、
    `TREND_DAMPING`、`EMA`、调用方函数名、`scope/reason`。
  - L：`remoteAssetCdn.ts:56`（`、` + `，` 共 2 个）、`git.ts:126`（数组里两个 `,`）
    —— 改为「与…构成」「用 enabled() 读取」。
  - 返修只补锚点与谓词，未改语义。
- 本批注释普遍是「一行一句」的短断言（如 `// 过滤空串。`），改写后统一补上
  所在函数/字段名，可读性与可检索性同时提升。

## 6. 收口

```text
GUARD 15文件 pre=4 post=4 新增=0 max=8 → PASS
ACCT files 250 + 757 = 1007 OK
ACCT lines 3679 + 3742 = 7421 OK
ALIGNED acct_remain=3742 pool_remain=3742 diff=0
ledger-assert ASSERT PASS（CLOSE 802 = 802，EXEMPT 2）
OWNCOMMITS rows=313 generated=313 missing=0 extra=0 text=same
WHITELIST OK head=2bdd2e41062f rows=313
SELF-CLEAR n=0
```

## 7. 首轮命中率（逐批）

| 批 | 首轮 hits | 登记行 | 命中率 |
| --- | ---: | ---: | ---: |
| b286 | 8 | 97 | 8.2% |
| b287 | 2 | 92 | 2.2% |
| b288 | 6 | 90 | 6.7% |
| b289 | 7 | 90 | 7.8% |
| b290 | 6 | 90 | 6.7% |
| b291 | 9 | 97 | 9.3% |
| **b292** | **10** | **98** | **10.2%** |

- 七批均值约 7.3%。b292 偏高是因为本批文件全是一行一句的短断言（W 占 8 条），
  不是改写质量下降；补上函数名后第二轮清零。

## 8. 剩余工作量（按 post-b292 更新）

| 口径 | 单位耗时 | 3,742 行折算 | 说明 |
| --- | ---: | ---: | --- |
| `controllable`（新口径 n=7，中位数） | 1.66 s/行 | 6,212 s ≈ 1.7 h | 只作区间 |
| 端到端（b286 实测） | 5.67 s/行 | 21,257 s ≈ **5.9 h** | 含门禁、返修、快照、台账 |
| 批次折算 | 90 行/批 | **约 42 批** | `3,742 / 90 ≈ 42` |

## 9. 池外对账

| 快照 | 提交 | weak | files | remain | 池外 |
| --- | --- | ---: | ---: | ---: | ---: |
| post-b290 | `02af44fa` | 7197 | 1906 | 3937 | 3260 |
| post-b291 | `4d7d84ed` | 7097 | 1902 | 3840 | 3257 |
| post-b292 | `2bdd2e41` | 6999 | 1895 | 3742 | 3257 |

- `7097 − 6999 = 98` = 池内登记行数；池外 3257 未变，本批无自清。
