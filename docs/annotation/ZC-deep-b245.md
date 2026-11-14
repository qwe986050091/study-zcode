# b245 改写批（5 文件 + 门禁 v11 嵌套注释硬拒绝 + 802 行分类账）

- 日期：2026-11-10
- base：`a70edf7e`（b244 台账提交，本批改写前 HEAD）
- 提交：`3f2e1cae b245 改写 (+9/−9)`
- 尺子：`zc-commit v11`（`GATE self=… blob=3c65b811b847`）、`zc-gate v4`（`633b334905ee`）、`deep-quality v1.9 8042442fe198`
- 本批性质：b244 收下后按阈值表回落 **5 文件**；跟办门禁硬拒绝、802 行分类、产能口径修正

## 1. 本批选谁

1–2 行档剩余排序取下一组（`deep-quality v1.9`，改前 `--list-weak` 实测 12 行）：

| 文件 | 实测 weak |
| --- | ---: |
| `packages/ui/src/ErrorBoundary.tsx` | 2 |
| `packages/ui/src/components/ui/carousel.tsx` | 2 |
| `packages/ui/src/components/ui/dropdown-menu.tsx` | 3 |
| `packages/ui/src/conversation-share-interaction/conversationSharePopoverActions.ts` | 2 |
| `packages/ui/src/v4/ConversationComposer.tsx` | 3 |

## 2. 归属预检（v6 白名单，31 条）

| sha | 行数 | 判定 | 处置 |
| --- | ---: | --- | --- |
| `a8784b7e` | 9 | 本线 | 改写 9 |
| `872ad960` | 3 | **上游** | 不删不改，登记豁免 |

上游 3 行：

```text
dropdown-menu.tsx:63    圆角规范迁移：旧菜单沿用 xl/lg，统一为独立外壳 lg、内部选项 md；子菜单重新起算。
ConversationComposer.tsx:900   ── 附件全链路（选择/粘贴/拖拽/画板/预传/门禁）──
ConversationComposer.tsx:1550  刷新/关窗前落盘当前草稿。
```

改写后 `--list-weak` 的 3 条正是这三行，本线 weak = **0**。`own-commits.mjs --check`：`a8784b7e` 本线、`872ad960` 上游。

## 3. 门禁八行原文（v11，第七行新增「其中嵌套注释」）

```text
GATE self=d:\code\_annot_baseline\zc-commit.mjs blob=3c65b811b847
=== 改写门禁（base=HEAD）===
删本线注释    n=9  （允许，逐行登记）
删代码        n=0  （必须 0）
删上游注释    n=0  （必须 0）
新增非注释行  n=0  （必须 0）
原行搬移      n=0  （不变量：不计入改写量、不计入新增注释行数；行号见下方明细）
标点级改写    n=0  （必须 0：去标点后与删除行相同但原文不同）
新增注释行    n=9  其中判据命中 0  其中嵌套注释 0  （必须 0；已扣除搬移行）
```

提交集合断言：`expected=5  staged=5`。

> 版本说明：v11 没有新增第 8 行，而是把「嵌套注释」并入第七行的子计数，保持七行结构不变；非 0 时额外打印违规明细并 `exit 1`。

## 4. TSV 与「删本线注释」逐条对应（9 条 = 门禁 n=9）

登记表：`docs/annotation/ZC-deep-b245-rewrite.tsv`（9 行数据 + 表头）。

