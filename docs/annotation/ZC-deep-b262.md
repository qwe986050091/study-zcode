# ZC-deep-b262：5 文件 / 100 行改写批 + 两项口径更正 + 全仓 weak 地板

- 日期：2026-11-10
- base：`0cab755e`（b261 台账提交）
- 代码提交：`e3116a93 b262 改写 (+100/−100)`
- 尺子：`deep-quality` v2.0（`756bea66122a`）+ `zc-gate` v4（`633b334905ee`）+ `zc-commit` v12（`a35b42fa2e4c`）+ `own-commits` v2（`f56b84fbf964`）+ `ledger-assert` `35afeb266f97` + `capacity-estimate` `8d31b38559da` + `weak-guard` `a3600ccfacab`

## 0. 更正 b261 的两个数

**（1）`106 → 6` 不是本线数。** b261 首版台账把「本线 weak」写成 `106 → 0`，与本批 `106 → 6` 打架：
门禁只登记本线行，`删本线注释 n=100`、`删上游注释 n=0`，所以本线只清了 100 条，余 6 条属上游。
正确写法是 **「`106 → 6`，本线 100 条全清，余 6 条属上游（未动）」**，两处已按此改：

| 位置 | 原文 | 现文 |
| --- | --- | --- |
| `ZC-deep-b261.md` §3.4 | 「本线 weak **106 → 0**」 | 「本线 100 条全清，余 6 条属上游（未动）」+ 双口径表 |
| `ZC-deep-b261.md` §3.7 | `s/文件` 只写超上界 | 加注「该口径已在 b262 §2 判定作废，只作诊断」 |

**（2）分母 `301` 含上游，是个纯文件口径。** `301` = `SUMMARY comments=301`，即这 5 个文件的
**全部注释行**；6 条上游 weak 行本身就是注释行，本来就在 301 里。所以：

- `106/301 → 6/301`：文件口径（含上游），分子分母同域，成立；
- `100/301 → 0/301`：本线口径，只有 blame 在册的行，门禁能删的也只有这些；
- 两个数不能互相替换——把 `106` 当成本线数是错的，把 `6` 当成「没清干净」也是错的。

## 1. `s/文件` 正式作废，产能改按行计价

`capacity-estimate` 的 `20.6 s/文件 × 935 = 5.35h` 与实测 `50.4 × 935 = 13.1h` 差 2.5 倍，
而同一批的 `s/行` 是稳的，所以作废的是口径，不是产量。

| 口径 | 值 | 判定 |
| --- | ---: | --- |
| `s/行` | **2.52**（b261：252s / 100 行；b260 2.58） | 落在 802 解包批基线 `0.85–2.85` 内，**唯一产能依据** |
| `s/文件` | 50.4（b261 实测）/ 20.6（全历史均值）/ 14.9（b245–b247） | 是 `行/文件 × s/行` 的函数，**只作诊断** |

剩余 `935` 文件的折算（按行，不按文件；取 b261 收口后的时点，b262 后为 `925 / 6,624`，算式同）：

```text
待改行数   6,824 行                              （ACCT lines remain，802 收口后）
点估计     6,824 × 2.52 s        = 17,196 s ≈ 4.78 h
区间       6,824 × 0.85 – 2.85 s = 5,800 – 19,448 s ≈ 1.61 – 5.40 h
平均密度   6,824 / 935 = 7.30 行/文件 → 18.4 s/文件（只在该密度下成立）
```

`20.6 s/文件` **作废**（明细写进 `_tools/INDEX.md` §2.3）：

- 它唯一自洽的密度是 `20.6 / 2.52 = 8.2 行/文件`；
- 限定成「每文件 14–16 行时可用」也不成立：`14–16 × 2.52 = 35.3–40.3 s/文件`，与 20.6 差一倍；
- PLAN 装箱（≤6 文件且 ≤100 行）的实际密度是 **7.30 行/文件**，既不是 8.2 也不是 14–16，
  所以这个常数在任何装箱下都不能直接乘文件数——条件不是「几乎不成立」，是**不成立**。

`INDEX.md` 同步改动：§2.3 整段改写（新增 b262 更正段、按行折算的三行数据、阈值收口为只认 `s/行`），
§2.2 的 `--per-file` 说明改成「只作每批诊断」。

## 2. `upstream=2`：这 6 行是哪个提交、改了什么、为什么本线不动

### 2.1 两个提交

