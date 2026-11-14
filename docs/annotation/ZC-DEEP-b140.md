# ZC-DEEP-B140（4 文件，+161 行）

> 范围：网页元素选择 hook、推荐插件适配器、模型配置解析 hook 与模型用量饼图。
> 快照：`d:\code\_annot_baseline\ZC-deep-b140\orig`；清单：`ZC-deep-b140-files.txt`。
> 目标密度 31.4%，实际落点 30.71%~31.58%。

## 1. 验收输出

```text
[ok] packages/ui/src/hooks/useWebElementPicker.ts: 5 blocks, 41 lines
[ok] packages/ui/src/plugin-ui/adapters/useRecommendedUiPlugins.ts: 5 blocks, 40 lines
[ok] packages/ui/src/settings/model-provider-section/useModelConfigResolution.ts: 5 blocks, 40 lines
[ok] packages/ui/src/settings/usage-stats/AppUsageModelUsagePieChart.tsx: 5 blocks, 40 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=161
TOTAL added=161 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.58% code=152 comment=48 packages/ui/src/hooks/useWebElementPicker.ts
30.71% code=140 comment=43 packages/ui/src/plugin-ui/adapters/useRecommendedUiPlugins.ts
30.94% code=139 comment=43 packages/ui/src/settings/model-provider-section/useModelConfigResolution.ts
31.06% code=132 comment=41 packages/ui/src/settings/usage-stats/AppUsageModelUsagePieChart.tsx
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/hooks/useWebElementPicker.ts` | 网页元素选择的生命周期、取消与结果分发 | 运行号抢占、回包校验、日志脱敏与 Esc 双通道 | 41 |
| `packages/ui/src/plugin-ui/adapters/useRecommendedUiPlugins.ts` | 推荐插件列表与插件管理 store 的适配 | 目标键去重、上下文身份、忙碌拦截与失败绑定 | 40 |
| `packages/ui/src/settings/model-provider-section/useModelConfigResolution.ts` | 模型配置的一次性解析与延迟触发 | 代次与身份共判、提示节流、取消与复位 | 40 |
| `packages/ui/src/settings/usage-stats/AppUsageModelUsagePieChart.tsx` | 按模型拆分的令牌用量饼图与图例 | 视图模型复用、提示格式化回退、空态与语义图例 | 40 |

## 3. 说明

- `useRecommendedUiPlugins.ts` 的 `useEffect` 出现两次，正文块避开该锚点，改锚 `key` 构造处。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。
