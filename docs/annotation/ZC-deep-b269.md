# ZC-deep-b269：PLAN#2 五文件 / 100 行改写（预检拦截 2 W · 门禁首轮 0）

- base：`28afddda`（b268 台账：排期改工艺分段、`precheck-assert` 入库）
- 代码提交：`22cb4efe docs(注释): b269 注释清水 100 行（5 文件） (+100/−100)`
- 规划成员：`configured-runner-callback.ts`(20)、`gen-ui-fixture/renderer.ts`(20)、
  `mcp-apps-host-fixture/managed-model-checks.ts`(20)、`WorkflowRunSpineParts.tsx`(20)、
  `BotsDialog/shared.tsx`(20)

尺子与 b268 相同：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v12（`a35b42fa2e4c`）、
`capacity-estimate.mjs`（`77c4cc2391e7`）、`weak-guard.mjs`（`a3600ccfacab`）、
`ledger-assert.mjs`（`35afeb266f97`）。**本批第一次使用 `precheck-assert.mjs`（`db7189f9b562`）**。

## 0. 交代

| # | 事项 | 结论 |
| --- | --- | --- |
| 1 | 配额 = `writable − self-clearing` | 落笔前四态 `writable=100 / upstream=0 / self-clearing=0 / pool-out=2 / pending=0 → quota=100` |
| 2 | 落笔前预检（工具约束） | `--record` 首轮 **2 处 W** 被自己拦住，改后 `n=100 hits=0 sha=b0a8ec9ee636`；门禁前 `--verify` 同 sha、0 命中 → **门禁首轮 0** |
| 3 | 常规链路 | 七行门禁全 0；`weak-guard` 新增 0；`ledger-assert PASS`；`ALIGNED diff=0`；`+100/−100`、零代码行 |
| 4 | 自清 | 池外 **1 行**（`WorkflowRunSpineParts.tsx:168` 的空 `//` 行，sha `aac47556`），随相邻块转强，不进配额扣减 |
| 5 | 计时口径缺口 | 本批**未起秒表**：只有全批可复算（提交时间戳 236 s），分段计时均为文件时间戳推算并标「估」；下批起在起笔与收笔各写一枚时间戳文件 |

## 1. 三列计划表（沿用 b265 §2）

| 类别 | 行数 | 明细 |
| --- | ---: | --- |
| 真上游（池内） | **0** | 池 = `git diff +` 行，上游行进不来 |
| 本线已转强（池内块尾 `*/`） | **0** | 本批无 |
| 可写（池内 + 白名单） | **100** | 恰好等于配额，全部落笔 |
| 池外另计 | **2** | `WorkflowRunSpineParts.tsx:168`（空 `//` 行）、`:284`（`/** … */` 单行块，`无信息列举`） |
| 合计 weak | **102** | `100 + 2` |

```text
TALLY ownIn=100 ownOut=2 upIn=0 upOut=0
```

池外两行都不落笔：`168` 是空注释行，`:284` 是 `AvatarCluster` 的 JSDoc 单行块。改完 `169–173` 与 `285–289`
之后，`168` 随所在段落合并转强（自清），`:284` 仍弱（保持池外，不扣配额）。

## 2. 配额扣减与四态断言

```text
PLAN#1	5 文件 / 100 行	writable=100 upstream=0 self-clearing=0 pool-out=2 pending=0
quota=100(writable 100 − self-clearing 0) 四态和=102=weak合计 102 池内weak=100/池内实测 100
```

批后复算（`--batch b269`）：

```text
BATCHCHK b269 pre=b268-repo-post.txt weak=b269-repo-post.txt  OK
SELF-CLEAR n=1	可写桶 0 / 池外 1 / 上游桶 0 / 未解析 0	（只有可写桶进配额扣减）
  packages/ui/src/app-shell/WorkflowRunSpineParts.tsx:168	aac47556	out-of-pool
```

这条落「池外桶」，配额仍是 `100 − 0 = 100`。**全仓 weak 减 101、落笔 100、文件数只减 4**：

```text
b268-repo-post  WEAK lines=9319 files=2013  filler=4127
b269-repo-post  WEAK lines=9218 files=2009  filler=4027      差 −101 / −4 / −100
```

文件数 −4 而不是 −5，是因为 `WorkflowRunSpineParts.tsx` 还留着池外的 `:284`；这正是「池外行不扣配额、
但仍占 weak 计数」的可观测形态。

## 3. 计时

本批未起秒表，分段为**文件时间戳推算**（标「估」）；只有全批可由提交时间戳复算。

| 段 | 起止 | 实测 | 说明 |
| --- | --- | ---: | --- |
| 规划 + 选行 | 02:15:28 → 02:15:50（估） | 约 22 s | `--batch b268` 四态复算 + PLAN#1 逐行核对池内外 |
| 落笔 | 02:15:50 → 02:18:00（估） | 约 130 s | 读 5 文件、20 处改写；`precheck-assert --record` 首轮 2 W、改后 0 |
| 预检与门禁 | 02:18:00 → 02:19:24 | 84 s | `--record`（02:18:30）、`--verify`、七行门禁、提交 |
| 后测 | 02:19:24 → 02:21:15 | 111 s | 建 2 个干净 worktree、全仓 + 15 文件 cohort |
| 收口 | 02:21:15 起 | 约 60 s | `ledger-assert`、`capacity-estimate`、落 tsv |

