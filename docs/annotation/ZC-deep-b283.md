# ZC-deep-b283：注释清水 96 行（6 文件）· 矩阵后首批 · 计时样本 n=11

> 批次：b283 ｜ 提交 `c9576925` ｜ 代码 `+96/−96` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v13（`f02be471a849`）、
> `capacity-estimate.mjs`（`3ff652131ef9`）、`weak-guard.mjs`（`a3600ccfacab`）、
> `ledger-assert.mjs`（`35afeb266f97`）、`precheck-assert.mjs`（`0eedbcb107fb`）。

## 0. 交代

1. 关机中断后先核对落点：`git status` 空、`d7577e7f`（矩阵）与 `c7fe04f3`（b282 台账）都在，
   无半截提交；`--start` 在干净树上通过（`ts=2026-11-11T02:24:21.832Z`），mtime 快照 20,072 文件。
2. 本批 6 文件 / **96 行**（6 × 16）：`writable=96 / upstream=0 / self-clearing=0 / pool-out=0 / pending=0`。
   每文件恰有 16 行池内 weak，取满 6 文件 × 16 行，未凑 100 行（同上限约束，宁少不越界）。
3. 流程：`--start` → 后台 `--watch`（10 s 采样，15 轮）→ 改写 → `--scope`
   （`plan=96 allow=0 diff_old=96 diff_new=96 out_of_scope_edits=0`）→ `--record` 首轮 3 命中（返修）
   → `--record`（`hits=0`）→ `--verify` → `zc-commit v13` → `--order`。
4. 七行门禁：`expected=6 staged=6`，`+96/−96`，`GATE blob=f02be471a849`。
5. 批后 6 个文件 weak 全部清零；全仓 `WEAK lines=7839 files=1940`（b282 后 7,935 / 1,946）。

## 1. 三列计划表

```text
PLAN#1	6 文件 / 96 行	writable=96 upstream=0 self-clearing=0 pool-out=0 pending=0
quota=100，本批实际取 96（6 × 16，池内同批可写行用尽）
四态和=96=池内实测 96
```

| 文件 | 可写 | 上游 | 池外 | 小计 | 本批 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `packages/ui/src/GitPane/helpers.ts` | 16 | 0 | 0 | 16 | 16 |
| `packages/ui/src/components/ui/flip-metric-value.tsx` | 16 | 0 | 0 | 16 | 16 |
| `packages/ui/src/conversation-share-interaction/ConversationSharePreflightStatus.tsx` | 16 | 0 | 0 | 16 | 16 |
| `packages/ui/src/lib/assistantCodeComment.ts` | 16 | 0 | 0 | 16 | 16 |
| `packages/ui/src/lib/chatSessionScrollMemory.ts` | 16 | 0 | 0 | 16 | 16 |
| `packages/ui/src/lib/modeConfigUpdateGuard.ts` | 16 | 0 | 0 | 16 | 16 |
| **合计** | **96** | **0** | **0** | **96** | **96** |

- 6 个文件的 weak 行全部 `blame=a8784b7e479d3a`、全部在池内，`allow=0`。
- 选片按矩阵后的口径执行：只取池内 16 行的文件，不借批次夹带池外行。

## 2. 配额扣减与批后池

```text
SELF-CLEAR n=96	可写桶 96 / 池外 0 / 上游桶 0 / 未解析 0
```

- 96 行全部登记在 `ZC-deep-b283-rewrite.tsv`（97 行含表头），批前即落盘。
- 批后 `done files=196`（+6）/ `done lines=2866`（+96），`remain files=811` / `remain lines=4555`（−96）。
- `PARTIAL 1`：`cuaDetails.tsx`（基线 23 → 现 1，b263 遗留），按剩余行回池排期。

## 3. 计时：四量（新口径样本 n=11）

```text
t-start    2026-11-11 10:24:21.832 +08:00
t-record   2026-11-11 10:26:56.694 +08:00  sha=cbaa2d1c436d  record_runs=2
t-verify   2026-11-11 10:27:01.597 +08:00  sha=cbaa2d1c436d  record_runs=2
commit     2026-11-11 10:27:44 +08:00  c9576925

batch_wall_total         = 222.0 s（d7577e7f → c9576925）
batch_wall_controllable  = 203.0 s（t-start → commit）
落笔段                   = 159.8 s（t-start → t-verify）
tail                     =   4.9 s（t-record → t-verify）
record_runs = 2
s/行                     = 1.66（159.8 ÷ 96）
```

### 3.1 主档建议（n=11）

