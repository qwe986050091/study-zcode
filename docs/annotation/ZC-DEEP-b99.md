# ZC-DEEP-b99

> 批次：B99（6 文件，按 31.4% 口径计算目标 303 行，实际 +303）。
> 逐文件独立 spec、逐份自检后一次插入；单批 6 个文件，按同目录优先选批。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b99\orig`；开工前 6 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b99
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=303

node check-batch.mjs ZC-deep-b99 ZC-deep-b99-files.txt
TOTAL added=303 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.38  259  188  59  49  packages/ui/src/TaskInteractionBadge.tsx
31.61  263  193  61  50  packages/ui/src/hooks/useGlobalTaskList.ts
31.65  216  158  50  50  packages/ui/src/ModelTrajectoryExpandedContent.tsx
32.50  226  160  52  51  packages/ui/src/ToolCallBlocks/renderers.tsx
32.62  260  187  61  51  packages/ui/src/WorkspaceWebRemoteControlTrigger.tsx
32.95  233  173  57  52  packages/ui/src/settings/OffPeakHistoryTab.tsx
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.38 median=32.07 newComments=303
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ModelTrajectoryExpandedContent.tsx` | 轨迹展开正文 | INV-01~18；载荷优先；容差判定；搜索揭示 | 50 |
| `TaskInteractionBadge.tsx` | 阻塞交互胶囊 | INV-01~18；旧帧兼容；进度夹紧；单次延后 | 49 |
| `WorkspaceWebRemoteControlTrigger.tsx` | 远控入口按钮 | INV-01~18；开关前置；已连接只认 active | 51 |
| `ToolCallBlocks/renderers.tsx` | 工具块纯渲染函数 | INV-01~18；零变化不渲染；行选择隔离 | 51 |
| `hooks/useGlobalTaskList.ts` | 跨工作区任务列表 | INV-01~18；请求序号；引用稳定化 | 50 |
| `settings/OffPeakHistoryTab.tsx` | 闲时任务历史表 | INV-01~18；未执行即空态；时长下限 | 52 |

合计 **303**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 有工具载荷时不再渲染普通分段

`ModelTrajectoryExpandedContent.tsx` 在有工具结果时只渲染载荷，没有才回退到分段。
两条路径同时渲染会让同一次调用在展开态出现两份内容。

### 2. 展开后停止溢出测量

`measureOverflow` 在已展开时直接返回。否则内容撑高后仍按溢出判定，
按钮会一直显示为可展开，用户无法收起。

### 3. 已延后的问答不显示倒计时

`TaskInteractionBadge.tsx` 在 `snoozed` 态隐藏进度。保留倒计时会让进度条
在延后期间继续跳动，与「已停止」的语义相反。

### 4. 单次延后由请求标识兜住

`handleSnooze` 先写入交互标识再发请求，失败时回滚。
连点期间第二次点击被标识拦住，避免重复提交同一延后。

### 5. 远控入口的开关必须前置

`WorkspaceWebRemoteControlTrigger` 先读无存储依赖的特性开关，关闭时直接返回 null。
否则远程会话解析钩子会依赖 Tab 存储提供者，静态渲染提前抛错。

### 6. 已连接只看 active

中继重连时状态会短暂降到启动或运行，但手机配对信息仍在。
把配对信息当已连接，会让按钮显示已连接而弹层仍停在连接中。

### 7. 查询签名排序后序列化

`useGlobalTaskList` 对工作区键排序后再序列化，父组件重建 tabs 数组不会触发重查。
不排序则数组顺序变化即被视为新查询，列表反复加载。

### 8. 引用稳定化避免整表换代

每个活动帧都会产生全新列表项，逐条稳定化后内容等价的项复用旧对象。
不做稳定化，下游按引用判等会整棵列表树重渲染并重测量虚拟器。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 载荷与分段同时渲染 | 展开态出现两份相同内容 |
| 展开后仍测量溢出 | 按钮永远显示可展开，收不起来 |
| 搜索命中仍裁剪 | 命中内容被遮罩盖住 |
| 已延后仍显示倒计时 | 进度条继续跳动，语义相反 |
| 延后失败不回滚标识 | 按钮永久失效 |
| 点徽标不阻止冒泡 | 选中整行任务 |
| 特性开关后置 | 静态渲染缺提供者时抛错 |
| 配对信息当已连接 | 按钮与弹层阶段文案矛盾 |
| 查询签名不排序 | tabs 重建即重复查询 |
| 不做引用稳定化 | 每个活动帧整表重渲染 |
| 失败清空列表 | 单源异常抹掉其他工作区 |
| 已完成任务取当前时间 | 时长随时间持续增长 |
| 时长不设下限 | 刚启动显示零分钟 |
| 表头与数据行同高 | 大字号下内容被裁切 |

## 断点报告（续跑基线）

- 最后完成批次：**B99**（6 文件 / +303 行 / 全绿）；`added=303`、硬校验全 0。
- 累计（core+apps）：**866 文件 / 106,906 行**。
- 半插入残留：无（6 份 spec 均补足到目标行后一次插入）。
- 剩余缺口：按基线推导 **2,358 个 coreBelow30 / 34,684 行**，完成度 **75.5%**。

> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.38%~32.95%，`suspicious=0`。
