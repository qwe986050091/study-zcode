# ZC-deep-b263：5 文件 / 100 行改写批 + 池外汇总口径 + `s/文件` 单位错/数值错 + ACCT 差 1 行定位

- 日期：2026-11-10
- base：`608a8b5b`（b262 台账提交）
- 代码提交：`2e779933 b263 改写 (+100/−100)`
- 尺子：`deep-quality` v2.0（`756bea66122a`）+ `zc-gate` v4（`633b334905ee`）+ `zc-commit` v12（`a35b42fa2e4c`）+ `own-commits` v2（`f56b84fbf964`）+ `ledger-assert` `35afeb266f97` + `capacity-estimate` `8d31b38559da` + `weak-guard` `a3600ccfacab`

## 0. 三项交代的结论

| # | 问题 | 结论 | 位置 |
| --- | --- | --- | --- |
| 1 | 池外 weak（v3 白名单重算后 1,270 条）是什么 | 全是**本线白名单提交**写的（27 个提交），0 条上游；分界是**时间**（`8f7daaf0` 之前）不是归属 | §1（b264 返工） |
| 2 | `20.6 s/文件` 错在哪 | 单位错：不能乘文件数/批数；数值不错：隐含 8.2 行/文件，与 PLAN 的 7.30 差 12% | §2 |
| 3 | `ACCT 6,724` 与重算 `6,725` 差 1 行 | `packages/ui/src/ToolCallBlocks/renderers/cuaDetails.tsx:14`，b234 登了 22 行、漏登这一行，ACCT 按整文件记 `done` 于是多扣 1 行；b264 改行口径后该行回池，差值归零 | §3（b264 返工） |

## 1. 1,270 条池外 weak：定性、收口语义、补做代价

> **b264 返工**：本节原按 v2 散文白名单登记（own=1,132 / upstream=2,173 / commits_own=15），
> b264 把白名单改成机器生成（作者口径 214 条）后重算，有 138 行从「上游」翻回「本线」，
> 池外本线与上游两个数、以及下方分布表全部改写。恒等式左右两边（9,981）不变。

### 1.1 写死的恒等式（b264 按 v3 白名单重算，时点 `0cab755e` = b261 后、b262 前）

```text
9,981 = 6,676（本工程范围，可做） + 1,270（历史遗留，显式不排期） + 2,035（上游，不可动）
```

复核方式（同一把尺子、同一次运行，不是拼接）：干净 worktree `0cab755e`，`deep-quality --root packages,apps --list-weak`
得 `9,981` 条；`b263-outofpool.mjs` 按 `git diff -U0 8f7daaf0 HEAD` 的 `+` 行划池，再对池外逐文件 `git blame --porcelain` 归户：

```text
SPLIT weak_total=9981 in_pool=6676 out_pool=3305
OUTPOOL own=1270 upstream=2035 unparsed=0 commits_own=27 commits_upstream=5
```

**收口标准 = 池内 `6,676` 清零（b264 起点为 `6,476`，见 §1.4），不是全仓 `9,981` 清零。**
`--list-weak` 的全仓读数永远不会到 0，下限是 §1.4 的「池外本线 + 上游」两块之和；
b262 单列的地板 `2,173` 按新白名单是 `2,035`。

### 1.2 这 1,270 条有没有「可做 / 不可做」分界

**有，但分界不是归属，是时间。**

| 判据 | 结果 | 依据 |
| --- | --- | --- |
| 是否在本线白名单提交里 | **全部在**（27 个提交，`commits_own=27`，`upstream=0`） | 池外 3,305 条里 blame ∈ 白名单的正好 1,270 条 |
| 门禁能不能删/改 | **能**：`zc-gate` 只拦「删上游注释」，这些行 blame 在册 | `own-commits --check` 判「本线」 |
| 为什么进不了池 | 都在 `8f7daaf0`（2026-11-10 审计快照基线）**之前**写下，池子只收 `git diff 8f7daaf0..HEAD` 的 `+` 行 | `diffsets.mjs` 定义 |
| 为什么不在 PLAN 里 | `capacity-estimate` 的基线是 `weak-own-by-file.tsv`，它只收 8f7daaf0 之后的行 | 台账 §2.5 |

