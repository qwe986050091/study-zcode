# ZC-deep-b281：注释清水 100 行（6 文件）· mtime 检测与白名单新鲜度上线 · 新口径样本 n=9

> 批次：b281 ｜ 提交 `daa89fa2` ｜ 代码 `+100/−100` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v13（`f02be471a849`）、
> `capacity-estimate.mjs`（`3ff652131ef9`）、`weak-guard.mjs`（`a3600ccfacab`）、
> `ledger-assert.mjs`（`35afeb266f97`）、`precheck-assert.mjs`（`0a8e381ce08a`）。

## 0. 交代

1. 起笔前 `--start` 在干净树上通过（`ts=2026-11-10T20:47:36.246Z`），未触发 `exit 6`；
   同时落 mtime 快照 **20,068 个跟踪文件**（全量，不按 `--scope` 缩范围）。
2. 本批 6 文件 / 100 行：`writable=100 / upstream=0 / self-clearing=0 / pool-out=0 / pending=0`。
   5 个文件各 17 行、`featureSuggestedPromptRotation.ts` 15 行（该文件 124-125 不在 plan，留 b282）。
3. 100 行不是「凑满 100」：池内单文件可写上限 17，`17×5 + 15 = 100`，正好卡在 ≤6 文件 / ≤100 行上限。
4. 流程：`--start` → 改写 → `--scope`（`out_of_scope_edits=0`）→ `--record`
   （首轮 6 命中：5 L + 1 W，返修）→ `--record`（`hits=0`）→ `--verify` → `zc-commit v13`（`ORDER GATE PASS`）→ `--order`。
5. 七行门禁：`expected=6 staged=6`，`+100/−100`，`GATE self=… blob=f02be471a849`。
6. 批后 6 个文件中 5 个清零，`featureSuggestedPromptRotation.ts` 17 → 2（124-125 顺延）；
   全仓 `WEAK lines=8017 files=1952`（b280 后 8,117 / 1,957）。

## 1. 三列计划表（沿用 b265 §2）

```text
PLAN#1	6 文件 / 100 行	writable=100 upstream=0 self-clearing=0 pool-out=0 pending=0
quota=100(writable 100 − self-clearing 0)，本批取满 100（正好触及 ≤100 行上限）
四态和=100=weak合计 池内weak=100/池内实测 100
```

| 文件 | 可写 | 上游 | 池外 | 小计 | 本批 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `packages/ui/src/components/workflow-timeline/workflow-face-motion.ts` | 17 | 0 | 0 | 17 | 17 |
| `packages/ui/src/embeddedBrowserHelpers.ts` | 17 | 0 | 0 | 17 | 17 |
| `packages/ui/src/feedback/feedbackTimelineSummary.ts` | 17 | 0 | 0 | 17 | 17 |
| `packages/ui/src/lib/mermaidRenderBudget.ts` | 17 | 0 | 0 | 17 | 17 |
| `packages/ui/src/lib/officeFilePreview.ts` | 17 | 0 | 0 | 17 | 17 |
| `packages/ui/src/v4/featureSuggestedPromptRotation.ts` | 17 | 0 | 0 | 17 | **15** |
| **合计** | **102** | **0** | **0** | **102** | **100** |

- 6 个文件的 weak 行全部 `blame=a8784b7e479d3a`，且都在 `git diff -U0 8f7daaf0 HEAD` 的 `+` 行集合内。
- `featureSuggestedPromptRotation.ts` 15 行之外的 2 行（124-125）属同文件同批可写，但本批已满 100 行上限，
  按既有规则**顺延到 b282**，不拆第 7 个文件去凑数。

## 2. 配额扣减与批后池

```text
SELF-CLEAR n=100	可写桶 100 / 池外 0 / 上游桶 0 / 未解析 0	（只有可写桶进配额扣减）
```

- 100 行全部登记在 `ZC-deep-b281-rewrite.tsv`，`SELF-CLEAR` 把 100 行全部判成 `writable`，
  说明白名单已含 `daa89fa2`（本批先提交、后 `own-commits-gen`、再跑产能，顺序不再靠人记，见 §7.2）。
