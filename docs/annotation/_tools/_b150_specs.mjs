import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/v4/WorkbenchSplitDivider.tsx',
    target: 40,
    header: [
      '// INV-01 拖动占比不进 React state：守住位置 dragRef；改错故障 pane 子树每帧重渲染。',
      '// INV-02 拖动中只写 CSS 变量：守住位置 帧回调；改错故障 布局抖动。',
      '// INV-03 每帧最多一次写入：守住位置 帧号判断；改错故障 指针事件洪泛。',
      '// INV-04 主轴像素拖动期恒定：守住位置 regionPx；改错故障 占比随窗口漂移。',
      '// INV-05 区域为零回退起点：守住位置 早退；改错故障 除零得到无穷大。',
      '// INV-06 占比夹在合法区间：守住位置 clampSplitRatio；改错故障 面板被拖出边界。',
      '// INV-07 只响应主键鼠标：守住位置 按键判断；改错故障 右键拖动误触。',
      '// INV-08 指针捕获失败可继续：守住位置 try 块；改错故障 合成事件下拖动失效。',
      '// INV-09 指针 id 必须匹配：守住位置 身份比较；改错故障 多指拖动互相抢占。',
      '// INV-10 结束取消在途帧：守住位置 cancelAnimationFrame；改错故障 末帧覆盖最终值。',
      '// INV-11 结束立即写入最终值：守住位置 设置属性；改错故障 松手后闪回。',
      '// INV-12 结束一次性提交仓库：守住位置 onCommitRatio；改错故障 拖动过程频繁持久化。',
      '// INV-13 卸载清理在途帧：守住位置 effect 返回闭包；改错故障 卸载后仍操作容器。',
      '// INV-14 高亮态仅本地：守住位置 dragging；改错故障 全局状态被拖动污染。',
      '// INV-15 角色为分隔条：守住位置 role；改错故障 读屏不知可调整。',
      '// INV-16 方向映射无障碍朝向：守住位置 aria-orientation；改错故障 横竖方向播报相反。',
      '// INV-17 触摸操作交给指针事件：守住位置 touch-none；改错故障 移动端触发滚动。',
      '// INV-18 组件按 props 记忆化：守住位置 memo；改错故障 父级渲染连带重绘。',
      '//',
      '// 模块职责：渲染可拖拽的分屏分隔条，按行或列调整两侧占比。',
      '// 状态所有权：拖动事实归引用；仅高亮态为组件本地状态。',
      '// 阅读顺序：先看拖动换算，再看三个指针回调，最后看清理与渲染。',
    ],
    blocks: [
      {
        anchor: 'const dragRef = useRef<SplitDividerDragState | null>(null);',
        lines: [
          '拖动事实放在引用里。',
          '不触发 React 重渲染。',
          '结束或卸载时清空。',
        ],
      },
      {
        anchor: 'const [dragging, setDragging] = useState(false);',
        lines: [
          '仅驱动分隔条自身高亮。',
          '不进入 pane 子树。',
          '开始与结束各提交一次。',
        ],
      },
      {
        anchor: 'const ratioFromDrag = useCallback((drag: SplitDividerDragState): number => {',
        lines: [
          '区域像素为零时回退起点。',
          '位移除以主轴像素。',
          '结果夹在合法区间。',
        ],
      },
      {
        anchor: 'const handlePointerDown = useCallback(',
        lines: [
          '只响应主键鼠标。',
          '捕获指针保证后续事件。',
          '记录起点与主轴像素。',
        ],
      },
      {
        anchor: 'const handlePointerMove = useCallback(',
        lines: [
          '只处理匹配的指针。',
          '每帧只写一次变量。',
          '已有在途帧则跳过。',
        ],
      },
      {
        anchor: 'const endDrag = useCallback(',
        lines: [
          '取消在途帧。',
          '末次位置立即写入。',
          '一次性提交到布局仓库。',
        ],
      },
    ],
  },
  {
    file: 'packages/zcode-server-cli/src/runtime/releaseDownload.ts',
    target: 39,
    header: [
      '// INV-01 发布 JSON 统一超时：守住位置 fetchReleaseJson；改错故障 请求永久挂起。',
      '// INV-02 非成功状态即抛错：守住位置 状态判断；改错故障 错误页被当数据解析。',
      '// INV-03 响应必须过 schema：守住位置 解析调用；改错故障 合同漂移进入运行时。',
      '// INV-04 计时器必须清理：守住位置 finally；改错故障 计时器泄漏。',
      '// INV-05 空闲超时按无数据计：守住位置 计时重置；改错故障 大文件被误判超时。',
      '// INV-06 总时长有独立上限：守住位置 overallTimeoutMs；改错故障 慢速连接永久占用。',
      '// INV-07 未知大小用默认时长：守住位置 默认计算；改错故障 预算为零。',
      '// INV-08 速率估算带下限：守住位置 取最大值；改错故障 小文件预算过短。',
      '// INV-09 重试仅限可恢复错误：守住位置 可重试判断；改错故障 校验失败被反复重试。',
      '// INV-10 中止与类型错误可重试：守住位置 名称判断；改错故障 网络抖动直接失败。',
      '// INV-11 特定状态码可重试：守住位置 状态判断；改错故障 限流被当成永久失败。',
      '// INV-12 退避按指数增长：守住位置 位移运算；改错故障 重试风暴。',
      '// INV-13 临时文件带进程与随机后缀：守住位置 路径拼接；改错故障 并发下载互相覆盖。',
      '// INV-14 空闲计时随数据重置：守住位置 数据监听；改错故障 传输中被中断。',
      '// INV-15 大小不符即失败：守住位置 期望值比对；改错故障 截断包被接受。',
      '// INV-16 校验和必须匹配：守住位置 摘要比对；改错故障 损坏包被安装。',
      '// INV-17 失败清理临时文件：守住位置 catch；改错故障 残留半成品。',
      '// INV-18 成功才原子改名：守住位置 改名调用；改错故障 目标文件被写坏。',
      '//',
      '// 模块职责：下载发布清单与归档，校验大小与校验和后原子落盘。',
      '// 状态所有权：函数内临时资源；模块只持有默认常量。',
      '// 阅读顺序：先看清单请求与默认值，再看重试判定，最后看单次下载流程。',
    ],
    blocks: [
      {
        anchor: 'export async function fetchReleaseJson<T>(',
        lines: [
          '统一超时与重定向策略。',
          '非成功状态即抛错。',
          '响应必须通过 schema 校验。',
          '无论成败都清理计时器。',
        ],
      },
      {
        anchor: 'const DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;',
        lines: [
          '空闲超时按无数据活动计。',
          '收到数据即重新计时。',
          '总时长另有上限。',
        ],
      },
      {
        anchor: 'function defaultOverallTimeoutMs(expectedSizeBytes: number | undefined): number {',
        lines: [
          '未知大小使用默认总时长。',
          '按保守速率估算传输预算。',
          '结果夹在空闲与总上限之间。',
        ],
      },
      {
        anchor: 'function isRetryableDownloadError(error: unknown): boolean {',
        lines: [
          '中止与类型错误可重试。',
          '特定 HTTP 状态可重试。',
          '常见网络错误码可重试。',
          '其余错误直接失败。',
        ],
      },
      {
        anchor: 'public async download(options: DownloadOptions): Promise<void> {',
        lines: [
          '尝试次数至少一次。',
          '退避按指数增长。',
          '不可重试即立即抛出。',
        ],
      },
    ],
  },
  {
    file: 'packages/zcode-server-cli/src/server-core/core.ts',
    target: 40,
    header: [
      '// INV-01 关闭函数只执行一次：守住位置 shutdownStarted；改错故障 重复释放资源。',
      '// INV-02 父进程先断开可延后关闭：守住位置 parentDisconnected；改错故障 启动后无人关闭。',
      '// INV-03 内建配置优先环境变量：守住位置 入口赋值；改错故障 显式路径被忽略。',
      '// INV-04 内嵌配置物化到环境根：守住位置 分支；改错故障 release 目录校验失败。',
      '// INV-05 缺少内建配置即失败：守住位置 早退判断；改错故障 服务带着空配置启动。',
      '// INV-06 服务标识逐级回退：守住位置 空值合并；改错故障 空标识进入日志。',
      '// INV-07 任务追踪可选服务：守住位置 可选获取；改错故障 缺失服务导致启动失败。',
      '// INV-08 入口令牌先于 HTTP：守住位置 调用顺序；改错故障 出现无鉴权窗口。',
      '// INV-09 ready 上报 Core 版本：守住位置 version 字段；改错故障 消费方读到 Node 版本。',
      '// INV-10 心跳串行不重叠：守住位置 heartbeatInFlight；改错故障 慢响应堆积。',
      '// INV-11 心跳同时带任务数：守住位置 心跳载荷；改错故障 父进程状态滞后。',
      '// INV-12 心跳失败仍上报：守住位置 失败分支；改错故障 监控断流。',
      '// INV-13 关闭先停心跳与订阅：守住位置 顺序；改错故障 关闭后仍有定时回调。',
      '// INV-14 关闭容错释放服务：守住位置 忽略异常；改错故障 单个服务异常阻断退出。',
      '// INV-15 关闭发送确认与退出消息：守住位置 发送顺序；改错故障 父进程收不到完成信号。',
      '// INV-16 显式退出确保收口：守住位置 显式退出；改错故障 Supervisor 等待超时。',
      '// INV-17 关闭命令与信号同源：守住位置 消息与信号处理；改错故障 两条路径行为不一致。',
      '// INV-18 IPC 消息先判形状再判命令：守住位置 类型守卫；改错故障 非法消息触发关闭。',
      '//',
      '// 模块职责：启动服务器核心进程，装配服务、HTTP 入口与父进程通信。',
      '// 状态所有权：进程级单例；关闭标记与心跳句柄局部持有。',
      '// 阅读顺序：先看启动装配，再看 ready 与心跳，最后看关闭流程。',
    ],
    blocks: [
      {
        anchor: 'let shutdown: ((reason: string) => Promise<void>) | undefined;',
        lines: [
          '关闭函数在初始化后注册。',
          '父进程先断开时延后执行。',
          '重复调用只生效一次。',
        ],
      },
      {
        anchor: 'const topicResourcePeers = createTopicResourcePeers();',
        lines: [
          '主题资源中继由对等端承载。',
          '通道按请求惰性提供。',
          '生命周期随进程结束。',
        ],
      },
      {
        anchor: 'const zcodeBuiltinProviderConfigFilePath = explicitZCodeBuiltinProviderConfigFilePath',
        lines: [
          '环境变量优先。',
          '否则使用内嵌配置物化。',
          '显式文件避免写入 release 目录。',
        ],
      },
      {
        anchor: 'const sourceServerId = (await resolveCoreServerId()) ?? hostname() ?? "zcode-server";',
        lines: [
          '优先使用持久化标识。',
          '回退主机名。',
          '最后使用固定名。',
        ],
      },
      {
        anchor: 'const send = (message: unknown): Promise<void> => {',
        lines: [
          '无 IPC 通道时静默成功。',
          '父进程断连后不阻塞。',
          '发送异常被吞掉。',
        ],
      },
      {
        anchor: 'const activitySubscription = taskActivityTracker.onDidChangeRunningTaskCount(',
        lines: [
          '任务数变化即上报。',
          '上报包含任务列表。',
          '订阅在关闭时释放。',
        ],
      },
    ],
  },
  {
    file: 'apps/dev-docs/src/capability-map/capabilityMapLayout.ts',
    target: 41,
    header: [
      '// INV-01 必填数值缺失即抛错：守住位置 必填取数；改错故障 节点被画到原点。',
      '// INV-02 非有限数视为缺失：守住位置 有限性判断；改错故障 无穷值进入坐标。',
      '// INV-03 位置缺失带层级描述：守住位置 位置取数；改错故障 无法定位漏算阶段。',
      '// INV-04 群图只喂本群节点：守住位置 节点过滤；改错故障 群框被外部节点撑大。',
      '// INV-05 跨群边不参与群内布局：守住位置 边过滤；改错故障 为不存在邻居预留空间。',
      '// INV-06 群节点 id 带前缀：守住位置 群 id 拼接；改错故障 与能力节点 id 冲突。',
      '// INV-07 区域节点 id 带前缀：守住位置 区域 id 拼接；改错故障 两类节点互相覆盖。',
      '// INV-08 群框顺序由关系决定：守住位置 排序函数；改错故障 跨群连线走向随机。',
      '// INV-09 群尺寸来自第一阶段：守住位置 群布局表；改错故障 打包尺寸不符。',
      '// INV-10 路径至少两点：守住位置 起止点拼接；改错故障 单点无法成线。',
      '// INV-11 标签取最长线段中点：守住位置 标签计算；改错故障 标签压在节点边框。',
      '// INV-12 空点集兜底原点：守住位置 默认值；改错故障 返回无效坐标。',
      '// INV-13 平移返回新对象：守住位置 平移函数；改错故障 共享坐标被就地改写。',
      '// INV-14 平移后重算标签：守住位置 路径平移；改错故障 标签停在旧坐标。',
      '// INV-15 两阶段必须串行：守住位置 循环内等待；改错故障 共享 worker 状态互相干扰。',
      '// INV-16 worker 必须终止：守住位置 finally；改错故障 后台线程长期残留。',
      '// INV-17 模块求值即计算一次：守住位置 顶层 Promise；改错故障 每个消费者重复布局。',
      '// INV-18 失败保持 rejected：守住位置 顶层 Promise；改错故障 静默重算掩盖错误。',
      '//',
      '// 模块职责：用 ELK 两阶段计算能力地图的区域、群、节点与连线坐标。',
      '// 状态所有权：模块级单例 Promise；布局结果只读共享。',
      '// 阅读顺序：先看两阶段构图，再看坐标提取与平移，最后看主流程拼装。',
    ],
    blocks: [
      {
        anchor: 'function getRequiredNumber(value: number | undefined, description: string) {',
        lines: [
          '缺失即抛错而不是归零。',
          '非有限数同样视为缺失。',
          '错误信息带上字段描述。',
          '避免节点被画到原点。',
        ],
      },
      {
        anchor: 'function buildGroupGraph(groupId: string): ElkNode {',
        lines: [
          '只喂本群节点与群内边。',
          '跨群边留给上层处理。',
          '尺寸使用统一常量。',
        ],
      },
      {
        anchor: 'function buildSystemGraph(',
        lines: [
          '群框按关系顺序输入。',
          '群尺寸来自第一阶段。',
          '缺布局即抛错。',
        ],
      },
      {
        anchor: 'function getRouteLabelPosition(points: ElkPoint[]) {',
        lines: [
          '取最长线段的中点。',
          '空点集兜底原点。',
          '返回合法坐标。',
        ],
      },
      {
        anchor: 'async function calculateCapabilityMapLayout(): Promise<CapabilityMapLayout> {',
        lines: [
          '两阶段串行共用 worker。',
          '结束时必须终止 worker。',
          '任一缺失即整体失败。',
        ],
      },
      {
        anchor: 'export const capabilityMapLayoutPromise = calculateCapabilityMapLayout();',
        lines: [
          '模块求值即开始布局。',
          '全站共享同一份结果。',
          '失败保持 rejected。',
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
    `ZC-deep-b150-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
