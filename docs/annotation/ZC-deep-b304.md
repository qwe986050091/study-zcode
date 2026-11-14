# ZC-deep-b304：3 文件 / 36 行（全池内，无自清）

> 批次：b304 ｜ 代码提交 `0b23b3c1` ｜ `+36/−36` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v13（`f02be471a849`）、
> `precheck-assert.mjs`（`--start` 实盘逐行基准的第十六批）、
> `capacity-estimate.mjs`、`weak-guard.mjs`、`ledger-assert.mjs`。
> 本批起新增两件工具：`apply-run.mjs`（映射覆盖预检）与 `gate-run.mjs`（单入口门禁 runner）。

## 0. 交代

1. 本批 3 文件 / **36 行，全部池内**（`ownIn=36 ownOut=0 upIn=0 upOut=0 pending=0 plan=36 allow=0`）。
   `12 × 3 = 36`。
2. **工具化改造（本批两件）**：
   - `apply-run.mjs <batch>`：读 `<batch>-plan.tsv` + `<batch>-map.tsv`（`file:line<TAB>文案`），
     开工前做四条硬断言：plan 每行必须有非空文案（缺一条 `exit 1` 并打印 `MISSING` 清单）、
     map 不得有多余键（`EXTRA` 同样 `exit 1`）、写前逐行比对磁盘正文 == plan content、
     写后逐行复核正文 == 文案。四条全过才落盘；任何一条失败都**不动文件**。
     b302 那类「漏填一行、静默少写」在覆盖预检处即被拦住。
   - `gate-run.mjs --batch <b> --subject <前缀>`：一次调用跑完 `--scope` → `--record`（集合断言 +
     `SAME` + `INDENT` + `MTIME` + `line_drift`）→ `--verify` → `zc-commit v13`（七行 + 提交集合断言）
     → `--order`，每条打印 `gate: PASS|FAIL <name> n=<读数>`，任一非零整体 `exit 1`；
     末行 `GATE ALL PASS batch=<b> sha=<sha>`。`--from <scope|record|verify|commit|order>` 只用于
     runner 自身故障修复后的续跑（避免 `--record` 空转加 `record_runs`），不用于跳过真实门禁。
3. 实跑：`apply-run.mjs b304` 输出 `covered=36/36 missing=0 extra=0` / `covered=36/36 changed=36 same=0`；
   负控（从 map 删 1 行）输出 `COVERAGE FAIL missing=1/36` 并 `exit 1`，未落盘。
4. `gate-run` 首跑暴露 runner 自身两处解析缺陷（非代码问题）：`line_drift` 只出现在 `PRECHECK RECORD`
   摘要、`VERIFY` 摘要没有该字段；七行标签用全角空格对齐导致计数正则未命中；顺序闸输出是
   `PRECHECK ORDER OK` 而非 `ORDER GATE PASS`。修好后用 `--from order --sha 0b23b3c1 --prev a8b666b0`
   续跑，输出 `gate: PASS order` + `GATE ALL PASS`。
   **代价**：`--record` 因此多跑一次，`record_runs=2`；首轮判据命中 0，属 runner 返修，不是判据返修。
5. 起笔前白名单 `346 行 / head=3e50b96c`（`a8b666b0` 随 b303 台账入账），工作树干净，
   `--start` 于 `2026-11-11T07:00:52.818Z` 落盘（3 文件实盘逐行基准）。
6. 顺序断言：`t-start 07:00:52.818 < t-record 07:01:54.082 ≤ t-verify 07:01:55.341 < commit 15:02:30+08:00`。
7. 第 8 行门禁第十六批：`indentChanged=0 eolChanged=0`、`SAME 0`、`touched_restored=0`、
   `line_drift=0`、`out_of_scope_edits=0`。全程 apply-run + Edit，无 BOM。
8. 本批结束重生成白名单：**348 行 / `head=0b23b3c1`**（未提交，随台账一起入账）。

## 1. 计划表

| 文件 | 池内 | 池外 own | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/services/src/session/claude-native/claudeNativeSessionImportParser.ts` | 12 | 0 | 12 | 0 |
| `packages/ui/src/conversation-share-interaction/conversationSharePreflightResponse.ts` | 12 | 0 | 12 | 0 |
| `packages/ui/src/project-sidebar/ArchiveManagement.tsx` | 12 | 0 | 12 | 0 |
| **合计** | **36** | **0** | **36** | **0** |

## 2. 批后池

```text
done files=321（+3）   remain files=686
done lines=4631（+36） remain lines=2790（−36）
ALIGNED acct_remain=2790 pool_remain=2790 diff=0
完成度 4631 / 7421 = 62.4%
```

- 写入 36 行、池内前移 36 行，一一对应：无 PARTIAL 新增、无自清。
- PARTIAL 仍为 3：`cuaDetails.tsx`（23 → 1）、`script-workflow-process.ts`（13 → 1）、
  `CoveragePanel.tsx`（13 → 2）。
- 全仓：`6077 → 6041`（−36）；池外 `6041 − 2790 = 3251`，与 post-b303 持平。
- `done 4,631` 的台账口径：**「已写入 4,631 行，其中 10 行经 N/P 双读，fail 1」**。

## 3. 计时

```text
t-start    2026-11-11T07:00:52.818Z
t-record   2026-11-11T07:01:54.082Z  sha=4f25d2380c8f  record_runs=2
t-verify   2026-11-11T07:01:55.341Z  sha=4f25d2380c8f
commit     2026-11-11T15:02:30+08:00  0b23b3c1

