# ZC-deep-b264：PLAN#1 五文件 / 100 行改写 + 白名单机器化与四时点口径统一

- base：`40dca0b4`（b263 台账补）
- 代码提交：`cf26a733 b264 改写 (+100/−100)`

尺子：`deep-quality.mjs` v2.0（blob `756bea66122a`）；门禁 `zc-commit.mjs` v12（`a35b42fa2e4c`）；
`ledger-assert.mjs`（`35afeb266f97`）；`weak-guard.mjs`（`a3600ccfacab`）；
`own-commits.mjs` v3（`16b02706cd90`，本批换）；`capacity-estimate.mjs` v2（`30ce7b12abd2`，本批换，含三态摘要）。
本批两项工具变更都**只增不改**：v2 归档为 `own-commits-v2.mjs` / `capacity-estimate-v1.mjs`。

## 0. 七项交代结论

| # | 要求 | 结论 | 位置 |
| --- | --- | --- | --- |
| 1 | 白名单改机器生成，负例必须做 | `OWN-COMMITS.tsv` 214 行，作者口径；两条断言（sha 可解析 / 行数一致）；负例注入假 sha 后白名单 sha256 不变 | §1 |
| 2 | 三个 weak 快照绑 sha，pre-b264 给明确值 | 补 `8acd208e` 成四时点；`6,676` 明确标注「b261 后、b262 前」；pre-b264 = `6,476` | §2 |
| 3 | `--uncovered 877 → 877` 必须解释 | 它数「代码单元有没有注释」，1→1 改写注释正文不改变集合；**非进度指标** | §3 |
| 4 | ACCT 从「文件」改「行」，加 `pool_remain == acct_remain` 断言 | 已改：首跑 `done 896 / remain 6,525`，b264 后 `done 996 / remain 6,425`，两次 `diff=0`；断言失败即 `exit 1` | §4 |
| 5 | `offPeakTaskService.ts:439/833` 定性矛盾 | 两行均 **改前 weak → 改后 strong**，不在「剩余 5 条」里；剩余 5 条全是另外的行 | §5 |
| 6 | 台账撤 `s/文件` 与隐含密度 | 批次台账只留 `s/行`；`s/文件` 历史对照进 `INDEX.md` §2.4（含 12% 偏差与两条禁令） | §6 |
| 7 | 选行判据叠 `own-commits` 三态，配额分母改 `writable` | 五文件 107 weak = **writable 100 + upstream 7**；配额 100 恰好等于 `writable`；`--plan-print` 每片开头打 `writable/upstream/pending` | §2.1 |
| — | 首跑命中趋势 | b261 `4（3L+1W）` → b262 `3（0L+3W）` → b263 `11（10L+1W）` → b264 `5（4 归户 + 1 W）`，全部 100 行/批 | §7 |

---

## 1. 白名单改机器生成（b262 归户翻转的根因修复）

### 1.1 根因

v2 的白名单不是「谁写的」，是「台账里被提到过、且长得像提交号的字符串」：
`own-commits-v2.mjs` 用 `/提交[^\n0-9a-f]{0,6}([0-9a-f]{7,40})/g` 与 `/安全快照[^\n0-9a-f]{0,6}([0-9a-f]{7,40})/g`
扫 `ZC-*.md` 散文。b262 台账一句「本线的注释提交，`872ad960` / `aac47556` 都在册外」把两个**上游** sha 抽进白名单，
`872ad960` 名下 1,001 行归户翻转；b263 只是靠改写措辞把 sha 挪出「提交」后 6 字符，人一换写法就复发。

### 1.2 做法

| 件 | 作用 |
| --- | --- |
| [`own-commits-gen.mjs`](../../../docs/annotation/_tools/own-commits-gen.mjs) | `git log --format=%H%x09%an%x09%ai%x09%s --reverse` → 按 `OWN_AUTHORS = ['zhanglingfeng']` 过滤 → 按 sha 升序渲染 TSV |
| [`OWN-COMMITS.tsv`](../../../docs/annotation/_tools/OWN-COMMITS.tsv) | **唯一事实来源**，214 行（`sha / author / date / subject`）；**文档散文不参与解析** |
| [`own-commits.mjs`](../../../docs/annotation/_tools/own-commits.mjs) | 只读 TSV；`--check` 三态照旧（未解析 `exit 3`）；新增 `--verify` |

