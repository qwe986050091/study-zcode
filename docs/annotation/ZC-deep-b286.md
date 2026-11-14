# ZC-deep-b286：6 文件 / 97 行（94 池内 + 3 池外）+ 计时口径切换首例

> 批次：b286 ｜ 提交 `a899f645` ｜ 代码 `+97/−97` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v13（`f02be471a849`）、
> `precheck-assert.mjs`（含第 8 行门禁）、`capacity-estimate.mjs`（`3ff652131ef9`）、
> `weak-guard.mjs`（`a3600ccfacab`）、`ledger-assert.mjs`（`35afeb266f97`）。

## 0. 交代

1. 本批 6 文件 / **97 行**：**94 行池内**（计入 `done`）+ **3 行池外 own**
   （`capabilityMapLayout.ts:51/91`（blame `10e9df51`）、`snapshot.ts:56`（blame `522e851e`））。
2. **计时改用新口径**：`--start` 在起草之前调用，`controllable` 与落笔段从此**包含起草时间**；
   与 b281–b283 旧口径不可比，本批为「新口径」第 1 个样本，**不并入 n=11 的 1.59 s/行**。
3. 流程：`--start`（`ts=2026-11-11T03:15:48.474Z`，mtime 快照 20,081 文件）→ 后台 `--watch`
   （10 s 采样，21 轮）→ 起草 → 改写 → `--scope`（`diff_old=97 diff_new=97 out_of_scope_edits=0`）
   → `--record` 首轮 **8 hits**（5 W + 3 L）→ 返修 → `--record`（`hits=0`）→ `--verify`
   → `zc-commit v13` → `--order`。
4. 七行门禁：`expected=6 staged=6`，`+97/−97`，`GATE blob=f02be471a849`。
5. **归档副本补洞（另笔提交）**：`_tools/zc-gate.mjs` 是早期归档，缺 `isNestedComment`；
   直接跑归档版 `_tools/zc-commit-v13.mjs` 会 `SyntaxError`。活文件对在 `_annot_baseline/`
   （`zc-commit.mjs` + `zc-gate.mjs`，gate 即 v4 内容）本就完整，b278–b285 跑的是它。
   本批为可复跑性把同实现补进归档，并核对 `judgeEntries` 与活文件逐字一致；判据读数不受影响。

## 1. 计划表

| 文件 | 池内 | 池外 own | 上游残留 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: | ---: |
| `packages/shared/src/feedback.ts` | 16 | 0 | 4 | 16 | 4 |
| `packages/ui/src/store/pluginManagementStoreEnabled.ts` | 16 | 0 | 0 | 16 | 0 |
| `packages/ui/src/v4/composer/useConversationSelectionReferences.ts` | 16 | 0 | 0 | 16 | 0 |
| `packages/ui/src/v4/WorkbenchSplitDivider.tsx` | 16 | 0 | 0 | 16 | 0 |
| `apps/dev-docs/src/capability-map/capabilityMapLayout.ts` | 15 | 2 | 0 | 17 | 0 |
| `apps/zcode-cli/packages/adapters/src/browser/snapshot.ts` | 15 | 1 | 0 | 16 | 0 |
| **合计** | **94** | **3** | **4** | **97** | **4** |

- `feedback.ts` 改写前 20 行 weak，plan 只取 16 行；剩 4 行不在池内且 blame 不在白名单
  （上游残留），按规则不动。
- 池外 3 行是本线 blame 但不在基线 diff 的 `+` 行里，改写只改善质量、不进 `done`。

## 2. 配额与批后池

```text
PLAN#1（b287）	CHK 待下批起笔时重算
SELF-CLEAR n=0
```

- 批后 `done files=212`（+6）/ `done lines=3124`（+94），`remain files=795` / `remain lines=4297`（−94）。
- **登记 97 行 ≠ done +94**：差的 3 行是池外 own，`capacity-estimate` 按「基线 weak − 现 weak ∩ 池」
  记账，`ALIGNED acct_remain=4297 pool_remain=4297 diff=0`。

## 3. 计时（新口径第 1 个样本，单列）

