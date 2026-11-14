# ZC-DEEP-b87

> 批次：B87（6 文件，按 31.4% 口径计算目标 325 行，实际 +325，无补插）。
> 逐文件独立 spec、逐份自检后一次插入；单批 6 个文件。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b87\orig`；开工前 6 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b87
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=325

node check-batch.mjs ZC-deep-b87 ZC-deep-b87-files.txt
TOTAL added=325 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.25   266   192   60   54  packages/ui/src/settings/model-provider-section/StartPlanBalanceCard.tsx
31.32   242   182   57   55  packages/ui/src/workspace-file-tree/WorkspaceFileTreeList.tsx
31.35   244   185   58   54  packages/ui/src/WorkspaceSidebar/RemoteProjectDetailsPopover.tsx
31.37   291   204   64   54  packages/ui/src/terminal/terminalComposedInputFallback.ts
31.58   226   171   54   54  packages/ui/src/project-sidebar/ArchiveGroupCard.tsx
31.64   239   177   56   54  packages/provider/src/config/rule-data-schema.ts
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.25 median=31.36 newComments=325
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/workspace-file-tree/WorkspaceFileTreeList.tsx` | 工作区文件树虚拟列表 | INV-01~18；吸顶遮罩偏移；三种非列表态优先级；行渲染与属性透传 | 55 |
| `provider/src/config/rule-data-schema.ts` | 模型与 Provider 规则 schema | INV-01~18；严格对象；正则锚定；智能/手动互斥；标识唯一性 | 54 |
| `ui/src/project-sidebar/ArchiveGroupCard.tsx` | 归档分组折叠卡 | INV-01~18；收起不挂载；50 条增量展开；批量与单行委托；日期来源 | 54 |
| `ui/src/settings/model-provider-section/StartPlanBalanceCard.tsx` | 开始计划余额卡 | INV-01~18；可见桶过滤；服务端顺序；比例夹取；套餐归属精确 | 54 |
| `ui/src/terminal/terminalComposedInputFallback.ts` | 终端组合输入兜底纯函数 | INV-01~18；纯文本判断；严格相等；单次消费；时间窗与容差 | 54 |
| `ui/src/WorkspaceSidebar/RemoteProjectDetailsPopover.tsx` | 远程项目详情浮层 | INV-01~18；虚拟锚点；悬停/点击双模；定时器清理；关闭聚焦 | 54 |

合计 **325**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 吸顶遮罩只做视觉隐藏，不改布局

`WorkspaceFileTreeList.tsx` 通过 CSS 变量接收滚动偏移，遮罩尺寸扣掉偏移；吸顶数为零时直接不生成遮罩。
把遮罩实现成高度压缩会改变滚动范围，列表底部出现无法滚动到的行。

### 2. 规则模式必须整串锚定

`rule-data-schema.ts` 在编译正则前加首尾锚定，非法正则直接判为校验失败。
只匹配子串会让「gpt-4」模式命中「gpt-4o-mini」，规则命中范围被放大。

### 3. 归档分组收起时不构造行

`ArchiveGroupCard.tsx` 用展开条件控制整段内容的挂载，而不是隐藏样式。
上千行同时挂载会放大全局样式重算，侧栏第一次展开明显卡顿。

### 4. 余额桶过滤不重排

`StartPlanBalanceCard.tsx` 只按正数过滤，保持后端返回的原序。
前端按余量重排会与服务端配置的产品优先级和用户预期冲突。

### 5. 组合输入兜底必须单次消费

`terminalComposedInputFallback.ts` 命中记录后同时标记历史与待补对象。
只标记一侧会让同段数据被按键路径与输入路径各写一次，终端出现重复字符。

### 6. 详情浮层的定时器必须成对清理

`RemoteProjectDetailsPopover.tsx` 用同一清理函数清掉进入与离开两个定时器。
禁用或卸载时漏清会让残留的打开请求在组件不可见后触发。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 遮罩改高度而非裁切 | 滚动范围变化、底部行不可达 |
| 吸顶数为零仍生成遮罩 | 列表首行被裁 |
| 正则不锚定 | 规则误命中相近模型名 |
| 智能/手动互斥缺失 | 同一组合后写覆盖前写 |
| 收起仍挂载全部行 | 展开时整侧栏卡顿 |
| 展开增量与初始值分叉 | 点更多跳变条数 |
| 前端重排额度桶 | 与服务端优先级不一致 |
| 余量比例不夹取 | 进度条越界 |
| 兜底只标记一侧 | 终端重复输入 |
| 时间窗缺失 | 过期候选被消费 |
| 浮层定时器漏清 | 卸载后仍弹层 |
| 关闭不还原焦点 | 键盘用户焦点丢失 |
| 禁用不清计时 | 禁用后仍被悬停打开 |
| 行键用下标 | 删行后状态错位 |
| 批量操作传单行 | 只处理一行 |

## 断点报告（续跑基线）

- 最后完成批次：**B87**（6 文件 / +325 行 / 全绿）；`added=325`、硬校验全 0。
- 累计（core+apps）：**794 文件 / 103,127 行**。
- 半插入残留：无（6 份 spec 的插入行数与文件实际增量逐一对齐）。
- 剩余缺口：按基线推导 **2,430 个 coreBelow30 / 38,463 行**，完成度 **72.8%**。

> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.25%~31.64%，`suspicious=0`。
