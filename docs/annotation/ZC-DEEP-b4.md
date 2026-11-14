# ZC-DEEP-b4

> 批次：B4。基线快照：`d:\code\_annot_baseline\ZC-deep-b4\orig`。

## 校验

```
node zc-verify.mjs ZC-deep-b4
SUMMARY files=2 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1533

deep-density --only 两文件
30.04  3673  2760  829  742  packages/ui/src/settings/AutomationEditView.tsx
30.07  5048  3735  1123  791  apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts
SUMMARY files=2 coreBelow30=0 needLines=0 min=30.04 median=30.05 newComments=1533
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts` | 协议侧服务端操作：会话创建/恢复、turn 与流式事件、fork/rewind、快照与持久化 | INV-01~35；durable 事实归属 SessionStore/eventStore；sessionId 唯一占用与创建失败五步清理；resume 同一性校验与 waitForDeactivation；deliveryKind 独立序列与 seq 幂等；streaming delta 批处理与确定性 flush；工具输入去重；导入 provenance；sendPrompt 准入与立即 ACK；activeAbortController 唯一活跃判据；stop/pause/goal 不复活终态；fork 继承；工具面 deny；persistence 单向；纯配置不 bump updatedAt；snapshot 分阶段计时；rewind keptMessageIDs；错误到 wire 错误码 | 791 |
| `packages/ui/src/settings/AutomationEditView.tsx` | 自动化编辑页：表单状态、保存事务、调度校验、运行历史 | INV-01~34；state/ref 双写；dirty 三要素；提交六步串行；cronExpr 三态（removed/preserved/built）；touched 基线；submissionContextReady 六条件；本地不做乐观回滚；保存并运行防重入；离开保护仅编辑态且 changedFields 非空；运行历史分页与页码收敛；轮询依赖收敛避免请求风暴；目标 Host 模型候选与远程 waiting；自定义重复区间；endAt 三态；日期月末收敛；状态点色同源；失效模型提示去重；trace 三出口闭环；JSX 可访问性与 id/form 成对 | 742 |

合计 **1533**，与 `added` 一致。

## 关键不变量（抽取）

- server-operations：一个 session 同时只有一个活跃 turn，判据是 `activeAbortController`，不是 UI 的 loading。
- server-operations：stop/pause 不得把已终态的 turn 复活成 running。
- AutomationEditView：`canSave` 与 `validate` 同源，避免"能点保存却提交失败"。
- AutomationEditView：保存失败不在本地做乐观回滚，由 `onSubmit` 返回 boolean 决定去留。