两条断言（`--verify`，任一失败 `exit 1`）：

1. **每个 sha 在 `git log` 里存在**：`loadOwnCommits` 逐行 `git rev-parse --verify <sha>^{commit}`，
   解析结果必须等于该 sha 本身（防把 tag / blob / 短 sha 写进 TSV）。
2. **白名单行数 == 机器生成行数**：把 TSV 与 `generateRows()` 的结果比「行数、缺失、多余、逐字文本」四项。

```text
OWNCOMMITS rows=214 generated=214 missing=0 extra=0 text=same
exit=0
```

三态抽查（`--check`）：

```text
872ad960	上游	wuweiqi	feat: open source
aac47556	上游	bot	feat: update to v3.15.1
0a1fc56d	上游	bot	...
32fe1002	本线	白名单	...
e0060254	本线	白名单	...
a8784b7e	本线	白名单	...
CHECK own=3 upstream=3 pending=0
```

### 1.3 负例（必须做，已做）

往 `docs/annotation/ZC-deep-b263.md` 末尾追加一行散文：

```text
（b264 负例）本线提交 deadbeefdeadbeefdeadbeefdeadbeefdeadbeef，安全快照 1234567890abcdef1234567890abcdef12345678。
```

这一步专打 v2 的两个正则：两个假 sha 都紧跟在触发词后、都是 40 位、一个词是「提交」一个是「安全快照」。

```text
$ node docs/annotation/_tools/own-commits.mjs . --verify
OWNCOMMITS rows=214 generated=214 missing=0 extra=0 text=same
$ (Get-FileHash OWN-COMMITS.tsv -Algorithm SHA256).Hash   # 注入前后同一个值
$ node docs/annotation/_tools/own-commits.mjs . --check deadbeef… 1234567890ab…
deadbeef…	未解析	(未解析)	(无 commit 证据)
1234567890ab…	未解析	(未解析)	(无 commit 证据)
CHECK own=0 upstream=0 pending=2
exit=3
```

结论：**文档里写什么 sha 都不影响白名单**；写进 White 名单之外的假 sha 只会被 `--check` 判「未解析」并 `exit 3`，
不会静默落进上游桶。删掉该行后复验仍 `rows=214`。

### 1.4 用新白名单重算 b262 的 weak 增量（返工）

同一份 `0cab755e` 的 weak 快照，只换白名单：

| 项 | v2（旧台账） | v3（本批） | 差 |
| --- | ---: | ---: | ---: |
| 全仓 weak | 9,981 | 9,981 | 0 |
| 池内本线 | 6,676 | 6,676 | 0 |
| 池外本线 | 1,132 | **1,270** | +138 |
| 上游 | 2,173 | **2,035** | −138 |
| 本线提交数 | 15 | **27** | +12 |
| 上游提交数 | 17 | **5** | −12 |

b262 本批（`0cab755e → e3116a93`）的 weak 增量：

| 项 | v2 登记 | v3 重算 | 说明 |
| --- | ---: | ---: | --- |
| 全仓 weak | 9,981 → 9,881（`−100`） | 9,981 → **9,878**（`−103`） | 实测另有 `−3` 连带；`9,881` 是算术外推 |
| own | 7,808 → 7,708（`−100`） | 7,946 → **7,843**（`−103`） | 同上 |
| upstream | 2,173 → 2,173（0） | 2,035 → **2,035**（0） | 不变 |

**返工记录**：`ZC-deep-b262.md` §2.4/§2.5 与 `ZC-deep-b263.md` §1.1–§1.4 已按上表改写并标「b264 返工」；
地板 `2,173 → 2,035`，池外本线 `1,132 → 1,270`，`9,881 → 9,878`。三个恒等式两边都仍闭合（合计 `9,981` / `9,878` 不变）。

---

## 2. 四个 weak 快照各绑 commit sha

今天在四个干净 worktree 上各跑一次 `--root packages,apps --list-weak` + 池外 blame 拆分（不是拼接历史读数）：

