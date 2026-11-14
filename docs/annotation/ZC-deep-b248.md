# b248 B1 去双前缀（`offPeakTaskStore.ts` 68 行 = 144 侧 10 + 658 侧 58）

- 日期：2026-11-10
- base：`8a4d8e02`（b247 台账提交，本批前 HEAD）
- 提交：`a08969d2 b248 B1 去双前缀 (+68/−68)`
- 尺子：`zc-commit v11`（`GATE self=… blob=3c65b811b847`）、`zc-gate v4`（`633b334905ee`）、`deep-quality v1.9`（`8042442fe198`）、`own-commits v2`（`f56b84fbf964`）
- 本批性质：802 行立项第 1 批；三件跟办（白名单三态 / 144 处置写死 / 144 逐行上界）先办后改

## 1. 跟办 1：白名单判据改三态，堵掉 fail-open

### 1.1 问题

`own-commits.mjs` v1 的 `--check` 只查「这个 sha 在不在白名单的 short 映射里」：

```js
const full = wl.short.get(sha) ?? (wl.commits.has(sha) ? sha : null);
```

不在就打印 `上游 (未解析)`。`aac47556` 因此在 b247 被记成「上游、不必改」——它其实能从 git 解析出来，
只是没被台账抽到。**「不知道」拿到了「安全结论」，这是 fail-open。**

### 1.2 改法（`own-commits.mjs` v2，blob `f56b84fbf964`）

```text
resolveCommit(repo, sha)   git rev-parse --verify <sha>^{commit}，失败 → null
classifySha(repo, sha, wl) 解析失败 → 未解析；full ∈ 白名单 → 本线；否则 → 上游（附 author + subject）
--check                    三态逐条打印 + CHECK own=/upstream=/pending=；pending>0 → exit 3
```

未解析的处置写进 `OWN-COMMITS.md` §3 规则 3：必须人工定归属（`git log -1 --format='%an %ae %s'`、
是否在批次台账）→ 回填白名单 → 才允许放过；未回填的单列「待定 n 条」，计入未完成。

### 1.3 本批 `--check` 原文

```text
a8784b7e	本线	a8784b7e479d3a5864dec41d706d4aa4ecbc6703	台账	snapshot(annot): b1–b226 工作区注释安全快照（未逐批验证） (+146860)
aac47556	上游	aac4755666d09fdcd70272fcf063c077a639015f	wuweiqi <weiqi.wu@aminer.cn>	feat: update to v3.15.1
872ad960	上游	872ad960de7ec172591f7e1952f7849229f94521	wuweiqi <weiqi.wu@aminer.cn>	feat: open source
CHECK own=1 upstream=2 pending=0
```

负例（fail-closed 验证）：

```text
deadbeefdeadbeef	未解析	(未解析)	(无 commit 证据)
CHECK own=0 upstream=0 pending=1
未解析 1 条：必须人工定归属…并回填白名单后才允许放过；未回填的计入「待定」，不算豁免。
exit=3
```

**b247 遗留的 `aac47556` 由此结案**：不是待定，是上游，证据为作者 `wuweiqi` + 标题 `feat: update to v3.15.1`。
本批「待定 n 条」= **0**。

## 2. 跟办 2：144 侧处置方式写死为「逐行改写（1→1）」

- **规则**：144 行一律逐行改写，行数不变；不删除、不合并。理由：这 10 行都是同一 prose 块内的续行，
  删除会打断块的解释链；而合并续行会让 numstat 出现净减，把「去前缀」和「删内容」混在一张账上。
- **因此 numstat 预说明成立**：全项目 `+802 −802`，B1 实测 `68 68`。**不是净删除**。
- **capacity 口径**：`done lines` 统计的是基线 weak 行数之和，不随删行变化；B1 只让 `done files +1`。

## 3. 跟办 3：144 标注为「逐行上界」+ 滚动行

144 是逐行判定的上界：块内续行单独判会因缺锚点落 W。本批按块复核了全部 10 行，10 行均为真水
（不是「块内有锚点、单行被误判」），故逐行改写，无一行因块级复核而豁免。