- 批后 `done files=184`（+5）/ `done lines=2688`（+100），`remain files=823` / `remain lines=4733`（−100）。
- `PARTIAL` 两个：`cuaDetails.tsx`（基线 23 → 现 1，b263 遗留）+ `featureSuggestedPromptRotation.ts`（17 → 2，本批留 2）。

## 3. 计时：四量（新口径样本 n=9）

```text
t-start    2026-11-11 04:47:36.246 +08:00
t-record   2026-11-11 04:50:37.884 +08:00  sha=ae8058526ec4  record_runs=2
t-verify   2026-11-11 04:50:42.597 +08:00  sha=ae8058526ec4  record_runs=2
commit     2026-11-11 04:51:20 +08:00  daa89fa2

batch_wall_total         = 237.0 s（daa89fa2^ → daa89fa2，git 两端）
batch_wall_controllable  = 224.0 s（t-start → commit）
落笔段                   = 186.4 s（t-start → t-verify）
tail                     =   4.7 s（t-record → t-verify）
record_runs = 2
s/行                     = 1.86（186.4 ÷ 100）
```

- `237.0 s` 与 `224.0 s` 之差 13.0 s 是起笔前的选片动作，不改写行。
- `--order --commit daa89fa2 --prev daa89fa2^` 输出 `PRECHECK ORDER OK`（四戳齐全且单调）。

### 3.1 主档建议（n=9）

```text
样本（落笔段 s/行）  b273 1.51 / b274 1.11 / b275 1.72 / b276 1.06 / b277 1.69 / b278 1.98 / b279 1.07 / b280 1.59 / b281 1.86
中位数               1.59 s/行
极差                 1.98 − 1.06 = 0.92 s/行（中位数的 57.9%）
record_runs 分布     1 → 1 批（b273）；2 → 8 批（b274–b281）；3+ → 0 批
out_of_scope_edits   本批 1 = write_phase 1 + record_phase 0；rolled_back=yes；includes_upstream=no
结论                 **仍不切换主档**：极差 57.9% > 30% 阈值，n=9 只把极差从 59.4% 压到 57.9%
```

- 按 `record_runs` 分组（返修次数 = `record_runs − 1`）：

  | 组 | 口径 | n | 中位数（落笔段 s/行） | 样本 |
  | --- | --- | ---: | ---: | --- |
  | 零/一次返修 | `record_runs ≤ 2` | 9 | **1.59** | 1.51 / 1.11 / 1.72 / 1.06 / 1.69 / 1.98 / 1.07 / 1.59 / 1.86 |
  | 两次以上 | `record_runs ≥ 3` | 0 | —（无样本） | 无 |

- 第二组仍是空组，**不据此给任何工艺结论**，等 `record_runs ≥ 3` 出现实样本再比较。
- 用户口径已并入：极差稳定在一个宽度上，说明**批间波动不是样本量问题**，多做几批不会把极差压到 30% 以下；
  主档维持「不切换」，直到出现 `record_runs ≥ 3` 的样本。

## 4. 度量前后（同批 6 文件，批前 `_wt_b281_pre` 干净 worktree / 批后主工作区）

| 文件 | weak 前→后 | comments | substance 前→后 | explain 前→后 | filler 前→后 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `workflow-face-motion.ts` | 17 → 0 | 54 | 68.5 → 81.5 | 90.7 → 100.0 | 31.5 → 0.0 |
| `embeddedBrowserHelpers.ts` | 17 → 0 | 80 | 61.3 → 77.5 | 91.3 → 100.0 | 21.3 → 0.0 |
| `feedbackTimelineSummary.ts` | 17 → 0 | 42 | 59.5 → 92.9 | 88.1 → 100.0 | 40.5 → 0.0 |
| `mermaidRenderBudget.ts` | 17 → 0 | 41 | 63.4 → 95.1 | 82.9 → 100.0 | 41.5 → 0.0 |
| `officeFilePreview.ts` | 17 → 0 | 53 | 66.0 → 86.8 | 79.2 → 100.0 | 28.3 → 0.0 |
| `featureSuggestedPromptRotation.ts` | 17 → **2** | 41 | 56.1 → 87.8 | 75.6 → 95.1 | 41.5 → 0.0 |
| **合计** | **102 → 2** | **311** | **62.7 → 85.5** | **85.5 → 99.4** | **32.2 → 0.0** |