| 时点（commit） | 释义 | 全仓 weak | 池内本线 | 池外本线 | 上游 | 恒等式 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `8acd208e` | b261 **前**（B12 收口） | 10,081 | **6,776** | 1,270 | 2,035 | 10,081 |
| `0cab755e` | **b261 后、b262 前** | 9,981 | **6,676** | 1,270 | 2,035 | 9,981 |
| `e3116a93` | **b262 后、b263 前** | 9,878 | **6,576** | 1,267 | 2,035 | 9,878 |
| `2e779933` | **b263 后 = pre-b264** | 9,776 | **6,476** | 1,267 | 2,033 | 9,776 |

- **`6,676` 的时点被写错了**：它是「b261 之后、b262 之前」（`0cab755e`），不是 pre-b261。
  pre-b261 是 `8acd208e` 的 `6,776`。补上这一行后，池内是三段各 `−100`：`6,776 → 6,676 → 6,576 → 6,476`。
- 之前只有两段间隔，是因为表里缺了 `8acd208e` 这一行，读者容易把 `6,676` 当成 b261 的起点，
  于是 `9,981 → 9,878 → 9,776` 读起来像「一批掉 200」。
- **pre-b264 的池内本线是一个明确值：`6,476`（`packages,apps`）**；同域（含基线里的 `docs/knip` 4 文件 49 行）
  为 `6,525`，这是 `capacity-estimate` v2 断言的右边（§4）。
- `40dca0b4`（本批 HEAD）与 `2e779933` 代码树相同（只差文档），池内读数同为 `6,476`。

**收口标准（按正确时点重写）**：收口 = **池内清零**。时点口径是 `40dca0b4` / pre-b264，
此时池内 `6,476`（`packages,apps`）；每批 100 行改写对 100 行池内 weak，四批分别
`6,776 → 6,676 → 6,576 → 6,476`。**不是「一批掉 200」**，也不是「全仓 9,776 清零」——
全仓读数的下限是池外本线 `1,267` + 上游 `2,033` = `3,300`。

### 2.1 选行判据的缺陷与修正（返工）

**首轮门禁失败暴露的问题**：`删上游注释 n=4`。池定义 `git diff -U0 8f7daaf0 HEAD` 的 `+` 行 ∩ weak，
会把**上游**在 `8f7daaf0` 之后落的 weak 也放进「可写」集合。PLAN#1 从这 107 条里取了 100 行，
其中 4 行是上游注释（`872ad960` / `0a1fc56d` / `aac47556`），改不动。

**修法**：选行时再叠一次 `own-commits` 三态，只取「本线」桶；配额分母从「文件里的 weak 总数」改成 `writable`。

**实测三态（`_b264_b263` 干净 worktree，`b264-weak-before.txt` 107 条逐行 blame）**：

| 文件 | weak 合计 | writable | upstream | pending |
| --- | ---: | ---: | ---: | ---: |
| `node-repl-session.ts` | 14 | 12 | 2 | 0 |
| `SaveWorkflowPermissionBlock.tsx` | 25 | 22 | 3 | 0 |
| `WorkflowSavePopover.tsx` | 24 | 22 | 2 | 0 |
| `automationTelemetry.ts` | 22 | 22 | 0 | 0 |
| `PurposeSections.tsx` | 22 | 22 | 0 | 0 |
| **合计** | **107** | **100** | **7** | **0** |

**更正（返工登记）**：b264 首报写的是「103 可写 + 4 上游」，**错**。逐行 blame 后是 **100 可写 + 7 上游**。
差的 3 条是块尾 `*/` 结构行（`node-repl-session.ts:142`、`SaveWorkflowPermissionBlock.tsx:51`、`:152`），
改前因句元下合并判弱、本批未动，相邻行改写后自动判强。所以：

- 配额 `100` 恰好等于 `writable 100`，本批**没有**「注定差 4 行」；真正该改的是分母口径，不是补行。
- 改写 100 行后 `writable` 归零；`upstream 7` 中 4 条仍是 weak、3 条连带转强。
- **「不可写集合」单列，不与待办混排**：`node-repl-session.ts:498`、`SaveWorkflowPermissionBlock.tsx:44`、
  `WorkflowSavePopover.tsx:65`、`WorkflowSavePopover.tsx:155`。四条全部**在池外**（早于 `8f7daaf0`），
  既不进待办，也不阻塞「池内清零」。