| 口径 | 计划 | B1 实测 | 累计实测 | 剩余 |
| --- | ---: | ---: | ---: | ---: |
| 144 侧（水，改写） | 144 | 10 | 10 | 134 |
| 658 侧（合格，去前缀） | 658 | 58 | 58 | 600 |
| **合计** | **802** | **68** | **68** | **734** |

144 实测 = 计划，无偏差；若后续批次出现「块级复核后低于计划」，在同一张表里回填，收尾时以累计实测对 802 收账。

## 4. 门禁七行原文（v11）

```text
GATE self=d:\code\_annot_baseline\zc-commit.mjs blob=3c65b811b847
=== 改写门禁（base=HEAD）===
删本线注释    n=68  （允许，逐行登记）
删代码        n=0  （必须 0）
删上游注释    n=0  （必须 0）
新增非注释行  n=0  （必须 0）
原行搬移      n=0  （不变量：不计入改写量、不计入新增注释行数；行号见下方明细）
标点级改写    n=0  （必须 0：去标点后与删除行相同但原文不同）
新增注释行    n=68  其中判据命中 0  其中嵌套注释 0  （必须 0；已扣除搬移行）
```

提交集合断言：`expected=1  staged=1`。

说明：本批 subject 传了「b248 B1 去双前缀 (+68/−68)」，zc-commit 会自行追加数字，最终标题重复了一次
（`… (+68/−68) (+68/−68)`）。只影响可读性；后续批次 subject 不再带数字。

## 5. TSV 与「删本线注释 n=68」逐条对应

`ZC-deep-b248-rewrite.tsv`：1 行表头 + **68 行**，与门禁 `n=68` 相等；68 行 blame 全为 `a8784b7e479d3a`（本线）。

### 5.1 144 侧 10 行（改前 → 改后，均 1→1）

| # | 行 | 改前（剥一层后） | 改后 |
| --- | ---: | --- | --- |
| 1 | 174 | 复位时同时比对持有者身份，避免旧一轮清掉新一轮的句柄。 | 复位时同时比对 `initializeInFlight` 的持有者身份，避免旧一轮清掉新一轮的句柄。 |
| 2 | 202 | 两路都就地兜底成空值：灰度拉不到只影响入口可见性，列表拉不到只影响首屏行数， | 两路都就地兜底成空值：`grayConfig` 拉不到只影响入口可见性，而 `tasks` 拉不到只影响首屏行数。 |
| 3 | 205 | 此处拿不到区分「服务不可用」与「确实没有数据」的依据， | `grayConfig` 与 `tasks` 的降级结果拿不到区分「服务不可用」与「确实没有数据」的依据， |
| 4 | 261 | renderer 侧只有脱敏快照，比内容既判断不出「变了」也判断不出「没变」， | renderer 侧只有脱敏快照：比凭据内容既判断不出「变了」也判断不出「没变」， |
| 5 | 284 | 中途到达的新触发写入待办并在本轮结束后被接走，既不丢也不重复。 | 中途到达的新触发写入 `pendingEligibilityService`，由本轮结束后接走，既不丢也不重复。 |
| 6 | 305 | idle 与 error 的区别是语义的：前者表示「无需读」，后者表示「读过但坏了」， | `takeNumberAvailabilityStatus` 的 idle 与 error 语义不同：idle 表示「无需读」，而 error 表示「读过但坏了」， |
| 7 | 346 | 入参 permissionMode 的取值收窄放在服务端，store 只透传， | 入参 permissionMode 的取值收窄放在服务端，而 store 只透传， |
| 8 | 347 | 避免枚举在两端各写一份而慢慢分叉。 | 避免 permissionMode 枚举在两端各写一份而慢慢分叉。 |
| 9 | 356 | [并发] 刷新期间 operationId 仍是 create，按钮据此继续禁用提交， | [并发] 刷新期间 operationId 仍是 create，而按钮据此继续禁用提交， |
| 10 | 445 | 而本地列表已按第一个结果渲染，出现「界面已取消、实际仍在跑」。 | 而 tasks 已按第一个结果渲染，出现「界面已取消、实际仍在跑」。 |

