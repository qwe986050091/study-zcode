# ZC-deep-b282：注释清水 82 行（6 文件）· 行级漂移采样上线 · plan 缺失硬失败 · 新口径样本 n=10

> 批次：b282 ｜ 提交 `769584b9` ｜ 代码 `+82/−82` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v13（`f02be471a849`）、
> `capacity-estimate.mjs`（`3ff652131ef9`）、`weak-guard.mjs`（`a3600ccfacab`）、
> `ledger-assert.mjs`（`35afeb266f97`）、`precheck-assert.mjs`（`0eedbcb107fb`）。

## 0. 交代

1. 起笔前 `--start` 在干净树上通过（`ts=2026-11-11T02:18:46.206Z`），mtime 快照 20,070 文件。
   上一轮因关机中断，先核对了 `git status` 为空、`daa89fa2`（b281 批）与 `99cbac4d`（b281 台账）、
   `34c5d7ce`（本批工具前置）都在，无半截提交；`ledger-assert` 当时即 `ASSERT PASS`。
2. 本批 6 文件 / **82 行**：`writable=82 / upstream=0 / self-clearing=0 / pool-out=0 / pending=0`。
   2 行来自 `featureSuggestedPromptRotation.ts:124-125`（b281 顺延），其余 5 个文件各 16 行。
3. 未凑满 100 行是有意的：池内单文件可写上限只有 16-17 行，取 `2 + 16×5 = 82` 已经用满 6 文件上限；
   再找第 7 个文件会破坏 ≤6 文件约束。**宁少不越界**。
4. 流程：`--start` → 后台 `--watch`（10 s 采样）→ 改写 → `--scope`
   （`plan=82 allow=0 diff_old=82 diff_new=82 out_of_scope_edits=0`）→ `--record`
   （首轮 6 W 命中，返修）→ `--record`（`hits=0`）→ `--verify` → `zc-commit v13` → `--order`。
5. 七行门禁：`expected=6 staged=6`，`+82/−82`，`GATE blob=f02be471a849`。
6. 批后 6 个文件 weak 全部清零；全仓 `WEAK lines=7935 files=1946`（b281 后 8,017 / 1,952）。

## 1. 三列计划表

```text
PLAN#1	6 文件 / 82 行	writable=82 upstream=0 self-clearing=0 pool-out=0 pending=0
quota=100，本批实际取 82（池内同批可写行用尽，不拆文件凑数）
四态和=82=池内实测 82
```

| 文件 | 可写 | 上游 | 池外 | 小计 | 本批 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `packages/ui/src/v4/featureSuggestedPromptRotation.ts` | 2 | 0 | 0 | 2 | 2 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-debug.ts` | 16 | 0 | 0 | 16 | 16 |
| `apps/zcode-cli/packages/core/src/runtime/methods/compact-summary-model-request.ts` | 16 | 0 | 0 | 16 | 16 |
| `docs/knip/docs/scripts/generate-plugin-docs.ts` | 16 | 0 | 0 | 16 | 16 |
| `packages/desktop/src/host/sourceServerReleaseResolver.ts` | 16 | 0 | 0 | 16 | 16 |
| `packages/server/src/remote/remoteAssetPreflight.ts` | 16 | 0 | 0 | 16 | 16 |
| **合计** | **82** | **0** | **0** | **82** | **82** |

- 6 个文件的 weak 行全部 `blame=a8784b7e479d3a`、全部在池内，`allow=0`（没有任何池外行被登记）。
- 选片顺序：先接 b281 顺延的 2 行，再取候选表里池内 16-17 行且 `out=0` 的文件，
  刻意避开 `session-inputs.ts` / `apply.ts` / `browserControlMainBridge.ts` 这类带池外行的文件，
  避免为本批引入 `allow` 噪音（池外已定性为明确排除，不借批次夹带）。

## 2. 配额扣减与批后池

```text
SELF-CLEAR n=82	可写桶 82 / 池外 0 / 上游桶 0 / 未解析 0
```

- 82 行全部登记在 `ZC-deep-b282-rewrite.tsv`（83 行含表头），**批前即落盘**。
- 批后 `done files=190`（+6）/ `done lines=2770`（+82），`remain files=817` / `remain lines=4651`（−82）。
- `PARTIAL 1`：`cuaDetails.tsx`（基线 23 → 现 1，b263 遗留），按剩余行回池排期。

## 3. 计时：四量（新口径样本 n=10）

```text
t-start    2026-11-11 10:18:46.206 +08:00
t-record   2026-11-11 10:20:10.588 +08:00  sha=2a5e0548486b  record_runs=2
t-verify   2026-11-11 10:20:16.282 +08:00  sha=2a5e0548486b  record_runs=2
commit     2026-11-11 10:20:35 +08:00  769584b9