**b265 起计法更新（三列）**：`upstream 7` 拆成「真上游 4 + 本线已转强 3」，计划表改为
「真上游 / 已转强（块尾 `*/`）/ 可写」三列 + 一行「池外另计」；`100 + 7 = 107` 的写法停用。
理由与 b265 的 112 拆解见 `ZC-deep-b265.md` §2。

**工具改动**：`capacity-estimate.mjs` 的 `--plan-print` 每片开头打印
`writable=X self-clearing=Y upstream=Z pending=W`；`pending > 0` 时 `exit 3`（先回填白名单再排期）；
`quota < 计划行数` 时打印「实际按 quota 行排」。当前实测：

```text
PLAN#1	5 文件 / 100 行	writable=100 upstream=0 pending=0	apps/…/turn.ts , …
PLAN#2	5 文件 / 100 行	writable=100 upstream=0 pending=0	packages/ui/…/WorkflowRunSettingsPopover.tsx , …
PLAN#3	5 文件 / 100 行	writable=100 upstream=0 pending=0	packages/ui/…/RemoteIdentityHoverCard.tsx , …
```

（以上是三片 b264 后的剩余批次；PLAN#1 的成员已换成下一组五文件，因为原五文件的 `writable` 已归零。）

**历史数字修正**：`ZC-deep-b261.md` §3.8 的 PLAN#1 条目已加返工注，把「5 文件 / 107 条 weak」更正为
「writable 100 + upstream 7，配额 100 = writable 100」。改的是台账结论，不是代码。

---

## 3. `--uncovered` 是什么，为什么 `877 → 877`

### 3.1 定义

`deep-quality.mjs --uncovered <outFile>` 输出的是**代码单元未覆盖明细**，一行一条：

```text
<path>\t<line>\t<B|->\t<该行代码正文>
```

- **unit**：每个非空、非注释、非结构行（`{`/`}`/`)` 等）、非 import、非续行的代码行。
- **covered**：该 unit 的上方 2 行内存在注释，或本行有行尾注释。
- **uncovered**：不满足 covered 的 unit。`B` 表示该 unit 属于分支/块，`-` 表示普通行。

### 3.2 作用域

由 `--files` / `--file-list` / `--root` 决定。批次里是**当批那几个文件**，不是全仓。
所以跨批的 `531 / 428 / 877` 不可比——它们的 unit 总量和文件集都不同：

| 批次 | 文件 | units | coverage | covered | uncovered |
| --- | ---: | ---: | ---: | ---: | ---: |
| b261 | 5 | 583 | 8.9% | 52 | **531** |
| b262 | 5 | 457 | 6.3% | 29 | **428** |
| b263 | 5 | 1,066 | 17.7% | 189 | **877** |
| b264 | 5 | 721 | 10.0% | 72 | **649**（改前 649 → 改后 649） |

### 3.3 为什么改写 100 行它不动

1→1 改写只换注释**正文**：既没有删/加注释行（门禁 `新增注释行 n=100` 与 `删本线注释 n=100` 等量），
也没有动代码行（`删代码 n=0`、`新增非注释行 n=0`）。`unit` 集合不变、`covered` 判定不变，
所以 `uncovered` 必然不变。三批都 `X → X`，不是巧合，是构造性恒等。

### 3.4 结论：**非进度指标**

- 它测的是「这些文件里有多少代码行还没有注释」，不是「有多少注释还不合格」。
- 本工程的收口标准是**池内 weak 清零**，对应 `--list-weak`；`--uncovered` 与它正交。
- 只有「新增注释覆盖了原来没注释的代码行」或「代码结构变化」才会让它动；本工作流两者都不做。
- 台账从本批起把它标为**非进度指标**，只作「这批文件的可解释性基线」记录，不参与任何进度/产能判断。

---

## 4. ACCT 记账单位从「文件」改为「行」

### 4.1 改了什么

