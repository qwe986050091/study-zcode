# ZC-deep-b257：B9「usageEntitlementRefreshPolicy + app-events」去双前缀（99 行 / 2 文件）

- 日期：2026-11-10
- 批次：B9（15 文件清单第 9 个，合批 2 文件）
- 目标文件：`packages/ui/src/lib/usageEntitlementRefreshPolicy.ts`（12 + 48 = 60）、`apps/zcode-cli/packages/tui/src/app-events.ts`（2 + 37 = 39）
- 本批行数：99（144 类 14 + 658 类 85）
- 代码提交：`8626e043 b257 B9 去双前缀 (+99/−99)`
- 尺子：`deep-quality` **v2.0**（blob `756bea66122a`）+ `zc-gate` v4（`633b334905ee`）+ `zc-commit` v12（`a35b42fa2e4c`）+ `own-commits` v2（`f56b84fbf964`）+ `ledger-assert` `1836c9034a66`

## 0. `684` 与 `2` 的口径：单位不同，不是文件差

**结论：`684` 是两个不同量纲相减得到的错数，不存在「682 个文件」需要拆。**

`10,175` 是 `RATIOS weak=10175/331156` 的**分子，即 weak 注释行数**；`9,491` 是 `SUMMARY files=9491` 的**文件数**。行数减文件数没有意义。

两作用域**在同一提交 `c40c4d70`** 上实测（v2.0；主工作区额外带别的会话的未提交改动）：

| 作用域 | 提交 | files | units | comments | weak |
| --- | --- | ---: | ---: | ---: | ---: |
| 干净 worktree `D:/code/_b257_same` | `c40c4d70`（detached） | 9,491 | 1,263,663 | 329,480 | **10,084**（3.1%） |
| 主工作区 `D:/code/ZCode` | `c40c4d70` + 别的会话未提交改动 | 9,493 | 1,265,099 | 331,156 | **10,175**（3.1%） |
| Δ（主 − 干净） | — | **+2** | +1,436 | **+1,676** | **+91** |

三个差值同一量纲，可以相减；`684` 不在此列。

**`+2` 文件是哪两个**（v2.0 口径，产物目录已跳过）：

| 文件 | 注释行 |
| --- | ---: |
| `apps/zcode-cli/packages/dynamic-workflow/src/compiler/libs.generated.ts` | 4 |
| `apps/zcode-cli/packages/browser-use-plugin/scripts/browser-client.mjs` | 31 |

**`+1,676` 注释行完整拆解**：新增 2 文件 35 行 + 15 个共同文件被别人加注 **+1,641** 行 = 1,676（`b257-reconcile.mjs`）。加注 top 5：`sqlite-session-store.ts` +279、`background-tasks.ts` +207、`mcpSyncService.ts` +205、`file-rewind.ts` +196、`rewind.ts` +116。**+91 weak 全部落在这 15+2 个文件内**，与本线无关。

**产物为什么不再出现在差集里**：v1.9 跳过表缺 `out / dist-* / bundled-agents`，同一主工作区会多出 216 个产物文件 / 27,048 条注释行（`packages/desktop/out` 199 个，`b256-scope.mjs` 以 v1.9 跳过表可复现）。v2.0 之后这部分归零，剩下的 2 个才是真源码文件。

**更正**：b256 §0 写的 `+90 weak` 是拿主工作区与 `8a4d8e02` 快照（`10,085`）跨提交相减所得；同提交 `c40c4d70` 干净 worktree 为 `10,084`，正确差值 **+91**。`_tools/INDEX.md` §5.3 已同步更正。

**里程碑判定**：两作用域同提交，差异只来自别的会话的未提交改动，**不属于「工作区或提交不一致」**，不单独发报告。

## 1. 三条收尾断言（v2.0 口径；v1.9 只作历史引用）

| # | 断言（v2.0 生效文本） | v2.0 当前值 | v1.9 历史值（仅引用，**不得相减**） |
| --- | --- | --- | --- |
| 1 | 全仓 weak 率 **≤ 3.1%（v2.0 口径，分母 329,480）**，输入取干净 worktree | B1 前 `10,085/329,480`；B9 后分子不变、本线不新增 weak | `10,085/329,503`（分母差 23，分子同） |
| 2 | **v2.0 复测**：本工程 15 文件 weak 绝对数 ≤ B1 前 `8/3353` | B1 前 `8/3353`；B7 后 `7/3353` | 两版同值 `8/3353`、`7/3353` |
| 3 | 每批新增/改写行 ∩ weak = ∅ | B9：99 行改写后 `judgeEntries` 0 命中；当批 weak `3/203 → 2/203` | — |

