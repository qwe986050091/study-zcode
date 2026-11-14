# ZC-DEEP-b8

> 批次：B8。基线快照：`d:\code\_annot_baseline\ZC-deep-b8\orig`。

## 校验

```
node zc-verify.mjs ZC-deep-b8
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1968

deep-density --only 四文件
30.02  2597  1932  580  491  packages/web/src/main.tsx
30.03  2514  1848  555  493  packages/desktop/src/main/webRemoteControlManager.ts
30.09  3284  2486  748  494  packages/ui/src/v4/ConversationComposer.tsx
30.30  2229  1693  513  490  packages/ui/src/settings/SourceServerManagementPanel.tsx
SUMMARY files=4 coreBelow30=0 needLines=0 min=30.02 median=30.06 newComments=1968
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/desktop/src/main/webRemoteControlManager.ts` | 手机远控：配对票据、bridge/relay、设备 SID、任务视图与断连宽限 | INV-01~20；windowId→Runtime 唯一事实源；currentBridge 与 bridgeOpen 分离；bridge-ready 先入 transport 再开闸；raw RPC 重放所有权归 relayProtocol；degraded 单向闩锁；身份三元组与 intentKey 冲突拒绝；手机 fault 只释放 attachment，不踢物理 Host；workspace 可桥接双条件；统一 workspace key 解析；启动票据一次性 30s TTL 三重匹配；设备 SID 注册串行；auth-required 终态不自动重试；lifecycle/auth 通知代际；mobileTaskView 只接受 paired+epoch+seq 递增；3s 宽限只影响展示 | 493 |
| `packages/ui/src/v4/ConversationComposer.tsx` | 会话输入框：草稿持久化、提交、附件、队列与快捷键 | INV-01~27；草稿作用域与持久化 timer；提交前 claim 与回滚；附件与媒体预览顺序；插件 UI/元素引用上下文；rAF 聚焦重试；恢复请求一次性；sendAction 门禁与路由判定；telemetry 种子与错误上报时机；队列确认与 blocked 分支；promptHistory 回滚；命令解析订阅；卸载期 flush/pagehide；移动端视口与快捷键；stop/send 按钮派生条件 | 494 |
| `packages/web/src/main.tsx` | Web 客户端启动装配：root、平台注入、路由、分享页与远控互斥 | INV-01~17；启动顺序与单一 root；streamClientId 固化；isPageUnloading；失败页与重试动作分叉；workspaceKey 与跨 workspace 已读；平台代理能力；路由判定；恢复超时；主题只读与分享页浅色；OAuth 回调页；分享/远控互斥；ErrorBoundary 范围；监听只注册一次；relay 协议切换与 pending；bridge 注册/回收 | 491 |
| `packages/ui/src/settings/SourceServerManagementPanel.tsx` | 源服务器管理：增删改、连通性、迁移与设备卡片 | INV-01~15；scope 互斥（同设备串行、跨设备并行）；operationsRef 与 state 双写；finally 释放；快照快/慢路径；删除与迁移确认；面板级统一错误位；mountedRef 卸载保护；目标设备一次性聚焦；60s 相对时间心跳；展开态派生与日志按 sourceServerId；迁移报告按设备累积；统一投影；启动自动重连乐观回填；危险操作 scope；孤儿连接与未完成连接清理 | 490 |

合计 **1968**，与 `added` 一致。

## 关键不变量（抽取）

- 远控：手机 fault 只释放 attachment，不得停掉桌面 Host/Agent（手机不另起运行时）。
- 远控：degraded 是单向闩锁，一旦降级不能靠重连"猜"回正常。
- Web：分享页与远控互斥，二者同时激活会让同一 relay 连接出现两个所有者。
- 源服务器：同一设备的操作串行、跨设备可并行；并发释放必须走 finally。