也就是说：**它们不是「不可动」，是「没被排期」**。判据只排除 `2,035` 条上游（改不了），
剩下 `1,270` 条按门禁是可以改的，缺的只是一个显式决定。本批的决定是：**显式不排期**，
理由是与当前 802 / PLAN 两条线不重叠，混进来会让「池内清零」这个唯一收口标准失效。

分布（27 个本线提交，前 4 个占 60%）：

| 提交 | 行数 | 提交 | 行数 |
| --- | ---: | --- | ---: |
| `878e95da` | 257 | `bce5596a` | 20 |
| `522e851e` | 169 | `e6ff6fab` | 15 |
| `ad6dc0eb` | 168 | `deb218da` | 14 |
| `b3cc6d24` | 130 | `54f51bad` | 11 |
| `a7af675d` | 84 | `6d19b272` | 9 |
| `73782160` | 67 | `ee933d52` | 7 |
| `3ead6c6a` | 63 | `55fedda3` | 7 |
| `c3590b12` | 62 | `fb9e504b` | 7 |
| `67be296b` | 48 | `32fe1002` | 4 |
| `10e9df51` | 40 | `e0060254` | 3 |
| `0f2ef80d` | 27 | `013c4c5c` | 3 |
| `55f48e6d` | 25 | `26a74c66` | 3 |
| `c788b9f1` | 23 | `783d49a6` | 3 |
| | | `ccc8ef74` | 1 |
| | | **合计** | **1,270** |

其中 12 个提交（合计 138 行）在 v2 白名单下被误判成上游：
`3ead6c6a` 63、`bce5596a` 20、`e6ff6fab` 15、`6d19b272` 9、`55fedda3` 7、`fb9e504b` 7、
`32fe1002` 4、`e0060254` 3、`013c4c5c` 3、`26a74c66` 3、`783d49a6` 3、`ccc8ef74` 1。

### 1.3 若要补做：多少行、多少小时（只作备查，不排期）

```text
1,270 行 × 2.52 s/行 = 3,200 s ≈ 0.89 h
区间 1,270 × 0.85 – 2.85 s = 1,080 – 3,620 s ≈ 0.30 – 1.01 h
```

按 b263 后的实测池外本线数（`1,267`，见 §1.4）折：`1,267 × 2.52 = 3,193 s ≈ 0.89 h`。
**这个数字不进 PLAN、不进 `capacity-estimate` 的 `REMAIN`，只作「要不要补」的备查。**

### 1.4 四个时点的恒等式（每个时点绑 commit sha，今天各跑一次干净 worktree 复核）

| 时点 | 全仓 weak | 池内本线 | 池外本线 | 上游 | 变化来源 |
| --- | ---: | ---: | ---: | ---: | --- |
| `8acd208e`（b261 前 / B12 收口） | 10,081 | 6,776 | 1,270 | 2,035 | — |
| `0cab755e`（b261 后、b262 前） | 9,981 | 6,676 | 1,270 | 2,035 | b261：`−100` 池内 |
| `e3116a93`（b262 后、b263 前） | 9,878 | 6,576 | 1,267 | 2,035 | b262：`−100` 池内 + `−3` 池外连带 |
| `2e779933`（b263 后 = **pre-b264**） | 9,776 | **6,476** | 1,267 | 2,033 | b263：`−100` 池内 + `−2` 上游连带 |

- **`6,676` 是 b261 之后、b262 之前（`0cab755e`）的值，不是 pre-b261。** pre-b261 是 `8acd208e` 的 `6,776`；
  之前只写了三段里的后两段，才让人读成「一批掉 200」。
