# ZC-DEEP-b121

> 批次：B121（4 文件，按 31.4% 口径目标 176 行，落地 176 行）。
> 逐文件独立 spec、逐份自检后按序插入；按 4 文件小批控制单轮步数。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b121`。
> 首选项仍为 `bootstrap/src/app/script-workflow-child-source.ts`（`String.raw` 子进程源码字符串），
> 插入注释会改动运行时源码，按既定规则跳过，顺延到后续批次。

## 校验

```
node zc-verify.mjs ZC-deep-b121
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=176

node check-batch.mjs ZC-deep-b121 ZC-deep-b121-files.txt
TOTAL added=176 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.43  140   44  44  packages/shared/src/assistant-presentation.ts
31.60  212   67  44  packages/shared/src/workspaceFileSearch.ts
31.37  153   48  43  packages/ui/src/lib/chatPrepareError.ts
31.55  317  100  45  packages/ui/src/lib/patchDiffPreview.ts
min=31.37 max=31.60 added=176
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `shared/src/assistant-presentation.ts` | 助手消息部件投影为内容、思考与工具调用块 | INV-01~18；回退三件套顺序；根调用过滤；按标识索引；单次渲染；三种进行态；最新块与历史块切分 | 44 |
| `shared/src/workspaceFileSearch.ts` | 工作区文件搜索候选构建、模糊打分与 top-K 过滤 | INV-01~18；展示上限；一次归一化建索引；三档打分；热路径版本；稳定排序；二分插入全序 | 44 |
| `ui/src/lib/chatPrepareError.ts` | 聊天与工作区准备错误归一化与用户文案 | INV-01~18；稳定缺失码；未就绪归一化；详情串顺序；类型化字符串化；白名单透传；缓存复用 | 43 |
| `ui/src/lib/patchDiffPreview.ts` | 补丁差异降级判定与纯文本预览行生成 | INV-01~18；四组阈值；截断标记；锁文件与后缀强制降级；hunk 行数消费；元信息回退；空行收尾 | 45 |
