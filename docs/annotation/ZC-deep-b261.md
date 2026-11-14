# ZC-deep-b261：5 文件 / 100 行改写批 + 802 收口后四项交代

- 日期：2026-11-10
- base：`8acd208e`（b260 台账提交）
- 代码提交：`b3170026 b261 改写 (+100/−100)`
- 尺子：`deep-quality` v2.0（`756bea66122a`）+ `zc-gate` v4（`633b334905ee`）+ `zc-commit` v12（`a35b42fa2e4c`）+ `own-commits` v2（`f56b84fbf964`）+ `ledger-assert` **`35afeb266f97`** + `capacity-estimate` **`8d31b38559da`** + `weak-guard` `a3600ccfacab`

## 0. 那 1 条 weak 差额：不是口径差异，是把 B6 后读成了 B1 前

三份快照都是 **`deep-quality` v2.0、全仓 `--root packages,apps`、同一份代码范围**，分母全程 `329,480`：

| 快照 | 提交 | 含义 | weak / comments |
| --- | --- | --- | --- |
| B1 前 | `8a4d8e02` | 802 项目起点 | **10,085 / 329,480** |
| B6 后 | `c40c4d70` | B1–B6 做完 | **10,084 / 329,480** |
| CLOSE | `c4325d90` | B12 收口 | **10,081 / 329,480** |

`10,085 − 10,081 = 4`，与 15 文件 `8 → 4` 的减量**逐条相等**；`10,084` 是 B6 后的读数，
不是「B1 前」。用户引用 `10,084（B1 前）→ 10,081` 时，起点取错了快照，于是看起来差 1。

判定依据（不是推断）：

1. 三份快照的 `SUMMARY` 里 `metric=v3`、`comments=329480` 完全相同，排除「外部加注/分母变化」；
2. `Compare-Object` 比对 B1 前与 CLOSE 的 weak 明细，**只有 `<=` 没有 `=>`**，全仓没有新增 weak；
3. 被消除的 4 行，逐条对得上 15 文件里的 4 个改写点：

| # | 文件:行 | 消除批次 |
| --- | --- | --- |
| 1 | `apps/zcode-cli/packages/tui/src/app-view.tsx:432` | B4 / b251 |
| 2 | `packages/ui/src/lib/usageEntitlementRefreshPolicy.ts:208` | B9 / b257 |
| 3 | `packages/ui/src/rewards/RewardsWebview.tsx:284` | B10 / b258 |
| 4 | `packages/ui/src/settings/CommandForm.tsx:203` | B11 / b259 |

15 文件内另外 4 条残留（`app-events.ts:87`、`app-events.ts:95`、`zcodeTaskServiceAdapter.ts:700`、`zcodeTaskServiceAdapter.ts:2813`）
不在本线白名单内（`own-commits --check` 判上游/未纳入本批），B1 前与 CLOSE 都在，所以 15 文件是 `8 → 4` 而不是 `8 → 0`。

**附带更正**：`ZC-deep-b257.md` 里「当批 weak 3/203 → 2/203（app-events.ts）」标注错了归属——
`app-events.ts` 的那 2 条在 B1 前与 CLOSE 都是 2 条，B9 的 −1 实际来自 `usageEntitlementRefreshPolicy.ts:208`。
总数不受影响，只改归属说明。

## 1. `GREP` 清单外 2 条固化成 `EXEMPT`（`ledger-assert`）

`ledger-assert.mjs` 新增 `EXEMPT` 表，输出从「全仓 2 = 清单内 0 + 清单外 2」改成可判定形式：

| 文件:行 | 判据（为什么不是漏账） |
| --- | --- |
| `docs/annotation/_tools/d7e-shift.mjs:1` | 一次性迁移工具；第 2 行自述「`// /// 文档注释…`」被 `^\s*// //` 命中，是工具在描述 `//` 与 `///` 注释，不是待清的双前缀行 |
| `docs/webdriverio/docs/ocr-testing/ocr-faq.md:1` | 上游 WebdriverIO 文档；第 30 行是 OCR 示例代码里的原文样板 `// // With the default contrast…`，属于引用内容，不是本仓注释 |

