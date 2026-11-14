# b247 改写批（5 文件 + 802 行处置顺序与立项计划）

- 日期：2026-11-10
- base：`c90fe5df`（b246 台账提交，本批改写前 HEAD）
- 提交：`6269b765 b247 改写 (+5/−5)`
- 尺子：`zc-commit v11`（`GATE self=… blob=3c65b811b847`）、`zc-gate v4`（`633b334905ee`）、`deep-quality v1.9 `8042442fe198``
- 本批性质：b246 收下后继续 5 文件；跟办 802 行处置顺序调整与立项拆分

## 1. 本批选谁

1–2 行档剩余排序取下一组（`deep-quality v1.9`，改前 `--list-weak` 实测 7 行）：

| 文件 | 实测 weak |
| --- | ---: |
| `packages/ui/src/settings/MigrationSection.tsx` | 1 |
| `packages/ui/src/settings/OffPeakEditView.tsx` | 1 |
| `packages/ui/src/settings/PluginsSection.tsx` | 1 |
| `packages/ui/src/settings/usage-stats/UsageHeatmap.tsx` | 1 |
| `packages/ui/src/v4/composer/V4ComposerToolbar.tsx` | 3 |

## 2. 归属预检（v6 白名单，31 条）

| sha | 行数 | 判定 | 处置 |
| --- | ---: | --- | --- |
| `a8784b7e` | 5 | 本线 | 改写 5 |
| `872ad960` | 1 | **上游** | 不删不改（`V4ComposerToolbar.tsx:612`） |
| `aac47556` | 1 | **上游**（`--check` 未解析） | 不删不改（`V4ComposerToolbar.tsx:626`） |

上游 2 行：

```text
V4ComposerToolbar.tsx:612  当前视口是否为手机输入布局。
V4ComposerToolbar.tsx:626  模型翻页完成并静置后播放一次扫光。
```

改写后 `--list-weak` 剩 2 条，正是这两行；本线 weak = **0**。

## 3. 门禁七行原文（v11）

```text
GATE self=d:\code\_annot_baseline\zc-commit.mjs blob=3c65b811b847
=== 改写门禁（base=HEAD）===
删本线注释    n=5  （允许，逐行登记）
删代码        n=0  （必须 0）
删上游注释    n=0  （必须 0）
新增非注释行  n=0  （必须 0）
原行搬移      n=0  （不变量：不计入改写量、不计入新增注释行数；行号见下方明细）
标点级改写    n=0  （必须 0：去标点后与删除行相同但原文不同）
新增注释行    n=5  其中判据命中 0  其中嵌套注释 0  （必须 0；已扣除搬移行）
```

提交集合断言：`expected=5  staged=5`。

## 4. TSV 与「删本线注释」逐条对应（5 条 = 门禁 n=5）

| # | 文件:行 | 改写后 |
| --- | --- | --- |
| 1 | `MigrationSection.tsx:237` | `// scanLimit 来自数字输入，产不出「不限」哨兵；哨兵分支只留给 programmatic 调用方` |
| 2 | `OffPeakEditView.tsx:406` | `// model 变化属于重要改动：即使 prompt 与 title 未变，也要走 discard 确认。` |
| 3 | `PluginsSection.tsx:427` | `// visiblePluginGroups 驱动渲染，installedPluginCount 决定是否显示「一个都没装」的空态。` |
| 4 | `UsageHeatmap.tsx:96` | `// 不要为省一次计算就改读末列单元格：pad 过的末列可能是空单元格，会让 count 失真。` |
| 5 | `V4ComposerToolbar.tsx:1616` | `// modelSelectGroups 为空但 showManageModelsAction 为真时仍要露出入口，否则零模型用户进不去设置。` |

5 删 / 5 增，差值 0。

## 5. 度量与覆盖

| | SUMMARY | RATIOS |
| --- | --- | --- |
| 改前 | `files=5 units=2363 coverage=15.8% branch=31.5% field=26.3% comments=1325 substance=87.8% explain=99.5% filler=0.0% weak=0.5%` | `weak=7/1325` |
| 改后 | `files=5 units=2363 coverage=15.8% branch=31.5% field=26.3% comments=1325 substance=88.0% explain=99.8% filler=0.0% weak=0.2%` | `weak=2/1325` |

`--list-weak`：7 → 2（2 条全为上游）。

覆盖差集：

```text
UNCOVERED units=1554（去重键 1554）pre → 1554 post
onlyPre=0  onlyPost=0
```

## 6. numstat

```text
+1 −1  packages/ui/src/settings/MigrationSection.tsx
+1 −1  packages/ui/src/settings/OffPeakEditView.tsx
+1 −1  packages/ui/src/settings/PluginsSection.tsx
+1 −1  packages/ui/src/settings/usage-stats/UsageHeatmap.tsx
+1 −1  packages/ui/src/v4/composer/V4ComposerToolbar.tsx
合计 +5 −5
```

## 7. 三段计时

| 段 | 打点 | 秒 | 性质 |
| --- | --- | ---: | --- |
| T0 → T1（选片、读上下文、blame、改前快照） | 18:17:14.797 → 18:17:38.141 | 23.3 | 固定 |
| T1 → T2（编辑 5 行） | 18:17:38.141 → 18:17:39.912 | 1.8 | 可变 |
| T2 → T3（改后快照 + 门禁 + 提交） | 18:17:39.912 → 18:17:58.266 | 18.4 | 固定 |
| **合计 == 墙钟** | 18:17:14.797 → 18:17:58.266 | **43.5** | — |

