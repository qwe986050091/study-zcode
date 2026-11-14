# ZC-deep-b305：3 文件 / 36 行（全池内，无自清）

> 批次：b305 ｜ 代码提交 `b355ff66` ｜ `+36/−36` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v13（`f02be471a849`）、
> `precheck-assert.mjs`（`--start` 实盘逐行基准的第十七批）、
> `capacity-estimate.mjs`、`weak-guard.mjs`、`ledger-assert.mjs`
> ｜流程：`apply-run.mjs` + `gate-run.mjs`（b304 上线，本批首次一次性跑完）。

## 0. 交代

1. 本批 3 文件 / **36 行，全部池内**（`ownIn=36 ownOut=0 upIn=0 upOut=0 pending=0 plan=36 allow=0`）。
   `12 × 3 = 36`。
2. **首次全流程走新工具**：
   - `apply-run.mjs b305` → `covered=36/36 missing=0 extra=0` / `covered=36/36 changed=36 same=0`；
   - `gate-run.mjs --batch b305 --subject …` → 单次调用输出 5 条 `gate: PASS` + `GATE ALL PASS`。
   单批工具调用从十几次压到 4 次（apply / judge / gate / 快照），本批门禁本身耗时 50 s。
3. 起笔前白名单 `348 行 / head=0b23b3c1`（`ff3167eb` 随 b304 台账入账），工作树干净，
   `--start` 于 `2026-11-11T07:04:06Z` 落盘（3 文件实盘逐行基准）。
4. 顺序断言：`t-start 07:04:06 < t-record 07:04:34.341 < commit 15:04:56+08:00`；
   `batch_wall_total=64.0s`（`ff3167eb → b355ff66`），`controllable=50.0s`（t-start → commit）。
5. 第 8 行门禁第十七批：`indentChanged=0 eolChanged=0`、`SAME 0`、`touched_restored=0`、
   `line_drift=0`、`out_of_scope_edits=0`。全程 apply-run，无 Edit 返修、无 BOM。
6. 本批结束重生成白名单：**350 行 / `head=b355ff66`**（未提交，随台账一起入账）。

## 1. 计划表

| 文件 | 池内 | 池外 own | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/settings/PluginScopeMenu.tsx` | 12 | 0 | 12 | 0 |
| `packages/ui/src/settings/model-provider-section/ProviderModelMetadataDialogActions.tsx` | 12 | 0 | 12 | 0 |
| `packages/ui/src/slashCommandPanelSections.tsx` | 12 | 0 | 12 | 0 |
| **合计** | **36** | **0** | **36** | **0** |

## 2. 批后池

```text
done files=324（+3）   remain files=683
done lines=4667（+36） remain lines=2754（−36）
ALIGNED acct_remain=2754 pool_remain=2754 diff=0
完成度 4667 / 7421 = 62.9%
```

- 写入 36 行、池内前移 36 行，一一对应：无 PARTIAL 新增、无自清。
- PARTIAL 仍为 3：`cuaDetails.tsx`（23 → 1）、`script-workflow-process.ts`（13 → 1）、
  `CoveragePanel.tsx`（13 → 2）。
- 全仓：`6041 → 6005`（−36）；池外 `6005 − 2754 = 3251`，与 post-b304 持平。
- `done 4,667` 的台账口径：**「已写入 4,667 行，其中 10 行经 N/P 双读，fail 1」**。

## 3. 计时

```text
t-start    2026-11-11T07:04:06Z（由 controllable 反推，runner --start 未打印时间戳）
t-record   2026-11-11T07:04:34.341Z  record_runs=1
t-verify   2026-11-11T07:04:55Z（同批，早于 commit）
commit     2026-11-11T15:04:56+08:00  b355ff66

batch_wall_total        = 64.0 s（ff3167eb → b355ff66）
batch_wall_controllable = 50.0 s（t-start → commit）
s/行（端到端）           = 1.39（50.0 / 36）
```

- 小批 n=4（3.69 / 1.75 / 2.72 / 1.39），本批是 runner 上线后的首个「无返修、无 Edit」样本；
  样本仍不足，不给合并值。

## 4. 度量前后

| 文件 | weak 前→后 |
| --- | ---: |
| `settings/PluginScopeMenu.tsx` | 12 → 0 |
| `settings/model-provider-section/ProviderModelMetadataDialogActions.tsx` | 12 → 0 |
| `slashCommandPanelSections.tsx` | 12 → 0 |

- 全仓：`post-b304 6041 / 1835` → `post-b305 6005 / 1832`。
- 池内：`done 4631 / remain 2790` → `done 4667 / remain 2754`。

## 5. 门禁（runner 单次输出）

```text
gate: PASS scope  n=0 plan=36 allow=0 diff_old=36 diff_new=36
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS commit n=0 sha=b355ff66 files=3/3 numstat=36/36 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS order  n=0 total=64.0s controllable=50.0s
GATE ALL PASS batch=b305 sha=b355ff66
```

- 首轮判据 `hits=0`；`record_runs=1`；无 `SAME`、无 Edit 返修。

## 6. 收口

```text
GUARD 15文件 pre=4 post=4 新增=0 max=8 → PASS
ACCT files 324 + 683 = 1007 OK
ACCT lines 4667 + 2754 = 7421 OK
ALIGNED acct_remain=2754 pool_remain=2754 diff=0
ledger-assert ASSERT PASS（CLOSE 802 = 802，EXEMPT 2，FILELIST 15 文件 OK）
OWNCOMMITS rows=350 generated=350 missing=0 extra=0 text=same
WHITELIST OK head=b355ff66 rows=350
SELF-CLEAR n=0
```

## 7. 首轮命中率（逐批）

| 批 | 首轮 hits | 登记行 | 命中率 |
| --- | ---: | ---: | ---: |
| b300 | 6 | 91 | 6.6% |
| b301 | 2 | 100 | 2.0% |
| b302 | 2 | 36 | 5.6% |
| b303 | 3 | 36 | 8.3% |
| b304 | 0 | 36 | 0.0% |
| **b305** | **0** | **36** | **0.0%** |

- b283–b305 二十三批合计 `111 / 1,911 ≈ 5.8%`；近七批（b299–b305）`17 / 371 ≈ 4.6%`。
- b304–b305 连续两批 0 命中：apply-run 覆盖预检 + 先读代码再写映射，未出现「写了但被判据打回」。

## 8. 剩余工作量（按 post-b305 更新）

| 口径 | 单位耗时 | 2,754 行折算 | 说明 |
| --- | ---: | ---: | --- |
| 旧新口径 n=7 中位数（90–100 行批） | 1.66 s/行 | 4,572 s ≈ 1.3 h | 只作区间 |
| 30–40 行小批（b302–b305，n=4） | 3.69 / 1.75 / 2.72 / 1.39 s/行 | — | 样本不足 |
| 批次折算（35 行/批） | 35 行/批 | **约 79 批** | `2,754 / 35 ≈ 78.7` |

## 9. 池外对账

| 快照 | 提交 | weak | files | remain | 池外 |
| --- | --- | ---: | ---: | ---: | ---: |
| post-b301 | `abccbe47` | 6149 | 1844 | 2898 | 3251 |
| post-b302 | `3f5f1757` | 6113 | 1841 | 2862 | 3251 |
| post-b303 | `3e50b96c` | 6077 | 1838 | 2826 | 3251 |
| post-b304 | `0b23b3c1` | 6041 | 1835 | 2790 | 3251 |
| post-b305 | `b355ff66` | 6005 | 1832 | 2754 | 3251 |

- `6041 − 6005 = 36` = 池内前移 36 行；池外 3251 不变。
