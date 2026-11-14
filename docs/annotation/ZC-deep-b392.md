# ZC 深度注释 · b392 台账（cap 20 试验第 2 批）

> 提交：`6f49bfa9`（代码 20 行 / 20 文件，+20/−20）
> 批前基准：`b391-repo-post.txt`；批后快照：`b392-repo-post.txt`
> 口径：`CLOSING.md` §5 / `_tools/INDEX.md` §5.3 与 §6.2

## 0. 三列

| 判据类 | 格式类 | lint |
| ---: | ---: | ---: |
| **0**（`judge-generic` hits=0） | **0**（`diffset-assert` missing=0 extra=0） | **首轮 4 → 修后 0** |

- lint 首轮 4 条全部是本地规则（分隔符 `[、,，]` 超 1 个 3 条、禁用词「因此」1 条），不是内容问题；改分号与同义替换后一次过。
- 判据类放行仍只认 `deep-quality` 全仓扫描 0 残留（§5.3 4b），本批未跑全仓放行，只跑了 `judge`（本批新增行）。

## 0.1 cap 20 试验第 2 批：原判据被邻接自清污染，**回退结论作废**

| 判据 | 阈值 | 原始读数 | 修正判据读数 | 结论 |
| --- | --- | --- | --- | --- |
| `controllable` | ≤ 1.5 × 130.4 = **195.6s** | 150.0s | 149.1s | PASS |
| 六闸一次全 PASS | 是 | 否（`pool-diff` 首轮 3 条未登记） | 登记后 PASS | 见下 |
| `removed` | **= 20** | 23 | `removed 23 − selfclear_batch 3 = 20` | **PASS（修正后）** |

- **判据本身错了**：`removed == plan` 会被**邻接自清**干扰——块尾 `*/` 与下一行同句元，下一行转强后 `*/` 也消失，`removed` 必然多 3。这个数与 cap 大小无关（cap 10 下同样出现，b367 有先例），所以它测的不是 cap。
- **修正判据**：`removed − selfclear_batch == plan`（`selfclear_batch` = 本批消失行中已登记的自清行，人工 + 自动）。b392 读数 `23 − 3 = 20` ✔。
- **闸只出原始量，判定在收口侧**：`gate-run.mjs` 的 `pool-diff` 行只打印 `removed` / `selfclear_batch`，并落盘 `<batch>-pooldiff.json`；
  `closeout.mjs` 读这两个数与**独立来源** `<batch>-plan.tsv` 行数比对，打印
  `[cap 判据] removed=23 − selfclear_batch=3 = 20，plan.tsv=20 → OK`。闸不再自证「比对通过」。
- **因此回退 cap 10 的结论作废**：b393 仍按 **cap 20** 跑（试验第 3 批），另两条判据不动；连续两批全绿（b392 修正后 + b393）才写死进 CLOSING。
- 代价量化：159 行按 cap 10 是 16 批、cap 20 是 8 批，收口 `169s/批`，差 `8 × 169 = 1,352s ≈ 0.38h`，占 cap 10 主报 `1.18h` 的三分之一。

## 0.2 三条池外 `*/` 行「不再 weak」的归因

- **改前判据**（`b391-repo-post.txt` 原样）：
```
WEAK apps/zcode-cli/packages/core/src/tool/handlers/bash-command-parser.ts:144  无解释
WEAK apps/zcode-cli/packages/debug/src/shared.ts:319                           无解释
WEAK apps/zcode-cli/packages/telemetry/src/agent-trace-runtime.ts:444          无解释
```
- **改后**：同一扫描里三行都不再出现；同文件其它 `*/` 仍在，说明不是「`*/` 这一类被整体豁免」：
```
WEAK .../debug/src/shared.ts:315            无解释
WEAK .../telemetry/src/agent-trace-runtime.ts:1000 / 1295 / 1322 / 1795   无解释
```
- **机制**（`deep-quality.mjs` 源码可复算）：
  1. `cleanBlock('*/')` → 空串，行本身没有任何内容；
  2. `sentenceUnit()` 把相邻注释行并成「整句」，直到遇到句末标点；`*/` 的下一行是 `//`，被并入同一句元；
  3. `isWeakLine(unit)` 用**并后的整句**判「无解释」：没有标识符/数字/中文名词/前置条件即 weak。
- **所以是三段「判据随同句元变化」**，逐条对照：

