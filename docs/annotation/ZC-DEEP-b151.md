# ZC-DEEP-B151（1 文件，+55 行）

> 范围：Core 运行时单轮输入接纳与执行主链（1,361 行，单独成批）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b151\orig`；清单：`ZC-deep-b151-files.txt`。
> 目标密度 31.4%，实际落点 31.42%。

## 1. 验收输出

```text
[ok] apps/zcode-cli/packages/core/src/runtime/methods/turn.ts: 10 blocks, 55 lines
SUMMARY files=1 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=55
TOTAL added=55 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.42% code=1063 comment=334 apps/zcode-cli/packages/core/src/runtime/methods/turn.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | ---: | ---: |
| `apps/zcode-cli/packages/core/src/runtime/methods/turn.ts` | Agent 单轮输入的接纳、执行与成功/失败收尾 | 入口冻结模型与风格、事件缓冲、阶段观测、创建失败保留输入、活跃 turn 唯一、终态唯一出口与 finally 清理 | 55 |

## 3. 说明

- 文件首行为 `/**`，且在文中出现 3 次；文件头使用 `nth: 1` 锚定首个块注释起点，插入后位于原 JSDoc 之前。
- 该文件已有大量根因注释（330 行），新块只落在未被注释覆盖的变量声明、函数签名与调用语句前，未改写任何既有注释。
- 块数 10，包含 6 个 4 行块与 3 个 3 行块，外加 22 行文件头，合计 55 行。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。
