# L1-A4 目标队列与 MCP——逐段密注索引

> 批次：第二轮"逐段密注"（函数体内逐分支中文注释）
> 范围：`apps/zcode-cli/packages/core/src/runtime/methods/` 下 15 个文件
> 规则：只新增注释行与紧邻空行；禁止改代码、缩进、import、字符串；保留已有文件头与英文注释
> 校验：`git diff --no-index --numstat` 删除列全部为 0；总 +94 行

## 文件清单

| 文件 | 注释主题 | +行数 | 对应链路 |
| --- | --- | --- | --- |
| `target.ts` | 候选校验重判定、verifier 无 nextAction 早退（不变量 12）、active turn 互斥（不变量 5）、active target 记账守卫、pause 失败抛错语义、store→事件写入顺序 | 13 | 链路 8 |
| `target-continuation-loop.ts` | 循环三大退出条件（abortSignal / 通知驱动+验证禁用 / 单轮返回 null）、让位不丢 lastResult | 6 | 链路 8 |
| `target-completion-verification.ts` | fail-open = 标 complete 的取舍（不变量 12）、取消返回 failed 不误标 complete、store→事件写入顺序 | 8 | 链路 8 |
| `steering.ts` | reservation 关闭竞态窗口（不变量 5）、pendingInputReservations 单消费者锁、permissionFullAccessPending 暂停 drain（不变量 3）、discard 绑定 activeTurn 实例 | 11 | 链路 7 |
| `runtime-command-queue.ts` | foregroundPromotionLease 原子出队（不变量 5）、两阶段取消第二阶段 consumeCancelPending、activeForegroundExecution 单指针 | 8 | 链路 7 |
| `runtime-command-active-loop.ts` | stale branch 消费前校验（不变量 6）、先 remove 再判 stale 防残留 | 1 | 链路 7 |
| `runtime-command-submit.ts` | 三种取消竞态窗口（入队前 / 在队列 / 刚出队）、两阶段取消（不变量 5）、settled 双保险 | 5 | 链路 7 |
| `runtime-command-generation.ts` | 命令代际校验（不变量 6）、任务事件从 registry 取出生代际（不变量 6） | 4 | 链路 7 |
| `control-only-turn.ts` | 持久化顺序 session→history→message→事件、防孤儿状态 | 2 | 链路 7 |
| `mcp.ts` | 刷新失败不更新 revision（fail-retry 取舍）、官方 CUA 双重匹配 fail-closed（不变量 11） | 6 | 链路 10 |
| `turn-tool-visibility.ts` | 按轮次类型收紧工具面（不变量 3） | 2 | 链路 10 |
| `subagent.ts` | 旧分支事件过滤（不变量 6）、权限只能收紧（不变量 3）、收尾顺序 seal→cancel、MCP 显式 fail-closed / 隐式 fail-open、resume 无历史抛 SessionNotFound | 11 | 子代理 |
| `subagent-messages.ts` | 子代理回复代际校验（不变量 6）、model-only 可见性语义 | 4 | 子代理 |
| `background.ts` | 幂等停止 alreadyTerminal、cancel 返回 undefined 标 lost、子代理清理只取消 local_bash | 9 | 后台任务 |
| `background-notifications.ts` | 通知代际校验（不变量 6）、账本 fire-and-forget 语义 | 4 | 后台任务 |

## 超 800 行文件（既有超限，非本次引入）

- `steering.ts`：1458 行
- `subagent.ts`：1108 行

## 不变量引用分布

| 不变量 | 引用文件 |
| --- | --- |
| 5（单 active turn / reservation 关闭竞态） | target.ts、steering.ts、runtime-command-queue.ts、runtime-command-submit.ts |
| 6（旧分支通知丢弃） | runtime-command-generation.ts、runtime-command-active-loop.ts、subagent.ts、subagent-messages.ts、background-notifications.ts |
| 12（fail-open 只用于裁判失败） | target.ts、target-completion-verification.ts |
| 3（权限只能收紧） | steering.ts、turn-tool-visibility.ts、subagent.ts |
| 11（CUA fail closed） | mcp.ts |
