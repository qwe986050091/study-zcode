# ZC-deep-b285：b284 顺延行收口 + 4 个新文件（6 文件 / 70 行）

> 批次：b285 ｜ 提交 `00cf1879` ｜ 代码 `+70/−70` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v13（`f02be471a849`）、
> `precheck-assert.mjs`（含第 8 行门禁）、`capacity-estimate.mjs`（`3ff652131ef9`）、
> `weak-guard.mjs`（`a3600ccfacab`）、`ledger-assert.mjs`（`35afeb266f97`）。

## 0. 交代

1. 本批 6 文件 / **70 行**（4+2+16+16+16+16）：**64 行池内**（计入 `done`）+ **6 行池外顺延**
   （`network-capture.ts` 4、`browserControlMainBridge.ts` 2，质量收益、不计 `done`）。
2. b284 顺延的 14 行下落：**10 行已清**（network 8、browser 2）；
   **4 行是上游注释**（`workflow-notification-copy.ts:302/345`、`browserControlMainBridge.ts:407`、
   `apply.ts:200`，blame 不在白名单），按规则不动，继续登记为上游残留。
3. `network-capture.ts` 的 4 个 `/**` 开合行（82/115/396/443）本身不能改写：
   它们被判 weak 只是因为下一行摘要太短；摘要行补上标识符后，这 4 行自动转强。
   因此本批 plan 不含开合行，改写后该文件 weak `8 → 0`。
4. 流程：`--start`（`ts=2026-11-11T02:58:25.311Z`，mtime 快照 20,079 文件）→ 后台 `--watch`
   （10 s 采样，3 轮）→ 改写 → `--scope`（`diff_old=70 diff_new=70 out_of_scope_edits=0`）
   → `--record` 首轮 1 W（`mentionSearch.ts:74` 只有数字锚点，`zc-gate` 不认数字）→ 返修
   → `--record`（`hits=0`）→ `--verify` → `zc-commit v13` → `--order`。
5. 七行门禁：`expected=6 staged=6`，`+70/−70`，`GATE blob=f02be471a849`。

## 1. 计划表

| 文件 | 池内 | 池外 | 上游残留 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: | ---: |
| `apps/zcode-cli/packages/debug/server/network-capture.ts` | 0 | 8 | 0 | 4 | 0 |
| `packages/desktop/src/host/browserControlMainBridge.ts` | 0 | 3 | 1 | 2 | 1 |
| `packages/ui/src/lib/zcodeFileCitation.ts` | 16 | 0 | 0 | 16 | 0 |
| `packages/ui/src/mentions/mentionSearch.ts` | 16 | 0 | 0 | 16 | 0 |
| `packages/ui/src/settings/DataBaseDirControl.tsx` | 16 | 0 | 0 | 16 | 0 |
| `packages/ui/src/settings/usage-stats/usageStatsUiParts.tsx` | 16 | 0 | 0 | 16 | 0 |
| **合计** | **64** | **11** | **1** | **70** | **1** |

- 池外 11 行中 6 行本批改写、4 行（`network-capture` 的 JSDoc 开合行）随摘要转强、1 行上游不动。
- 4 个新文件全部 `blame=a8784b7e479d3a`；`network-capture` / `browserControlMainBridge` 为 `3ead6c6a` / `e6ff6fab`。

## 2. 配额与批后池

```text
SELF-CLEAR n=4	可写桶 0 / 池外 4（network-capture 的 4 个 JSDoc 开合行）
PLAN#1（b286）	6 文件 / 94 行	writable=94 upstream=0 self-clearing=0 pool-out=7 pending=0 quota=94
```

- 批后 `done files=206`（+4）/ `done lines=3030`（+64），`remain files=801` / `remain lines=4391`（−64）。
- **登记 70 行 ≠ done +64**：差的 6 行是池外顺延行，只改善质量、不进 `done`；`capacity-estimate`
  按「基线 weak − 现 weak ∩ 池」记账，`ALIGNED acct_remain=4391 pool_remain=4391 diff=0`。

## 3. 计时（再次不进入中位数）

