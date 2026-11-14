# ZC-deep-b271：注释清水 100 行（5 文件）

> 批次：b271 ｜ 提交 `af3afcd0` ｜ 代码 `+100/−100` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v12（`a35b42fa2e4c`）、
> `capacity-estimate.mjs`（`77c4cc2391e7`）、`weak-guard.mjs`（`a3600ccfacab`）、
> `ledger-assert.mjs`（`35afeb266f97`）、`precheck-assert.mjs`（`8b3abe2bf6dc`，sha 只覆盖正文）。

## 0. 交代

1. 本批 5 文件 / 100 行，全部池内、全部本线行：`ownIn=100 / ownOut=0 / quota=100`。
2. 5 文件：`RemoteConnectionProgressSection.tsx`(20)、`RemoteConversationDisconnected.tsx`(20)、
   `StorageDiskCard.tsx`(20)、`SourceServerMigrationReportPanel.tsx`(20)、`mcpStoreHelpers.ts`(20)。
3. 预检首轮拦 **6** 处（4 W + 2 L），返修后 `record n=100 hits=0 sha=c27f2348e5eb`，`--verify` 同 sha。
4. 七行门禁全 0，`expected=5 staged=5`，`+100/−100`。
5. 本批 **无自清行**（`SELF-CLEAR n=0`）：池内 weak 100 → 0，完成数 100 = 改写数 100，无差额可归因。

## 1. 三列计划表（沿用 b265 §2）

| 文件 | 可写 | 上游 | 池外 | 小计 |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/project-sidebar/RemoteConnectionProgressSection.tsx` | 20 | 0 | 0 | 20 |
| `packages/ui/src/project-sidebar/RemoteConversationDisconnected.tsx` | 20 | 0 | 0 | 20 |
| `packages/ui/src/resource-manager/storage/StorageDiskCard.tsx` | 20 | 0 | 0 | 20 |
| `packages/ui/src/settings/SourceServerMigrationReportPanel.tsx` | 20 | 0 | 0 | 20 |
| `packages/ui/src/store/mcpStoreHelpers.ts` | 20 | 0 | 0 | 20 |
| **合计** | **100** | **0** | **0** | **100** |

## 2. 配额扣减与四态断言

```text
PLAN#1	5 文件 / 100 行	writable=100 upstream=0 self-clearing=0 pool-out=0 pending=0
quota=100(writable 100 − self-clearing 0) 四态和=100=weak合计 100 池内weak=100/池内实测 100
SELF-CLEAR n=0	可写桶 0 / 池外 0 / 上游桶 0 / 未解析 0
```

- 批前（`b270-repo-post.txt`）这 5 文件池内 weak 恰为 100，无池外行、无上游行，故配额 = 100。
- 批后（`b271-repo-post.txt`）这 5 文件 weak 归零，消失的 100 行**全部是本批 1→1 改写的 100 行**
  （`ZC-deep-b271-rewrite.tsv` 逐行可对）；没有「行还在、只是不判 weak」的差额，也没有删除行。
- 四态和 = 100 = 批前 weak 合计，断言成立。

## 3. 计时

### 3.1 落笔段与门禁成本

```text
起笔 b271-t-start.txt        2026-11-11 02:36:17   （手写，已停用）
收笔 b271-t-write-end.txt    2026-11-11 02:37:58   （手写，已停用）
落笔段（含 6 处预检返修）      101 s / 100 行 = 1.01 s/行
门禁段（末次改写 → 提交）      39 s（02:37:58 → 02:38:37）
```

- **本批计时不可与 b272 起的新口径直接比较**：b271 仍靠手写打点，首枚收笔写成 `02:37:21`，
  早于最后一次返修（`mcpStoreHelpers.ts` mtime `02:37:58`），说明人工打点会早退。
- 按 b270 的定义（改写与返修全部写定后收笔）改用 `02:37:58`，所以 `1.01` 里**混着 6 处预检返修**；
  返修次数没有单独计数，这正是新口径要解决的问题。
- b272 起：`--record` / `--verify` 各自落 `t-record` / `t-verify`，落笔段 = `t-verify − t-record`，
  返修用 `record_runs` 显性化（尺子见 `_tools/INDEX.md` §2.5）。本节两项保留为**历史值**。

### 3.2 排期：主档 1.58 已降级为**旧口径历史值**（b273 起停用）

`1.58` 与 b261–b272 的整列 `s/行` 一并标「旧口径（手工打点 / 口径不一）」，**不参与**新口径的任何中位数与区间；
新口径从 b273 起用 `batch_wall / 落笔段 / tail` 三量重建（定义见 `_tools/INDEX.md` §2.5 与 `ZC-deep-b265.md` §5.1）。
旧值只作量级交叉验证，不再作排期依据。

### 3.3 主档政策：旧口径整列降级，n=5 改为新口径重建

- b273 决定：b261–b272 的 `s/行` 保留在表里，但整列降级为旧口径；`1.58` 也不再是主档，**不可与新口径混合**。
- 旧样本（b267 `1.57`、b268 `1.58`、b270 `1.62`、b271 `1.01`）全部是手写打点，口径不一；
  b271 的 `1.01` 还混着返修，只登记为「打点+返修混合」的历史值。
- 新口径从 b273 起建三量，当前样本 **n=0**；攒到 n=5 时分开给：
  1. **`batch_wall / 100` 中位数**（git 两端，整批墙钟）；
  2. **落笔段中位数**（`t-start → t-verify`）与 **`tail` 中位数**（`t-record → t-verify`）；
  3. **`record_runs` 分布与返修耗时**（每多一次 record 平均多几秒、修的是 W 还是 L）。
- 主档判定：新口径 n=5 前不设主档；若离群仍出现，先查打点与返修这两个未识别变量。
- 保守档 `3.9–4.0` 是旧口径值，只作上界参考，不作为新口径区间。

## 4. 度量前后（同批 5 文件，干净 worktree）

| 指标 | 改前 | 改后 | 变化 |
| --- | ---: | ---: | --- |
| weak 行 | **100** / 230 comments | **0** / 230 | −100（= 配额，0 自清） |
| `substance%` | 63.5 | **93.5** | +30.0 |
| `explain%` | 82.2 | **100.0** | +17.8 |
| `filler%` | 43.0 | **0.0** | −43.0 |
| `uncovered` | 未重测 | 未重测 | 1→1 改写构造性不变（b265 §3.1） |

5 文件批后无残留 weak（`RATIOS weak=0/230`）。

全仓同域（`packages,apps,docs/knip`）：`WEAK lines=9114 files=2005` → **`9014 / 2000`**；
`filler 3930 → 3831`（−99，与 100 行改写中 99 行原判 filler 一致）。

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
expected=5  staged=5
```

