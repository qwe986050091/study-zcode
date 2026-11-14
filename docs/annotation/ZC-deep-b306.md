# ZC-deep-b306：3 文件 / 36 行（全池内，无自清；runner 改为失败闭合）

> 批次：b306 ｜ 代码提交 `035e00bd` ｜ `+36/−36` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v13（`f02be471a849`）、
> `precheck-assert.mjs`（`--start` 实盘逐行基准的第十八批）、
> `capacity-estimate.mjs`、`weak-guard.mjs`、`ledger-assert.mjs`
> ｜流程：`apply-run.mjs` + `gate-run.mjs`（本批 runner 改为失败闭合）。

## 0. 交代

1. 本批 3 文件 / **36 行，全部池内**（`ownIn=36 ownOut=0 upIn=0 upOut=0 pending=0 plan=36 allow=0`）。
   `12 × 3 = 36`。
2. **runner 改为失败闭合**（b306 起）。b305 首跑暴露的三处解析缺陷
   （`line_drift` 只出现在 RECORD 摘要、七行标签用全角空格对齐、顺序闸文案是
   `PRECHECK ORDER OK`）根因同一个：**没匹配到就算过**。现在：

   - 内置预期闸门清单 `scope / record / verify / commit / order` 及各自必填字段；
     缺行、重复行、缺字段一律 `exit 1` 并打印 `GATE MISSING: <gate>`；
   - 行内结论与退出码矛盾（有 `FAIL` 行而 exit=0、或 exit≠0 却全 PASS）判
     `GATE CONTRADICTION` 并 `exit 1`；
   - 真实执行结束后把打印出来的日志回灌 `validateGateLog()` 再验一遍，
     失败打印 `GATE SELFTEST FAIL n=…`（不再信任内存里的布尔值）；
   - 另提供离线入口 `--check-log <file> [--expect-exit N]`，负例测试走这条。

3. **四组负例实跑**（同一份 b306 日志做变形，`--check-log`）：

   ```text
   [1] 原日志                      CHECK-LOG PASS n=0                 exit=0
   [2] 删掉 order 行               GATE MISSING: order                exit=1
   [3] verify 的 PASS 改 FAIL       GATE CONTRADICTION: verify 行内 FAIL 但 exit=0  exit=1
   [4] 同一 FAIL 日志 + --expect-exit 1   CHECK-LOG PASS n=0           exit=0
   ```

   [4] 是防「恒红」控制：校验器不是只会报错，预期 exit 非零时也认。
   另两组（重复行 `GATE DUPLICATE: order (2 行)`、缺字段
   `GATE MISSING: scope field=out_of_scope_edits=`）在 b305 的工具返修阶段已验，口径相同。

4. 起笔前白名单 `350 行 / head=bb01adbd`（随 b305 台账入账），工作树干净，
   `--start` 于 `2026-11-11T07:07:54.744Z` 落盘。
5. 本批 runner 自身返修一次：首跑 `gate: FAIL verify n=1 drift=-1`——`precheck-assert --verify`
   根本不产出 `line_drift`，旧规格却要求 `drift=` 必填，是**规格错**不是读数错。
   改为 verify 阶段不要求 `drift=`，而要求 `verify_ok=true`（即
   `PRECHECK VERIFY n=… hits=… sha=…  OK` 必须出现，缺了同样判红），
   并用 `--from verify` 续跑，**未重复 `--record`，`record_runs` 仍为 1**（不属于判据返修）。
6. 顺序断言：`t-start 07:07:54.744 < t-record 07:08:18.831 < t-verify 07:08:20.014 < commit 15:09:32+08:00`；
   `batch_wall_total=219.0s`（`bb01adbd → 035e00bd`，含批间工具返修），
   `controllable=98.0s`（t-start → commit）。
7. 第 8 行门禁第十八批：`indentChanged=0 eolChanged=0`、`SAME 0`、`touched_restored=0`、
   `line_drift=0`、`out_of_scope_edits=0`。全程 apply-run，无 Edit 返修、无 BOM。
8. 本批结束重生成白名单：**352 行 / `head=035e00bd`**（未提交，随台账一起入账）。

## 1. 计划表

| 文件 | 池内 | 池外 own | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/store/mcpStoreMigration.ts` | 12 | 0 | 12 | 0 |
| `packages/ui/src/v4/ackActivationBarrier.ts` | 12 | 0 | 12 | 0 |
| `packages/ui/src/v4/composer/ConversationSelectionReferenceChip.tsx` | 12 | 0 | 12 | 0 |
| **合计** | **36** | **0** | **36** | **0** |

## 2. 批后池

```text
done files=327（+3）   remain files=680（−3）
done lines=4703（+36） remain lines=2718（−36）
ALIGNED acct_remain=2718 pool_remain=2718 diff=0
完成度 4703 / 7421 = 63.4%
```

- 写入 36 行、池内前移 36 行，一一对应：无 PARTIAL 新增、无自清
  （全仓 `6005 − 5969 = 36`，减少数恰等于落笔数）。
- PARTIAL 仍为 3：`cuaDetails.tsx`（23 → 1）、`script-workflow-process.ts`（13 → 1）、
  `CoveragePanel.tsx`（13 → 2）。
- 全仓：`6005 → 5969`（−36）；池外 `5969 − 2718 = 3251`，与 post-b305 持平。
- `done 4,703` 的台账口径：**「已写入 4,703 行，其中 10 行经 N/P 双读，fail 1」**。

## 3. 计时

```text
t-start    2026-11-11T07:07:54.744Z
t-record   2026-11-11T07:08:18.831Z  record_runs=1
t-verify   2026-11-11T07:08:20.014Z（首轮 verify 因 runner 规格错退出，标记已落；
           修复后 --from verify 重跑通过，未新增 record 轮次）