```text
t-start    2026-11-11 10:58:25.311 +08:00
t-record   2026-11-11 10:58:59.793 +08:00  sha=de3d537cea48  record_runs=2
t-verify   2026-11-11 10:59:06.404 +08:00  sha=de3d537cea48  record_runs=2
commit     2026-11-11 11:00:03 +08:00  00cf1879

batch_wall_total         = 411.0 s（c5f494a6 → 00cf1879，含起笔前白名单提交与快照扫描）
batch_wall_controllable  =  98.0 s
落笔段                   =  41.1 s（t-start → t-verify）
tail                     =   6.6 s
record_runs = 2
s/行                     = 0.59（不进入样本）
```

- 与 b284 同因：70 条正文在 `--start` 之前就已随 `b285-apply.mjs` 写好，落笔段只含脚本执行 + 预检 + 返修。
  **本批第二次出现「正文先于起笔完成」**，已在 §8 记为流程债；下批必须 `--start` 后再起草，否则计时列连续失效。
- 新口径仍按 **n=11、中位数 1.59 s/行、极差 57.9%** 报，b285 单列为「测量口径失效样本」。
- **口径切换（b286 起，必须单列）**：改成「先 `--start` 再起草」后，`controllable` 与落笔段**会包含起草时间**，
  与 b281–b283 的旧口径（起草发生在 `--start` 之前、不计入）不可比。b286 起另起一列「新口径」样本，
  n=11 的 1.59 s/行只服务旧口径，两者不得放进同一列求中位数或极差。

## 4. 度量前后

| 文件 | weak 前→后 | substance 前→后 | filler 前→后 |
| --- | ---: | ---: | ---: |
| `network-capture.ts` | 8 → 0 | 68.1 → 71.4 | 0.0 → 0.0 |
| `browserControlMainBridge.ts` | 3 → 1 | 92.1 → 93.9 | 0.0 → 0.0 |
| `zcodeFileCitation.ts` | 16 → 0 | 65.1 → 90.7 | 37.2 → 0.0 |
| `mentionSearch.ts` | 16 → 0 | 69.4 → 91.8 | 32.7 → 0.0 |
| `DataBaseDirControl.tsx` | 16 → 0 | 69.0 → 92.9 | 38.1 → 0.0 |
| `usageStatsUiParts.tsx` | 16 → 0 | 58.7 → 87.0 | 32.6 → 0.0 |
| **合计** | **75 → 1** | **73.6 → 86.0** | **15.3 → 0.0** |

- `units=822`、`comments=413` 前后同值；`explain 91.0 → 99.8`；剩下的 1 行 weak 是上游 `browserControlMainBridge.ts:407`。
- 全仓：`WEAK 7737/1938` → **`7663 / 1933`**（−74 行 / −5 文件）；`filler 2658 → 2595`。
- 池外：`7663 − 4391 = 3,272`（b284 为 3,282，减少 10 = 6 行改写 + 4 个 JSDoc 开合行转强）。

## 5. 门禁

```text
删本线注释    n=70
删代码        n=0
删上游注释    n=0
新增非注释行  n=0
原行搬移      n=0
标点级改写    n=0
新增注释行    n=70  判据命中 0  嵌套注释 0
numstat: +70 −70
ORDER GATE PASS record=2026-11-11T02:58:59.793Z verify=2026-11-11T02:59:06.404Z files=6
GATE blob=f02be471a849
```

### 5.1 第 8 行门禁

```text
--record  PRECHECK INDENT indentChanged=0 eolChanged=0
--verify  PRECHECK INDENT indentChanged=0 eolChanged=0
```

- 本批含 4 条 JSDoc 摘要行（` * 正文`），apply 仍按「取原行前导空白 + 原换行符」写回，
  `indentChanged` / `eolChanged` 均为 0。
- 判据、负控与 b284 相同（`INDEX.md` §2.6），本批未新增门禁。
- **JSDoc 开合行的判据噪声（记一笔）**：`/**` / ` */` 本身正文为空，被判 weak 是因为它与下一行摘要
  被拼成同一个「句子」；摘要补上标识符后，开合行自动转强（本批 4 行即此）。这说明 weak 判据对
  JSDoc 开合行有系统性误判，**这类行不该进 plan**（本批已按结构行过滤）。判据本身不改：一改会
  重算 b261–b285 的历史读数，收益不值。

### 5.2 预检与越界

```text
--record  run1 hits=1（mentionSearch.ts:74 W）→ 返修
--record  run2 hits=0
mtime     touched_restored=0
line-drift samples=19（record）/ 25（verify） files=0
越界      write_phase=0 / record_phase=0 / 合计 0
```

