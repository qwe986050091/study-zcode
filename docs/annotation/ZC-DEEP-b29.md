# ZC-DEEP-b29

> 批次：B29（按 10~12 文件/批的新节奏，本批 11 文件，全部位于 `packages/ui/src`）。
> 覆盖两条链路：设置域（插件商店列表、命令、Skill 同步、Hooks、套餐缓存）与
> 主界面域（Git 面板、explore 渲染器、账户区、打开按钮、预览路由、任务列表）。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b29\orig`。
> 规范母本：[ZC-DEEP-CORE-PLAN.md](./ZC-DEEP-CORE-PLAN.md)（第 5 节固定动作）。

## 校验

```
node zc-verify.mjs ZC-deep-b29
SUMMARY files=11 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1539

deep-density --baseline ZC-deep-b29/orig --ext .ts,.tsx --threshold 30 --mode code
31.44   665   493  155  148  packages/ui/src/settings/PluginStoreListView.tsx
31.56   664   488  154  145  packages/ui/src/settings/CommandsSection.tsx
31.42   652   471  148  143  packages/ui/src/settings/RemoteSkillSyncDialog.tsx
31.57   772   567  179  138  packages/ui/src/settings/HooksSection.tsx
31.59   722   516  163  138  packages/ui/src/settings/model-provider-section/useCodingPlanProducts.ts
31.53   659   463  146  145  packages/ui/src/ToolCallBlocks/renderers/explore.tsx
31.48   685   486  153  139  packages/ui/src/GitPane.tsx
31.42   633   471  148  138  packages/ui/src/WorkspaceSidebarFooter.tsx
31.54   606   447  141  135  packages/ui/src/OpenSplitButton.tsx
31.46   615   445  140  135  packages/ui/src/previewPaneContent.tsx
31.45   659   477  150  135  packages/ui/src/TaskList.tsx
SUMMARY files=11 coreBelow30=0 needLines=0 min=31.42 median=31.47 newComments=1539
PASS: all 11 file(s) >= 30% (mode=code)
```

列口径：`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`。
每个文件 `// INV-` 为 18~20 条（settings 组 20 条，主界面组 18 条）。
新增行自查：`nonComment=0`、`starSlash=0`、代码样式行（关键字开头 / 行尾分号 / 箭头函数）`suspicious=0`。

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/settings/PluginStoreListView.tsx` | 插件商店浏览投影：来源分段、搜索、UI 插件推荐、精选与分组折叠 | INV-01~20；退役条目只从商店剔除、管理页仍可见；UI 与公共插件严格互补且并集等于分段集；分段只由 `resolvePluginStoreSegment` 判定；空搜索词返回空数组且由 keyword 决定是否进搜索分支；搜索范围是 segmentItems 而非全量；展开态缺省语义为「展开」，三处读取都用空值合并取 true；折叠 key 必须带类型前缀（三类分组共用一张表）；收起时 hidden 与 visible 互补 | 148 |
| `packages/ui/src/settings/CommandsSection.tsx` | 斜杠命令设置：列表投影、Scope 解析、新建与编辑表单、外部导入入口 | INV-01~20；列表服务由 target 解析得出，不能直接取当前 Provider；表单服务独立解析但规则一致；连接未就绪不发起命令 RPC；workspace key 三段兜底（身份去空白 → 路径 → 空串）；编辑态与 Scope 切换必须同源 | 145 |
| `packages/ui/src/settings/RemoteSkillSyncDialog.tsx` | 本地用户级 Skill → 远端目标的同步弹窗：加载、选择、预检、执行 | INV-01~20；默认只勾选远端不存在的技能；已存在项必须显式勾选才可覆盖；行数据按目录名匹配远端状态（显示名不参与）；远端状态缺失按「不存在」处理，不得留未知态；预检结论与默认选择必须同源 | 143 |
| `packages/ui/src/settings/HooksSection.tsx` | Hooks 设置主容器：作用域选择、本地/插件 Hook 分组投影、编辑与导入 | INV-01~20；读写目标只由选中作用域条目决定；选中条目时路径与身份必须成对取用；可编辑判断优先尊重运行时标志；只读 zcode 行必须留在已安装分组；分组过滤不能顺手吞掉只读项 | 138 |
| `packages/ui/src/settings/model-provider-section/useCodingPlanProducts.ts` | Coding Plan 套餐读取与缓存：静态套餐、远端试算、登录态回退 | INV-01~20；请求缓存按服务实例 WeakMap 分桶；缓存的是 Promise 而非结果；强制刷新必须自增代数；写快照前校验代数；登录态回退不得覆盖远端快照 | 138 |
| `packages/ui/src/ToolCallBlocks/renderers/explore.tsx` | Explore 聚合工具调用渲染器：分类、摘要与子调用列表 | INV-01~18；分类只决定展示分组、不决定执行结果；未知输入必须兜底摘要而非抛错；命令拆分先解包再按分隔符切；shell 包装只剥一层不递归；子调用摘要取最新而非首条 | 145 |
| `packages/ui/src/GitPane.tsx` | Git 变更面板：来源切换、虚拟滚动列表、diff 懒加载与查找联动 | INV-01~18；同一时刻只允许一个文件展开；diff 缓存键必须含来源 id + 路径；世代号在发起请求时快照、回调只比快照；pending 必须在 finally 清除；已有 diff 或 pending 时早退保证幂等；虚拟行用 top 偏移而非 transform；行 key 带来源 id | 139 |
| `packages/ui/src/WorkspaceSidebarFooter.tsx` | 侧边栏底部账户区：头像菜单、语言/主题/界面模式、缩放与设置入口 | INV-01~18；footer 只做展示与转发、不缓存 user；头像 key 必须随 avatarUrl 或 id 变化；未登录且恢复会话中显示 loading；菜单内容必须保持挂载（forceMount 不能删）；主题与缩放只转发不落本地 | 138 |
| `packages/ui/src/OpenSplitButton.tsx` | 打开按钮：主按钮预览、下拉选择第三方应用、右键补充路径动作 | INV-01~18；预览优先级固定（代码查看器先于文件链接回调）；卡片虚拟行复用时自增请求号；effect 清理里同样自增；请求号不匹配时成功与失败两条路径都禁止写 state；编辑器列表加载失败保留空态不重试风暴 | 135 |
| `packages/ui/src/previewPaneContent.tsx` | 预览面板内容路由：文本、图片、媒体、Office、PDF、PPTX 分派 | INV-01~18；路由顺序固定（patch → 多文件 diff → 文本 → 图片 → 媒体 → PDF → Office → PPTX → 纯文件）；`multiFileDiffFiles` 必须 memo 保引用稳定；错误文本样式区分「文件缺失」与真实错误；各 loading 必须同时满足无错误且无数据 | 135 |
| `packages/ui/src/TaskList.tsx` | 任务列表：排序、行内操作、重命名、归档确认与列表级右键菜单 | INV-01~18；整体必须 memo；置顶列表默认值必须是模块级常量；回调 ref 每次渲染同步赋值；所有写操作入口先判只读原因；重命名与归档确认互斥 | 135 |

合计 **1,539**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 「作用域」是一个成对对象，不是一个 id

`CommandsSection.tsx` 与 `HooksSection.tsx` 是同一类坑：设置页的写入目标由「路径 + 身份」两个字段共同决定。
- 命令面板：列表服务与表单服务**各自**从 target 解析，不能退化成「取当前 Provider」——否则 A 的路径会发往 B 的 host。
- Hooks：选中条目时必须**成对**取路径与身份；只取路径会让本机路径配上远端身份，建目录直接报权限错误。
- 两者的 workspace key 都是三段兜底（身份去空白 → 路径 → 空串）。少一段，远程与本地同路径连接就会互相串状态。

### 2. 默认值即安全边界

`RemoteSkillSyncDialog.tsx` 的三条 INV 都在防「默认勾选」变成破坏性操作：
默认只勾远端不存在的技能、已存在项必须显式勾选、按目录名（而非显示名）匹配。
任何一条写松，用户点一次「同步」就覆盖远端已有目录，且事后无法从界面看出覆盖了哪些。

### 3. 缓存键必须携带「身份」，世代号必须「快照」

`GitPane.tsx` 与 `useCodingPlanProducts.ts` 是同一条纪律的两种形态：
- 缓存键缺来源 id → 切换来源后看到上一来源的 diff；缓存键缺服务实例 → 切换连接后复用上一个连接的在途请求。
- 世代号/代数必须在**发起时**快照，回调里只与快照比较；写在回调里等于永远相等。
- `pending` / Promise 的清理必须放 `finally`，只写成功路径会让一次失败永久卡死重试入口。

### 4. 展示层的顺序与引用稳定性就是性能契约

`previewPaneContent.tsx` 的路由顺序、`TaskList.tsx` 的模块级空数组、`OpenSplitButton.tsx` 的请求号，
三者看起来都是「可以随手整理」的代码，实际分别是：扩展名误判、memo 全面失效、过期响应写脏 state。
`TaskList` 尤其反直觉：`pinnedTasks = []` 写成内联默认参数，会让整个 memo 包装完全失效。

### 5. 投影层不拥有状态

`PluginStoreListView.tsx` 与 `WorkspaceSidebarFooter.tsx` 都守同一条边界：
组件只做投影与转发，不缓存权威值（user、插件列表）。一旦在组件内留副本，
登出后头像仍显示旧用户、已安装插件被误判为消失，且没有任何报错路径能暴露它。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 商店列表按字段自行推断分段 | 个人市场条目漏进「公开」分段，搜索跨段 |
| 空搜索词不提前返回 | 搜索区与分类区重复展示同一条目 |
| 展开态读取不做空值合并 | 首次进入所有分组收起，用户以为分类为空 |
| 折叠 key 不带类型前缀 | 同名市场与分类互相覆盖展开态 |
| 命令列表服务取「当前 Provider」 | 请求发往错误 host，列表读到别人的命令文件 |
| 连接未就绪仍发 RPC | 读到空列表，用户误以为命令被删 |
| Skill 同步默认全选 | 一次点击覆盖远端已有目录 |
| 按显示名匹配远端状态 | 改过名的技能被误判为不存在并覆盖 |
| Hooks 只取路径不取身份 | 本机路径配远端身份，建目录权限报错 |
| 可编辑判断绕过运行时标志 | 出现可编辑入口但保存必然失败 |
| 套餐缓存按全局而非服务实例 | 切换连接后复用上一个连接的在途请求 |
| 缓存结果而非 Promise | 并发第二个调用者拿不到同一次请求的结果 |
| 刷新不自增代数 | 旧请求返回后覆盖新快照 |
| explore 未知输入直接抛错 | 单条脏数据让整行工具调用渲染崩溃 |
| shell 包装递归解包 | 嵌套引号被多吃一层，展示命令与实际不符 |
| diff 缓存键缺来源 id | 切换来源后看到上一来源的 diff |
| pending 只在成功路径清除 | 失败一次后该文件永远不再重试 |
| 虚拟行用 transform 定位 | 展开大 diff 后 sticky 文件名失效 |
| footer 内缓存 user | 登出后头像仍显示旧用户 |
| 头像 key 不随 url/id 变化 | 切换账号后头像停在上一张 |
| 删除菜单的 forceMount | 每次点开都重建 footer 内部状态 |
| 预览路由把 Office 放到文本之后 | 带扩展名的 office 文件被当普通文本渲染 |
| `multiFileDiffFiles` 去掉 memo | 父级滚动时 diff 强制重渲染，长文档卡顿 |
| 加载判断只判无数据 | 请求失败后一直转圈，看不到错误 |
| TaskList 去掉 memo | 每次 token 增量都重排整个列表 |
| 置顶默认值写成内联空数组 | memo 完全失效 |
| 回调 ref 不在渲染中同步赋值 | 稳定回调读到上一次的父级函数，操作落到旧任务 |
| 写操作不先判只读原因 | 只读视图里仍能归档或重命名 |

## 顺延

本批按新节奏（10~12 文件/批、同目录优先）从 `packages/ui/src` 内取 11 个文件，
未跨模块拼批。B30 起继续由 `zc-next-batches.mjs` 基于当前工作树复算。

> 说明：本批开工前对 11 个目标文件逐一做了基线校验（`newComments=0`），确认无半插入残留。
> 全部插入均经 `zc-insert.mjs` 原子批写入；B 组有 5 个文件因首轮差 1 行，
> 按「不删注释补救」的约定用快照整文件还原后重插，最终行数与目标完全一致。
