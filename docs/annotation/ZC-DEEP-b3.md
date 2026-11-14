# ZC-DEEP-b3

> 批次：B3。基线快照：`d:\code\_annot_baseline\ZC-deep-b3\orig`。

## 校验

```
node zc-verify.mjs ZC-deep-b3
SUMMARY files=2 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1700

deep-density --only 两文件
30.02  5234  3881  1165  853  packages/shared/src/zcode-protocol/index.ts
30.17  5478  4054  1223  847  packages/desktop/src/main/browserView/browserGuestManager.ts
SUMMARY files=2 coreBelow30=0 needLines=0 min=30.02 median=30.09 newComments=1700
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/shared/src/zcode-protocol/index.ts` | 全仓共享的协议契约：消息判别联合、错误码、事件、版本兼容 | 协议版本双轨与兼容窗口；未知字段拒绝边界；只增不改的联合约束；错误码与 payload 语义；事件封闭集；legacy/v4 镜像；遥测隐私字段；载荷上界；时间形态校验；requestId 双形态；topic/resource 关联键；totalChunks 推导与 checksum；MCP OAuth/transport 字段；插件作用域三元组；tool result/error 互斥；expectedRevision 乐观锁；automation 配对；off-peak 失败两维；seq 单调与 state.updated scope | 853 |
| `packages/desktop/src/main/browserView/browserGuestManager.ts` | 内嵌浏览器 guest 的进程/视图生命周期、IPC 授权与资源回收 | 执行上下文作为唯一 IPC 授权凭证；tab 生命周期与 CDP 绑定正交；scopeKey 复合键与 legacy scope；attachGuest 校验顺序；guestGeneration 换代与 stale 命令拒绝；suspension generation 单调；waiter 超时/取消；runningRequests 去重；截图 tracker 上限；录制终态幂等；下载早到队列配对；viewport 优先级与串行化；tab registry 与 tombstone；closeTab/closeWindow/closeSession 顺序；CDP attach/detach 与空闲释放；恢复快照顺序；三类 flight 单飞；监听随换代注销；disposeAll 收口 | 847 |

合计 **1700**，与 `added` 一致。

## 关键不变量（抽取）

- 协议：未知字段一律拒绝（`.strict`），避免新旧端字段漂移被静默吞掉。
- 协议：判别联合只增不改，删除/改名会让旧客户端整条消息被判非法。
- guest：执行上下文（window/workspace/session/remoteSession）是唯一授权凭证，不看 UI 自报身份。
- guest：换代后迟到的 attach 必须 fail-closed，不能挂到新代际的 view 上。
