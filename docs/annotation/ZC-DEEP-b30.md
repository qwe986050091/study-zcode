# ZC-DEEP-b30

> 批次：B30（12 文件，全部位于 `packages/ui/src`；因总量超过 1,500 行，拆为 B30-A / B30-B 两个子批各自校验）。
> 覆盖三组：ai-elements 展示原语（堆栈、思考、Schema）、项目侧栏分组视图（任务行、拖拽）、
> 以及 hooks / store / 侧栏用量 / 对话宿主 / 草稿配置控制。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b30\orig`。

## 校验

```
node zc-verify.mjs ZC-deep-b30
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1641

deep-density --baseline ZC-deep-b30/orig --ext .ts,.tsx --threshold 30 --mode code
31.48   672   467  147  139  packages/ui/src/components/ai-elements/stack-trace.tsx
31.47   711   502  158  134  packages/ui/src/components/ai-elements/reasoning.tsx
31.46   603   426  134  132  packages/ui/src/components/ai-elements/schema-display.tsx
31.47   667   502  158  138  packages/ui/src/project-sidebar/grouped/task-row.tsx
31.41   573   417  131  130  packages/ui/src/project-sidebar/grouped/drag.ts
31.44   702   493  155  138  packages/ui/src/hooks/useGitRepository.ts
31.42   682   487  153  135  packages/ui/src/hooks/useSettingsSync.ts
31.46   638   445  140  131  packages/ui/src/hooks/useBuiltinAgentCli.ts
31.50   669   492  155  138  packages/ui/src/store/automationManagementStore.ts
31.39   642   481  151  133  packages/ui/src/WorkspaceSidebarFooterUsageSummary.tsx
31.50   757   565  178  148  packages/ui/src/side-pane-full-view/ConversationHost.tsx
31.54   799   596  188  145  packages/ui/src/v4/composer/useDraftConfigControl.ts
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.39 median=31.47 newComments=1641
PASS: all 12 file(s) >= 30% (mode=code)
```

列口径：`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`。
`// INV-` 计数：18~20 条/文件。新增行自查：`nonComment=0`、`starSlash=0`、
代码样式命中 1 条为误报（`// catch 里先做闸门检查再记日志…` 是散文，被关键字正则误判）。

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `.../ai-elements/stack-trace.tsx` | 错误堆栈展示组件族：解析纯文本堆栈为结构化帧并渲染可点击路径 | INV-01~20；Context 默认 null 且缺 Provider 必须抛错；受控优先于内部状态；解析是纯函数只依赖入参；帧 key 不能退化为下标；路径点击只对可解析的绝对路径生效 | 139 |
| `.../ai-elements/reasoning.tsx` | 思考块组件族：流式内容、自动收起与延迟卸载 | INV-01~20；Context 缺失必须抛错；受控 open 优先；用户交互后自动收起永久失效；计时器与延迟卸载必须成对清理；流式追加不得重置用户展开态 | 134 |
| `.../ai-elements/schema-display.tsx` | OpenAPI 风格接口卡片：方法徽章、路径高亮、参数表与结构树 | INV-01~20；Context 默认值是 GET + 空串而非 null；方法类型固定五种且配色表必须全覆盖；结构树递归不得依赖渲染顺序；可选字段标记与必填校验分离 | 132 |
| `.../project-sidebar/grouped/task-row.tsx` | 分组视图任务行：标题、状态点、交互胶囊、拖拽与右键菜单 | INV-01~20；拖拽叠加层只做纯展示（不得订阅菜单/查询路径）；工作区键身份优先路径兜底；活跃判定必须同时比对工作区键与任务标识；行内操作先判只读 | 138 |
| `.../project-sidebar/grouped/drag.ts` | 拖拽支撑层：碰撞过滤、落点预览变换、布局快照与补间 | INV-01~20；只有分组拖拽可把组间落点当候选；任务拖拽必须排除组间落点；碰撞检测只过滤候选、不重写排序；布局快照在拖拽开始时冻结 | 130 |
| `packages/ui/src/hooks/useGitRepository.ts` | 把 gitService 的一次快照投影成 header 与 Git pane 共用的只读视图状态 | INV-01~18；只读投影、不缓存第二份 summary；空骨架每个字段都要有默认值；刷新必须有闸门；catch 里先做闸门检查再记日志 | 138 |
| `packages/ui/src/hooks/useSettingsSync.ts` | 设置迁移向导 UI 状态机：发现、勾选、导入与首启提示 | INV-01~18；workspacePath 缺失必须早退；关闭必须抢占在途导入；首启提示只在关闭或空发现时写 handled；导入任务回写必须比对运行号 | 135 |
| `packages/ui/src/hooks/useBuiltinAgentCli.ts` | 内置 Agent CLI 安装/卸载状态机与可控节奏的假进度动画 | INV-01~18；已启用不得重复安装、未启用不得卸载；变更前统一过 canMutateProvider；进度单调不跳号；卸载失败必须回滚本地开关 | 131 |
| `packages/ui/src/store/automationManagementStore.ts` | 定时任务管理 store：列表、运行历史、CRUD 与立即运行 | INV-01~20；每次列表请求先自增全局序号；落库前同时比对序号与工作区；视图工作区为空不得发起写请求；运行历史只追加不重排 | 138 |
| `packages/ui/src/WorkspaceSidebarFooterUsageSummary.tsx` | 侧栏底部用量入口、升级入口与套餐徽标的取数与投影 | INV-01~19；provider 读取 ready 前不得判定「无套餐」；provider 事实与来源选择必须同一份 settings 快照；selectedSupplierKey 必须同时按路径与身份选取 | 133 |
| `packages/ui/src/side-pane-full-view/ConversationHost.tsx` | Side Pane 完整视图的对话宿主：几何测量与三栏布局 | INV-01~19；几何只写内联样式、不进 React state；normal 模式必须移除全部几何属性；清理函数必须同时断开观察器与窗口监听 | 148 |
| `packages/ui/src/v4/composer/useDraftConfigControl.ts` | Composer 草稿 owner：模型选择、正文与提交生命周期 | INV-01~19；切模型时必须删除思考档位字段；目录水合必须同时看斜杠命令与模式目录；水合按工作区键单飞；严格模式双挂载只能发一次请求 | 145 |