`capacity-estimate.mjs` v2（`3c7f6139100a`），v1 归档为 `capacity-estimate-v1.mjs`（`8d31b38559da`）。

| | v1（旧） | v2（本批） |
| --- | --- | --- |
| 记账单位 | 文件（all-or-nothing） | 行 |
| 文件 done 时扣 | `baselineCount` 整份 | `基线 weak − 现 weak` |
| 现 weak 来源 | 无（假设 done 即清零） | `--weak <--list-weak 输出>` ∩ 池定义（`git diff -U0 8f7daaf0 HEAD` 的 `+` 行） |
| 文件还有残留 | 记 0 | 记 `PARTIAL`，按剩余行**回池排期** |
| 对账 | 人工看 | `acct_remain == pool_remain`，不等 `exit 1` 并打 `DRIFT` |
| `--weak` | 无 | **必填**（缺省 `exit 2`） |

### 4.2 实测（`2e779933` = pre-b264，扫描根 `packages,apps,docs/knip`）

```text
baseline=weak-own-by-file.tsv files=1007 lines=7421
done files=86 lines=896（行口径：Σ 基线 weak − 现 weak）  perBatch=2
PARTIAL	1 个 done 文件仍有池内 weak，已按剩余行回池排期
PARTIAL	packages/ui/src/ToolCallBlocks/renderers/cuaDetails.tsx	基线 23 → 现 1
ACCT files  done 86 + remain 921 = 1007  OK
ACCT lines  done 896 + remain 6525 = 7421  OK
ALIGNED acct_remain=6525 pool_remain=6525 diff=0  OK
ASSERT PASS
```

- `done files 87 → 86`、`remain 920 → 921`：`cuaDetails.tsx` 不再算 done，因为还留 1 行。
- `done lines 897 → 896`：该文件按 `23 − 1 = 22` 记，不再整份扣 23。
- **差 1 消失**：旧账 `pool 6,525 vs acct 6,524`，新账 `6,525 == 6,525`。断言不等就 `exit 1`，
  不会再出现「人工核出差 1 已知」就往下走。

### 4.3 `+49` 是什么

不是残差，是**基线覆盖范围**：`weak-own-by-file.tsv` 的 1,007 文件里有 4 个 `docs/knip` 文件，合计 49 行
（16 + 13 + 12 + 8）。旧测量用 `--root packages,apps` 扫描，这 49 行扫不到，于是要把 `+49` 手工补到池子那边；
v2 把扫描根改成 `packages,apps,docs/knip`，两侧同域，`+49` 不再需要人补，等式自然闭合。

### 4.4 `cuaDetails.tsx:14` 回池

该行不再进「已知残差」：`capacity-estimate` 把它作为 `PARTIAL` 留在剩余集里（1 行），
下一个 1 行批或就近批会带上它；`PLAN#1` 仍是 5 文件 / 100 行（不含它）。

---

## 5. `offPeakTaskService.ts:439/833` 的逐行结论

b263 §4.4 原来一句话同时说了「相邻改写让句元重新判强」和「剩余 5 条 weak」，读起来像这两行还在剩余里。逐行定死：

| 行 | blame | 改前（`e3116a93`） | 改后（`2e779933`） | 依据 |
| --- | --- | --- | --- | --- |
| `:439` | `872ad960`（wuweiqi，上游） | **weak**：`无解释`，去掉 `*/` 标记后正文为空 | **strong**：不在 `--list-weak` 明细 | 结构行 `*/`，本批未删未改；相邻行改写后块内句元合并重新判强 |
| `:833` | `872ad960`（wuweiqi，上游） | **weak**：`短句堆叠`（「单票状态映射（两轴）：返回是否翻为可派发。」） | **strong**：不在 `--list-weak` 明细 | 同块 `:834/:835` 是本线行，本批改写后整块句元重新判强 |

**剩余 5 条 weak 是另外的行**，全部上游、本批未触及：

