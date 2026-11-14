import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/v4/composer/toolbarShortcuts.ts',
    target: 33,
    firstNth: 1,
    header: [
      '// INV-01 只处理工具条三条命令：守住位置 candidates 表；改错故障 抢占其他区域的快捷键。',
      '// INV-02 修饰键精确匹配：守住位置 matchesShortcutBinding；改错故障 Ctrl+M 也命中 Ctrl+Shift+M。',
      '// INV-03 任一前置条件不满足即整体退出：守住位置 开头早退；改错故障 禁用态仍能打开模型菜单。',
      '// INV-04 defaultPrevented 与 repeat 必须尊重：守住位置 早退判断；改错故障 与上层监听重复触发。',
      '// INV-05 输入法组合态不响应：守住位置 isComposing；改错故障 中文输入中按 m 就开菜单。',
      '// INV-06 选项归属必须与命令一致：守住位置 getChatToolbarShortcutKey 比对；改错故障 用模型选项去切思考深度。',
      '// INV-07 同一命令可绑多个键位：守住位置 内层绑定循环；改错故障 只认第一个绑定。',
      '// INV-08 候选顺序即优先级：守住位置 candidates 数组顺序；改错故障 键位重叠时行为随机。',
      '// INV-09 录制态键盘归录制器独占：守住位置 isShortcutRecordingActive 早退；改错故障 改键时按键真的触发了动作。',
      '// INV-10 生效表通过 ref 读取：守住位置 effectiveRef；改错故障 改绑后必须重建监听才生效。',
      '// INV-11 监听挂在 capture 阶段并成对移除：守住位置 addEventListener 第三参；改错故障 监听泄漏或抢在录制器之前。',
      '// INV-12 诊断日志只在确实绑定了该命令时打：守住位置 openModelMenuBound；改错故障 改绑后按旧键刷日志。',
      '// INV-13 命中后必须 preventDefault：守住位置 动作分发之前；改错故障 浏览器默认行为与工具条动作叠加。',
      '//',
      '// 模块职责：V4 composer 工具条热键的动作解析与 window 级监听装配。',
      '// 阅读顺序：先看纯函数解析的三层过滤，再看 hook 的监听与诊断日志。',
    ],
    blocks: [
      {
        anchor: 'export function getNextConfigSelectValue(',
        lines: [
          '只有 select 且有选项才可循环，其余类型返回 null。',
          '当前值不在选项里时从第一项开始，而不是报错。',
          '取不到下一项时返回 null，调用方据此跳过本次切换。',
        ],
      },
      {
        anchor: '!hasAnyOption ||',
        lines: [
          '没有可选项时整条链路无意义，直接退出。',
          '组合键的修饰键由 matcher 精确比较，这里不重复判定。',
          '正在输入法与长按重复都不响应。',
        ],
      },
      {
        anchor: 'const candidates: ReadonlyArray<{',
        lines: [
          '顺序即优先级：模型菜单先于模式，模式先于思考深度。',
          '每个候选同时绑定命令 id 与旧的热键归属键，便于迁移期对齐。',
          'disabled 只对模型菜单生效，其余两个由 toolbarDisabled 统一管。',
          'expectedKey 必须与 getChatToolbarShortcutKey 的返回值一致。',
        ],
      },
      {
        anchor: 'if (candidate.disabled) {',
        lines: [
          '禁用项直接跳过，不参与后续匹配。',
        ],
      },
      {
        anchor: 'const effectiveBindings = useEffectiveShortcutBindings();',
        lines: [
          '生效表可能随设置页改绑变化，必须每次渲染同步到 ref。',
          '监听只注册一次，匹配时读 ref 里的最新表。',
        ],
      },
      {
        anchor: 'if (isShortcutRecordingActive()) {',
        lines: [
          '录制态下按键只用于采集，绝不能触发真实动作。',
          '这个判断必须早于任何匹配，包括诊断日志分支。',
        ],
      },
      {
        anchor: 'event.preventDefault();',
        lines: [
          '命中才阻止默认行为，未命中保持浏览器原有处理。',
          '顺序是先阻止再分发，避免回调里再操作事件。',
        ],
      },
    ],
  },
  {
    file: 'packages/web/src/web-remote-control/contracts/transport.ts',
    target: 30,
    header: [
      '// INV-01 状态集合与运行态一一对应：守住位置 WebRemoteControlTerminalTransportState；改错故障 新增状态后诊断类型不全、漏记现场。',
      '// INV-02 每类诊断都带定位要素：state、timestamp、visibilityState 与 online；改错故障 线上问题无法还原现场。',
      '// INV-03 hiddenDurationMs 只在有值时出现：守住位置 可选字段；改错故障 序列化出大量 null 噪声。',
      '// INV-04 输入侧字段全部可选：守住位置 DiagnosticInput；改错故障 构造诊断时必须伪造无关字段。',
      '// INV-05 socket-close 必带 code 与 wasPaired：守住位置 close 分支；改错故障 无法区分主动断开与配对后掉线。',
      '// INV-06 pair-status 只允许两种取值：守住位置 字面量联合；改错故障 UI 出现未知配对态。',
      '// INV-07 WebSocketCtor 可注入：守住位置 options；改错故障 单测无法模拟断线。',
      '// INV-08 时间参数全部可选：守住位置 各 IntervalMs；改错故障 生产与测试行为被迫一致。',
      '// INV-09 getToken 必须可中止：守住位置 signal 参数；改错故障 退出时挂起的鉴权无法取消。',
      '// INV-10 原始载荷回调返回布尔：守住位置 onRawTransportPayload；改错故障 上层无法声明已消费、消息被二次处理。',
      '// INV-11 状态变更只通过回调出站：守住位置 onStateChange；改错故障 外部直接读内部状态导致不同步。',
      '// INV-12 失败与错误分两条通道：守住位置 onFailure 与 onError；改错故障 协议失败被当成网络异常。',
      '// INV-13 重载页面由宿主提供：守住位置 reloadPage；改错故障 传输层直接操作 window。',
      '//',
      '// 模块职责：Web 远控终端传输层的状态、诊断事件与选项契约。',
      '// 阅读顺序：先看状态集合，再看诊断联合的五种形状，最后看选项接口。',
    ],
    blocks: [
      {
        anchor: 'export type WebRemoteControlTerminalTransportDiagnostic =',
        lines: [
          '诊断是排查断线问题的唯一现场来源，字段只增不减。',
          '五种形状按事件来源区分，不要合并成一个大可选对象。',
        ],
      },
      {
        anchor: 'type: "socket-close";',
        lines: [
          'close 码与 wasPaired 一起记录，才能区分主动断开与配对后掉线。',
          'wasClean 反映浏览器判定，不要用 code 反推。',
          '断线时的页面可见性直接决定是否属于后台回收。',
        ],
      },
      {
        anchor: 'type: "socket-error" | "recover-start" | "recover-scheduled";',
        lines: [
          '这三类没有额外业务字段，只带定位要素。',
          '不要把错误对象塞进来：诊断必须可安全序列化。',
        ],
      },
      {
        anchor: 'export type WebRemoteControlTerminalTransportDiagnosticInput = {',
        lines: [
          '输入侧全字段可选，由构造方按事件类型填必需的几项。',
          'previousState 只在状态迁移时提供。',
          '缺失字段由构造器补成类型要求的形状，而不是留 undefined。',
        ],
      },
      {
        anchor: 'export interface WebRemoteControlTerminalTransportOptions {',
        lines: [
          'relayWsUrl 与 deviceSid 是连接身份，不可为空。',
          '所有时间参数都有生产默认值，测试通过注入覆盖。',
          'onSendReady 用于区分同一 socket 复用与重连后的新 socket。',
          '回调全部由宿主实现，传输层不直接操作页面。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/adapters/src/model/runner-status.ts',
    target: 34,
    firstNth: 1,
    header: [
      '// INV-01 每次物理尝试必须有独立 requestId：守住位置 createAttemptStatusContext；改错故障 上游日志与 retry-after 诊断串请求。',
      '// INV-02 traceId 缺失时生成而不是留空：守住位置 createStatusContext；改错故障 请求无法关联追踪。',
      '// INV-03 请求侧与生效侧 reasoning 分离：守住位置 initialReasoningObservation；改错故障 把 provider 默认当成已生效。',
      '// INV-04 观测事件必须先于终态投递：守住位置 publishModelStatus 的调用顺序；改错故障 recorder 释放 span 后观测丢失。',
      '// INV-05 observations.take 是消费语义：守住位置 publishRequestObservations；改错故障 同一批观测被投递两次。',
      '// INV-06 队列与准入事件不经过票据：守住位置 admissionWaitPublishers；改错故障 治理器收到没有票据的伪事件。',
      '// INV-07 单 sink 失败不得影响其他 sink：守住位置 allSettled 与逐条 warn；改错故障 观测故障打断请求链路。',
      '// INV-08 failed 且有原始错误时改走 publishFailure：守住位置 三元投递；改错故障 治理器只拿到事件、拿不到异常对象。',
      '// INV-09 requestStatusSink 与 statusSink 同对象时只投一次：守住位置 身份比较；改错故障 重复消费导致状态翻倍。',
      '// INV-10 里程碑只发进程级 sink：守住位置 publishModelTelemetryMilestone；改错故障 纯观测事件污染会话事件流。',
      '// INV-11 observation 事件不重复写本地日志：守住位置 logStatusEvent 末尾分支；改错故障 一次请求两条同内容日志。',
      '// INV-12 maxRetries 用 0 表达无上限：守住位置 三元；改错故障 无上限被显示成 0 次重试。',
      '// INV-13 日志上下文与事件同源：守住位置 modelStatusLogContext；改错故障 日志里的 attempt 与实际不符。',
      '//',
      '// 模块职责：模型请求状态事件的构造、日志级别选择与多 sink 投递。',
      '// 阅读顺序：先看上下文构造与 attempt 派生，再看投递顺序与失败降级，最后看日志字段。',
    ],
    blocks: [
      {
        anchor: 'const metadata = input.request.metadata ?? {};',
        lines: [
          'traceContext 优先于 metadata，metadata 优先于随机生成。',
          'requestId 缺失时随机生成，保证每条事件都能定位。',
          '所有 stringMetadata 读取都是防御性的，不信任外部形状。',
        ],
      },
      {
        anchor: 'if (attempt <= 1) {',
        lines: [
          '首轮直接复用上下文，只有 retry 才需要新 requestId。',
          '浅拷贝其余字段，避免调用方误改首轮上下文。',
          '换 id 的理由是上游日志按物理请求聚合。',
        ],
      },
      {
        anchor: 'const explicit = hint?.explicit;',
        lines: [
          '能力默认 unknown，由 provider 回流后再确认。',
          '显式 disabled 可以直接确认生效值，其余保持 unknown。',
          '请求侧与生效侧分别赋值，不能互相兜底。',
          '预算 token 只在显式给出时写入，避免伪精确。',
        ],
      },
      {
        anchor: 'logStatusEvent(event, options.logger);',
        nth: 1,
        lines: [
          '先写日志再消费观测，保证本地日志早于 sink 结果。',
          '观测投递必须在这一步之后、sink 扇出之前完成。',
          'deliveries 是惰性函数数组，凑齐后统一并发执行。',
        ],
      },
      {
        anchor: 'const deliveries: Array<() => void | Promise<void>> = [];',
        lines: [
          '票据与请求级 sink 只收事件，不接收错误对象。',
          '两个 sink 相同时跳过重复投递。',
        ],
      },
      {
        anchor: 'const observations = store.take(event.requestId);',
        lines: [
          'take 即删除：同一批观测只能投递一次。',
          '没有 statusSink 时也要 take 掉，避免内存里长期滞留。',
          '单条观测失败只 warn，后续观测继续投递。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/bootstrap/src/app/workspace-hook-trust.ts',
    target: 32,
    firstNth: 1,
    header: [
      '// INV-01 无快照即无安全面：守住位置 首行早退；改错故障 无 hook 的工作区凭空建 coordinator。',
      '// INV-02 rollout 关闭保持旧 hard block 且不读 Trust 文件：守住位置 trustEnabled 分支；改错故障 关掉开关后既有信任仍生效。',
      '// INV-03 控制器创建需要三条件同时成立：守住位置 if 判断；改错故障 缺 host 时 requestReview 抛错而不是返回 unavailable。',
      '// INV-04 unavailable 原因码取决于开关而不是 wiring：守住位置 三元；改错故障 用户看到「未启用」但其实只是没接 host。',
      '// INV-05 Trust 读取 fail-closed：守住位置 loadWorkspaceHookTrustStore 的捕获；改错故障 损坏文件被当成全部信任。',
      '// INV-06 reloadTrust 必须重放 admission 状态：守住位置 activate 的 resume；改错故障 行内信任后 banner 仍显示旧 pending。',
      '// INV-07 pendingCount 为 0 也要发事件：守住位置 activate 约定；改错故障 banner 永远清不掉。',
      '// INV-08 读取不写配置：守住位置 全文件无写盘；改错故障 启动过程产生配置副作用。',
      '// INV-09 emit 失败只 warn：守住位置 捕获；改错故障 观测发射失败导致会话创建失败。',
      '// INV-10 coordinatorEpoch 每次装配唯一：守住位置 随机 UUID；改错故障 重载后旧 revision 仍被接受。',
      '// INV-11 admission 的 enabled 跟随 trustEnabled：守住位置 创建入参；改错故障 开关与准入状态不一致。',
      '// INV-12 每会话自己 load 一次 Trust：守住位置 装配时序；改错故障 多会话共享一份陈旧镜像。',
      '// INV-13 homeDir 仅测试注入：守住位置 条件展开；改错故障 生产把信任写到临时目录。',
      '//',
      '// 模块职责：为会话装配 Workspace Hook 的准入与审核安全面。',
      '// 阅读顺序：先看开关与 store 创建，再看控制器装配，最后看 reloadTrust 与 fail-closed 读取。',
    ],
    blocks: [
      {
        anchor: 'if (!input.snapshot) return undefined;',
        lines: [
          '没有快照就没有可审内容，直接不提供安全面。',
          '注意这不是禁用：返回 undefined 表示该工作区根本没有 hook 面。',
        ],
      },
      {
        anchor: 'const trustEnabled = input.workspaceHookTrustEnabled === true;',
        lines: [
          '只有显式 true 才开启，undefined 与 false 都按关闭处理。',
          '关闭时不创建 store，也就不读用户已有信任文件。',
          '信任文件保留，重新打开开关后可继续沿用。',
        ],
      },
      {
        anchor: 'let controller: WorkspaceHookReviewController | undefined;',
        lines: [
          '控制器是可选件：没有 host 或没有 emit 时保持 undefined。',
          '后续所有审核方法都据此回退到 unavailable。',
          '这一层不改变 admission 的启用态。',
        ],
      },
      {
        anchor: 'if (trustEnabled && input.reviewHost && input.emitReviewEvent) {',
        lines: [
          '三个条件必须同时成立，缺一个都不装配控制器。',
          'host 通过展开注入 emit，控制器只认 host 端口。',
          'mutation 端口绑定当前工作目录与运行根，避免跨区写。',
        ],
      },
      {
        anchor: 'reloadTrust: async () => {',
        lines: [
          '关闭态与无 store 时是安全 no-op。',
          '重载后 activate 幂等，会重新 evaluate 并重发状态。',
          'pendingCount 为 0 也发，用于清空 banner。',
        ],
      },
      {
        anchor: 'const loaded = await (await input.store).load();',
        lines: [
          'store 本身是 Promise，先 await 再 load。',
          'loaded.status 原样透传给 coordinator，corrupt 时附带恢复路径。',
        ],
      },
    ],
  },
];

let index = 0;
for (const spec of specs) {
  const srcLines = fs.readFileSync('D:/code/ZCode/' + spec.file, 'utf8').split('\n');
  const firstAnchor = srcLines[0].replace(/\r$/, '').trim();
  const firstItem = { anchor: firstAnchor, raw: spec.header };
  if (spec.firstNth) firstItem.nth = spec.firstNth;
  const items = [firstItem];
  for (const block of spec.blocks) {
    const item = { anchor: block.anchor, lines: block.lines };
    if (block.nth !== undefined) item.nth = block.nth;
    items.push(item);
  }
  const total = spec.header.length + spec.blocks.reduce((n, b) => n + b.lines.length, 0);
  if (total !== spec.target) {
    console.error(`TARGET MISMATCH ${spec.file}: ${total} != ${spec.target}`);
    process.exit(1);
  }
  fs.writeFileSync(
    `ZC-deep-b204-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