合计 **1,641**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. Context 默认值的两种相反策略

`stack-trace` / `reasoning` 用 `null` 默认值并在 hook 里抛错：缺 Provider 必须立刻炸，不能静默渲染空卡片。
`schema-display` 反而用「GET + 空串」的合法默认值：它是可独立渲染的纯展示件，子件不该为判空付出成本。
两者都对，但**不能互换**——把前者改成空对象会让放错位置的子件长期空转，把后者改成 null 会让独立渲染直接崩。

### 2. 受控与内部状态只能有一个主人

`stack-trace`、`reasoning` 都以 `isOpenControlled` 分流：外部传入 `open` 时，内部规则（自动收起、延迟卸载）
必须让位。写法上只要把 `useControllableState` 的 prop 参数写反，界面就会出现「用户展开后立刻被收起」的抖动。
`reasoning` 另有一条：用户一旦手动交互，自动收起永久失效——用 ref 置位，不能靠 state（置位发生在事件里，state 会滞后一帧）。

### 3. 拖拽层是「纯投影」，不是数据源

`drag.ts` 与 `task-row.tsx` 分工明确：碰撞检测只**过滤候选**，排序仍由原列表决定；叠加层只做纯展示，
不得订阅右键菜单或查询路径。任何把排序/查询塞进拖拽路径的改动都会让快速移动时落点跳变、每帧掉帧。

### 4. 序号 + 工作区是同一个闸门

