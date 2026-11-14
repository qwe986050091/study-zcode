# ZC-DEEP-B196（4 文件，+130 行）

> 范围：任务重命名对话框、PPTX 元素引用药丸、轮尾工作流摘要与 Web 远控请求器（合计 505 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b196\orig`；清单：`ZC-deep-b196-files.txt`。
> 目标密度 31.4%，实际落点 31.33%~31.82%。

## 1. 验收输出

```text
[ok] packages/ui/src/TaskRenameDialog.tsx: 4 blocks, 33 lines
[ok] packages/ui/src/v4/composer/PptxElementReferenceChip.tsx: 4 blocks, 32 lines
[ok] packages/ui/src/v4/ConversationWorkflowDigests.tsx: 4 blocks, 33 lines
[ok] packages/web/src/web-remote-control/adapters/payloadRequester.ts: 4 blocks, 32 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=130
TOTAL added=130 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.82% code=110 comment=35 packages/ui/src/TaskRenameDialog.tsx
31.37% code=102 comment=32 packages/ui/src/v4/composer/PptxElementReferenceChip.tsx
31.33% code=166 comment=52 packages/ui/src/v4/ConversationWorkflowDigests.tsx
31.50% code=127 comment=40 packages/web/src/web-remote-control/adapters/payloadRequester.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/TaskRenameDialog.tsx` | 任务重命名弹框 | 输入法组合拦截、双源判定、受控值、日志只带长度、取消不提交 | 33 |
| `v4/composer/PptxElementReferenceChip.tsx` | PPTX 引用药丸 | 空数组早退、单复数文案、四级文本回退、打开降级、删除阻冒泡 | 32 |
| `v4/ConversationWorkflowDigests.tsx` | 轮尾摘要卡 | 空摘要早退、设置轮单行、五类回调门控、可选字段展开、键与测试标识 | 33 |
| `web-remote-control/adapters/payloadRequester.ts` | 远控请求挂起表 | 可恢复判定、恢复单例、超时清理、发送失败即报、响应消费与销毁 | 32 |

## 3. 说明

- `TaskRenameDialog.tsx` 的块落在组件签名、组合标记引用与 `return (` 前；既有两行输入法注释与两处日志未动，
  JSX 属性区未插入。
- `PptxElementReferenceChip.tsx` 原为零注释，块落在文本回退函数、组件签名与外层返回前；
  两条 `return (` 中仅组件主体一处命中，打开/只读双分支保持原样。
- `ConversationWorkflowDigests.tsx` 既有文件 JSDoc 未动，块落在组件签名、`onOpenRun` 派生与 `const card` 前；
  五类回调派生体与三处既有说明注释保持原样。
- `payloadRequester.ts` 的块落在可恢复判定函数、恢复工厂与请求器工厂前；三处 Bugfix 注释未动。
- 本批 4 份 spec 均一次 check 通过，所有锚点经计数确认唯一。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1938 needLines=28594 min=0.00 median=31.33
本会话范围 files=4562 coreBelow30=1934 needLines=24002
```

累计 1,290 文件 / 124,257 行。