| # | 文件:行 | 改写后 |
| --- | --- | --- |
| 1 | `ErrorBoundary.tsx:146` | `// [资源] 容器用 overflow-y-auto + items-start：componentStack 再长，重试与刷新按钮也保持可达。` |
| 2 | `ErrorBoundary.tsx:396` | `// [事务] handleReset 只清 error 与 componentStack 后 setState：触发重渲染，但不重挂载子树。` |
| 3 | `carousel.tsx:115` | `// [契约] 左右箭头命中时先 preventDefault，再由 api.scrollPrev/Next 消费，防止页面滚动抢占按键。` |
| 4 | `carousel.tsx:117` | `// [权衡] handleKeyDown 只认 ArrowLeft/ArrowRight，垂直模式的 ArrowUp/ArrowDown 仍交给浏览器。` |
| 5 | `dropdown-menu.tsx:3` | `// 做：用一份 className 基线覆盖外壳与条目的圆角、间距、阴影、层级、禁用态与高亮态，不各写一处。` |
| 6 | `dropdown-menu.tsx:222` | `// [语义] DropdownMenuLabel 只是视觉分组标题：不进键盘序列，也不充当条目的可访问名称。` |
| 7 | `sharePopoverActions.ts:115` | `// [权衡] openShare 清空排除集牺牲沿用上次选择的便利，换来新链接不继承旧范围这一可解释性。` |
| 8 | `sharePopoverActions.ts:187` | `// [并发] togglePendingRow 在 dock.publishing 时同样早退：以请求提交瞬间的排除集为准，避免勾选覆盖在途请求。` |
| 9 | `ConversationComposer.tsx:847` | `// reportedErrorKeysRef 记录已上报的 key：同一次挂载内同一错误只上报一次，避免流式刷新刷出多条样本。` |

9 删 / 9 增，差值 0。

## 5. 度量与覆盖

| | SUMMARY | RATIOS |
| --- | --- | --- |
| 改前 | `files=5 units=2099 coverage=14.5% branch=13.7% field=32.0% comments=1079 substance=87.7% explain=99.0% filler=0.0% weak=1.1%` | `weak=12/1079` |
| 改后 | `files=5 units=2099 coverage=14.5% branch=13.7% field=32.0% comments=1079 substance=88.0% explain=99.7% filler=0.0% weak=0.3%` | `weak=3/1079` |

`--list-weak`：12 → 3（3 条全为上游 `872ad960`）。

覆盖差集（改前快照在 `HEAD=a70edf7e` 的 `--detach` 工作树里跑，避免受其它会话脏文件影响）：

```text
UNCOVERED units=1794（去重键 1304）pre → 1794（1304）post
onlyPre=0  onlyPost=0
```

## 6. numstat

```text
+2 −2  packages/ui/src/ErrorBoundary.tsx
+2 −2  packages/ui/src/components/ui/carousel.tsx
+2 −2  packages/ui/src/components/ui/dropdown-menu.tsx
+2 −2  packages/ui/src/conversation-share-interaction/conversationSharePopoverActions.ts
+1 −1  packages/ui/src/v4/ConversationComposer.tsx
合计 +9 −9
```

## 7. 三段计时

| 段 | 打点 | 秒 | 性质 |
| --- | --- | ---: | --- |
| T0 → T1（选片、读上下文、blame、改前快照） | 18:09:37.491 → 18:10:03.332 | 25.8 | 固定 |
| T1 → T2（编辑 9 行 + v11 负例注入/回滚） | 18:10:03.332 → 18:10:40.097 | 36.8 | 可变 |
| T2 → T3（改后快照 + 门禁 + 提交） | 18:10:40.097 → 18:11:36.687 | 56.6 | 固定 |
| **合计 == 墙钟** | 18:09:37.491 → 18:11:36.687 | **119.2** | — |

每文件均摊：119.2 / 5 = **23.8 秒/文件**（含 v11 负例注入与一次 L 返工）。

### 7.1 返工打点（单独）

| # | 触发 | 处置 | 区间 | 秒 |
| --- | --- | --- | --- | ---: |
| R1 | v11 负例注入（`// // 临时`）验证硬拒绝 | 跑门禁确认 `嵌套注释 n=1` + `exit 1`，随后回滚该行 | 18:10:2x → 18:10:3x | ~15 |
| R2 | 首跑 2 条 L（`sharePopoverActions.ts:115`、`ConversationComposer.tsx:847`，各 2 个逗号） | 把第一个逗号改成冒号/去掉，分隔符降到 1 个 | 18:10:4x | ~10 |

返工合计约 25 秒，占墙钟 21%（b244 是 49%，回调来自「先按 W/L 互斥自检再落笔」）。

## 8. 门禁 v11：嵌套注释硬拒绝（指令第 1 件）

### 8.1 规则

`zc-gate v4` 新增导出：