两列口径：

| 列 | 值 | 说明 |
| --- | ---: | --- |
| **落笔段 `s/行`** | **1.30（估）** | 不进主档；主档仍用 B 段 n=2 的 1.58 |
| 全批 `s/行` | 2.36（236 ÷ 100，可复算） | 只作历史记录，**不可用于排期** |

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

| 批 | 行数 | 落笔段 `s/行` | 预检首轮命中 | 门禁首轮命中 | 门禁轮数 | 中断 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| b267 | 100 | 1.57 | （手工预检，未留数） | 1（1W） | 2 | 无 |
| b268 | 100 | 1.58 | （手工预检，未留数） | 1（1L） | 2 | 无 |
| **b269** | 100 | **1.30（估）** | **2（2W）** | **0** | **1** | 无 |

- 主档不改：**1.58 s/行（n=2，有秒表的样本）**。b269 的 1.30 是推算值，只作旁证，不进拟合。
- b269 第一次把「命中」发生在**预检**而不是门禁：`judgeEntries` 拦下 2 处 W
  （`shared.tsx:174`「不做本地化，数字直接交给模板字符串。」、`WorkflowRunSpineParts.tsx:287`
  「超出部分折叠成 +N 计数。」），补标识符后 0 命中。门禁因此一轮过。
- 两段仍不可直接比较；B 段 n=3 但只有 2 个可复算样本，**疑似工艺切换仍不足以确认**。

### 3.2 排期：主档 1.58（n=2）+ 保守档 3.9–4.0

```text
剩余 5,925 行（capacity-estimate REMAIN）
主档    1.58 s/行（B 段 n=2，疑似工艺切换，未确认） →  9,362 s ≈ 2.6 h
主档上沿 1.9 s/行（跨到 A 段最快值）                → 11,258 s ≈ 3.1 h
保守档  3.9 – 4.0 s/行（A 段 b266 那种，无预检）     → 23,108 – 23,700 s ≈ 6.4 – 6.6 h
合计区间 2.6 – 6.6 h
中位数  5,925 × 2.17 = 12,857 s ≈ 3.6 h            （只作交叉验证）
批数    5,925 ÷ 100 = 59.25 批（满批 59 + 零星 25 行）；REMAIN 的 447 是文件档位对照，不作排期
```

与 b268 的 2.6–6.7 h 相比，区间下沿不变、上沿收 0.1 h，纯粹来自剩余行数 6,025 → 5,925，不是估值调整。

## 4. 度量前后（同批 5 文件，干净 worktree）

| 指标 | 改前 | 改后 | 变化 |
| --- | ---: | ---: | --- |
| weak 行 | **102** / 582 units | **1** / 582 | −101（100 配额 + 1 池外自清） |
| `substance%` | 59.2 | **86.1** | +26.9 |
| `explain%` | 83.0 | **99.7** | +16.7 |
| `filler%` | 34.0 | **0.0** | −34.0 |
| `uncovered` | 未重测 | 未重测 | 预期不变，非进度指标（b265 §3.1） |

残留的 1 行 weak 是池外的 `WorkflowRunSpineParts.tsx:284`（JSDoc 单行块，`无信息列举,无解释`），
按四态口径不属于本线的可写集合。

全仓同域（`packages,apps,docs/knip`）：`WEAK lines=9319 files=2013` → **`9218 / 2009`**；
`filler 4127 → 4027`（−100，等于落笔行数）。

## 5. 七行门禁（`zc-commit.mjs` v12，`--rewrite-annot --base HEAD`）

**首轮即通过**（预检把 2 处 W 提前打掉）：

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

`precheck-assert` 两阶段输出：

```text
PRECHECK RECORD n=100 hits=0 sha=b0a8ec9ee636 -> b269-precheck.json     （首轮 n=100 hits=2，改后重录）
PRECHECK VERIFY n=100 hits=0 sha=b0a8ec9ee636  OK
```

首轮 2 处命中原文：

```text
packages/ui/src/BotsDialog/shared.tsx:174                    W  单行无信息
  不做本地化，数字直接交给模板字符串。                       → 不走 intl 本地化，数字直接拼进返回值模板。
packages/ui/src/app-shell/WorkflowRunSpineParts.tsx:287      W  单行无信息
  超出部分折叠成 +N 计数。                                   → 超出 CLUSTER_MAX 的部分折叠成 +N 计数。
```

两条都是「整句没有可检索标识符」，与 b268 的 L（ASCII 逗号计入分隔符）不同类。这说明 b268 立的
「预检=对最终正文的断言」确实在起作用：命中前移到预检，门禁看到的正文就是预检过的正文。

### 5.1 预检 sha 的负控（b270 开工前补齐）

`--record` 落 sha、`--verify` 比对同一 sha，机制本身要能被证明「真会拦」，所以补三条负控
（同一 worktree，`record n=1 hits=0 sha=31aead13e216`）：