batch_wall_total        = 232.0 s（a8b666b0 → 0b23b3c1）
batch_wall_controllable =  98.0 s（t-start → commit）
落笔段                  =  62.5 s（t-start → t-verify）
tail                    =   1.3 s（t-record → t-verify）
s/行（端到端，落笔段）    = 2.72（98.0 / 36）
```

- `total` 含批间工具开发（apply-run / gate-run 编写与负控），**不得除以行数当改写成本**；
  `controllable` 98 s 也含 runner 两次返修，仅作记录。
- 小批 n=3（b302 3.69 / b303 1.75 / b304 2.72），样本仍不足，不给合并值。

## 4. 度量前后

| 文件 | weak 前→后 |
| --- | ---: |
| `claudeNativeSessionImportParser.ts` | 12 → 0 |
| `conversationSharePreflightResponse.ts` | 12 → 0 |
| `ArchiveManagement.tsx` | 12 → 0 |

- 全仓：`post-b303 6077 / 1838` → `post-b304 6041 / 1835`。
- 池内：`done 4595 / remain 2826` → `done 4631 / remain 2790`。

## 5. 门禁

```text
gate: PASS scope  n=0  plan=36 allow=0 diff_old=36 diff_new=36
gate: PASS record n=0  same=0 indent=0/0 mtime=0 drift=0 record_runs=2
gate: PASS verify n=0  same=0 indent=0/0 mtime=0 drift=0
gate: PASS commit n=0  sha=0b23b3c1 files=3/3 numstat=36/36 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS order  n=0  total=232.0s controllable=98.0s
GATE ALL PASS batch=b304 sha=0b23b3c1
```

- 首轮判据命中 `hits=0`（本批零返修）；`record_runs=2` 的原因见 §0.4（runner 解析缺陷续跑）。
- 起草无 `SAME`，`changed=36 same=0`。

## 6. 收口

```text
GUARD 15文件 pre=4 post=4 新增=0 max=8 → PASS
ACCT files 321 + 686 = 1007 OK
ACCT lines 4631 + 2790 = 7421 OK
ALIGNED acct_remain=2790 pool_remain=2790 diff=0
ledger-assert ASSERT PASS（CLOSE 802 = 802，EXEMPT 2）
OWNCOMMITS rows=348 generated=348 missing=0 extra=0 text=same
WHITELIST OK head=0b23b3c1 rows=348
SELF-CLEAR n=0
```

## 7. 首轮命中率（逐批）

| 批 | 首轮 hits | 登记行 | 命中率 |
| --- | ---: | ---: | ---: |
| b299 | 4 | 91 | 4.4% |
| b300 | 6 | 91 | 6.6% |
| b301 | 2 | 100 | 2.0% |
| b302 | 2 | 36 | 5.6% |
| b303 | 3 | 36 | 8.3% |
| **b304** | **0** | **36** | **0.0%** |

- b283–b304 二十二批合计 `111 / 1,875 ≈ 5.9%`；近七批（b298–b304）`21 / 426 ≈ 4.9%`。
- b304 的 0% 来自「先读代码再写映射 + apply-run 覆盖预检」，不含判据返修。

## 8. 剩余工作量（按 post-b304 更新）

| 口径 | 单位耗时 | 2,790 行折算 | 说明 |
| --- | ---: | ---: | --- |
| 旧新口径 n=7 中位数（90–100 行批） | 1.66 s/行 | 4,631 s ≈ 1.3 h | 只作区间 |
| 30–40 行小批（b302–b304，n=3） | 3.69 / 1.75 / 2.72 s/行 | — | 样本不足，不给合并值 |
| 批次折算（35 行/批） | 35 行/批 | **约 80 批** | `2,790 / 35 ≈ 79.7` |

- runner 上线后单批工具调用从十几次压到 4 次（apply / judge / gate-run / 快照），后续批的实际墙钟会低于以上折算。

## 9. 池外对账

| 快照 | 提交 | weak | files | remain | 池外 |
| --- | --- | ---: | ---: | ---: | ---: |
| post-b300 | `b910ddfa` | 6250 | 1852 | 2998 | 3252 |
| post-b301 | `abccbe47` | 6149 | 1844 | 2898 | 3251 |
| post-b302 | `3f5f1757` | 6113 | 1841 | 2862 | 3251 |
| post-b303 | `3e50b96c` | 6077 | 1838 | 2826 | 3251 |
| post-b304 | `0b23b3c1` | 6041 | 1835 | 2790 | 3251 |

- `6077 − 6041 = 36` = 池内前移 36 行；池外 3251 不变。