- 三批各 `−100` 池内：`6,776 → 6,676 → 6,576 → 6,476`，每批 100 行改写对 100 行，没有一批掉 200。
- **pre-b264 的池内本线是一个明确值：`6,476`**（`packages,apps`）。基线还覆盖 `docs/knip` 4 个文件 49 行，
  同域合计 `6,525`（见 `ZC-deep-b264.md` §4）。
- 两条「连带」都不是删除：`git diff` 里没有那 3+2 行，它们是被相邻行的句元合并**重新判强**的
  （`deep-quality` 按句元合并判 weak，改邻居会改判定），所以 TSV 行数、门禁 `删本线注释 n=100` 都不受影响。
- `e3116a93` 那次 `−3` 全部落在 b262 的 5 个文件里（`Compare-Object` 比两份 weak 明细，`gone=103`，
  103 = 100 登记 + 3 连带，5 个文件各 22/22/22/22/15）。
- 池外本线 `1,267` 是**当前值**；`1,270` 是 b262 台账时点的值，两者只差 §1.4 的连带，不是口径变化。


## 2. `20.6 s/文件`：单位错 ≠ 数值错

b262 写「`20.6` 在任何装箱下都不能直接乘文件数」是对的，但把两件事混成一句，容易读成「这个数也是错的」。
拆开：

| | 内容 | 判定 |
| --- | --- | --- |
| **单位错** | `s/文件` 不是产能单位。把它乘文件数、乘批数，等于默认「每文件行数恒定」；`s/文件 = 行/文件 × s/行`，装箱密度一变它就整体平移 | **作废这个用法** |
| **数值错** | `20.6` 隐含 `20.6 ÷ 2.52 = 8.2 行/文件`；PLAN 复算的整体密度是 `6,824 / 935 = 7.30 行/文件`（b262 时点），偏差 `(8.2 − 7.30) / 7.30 = 12%` | **数值本身不错**，只是对应另一个密度 |

所以：

- 作废的是「`s/文件` × 任意批次密度」，不是 `20.6` 这个数；
- `20.6` 仍可作**粗估交叉验证**：用它乘文件数得到的量级可用，但必须注明 **误差 12%**，不能当点估计；
- **历史估值不整体作废**：当时按「每文件行数」记账的数字仍可复算（`s/文件 ÷ s/行` 能还原密度）；
  作废的只是「乘文件数」这一步，不是那些批次的实测墙钟。

产能口径不变：`总时长 ≈ 待改行数 × s/行`，`s/行 = 2.52`（b261 实测；802 解包批全距 `0.85–2.85`）。
`_tools/INDEX.md` §2.3 已按本节改写。

## 3. `ACCT 6,724` 与重算 `6,725` 的 1 行差：定位到文件与行

**位置：`packages/ui/src/ToolCallBlocks/renderers/cuaDetails.tsx:14`。**

| 证据 | 值 |
| --- | --- |
| 基线 `weak-own-by-file.tsv` 里该文件的 weak 行 | **23** |
| `ZC-deep-b234-rewrite.tsv` 里该文件登记的行 | **22**（36–40、46–51、82–87、99–103） |
| 当前仍 weak 且在池内的行 | `:14`（`同义重复`），行文 `// INV-14 环境行有项才渲染：守住位置 长度判断；改错故障 空环境显示空表。` |
| 当前 weak 但池外的行 | `:86`（`无指代,无解释`），不在 `8f7daaf0..HEAD` 的 `+` 行里，不计 |

**成因：ACCT 是整文件计数，不是逐行计数。** `capacity-estimate.mjs` 的 `done` 是一个**文件集合**
（出现在任一 `ZC-deep-b*-rewrite.tsv` 里的基线文件），计入时按基线整文件行数扣：

```js
// capacity-estimate.mjs
doneLines += baselineCount;   // 文件一旦进 done，整份行数一起扣
remain = 基线文件 − done 文件
```

