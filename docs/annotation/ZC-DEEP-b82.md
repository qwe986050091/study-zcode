# ZC-DEEP-b82

> 批次：B82（6 文件，按 31.4% 口径计算目标 339 行，实际 +339，无补插）。
> 逐文件独立 spec、逐份自检后一次插入；单批 6 个文件。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b82\orig`；开工前 6 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b82
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=339

node check-batch.mjs ZC-deep-b82 ZC-deep-b82-files.txt
TOTAL added=339 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.15   243   183   57   56  packages/ui/src/project-sidebar/useProjectRemoteSync.tsx
31.25   232   176   55   55  packages/ui/src/project-sidebar/ArchiveManagement.tsx
31.25   330   240   75   57  packages/ui/src/project-sidebar/view.ts
31.39   324   223   70   57  packages/ui/src/store/remoteWorkspaceSessionStore.ts
31.60   325   231   73   57  packages/ui/src/v4/telemetry/ConversationTelemetryAttachment.tsx
31.61   269   193   61   57  packages/ui/src/v4/attachmentUploadTransaction.ts
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.15 median=31.32 newComments=339
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/project-sidebar/useProjectRemoteSync.tsx` | 侧栏远端同步动作 Hook | INV-01~18；菜单不创建连接；只对在线主机出动作；选择态持续自证；失效自动清空；回调按目标作用域刷新 | 56 |
| `ui/src/project-sidebar/view.ts` | 项目树纯派生 | INV-01~18；活动只覆盖已有行；等价复用；比较器共享；置顶与归档互斥；未读去重与同源 | 57 |
| `ui/src/project-sidebar/ArchiveManagement.tsx` | 归档管理页外壳 | INV-01~18；上下文由外层提供；分组同源；禁用条件全覆盖；四种状态提示互不遮蔽 | 55 |
| `ui/src/store/remoteWorkspaceSessionStore.ts` | 远端会话登记 store | INV-01~18；会话标识为键；路径与身份双索引；注销单次更新；预分配服务代际；解析顺序固定 | 57 |
| `ui/src/v4/attachmentUploadTransaction.ts` | 附件分片上传事务 | INV-01~18；分片可三整除；预检先于解码；每帧计量；进度单调；续传索引；中止不掩盖原错 | 57 |
| `ui/src/v4/telemetry/ConversationTelemetryAttachment.tsx` | 会话遥测监督器挂载 | INV-01~18；三键登记；换代出册与陈旧标记；引用计数归零才销毁；懒订阅；销毁顺序固定 | 57 |

合计 **339**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 展示同步菜单不得产生远端副作用

`useProjectRemoteSync.tsx` 只在点击后写入目标，连接与标签页仍由对话框内的确认动作建立。
若在 Hook 顶部建立连接，侧栏每次渲染都会拉活远端，空闲工作区被无故占用。

### 2. 选择态必须持续自证有效

主机在线、会话身份一致、非 Web 回放三者同时成立才渲染对话框，失效即清空。
只校验主机不校验身份，会在会话换代后把同步请求打到上一代的服务上。

### 3. 注销必须在单次更新内完成

`remoteWorkspaceSessionStore.ts` 的注销同时返回三张新表。
分多次写入会让订阅者在中间态读到悬空索引，按旧标识取到已终结的附着。

### 4. 换代先预分配代际再终结旧附着

顺序颠倒时，迟到的中间代理会把传输切回旧代，挂起请求跨代永久悬置。

### 5. 上传长度预检先于解码

`attachmentUploadTransaction.ts` 先按 base64 长度估算字节数并与上限比较，再解码。
反过来会让超大载荷先占满内存，才在下一步被拒绝。

### 6. 监督器销毁顺序固定

先出册、再释放订阅、最后销毁监督器。
顺序颠倒会在销毁过程中触发回调重入，访问已释放的登记项。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 菜单派生处创建连接 | 悬停即拉活远端工作区 |
| 只校验主机不校验身份 | 会话换代后同步打到旧代 |
| 失效选择不清空 | 对话框保持打开并复用过期会话 |
| 注销分多次更新 | 订阅者读到悬空索引 |
| 只清标识不清身份索引 | 新会话按旧标识取到已销毁服务 |
| 注册前不预分配代际 | 迟到代理把传输切回旧代 |
| 先解码再判长度 | 超大载荷先占满内存 |
| 分片索引固定从零 | 断点重试重复上传已收分片 |
| 归零即销毁监督器 | 后台保活期事件丢失 |
| 销毁顺序颠倒 | 回调在销毁中重入 |
| 未读统计含归档行 | 蓝点数量永不清零 |

## 断点报告（续跑基线）

- 最后完成批次：**B82**（6 文件 / +339 行 / 全绿）；`added=339`、硬校验全 0。
- 累计（core+apps）：**764 文件 / 101,479 行**。
- 半插入残留：无（6 份 spec 的插入行数与文件实际增量逐一对齐）。
- 剩余缺口：按基线推导 **2,460 个 coreBelow30 / 40,111 行**，完成度 **71.7%**。

> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.15%~31.61%，`suspicious=0`。
