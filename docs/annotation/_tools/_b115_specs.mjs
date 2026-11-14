import fs from 'node:fs';

const specs = [
  {
    file: 'packages/shared/src/project-access-token.ts',
    first: 'import { z } from "zod";',
    target: 45,
    header: [
      '// INV-01 响应先补默认 enable：守住位置 responseSchema 预处理；改错故障 旧服务端响应被判非法。',
      '// INV-02 enable 为判别键：守住位置 discriminatedUnion；改错故障 关闭态仍带令牌字段。',
      '// INV-03 令牌文本必须非空：守住位置 accessToken 约束；改错故障 空串被缓存为有效凭据。',
      '// INV-04 有效期必须为正有限数：守住位置 expiresIn 与 expiresAt；改错故障 无穷大令牌常驻。',
      '// INV-05 作用域八元组共同定键：守住位置 scopeKey；改错故障 不同场景误共享令牌。',
      '// INV-06 登录代次不得用令牌派生：守住位置 loginGeneration；改错故障 令牌原文进入键与日志。',
      '// INV-07 缓存只做内存态：守住位置 ProjectAccessTokenCache；改错故障 实例被跨宿主共享。',
      '// INV-08 时间与随机源可注入：守住位置 构造选项；改错故障 刷新时序无法单测。',
      '// INV-09 指纹只清被拒绝的那一代：守住位置 rejectedFingerprint 判断；改错故障 迟到 401 废掉新凭据。',
      '// INV-10 同一键的并发只发一个请求：守住位置 pending 复用；改错故障 同步重入触发重复签发。',
      '// INV-11 未到刷新点直接返回缓存：守住位置 有效期比较；改错故障 每次调用都换证。',
      '// INV-12 签发延迟到微任务：守住位置 Promise 首段；改错故障 同步重入绕过 pending 登记。',
      '// INV-13 换人后旧请求必须作废：守住位置 三处对象身份比较；改错故障 旧登录态结果写回新缓存。',
      '// INV-14 有效期从请求发起时起算：守住位置 startedAt；改错故障 网络耗时被算成额外有效期。',
      '// INV-15 刷新点保留提前量与抖动：守住位置 refreshAt 计算；改错故障 到期瞬间并发雪崩。',
      '// INV-16 仅临时故障允许降级：守住位置 捕获分支；改错故障 认证拒绝被当成可重试。',
      '// INV-17 降级不延长原有效期：守住位置 重试截止比较；改错故障 过期令牌被继续使用。',
      '// INV-18 异常不携带响应与令牌：守住位置 自定义错误；改错故障 凭据进入日志或堆栈。',
      '//',
      '// 模块职责：项目访问令牌的解析、缓存、并发合并与临时故障降级。',
      '// 状态所有权：缓存实例由各宿主各自持有；模块本身无全局单例。',
      '// 阅读顺序：先看响应 schema，再读缓存类，最后看指纹与作用域键。',
    ],
    blocks: [
      {
        anchor: 'const responseSchema = z.preprocess(',
        lines: [
          '响应在解析前先补默认值。',
          '缺少 enable 字段时按启用处理。',
          '兼容旧服务端只返回令牌体。',
          'enable 为假时走关闭分支。',
          '类型与有效期都做严格校验。',
          '解析失败统一转成凭据错误。',
        ],
      },
      {
        anchor: 'export class ProjectAccessTokenCache {',
        lines: [
          '缓存只做内存态。',
          '每个宿主各自持有实例。',
          '时间与随机源都可注入。',
          '键由八元组序列化得到。',
          '同一账号不同场景互不共享。',
          '登录代次变化即视为换人。',
        ],
      },
      {
        anchor: 'async resolve(',
        lines: [
          '先按指纹清理被拒绝的那一代。',
          '迟到的 401 不得废弃新凭据。',
          '同步重入复用同一个 pending。',
          '有效期内直接返回缓存值。',
          '签发延迟到微任务再发起。',
          '换人后旧请求一律作废。',
        ],
      },
      {
        anchor: 'invalidate(scope: ProjectAccessTokenScope): void {',
        lines: [
          '作废指定作用域的缓存。',
          '登出与切号都调用这里。',
          'clear 用于整表回收。',
          '指纹只做比较不做身份。',
          '摘要不进入日志与上游。',
        ],
      },
    ],
  },
  {
    file: 'packages/shared/src/remoteUsageTelemetry.ts',
    first: 'import type { RemoteTarget } from "./remoteTarget.js";',
    target: 45,
    header: [
      '// INV-01 埋点只取场景枚举：守住位置 resolveWorkspaceTelemetryDetail；改错故障 地址或路径进入业务埋点。',
      '// INV-02 本地与远端判定看两个来源：守住位置 workspace_kind 计算；改错故障 远端会话被记为本地。',
      '// INV-03 未知远端身份仍归远端：守住位置 三元回退；改错故障 无法解析时降级为本地。',
      '// INV-04 远端类别只保留解析结果：守住位置 remote_kind；改错故障 原始标识被带出。',
      '// INV-05 成功时错误分类必须为空：守住位置 buildResultDetail；改错故障 成功事件带 residual 分类。',
      '// INV-06 失败时分类缺省 unknown：守住位置 回退分支；改错故障 看板出现空分类。',
      '// INV-07 分类集合保持低基数：守住位置 RemoteUsageErrorCategory；改错故障 自由文本炸开维度。',
      '// INV-08 事件区域由构建函数固定：守住位置 buildWebRemoteControlEvent；改错故障 区域名各写各的。',
      '// INV-09 连接结果事件字段固定：守住位置 buildRemoteWorkspaceConnectResultTelemetry；改错故障 键名漂移。',
      '// INV-10 触发方式三选一：守住位置 RemoteWorkspaceConnectTrigger；改错故障 新入口无法归类。',
      '// INV-11 入口浏览事件只带类别：守住位置 buildWebRemoteControlEntryViewTelemetry；改错故障 浏览带结果字段。',
      '// INV-12 启动结果区分取消：守住位置 WebRemoteControlStartTelemetryResult；改错故障 取消被记成失败。',
      '// INV-13 配对与桥接各带专属维度：守住位置 pair_kind 与 entry_kind；改错故障 两条漏斗混线。',
      '// INV-14 原始错误只在本地匹配：守住位置 readErrorSearchText；改错故障 错误原文进入埋点。',
      '// INV-15 错误匹配先小写再判定：守住位置 字符串拼接与 lower；改错故障 大小写导致漏判。',
      '// INV-16 认证类优先命中：守住位置 第一条正则；改错故障 权限错误被记成连接失败。',
      '// INV-17 部署与启动分列：守住位置 中段正则；改错故障 资产失败与进程失败混淆。',
      '// INV-18 都不命中记 unknown：守住位置 末尾回退；改错故障 未分类事件被丢弃。',
      '//',
      '// 模块职责：远端工作区与网页远控的使用埋点事件构造和错误归类。',
      '// 状态所有权：无状态；全部为纯函数，事件对象每次新建。',
      '// 阅读顺序：先看工作区类别，再读各事件构造，最后看错误归类。',
    ],
    blocks: [
      {
        anchor: 'export function resolveWorkspaceTelemetryDetail(scope: {',
        lines: [
          '埋点只取场景枚举。',
          '地址与远端会话都为空才算本地。',
          '未知远端身份仍归为远端。',
          '远端类别只保留解析结果。',
          '地址与路径一律不下发。',
          '返回值形状固定两个键。',
        ],
      },
      {
        anchor: 'function buildResultDetail(',
        lines: [
          '失败才填错误分类。',
          '成功时分类固定为空串。',
          '缺省分类回落到 unknown。',
          '分类集合保持低基数。',
          '构建函数不修改入参。',
          '结果键名与看板对齐。',
        ],
      },
      {
        anchor: 'export function buildRemoteWorkspaceConnectResultTelemetry(input: {',
        lines: [
          '连接结果事件固定区域。',
          '远端类别必填。',
          '触发方式三选一。',
          '成功时忽略传入分类。',
          '失败时缺省记 unknown。',
          '事件名用于漏斗首步。',
        ],
      },
      {
        anchor: 'export function classifyRemoteUsageError(error: unknown): RemoteUsageErrorCategory {',
        lines: [
          '原始错误只在本地匹配。',
          '先取 code 与 message 并小写。',
          '认证类优先命中。',
          '其余按部署、启动、附加、中继、连接排列。',
          '都不命中记 unknown。',
        ],
      },
    ],
  },
  {
    file: 'packages/shared/src/zcode-network-debug-status.ts',
    first: 'import type {',
    target: 44,
    header: [
      '// INV-01 五种模型网络状态是白名单：守住位置 MODEL_NETWORK_STATUS_TYPES；改错故障 未知类型进入事件。',
      '// INV-02 类型不在白名单即丢弃：守住位置 首个提前返回；改错故障 客户端收到无意义状态。',
      '// INV-03 事件键缺省由六段拼接：守住位置 eventKey 构造；改错故障 同类事件互相覆盖。',
      '// INV-04 调用方事件标识优先：守住位置 eventId 回退顺序；改错故障 上游编号被覆盖。',
      '// INV-05 查询标识双来源：守住位置 resolvedQueryId；改错故障 旧载荷丢失关联。',
      '// INV-06 请求头只收字符串值：守住位置 stringRecordValue；改错故障 嵌套对象进入事件。',
      '// INV-07 头部计数缺省取实际键数：守住位置 空值回退；改错故障 计数与内容不一致。',
      '// INV-08 可选字段只在合法时展开：守住位置 条件展开；改错故障 未定义键污染事件。',
      '// INV-09 模型标识拆成两个可选字段：守住位置 asRecord 与逐字段取值；改错故障 整个对象被透传。',
      '// INV-10 数值必须非负有限：守住位置 nonNegativeNumberValue；改错故障 负数时长进入看板。',
      '// INV-11 整数必须非负：守住位置 nonNegativeIntegerValue；改错故障 小数计数被接受。',
      '// INV-12 尝试次数必须为正：守住位置 positiveIntegerValue；改错故障 零次尝试被记录。',
      '// INV-13 布尔只接受真布尔：守住位置 booleanValue；改错故障 字符串真值被当可重试。',
      '// INV-14 空字符串视为缺失：守住位置 stringValue；改错故障 空值占位进入事件。',
      '// INV-15 数组不当作记录：守住位置 asRecord；改错故障 数组下标被当字段名。',
      '// INV-16 头部保持原始键序：守住位置 fromEntries；改错故障 顺序抖动影响快照。',
      '// INV-17 状态类型收窄不用断言逃逸：守住位置 类型守卫；改错故障 非法字符串进入联合类型。',
      '// INV-18 本文件不做 I/O 与状态缓存：守住位置 纯函数边界；改错故障 事件构造被副作用污染。',
      '//',
      '// 模块职责：把任务载荷归类为网络调试状态事件。',
      '// 状态所有权：无状态；只有只读白名单集合与纯转换函数。',
      '// 阅读顺序：先看白名单，再读事件构造，最后看各类型守卫。',
    ],
    blocks: [
      {
        anchor: 'const MODEL_NETWORK_STATUS_TYPES = new Set<ZCodeTaskNetworkDebugStatusType>([',
        lines: [
          '五种模型网络状态是白名单。',
          '未知类型直接丢弃。',
          '集合在模块加载时固定。',
          '新增状态必须同步这里。',
          '重试与卡顿都属于调试面。',
          '该集合不参与运行时推导。',
        ],
      },
      {
        anchor: 'export function zcodeTaskNetworkDebugStatusFromPayload(params: {',
        lines: [
          '类型不在白名单时返回空。',
          '头部先按字符串字典收敛。',
          '模型标识拆成两个可选字段。',
          '事件键缺省由六段拼接。',
          '可选数值只在合法时写入。',
          '头部计数缺省取实际键数。',
        ],
      },
      {
        anchor: 'function networkStatusTypeValue(value: unknown): ZCodeTaskNetworkDebugStatusType | undefined {',
        lines: [
          '只接受字符串类型。',
          '命中白名单才转换。',
          '其余返回未定义。',
          '该守卫不做二次解析。',
          '调用方据此提前退出。',
        ],
      },
      {
        anchor: 'function stringRecordValue(value: unknown): Record<string, string> {',
        lines: [
          '非对象一律当空记录。',
          '数组也不接受。',
          '只保留值为字符串的条目。',
          '键顺序保持原样。',
          '空对象是合法结果。',
        ],
      },
    ],
  },
  {
    file: 'packages/shared/src/zcode-session-visible-content.ts',
    first: null,
    target: 46,
    header: [
      '// INV-01 续跑提醒有两种前缀形态：守住位置 isZCodeGoalContinuationReminderText；改错故障 旧快照提醒被当用户输入。',
      '// INV-02 新版按 source 属性识别：守住位置 消息级判定首支；改错故障 仅靠文案导致漏判。',
      '// INV-03 旧版只认固定文案：守住位置 文案常量；改错故障 任意系统提醒被误判为续跑。',
      '// INV-04 比较先去前导空白：守住位置 trimStart；改错故障 缩进提醒逃过过滤。',
      '// INV-05 状态提示不计入续跑：守住位置 isZCodeGoalStateReminderText；改错故障 每轮状态注入都推进迭代。',
      '// INV-06 模型专用提醒含续跑与状态：守住位置 isZCodeGoalModelOnlyReminderMessage；改错故障 状态提示进入可见气泡。',
      '// INV-07 子 agent 消息按来源识别：守住位置 SUBAGENT_MESSAGE_SOURCE；改错故障 后台消息被当用户提问。',
      '// INV-08 来源可落在消息或分段：守住位置 三处来源读取；改错故障 只在消息级判断导致漏网。',
      '// INV-09 投影策略再兜底：守住位置 getConversationMessageProjectionPolicy；改错故障 隐藏合成消息显示出来。',
      '// INV-10 压缩摘要按 timelineStatus 区分：守住位置 isZCodeCompactSummaryMessage；改错故障 压缩上下文被渲染成用户输入。',
      '// INV-11 可见投影不回写原数组：守住位置 新建数组；改错故障 调用方数据被就地修改。',
      '// INV-12 过滤保持原相对顺序：守住位置 单次遍历；改错故障 消息顺序错乱。',
      '// INV-13 迭代统计先稳定排序：守住位置 compareZCodeMessagesByCreatedTime；改错故障 同毫秒消息抖动。',
      '// INV-14 续跑边界才推进迭代：守住位置 续跑分支；改错故障 状态提示被算成新一轮。',
      '// INV-15 可见 goal 输入只补首段：守住位置 pending 标志；改错故障 同一轮被计两次。',
      '// INV-16 目标失效后的回复不继承：守住位置 inactiveAt 比较；改错故障 追问被折叠进旧轮次。',
      '// INV-17 旧会话首条回复归第一轮：守住位置 零轮次回填；改错故障 历史区退回普通状态。',
      '// INV-18 迭代上限由 verifier 收敛：守住位置 maxGoalIteration；改错故障 未确认轮次提前展示。',
      '//',
      '// 模块职责：旧协议兼容面上的 goal 与可见消息投影函数。',
      '// 状态所有权：无状态；全部为纯函数，输入数组不被修改。',
      '// 阅读顺序：先看提醒与可见性判定，再读投影，最后看迭代统计。',
    ],
    blocks: [
      {
        anchor: 'export function isZCodeGoalContinuationReminderText(text: string): boolean {',
        lines: [
          '续跑提醒有两种前缀形态。',
          '新协议带 source 属性。',
          '旧协议只认固定文案。',
          '去前导空白后比较。',
          '状态提示不计入续跑。',
          '该判定被消息级函数复用。',
        ],
      },
      {
        anchor: 'export function isZCodeModelOnlySyntheticUserMessage(message: ZCodeMessageWithParts): boolean {',
        lines: [
          '子 agent 注入按来源识别。',
          '来源可落在消息或分段。',
          '投影策略再兜底一次。',
          '隐藏合成与仅上下文都算。',
          '真实用户输入不在此列。',
          '该函数是可见性总闸。',
        ],
      },
      {
        anchor: 'export function getZCodeUserVisibleMessages(',
        lines: [
          '逐条过滤模型专用消息。',
          '压缩摘要也一并隐藏。',
          '剩余消息保持原顺序。',
          '投影不改写消息内容。',
          '目标参数当前不参与过滤。',
          '返回值是新数组。',
        ],
      },
      {
        anchor: 'export function getZCodeGoalIterationByAssistantMessageId(',
        lines: [
          '先按创建时间稳定排序。',
          '续跑边界推进迭代号。',
          '可见 goal 输入只补首段。',
          '状态提示不推进轮次。',
          '目标失效后的回复不继承。',
          '上限由 verifier 收敛。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/app-shell/WorkflowRunDirectorySidePane.tsx',
    first: 'import { memo, useEffect, useMemo, useState } from "react";',
    target: 48,
    header: [
      '// INV-01 打开请求只带作用域与运行标识：守住位置 buildWorkflowRunDirectoryOpenRequest；改错故障 详情页拿到错误 run。',
      '// INV-02 工作区身份与远端会话按需展开：守住位置 条件展开；改错故障 空值键覆盖默认作用域。',
      '// INV-03 展示名只作标题兜底：守住位置 workflowName 注释语义；改错故障 目录行名与详情标题不一致。',
      '// INV-04 运行标识与工具调用标识必填：守住位置 请求字段；改错故障 详情页无法回查来源。',
      '// INV-05 行只渲染 journal 摘要：守住位置 DirectoryRow；改错故障 实时状态重复渲染两套。',
      '// INV-06 未命名运行用统一兜底名：守住位置 label 回退；改错故障 runId 暴露到界面。',
      '// INV-07 状态词是主通道圆点是冗余：守住位置 文本与圆点；改错故障 仅靠颜色传达状态。',
      '// INV-08 停止原因优先于失败码：守住位置 stopReason 判断；改错故障 可读原因被技术码覆盖。',
      '// INV-09 相对时间可缺省：守住位置 updatedAt 判断；改错故障 缺失时间显示为 1970。',
      '// INV-10 分段只负责标题与空态：守住位置 DirectorySection；改错故障 统计口径散落两处。',
      '// INV-11 计数直接取行数：守住位置 rows.length；改错故障 计数与列表不一致。',
      '// INV-12 空段保留可测标识：守住位置 emptyTestId；改错故障 空态无法被测试区分。',
      '// INV-13 运行段与已结束段分开：守住位置 section 字段；改错故障 跑完不挪段。',
      '// INV-14 租约随页签生命周期获取与释放：守住位置 useEffect 清理；改错故障 对话层租约泄漏。',
      '// INV-15 投影只作刷新触发器：守住位置 refreshKey；改错故障 页面跑完仍留在运行中。',
      '// INV-16 刷新键由运行数与结算数组成：守住位置 workflowRunDirectoryRefreshKey；改错故障 节点级事件导致频繁重取。',
      '// INV-17 三种无行状态必须可分辨：守住位置 unavailable 与 empty 分支；改错故障 接口缺失被显示成空列表。',
      '// INV-18 截断必须明写上限：守住位置 truncated 分支；改错故障 取满一页被当成全部。',
      '//',
      '// 模块职责：一条对话的 workflow 运行目录侧边页。',
      '// 状态所有权：租约与投影来自对话层；目录行由摘要查询派生。',
      '// 阅读顺序：先看打开请求，再读行与分段，最后看内容装配。',
    ],
    blocks: [
      {
        anchor: 'function buildWorkflowRunDirectoryOpenRequest(',
        lines: [
          '打开请求只带作用域与运行标识。',
          '工作区身份与远端会话按需展开。',
          '展示名只作标题兜底。',
          '运行标识与工具调用标识必填。',
          '父会话来自目录页签。',
          '该函数不读全局状态。',
        ],
      },
      {
        anchor: 'const DirectoryRow = memo(function DirectoryRow({',
        lines: [
          '行只渲染 journal 摘要。',
          '未命名运行用统一兜底名。',
          '状态词是主通道，圆点是冗余。',
          '停止原因优先于失败码。',
          '相对时间可缺省。',
        ],
      },
      {
        anchor: 'function DirectorySection({',
        lines: [
          '分段只负责标题与空态。',
          '计数直接取行数。',
          '空段也保留可测标识。',
          '已结束段与运行段分开。',
          '段内顺序由模型给定。',
        ],
      },
      {
        anchor: 'const WorkflowRunDirectoryContents = memo(function WorkflowRunDirectoryContents({',
        lines: [
          '租约随页签生命周期获取与释放。',
          '投影只作刷新触发器。',
          '刷新键由运行数与结算数组成。',
          '三种无行状态必须可分辨。',
          '截断时明写上限。',
        ],
      },
      {
        anchor: 'export const WorkflowRunDirectorySidePane = memo(function WorkflowRunDirectorySidePane({',
        lines: [
          '外层只装配作用域。',
          '作用域依赖三个可空字段。',
          '上下文提供者包住内容。',
          '页签变化会重建作用域。',
          '组件本身不持有数据。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/ChatMediaAttachmentPreviewDialog.tsx',
    first: 'import { lazy, Suspense, useEffect, useState } from "react";',
    target: 46,
    header: [
      '// INV-01 PDF 组件只在渲染时加载：守住位置 LazyPdfViewer；改错故障 对话列表触发浏览器专属依赖。',
      '// INV-02 懒加载边界只包 PDF：守住位置 dynamic import；改错故障 图片与视频加载行为被改变。',
      '// INV-03 动态导入返回默认导出：守住位置 模块映射；改错故障 组件为空导致渲染崩溃。',
      '// INV-04 附件为空仍可渲染标题：守住位置 attachment 可空；改错故障 关闭动画期间白屏。',
      '// INV-05 文本内容优先于链接：守住位置 首个渲染分支；改错故障 文本附件被当图片加载。',
      '// INV-06 PDF 源与普通链接分开判断：守住位置 pdfSource 分支；改错故障 PDF 走图片标签。',
      '// INV-07 视频按 MIME 前缀识别：守住位置 isVideo；改错故障 视频被当图片。',
      '// INV-08 PDF 判定去掉参数并小写：守住位置 isPdf；改错故障 带 charset 的 PDF 无法预览。',
      '// INV-09 切换附件必须重置播放状态：守住位置 useEffect 依赖；改错故障 新视频沿用旧状态。',
      '// INV-10 打开对话框也重置播放状态：守住位置 open 依赖；改错故障 二次打开直接显示错误。',
      '// INV-11 不支持时只提示不阻断：守住位置 unsupported 分支；改错故障 解码失败导致对话框崩溃。',
      '// INV-12 媒体错误不改写附件事实：守住位置 onError；改错故障 预览失败被当成发送失败。',
      '// INV-13 加载文案按媒体类型分派：守住位置 loadingLabel 三元；改错故障 视频等待显示通用文案。',
      '// INV-14 不可用文案同规则分派：守住位置 unavailableLabel；改错故障 错误提示与类型不符。',
      '// INV-15 PDF 标签复用代码查看器文案：守住位置 pdfViewerLabels；改错故障 分页控件无本地化。',
      '// INV-16 非 PDF 不构造标签对象：守住位置 isPdf 三元；改错故障 无谓对象进入渲染。',
      '// INV-17 加载与错误态互斥展示：守住位置 末尾分支链；改错故障 同时出现两个提示。',
      '// INV-18 组件不修改附件对象：守住位置 只读入参；改错故障 调用方数据被副作用改写。',
      '//',
      '// 模块职责：聊天媒体附件的图片、视频、PDF 与文本预览对话框。',
      '// 状态所有权：仅播放状态为本地状态；附件与开关由调用方持有。',
      '// 阅读顺序：先看懒加载，再读类型判定，最后看渲染分支。',
    ],
    blocks: [
      {
        anchor: 'const LazyPdfViewer = lazy(async () => {',
        lines: [
          'PDF 组件只在渲染时加载。',
          '避免对话列表触发浏览器依赖。',
          '图片与视频分支不受影响。',
          '动态导入返回默认导出。',
          '测试环境因此无需补垫片。',
          '懒加载边界只包 PDF。',
        ],
      },
      {
        anchor: 'export function ChatMediaAttachmentPreviewDialog({',
        lines: [
          '入参包含目标、开关与加载态。',
          '附件为空时仍可渲染标题。',
          '文本内容优先于链接。',
          'PDF 源与普通链接分开判断。',
          '错误态与加载态互斥展示。',
          '组件不修改附件对象。',
        ],
      },
      {
        anchor: 'const pdfViewerLabels: Partial<PdfViewerLabels> | undefined = isPdf',
        lines: [
          'PDF 文案按需组装。',
          '非 PDF 时不构造标签。',
          '页导航文案复用代码查看器。',
          '缺省项交给查看器兜底。',
          '标签对象每次渲染新建。',
          '该对象不参与依赖比较。',
        ],
      },
      {
        anchor: 'const isVideo = attachment?.mediaType.startsWith("video/") === true;',
        lines: [
          '视频按 MIME 前缀识别。',
          'PDF 判定去掉参数并小写。',
          '切换附件时重置播放状态。',
          '打开对话框也会重置。',
          '不支持时只提示不阻断。',
          '媒体错误不改写附件事实。',
        ],
      },
    ],
  },
];

let index = 0;
for (const spec of specs) {
  const srcLines = fs.readFileSync('D:/code/ZCode/' + spec.file, 'utf8').split('\n');
  const firstAuto = srcLines[0].replace(/\r$/, '').trim();
  const firstAnchor = spec.first ?? firstAuto;
  if (spec.first && firstAnchor !== firstAuto) {
    console.error(`FIRST MISMATCH ${spec.file}\n  spec: ${spec.first}\n  file: ${firstAuto}`);
    process.exit(1);
  }
  const firstItem = { anchor: firstAnchor, raw: spec.header };
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
    `ZC-deep-b115-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  index += 1;
}
