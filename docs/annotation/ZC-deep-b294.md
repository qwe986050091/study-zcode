# ZC-deep-b294：7 文件 / 98 行（全池内，无自清）

> 批次：b294 ｜ 提交 `682cf328` ｜ 代码 `+98/−98` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v13（`f02be471a849`）、
> `precheck-assert.mjs`（`--start` 实盘逐行基准的第六批）、
> `capacity-estimate.mjs`、`weak-guard.mjs`、`ledger-assert.mjs`。

## 0. 交代

1. 本批 7 文件 / **98 行，全部池内**（`ownIn=98 ownOut=0 upIn=0 upOut=0 pending=0 plan=98 allow=0`）。
2. 起笔前重跑 `own-commits-gen`（317 行 / `head=8f0c3b28`），白名单单独提交后才 `--start`
   （`2026-11-11T06:09:38.304Z`，7 文件 1,637 行实盘逐行基准）。
   **计时口径例外（同 b293）**：本批映射先于 `--start` 起草，§3 的 `controllable` 只覆盖
   「落笔 → 提交」，与 b284/b285/b293 同列，**不进入中位数**。
3. 流程：`--start` → `b294-apply.mjs`（1→1，`SAME 0`）→ 判据预判（2 轮，首轮 6 条）
   → `--scope` → `--record`（首跑即过，`record_runs=1`）→ `--verify` → `zc-commit v13` → `--order`。
4. 七行门禁：`expected=7 staged=7`，`+98/−98`；顺序断言
   `t-start 06:09:38.304 < t-record 06:09:56.145 ≤ t-verify 06:09:57.680 < commit 14:11:35+08:00`。
5. 第 8 行门禁第六批：`indentChanged=0 eolChanged=0`、`SAME 0`、`touched_restored=0`。
6. 本批结束重生成白名单：**319 行 / `head=682cf328`**。

## 1. 计划表

| 文件 | 池内 | 池外 own | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/lib/taskSidePaneMemory.ts` | 14 | 0 | 14 | 0 |
| `packages/ui/src/lib/workspaceFileDrag.ts` | 14 | 0 | 14 | 0 |
| `packages/ui/src/plugin-ui/adapters/useRecommendedUiPlugins.ts` | 14 | 0 | 14 | 0 |
| `packages/ui/src/project-sidebar/view.ts` | 14 | 0 | 14 | 0 |
| `packages/ui/src/settings/SettingsHeaderBreadcrumb.tsx` | 14 | 0 | 14 | 0 |
| `packages/ui/src/store/codeCommentPreviewStore.ts` | 14 | 0 | 14 | 0 |
| `packages/ui/src/store/remoteWorkspaceSessionStore.ts` | 14 | 0 | 14 | 0 |
| **合计** | **98** | **0** | **98** | **0** |

## 2. 批后池

```text
done files=264（+7）  remain files=743
done lines=3875（+98）remain lines=3546（−98）
ALIGNED acct_remain=3546 pool_remain=3546 diff=0
完成度 3875 / 7421 = 52.2%
```

- 登记 98 行 == `done +98`，无池外 own 差额。
- **SELF-CLEAR 0**：全仓 weak `6899 → 6801`（−98），全部由本批登记解释；池外 `6801 − 3546 = 3255`，与 post-b293 一致。
- 档位分布：`>=20` 归零，`10-19` 146 文件 / 1,697 行，`5-9` 141 / 931，`3-4` 158 / 539，`1-2` 298 / 379。
- `done 3,875` 的台账口径：**「已写入 3,875 行，其中 10 行经 N/P 双读，fail 1」**。

## 3. 计时（口径例外，不进入中位数）

```text
t-start    2026-11-11T06:09:38.304Z
t-record   2026-11-11T06:09:56.145Z  sha=f2af8e7053d9  record_runs=1
t-verify   2026-11-11T06:09:57.680Z  sha=f2af8e7053d9
commit     2026-11-11T14:11:35+08:00  682cf328

