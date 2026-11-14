import fs from 'node:fs';

const specs = [
  {
    file: 'packages/desktop/src/host/sourceServerManagementService.ts',
    target: 40,
    header: [
      '// INV-01 快照双读校验：守住位置 start/end generation；改错故障 返回自相矛盾快照。',
      '// INV-02 变化即重试：守住位置 continue；改错故障 旧状态覆盖新状态。',
      '// INV-03 迁移统计失效不阻塞：守住位置 read 调用；改错故障 远端慢时快照卡住。',
      '// INV-04 事件推送带代际：守住位置 generation 自增；改错故障 增量无法对齐。',
      '// INV-05 目录变化统一入口：守住位置 publishDirectoryChange；改错故障 多处重复自增。',
      '// INV-06 disposed 后静默：守住位置 早退；改错故障 关闭后仍推送。',
      '// INV-07 状态变化先失效统计：守住位置 invalidate；改错故障 统计滞后一轮。',
      '// INV-08 操作日志按合约解析：守住位置 schema.parse；改错故障 非法日志进入前端。',
      '// INV-09 命令结束必回新快照：守住位置 return getSnapshot；改错故障 调用方拿旧代际。',
      '// INV-10 连接并发取 profile 与目标：守住位置 Promise.all；改错故障 串行多一次 IO。',
      '// INV-11 身份待确认视为已到点：守住位置 code 比较；改错故障 用户看不到确认引导。',
      '// INV-12 确认连接必须显式标志：守住位置 confirmIdentityChange；改错故障 再次停在待确认。',
      '// INV-13 新会话目录由远端分配：守住位置 prepareSession；改错故障 所有会话共享 default cwd。',
      '// INV-14 更新前双重核验：守住位置 assertTarget 两次；改错故障 旧授权用于另一台设备。',
      '// INV-15 删除三步顺序不可换：守住位置 断开→回调→持久化；改错故障 悬挂 attachment。',
      '// INV-16 缺回调直接失败：守住位置 missing 分支；改错故障 留下无主附件。',
      '// INV-17 不存在视为幂等成功：守住位置 exists 判断；改错故障 重复删除报错。',
      '// INV-18 迁移放弃与重试都刷新统计：守住位置 finally；改错故障 UI 停在旧失败计数。',
      '//',
      '// 模块职责：把 Directory 持久化事实与 ConnectionManager 运行态合成快照与命令入口。',
      '// 状态所有权：generation 由本服务单调维护；连接与目录各自持有真实状态。',
      '// 阅读顺序：先看快照构造，再看连接与更新，最后看删除流程。',
    ],
    blocks: [
      {
        anchor: 'export function createSourceServerManagementService(options: {',
        lines: [
          '目录提供持久化事实。',
          'manager 提供运行态。',
          '命令后统一回新快照。',
        ],
      },
      {
        anchor: '  function publishDirectoryChange() {',
        lines: [
          'disposed 后静默。',
          '先自增代际。',
          '再推送目录增量。',
        ],
      },
      {
        anchor: '  const stateSubscription = options.manager.onDidChangeState((state) => {',
        lines: [
          '先失效迁移统计。',
          '再自增代际。',
          '最后推送状态增量。',
        ],
      },
      {
        anchor: '  async function getSnapshot(',
        lines: [
          '请求可要求刷新统计。',
          '循环双读代际。',
          '代际一致才构造快照。',
        ],
      },
      {
        anchor: '  async function readProfile(profileId: string) {',
        lines: [
          '先取目录快照。',
          '按 id 查找 profile。',
          '缺失即抛错。',
        ],
      },
      {
        anchor: '    async removeSourceServer(sourceServerId) {',
        lines: [
          '不存在视为成功。',
          '缺回调立即失败。',
          '断开、清理、持久化顺序不可换。',
        ],
      },
    ],
  },
  {
    file: 'packages/desktop/src/host/taskRealtimeBridge.ts',
    target: 39,
    header: [
      '// INV-01 非 InitLocal 返回空：守住位置 type 比较；改错故障 远端模式误建通道。',
      '// INV-02 缺 hostId 返回空：守住位置 判空；改错故障 桥无法与 main 关联。',
      '// INV-03 deliveryKind 随桥固化：守住位置 构造参数；改错故障 同一 Host 出现两条通道。',
      '// INV-04 边界先过共享 schema：守住位置 safeParse；改错故障 非法跨进程消息进入分派。',
      '// INV-05 回包只认 requestId：守住位置 pending map；改错故障 迟到回包影响其它请求。',
      '// INV-06 找不到 pending 即丢弃：守住位置 早退；改错故障 重复回包触发两次结算。',
      '// INV-07 租约与命令结果分开存放：守住位置 两个 Map；改错故障 请求类型互相串。',
      '// INV-08 事件去重有界：守住位置 rememberEventId；改错故障 内存线性增长。',
      '// INV-09 FIFO 淘汰最旧：守住位置 shift；改错故障 新事件被误判重复。',
      '// INV-10 去重失败停止分发：守住位置 返回 false；改错故障 同一事件投递两次。',
      '// INV-11 投递类才 fan-out：守住位置 两个 deliver 分支；改错故障 回包被当事件广播。',
      '// INV-12 dispose 拒绝全部 pending：守住位置 两个循环；改错故障 调用方永久挂起。',
      '// INV-13 dispose 摘掉监听：守住位置 off；改错故障 关闭后仍有回调。',
      '// INV-14 dispose 幂等：守住位置 disposed 早退；改错故障 重复清理抛错。',
      '// INV-15 写操作在 dispose 后静默：守住位置 各方法早退；改错故障 关闭后仍 postMessage。',
      '// INV-16 监听器返回可释放句柄：守住位置 闭包 delete；改错故障 订阅泄漏。',
      '// INV-17 租约请求生成唯一 id：守住位置 createUuid；改错故障 并发请求互相覆盖。',
      '// INV-18 事件监听同样受 disposed 约束：守住位置 早退；改错故障 关闭后仍注册。',
      '//',
      '// 模块职责：在 Host 与 main 之间中继任务实时事件、租约与 owner command。',
      '// 状态所有权：listener 集合与两个 pending 映射随桥创建与销毁。',
      '// 阅读顺序：先看构造入口，再看消息分派，最后看销毁。',
    ],
    blocks: [
      {
        anchor: 'export function createTaskRealtimeBridgeForHostInit(',
        lines: [
          '只有 InitLocal 建立通道。',
          '缺 hostId 返回空。',
          'deliveryKind 原样下传。',
          '调用方据空值跳过注册。',
        ],
      },
      {
        anchor: 'export function createTaskRealtimeBridge(params: {',
        lines: [
          '事件与命令监听分开。',
          '两个 pending 映射分开。',
          '去重窗口有界。',
          'disposed 控制所有入口。',
        ],
      },
      {
        anchor: '  const rememberEventId = (eventId: string): boolean => {',
        lines: [
          '已见即返回否。',
          '写入后按容量淘汰。',
          '淘汰同步删索引。',
        ],
      },
      {
        anchor: '  const onMessage = (messageEvent: { data: unknown }) => {',
        lines: [
          '先校验共享 schema。',
          '回包只结算对应 pending。',
          '投递类才广播。',
        ],
      },
      {
        anchor: '    dispose(): void {',
        lines: [
          '先置关闭标志。',
          '拒绝全部 pending。',
          '摘掉监听并清缓存。',
        ],
      },
    ],
  },
  {
    file: 'packages/desktop/src/main/databaseStartupTelemetry.ts',
    target: 37,
    header: [
      '// INV-01 上报失败不阻断启动：守住位置 try/catch；改错故障 遥测异常导致白屏。',
      '// INV-02 事件 id 可复算：守住位置 拼接规则；改错故障 前后端无法对齐。',
      '// INV-03 尝试表有上限：守住位置 128 判断；改错故障 进程内无限增长。',
      '// INV-04 首次进入即发 started：守住位置 创建分支；改错故障 缺少起点事件。',
      '// INV-05 终态后不再上报：守住位置 terminal 早退；改错故障 重复结算。',
      '// INV-06 阶段变化才发事件：守住位置 lastStage 比较；改错故障 每帧上报。',
      '// INV-07 阶段时长从上次变化算：守住位置 stageAt；改错故障 累计时长失真。',
      '// INV-08 数据库完成只记一次：守住位置 databaseFinished；改错故障 重复 result。',
      '// INV-09 失败阶段映射为 failed：守住位置 三元；改错故障 失败被记成 ready。',
      '// INV-10 迁移类型缺失记为 unknown：守住位置 回退；改错故障 空字符串进入看板。',
      '// INV-11 基线逐库上报：守住位置 循环；改错故障 多库只记一条。',
      '// INV-12 终态事件名二选一：守住位置 ready 判断；改错故障 失败也叫 ready。',
      '// INV-13 磁盘峰值未知用占位：守住位置 null 判断；改错故障 缺失值被当 0。',
      '// INV-14 磁盘陈述时长非负：守住位置 Math.max；改错故障 出现负时长。',
      '// INV-15 终态日志附时长：守住位置 logger.info；改错故障 现场无耗时信息。',
      '// INV-16 只读 Host 镜像：守住位置 函数入口；改错故障 启动期访问磁盘。',
      '// INV-17 尝试键按 attemptId：守住位置 Map 键；改错故障 多尝试互相覆盖。',
      '// INV-18 上报属性可扩展：守住位置 properties 展开；改错故障 调用方无法附加维度。',
      '//',
      '// 模块职责：把 Host 聚合的数据库启动状态转成 ARMS 自定义事件。',
      '// 状态所有权：attempts 以 attemptId 为键记录阶段推进，总量有上限。',
      '// 阅读顺序：先看单次上报，再看状态推进，最后看终态与磁盘明细。',
    ],
    blocks: [
      {
        anchor: 'function send(',
        lines: [
          '事件 id 可复算。',
          '属性可扩展。',
          '上报失败静默。',
        ],
      },
      {
        anchor: 'export function reportDatabaseStartupState(state: DatabaseStartupState): void {',
        lines: [
          '首次进入发 started。',
          '尝试表有上限。',
          '只读 Host 镜像。',
        ],
      },
      {
        anchor: '  if (attempt.terminal) return;',
        lines: [
          '终态后不再上报。',
          '阶段名由两段拼成。',
          '变化才发阶段事件。',
        ],
      },
      {
        anchor: '  if (!attempt.databaseFinished && ["starting_services", "ready", "failed"].includes(state.phase)) {',
        lines: [
          '完成只记一次。',
          '失败映射为 failed。',
          '迁移缺失记 unknown。',
        ],
      },
      {
        anchor: '  attempt.terminal = true;',
        lines: [
          '终态事件名二选一。',
          '磁盘逐块上报。',
          '终态日志附时长。',
        ],
      },
    ],
  },
  {
    file: 'packages/server/src/remote/remoteAssetCdn.ts',
    target: 38,
    header: [
      '// INV-01 多基址去重：守住位置 Set；改错故障 重复探测。',
      '// INV-02 空串过滤：守住位置 trim 与 filter；改错故障 生成根路径 URL。',
      '// INV-03 已固定版本不再拼版本：守住位置 endsWith；改错故障 双版本 404 噪音。',
      '// INV-04 候选顺序版本化优先：守住位置 数组顺序；改错故障 先打根路径。',
      '// INV-05 文件名与基址笛卡尔积：守住位置 双层循环；改错故障 组合缺失。',
      '// INV-06 路径段逐段编码：守住位置 encodePathSegment；改错故障 加号被当空格。',
      '// INV-07 已编码输入不二次编码：守住位置 先解码；改错故障 %2B 变成 %252B。',
      '// INV-08 非法百分号回退直编：守住位置 catch；改错故障 抛异常中断下载。',
      '// INV-09 相对路径拒绝反斜杠：守住位置 includes；改错故障 Windows 路径混入 URL。',
      '// INV-10 拒绝绝对路径与盘符：守住位置 正则；改错故障 读到本地文件。',
      '// INV-11 拒绝空段与点段：守住位置 段检查；改错故障 路径穿越。',
      '// INV-12 归一化后再次校验：守住位置 二次检查；改错故障 异常段漏网。',
      '// INV-13 版本锁前置校验：守住位置 基址末段；改错故障 部署阶段才报错。',
      '// INV-14 非版本末段直接放行：守住位置 无固定版本分支；改错故障 正常基址被误拒。',
      '// INV-15 组件产物回退父级根：守住位置 slice；改错故障 每个组件先打 404。',
      '// INV-16 组件候选过滤空串：守住位置 filter；改错故障 生成空基址。',
      '// INV-17 产物候选同样去重：守住位置 Set；改错故障 同一 URL 重复下载。',
      '// INV-18 语义化版本仅认末段：守住位置 isSemverLike；改错故障 中间段被误判。',
      '//',
      '// 模块职责：由 CDN 基址与相对路径生成有序候选 URL，并做版本锁校验。',
      '// 状态所有权：无状态；所有导出均为纯函数。',
      '// 阅读顺序：先看基址与候选构造，再看路径归一化，最后看版本校验。',
    ],
    blocks: [
      {
        anchor: 'export function resolveRemoteCdnBaseUrls(options: RemoteCdnBaseOptions): string[] {',
        lines: [
          '合并两组来源。',
          '逐项去空白。',
          '过滤空串。',
          'Set 去重。',
        ],
      },
      {
        anchor: 'export function buildReleaseAssetUrlCandidates(',
        lines: [
          '文件先归一化。',
          '基址与文件做笛卡尔积。',
          '逐段编码后拼接。',
          'Set 去重。',
        ],
      },
      {
        anchor: 'export function normalizeRemoteAssetRelativePath(rawPath: string, label: string): string {',
        lines: [
          '拒绝空串与反斜杠。',
          '拒绝绝对路径与盘符。',
          '拒绝空段与点段。',
          '归一化后二次校验。',
        ],
      },
      {
        anchor: 'export function assertRemoteCdnBaseVersionMatches(',
        lines: [
          '只校验版本末段。',
          '非版本基址放行。',
          '不匹配项汇总。',
          '前置抛错阻断部署。',
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
    const anchor =
      block.anchorLine === undefined
        ? block.anchor
        : srcLines[block.anchorLine - 1].replace(/\r$/, '').trim();
    const item = { anchor, lines: block.lines };
    if (block.nth !== undefined) item.nth = block.nth;
    items.push(item);
  }
  const total = spec.header.length + spec.blocks.reduce((n, b) => n + b.lines.length, 0);
  if (total !== spec.target) {
    console.error(`TARGET MISMATCH ${spec.file}: ${total} != ${spec.target}`);
    process.exit(1);
  }
  fs.writeFileSync(
    `ZC-deep-b158-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
