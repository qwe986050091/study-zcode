# ZC-DEEP-B152（4 文件，+162 行）

> 范围：Core 单轮状态机、workflow 通知文案、会话标题旁路与 git 运行时安全（合计 1,343 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b152\orig`；清单：`ZC-deep-b152-files.txt`。
> 目标密度 31.4%，实际落点 31.35%~31.47%。

## 1. 验收输出

```text
[ok] apps/zcode-cli/packages/core/src/agent/turn-state.ts: 7 blocks, 40 lines
[ok] apps/zcode-cli/packages/core/src/runtime-task/workflow-notification-copy.ts: 7 blocks, 41 lines
[ok] apps/zcode-cli/packages/core/src/runtime/methods/session-title.ts: 6 blocks, 42 lines
[ok] apps/zcode-cli/packages/core/src/tool/handlers/bash-git-runtime-safety.ts: 6 blocks, 39 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=162
TOTAL added=162 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.43% code=210 comment=66 apps/zcode-cli/packages/core/src/agent/turn-state.ts
31.46% code=302 comment=95 apps/zcode-cli/packages/core/src/runtime-task/workflow-notification-copy.ts
31.47% code=375 comment=118 apps/zcode-cli/packages/core/src/runtime/methods/session-title.ts
31.35% code=185 comment=58 apps/zcode-cli/packages/core/src/tool/handlers/bash-git-runtime-safety.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `apps/zcode-cli/packages/core/src/agent/turn-state.ts` | 定义单轮阶段枚举、轮次状态、工具调度状态与阶段转移规则 | 十阶段封闭、等待类可停留、终态二选一、集合字段预置空、工厂冻结时间、转移表穷举与未知转移拒绝 | 40 |
| `apps/zcode-cli/packages/core/src/runtime-task/workflow-notification-copy.ts` | 生成 workflow run 中通知与 provider 停止原因文案 | 系统抬头防误读、provider 显示名逐级回退、五种停止原因各给原因+动作、事实行与原文附加、停滞/升级/留白/阻塞四类通知边界 | 41 |
| `apps/zcode-cli/packages/core/src/runtime/methods/session-title.ts` | 编排首条输入后的会话标题后台生成、写回与自定义改名持久化 | 旁路失败不影响主轮、一次性尝试、前置条件逐项早退、runtime headers 竞争延迟、入队冻结因果与模型上下文、写回前重读与 CAS 期望来源 | 42 |
| `apps/zcode-cli/packages/core/src/tool/handlers/bash-git-runtime-safety.ts` | 只读放行 git 前校验 cwd 的 .git 归属与仓库形态 | 复合命令逐个检查、内建包装逐层剥离、无 cwd 放行、逐级向上查找、裸仓库信号拒绝、符号链接与 gitdir 指针解析、HEAD 只认引用或对象号、commondir 视为工作树 | 39 |

## 3. 说明

- 三个文件首行为 `// ============` 分隔线且在文中重复出现，文件头统一使用 `nth: 1` 锚定文件首行。
- `turn-state.ts` 为纯类型/纯函数模块，新块只落在阶段枚举、两个接口、结果类型联合、工厂与转移表之前。
- `session-title.ts` 已有 76 行注释，新块仅补在未被覆盖的常量表、三个入口、`generateAndPersistSessionTitle` 与 `updateSession` 调用之前，未改动既有注释。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。