新增三条断言：`清单内 + 豁免 = 全仓`；未登记的清单外一律 `exit 1`；豁免条数对不上 `exit 1`。
同时把批次范围收紧为「登记文件全部落在 b247 批次表内」——802 已收口，b261 这类常规批的 TSV 不得计入 802 累计，
脚本把它打印成 `IGNORED` 而不是混进 `SUM`。实测原文：

```text
BATCH ZC-deep-b248-rewrite.tsv	68 行
…（B1–B12 共 12 行，合计 802）
IGNORED ZC-deep-b261-rewrite.tsv（非 802 批次，100 行不计入）
SUM 各批 = 68 + 64 + 62 + 68 + 65 + 60 + 49 + 68 + 99 + 97 + 42 + 60 = 802  OK（逐文件登记数 == 批次表计划数）
ROLL 144  计划 144  累计 144  剩余 0  OK
ROLL 658  计划 658  累计 658  剩余 0  OK
ROLL 802  计划 802  累计 802  剩余 0  OK
CUM 累计 802 + 剩余 0 = 802  OK
PLAN 批次表合计 802  = 802  OK
GREP 全仓 2 = 清单内 0 + 清单外 2  OK
EXEMPT 2  docs/annotation/_tools/d7e-shift.mjs:1（一次性迁移工具：第 2 行自述「// /// 文档注释…」被 `^\s*// //` 命中，是工具在描述 // 与 /// 注释，不是待清的双前缀行） , docs/webdriverio/docs/ocr-testing/ocr-faq.md:1（上游 WebdriverIO 文档：第 30 行是 OCR 示例代码里的原文样板 `// // With the default contrast…`，属于引用内容，不是本仓注释）
REMAIN 剩余 = 0
CLOSE 802 = 802  OK
FILELIST 15 文件 == 批次表清单  OK  (d:/code/_annot_baseline/b254-802-files.txt)
ASSERT PASS
exit 0
```

- 范围收紧前首跑是 `SUM … = 902 FAIL`（b261 的 100 行被算进 802）；这是脚本作用域缺陷，不是账目问题，
  修的是「哪些 TSV 属于 802」，没有动任何恒等式、阈值或豁免判据。

## 2. 802 的 15 文件与 `PLAN 159` 剩余池的关系

基线池取自 `_annot_baseline/snapshot/weak-own-by-file.tsv`：**1007 文件 / 7421 weak**。
15 文件与池子的交集是 **6 个**（逐文件比对，非估算）：

| 文件 | 基线 weak | 何时清掉 |
| --- | ---: | --- |
| `apps/zcode-cli/packages/tui/src/app-view.tsx` | 1 | 802 内 B4 / b251 |
| `apps/zcode-cli/packages/tui/src/app-sidebar.tsx` | 2 | 802 之前 b243 |
| `packages/ui/src/lib/usageEntitlementRefreshPolicy.ts` | 1 | 802 内 B9 / b257 |
| `packages/ui/src/components/ai-elements/audio-player.tsx` | 2 | 802 之前 b244 |
| `packages/ui/src/rewards/RewardsWebview.tsx` | 1 | 802 内 B10 / b258 |
| `packages/ui/src/settings/CommandForm.tsx` | 1 | 802 内 B11 / b259 |

另外 9 个**本来就不在池内**：基线 tsv 只收「weak ≥ 1」的文件，这 9 个在基线时 weak = 0，
只有 `// //` 双前缀（去前缀后才可能变成 weak）。所以 802 对它们做的是「防止去前缀激活新水」，不是「清池子里的欠账」。

`ACCT` 怎么扣：

```text
802 之前：done 68 + remain 939 = 1007
802 之后：done 72 + remain 935 = 1007   （app-view / usageEntitlement / RewardsWebview / CommandForm 各 −1 文件）
```

`app-sidebar` 与 `audio-player` 早在 b243/b244 就已计入 `done`，所以 802 只把 `done` 推了 4 个（68 → 72），
不是 6 个。两条等式都成立，`1007` 没有被改口径，也没有「两套计划各算各的」：

```text
ACCT files  done 72 + remain 935 = 1007  OK
ACCT lines  done 597 + remain 6824 = 7421  OK
ASSERT PASS
```