| 行 | 改前同句元（含下一行） | 改后同句元 | 判据 |
| --- | --- | --- | --- |
| `bash-command-parser.ts:144` | 「回答的是…把 `true` 读成放行」（`true` 不算标识符） | 含 `isBashCommandPermissionSafe` | 无解释 → 有锚点 |
| `debug/src/shared.ts:319` | 「归因四键全部可选…省略键」（无标识符） | 含 `NetworkRequestAttribution`、`trace` | 无解释 → 有锚点 |
| `agent-trace-runtime.ts:444` | 「非前台执行作为独立根。」（无标识符） | 含 `executionKind`、`linkedRoot`、`ROOT_CONTEXT` | 无解释 → 有锚点 |

- **结论**：既不是行被删（六闸 `删上游=0`、行数 1→1 未变），也不是物理并入新注释块（块结构没动），而是**扫描按整句归类时，下一行补了锚点**。
  因此「池外残留」的分子会在改写相邻行时自动减少 3，**不能读成上游债被清了 3 行**；这条口径写进 CLOSING §1 与 §7。

## 1. 逐文件（批前 weak → 批后 weak，合计 44 → 21）

| 文件 | 前 | 后 |
| --- | ---: | ---: |
| `core/src/mcp/image-normalization.ts` | 2 | 1 |
| `core/src/runtime/methods/index.ts` | 1 | 0 |
| `core/src/runtime/methods/rewind-message.ts` | 1 | 0 |
| `core/src/tool/handlers/bash-command-parser.ts` | 3 | 1 |
| `core/src/tool/handlers/bash-read-file-sources.ts` | 1 | 0 |
| `core/src/tool/handlers/bash-readonly-policy-callbacks.ts` | 3 | 2 |
| `core/src/tool/handlers/read.ts` | 3 | 2 |
| `core/src/workflow/scheduler/collection-planner.ts` | 1 | 0 |
| `debug/src/shared.ts` | 4 | 2 |
| `dynamic-workflow/src/schema/emit.ts` | 1 | 0 |
| `dynamic-workflow/src/testing/journal-contract-runs.ts` | 1 | 0 |
| `ios-simulator-plugin/src/mcp/server.ts` | 1 | 0 |
| `node-repl-host/src/cua-bridge.ts` | 1 | 0 |
| `telemetry/src/agent-trace-runtime.ts` | 15 | 13 |
| `telemetry/src/bootstrap.ts` | 1 | 0 |
| `tui/src/app-tool-transcript.ts` | 1 | 0 |
| `packages/client/src/webRemoteControlAcknowledgedRelayProtocol.ts` | 1 | 0 |
| `packages/client/src/websocket.ts` | 1 | 0 |
| `packages/desktop/scripts/gen-ui-fixture/file-summary.tsx` | 1 | 0 |
| `packages/desktop/scripts/gen-ui-fixture/main.ts` | 1 | 0 |

固定对账三列：

| 清理 | 全仓清零 | 注解清零 | 归类清零 | 新进 |
| ---: | ---: | ---: | ---: | ---: |
| **20** | **14** | **14** | **0** | **0** |

- **两个清零口径分开记**：`注解清零`=该文件最后一行 weak 由本批改写清除；`归类清零`=没有任何改写行、仅因邻接位移离场。
  回填 b390–b392 为 `8/0`、`15/0`、`14/0`（脚本按「批前 weak>0 且批后无 weak」的文件逐一对 `plan.tsv` 成员身份判定）。
- **那 5 个表外文件不是归类清零**：`methods/index.ts`、`collection-planner.ts`、`cua-bridge.ts`、`webRelayProtocol.ts`、`file-summary.tsx` 批前各只有 **1 行** weak，
  行号正是本批改写的那一行（如 `file-summary.tsx:25` 批前为 `WEAK … 夹具只服务截图与端到端测试`），所以是**注解清零**。
  池外减少的 3 行与这 5 个文件无关，是另一批 3 条 `*/` 的归类位移（§0.2）。

- **交叉核对（两套独立记录）**：`全仓清零 14 = 表内 +9 + 表外 −5`。
  表内 `CLEARED 168 → 177`（+9），表外 `81 → 76`（−5），两边都能从残留台账复算，与逐文件清零的 14 个对上。