```text
t-start    2026-11-11T03:15:48.474Z
t-record   2026-11-11T03:19:18.041Z  sha=43f9536d84f7  record_runs=2
t-verify   2026-11-11T03:19:24.173Z  sha=43f9536d84f7  record_runs=2
commit     2026-11-11T03:21:04Z      a899f645

batch_wall_total         = 362.0 s（5a7363a8 → a899f645，含批间台账动作）
batch_wall_controllable  = 316.0 s（t-start → commit，**含起草时间**）
落笔段                   = 215.7 s（t-start → t-verify，**含起草时间**）
tail                     =   6.1 s
record_runs = 2
s/行（新口径）           = 3.26（316.0 / 97，单样本，**不与 n=11 的 1.59 同列**）
```

- **口径切换已生效**：本批正文在 `--start` 之后起草，落笔段与 `controllable` 都包含起草时间，
  因此 3.26 s/行 与旧口径 1.59 s/行不是同一把尺子。旧口径 n=11、中位数 1.59、极差 57.9%
  继续只服务 b281–b283；新口径从本批开始独立累计，样本数与中位数另行登记。
- **比较禁令**：新口径 **n≥5** 之前，不做「新口径比旧口径快/慢」的任何判断或暗示。
  两者分子不同（旧口径不含起草时间），n=1 的 3.26 只能作为单点记录。
- `record_runs=2` 是首轮 8 hits 返修造成的，不表示流程异常。

## 4. 度量前后

| 文件 | weak 前→后 |
| --- | ---: |
| `feedback.ts` | 20 → 4 |
| `pluginManagementStoreEnabled.ts` | 16 → 0 |
| `useConversationSelectionReferences.ts` | 16 → 0 |
| `WorkbenchSplitDivider.tsx` | 16 → 0 |
| `capabilityMapLayout.ts` | 17 → 0 |
| `snapshot.ts` | 16 → 0 |
| **合计** | **101 → 4** |

- 全仓（`--root packages,apps,docs/knip`）：`post-b285 7663 / 1933 文件` → `post-b286 7566 / 1928`
  （−97 行 / −5 文件）；`filler 2595 → 2509`。
- 池内：`post-b285 done 3030 / remain 4391` → `post-b286 done 3124 / remain 4297`（−94）。
- 池外：`post-b286 7566 − 4297 = 3,269`；`post-b285` 为 `3,272`，减少 **3**，正好等于本批 3 行池外 own，
  与池内减少 94 相加 = 97，与登记行数一致。跨批引用一律带快照标签（`INDEX.md` A2 段纪律）。

## 5. 门禁

```text
删本线注释    n=97
删代码        n=0
删上游注释    n=0
新增非注释行  n=0
原行搬移      n=0
标点级改写    n=0
新增注释行    n=97  判据命中 0  嵌套注释 0
numstat: +97 −97
ORDER GATE PASS record=2026-11-11T03:19:18.041Z verify=2026-11-11T03:19:24.173Z files=6
GATE blob=f02be471a849
```

### 5.1 第 8 行门禁

```text
--record  PRECHECK INDENT indentChanged=0 eolChanged=0
--verify  PRECHECK INDENT indentChanged=0 eolChanged=0
```

- 本批 97 行全部是 `//` 注释行，无 JSDoc 开合行进入 plan。
- 判据与负控同 b284/b285（`INDEX.md` §2.6），本批未新增门禁。

### 5.2 预检与越界

```text
--record  run1 hits=8（5 W + 3 L）→ 返修
--record  run2 hits=0
mtime     touched_restored=0
line-drift samples=127（record）/ 133（verify） files=0
越界      write_phase=0 / record_phase=0 / 合计 0
```

- 首轮 8 hits 分两类：
  - **W（无标识符锚点）**：`capabilityMapLayout.ts:159`、`snapshot.ts:307`、`feedback.ts:219/238`、
    `pluginManagementStoreEnabled.ts:38`——正文全中文，没有任何 ≥3 字符的 ASCII 标识符；
  - **L（≥2 个分隔符且无谓词）**：`feedback.ts:73`、`WorkbenchSplitDivider.tsx:80/98`。
- 返修方式：W 行补上真实标识符（`buildGroupGraph` / `isConnected` / `FEEDBACK_TICKET_MODULES` /
  `FEEDBACK_TICKET_TYPES` / `requestId`），L 行补谓词（`由` / `先…再` / `写入`）。
  逐行预判 `judgeEntries` 返回空数组后再跑 `--record`，第二轮 `hits=0`。

## 6. 收口

