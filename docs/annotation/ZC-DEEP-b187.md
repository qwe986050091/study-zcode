# ZC-DEEP-B187（4 文件，+138 行）

> 范围：测速新建表单、TUI 子代理分区、远端附件物化、本地媒体预览协议（合计 659 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b187\orig`；清单：`ZC-deep-b187-files.txt`。
> 目标密度 31.4%，实际落点 30.97%~31.72%。

## 1. 验收输出

```text
[ok] packages/stream-animate/src/client/RunForm.tsx: 4 blocks, 35 lines
[ok] apps/zcode-cli/packages/tui/src/app-sidebar-subagents.tsx: 4 blocks, 34 lines
[ok] packages/desktop/src/host/remotePromptAttachments.ts: 4 blocks, 35 lines
[ok] packages/desktop/src/main/localMediaPreviewProtocol.ts: 4 blocks, 34 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=138
TOTAL added=138 hardBad=0 suspicious=0
```

逐文件密度：

```text
30.97% code=113 comment=35 packages/stream-animate/src/client/RunForm.tsx
31.72% code=145 comment=46 apps/zcode-cli/packages/tui/src/app-sidebar-subagents.tsx
31.30% code=246 comment=77 packages/desktop/src/host/remotePromptAttachments.ts
31.61% code=155 comment=49 packages/desktop/src/main/localMediaPreviewProtocol.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `stream-animate/src/client/RunForm.tsx` | 测速新建表单 | 受控字段与单一更新函数、阻止默认提交、运行中禁用、密钥不回显、数值上下限、标签包裹 | 35 |
| `apps/zcode-cli/packages/tui/src/app-sidebar-subagents.tsx` | 子代理分区 | 运行中优先合并、已结束按开关追加、高度估算与夹取、点击阻止冒泡、错误优先于空态 | 34 |
| `packages/desktop/src/host/remotePromptAttachments.ts` | 远端附件物化 | 空列表早退、已在根下跳过上传、根目录单次解析、失败回收、权限收紧、替换按长度倒序 | 35 |
| `packages/desktop/src/main/localMediaPreviewProtocol.ts` | 媒体预览协议 | 精确路径授权、TTL 与容量上限、二次解析复核、协议单次注册、特权方案合并、统一错误码 | 34 |

## 3. 说明

- `RunForm.tsx` 原文件无任何注释，header 22 行插在首行 import 之上；块落在组件签名、更新函数与 `return (` 前，JSX 属性区未插入。
- `app-sidebar-subagents.tsx` 首行是既有分区说明，header 插在其上；块落在组件签名、列表合并与高度估算前，`h(` 调用内部保持原样。
- `remotePromptAttachments.ts` 首行是既有职责说明，header 插在其上；块落在物化主流程、清理入口与路径构造前。
- `localMediaPreviewProtocol.ts` 的块落在注册表工厂、协议安装与方案注册前；既有安全注释未动。
- 本批 4 份 spec 均一次 check 通过，无目标行数修正。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1974 needLines=29719 min=0.00 median=31.32
本会话范围 files=4562 coreBelow30=1970 needLines=25127
```

累计 1,254 文件 / 123,079 行。
