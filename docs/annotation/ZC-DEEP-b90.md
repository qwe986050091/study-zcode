# ZC-DEEP-b90

> 批次：B90（6 文件，按 31.4% 口径计算目标 319 行，实际 +319）。
> 逐文件独立 spec、逐份自检后一次插入；单批 6 个文件。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b90\orig`；开工前 6 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b90
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=319

node check-batch.mjs ZC-deep-b90 ZC-deep-b90-files.txt
TOTAL added=319 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.28  238  179  56  53  packages/ui/src/project-sidebar/ProjectSidebarNode.tsx
31.32  244  182  57  53  packages/ui/src/WorkspaceFileTree.tsx
31.61  240  174  55  53  packages/ui/src/components/ui/command.tsx
31.61  241  174  55  53  packages/ui/src/previewPaneOfficeXlsxContent.tsx
31.61  233  174  55  53  packages/ui/src/v4/BotGroupDeliveryAction.tsx
31.67  248  180  57  54  packages/ui/src/settings-sync/SettingsSyncSelectionStep.tsx
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.28 median=31.61 newComments=319
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/components/ui/command.tsx` | cmdk 命令面板样式封装 | INV-01~18；键盘循环默认关；选中态同源；勾选与快捷键互斥 | 53 |
| `ui/src/previewPaneOfficeXlsxContent.tsx` | 只读 Excel 预览 | INV-01~18；WASM 先行；标签键位回绕；链接安全清理；错误只报一次 | 53 |
| `ui/src/project-sidebar/ProjectSidebarNode.tsx` | 侧栏项目行装配 | INV-01~18；动作统一收口；按项目 memo；移动补根需确认 | 53 |
| `ui/src/settings-sync/SettingsSyncSelectionStep.tsx` | 设置同步分类勾选 | INV-01~18；选择键含分类；分类顺序固定；三态互斥；空分类禁用 | 54 |
| `ui/src/v4/BotGroupDeliveryAction.tsx` | 群投递失败/未知操作栏 | INV-01~18；单次订阅；只展示关联投递；未知优先；禁用按条目 | 53 |
| `ui/src/WorkspaceFileTree.tsx` | 预览与目录组合面板 | INV-01~18；宽度驱动紧凑；偏好按工作区；折叠而非隐藏；自动收起 | 53 |

合计 **319**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 键盘选中态与鼠标悬停必须共用背景

`command.tsx` 让 `data-selected` 与 `hover` 指向同一个语义色。
分开定义会让键盘导航看起来「没选中」，用户误以为上下键失效。

### 2. 关闭默认工具栏必须补回工作表标签

`previewPaneOfficeXlsxContent.tsx` 用 toolbar 渲染函数补回只读标签栏。
只关闭工具栏不补回，多表 Excel 就无法在预览里切换。

### 3. 任务活动刷新不能穿透到每一行

`ProjectSidebarNode.tsx` 把任务数组拆出来单独浅比较。
整对象比较会在任务活动每秒刷新时重渲染整列项目。

### 4. 三态勾选必须互斥

`SettingsSyncSelectionStep.tsx` 的「部分选中」明确排除「全选」。
两个条件同时成立时，全选框会同时出现勾与减号。

### 5. 未知投递要给双选而不是重发

`BotGroupDeliveryAction.tsx` 对未知状态提供「已收到 / 未收到」。
只给重发会让用户重复发送同一条消息。

### 6. 目录显隐偏好必须按工作区隔离

`WorkspaceFileTree.tsx` 用远端标识或本地路径做键。
共用一份偏好会让所有工作区互相覆盖目录展开状态。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 键盘循环默认开启 | 过滤后上下键在首尾回绕 |
| 选中与悬停用两种颜色 | 键盘导航看起来没选中 |
| 勾选与快捷键标记不互斥 | 同一行出现两处标记 |
| 不关闭默认工具栏 | 只读预览出现编辑入口 |
| 关闭工具栏不补标签 | 多表 Excel 无法切表 |
| 单表也渲染标签栏 | 出现无意义的单标签 |
| 标签栏不移动焦点 | 键盘切换后焦点留在旧标签 |
| 链接安全不清理 | 卸载后仍拦截点击 |
| 项目行整对象比较 | 任务活动刷新导致整列重渲染 |
| 移动重试不限本地 | 远端缺根被引导补本地目录 |
| 补根不确认 | 未经同意添加工作区根 |
| 选择键不含分类 | 跨分类同名 Agent 互相勾选 |
| 分类顺序取返回顺序 | 分组顺序抖动 |
| 部分选中不排除全选 | 全选框同时显示勾与减号 |
| 空分类不禁用 | 可点击的全选框没有任何效果 |
| 未知投递只给重发 | 用户重复发送消息 |
| 禁用判断取全局忙碌 | 一个投递处理中其它投递不可用 |
| 导航补齐工作区字段 | 跨工作区打开丢失远端会话 |
| 自动收起写回偏好 | 紧凑布局下用户偏好被覆盖 |
| 用样式隐藏面板 | 外层占位导致预览留白 |
| 偏好不按工作区隔离 | 各工作区目录显隐互相覆盖 |

## 断点报告（续跑基线）

- 最后完成批次：**B90**（6 文件 / +319 行 / 全绿）；`added=319`、硬校验全 0。
- 累计（core+apps）：**812 文件 / 104,085 行**。
- 半插入残留：无（6 份 spec 均补足到目标行后一次插入）。
- 剩余缺口：按基线推导 **2,412 个 coreBelow30 / 37,505 行**，完成度 **73.5%**。

> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.28%~31.67%，`suspicious=0`。
