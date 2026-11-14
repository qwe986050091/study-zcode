# ZC-deep-b272：注释清水 100 行（6 文件）

> 批次：b272 ｜ 提交 `fd6dfa8f` ｜ 代码 `+100/−100` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v12（`a35b42fa2e4c`）、
> `capacity-estimate.mjs`（`77c4cc2391e7`）、`weak-guard.mjs`（`a3600ccfacab`）、
> `ledger-assert.mjs`（`35afeb266f97`）、`precheck-assert.mjs`（`171b50eafc19`，计时首用）。

## 0. 交代

1. 本批 6 文件 / 100 行，全部池内可写：`ownIn=100 / upstream=0 / self-clearing=0 / pool-out=4 / quota=100`。
2. 6 文件：`TaskList.tsx`(20)、`bash-readonly-policy-simple-commands.ts`(19)、
   `app-mode-suggestion-panel.tsx`(19)、`database-startup.ts`(19)、`backup.ts`(19)、
   `CapabilityMapFlowElements.tsx`(4)。
3. 预检跑 **3 轮**（`record_runs=3`）：首轮 3 处 W、次轮 1 处 L（同一行 217 的 W→L 互补），
   末轮 `record n=100 hits=0 sha=adde3ac877bd`，`--verify` 同 sha。
4. 七行门禁全 0，`expected=6 staged=6`，`+100/−100`。
5. 本批**无配额内自清**（`SELF-CLEAR n=1`，全在池外桶，扣减 0）。

## 1. 三列计划表（沿用 b265 §2）

| 文件 | 可写 | 上游 | 池外 | 小计 |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/TaskList.tsx` | 20 | 0 | 1 | 20 |
| `apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-simple-commands.ts` | 19 | 0 | 1 | 19 |
| `apps/zcode-cli/packages/tui/src/app-mode-suggestion-panel.tsx` | 19 | 0 | 1 | 19 |
| `packages/shared/src/database-startup.ts` | 19 | 0 | 0 | 19 |
| `packages/shared/src/sqlite-migrations/backup.ts` | 19 | 0 | 1 | 19 |
| `apps/dev-docs/src/capability-map/CapabilityMapFlowElements.tsx` | 4 | 0 | 0 | 4 |
| **合计** | **100** | **0** | **4** | **100** |

- 「小计」= 本批改写行数（登记表 100 行）；「池外」列是同一批文件里**不参与改写**的 weak 行，
  四态摘要与配额都按可写列计算，池外列不进配额。

## 2. 配额扣减与四态断言

```text
PLAN#1	6 文件 / 100 行	writable=100 upstream=0 self-clearing=0 pool-out=4 pending=0
quota=100(writable 100 − self-clearing 0) 四态和=104=weak合计 104 池内weak=100/池内实测 100
SELF-CLEAR n=1	可写桶 0 / 池外 1 / 上游桶 0 / 未解析 0
  apps/zcode-cli/.../bash-readonly-policy-simple-commands.ts:103	54f51bad	out-of-pool
