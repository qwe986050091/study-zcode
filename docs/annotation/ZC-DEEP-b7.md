# ZC-DEEP-b7

> 批次：B7。基线快照：`d:\code\_annot_baseline\ZC-deep-b7\orig`。

## 校验

```
node zc-verify.mjs ZC-deep-b7
SUMMARY files=3 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1558

deep-density --only 三文件
30.09  3161  2343  705  513  packages/desktop/src/main/index.ts
30.36  2919  2200  668  521  packages/ui/src/v4/ConversationRowView.tsx
31.64  2434  1792  567  524  packages/ui/src/settings/SubagentsSection.tsx
SUMMARY files=3 coreBelow30=0 needLines=0 min=30.09 median=30.36 newComments=1558
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/v4/ConversationRowView.tsx` | 会话行渲染：按 row.kind 分派到消息/工具/权限/工作流/子代理等特化视图 | switch 完备性与 default 空渲染的向下兼容；`data-row-id` 作为虚拟列表/选择/e2e 唯一锚点；memo 边界与模块级空常量；轮尾动作三条件与整轮 copyText；streaming 由 row.state 派生与未闭合标记容错；评论卡/预览卡挂载条件；附件读取 AbortController + 请求序号 + object URL 记账；预览打开/关闭/失败与迟到响应丢弃；编辑态附件两数组同长同删；userInput 编辑事务三态；仅修改会话复用提交流程；反馈乐观更新与 CAS 回滚；timelineMarker 优先级；workflow 三种特化判定顺序；subagent 裸行兜底与宿主回调映射 | 521 |
| `packages/desktop/src/main/index.ts` | Electron Main 入口：窗口/Host 生命周期、单实例、退出、托盘、自动更新 | ready 前 scheme/权限注册时序；单实例锁与 second-instance 转交；窗口↔Host 一对一与 map 清理；before-quit 首次拦截二次放行；prepareAppQuit 幂等与超时预算不可延长；退出顺序（停采样→停调度→flush 遥测→回收 Host→放行）；forceQuit/explicitQuit 语义分离；托盘能力探测与 Linux 延迟创建；closeToTray 与最后一个应用窗口；环境采集 fallback 与登录 shell 有界等待；端点解析单一入口；强制升级 gate；更新安装前资源锁清理；遥测前台态；渲染进程崩溃复位 | 513 |
| `packages/ui/src/settings/SubagentsSection.tsx` | 子代理设置：作用域、表单、保存/删除、模型与工具配置 | selectedScopeKey 单一所有者；requestId + requestTargetKey 双判据丢弃迟到响应；rpcReady 早退与四种互斥空态；插件投影去重与分组键优先级；表单初值归一化与等价刷新；保存事务与写后刷新（失败不回滚磁盘）；删除按 agent.id 身份；enabled 仅 user scope；覆盖写入双通道；模型可用性三道放行；reasoning 状态机 fail-open；工具三态与 preserved 未知项保真；validate 与 canSave 同源；搜索过滤口径；图标/徽标投影与窄屏栅格 | 524 |

合计 **1558**，与 `added` 一致。

## 关键不变量（抽取）

- 渲染：`data-row-id` 是虚拟列表、选择与 e2e 的唯一锚点，不能因分支重排而丢失。
- Main：`prepareAppQuit` 只能执行一次并共享 in-flight Promise，重复执行会让 Host 被回收两次。
- 设置：保存失败不回滚磁盘状态（真值在磁盘），只刷新读回结果。
