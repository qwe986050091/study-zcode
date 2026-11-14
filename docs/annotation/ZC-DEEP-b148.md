# ZC-DEEP-B148（4 文件，+158 行）

> 范围：远端连接进度卡、数据目录设置控件、代码评论预览 store、插件启停乐观更新。
> 快照：`d:\code\_annot_baseline\ZC-deep-b148\orig`；清单：`ZC-deep-b148-files.txt`。
> 目标密度 31.4%，实际落点 31.20%~31.54%。

## 1. 验收输出

```text
[ok] packages/ui/src/remote-connection-flow/ui/RemoteConnectionProgress.tsx: 7 blocks, 40 lines
[ok] packages/ui/src/settings/DataBaseDirControl.tsx: 6 blocks, 39 lines
[ok] packages/ui/src/store/codeCommentPreviewStore.ts: 6 blocks, 39 lines
[ok] packages/ui/src/store/pluginManagementStoreEnabled.ts: 7 blocks, 40 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=158
TOTAL added=158 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.54% code=130 comment=41 packages/ui/src/remote-connection-flow/ui/RemoteConnectionProgress.tsx
31.34% code=134 comment=42 packages/ui/src/settings/DataBaseDirControl.tsx
31.20% code=125 comment=39 packages/ui/src/store/codeCommentPreviewStore.ts
31.43% code=140 comment=44 packages/ui/src/store/pluginManagementStoreEnabled.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/remote-connection-flow/ui/RemoteConnectionProgress.tsx` | 连接进度的发布订阅与最小化进度卡 | 双上下文分离、阶段推导、百分比口径与标题优先级 | 40 |
| `packages/ui/src/settings/DataBaseDirControl.tsx` | 数据目录设置的草稿编辑、目录选择与保存迁移 | 草稿与配置分离、浏览只改草稿、保存才迁移与错误分类 | 39 |
| `packages/ui/src/store/codeCommentPreviewStore.ts` | 按工作区与源路径分桶缓存代码评论预览 | 桶键构成、空数组常量化、按 id 去重与前缀删除 | 39 |
| `packages/ui/src/store/pluginManagementStoreEnabled.ts` | 插件启停的乐观更新、过期响应与失败回滚 | 请求序号、弱映射隔离、当前请求校验与收尾清理 | 40 |

## 3. 说明

- `RemoteConnectionProgress.tsx` 已有发布回环根因注释，正文块避开该行，落在上下文与计算语句上。
- `DataBaseDirControl.tsx` 的浏览/保存回调内已有 3 行根因注释，锚点选在 `useCallback` 签名与函数体首行，未改写既有注释。
- `codeCommentPreviewStore.ts` 与 `pluginManagementStoreEnabled.ts` 为状态层文件，块锚点均为属性或函数签名，插入在写操作之前。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。