```js
export const isNestedComment = (rawLine) => {
  const t = rawLine.trim();
  const inner = t.replace(/^\/\//, '').replace(/^\/\*+/, '').trimStart();
  return /^(\/\/|\/\*)/.test(inner);
};
```

`zc-commit v11` 对每条新增注释行先过这个判据，命中即 `nested.push`，打印明细并 `exit 1`。
判据与判据命中分开计数：嵌套行**不计入** W/L/POEM 的 `判据命中`，避免两种违规混成一个数字。

### 8.2 负例回放（802 行）

`b245-nested-classify.mjs` 从 HEAD 取 15 个文件的全部 `// //` 行，逐行喂 `isNestedComment`：

```text
TOTAL=802  NESTED_REJECTED=802  MISSED=0
```

**802/802 全部拦住，漏网 0。**

### 8.3 端到端验证

临时在 `ErrorBoundary.tsx:147` 注入 `// // v11 嵌套注释负例（临时，测完删除）`，门禁实跑：

```text
新增注释行    n=10  其中判据命中 2  其中嵌套注释 1  （必须 0；已扣除搬移行）
--- 嵌套注释（违规：注释里的注释，剥一层后仍以 // 或 /* 开头）---
  packages/ui/src/ErrorBoundary.tsx:147	// // v11 嵌套注释负例（临时，测完删除）
改写门禁未通过：…… / 嵌套注释 必须全为 0。
exit=1
```

随后原样回滚（最终提交里没有这一行，numstat 为 `+9 −9` 可反证）。

## 9. 802 行分类账（指令第 2 件，本批不改）

### 9.1 判据

对每行 `// // 正文`：

1. 剥掉**多余的那一层** → 得到 `// 正文`（有效注释形态）；
2. 再剥成纯正文 `正文`，用**与门禁同一把尺子**（`zc-gate.judgeEntries` 的 W / L / POEM 逐行判据）判；
3. 分类：
   - **(a) 合格注释**：无 W/L/POEM 命中 → 属「有效注释被误包」，处置是**去掉多余前缀**（恢复为有效注释），不是删除；
   - **(b) 仍是水**：命中 W/L/POEM → 改写或删除；
   - **(c) 空/分隔**：剥完为空或纯分隔符 → 直接删（本批为 0）。

> 口径说明：(b) 是**逐行口径的上界**。块注释的续行单独判会缺锚点而落 W，实际处置前需按整块复核，
> 预计 (b) 会低于 144；但「先分类再动手」要的就是这个上界账，不能边清边估。

### 9.2 计数

| 类 | 行数 | 占比 | 处置性质 |
| --- | ---: | ---: | --- |
| (a) 合格注释被误包 | **658** | 82.0% | 去一层前缀，**不删** |
| (b) 剥一层后仍是水 | **144** | 18.0% | 改写或删除，需逐块复核 |
| (c) 空/分隔 | 0 | 0% | — |
| **合计** | **802** | 100% | — |

### 9.3 文件分布

| 文件 | 双前缀行 | (a) 合格 | (b) 水 |
| --- | ---: | ---: | ---: |
| `apps/zcode-cli/packages/tui/src/app-view.tsx` | 68 | 55 | 13 |
| `apps/zcode-cli/packages/tui/src/app-sidebar.tsx` | 48 | 41 | 7 |
| `apps/zcode-cli/packages/tui/src/app-events.ts` | 39 | 37 | 2 |
| `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts` | 1 | 1 | 0 |
| `packages/shared/src/workspace-hook-digest.ts` | 60 | 42 | 18 |
| `packages/ui/src/v4/conversationTurnNavigatorHelpers.ts` | 64 | 49 | 15 |
| `packages/shared/src/git.ts` | 62 | 49 | 13 |
| `packages/ui/src/store/offPeakTaskStore.ts` | 68 | 58 | 10 |
| `packages/ui/src/components/ai-elements/audio-player.tsx` | 42 | 36 | 6 |
| `packages/ui/src/browser-use/ResponsiveBrowserViewport.tsx` | 68 | 58 | 10 |
| `packages/ui/src/settings/CommandForm.tsx` | 42 | 34 | 8 |
| `packages/ui/src/rewards/RewardsWebview.tsx` | 55 | 45 | 10 |
| `packages/ui/src/feedback/FeedbackBackgroundUploadIndicator.tsx` | 60 | 54 | 6 |
| `packages/ui/src/lib/pptxElementReference.ts` | 65 | 51 | 14 |
| `packages/ui/src/lib/usageEntitlementRefreshPolicy.ts` | 60 | 48 | 12 |
| **合计** | **802** | **658** | **144** |