b234 把该文件记进 `done`，ACCT 便按 23 行整份扣掉；实际只改写/登记了 22 行，于是 `:14` 这一行
「账面已清、实际还 weak」，重算比 ACCT 多 **1 行**。

- 不是重复计数（`cuaDetails.tsx` 在 TSV 中只出现在 b234，22 行无重复）；
- 不是 `docs/knip` 的 49 条被算两次（那是基线里 4 个 `docs/knip` 文件的 49 行，来源见 `ZC-deep-b264.md` §4）；
- 是**边界归属**：整文件口径 vs 逐行口径的差，正好 1 行。

不改 ACCT 的口径（整文件在排期上是正确粒度：一个文件做完就是做完），但把这一行记在这里：
若未来按逐行核账，`6,724` 应读作 `6,725`，差额就是这一行。b263 后两份账仍然只差这 1 行
（池内 `6,476 + 49 = 6,525` vs `ACCT lines remain 6,524`）。

> **b264 已按逐行口径返工，本节结论作废为历史记录。** `capacity-estimate.mjs` v2 改为
> `done` 文件按「基线 weak − 现 weak」记账：`cuaDetails.tsx` 记 `23 − 1 = 22`，`done 896 / remain 6,525`，
> 该文件以 `PARTIAL 基线 23 → 现 1` 回池排期。同域扫描（含 `docs/knip`）后
> `ALIGNED acct_remain=6525 pool_remain=6525 diff=0`，**差 1 消失，不再是「已知残差」**。见 `ZC-deep-b264.md` §4。
> 另外 `+49` 的准确构成是基线里的 4 个 `docs/knip` 文件（16+13+12+8 = 49 行），不是扫描根外的杂项。

## 4. b263 本体（`PLAN#3`）

### 4.1 选片

`capacity-estimate --plan 6x100 --plan-print 3`（b262 台账后）：

```text
PLAN#3	5 文件 / 100 行
  packages/services/src/session/offPeakTaskService.ts                  21
  packages/ui/src/components/ui/usePdfZoomOverlay.ts                   21
  packages/ui/src/components/workflow-timeline/WorkflowAskSettingsParts.tsx 21
  packages/ui/src/components/workflow-timeline/WorkflowRunSettingsFields.tsx 21
  apps/zcode-cli/packages/adapters/src/storage/index.ts                16
```

合计 `21 + 21 + 21 + 21 + 16 = 100`。

### 4.2 归属预检（三态 `--check`，`pending=0`）

```text
a8784b7e479d	本线	snapshot(annot): b1–b226 工作区注释安全快照（未逐批验证）
872ad960de7e	上游	wuweiqi  feat: open source
aac4755666d0	上游	wuweiqi  feat: update to v3.15.1
CHECK own=1 upstream=2 pending=0
```

本批 107 条 weak = 本线 100 + 上游 7（`offPeakTaskService.ts:69,214,439,833`；
`WorkflowAskSettingsParts.tsx:109,219`；`WorkflowRunSettingsFields.tsx:90`）。

**白名单事故（本批修掉措辞，b264 修掉机制）：** b262 台账里有一句把两个上游 sha（`872ad960` / `aac47556`）
与「本线的注释提交」写在同一行，被 `own-commits` 的 `PATTERNS[0] = /提交[^\n0-9a-f]{0,6}([0-9a-f]{7,40})/g` 命中，
把上游那个 sha 抽进了白名单，
导致本批 5 行上游 weak 被判成「本线」（`own=105 upstream=2`）。改措辞后 `loadOwnCommits` 得 55 条、
`has(872ad960)=false`，重跑 `own=100 upstream=7`。
同一句污染的 1,001 行全仓归户也一并纠正（§1.4 的 `own/upstream` 就是修正后重跑的）。

