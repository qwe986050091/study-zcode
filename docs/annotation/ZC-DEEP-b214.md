# ZC-DEEP-B214（4 文件，+120 行）

> 范围：模型触发器文案、v4 数据层出口、草稿建议插件弹层、workspace 索引订阅集合（合计 449 代码行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b214\orig`；清单：`ZC-deep-b214-files.txt`。
> 目标密度 31%~32%，实际落点 31.30%~31.96%。

## 1. 验收输出

```text
[ok] packages/ui/src/v4/composer/modelTriggerDisplay.ts: 14 blocks, 30 lines
[ok] packages/ui/src/v4/index.ts: 14 blocks, 30 lines
[ok] packages/ui/src/v4/useDraftSuggestedPluginActionPopover.ts: 14 blocks, 30 lines
[ok] packages/ui/src/v4/workspaceSessionsIndexSubscriptionSet.ts: 14 blocks, 30 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=120
[packages/ui/src/v4/composer/modelTriggerDisplay.ts] added=30 nonComment=0 starSlash=0 suspicious=0
[packages/ui/src/v4/index.ts] added=30 nonComment=0 starSlash=0 suspicious=0
[packages/ui/src/v4/useDraftSuggestedPluginActionPopover.ts] added=30 nonComment=0 starSlash=0 suspicious=0
[packages/ui/src/v4/workspaceSessionsIndexSubscriptionSet.ts] added=30 nonComment=0 starSlash=0 suspicious=0
TOTAL added=120 hardBad=0 suspicious=0
```

逐文件密度（`codeRatio` = 注释 ÷ 代码）：

```text
31.30% code=131 comment=41 packages/ui/src/v4/workspaceSessionsIndexSubscriptionSet.ts
31.58% code=114 comment=36 packages/ui/src/v4/composer/modelTriggerDisplay.ts
31.78% code=107 comment=34 packages/ui/src/v4/index.ts
31.96% code=97 comment=31 packages/ui/src/v4/useDraftSuggestedPluginActionPopover.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/v4/composer/modelTriggerDisplay.ts` | 模型触发文案 | 套餐身份只认 providerId、三档映射、通用回退、内置连接名、trim、菜单查找、ID 兜底、结构化前缀、两标签同源 | 30 |
| `ui/src/v4/index.ts` | 数据层出口 | 纯新增 barrel、只 re-export、传输优先、索引分组、持久行不在本组、两套租约、归组与无副作用 | 30 |
| `ui/src/v4/useDraftSuggestedPluginActionPopover.ts` | 插件操作弹层 | 两种时长、effect 计时、终态才计、新操作清旧计时、按 operationId 隔离、卸载清理、可选动作 | 30 |
| `ui/src/v4/workspaceSessionsIndexSubscriptionSet.ts` | 索引订阅集合 | 期望集合、entry key、逐字段等价、先 acquire 后 release、同 store 复用、删除/新增两段、一次通知 | 30 |

## 3. 说明

- `modelTriggerDisplay.ts` 原 6 行（5.26%），块锚定套餐 switch、三组 case、回退拼接、内置 family、provider trim、两处 `modelGroups.find` 与 `!selectedGroup`（均 `nth: 1`）、ID 兜底、fullLabel、providerPrefix、modelLabel。
- `index.ts` 原 4 行（3.74%），文件头复用首行注释；块锚定文件头说明、transport、projection、sessionDataLayer、索引组注释、索引 store、索引 registry、分屏组注释、paneLayoutStore、connectionRegistry、弹窗宿主、交互适配与 SessionPane。
- `useDraftSuggestedPluginActionPopover.ts` 原 1 行（1.03%），块锚定两个时长、计时器 ref、clearTimer 校验、函数式隐藏、卸载清理、`clearTimer(resultTimerRef);`（`nth: 2` 为展示前清除）、文案注入、actionLabel、onDismiss、终态判断、时长分流、effect 依赖。
- `workspaceSessionsIndexSubscriptionSet.ts` 原 11 行（8.40%），块锚定日志键、等价判断、active map、reconcile、desired.set、跳过分支、acquire、sameStore、同 store 释放、`releasedScopeKeys.push(...)`（`nth: 2` 为删除分支）、新增 acquire、统一通知、disposeEntry。
- 四个文件均按「新增 30 行」写入，密度 31.30%~31.96%，全部 ≥30% 且未贴线。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1866 needLines=26474 min=0.00 median=31.34
本会话范围 files=4562 coreBelow30=1862 needLines=21882
```

累计 1,362 文件 / 126,489 行。

## 提交回填（2026-11-10）

```text
ZC-deep-b214 | 提交 a8784b7e | numstat 120 0 | 门禁 未通过（现行 W/POEM/L 判据：waterLines=31 / 120）
```

口径与边界：

- **提交边界不代表批次边界。** 本批注释在安全快照 `a8784b7e` 里入库，与其余 1,700 余个文件同属一次提交，无法从提交历史还原批次边界。
- 门禁以 `8f7daaf0` 为基线重跑（`--base` / `--diff-base`），以复原落盘时的判据条件；若用 HEAD 作基线会得到 0 行假 PASS。
- 六件套原始 SUMMARY：

```text
deep-gate    SUMMARY files=4 badFiles=4 addedCommentLines=120 waterLines=31 waterRate=25.83% [exit!=1]
zc-verify    SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=120
code-tokens  SUMMARY files=4 codeTokenDiff=0
in-strings   SUMMARY files=4 scanned=4 stringRanges=61 violations=0 addedViolations=0
boilerplate  SUMMARY groups=0 lines=0 files=0 dups=0 dupLines=0 singles=0 mode=diff
upstream     SUMMARY files=4 checked=4 upstreamComments=102 missing=0
```

- 结论：**六件套未全通过**。waterLines=31 说明按现行判据仍有水句，需按 §2.16 逐行改写后重新门禁；本批状态为「已提交、门禁未通过」。
