# b244 改写批（8 文件试批 + `// //` 归属审计）

- 日期：2026-11-10
- base：`7237098c`（b243 台账提交，本批改写前 HEAD；8 个文件在工作区均无改动）
- 提交：`a149ef4d b244 改写 (+16/−16)`
- 尺子：`zc-commit v10`（`GATE self=… blob=066509a32c52`）、`zc-gate v3 f75c5e64246f`、`deep-quality v1.9 8042442fe198`
- 本批性质：阈值表触发的 **8 文件试批**（b242 = 24.9、b243 = 10.8 秒/文件，连续两批 < 25）

## 1. 本批选谁

1–2 行档剩余排序取下一组（`deep-quality v1.9`，改前 `--list-weak` 实测）：

| 文件 | 基线标注 | 实测 weak |
| --- | ---: | ---: |
| `packages/ui/src/app-shell/SidePaneTabOverview.tsx` | 2 | 2 |
| `packages/ui/src/app-shell/useAppChromeState.ts` | 2 | 2 |
| `packages/ui/src/app-shell/workflow-artifacts/presets/ArtifactChartView.tsx` | 2 | 6（5 本线 + 1 上游连带） |
| `packages/ui/src/chat-input-toolbar/CodingPlanUsageHeaderAction.tsx` | 2 | 2 |
| `packages/ui/src/chat-input-toolbar/contextUsage.tsx` | 2 | 3（2 本线 + 1 上游） |
| `packages/ui/src/CodingPlanBillingDiscount.tsx` | 2 | 2 |
| `packages/ui/src/CodingPlanUsageRemainingPanel.tsx` | 2 | 2 |
| `packages/ui/src/components/ai-elements/audio-player.tsx` | 2 | 2 |

合计实测 21 行（基线 16，差值来自 `ArtifactChartView.tsx` 的 4 行与 `contextUsage.tsx` 的 1 行上游行——deep-quality 按整文件口径把相邻行一起报出）。

## 2. 归属预检（v6 白名单，31 条）

逐行 `git blame` + `own-commits.mjs --check`：

| sha | 行数 | 判定 | 处置 |
| --- | ---: | --- | --- |
| `a8784b7e`（`snapshot(annot): b1–b226 工作区注释安全快照`） | 16 | 本线 | 改写 16 |
| `872ad960`（`feat: open source`） | 5 | **上游** | 不删不改，登记豁免 |

上游 5 行：

```text
ArtifactChartView.tsx:74    点多到这个数以上就不画点了：一条挤满圆点的线比没有点更难读。
ArtifactChartView.tsx:148   点形是散点图上的次级编码（颜色之外的第二条身份线索），同折线的线型。
ArtifactChartView.tsx:307   （空文本 `*/` 的连带行）
ArtifactChartView.tsx:339   直接标注最新值：图例不只是一块色块 + 名字，它同时是这条序列此刻的读数。
contextUsage.tsx:989        两类同时处于自动提示阶段时，优先展示更晚被观察到的那一类。
```

改写后 `--list-weak` 的 4 条全部落在这 5 行里（`ArtifactChartView.tsx:307` 随 `:74/:148/:339` 同块计数，不单独成行），本线 weak = **0**。

## 3. 门禁七行原文（v10，含 self 行）

```text
GATE self=d:\code\_annot_baseline\zc-commit.mjs blob=066509a32c52
=== 改写门禁（base=HEAD）===
删本线注释    n=16  （允许，逐行登记）
删代码        n=0  （必须 0）
删上游注释    n=0  （必须 0）
新增非注释行  n=0  （必须 0）
原行搬移      n=0  （不变量：不计入改写量、不计入新增注释行数；行号见下方明细）
标点级改写    n=0  （必须 0：去标点后与删除行相同但原文不同）
新增注释行    n=16  其中判据命中 0  （必须 0；已扣除搬移行）
```

提交集合断言（v9 起）：`expected=8  staged=8`。

## 4. TSV 与「删本线注释」逐条对应（16 条 = 门禁 n=16）

登记表：`docs/annotation/ZC-deep-b244-rewrite.tsv`（16 行数据 + 表头）。