第 1 条的分母已随换版改变（少 23 条注释、75 units），所以断言文本必须写「v2.0 口径下 ≤ 3.1%（分母 329,480）」；v1.9 的 3.1% 与 v2.0 的 3.1% 分子相同、分母不同，**不得相减**。

## 2. 三列滚动行（`ledger-assert` 输出）

```text
批次表：15 文件 / 计划合计 802 行
BATCH ZC-deep-b248-rewrite.tsv	68 行
BATCH ZC-deep-b249-rewrite.tsv	64 行
BATCH ZC-deep-b250-rewrite.tsv	62 行
BATCH ZC-deep-b251-rewrite.tsv	68 行
BATCH ZC-deep-b252-rewrite.tsv	65 行
BATCH ZC-deep-b253-rewrite.tsv	60 行
BATCH ZC-deep-b255-rewrite.tsv	49 行
BATCH ZC-deep-b256-rewrite.tsv	68 行
BATCH ZC-deep-b257-rewrite.tsv	99 行
SUM 各批 = 68 + 64 + 62 + 68 + 65 + 60 + 49 + 68 + 99 = 603  OK（逐文件登记数 == 批次表计划数）
ROLL 144  计划 144  累计 114  剩余 30  OK
ROLL 658  计划 658  累计 489  剩余 169  OK
ROLL 802  计划 802  累计 603  剩余 199  OK
CUM 累计 603 + 剩余 199 = 802  OK
PLAN 批次表合计 802  = 802  OK
GREP 全仓 201 = 清单内 199 + 清单外 2  OK
OUTSIDE docs/annotation/_tools/d7e-shift.mjs:1 , docs/webdriverio/docs/ocr-testing/ocr-faq.md:1
REMAIN 剩余 = 199
ASSERT PASS
```

## 3. B9 之后的切批预判：不会出现 `Bx-1 / Bx-2`

剩余 199 行 / 3 批，按 `ZC-deep-b247.md` 批次表原样执行：

| 批 | 文件 | 144 | 658 | 合计 | 文件数 |
| --- | --- | ---: | ---: | ---: | ---: |
| B10 | `packages/ui/src/components/ai-elements/audio-player.tsx` | 6 | 36 | 42 | 2 |
| B10 | `packages/ui/src/rewards/RewardsWebview.tsx` | 10 | 45 | 55 |  |
| B11 | `packages/ui/src/settings/CommandForm.tsx` | 8 | 34 | 42 | 1 |
| B12 | `packages/ui/src/feedback/FeedbackBackgroundUploadIndicator.tsx` | 6 | 54 | 60 | 1 |

- 单文件最大 **60 行**（B12），全部 < 100，**不会触发** `>100 行文件切 `Bx-1 / Bx-2`` 规则。
- 单批最大 **97 行**（B10，2 文件），< 100，也不触发批上限。
- 平均 199 ÷ 3 = 66.3 行/批；B10 是唯一合批，B11 / B12 单文件成批。
- 切批规则（b250 写死）保持待用但不启用：符号边界 → 逻辑段 → 行数硬切，硬切只落空行或注释块边界。

## 4. B9 分类（99 行）

双前缀 99 行 = `usageEntitlementRefreshPolicy.ts` 60 + `app-events.ts` 39；判据命中 **14 行（L 6 / W 8）**，其余 85 行只去一层前缀。

