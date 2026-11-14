import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/settings/model-provider-section/ProviderTemplatePicker.tsx',
    first: 'import type { ProviderSettingsView } from "@zcode/services";',
    target: 46,
    header: [
      '// INV-01 模板分组只由 zhipuIds 决定：守住位置 常量数组；改错故障 新模板被分到错误分组。',
      '// INV-02 分组顺序固定为 zhipu 在前、other 在后：守住位置 groups 数组；改错故障 用户看到不稳定的排序。',
      '// INV-03 模板顺序保持服务端下发顺序：守住位置 flatMap 与 filter；改错故障 排序随本地实现变化。',
      '// INV-04 创建自定义供应商只在 other 组出现：守住位置 分组判断；改错故障 每个分组都多出一张自定义卡。',
      '// INV-05 创建期间所有卡片统一禁用：守住位置 disabled 入参；改错故障 并发点击创建多个供应商。',
      '// INV-06 创建失败必须留在当前页并给出可重试横幅：守住位置 createWithFeedback 的捕获；改错故障 用户看不到失败结果。',
      '// INV-07 重试动作复用同一条反馈键：守住位置 feedbackKey；改错故障 多次失败堆叠出多条横幅。',
      '// INV-08 启动新创建前先关闭旧反馈：守住位置 dismissFeedback 调用；改错故障 旧错误遮住新流程。',
      '// INV-09 原始错误只写统一日志，不进横幅：守住位置 logger.error；改错故障 内部细节暴露给用户。',
      '// INV-10 模板展示名统一走名称解析器：守住位置 resolveProviderTemplateName；改错故障 多语言下模板名不一致。',
      '// INV-11 自定义供应商名称走国际化默认文案：守住位置 customLabel；改错故障 空名称被提交。',
      '// INV-12 返回按钮必须有读屏标签：守住位置 aria-label；改错故障 图标按钮无含义。',
      '// INV-13 卡片测试标识按模板标识生成：守住位置 testId 调用；改错故障 自动化无法定位具体模板。',
      '// INV-14 卡片图标与文案都必须允许收缩与换行：守住位置 min-w-0 与 break-words；改错故障 长名称撑破网格。',
      '// INV-15 网格在窄屏单列、宽屏两列：守住位置 grid 类名；改错故障 移动端卡片过窄。',
      '// INV-16 卡片必须是原生按钮以保留键盘语义：守住位置 button 元素；改错故障 键盘无法聚焦或触发。',
      '// INV-17 悬停提示只承载完整名称，不改变点击行为：守住位置 ControlHintTooltip；改错故障 提示层拦截点击。',
      '// INV-18 创建回调只接受零参函数，参数在点击时闭包捕获：守住位置 createWithFeedback 签名；改错故障 异步过程中读到错误的模板标识。',
      '//',
      '// 模块职责：渲染供应商模板选择页，按智谱与其他分组展示模板，并提供自定义创建入口。',
      '// 状态所有权：模板列表来自入参；创建中标记与反馈横幅分别由父组件和共享反馈 hook 持有。',
      '// 阅读顺序：先看分组构造，再读带反馈的创建包装，最后看分组渲染与卡片组件。',
    ],
    blocks: [
      {
        anchor: 'const zhipuIds = ["bigmodel-api", "zai-api", "bigmodel-standard-api", "zai-standard-api"];',
        lines: [
          '这四个标识决定哪些模板进入智谱分组。',
          '分组只做展示归类，不改变模板能力。',
          '未列出的模板统一进入其他分组。',
          '新增模板时只需确认是否应归入此组。',
        ],
      },
      {
        anchor: 'const groups = [',
        lines: [
          '智谱组按标识顺序展开，保持稳定排序。',
          '其他组排除智谱标识，保留服务端顺序。',
          '两组都只包含模板数组，不携带额外状态。',
          '分组标识同时用于标题文案键。',
        ],
      },
      {
        anchor: 'const createWithFeedback = async (create: () => Promise<void>) => {',
        lines: [
          '每次创建前先关闭同键旧反馈。',
          '成功时不额外提示，由父组件切换页面。',
          '失败时保持当前页，避免用户丢失选择上下文。',
          '横幅只展示可读摘要与重试动作。',
          '原始错误对象只写入统一日志。',
          '重试闭包复用同一个创建函数。',
        ],
      },
      {
        anchor: '{groups.map((group) => (',
        lines: [
          '每个分组渲染标题与卡片网格。',
          '其他组在最前面插入自定义创建卡。',
          '模板卡按标识生成测试标识与键。',
          '创建中状态统一传给所有卡片。',
        ],
      },
      {
        anchor: 'function ProviderTemplateCard({',
        lines: [
          '卡片是受控展示组件，不持有状态。',
          '点击直接调用外部传入的回调。',
          '图标与文案都允许收缩，避免溢出。',
        ],
      },
      {
        anchor: 'onClick={() => void createWithFeedback(() => onCreateCustom(customLabel))}',
        lines: [
          '自定义创建同样经过反馈包装。',
          '名称在渲染时已解析为当前语言。',
          '返回的 Promise 被显式忽略，错误由包装处理。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/ToolCallBlocks/renderers/list-workflow-runs.tsx',
    first: 'import { History } from "lucide-react";',
    target: 47,
    header: [
      '// INV-01 折行主文案只取计数或空态，不展示运行明细：守住位置 primaryText；改错故障 折叠行被长文本撑开。',
      '// INV-02 单复数使用独立文案键：守住位置 计数格式化；改错故障 英文出现 1 runs。',
      '// INV-03 运行中与已结束使用不同动词：守住位置 kindLabel 条件；改错故障 进行中显示成已完成。',
      '// INV-04 只有结构化结果才渲染行列表：守住位置 listDisplay 判定；改错故障 把任意输出解析成运行记录。',
      '// INV-05 无结构化结果时回退到裁切后的纯文本：守住位置 fallbackText；改错故障 原始 JSON 直接铺满卡片。',
      '// INV-06 空输出不产生展开区：守住位置 hasDetails；改错故障 出现空白可展开容器。',
      '// INV-07 有运行记录才允许展开：守住位置 hasDetails 与 canToggle 组合；改错故障 空列表仍可点开。',
      '// INV-08 截断提示只在服务端标记时出现：守住位置 truncated 判断；改错故障 正常结果也提示不完整。',
      '// INV-09 失败状态必须走统一失败标签：守住位置 statusLabel 条件；改错故障 失败被渲染成普通完成。',
      '// INV-10 快照字段提示必须保留全量加载入口：守住位置 ToolSnapshotFieldNotice；改错故障 被裁字段无法恢复。',
      '// INV-11 行列表为空时单独渲染空态：守住位置 runs.length 判断；改错故障 出现空容器。',
      '// INV-12 每行状态词由状态枚举拼键：守住位置 模板字符串；改错故障 未知状态显示原始枚举。',
      '// INV-13 中断原因只在存在时追加：守住位置 stopReason 判断；改错故障 每行都显示空原因。',
      '// INV-14 本会话标记是展示签，不是筛选条件：守住位置 ownedByThisSession；改错故障 其他会话的运行被隐藏。',
      '// INV-15 可能中断只做行尾警示，不改写状态：守住位置 possiblyInterrupted；改错故障 状态点与文字矛盾。',
      '// INV-16 运行标识必须单行截断并保留完整悬停标题：守住位置 title 与 truncate；改错故障 长标识撑破行。',
      '// INV-17 时间与 token 都走统一格式化：守住位置 两个格式化函数；改错故障 数字精度与单位不一致。',
      '// INV-18 行键必须使用运行标识：守住位置 key；改错故障 列表更新时行状态错位。',
      '//',
      '// 模块职责：把 ListWorkflowRuns 的结构化结果渲染为可折叠的聊天卡，并逐行展示运行状态。',
      '// 状态所有权：运行数据来自工具结果；折叠与展开状态由通用 ToolLayout 持有。',
      '// 阅读顺序：先看展示数据与文案派生，再读内容与展开条件，最后看逐行列表。',
    ],
    blocks: [
      {
        anchor: 'const LIST_WORKFLOW_RUNS_TOOL_ICON = <History className="size-4 shrink-0 text-foreground-subtle" />;',
        lines: [
          '图标在模块加载时创建一次。',
          '尺寸与颜色跟随工具卡统一样式。',
          '历史图标表达运行记录而不是实时状态。',
        ],
      },
      {
        anchor: 'export function ListWorkflowRunsToolCallBlock(context: ToolCallBlockRenderContext) {',
        lines: [
          '只接受 list_workflow_runs 类型的结构化结果。',
          '计数与空态文案都在渲染前解析。',
          '主文案在依赖未变时保持引用稳定。',
          '内容区同时支持结构化列表与纯文本回退。',
          '展开条件要求至少有一种可展示内容。',
        ],
      },
      {
        anchor: 'const primaryText = useMemo(',
        lines: [
          '零条运行时显示空态。',
          '其余情况显示带计数的短语。',
          '依赖只包含三个展示值。',
          '返回 JSX 片段而不是字符串。',
        ],
      },
      {
        anchor: 'const renderContent = useMemo(() => {',
        lines: [
          '有结构化结果时渲染行列表。',
          '截断标记只追加一行说明。',
          '没有结构化结果时尝试纯文本回退。',
          '纯文本为空则不提供展开内容。',
          '内容函数在依赖变化时重建。',
        ],
      },
      {
        anchor: 'const hasDetails =',
        lines: [
          '有运行记录即可展开。',
          '没有运行记录时只有非空纯文本才可展开。',
          '该值同时控制折叠箭头与内容挂载。',
          '空结果保持纯折叠行，不产生空白区。',
        ],
      },
      {
        anchor: 'function ListWorkflowRunsBody({ runs }: { runs: ToolCallListWorkflowRunsDisplay["runs"] }) {',
        lines: [
          '空列表单独渲染空态文案。',
          '每行按运行标识生成键。',
          '状态点与状态词来自同一状态枚举。',
          '本会话标记与中断警示都是附加信息。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-flags-file.ts',
    first: '/**',
    firstNth: 1,
    target: 46,
    header: [
      '// INV-01 安全 flag 表是白名单，缺省即判可能写：守住位置 六张表；改错故障 未收录 flag 被放行。',
      '// INV-02 表只被对应的 simple-command policy 引用：守住位置 模块注释与导出；改错故障 其他命令误用宽松表。',
      '// INV-03 fd 的执行类 flag 必须保持不收录：守住位置 FD 表；改错故障 任意子进程被执行。',
      '// INV-04 sort 的输出类 flag 必须保持不收录：守住位置 SORT 表；改错故障 只读命令覆盖文件。',
      '// INV-05 date 的设置时间 flag 必须保持不收录：守住位置 DATE 表；改错故障 系统时间被修改。',
      '// INV-06 hostname 的写主机名 flag 必须保持不收录：守住位置 HOSTNAME 表；改错故障 系统主机名被改写。',
      '// INV-07 sha 校验类 flag 只保留只读语义：守住位置 SHA 表；改错故障 校验模式被误判为写入。',
      '// INV-08 base64 的输入输出 flag 按取值类型声明：守住位置 BASE64 表；改错故障 取值被当成位置参数。',
      '// INV-09 值类型只能取 SafeFlagValue 的五种形态：守住位置 satisfies 约束；改错故障 新增类型绕过 argv 解析。',
      '// INV-10 每个 flag 都必须显式声明取值类型：守住位置 值映射；改错故障 缺值 flag 吞掉后续路径。',
      '// INV-11 短选项与长选项分开列出：守住位置 两组键；改错故障 只匹配一种写法。',
      '// INV-12 同一命令的别名选项必须同时收录：守住位置 多组等价键；改错故障 换个写法就判写。',
      '// INV-13 表使用 as const 保持字面量类型：守住位置 每个表尾；改错故障 类型放宽后丢失穷尽检查。',
      '// INV-14 表对象不得被运行时修改：守住位置 Readonly 约束；改错故障 策略层意外增删条目。',
      '// INV-15 注释中说明的排除项必须与表内容一致：守住位置 每张表前注释；改错故障 维护者误以为已收录。',
      '// INV-16 新增 flag 前先确认其不会执行子进程或写盘：守住位置 评审口径；改错故障 只读策略被扩大。',
      '// INV-17 表顺序不影响判定，但保持字母序便于比对：守住位置 键排列；改错故障 人工审查遗漏重复键。',
      '// INV-18 本文件不包含任何执行逻辑：守住位置 模块边界；改错故障 数据与策略耦合难以复用。',
      '//',
      '// 模块职责：集中声明文件与搜索类只读命令的安全 flag 白名单及其取值类型。',
      '// 状态所有权：全部为不可变常量；策略层只读引用，本文件不持有运行时状态。',
      '// 阅读顺序：先读模块注释的保守口径，再按命令逐张查看白名单与排除说明。',
    ],
    blocks: [
      {
        anchor: 'export const FD_SAFE_FLAGS = {',
        lines: [
          '只收录纯查询与格式化选项。',
          '执行类选项刻意缺席，出现即判不可读。',
          '取值类型严格按命令手册声明。',
          '新增条目必须同步检查排除说明。',
        ],
      },
      {
        anchor: 'export const SORT_SAFE_FLAGS = {',
        lines: [
          '排序键、字段分隔符与稳定性选项都属只读。',
          '输出到文件的选项不在表中。',
          '检查模式只校验不写回。',
          '大小写与数字排序别名成对收录。',
        ],
      },
      {
        anchor: 'export const BASE64_SAFE_FLAGS = {',
        lines: [
          '解码与忽略垃圾字符不会写盘。',
          '换行宽度只影响输出格式。',
          '输入文件选项只读取指定内容。',
          '编码结果仍走标准输出。',
        ],
      },
      {
        anchor: 'export const SHA_SUM_SAFE_FLAGS = {',
        lines: [
          '校验模式只读取清单与目标文件。',
          '二进制与文本模式只影响读取方式。',
          '状态与安静选项只改变输出。',
          '严格模式在格式错误时失败，不写文件。',
        ],
      },
      {
        anchor: 'export const DATE_SAFE_FLAGS = {',
        lines: [
          '格式化与解析选项都只读。',
          '参考时间与参考文件不会修改系统时钟。',
          '时区展示选项只影响输出。',
          '设置时间的选项刻意不收录。',
        ],
      },
      {
        anchor: 'export const HOSTNAME_SAFE_FLAGS = {',
        lines: [
          '查询名称、域名与地址都只读。',
          '从文件读取新主机名的选项被排除。',
          '设置默认主机名的选项被排除。',
          '详细与别名选项只改变输出内容。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/core/src/tool/handlers/off-peak.ts',
    first: '// ============================================================',
    firstNth: 1,
    target: 47,
    header: [
      '// INV-01 闲时拒绝边界是本轮 offPeakTurn，不是 automation 轮：守住位置 assertNotOffPeakTurn；改错故障 定时派生的闲时任务被错误拒绝。',
      '// INV-02 拒绝必须抛权限错误且默认不可恢复：守住位置 createCoreError 参数；改错故障 模型无限重试同一调用。',
      '// INV-03 拒绝提示只拼接可选 hint：守住位置 hint 构造；改错故障 提示缺空格或吞掉自定义说明。',
      '// INV-04 端口缺失必须抛配置错误：守住位置 assertOffPeakPort；改错故障 运行时空指针崩溃。',
      '// INV-05 类型断言必须收窄 offPeakPort 非空：守住位置 asserts 签名；改错故障 后续调用仍需重复判空。',
      '// INV-06 业务失败分类只按 errorCategory 分派：守住位置 switch；改错故障 靠 message 猜分类导致文案漂移。',
      '// INV-07 客户端校验细分只按 errorCode 分派：守住位置 四个分支；改错故障 不同校验错误共用一句提示。',
      '// INV-08 未知分类必须回退到通用可行动文案：守住位置 default；改错故障 模型收到空错误。',
      '// INV-09 创建失败必须携带失败阶段与分类上下文：守住位置 createCoreError context；改错故障 无法定位服务端拒绝原因。',
      '// INV-10 创建入口必须先拒绝闲时轮再解析输入：守住位置 handler 首行；改错故障 被拒绝的调用仍消耗解析成本。',
      '// INV-11 创建必须绑定当前会话：守住位置 sessionId 入参；改错故障 任务派发到错误会话。',
      '// INV-12 成功消息只在队列位置存在时附带序号：守住位置 条件模板；改错故障 显示 undefined 队列位置。',
      '// INV-13 列表入口只解析输入并读取端口：守住位置 offPeakListHandler；改错故障 列表操作触发创建副作用。',
      '// INV-14 创建权限固定要求审批：守住位置 offPeakPermission 调用；改错故障 消耗免费额度却无确认。',
      '// INV-15 结果预算对模型与内联使用同一上限：守住位置 offPeakResultBudget；改错故障 模型看到被截断的不同内容。',
      '// INV-16 超时不允许调用方覆盖：守住位置 allowCallOverride；改错故障 单次调用绕过统一上限。',
      '// INV-17 创建与列表共享同一超时与预算对象：守住位置 两个 ToolEntry；改错故障 两个工具行为不一致。',
      '// INV-18 工具面默认延迟加载：守住位置 shouldDefer；改错故障 常驻工具面被低频能力挤占。',
      '//',
      '// 模块职责：实现闲时任务的创建与列表工具，并把 host 业务失败翻译为稳定 CoreError。',
      '// 状态所有权：任务与队列归 host；本文件只持有请求上下文与工具元数据。',
      '// 阅读顺序：先看拒绝与端口断言，再读失败翻译，最后看两个 handler 与 ToolEntry。',
    ],
    blocks: [
      {
        anchor: 'export function assertNotOffPeakTurn(',
        lines: [
          '非闲时轮直接放行。',
          '闲时轮抛出权限拒绝，默认不可恢复。',
          '可选提示会追加到错误文本末尾。',
          '上下文只保留调用标识与工具名。',
          '该函数也被发送消息与工作流复用。',
        ],
      },
      {
        anchor: 'function assertOffPeakPort(',
        lines: [
          '端口存在时断言通过。',
          '缺失时抛配置错误而不是运行时空指针。',
          '错误上下文同样只带调用标识与工具名。',
          '断言签名让后续代码直接使用非空端口。',
        ],
      },
      {
        anchor: 'function throwOffPeakCreateFailure(',
        lines: [
          '额度与资格错误各自给出可行动说明。',
          '客户端校验按错误码继续细分。',
          '网络错误提示稍后重试。',
          '未知分类回退到自动化页面重试。',
          '抛出时保留失败阶段、分类与错误码。',
        ],
      },
      {
        anchor: 'export const offPeakCreateHandler: ToolHandler = async (input, context) => {',
        lines: [
          '先做闲时轮拒绝，再解析输入。',
          '端口缺失时立即抛配置错误。',
          '创建请求固定绑定当前会话。',
          '失败统一交给翻译函数抛出。',
          '成功消息按队列位置决定是否附带序号。',
        ],
      },
      {
        anchor: 'export const offPeakListHandler: ToolHandler = async (input, context) => {',
        lines: [
          '列表只校验输入结构，不使用字段。',
          '端口缺失同样抛配置错误。',
          '读取结果原样返回，不做二次排序。',
        ],
      },
      {
        anchor: 'function offPeakPermission(',
        lines: [
          '风险等级与副作用范围固定为中危工作区。',
          '规则来源同时覆盖工具名与输入。',
          '需要审批时才禁用按工具名永久放行。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/ios-simulator-plugin/src/mcp/server.ts',
    first: '#!/usr/bin/env node',
    target: 50,
    header: [
      '// INV-01 参数 schema 必须声明相对路径语义：守住位置 target 与 build；改错故障 宿主传入绝对路径越界。',
      '// INV-02 模拟器目标三者都可省略：守住位置 target 字段；改错故障 未给目标时无法使用默认设备。',
      '// INV-03 构建参数默认使用插件数据目录：守住位置 derivedDataPath 描述；改错故障 污染用户 DerivedData。',
      '// INV-04 服务名与版本是客户端可见身份：守住位置 McpServer 构造；改错故障 工具命名空间变化。',
      '// INV-05 所有工具 handler 必须经 guard 包裹：守住位置 每个 registerTool；改错故障 异常打断 MCP 会话。',
      '// INV-06 guard 只保留错误消息，不返回堆栈：守住位置 catch；改错故障 内部路径泄露给客户端。',
      '// INV-07 非 Error 抛出物统一字符串化：守住位置 catch 分支；改错故障 客户端收到空错误。',
      '// INV-08 只读工具不得隐式启动模拟器：守住位置 preflight/list/discover/status；改错故障 查询操作改变系统状态。',
      '// INV-09 安装与启动类工具必须先确保模拟器可用：守住位置 boot 调用；改错故障 对关机设备执行安装。',
      '// INV-10 启动与打开 URL 默认打开模拟器窗口：守住位置 open 参数；改错故障 用户看不到运行界面。',
      '// INV-11 安装路径相对值必须限定在工作区内：守住位置 file 函数；改错故障 ../ 穿越读取任意目录。',
      '// INV-12 安装路径绝对值原样放行：守住位置 isAbsolute 分支；改错故障 无法安装 DerivedData 产物。',
      '// INV-13 硬件按钮只接受固定枚举：守住位置 z.enum；改错故障 任意字符串注入 idb。',
      '// INV-14 URL 长度必须受限：守住位置 max(2048)；改错故障 超长输入进入模拟器。',
      '// INV-15 截图同时返回元数据与图像内容：守住位置 image 调用；改错故障 模型只拿到路径无法看图。',
      '// INV-16 日志查询的时间窗口与条数必须为正整数：守住位置 seconds 与 limit；改错故障 负值导致 provider 异常。',
      '// INV-17 主入口只建立 stdio 传输并阻塞：守住位置 main；改错故障 额外副作用污染协议输出。',
      '// INV-18 直接执行时才启动服务：守住位置 import.meta.main 判断；改错故障 被导入时也拉起传输。',
      '//',
      '// 模块职责：注册 iOS 模拟器 MCP 工具，声明参数 schema，并把结果或异常包装为协议结果。',
      '// 状态所有权：工具实现全部在 providers；本文件只持有服务实例与 schema。',
      '// 阅读顺序：先看共享 schema 与服务实例，再按工具分组读注册，最后看 main 与 guard。',
    ],
    blocks: [
      {
        anchor: 'const target = {',
        lines: [
          'udid 精确指定目标设备。',
          '设备名与运行时都是片段匹配。',
          '三者省略时由 provider 选择已启动或默认设备。',
        ],
      },
      {
        anchor: 'const server = new McpServer({',
        lines: [
          '名称与版本共同构成客户端看到的插件身份。',
          '改动会同步影响宿主侧工具命名空间。',
          '实例在模块加载时创建一次。',
        ],
      },
      {
        anchor: '"ios_build_and_run",',
        lines: [
          '该工具串起构建、启动、安装、运行与开窗。',
          '任一步失败即中止并返回该步上下文。',
          '启动参数原样透传给应用。',
          '构建参数完全复用共享 build schema。',
        ],
      },
      {
        anchor: '"ios_screenshot",',
        lines: [
          '截图默认落在插件数据目录。',
          '文本结果只带模拟器、路径与字节数。',
          '图像内容单独走 base64。',
          '调用方可凭返回路径复用同一张图。',
        ],
      },
      {
        anchor: '"ios_ui_button",',
        lines: [
          '按钮枚举由 schema 限制，避免任意注入。',
          '按压时长可选，必须为正数。',
          '该工具依赖可选 UI 后端。',
          '未安装后端时 guard 会把错误转为可读结果。',
        ],
      },
      {
        anchor: 'export async function main(): Promise<void> {',
        lines: [
          '只建立 stdio 传输，不写标准输出。',
          '连接后阻塞在传输事件循环。',
          '连接关闭或进程终止时函数才返回。',
        ],
      },
      {
        anchor: 'async function guard(work: () => Promise<CallToolResult>): Promise<CallToolResult> {',
        lines: [
          '所有工具执行的唯一错误收敛点。',
          '异常转为失败结果而不是继续抛出。',
          '只保留消息，不附带堆栈。',
          '非 Error 抛出物统一字符串化。',
        ],
      },
      {
        anchor: 'function file(raw: string): string {',
        lines: [
          '绝对路径直接放行。',
          '相对路径限定在当前工作目录内。',
          '该函数阻止目录穿越。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/office-runtime/ui/viewers/DocxView.tsx',
    first: '// docx 查看器：用 docx-preview 把字节渲染成分页 DOM，再按服务端块锚点打 data-at 标记。',
    target: 49,
    header: [
      '// INV-01 渲染只在字节变化时重跑：守住位置 首个副作用依赖；改错故障 无关重渲反复替换 DOM。',
      '// INV-02 渲染前必须清空正文与样式容器：守住位置 replaceChildren；改错故障 旧文档与新文档叠加。',
      '// INV-03 卸载后不得再调用回调：守住位置 active 标记；改错故障 已卸载组件的回调被触发。',
      '// INV-04 渲染失败只走 onError：守住位置 catch；改错故障 非法文档让整页白屏。',
      '// INV-05 项目符号修复只改样式文本：守住位置 fixSymbolBullets；改错故障 正文文本被意外替换。',
      '// INV-06 未知私用区字形统一退化为圆点：守住位置 映射回退；改错故障 列表出现豆腐块。',
      '// INV-07 表格行只取直属本表的行：守住位置 rowsOf；改错故障 嵌套表行列号与服务端错位。',
      '// INV-08 缩放基准必须避免零尺寸除零：守住位置 scale 计算；改错故障 首帧得到 NaN 比例。',
      '// INV-09 适配模式与手动百分比共用同一比例：守住位置 zoom 分支；改错故障 百分比切换后跳回适配。',
      '// INV-10 缩放变化要保持视口中心：守住位置 useLayoutEffect；改错故障 每次缩放跳回左上角。',
      '// INV-11 比例未变或首次布局时不得滚动：守住位置 before 判断；改错故障 首帧无故滚动。',
      '// INV-12 三层高亮必须按固定顺序重绘：守住位置 paint；改错故障 当前查找命中被 Agent 标记盖住。',
      '// INV-13 挂载期监听必须在卸载时逐个解绑：守住位置 清理函数；改错故障 多文档切换后监听累积。',
      '// INV-14 选区跨段时合并为区间锚点：守住位置 p 区间判断；改错故障 只上报起始段，丢失选择范围。',
      '// INV-15 鼠标抬起必须延迟读取选区：守住位置 deferred；改错故障 拖选结束瞬间读到旧选区。',
      '// INV-16 显式锚点找不到时截图必须报错：守住位置 capture 的抛错；改错故障 静默截到错误页面。',
      '// INV-17 定位目标找不到时静默跳过，不中断其余目标：守住位置 reveal 的 continue；改错故障 一个坏锚点让整批定位失败。',
      '// INV-18 命令式句柄只读 ref，不额外依赖 props：守住位置 空依赖数组；改错故障 句柄重建导致调用方持有旧实例。',
      '//',
      '// 模块职责：把 docx 字节渲染为分页 DOM，并提供定位、高亮、查找、缩放、截图与选择能力。',
      '// 状态所有权：DOM 由 docx-preview 生成并归本组件；缩放与尺寸状态在本地，文档数据来自 props。',
      '// 阅读顺序：先看锚点映射与项目符号修复，再读渲染副作用，最后看事件接线与命令式句柄。',
    ],
    blocks: [
      {
        anchor: 'function elementsFor(root: HTMLElement, at: string): HTMLElement[] {',
        lines: [
          '段落区间展开为多个 data-at 元素。',
          '表格整表锚点直接返回表格。',
          '单元格锚点取对应行列，越界时回退整表。',
          '找不到目标时返回空数组而不是抛错。',
        ],
      },
      {
        anchor: 'function fixSymbolBullets(styles: HTMLElement) {',
        lines: [
          '只遍历渲染器生成的样式表。',
          '私用区字符按映射替换。',
          '文本未变化时不写回，避免无意义重排。',
        ],
      },
      {
        anchor: 'function rowsOf(table: HTMLElement): HTMLTableRowElement[] {',
        lines: [
          '从表格的行集合出发。',
          '用最近的表格祖先过滤嵌套行。',
          '返回顺序与服务端行列号一致。',
        ],
      },
      {
        anchor: 'export const DocxView = forwardRef<ViewerHandle, ViewerProps>(function DocxView(props, ref) {',
        lines: [
          '正文、样式与滚动容器分别持有引用。',
          '缩放状态区分适配模式与手动百分比。',
          '自然尺寸只在渲染后测量一次。',
          '回调引用每帧更新，避免闭包过期。',
          '句柄通过 imperative handle 暴露给 Shell。',
        ],
      },
      {
        anchor: 'renderAsync(props.bytes, body, styles, {',
        lines: [
          '分页、页眉页脚与脚注都启用。',
          '批注与修订不渲染，避免只读视图出现编辑痕迹。',
          '渲染成功后修复项目符号并打锚点。',
          '页数至少为一，防止空文档出现零页。',
        ],
      },
      {
        anchor: 'function annotate(body: HTMLElement) {',
        lines: [
          '只遍历正文文章节点。',
          '段落与标题作为块级锚点。',
          '表格整体作为一个锚点，内部单元格不再入列。',
          '对齐结果只在存在键时写入 data-at。',
        ],
      },
      {
        anchor: 'useLayoutEffect(() => {',
        lines: [
          '布局阶段先记录上一比例。',
          '比例未变、容器未挂载或首次布局时直接返回。',
          '缩放后按新旧比例换算滚动位置。',
          '同时扣减并补回画布内边距。',
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
    `ZC-deep-b108-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  index += 1;
}