batch_wall_total         = 19,241 s  ← **不可比**：上一提交 04:59:54，中间跨关机中断
batch_wall_controllable  = 108.8 s（t-start → commit）
落笔段                   =  90.1 s（t-start → t-verify）
tail                     =   5.7 s（t-record → t-verify）
record_runs = 2
s/行                     = 1.10（90.1 ÷ 82）
```

- `total` 这次被关机拉长到 5 小时 20 分，只作为「四戳完整」的旁证，**不进入中位数与极差**；
  中断属于环境事件，不是工艺变慢。以后遇到断点恢复，同样只用 `controllable` 与落笔段。
- `--order --commit 769584b9 --prev 769584b9^` 输出 `PRECHECK ORDER OK`（四戳单调）。

### 3.1 主档建议（n=10）

```text
样本（落笔段 s/行）  … b279 1.07 / b280 1.59 / b281 1.86 / b282 1.10
中位数               1.55 s/行
极差                 1.98 − 1.06 = 0.92 s/行（中位数的 59.4%）
record_runs 分布     1 → 1 批（b273）；2 → 9 批（b274–b282）；3+ → 0 批
结论                 **仍不切换主档**：极差 59.4%，与 b280 同值；n=10 没有把宽度压窄
```

- 82 行的小批把 s/行 压到 1.10，但极差没有改善——再次印证「批间波动不是样本量问题」。
  按用户口径，主档维持「不切换」，等 `record_runs ≥ 3` 的实样本再论证，不再每批重复讨论。

## 4. 度量前后（同批 6 文件，批前 `_wt_b282_pre` / 批后主工作区）

| 文件 | weak 前→后 | comments | substance 前→后 | explain 前→后 | filler 前→后 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `featureSuggestedPromptRotation.ts` | 2 → 0 | 41 | — 合计口径 — | | |
| `session-debug.ts` | 16 → 0 | 90 | | | |
| `compact-summary-model-request.ts` | 16 → 0 | 96 | | | |
| `generate-plugin-docs.ts` | 16 → 0 | 61 | | | |
| `sourceServerReleaseResolver.ts` | 16 → 0 | 46 | | | |
| `remoteAssetPreflight.ts` | 16 → 0 | 43 | | | |
| **合计** | **82 → 0** | **377** | **79.0 → 91.8** | **92.3 → 100.0** | **21.0 → 0.0** |

- `units=736`（前后同值），`coverage=9.2% / branch=10.7%` 前后不变：只改注释，未动代码。
- 全仓同域：`WEAK 8017/1952` → **`7935 / 1946`**（−82 行 / −6 文件，6 个文件全部清零）；
  `filler 2930 → 2851`。
- 池外仍为 **`7935 − 4651 = 3,284` 行**——b280、b281、b282 连续三批同值，排除口径稳定。

## 5. 七行门禁

```text
删本线注释    n=82
删代码        n=0
删上游注释    n=0
新增非注释行  n=0
原行搬移      n=0
标点级改写    n=0
新增注释行    n=82  判据命中 0  嵌套注释 0
numstat: +82 −82
expected=6  staged=6
ORDER GATE PASS record=2026-11-11T02:20:10.588Z verify=2026-11-11T02:20:16.282Z files=6
GATE self=d:\code\_annot_baseline\zc-commit.mjs blob=f02be471a849
```

### 5.1 预检与越界

```text
--scope   plan=82 allow=0 diff_old=82 diff_new=82 out_of_scope_edits=0
--record  run1  hits=6（全部 W）→ 返修
--record  run2  hits=0
mtime     touched_restored=0
line-drift samples=49 files=0
越界      write_phase=0 / record_phase=0 / 合计 0
```

- 首轮 6 条都是「单行无信息」（缺 ASCII 标识符）：`generate-plugin-docs.ts:108/199`、
  `sourceServerReleaseResolver.ts:69/70`、`remoteAssetPreflight.ts:105/122`；
  分别补 `enablers.length`、`href`、`baseUrls`、`ResolvedDescriptor`、`&&`、`separatorIndex` 后 `hits=0`。
- 本批**没有**行级或文件级还原：`writes-b282.tsv` 共 49 个样本，非 plan 行 sha 始终只有
  「start(HEAD)」与「record(工作树)」两种值（实际相等），`LINE-DRIFT files=0`。

## 6. 收口

### 6.1 守卫

```text
WEAK 15文件  pre=4  post=4  新增=0  max=8  key=file+正文
GUARD PASS
```

### 6.2 产能

```text
WHITELIST OK head=769584b97b81 rows=275
BATCHCHK b282  OK
done files=190 lines=2770  perBatch=2
REMAIN 817 4651 - 409
ACCT files  190 + 817 = 1007  OK
ACCT lines  2770 + 4651 = 7421  OK
ACCT NOTE 恒等式只对池内成立（池 = 基线 diff 的 + 行 ∩ 本线 blame）；池外 weak 不进 done/remain，另计为外部观测
ALIGNED acct_remain=4651 pool_remain=4651 diff=0  OK
ASSERT PASS
```

`ledger-assert PASS`（802 收口三列 `144/658/802` 全 OK，b282 的 tsv 按非 802 批次 `IGNORED`）。
本批推进 `remain`：4,733 → **4,651**。

## 7. 本批工具交付

### 7.1 行级「改过又还原」：`--watch` + `writes-<batch>.tsv`

- 做法：`--watch --plan <tsv>` 每 10 s 对 `--files` 里的文件拍一次**非 plan 行**的 sha，
  追加到 `writes-<batch>.tsv`（`ts / kind / file / sha`）；`--record`、`--verify` 末尾按
  「start = `git show <base>:<file>`」「record = 工作树」两种合法 sha 复核，出现第三种即
  `PRECHECK LINE-DRIFT files=N` + `LINE-DRIFT HIT <file> sha=… 出现 k 次`（只报不拦，计入 `write_phase`）。
- 为什么不是整文件 sha：本线每批都在持续改计划行，整文件 sha 在批中必然出现大量第三种值，
  全是假阳性。**非 plan 行**才是不该动的部分，且 1→1 改写保证行号不变，所以它必须逐字节恒定。
- 正负控（worktree `_wt_b282_ctl`，`mermaidRenderBudget.ts` 2 行 plan）：

  | 控 | 操作 | 实测 |
  | --- | --- | --- |
  | 负控 | 只改 plan 内 2 行 | `LINE-DRIFT samples=7 files=0`，`line_drift=0` |
  | 正控 | 另把 1 行非 plan 注释改成 `DRIFT PROBE`、停留 5 s 再还原 | `LINE-DRIFT samples=8 files=1` + `LINE-DRIFT HIT …/mermaidRenderBudget.ts 非 plan 行样本 sha=2358fa1b 出现 3 次`，`exit 0`（不拦） |
  | 边界 | 10 s 内改完又还原 | **拍不到**，仍靠人工自查记账（b281 的 `embeddedBrowserHelpers.ts:111` 属此类） |
  | 边界 | 某批改变行数 | **责任在 `--record` 集合同构（`exit 8`）**；watcher 只作冗余读数，见 §7.2 ④ |
- 本批实跑：`samples=49 files=0`，`writes-b282.tsv` 留在仓库外 `_annot_baseline/`。

### 7.2 边界 × 门禁矩阵（b283 申请单）

四条残留边界逐条定责，完整表在 `_tools/INDEX.md` §2.6：

| # | 失败模式 | 责任人 | 读数 | 阻断 |
| --- | --- | --- | --- | --- |
| ① | 整文件改过又还原 | mtime 复拍 | `touched_restored=N` | 否（只计） |
| ② | 非 plan 行还原 >10 s | `--watch` + LINE-DRIFT | `LINE-DRIFT files=M` + sha | 否（只计） |
| ③ | 非 plan 行还原 <10 s | **无** | — | **已接受风险** |
| ④ | 行数改变 / 整体位移 | **`--record` 集合同构**（主） | 越界/漏改 + `exit 8` | 是 |
| ⑤ | `--files` 之外被写 | 下一批 `--start` 脏树断言 | `exit 6` | 是（延迟一批） |
| ⑥ | 判据漏判 | `zc-commit` + `weak-guard` | 判据命中 / 新增 >0 → `exit 1` | 是（近似） |

- ④ 的怀疑被证实：`scopeCheck()` 用「diff 新行号」与 plan 行号（= 基线行号）求差，插入一行会让该 hunk 之后
  所有新行号 +1，`outNew` 立即非空；删行命中 `missing`；一行拆两行则第二行越界——三种都在判据之前 `exit 8`。
  所以 watcher 原先写的「行数改变需人工判读」是**归责错误**，已改成「冗余路径，真发生说明契约先破」。
  `zc-commit` 的 `numstat +N −M` 只打印不对比，注释行 1→2 若都过判据不会红，不能当 ④ 的责任人。
- ③ 接受而不补工具：瞬时还原净效果为零，未完全还原的残留必然进最终 diff 被 ④ 或七行门禁拦住；
  要闭合只能让所有写操作走 `zc-write` 统一写闸，属于改工作方式，单独立项。
- ⑤ 接受：未提交的写会留在工作树，下一批 `--start` 直接 `exit 6`；代价是延迟一批，且手工 `checkout` 会留不下痕迹。
- 本轮**不新增门禁**，矩阵作为申请单留在 INDEX；b283 照常推进。

### 7.3 plan 缺失硬失败

`--plan` 指向的文件不存在时，`precheck-assert` 在进入任何统计前直接 `exit 2`：

```text
PRECHECK RECORD FAIL 缺 plan 文件 …\no-such-plan.tsv：登记表未落盘，改动行集合与 ACCT 都会指向错误方向
exit=2
```

起因是 b281 的假信号：`ZC-deep-b281-rewrite.tsv` 没落盘，`ALIGNED diff=100` 把一次正确的批报成「漂移」。
现在这类错误在预检阶段就失败，不再由 ACCT 差值承担报错职责。

## 8. 趋势：归户错 / 文本错 / 越界

| 批 | 归户错 | 文本错 | write_phase | record_phase | 合计 | rolled_back | includes_upstream | `record_runs` | 明细 |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | --- |
| b278 | 0 | 0 | 0 | 0 | **0** | no | no | 2 | 3 W，无越界 |
| b279 | 0 | 0 | 1 | 0 | **1** | yes | no | 2 | `useWebElementContexts.ts:84` 整块替换越界 |
| b280 | 0 | 0 | 3 | 0 | **3** | yes | no | 2 | `remoteWorkspaceServiceCollection.ts:180-182` |
| b281 | 0 | 0 | 1 | 0 | **1** | yes | no | 2 | `embeddedBrowserHelpers.ts:111` 行级还原，mtime 测不到 |
| **b282** | **0** | **0** | **0** | **0** | **0** | **no** | **no** | **2** | 6 W 返修；`LINE-DRIFT files=0`、`touched_restored=0` |

十批合计：`write_phase 12 + record_phase 0 = 12`；b282 是**首个带行级漂移工具读数**的零越界批。

## 9. 池外定性与 A2 恒等式

- 池外 `3,284` 行 / 1,308 文件，b280→b282 三批同值；继续按「明确排除」处理，不纳入 `remain`。
- A2：`done + remain == 7,421`，**该恒等式只对池内成立，池外 3,284 行另计**。
- 三断言：`remain == 0` 未达成；`done + remain == 7421` OK；`ledger-assert PASS` OK。

## 10. 事后追溯：缩进 / 行尾残留（b285 前置，第 8 行门禁回放）

第 8 行门禁上线后对 `769584b9^..769584b9` 回放，抓出 **`indentChanged=20`**：3 文件 20 条 `//` 行注释的
原缩进被整行重建抹成顶格（`session-debug.ts` 9、`compact-summary-model-request.ts` 4、
`generate-plugin-docs.ts` 7）。全部是函数体 / 块内的行注释，无 JSDoc `*` 续行，**判定「只影响排版」**；
改写后的正文不变，代码行零改动。同期工作树还留着 3 个文件的 EOL 残留（`w/mixed`、`w/lf`、`w/mixed`），
而正常文件是 `w/crlf`。

修复 `6b765c30`：按旧侧前导空白回填 20 行，并把三个文件归一为 CRLF；`git diff -w --stat` 为空、`+20/−20`。
工具、判定与全表见 [`ZC-deep-history-audit.md`](ZC-deep-history-audit.md)；b283 的 12 条已由 `5522d403` 抵消，
b261–b281、b284 均为 0。
