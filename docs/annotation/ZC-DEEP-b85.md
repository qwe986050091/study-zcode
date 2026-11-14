# ZC-DEEP-b85

> 批次：B85（6 文件，按 31.4% 口径计算目标 327 行，实际 +327，无补插）。
> 逐文件独立 spec、逐份自检后一次插入；单批 6 个文件。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b85\orig`；开工前 6 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b85
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=327

node check-batch.mjs ZC-deep-b85 ZC-deep-b85-files.txt
TOTAL added=327 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.22   301   221   69   55  packages/ui/src/ConfirmDialog.tsx
31.28   252   179   56   54  packages/ui/src/WorkspaceEditorButtonGroup.tsx
31.41   263   191   60   54  packages/ui/src/ModelTrajectoryTimeline.tsx
31.58   234   171   54   54  packages/ui/src/v4/ConversationHookDetailsAction.tsx
31.60   302   212   67   55  packages/ui/src/previewPaneOfficeDocxContent.tsx
31.67   244   180   57   55  packages/ui/src/v4/ConversationShareSuccessDock.tsx
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.22 median=31.50 newComments=327
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/ConfirmDialog.tsx` | 确认对话框唯一宿主 | INV-01~18；退场快照；dismiss 与必读；Enter 捕获；危险操作焦点；两种 presentation | 55 |
| `ui/src/ModelTrajectoryTimeline.tsx` | 模型轨迹虚拟时间线 | INV-01~18；稳定键与占位；搜索期禁自动锚点；双帧高亮；差量与首条特例 | 54 |
| `ui/src/WorkspaceEditorButtonGroup.tsx` | 工作区打开编辑器按钮组 | INV-01~18；挂载拉取与 disposed；office 过滤；显式选择才持久化；远程参数组装 | 54 |
| `ui/src/previewPaneOfficeDocxContent.tsx` | DOCX 预览渲染层 | INV-01~18；唯一类名；异步隔离；缩放只缩不放；链接安全与观察器 | 55 |
| `ui/src/v4/ConversationHookDetailsAction.tsx` | 回合 hook 明细气泡 | INV-01~18；只收已执行；状态优先级；时长三档；空回合不渲染 | 54 |
| `ui/src/v4/ConversationShareSuccessDock.tsx` | 分享成功结果面板 | INV-01~18；两秒复原；Promise 归一；字节换单位；警告折叠 | 55 |

合计 **327**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 退场内容必须来自快照而非待决请求

`ConfirmDialog.tsx` 在请求结算后仍沿用最后一次可见请求，`open` 单独由待决请求决定。
直接读待决请求会让关闭动画期间标题与描述先变空，只剩两个按钮闪一帧；把快照写进 `open` 又会让弹窗永远关不掉。

### 2. 搜索期禁止虚拟器自行修正滚动锚点

`ModelTrajectoryTimeline.tsx` 在有搜索词时关闭逐项测高后的锚点修正，改由双帧后的文本级定位一次完成滚动。
不关闭会与文本定位互相拉扯，快速输入时视口先跳后抖。

### 3. 只有显式选择才写入编辑器偏好

`WorkspaceEditorButtonGroup.tsx` 区分「用户选择」与「程序化回落」，只有前者持久化。
把回落也写进偏好，下一次打开工作区会覆盖用户真正想用的编辑器。

### 4. 旧渲染任务只能停留在脱离文档树的容器里

`previewPaneOfficeDocxContent.tsx` 用 `active` 标记隔离异步结果，清理时移除临时根节点。
渲染库不提供取消能力，不做隔离会让旧文档在新文档之后完成并覆盖可见 DOM。

### 5. hook 状态映射的优先级决定图标语义

`ConversationHookDetailsAction.tsx` 先判运行中，再判超时与取消，最后才判失败。
顺序调整会把超时显示成失败，用户会按失败去排查一个只是慢的 hook。

### 6. 复制提示是自限时状态

`ConversationShareSuccessDock.tsx` 在复制成功后两秒自动复原，并保证定时器随状态重建。
提示常驻会让用户反复点击；不复位定时器会让旧计时器提前清掉新的成功态。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 退场直接读待决请求 | 关闭时文案先变空 |
| 快照写进 open 推导 | 弹窗无法关闭 |
| 必读弹窗允许 dismiss | 未确认却被记为已读 |
| 带复选框时抢 Enter | 勾选框回车误确认 |
| 虚拟键用下标 | 搜索定位滚错行 |
| 搜索期保留锚点修正 | 视口抖动 |
| 差量用当前长度当游标 | 每轮新增为空 |
| 程序化回落也持久化 | 覆盖用户偏好 |
| 服务端目标仍渲染按钮 | 远程路径交给本地 IDE |
| 异步渲染不隔离 | 旧文档覆盖新文档 |
| 只设置变换不设外层尺寸 | 残留横向滚动区 |
| 状态映射顺序颠倒 | 超时显示成失败 |
| 空回合仍渲染气泡 | 出现无内容浮层 |
| 复制失败仍显示已复制 | 用户以为链接已复制 |
| 字节数不换单位 | 上限难以阅读 |

## 断点报告（续跑基线）

- 最后完成批次：**B85**（6 文件 / +327 行 / 全绿）；`added=327`、硬校验全 0。
- 累计（core+apps）：**782 文件 / 102,465 行**。
- 半插入残留：无（6 份 spec 的插入行数与文件实际增量逐一对齐）。
- 剩余缺口：按基线推导 **2,442 个 coreBelow30 / 39,125 行**，完成度 **72.4%**。

> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.22%~31.67%，`suspicious=0`。