- **`表外文件` 与 `池外行` 是两个集合**（本批易混点）：表外差集移除的 5 个文件各只有 **1 行** weak，且 5 行**全部是池内可写行**（在 20 行计划里）；
  池外行从 `3,236` 减到 `3,233`，减的 **3 行**是 `bash-command-parser.ts:144`、`debug/src/shared.ts:319`、`telemetry/src/agent-trace-runtime.ts:444` 三条块尾 `*/`。
  5 个文件离场是**文件级**变化，3 行减少是**行级**变化，两者不同源，不能互相解释。
- **表外差集**（`ZC-deep-b392-outside-diff.tsv`，`dir/path/cause` 三列）：新增 **0** / 移除 **5**，5 行 `cause` 全为 `annotation`（都在本批计划里，不是归类位移）。
  - `core/src/runtime/methods/index.ts`
  - `core/src/workflow/scheduler/collection-planner.ts`
  - `node-repl-host/src/cua-bridge.ts`
  - `packages/client/src/webRemoteControlAcknowledgedRelayProtocol.ts`
  - `packages/desktop/scripts/gen-ui-fixture/file-summary.tsx`

## 2. 六闸原文（同一提交 `6f49bfa9`，分两段跑）

第一段（`--batch b392`，止于 `pool-diff` 失败）：

```
gate: PASS scope n=0 plan=20 allow=0 diff_old=20 diff_new=20 out_of_scope_edits=0 plan_lines_covered=20/20
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=6f49bfa9 files=20/20 numstat=20/20 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: FAIL pool-diff n=3 removed=23 added=0 allowed=35 auto_self_clear=0
    ! UNREGISTERED SELF-CLEAR .../bash-command-parser.ts:144 (own blame)
    ! UNREGISTERED SELF-CLEAR .../debug/src/shared.ts:319 (own blame)
    ! UNREGISTERED SELF-CLEAR .../telemetry/src/agent-trace-runtime.ts:444 (own blame)
```

第二段（登记 3 行后 `--from pool-diff --sha 6f49bfa9 --prev 883ec155`）：

```
gate: PASS pool-diff n=0 removed=23 added=0 selfclear_batch=3 allowed=38 auto_self_clear=0
gate: PASS order n=0 total=586.0s controllable=150.0s
GATE ALL PASS batch=b392 sha=6f49bfa9
```

- `allowed = 20 计划 + 15 已登记 + 3 人工登记 = 38`。
- 3 行登记进 `docs/annotation/POOL-SELF-CLEAR.tsv`（`out-of-pool`，人工列，成因写明「块尾 `*/` 与下一行同句元」）。
- `total=586.0s` 是「上一提交 → 本提交」，含批间动作，**不当改写成本用**；本批成本看 `controllable=150.0s`。
- 第一段与第二段是同一提交的两个阶段，不是两批；判「一次全 PASS」时按第一段算，故 §0.1 记 FAIL。

## 3. 进度与残余

| 项 | 值 |
| --- | --- |
| 池内可写行 | **159**（done 7,262 / 7,421 = **97.9%**） |
| 池内文件 | **159**（done 848 / 1,007 = 84.2%），辅助 |
| 全仓 weak | **3,392 行** |
| 池外残留 | **3,233 行**（3,392 − 159） |
| 集合 | `1,419 = ACTIVE 1,343 + 表外 76`（**定义恒等，非校验**：表外 = 扫描文件数 − ACTIVE） |
| 表内 | `1,520 = ACTIVE 1,343 + CLEARED 177`（**定义恒等，非校验**：CLEARED = 台账 − 扫描命中） |

- `ALIGNED OK`：`acct_remain 159 == pool_remain 159`。
- 剩余形状仍是 **159 文件 × 1 行**，cap 20 下每批 20 文件 = 20 行，共 8 批（退回 cap 10 则为 16 批）。

## 4. 计时

| 读数 | 起点 | 终点 | 秒 |
| --- | --- | --- | ---: |
| `total` | `883ec155`（18:41:24） | `6f49bfa9`（18:51:10） | 586.0 |
| `controllable` | `--start`（18:48:40.9） | 批次提交（18:51:10） | **149.1 ± 0.5**（闸报 150.0） |
| **S0** 收口准备 | 18:52:33 | 18:52:41.6 | **8.6**（`closeout` 自报：扫描 7.3 + capacity 1.1 + own-commits 0.2） |
| **S1** 失败诊断 | 18:51:10 | 18:52:33 | **83.0** |
| **S2** 人工登记 + 第二段六闸 | 18:52:41.6 | 18:53:08.6 | **27.0** |
| **S3a** 台账与快照（稳态） | 18:53:08.6 | 18:54:15.8 | **67.2** |
| **S3b** CLOSING + INDEX 填数（文档） | 18:54:15.8 | 18:56:41.3 | **145.5** |
| **S4** 提交 | 18:56:41.3 | 18:57:04 | **22.7** |
| **收口 S0–S4（分段和）** | 18:51:10 | 18:57:04 | **354.0**（8.6 + 83.0 + 27.0 + 67.2 + 145.5 + 22.7） |
| **批墙钟（实测端点）** | 18:48:40.9 | 18:57:04 | **503.1** |

