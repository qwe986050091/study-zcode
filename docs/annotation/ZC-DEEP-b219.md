# ZC-DEEP-B219（4 文件，+120 行）

> 范围：Bot 任务广播解析、套餐升级弹窗入口、模型草稿状态与供应商设置骨架（合计 407 代码行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b219\orig`；清单：`ZC-deep-b219-files.txt`。
> 目标密度 31%~32%，实际落点 32.26%~32.67%。

## 1. 验收输出

```text
[ok] packages/ui/src/root/botsTaskBroadcast.ts: 14 blocks, 30 lines
[ok] packages/ui/src/settings/CodingPlanUpgradeDialogProvider.tsx: 14 blocks, 30 lines
[ok] packages/ui/src/settings/model-provider-section/ProviderModelDraftState.ts: 14 blocks, 30 lines
[ok] packages/ui/src/settings/model-provider-section/SectionLayout.tsx: 14 blocks, 30 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=120
TOTAL added=120 hardBad=0 suspicious=0
```

逐文件密度（`codeRatio` = 注释 ÷ 代码）：

```text
32.26% code=93 comment=30 packages/ui/src/settings/model-provider-section/SectionLayout.tsx
32.35% code=102 comment=33 packages/ui/src/root/botsTaskBroadcast.ts
32.43% code=111 comment=36 packages/ui/src/settings/CodingPlanUpgradeDialogProvider.tsx
32.67% code=101 comment=33 packages/ui/src/settings/model-provider-section/ProviderModelDraftState.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/root/botsTaskBroadcast.ts` | Bot 任务广播 | 频道早退、载荷白名单、可选字段逐个校验、打开工作区过滤、事件到状态映射 | 30 |
| `ui/src/settings/CodingPlanUpgradeDialogProvider.tsx` | 升级弹窗入口 | 单弹窗实例、就绪守卫、观察者单槽位、结果只回传一次、openVersion 隔离 | 30 |
| `ui/src/settings/model-provider-section/ProviderModelDraftState.ts` | 模型草稿状态 | 草稿非事实、显式覆写集合、继承优先、恢复与覆写汇总 | 30 |
| `ui/src/settings/model-provider-section/SectionLayout.tsx` | 供应商设置骨架 | 两路加载合并、头部动作、分栏与独立滚动、反馈边界重置 | 30 |

## 3. 说明

- `botsTaskBroadcast.ts` 原 3 行（2.91%），块锚定载荷守卫、非对象早退、事件白名单、刷新入口、频道与结构早退、工作区键、页签匹配、状态映射入口、completed / prompt_sent / updated 三个 case 与 ready 返回。
- `CodingPlanUpgradeDialogProvider.tsx` 原 6 行（5.41%），块锚定 Provider 入口、inventoryRef、openVersion、opening 槽位、卸载清理、打开回调、就绪守卫、观察者分支、abort、funnelContext 冻结、版本自增、结果回调与上下文缺失抛错。
- `ProviderModelDraftState.ts` 原 4 行（3.96%），块锚定字段清单、projectModelDraft、推荐早退、默认值推导、两处 `const explicit`（`nth: 1` / `nth: 2`）、updateModelDraft、重开推荐、projected、inputFormat 分支、restore、overrides 与文本字段判定。
- `SectionLayout.tsx` 原 0 注释（0.00%），块锚定加载合并函数、返回值、布局入口、合并结果、头部行、动作组件、加载文案、三个 data 标记、导航与详情边界、外层间距。
- 本批一次锚点不匹配：`CodingPlanUpgradeDialogProvider.tsx` 首行 `import {` 在文件内出现 3 次，补 `firstNth: 1` 后重插；失败文件未落盘，`deletedNonZero=0`。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1846 needLines=25913 min=0.00 median=31.35
本会话范围 files=4562 coreBelow30=1842 needLines=21321
```

累计 1,382 文件 / 127,089 行。

## 提交回填（2026-11-10）

```text
ZC-deep-b219 | 提交 a8784b7e | numstat 116 0 | 门禁 未通过（现行 W/POEM/L 判据：waterLines=35 / 116）
```

口径与边界：

- **提交边界不代表批次边界。** 本批注释在安全快照 `a8784b7e` 里入库，与其余 1,700 余个文件同属一次提交，无法从提交历史还原批次边界。
- 门禁以 `8f7daaf0` 为基线重跑（`--base` / `--diff-base`），以复原落盘时的判据条件；若用 HEAD 作基线会得到 0 行假 PASS。
- 六件套原始 SUMMARY：

```text
deep-gate    SUMMARY files=4 badFiles=4 addedCommentLines=116 waterLines=35 waterRate=30.17% [exit!=1]
zc-verify    SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=116
code-tokens  SUMMARY files=4 codeTokenDiff=0
in-strings   SUMMARY files=4 scanned=4 stringRanges=117 violations=0 addedViolations=0
boilerplate  SUMMARY groups=0 lines=0 files=0 dups=0 dupLines=0 singles=0 mode=diff
upstream     SUMMARY files=4 checked=4 upstreamComments=14 missing=0
```

- 结论：**六件套未全通过**。waterLines=35 说明按现行判据仍有水句，需按 §2.16 逐行改写后重新门禁；本批状态为「已提交、门禁未通过」。
