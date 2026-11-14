# ZC-deep-b284：注释清水 100 行（6 文件）· 第 8 行门禁首跑批次

> 批次：b284 ｜ 提交 `22994ad3` ｜ 代码 `+100/−100` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v13（`f02be471a849`）、
> `precheck-assert.mjs`（含第 8 行门禁，b284 版）、`capacity-estimate.mjs`（`3ff652131ef9`）、
> `weak-guard.mjs`（`a3600ccfacab`）、`ledger-assert.mjs`（`35afeb266f97`）。

## 0. 交代

1. 本批 6 文件 / **100 行**（17+17+17+17+16+16）：`writable=100 / upstream=0 / self-clearing=0 / pool-out=0 / pending=0`
   （`TALLY ownIn=100 ownOut=16 upOut=4`，池外 16 行按「明确排除」不进本批）。
2. 这是第 8 行门禁（缩进/行尾）落地后的首批：`--record` 与 `--verify` 都输出
   `PRECHECK INDENT indentChanged=0 eolChanged=0`；apply 用修复版模板（保留原前导空白 + 原换行符）。
3. 流程：`--start`（`ts=2026-11-11T02:37:00.911Z`，mtime 快照 20,074 文件）→ 后台 `--watch`
   （10 s 采样，3 轮）→ 改写 → `--scope`（`diff_old=100 diff_new=100 out_of_scope_edits=0`）
   → `--record` 首轮 7 命中（6 W + 1 L）→ 返修 → `--record`（`hits=0`）→ `--verify` → `zc-commit v13` → `--order`。
4. 七行门禁：`expected=6 staged=6`，`+100/−100`，`GATE blob=f02be471a849`。

## 1. 计划表

| 文件 | 可写 | 上游 | 池外 | 本批 | 批后残留 weak |
| --- | ---: | ---: | ---: | ---: | ---: |
| `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/session-inputs.ts` | 17 | 0 | 1 | 17 | 0 |
| `apps/zcode-cli/packages/core/src/runtime-task/workflow-notification-copy.ts` | 17 | 0 | 2 | 17 | 2 |
| `packages/desktop/src/host/browserControlMainBridge.ts` | 17 | 0 | 3 | 17 | 3 |
| `packages/ui/src/app-shell/workflow-artifacts/presets/apply.ts` | 17 | 0 | 1 | 17 | 1 |
| `apps/zcode-cli/packages/debug/server/network-capture.ts` | 16 | 0 | 0 | 16 | 8 |
| `apps/zcode-cli/packages/tui/src/app-file-mentions.ts` | 16 | 0 | 0 | 16 | 0 |
| **合计** | **100** | **0** | **7** | **100** | **14** |

- 6 个文件的 100 条可写行全部 `blame=a8784b7e479d3a`，`allow=16`（池外 own 行，不参与本批）。

## 2. 配额与批后池

```text
SELF-CLEAR n=2	可写桶 0 / 池外 2 / 上游桶 0 / 未解析 0（只有可写桶进配额扣减）
```

- `ZC-deep-b284-rewrite.tsv` 100 行，批前落盘。
- 批后 `done files=202`（+6）/ `done lines=2966`（+100），`remain files=805` / `remain lines=4455`（−100）。
- `SELF-CLEAR n=2` 的解释：`session-inputs.ts:132` 与 `app-file-mentions.ts:285` 是**池外**邻行，
  本批没改它们，但它们与相邻目标行同属一个注释块，目标行补上标识符后整块不再判 weak。
  所以全仓 weak 减了 **102** 而 `done` 只加 100——两者差额正是这 2 行，不是记账错误。

## 3. 计时（b284 样本不计入中位数）

```text
t-start    2026-11-11 10:37:00.911 +08:00
t-record   2026-11-11 10:37:35.371 +08:00  sha=2f2dc3db7d65  record_runs=2
t-verify   2026-11-11 10:37:41.938 +08:00  sha=2f2dc3db7d65  record_runs=2
commit     2026-11-11 10:38:23 +08:00  22994ad3

batch_wall_total         = 210.0 s
batch_wall_controllable  =  83.0 s
落笔段                   =  41.0 s（t-start → t-verify）
tail                     =   6.6 s
record_runs = 2
s/行                     = 0.41（不进入样本）
```

- **为什么 0.41 不可比**：本批 100 条正文在 `--start` 之前就已随 `b284-apply.mjs` 写好，
  落笔段只包含「跑脚本 + 预检 + 一次返修」，不含起草时间。把它混进中位数会把主档压出一个假低点，
  所以新口径仍按 **n=11、中位数 1.59 s/行、极差 57.9%** 报，b284 单列为「测量口径失效样本」。
- 下批起要么在 `--start` 之后再起草，要么在台账里明确标注「正文先于起笔完成」，不许两套混用。

## 4. 度量前后

| 文件 | weak 前→后 | substance 前→后 | filler 前→后 |
| --- | ---: | ---: | ---: |
| `session-inputs.ts` | 18 → 0 | 78.4 → 79.6 | 14.7 → 0.0 |
| `workflow-notification-copy.ts` | 19 → 2 | 67.4 → 78.9 | 15.8 → 0.0 |
| `network-capture.ts` | 24 → 8 | 60.5 → 68.1 | 12.6 → 0.0 |
| `app-file-mentions.ts` | 17 → 0 | 81.6 → 95.4 | 19.5 → 0.0 |
| `browserControlMainBridge.ts` | 20 → 3 | 86.8 → 92.1 | 14.9 → 0.0 |
| `apply.ts` | 18 → 1 | 67.6 → 77.5 | 16.7 → 0.0 |
| **合计** | **116 → 14** | **73.6 → 82.0** | **15.5 → 0.0** |