| 提交 | 作者 | 日期 | 说明 | 在本批 5 文件上的改动 |
| --- | --- | --- | --- | --- |
| `872ad960de7e` | wuweiqi | 2026-09-21 | `feat: open source` | 整体引入两文件：`storage-startup.ts` +147、`WorkflowRunDigest.tsx` +357 |
| `aac4755666d0` | wuweiqi | 2026-10-10 | `feat: update to v3.15.1` | `WorkflowRunDigest.tsx` +29/−4，带入第二段文案 |

### 2.2 6 行逐条

| 文件:行 | blame | 行文 |
| --- | --- | --- |
| `storage-startup.ts:82` | `872ad960` | `/* 传输已断开时保留最初的数据库/传输异常。 */` |
| `WorkflowRunDigest.tsx:63` | `aac47556` | `/** 补全过的留白的名字与类型（补全行入参），头的文字从它取（投影没记类型时）。 */` |
| `WorkflowRunDigest.tsx:152` | `872ad960` | `// 去掉箭头不代表取消折叠。仅空白区域切换，子控件继续执行各自的操作。` |
| `WorkflowRunDigest.tsx:171` | `872ad960` | `// 「调整自 / 已被替代」两句只在详情页与确认窗说；卡只换种类词——卡上太吵。` |
| `WorkflowRunDigest.tsx:310` | `872ad960` | `// 收起时只隐藏代理，保留阶段线作为运行进度概览。` |
| `WorkflowRunDigest.tsx:325` | `aac47556` | `// 补全的头：开侧板、落到它写下的第一站（那一站的节头就是补全的标题）。` |

### 2.3 为什么本线不动

不是「没发现」，是「发现且判定不可动」，三条硬约束同时成立：

1. `own-commits` 白名单只覆盖本线的注释提交（当前 55 条，含本批 `e3116a93`）；两个上游 sha（`872ad960` / `aac47556`）都在册外，`--check` 判上游；
2. `zc-gate` 的不变量是 `删上游注释 n=0（必须 0）`，`删本线注释` 只接受 blame 在册的行；
3. 台账 TSV 只登本线行，登上游行会被门禁直接拒绝。

### 2.4 全仓 weak 的地板

**是，地板不为 0。** 机制同上：上游注释行只要判弱，本线就既不能删也不能改，它只能等上游自己改。
b261 那 6 行是这套机制的样本，不是孤例。

**测法**：干净 worktree `0cab755e`，`--root packages,apps` 得 9,981 条 weak（2,032 文件），
逐文件跑 `git blame --porcelain`（并行 10，`unparsed=0`），按 `own-commits` 白名单归户：

```text
FLOOR weak_total=9981 own=7946 upstream=2035 unparsed=0
```

> **b264 返工**：本节原登记 `own=7,808 / upstream=2,173`（v2 散文白名单，54 条）。
> v3 换成机器生成白名单（作者口径，214 条）后，12 个本线提交的 138 行由「上游」翻回「本线」，
> 地板 `2,173 → 2,035`，own `7,808 → 7,946`。`9,981` 不变，所以恒等式两边仍闭合。

恒等式 `7,946 + 2,035 = 9,981`——三项同一次运行、同一把尺子，没有口径拼接。

**地板值 = 2,035 行**（占 20.4%），分布在 5 个提交上：

| 提交 | weak 行 | 说明 |
| --- | ---: | --- |
| `872ad960` | 1,001 | `feat: open source` |
| `aac47556` | 810 | `feat: update to v3.15.1` |
| `0a1fc56d` | 169 | 上游 |
| `3c5b2276` / `29628c9a` | 28 / 27 | 上游 |
| **合计** | **2,035** | 前两个占 89.0% |

（v2 下的 `3ead6c6a` 63 / `bce5596a` 20 / `e6ff6fab` 15 / `6d19b272` 9 / `55fedda3` 7 / `fb9e504b` 7 /
`32fe1002` 4 / `e0060254` 3 / `013c4c5c` 3 / `26a74c66` 3 / `783d49a6` 3 / `ccc8ef74` 1 共 138 行已改判本线。）

**HEAD 处地板不变**：b262 本批 `upstream=0`，100 条全在本线，所以 `9,878 = 7,843 + 2,035`
（v2 写的 `9,881 = 7,708 + 2,173` 是 `9,981 − 100` 的算术外推，实测另有 `−3` 连带，见 b263 §1.4）。

**地板不是常数，是白名单的函数。** 白名单只收本线提交，b240 补录 `55f48e6d`、b242 补录
`ee933d52`/`c788b9f1` 时，就有一批行从「上游」变成「本线」；b264 改用作者口径一次补进 12 个提交，地板降 138 行。
所以 2,035 是**当前白名单**下的地板：再纳入一条本线来源的提交，地板就下降；上游改掉这 5 个提交的注释，地板也会下降。

