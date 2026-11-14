# ZC-DEEP-b64

> 批次：B64（12 文件，按 31.4% 口径计算目标 807 行；按当前工作树复算，优先同类：`packages/ui` 5 个（browser-use、project-sidebar、ToolCallBlocks、v4/composer、cloud-content-dialog）、`packages/desktop` 2 个（scheduler、main/desktopSaveFile）、`packages/zcode-server-cli` 2 个（contracts、runtime）、`apps/zcode-cli` 2 个（cli/command-center、core/runtime））。
> 执行分三波：4 + 4 + 4（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b64\orig`；开工前 12 文件均为 `newComments=0`（30% 口径 needLines=764）。

## 校验

```
node zc-verify.mjs ZC-deep-b64
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=807

node check-batch.mjs ZC-deep-b64 ZC-deep-b64-files.txt
TOTAL added=807 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.22   302   221    69   65  packages/desktop/src/main/desktopSaveFile.ts
31.22   303   221    69   66  packages/ui/src/browser-use/BrowserViewportToolbar.tsx
31.23   399   285    89   67  apps/zcode-cli/packages/cli/src/command-center/types.ts
31.28   327   243    76   67  packages/zcode-server-cli/src/runtime/updatePreparation.ts
31.31   282   214    67   66  packages/ui/src/project-sidebar/RemoteProjectList.tsx
31.35  1101   823   258   74  apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts
31.43   286   210    66   66  packages/ui/src/settings/McpServerList.tsx
31.44   306   229    72   66  packages/ui/src/components/cloud-content-dialog/CloudContentDialog.tsx
31.44   317   229    72   67  packages/zcode-server-cli/src/contracts.ts
31.51   531   384   121   69  packages/desktop/src/scheduler/index.ts
31.53   294   222    70   67  packages/ui/src/v4/composer/V4ComposerModeControls.tsx
31.63   297   215    68   67  packages/ui/src/ToolCallBlocks/renderers/cuaListDetails.tsx
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.22 median=31.39 newComments=807
PASS: all 12 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `cli/src/command-center/types.ts` | command-center 类型契约层 | INV-01~18；只允许类型声明且五个导入块均带 type；选项类型从 TUI 函数签名派生；模式集合先 NonNullable 再 Extract 白名单；登录授权字段保留服务端 snake_case；卸载结果用 null 表达本来未安装；能力面只有 submitPrompt 与 resume 必选 | 67 |
| `desktop/src/scheduler/index.ts` | 常驻 cron 调度进程 | INV-01~18；轮询必须单飞，同一时刻只允许一个 tick；唤醒只能排队不能重入；轮末必须补跑被排队的唤醒；每轮固定认领-派发-上报顺序；轮内异常不得终止调度循环；misfire 判定同时要求非重试且超出宽限 | 69 |
| `ui/browser-use/BrowserViewportToolbar.tsx` | 响应式视口工具条受控层 | INV-01~18；权威尺寸与缩放只存在于 props；宽度/高度草稿与越界标记是可丢弃本地状态；唯一提交口 commitDraft，Enter 与失焦都必须汇入；唯一写出口是两个回调；越界保留原草稿只置标记；越界文案统一由 getRangeError 生成 | 66 |
| `ui/project-sidebar/RemoteProjectList.tsx` | 远程 Host 项目选择入口 | INV-01~18；组件身份以 device 优先、host 兜底；scope 由 hostId 与 membershipId 共同构成；过期判定同时校验存活与作用域；存活标记由挂载副作用接管；作用域快照每次渲染同步；能力回调走 ref 间接调用 | 66 |
| `ui/ToolCallBlocks/renderers/cuaListDetails.tsx` | CUA 列表类工具结果投影 | INV-01~18；展示模型只由 list_apps 与 list_windows 生成；结果行三级降级固定为 display、output、rawOutput；v4 display 只在 kind 为 cua 时解析；文本解析遇到分隔标记只取前半段；文本候选须以左方括号开头；解析异常一律折成 null | 67 |
| `ui/v4/composer/V4ComposerModeControls.tsx` | V4 输入框模式入口 | INV-01~18；只改写草稿不下发运行时切换命令；props 只从工具栏 props 挑字段；provider 缺省回落 ZCODE_AGENT_PROVIDER；候选模式每次现取不缓存；permissions 排除 plan；历史 edit 草稿不在候选集也要回显 | 67 |
| `zcode-server-cli/src/contracts.ts` | 控制面契约声明 | INV-01~18；协议版本是控制帧兼容唯一判据；生命周期状态集覆盖 Supervisor 全部落盘取值；状态快照 strict 禁未知字段；pid 与 port 用 null 表达缺失；generation 单调递增区分新旧进程；crashBudget 窗口起点缺省表示尚未崩溃 | 67 |
| `zcode-server-cli/src/runtime/updatePreparation.ts` | 在线更新准备流程 | INV-01~18；三态返回值是唯一对外契约；未配置 catalog 必须回落 pending 或显式抛错；整包临时目录只在 finally 递归删除；pending 必须在安装成功后才出现；回滚只处理仍指向本次 candidate 的 pending；discard 幂等且只执行一次 | 67 |
| `core/src/runtime/methods/turn-model-step.ts` | 单次模型步 | INV-01~18；本步只允许 continue、output_continuation、break 三种返回值且互斥；一切恢复动作映射为 continue；assistant 占位消息先于请求落库；ModelRequest 事件只记录 recordedMessages；assistantPersistenceAnchor 请求前采样；输出预算叠加剩余上下文窗口 | 74 |
| `desktop/src/main/desktopSaveFile.ts` | 保存文件 IPC 入口 | INV-01~18；远端 URL 与 ArrayBuffer 二选一；业务失败一律用返回值表达；取消或无路径短路为 canceled 且零写盘；建议文件名经 basename、trim 与 120 字符截断；大小上限在入口与流式累计两处执行；content-length 只做快速拒绝 | 65 |
| `ui/components/cloud-content-dialog/CloudContentDialog.tsx` | 云端内容弹窗 | INV-01~18；关闭态整棵卸载返回 null；实例身份由 payload.id 与 revision 共同决定；close 只调用 onClose；重入防护是 actionPending 与 inFlight 的并集；inFlight 覆盖整个 await 周期；await 之后每次写入先确认 mounted | 66 |
| `ui/settings/McpServerList.tsx` | MCP 服务器设置列表 | INV-01~18；servers 是父级注入只读输入；状态配色优先级 disabled 高于 connected 高于 connecting 高于 error 高于 attention；禁用压过一切 status；仅 connecting 且未禁用渲染旋转图标；reason 为必填非空；scope 只归一化为 workspace 或 user | 66 |