```text
样本（落笔段 s/行）  b273 1.51 / b274 1.11 / b275 1.72 / b276 1.06 / b277 1.69 / b278 1.98
                    b279 1.07 / b280 1.59 / b281 1.86 / b282 1.10 / b283 1.66
中位数               1.59 s/行
极差                 1.98 − 1.06 = 0.92 s/行（中位数的 57.9%）
record_runs 分布     1 → 1 批（b273）；2 → 10 批（b274–b283）；3+ → 0 批
结论                 **仍不切换主档**：n=11 只把中位数从 1.55 抬到 1.59，极差 59.4% → 57.9%，
                     宽度基本不变，继续等 `record_runs ≥ 3` 的实样本
```

- 本批 `total` 与 `controllable` 都可比（无关机跨度），差 19 s 是批间台账提交与 `--order`。

## 4. 度量前后（同批 6 文件，批前 `_wt_b283_pre` / 批后主工作区）

| 文件 | weak 前→后 | comments | substance 前→后 | explain 前→后 | filler 前→后 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `helpers.ts` | 16 → 0 | 54 | 79.6 → 96.3 | 90.7 → 100.0 | 27.8 → 0.0 |
| `flip-metric-value.tsx` | 16 → 0 | 40 | 65.0 → 97.5 | 75.0 → 100.0 | 40.0 → 0.0 |
| `ConversationSharePreflightStatus.tsx` | 16 → 0 | 52 | 67.3 → 84.6 | 84.6 → 100.0 | 30.8 → 0.0 |
| `assistantCodeComment.ts` | 16 → 0 | 55 | 70.9 → 87.3 | 100.0 → 100.0 | 29.1 → 0.0 |
| `chatSessionScrollMemory.ts` | 16 → 0 | 40 | 67.5 → 97.5 | 85.0 → 100.0 | 40.0 → 0.0 |
| `modeConfigUpdateGuard.ts` | 16 → 0 | 40 | 72.5 → 97.5 | 80.0 → 100.0 | 40.0 → 0.0 |
| **合计** | **96 → 0** | **281** | **70.8 → 92.9** | **86.8 → 100.0** | **33.8 → 0.0** |

- `units=573`（前后同值），`coverage=7.2% / branch=4.2%` 前后不变：只改注释，未动代码。
- 全仓同域：`WEAK 7935/1946` → **`7839 / 1940`**（−96 行 / −6 文件，6 个文件全部清零）；
  `filler 2851 → 2756`。
- 池外仍为 **`7839 − 4555 = 3,284` 行**——b280–b283 连续四批同值，排除口径稳定。

## 5. 七行门禁

```text
删本线注释    n=96
删代码        n=0
删上游注释    n=0
新增非注释行  n=0
原行搬移      n=0
标点级改写    n=0
新增注释行    n=96  判据命中 0  嵌套注释 0
numstat: +96 −96
expected=6  staged=6
ORDER GATE PASS record=2026-11-11T02:26:56.694Z verify=2026-11-11T02:27:01.597Z files=6
GATE self=d:\code\_annot_baseline\zc-commit.mjs blob=f02be471a849
```

### 5.1 预检与越界

```text
--scope   plan=96 allow=0 diff_old=96 diff_new=96 out_of_scope_edits=0
--record  run1  hits=3（2 W + 1 L）→ 返修
--record  run2  hits=0
mtime     touched_restored=0
line-drift samples=91（record）/ 97（verify） files=0
越界      write_phase=0 / record_phase=0 / 合计 0
```

- 首轮 3 条：`flip-metric-value.tsx:70` W（`w-[0.34em]` 无可识别标识符）、
  `ConversationSharePreflightStatus.tsx:54` L（三个 `、` 无谓词）、`:125` W；
  分别补 `character`、`先读 … 三类长度`、`Popover` 后 `hits=0`。
- 行级漂移：`writes-b283.tsv` 共 91 个样本（watcher 15 轮），非 plan 行 sha 只有
  「start(HEAD)」与「record(工作树)」两种值，`LINE-DRIFT files=0`。

### 5.2 本批返修：缩进与行尾（工具副作用，非判据问题）

逐行替换脚本替换了整行，把函数体内/块内的注释从原缩进改成顶格，并把替换行的行尾从 CRLF 变成 LF
（原文件是 CRLF）。`--record` 只比正文字节、七行门禁只判行分类，**两者都没报**。
- 实际损失（b284 用第 8 行门禁复核）：**14 条**原本有缩进的注释被抹成顶格
  （`flip-metric-value.tsx` 3 条 + `ConversationSharePreflightStatus.tsx` 11 条；其余 82 条本来就在顶格），
  **96 个改动行**的行尾从 CRLF 变成 LF。
- 首版 `b283-fix-indent.mjs` 只恢复了其中 14 条，却**额外**给 12 条本该顶格的注释加了 2 空格缩进，
  且只统一了 3 个文件的行尾；这两种残留都被第 8 行门禁首跑抓出（`indentChanged=12 eolChanged=48`），
  修正后 `0 / 0`。