`automationManagementStore` 与 `useSettingsSync` 的写回条件都是「序号匹配 **且** 工作区匹配」。
只比序号：切工作区后旧响应仍落库；只比工作区：并发刷新时旧响应覆盖新结果。
`useSettingsSync` 的关闭动作还要**先**自增运行号再发关闭请求——顺序反了，在途导入会在关窗后继续回写。

### 5. 几何与进度这类「高频值」不能进 React 状态

`ConversationHost` 的测量结果直接写内联样式，`useBuiltinAgentCli` 的进度按「每轮最多 +1」推进。
前者进 state 会让对话树随每次 resize 重渲染；后者允许跳号会让动画失去可信度，也会让「完成」早于真实回调。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| Context 默认值从 null 改成 `{}` | 缺 Provider 静默渲染空卡片 / 永远收起且点不开 |
| 受控判断写反 | 用户展开后被内部规则立刻收起，开合抖动 |
| 解析函数读取外部变量 | 同一堆栈两次渲染帧不同，memo 永久失效 |
| 方法配色表漏键 | 徽章背景缺失，浅色主题下几乎不可读 |
| 叠加层里订阅菜单/查路径 | 拖动时每帧重算，明显掉帧 |
| 工作区键只用路径 | 远端与本地同路径互相串台 |
| 活跃判定只比任务 id | 不同工作区同名任务同时高亮 |
| 任务拖拽允许组间落点 | 松手回弹，看起来像拖拽失效 |
| 在碰撞检测里改排序 | 快速移动时落点跳变 |
| Git 投影缓存第二份 summary | 面板与服务端分叉，出现幽灵改动 |
| 空骨架缺字段 | 消费者读 undefined 直接崩 |
| 刷新不设闸门 | 首屏与每次渲染都打一轮 Git |
| workspacePath 缺失仍调服务 | 空路径请求污染状态 |
| 关闭时不抢占在途导入 | 关窗后旧导入回写，鬼影数据重现 |
| 首启提示提前写 handled | 用户没看过提示却再也不会被提醒 |
| 已启用仍重复安装 | 启用列表出现重复项 |
| 变更不过 canMutateProvider | 两个 provider 并发写入，后写覆盖先写 |
| 进度允许跳号/回退 | 动画失去可信度，完成早于真实回调 |
| 列表请求不自增序号 | 并发刷新时旧响应覆盖新结果 |
| 落库只比序号不比工作区 | 切工作区后仍写入旧项目数据 |
| 工作区为空仍发写请求 | 打到默认项目，改错任务 |
| provider 未 ready 就判「无套餐」 | 首屏闪出错误的「未订阅」 |
| 来源选择分两次读 settings | 事实与来源来自不同快照，徽标错位 |
| selectedSupplierKey 只看路径 | 远程与本地同路径串会话 |
| 几何测量写进 state | 拖拽/缩放时对话树持续抖动 |
| normal 模式残留几何属性 | 退出完整视图后三栏布局偏移 |
| 清理只断观察器不摘监听 | 多次切换后每次缩放触发多轮重算 |
| 切模型保留思考档位 | 首条消息把旧档位写到新模型 |
| 目录水合只看斜杠命令 | 已有会话命令列表永久为空 |
| 水合不做单飞 | 双挂载各发一次请求，状态在加载/就绪间抖动 |

## 顺延

本批原计划 12 文件一次推进，因总量 1,641 行超过单批 1,500 行阈值，按新规则拆为
B30-A（6 文件 / 811 行）与 B30-B（6 文件 / 830 行）两个子批，各自独立校验后合并验收。
子批执行中每文件单独一份 spec（≤150 行）并即时校验，未再出现长输出。

> 说明：开工前 12 文件基线均为 `newComments=0`；B30-B 首轮中断未产生任何落盘，
> 复跑后按文件补齐，最终 `added=1641` 与逐文件目标完全一致。
