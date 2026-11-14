# ZC-deep-b270：PLAN#2 五文件 / 100 行改写（预检拦 11 · 门禁首轮 0 · 落笔段首次可复算）

- base：`0aa52e00`（b269 台账：预检 sha 只覆盖正文字节 + 三条负控）
- 代码提交：`384ce0d3 docs(注释): b270 注释清水 100 行（5 文件） (+100/−100)`
- 规划成员：`WorkflowTimelineStation.tsx`(20)、`feedbackUserView.ts`(20)、
  `usePptxFileWatch.ts`(20)、`useRemoteConnectionLogs.ts`(20)、`useSettingService.ts`(20)

尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v12（`a35b42fa2e4c`）、
`capacity-estimate.mjs`（`77c4cc2391e7`）、`weak-guard.mjs`（`a3600ccfacab`）、
`ledger-assert.mjs`（`35afeb266f97`）、`precheck-assert.mjs`（`8b3abe2bf6dc`，sha 只覆盖正文）。

## 0. 交代

| # | 事项 | 结论 |
| --- | --- | --- |
| 1 | 配额 = `writable − self-clearing` | 落笔前四态 `writable=100 / upstream=0 / self-clearing=0 / pool-out=10 / pending=0 → quota=100` |
| 2 | 落笔前预检（工具约束） | `--record` 首轮 **11 处**（2 L + 9 W），全部改后 `n=100 hits=0 sha=94380ffbd7e3`；门禁前 `--verify` 同 sha → 门禁首轮 0 |
| 3 | 计时 | **首次用时间戳文件**：`b270-t-start.txt` / `b270-t-write-end.txt`；落笔段 **161.9 s → 1.62 s/行**，可复算 |
| 4 | 自清 | 池外 **4 行**（3 条 ` */` + 1 条单行 JSDoc），**全部是判定变化**：行仍在、字节不变；**删除行 0**；不进配额扣减（见 §2） |
| 5 | 主档 | B 段可复算样本到 **n=3**（b267 1.57 / b268 1.58 / b270 1.62）；**主档仍用 1.58**，切换待议（见 §3.3） |

## 1. 三列计划表（沿用 b265 §2）

| 类别 | 行数 | 明细 |
| --- | ---: | --- |
| 真上游（池内） | **0** | 池 = `git diff +` 行，上游行进不来 |
| 本线已转强（池内块尾 `*/`） | **0** | 本批无 |
| 可写（池内 + 白名单） | **100** | 等于配额，全部落笔 |
| 池外另计 | **10** | 4 个空 `//` 行自清后不计，余 6 行仍弱（见 §4） |
| 合计 weak | **110** | `100 + 10` |

```text
TALLY ownIn=100 ownOut=10 upIn=0 upOut=0
```

## 2. 配额扣减与四态断言

```text
PLAN#1	5 文件 / 100 行	writable=100 upstream=0 self-clearing=0 pool-out=10 pending=0
quota=100(writable 100 − self-clearing 0) 四态和=110=weak合计 110 池内weak=100/池内实测 100
SELF-CLEAR n=4	可写桶 0 / 池外 4 / 上游桶 0 / 未解析 0
```

四条自清全落池外，且**四条都是「行还在、只是不再判 weak」的判定变化**：改写前后逐行比对，行仍存在、
正文逐字节相同（同一正文 sha），本批**没有删除任何注释行**。

| # | 行 | 正文（改写前后同字节） | 改写前存在 | 改写后存在 | 字节变化 | 判定变化 | 删除行 | blame | 归属 |
| ---: | --- | --- | --- | --- | --- | ---: | ---: | --- | --- |
| 1 | `WorkflowTimelineStation.tsx:51` | ` */` | 是 | 是 | 否（`533a9f115572`） | ✓ | 0 | `872ad960d` | 上游行（池外） |
| 2 | `WorkflowTimelineStation.tsx:145` | ` */` | 是 | 是 | 否（`533a9f115572`） | ✓ | 0 | `872ad960d` | 上游行（池外） |
| 3 | `WorkflowTimelineStation.tsx:301` | ` */` | 是 | 是 | 否（`533a9f115572`） | ✓ | 0 | `872ad960d` | 上游行（池外） |
| 4 | `useSettingService.ts:137` | `/** 获取和更新应用设置 */` | 是 | 是 | 否（`478db31bc6b4`） | ✓ | 0 | `872ad960d` | 上游行（池外） |
| — | **合计** | — | **4** | **4** | **0** | **4** | **0** | — | — |