| # | 文件:行 | 改写后 |
| --- | --- | --- |
| 1 | `CodingPlanBillingDiscount.tsx:53` | `// 调大 TTL：活动下线后最长一小时仍展示旧福利；调小：每次进入订阅页都多一次远端读取。` |
| 2 | `CodingPlanBillingDiscount.tsx:221` | `// [权衡] iconVisible 只控制 TrendingUpIcon；关掉图标仅减少视觉噪音，badgeBody 文案始终保留。` |
| 3 | `CodingPlanUsageRemainingPanel.tsx:84` | `//   CodingPlanUsageRemainingState 只承载派生结果，渲染分支由消费方按 loading 与 unavailable 自行选择。` |
| 4 | `CodingPlanUsageRemainingPanel.tsx:426` | `//   unavailable 必须三项全空才为真（额度、窗口桶、档位），宁可显示部分额度也不误报不可用；` |
| 5 | `SidePaneTabOverview.tsx:169` | `// filteredTabItems 为空而 filteredRecentClosedItems 非空时 hasAnySearchResult 仍为真：只渲染已关闭分组，不显示占位。` |
| 6 | `SidePaneTabOverview.tsx:200` | `// 收起弹层只更新本地 open 与关键词，不调用父层回调，当前激活页签保持不变。` |
| 7 | `useAppChromeState.ts:39` | `// resolveInitialWindowControlsPaddingPx 优先读平台上报的几何，读不到时回落到默认留白。` |
| 8 | `useAppChromeState.ts:242` | `// 每次 updateState 推送都让 updateStateEventRevisionRef 自增，慢查询回来时比对旧修订号即作废。` |
| 9 | `ArtifactChartView.tsx:308` | `// ChartLegendRow 在全尺寸分支无条件渲染：零序列输入已被上层空态拦掉，此处不再判空。` |
| 10 | `ArtifactChartView.tsx:393` | `// 空数据不在 useMemo 里兜底，由后续空态分支统一决定标题与占位，避免两处判断分叉。` |
| 11 | `CodingPlanUsageHeaderAction.tsx:60` | `// refreshActionState 的 success 只保留 CONTEXT_USAGE_REFRESH_SUCCESS_MS，超时后 setRefreshActionState("idle")。` |
| 12 | `CodingPlanUsageHeaderAction.tsx:114` | `// onClick 里 stopPropagation，阻断冒泡到外层菜单，防止点按钮时连带关闭菜单。` |
| 13 | `contextUsage.tsx:249` | `// CACHE_HIT_RATE_DISPLAY_THRESHOLD 只作用于展示层：开发者面板与埋点仍拿到真实低命中值。` |
| 14 | `contextUsage.tsx:291` | `// formatContextCacheHitRateLabel 返回 null 表示整行不渲染；空串会让调用方误判成「有内容」。` |
| 15 | `audio-player.tsx:47` | `// // [权衡] AudioPlayerProps 从 MediaController 裁掉 audio 字段，调用方无法翻转本组件的音频语义。` |
| 16 | `audio-player.tsx:182` | `// // AudioPlayerSeekForwardButton 与 AudioPlayerSeekBackwardButton 只改插槽与方向，结构样式完全对称。` |

16 删 / 16 增，与 `新增注释行 n=16`、numstat `+16 −16` 一致（差值 0，无需归因）。

第 15/16 条**沿用原双前缀**（`// //`），本批不做去前缀——见 §10。

## 5. 度量与覆盖

| | SUMMARY | RATIOS |
| --- | --- | --- |
| 改前 | `files=8 units=1684 coverage=9.6% branch=21.1% field=1.0% comments=882 substance=86.4% explain=97.6% filler=0.0% weak=2.4%` | `weak=21/882 filler=0/882` |
| 改后 | `files=8 units=1684 coverage=9.6% branch=21.1% field=1.0% comments=882 substance=87.4% explain=99.5% filler=0.0% weak=0.5%` | `weak=4/882 filler=0/882` |

`--list-weak`：21 → 4，剩余 4 条全部为上游 `872ad960` 豁免行。

覆盖差集（按 `path|unitText` 去重取差集）：

```text
UNCOVERED units=1523（去重键 1156）pre → 1523（1156）post
onlyPre=0  onlyPost=0
```

## 6. numstat

```text
+2 −2  packages/ui/src/CodingPlanBillingDiscount.tsx
+2 −2  packages/ui/src/CodingPlanUsageRemainingPanel.tsx
+2 −2  packages/ui/src/app-shell/SidePaneTabOverview.tsx
+2 −2  packages/ui/src/app-shell/useAppChromeState.ts
+2 −2  packages/ui/src/app-shell/workflow-artifacts/presets/ArtifactChartView.tsx
+2 −2  packages/ui/src/chat-input-toolbar/CodingPlanUsageHeaderAction.tsx
+2 −2  packages/ui/src/chat-input-toolbar/contextUsage.tsx
+2 −2  packages/ui/src/components/ai-elements/audio-player.tsx
合计 +16 −16
```

## 7. 三段计时（固定 / 可变 / 返工分列）

