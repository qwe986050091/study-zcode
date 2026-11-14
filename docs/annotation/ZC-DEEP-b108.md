# ZC-DEEP-b108

> 批次：B108（6 文件，按 31.4% 口径目标 285 行，实际 +285）。
> 逐文件独立 spec、逐份自检后一次插入；单批 6 个文件，按缺口降序选批。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b108\orig`；开工前 6 文件均为 `newComments=0`。
> 唯一特殊处理：`ios-simulator-plugin/src/mcp/server.ts` 带 shebang，文件头改插在首行之后（见 `zc-insert.mjs` 的 shebang 分支）。

## 校验

```
node zc-verify.mjs ZC-deep-b108
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=285

node check-batch.mjs ZC-deep-b108 ZC-deep-b108-files.txt
TOTAL added=285 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.21  210  157  49  46  packages/ui/src/settings/model-provider-section/ProviderTemplatePicker.tsx
31.22  255  189  59  46  apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-flags-file.ts
31.40  559  414 130  49  apps/zcode-cli/packages/office-runtime/ui/viewers/DocxView.tsx
31.45  340  248  78  47  apps/zcode-cli/packages/core/src/tool/handlers/off-peak.ts
31.58  238  171  54  47  packages/ui/src/ToolCallBlocks/renderers/list-workflow-runs.tsx
31.90  486  348 111  50  apps/zcode-cli/packages/ios-simulator-plugin/src/mcp/server.ts
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.21 median=31.43 newComments=285
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/.../ProviderTemplatePicker.tsx` | 供应商模板选择页 | INV-01~18；分组与排序；创建反馈；卡片可访问性 | 46 |
| `ui/src/.../list-workflow-runs.tsx` | 运行记录工具卡 | INV-01~18；折叠主文案；纯文本回退；逐行状态与空态 | 47 |
| `core/src/tool/handlers/bash-readonly-policy-flags-file.ts` | 只读命令 flag 白名单 | INV-01~18；六张表；取值类型；排除项一致性 | 46 |
| `core/src/tool/handlers/off-peak.ts` | 闲时任务工具 | INV-01~18；闲时轮拒绝；端口断言；失败分类翻译 | 47 |
| `ios-simulator-plugin/src/mcp/server.ts` | iOS 模拟器 MCP 服务 | INV-01~18；schema 约束；guard 收敛；路径穿越防护 | 50 |
| `office-runtime/ui/viewers/DocxView.tsx` | docx 分页查看器 | INV-01~18；渲染副作用；锚点映射；缩放保中心；选区与截图 | 49 |
