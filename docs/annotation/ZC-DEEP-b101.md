# ZC-DEEP-b101

> 批次：B101（6 文件，按 31.4% 口径计算目标 297 行，实际 +297）。
> 逐文件独立 spec、逐份自检后一次插入；单批 6 个文件，按同目录优先选批。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b101\orig`；开工前 6 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b101
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=297

node check-batch.mjs ZC-deep-b101 ZC-deep-b101-files.txt
TOTAL added=297 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.25  272  192  60  48  apps/zcode-cli/packages/dynamic-workflow/src/schema/validate.ts
31.25  212  160  50  49  packages/ui/src/settings/saved-workflows/SavedWorkflowArgsTable.tsx
31.41  207  156  49  48  packages/ui/src/settings/SourceServerMigrationReportPanel.tsx
31.54  370  260  82  51  apps/zcode-cli/packages/dynamic-workflow/src/schema/emit.ts
31.68  216  161  51  48  packages/ui/src/settings/PluginScopeMenu.tsx
31.81  541  393 125  53  packages/ui/src/app-shell/WorkflowRunSidePane.tsx
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.25 median=31.47 newComments=297
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `dynamic-workflow/src/schema/emit.ts` | 类型到 JSON Schema 发射器 | INV-01~18；栈帧提升 $ref；内建与类实例拒绝；闭合对象 | 51 |
| `dynamic-workflow/src/schema/validate.ts` | schema 子集校验器 | INV-01~18；$ref 先解；anyOf 试算；required 与额外键 | 48 |
| `settings/saved-workflows/SavedWorkflowArgsTable.tsx` | 参数声明表 | INV-01~18；列宽单一来源；布尔三态；错误按行键 | 49 |
| `settings/PluginScopeMenu.tsx` | 插件作用域下拉 | INV-01~18；在线优先；远端要会话；受控选择 | 48 |
| `settings/SourceServerMigrationReportPanel.tsx` | 迁移报告面板 | INV-01~18；最新才可操作；错误码优先；只呈现不拉取 | 48 |
| `app-shell/WorkflowRunSidePane.tsx` | workflow run 详情页 | INV-01~18；父会话订阅；图按发起行取；恢复灰度门 | 53 |