| 段 | 打点 | 秒 | 成本性质 |
| --- | --- | ---: | --- |
| T0 → T1（选片、读上下文、blame 归属预检、改前 SUMMARY + uncovered） | 18:02:46.250 → 18:03:40.928 | 54.7 | 固定 |
| T1 → T2（逐文件编辑 16 行） | 18:03:40.928 → 18:03:55.031 | 14.1 | 可变（8 文件） |
| T2 → T2′（改后 `--list-weak` + uncovered 快照） | 18:03:55.031 → 18:04:06.921 | 11.9 | 固定（随 units 增长） |
| **返工 R1**（门禁 3 次迭代：2×L + 1×W，逐条改写重跑） | 18:04:06.921 → 18:05:32.147 | 85.2 | **返工，单独打点** |
| T3（提交） | 18:05:32.147 → 18:05:41.420 | 9.3 | 固定 |
| **合计 == 墙钟** | 18:02:46.250 → 18:05:41.420 | **175.2** | — |

- 每文件均摊（含返工）：175.2 / 8 = **21.9 秒/文件**
- 每文件均摊（不含返工）：90.0 / 8 = **11.25 秒/文件**
- 固定成本合计 54.7 + 11.9 + 9.3 = **75.9 秒**；可变成本 **14.1 秒**；返工 **85.2 秒**

## 8. 8 文件试批的结论：均摊没有下降

| 批次 | 文件数 | 总秒 | 每文件秒 | 备注 |
| --- | ---: | ---: | ---: | --- |
| b240 | 6 | 195.0 | 32.5 | 首跑即过 |
| b241 | 6 | 250.4 | 41.7 | 返工 1 次 |
| b242 | 6 | 149.2 | 24.9 | 返工 1 次（v8 计数洞） |
| b243 | 6 | 65.1 | 10.8 | 零返工 |
| **b244** | **8** | **175.2** | **21.9（含返工）/ 11.25（不含）** | 返工 1 次（3 次门禁迭代） |

结论（按指令口径，先看均摊）：

1. **含返工 21.9 > 10.8**，**不含返工 11.25 > 10.8**——两种口径都**高于** 6 文件的 b243。
2. 原因不是「共享固定成本被摊薄」，恰恰相反：**固定成本不是每批常数，而是随扫描单元数线性增长**。
   b243（1046 units）固定成本 45.8 秒；b244（1684 units）固定成本 75.9 秒，增长 66%，与 units 增长 61% 基本同步。
   所谓「加文件摊薄固定成本」的前提不成立——固定成本的主体是逐单元度量（`deep-quality` 全量扫描 + uncovered 快照），
   不是一次性的读上下文开销。
3. 可变成本本身很低（14.1 秒 / 16 行 = 0.88 秒/行），**文件数不是瓶颈，门禁返工才是**（85.2 秒，占墙钟 49%）。

**处置**：按阈值表回落到 **4–5 个文件/批**。理由写清楚：8 文件批没有带来摊薄收益，反而把单批返工成本放大；
小批的目的不是省时间，而是让「一次门禁失败」只影响更少的行。

## 9. 返工打点（单独）

| # | 触发 | 命中 | 处置 | 区间 | 耗时 |
| --- | --- | --- | --- | --- | ---: |
| R1 | 首跑门禁 | `CodingPlanUsageRemainingPanel.tsx:426` L「无信息列举」、`SidePaneTabOverview.tsx:200` L | 改写这两行 | 18:04:06.921 → 18:05:0x | — |
| R2 | 第二次门禁 | `CodingPlanUsageRemainingPanel.tsx:426` L（去标识符后仍有 3 个分隔符且无谓词） | 加谓词「必须」并收敛列举 | — | — |
| R3 | 第三次门禁 | `CodingPlanUsageRemainingPanel.tsx:426` W「单行无信息」（去掉标识符后失去锚点） | 恢复 `unavailable` 锚点 + 保留谓词 | → 18:05:32.147 | 合计 85.2 |

三次都是同一行反复：**L（列举）与 W（无锚点）是互补判据，改一边就掉到另一边**。
正确写法必须同时满足：有标识符锚点（W）+ 有谓词或分隔符 < 2（L）。这条写进 INDEX §9 缺陷族的「判据互斥」备注。

## 10. `// //` 双前缀归属审计（指令第 2 件，先判归属、不清理）

### 10.1 口径

`grep -c '^\s*// //'` 全仓（排除 node_modules）命中 **804 行 / 17 个文件**，其中 2 处不是代码注释
（`docs/annotation/_tools/d7e-shift.mjs` 1 行、`docs/webdriverio/docs/ocr-testing/ocr-faq.md` 1 行），
代码文件 **802 行 / 15 个文件**。

### 10.2 逐文件 blame