### 5.1 预检首轮 6 处明细

| # | 位置 | 判据 | 原因 | 修法 |
| ---: | --- | --- | --- | --- |
| 1 | `StorageDiskCard.tsx:36` | W | 无 ASCII 标识符 | 补 `StorageDiskCard` |
| 2 | `StorageDiskCard.tsx:57` | W | 「格式化」不算锚点 | 补 `intl.formatMessage` |
| 3 | `SourceServerMigrationReportPanel.tsx:36` | L | 两个中文逗号 ≥2 | 改分号分隔三段 |
| 4 | `SourceServerMigrationReportPanel.tsx:121` | W | `px-4` 的数字不计锚点 | 补 `div` |
| 5 | `mcpStoreHelpers.ts:127` | W | 「纯函数」不算锚点 | 补 `makeServerId` |
| 6 | `mcpStoreHelpers.ts:137` | L | 两个顿号 ≥2 | 改 `→` 连接 |

第 3、6 条与 b270 §5 同因：**分隔符判据不区分「列举」与「代码片段」，括号参数与中文顿号都计数**。
预检把这类命中前移到落笔之后、门禁之前，本批门禁因此零命中。

登记表：`ZC-deep-b271-rewrite.tsv`（100 行）。

## 6. `uncovered` 与本批的收口边界

同 b269 §6：1→1 改写不改 uncovered 的构造，「100 → 0」是 weak，不是 uncovered。
池内清零不等于全仓完成，禁止用池清零暗示收口。

## 7. 趋势：归户错 / 文本错

| 批 | 归户错 | 文本错 | 明细 |
| --- | ---: | ---: | --- |
| b261–b266 | 4 | 26 | 见 b266 台账 |
| b267 | 0 | 1 | 1 W |
| b268 | 0 | 1 | 1 L |
| b269 | 0 | 0 | 门禁 0；预检拦 2 W |
| b270 | 0 | 0 | 门禁 0；预检拦 11（2 L + 9 W） |
| **b271** | **0** | **0** | 门禁 0；预检拦 **6**（2 L + 4 W） |

## 8. 守卫 / 断言 / 产能 / 提交

### 8.1 `weak-guard`（15 文件 cohort，与本批 5 文件无交集）

```text
WEAK 15文件  pre=4  post=4  新增=0  max=8  key=file+正文
GUARD PASS
```

### 8.2 `ledger-assert`

```text
BATCH ZC-deep-b248..b260-rewrite.tsv（12 批）
IGNORED b261–b271（非 802 批次，各 100 行不计入）
SUM 各批 = 802  OK
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
BATCHCHK b271 pre=b270-repo-post.txt weak=b271-repo-post.txt  OK
done files=126 lines=1696	perBatch=2
REMAIN	881	5725	-	442
SELF-CLEAR n=0
ACCT files  done 126 + remain 881 = 1007  OK
ACCT lines  done 1696 + remain 5725 = 7421  OK
ALIGNED acct_remain=5725 pool_remain=5725 diff=0  OK
ASSERT PASS
```

下一批在 b272 落笔前的四态摘要里由 `capacity-estimate.mjs` 决定，本台账不预写文件名。

- **`442` 的口径（不是笔误）**：`442 = Σ ceil(档位文件数 ÷ 每批 2 文件)`，是按**文件**装箱、每档每批最多
  2 个文件的对照上界；工具明示「不作为排期依据」。
- **排期口径是第三个数**：`PLAN 147 批`，口径 `≤6 文件且 ≤100 行/批`（均值 6.0 文件 / 38.9 行）。
- **纯行上界**：`5,725 ÷ 100 ≈ 58 批`，只在「每批都塞满 100 行」时成立，实际因 6 文件上限做不到。
- 三个数并列时必须带口径：`147`（排期）/ `58`（纯行上界）/ `442`（文件装箱对照上界）。

### 8.4 提交

| 提交 | 内容 |
| --- | --- |
| `af3afcd0` | 代码（注释）`+100/−100`，5 文件，`expected=5 staged=5` |
| `17c9f04e` | 台账 b270 自清归因修订（本批前置） |
| 本台账提交 | `ZC-deep-b271.md`、`ZC-deep-b271-rewrite.tsv` |

## 9. 收口三断言（指针）

仍按 `ZC-deep-b265.md` §9 的 A1/A2/A3：`remain == 0`、`done + remain == 7,421`、`ledger-assert PASS`。
本批只推进 `remain`：5,825 → **5,725**，A1 未达成。