TOOL_TRIP: 110.0（`S1` 失败诊断 83.0 + `S2` 登记与二段闸 27.0；两者都是 `pool-diff` 首轮 FAIL 之后的重复执行）
- b394 回标：净收口 `354.0 − 110.0 = 244.0s`，净墙钟 `503.1 − 110.0 = 393.1s`。
- 注意 `S2` 台账记 `27.0`，与 `S0 8.6` 相加才是 `35.6`；此前批报把 `35.6` 说成「S2」，是把 `S0` 重复计入，已订正。

- `controllable 149.1s` + 收口 `354.0s` = **503.1s**，与实测端点一致；闸报 `150.0` 是「提交秒戳 − 起笔秒戳取整」的差 `0.9s`。
- `controllable 149.1s` vs 模型 `61.4 + 20 × 3.45 = 130.4s`：**1.14×**，高 `14%`，来自 lint 首轮 4 条 BAD 的「改脚本 → 重跑」往返 `44.9s`。
- `S3b 145.5s` 是文档改写量（本批口径条目多，见下），**不含** CRLF 返工——本批全部逐行单行替换，一次未失败。
  它把包络上沿抬到 `503.1s`，但**不动中位**（`136.3 / 169.1 / 354.0` 的第 2 个仍是 `169.1`）；b393 收口后即滚出。
- **S3b 对照（答 b391 遗留的第 ④ 点）**：`145.5s`，**没有回落到 ~56s**，也**不是**「一次性 CRLF 返工退出窗口」。
  b391 的 `101.0s` 里 CRLF 返工只占 `40–50s`，剩下的是文档改写量；本批逐条写 CLOSING 的 cap 20 结论、B 切换点订正、3 条自清登记、§5.3/§5.4 重算，条数更多，故更长。
  结论：**A 口径中位不变（169.1s）**，cap 20 主报 `0.66h` 不因本批 S3b 而移动；S3b 的主变量是「本批要改多少条口径」，不是「有没有 CRLF 返工」。

## 5. 主报与参考档（cap 20 复核口径）

- 剩余 159 行 / 159 文件 → cap 20 下 `ceil(159 / 20) = 8` 批（b393 复核中）；若退回 cap 10 则 16 批。
- **两档参考（`--cost=A`，含文档全成本）**，对外只报 `0.66h`：
  - **主报 · 含政策变更**：`8 × 61.4 + 159 × 3.45 + 8 × 169.1 = 2,392.55s = 0.66h`，区间 `0.49–0.79h`。
    适用条件：S3b 维持 b390–b392 的密度（这三批恰是 cap 结论、B 切换点、3 条自清登记、§5.3/5.4 重算最密的三批）。
  - **参考 · 稳态下界**：S3b 回到 ~56s、收口 ≈113s → `8 × 61.4 + 159 × 3.45 + 8 × 113 = 1,943.75s = 0.54h`，区间 `0.39–0.64h`。
    触发条件：b393 起无口径变更，CLOSING/INDEX 只填数不改口径。
- **cap 10 退路（触发条件：b393 复核不过）**：同式 16 批 → 含政策变更 `1.18h`、稳态 `0.93h`；两者差 `0.38h` 全部是 8 次收口。
- 观测包络（参考，不进主报，cap 20）：`8 × 250.3 ÷ 3600 = 0.56h`、`8 × 503.1 ÷ 3600 = 1.12h`。
- B 口径（窗口三批都有 S3a/S3b，`--cost=B`）：cap 20 下 `8 × 61.4 + 159 × 3.45 + 8 × 80.3 = 1,682.15s = 0.47h`，**只作参考**，不与 A 并行当主报。

## 6. 提交

- 代码：`6f49bfa9`（20 文件 / 20 行）
- 文档：`cf77a870`（本台账 + `rewrite.tsv` + `outside-diff.tsv` + CLOSING/INDEX）；计时回填另起一条提交