`PLAN 159 → 158` 正是这 4 个池内文件被清后少装的一批（b261 之后为 157，见 §3）。

## 3. b261 选片（`PLAN 158` 的第一个未做批次）

`capacity-estimate --plan 6x100 --plan-print 2`（b260 台账后）：

```text
PLAN#1	5 文件 / 100 行
  packages/shared/src/assistant-presentation.ts                          22
  packages/shared/src/workspaceFileSearch.ts                             22
  packages/shared/src/zcode-network-debug-status.ts                      22
  packages/ui/src/components/workflow-timeline/WorkflowRunDigest.tsx     22
  apps/zcode-cli/packages/bootstrap/src/zcode-protocol/storage-startup.ts 12
```

合计 `22 + 22 + 22 + 22 + 12 = 100`，符合「≤6 文件且 ≤100 行、按行数降序贪心装箱」。

### 3.1 归属预检（三态 `--check`，`pending=0`）

| sha | 行数 | 判定 | 处置 |
| --- | ---: | --- | --- |
| `a8784b7e479d` | 100 | 本线 | 改写 100 |
| `872ad960de7e` | 4 | 上游（`wuweiqi` feat: open source） | 不删不改 |
| `aac4755666d0` | 2 | 上游（`wuweiqi` feat: update to v3.15.1） | 不删不改 |

```text
CHECK own=1 upstream=2 pending=0
exit 0
```

上游 6 行（改写后仍残留，故本批 post weak = 6）：

```text
storage-startup.ts:82                      传输已断开时保留最初的数据库/传输异常。
WorkflowRunDigest.tsx:63                   补全过的留白的名字与类型（补全行入参）…
WorkflowRunDigest.tsx:152                  去掉箭头不代表取消折叠。…
WorkflowRunDigest.tsx:171                  「调整自 / 已被替代」两句只在详情页与确认窗说…
WorkflowRunDigest.tsx:310                  收起时只隐藏代理，保留阶段线作为运行进度概览。
WorkflowRunDigest.tsx:325                  补全的头：开侧板、落到它写下的第一站…
```

本线 100 行改写后 weak = **0**（`--list-weak` 只剩上面 6 条上游行）。

### 3.2 门禁七行（`zc-commit` v12，blob `a35b42fa2e4c`）

首跑有 4 行判据命中（3 条 L、1 条 W），门禁按设计拒绝提交；逐行改这 4 行后二跑通过：

