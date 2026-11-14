# ZC-deep-b276：注释清水 100 行（6 文件）· 新口径样本 n=4

> 批次：b276 ｜ 提交 `622952e8` ｜ 代码 `+100/−100` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v12（`a35b42fa2e4c`）、
> `capacity-estimate.mjs`（`71c35d496da1`）、`weak-guard.mjs`（`a3600ccfacab`）、
> `ledger-assert.mjs`（`35afeb266f97`）、`precheck-assert.mjs`（`47a15788e58a`，`--scope` 第二次跑）。

## 0. 交代

1. 本批 6 文件 / 100 行，全部池内可写：`writable=100 / upstream=0 / self-clearing=0 / pool-out=1 / quota=100`。
2. 6 文件：`ConversationTelemetryAttachment.tsx`(19)、`webRemoteControlConnectingScreen.tsx`(19)、
   `turn-state.ts`(18)、`persistent-memory-prompt.ts`(18)、`standalone-checks.ts`(18)、`vite.config.ts`(8)。
3. 流程：`--start` → 改写 → `--scope`（只报不拦，首轮 `越界 0 / 漏改 0`）→ `--record` → `--verify` → 七行门禁。
4. 预检首轮 5 条命中（4 W + 1 L），返修后 `hits=0`，`record_runs=2`。
5. 七行门禁全 0，`expected=6 staged=6`，`+100/−100`。
6. 本批无连带自清：池外 1 行（上游 `persistent-memory-prompt.ts:28`）原样保留，批后 weak 残留 1。

## 1. 四态摘要与三列计划表（沿用 b265 §2）

```text
PLAN#1	6 文件 / 100 行	writable=100 upstream=0 self-clearing=0 pool-out=1 pending=0
quota=100(writable 100 − self-clearing 0) 四态和=101=weak合计 池内weak=100/池内实测 101
```

| 文件 | 可写 | 上游 | 池外 | 小计 |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/v4/telemetry/ConversationTelemetryAttachment.tsx` | 19 | 0 | 0 | 19 |
| `packages/web/src/web-remote-control/ui/webRemoteControlConnectingScreen.tsx` | 19 | 0 | 0 | 19 |
| `apps/zcode-cli/packages/core/src/agent/turn-state.ts` | 18 | 0 | 0 | 18 |
| `apps/zcode-cli/packages/core/src/subagent/persistent-memory-prompt.ts` | 18 | 0 | 1 | 19 |
| `packages/desktop/scripts/gen-ui-fixture/standalone-checks.ts` | 18 | 0 | 0 | 18 |
| `apps/dev-docs/vite.config.ts` | 8 | 0 | 0 | 8 |
| **合计** | **100** | **0** | **1** | **101** |

- 池外 1 行：`persistent-memory-prompt.ts:28`「持久记忆提示词模板（英文原文即模型契约，改动需评估行为回归）。」
  blame `c788b9f1`，上游、池外、未触碰，批后仍在（就是批后残留的那 1 行 weak）。

## 2. 配额扣减与批后池

```text
SELF-CLEAR n=0	可写桶 0 / 池外 0 / 上游桶 0 / 未解析 0
```

批后 6 文件 weak `101 → 1`，减少的 100 行全部是登记表里的 1→1 改写；没有自清、没有多改、没有漏改。

## 3. 计时：三量（新口径样本 n=4）

```text
t-start    2026-11-11 03:37:59.593 +08:00
t-record   2026-11-11 03:39:41.921 +08:00  sha=238d760c6a60  record_runs=2
t-verify   2026-11-11 03:39:45.818 +08:00  sha=238d760c6a60  record_runs=2
commit     2026-11-11 03:40:06 +08:00  622952e8

batch_wall_total         = 253.0 s（1ca9a75f → 622952e8，git 两端）
batch_wall_controllable  = 127.0 s（t-start → commit）
落笔段                   = 106.2 s（t-start → t-verify）
tail                     =   3.9 s（t-record → t-verify）
record_runs = 2
```

- `253.0 s` 与 `127.0 s` 之差 126 s 是门禁、提交与批间动作，不改写行。
- `--order --commit 622952e8 --prev 1ca9a75f` 输出 `PRECHECK ORDER OK`。
- 新口径样本累计 **n=4**：`落笔段/100 = 1.51 / 1.11 / 1.72 / 1.06`。n=5 时按约定报主档建议（b277 后）。

## 4. 度量前后（同批 6 文件，干净 worktree）

| 文件 | weak 前→后 | comments | substance 前→后 | explain 前→后 | filler 前→后 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `vite.config.ts` | 8 → 0 | 70 | 87.1 → 94.3 | 98.6 → 100.0 | 11.4 → 0.0 |
| `turn-state.ts` | 18 → 0 | 66 | 59.1 → 78.8 | 86.4 → 100.0 | 27.3 → 0.0 |
| `persistent-memory-prompt.ts` | 19 → 1 | 52 | 71.2 → 92.3 | 82.7 → 98.1 | 34.6 → 0.0 |
| `standalone-checks.ts` | 18 → 0 | 41 | 58.5 → 95.1 | 78.0 → 100.0 | 43.9 → 0.0 |
| `ConversationTelemetryAttachment.tsx` | 19 → 0 | 73 | 67.1 → 74.0 | 100.0 → 100.0 | 26.0 → 0.0 |
| `webRemoteControlConnectingScreen.tsx` | 19 → 0 | 44 | 56.8 → 93.2 | 86.4 → 100.0 | 43.2 → 0.0 |
| **合计** | **101 → 1** | **346** | **67.9 → 86.7** | **90.2 → 99.7** | **28.9 → 0.0** |

全仓同域（`packages,apps,docs/knip`）：`WEAK lines=8610 files=1982` → **`8510 / 1977`**。
减少 100 行 = 100 行改写，减少 5 个文件 = 5 个文件清零（`persistent-memory-prompt.ts` 仍剩 1 行上游 weak）。

## 5. 七行门禁（`zc-commit.mjs` v12，`--rewrite-annot --base HEAD`）

```text
删本线注释    n=100  （允许，逐行登记）
删代码        n=0    （必须 0）
删上游注释    n=0    （必须 0）
新增非注释行  n=0    （必须 0）
原行搬移      n=0
标点级改写    n=0    （必须 0）
新增注释行    n=100  其中判据命中 0  其中嵌套注释 0
numstat: +100 −100
expected=6  staged=6
GATE self=d:\code\_annot_baseline\zc-commit.mjs blob=a35b42fa2e4c
```

登记表：`ZC-deep-b276-rewrite.tsv`（100 行，全部 blame `a8784b7e479d3a`）。

### 5.1 预检：集合断言首轮过，判据命中 5 条

```text
--scope   PRECHECK SCOPE plan=100 allow=1 diff_old=100 diff_new=100 out_of_scope_edits=0
          PRECHECK SCOPE PASS 越界 0 / 漏改 0（只报不拦）