| 负控 | 改动 | 期望 | 实测 |
| --- | --- | --- | --- |
| ① 改一个字符 | 「向上取整」→「向下取整」 | `exit 7` | `DRIFT #0` + `PRECHECK VERIFY FAIL` + `exit 7` |
| ② 只改空白 | 「1000 后」→「1000 后␣␣」 | `exit 7` | `DRIFT #0`（用 `JSON.stringify` 展示原文）+ `exit 7` |
| ③ 只改换行 | 一行拆成两行 | `exit 7` | `DRIFT #0/#1`，`record 1 行 / now 2 行` + `exit 7` |
| ④ 回滚原文 | 恢复记录时的正文 | `exit 0` | `PRECHECK VERIFY n=1 hits=0 sha=31aead13e216` |

② 证明是**字节级比较**，不是语义归一：`strip()` 只用于判据分析，比对用的是保留行内/行尾空白的原始文本。
③ 证明拆行/并行走「条目数」，与空白改动同一出口。

**sha 覆盖范围**：只覆盖**正文字节**——每个新增注释行的原始文本（去掉前导 `+`，保留行内与行尾空白）
按行序拼接后取 sha256，**不含文件路径、行号与时间戳**；逐条比对仍含 file / line。
已知边界：CRLF/LF 切换在 `git diff` 切行时归一为 `\r?\n`，换行符类型本身不进 sha。

口径断点：b269 落笔时用的是 `db7189f9b562`（sha 含 file/line/content，`b0a8ec9ee636`），
负控与 b270 起用 `8b3abe2bf6dc`（sha 只覆盖正文）。两代 sha 不可互比，台账各记各的。

登记表：`ZC-deep-b269-rewrite.tsv`（100 行）。

## 6. `uncovered` 与本批的收口边界

按 b265 §3.1 的定性，`uncovered` 是「当批文件集内、上方无任何整行注释的代码单元数」，
PLAN#2 只做 1→1 改写、不新增注释行，因此它在每批**构造性不变**，本批不花额外测量复证。
它不参与任何进度判断：本批「102 → 1」是 weak，不是 uncovered。

边界同 b265 §3.5：池内清零 **不等于** ZCode 全仓注释完成。禁止用「池清零」暗示全仓做完。

## 7. 趋势：归户错 / 文本错

| 批 | 归户错 | 文本错 | 明细 |
| --- | ---: | ---: | --- |
| b261 | 0 | 4 | 4 L |
| b262 | 0 | 3 | 3 W |
| b263 | 0 | 11 | 10 L + 1 W |
| b264 | 4 | 1 | 4 条删上游注释（选行判据缺陷） |
| b265 | 0 | 4 | 3 L + 1 W |
| b266 | 0 | 3 | 2 L + 1 W，二轮再出 1 L |
| b267 | 0 | 1 | 1 W |
| b268 | 0 | 1 | 1 L（`clipboard-image.ts:266`，ASCII 逗号计入分隔符） |
| **b269** | **0** | **0** | 门禁 0；预检拦下 2 W（`shared.tsx:174`、`WorkflowRunSpineParts.tsx:287`） |

## 8. 守卫 / 断言 / 产能 / 提交

### 8.1 `weak-guard`（15 文件 cohort，与本批 5 文件无交集）

```text
WEAK 15文件  pre=4  post=4  新增=0  max=8  key=file+正文
GUARD PASS
```

pre 取 `b268-guard-post.txt`，post 取 `22cb4efe` 干净 worktree。

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

b269 属 PLAN#2，不计入 802 解包批的收尾等式。

### 8.3 产能与池等式

```text
REMAIN	891	5925	-	447
ACCT files  done 116 + remain 891 = 1007  OK
ACCT lines  done 1496 + remain 5925 = 7421  OK
ALIGNED acct_remain=5925 pool_remain=5925 diff=0  OK
ASSERT PASS
```

`done 1,396 → 1,496`、`remain 6,025 → 5,925`，两侧各 −100；`7,421` 的域仍是
`packages` / `apps` / `docs/knip` 三根 baseline weak 并集（1,007 文件），域变则不可比。

下一批 PLAN#1（b270）：`WorkflowTimelineStation.tsx`、`feedbackUserView.ts`、`usePptxFileWatch.ts`、
`useRemoteConnectionLogs.ts`、`useSettingService.ts`，5 文件 / 100 行。

### 8.4 提交

| 提交 | 内容 |
| --- | --- |
| `22cb4efe` | 代码（注释）`+100/−100`，5 文件，`expected=5 staged=5` |
| 本台账提交 | `ZC-deep-b269.md`、`ZC-deep-b269-rewrite.tsv` |

15 个外部会话脏文件全程未进入任何提交路径。

## 9. 收口三断言（指针）

仍是 `ZC-deep-b265.md` §9 的 A1/A2/A3：`remain == 0`、`done + remain == 7,421` 恒等、`ledger-assert PASS`，
三条同时成立才算收口。本批只推进 `remain`：6,025 → **5,925**，A1 未达成。