| 文件 | 双前缀行 | blame 归属 |
| --- | ---: | --- |
| `apps/zcode-cli/packages/tui/src/app-view.tsx` | 68 | `a8784b7e` 68 |
| `apps/zcode-cli/packages/tui/src/app-sidebar.tsx` | 48 | `a8784b7e` 46、`18e274fc` 2（b243 沿用） |
| `apps/zcode-cli/packages/tui/src/app-events.ts` | 39 | `a8784b7e` 39 |
| `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts` | 1 | `a8784b7e` 1 |
| `packages/shared/src/workspace-hook-digest.ts` | 60 | `a8784b7e` 60 |
| `packages/ui/src/v4/conversationTurnNavigatorHelpers.ts` | 64 | `a8784b7e` 64 |
| `packages/shared/src/git.ts` | 62 | `a8784b7e` 62 |
| `packages/ui/src/store/offPeakTaskStore.ts` | 68 | `a8784b7e` 68 |
| `packages/ui/src/components/ai-elements/audio-player.tsx` | 42 | `a8784b7e` 40、`a149ef4d` 2（本批沿用） |
| `packages/ui/src/browser-use/ResponsiveBrowserViewport.tsx` | 68 | `a8784b7e` 68 |
| `packages/ui/src/settings/CommandForm.tsx` | 42 | `a8784b7e` 42 |
| `packages/ui/src/rewards/RewardsWebview.tsx` | 55 | `a8784b7e` 55 |
| `packages/ui/src/feedback/FeedbackBackgroundUploadIndicator.tsx` | 60 | `a8784b7e` 60 |
| `packages/ui/src/lib/pptxElementReference.ts` | 65 | `a8784b7e` 65 |
| `packages/ui/src/lib/usageEntitlementRefreshPolicy.ts` | 60 | `a8784b7e` 60 |
| **合计** | **802** | **本线 802 / 上游 0** |

### 10.3 归属结论

**全部是本线，没有一行是上游。** 证据链：

1. `a8784b7e` 是 `snapshot(annot): b1–b226 工作区注释安全快照`，把当时工作区整棵树一次性提交（1726 文件、+146860）；
2. 取该提交的父提交 `8f7daaf0` 对比：`packages/shared/src/git.ts` 父版本 317 行、双前缀 0 行，HEAD 版本双前缀 62 行；
   `app-view.tsx` 的正文在原父提交里**不存在**（`git grep` 计数 0）；
3. 因此这 802 行是 b1–b226 注释期由本线的插入动作产生的「本线新增注释 + 再多包一层 `//`」，
   不是「上游注释被本线包了一层」。

### 10.4 缺陷族登记

形态：**门禁只看新增行的形状（是否注释、是否过 W/L/POEM），看不见「新增行是否被更高一层注释掉」。**
`// // 正文` 在门禁里被 `contentOf` 剥掉一层后变成 `// 正文`，仍算「注释行」，
W/L/POEM 里 `ident()` 可能命中正文里的英文标识符，于是整行通过；双前缀本身没有任何判据。

实测证据：把 802 行各自**再剥一层**后交给 `zc-gate.judgeEntries`，命中 **144 行**（W 为主，少量 L）——
即双前缀当前掩盖了约 144 行本应被改写的注释。

同类缺陷族（均属「门禁只看新增行形状」）：

| # | 形态 | 出现批次 | 后果 |
| --- | --- | --- | --- |
| 1 | valkey 宏续行 | 早期批 | 续行被当成独立新增行，锚点误判 |
| 2 | drizzle 参数列表插入 | 早期批 | 插入位置在括号内，形状合法但语义错位 |
| 3 | JSDoc `*` / `/*` 行不计入 | b237–b240 | `新增注释行` 分子蒸发（v8/v10 已补） |
| 4 | **`// //` 双层前缀** | b1–b226（802 行） | 双前缀不可见，约 144 行水句被掩盖 |

**本批不清理**，按指令先给归属结论。清理立项需单独判断两件事：
(a) 802 行逐块去一层 `//` 是否改变可读性/排版；(b) 去掉后 144 行命中如何分批消化。

## 11. 白名单与 capacity 断言

白名单 `own-commits.mjs --check`：

```text
a8784b7e479d3a5864dec41d706d4aa4ecbc6703	本线
872ad960de7ec172591f7e1952f7849229f94521	上游	（未解析）
```

capacity-estimate（`--per-batch-map ">=20:2,5-9:3,1-2:6"`，b244 登记表纳入后）：

```text
baseline files=1007 lines=7421   done files=53 lines=569
band	files	lines	perBatch	batches
>=20	48	1002	2	24
10-19	285	3938	2	143
5-9	146	963	3	49
3-4	159	543	2	80
1-2	316	406	6	53
SUM	954	6852	-	349
ASSERT PASS
```

三条恒等式通过：Σ档位文件 954 == 1007 − 53；Σ档位行 6852 == 7421 − 569；Σ批数 349 == 24+143+49+80+53。

## 12. 下一步

1. b245 按 §8 结论回落 **4–5 个文件/批**；
2. `// //` 清理单独立项（§10.4），先决定「去一层前缀」是否作为一批；
3. 门禁新增一条形状判据（检测 `// //` / `* *` 双层嵌套）前，先归档新版并记 INDEX「首个使用批次」。
