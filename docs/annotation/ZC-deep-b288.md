# ZC-deep-b288：6 文件 / 90 行（全池内）+ 1 行邻行自清

> 批次：b288 ｜ 提交 `e5da2497` ｜ 代码 `+90/−90` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v13（`f02be471a849`）、
> `precheck-assert.mjs`（含第 8 行门禁）、`capacity-estimate.mjs`、`weak-guard.mjs`、`ledger-assert.mjs`。

## 0. 交代

1. 本批 6 文件 / **90 行，全部池内**（own，无池外 own）。
2. 新口径第 3 个样本：`--start`（`2026-11-11T03:34:56.877Z`）先于起草，后台 `--watch` 10 s 采样（19 ticks）。
3. 流程：`--start` → 起草 → 改写 → 判据预判（3 轮）→ `--scope`（`plan=90 diff_old=90 diff_new=90 out_of_scope=0`）
   → `--record`（**首次被第 8 行门禁拦下，见 §5**）→ 修 EOL → `--record`（`hits=0 record_runs=2`）
   → `--verify` → `zc-commit v13` → `--order`。
4. 七行门禁：`expected=6 staged=6`，`+90/−90`；顺序断言 `t-start < t-record ≤ t-verify < commit`。
5. 与 b287 的差别：本批**没有池外 own 行**，`done +90` 与登记 90 闭合；池外仅 −1（邻行自清）。

## 1. 计划表

| 文件 | 池内 | 池外 own | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `apps/zcode-cli/packages/core/src/tool/handlers/bash-output.ts` | 15 | 0 | 15 | 0 |
| `apps/zcode-cli/packages/core/src/tool/handlers/cron.ts` | 15 | 0 | 15 | 0 |
| `apps/zcode-cli/packages/telemetry/src/error-sanitizer.ts` | 15 | 0 | 15 | 0 |
| `packages/provider-node/src/provider-config-file-codec.ts` | 15 | 0 | 15 | 0 |
| `packages/shared/src/feedbackPrivacy.ts` | 15 | 0 | 15 | 0 |
| `packages/shared/src/gen-ui/tweakProtocol.ts` | 15 | 0 | 15 | 0 |
| **合计** | **90** | **0** | **90** | **0** |

## 2. 批后池

```text
done files=224（+6）  remain files=783
done lines=3304（+90） remain lines=4117（−90）
ALIGNED acct_remain=4117 pool_remain=4117 diff=0
```

- 登记 90 行 == `done +90`，无池外 own 差额。
- 池外另有 **1 行上游**（`cron.ts:216`）因相邻改写自动转强，
  由 `capacity-estimate` 记为 `SELF-CLEAR n=1 / out-of-pool`，不进 `done`。

## 3. 计时（新口径 n=3，仍单列）

```text
t-start    2026-11-11T03:34:56.877Z
t-record   2026-11-11T03:38:12.338Z  sha=c8d3e27d7dad  record_runs=2
t-verify   2026-11-11T03:38:18.224Z
commit     2026-11-11T11:38:47+08:00  e5da2497

batch_wall_total        = 252.0 s
batch_wall_controllable = 231.0 s（含起草时间）
落笔段                  = 201.3 s（含起草时间）
tail                    =   5.9 s
s/行（新口径，端到端）  = 2.57（231.0 / 90）
```

- 新口径累计 **n=3**（3.26、1.62、2.57），**仍不做与旧口径 1.59 的快慢比较**；
  n≥5 前不取中位数、不做新口径内部结论。
- `batch_wall_total` 含批间非改写动作（本批含收口清单的文档提交），不得除以行数当改写成本。

## 4. 度量前后

| 文件 | weak 前→后 |
| --- | ---: |
| `bash-output.ts` | 15 → 0 |
| `cron.ts` | 16 → 0 |
| `error-sanitizer.ts` | 15 → 0 |
| `provider-config-file-codec.ts` | 15 → 0 |
| `feedbackPrivacy.ts` | 15 → 0 |
| `tweakProtocol.ts` | 15 → 0 |
| **合计** | **91 → 0** |

- 全仓：`post-b287 7471 / 1924` → `post-b288 7380 / 1918`（−91 行 / −6 文件）；`filler 2419 → 2340`。
- 池内：`post-b287 done 3214 / remain 4207` → `post-b288 done 3304 / remain 4117`（−90），完成度 **44.5%**。
- 池外：`post-b288 7380 − 4117 = 3263`；`post-b287` 为 `3264`，减少 **1**（`cron.ts:216` 邻行自清）；
  `90 + 1 = 91`，与全仓减少量闭合。

## 5. 门禁

```text
删本线注释 n=90   删代码 n=0   删上游注释 n=0
新增非注释行 n=0  原行搬移 n=0  标点级改写 n=0
新增注释行 n=90   判据命中 0   嵌套注释 0
numstat: +90 −90
PRECHECK INDENT indentChanged=0 eolChanged=0（record / verify 各一次）
PRECHECK MTIME  touched_restored=0
PRECHECK LINE-DRIFT samples=121 files=0
ORDER GATE PASS
```