- 实测口径：`git show 0aa52e00:<file>` 与 `git show 384ce0d3:<file>` 同号行逐字节比较；sha 为该行正文的
  sha256 前 12 位（两版相同即字节未变）。复算件 `_annot_baseline/b270-selfclear-check.mjs` 按 `git diff -U0`
  建 old→new 映射，对池外行逐条给「是否存在 / 是否同字节」。
- 机制：判 weak 的单位是 `sentenceUnit` 合并出的整句，` */` 这类收尾行跟随所在整句的判定；相邻正文行改写后
  整句有了锚点，这 4 行随之不再判 weak。**不是行被合并进相邻段落，更不是被删掉。**
- 「删除行」栏为 0 的旁证：`git diff --numstat` 为 5 × `20/20`，5 文件行数合计 1,212 → 1,212 未变；
  门禁 `删本线注释 n=100 / 新增注释行 n=100` 是 100 组 1→1 替换，无净删除。
- 计数口径：完成数只记落笔的 **100 行**；4 条判定变化不计入完成行数，也不扣配额（`100 − 0 = 100`）。

批后复算：

```text
BATCHCHK b270 pre=b269-repo-post.txt weak=b270-repo-post.txt  OK
done files=121 lines=1596	perBatch=2
REMAIN	886	5825	-	444
SELF-CLEAR n=4	可写桶 0 / 池外 4
ACCT files  done 121 + remain 886 = 1007  OK
ACCT lines  done 1596 + remain 5825 = 7421  OK
ALIGNED acct_remain=5825 pool_remain=5825 diff=0  OK
```

全仓 weak `9218 / 2009` → **`9114 / 2005`**（−104 行 / −4 文件）；`filler 4027 → 3930`（−97）。

文件数 −4 而 weak 行 −104 的差额 4，正是 4 条自清：**自清会减 weak，但不减文件**（文件里仍留着 6 行池外 weak）。

## 3. 计时（首次可复算）

| 段 | 起止 | 实测 | 说明 |
| --- | --- | ---: | --- |
| 规划 + 选行 | 02:26:47 起 | 并入落笔段 | `--batch b269` 四态 + PLAN#1 池内外核对 |
| **落笔段** | `b270-t-start` → `b270-t-write-end` | **161.9 s** | 读 5 文件、20 处改写、预检首轮 11 处返工 |
| 预检与门禁 | 定稿 → 02:30:15 | 约 30 s | `--record`、`--verify`、七行门禁、提交 |
| 后测 | 02:30:15 → 02:33 | 约 170 s | 2 个 worktree、全仓 + 5 文件 + cohort |

两列口径：

| 列 | 值 | 说明 |
| --- | ---: | --- |
| **落笔段 `s/行`** | **1.62**（161.9 ÷ 100，时间戳可复算） | 进 B 段样本表；主档暂不动 |
| 全批 `s/行` | 2.08（02:26:47 → 02:30:15 = 207.5 s） | 仅历史记录，不可用于排期 |

**中断判定：无。**

### 3.1 落笔段 `s/行` 与门禁成本（按工艺分两段，**前后段不可直接比较**）

**A 段：无落笔前预检（b261–b266）**

| 批 | 行数 | 落笔段 `s/行` | 首轮命中处数 | 门禁轮数 | 中断 |
| --- | ---: | ---: | ---: | ---: | --- |
| b261 | 100 | 1.90 | 4（3L+1W） | 2 | 无 |
| b262 | 100 | 2.17 | 3（3W） | 3 | 无 |
| b263 | 100 | 3.04 | 11（10L+1W） | 2 | 无 |
| b264 | 100 | 5.31 | 5（4 归户 + 1W） | 2 | 有 |
| b265 | 100 | 4.90 | 4（3L+1W） | 2 | 有 |
| b266 | 100 | 3.96 | 3（2L+1W） | 3 | 无 |

**B 段：落笔前预检上线（b267–）**