- `units=661`（前后同值）。批后 2 行 weak 就是 `featureSuggestedPromptRotation.ts:124-125`（不在 plan，顺延 b282）。
- 全仓同域（`packages,apps,docs/knip`）：`WEAK lines=8117 files=1957` → **`8017 / 1952`**；
  `filler 3030 → 2930`（−100，与本批改写行数一一对应）。
- 减少 100 行 = 100 行改写；减少 5 个文件 = 5 个文件清零（第 6 个文件留 2 行未清，故 `files` 只减 5）。
- 池外 weak 恒为 **`8017 − 4733 = 3,284` 行**（b280 后 `8,117 − 4,833 = 3,284` 同值）：
  池内清 100 行时池外不动，正是「池 = 可改写集」的口径证明（§9）。

## 5. 七行门禁（`zc-commit.mjs` v13，`--rewrite-annot --base HEAD`）

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
ORDER GATE PASS record=2026-11-10T20:50:37.884Z verify=2026-11-10T20:50:42.597Z files=6
GATE self=d:\code\_annot_baseline\zc-commit.mjs blob=f02be471a849
```

登记表：`ZC-deep-b281-rewrite.tsv`（100 行，全部 blame `a8784b7e479d3a`）。

### 5.1 预检：集合断言、mtime 读数与越界两列

```text
--scope   out_of_scope_edits=0
--record  run1  hits=6（5 L + 1 W）→ 返修
--record  run2  hits=0
mtime     --scope / --record / --verify 三次均 touched_restored=0
越界      out_of_scope_write_phase=1 / out_of_scope_record_phase=0 / 合计 1
```

- 首轮 6 条命中逐条改写：`workflow-face-motion.ts:114`（L，列举无谓词）、`mermaidRenderBudget.ts:89`（W，单行无信息）、
  `officeFilePreview.ts:31`（L）、`:79`（L）、`featureSuggestedPromptRotation.ts:90`（L）、`:91`（L）；
  分别补 `调用` / `countLines` / `返回` / `Math.min … 计算并封顶` / `分别收集 … 并返回` / `在 selectForPane 中用于避重` 后 `hits=0`。
- **本批 1 行越界无工具证据**：改写 `embeddedBrowserHelpers.ts` 111-114 段时，111 行（`// 加载错误与 guest 失败分开。`，
  不在 plan）被误删，随即补回原文。该文件本批仍是 dirty（其余 17 行是真改写），
  **文件级 mtime 检测看不见「脏文件内的行级还原」**，`touched_restored=0` 是如实读数，不是「没发生」。
  按「回滚不等于未发生」计入 `write_phase=1`，`rolled_back=yes`、`includes_upstream=no`。
- 这正是 b280 那 3 行的同类，也是 §7.1 要写明的边界：工具只补上了「整文件碰过又还原」，行级还原仍需人工记账。

## 6. 收口

### 6.1 守卫（15 文件 cohort，与本批无交集）

```text
WEAK 15文件  pre=4  post=4  新增=0  max=8  key=file+正文
GUARD PASS
```

### 6.2 产能

```text
WHITELIST OK head=daa89fa22b8c rows=272
BATCHCHK b281 pre=b280-repo-post.txt weak=b281-repo-post.txt  OK
baseline=weak-own-by-file.tsv files=1007 lines=7421
done files=184 lines=2688（行口径：Σ 基线 weak − 现 weak）
REMAIN	823	4733	-	412  （剩余；批数为对照/上界，不作为排期依据）
PLAN	138 批	口径=≤6 文件且 ≤100 行/批	均值 6.0 文件 / 34.3 行
ACCT files  done 184 + remain 823 = 1007  OK
ACCT lines  done 2688 + remain 4733 = 7421  OK
ACCT NOTE 恒等式只对池内成立（池 = 基线 diff 的 + 行 ∩ 本线 blame）；池外 weak 不进 done/remain，另计为外部观测
ALIGNED acct_remain=4733 pool_remain=4733 diff=0  OK
ASSERT PASS
```