### 2.5 与 `ACCT` 池子对账（两把尺子，一本账）

池子的「本线」不是 blame，是 `diffsets.mjs` 的定义：`git diff -U0 8f7daaf0 HEAD` 的 `+` 行——
只收 **8f7daaf0（2026-11-10 审计快照基线）之后新增**的注释。按同一定义在今天重算：

| 项 | 行数 | 关系 |
| --- | ---: | --- |
| 池内本线（`packages,apps`） | 6,676 | 与 ACCT `remain 6,724` 比 |
| 池内本线（`docs/knip`，基线里的 4 个文件，扫描根外） | 49 | 基线收了、`--root packages,apps` 不收 |
| 小计 | **6,725** | 比 ACCT 多 **1 行**（`cuaDetails.tsx:14`，整文件记账多扣；b264 行口径后差 0） |
| 池外本线（8f7daaf0 之前写下的早期 L2 注释） | 1,270 | blame 算本线、池子不收、PLAN 没有它们 |
| 上游 | 2,035 | 即地板 |
| **合计** | **9,981** | `6,676 + 1,270 + 2,035 = 9,981` |

所以「池子清零」不会让 weak 归零：PLAN 按池子排期，池子清完，`weak` 停在 `1,270 + 2,035 = 3,305`。
其中 1,270 仍是本线、仍可改写（只是不在 PLAN 里，要另开「扩池批」），**2,035 不可动**。
**weak 的归零点 = 2,035，不是 0。**

## 3. b262 选片（`PLAN#2`）

`capacity-estimate --plan 6x100 --plan-print 2`（b261 台账后），`PLAN#2`：

```text
PLAN#2	5 文件 / 100 行
  packages/ui/src/settings/SettingsResourceHeaderActions.tsx    22
  packages/ui/src/terminal/terminalLinks.ts                     22
  packages/ui/src/ToolCallBlocks/renderers/todo.tsx             22
  packages/ui/src/v4/attachmentUploadTransaction.ts             22
  apps/zcode-cli/packages/core/src/runtime/deps.ts              12
```

合计 `22 × 4 + 12 = 100`，符合「≤6 文件且 ≤100 行、按行数降序贪心装箱」。

### 3.1 归属预检（三态 `--check`，`pending=0`）

`--list-weak` 改前给 **103 行**，blame 逐行归户后是：

| sha | 行数 | 判定 | 处置 |
| --- | ---: | --- | --- |
| `a8784b7e479d` | 100 | 本线（无逐批验证的快照提交） | 改写 100 |
| `ad6dc0eb51eb` | 3 | 本线（`docs(注释): L2-B2 runtime`） | 结构性行，不改写 |

```text
CHECK own=2 upstream=0 pending=0
exit 0
```

那 3 条是 JSDoc 收尾行 `*/`（`deps.ts:80`、`108`、`344`，`deep-quality` 判「无解释」）。它们是结构行，
不是可改写的注释文案，所以没有登记、也没有删除；把同块的 `//` 行改写后，这三行**同一份文本**不再判弱
（改后 `--list-weak` 为 0）——同一行、同样 `*/`，只因邻居 `//` 改了就不弱，说明判定按注释块聚合，不按单行。

于是本批口径要说全三层：

| 口径 | 数 |
| --- | ---: |
| 改前 `--list-weak`（本批 5 文件） | 103 |
| 门禁登记 / 删除（可改写的 `//` 行） | **100** |
| 改写后 `--list-weak` | **0** |

### 3.2 门禁七行（`zc-commit` v12，blob `a35b42fa2e4c`）

首跑 3 条 W（单行无标识符），按判据补标识符后二跑通过：

| 位置 | 首跑原因 | 处理 |
| --- | --- | --- |
| `SettingsResourceHeaderActions.tsx:84` | W（缺省文案句无 ASCII 标识符） | 补 `intl.formatMessage` |
| `SettingsResourceHeaderActions.tsx:88` | W | 补 `importLabel` / `exportLabel` |
| `SettingsResourceHeaderActions.tsx:90` | W | 补 `intl.formatMessage` |

另有 3 条改写后仍判弱（`SettingsResourceHeaderActions.tsx:108,109`、`terminalLinks.ts:184`，同为 W），
补 `import/export`、`refresh/new`、`TerminalHttpLinkMatch` 后清零。