| 位置 | 首跑原因 | 处理 |
| --- | --- | --- |
| `assistant-presentation.ts:153` | L 无信息列举（3 个分隔符、无谓词） | 三个进行态收敛成 `streaming 等三种`，分隔符降到 1 |
| `assistant-presentation.ts:157` | L 无信息列举（2 逗号、无谓词） | 改「生成新数组**而**不改写…」 |
| `zcode-network-debug-status.ts:36` | W 单行无信息（无标识符） | 补 `MODEL_NETWORK_STATUS_TYPES` |
| `zcode-network-debug-status.ts:169` | W 单行无信息（无标识符） | 补 `stringRecordValue` |

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
标题: b261 改写 (+100/−100)
```

### 3.3 TSV 与门禁逐条对应

`ZC-deep-b261-rewrite.tsv` 由门禁写入 **100 行**（`file` / `baseLine` / `blame` / `content`），
与门禁「删本线注释 n=100」、numstat `+100/−100` 三源相等。

### 3.4 度量与覆盖

| | SUMMARY | RATIOS |
| --- | --- | --- |
| 改前 | `files=5 units=583 coverage=8.9% branch=5.3% field=20.6% comments=301 substance=62.8% explain=83.4% filler=33.2% weak=35.2%` | `weak=106/301 filler=100/301` |
| 改后 | `files=5 units=583 coverage=8.9% branch=5.3% field=20.6% comments=301 substance=87.4% explain=98.0% filler=0.0% weak=2.0%` | `weak=6/301 filler=0/301` |

`--list-weak`：`106 → 6`，**本线 100 条全清，余 6 条属上游（未动）**。门禁登记量 `删本线注释 n=100`
与本批 `106 − 6 = 100` 互证；首版台账写的「本线 weak 106 → 0」是错的（把上游 6 行也算进了本线分子），
b262 校正，不改任何数值。

分母 `301` 是这 5 个文件的**全部注释行**（`SUMMARY comments=301`），与分子同域——6 条上游 weak 行本身
就是注释行，本来就在 301 里。所以两个口径要分开读，不能互相替换：

| 口径 | 改前 → 改后 | 含义 |
| --- | --- | --- |
| 文件口径（含上游） | `106/301 → 6/301` | 这 5 文件的 weak 行数 / 全部注释行数 |
| 本线口径 | `100/301 → 0/301` | 只有 blame 落在本线白名单的行，门禁能删的也只有这些 |

`--uncovered`：`531 → 531`，`Compare-Object` 差 **0** 行（正文改动全在注释行，覆盖单元未动）。

### 3.5 numstat

```text
+12 −12  apps/zcode-cli/packages/bootstrap/src/zcode-protocol/storage-startup.ts
+22 −22  packages/shared/src/assistant-presentation.ts
+22 −22  packages/shared/src/workspaceFileSearch.ts
+22 −22  packages/shared/src/zcode-network-debug-status.ts
+22 −22  packages/ui/src/components/workflow-timeline/WorkflowRunDigest.tsx
合计 +100 −100
```

行数不变（每个文件 `+X −X`，`unitText` 未动）。

### 3.6 15 文件 weak 守卫（b260 版 `a3600ccfacab`）

```text
WEAK 15文件  pre=4  post=4  新增=0  max=8  key=file+正文
GUARD PASS
exit 0
```

本批 5 文件与 802 的 15 文件**交集 = 0**（15 文件清单见 `b254-802-files.txt`，与本批清单无同名路径）。

### 3.7 计时

| 段 | 打点 | 秒 |
| --- | --- | ---: |
| T0 → T1（选片、blame、改前快照） | 19:42:29 → 19:43:07 | 38 |
| T1 → T2（编辑 100 行，含首跑 4 条返工） | 19:43:07 → 19:46:17 | 190 |
| T2 → T3（改后快照 + 门禁 + 提交） | 19:46:17 → 19:46:41 | 24 |
| **合计 == 墙钟** | 19:42:29 → 19:46:41 | **252** |

- `s/文件 = 252 / 5 = 50.4`，超出 14.9 的 +50% 上界（22.35）——但本批是 100 行/5 文件（20 行/文件），
  是按均值 43.2 行/批的 2.3 倍密度，不能用 s/文件 横向比；**该口径已在 b262 §2 判定作废**，
  这里只作诊断记录，不再作产能依据（产能按 `s/行 × 待改行数`）；
- 可比口径是 `s/行 = 252 / 100 = 2.52`，落在 802 解包批基线 `0.85–2.85` 区间内（b260 为 2.58）；
- 返工：内容返工 1 轮（4 行判据命中，见 §3.2），提交链路返工 0。

### 3.8 下一批

b261 后 `ACCT files done 77 + remain 930 = 1007`、`PLAN 157`；下一个未做批次 `PLAN#1` 为 5 文件 / 100 行：
`WorkflowSavePopover.tsx`、`automationTelemetry.ts`、`PurposeSections.tsx`、`SaveWorkflowPermissionBlock.tsx`、`node-repl-session.ts`。

> **b264 返工注（口径修正，非代码变更）**：上面这行只写了「100 行」，没写分母。b264 逐行 blame 后的正确口径是
> **writable 100 + upstream 7 = 107**：7 条上游行（`872ad960` / `0a1fc56d` / `aac47556`）不可写，
> 其中 4 条（`node-repl-session.ts:498`、`SaveWorkflowPermissionBlock.tsx:44`、`WorkflowSavePopover.tsx:65`、`:155`）
> 改写后仍是 weak，单列为「不可写集合」。配额分母从本批起一律用 `writable`，
> `capacity-estimate --plan-print` 每片开头打 `writable=X upstream=Y pending=Z`。
> 据此「100 行」= `writable 100`，本批写满、无短差。详见 `ZC-deep-b264.md` §2.1。