| 批 | 行数 | 落笔段 `s/行` | 预检首轮命中 | 门禁首轮 | 门禁轮数 | 可复算 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| b267 | 100 | 1.57 | 未留数（手工预检） | 1 W | 2 | 是 |
| b268 | 100 | 1.58 | 未留数（手工预检） | 1 L | 2 | 是 |
| b269 | 100 | 1.30（估） | 2（2W） | 0 | 1 | **否**（未起秒表） |
| **b270** | 100 | **1.62** | **11（2L+9W）** | **0** | **1** | **是**（时间戳文件） |

### 3.2 排期：主档 1.58（n=2 可复算）+ 保守档 3.9–4.0

```text
剩余 5,825 行（capacity-estimate REMAIN）
主档    1.58 s/行 →  9,204 s ≈ 2.6 h
主档上沿 1.9 s/行 → 11,068 s ≈ 3.1 h
保守档  3.9 – 4.0 s/行 → 22,718 – 23,300 s ≈ 6.3 – 6.5 h
合计区间 2.6 – 6.5 h
中位数  5,825 × 2.17 = 12,640 s ≈ 3.5 h（只作交叉验证）
批数    5,825 ÷ 100 = 58.25 批（满批 58 + 25 行）
```

### 3.3 主档政策：样本量已到 3，值不变

- 规则（b269 用户定）：主档维持 `1.58`，直到**预检上线后有 3 个可复算落笔段样本**再议；切换时样本量与切换前后值一起记。
- 现状：**n=3 可复算**（b267 1.57、b268 1.58、b270 1.62），均值 **1.59**、中位 **1.58**、极差 0.05（3.2%）。
- 处置：**本批不切换**。三个样本与 1.58 的差都在 ±3% 内（`1.58` 与均值 `1.59` 差 0.6%），对 `2.6–6.5 h` 排期无影响。
- **台账定稿句**：「n=3 已到，极差 3.2%，主档暂不改；n=5 时一并给样本量与前后值。」
- 即：样本攒到 **n=5** 再议；切换时台账须同时写「n=3→n=5」与「1.58→新值」，不得只写新值。

## 4. 度量前后（同批 5 文件，干净 worktree）

| 指标 | 改前 | 改后 | 变化 |
| --- | ---: | ---: | --- |
| weak 行 | **110** / 272 comments | **6** / 272 | −104（100 配额 + 4 池外自清） |
| `substance%` | 57.7 | **87.1** | +29.4 |
| `explain%` | 78.3 | **97.8** | +19.5 |
| `filler%` | 35.7 | **0.0** | −35.7 |
| `uncovered` | 未重测 | 未重测 | 预期不变，非进度指标（b265 §3.1） |

残留 6 行全在 `WorkflowTimelineStation.tsx` 且全属池外：`:135`（单行 `/** … */`）、`:234`（行内 `// 光标…`）、
`:297`（`/**` 开头）、`:298–300`（三行 JSDoc 正文），按四态口径不属于本批可写集合。

全仓同域（`packages,apps,docs/knip`）：`WEAK lines=9218 files=2009` → **`9114 / 2005`**；
`filler 4027 → 3930`。

## 5. 七行门禁（`zc-commit.mjs` v12，`--rewrite-annot --base HEAD`）