```

- 批前这 6 文件共 104 行 weak：100 行可写 + 4 行池外（`own/out` 2 + `up/out` 2）。
- 批后剩 3 行 weak（全部是未触碰的池外行）：

  | 位置 | 归属 | 正文 |
  | --- | --- | --- |
  | `app-mode-suggestion-panel.tsx:149` | own / pool-out | 副作用：无，纯函数，不修改入参。 |
  | `backup.ts:48` | upstream | 新库没有待保护的历史表；不为每个内存测试或首次安装制造空备份。 |
  | `TaskList.tsx:227` | upstream | 这里改成“首次点击进入待确认态，二次点击原位确认”，既保留保护，也不离开当前上下文。 |

- 消失的 101 行 = **100 行 1→1 改写**（`ZC-deep-b272-rewrite.tsv` 逐行可对）+ **1 行池外自清**。
  这 1 行是 `bash-readonly…:103`：改前它是「短句堆叠」run 的一行，邻行 104–109 写长后被带强，
  本身没落笔，也不在登记表里。它属于池外桶，**不扣配额**，所以「配额 100 / 实清 100」仍然自洽。
- 四态和 = 104 = 批前 weak 合计；池内三桶 = 100 = 池内实测，断言成立。

## 3. 计时（工具落戳，b272 首用）

### 3.1 两列：落笔段与门禁段

```text
t-record   2026-11-11 02:50:06.977 +08:00  sha=adde3ac877bd  record_runs=3
t-verify   2026-11-11 02:50:10.503 +08:00  sha=adde3ac877bd  record_runs=3
落笔段      3.5 s（t-verify − t-record）
门禁段      92.5 s（t-verify → 提交 fd6dfa8f 02:51:43）
```

- 两枚戳都由 `precheck-assert.mjs` 写，人不参与；`--verify` 会拒绝「t-record 晚于当前时刻」「sha 不符」
  「t-record 缺失」「t-verify 早于 t-record」四种情况，负控见 `_tools/INDEX.md` §2.5。
- **口径必读**：`--record` 只能在正文写完之后跑（它要对 `git diff` 的新增注释行跑判据），
  所以工具口径的「落笔段」实际覆盖的是「最后一次预检 → verify 通过」，**不含 100 行改写本身**。
  改写耗时本批没有起笔戳，不能从 3.5 s 推出来；要拿工具量全段，需要再加一枚 `--start`（本批未做）。
- 返修成本用 `record_runs=3` 显性化：首轮 3 处 W、次轮 1 处 L、三跑才过；`--record` 每跑一次自增，
  失败尝试也计数（不是只数成功）。重跑会作废旧 `t-verify`，落笔段只记「最后一次 record → verify」。

### 3.2 排期：旧口径整列降级（b273 决定）

`1.58` 与 b261–b272 的 `s/行` 一律标「旧口径（手工打点 / 口径不一）」，**不参与**新口径的任何中位数与区间；
新口径从 b273 起用 `batch_wall / 落笔段 / tail` 三量重建（`_tools/INDEX.md` §2.5、`ZC-deep-b265.md` §5.1）。
本批的 3.5 s 只作历史记录，不作排期输入。

### 3.3 n 的现状：旧样本 n=4 全部降级，工具样本 n=1 且不同段

- 旧口径 4 个样本（b267 `1.57`、b268 `1.58`、b270 `1.62`、b271 `1.01`）全部是手写打点，整列降级；
  b271 的 `1.01` 还混着 6 处返修，**不作为工艺样本**。
- 本批是工具打点第 1 个样本，但 3.5 s 只覆盖「预检 → verify」，与旧口径（含改写）**不同段**，
  因此不能把 3.5 s 和 1.5x s 放进同一个中位数；b273 起用 `--start` 补齐「起笔 → verify」的落笔段。
- 到 n=5 时按用户口径分开给：①落笔段中位数 ②`record_runs` 分布 ③返修次数与耗时关系。
  现在能给的只有 ②的 1 个点：`record_runs=3`（首轮 3 W / 次轮 1 L / 三跑过）。
- 新口径不设主档；若后续同段样本仍离群，先查打点与返修两个未识别变量。

## 4. 度量前后（同批 6 文件，干净 worktree）

| 文件 | weak 前→后 | comments | substance 前→后 | explain 前→后 |
| --- | ---: | ---: | ---: | ---: |
| `CapabilityMapFlowElements.tsx` | 4 → 0 | 69 | 84.1 → 89.9 | 94.2 → 100.0 |
| `bash-readonly-policy-simple-commands.ts` | 20 → 0 | 69 | 71.0 → 91.3 | 92.8 → 100.0 |
| `app-mode-suggestion-panel.tsx` | 20 → 1 | 67 | 68.7 → 89.6 | 79.1 → 98.5 |
| `database-startup.ts` | 19 → 0 | 52 | 75.0 → 94.2 | 86.5 → 100.0 |
| `backup.ts` | 20 → 1 | 45 | 62.2 → 88.9 | 86.7 → 97.8 |
| `TaskList.tsx` | 21 → 1 | 116 | 71.6 → 83.6 | 94.0 → 99.1 |
| **合计** | **104 → 3** | **418** | **72.5 → 88.8** | **89.7 → 99.3** |

`filler` 94 → 0（逐文件 0/20/19/19/18/18 → 全 0），与全仓 `filler 3831 → 3737`（−94）一致。

全仓同域（`packages,apps,docs/knip`）：`WEAK lines=9014 files=2000` → **`8913 / 1997`**；
减少的 101 行 = 100 行改写 + 1 行池外自清；减少的 3 个文件 = 本批把 weak 清零的
`CapabilityMapFlowElements` / `bash-readonly-policy-simple-commands` / `database-startup`。

> **BOM 口径修正（本批实测）**：PowerShell 5.1 的 `>` 会给重定向文件加 UTF-8 BOM，
> `capacity-estimate` 与 `weak-guard` 按 `^WEAK\t` 解析，BOM 会让**首行 weak 不可见**。
> 本批首跑因此把 `App.tsx:295` 误报成自清；剥掉 BOM 后重跑，`SELF-CLEAR` 由 `n=2` 回到 `n=1`。
> 后续快照用 `cmd /c "node … > file"` 生成，或落盘后剥 BOM，再进断言。

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
```

