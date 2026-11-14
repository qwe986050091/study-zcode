# ZC-DEEP-b2

> 批次：B2（缺口第 2 档）。基线快照：`d:\code\_annot_baseline\ZC-deep-b2\orig`。
> 规范：`DEEP-SPEC.md` v1；本批只新增整行 `//` 注释。

## 校验

```
node zc-verify.mjs ZC-deep-b2
SUMMARY files=2 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1795

deep-density --only packages/desktop/src/host/index.ts,packages/ui/src/lib/zcodeSessionProjection.ts
30.26  5087  3797  1149  900  packages/desktop/src/host/index.ts
31.22  4496  3283  1025  895  packages/ui/src/lib/zcodeSessionProjection.ts
SUMMARY files=2 coreBelow30=0 needLines=0 min=30.26 median=30.74 newComments=1795
```

前后对比：`host/index.ts` comment 249 → 1149（6.6% → 30.26%）；`zcodeSessionProjection.ts` comment 130 → 1025（4.0% → 31.22%）。两文件 code 行数均未变。

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/desktop/src/host/index.ts` | 每窗口一个 window-scoped Local Host：attachment 注册、logical session 换代、远程连接注册表、cron/off-peak 调度、remote media 与 prompt staging、退出释放 | INV-01~INV-50；requestId 恰好 settle 一次；InitLocal 幂等；databaseStartup 就绪门；activeServices 单一所有者；attachment clientMode 收敛；ExposedServicePortHandle 只摘自身句柄；远程身份不得回落本地；远程 task service Proxy 的错误边界；loopback Range vs inline 取舍；staging 目录失败回滚；disposeHostResources 阶段顺序与幂等；信号处理器不重复释放 | 900 |
| `packages/ui/src/lib/zcodeSessionProjection.ts` | 只读迁移桥：把 V4 snapshot / event 投影为 UI 呈现模型（不是真相源） | INV-01~INV-50；traceId 由 inputId 派生；activePromptInputId 清空时机；streamedTurnKeys 不等于完成；工具记忆在 turn 边界清空；tool_input_delta 物化分级；权限卡与 elicitation 互斥；ExitPlanMode 必须双项；goal verification 按 targetId+iteration 归位；compaction 失败不污染整会话；/goal 前缀恢复的匹配条件；fork 分割线；todo/plan 双视图与下标派生 id；contextUsage 优先级；usage 只认 model.complete；配置往返与 model hint 自愈 | 895 |

合计：**1795**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

- INV-02 Host 内 `activeServices` 只能有一份；两份 services 会各自持有 sqlite 与 Agent 子进程。
- INV-08 关闭一个 attachment 端口只摘自身句柄，不得断开共享 connection。
- INV-11 远程身份找不到目标 Host 必须失败，禁止回落到本地 Host。
- INV-03 projection 的 traceId 有 inputId 时必须用 inputId，否则同一轮会被拆成两组气泡。
- INV-13 工具记忆（toolNameById / streamingToolInputById）必须在 turn 边界清空，否则跨轮串参。