合计 **807**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 调度轮询必须单飞

`scheduler/index.ts` 用单飞标记保证同一时刻只有一个 tick。
并发 tick 会对同一条到期任务重复认领，同一次 automation 被执行两次。

### 2. 唤醒只能排队不能重入

同一文件在 tick 进行中把唤醒写入排队位，轮末补跑一次。
直接递归调用 tick 会让调用栈随唤醒次数增长，并在异常时丢失外层结算。

### 3. 取消保存不得产生写盘副作用

`desktopSaveFile.ts` 在对话框取消或无路径时直接返回 canceled。
先建目录再判断路径会让用户取消后仍留下空目录与临时文件。

### 4. 重入防护必须是两个标记的并集

`CloudContentDialog.tsx` 用 actionPending 与 inFlight 共同拦截重复点击。
只看其中一个会让异步期间第二次点击进入分发，动作被执行两遍。

### 5. 单次模型步只允许三种返回值

`turn-model-step.ts` 把恢复动作全部映射为 continue，不新增返回值。
新增返回值会让主循环的 switch 落入默认分支，整轮对话被判定为异常终止。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 调度 tick 不去重 | 同一条到期 automation 被执行两次 |
| 唤醒递归重入 | 调用栈膨胀，异常时丢失外层结算 |
| 保存取消后仍建目录 | 用户取消后残留空目录与临时文件 |
| 重入只判一个标记 | 异步期间重复点击，动作执行两遍 |
| 模型步新增返回值 | 主循环走默认分支，整轮被判定异常 |
| 视口草稿静默截断 | 用户无法分辨回显来自自己还是 Fit |
| 远程项目身份只比 host | 同名设备下不同成员的项目互相覆盖 |
| 契约状态集缺枚举值 | 状态落盘被拒，停止链路卡在锁上 |
| update pending 提前出现 | 安装失败后仍指向半成品目录 |
| MCP scope 不归一化 | 未知 scope 落盘后被读成 undefined |

## 顺延

B64 复算清单共 20 个候选，本批取 12 个，其余顺延到 B65，开工前用更新后的工作树重新测量后确定。

> 说明：每文件独立 spec（≤150 行），4 文件一组并行（并发上限 5），逐文件密度校验。
> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.22%~31.63%，`suspicious=0`。