- 返修原因：`// 前缀命中得长度差，子串命中得 100 + 下标…` 只带数字锚点；
  `zc-gate` 的 W 判据只认标识符 / PRECOND / INVARIANT，不认数字。改为
  `// 前缀命中返回长度差，子串命中返回 100 + indexOf，前者天然更优。` 后 `hits=0`。

## 6. 收口

```text
GUARD 15文件  pre=4  post=4  新增=0  max=8  key=file+正文  → PASS
ACCT files  206 + 801 = 1007  OK
ACCT lines  3030 + 4391 = 7421  OK
ALIGNED acct_remain=4391 pool_remain=4391 diff=0  OK
ledger-assert PASS（802 收口 658/802/802 全 OK）
WHITELIST OK head=00cf1879f497 rows=287
```

## 7. 矩阵（四条边界，读数与 b284 同口径）

| # | 失败模式 | 谁拦 | 读数 / 退出 | 结论 |
| --- | --- | --- | --- | --- |
| ① | 非 plan 行 10 s 内改完又还原 | 无 | — | 唯一真空（已接受风险） |
| ② | 行数改变导致整体位移 | `--record` 集合同构 | `diff_old=70 diff_new=70`，无位移 | 有主 |
| ③ | 文件级还原 | mtime 复拍 | `touched_restored=0` | 已覆盖 |
| ④ | 行级还原（>10 s） | `--watch` + LINE-DRIFT | `files=0` | 有主 |

本批无 ① 的读数是正常的：窗口内没有非 plan 行写操作；① 仍按已接受风险处理。

## 8. 趋势

| 批 | 归户错 | 文本错 | write_phase | record_phase | 合计 | rolled_back | 明细 |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| b282 | 0 | 0 | 0 | 0 | **0** | no | 6 W 返修 |
| b283 | 0 | 0 | 0 | 0 | **0** | no | 2 W + 1 L；缩进/行尾返修（工具副作用） |
| b284 | 0 | 0 | 0 | 0 | **0** | no | 6 W + 1 L 返修；第 8 行门禁 0/0 |
| **b285** | **0** | **0** | **0** | **0** | **0** | **no** | 1 W 返修；池外顺延 10 行清零 |

十三批合计：`write_phase 12 + record_phase 0 = 12`。

- **流程债（两批连续）**：b284、b285 的正文都在 `--start` 前完成，`s/行` 不可比。
  b286 起把「先 `--start`、再起草正文」写进起笔顺序；若再出现，必须在台账里明确标注，不许混入中位数。

## 9. 池外对账（b283 → b285）与 A2

独立复算（`_annot_baseline/b285-pool-recon.mjs`：weak 快照 × `git diff -U0 8f7daaf0 <commit>` 的池 × 各时点白名单 blame，不引用台账里的池外数）：

| 快照 | 提交 | weak 总数 | 池内本线（remain） | 池外 own | 池外上游 | 池外合计 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| post-b283 | `c9576925` | 7839 | 4555 | 1262 | 2022 | **3284** |
| post-b284 | `22994ad3` | 7737 | 4455 | 1260 | 2022 | **3282** |
| post-b285 | `00cf1879` | 7663 | 4391 | 1250 | 2022 | **3272** |

- **3,284 是 b283 批后的读数，不是 b284 的**。b284 §9 原文是「池外 3,282 行（b283 后 3,284，减少的 2 行为邻行 weak 翻转）」——
  它当时已经登记了 −2，只是把 3,284 作为对照写在括号里。
- b284 → b285 的差集：`removed=74 added=0`，其中 `pool-own 64 + out-own 10`。
  池外减 **10** = 6 行本批改写（`network-capture.ts` 4 + `browserControlMainBridge.ts` 2）
  + 4 个 JSDoc 开合行（`network-capture.ts` 82/115/396/443）随摘要转强。
- 所以 `3,282 − 3,272 = 10`，与「本批写了 6 行池外」不矛盾；`3,284 − 3,272 = 12` 是**跨 b283→b285 两批**的合计，不是本批。
- 池外上游三档恒为 2,022 未动；池内上游恒为 0（`remain` 就是池内 weak 全体）。
- A2：`done + remain == 7,421`，只对池内成立；池外另计。上游残留 4 行（b284 顺延中不可改的部分）
  继续留在池外观测，不入 `done`、不入 `remain`。