- 首跑 `ALIGNED … diff=100 MISMATCH`，原因不是口径漂移：本批的 `ZC-deep-b281-rewrite.tsv` 还没落盘，
  `done` 集合里没有这 6 个文件，100 行被算成「未排期文件的漂移」（`DRIFT` 六条，各 `-17/-15`）。
  补登记表后同一份快照复跑 `diff=0`。**登记表与批后快照必须同批落盘**，否则 ACCT 差值会指向错误方向。

### 6.3 三断言

`remain == 0` 未达成；`done + remain = 2,688 + 4,733 = 7,421` OK；`ledger-assert PASS`
（802 收口三列仍 `144/658/802` 全 OK，b281 的 tsv 按非 802 批次 `IGNORED`）。
本批推进 `remain`：4,833 → **4,733**。

## 7. 本批工具交付（用户里程碑：正负控都要跑）

### 7.1 mtime「碰过又还原」检测（`precheck-assert.mjs`）

设计：`--start` 对 `git ls-files` 全量拍 `mtimeMs` 到 `<snapshot>-mtimes.json`；
`--record` / `--verify` 复拍，凡「mtime 变了 + `git diff --quiet HEAD -- <file>` 干净」的文件即命中，
打印 `PRECHECK MTIME touched_restored=N` 与 `MTIME HIT <file>`（最多 12 个），**只计不拦**。

正负控（临时 worktree `_wt_b281_pre`，快照前缀 `ctl81`，20,068 文件全量快照）：

| 控 | 操作 | 期望 | 实测 |
| --- | --- | --- | --- |
| 负控 1 | 起笔后不做任何改动，直接 `--record` | 0 | `PRECHECK MTIME touched_restored=0`，`touched_restored=0` |
| 负控 2 | 真实内容改动（非本批清单文件追加一行） | 不计「还原」 | `touched_restored=0`（该文件 `git diff --quiet HEAD` 非干净） |
| 正控 | 只 `touch` 一个跟踪文件、内容不变 | 1 + 打印文件名 | `PRECHECK MTIME touched_restored=1（mtime 变了但内容 == HEAD，计入 write_phase）` + `MTIME HIT packages/ui/src/lib/mermaidRenderBudget.ts`，`exit 0`（不拦） |

- **已知边界（必须与读数一起看）**：这是**文件级**检测。b280 那种「同一文件内 3 行改过又还原、其余 17 行仍是真改写」
  的文件始终是 dirty，`git diff --quiet HEAD` 永远不干净，因此**测不到**；b281 的 111 行误删又补回正属此类。
  文件级只覆盖「整文件回到 HEAD」这一种还原。
- 命中口径与越界一致：**回滚不等于未发生**，所以照计 `write_phase`，不阻断流程。

### 7.2 白名单新鲜度断言（`capacity-estimate.mjs`）

设计：`own-commits-gen.mjs` 生成 TSV 时同写 `OWN-COMMITS.meta.json`（`head` / `generatedAt` / `rows`）；
产能件启动先读 meta——缺文件 `exit 2`（`WHITELIST MISSING`），`meta.head ≠ HEAD` 时打印
`WHITELIST STALE 白名单落后 N 个提交（生成于 …，当前 HEAD …）` 并 `exit 2`，不进入任何统计。

正负控（真实 meta 文件，改完即还原）：