每文件均摊：43.5 / 5 = **8.7 秒/文件**。零返工。

## 8. 802 行处置顺序与立项计划

### 8.1 顺序：先 144 行（水），再 658 行（去前缀）

原因：去前缀把死注释变成活注释。若先做 658，那 144 行会立刻以 weak 形式出现在 `deep-quality` 里，
等于自己制造一批新问题再收拾，而且「改后 weak 不增」这条验收当场就不成立。先清 144 再解包 658，
每一步的 weak 只降不升。

### 8.2 批次拆分：≤100 行/批，按文件聚合

同一文件的水行与合格行尽量同批做完，避免同一文件两次进出。每批内部先做 144 类（改写 + 去一层前缀），
再做 658 类（只去一层前缀）。

| 批次 | 文件 | 144 行 | 658 行 | 合计 |
| --- | --- | ---: | ---: | ---: |
| B1 | `packages/ui/src/store/offPeakTaskStore.ts` | 10 | 58 | **68** |
| B2 | `packages/ui/src/v4/conversationTurnNavigatorHelpers.ts` | 15 | 49 | **64** |
| B3 | `packages/shared/src/git.ts` | 13 | 49 | **62** |
| B4 | `apps/zcode-cli/packages/tui/src/app-view.tsx` | 13 | 55 | **68** |
| B5 | `packages/ui/src/lib/pptxElementReference.ts` | 14 | 51 | **65** |
| B6 | `packages/shared/src/workspace-hook-digest.ts` | 18 | 42 | **60** |
| B7 | `apps/zcode-cli/packages/tui/src/app-sidebar.tsx` | 7 | 41 | 48 |
| B7 | `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts` | 0 | 1 | 1 |
| | **B7 小计** | 7 | 42 | **49** |
| B8 | `packages/ui/src/browser-use/ResponsiveBrowserViewport.tsx` | 10 | 58 | **68** |
| B9 | `packages/ui/src/lib/usageEntitlementRefreshPolicy.ts` | 12 | 48 | 60 |
| B9 | `apps/zcode-cli/packages/tui/src/app-events.ts` | 2 | 37 | 39 |
| | **B9 小计** | 14 | 85 | **99** |
| B10 | `packages/ui/src/components/ai-elements/audio-player.tsx` | 6 | 36 | 42 |
| B10 | `packages/ui/src/rewards/RewardsWebview.tsx` | 10 | 45 | 55 |
| | **B10 小计** | 16 | 81 | **97** |
| B11 | `packages/ui/src/settings/CommandForm.tsx` | 8 | 34 | **42** |
| B12 | `packages/ui/src/feedback/FeedbackBackgroundUploadIndicator.tsx` | 6 | 54 | **60** |
| **合计** | 15 文件 | **144** | **658** | **802** |

12 批，每批 ≤ 100 行；最大批 B9 = 99。

### 8.3 每批验收（四条硬条件）

1. `deep-quality` 本线 weak **不增**（批前批后各跑一次 `--list-weak`，只允许上游豁免行残留）；
2. `onlyPre` / `onlyPost` 有据可查：去前缀不改变 unitText，预期两者皆为 0；若非 0 必须逐条解释；
3. 门禁 `其中嵌套注释 = 0`——去前缀后的新增行必须是单层 `//`，任何仍以 `//` 开头的即三层，直接判红；
4. 门禁「删本线注释 n」与 `rewrite.tsv` 行数逐条相等，numstat 每文件 `+X −X` 对齐。

### 8.4 numstat 的预先说明（重要）

去前缀是 **658 删 + 658 增**，不是净删除。整个 802 项目做完后 numstat 预期为 **`+802 −802`**
（水行改写同样是 1 删 1 增；只有「随块删除」的死注释才会体现为净删除，而 A2 = 0，本项目没有净删除）。
报告里不得把 `+658 −658` 读成「删了 658 行」。

### 8.5 全量收尾断言

12 批做完后跑全仓检查：

```bash
grep -rc '^\s*// //'  # 断言剩余 = 0
node -e "…isNestedComment 扫全仓…"  # 断言嵌套注释 = 0
```

并给出改前 / 改后全仓 weak 总数对比，证明「水没有从死注释搬到活注释」：
若总 weak 减少量 ≈ 144 − 残留豁免，说明水被真正清掉；若总量不降反升，说明去前缀激活了新水，整项目回滚。

## 9. 白名单与 capacity 断言

capacity-estimate（b247 登记表纳入后）：

```text
done files=68 lines=593
1-2 档剩余 301 文件 / 382 行
SUM 939 文件 / 6828 行 / 347 批
ASSERT PASS
```

## 10. 下一步

1. b248 继续 4–5 文件；
2. 802 项目按 §8.2 的 B1→B12 顺序执行，每批四条验收全过才进下一批；B1 起每批 ≤100 行；
3. 全量收尾后写 `ZC-deep-nested-closeout.md`，含 `// //` 剩余 = 0、嵌套 = 0、全仓 weak 前后对比。