```text
GUARD 15文件  pre=4  post=4  新增=0  max=8  key=file+正文  → PASS
ACCT files  212 + 795 = 1007  OK
ACCT lines  3124 + 4297 = 7421  OK
ALIGNED acct_remain=4297 pool_remain=4297 diff=0  OK
ledger-assert PASS（802 收口 658/802/802 全 OK；b286 97 行登记被识别为非 802 批次）
WHITELIST OK head=a899f6453d56 rows=290
```

- `PARTIAL 1`：`cuaDetails.tsx` 基线 23 → 现 1，剩余行回池排期（不在本批）。

## 7. 矩阵（四条边界）

| # | 失败模式 | 谁拦 | 读数 / 退出 | 结论 |
| --- | --- | --- | --- | --- |
| ① | 非 plan 行 10 s 内改完又还原 | 无 | — | 唯一真空（已接受风险） |
| ② | 行数改变导致整体位移 | `--record` 集合同构 | `diff_old=97 diff_new=97`，无位移 | 有主 |
| ③ | 文件级还原 | mtime 复拍 | `touched_restored=0` | 已覆盖 |
| ④ | 行级还原（>10 s） | `--watch` + LINE-DRIFT | `files=0` | 有主 |

本批 `--watch` 21 轮、`LINE-DRIFT samples=127/133`，`files=0`；① 仍按已接受风险处理。

## 8. 趋势

| 批 | 归户错 | 文本错 | write_phase | record_phase | 合计 | rolled_back | 首轮命中率 | 明细 |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |
| b283 | 0 | 0 | 0 | 0 | **0** | no | 3/96 = **3.1%** | 2 W + 1 L；缩进/行尾返修 |
| b284 | 0 | 0 | 0 | 0 | **0** | no | 7/100 = **7.0%** | 6 W + 1 L 返修；第 8 行门禁 0/0 |
| b285 | 0 | 0 | 0 | 0 | **0** | no | 1/70 = **1.4%** | 1 W 返修；池外顺延 10 行清零 |
| **b286** | **0** | **0** | **0** | **0** | **0** | **no** | 8/97 = **8.2%** | 5 W + 3 L 返修；新口径计时首例 |

十四批合计：`write_phase 12 + record_phase 0 = 12`。

**首轮命中率口径**：`--record` 首轮 hits / 本批登记行，每批必报。
b283–b286 为 `3.1% / 7.0% / 1.4% / 8.2%`，均值约 4.9%，b286 的 8.2% 仍在正常区间上沿。
若某批显著升高，先查**文件类型构成**（JSDoc 开合行、结构行、长接口声明占比），再决定是否归因于起草质量；
不得只看比值就下结论。

## 9. 剩余工作量（小时级，非天级）

| 口径 | 单位耗时 | 4,297 行折算 | 说明 |
| --- | ---: | ---: | --- |
| 仅 `controllable`（新口径 n=1） | 3.26 s/行 | 14,008 s ≈ **3.9 h** | 只含 `--start`→commit，不含批后台账 |
| 端到端（`--start`→台账提交） | 5.67 s/行 | 24,363 s ≈ **6.8 h** | b286 实测 550 s / 97 行，含门禁、返修、快照、台账 |
| 批次折算 | 100 行/批 | **43 批** | `4,297 / 100 ≈ 43`，每批另含固定动作 |

- 用户口径的 `3.26 s/行 → 3.9 h` 核对无误，但**低估约 1.7 倍**：门禁复跑、返修、
  全仓快照（约 40 s/次）、守卫/产能/台账（约 2–3 min/批）不在 `controllable` 的分子里。
  端到端 `5.67 s/行` 更接近排期口径。
- 结论：剩余工作量是**小时级（约 4–7 小时可控时间 + 43 批固定动作）**，不是天级。
  该倍数来自 n=1，若后续批次 JSDoc 占比升高，倍数只会变大，不会变小。

## 10. 池外对账（b285 → b286）

| 快照 | 提交 | weak 总数 | 池内本线（remain） | 池外合计 |
| --- | --- | ---: | ---: | ---: |
| post-b285 | `00cf1879` | 7663 | 4391 | **3272** |
| post-b286 | `a899f645` | 7566 | 4297 | **3269** |

- `3,272 − 3,269 = 3`，等于本批 3 行池外 own（`capabilityMapLayout.ts:51/91`、`snapshot.ts:56`）；
  池内 `4,391 − 4,297 = 94`；`94 + 3 = 97`，与登记行数闭合。
- 池外上游仍为 2,022 未动；池内上游恒为 0。