| 控 | 操作 | 期望 | 实测 |
| --- | --- | --- | --- |
| 负控（缺失） | 临时移走 `OWN-COMMITS.meta.json` | exit 2 | `WHITELIST MISSING 缺 …：先重跑 own-commits-gen.mjs <repo> 再跑产能`，`exit 2` |
| 负控（过期） | 把 `meta.head` 改成父提交 `04ba2ad6` | exit 2 + 落后 N | `WHITELIST STALE 白名单落后 1 个提交（生成于 04ba2ad6，当前 HEAD daa89fa22b8c）`，`exit 2` |
| 正控 | 重跑 `own-commits-gen.mjs` 后原样跑产能 | exit 0 | `WHITELIST OK head=daa89fa22b8c rows=272`，继续统计 |

- 严格相等意味着「台账提交之后」必然显示落后 1 个提交——这是有意的：**必须重跑生成器才能继续**，
  用拒跑代替「每批记得重跑」。
- 起因是 b280 首跑把 85 行判成「上游自清」、`done` 只 +7，归户翻转不报错、只让 `done` 少算；
  现在同一类错误会在启动时直接失败。

## 8. 趋势：归户错 / 文本错 / 越界

> 表头口径：**回滚不等于未发生；统计目的是看越界在增加还是减少。**

| 批 | 归户错 | 文本错 | write_phase | record_phase | 合计 | rolled_back | includes_upstream | `record_runs` | 明细 |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | --- |
| b273 | 0 | 0 | 4 | 0 | **4** | yes | yes | 1 | 3 本线 + 1 上游，`--record` 前手工回滚 |
| b274 | 0 | 0 | 1 | 0 | **1** | yes | no | 2 | 本线 1 行，`numstat` 反推后回滚 |
| b275 | 0 | 0 | 0 | 0 | **0** | no | no | 2 | `--scope` 首用，1 W + 2 L |
| b276 | 0 | 0 | 0 | 0 | **0** | no | no | 2 | 4 W + 1 L |
| b277 | 0 | 0 | 2 | 0 | **2** | yes | no | 2 | `useWorkspaceServices.tsx:198/199` 原样回退 |
| b278 | 0 | 0 | 0 | 0 | **0** | no | no | 2 | 3 W，无越界 |
| b279 | 0 | 0 | 1 | 0 | **1** | yes | no | 2 | `useWebElementContexts.ts:84` 整块替换越界 |
| b280 | 0 | 0 | 3 | 0 | **3** | yes | no | 2 | `remoteWorkspaceServiceCollection.ts:180-182` 改写块越界，`--scope` 前自查恢复 |
| **b281** | **0** | **0** | **1** | **0** | **1** | **yes** | **no** | **2** | `embeddedBrowserHelpers.ts:111` 误删又补回（行级还原，mtime 文件级测不到）；5 L + 1 W |

九批合计：`write_phase 12 + record_phase 0 = 12`。

- b281 起，**「整文件碰过又还原」有了工具读数**（§7.1），从此这一类不再只能靠人记；
  仍无工具证据的只剩「脏文件内的行级还原」——b281 这 1 行就是它，已如实标注。

## 9. 池外定性与 A2 恒等式（b281 定案）

- 判断：**明确排除**，不纳入 `remain`。池外 3,284 行 / 1,308 文件（基线同号 2,678/1,007、行号漂移 601/307、跨行 5）
  与用户倾向一致，理由也独立成立：
  1. 池外主体是上游英文注释与结构性行，本线没有「改写但不改语义」的权限；纳入等于把不可写行拉进配额。
  2. 纳入会把 `remain` 从 4,733 抬到 8,017、换掉 A2 分母，同时稀释 `done` 的语义（同一行既可能是本线债、也可能是上游文本）。
  3. 池内清 100 行时池外恒为 3,284（§4 实测），两侧互不干扰；排除口径下 `ALIGNED diff=0` 才是一个可失败的断言。
- 代价写死：这 3,284 行**永久不排期**，只用「全仓 WEAK − pool_remain」持续观测，不写成 0。
- A2 完整写法：`done + remain == 7,421`，**该恒等式只对池内成立，池外 3,284 行另计**。
- 收口三断言指针仍按 `ZC-deep-b265.md` §9：`remain == 0`（未达成）、`done + remain == 7,421`（OK）、
  `ledger-assert PASS`（OK）。本批推进 `remain`：4,833 → **4,733**。
