# ZC-deep-b266：PLAN#2 五文件 / 100 行改写（口径沿用 b265）

- base：`2dd8d70c`（b265 口径补充：`s/行` 中位数 / `uncovered` 边界 / 收口三断言）
- 代码提交：`714cb921 docs(注释): b266 改写 PLAN#2 五文件注释 (+100/−100)`
- 规划成员：`WorkflowRunSettingsPopover.tsx`、`useTabPersistence.ts`、`useWorkspaceActiveTaskState.ts`、
  `ProjectNode.tsx`、`subagents.ts`

尺子：`deep-quality.mjs` v2.0（`756bea66122a`）；门禁 `zc-commit.mjs` v12（`a35b42fa2e4c`）；
`own-commits.mjs` v3（`16b02706cd90`）+ `OWN-COMMITS.tsv`（214 行）；
`ledger-assert.mjs`（`35afeb266f97`）；`weak-guard.mjs`（`a3600ccfacab`）；
`capacity-estimate.mjs` v2（`e49e187e10d7`，本批改：`pool-out` 第四桶 + `PLAN` 行四桶打印）。

## 0. 交代

| # | 事项 | 结论 |
| --- | --- | --- |
| 1 | 口径（`s/行` 中位数、`uncovered` 边界、收口三断言） | 已写入 `ZC-deep-b265.md` §5 / §3.5 / §9 与 `INDEX.md`，本批只沿用不重述 |
| 2 | 配额 = `writable − self-clearing` | 落笔前四桶摘要 `writable=100 / upstream=0 / self-clearing=0 / pool-out=3 / pending=0 → quota=100` |
| 3 | 常规链路 | 门禁三轮全 0；`weak-guard` 新增 0；`ledger-assert PASS`；`ALIGNED diff=0`；`+100/−100`、零代码行 |

本批无「规划时值 ≠ 批后值」的口径争议：`uncovered` 未重测也不影响收口，理由见 §6。

---

## 1. 三列计划表（沿用 b265 §2）

| 类别 | 行数 | 明细 |
| --- | ---: | --- |
| 真上游（池内） | **0** | 池 = `+` 行，上游行进不来 |
| 本线已转强（池内块尾 `*/`） | **0** | 本批无 |
| 可写（池内 + 白名单） | **100** | 恰好等于配额，全部落笔 |
| 池外另计 | **3** | `own/out` 2（`subagents.ts:93`、`:194`）+ `up/out` 1（`WorkflowRunSettingsPopover.tsx:74`） |
| 合计 weak | **103** | `100 + 3` |

```text
TALLY ownIn=100 ownOut=2 upIn=0 upOut=1
```

池外 3 行里 **1 行自清**（`subagents.ts:93`，`0f2ef80d out-of-pool`），其余 2 行保留：

```text
subagents.ts:194                  // - 多个插件同名 → 只保留正名并给歧义诊断。      （own/out）
WorkflowRunSettingsPopover.tsx:74 // 触发点的开关与锚点：点同一个触发点再点一次是关…  （up/out）
```

## 2. 配额扣减与四态断言

```text
SELF-CLEAR n=1	可写桶 0 / 池外 1 / 上游桶 0 / 未解析 0	（只有可写桶进配额扣减）
  apps/zcode-cli/packages/bootstrap/src/subagents.ts:93	0f2ef80d	out-of-pool
```

落笔前该片（b266 五文件）摘要，`quota` 由式子直接印出：

```text
writable=100 upstream=0 self-clearing=0 pool-out=3 pending=0 quota=100
四态和 100+0+0+3 = 103 = weak 合计 103；池内 weak 100 = 实测 100
```

分类顺序仍是 **池外 → 未解析 → 可写 → 上游**。**自清行只有在「池内 + 可写桶」时才扣配额**：
b266 这行（`subagents.ts:93`）已转强，当前不在池内，所以落「池外桶」，配额保持 `100 − 0 = 100`，
不会出现「配额 99 / 实清 100」。b265 `agent.ts:225` 是同一个坑，判据一致。

`--plan-print` 现已内置两条断言（本批落笔后补入并验证，验证对象是下一批 b267 的装箱）：

```text
PLAN#1	5 文件 / 100 行	writable=100 upstream=0 self-clearing=0 pool-out=1 pending=0
quota=100(writable 100 − self-clearing 0) 四态和=101=weak合计 101 池内weak=100/池内实测 100
```

- 四态之和（可写 + 上游 + 未解析 + 池外）== 成员文件 weak 合计；
- 池内三桶 == `weak ∩ pool` 实测行数；不等即 `exit 5`；
- `pending > 0` 仍 `exit 3`（归属未解析不许排期）。

### 2.1 负控（两条等式各一条）