命中类型（改前）：W=5（174/202/205/284/347）、L=5（261/305/346/356/445）。
改后：`judgeEntries` 68 行命中 **0**（脚本 `b248-b1-unwrap.mjs` 落盘前断言，失败则拒绝写入）。

### 5.2 658 侧 58 行

只去一层前缀：`// // X` → `// X`，正文逐字不变。TSV 已逐行登记原行，行号与 base 一致（行数未变）。

## 6. 度量与覆盖

| | SUMMARY | RATIOS |
| --- | --- | --- |
| 改前（`8a4d8e02`） | `files=1 units=219 coverage=11.9% branch=16.7% field=28.0% comments=113 substance=89.4% explain=100.0% filler=0.0% weak=0.0%` | `weak=0/113` |
| 改后（`a08969d2`） | `files=1 units=219 coverage=11.9% branch=16.7% field=28.0% comments=113 substance=92.0% explain=100.0% filler=0.0% weak=0.0%` | `weak=0/113` |

本线 weak 不增（0 → 0）；substance 89.4% → 92.0%（去前缀后正文被计入实质率）。

覆盖差集（按 `path|unitText` 去重，改前用 `git worktree add --detach HEAD~1` 取快照）：

```text
UNCOVERED units=153（去重 153）
onlyPre=0  onlyPost=0
```

## 7. numstat

```text
+68 −68  packages/ui/src/store/offPeakTaskStore.ts
合计 +68 −68（502 行 → 502 行，非净删除）
```

## 8. 三段计时（返工单列）

| 段 | 打点 | 秒 | 归类 |
| --- | --- | ---: | --- |
| T0 → T1（三态白名单改造 + 68 行分类 + 改前快照/metrics + 改写脚本） | 18:19:00 → 18:24:37 | 337 | **一次性** |
| T1 → T2（落盘 68 行） | 18:24:37 → 18:24:44 | 7 | 常规 |
| T2 → T3（门禁 + 提交） | 18:24:44 → 18:25:03 | 19 | 常规 |
| **合计 == 墙钟** | 18:19:00 → 18:25:03 | **363** | 一次性 337 / 常规 26；返工 **0s** |

> 分账说明（b249 起修订）：337s 是 own-commits v2、分类脚本与改前快照的一次性投入，**不计入产能均值**，
> 否则会得出「每批 6 分钟」的错误预期。本批常规成本只有 26s。

提交后补跑改后度量（deep-quality 改后 + 覆盖 post + worktree 清理）：18:25:03 → 18:26:15，**72s**，单列。
T0 取 b247 台账提交时刻（`8a4d8e02` 18:19:00），T3 取 `a08969d2` 提交时刻。

## 9. capacity 断言

```text
done = 68 个文件（不含 802 项目）  lines=593
1-2 档剩余 301 文件 / 382 行
SUM 939 文件 / 6828 行 / 471 批
ASSERT PASS
```

> 口径说明（b249 起修订）：这里的 68 是**基线文件数**，与「B1 解包 68 行」同值纯属巧合，不是同一件事。
> 802 项目的产出单列：B1 68 行 / 1 批。

`offPeakTaskStore.ts` 不在 1007 文件基线里（基线只收有本线 weak 的文件），所以 B1 不让 `done files` 变化；
`done lines` 恒 593（基线 weak 口径，不随解包变）。**B1 的产出不进 capacity 的分子，capacity 只作剩余体量参照。**

## 10. 下一步

1. 按 §8.2 批次表执行 B2（`conversationTurnNavigatorHelpers.ts`，15 + 49 = 64）；
2. 每批四条验收：本线 weak 不增 / `onlyPre/onlyPost` 有据 / `其中嵌套注释 = 0` / 门禁 n = TSV 行数；
3. 滚动行（计划 144 / 实测累计 / 剩余）每批回填。