| 文件:行 | 判据 | 改前 | 改写后 |
| --- | --- | --- | --- |
| usage:76 | L（`、`×3 无谓词） | `计数只在购买、鉴权切换这类显式失效时自增，普通刷新沿用当前代，因此同一 key 上` | 列举改「与」+「而」，删「因此」 |
| usage:84 | L（2 逗号无谓词） | `…调用方拿 requestKey 带进请求，` | 补「后」，接续下一行 |
| usage:86 | L（2 逗号无谓词） | `读代数与写代数之间没有 await，单线程下这段是原子的；` | 补「而」连接两个分句 |
| usage:118 | W（无标识符） | `用途是给同一身份的访问类刷新去重：设置页、侧栏、推荐入口可能同时挂载，` | 补 `useUsageStats` 消费者 + 「因为」 |
| usage:124 | L（2 逗号无谓词） | `…不读系统时钟也不写状态，[并发] 因此它是可重入的纯查询。` | 「因此」→「所以」（入 PREDICATE） |
| usage:151 | W（无标识符） | `…拼出同一个键。` | 「键」→ `requestKey` |
| usage:206 | W（无标识符） | `区分字段缺失与值为 0 两种表示。` | 补 `nextAllowedAt` |
| usage:207 | W（无标识符） | `…订阅者回调里读到的必然是新快照；` | 补 `listener` |
| usage:208 | W（无标识符） | `…回调中读到的还是旧值，…` | 「旧值」→ `snapshot` |
| usage:210 | W（无标识符） | `因此不额外复制数组，…` | 补 `listeners` |
| usage:305 | W（无标识符） | `间隔比较用小于等于，…` | 「小于等于」→ `intervalMs` 比较对象 |
| usage:308 | W（无标识符） | `拷贝反而让同一份数据在每个调用点各有一份，…` | 「数据」→ `snapshot` |
| app-events:65 | L（2 逗号无谓词） | `…缺失时统计走原始路径，跨平台分隔符可能对不上。` | 补「而」 |
| app-events:109 | L（2 逗号无谓词） | `分发函数无状态、无缓存：…得到同一状态，重放安全的前提…` | 「、」→「且」，补「而」 |

## 5. 门禁七行（`zc-commit` v12，blob `a35b42fa2e4c`）

```text
删本线注释    n=99  （允许，逐行登记）
删代码        n=0
删上游注释    n=0
新增非注释行  n=0
原行搬移      n=0
标点级改写    n=0
新增注释行    n=99  其中判据命中 0  其中嵌套注释 0
提交集合断言  expected=2  staged=2
```

三源一致：numstat `+60−60` + `+39−39` = 99 = TSV 99 行 = 门禁 99 行。复核：改前 99 行全部形如 `// //`（26 行带缩进）、改后 99 行全部形如 `// `、残留双前缀 0。EOL 两文件均 CRLF（363 / 536 行不变）。

## 6. 度量（SUMMARY 前后）

| 文件 | units | comments | coverage | substance pre → post | explain pre → post |
| --- | ---: | ---: | ---: | --- | --- |
| `app-events.ts` | 274 | 122 | 16.1% | 86.1% → 86.1% | 98.4% → 98.4% |
| `usageEntitlementRefreshPolicy.ts` | 176 | 81 | 5.1% | 82.7% → **88.9%** | 98.8% → **100.0%** |
| 合计 | 450 | 203 | 11.8% | 84.7% → **87.2%** | 98.5% → **99.0%** |

weak：`3/203` → `2/203`（1.5% → 1.0%）。units / comments 逐值不变，去前缀与 14 行 1→1 改写都没有改变分母。

## 7. 覆盖差集

`--uncovered` pre 397 行 / post 397 行，`onlyPre=0`、`onlyPost=0`：改写只动注释文本，未改变任何覆盖单元。

## 8. 三态（改前 blame）

99 行全部来自 `a8784b7e479d`（`app-events.ts` 39 行 + `usageEntitlementRefreshPolicy.ts` 60 行，无第二个 sha）：`CHECK own=1 upstream=0 pending=0`。

## 9. 回读三条（只去前缀、未改写）

```text
usage:145  // 少一个字段，两个语义不同的请求就共用一份快照，用户会看到不属于当前身份的数据。
usage:237  // [权衡] 冷却按 key 累计而不按账号累计：同一账号在不同 provider 下的失败原因不同，
app-events:62  // 带 ? 的 setter 表示宿主可降级：缺 setModifiedFiles 就不显示 diff，缺 setQueuedInputs 就不刷排队条。
```

三条剥一层后语义完整、均有标识符或谓词锚点，不判 144；`judgeEntries` 0 命中。

## 10. 计时

- 起：19:11:06（本轮首份 B9 证据 `b257-same-v20.txt` 落盘）
- 止：19:13:18（提交 `8626e043`）
- 合计 **132s**，`132 / 99 = 1.33 s/行`
- 下限口径：改前字节落盘 19:12:33 → 提交 45s（不含分类与改写，**不作批成本**）
- 返工 0
- 阈值 0.85–2.85 为**拍定值**（1.7 × 0.5 / 1.7 × 1.5），1.33 在区间内

## 11. 下一步

B10：`packages/ui/src/components/ai-elements/audio-player.tsx`（6+36=42）+ `packages/ui/src/rewards/RewardsWebview.tsx`（10+45=55），合计 **97 行 / 2 文件**。此后 B11 `CommandForm.tsx` 42、B12 `FeedbackBackgroundUploadIndicator.tsx` 60，收口 802。
