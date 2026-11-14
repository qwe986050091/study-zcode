import fs from 'node:fs';

const specs = [
  {
    file: 'apps/zcode-cli/packages/cli/src/command-center/handlers/plugins.ts',
    first: 'import type { TuiSelection, TuiSubmitPromptResult } from "@zcode/tui";',
    target: 46,
    header: [
      '// INV-01 list 与 status 共用同一面板出口：守住位置 分支合并；改错故障 两种展示口径漂移。',
      '// INV-02 未知动作回落用法提示：守住位置 末尾返回；改错故障 拼错子命令被静默执行。',
      '// INV-03 enable 与 disable 只接受一个插件名：守住位置 参数解构；改错故障 多余参数被忽略。',
      '// INV-04 变更只对新会话生效且文案必须声明：守住位置 结果文案；改错故障 用户以为当前会话已生效。',
      '// INV-05 变更成功后重新取列表刷新选择器：守住位置 二次调用；改错故障 面板停留在旧状态。',
      '// INV-06 选择器命令按当前启用态生成 toggle：守住位置 命令拼接；改错故障 回车执行相反动作。',
      '// INV-07 卸载必须显式 force 闸门：守住位置 确认分支；改错故障 一次输入即不可逆删除。',
      '// INV-08 force 与短标志等价且不当作插件名：守住位置 参数过滤；改错故障 把标志当插件名。',
      '// INV-09 卸载拒绝多余参数：守住位置 过滤后计数；改错故障 误删非目标插件。',
      '// INV-10 卸载成功后重建选择器：守住位置 条件展开；改错故障 列表残留已删插件。',
      '// INV-11 能力缺失统一回复并保留 mode：守住位置 unavailable；改错故障 前端模式与其他响应不一致。',
      '// INV-12 选择器按 id 排序：守住位置 排序调用；改错故障 相同数据顺序抖动。',
      '// INV-13 未命中时索引回退 0：守住位置 Math.max；改错故障 选择器落在非法位置。',
      '// INV-14 关键字覆盖多个展示字段：守住位置 keywords 数组；改错故障 别名搜索不命中。',
      '// INV-15 空列表给出明确空态文案：守住位置 空值分支；改错故障 面板空白无提示。',
      '// INV-16 副标题固定六段且缺失有占位：守住位置 pluginMeta；改错故障 文案缺段产生歧义。',
      '// INV-17 概要展示启用数与总数：守住位置 统计调用；改错故障 用户无法判断全局状态。',
      '// INV-18 错误只转可读文本不向上抛：守住位置 两处捕获；改错故障 命令中心收到异常。',
      '//',
      '// 模块职责：实现 /plugins 的列表、启停与卸载子命令，并构造插件选择器。',
      '// 状态所有权：无状态；插件事实来自 app 端口，本文件只做展示转换。',
      '// 阅读顺序：先看主分派，再读卸载闸门，最后看选择器与文案格式化。',
    ],
    blocks: [
      {
        anchor: 'export async function handlePluginsCommand(',
        lines: [
          '先取 app，再解析子命令。',
          '缺省动作是 list。',
          'list 与 status 走同一分支。',
          'enable 与 disable 共用一个切换流程。',
          'uninstall 单独校验确认闸门。',
        ],
      },
      {
        anchor: '  if (action === "list" || action === "status") {',
        lines: [
          '能力缺失时直接返回统一提示。',
          '列表结果同时用于文本与选择器。',
          '选择器初始不选中任何项。',
          'locale 缺省为 en-US。',
          'mode 来自 deps，保持前端同步。',
        ],
      },
      {
        anchor: 'async function handlePluginsUninstall(',
        lines: [
          '插件名是首个非标志参数。',
          '其余参数全部视为多余。',
          '缺少插件名或存在多余参数都回用法。',
          '无 force 时只返回确认指引。',
          '成功后尽力刷新列表。',
        ],
      },
      {
        anchor: 'function buildPluginsSelection(',
        lines: [
          '排序保证相同输入产生相同顺序。',
          '命令按当前启用态切换。',
          '关键字覆盖 id 与各展示字段。',
          'pending 文案与实际动作一致。',
          '未命中时回退到第一项。',
        ],
      },
      {
        anchor: 'function pluginMeta(plugin: CommandCenterPluginListOutcome["plugins"][number]): string {',
        lines: [
          '版本缺失显示 unversioned。',
          'MCP 名称以逗号连接。',
          '无 MCP 时显示 no mcp。',
          '六段固定顺序用竖线连接。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/core/src/runtime/internal-methods.ts',
    first: 'import type {',
    firstNth: 1,
    target: 47,
    header: [
      '// INV-01 本文件只声明签名：守住位置 模块边界；改错故障 实现被误放进类型文件。',
      '// INV-02 所有方法以运行时内部类型作为 this：守住位置 调用纪律；改错故障 独立函数拿不到私有成员。',
      '// INV-03 同步段内不得跨 await 修改队列或 activeTurn 快照：守住位置 方法契约；改错故障 并发起轮状态错乱。',
      '// INV-04 跨 await 的调度必须走预留或租约：守住位置 租约类方法；改错故障 tick 窗口内重复启动。',
      '// INV-05 同一时刻只有一个 activeTurn：守住位置 begin 前置条件；改错故障 两轮并行写同一会话。',
      '// INV-06 begin 与 finish 成对调用：守住位置 生命周期方法；改错故障 activeTurn 泄漏。',
      '// INV-07 reserve 与 release 成对调用：守住位置 启动预留方法；改错故障 busy 位永久占用。',
      '// INV-08 繁忙判定综合前台多维事实：守住位置 单一判定方法；改错故障 只看单一字段漏判。',
      '// INV-09 前台提升租约必须显式释放：守住位置 租约接口；改错故障 后续 turn 无法提升。',
      '// INV-10 异步结果只入队不直接起 turn：守住位置 通知与子代理入口；改错故障 绕过队列打乱顺序。',
      '// INV-11 暂停项操作一律按 pendingInputId 定位：守住位置 五个操作方法；改错故障 误改其他输入。',
      '// INV-12 变更暂停项需 reservationId 关闭竞态：守住位置 预留类方法；改错故障 提升与删除相互覆盖。',
      '// INV-13 drain 只在 turn 内调用：守住位置 方法注释；改错故障 冷恢复重放导致重复注入。',
      '// INV-14 工具面缓存必须由显式失效回收：守住位置 invalidateToolCache；改错故障 配置变更后仍发旧声明。',
      '// INV-15 MCP 启动为两段式：守住位置 startMcpStartup 返回结构；改错故障 启动阻塞首个事件。',
      '// INV-16 上下文初始化失败让本轮直接失败：守住位置 ensureContextInitialized；改错故障 静默用空上下文请求。',
      '// INV-17 冷恢复按固定装配顺序重建内存态：守住位置 resumeFromStore；改错故障 历史与目标不一致。',
      '// INV-18 Goal 读写都经会话存储：守住位置 目标类方法；改错故障 内存态与持久态分叉。',
      '//',
      '// 模块职责：声明运行时核心方法的类型契约，覆盖配置、steering、队列、通知、工具面与目标。',
      '// 状态所有权：无运行时状态；所有成员由 AgentRuntime 实例持有并在实现文件中维护。',
      '// 阅读顺序：先看配置与 steering，再读队列与繁忙判定，最后看工具面、模型请求与目标。',
    ],
    blocks: [
      {
        anchor: 'export interface AgentRuntimeCoreMethods {',
        lines: [
          '该接口由交叉类型并入运行时。',
          '实现函数以 this 访问这些成员。',
          '方法安装发生在统一安装函数中。',
          '本文件不导入任何实现模块。',
          '依赖类型全部来自依赖与类型文件。',
        ],
      },
      {
        anchor: '  enqueueDeferredInput(input: string | TurnSteerInput): Promise<TurnSteerResult>;',
        lines: [
          '入队是异步结果进入运行时的唯一入口。',
          '入队后立即尝试消费。',
          '消费单飞，重复调用安全。',
          '拒绝结果带回稳定原因码。',
          '成功返回可追踪的输入标识。',
        ],
      },
      {
        anchor: '  hasActiveOrQueuedTurnWork(): boolean;',
        lines: [
          '前台繁忙综合租约与队列判断。',
          'activeTurn 存在即视为繁忙。',
          '启动预留同样计入繁忙。',
          '常驻池使用独立判定方法。',
          '该结果决定是否允许启动新 turn。',
        ],
      },
      {
        anchor: '  startMcpStartup(traceContext: TraceContext): Promise<McpConnectionSnapshot> | undefined;',
        lines: [
          '返回 promise 表示启动仍在等待。',
          '未启动时返回 undefined。',
          '刷新只在签名变化时重注册工具。',
          '刷新失败不推进版本号。',
          '连接快照用于界面展示状态。',
        ],
      },
      {
        anchor: '  resumeFromStore(options?: ResumeSessionOptions): Promise<ResumeSessionResult>;',
        lines: [
          '恢复按固定装配顺序重建内存态。',
          '先恢复消息历史再恢复目标。',
          '目标与待办都从会话存储读取。',
          '恢复完成后 activeTurn 保持为空。',
          '返回值带恢复结论与诊断。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/node-repl-host/src/cua-bridge.ts',
    first: 'import { randomUUID } from "node:crypto";',
    target: 45,
    header: [
      '// INV-01 桥接以全局符号暴露：守住位置 返回对象键；改错故障 会话对象被注入隐藏能力。',
      '// INV-02 每次调用校验代次：守住位置 活跃检查；改错故障 内核重置后旧绑定仍可调用。',
      '// INV-03 子代理作用域一律拒绝：守住位置 可用性检查；改错故障 子代理越权控制桌面。',
      '// INV-04 broker 连接缺失即判定不可用：守住位置 连接判断；改错故障 拿到空连接后挂起。',
      '// INV-05 请求上下文必须携带会话标识：守住位置 元数据提取；改错故障 broker 无法归属请求。',
      '// INV-06 工作区键按三字段顺序回落：守住位置 空值合并；改错故障 不同调用点归属不一致。',
      '// INV-07 客户模式与投递类型有固定缺省：守住位置 缺省赋值；改错故障 老客户端字段缺失即失败。',
      '// INV-08 响应必须单飞结算：守住位置 settled 标志；改错故障 重复 resolve 或 reject。',
      '// INV-09 响应超过 32MiB 立即失败：守住位置 字节长度检查；改错故障 超大响应耗尽内存。',
      '// INV-10 响应标识必须与请求一致：守住位置 id 比较；改错故障 串包读到他人结果。',
      '// INV-11 中断信号必须销毁连接：守住位置 abort 监听；改错故障 取消后 socket 泄漏。',
      '// INV-12 连接提前关闭视为失败：守住位置 close 回调；改错故障 调用永久悬挂。',
      '// INV-13 只读取 primary 应用身份：守住位置 关联字段选择；改错故障 列表动作覆盖已确立身份。',
      '// INV-14 应用标识必须是非空字符串：守住位置 类型与去空白判断；改错故障 空标识进入会话。',
      '// INV-15 图标字节不进入会话协议：守住位置 身份投影；改错故障 大字节随会话传输。',
      '// INV-16 响应元信息先合并再读身份：守住位置 调用顺序；改错故障 身份读取到旧元信息。',
      '// INV-17 身份读取位于 broker 一跳：守住位置 调用链位置；改错故障 模型可伪造应用身份。',
      '// INV-18 所有失败都是显式异常：守住位置 错误分支；改错故障 调用方拿到半成品结果。',
      '//',
      '// 模块职责：把 node_repl 的 computer-use 能力桥接到 broker，并投影目标应用身份。',
      '// 状态所有权：桥接对象不持有会话；活跃调用由宿主通过回调提供。',
      '// 阅读顺序：先看桥接装配，再读上下文提取，最后看单飞请求与身份读取。',
    ],
    blocks: [
      {
        anchor: 'export function createComputerUseBridgeGlobals(input: {',
        lines: [
          '返回值以符号作为唯一键。',
          '代次校验放在最前。',
          '子代理请求在可用性检查处拒绝。',
          '只有 broker 存在才允许发送。',
          '桥接对象不持有会话引用。',
        ],
      },
      {
        anchor: '  const assertAvailable = (): ActiveCuaNodeReplCall => {',
        lines: [
          '先确认绑定仍然有效。',
          '子代理作用域统一拒绝。',
          '缺少 broker 视为不可用。',
          '错误消息为稳定常量。',
          '通过后返回当前调用。',
        ],
      },
      {
        anchor: 'function readPrimaryAppIdentity(result: CallToolResult): NodeReplCuaAppIdentity | undefined {',
        lines: [
          '只读取 primary 关联。',
          '应用标识必须是非空字符串。',
          '展示名可选且需去空白。',
          '列表与访问类动作不覆盖身份。',
          '图标字节在这里被忽略。',
        ],
      },
      {
        anchor: 'function requestContext(meta: NodeReplRequestMeta): Record<string, unknown> {',
        lines: [
          '会话标识缺失直接抛错。',
          '工作区键依次回落三个字段。',
          '客户模式缺省为桌面连续模式。',
          '追踪信息只在存在时写入。',
        ],
      },
      {
        anchor: 'async function sendCuaBrokerRequest(',
        lines: [
          '单飞保证只结算一次。',
          '结算时统一移除监听并销毁连接。',
          '响应超限或标识不匹配都失败。',
          '连接提前关闭视为失败。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/telemetry/src/agent-trace-runtime.ts',
    first: 'import { recordRequestObservation } from "./request-security-edition/index.js";',
    target: 64,
    header: [
      '// INV-01 span 创建只经统一封装：守住位置 startSpan；改错故障 各处默认值与父上下文不一致。',
      '// INV-02 容量上限默认 5000 且非法值回落：守住位置 构造归一首；改错故障 零容量让遥测全丢。',
      '// INV-03 超容量降级共享空实现：守住位置 安全创建；改错故障 每次降级都新建对象。',
      '// INV-04 容量告警超限期间只报一次：守住位置 告警闩锁；改错故障 刷屏淹没日志。',
      '// INV-05 创建异常转告警并降级：守住位置 捕获分支；改错故障 遥测故障打断业务。',
      '// INV-06 指标异常不得影响 span 生命周期：守住位置 指标包装；改错故障 后端故障导致 span 悬挂。',
      '// INV-07 活动集只含未终结写入器：守住位置 登记与移除；改错故障 容量被僵尸占满。',
      '// INV-08 终结回调负责移出活动集：守住位置 构造参数；改错故障 活动集无限增长。',
      '// INV-09 非子模式用链接表达来源：守住位置 链接分支；改错故障 独立任务被串进父链。',
      '// INV-10 子模式才建立真实父子：守住位置 父上下文选择；改错故障 会话树层级错误。',
      '// INV-11 身份在开启回合时快照：守住位置 关联对象；改错故障 中途换身份污染已开 span。',
      '// INV-12 会话结束按会话标识放弃：守住位置 放弃会话；改错故障 关闭会话后仍上报 span。',
      '// INV-13 进程退出放弃全部写入器：守住位置 放弃进程；改错故障 进程退出留下未结束 span。',
      '// INV-14 尝试 span 固定为客户端类型：守住位置 类型参数；改错故障 外部调用被当作内部操作。',
      '// INV-15 命令 span 必须挂在工具 span 之下：守住位置 父写入器注入；改错故障 命令脱离工具上下文。',
      '// INV-16 属性统一经压缩归一：守住位置 属性构造；改错故障 空值进入后端产生噪声。',
      '// INV-17 非法标识直接丢弃而不是写空串：守住位置 安全标识；改错故障 属性出现空维度。',
      '// INV-18 放弃操作幂等：守住位置 终结闩锁；改错故障 重复放弃重复上报。',
      '//',
      '// 模块职责：统一创建回合、步骤、工具、命令、压缩、游离操作与模型调用各类 span。',
      '// 状态所有权：活动写入器集合、容量闩锁与身份快照由运行时实例持有。',
      '// 阅读顺序：先看运行时与开启方法，再读写入器实现，最后看指标标签与空实现。',
    ],
    blocks: [
      {
        anchor: 'export class AgentExecutionTelemetryRuntime',
        lines: [
          '活动集与容量上限是实例唯一可变状态。',
          '身份快照可热更新。',
          '指标与告警都走旁路。',
          '所有开启方法都经安全创建。',
          '该类同时实现两个遥测端口。',
        ],
      },
      {
        anchor: '  startDetachedOperation(input: DetachedOperationTraceStart): DetachedOperationSpanWriter {',
        lines: [
          '非前台执行作为独立根。',
          '恢复来源记为 resumed_from。',
          '其余来源记为 triggered_by。',
          '前台执行才继承父上下文。',
        ],
      },
      {
        anchor: '  startCall(input: ModelCallTraceStart): ModelCallSpanWriter {',
        lines: [
          '无活跃写入器时以当前上下文为父。',
          '逻辑调用标识写入属性。',
          '尝试由该写入器派生。',
          '调用级维度在构造时固定。',
        ],
      },
      {
        anchor: '  abandonSession(sessionId: string): void {',
        lines: [
          '只处理匹配会话标识的写入器。',
          '放弃原因固定为会话关闭。',
          '终结回调同步移出活动集。',
          '遍历集合期间删除是安全的。',
        ],
      },
      {
        anchor: '  private startCommand(',
        lines: [
          '父上下文取自工具写入器快照。',
          '安全名截断到 128。',
          '沙箱标记直接写布尔值。',
          '命令 span 不单独建链。',
        ],
      },
      {
        anchor: '  private startAttempt(',
        lines: [
          '尝试解析实际请求目标。',
          '与调用级维度共享关联信息。',
          '重试延迟只在非负时写入。',
          '失败会回调父写入器计数。',
          'span 类型固定为客户端。',
        ],
      },
      {
        anchor: '  private safeCreate<T>(spanName: string, create: () => T, fallback: T): T {',
        lines: [
          '超容量直接返回降级单例。',
          '每次丢弃都记录创建丢弃指标。',
          '告警闩锁避免重复刷屏。',
          '创建异常同样降级。',
          '告警回调自身异常也被吞掉。',
        ],
      },
      {
        anchor: 'class TurnWriter extends TrackedBaseWriter implements AgentTurnSpanWriter {',
        lines: [
          '构造函数只做依赖绑定。',
          '完成时写入结果类型。',
          '取消与失败走统一终结路径。',
        ],
      },
      {
        anchor: 'class ToolWriter extends TrackedBaseWriter implements ToolExecutionSpanWriter {',
        lines: [
          '工具名与调用标识是固定维度。',
          '完成结论决定终态属性。',
          '失败按错误分类归档。',
          '指标标签与属性保持同口径。',
        ],
      },
      {
        anchor: 'class ModelCallWriter extends TrackedBaseWriter implements ModelCallSpanWriter {',
        lines: [
          '逻辑调用维度在构造时固定。',
          '尝试通过回调派生。',
          '失败阶段与类别来自尝试。',
          '完成时写入结束原因。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/tui/src/app-input-status.tsx',
    first: '// 输入区状态行（L2）：运行时活动指示（spinner + 上下文用量）与底部 composer 元信息（模型/provider/effort）。',
    target: 46,
    header: [
      '// INV-01 组件纯展示不持有状态：守住位置 组件体；改错故障 重渲染出现状态漂移。',
      '// INV-02 宽度单位统一为显示列：守住位置 全部宽度计算；改错故障 中文与图标按字符数算错。',
      '// INV-03 宽度非法回落 80 且最小 8：守住位置 归一函数；改错故障 NaN 导致布局崩溃。',
      '// INV-04 显式动画帧优先于激活标记：守住位置 渲染分支；改错故障 外部驱动与内部动画打架。',
      '// INV-05 未传动画帧时不挂动画钩子：守住位置 静态分支；改错故障 空闲状态仍每帧重渲染。',
      '// INV-06 徽标缺失时整体不渲染：守住位置 条件子节点；改错故障 出现空文本节点。',
      '// INV-07 已用量非法即隐藏徽标：守住位置 合法性判断；改错故障 显示 NaN 用量。',
      '// INV-08 窗口非法时只显示已用量：守住位置 窗口校验；改错故障 除零得到无穷百分比。',
      '// INV-09 百分比四舍五入为整数：守住位置 格式化；改错故障 小数位抖动。',
      '// INV-10 紧凑计数按 K 与 M 进位：守住位置 分段阈值；改错故障 百万级仍显示长数字。',
      '// INV-11 放不下时先保证思考强度完整：守住位置 拟合入口；改错故障 关键信息先被裁掉。',
      '// INV-12 provider 预算为剩余宽度的 40%：守住位置 预算计算；改错故障 provider 挤压模型名。',
      '// INV-13 模型名与 provider 各至少保留 1 列：守住位置 下界夹取；改错故障 出现负宽度。',
      '// INV-14 状态行高度恒为 1：守住位置 高度常量；改错故障 输入区高度跳动。',
      '// INV-15 不改入参并返回新对象：守住位置 构造返回；改错故障 React 依赖比较失效。',
      '// INV-16 截断按显示宽度而非字符数：守住位置 截断调用；改错故障 宽字符被截半。',
      '// INV-17 徽标隐藏阈值固定为 4 列：守住位置 阈值常量；改错故障 极窄行出现乱码。',
      '// INV-18 组件不缓存用量对象：守住位置 入参读取；改错故障 新用量不触发重渲染。',
      '//',
      '// 模块职责：渲染输入区的活动状态行与底部 composer 元信息，并做宽度拟合。',
      '// 状态所有权：无状态；动画帧由外部驱动或内部钩子提供。',
      '// 阅读顺序：先看两个入口组件，再读纯渲染行，最后看宽度拟合与格式化。',
    ],
    blocks: [
      {
        anchor: 'export function InputActiveStatus({',
        lines: [
          '显式动画帧时走无状态分支。',
          '未激活且无动画帧时静态渲染。',
          '激活且无动画帧时才订阅动画。',
          '宽度由父层扣减后传入。',
          '返回值恒为元素。',
        ],
      },
      {
        anchor: 'export function InputComposerStatus({',
        lines: [
          '只做参数转发。',
          '不持有状态。',
          '模型名为空也会渲染。',
          '思考强度空值由下层占位。',
        ],
      },
      {
        anchor: 'export function inputActiveStatusRow(',
        lines: [
          '先算右侧徽标可用宽度。',
          '徽标再按可用宽度截断。',
          '无动画帧时不渲染左侧提示。',
          '无徽标时不留弹性间隔。',
          '行高恒为 1。',
        ],
      },
      {
        anchor: 'export function inputComposerStatusParts(',
        lines: [
          '模型名与 provider 来自统一解析。',
          '思考强度去空白后为空用横线占位。',
          '返回新对象便于依赖比较。',
          '最大宽度缺省表示不限宽。',
          '截断规则由下层统一执行。',
        ],
      },
      {
        anchor: 'function fitComposerStatusParts(',
        lines: [
          '不限宽时原样返回。',
          '能放下时不做任何裁剪。',
          '放不下先保证思考强度。',
          '剩余宽度按四成给 provider。',
          '模型名至少保留 1 列。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/tui/src/app-model-suggestion-panel.tsx',
    first: '// 模型候选浮层的布局与渲染。',
    target: 46,
    header: [
      '// INV-01 可见窗口固定 8 行：守住位置 窗口常量；改错故障 浮层超出终端高度。',
      '// INV-02 选中项必须落在可见窗口内：守住位置 窗口函数；改错故障 键盘移动看不到高亮。',
      '// INV-03 空候选渲染提示行：守住位置 空值分支；改错故障 浮层空白无解释。',
      '// INV-04 面板高度按可见行数加边框：守住位置 高度计算；改错故障 最后一行被裁掉。',
      '// INV-05 provider 列预算上限为四成：守住位置 预算函数；改错故障 provider 挤压模型名。',
      '// INV-06 provider 预算还需扣除选择符与最小模型名：守住位置 预算下界；改错故障 模型名被压到 0 列。',
      '// INV-07 标注只在模型名仍够宽时显示：守住位置 显示判断；改错故障 模型名被标注挤没。',
      '// INV-08 模型名优先标签回落标识：守住位置 展示组装；改错故障 别名模型显示为空。',
      '// INV-09 provider 优先展示名回落标识：守住位置 展示组装；改错故障 列显示内部标识。',
      '// INV-10 current 标记附在标注末尾：守住位置 标注拼接；改错故障 当前模型无法识别。',
      '// INV-11 禁用原因与当前标记用竖线连接：守住位置 过滤连接；改错故障 空值产生悬空分隔符。',
      '// INV-12 宽度非法回落 80 列：守住位置 归一函数；改错故障 NaN 导致布局异常。',
      '// INV-13 内容宽最小 8 列：守住位置 下界夹取；改错故障 极窄面板出现负预算。',
      '// INV-14 选择符固定 2 列：守住位置 宽度常量；改错故障 高亮箭头挤动文本。',
      '// INV-15 provider 与模型名间隔 2 列：守住位置 间隔常量；改错故障 两列文字粘连。',
      '// INV-16 空 provider 时不留间隔：守住位置 条件宽度；改错故障 行尾出现悬空留白。',
      '// INV-17 纯展示不触发模型切换：守住位置 模块边界；改错故障 渲染产生副作用。',
      '// INV-18 每次渲染重算裁剪不缓存：守住位置 行数据构造；改错故障 宽度变化后仍用旧裁剪。',
      '//',
      '// 模块职责：渲染模型候选浮层，处理可见窗口、当前标记与列宽对齐。',
      '// 状态所有权：无状态；候选、选中项与当前模型全部由父层传入。',
      '// 阅读顺序：先看面板与行组件，再读展示组装，最后看列预算与宽度归一。',
    ],
    blocks: [
      {
        anchor: 'export function ModelSuggestionPanel({',
        lines: [
          '可见窗口保证选中项在范围内。',
          '行数据同时算当前标记与选中态。',
          '面板高度按可见行数计算。',
          '空候选显示提示行。',
          '键使用模型引用序列化。',
        ],
      },
      {
        anchor: 'function ModelSuggestionRow({',
        lines: [
          '选择符宽度固定。',
          '模型名可收缩。',
          '标注为空时不渲染节点。',
          'provider 为空时不留间隔。',
        ],
      },
      {
        anchor: 'function modelOptionDisplayParts(model: TuiModelOption, current: boolean): ModelOptionDisplayParts {',
        lines: [
          '名称优先标签。',
          'provider 优先展示名。',
          '标注由禁用原因与当前标记组成。',
          '两者都没有时标注为空串。',
          '返回结构不修改入参。',
        ],
      },
      {
        anchor: 'function fitModelOptionRow(',
        lines: [
          '先算 provider 列预算。',
          '再扣选择符与间隔。',
          '标注只在模型名仍够宽时显示。',
          '剩余宽度全部给模型名。',
          '返回裁剪后的固定列宽。',
        ],
      },
      {
        anchor: 'function providerColumnBudget(provider: string, contentWidth: number): number {',
        lines: [
          '空 provider 预算为 0。',
          '上限为内容宽的四成。',
          '还需扣除选择符与最小模型名。',
          '取两者较小值。',
          '结果不小于 0。',
        ],
      },
    ],
  },
];

let index = 0;
for (const spec of specs) {
  const firstItem = { anchor: spec.first, raw: spec.header };
  if (spec.firstNth) firstItem.nth = spec.firstNth;
  const items = [firstItem];
  for (const block of spec.blocks) {
    const item = { anchor: block.anchor, lines: block.lines };
    if (block.nth) item.nth = block.nth;
    items.push(item);
  }
  const total = spec.header.length + spec.blocks.reduce((sum, b) => sum + b.lines.length, 0);
  const bodyTotal = spec.blocks.reduce((sum, b) => sum + b.lines.length, 0);
  console.log(`${spec.file} header=${spec.header.length} body=${bodyTotal} total=${total} expect=${spec.target} ${total === spec.target ? 'OK' : 'MISMATCH'}`);
  fs.writeFileSync(
    `ZC-deep-b113-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  index += 1;
}