batch_wall_total        = 199.0 s（26020436 → 682cf328）
batch_wall_controllable = 117.0 s（t-start → commit）
落笔段                  =  19.4 s（t-start → t-verify）
tail                    =   1.5 s（t-record → t-verify）
s/行（端到端，仅落笔段） = 1.19（117.0 / 98）
```

- 起草在 `--start` 之前完成，本样本与 b284/b285/b293 同列「测量口径失效」，
  **不进入新口径 n=7 的中位数（仍为 1.66 s/行）**。

## 4. 度量前后

| 文件 | weak 前→后 |
| --- | ---: |
| `taskSidePaneMemory.ts` | 14 → 0 |
| `workspaceFileDrag.ts` | 14 → 0 |
| `useRecommendedUiPlugins.ts` | 14 → 0 |
| `view.ts` | 14 → 0 |
| `SettingsHeaderBreadcrumb.tsx` | 14 → 0 |
| `codeCommentPreviewStore.ts` | 14 → 0 |
| `remoteWorkspaceSessionStore.ts` | 14 → 0 |

- 全仓：`post-b293 6899 / 1890` → `post-b294 6801 / 1883`。
- 池内：`done 3777 / remain 3644` → `done 3875 / remain 3546`。
- PARTIAL 仍为 1：`cuaDetails.tsx` 基线 23 → 现 1。

## 5. 门禁

```text
删本线注释 n=98   删代码 n=0   删上游注释 n=0
新增非注释行 n=0  原行搬移 n=0  标点级改写 n=0（首轮 1 条已修）
新增注释行 n=98   判据命中 0   嵌套注释 0
numstat: +98 −98
PRECHECK SAME same_rewrites=0（record / verify 各一次）
PRECHECK SCOPE plan=98 allow=0 diff_old=98 diff_new=98 out_of_scope_edits=0
PRECHECK INDENT indentChanged=0 eolChanged=0
PRECHECK MTIME  touched_restored=0
ORDER GATE PASS
```

- `record_runs=1`：预检**无返修**；`zc-commit` 首跑被「标点级改写」拦下 1 条
  （`remoteWorkspaceSessionStore.ts:256` 只补了句号，判为标点级），改成
  「若 `getRemoteWorkspaceSession()` 抛错…」后通过；该返修发生在 `--record` 之后，
  按口径**不计入 `record_runs`**，但记在这里。
- 首轮预判 `hits=6`，全部是 W（无 ASCII 锚点）：
  - `SettingsHeaderBreadcrumb.tsx:31/32/50`：补 `SettingsBreadcrumbItem`、`onSelect`、`cleanup`。
  - `codeCommentPreviewStore.ts:36/58`：补 `EMPTY_CODE_COMMENT_PREVIEWS`、`sourcePath`/`bucketKey`。
  - `useRecommendedUiPlugins.ts:114`：`、` 列举改「按 `item.installed` 与 `item.restorable` 选择 A、B 或 C」。
  - 返修只补锚点与句式，未改语义。

## 6. 收口

```text
GUARD 15文件 pre=4 post=4 新增=0 max=8 → PASS
ACCT files 264 + 743 = 1007 OK
ACCT lines 3875 + 3546 = 7421 OK
ALIGNED acct_remain=3546 pool_remain=3546 diff=0
ledger-assert ASSERT PASS（CLOSE 802 = 802，EXEMPT 2）
OWNCOMMITS rows=319 generated=319 missing=0 extra=0 text=same
WHITELIST OK head=682cf3282fb4 rows=319
SELF-CLEAR n=0
```

## 7. 首轮命中率（逐批）

| 批 | 首轮 hits | 登记行 | 命中率 |
| --- | ---: | ---: | ---: |
| b288 | 6 | 90 | 6.7% |
| b289 | 7 | 90 | 7.8% |
| b290 | 6 | 90 | 6.7% |
| b291 | 9 | 97 | 9.3% |
| b292 | 10 | 98 | 10.2% |
| b293 | 2 | 98 | 2.0% |
| **b294** | **6** | **98** | **6.1%** |

- 七批均值约 6.4%（46/661），本批回到均值附近。
- 命中仍集中在 W 类：原注释是「一句一断言」的中文短句，缺少可检索锚点；
  补 `函数名 / 字段名 / 常量名` 后一轮清零，没有语义返工。

## 8. 剩余工作量（按 post-b294 更新）

| 口径 | 单位耗时 | 3,546 行折算 | 说明 |
| --- | ---: | ---: | --- |
| `controllable`（新口径 n=7，中位数） | 1.66 s/行 | 5,886 s ≈ 1.6 h | 只作区间 |
| 端到端（b286 实测） | 5.67 s/行 | 20,106 s ≈ **5.6 h** | 含门禁、返修、快照、台账 |
| 批次折算 | 90 行/批 | **约 40 批** | `3,546 / 90 ≈ 40` |

## 9. 池外对账

| 快照 | 提交 | weak | files | remain | 池外 |
| --- | --- | ---: | ---: | ---: | ---: |
| post-b291 | `4d7d84ed` | 7097 | 1902 | 3840 | 3257 |
| post-b292 | `2bdd2e41` | 6999 | 1895 | 3742 | 3257 |
| post-b293 | `042f140e` | 6899 | 1890 | 3644 | 3255 |
| post-b294 | `682cf328` | 6801 | 1883 | 3546 | 3255 |

- `6899 − 6801 = 98`，全部为池内登记；池外 3255 保持不变，无自清。
