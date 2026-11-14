# ZC-deep-b308：3 文件 / 36 行（全池内；判据首轮 2 hits 已返修；POOL-DIFF 首跑）

> 批次：b308 ｜ 代码提交 `352ad021` ｜ `+36/−36` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v13（`f02be471a849`）、
> `precheck-assert.mjs`（`--start` 实盘逐行基准的第二十批）、
> `capacity-estimate.mjs`、`weak-guard.mjs`、`ledger-assert.mjs`
> ｜流程：`apply-run.mjs` + `gate-run.mjs`（**十一闸**，本批起含 `POOL-DIFF`）。

## 0. 交代

1. 本批 3 文件 / **36 行，全部池内**（`ownIn=36 ownOut=2 upIn=0 upOut=2 pending=0 plan=36 allow=0`）；
   池外那 4 行是同文件的重复/工具注释，不进计划。
2. **判据首轮 `hits=2`，均为 `L/无信息列举`**：

   ```text
   L 34  收起只改可见性，不卸载 Terminal 实例，重开时免去重建成本。（2 个逗号）
   L 70  同一个 finishTerminalPanelResize 同时挂 pointerup、pointercancel、blur 三类全局事件。（2 个顿号）
   ```

   改为「单分隔符 + 显式谓词」后 `hits=0`。**`write_phase` 返修 2 行**（Edit 直改）。
3. **第 11 道门禁 `POOL-DIFF` 本批首次进入常规流程**：`gate: PASS pool-diff n=0 removed=36 added=0 allowed=37`
   （`allowed` = 36 计划行 + 1 条已登记池外自清）。
4. 起笔前白名单 `354 行 / head=b12c9948` 之后的文档提交为其后一代，工作树干净；
   `--start` 于 `2026-11-11T07:23:22.642Z` 落盘。
5. 顺序断言：`t-start 07:23:22.642 < t-record 07:24:19.200 < t-verify 07:24:20.650 < commit 15:24:39+08:00`；
   `record_runs=1`。
   `batch_wall_total=115.0s`（`c4b1728f → 352ad021`），`controllable=77.0s`（t-start → commit）。
6. 第 8 行门禁第二十批：`indentChanged=0 eolChanged=0`、`SAME 0`、`touched_restored=0`、
   `line_drift=0`、`out_of_scope_edits=0`。全程 apply-run，无 BOM。
7. 本批结束重生成白名单：**357 行 / `head=352ad021`**（未提交，随台账一起入账）。

## 1. 计划表

| 文件 | 池内 | 池外 own | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `apps/zcode-cli/packages/debug/server/observation-events.ts` | 11 | 1 | 11 | 2 |
| `packages/ui/src/app-shell/AnimatedTerminalPanel.tsx` | 12 | 1 | 12 | 1 |
| `packages/ui/src/plugin-ui/app/pluginUiAppTools.ts` | 13 | 2 | 13 | 1 |
| **合计** | **36** | **4** | **36** | **4** |

- 三个文件的池内 weak 清零，文件仍留在全仓清单里是因为还有池外行（不扣配额）。

## 2. 批后池

```text
done files=333（+3）   remain files=674（−3）
done lines=4775（+36） remain lines=2646（−36）
ALIGNED acct_remain=2646 pool_remain=2646 diff=0
完成度 4775 / 7421 = 64.3%
```

- PARTIAL 仍为 3：`cuaDetails.tsx`（23 → 1）、`script-workflow-process.ts`（13 → 1）、
  `CoveragePanel.tsx`（13 → 2）。
- 全仓：`5932 → 5896`（−36，与落笔数一致，无自清）；文件 `1827 → 1827`。
- 池外：`5896 − 2646 = 3250`，与 post-b307 持平。
- `done 4,775` 的台账口径：**「已写入 4,775 行，其中 10 行经 N/P 双读，fail 1」**。

## 3. 计时

