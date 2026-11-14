# ZC-DEEP-B217（4 文件，+120 行）

> 范围：工作流时间线模型、反馈流程页、Highspeed footer 聚合、Provider 设置视图（合计 728 代码行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b217\orig`；清单：`ZC-deep-b217-files.txt`。
> 目标密度 31%~32%，实际落点 30.63%~32.61%。

## 1. 验收输出

```text
[ok] packages/ui/src/components/workflow-timeline/timeline-model.ts: 14 blocks, 30 lines
[ok] packages/ui/src/feedback/FeedbackProcessView.tsx: 14 blocks, 30 lines
[ok] packages/ui/src/highspeed/highspeedOutputFooter.ts: 14 blocks, 30 lines
[ok] packages/ui/src/hooks/useProviderSettingsView.ts: 14 blocks, 30 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=120
TOTAL added=120 hardBad=0 suspicious=0
```

逐文件密度（`codeRatio` = 注释 ÷ 代码）：

```text
30.63% code=395 comment=121 packages/ui/src/components/workflow-timeline/timeline-model.ts
31.58% code=133 comment=42 packages/ui/src/highspeed/highspeedOutputFooter.ts
32.41% code=108 comment=35 packages/ui/src/hooks/useProviderSettingsView.ts
32.61% code=92 comment=30 packages/ui/src/feedback/FeedbackProcessView.tsx
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/components/workflow-timeline/timeline-model.ts` | 时间线模型 | 纯函数、共享模型、显式标签绕过缓存、声明序、回边判定、边去重、带折叠、头像实例、状态折叠、行进优先级 | 30 |
| `ui/src/feedback/FeedbackProcessView.tsx` | 反馈流程页 | 纯展示、事件与补充合并、最新项可缺、角色兜底、步骤数、唯一返回、耗时展示、提交只回调 | 30 |
| `ui/src/highspeed/highspeedOutputFooter.ts` | footer 聚合 | 组尾打标、整卡状态、过期条件、前序输出、marker 排除、TPS 齐全、零令牌、耗时加权、首条 TPS | 30 |
| `ui/src/hooks/useProviderSettingsView.ts` | 设置视图 | 两种来源、外部 store、失败只记日志、代际号、保留 ready、提交校验、revision 单调、重复事件、清理 | 30 |

## 3. 说明

- `timeline-model.ts` 原 91 行（23.04%），块锚定入口、显式标签早退、隐式阶段、下标表、待答集合、边丢弃、边去重键、带折叠、头像键、状态三元、等待判定、再入分支、落点弧。
- `FeedbackProcessView.tsx` 原 0 注释（0.00%），块锚定入口、formatMessage、时间线合并、最新项、返回按钮、标题、计数、进度组件、最新块、摘要兜底、时间线组件、提交回调。
- `highspeedOutputFooter.ts` 原 12 行（9.02%），块锚定标记入口、未命中返回、打标字段、用户输入收集、组尾下标、输出或链、marker 过滤、三元条件、无指标打标、TPS 校验、令牌累加、零令牌、首条 TPS。
- `useProviderSettingsView.ts` 原 5 行（4.63%），块锚定两个导出、外部 store、失败日志、reducer、visibleState、service 比较、revision 取大、过期判断、重复事件、`generationRef.current += 1;`（`nth: 1`）、代际校验（`nth: 1`）、错误覆盖。
- 本批四个文件锚点一次命中，`deletedNonZero=0`。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1854 needLines=26137 min=0.00 median=31.35
本会话范围 files=4562 coreBelow30=1850 needLines=21545
```

累计 1,374 文件 / 126,849 行。

## 提交回填（2026-11-10）

```text
ZC-deep-b217 | 提交 a8784b7e | numstat 114 0 | 门禁 未通过（现行 W/POEM/L 判据：waterLines=25 / 114）
```

口径与边界：

- **提交边界不代表批次边界。** 本批注释在安全快照 `a8784b7e` 里入库，与其余 1,700 余个文件同属一次提交，无法从提交历史还原批次边界。
- 门禁以 `8f7daaf0` 为基线重跑（`--base` / `--diff-base`），以复原落盘时的判据条件；若用 HEAD 作基线会得到 0 行假 PASS。
- 六件套原始 SUMMARY：

```text
deep-gate    SUMMARY files=4 badFiles=4 addedCommentLines=114 waterLines=25 waterRate=21.93% [exit!=1]
zc-verify    SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=114
code-tokens  SUMMARY files=4 codeTokenDiff=0
in-strings   SUMMARY files=4 scanned=4 stringRanges=164 violations=0 addedViolations=0
boilerplate  SUMMARY groups=0 lines=0 files=0 dups=0 dupLines=0 singles=0 mode=diff
upstream     SUMMARY files=4 checked=4 upstreamComments=495 missing=0
```

- 结论：**六件套未全通过**。waterLines=25 说明按现行判据仍有水句，需按 §2.16 逐行改写后重新门禁；本批状态为「已提交、门禁未通过」。
