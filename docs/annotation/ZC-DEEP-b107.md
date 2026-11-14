# ZC-DEEP-b107

> 批次：B107（6 文件，按 31.4% 口径目标 294 行，实际 +285）。
> 逐文件独立 spec、逐份自检后一次插入；单批 6 个文件，按缺口降序选批。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b107\orig`；开工前 6 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b107
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=285

node check-batch.mjs ZC-deep-b107 ZC-deep-b107-files.txt
TOTAL added=285 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.28  278  195  61  47  packages/provider-node/src/zcode-builtin-provider-config-source.ts
31.39  439  309  97  49  packages/shared/src/mcp.ts
31.44  260  194  61  47  packages/ui/src/components/workflow-timeline/WorkflowAskSettingsParts.tsx
31.52  229  165  52  47  packages/shared/src/web-remote-relay/contract.ts
31.54  198  149  47  47  packages/ui/src/resource-manager/storage/StorageCategoryDetail.tsx
31.63  282  196  62  48  packages/ui/src/hooks/useWorkspaceProviderConfigFile.ts
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.28 median=31.48 newComments=285
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `provider-node/src/zcode-builtin-provider-config-source.ts` | 内置 Provider 配置来源 | INV-01~18；Bundled/Active/Remote 统一；文件锁；候选选择与监听刷新 | 47 |
| `shared/src/mcp.ts` | MCP 类型与转换 | INV-01~18；CUA 识别；请求头兼容；Agent DTO 与守卫 | 49 |
| `shared/src/web-remote-relay/contract.ts` | 远控中继 V2 契约 | INV-01~18；严格出站/宽松响应；判别联合；HTTP 路由表 | 47 |
| `ui/src/.../WorkflowAskSettingsParts.tsx` | 确认窗设置零件 | INV-01~18；类名常量；原值恢复；并发上界步进；旧 agent 纯文本 | 47 |
| `ui/src/hooks/useWorkspaceProviderConfigFile.ts` | 配置文件路径读取 hook | INV-01~18；服务选择；版本号防旧响应；卸载清理；引用稳定 | 48 |
| `ui/src/.../StorageCategoryDetail.tsx` | 存储分类详情 | INV-01~18；分类聚合；清理条件；更多条目；定位路径拼接 | 47 |