最终门禁原文：

```text
GATE self=D:\code\_annot_baseline\zc-commit.mjs blob=a35b42fa2e4c
删本线注释    n=100  （允许，逐行登记）
删代码        n=0
删上游注释    n=0
新增非注释行  n=0
原行搬移      n=0
标点级改写    n=0
新增注释行    n=100  其中判据命中 0  其中嵌套注释 0
expected=5  staged=5
标题: b262 改写 (+100/−100)
```

### 3.3 TSV 与门禁逐条对应

`ZC-deep-b262-rewrite.tsv` 由门禁写入 **100 行**（`file` / `baseLine` / `blame` / `content`），
与门禁 `删本线注释 n=100`、numstat `+100/−100` 三源相等。

### 3.4 度量与覆盖

| | SUMMARY | RATIOS |
| --- | --- | --- |
| 改前 | `files=5 units=457 coverage=6.3% branch=0.0% field=0.0% comments=296 substance=58.4% explain=85.5% filler=31.8% weak=34.8%` | `weak=103/296 filler=94/296` |
| 改后 | `files=5 units=457 coverage=6.3% branch=0.0% field=0.0% comments=296 substance=84.1% explain=100.0% filler=0.0% weak=0.0%` | `weak=0/296 filler=0/296` |

`--list-weak`：`103 → 0`（分层见 §3.1；本线按行登记 100，3 条结构行随块退出）。
`--uncovered`：`428 → 428`，`Compare-Object` 差 **0** 行（正文改动全在注释行，覆盖单元未动）。
`MAP`：`comments=296 mappedStrict=29 mappedBlock=203 unmapped=93 reasons=import:88,structural:0,continuation:5,gap:0,eof:0,other:0`。

### 3.5 numstat

```text
+12 −12  apps/zcode-cli/packages/core/src/runtime/deps.ts
+22 −22  packages/ui/src/ToolCallBlocks/renderers/todo.tsx
+22 −22  packages/ui/src/settings/SettingsResourceHeaderActions.tsx
+22 −22  packages/ui/src/terminal/terminalLinks.ts
+22 −22  packages/ui/src/v4/attachmentUploadTransaction.ts
合计 +100 −100
```

行数不变（每个文件 `+X −X`，`unitText` 未动）。

### 3.6 与 802 的 15 文件关系 + 守卫

本批 5 文件与 802 的 15 文件**交集 = 0**（清单见 `b254-802-files.txt`，无同名路径）。
按「同一套门禁」照跑 15 文件守卫（`weak-guard` `a3600ccfacab`，pre 取 `0cab755e` 干净 worktree、post 取当前工作树）：

```text
WEAK 15文件  pre=4  post=4  新增=0  max=8  key=file+正文
GUARD PASS
exit 0
```

### 3.7 计时

| 段 | 打点 | 秒 |
| --- | --- | ---: |
| T0 → T1（选片、改前快照、blame） | 19:50:53 → 19:51:21 | 28 |
| T1 → T2（编辑 100 行 + 门禁，含 2 轮返工） | 19:51:21 → 19:54:58 | 217 |
| T2 → T3（改后快照 + 提交） | 19:54:58 → 19:55:03 | 5 |
| **合计 == 墙钟** | 19:50:53 → 19:55:03 | **250** |

- `s/行 = 250 / 100 = 2.50`，落在 `0.85–2.85` 内（b261 2.52、b260 2.58）；
- `s/文件 = 250 / 5 = 50.0`，只记录、不比较（本批密度 20 行/文件，是 PLAN 均值 7.30 的 2.7 倍）；
- 返工：内容返工 2 轮（3 条 W + 3 条残弱，见 §3.2），提交链路返工 0。

**本批 `s/行` 与 `s/文件` 同时给出，且 `s/文件` 仅作参考不作产能依据。**

## 4. 下一批

b262 后 `ACCT files done 82 + remain 925 = 1007`、`lines done 797 + remain 6624 = 7421`、`PLAN 156`
（`ASSERT PASS`）。下一个未做批次 `--plan 6x100 --plan-print 1`：

```text
PLAN#1	5 文件 / 100 行
  packages/ui/src/components/workflow-timeline/WorkflowSavePopover.tsx   22
  packages/ui/src/lib/automationTelemetry.ts                             22
  packages/ui/src/project-sidebar/PurposeSections.tsx                    22
  packages/ui/src/SaveWorkflowPermissionBlock.tsx                        22
  apps/zcode-cli/packages/core/src/repl/node-repl-session.ts             12
```