- **第 8 行门禁首次实拦**：`--record` 首跑报 `eolChanged=15`，逐行 `\r\n => \n`，全部落在 `cron.ts`。
  根因不是改写文案，而是 `cron.ts` 工作树在批前已是 LF，而门禁的「替换前」取
  `git cat-file --filters HEAD:<file>`，按工作区属性 smudge 出 CRLF。把该文件统一回 CRLF 后
  `eolChanged=0`，`git diff` 仍为 15 行（clean filter 把 CRLF 归一，对象库内容不变）。
  **代价**：`record_runs` 由 1 变 2，多一轮 record + diff 复算。
  **b289 起已改基准**：门禁的「替换前」改取 `--start` 的实盘逐行快照（`<batch>-lines.json`），
  与 `git` 配置解耦；同一场景（实盘 LF、`.gitattributes` 强制 `eol=crlf`、改 15 行注释）新实现
  `eolChanged=0`，旧实现 `eolChanged=15`，负控记录在 `INDEX`。
- 首轮预判 `hits=6`（1 POEM + 4 W + 1 L），第二轮 `hits=2`（W），第三轮 `hits=0`。
  - POEM：`feedbackPrivacy.ts:24` 起始的连续 3 行纯中文短句（`poem run`），改写正文后断开。
  - W：`error-sanitizer.ts:85`、`feedbackPrivacy.ts:94/97`、`tweakProtocol.ts:102`，正文无 ASCII 锚点。
  - L：`error-sanitizer.ts:133`，两个 `、` 且无谓词。
  - `b288-apply.mjs` 报 **2 处 `SAME`**（`error-sanitizer.ts:84/133`）：替换文案与原文逐字相同，等于没改写。
    其中 133 首轮被判 L，84 未被判据命中但仍属「未生效改写」，两者一并重写。
    这类 `SAME` 不是判据分歧，是起草时的空替换。**b289 起 SAME 进 `--record`/`--verify` 门禁**
    （`PRECHECK SAME same_rewrites=0`，非零 `exit 1`），不再只靠 apply 脚本自觉。

## 6. 收口

```text
GUARD 15文件 pre=4 post=4 新增=0 max=8 → PASS
ACCT files 224 + 783 = 1007 OK
ACCT lines 3304 + 4117 = 7421 OK
ALIGNED acct_remain=4117 pool_remain=4117 diff=0
ledger-assert ASSERT PASS（CLOSE 802 = 802，EXEMPT 2）
OWNCOMMITS rows=298 generated=298 missing=0 extra=0 text=same
WHITELIST OK head=e5da249728de rows=298
PARTIAL 1：cuaDetails.tsx 基线 23 → 现 1
```

## 7. 首轮命中率（逐批）

| 批 | 首轮 hits | 登记行 | 命中率 |
| --- | ---: | ---: | ---: |
| b283 | 3 | 96 | 3.1% |
| b284 | 7 | 100 | 7.0% |
| b285 | 1 | 70 | 1.4% |
| b286 | 8 | 97 | 8.2% |
| b287 | 2 | 92 | 2.2% |
| **b288** | **6** | **90** | **6.7%** |

- 六批均值约 4.8%。b288 回升到 6.7%，文件类型是 3 个 TS + 2 个脱敏/编码模块 + 1 个 schema 模块，
  JSDoc 与结构行占比与 b286 相近；6 条命中里 2 条是 `SAME`（未生效改写），
  扣掉后按真实新写正文计为 4 条（4.4%），与均值一致，不构成起草质量回退。

## 8. 剩余工作量（按 post-b288 更新）

| 口径 | 单位耗时 | 4,117 行折算 | 说明 |
| --- | ---: | ---: | --- |
| `controllable`（新口径 n=3） | 3.26 / 1.62 / 2.57 s/行 | 13,421 / 6,670 / 10,580 s ≈ 1.9–3.7 h | 只作区间，不取单点 |
| 端到端（b286 实测） | 5.67 s/行 | 23,343 s ≈ **6.5 h** | 含门禁、返修、快照、台账 |
| 批次折算 | 90 行/批 | **约 41–46 批** | `4,117 / 90 ≈ 46`，按 b287/b288 实际批大小 |

- 结论不变：剩余工作量**小时级（约 4–7 小时可控时间 + 约 45 批固定动作）**，不是天级。
- 新口径三样本离散（3.26 / 1.62 / 2.57），b288 的 2.57 含一次 EOL 门禁返修；样本仍不足，不做归因。

## 9. 池外对账

| 快照 | 提交 | weak | files | remain | 池外 |
| --- | --- | ---: | ---: | ---: | ---: |
| post-b287 | `c8e58ba3` | 7471 | 1924 | 4207 | 3264 |
| post-b288 | `e5da2497` | 7380 | 1918 | 4117 | 3263 |

- `3264 − 3263 = 1` = `cron.ts:216` 邻行自清（上游 blame、非池）；池内 `4207 − 4117 = 90`；
  `90 + 1 = 91` = `7471 − 7380`。
- 本批无池外 own 行，故池外减少量等于 `SELF-CLEAR` 数，不存在「登记 90 而全仓减 95」那类差额。
