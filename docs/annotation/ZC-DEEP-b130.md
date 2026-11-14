# ZC-DEEP-B130（4 文件，+176 行）

> 范围：Provider 配置运行边界、PPTX 文件监听、工作流看板折叠与企业套餐目录加载。
> 快照：`d:\code\_annot_baseline\ZC-deep-b130\orig`；清单：`ZC-deep-b130-files.txt`。
> 目标密度 31.4%，实际落点 31.22%~31.48%。

## 1. 验收输出

```text
[ok] packages/provider-node/src/provider-config-runtime.ts: 6 blocks, 48 lines
[ok] packages/ui/src/hooks/usePptxFileWatch.ts: 5 blocks, 42 lines
[ok] packages/ui/src/app-shell/workflow-artifacts/presets/apply.ts: 6 blocks, 44 lines
[ok] packages/ui/src/settings/model-provider-section/useEnterpriseCodingPlanProducts.ts: 5 blocks, 42 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=176
TOTAL added=176 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.29% code=163 comment=51 packages/provider-node/src/provider-config-runtime.ts
31.47% code=143 comment=45 packages/ui/src/hooks/usePptxFileWatch.ts
31.48% code=324 comment=102 packages/ui/src/app-shell/workflow-artifacts/presets/apply.ts
31.22% code=237 comment=74 packages/ui/src/settings/model-provider-section/useEnterpriseCodingPlanProducts.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/provider-node/src/provider-config-runtime.ts` | Node 进程内 Provider 配置运行时的装配与生命周期 | 两套来源互斥、启动单飞、后台检查并发与销毁释放 | 48 |
| `packages/ui/src/hooks/usePptxFileWatch.ts` | PPTX 预览对源文件变化的目录监听与刷新代数 | 路径归一、服务归属校验、注册竞态回收与失败降级 | 42 |
| `packages/ui/src/app-shell/workflow-artifacts/presets/apply.ts` | 报告条目折叠成图表、表格、指标与看板模型 | 纯函数单遍折叠、对数轴维度丢弃、upsert 保留首现位置 | 44 |
| `packages/ui/src/settings/model-provider-section/useEnterpriseCodingPlanProducts.ts` | 企业 Coding Plan 静态目录与实时定价的加载编排 | 身份作用域隔离、失败保留快照与静态目录兜底 | 42 |

## 3. 说明

- `provider-config-runtime.ts` 首行 `import {` 出现四次，文件头按 `nth=1` 命中首个。
- `apply.ts` 首行 `/**` 出现三次，文件头按 `nth=1` 命中首个。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。