- `units=1248`、`comments=633` 前后同值；`explain 91.3 → 97.8`。
- 全仓：`WEAK 7839/1940` → **`7737 / 1938`**（−102 行 / −2 文件）；`filler 2658`。
- 池外：`7737 − 4455 = 3,282`（b283 为 3,284，差 2 即上面的 SELF-CLEAR 邻行）。

## 5. 门禁

```text
删本线注释    n=100
删代码        n=0
删上游注释    n=0
新增非注释行  n=0
原行搬移      n=0
标点级改写    n=0
新增注释行    n=100  判据命中 0  嵌套注释 0
numstat: +100 −100
ORDER GATE PASS record=2026-11-11T02:37:35.371Z verify=2026-11-11T02:37:41.938Z files=6
GATE blob=f02be471a849
```

### 5.1 第 8 行门禁（本批新增）

```text
--record  PRECHECK INDENT indentChanged=0 eolChanged=0
--verify  PRECHECK INDENT indentChanged=0 eolChanged=0
```

- 判据：`-U0` hunk 内删除行与新增行按序配对，只比两侧都是注释的行；比前导空白字节与行尾字节。
  「替换前」取 `git cat-file --filters <base>:<file>`（工作区属性 smudge，CRLF 树拿到 CRLF）。
- 负控（worktree `_wt_b283_ctl8` 重放修复前脚本）：`indentChanged=14 eolChanged=96` + `exit 1`。
- 正控（修复后脚本）：`indentChanged=0 eolChanged=0` + `exit 0`。
- 对已提交的 b283 复测：`indentChanged=12 eolChanged=48` → 修正后 `0/0`。
  详见 `INDEX.md` §2.6 末条与 b283 台账 §5.2。

### 5.2 预检与越界

```text
--record  run1 hits=7（6 W + 1 L）→ 返修
--record  run2 hits=0
mtime     touched_restored=0
line-drift samples=19（record）/ 25（verify） files=0
越界      write_phase=0 / record_phase=0 / 合计 0
```

- 首轮 7 条：`workflow-notification-copy.ts:39/40/142/314`、`app-file-mentions.ts:290`、
  `browserControlMainBridge.ts:314`、`apply.ts:211`；补 `notification`、`SYSTEM_NOTIFICATION_BANNER`、
  `Math.max`/`先…取整`、`WORKFLOW_BLOCKED_TEXT_MAX_CHARS`、`replaceSelection`、`pending.delete`、
  `log/linear` 后 `hits=0`。

## 6. 收口

```text
GUARD 15文件  pre=4  post=4  新增=0  max=8  key=file+正文  → PASS
ACCT files  202 + 805 = 1007  OK
ACCT lines  2966 + 4455 = 7421  OK
ALIGNED acct_remain=4455 pool_remain=4455 diff=0  OK
ledger-assert PASS（802 收口 658/802/802 全 OK）
WHITELIST OK head=22994ad36a81 rows=282
```

## 7. 矩阵（四条边界，b284 更正编号）

| # | 失败模式 | 谁拦 | 读数 / 退出 | 是否被覆盖 | 结论 |
| --- | --- | --- | --- | --- | --- |
| ① | 非 plan 行 10 s 内改完又还原 | 无 | — | 否（残留进最终 diff 后被 ② 或七行门禁兜住） | **唯一真空 → 已接受** |
| ② | 行数改变导致整体位移 | `--record` 集合同构 | `改动行集合 ≠ plan 行集合`，`exit 8` | 是，先于 watcher 与七行门禁 | 有主；watcher 为冗余路径 |
| ③ | 文件级还原 | mtime 复拍 | `touched_restored=N` | 是（mtime 为此设计） | **已覆盖**，计入 write_phase |
| ④ | 行级还原（>10 s） | `--watch` + LINE-DRIFT | `samples=N files=M` | 是（唯一证据） | 有主，计入 write_phase |

本批读数：`touched_restored=0`、`LINE-DRIFT files=0`、② 未发生（`diff_old=diff_new=100`）、
第 8 行门禁 `0/0`。① 无读数可报（窗口内无写操作），按已接受风险处理。

## 8. 趋势

| 批 | 归户错 | 文本错 | write_phase | record_phase | 合计 | rolled_back | 明细 |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| b281 | 0 | 0 | 1 | 0 | **1** | yes | `embeddedBrowserHelpers.ts:111` 行级还原 |
| b282 | 0 | 0 | 0 | 0 | **0** | no | 6 W 返修 |
| b283 | 0 | 0 | 0 | 0 | **0** | no | 2 W + 1 L；缩进/行尾返修（工具副作用） |
| **b284** | **0** | **0** | **0** | **0** | **0** | **no** | 6 W + 1 L 返修；第 8 行门禁 0/0 |

十二批合计：`write_phase 12 + record_phase 0 = 12`。

## 9. 池外与 A2

- 池外 `3,282` 行（b283 后 3,284，减少的 2 行为邻行 weak 翻转，非本批改写）。
- A2：`done + remain == 7,421`，只对池内成立；池外另计。