### 5.1 预检 3 轮、4 处明细

| 轮 | 位置 | 判据 | 原因 | 修法 |
| ---: | --- | --- | --- | --- |
| 1 | `CapabilityMapFlowElements.tsx:217` | W | `M`/`Q`/`L` 单字母不算标识符 | 补 `SVG path` |
| 1 | `backup.ts:37` | W | 无 ASCII 标识符 | 补 `metadata` |
| 1 | `backup.ts:162` | W | 无 ASCII 标识符 | 补 `pruneBackups` |
| 2 | `CapabilityMapFlowElements.tsx:217` | L | 3 个逗号且无谓词 | 改「先…再…最后…」带谓词 |

第 1 轮修完 W 后，同一行 217 立刻掉进 L——正是 `_tools/INDEX.md` §2.3 记的
「W 与 L 互补，改一边掉到另一边」。本批把它计成 2 次返修、`record_runs=3`，不再靠人工回忆。

登记表：`ZC-deep-b272-rewrite.tsv`（100 行）。

## 6. `uncovered` 与本批的收口边界

同 b269 §6：1→1 改写不改 uncovered 的构造，「104 → 3」是 weak，不是 uncovered。
池内清零不等于全仓完成，禁止用池清零暗示收口。

## 7. 趋势：归户错 / 文本错

| 批 | 归户错 | 文本错 | 明细 |
| --- | ---: | ---: | --- |
| b267 | 0 | 1 | 1 W |
| b268 | 0 | 1 | 1 L |
| b269 | 0 | 0 | 门禁 0；预检拦 2 W |
| b270 | 0 | 0 | 门禁 0；预检拦 11（2 L + 9 W） |
| b271 | 0 | 0 | 门禁 0；预检拦 6（2 L + 4 W） |
| **b272** | **0** | **0** | 门禁 0；预检 4（1 L + 3 W，跨 3 轮） |

## 8. 守卫 / 断言 / 产能 / 提交

### 8.1 `weak-guard`（15 文件 cohort，与本批 6 文件无交集）

```text
WEAK 15文件  pre=4  post=4  新增=0  max=8  key=file+正文
GUARD PASS
```

### 8.2 `ledger-assert`

```text
BATCH ZC-deep-b248..b260-rewrite.tsv（12 批）
IGNORED b261–b272（非 802 批次，各 100 行不计入）
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
BATCHCHK b272 pre=b271-repo-post.txt weak=b272-repo-post.txt  OK
done files=132 lines=1796（行口径：Σ 基线 weak − 现 weak）
REMAIN	875	5625	-	438
SELF-CLEAR n=1	可写桶 0 / 池外 1 / 上游桶 0 / 未解析 0
PARTIAL	packages/ui/src/ToolCallBlocks/renderers/cuaDetails.tsx	基线 23 → 现 1
ACCT files  done 132 + remain 875 = 1007  OK
ACCT lines  done 1796 + remain 5625 = 7421  OK
ALIGNED acct_remain=5625 pool_remain=5625 diff=0  OK
ASSERT PASS
```

落笔后池数：**875 文件 / 5,625 行**（b271 后为 881 / 5,725；本批 −6 文件、−100 行）。

- 三个批数口径照 `ZC-deep-b271.md` §8.3 区分，不得并排引用：
  `147`（排期口径 `≤6 文件且 ≤100 行/批`）/ `58`（纯行上界 `5,725÷100`）/ `442`（文件装箱对照上界）。
  本批工具打印的 `438` 是同一「文件分档装箱」口径的对照上界，**不是排期依据**。

### 8.4 提交

| 提交 | 内容 |
| --- | --- |
| `fd6dfa8f` | 代码（注释）`+100/−100`，6 文件，`expected=6 staged=6` |
| `ae64e1ca` | 本台账与 `ZC-deep-b272-rewrite.tsv`（100 行登记） |

## 9. 收口三断言（指针）

仍按 `ZC-deep-b265.md` §9 的 A1/A2/A3：`remain == 0`、`done + remain == 7,421`、`ledger-assert PASS`。
本批只推进 `remain`：5,725 → **5,625**，A1 未达成。