```text
t-start    2026-11-11T07:23:22.642Z
t-record   2026-11-11T07:24:19.200Z  record_runs=1
t-verify   2026-11-11T07:24:20.650Z
commit     2026-11-11T15:24:39+08:00  352ad021

batch_wall_total        = 115.0 s（c4b1728f → 352ad021）
batch_wall_controllable = 77.0 s（t-start → commit）
s/行（端到端）           = 2.14（77.0 / 36）
```

- 小批 n=7（3.69 / 1.75 / 2.72 / 1.39 / 2.72 / 3.22 / 2.14），中位 2.72。

## 4. 度量前后

| 文件 | weak 前→后 |
| --- | ---: |
| `debug/server/observation-events.ts` | 14 → 2（池内 11 清零，余 2 行池外） |
| `app-shell/AnimatedTerminalPanel.tsx` | 13 → 1（池内 12 清零，余 1 行池外） |
| `plugin-ui/app/pluginUiAppTools.ts` | 13 → 1（池内 13 清零，余 1 行池外） |

## 5. 门禁（runner 输出，失败闭合，十一闸）

```text
gate: PASS scope     n=0 plan=36 allow=0 diff_old=36 diff_new=36 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=352ad021 files=3/3 numstat=36/36 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=36 added=0 allowed=37
gate: PASS order     n=0 total=115.0s controllable=77.0s
GATE ALL PASS batch=b308 sha=352ad021
```

- `pool-diff` 对比 b307 全仓快照与本批 3 文件重扫：消失 36 行全部落在 plan 内，新增 0 行。
- `verify` 的 `drift=n/a` 是规格显式声明（该阶段不产出 `line_drift`），由 `verify_ok=true` 断言。

## 6. 收口

```text
GUARD 15文件 pre=4 post=4 新增=0 max=8 → PASS
ACCT files 333 + 674 = 1007 OK
ACCT lines 4775 + 2646 = 7421 OK
ALIGNED acct_remain=2646 pool_remain=2646 diff=0
ledger-assert ASSERT PASS（CLOSE 802 = 802，EXEMPT 2，FILELIST 15 文件 OK）
OWNCOMMITS rows=357 generated=357 missing=0 extra=0 text=same
WHITELIST OK head=352ad021 rows=357
SELF-CLEAR n=0
```

## 7. 首轮命中率（逐批）

| 批 | 首轮 hits | 登记行 | 命中率 |
| --- | ---: | ---: | --- |
| b304 | 0 | 36 | 0.0% |
| b305 | 0 | 36 | 0.0% |
| b306 | 0 | 36 | 0.0% |
| b307 | 2 | 36 | 5.6% |
| **b308** | **2** | **36** | **5.6%** |

- b283–b308 二十六批合计 `115 / 2,019 ≈ 5.7%`；近八批（b301–b308）`11 / 352 ≈ 3.1%`。
- 两批的 2 hits 都是 `L/无信息列举`（多分隔符 + 无谓词），已连续两周重复出现，属写作习惯而非判据漂移。

## 8. 剩余工作量（按 post-b308 更新）

| 口径 | 单位耗时 | 2,646 行折算 | 说明 |
| --- | ---: | ---: | --- |
| 旧新口径 n=7 中位数（90–100 行批） | 1.66 s/行 | 4,392 s ≈ 1.2 h | 只作区间 |
| 30–40 行小批（b302–b308，n=7） | 1.39–3.69 s/行 | — | 中位 2.72 |
| 批次折算（35 行/批） | 35 行/批 | **约 76 批** | `2,646 / 35 ≈ 75.6` |

- `capacity` 分档合计 338 批（文件数上界，不是排期依据）。

## 9. 池外对账

| 快照 | 提交 | weak | files | remain | 池外 |
| --- | --- | ---: | ---: | ---: | ---: |
| post-b304 | `0b23b3c1` | 6041 | 1835 | 2790 | 3251 |
| post-b305 | `b355ff66` | 6005 | 1832 | 2754 | 3251 |
| post-b306 | `035e00bd` | 5969 | 1829 | 2718 | 3251 |
| post-b307 | `b12c9948` | 5932 | 1827 | 2682 | 3250 |
| post-b308 | `352ad021` | 5896 | 1827 | 2646 | 3250 |