| 行 | blame | 原因 |
| --- | --- | --- |
| `offPeakTaskService.ts:69` | `872ad960` | `无解释`（正文「测试注入时钟。」） |
| `offPeakTaskService.ts:214` | `872ad960` | `无解释`（正文「---- 管理操作 ----」） |
| `WorkflowAskSettingsParts.tsx:109` | `872ad960` | `无解释` |
| `WorkflowAskSettingsParts.tsx:219` | `872ad960` | `无解释` |
| `WorkflowRunSettingsFields.tsx:90` | `872ad960` | `无解释` |

所以 b263 的「本线 100 条全清」成立：`107 − 5 = 102 = 本线 100 + 上游连带 2`，
`439/833` 属于「连带 2」，不属于「剩余 5」。`ZC-deep-b263.md` §4.4 已按本表改写。

---

## 6. 批次台账撤 `s/文件` 与「隐含密度」

- 批次台账的计时表从本批起**只留 `s/行`**（全批 + 仅改写段两列），撤掉 `s/文件` 与「隐含密度」两行。
- `s/文件` 的历史对照集中到 [`INDEX.md` §2.4](../_tools/INDEX.md)：b240–b247、b261、b263 的值与全历史均值 20.6，
  并写明 **12% 密度偏差**（隐含 8.2 行/文件 vs PLAN 7.30）与两条用法禁令（不得乘文件数、不得乘批数）。
- `ZC-deep-b263.md` §4.7 已同步删除那两行（保留历史文字，标注「b264 起撤掉」）。

---

## 7. 首跑命中趋势（判据是否还在咬）

| 批次 | 改写量 | 首跑命中 | 类型 | 说明 |
| --- | ---: | ---: | --- | --- |
| b261 | 100 行 | **4** | 3 L + 1 W | L = 无信息的中文列举（`,，、` ≥2 且无谓词），W = 无标识符 |
| b262 | 100 行 | **3** | 0 L + 3 W | 全 W |
| b263 | 100 行 | **11** | 10 L + 1 W | 前一批 |
| b264 | 100 行 | **5** | 4 归户 + 1 W | 归户 4 = 删上游注释；文本 1 = W（`automationTelemetry.ts:104` 无标识符）；二跑 0 |

这是目前唯一能证明「判据还在起作用」的数：判据本身没改，命中数只随抽取文本的写法变化。
三批都全部拦下、逐行改后二跑 `exit 0`，说明门禁不是空转。

---

## 8. 本体：PLAN#1 五文件 100 行改写

### 8.1 改写量（`+100 / −100`，零代码行）

```text
12	12	apps/zcode-cli/packages/core/src/repl/node-repl-session.ts
22	22	packages/ui/src/SaveWorkflowPermissionBlock.tsx
22	22	packages/ui/src/components/workflow-timeline/WorkflowSavePopover.tsx
22	22	packages/ui/src/lib/automationTelemetry.ts
22	22	packages/ui/src/project-sidebar/PurposeSections.tsx
```

逐文件 `12 / 22 / 22 / 22 / 22 = 100`，与 §2.1 的 `writable` 分布一致：写满 `writable`，不碰 `upstream`。

### 8.2 首轮门禁（失败，原文）

```text
=== 改写门禁（base=HEAD）===
删本线注释    n=96  （允许，逐行登记）
删代码        n=0   （必须 0）
删上游注释    n=4   （必须 0）        ← 违规
新增非注释行  n=0   （必须 0）
原行搬移      n=0
标点级改写    n=0   （必须 0）
新增注释行    n=100  其中判据命中 1  其中嵌套注释 0   ← 违规
--- 删上游注释（违规）---
  apps/…/node-repl-session.ts:498	feat: open source	/** 释放资源。 */
  packages/ui/src/SaveWorkflowPermissionBlock.tsx:44	chore: sync ZCode source	// 与确认窗脚本开关同一副文字按钮样式：…
  packages/ui/…/WorkflowSavePopover.tsx:65	feat: update to v3.15.1	* 缺席即这条路不可达——…
  packages/ui/…/WorkflowSavePopover.tsx:155	feat: update to v3.15.1	// 名字或作用域一变先把结论作废，…
--- 新增注释命中 W/L/POEM（违规）---
  packages/ui/src/lib/automationTelemetry.ts:104	W	单行无信息	校验错误放在最后判断，避免抢占前面的类别。
改写门禁未通过
```