--record  HIT persistent-memory-prompt.ts:34 W 单行无信息
          HIT standalone-checks.ts:54 W 单行无信息
          HIT standalone-checks.ts:55 W 单行无信息
          HIT standalone-checks.ts:168 W 单行无信息
          HIT ConversationTelemetryAttachment.tsx:68 L 无信息列举
          PRECHECK RECORD FAIL n=100 hits=5 record_runs=1
```

- 4 条 W 的共性：整句中文却没有 ASCII 标识符可挂（「反例段落…」「断言完即移除探针…」）；
  补 `negative examples`、`probe.remove()`、`light / dark`、`checkStandalone` 后过。
- 1 条 L 是 `，…，…` 两个逗号无谓词，改成「而不表达顺序语义」后过。
- 二轮 `record n=100 hits=0 sha=238d760c6a60 record_runs=2`，`--verify` 逐字节通过（`tail=3.9 s`）。

```text
out_of_scope_edits = 0   scope=0 / record=0   计入 record_runs = 否
```

## 6. 守卫 / 断言 / 产能 / 提交

### 6.1 `weak-guard`（15 文件 cohort，与本批 6 文件无交集）

```text
WEAK 15文件  pre=4  post=4  新增=0  max=8  key=file+正文
GUARD PASS
```

### 6.2 `ledger-assert`

```text
BATCH ZC-deep-b248..b260-rewrite.tsv（12 批）
IGNORED b261–b276（非 802 批次，各 100 行不计入）
SUM 各批 = 802  OK ；ROLL 144 / 658 / 802 均 OK ；GREP 全仓 2 = 清单内 0 + 清单外 2  OK
EXEMPT 2 ；REMAIN 0 ；CLOSE 802 = 802  OK ；FILELIST 15 文件 OK
ASSERT PASS
```

### 6.3 产能与池等式

```text
BATCHCHK b276 pre=b275-repo-post.txt weak=b276-repo-post.txt  OK
done files=156 lines=2196
REMAIN	851	5225	-	426
SELF-CLEAR n=0	可写桶 0 / 池外 0 / 上游桶 0 / 未解析 0
PARTIAL	packages/ui/src/ToolCallBlocks/renderers/cuaDetails.tsx	基线 23 → 现 1
ACCT files  done 156 + remain 851 = 1007  OK
ACCT lines  done 2196 + remain 5225 = 7421  OK
ALIGNED acct_remain=5225 pool_remain=5225 diff=0  OK
ASSERT PASS
```

落笔后池数：**851 文件 / 5,225 行**（b275 后为 857 / 5,325；本批 −6 文件、−100 行）。

- 三个批数口径照 `ZC-deep-b271.md` §8.3：`147`（排期）/ `53`（纯行上界，现为 `5,225÷100≈52`）/
  `426`（文件装箱对照，不作排期）。

### 6.4 提交

| 提交 | 内容 |
| --- | --- |
| `622952e8` | 代码（注释）`+100/−100`，6 文件，`expected=6 staged=6` |
| 本台账 | `ZC-deep-b276.md`、`ZC-deep-b276-rewrite.tsv` |

## 7. 趋势：归户错 / 文本错 / 越界

| 批 | 归户错 | 文本错 | `out_of_scope_edits` | `record_runs` | 明细 |
| --- | ---: | ---: | ---: | ---: | --- |
| b273 | 0 | 0 | 4（3 本线 + 1 上游，已回滚） | 1 | 预检 0 |
| b274 | 0 | 0 | 0（首用集合断言） | 2 | `--scope` 尚未存在 |
| b275 | 0 | 0 | 0（scope 0 / record 0） | 2 | 1 W + 2 L |
| **b276** | **0** | **0** | **0（scope 0 / record 0）** | **2** | 4 W + 1 L |

## 8. 收口三断言（指针）

仍按 `ZC-deep-b265.md` §9：`remain == 0`、`done + remain == 7,421`、`ledger-assert PASS`。
本批推进 `remain`：5,325 → **5,225**，A1 未达成。
