# ZC-DEEP-b80

> 批次：B80（6 文件，按 31.4% 口径计算目标 344 行，实际 +344，无补插）。
> 6 个 spec 并行编写（并发上限 5，最后一文串行补齐），逐文件自检后一次插入。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b80\orig`；开工前 6 文件均为 `newComments=0`（30% 口径 needLines=330）。

## 校验

```
node zc-verify.mjs ZC-deep-b80
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=344

node check-batch.mjs ZC-deep-b80 ZC-deep-b80-files.txt
TOTAL added=344 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.25   263   192    60   57  packages/zcode-server-cli/src/runtime/updateHandoff.ts
31.31   294   214    67   57  packages/ui/src/hooks/useModelProviders.ts
31.31   271   198    62   57  packages/zcode-server-cli/src/runtime/updateCommand.ts
31.35   253   185    58   57  packages/ui/src/hooks/usePlugins.ts
31.47   309   232    73   58  packages/ui/src/components/workflow-timeline/WorkflowSaveFields.tsx
31.56   297   225    71   58  packages/ui/src/conversation-share-interaction/conversationSharePopoverActions.ts
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.25 median=31.33 newComments=344
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/hooks/useModelProviders.ts` | 模型供应商数据 Hook | INV-01~18；有效列表派生；排序表合并；刷新令牌防竞态；新增/排序/连通性测试回写；返回对象引用稳定 | 57 |
| `ui/src/hooks/usePlugins.ts` | 插件清单 Hook | INV-01~18；工作区切换判定；初始化幂等；store 归属与自愈；刷新竞态；派生列表 memo | 57 |
| `zcode-server-cli/src/runtime/updateCommand.ts` | 本地归档更新命令 | INV-01~18；阶段进度上报；守护进程在线判定；回滚事务；在线更新准备；目标缺失即抛错 | 57 |
| `zcode-server-cli/src/runtime/updateHandoff.ts` | 更新交接与重启 | INV-01~18；守护进程启动超时；诊断输出累积；子进程句柄所有权；持久化状态优先级；锁陈旧判定；运行时身份校验 | 57 |
| `ui/src/conversation-share-interaction/conversationSharePopoverActions.ts` | 会话分享弹层动作集 | INV-01~18；选择态编辑事务；打开/关闭互斥；行级与全量选择的边界；确认后提交；取消即回滚 | 58 |
| `ui/src/components/workflow-timeline/WorkflowSaveFields.tsx` | 工作流保存表单 | INV-01~18；失败摘要结构；保存回调契约；受控输入与禁用态；下拉选项；后果提示；无障碍标注 | 58 |

合计 **344**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 刷新必须带令牌防竞态

`useModelProviders.ts` 的刷新自增令牌，回写前比对是否仍为最新。
去掉比对后，先发后到的旧响应会覆盖新结果，用户在设置页看到已删除的模型。

### 2. 初始化必须可重入

`usePlugins.ts` 的初始化以工作区路径与身份共同判定，只有不匹配时才重新拉取。
把判定放宽到「已初始化就跳过」，会在地点切换后仍展示上一个工作区的插件。

### 3. 回滚走事务而不是逐项补偿

`updateCommand.ts` 在应用新版本失败时整笔回滚到上一个 release。
拆成逐项补偿会留下半更新的产物，下一次启动直接失败且难以定位。

### 4. 交接状态的持久化优先级高于内存

`updateHandoff.ts` 读取时以磁盘状态为准，内存值只作为兜底。
顺序颠倒会让崩溃重启后读到过期状态，误判更新已完成。

### 5. 选择编辑是一次事务

`conversationSharePopoverActions.ts` 的编辑期改动只在确认时落地，取消即丢弃。
边选边写会让用户取消后仍带走部分选择，分享内容与界面不一致。

### 6. 表单禁用态由提交中与不可用共同派生

`WorkflowSaveFields.tsx` 的按钮可用性同时受保存中与字段合法性约束。
只看其中一项，会在校验失败时仍可提交，或在保存中重复触发请求。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 刷新未比对令牌 | 旧响应覆盖新列表，出现已删除项 |
| 初始化判定过宽 | 切换工作区后仍显示旧插件 |
| 更新失败逐项补偿 | 半更新产物导致下次启动失败 |
| 交接状态读内存优先 | 崩溃重启后误判更新完成 |
| 守护进程判定只看端口 | 进程已退出仍上报在线并继续重启 |
| 选择编辑边选边写 | 取消后仍残留部分选择 |
| 全量选择未处理空列表 | 空数据下产生无效确认 |
| 表单只看保存中 | 校验未通过时可提交 |
| 派生化未 memo | 父级每次渲染都重建对象，子组件全量重渲染 |
| 子进程句柄未收敛 | 超时后仍残留进程，端口被占用 |

## 断点报告（续跑基线）

- 最后完成批次：**B80**（6 文件 / +344 行 / 全绿）；`added=344`、硬校验全 0。
- 累计（core+apps）：**752 文件 / 100,797 行**。
- 半插入残留：无（B80 六份 spec 与插入结果逐文件行数吻合，无多余临时文件）。
- 剩余缺口：按基线推导 **2,472 个 coreBelow30 / 40,793 行**，完成度 **71.2%**；
  全仓实测 `files=5032 coreBelow30=2483 needLines=51039 median=30.16`（services 已收口）。

> 说明：每文件独立 spec，逐文件自检 `OK blocks / lines` 后统一插入。
> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.25%~31.56%，`suspicious=0`。