### 9.4 为什么必须分类后再动

两类动作互斥：(a) 的处置是**去前缀**，(b) 的处置是**改写/删除**。
若一把清，会把 658 行好注释跟着删掉（正是「既删好注释又留坏注释」）。
建议后续拆成两批：先做 (a)（纯机械去一层 `//`，改动零语义），再按 (b) 的整块复核结果分批改写。

## 10. 产能口径修正（指令第 3 件）

### 10.1 旧口径（错）

`总时长 = 批数 × 每批固定时长 + 总行数 × 单位行时长`

它假设「固定成本是一批一次」，于是合并文件能摊薄；b244 的实测推翻了这一点。

### 10.2 新口径

`总时长 ≈ 总单元数 × 单位单元时长 + 编辑行数 × 单位行时长 + 返工时长`

依据（b243 vs b244）：

| 批次 | 文件数 | units | units/文件 | 固定成本秒 | 固定成本/unit |
| --- | ---: | ---: | ---: | ---: | ---: |
| b243 | 6 | 1046 | 174 | 45.8 | 0.0438 |
| b244 | 8 | 1684 | 211 | 75.9 | 0.0451 |
| b245 | 5 | 2099 | 420 | 82.4 | 0.0393 |

固定成本的主体是 `deep-quality` 全量扫描（`--list-weak` + `--uncovered` 前后各一次），按**单元**计价，
不按批次计价；文件数增加只改变「units 总量」，不改变「每 units 单价」。所以：
**合并文件不摊薄固定成本，只把同一份按 units 计价的工作挪到同一批。**

结论：产能估算按 **plus 单元数** 报，不按批数报；批大小只影响返工爆炸半径，不影响平均成本。

### 10.3 真正的瓶颈：门禁返工

| 批次 | 墙钟秒 | 返工秒 | 返工占比 |
| --- | ---: | ---: | ---: |
| b244 | 175.2 | 85.2 | **49%** |
| b245 | 119.2 | ~25 | 21% |

返工根因：**W（无标识符锚点）与 L（≥2 分隔符且无谓词）是互补判据**，改一边掉到另一边。
b245 已把「先自检两条、再落笔」作为写作前置动作，返工占比从 49% 降到 21%。
后续若要把返工压到 10% 以下，正确做法是把 W/L 合成一个「合格注释」正例模板（锚点 + 谓词 + 分隔符 < 2），
而不是继续在两判据之间试错。

## 11. 门禁版本与归档

| 文件 | 版本 | blob sha1 | 改了什么 | 首个使用批次 |
| --- | --- | --- | --- | --- |
| [`zc-gate-v4.mjs`](_tools/zc-gate-v4.mjs) | v4 | `633b334905ee` | 新增 `isNestedComment`（剥一层后仍以 `//` 或 `/*` 开头即嵌套） | **b245** |
| [`zc-commit-v11.mjs`](_tools/zc-commit-v11.mjs) | v11 | `3c65b811b847` | 新增注释行过 `isNestedComment`，命中硬拒绝；第七行加 `其中嵌套注释 n` 子计数 | **b245** |

两版均已归档，INDEX §1/§2 已登记。

## 12. 白名单与 capacity 断言

capacity-estimate（b245 登记表纳入后，`--per-batch-map ">=20:2,5-9:3,1-2:6"`）：

```text
done files=58 lines=578
1-2 档剩余 311 文件 / 397 行
ASSERT PASS
```

三条恒等式通过（Σ档位 == 基线 − 已清）。

## 13. 下一步

1. b246 继续 **4–5 文件**（b245 均摊 23.8，不放量）；
2. 802 行按 §9 拆两批：先 (a) 658 行去前缀，再按整块复核消化 (b) 144 行；
3. 产能报表改按 units 报，返工单列；W/L 正例模板作为下一版尺子的候选。