不往活文件里改代码：把 `capacity-estimate.mjs` + `own-commits.mjs` + `own-commits-gen.mjs`
复制到 `_annot_baseline/_negcap/`，只改副本跑，跑完即弃（脚本 `_annot_baseline/negcap.mjs`）。

| 用例 | 注入（数据通路，不改断言） | 期望 | 实际 |
| --- | --- | --- | --- |
| 正常输入 | 无 | `exit 0` | `exit 0`，`四态和=101=weak合计 101 池内weak=100/池内实测 100` |
| NEG-1 四态和 ≠ weak 合计 | `out.poolOut += 1` → `+= 0`（漏分类 1 行） | `exit 5` | `exit 5`，`四态合计 100 + 池外 0 ≠ weak 合计 101` |
| NEG-2 池内 ≠ `weak ∩ pool` 实测 | 交集计数去掉 `ps?.has(ln)` 判断（重复计 1 行） | `exit 5` | `exit 5`，`池内 100 ≠ 实测 101` |

```text
NEGCTL PASS   （3/3）
```

两条负控各自只触发对应那一条断言：NEG-1 的「池内 100 = 实测 100」仍成立，
NEG-2 的「四态和 101 = 101」仍成立，所以不是一条断言顺带拦住两条。

**第一版误报已修**：初次实现把 `pool`（`git diff +` 全部行集 211 行）当成池内 weak 数去比，
正常输入即 `exit 5`。误报方向是**假红**（可见、可修）；真正的风险在相反方向——
分类漏行却不报（假绿），所以负控必须证明断言在「漏 1 行」时真的会响，而不是只证明它不响。

## 3. 计时

| 段 | 实测 | 说明 |
| --- | ---: | --- |
| 规划 | 475 s | 含上下文压缩恢复间隙 448 s；实际选行（清单 → `b266-plan.txt`）仅 **27 s** |
| 落笔 | **396 s** | `b266-plan.txt` 22:16:21 → 最后一处返工落盘 22:22:57，含三轮门禁 54 s 与两轮返工 |
| 后测 | 约 370 s | 干净 worktree 全仓扫描 12 s + 15 文件守卫 + 断言 + 产能 + 本批前后测 |

两列口径：

| 列 | 值 | 说明 |
| --- | ---: | --- |
| **落笔段 `s/行`** | **3.96**（396 ÷ 100） | 排期口径的组成单位；本批无宿主失联 |
| 全批 `s/行`（含上下文恢复） | 12.41（1,241 ÷ 100） | 只作历史记录，**不可用于排期** |
| 全批 `s/行`（剔除恢复间隙 448 s） | 7.93（793 ÷ 100） | 同上，仍含每批固定成本 |

**中断判定：有（上下文压缩恢复），但落在规划段，落笔段内无中断**。因此本批进「剔除中断」序列，
且 `s/行` 取落笔段的 **3.96**，不取全批值——全批值把每批固定成本（规划/后测）摊进行单价，
正是旧点估计 2.52 不可排期的原因。

### 3.1 落笔段 `s/行` 序列（趋势观察）

| 批 | b261 | b262 | b263 | b266 |
| --- | ---: | ---: | ---: | ---: |
| 落笔段 `s/行` | 1.90 | 2.17 | 3.04 | **3.96** |
| 中断 | 无 | 无 | 无 | 无（恢复间隙在规划段） |

**单调上升，四批翻 2.1 倍；疑似难度递增（好改的先改完），未插桩证实**——没有逐行计时，
不能排除「批内文件结构差异」这种替代解释。这条趋势是排期偏保守的理由，不是结论。

### 3.2 排期（唯一依据）

```text
剩余 6,225 行 × 2.61 s（四批干净窗口中位数）= 16,247 s ≈ 4.5 h
区间     6,225 行 × 1.90 – 3.96 s（干净批上下界）= 11,828 – 24,651 s ≈ 3.3 – 6.8 h
```

- **b267 起统一用 2.61**；`2.17` 降级为「**仅三批窗口，不用于排期**」，`1.90` 同理只是窗口下界。
- 中位数从 2.17 抬到 2.61 是**加入新样本**的结果，不是 b266 变慢：b266 落笔段含 3 次门禁（54 s），
  扣除后 3.42 s/行，仍在四批窗口内。
- **若 §3.1 的单调上升成立，中位数外推会低估后半程**：剩余批次按区间上界估，不按 2.61 单点下单。
- **禁止用早期批（b261 / b262）的速率外推总工期**——那等于用最快样本代表整段分布。

## 4. 度量前后（同批 5 文件，干净 worktree）

| 指标 | 改前 | 改后 | 变化 |
| --- | ---: | ---: | --- |
| weak 行 | **103** / 667 units | **2** / 667 | −101（100 配额 + 1 池外自清） |
| `substance%` | 68.1 | **86.3** | +18.2 |
| `explain%` | 88.0 | **99.4** | +11.4 |
| `filler%` | 27.9 | **0.0** | −27.9 |
| `uncovered` | 未重测 | 未重测 | 预期不变，非进度指标（b265 §3.1） |

