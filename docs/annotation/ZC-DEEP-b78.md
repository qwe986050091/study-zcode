# ZC-DEEP-b78

> 批次：B78（6 文件，按 31.4% 口径计算目标 351 行，实际 +351，无补插）。
> 6 个 spec 并行编写（并发上限 5，最后一文串行补齐），逐文件自检后一次插入。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b78\orig`；开工前 6 文件均为 `newComments=0`（30% 口径 needLines=338）。

## 校验

```
node zc-verify.mjs ZC-deep-b78
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=351

node check-batch.mjs ZC-deep-b78 ZC-deep-b78-files.txt
TOTAL added=351 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.25   276   192    60   58  packages/ui/src/git-branch-switcher/display.ts
31.31   285   214    67   59  packages/ui/src/GitPaneChangeCard.tsx
31.35   250   185    58   58  packages/ui/src/browser-use/ResponsiveBrowserResizeHandles.tsx
31.36   314   220    69   60  packages/ui/src/ToolCallBlocks/QueuedSummaryContent.tsx
31.41   252   191    60   58  packages/ui/src/gen-ui/adapters/retainedPage.ts
31.47   271   197    62   58  packages/ui/src/cua-permission/CuaPermissionObservationAttachment.tsx
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.25 median=31.36 newComments=351
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/GitPaneChangeCard.tsx` | Git 变更卡片 | INV-01~18；props 派生与 memo 依赖；缓存键；右键菜单禁用项；加载/预览/兜底三分支 | 59 |
| `ui/src/ToolCallBlocks/QueuedSummaryContent.tsx` | 排队摘要内容 | INV-01~18；三格队列与去重；漂移跳过；原位刷新与尾部计数分离；ref 镜像与计时器所有权 | 60 |
| `ui/src/browser-use/ResponsiveBrowserResizeHandles.tsx` | 浏览器缩放把手 | INV-01~18；方向 -1/0/1 语义；边缘与角映射；层级优先；指针事件成对；受控边界 | 58 |
| `ui/src/cua-permission/CuaPermissionObservationAttachment.tsx` | CUA 权限观察附件 | INV-01~18；观察数据所有权与去重键；真值重读；重试/取消；串行队列与卸载清理 | 58 |
| `ui/src/gen-ui/adapters/retainedPage.ts` | GenUI 页面保留适配 | INV-01~18；key 三元组唯一性；准入失败回收；guest 与 owner 所有权分离；释放队列串行化；代际校验 | 58 |
| `ui/src/git-branch-switcher/display.ts` | 分支切换展示纯函数 | INV-01~18；脏文件跨组去重；游离 HEAD 判定顺序；标题回退；路径摘要截断；稳定排序 | 58 |

合计 **351**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 队列去重键必须包含调用身份

`QueuedSummaryContent.tsx` 的三格队列按调用身份去重，并跳过漂移项。
漏掉身份会让同一工具的多次调用合并成一行，用户看到的排队数量少于实际。

### 2. 原位刷新与尾部计数分开渲染

刷新已有条目不能重建 DOM，只更新尾部计数。
合并渲染会让正在读的条目闪烁并丢失滚动位置。

### 3. 指针事件必须成对作用

`ResponsiveBrowserResizeHandles.tsx` 的按下与抬起、捕获与释放成对出现。
只挂一半会在快速拖拽后留下卡住的 cursor 与继续放大的错觉。

### 4. 保留页 key 三元组唯一

`retainedPage.ts` 用三元组标识一个保留页，准入失败要立即回收额度。
键不唯一会让两个宿主争用同一页，释放时把对方的页一起拆掉。

### 5. 纯函数不持有排序外的状态

`display.ts` 的所有派生只依赖入参，排序必须稳定。
借用模块级缓存会让同一输入在不同刷新周期给出不同顺序。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 队列去重键缺少调用身份 | 多次调用合并，排队数量偏少 |
| 刷新时重建条目 DOM | 条目闪烁并丢失滚动位置 |
| 指针事件只挂一半 | 拖拽结束后光标卡住、尺寸继续变化 |
| 观察数据未按去重键收敛 | 同一观察重复触发权限提示 |
| 卸载未清理串行队列 | 组件卸载后仍发起一次权限请求 |
| 保留页键不唯一 | 两个宿主争用同一页，释放误拆 |
| 释放队列并行执行 | 代际校验失效，旧页覆盖新页 |
| 高度占位未回落 | 页面释放后留下空白高度 |
| 游离 HEAD 判定顺序颠倒 | 正常分支被误显示为游离态 |
| 排序不稳定 | 同一列表在刷新间顺序抖动 |

## 断点报告（续跑基线）

- 最后完成批次：**B77**（6 文件 / +351 行 / 全绿）；B77 复验 `added=351`、硬校验全 0。
- 累计（core+apps）：**740 文件 / 100,104 行**。
- 半插入残留：无（B78 开工前 spec / files.txt / 快照目录均不存在，B77 六文件行数与 spec 吻合）。
- 剩余缺口：按基线推导 **2,484 个 coreBelow30 / 41,486 行**，完成度 **70.7%**；
  全仓实测 `files=5032 coreBelow30=2495 needLines=51709`（services 已收口）。

> 说明：每文件独立 spec，逐文件自检 `OK blocks / lines` 后统一插入。
> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.25%~31.47%，`suspicious=0`。
