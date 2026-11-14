# ZC-DEEP-B138（4 文件，+177 行）

> 范围：CLI 配置 schema、Android 模拟器 MCP 入口、工作流配置字段与 MCP 资源采样源。
> 快照：`d:\code\_annot_baseline\ZC-deep-b138\orig`；清单：`ZC-deep-b138-files.txt`。
> 目标密度 31.4%，实际落点 31.27%~31.63%。

## 1. 验收输出

```text
[ok] apps/zcode-cli/packages/adapters/src/config/schema.ts: 6 blocks, 47 lines
[ok] apps/zcode-cli/packages/android-emulator-plugin/src/mcp/server.ts: 6 blocks, 46 lines
[ok] packages/ui/src/components/workflow-timeline/WorkflowRunSettingsFields.tsx: 6 blocks, 43 lines
[ok] packages/desktop/src/main/processResourceMcpTelemetrySource.ts: 5 blocks, 41 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=177
TOTAL added=177 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.34% code=501 comment=157 apps/zcode-cli/packages/adapters/src/config/schema.ts
31.27% code=339 comment=106 apps/zcode-cli/packages/android-emulator-plugin/src/mcp/server.ts
31.63% code=196 comment=62 packages/ui/src/components/workflow-timeline/WorkflowRunSettingsFields.tsx
31.43% code=140 comment=44 packages/desktop/src/main/processResourceMcpTelemetrySource.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `apps/zcode-cli/packages/adapters/src/config/schema.ts` | 配置文件的唯一校验形状与历史字段归一化 | MCP 归一化顺序、strict 边界、插件 id canonical 与诊断码 | 47 |
| `apps/zcode-cli/packages/android-emulator-plugin/src/mcp/server.ts` | Android 工具集的 MCP 注册与结果包装 | 共享参数、错误守卫、副作用分级与传输入口 | 46 |
| `packages/ui/src/components/workflow-timeline/WorkflowRunSettingsFields.tsx` | 配置弹层里的模型与并发两个受控字段 | 受控边界、空清单退化、并发夹取与稳定引用 | 43 |
| `packages/desktop/src/main/processResourceMcpTelemetrySource.ts` | MCP 资源样本的摄入、分组与按窗口交付 | 去重与上限、分组键构成、新鲜度合并与交付标记 | 41 |

## 3. 说明

- `WorkflowRunSettingsFields.tsx` 首行分隔线重复出现，文件头按 `nth=1` 命中首个。
- `schema.ts` 首行为 eslint-disable 行注释，文件头插在其后、原块注释之前。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。
