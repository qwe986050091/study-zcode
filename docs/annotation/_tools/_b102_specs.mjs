import fs from 'node:fs';

const specs = [
  {
    file: 'apps/zcode-cli/packages/core/src/workflow/scheduler/node-runner.ts',
    first: 'import {',
    target: 53,
    header: [
      '// INV-01 节点状态只允许 pending→active→completed|pending|failed 三种迁移：守住位置 updateGraphNode 调用点；改错故障 节点卡在 active 导致整图永不收敛。',
      '// INV-02 started 必须在 active 快照落盘并发出 node_started 之后才 resolve：守住位置 resolveStarted 调用点；改错故障 调度器读到未落盘快照，重放时状态错位。',
      '// INV-03 所有快照写入与事件追加都必须透传 abortSignal：守住位置 writeSnapshot/appendGraphStatus/emitEvent 参数；改错故障 取消后仍在写盘，留下半结算记录。',
      '// INV-04 事件顺序固定 node_started → workflow_session_linked → artifact_written → node_completed：守住位置 主流程 await 序列；改错故障 订阅者按序断言失败，活动时间线倒序。',
      '// INV-05 失败路径只发 node_failed，不再补发 node_completed：守住位置 catch 分支；改错故障 单次失败被计成一次成功，重试口径失真。',
      '// INV-06 attempts 只在非取消失败时累加：守住位置 catch 内 abortSignal 检查之后；改错故障 用户取消被当成失败重试，耗尽 maxAttempts。',
      '// INV-07 nextStatus 达到 maxAttempts 才落 failed，否则回 pending：守住位置 nextStatus 计算；改错故障 首次失败即终态，重试策略失效。',
      '// INV-08 子会话链接事件只写回仍为 active 的活动：守住位置 onChildSessionStarted 前置判断；改错故障 已结算活动被改写，产物与状态不一致。',
      '// INV-09 产物路径必须经 safeArtifactName 归一：守住位置 writeArtifact 第一个参数；改错故障 节点 id 含路径分隔符时写到目录之外。',
      '// INV-10 完成态活动必须带 artifactPath 且输出路径唯一：守住位置 completedSnapshot 的 outputArtifactPaths；改错故障 下游读不到产物，图执行中断。',
      '// INV-11 完成态优先采用 runner 返回的 traceId/sessionId，缺失才回落：守住位置 completedSnapshot 字段展开顺序；改错故障 追踪链断在节点边界。',
      '// INV-12 失败态活动保留已完成阶段的 sessionId/model/traceId：守住位置 currentActivity 条件展开；改错故障 失败归因丢失会话线索。',
      '// INV-13 输入产物路径在节点启动时快照一次，之后不重算：守住位置 inputArtifactPaths 赋值；改错故障 运行期新增产物被冒充成输入。',
      '// INV-14 traceContext 只在父上下文存在时创建子上下文：守住位置 createChildTraceContext 三目；改错故障 无父链时生成孤立 trace，上报断链。',
      '// INV-15 快照更新一律走 upsertActivity 与 updateGraphNode 组合：守住位置 active/completed/failed 三处；改错故障 活动与节点状态各说一套。',
      '// INV-16 每个事件都携带 nodeId 与 phase：守住位置 emitEvent 负载；改错故障 多阶段同图运行时事件无法归位。',
      '// INV-17 返回值 ok=false 而不是抛错（取消除外）：守住位置 catch 末尾 return；改错故障 调度器把可重试失败当成致命异常，整图中止。',
      '// INV-18 started 挂在 promise 上供调用方 await：守住位置 return 前三行赋值；改错故障 调用方拿不到启动信号，同步快照时序失效。',
      '//',
      '// 模块职责：把一个 ready 图节点跑成一次受控子会话，并负责状态图、活动、产物与事件的成对结算。',
      '// 状态所有权：节点状态与活动由本模块写快照并经 snapshotAccess 回灌；调度器只读快照、只决定下一轮派发。',
      '// 阅读顺序：先看 runWorkflowNode 的参数与 started 契约，再读 active 段、runner 调用与完成段，最后看 catch 的重试判定。',
    ],
    blocks: [
      {
        anchor: 'export function runWorkflowNode(',
        lines: [
          '[并发] 本函数不持有调度器锁：调用方必须保证同一 node.id 不会被并发派发两次。',
          '参数 snapshotAccess 是唯一快照出入口，runtime 负责写盘、发事件与产物落盘。',
          'maxAttempts 由调度器按 strategy 传入，本层不读取任何全局重试配置。',
          '返回的 thenable 同时带 started 字段，供调度器在 node_started 之后同步快照。',
          '[资源] 每次调用都会新建 activityId，活动粒度是「一次派发尝试」而非「一个节点」。',
        ],
      },
      {
        anchor: 'const promise = (async () => {',
        lines: [
          '启动信号独立成 promise，避免调用方为了拿到快照而 await 整轮节点执行。',
          '异步主体立即开始执行，因此 active 结算发生在返回给调用方之前。',
          '[并发] started 只会 resolve 一次，重复 resolve 由 Promise 语义天然忽略。',
          '[失败路径] 主体内任何异常都不会漏出，catch 统一转成 ok=false 的结算。',
          'promise 对象在末尾补 started 字段后返回，类型见 WorkflowSchedulerNodePromise。',
        ],
      },
      {
        anchor: 'try {',
        lines: [
          '从这里进入「已启动」阶段：active 快照与 node_started 均已落盘。',
          '[事务] 完成态的图节点更新、活动更新、产物登记三步合并成一次快照写入。',
          '其中任一步抛错都会落到 catch，由重试逻辑决定回 pending 还是 failed。',
          '取消信号触发的异常不在这里结算，直接向上抛给调度器。',
        ],
      },
      {
        anchor: 'onChildSessionStarted: async (event) => {',
        lines: [
          '子会话在 runner 内部创建后才回调到这里，参数只带会话标识与可选模型。',
          '[并发] 回调可能晚于节点结算到达，因此每次都用最新快照重新定位活动。',
          '只更新仍为 active 的活动，已完成或已失败的活动保持原样。',
          '写盘与事件顺序与主流程一致：先写快照，再发 workflow_session_linked。',
          '事件负载走 compactWorkflowPayload，避免把整段会话元数据写进状态图。',
        ],
      },
      {
        anchor: 'const result = await runtime.runner.run({',
        lines: [
          'runner 负责真正的子会话生命周期，本层只提供节点、提示词与追踪上下文。',
          'prompt 优先用调用方注入的 buildPrompt，缺省时回落到模板构造。',
          '[资源] abortSignal 一路透传，取消会中断子会话而不是等它自然结束。',
          '返回的 model/sessionId/turnId 会写进完成态活动，供界面与遥测关联。',
        ],
      },
      {
        anchor: 'const artifact = await runtime.writeArtifact(',
        lines: [
          '产物目录默认 artifacts/exec，可由调用方按阶段覆盖。',
          '[失败路径] 写盘失败会抛进 catch，节点按重试口径回 pending 或 failed。',
          '返回的 relativePath 是快照里唯一允许持久化的产物标识。',
          '完成态活动同时登记输入与输出产物，形成可追溯的边。',
        ],
      },
      {
        anchor: '} catch (error) {',
        lines: [
          '[失败路径] 这里承担全部「非取消」失败的结算：累加 attempts、写快照、发 node_failed。',
          '取消检查必须放在累加之前，保证中止不计入重试次数。',
          'failed 是终态但仍解锁下游依赖，整图完成判定由调度器另行处理。',
          '失败活动沿用启动时记录的 sessionId/model/traceId，便于跨层归因。',
        ],
      },
    ],
  },
  {
    file: 'packages/desktop/src/main/browserView/browserScreenshotCapture.ts',
    first: 'import type { ControlledView } from "./browserCommandTypes.js";',
    target: 50,
    header: [
      '// INV-01 首帧截图在缺少归一化能力时必须原样返回：守住位置 第一个 early return；改错故障 宿主无降采样能力时反而丢帧。',
      '// INV-02 只有目标尺寸解析成功且首帧为等比缩放时才进入校正：守住位置 expected 与 firstDimensions 两个判断；改错故障 非等比截图被强行拉伸。',
      '// INV-03 已高于目标的等比首帧走宿主降采样，不再二次抓图：守住位置 尺寸比较分支；改错故障 重抓引入文字细节丢失。',
      '// INV-04 校正倍率必须大于原倍率且差异超过容差才重抓：守住位置 correctedScale 判断；改错故障 无意义重抓让截图耗时翻倍。',
      '// INV-05 重抓最多一次，异常一律回落首帧：守住位置 try/catch 包裹的第二次抓图；改错故障 协议抖动导致截图直接失败。',
      '// INV-06 重抓结果必须重新校验 PNG 尺寸与等比性：守住位置 correctedDimensions 后的两个判断；改错故障 返回被裁剪的残帧。',
      '// INV-07 校正帧仍高于目标时先降采样再比较：守住位置 resize 分支；改错故障 高分辨率帧被直接丢弃。',
      '// INV-08 最终兜底在首帧与校正帧之间取信息量更高者：守住位置 末尾选择函数；改错故障 质量回退到更低的一帧。',
      '// INV-09 PNG 尺寸只解析前 64 字节，不整图解码：守住位置 readPngDimensions 的 slice；改错故障 大图截图让主进程内存飙升。',
      '// INV-10 长度、签名、块类型任一不符即视为未知尺寸：守住位置 头部校验；改错故障 把非 PNG 数据当图片读。',
      '// INV-11 质量倍率上限 2、下限 1.25，且受 4096 边与 16M 像素约束：守住位置 resolveScreenshotQualityScale；改错故障 生成超大栅格触发图形上限。',
      '// INV-12 目标尺寸由当次 clip 的 CSS 值四舍五入，不假设固定像素比：守住位置 readScreenshotTarget 的 target 构造；改错故障 高分屏与普通屏表现不一致。',
      '// INV-13 clip 缺字段或非有限正数时不校正：守住位置 readScreenshotTarget 校验链；改错故障 非法倍率被送进协议层。',
      '// INV-14 降采样结果必须与目标尺寸误差小于 1px 才采纳：守住位置 resizeScreenshotToTarget 判断；改错故障 返回尺寸不符的图给上层断言。',
      '// INV-15 信息量比较先比像素数，再比与首帧的尺寸距离：守住位置 chooseHigherInformationScreenshot；改错故障 选到更模糊的一帧。',
      '// INV-16 所有降采样与重抓失败都回落到首帧，而不是抛错：守住位置 各 return first 分支；改错故障 截图能力退化为整体失败。',
      '// INV-17 归一化能力缺失时不进入校正链：守住位置 第二个 early return；改错故障 旧宿主上出现未定义行为。',
      '// INV-18 第二次抓图复用原参数的全部字段，只覆盖 scale：守住位置 clip 展开；改错故障 丢失 clip 之外的质量参数。',
      '//',
      '// 模块职责：对协议层截图做 CSS 像素校正，保证返回的栅格与调用方 clip 的 CSS 尺寸一致且信息量最大。',
      '// 状态所有权：本模块不持有状态，所有判据都来自本次调用的参数与首帧/校正帧的文件头。',
      '// 阅读顺序：先看主链，再回读尺寸解析、等比判定、质量倍率与降采样四个辅助函数。',
    ],
    blocks: [
      {
        anchor: 'const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;',
        lines: [
          '这些常量把「一次截图最多做多少额外工作」固定下来，避免参数化带来跨平台差异。',
          '质量倍率上限 2 用于高分屏；下限 1.25 表示收益太小的重抓直接放弃。',
          '4096 是多数图形栈的单边纹理上限，16M 像素约等于 4096 见方，两者共同兜底显存。',
          '尺寸容差 1px 吸收取整误差；倍率容差 0.001 吸收浮点除法误差。',
          '[权衡] 常量而非配置：截图是高频路径，读配置会引入额外 IO 与缓存一致性负担。',
        ],
      },
      {
        anchor: 'function readPngDimensions(data: string): ScreenshotDimensions | null {',
        lines: [
          '[资源] 只解 base64 前 64 字节，够覆盖 8 字节签名与块头。',
          '返回 null 表示「不是可识别的 PNG」，调用方据此放弃校正而不是抛错。',
          '宽高任一为 0 视为非法尺寸，避免后续除法出现无穷大。',
          '内部捕获兜住解码异常，保证这条路径永不向上抛。',
        ],
      },
      {
        anchor: 'function resolveScreenshotQualityScale(target: ScreenshotDimensions): number {',
        lines: [
          '综合三个上限取最小值：边上限、像素总量上限、固定倍率上限。',
          '目标本身很小时倍率可能被算成极大值，因此必须有固定上限夹住。',
          '[权衡] 低于下限时返回 1：多抓一次大图再降采样的收益抵不过延迟。',
          '有限性检查兜住目标为 0 时的除法结果，防止非法值流入协议层。',
        ],
      },
      {
        anchor: 'async function resizeScreenshotToTarget(',
        lines: [
          '宿主未提供降采样能力时返回 null，调用方沿用原始帧。',
          '[失败路径] 降采样抛错或返回空数据都不影响主链，只是放弃这次优化。',
          '结果必须重新解析文件头，确认尺寸真的落到目标上而不是近似值。',
          '只有尺寸精确匹配才替换数据，其余情况返回 null 让调用方保留首帧。',
        ],
      },
      {
        anchor: 'function chooseHigherInformationScreenshot(',
        lines: [
          '像素数更多意味着细节更多，这是首要比拼维度。',
          '像素数相同时比较与首帧的尺寸距离，距离更近说明缩放更少、重采样损失更小。',
          '两个候选都来自同一 clip，因此不需要再校验等比性。',
          '返回的一定是入参之一，不会新建对象，避免调用方误判数据来源。',
        ],
      },
      {
        anchor: 'function readScreenshotTarget(params: Record<string, unknown>): {',
        lines: [
          'clip 必须是普通对象，数组与空值都视为未提供。',
          '三个字段都要是有限正数，缺一即放弃校正，走原样返回。',
          '栅格只有整数像素，CSS 侧的亚像素尺寸在这里取整并以 1 为下限。',
          '返回的倍率保留原始值，后续计算以它为基线。',
        ],
      },
      {
        anchor: 'export async function captureScreenshotWithCssPixelCorrection(',
        lines: [
          '主链：抓首帧 → 解析目标 → 判等比 → 高帧降采样或小幅重抓 → 择优返回。',
          '[时序] attach 初期首帧可能只是低清栅格，因此尺寸匹配并不能证明细节完整。',
          '所有分支都以「返回一帧」为终点，宁可质量略低也不让截图失败。',
        ],
      },
    ],
  },
  {
    file: 'packages/desktop/tsup.config.ts',
    first: 'import { readFileSync, existsSync } from "node:fs";',
    target: 52,
    header: [
      '// INV-01 构建脚本必须动态加载，不能静态引入：守住位置 三处 await import；改错故障 tsup 打包配置时目录定位被重写，脚本路径解析到 desktop。',
      '// INV-02 .env 加载顺序固定 基础→环境→本地：守住位置 loadEnvFiles 的文件数组；改错故障 本地值被基础值覆盖，联调环境串味。',
      '// INV-03 真实环境变量优先级高于 .env 文件：守住位置 loadEnvFiles 末尾覆盖段；改错故障 CI 注入的地址被仓库文件顶掉。',
      '// INV-04 安装包身份与后端环境是两个轴：守住位置 产品形态解析；改错故障 Preview 身份与生产后端互相覆盖。',
      '// INV-05 CDN 前缀数量必须是 1 或与域名数相等：守住位置 resolveBuildRemoteCdnReleaseRoots 的校验；改错故障 多域名配单前缀时部分域名拼出错误地址。',
      '// INV-06 打包 Agent 遥测在发布构建中必须成对配置：守住位置 端点与头部的联合校验；改错故障 只配一半时产物静默丢遥测。',
      '// INV-07 遥测端点必须是 HTTP 或 HTTPS，生产强制 HTTPS：守住位置 协议校验；改错故障 明文上报被代理拦截。',
      '// INV-08 头部禁止换行且长度受限：守住位置 正则与长度判断；改错故障 注入式内容破坏上报请求。',
      '// INV-09 生产构建默认压缩并保留函数名，覆盖率构建例外：守住位置 resolveDesktopTsupBundleSecurityOptions；改错故障 覆盖率范围无法还原到源码。',
      '// INV-10 映射文件只在覆盖率构建或非生产构建开启：守住位置 sourcemap 表达式；改错故障 发布包带无效映射路径并暴露内部结构。',
      '// INV-11 产物法务注释一律置 none：守住位置 applyDesktopTsupEsbuildSecurityOptions；改错故障 产物残留许可注释与源码片段。',
      '// INV-12 main/host/scheduler 的分块名必须按目标分目录：守住位置 三处 esbuildOptions；改错故障 并发构建互相覆盖分块，出现缺少命名导出。',
      '// INV-13 Node 内建协议前缀不得剥离：守住位置 removeNodeProtocol 置 false；改错故障 内置 sqlite 被解析成第三方包。',
      '// INV-14 有原生依赖或动态加载的包必须留在 external：守住位置 desktopNodeRuntimeExternals；改错故障 产物运行时报动态加载不支持。',
      '// INV-15 workspace 源码包必须内联：守住位置 main/host/scheduler 的 noExternal；改错故障 安装包启动即找不到模块。',
      '// INV-16 沙箱别名产物不能落在 renderer 输出目录：守住位置 plugin-sandbox-alias 的 outDir；改错故障 renderer 构建清空目录时被删。',
      '// INV-17 每个子构建各自写就绪标记：守住位置 createDevReadyMarkerHook；改错故障 dev 脚本在构建未完成时启动 Electron。',
      '// INV-18 常量注入必须区分共享与 main 专属：守住位置 createSharedDefines 与 createMainDefines；改错故障 敏感遥测配置被打进 preload/host。',
      '//',
      '// 模块职责：声明 Desktop 各进程的构建目标，并把环境、版本、遥测与 CDN 信息编译成构建期常量。',
      '// 状态所有权：本文件在配置加载期完成一次解析，产出的常量与安全选项对所有子构建只读。',
      '// 阅读顺序：先读环境与身份解析，再读遥测/CDN 注入，最后看五个子构建配置的差异。',
    ],
    blocks: [
      {
        anchor: 'const { copyGenUiRuntimeAssets } = await import(',
        lines: [
          '[时序] 配置在打包前被 Node 直接加载，此时还不能依赖打包后的相对路径。',
          '用文件 URL 加目录解析动态加载，保证脚本位置固定。',
          '下面两处同样动态加载共享目录下的构建配置，避免跨包相对导入被重写。',
          '[权衡] 动态加载会带来一次额外模块解析，但换来路径语义稳定，值得。',
          '该模块只在沙箱别名的成功回调里使用，不参与代码打包。',
          '顶层 await 要求配置以 ESM 加载，包的 type 字段已声明为 module。',
        ],
      },
      {
        anchor: 'const buildTimeConfigDefines = createBuildTimeConfigDefines(',
        lines: [
          '构建期可选能力（上报、事件、自动更新）在这里一次性求值。',
          '结果以常量注入，运行时代码只看到布尔值，不感知构建分支。',
          '[权衡] 关掉的能力会被打包器静态剔除，因此不能依赖运行时再打开。',
          '读取的是进程环境，与下面 .env 文件的加载结果互不影响。',
        ],
      },
      {
        anchor: 'function loadEnvFiles(): Record<string, string> {',
        lines: [
          '顺序即优先级：基础文件先读，环境文件后读覆盖同名键。',
          '生产只叠加生产文件；开发叠加开发与本地两份。',
          '只解析键值对形式，注释与空行自然跳过。',
          '文件不存在不是错误，构建允许在没有 .env 的机器上完成。',
        ],
      },
      {
        anchor: 'export function resolveBuildRemoteCdnReleaseRoots(runtimeEnv: Record<string, string | undefined>) {',
        lines: [
          '域名支持逗号分隔多值，路径前缀支持单值或等长多值。',
          '单值时所有域名共用同一前缀；多值时必须与域名数量严格对齐。',
          '前缀末尾斜杠会被裁掉，保证拼出的地址不出现双斜杠。',
          '未配置域名时返回空数组，运行时保留旧默认根地址。',
        ],
      },
      {
        anchor: 'export function resolveBuildPackagedAgentTelemetryEnv(',
        lines: [
          '发布构建缺配置直接失败，避免静默产出无遥测的安装包。',
          '非发布构建缺配置返回空对象，产物不带遥测常量。',
          '端点与头部必须同配，单独给一半视为配置错误。',
          '端点解析后还要校验协议、是否含凭据，以及生产是否走 HTTPS。',
        ],
      },
      {
        anchor: 'export function resolveDesktopTsupBundleSecurityOptions(',
        lines: [
          '生产压缩与函数名保留只在非覆盖率构建开启。',
          '覆盖率构建需要保留可读产物与映射文件，才能把覆盖率映射回源码。',
          '[权衡] 压缩影响栈可读性，但发布包更需要缩小体积并降低逆向收益。',
          '返回值直接展开到各子构建配置里，保证五个目标口径一致。',
        ],
      },
      {
        anchor: 'function createSharedDefines() {',
        lines: [
          '版本、兼容版本、提交号、构建时间以序列化字符串形式注入，运行期作为字符串常量。',
          '环境与产品身份来自上面解析的结果，构建期固化，运行时不再回读环境变量。',
          'Computer Use Helper 构建标识由 CI 注入，开发态为空串时走本地兜底。',
          'CDN 发布根在构建期算好，避免运行时代码里再出现硬编码域名。',
        ],
      },
    ],
  },
  {
    file: 'apps/dev-docs/src/capability-map/CapabilityMapFlowElements.tsx',
    first: 'import { memo, type CSSProperties } from "react";',
    target: 50,
    header: [
      '// INV-01 节点类型注册表的键必须与节点字面量完全一致：守住位置 capabilityMapNodeTypes；改错故障 画布遇到未知类型节点整块不渲染。',
      '// INV-02 边类型注册表的键必须与连线字面量一致：守住位置 capabilityMapEdgeTypes；改错故障 所有连线退化成默认样式。',
      '// INV-03 三个节点视图都必须 memo 包裹后再注册：守住位置 三个 memo 赋值；改错故障 每次筛选重建数组时全量重渲染。',
      '// INV-04 dimmed 只改透明度，不卸载节点：守住位置 各视图类名拼接；改错故障 父子尺寸关系断裂，命中区域错位。',
      '// INV-05 系统框与群框头部高度必须取自几何常量：守住位置 两个头部样式常量；改错故障 布局计算与实际渲染高度不一致，连线错位。',
      '// INV-06 群复杂度缺失时抛错，不静默降级：守住位置 群复杂度查询调用；改错故障 徽标显示 0 掩盖数据不一致。',
      '// INV-07 节点卡片尺寸由布局层决定，视图不再设置宽高：守住位置 h-full/w-full 类名；改错故障 与布局引擎结果打架。',
      '// INV-08 每个能力节点必须有左侧入、右侧出两个锚点：守住位置 两个 Handle；改错故障 连线找不到锚点。',
      '// INV-09 边框状态优先级 selected 高于 searchMatch 高于 hover：守住位置 类名三目链；改错故障 搜索结果被悬浮态遮掉。',
      '// INV-10 连线优先用布局给出的正交路径，缺路由时回落贝塞尔：守住位置 path 三目；改错故障 布局未就绪时连线整段消失。',
      '// INV-11 正交路径必须做圆角倒角，半径固定 10px：守住位置 roundedOrthogonalPath；改错故障 直角折线视觉生硬且与设计稿不符。',
      '// INV-12 折线不足两点或出现空洞时返回退化路径而非非法坐标：守住位置 索引判空；改错故障 路径出现非数值导致整条边不渲染。',
      '// INV-13 标签位置优先用布局给出的 labelPosition：守住位置 标签坐标三目；改错故障 标签漂移到线段中点。',
      '// INV-14 标签必须显式声明层级：守住位置 标签层内 span 的 z-10；改错故障 标签被相邻节点盖住。',
      '// INV-15 关系类型缺省为 state，仅在数据缺失时生效：守住位置 空值兜底；改错故障 异常数据渲染成无样式连线。',
      '// INV-16 群内连线判定按两端节点的群标识相等：守住位置 intraGroup 计算；改错故障 群内短连线被当成跨群高亮。',
      '// INV-17 连线箭头由画布注入，视图不得覆盖：守住位置 基础边组件传参；改错故障 箭头样式失效。',
      '// INV-18 视图组件保持纯展示，不读写全局状态：守住位置 三个节点视图与连线视图；改错故障 筛选与渲染耦合，出现循环更新。',
      '//',
      '// 模块职责：把能力地图的节点与连线数据渲染成画布可用的视图组件与类型注册表。',
      '// 状态所有权：选中、搜索、压暗状态都由上游数据传入，本模块只读。',
      '// 阅读顺序：先看三个节点视图与注册表，再看折线几何辅助函数，最后看连线视图与标签。',
    ],
    blocks: [
      {
        anchor: 'const capabilitySystemHeaderStyle = {',
        lines: [
          '头部高度直接取布局常量，保证画布坐标系与盒模型一致。',
          '用 satisfies 而非断言：保留字面量类型推断，同时接受样式类型约束。',
          '两个头部样式都是模块级常量，避免每次渲染新建对象导致 memo 失效。',
          '样式对象只承载高度，其余视觉走类名，便于主题切换。',
          '[权衡] 不抽公共 hook：只有两个消费者，抽象成本高于收益。',
        ],
      },
      {
        anchor: 'function CapabilitySystemFlowNodeView({',
        lines: [
          '系统框是最外层容器，尺寸完全由画布父节点决定。',
          '虚线大框加半透明底表达「区域」而非「可点击实体」。',
          '筛选压暗时降低不透明度但不卸载，保持子节点测量结果稳定。',
          '头部展示系统名与描述，描述限宽避免长文本撑破框体。',
        ],
      },
      {
        anchor: 'function CapabilityGroupFlowNodeView({',
        lines: [
          '群框是系统框的子节点，选中时用品牌色边框强调当前群。',
          '复杂度徽标同时给出主责代码估算与跨群入出度，三者拼在一行等宽文本。',
          '[失败路径] 复杂度查不到直接抛错：数据不一致必须暴露，不能渲染成 0。',
          '徽标文本同时写进无障碍标签与悬浮提示，保证读屏与视觉一致。',
          '悬浮只改边框与底色，不改变布局尺寸，避免画布抖动。',
        ],
      },
      {
        anchor: 'function CapabilityItemFlowNodeView({',
        lines: [
          '叶子节点固定尺寸由布局层给出，这里只负责在框内排版两行文本。',
          '锚点必须显式声明标识与方向，连线的两端引用与之对应。',
          '边框状态按选中、搜索命中、悬浮顺序短路，越靠前优先级越高。',
          '压暗与选中态可以叠加，透明度不影响点击命中。',
        ],
      },
      {
        anchor: 'function moveToward(',
        lines: [
          '以起点为原点按比例插值，比值由目标距离除以线段长度得到。',
          '线段长度为 0 或短于目标距离时直接返回终点，避免除零与越界。',
          '只用于倒角切点计算，不做取整，保持与原始坐标同精度。',
          '返回新对象而不修改入参，保证调用方可安全复用折线点。',
        ],
      },
      {
        anchor: 'function roundedOrthogonalPath(points: { x: number; y: number }[]) {',
        lines: [
          '首点直接写入起点指令，中间点用二次贝塞尔倒角，末点补直线收尾。',
          '每个拐点向相邻两点各退回 10px，形成对称的圆角过渡。',
          '越界点跳过而不是插值，保证退化输入也能产出合法路径。',
        ],
      },
      {
        anchor: 'function CapabilityMapEdge({',
        lines: [
          '先算贝塞尔兜底，再在路由存在时改用正交路径与标签坐标。',
          '样式类名按关系类型、高亮、压暗、群内四个维度拼接，全部可选。',
          '标签只在开关为真时渲染，避免密集小图上文字互相遮挡。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/browser-use/useResponsiveBrowserViewportControl.ts',
    first: 'import { useCallback, useEffect, useRef, useState } from "react";',
    target: 49,
    header: [
      '// INV-01 ref 与 state 必须成对维护，ref 只供事件回调读取最新值：守住位置 三组 ref/state；改错故障 回调闭包读到过期状态，模式切换丢一次。',
      '// INV-02 进入响应式模式时把缩放重置为默认值：守住位置 applyResponsiveMode 的假转真判断；改错故障 用户刚选的固定缩放被覆盖。',
      '// INV-03 只有假转真才重置缩放，真转真不重置：守住位置 新值与 ref 的联合判断；改错故障 模型下发的尺寸同步把人工缩放冲掉。',
      '// INV-04 视口同步必须等主进程指标完成后再回调：守住位置 updateControlledViewport 的成功回调；改错故障 提前设置的缩放被页面缩放异步传播改回。',
      '// INV-05 同步失败只记调试日志，不抛给界面：守住位置 catch 分支；改错故障 一次视口失败变成全局错误提示。',
      '// INV-06 模型变更的视口事件要按标签页与会话双重过滤：守住位置 事件回调前两行；改错故障 其他标签页的尺寸串到当前浏览器。',
      '// INV-07 模型给出视口即进入响应式，给出空值即退出：守住位置 事件回调收尾分支；改错故障 人工模式与模型模式互相拉扯。',
      '// INV-08 模式变更提示必须按「变更后是否与当前模式不同」计算：守住位置 回调内的布尔表达式；改错故障 重排弱提示误报。',
      '// INV-09 人工偏好上报必须读 ref 而非 state：守住位置 reportHumanViewportPreference 的取值；改错故障 上报滞后一帧，丢失最后一次操作。',
      '// INV-10 未提供初始偏好或未注入回调时不上报：守住位置 上报函数首行判断；改错故障 只读场景也产生写请求。',
      '// INV-11 切换模式前先触发一次重排通知：守住位置 toggleResponsiveMode 首行；改错故障 容器已变但宿主未重排，出现空白条。',
      '// INV-12 切换模式时立即同步宿主视口，退出时传空值：守住位置 toggleResponsiveMode 内的同步调用；改错故障 退出响应式后仍保留旧尺寸。',
      '// INV-13 页面缩放变化只在响应式模式内重发同一视口：守住位置 第一个副作用的三项前置条件；改错故障 普通模式下产生多余的宿主调用。',
      '// INV-14 初始人类视口同步只允许执行一次：守住位置 已同步标记；改错故障 每次重渲染都重设尺寸，用户无法手动调整。',
      '// INV-15 尺寸更新必须同时写 ref、state 与宿主：守住位置 updateResponsiveViewportSize 三行；改错故障 三者不一致，切换模式后尺寸回跳。',
      '// INV-16 缩放更新只写 ref/state 并上报，不调用宿主：守住位置 updateResponsiveViewportZoom；改错故障 每次缩放都触发一次昂贵的视口重设。',
      '// INV-17 平台能力缺失时所有调用必须安全降级：守住位置 可选调用与空值判断；改错故障 Web 端渲染直接抛错。',
      '// INV-18 订阅必须返回清理函数：守住位置 第二个副作用的返回；改错故障 卸载后回调仍持有旧状态，产生内存泄漏。',
      '//',
      '// 模块职责：管理嵌入式浏览器的响应式视口状态，并把它与宿主视口、模型事件、人类偏好三路同步。',
      '// 状态所有权：模式、尺寸、缩放由本 hook 持有；宿主视口由主进程持有，本 hook 只发请求。',
      '// 阅读顺序：先看参数与初始值，再看三组 ref/state，然后读上报、模式切换、宿主同步，最后看两个副作用与初始化同步。',
    ],
    blocks: [
      {
        anchor: 'export function useResponsiveBrowserViewportControl({',
        lines: [
          '入参分三类：浏览器标识、宿主缩放、三类回调。',
          '浏览器标识决定操作哪个标签页，同时用于过滤该标签页的视口事件。',
          '宿主缩放只用于感知页面缩放变化，不参与尺寸计算。',
          '初始偏好决定首帧模式与尺寸，未提供时默认普通模式与默认尺寸。',
          '[权衡] 偏好通过回调外抛而不在本 hook 持久化，存储责任留给调用方。',
        ],
      },
      {
        anchor: 'const reportHumanViewportPreference = useCallback(',
        lines: [
          '只有同时具备初始偏好与上报回调时才上报，避免只读宿主产生写请求。',
          '取值一律读 ref：回调可能来自原生事件，闭包里的 state 已经过期。',
          '视口复制一份再上报，防止调用方持有内部引用后修改。',
          '来源区分模式、尺寸、缩放三种，便于上层做差异化落盘。',
        ],
      },
      {
        anchor: 'const applyResponsiveMode = useCallback((nextMode: boolean) => {',
        lines: [
          '只在假转真时把缩放重置为默认值。',
          '真转真不重置，保证模型反复下发尺寸时人工缩放不被清掉。',
          'ref 与 state 同时写，先写 ref 让同一事件循环内的后续读取立即生效。',
          '该函数不触发宿主同步，调用方负责按场景决定是否再调同步。',
        ],
      },
      {
        anchor: 'const updateControlledViewport = useCallback(',
        lines: [
          '平台不提供该方法时直接返回，Web 端与旧宿主共用同一实现。',
          '传空值表示退出响应式，恢复普通浏览器视口。',
          '[时序] 只有视口非空时才在成功后通知上层，退出路径无需重排。',
          '失败只记调试日志：视口同步是尽力而为，不应打断用户操作。',
        ],
      },
      {
        anchor: 'useEffect(() => {',
        nth: 1,
        lines: [
          '只在响应式模式持续期间响应页面缩放变化。',
          '三个条件任一不满足即跳过：非响应式、首次进入、缩放未变。',
          'Electron 的页面缩放传播可能晚于本副作用，因此重发同一尺寸让主进程再归一一次。',
          'ref 记录上一帧的缩放与模式，副作用本身不依赖它们，避免额外重渲染。',
        ],
      },
      {
        anchor: 'useEffect(() => {',
        nth: 2,
        lines: [
          '订阅宿主侧的视口变更，来源是模型工具调用而非人类操作。',
          '先按标签页过滤，再按会话过滤，避免多会话共享标签页时串台。',
          '卸载时由返回的清理函数退订，防止回调持有过期状态。',
        ],
      },
      {
        anchor: 'const synchronizeInitialHumanViewport = useCallback(() => {',
        lines: [
          '仅当初始偏好是响应式且尚未同步过时执行一次。',
          '标记先置位再同步，防止并发调用重复下发。',
          '提供给调用方在浏览器挂载完成后主动调用，而不是在挂载时自动执行。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/lib/sessionOpenArmsTelemetry.ts',
    first: 'import type { ArmsCustomEventPayload } from "@zcode/shared";',
    target: 49,
    header: [
      '// INV-01 事件名与事件组是常量，禁止调用方自带：守住位置 三个导出常量；改错故障 报表按名称聚合时出现同义异名。',
      '// INV-02 上报端未注册时所有上报静默丢弃：守住位置 emit 首行判空；改错故障 测试环境或早期启动阶段抛错打断会话打开。',
      '// INV-03 上报必须发起即走，异常只记警告：守住位置 emit 的异步链与 catch；改错故障 遥测失败反噬主流程。',
      '// INV-04 测试专用清理函数与正式设置函数分离：守住位置 清理函数；改错故障 生产代码误调清理，遥测全程丢失。',
      '// INV-05 时间字段统一四舍五入为非负整数，非法值丢弃：守住位置 时间字段归一函数；改错故障 报表出现负数或浮点毫秒。',
      '// INV-06 计数类字段走非负整数校验，同样丢弃非法值：守住位置 六个计数字段；改错故障 负数计数污染均值。',
      '// INV-07 事件数值取总耗时的取整值，缺失时回 0：守住位置 载荷的数值字段；改错故障 事件数值为空被聚合端丢弃。',
      '// INV-08 身份字段固定五个，键名不可改：守住位置 身份属性构造；改错故障 看板按会话打开标识关联时断链。',
      '// INV-09 结果事件必须同时携带状态：守住位置 结果载荷构造；改错故障 无法区分成功、失败与超时。',
      '// INV-10 错误阶段与错误码只在失败时出现，其余留空：守住位置 属性对象赋值；改错故障 成功样本被错误标签污染。',
      '// INV-11 计时字段缺失时保留空值而不是 0：守住位置 各计时字段赋值；改错故障 缺失样本被当成 0ms 拉低均值。',
      '// INV-12 属性对象允许空值，由上报端决定裁剪：守住位置 属性对象类型；改错故障 强制补默认值掩盖采集缺口。',
      '// INV-13 开始与结果共用同一事件组，仅名称不同：守住位置 两个载荷构造；改错故障 两组事件无法按同一实验口径对齐。',
      '// INV-14 上报函数不得等待，调用方无需感知异步：守住位置 两个 report 入口；改错故障 会话打开路径被遥测阻塞。',
      '// INV-15 上报端可显式传入以覆盖全局实例：守住位置 emit 第二参数；改错故障 单测无法隔离全局状态。',
      '// INV-16 所有导出类型保持只读语义，调用方只构造不修改：守住位置 各 interface；改错故障 上报后字段被就地改写，事件内容不可复现。',
      '// INV-17 日志前缀固定为会话打开标记：守住位置 两处日志调用；改错故障 排障时无法按模块过滤。',
      '// INV-18 本模块不依赖 React 或浏览器 API：守住位置 仅引入 shared 与 logger；改错故障 无法在 host 侧复用同一套载荷构造。',
      '//',
      '// 模块职责：构造并上报「会话打开」性能埋点的开始与结果两类事件。',
      '// 状态所有权：全局上报端是唯一可变状态，其余全部是纯函数与常量。',
      '// 阅读顺序：先看常量与类型，再看上报端生命周期与发送函数，最后看两个载荷构造与两个上报入口。',
    ],
    blocks: [
      {
        anchor: 'export const SESSION_OPEN_ARMS_GROUP = "ui_perf";',
        lines: [
          '组名固定为 ui_perf，与前端性能看板的既有分组保持一致。',
          '开始事件只证明「发起了一次打开尝试」，不带耗时；结果事件才承载完整分解。',
          '两个事件用同一会话打开标识关联，构成一次完整打开的两端。',
          '事件名是报表维度，改动等同破坏历史数据可比性。',
          '[权衡] 不在这里做采样：采样策略由上报端统一控制，避免双处限流。',
        ],
      },
      {
        anchor: 'let reporter: SessionOpenArmsReporter | null = null;',
        lines: [
          '全局单例由宿主在启动时注入，避免本模块直接依赖具体上报实现。',
          '保持可空：测试与早期启动阶段允许没有上报端。',
          '设置函数接受空值，用于显式关闭上报。',
          '测试清理函数与设置函数分开命名，防止生产代码误用。',
        ],
      },
      {
        anchor: 'function emit(',
        lines: [
          '没有上报端时直接返回，调用方无需判断。',
          '先包一层已完成承诺再挂异常处理，兼容同步抛错与异步拒绝两种实现。',
          '异常只记警告，绝不向上抛：埋点不能影响会话打开。',
          '默认参数取全局上报端，显式传入时优先，便于单测隔离。',
        ],
      },
      {
        anchor: 'function identityProperties(identity: SessionOpenIdentity): Record<string, string> {',
        lines: [
          '五个身份字段是所有事件的最小关联键，顺序与命名都固定。',
          '全部转成字符串：属性值类型混用会让看板分组出现重复桶。',
          '每次返回新对象，防止调用方修改后影响后续事件。',
          '不含任何可能为空的字段，保证关联键始终可用。',
        ],
      },
      {
        anchor: 'export function buildSessionOpenResultArmsPayload(',
        lines: [
          '身份字段先展开，再逐项追加结果与计时字段。',
          '计时字段统一做四舍五入，非法值落成空值而不是 0。',
          '计数字段走整数校验，负数与非有限值同样丢弃。',
          '事件数值取总耗时的取整值，缺失时回 0 保证聚合端可入桶。',
        ],
      },
      {
        anchor: 'export function reportSessionOpenStart(',
        lines: [
          '构造与上报分离：调用方可以只取载荷做断言。',
          '第二参数允许覆盖上报端，用于测试与特殊链路。',
          '本函数同步返回，不暴露异步细节。',
        ],
      },
      {
        anchor: 'function roundedNonNegative(value: number | undefined): number | undefined {',
        lines: [
          '非数字、非有限、负数一律视为缺失。',
          '缺失返回空值，让上报端自行裁剪，而不是补 0。',
          '与计数用的整数函数逻辑相同但语义不同，故保留两个名字。',
        ],
      },
    ],
  },
];

let index = 0;
for (const spec of specs) {
  const items = [{ anchor: spec.first, raw: spec.header }];
  for (const block of spec.blocks) {
    const item = { anchor: block.anchor, lines: block.lines };
    if (block.nth) item.nth = block.nth;
    items.push(item);
  }
  const total = spec.header.length + spec.blocks.reduce((sum, b) => sum + b.lines.length, 0);
  const bodyTotal = spec.blocks.reduce((sum, b) => sum + b.lines.length, 0);
  console.log(`${spec.file} header=${spec.header.length} body=${bodyTotal} total=${total} expect=${spec.target} ${total === spec.target ? 'OK' : 'MISMATCH'}`);
  fs.writeFileSync(
    `ZC-deep-b102-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  index += 1;
}