> **b264 根因修复**：b263 的修法是「改措辞让 sha 不紧跟『提交』6 个字符内」——约束的是人，不是代码，必然复发。
> b264 起 `own-commits` v3 直接把白名单改成机器生成（`OWN-COMMITS.tsv`，作者口径 214 条），
> 文档散文不再参与解析，负例（往台账写假 sha 后白名单不变）已回归。见 `ZC-deep-b264.md` §1。

### 4.3 门禁（`zc-commit` v12，blob `a35b42fa2e4c`）

首跑 **11 条判据命中**（10 条 L 无信息列举、1 条 W 无标识符），门禁按设计拒绝；逐行改后二跑通过：

| 位置 | 首跑原因 | 处理 |
| --- | --- | --- |
| `storage/index.ts:84` | L（2 逗号无谓词） | 改「由各自根目录承载」 |
| `storage/index.ts:85` | L | 改「由 finally 立刻 delete」 |
| `storage/index.ts:231` | L | 改「所以可以并发调用」 |
| `storage/index.ts:334` | W（无标识符） | 补 `isRegularFile` |
| `offPeakTaskService.ts:426` | L | 改「而 setPaused 不调用 client」 |
| `usePdfZoomOverlay.ts:39` | L | 改「所以可以在渲染期反复调用」 |
| `usePdfZoomOverlay.ts:159` | L（`、` + `，`） | 合并成「pointerEvents 与 userSelect」 |
| `WorkflowAskSettingsParts.tsx:94` | L | 改「tail 尾句与 initialText…」 |
| `WorkflowAskSettingsParts.tsx:210` | L | 改「行在上且…行在下」 |
| `WorkflowRunSettingsFields.tsx:57` | L | 改「只承担排版而不接收交互属性」 |
| `WorkflowRunSettingsFields.tsx:235` | L | 改「只回显受控值而不保留…」 |

最终：

```text
GATE self=d:\code\_annot_baseline\zc-commit.mjs blob=a35b42fa2e4c
删本线注释    n=100  （允许，逐行登记）
删代码        n=0
删上游注释    n=0
新增非注释行  n=0
原行搬移      n=0
标点级改写    n=0
新增注释行    n=100  其中判据命中 0  其中嵌套注释 0
expected=5  staged=5
标题: b263 改写 (+100/−100)
已提交: 2e779933
```

### 4.4 度量与覆盖

| | SUMMARY | RATIOS |
| --- | --- | --- |
| 改前 | `files=5 units=1066 coverage=17.7% branch=25.7% field=32.1% comments=518 substance=74.1% explain=88.6% filler=15.6% weak=20.7%` | `weak=107/518 filler=81/518` |
| 改后 | `files=5 units=1066 coverage=17.7% branch=25.7% field=32.1% comments=518 substance=86.5% explain=99.0% filler=0.0% weak=1.0%` | `weak=5/518 filler=0/518` |

- `--list-weak`：`107 → 5`。本批 `107 − 5 = 102` 条 = 本线 100（登记并改写）+ 上游 2（连带判强）。
  **逐行结论（b264 补，原先读起来像 439/833 还在剩余 5 条里，是表述缺陷）**：
  - `offPeakTaskService.ts:439`（`*/` 结构行，blame `872ad960` = 上游）→ 改前 **weak**（`无解释`，去标记后正文为空），
    改后 **strong**（`2e779933` 的 weak 明细里不出现）。本批没删也没改它，是因为相邻行改写后句元合并重新判强。
  - `offPeakTaskService.ts:833`（JSDoc 首行「单票状态映射（两轴）…」，blame 同为上游）→ 改前 **weak**（`短句堆叠`），
    改后 **strong**（同块的 `:834/:835` 是本线行，本批改写后整块句元重新判强）。
  - 所以这两行**不在**「剩余 5 条 weak」里。剩余 5 条是 `offPeakTaskService.ts:69`、`:214`、
    `WorkflowAskSettingsParts.tsx:109`、`:219`、`WorkflowRunSettingsFields.tsx:90`，全部上游、本批未触及。
  - 依据：`--list-weak` 在 `2e779933` 的这 5 个文件里只列出上面 5 行，`439/833` 不出现；本线后测 = 0，「本线 100 条全清」成立。