commit     2026-11-11T15:09:32+08:00  035e00bd

batch_wall_total        = 219.0 s（bb01adbd → 035e00bd，含批间工具返修）
batch_wall_controllable = 98.0 s（t-start → commit）
s/行（端到端）           = 2.72（98.0 / 36）
```

- 小批 n=5（3.69 / 1.75 / 2.72 / 1.39 / 2.72），本批的额外开销来自 runner 规格返修，
  属一次性工具成本，不计入稳定态速率。

## 4. 度量前后

| 文件 | weak 前→后 |
| --- | ---: |
| `store/mcpStoreMigration.ts` | 12 → 0 |
| `v4/ackActivationBarrier.ts` | 12 → 0 |
| `v4/composer/ConversationSelectionReferenceChip.tsx` | 12 → 0 |

- 全仓：`post-b305 6005 / 1832` → `post-b306 5969 / 1829`。
- 池内：`done 4667 / remain 2754` → `done 4703 / remain 2718`。

## 5. 门禁（runner 输出，失败闭合）

```text
gate: PASS scope  n=0 plan=36 allow=0 diff_old=36 diff_new=36 out_of_scope_edits=0
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=035e00bd files=3/3 numstat=36/36 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS order  n=0 total=219.0s controllable=98.0s
GATE ALL PASS batch=b306 sha=035e00bd
```

- 首轮判据 `hits=0`；`record_runs=1`；无 `SAME`、无 Edit 返修。
- `verify` 的 `drift=n/a` 是**规格显式声明**（该阶段不产出 `line_drift`），
  同名位置由 `verify_ok=true` 承担断言，不是「没读到就放过」。

## 6. 收口

```text
GUARD 15文件 pre=4 post=4 新增=0 max=8 → PASS
ACCT files 327 + 680 = 1007 OK
ACCT lines 4703 + 2718 = 7421 OK
ALIGNED acct_remain=2718 pool_remain=2718 diff=0
ledger-assert ASSERT PASS（CLOSE 802 = 802，EXEMPT 2，FILELIST 15 文件 OK）
OWNCOMMITS rows=352 generated=352 missing=0 extra=0 text=same
WHITELIST OK head=035e00bd rows=352
SELF-CLEAR n=0
```

## 7. 首轮命中率（逐批）

| 批 | 首轮 hits | 登记行 | 命中率 |
| --- | ---: | ---: | --- |
| b301 | 2 | 100 | 2.0% |
| b302 | 2 | 36 | 5.6% |
| b303 | 3 | 36 | 8.3% |
| b304 | 0 | 36 | 0.0% |
| b305 | 0 | 36 | 0.0% |
| **b306** | **0** | **36** | **0.0%** |

- b283–b306 二十四批合计 `111 / 1,947 ≈ 5.7%`；近八批（b299–b306）`17 / 407 ≈ 4.2%`。
- b304–b306 连续三批 0 命中。

## 8. 剩余工作量（按 post-b306 更新）

| 口径 | 单位耗时 | 2,718 行折算 | 说明 |
| --- | ---: | ---: | --- |
| 旧新口径 n=7 中位数（90–100 行批） | 1.66 s/行 | 4,512 s ≈ 1.3 h | 只作区间 |
| 30–40 行小批（b302–b306，n=5） | 3.69 / 1.75 / 2.72 / 1.39 / 2.72 s/行 | — | 样本不足 |
| 批次折算（35 行/批） | 35 行/批 | **约 78 批** | `2,718 / 35 ≈ 77.7` |

## 9. 池外对账

| 快照 | 提交 | weak | files | remain | 池外 |
| --- | --- | ---: | ---: | ---: | ---: |
| post-b302 | `3f5f1757` | 6113 | 1841 | 2862 | 3251 |
| post-b303 | `3e50b96c` | 6077 | 1838 | 2826 | 3251 |
| post-b304 | `0b23b3c1` | 6041 | 1835 | 2790 | 3251 |
| post-b305 | `b355ff66` | 6005 | 1832 | 2754 | 3251 |
| post-b306 | `035e00bd` | 5969 | 1829 | 2718 | 3251 |

- `6005 − 5969 = 36` = 池内前移 36 行；池外 3251 不变。