两类性质不同：**4 条是归户错**（§2.1，改的是选行判据），**1 条是文本错**（W：整句没有一个 ASCII 标识符）。

### 8.3 修正后的二轮门禁（`exit 0`）

修法三条：4 行按 HEAD 原文**逐字回退**（`git diff` 上表现为「没有改动」，不是删除，所以最终 `删上游注释 n=0`）；
`automationTelemetry.ts:104` 补**后果**（`校验错误用 validation 正则最后判断：若前移，ZodError 文本里的 "timeout"
会先命中 timeout 分支，真错因被归成网络错误。`）；从 `PurposeSections.tsx:95-98` 补 4 行，维持 100。

```text
=== 改写门禁（base=HEAD）===
删本线注释    n=100  （允许，逐行登记）
删代码        n=0
删上游注释    n=0
新增非注释行  n=0
原行搬移      n=0
标点级改写    n=0
新增注释行    n=100  其中判据命中 0  其中嵌套注释 0
登记表已写 docs/annotation/ZC-deep-b264-rewrite.tsv（100 行）
exit=0
```

**关于计数**：首轮的 `删本线注释 n=96` 与二轮的 `n=100` 里的 100 行，全部是本线 `a8784b7e`（安全快照）行；
`deletedNonZero` 指的是「删代码 / 新增非注释行 / 删上游注释」这三项，全程为 0。4 行上游注释是**恢复原文**，
在 diff 里既不产生删除也不产生新增，别把 `n=96 → n=100` 读成「删了上游又补了 4」。

### 8.4 度量（同一个 5 文件作用域）

| 指标 | 改前 | 改后 |
| --- | ---: | ---: |
| weak 行 | **107** | **4**（全部上游，且都在池外） |
| substance | 62.8% | **84.0%** |
| filler | 26.7% | **0.0%** |
| weak 率 | 29.5% | **1.1%** |
| uncovered | 649 | **649**（§3，非进度指标） |

`WEAK lines=4 files=3`；4 条 = §2.1「不可写集合」，不进待办。

### 8.5 全仓与池（干净 worktree）

主工作区有 15 个外部会话脏文件（多出 91 条 weak），所以全仓 baseline 用 `_b264_post`
（`40dca0b4` + 仅拷入 5 个改写文件）测：

```text
全仓（packages,apps,docs/knip）  9,825 → 9,722   −103
池内 / ACCT                      6,525 → 6,425   −100
ALIGNED acct_remain=6425 pool_remain=6425 diff=0  OK
ACCT lines  done 996 + remain 6425 = 7421  OK
ASSERT PASS
```

**`−103` 与 `−100` 的差 3**：`node-repl-session.ts:142`、`SaveWorkflowPermissionBlock.tsx:51`、`:152`
三条块尾 `*/` 结构行，改前判弱、改写相邻行后自动转强。它们既不在池内（早于 `8f7daaf0`），
也不在基线 weak 里，所以池和 ACCT 两侧同步只动 `−100`，`diff` 仍为 0。
这不是漂移，是「池外连带」，已在 §2.1 单列。

### 8.6 守卫

```text
weak-guard（b247 冻结 15 文件 cohort）  pre 4 → post 4  新增 0  PASS
ledger-assert                           PASS
own-commits --verify                    rows=214 generated=214 missing=0 extra=0 text=same
```

15 文件 cohort 与 b264 的 5 个文件无交集，所以这条守的是「别把别处的 weak 改坏」。

### 8.7 计时

只记 `s/行`。本批**不填造数**：门禁首轮失败 + 宿主侧工具失联，墙钟被切成三段，
其中一段是等工具恢复，不具可比性。下一批恢复常规计时（全批 / 仅改写段两列）。

### 8.8 收口状态

- 池内本线：`6,476 → 6,376`（`packages,apps`）；含 `docs/knip` 的 49 行为 `6,525 → 6,425`（这是 ACCT 断言的右端）。
- 本批 5 个文件 `writable` 已归零，退出待办。
- 「不可写集合」4 条（§2.1）永久单列，不计入任何进度。`cuaDetails.tsx:14` 仍按 `PARTIAL` 在池里排 1 行批。

---