- `--uncovered`：`877 → 877`，`Compare-Object` 差 **0** 行（改动全在注释行）。
  定义、作用域与「非进度指标」的结论见 `ZC-deep-b264.md` §3——它数的是「代码单元有没有注释」，
  1→1 改写注释正文既不增删单元也不改变覆盖集合，所以恒定不变，不是进度指标。
- `units` 与 `comments` 前后一致（1066 / 518），说明只换了行文、没动结构。

### 4.5 numstat

```text
+16 −16  apps/zcode-cli/packages/adapters/src/storage/index.ts
+21 −21  packages/services/src/session/offPeakTaskService.ts
+21 −21  packages/ui/src/components/ui/usePdfZoomOverlay.ts
+21 −21  packages/ui/src/components/workflow-timeline/WorkflowAskSettingsParts.tsx
+21 −21  packages/ui/src/components/workflow-timeline/WorkflowRunSettingsFields.tsx
合计 +100 −100
```

### 4.6 15 文件 weak 守卫

```text
WEAK 15文件  pre=4  post=4  新增=0  max=8  key=file+正文
GUARD PASS
```

`pre` 取自干净 worktree `e3116a93`，`post` 取自本批提交前的工作区；本批 5 文件与 802 的 15 文件交集 = 0。

### 4.7 计时（`s/行`、`s/文件`、`s/文件` 的隐含密度三者同屏）

| 段 | 打点 | 秒 |
| --- | --- | ---: |
| T0 → T1（选片、blame、改前快照） | 20:10:26 → 20:14:18 | 232 |
| T1 → T2（编辑 100 行 + 首跑门禁 11 条命中） | 20:14:18 → 20:19:22 | 304 |
| T2 → T3（11 条返工 + 二跑通过） | 20:19:22 → 20:19:53 | 31 |
| T3 → T4（度量、守卫、uncovered、池外拆分、提交） | 20:19:53 → 20:24:17 | 264 |
| **合计 == 墙钟** | 20:10:26 → 20:24:17 | **831** |

| 口径 | 全批 | 仅改写段（T1→T3，335 s） | 用途 |
| --- | ---: | ---: | --- |
| `s/行` | **8.31**（831 / 100） | **3.35**（335 / 100） | 唯一产能依据 |

**b264 起本表只留 `s/行`**：`s/文件` 与「隐含密度」两行撤掉（口径作废，且恒等于装箱密度，见 INDEX §2.4）。

- 全批 `8.31 s/行` 高于 b261 的 `2.52`，原因可拆：T3→T4 的 264 s 里有 131 s 是 §1.4 的池外拆分
  （两次全仓 blame），另有 §3 的 1 行定位；把这些调查排除后，改写段是 `3.35 s/行`，
  比 `2.85` 上界高 17.5%（5 文件 / 1066 units 的固定成本按批收，本批只有 100 行可摊）。
- 返工：内容返工 1 轮（11 行判据命中，见 §4.3），提交链路返工 0。

### 4.8 下一批

b263 后（`b264` 行口径复算）：`ACCT files done 86 + remain 921 = 1007`、`ACCT lines done 896 + remain 6525 = 7421`、`ALIGNED acct_remain=6525 pool_remain=6525 diff=0`、`PLAN 155`。
（此处 `done 87 / remain 920 / lines 897 / 6524` 是整文件记账旧值，少算 `cuaDetails.tsx:14` 这 1 行，已在 `ZC-deep-b264.md` §4 返工。）
下一个未做批次 `PLAN#1` 为 5 文件 / 100 行：
`WorkflowSavePopover.tsx`、`automationTelemetry.ts`、`PurposeSections.tsx`、
`SaveWorkflowPermissionBlock.tsx`、`node-repl-session.ts`。
