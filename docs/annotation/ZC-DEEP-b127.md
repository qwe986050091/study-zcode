# ZC-DEEP-B127（4 文件，+184 行）

> 范围：SQLite 迁移备份、工作区会话重建 hook、插件沙箱 guest 策略与个人 Provider 配置仓库。
> 快照：`d:\code\_annot_baseline\ZC-deep-b127\orig`；清单：`ZC-deep-b127-files.txt`。
> 目标密度 31.4%，实际落点 31.33%~31.69%。

## 1. 验收输出

```text
[ok] packages/shared/src/sqlite-migrations/backup.ts: 5 blocks, 42 lines
[ok] packages/ui/src/app-shell/useWorkspaceSessionReload.ts: 5 blocks, 42 lines
[ok] packages/desktop/src/main/pluginSandbox/guestPolicy.ts: 5 blocks, 42 lines
[ok] packages/provider-node/src/personal-provider-config-repository.ts: 7 blocks, 58 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=184
TOTAL added=184 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.69% code=142 comment=45 packages/shared/src/sqlite-migrations/backup.ts
31.48% code=162 comment=51 packages/ui/src/app-shell/useWorkspaceSessionReload.ts
31.55% code=187 comment=59 packages/desktop/src/main/pluginSandbox/guestPolicy.ts
31.33% code=233 comment=73 packages/provider-node/src/personal-provider-config-repository.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/shared/src/sqlite-migrations/backup.ts` | 迁移前表快照备份与保留份数裁剪 | 空表跳过、空间估算含余量、失败目录清理与元数据兜底 | 42 |
| `packages/ui/src/app-shell/useWorkspaceSessionReload.ts` | 工作区会话重建的入口与状态编排 | 入口防抖、身份作用域、提供者三级回退与失败回填 | 42 |
| `packages/desktop/src/main/pluginSandbox/guestPolicy.ts` | 插件沙箱 webview 的加固与挂载策略 | 三重匹配、偏好硬编码、导航白名单与 pin 生命周期 | 42 |
| `packages/provider-node/src/personal-provider-config-repository.ts` | 个人 Provider 配置读写、轮询与恢复 | 无锁读、锁内重读、规范形态版本与轮询世代过滤 | 58 |

## 3. 说明

- 四个文件首行为 `import`，文件头 `//` 块插在模块最前。
- `personal-provider-config-repository.ts` 目标 58 行，按 6 行内单块上限拆成 7 块（含恢复与轮询排期两处私有方法）。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。
