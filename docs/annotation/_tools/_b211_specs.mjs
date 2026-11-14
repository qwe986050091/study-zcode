// B211 四个文件的注释 spec 生成器（target 依次为 33/35/31/31，各新增 30 行）。
import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/remote-connection-flow/requestRemoteProjectConnection.ts',
    target: 30,
    header: [
      '// INV-01 过期调用直接返回：守住位置 入口与 catch 内的 isCurrent；改错故障 已切走的项目被旧请求继续推进。',
      '// INV-02 交接只认等待前目标：守住位置 failedTarget 的三重判定；改错故障 升级失败后按新 Profile 重新选址。',
      '// INV-03 WSL 目标需 distro 与 user 双齐：守住位置 括号内的两段 trim；改错故障 半配置目标被当成可升级。',
      '// INV-04 server 目标不参与升级：守住位置 kind 不等于 server；改错故障 本机服务器被要求走 Source 升级。',
      '// INV-05 失败与待处理都交给向导：守住位置 status 的双等值；改错故障 待安装状态被静默重连。',
      '// INV-06 等待动作到错误码的映射固定：守住位置 waitingCode 五键；改错故障 向导打开时没有初始原因。',
      '// INV-07 显式错误码优先于推导：守住位置 failure 的 code 短路；改错故障 上游给出的具体原因被泛化覆盖。',
      '// INV-08 升级类失败携带失败目标：守住位置 failedTarget 的展开；改错故障 用户看不出是哪台主机升级失败。',
      '// INV-09 重连选项集中在此：守住位置 reconnect 实参；改错故障 各调用方各自决定是否抛错，行为漂移。',
      '// INV-10 失败后按错误码重新归类：守住位置 catch 内的 resolveRemoteConnectionPresentation；改错故障 需交互的失败被当成普通失败吞掉。',
      '// INV-11 只有 pending 才升级为向导：守住位置 status 等值判断；改错故障 所有错误都弹窗，或该弹的都不弹。',
      '// INV-12 profileId 必须过类型判断：守住位置 in 与 typeof 双检；改错故障 任意字段被当作线路 id 透传。',
      '// INV-13 WSL 解析结果先校验再采用：守住位置 safeParse；改错故障 畸形的 resolvedWslTarget 进入向导。',
      '// INV-14 普通失败不重复提示：守住位置 末尾无 else 分支；改错故障 项目行与弹窗各报一次错。',
      '//',
      '// 模块职责：把一次远程项目连接请求分派到重连或连接向导，并保留失败上下文。',
      '// 阅读顺序：先看入口与目标判定，再看 pending 与 failed 的向导分支，最后看 catch 内的二次归类。',
    ],
    blocks: [
      {
        anchor: 'export async function requestRemoteProjectConnection({',
        lines: [
          '入口先做一次时效检查，过期即弃。',
        ],
      },
      {
        anchor: 'if (!isCurrent()) return;',
        nth: 1,
        lines: [
          '同一检查在异步失败后还要再执行一次。',
        ],
      },
      {
        anchor: 'const failedTarget =',
        lines: [
          '升级失败要带回的目标，需同时满足类型与完整度。',
        ],
      },
      {
        anchor: 'if (presentation.status === "failed" || presentation.status === "pending") {',
        lines: [
          '失败与待处理都需要用户交互，统一交给向导。',
        ],
      },
      {
        anchor: 'install: "source-server-install-required",',
        lines: [
          '每种主操作对应一个初始错误码。',
        ],
      },
      {
        anchor: 'const code = failure?.code ?? waitingCode[presentation.primaryAction];',
        lines: [
          '显式错误码优先，缺省才用推导值。',
        ],
      },
      {
        anchor: 'await reconnect({',
        lines: [
          '重连选项写死在此，避免调用方漂移。',
        ],
      },
      {
        anchor: 'error && typeof error === "object" && "code" in error ? String(error.code) : undefined;',
        lines: [
          '从错误对象里提取机器可读的 code。',
        ],
      },
      {
        anchor: '.status === "pending"',
        lines: [
          '按错误码重新归类，判断是否仍需交互。',
        ],
      },
      {
        anchor: 'const profileId =',
        lines: [
          '线路 id 要类型收窄后才能透传。',
        ],
      },
      {
        anchor: 'hostRemoteWorkspaceConnectFailedResponseSchema.shape.resolvedWslTarget.safeParse(',
        lines: [
          'WSL 解析结果来自宿主机，必须先校验。',
        ],
      },
      {
        anchor: '...(resolvedWslTarget.success && resolvedWslTarget.data',
        lines: [
          '成功解析后，升级失败目标改由解析结果推导。',
        ],
      },
      {
        anchor: '} catch (error) {',
        lines: [
          '其余失败由重连 owner 负责写回项目行。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/remote-connection/RemoteConnectionTags.tsx',
    target: 30,
    header: [
      '// INV-01 类型配色集中一处：守住位置 REMOTE_KIND_PRESENTATION；改错故障 同一类型在不同组件里颜色不一。',
      '// INV-02 每类三套类名齐全：守住位置 className、selectedClassName、tileClassName；改错故障 选中态或图标块缺底色。',
      '// INV-03 as const 锁定字面量：守住位置 对象收尾；改错故障 键被拓宽成 string，按 kind 索引失效。',
      '// INV-04 图标块纯装饰：守住位置 aria-hidden；改错故障 读屏把图标名重复念一遍。',
      '// INV-05 类型标签带 data 属性：守住位置 data-remote-connection-kind；改错故障 自动化无法按类型定位。',
      '// INV-06 类型文案按 kind 拼 id：守住位置 模板字符串；改错故障 新增类型没有对应翻译。',
      '// INV-07 外部展示结果优先：守住位置 supplied 的空值合并；改错故障 已聚合的线路状态被状态机覆盖。',
      '// INV-08 状态标签可自给自足：守住位置 只给 status 时的兜底推导；改错故障 不传 presentation 就无法渲染。',
      '// INV-09 status 角色与原子播报：守住位置 role 与 aria-atomic；改错故障 状态变化没有任何读屏反馈。',
      '// INV-10 圆点颜色与文案同源：守住位置 presentation.dot 与 messageId；改错故障 点显示绿色而文案说失败。',
      '// INV-11 恢复建议优先于简称：守住位置 第一段三元；改错故障 用户只看到简称，看不到怎么修。',
      '// INV-12 简称相同则省略：守住位置 第二段三元的判等；改错故障 同一句话在标签里出现两次。',
      '// INV-13 状态数据属性取解析后的值：守住位置 presentation.status；改错故障 选择器匹配到调用方传入的原始值。',
      '// INV-14 格式化函数原样转出：守住位置 文件顶部的 export；改错故障 调用方必须改导入路径。',
      '//',
      '// 模块职责：远程连接的类型与状态标签，以及候选列表左侧的类型图标块。',
      '// 阅读顺序：先看类型配色表，再看三个组件，最后看状态标签的恢复建议与简称回退。',
    ],
    blocks: [
      {
        anchor: 'export const REMOTE_KIND_PRESENTATION = {',
        lines: [
          '连接类型的唯一配色来源，标签、表单与候选块共用。',
          '新增类型必须补齐三套类名，否则标签会失去边框与底色。',
        ],
      },
      {
        anchor: 'ssh: {',
        lines: [
          'SSH 用服务器图标与蓝紫系 token。',
          'token 只表达类型，不表达连接状态。',
        ],
      },
      {
        anchor: 'wsl: {',
        lines: [
          'WSL 用终端图标与独立色系。',
        ],
      },
      {
        anchor: 'docker: {',
        lines: [
          'Docker 用容器图标与另一套 token。',
        ],
      },
      {
        anchor: 'const { Icon, tileClassName } = REMOTE_KIND_PRESENTATION[kind];',
        lines: [
          '按 kind 直接解构，类型收窄由联合类型保证。',
          '图标是纯装饰，外层已标记 aria-hidden。',
        ],
      },
      {
        anchor: 'const presentation = supplied ?? resolveRemoteConnectionPresentation({ state: status });',
        lines: [
          '调用方给了展示结果就直接用，避免重复推导。',
          '只给 status 时按状态反推一份最小展示。',
        ],
      },
      {
        anchor: 'role="status"',
        lines: [
          '状态标签用 status 角色，变化时读屏会播报。',
          'aria-atomic 保证整块文案一起读出，而不是逐段补丁。',
        ],
      },
      {
        anchor: '{presentation.recovery ? (',
        lines: [
          '有恢复建议时优先显示建议，而不是干巴巴的失败原因。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/remote/remoteWorkspaceController.ts',
    target: 31,
    header: [
      '// INV-01 意图是判别联合：守住位置 type 字段；改错故障 新增意图没有类型，分派无法收窄。',
      '// INV-02 分派覆盖全部意图：守住位置 switch 六个 case；改错故障 遗漏的意图静默成功。',
      '// INV-03 每个分支都要 await：守住位置 六处 await；改错故障 调用方拿不到完成时机，顺序错乱。',
      '// INV-04 打开会话一律拒绝：守住位置 open-conversation 分支；改错故障 绕过项目创建直接建连。',
      '// INV-05 拒绝发生在副作用之前：守住位置 throw 的位置；改错故障 先连主机再报错，留下脏连接。',
      '// INV-06 关闭必须声明 user-close：守住位置 origin 判等；改错故障 系统回收被当成用户意图。',
      '// INV-07 重连选项可省略：守住位置 两路分支；改错故障 无选项时把 undefined 传进处理器。',
      '// INV-08 控制器不持有状态：守住位置 返回对象只有 projection 与 dispatch；改错故障 控制器与 store 双写。',
      '// INV-09 projection 只读：守住位置 readonly 修饰；改错故障 调用方直接改写投影。',
      '// INV-10 处理器契约与意图字段对齐：守住位置 interface 的六个方法；改错故障 传参顺序与意图字段不一致。',
      '// INV-11 打开项目透传完整意图：守住位置 handlers.openProject(intent)；改错故障 逐字段重拼导致漏字段。',
      '// INV-12 连接设备区分两种效果：守住位置 effect 联合；改错故障 设备管理与选中项目走同一路径。',
      '// INV-13 未知意图不静默：守住位置 switch 无 default；改错故障 类型扩展后旧实现静默通过。',
      '// INV-14 控制器是纯装配：守住位置 工厂函数体；改错故障 在工厂里发起网络请求。',
      '//',
      '// 模块职责：把远程工作区的用户意图收敛成一次 dispatch，转发给注入的处理器。',
      '// 阅读顺序：先看三个类型声明，再看工厂返回，最后看 switch 六个分支的语义差异。',
    ],
    blocks: [
      {
        anchor: 'export type RemoteWorkspaceReconnectOptions = {',
        lines: [
          '重连只暴露三个开关，其余由 owner 决定。',
        ],
      },
      {
        anchor: 'export type RemoteWorkspaceIntent =',
        lines: [
          '意图以 type 判别，字段随类型变化。',
        ],
      },
      {
        anchor: '| { type: "connect-device"; profileId: string; effect: "select-project" | "device-management" }',
        lines: [
          '连接设备要区分只是选中还是进管理页。',
        ],
      },
      {
        anchor: '| { type: "disconnect-device"; sourceServerId: string }',
        lines: [
          '断开只接受服务器 id，不携带线路。',
        ],
      },
      {
        anchor: '| { type: "close-workspace"; workspaceKey: string; origin: "user-close" };',
        lines: [
          '关闭必须带来源，防止系统回收冒充用户操作。',
        ],
      },
      {
        anchor: 'export interface RemoteWorkspaceControllerHandlers {',
        lines: [
          '处理器契约与意图一一对应，参数顺序即字段顺序。',
        ],
      },
      {
        anchor: 'export interface RemoteWorkspaceController {',
        lines: [
          '控制器对外只有投影与分派两个成员。',
        ],
      },
      {
        anchor: 'dispatch(intent: RemoteWorkspaceIntent): Promise<void>;',
        lines: [
          '分派是唯一入口，异步返回便于串行化。',
        ],
      },
      {
        anchor: 'export function createRemoteWorkspaceController(',
        lines: [
          '工厂不持有状态，所有副作用都在处理器里。',
        ],
      },
      {
        anchor: 'switch (intent.type) {',
        lines: [
          '按 type 分派，每个分支只做转发。',
        ],
      },
      {
        anchor: 'case "open-conversation":',
        lines: [
          '旧回调也不能绕过项目创建。',
        ],
      },
      {
        anchor: 'throw new Error("project.remote-project-required");',
        lines: [
          '拒绝前不产生连接或目录副作用。',
        ],
      },
      {
        anchor: 'if (intent.origin !== "user-close")',
        lines: [
          '来源不符直接抛错，不做兜底关闭。',
        ],
      },
      {
        anchor: 'await handlers.closeWorkspace(intent.workspaceKey);',
        lines: [
          '关闭是最后一个分支，语义最窄。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/root/useReconnectingRemoteWorkspaceLogs.ts',
    target: 31,
    header: [
      '// INV-01 日志上限固定五十条：守住位置 常量与 slice；改错故障 长时间重连把内存撑爆。',
      '// INV-02 最新的键列表放进 ref：守住位置 第一个 effect 的写入；改错故障 订阅回调读到挂载时的旧键。',
      '// INV-03 日志按 workspaceKey 分组：守住位置 状态形状；改错故障 多个项目日志混成一条流。',
      '// INV-04 目标消失即清日志：守住位置 过滤条件 resolveWorkspaceTargetByKey；改错故障 已移除项目的日志常驻。',
      '// INV-05 无变化时返回原引用：守住位置 长度相等短路；改错故障 每次键变化都触发全量重渲染。',
      '// INV-06 空白日志消息直接丢弃：守住位置 归一化后的判空；改错故障 空行占满五十条配额。',
      '// INV-07 没有重连项目就不处理：守住位置 长度为 0 的提前返回；改错故障 常态下每条日志都走一遍匹配。',
      '// INV-08 只构造有目标的重连条目：守住位置 flatMap 的空数组；改错故障 无效项目参与标签匹配。',
      '// INV-09 requestId 可缺省：守住位置 可选链与空值合并；改错故障 缺少请求 id 的项目匹配不到日志。',
      '// INV-10 匹配失败不写状态：守住位置 第二处提前返回；改错故障 无关日志触发无意义的映射复制。',
      '// INV-11 只有真正变化才复制对象：守住位置 next 与 current 的判等；改错故障 每条日志都重建整个映射。',
      '// INV-12 日志 id 含时间戳与序号：守住位置 模板字符串；改错故障 同一毫秒的多条日志键冲突。',
      '// INV-13 订阅在卸载时释放：守住位置 effect 返回 unsubscribe；改错故障 重复挂载累积监听器。',
      '// INV-14 重置只清单个项目：守住位置 resetLogsForWorkspaceKey；改错故障 重连一个项目把其它项目日志清空。',
      '//',
      '// 模块职责：为重连中的远程工作区收集运行日志，并在项目消失或主动重置时释放。',
      '// 阅读顺序：先看上限与两份状态，再看键同步与日志订阅，最后看重置回调与返回值。',
    ],
    blocks: [
      {
        anchor: 'const RECONNECT_RUNTIME_LOG_LIMIT = 50;',
        lines: [
          '上限是配额而非提示，所有写入都要截断。',
        ],
      },
      {
        anchor: 'const reconnectingWorkspaceKeysRef = useRef<string[]>([]);',
        lines: [
          '回调里读到的最新键列表由 ref 提供。',
        ],
      },
      {
        anchor: 'const [logsByWorkspaceKey, setLogsByWorkspaceKey] = useState<',
        lines: [
          '按项目分组保存，互不干扰。',
        ],
      },
      {
        anchor: 'reconnectingWorkspaceKeysRef.current = reconnectingWorkspaceKeys;',
        lines: [
          '写入 ref 与清理状态放在同一个 effect。',
        ],
      },
      {
        anchor: 'const nextEntries = Object.entries(current).filter(',
        lines: [
          '目标已消失的项目，其日志一并清掉。',
        ],
      },
      {
        anchor: 'if (nextEntries.length === Object.keys(current).length) {',
        lines: [
          '没有减少就不必产生新对象。',
        ],
      },
      {
        anchor: 'const unsubscribe = platform.onRemoteConnectionLog((entry) => {',
        lines: [
          '订阅是唯一日志入口，卸载时必须释放。',
        ],
      },
      {
        anchor: 'const normalizedMessage = normalizeRemoteConnectionLogMessage(entry.message);',
        lines: [
          '先归一化，纯空白消息不进入状态。',
        ],
      },
      {
        anchor: 'if (reconnectingKeys.length === 0) {',
        lines: [
          '没有重连中的项目时，日志与本次无关。',
        ],
      },
      {
        anchor: 'const reconnectingEntries = reconnectingKeys.flatMap((workspaceKey) => {',
        lines: [
          '只把仍有目标的项目交给匹配器。',
        ],
      },
      {
        anchor: 'const matchedWorkspaceKeys = resolveRemoteWorkspaceReconnectLogWorkspaceKeys({',
        lines: [
          '匹配同时看标签与请求 id，规则在纯函数里。',
        ],
      },
      {
        anchor: 'if (matchedWorkspaceKeys.length === 0) {',
        lines: [
          '匹配不到任何项目就直接返回。',
        ],
      },
      {
        anchor: '}).slice(-RECONNECT_RUNTIME_LOG_LIMIT);',
        lines: [
          '保留最近若干条，旧日志按序丢弃。',
        ],
      },
      {
        anchor: 'const resetLogsForWorkspaceKey = useCallback((workspaceKey: string) => {',
        lines: [
          '重置只作用于指定项目，不影响其它分组。',
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
    `ZC-deep-b211-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