- 第 8 行门禁的正负控见 `INDEX.md` §2.6 末条：负控（修复前脚本）`indentChanged=14 eolChanged=96`
  + `exit 1`；正控（修复后脚本）`0 / 0` + `exit 0`。
- **这是脚本缺陷，不是门禁缺陷**，但暴露了门禁缺一行：`--record` 与七行门禁都看不见「整行被重建」。
  b284 起这条成为第 8 行门禁（`PRECHECK INDENT indentChanged=<n> eolChanged=<n>`，非零 `exit 1`）；
  apply 实现同步改为「取原行前导空白 + 原换行符」。门禁是底线，模板只是习惯。
- **历史可回放口径（b285 前置审计）**：提交里的 `c9576925` 读数是 **12 条、方向「顶格 → 加 2 空格」**，
  不是 14 条抹平——首版 `b283-fix-indent.mjs` 在提交前已把 14 条恢复，同时错误地给 12 条加了缩进；
  `5522d403` 再把这 12 条撤掉，两笔逐行镜像、净额 0。上面 `14/96` 是修复前脚本在副本上的负控，不是提交形态。
  行尾侧在历史里不可回放（对象库 LF、`cat-file --filters` 两侧都 smudge 成 CRLF）；详见
  [`ZC-deep-history-audit.md`](ZC-deep-history-audit.md)。

## 6. 收口

### 6.1 守卫

```text
WEAK 15文件  pre=4  post=4  新增=0  max=8  key=file+正文
GUARD PASS
```

### 6.2 产能

```text
WHITELIST OK head=c95769252160 rows=278
BATCHCHK b283  OK
done files=196 lines=2866  perBatch=2
REMAIN 811 4555 - 406
ACCT files  196 + 811 = 1007  OK
ACCT lines  2866 + 4555 = 7421  OK
ACCT NOTE 恒等式只对池内成立（池 = 基线 diff 的 + 行 ∩ 本线 blame）；池外 weak 不进 done/remain，另计为外部观测
ALIGNED acct_remain=4555 pool_remain=4555 diff=0  OK
ASSERT PASS
```

`ledger-assert PASS`（802 收口三列 `144/658/802` 全 OK，b283 的 tsv 按非 802 批次 `IGNORED`）。
本批推进 `remain`：4,651 → **4,555**。白名单由 `own-commits-gen.mjs` 重生成：275 → **278 行**，
`meta.head=c95769252160`（与 HEAD 一致，产能件才放行）。

## 7. 矩阵后执行：本批没有新增门禁

- b282 的「边界 × 门禁矩阵」（`INDEX.md` §2.6）在本批按「照常推进」执行，未新增工具（第 8 行门禁在 b284 才落地）。
  四条边界的责任（b284 更正编号）：①瞬时还原（<10 s）→ **无人负责、已接受**；②行数改变/位移 → `--record` 集合同构 `exit 8`；
  ③文件级还原 → mtime（已覆盖）；④行级还原（>10 s）→ `--watch` + LINE-DRIFT。**真空只有 ①**，本批台账此前误写为 ③。
- 本批两项读数可回归：`touched_restored=0`、`LINE-DRIFT files=0`；② 未发生（`diff_old=diff_new=96`）。
- ① 的接受理由不变（净效果为零，未完全还原的残留必进最终 diff 被 ② 或七行门禁拦）。

## 8. 趋势：归户错 / 文本错 / 越界

| 批 | 归户错 | 文本错 | write_phase | record_phase | 合计 | rolled_back | includes_upstream | `record_runs` | 明细 |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | --- |
| b279 | 0 | 0 | 1 | 0 | **1** | yes | no | 2 | `useWebElementContexts.ts:84` 整块替换越界 |
| b280 | 0 | 0 | 3 | 0 | **3** | yes | no | 2 | `remoteWorkspaceServiceCollection.ts:180-182` |
| b281 | 0 | 0 | 1 | 0 | **1** | yes | no | 2 | `embeddedBrowserHelpers.ts:111` 行级还原，mtime 测不到 |
| b282 | 0 | 0 | 0 | 0 | **0** | no | no | 2 | 6 W 返修；`LINE-DRIFT files=0` |
| **b283** | **0** | **0** | **0** | **0** | **0** | **no** | **no** | **2** | 2 W + 1 L 返修；缩进返修；`LINE-DRIFT files=0` |

十一批合计：`write_phase 12 + record_phase 0 = 12`。

## 9. 池外定性与 A2 恒等式

- 池外 `3,284` 行 / 1,308 文件，b280→b283 四批同值；继续按「明确排除」处理，不纳入 `remain`。
- A2：`done + remain == 7,421`，**该恒等式只对池内成立，池外 3,284 行另计**。
- 三断言：`remain == 0` 未达成；`done + remain == 7421` OK；`ledger-assert PASS` OK。
