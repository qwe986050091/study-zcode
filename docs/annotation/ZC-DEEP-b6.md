# ZC-DEEP-b6

> 批次：B6。基线快照：`d:\code\_annot_baseline\ZC-deep-b6\orig`。

## 校验

```
node zc-verify.mjs ZC-deep-b6
SUMMARY files=3 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1646

deep-density --only 三文件
30.10  3012  2236  673  536  packages/ui/src/root/useRemoteWorkspaceHistory.ts
30.40  2727  2056  625  543  packages/ui/src/remote-connection-flow/index.ts
30.92  2531  1863  576  567  packages/ui/src/settings/RemotePluginSyncDialog.tsx
SUMMARY files=3 coreBelow30=0 needLines=0 min=30.10 median=30.40 newComments=1646
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/settings/RemotePluginSyncDialog.tsx` | 远程插件同步弹窗：候选、冲突、打包上传、进度与结果 | step 阶段机单向推进与回退边界；operationId 取消 ≠ 远端回滚；inline 插件"本地导出归档 → 远端导入 overwrite:false"顺序与幂等；冲突策略与 source 可重放优先级；可移植选项过滤；逐项 try/catch + finally 收尾；候选加载代际取消；默认勾选规则；syncing 期间关闭闸门；marketplace 三件套顺序；状态徽标映射；日志卡片资源清理；受控全选语义；错误文案降级 | 567 |
| `packages/ui/src/remote-connection-flow/index.ts` | 远程连接流程：配对、鉴权、目录选择、重连与后台完成 | entryEpoch / activeRequestId 代际校验；关闭弹窗的 session 所有权与 attachment 释放；minimized 与 pendingBackgroundCompletion 协议；discard 边界；错误三件套与 source-server-install-required 分类；自动升级只执行一次；目标切换后作废旧请求；取消顺序（先撤归属再取消底层）；handleConnect 防重；setConnectedSessionId 必须先于 onConnectionReady；目录步骤取消后回收 session；forceDecisionRef 卸载兜底；受控 open 与 openIntentId 消费；视图分区；SSH 共享认证与凭据类别 | 543 |
| `packages/ui/src/root/useRemoteWorkspaceHistory.ts` | 远程 workspace 历史与重连控制器 | workspaceKey 唯一身份、path 与 identity 成对；单 key 单重连 + requestId 迟到丢弃；recoveringKeys 乐观占位与精确移除；bind 后按 sessionId 重读；WSL 失败落盘例外；中性离线 vs 异常断开；关闭文案优先级链；启动自动重连条件；SSH host 分组与 sibling 独立；两阶段恢复；历史变更统一 commit；日志按 key 隔离；关闭事件按 sessionId 反查并四同步；conversation 用途不写 localWorkspacePath；controller 单一命令入口 | 536 |

合计 **1646**，与 `added` 一致。

## 关键不变量（抽取）

- 同步：取消只停止等待，不回滚已发生的远端变更；回滚必须是独立操作。
- 连接流程：`setConnectedSessionId` 必须在 `onConnectionReady` 之前，否则订阅方拿到的是上一代会话。
- 历史：每个 workspaceKey 同时最多一个重连在飞，迟到的 requestId 结果必须丢弃。