**首轮即通过**：

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
```

预检两阶段：

```text
PRECHECK RECORD n=100 hits=0 sha=94380ffbd7e3    （首轮 n=100 hits=11，改后重录）
PRECHECK VERIFY n=100 hits=0 sha=94380ffbd7e3  OK
```

首轮 11 处（2 L + 9 W）：

| # | 位置 | 类 | 原句 → 改法 |
| ---: | --- | --- | --- |
| 1 | `WorkflowTimelineStation.tsx:53` | W | 无标识符 → 用 `StationHead` 作锚 |
| 2 | `WorkflowTimelineStation.tsx:146` | L | 两个中文逗号 → 改为「而」连接 |
| 3 | `WorkflowTimelineStation.tsx:148` | L | `railKey(i, i + 1)` 里 ASCII 逗号计入分隔符 → 改写为「相邻两站的 railKey」 |
| 4 | `feedbackUserView.ts:171` | W | 无标识符 → 用 `body` 作锚 |
| 5 | `usePptxFileWatch.ts:52` | W | 无标识符 → 用 `FileWatchEvent` 作锚 |
| 6 | `usePptxFileWatch.ts:53` | W | 无标识符 → 用 `normalizeFileWatchPathForCompare` 作锚 |
| 7 | `useRemoteConnectionLogs.ts:36` | W | 无标识符 → 用 `REGEX` 作锚 |
| 8 | `useRemoteConnectionLogs.ts:54` | W | 无标识符 → 用 `uploadMatch` 作锚 |
| 9 | `useRemoteConnectionLogs.ts:56` | W | 无标识符 → 用 `appendRemoteConnectionRuntimeLog` 作锚 |
| 10 | `useRemoteConnectionLogs.ts:75` | W | 无标识符 → 用 `matchingProgressIndex` 作锚 |
| 11 | `useRemoteConnectionLogs.ts:77` | W | 无标识符 → 用 `matchingLog` 作锚 |

第 3 条值得单记：**代码片段里的 ASCII 逗号会被 L 判据当作分隔符**，与 b268 的 `clipboard-image.ts:266` 同因，
只是这次发生在预检而不是门禁。ASCII 逗号计入分隔符这条判据不变，写注释时避免在括号参数里堆逗号。

登记表：`ZC-deep-b270-rewrite.tsv`（100 行）。

## 6. `uncovered` 与本批的收口边界

同 b269 §6：`uncovered` 在 1→1 改写里构造性不变，本批不复测；「110 → 6」是 weak，不是 uncovered。
池内清零不等于全仓完成，禁止用池清零暗示收口。

## 7. 趋势：归户错 / 文本错

| 批 | 归户错 | 文本错 | 明细 |
| --- | ---: | ---: | --- |
| b261–b266 | 4 | 26 | 见 b266 台账 |
| b267 | 0 | 1 | 1 W |
| b268 | 0 | 1 | 1 L |
| b269 | 0 | 0 | 门禁 0；预检拦 2 W |
| **b270** | **0** | **0** | 门禁 0；预检拦 **11**（2 L + 9 W） |

## 8. 守卫 / 断言 / 产能 / 提交

### 8.1 `weak-guard`（15 文件 cohort，与本批 5 文件无交集）

```text
WEAK 15文件  pre=4  post=4  新增=0  max=8  key=file+正文
GUARD PASS
```

### 8.2 `ledger-assert`

```text
SUM 各批 = 68 + 64 + 62 + 68 + 65 + 60 + 49 + 68 + 99 + 97 + 42 + 60 = 802  OK
ROLL 144 / 658 / 802 均 OK
GREP 全仓 2 = 清单内 0 + 清单外 2  OK
EXEMPT 2
REMAIN 剩余 = 0
CLOSE 802 = 802  OK
FILELIST 15 文件 == 批次表清单  OK
ASSERT PASS
```

### 8.3 产能与池等式

```text
done files=121 lines=1596	perBatch=2
REMAIN	886	5825	-	444
SELF-CLEAR n=4	可写桶 0 / 池外 4
ACCT files  done 121 + remain 886 = 1007  OK
ACCT lines  done 1596 + remain 5825 = 7421  OK
ALIGNED acct_remain=5825 pool_remain=5825 diff=0  OK
ASSERT PASS
```

下一批 PLAN#1（b271）：`RemoteConnectionProgressSection.tsx`、`RemoteConversationDisconnected.tsx`、
`StorageDiskCard.tsx`、`SourceServerMigrationReportPanel.tsx`、`mcpStoreHelpers.ts`，5 文件 / 100 行，
四态 `writable=100 / pool-out=0 / quota=100`。

### 8.4 提交

| 提交 | 内容 |
| --- | --- |
| `384ce0d3` | 代码（注释）`+100/−100`，5 文件，`expected=5 staged=5` |
| 本台账提交 | `ZC-deep-b270.md`、`ZC-deep-b270-rewrite.tsv` |

## 9. 收口三断言（指针）

仍按 `ZC-deep-b265.md` §9 的 A1/A2/A3：`remain == 0`、`done + remain == 7,421`、`ledger-assert PASS`。
本批只推进 `remain`：5,925 → **5,825**，A1 未达成。
