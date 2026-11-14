// B222 四个文件的注释 spec 生成器（各新增 30 行）。
import fs from 'node:fs';

const specs = [
  {
    file: 'packages/zcode-server-cli/src/packaging/stageArchives.ts',
    target: 30,
    header: [
      '// INV-01 外部命令统一入口：守住位置 runPackagingCommand；改错故障 各打包点各自拼 shell 参数。',
      '// INV-02 tar 一律改走宿主实现：守住位置 resolveHostTarCommand 调用；改错故障 Windows 命中 Git Bash 的 GNU tar。',
      '// INV-03 zip 在 Windows 走 bsdtar：守住位置 useWindowsTarForZip；改错故障 无 Info-ZIP 环境下打包直接失败。',
      '// INV-04 zip 参数改写：守住位置 ["-acf", ...args.slice(1)]；改错故障 bsdtar 收到不认识的 -qr 报错。',
      '// INV-05 参数数组而非字符串：守住位置 spawn 形参；改错故障 带空格路径被 shell 拆开。',
      '// INV-06 macOS 禁扩展属性：守住位置 --no-xattrs 分支；改错故障 PAX header 刷爆安装日志。',
      '// INV-07 尘土文件抑制：守住位置 COPYFILE_DISABLE；改错故障 归档混入 ._* 条目。',
      '// INV-08 非零退出即拒绝：守住位置 exit 回调；改错故障 打包失败仍产出半成品归档。',
      '// INV-09 退出码带进错误：守住位置 错误消息拼接；改错故障 排查时看不到真实退出码。',
      '// INV-10 文件遍历确定性：守住位置 两次 sort；改错故障 同一输入产生不同摘要。',
      '// INV-11 摘要含相对路径：守住位置 hash.update(`${file}\\0`)；改错故障 文件改名后摘要不变。',
      '// INV-12 目录先展开后哈希：守住位置 stat.isDirectory 分支；改错故障 目录被当普通文件读取。',
      '// INV-13 缺失路径跳过：守住位置 access 的 catch；改错故障 可选产物缺失导致整批打包中断。',
      '// INV-14 临时目录不留残渣：守住位置 前后两次 rm；改错故障 .components 越积越多。',
      '//',
      '// 模块职责：以宿主的 tar/zip 能力把发布目录裁剪成分组件归档，并给出摘要。',
      '// 阅读顺序：先看 runPackagingCommand 的平台改写，再看 hashPaths，最后看 createComponentArchive。',
    ],
    blocks: [
      {
        anchor: 'export async function runPackagingCommand(',
        lines: [
          '所有打包命令都从这里出去。',
        ],
      },
      {
        anchor: 'const useWindowsTarForZip = command === "zip" && process.platform === "win32";',
        lines: [
          'Windows 上没有 zip 时改用 bsdtar。',
        ],
      },
      {
        anchor: 'const baseArgs = useWindowsTarForZip ? ["-acf", ...args.slice(1)] : [...args];',
        lines: [
          '改写参数但不改写输出路径。',
        ],
      },
      {
        anchor: 'const env = isTarCommand(resolvedCommand)',
        lines: [
          'tar 家族统一关掉 AppleDouble。',
        ],
      },
      {
        anchor: 'const commandArgs =',
        lines: [
          'macOS 额外禁用 xattr 写入。',
        ],
      },
      {
        anchor: 'const child = spawn(resolvedCommand, commandArgs, {',
        lines: [
          '输出直通父进程，不缓存大日志。',
        ],
      },
      {
        anchor: 'child.once("exit", (code) => {',
        lines: [
          '只有 0 才算成功。',
        ],
      },
      {
        anchor: 'async function listFiles(root: string): Promise<string[]> {',
        lines: [
          '目录展开成相对路径列表。',
        ],
      },
      {
        anchor: 'export async function hashPaths(',
        lines: [
          '摘要与字节数一次遍历产出。',
        ],
      },
      {
        anchor: 'hash.update(`${file}\\0`);',
        lines: [
          '路径参与摘要，防止改名碰撞。',
        ],
      },
      {
        anchor: 'export async function createComponentArchive(',
        lines: [
          '先算摘要，再用摘要命名临时目录。',
        ],
      },
      {
        anchor: 'const extension = target.startsWith("win32-") ? "zip" : "tar.gz";',
        lines: [
          '归档格式由目标平台决定。',
        ],
      },
      {
        anchor: 'if (extension === "zip") {',
        lines: [
          '两种格式共用同一份临时树。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/adapters/src/fs/text-range-reader.ts',
    target: 30,
    firstNth: 1,
    header: [
      '// INV-01 只读契约：守住位置 全文件；改错故障 范围读取产生写入或删除副作用。',
      '// INV-02 行号从 0 起：守住位置 normalizeOffsetLine；改错故障 返回的 startLine 整体偏移一行。',
      '// INV-03 双路径同语义：守住位置 readRangeFast / readRangeStreaming；改错故障 大文件与小文件切片结果不一致。',
      '// INV-04 大小门禁先于读取：守住位置 assertWithinMaxBytes；改错故障 超限文件仍被整读进内存。',
      '// INV-05 快慢路径阈值：守住位置 FAST_PATH_MAX_BYTES；改错故障 10MB 边界两侧行为跳变不可预期。',
      '// INV-06 取消可中断：守住位置 throwIfAborted 与 abort 监听；改错故障 用户取消后仍读完整个大文件。',
      '// INV-07 流式内存与行数无关：守住位置 carry + selectedLines；改错故障 保留全部行导致内存暴涨。',
      '// INV-08 跨块残行保留：守住位置 carry 的 pop/push；改错故障 块边界处丢字符。',
      '// INV-09 末行不丢：守住位置 decoder.end 与 sawAnyBytes 分支；改错故障 无换行结尾的文件少一行。',
      '// INV-10 行尾统一去 CR：守住位置 normalizeCompletedLine；改错故障 返回内容残留 \\r。',
      '// INV-11 编码探测只看头部：守住位置 ENCODING_SAMPLE_BYTES；改错故障 为探测编码读完整文件。',
      '// INV-12 样本补齐不扩样：守住位置 getUtf8CompletionBytes；改错故障 扩样再次切断下一个字符。',
      '// INV-13 句柄必然关闭：守住位置 detectEncodingFromHead 的 finally；改错故障 句柄泄漏。',
      '// INV-14 revision 取整文件：守住位置 revisionId(mtime,size)；改错故障 偏移读取的 revision 与全文不一致。',
      '//',
      '// 模块职责：按行范围读取文本文件，小文件整读切片，大文件流式只保留目标行。',
      '// 阅读顺序：先看入口的分流，再看两条读取路径，最后看编码探测与行选择工具。',
    ],
    blocks: [
      {
        anchor: 'export async function readTextFileRangeFromNode(',
        lines: [
          '入口只做门禁与快慢分流。',
        ],
      },
      {
        anchor: 'if (info.size <= FAST_PATH_MAX_BYTES) {',
        lines: [
          '阈值内整读，阈值外流式。',
        ],
      },
      {
        anchor: 'function assertWithinMaxBytes(path: string, sizeBytes: number, maxBytes: number | undefined): void {',
        lines: [
          '未配置上限时不拦截。',
        ],
      },
      {
        anchor: 'async function readRangeFast(',
        lines: [
          '整读后统一换行再切片。',
        ],
      },
      {
        anchor: 'const normalized = isText ? normalizeLineEndings(rawContent) : rawContent;',
        lines: [
          '只有文本编码才做换行归一。',
        ],
      },
      {
        anchor: 'const lines = normalized.length === 0 ? [] : normalized.split("\\n");',
        lines: [
          '空文件不能切出一行空串。',
        ],
      },
      {
        anchor: 'async function readRangeStreaming(',
        lines: [
          '流式路径不保留范围外的行。',
        ],
      },
      {
        anchor: 'const stream = createReadStream(request.path);',
        lines: [
          '读取用流，避免整文件驻留。',
        ],
      },
      {
        anchor: 'for await (const chunk of stream) {',
        lines: [
          '逐块解码并按行切分。',
        ],
      },
      {
        anchor: 'async function detectEncodingFromHead(',
        lines: [
          '只读头部样本推断编码。',
        ],
      },
      {
        anchor: 'if (missingBytes > 0) sample = Buffer.concat([sample, Buffer.alloc(missingBytes)]);',
        lines: [
          '只补足当前字符缺的字节。',
        ],
      },
      {
        anchor: 'function shouldSelectLine(',
        lines: [
          '行选择同时受偏移与条数约束。',
        ],
      },
      {
        anchor: 'function revisionId(mtimeMs: number, sizeBytes: number): string {',
        lines: [
          '版本号表达整文件而非所选区间。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/bootstrap/src/app/node-repl-browser-broker.ts',
    target: 30,
    header: [
      '// INV-01 仅本机可达：守住位置 createSocketPath；改错故障 broker 暴露到网络。',
      '// INV-02 双因子凭证：守住位置 token 常量比较；改错故障 仅凭 socket 路径即可调用浏览器。',
      '// INV-03 常量时间比较：守住位置 timingSafeEqual；改错故障 token 可被逐字节试探。',
      '// INV-04 长度先比：守住位置 actual.length 判断；改错故障 timingSafeEqual 抛错变 500 而非 401。',
      '// INV-05 请求体上限：守住位置 MAX_REQUEST_BYTES；改错故障 对端可推爆内存。',
      '// INV-06 schema 强校验：守住位置 nodeReplBrowserBrokerRequestSchema.parse；改错故障 未知字段被静默接受。',
      '// INV-07 失败也回 id：守住位置 requestIdFromPayload；改错故障 客户端收到 id 不匹配的错误。',
      '// INV-08 错误不外泄堆栈：守住位置 respond 的 message 归一；改错故障 内部堆栈进入浏览器端。',
      '// INV-09 socket 错误全生命周期监听：守住位置 顶部 socket.on("error")；改错故障 EPIPE 变成未捕获事件击穿进程。',
      '// INV-10 对端断开视为取消：守住位置 abortController.abort；改错故障 已断开的请求继续跑浏览器操作。',
      '// INV-11 不可写就不回写：守住位置 socket.writable 判断；改错故障 写已销毁 socket 抛 EPIPE。',
      '// INV-12 close 幂等：守住位置 先 await ready 再关；改错故障 同步工厂下 socket 泄漏。',
      '// INV-13 不延长进程寿命：守住位置 server.unref；改错故障 空 broker 撑住 CLI 退出。',
      '// INV-14 注入不改正本：守住位置 injectNodeReplBrowserBroker 的展开；改错故障 共享配置快照被就地修改。',
      '//',
      '// 模块职责：node_repl MCP 子进程与宿主浏览器能力之间的私有 IPC broker。',
      '// 阅读顺序：先看工厂与 socket 路径，再看注入函数，最后看单请求的鉴权与执行。',
    ],
    blocks: [
      {
        anchor: 'export interface NodeReplBrowserBroker {',
        lines: [
          '句柄只暴露关闭、就绪、路径与令牌。',
        ],
      },
      {
        anchor: 'export function createNodeReplBrowserBroker(input: {',
        lines: [
          '工厂同步返回，就绪由 ready 表达。',
        ],
      },
      {
        anchor: 'const server = createServer((socket) => {',
        lines: [
          '每条连接独立处理，失败只记 warn。',
        ],
      },
      {
        anchor: 'server.unref();',
        lines: [
          'broker 不阻止进程自然退出。',
        ],
      },
      {
        anchor: 'close: async () => {',
        lines: [
          '关闭顺序：等就绪、关服务、清文件。',
        ],
      },
      {
        anchor: 'export function injectNodeReplBrowserBroker(',
        lines: [
          '只改 node_repl 一项，其余原样复制。',
        ],
      },
      {
        anchor: 'if (!broker) return servers;',
        lines: [
          '无 broker 时返回同一引用。',
        ],
      },
      {
        anchor: 'function createSocketPath(platform: NodeJS.Platform | string): string {',
        lines: [
          'Windows 用命名管道，其余用临时 socket。',
        ],
      },
      {
        anchor: 'async function handleSocket(',
        lines: [
          '单连接全流程：读、校验、鉴权、执行。',
        ],
      },
      {
        anchor: 'socket.on("error", (error) => {',
        lines: [
          '错误监听覆盖写响应阶段。',
        ],
      },
      {
        anchor: 'function authorizeRequest(request: NodeReplBrowserBrokerRequest, input: { token: string }): void {',
        lines: [
          '令牌不符直接抛错，不做降级。',
        ],
      },
      {
        anchor: 'async function executeRequest(',
        lines: [
          'list 与 execute 共用同一 trace 与取消信号。',
        ],
      },
      {
        anchor: 'async function readLine(socket: Socket, signal: AbortSignal): Promise<string> {',
        lines: [
          '读到换行为止，超限或取消即拒绝。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/bootstrap/src/app/startup-marks.ts',
    target: 30,
    header: [
      '// INV-01 只记计时事件：守住位置 全部导出函数；改错故障 启动埋点顺手改配置或插件状态。',
      '// INV-02 插件事实唯一：守住位置 resolveStartupPlugins 返回值；改错故障 后续阶段重新发现一次插件。',
      '// INV-03 抑制集合必须传入：守住位置 suppressedBuiltins；改错故障 已卸载的内置插件复活。',
      '// INV-04 默认开启名单必须传入：守住位置 officialPluginsEnabledByDefault；改错故障 skills 列表显示启用但会话报找不到。',
      '// INV-05 技能门在发现之后：守住位置 filterVisualizeSkillRoots；改错故障 未开 visualize 仍暴露该技能。',
      '// INV-06 事件名与阶段固定：守住位置 event / stage 字段；改错故障 计时看板无法按阶段聚合。',
      '// INV-07 只记来源布尔：守住位置 configSource* 字段；改错故障 配置内容进入日志。',
      '// INV-08 只记计数：守住位置 mcpServerCount / toolCount；改错故障 工具名与密钥落盘。',
      '// INV-09 阶段语义固定：守住位置 各函数注释中的 stage；改错故障 同名阶段出现两次导致耗时翻倍。',
      '// INV-10 顺序由调用方保证：守住位置 本模块无内部状态；改错故障 埋点之间产生隐式依赖。',
      '// INV-11 计时器由外部注入：守住位置 startupTimer 参数；改错故障 模块自建计时器，单测无法断言。',
      '// INV-12 参数只读：守住位置 全部 input 解构；改错故障 调用方配置被就地改写。',
      '// INV-13 resume 与注入状态入首事件：守住位置 startAppStartup 的 context；改错故障 无法解释冷启动差异。',
      '// INV-14 调试摘要受 logger 级别约束：守住位置 logger.debug；改错故障 生产环境默认落盘调试信息。',
      '//',
      '// 模块职责：启动各阶段的计时与调试埋点，只产出事件，不承载业务状态。',
      '// 阅读顺序：先看插件发现，再看四个阶段标记，最后看启动完成与调试摘要。',
    ],
    blocks: [
      {
        anchor: 'export function resolveStartupPlugins(input: {',
        lines: [
          '启动期只做一次插件发现。',
        ],
      },
      {
        anchor: 'const pluginStorageRoot =',
        lines: [
          '存储根可由调用方覆盖。',
        ],
      },
      {
        anchor: 'officialPluginsEnabledByDefault: DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS,',
        lines: [
          '默认开启名单必须显式传入。',
        ],
      },
      {
        anchor: 'pluginOutcome.skillRoots = filterVisualizeSkillRoots(',
        lines: [
          '技能根在发现结果上就地收窄。',
        ],
      },
      {
        anchor: 'input.startupTimer.mark("ZCode plugins resolved", {',
        lines: [
          '插件结果只上报计数。',
        ],
      },
      {
        anchor: 'export function startAppStartup(input: {',
        lines: [
          '首事件记录冷启动的两个前提。',
        ],
      },
      {
        anchor: 'export function markConfigurationLoaded(input: {',
        lines: [
          '配置阶段只记三个来源是否命中。',
        ],
      },
      {
        anchor: 'export function markStorageAdaptersInitialized(input: {',
        lines: [
          '存储阶段区分自有与注入实现。',
        ],
      },
      {
        anchor: 'export function markMcpAdapterInitialized(input: {',
        lines: [
          'MCP 阶段只代表配置与信任就绪。',
        ],
      },
      {
        anchor: 'export function markRuntimeConstructed(input: {',
        lines: [
          'runtime 构造完成时子装配线尚未挂载。',
        ],
      },
      {
        anchor: 'export function completeAppStartup(input: {',
        lines: [
          '总事件是最后一条计时记录。',
        ],
      },
      {
        anchor: 'export function debugRuntimeConfigResolved(input: {',
        lines: [
          '调试摘要只在 debug 级别输出。',
        ],
      },
      {
        anchor: 'input.logger.debug("Runtime config resolved", {',
        lines: [
          '字段均为计数或布尔，不含正文。',
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
    `ZC-deep-b222-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
