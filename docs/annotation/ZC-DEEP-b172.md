# ZC-DEEP-B172（4 文件，+147 行）

> 范围：压缩摘要请求降级、Goal 摘要标题、工作区检点账本与 Bash 模型可见内容（合计 1,066 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b172\orig`；清单：`ZC-deep-b172-files.txt`。
> 目标密度 31.4%，实际落点 31.30%~31.50%。

## 1. 验收输出

```text
[ok] apps/zcode-cli/packages/core/src/runtime/methods/compact-summary-model-request.ts: 5 blocks, 38 lines
[ok] apps/zcode-cli/packages/core/src/runtime/methods/goal-summary-title.ts: 4 blocks, 37 lines
[ok] apps/zcode-cli/packages/core/src/runtime/methods/workspace-checkpoint-persistence.ts: 5 blocks, 36 lines
[ok] apps/zcode-cli/packages/core/src/tool/handlers/bash-model-content.ts: 5 blocks, 36 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=147
TOTAL added=147 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.44% code=369 comment=116 apps/zcode-cli/packages/core/src/runtime/methods/compact-summary-model-request.ts
31.50% code=273 comment=86 apps/zcode-cli/packages/core/src/runtime/methods/goal-summary-title.ts
31.30% code=246 comment=77 apps/zcode-cli/packages/core/src/runtime/methods/workspace-checkpoint-persistence.ts
31.46% code=178 comment=56 apps/zcode-cli/packages/core/src/tool/handlers/bash-model-content.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `.../runtime/methods/compact-summary-model-request.ts` | 摘要流式请求与未提交时降级 | 提交判定按协议来源分流、已提交禁止重发、取消与超窗原样抛出、仅响应体阶段可重发、逻辑调用标识贯穿两次传输 | 38 |
| `.../runtime/methods/goal-summary-title.ts` | Goal 摘要标题生成与兜底 | 入口只启动后台任务、兜底纳入驻留工作、写前重读目标、标题未变不写、更新结果再校验 | 37 |
| `.../runtime/methods/workspace-checkpoint-persistence.ts` | 检查点与文件撤销的持久账本 | 写入尽力而为、标识派生幂等、回放按原序号、单条损坏只跳过、逐字段校验 | 36 |
| `.../tool/handlers/bash-model-content.ts` | Bash 结果的模型可见内容 | 结构化优先透传、解析失败降级、持久化只回预览、中断补错误标记、单文件路径口径唯一 | 36 |

## 3. 说明

- `compact-summary-model-request.ts` 的块落在入口状态创建、事件分派函数、失败处理函数与提交函数入口，未插入 switch 分支内部。
- `goal-summary-title.ts` 的块落在两个对外入口与准入函数签名前，未进入日志对象字面量。
- `workspace-checkpoint-persistence.ts` 的块落在四条写读入口签名前，恢复循环体保持零改动。
- `bash-model-content.ts` 的块落在两个导出入口与两个内部格式化函数签名前。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=2034 needLines=31689 min=0.00 median=31.31
本会话范围 files=4562 coreBelow30=2030 needLines=27097
```

累计 1,194 文件 / 121,009 行。