全仓同域（`packages,apps,docs/knip`）：`WEAK lines=9621 files=2025` → `9520 / 2022`，差 **−101 / −3**。

## 5. 七行门禁（`zc-commit.mjs` v12，`--rewrite-annot --base HEAD`）

首轮失败：`新增注释行 n=100 其中判据命中 3`。

```text
WorkflowRunSettingsPopover.tsx:202  L  无信息列举
useTabPersistence.ts:60             L  无信息列举
useWorkspaceActiveTaskState.ts:45   W  单行无信息
```

二次失败：`判据命中 1`——`useWorkspaceActiveTaskState.ts:45` 改完仍有 2 个分隔符（L 判据按分隔符计，
不看是否已有谓词），改成「1 个冒号 + 1 个逗号」后通过。终态：

```text
删本线注释    n=100  （允许，逐行登记）
删代码        n=0
删上游注释    n=0
新增非注释行  n=0
原行搬移      n=0
标点级改写    n=0
新增注释行    n=100  其中判据命中 0  其中嵌套注释 0
expected=5  staged=5
```

## 6. `uncovered` 与本批的收口边界

按 b265 §3.1 的定性，`uncovered` = 「当批文件集内、上方无任何整行注释的代码单元数」，
PLAN#2 只做 1→1 改写、不新增注释行，因此它在每批**构造性不变**，本批不再花一次全量测量去复证。
它也不参与任何进度判断：本批「103 → 2」是 weak，不是 uncovered。

边界同 b265 §3.5：池内清零 **不等于** ZCode 全仓注释完成；当前文件集内另有 4,911 个无整行注释单元属
未承诺范围。禁止用「池清零」暗示全仓做完。

## 7. 趋势：归户错 / 文本错

| 批 | 归户错 | 文本错 | 明细 |
| --- | ---: | ---: | --- |
| b261 | 0 | 4 | 4 L |
| b262 | 0 | 3 | 3 L |
| b263 | 0 | 11 | 10 L + 1 W |
| b264 | 4 | 1 | 4 条删上游注释（选行判据缺陷） |
| b265 | 0 | 4 | 3 L + 1 W |
| **b266** | **0** | **3** | 首轮 2 L + 1 W；二轮 1 L（同一行改法仍不合 L 判据） |

归户错连续两批为 0：池内行 blame 必命中白名单，`up/out` 的 1 行没有进配额。

## 8. 守卫 / 断言 / 产能 / 提交

### 8.1 `weak-guard`（15 文件 cohort，与 b264 同集，与本批 5 文件无交集）

```text
WEAK 15文件  pre=4  post=4  新增=0  max=8  key=file+正文
GUARD PASS
```

pre 取 `b265-guard-post.txt`（b265 批后即本批批前），post 取自干净 worktree（`714cb921`）。

### 8.2 `ledger-assert`

```text
CUM 累计 802 + 剩余 0 = 802  OK
REMAIN 剩余 = 0
CLOSE 802 = 802  OK
ASSERT PASS
```

b266 属 PLAN#2（100 行/批），不计入 802 解包批的收尾等式。

### 8.3 产能与池等式（`--weak` = 干净 worktree 全仓后测）

```text
REMAIN	906	6225	-	454  （剩余；批数为对照/上界，不作为排期依据）
SELF-CLEAR n=1	可写桶 0 / 池外 1 / 上游桶 0 / 未解析 0
ACCT files  done 101 + remain 906 = 1007  OK
ACCT lines  done 1196 + remain 6225 = 7421  OK
ALIGNED acct_remain=6225 pool_remain=6225 diff=0  OK
ASSERT PASS
```

`done 1,096 → 1,196`、`remain 6,325 → 6,225`，两侧各 −100，与 §1「可写 100」逐行吻合。
`7,421` 的域仍是 `packages` / `apps` / `docs/knip` 三根 baseline weak 并集（1,007 文件），域变则不可比。

### 8.4 提交

| 提交 | 内容 |
| --- | --- |
| `714cb921` | 代码（注释）`+100/−100`，5 文件，`expected=5 staged=5` |
| 本台账提交 | `ZC-deep-b266.md`、`ZC-deep-b266-rewrite.tsv`、`_tools/capacity-estimate.mjs`、`_tools/INDEX.md` |

15 个外部会话脏文件全程未进入任何提交路径，`zc-commit` 的提交集合断言负责拦截。

## 9. 收口三断言（指针）

判定仍是 `ZC-deep-b265.md` §9 的 A1/A2/A3：`capacity-estimate` 的 `remain == 0`、
`done + remain == 7,421` 恒等、`ledger-assert PASS`，三条同时成立才算收口。
本批只推进了 `remain`：6,325 → **6,225**，A1 未达成。
