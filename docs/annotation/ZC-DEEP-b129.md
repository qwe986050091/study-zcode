# ZC-DEEP-B129（4 文件，+170 行）

> 范围：Grep 工具处理、工作区文本生成、模型配置同步与错误横幅遥测。
> 快照：`d:\code\_annot_baseline\ZC-deep-b129\orig`；清单：`ZC-deep-b129-files.txt`。
> 目标密度 31.4%，实际落点 31.17%~31.60%。

## 1. 验收输出

```text
[ok] apps/zcode-cli/packages/core/src/tool/handlers/grep.ts: 5 blocks, 44 lines
[ok] apps/zcode-cli/packages/core/src/runtime/methods/workspace-generate-text.ts: 5 blocks, 43 lines
[ok] packages/ui/src/lib/modelConfigSync.ts: 5 blocks, 41 lines
[ok] packages/ui/src/lib/chatErrorBannerTelemetry.ts: 5 blocks, 42 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=170
TOTAL added=170 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.60% code=231 comment=73 apps/zcode-cli/packages/core/src/tool/handlers/grep.ts
31.37% code=255 comment=80 apps/zcode-cli/packages/core/src/runtime/methods/workspace-generate-text.ts
31.17% code=154 comment=48 packages/ui/src/lib/modelConfigSync.ts
31.55% code=168 comment=53 packages/ui/src/lib/chatErrorBannerTelemetry.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `apps/zcode-cli/packages/core/src/tool/handlers/grep.ts` | Grep 工具的参数归一、端口调用与文案 | 路径边界、三种输出互斥、超时不可覆盖与结果落盘 | 44 |
| `apps/zcode-cli/packages/core/src/runtime/methods/workspace-generate-text.ts` | 工作区一次性文本生成与连通性探测 | 不建回合、完成事件、失败记账与遥测收尾 | 43 |
| `packages/ui/src/lib/modelConfigSync.ts` | 设置页与工作区模型配置的作用域同步 | 供应商键解析、活动任务优先与模型名清单校验 | 41 |
| `packages/ui/src/lib/chatErrorBannerTelemetry.ts` | 错误横幅遥测负载组装与上报 | 敏感文本脱敏、可见恢复动作判定与六段键结构 | 42 |

## 3. 说明

- `grep.ts` 首行是横幅注释且重复出现三次，文件头按 `nth=1` 命中首个。
- `chatErrorBannerTelemetry.ts` 首行 `import {` 出现两次，同样按 `nth=1` 命中首个。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。
