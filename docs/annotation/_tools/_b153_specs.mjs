import fs from 'node:fs';

const specs = [
  {
    file: 'apps/zcode-cli/packages/adapters/src/exec/outputEncoding.ts',
    target: 40,
    firstNth: 1,
    header: [
      '// INV-01 优先按 UTF-8 解码：守住位置 一次性解码主分支；改错故障 合法 UTF-8 被当成 GBK。',
      '// INV-02 仅确定非法才回退：守住位置 valid 判断；改错故障 尾部截断被误判为非法。',
      '// INV-03 流式模式一次定型：守住位置 mode 变量；改错故障 同一路输出编码混用。',
      '// INV-04 尾部不完整留待拼接：守住位置 incomplete 分支；改错故障 多字节字符被截成乱码。',
      '// INV-05 纯 ASCII 直接返回：守住位置 hasNonAscii；改错故障 无谓进入解码器。',
      '// INV-06 locale 只补空缺：守住位置 isMissingOrCLocale；改错故障 覆盖用户显式设置。',
      '// INV-07 LC_ALL 未设不补：守住位置 undefined 判断；改错故障 压过 LANG 与 LC_CTYPE。',
      '// INV-08 Python 输出强制 UTF-8：守住位置 环境补丁；改错故障 Windows 中文路径乱码。',
      '// INV-09 Windows 环境键大小写不敏感：守住位置 setEnvKey；改错故障 重复键互相覆盖。',
      '// INV-10 覆盖变量优先：守住位置 override 分支；改错故障 无法强制指定编码。',
      '// INV-11 非 Windows 恒为 UTF-8：守住位置 平台判断；改错故障 误用旧代码页。',
      '// INV-12 chcp 探测限时一秒：守住位置 超时选项；改错故障 预检卡住启动。',
      '// INV-13 未知代码页返回空：守住位置 编码存在性检查；改错故障 iconv 抛错。',
      '// INV-14 代码页 65001 视为 UTF-8：守住位置 特殊分支；改错故障 UTF-8 被再转一次。',
      '// INV-15 locale 推断覆盖四语系：守住位置 正则序列；改错故障 中文环境落到 cp437。',
      '// INV-16 超长编码与代理区拒绝：守住位置 码点校验；改错故障 非法字节被静默吞掉。',
      '// INV-17 非 Win 路径直接返回：守住位置 resolve 入口；改错故障 引入多余系统调用。',
      '// INV-18 探测失败仍可解码：守住位置 locale 兜底；改错故障 无 chcp 时抛错。',
      '//',
      '// 模块职责：为 exec 输出注入 UTF-8 locale 并决定一次性与流式解码的编码。',
      '// 状态所有权：纯函数；除 Windows 代码页探测外无副作用。',
      '// 阅读顺序：先看环境补齐，再看 UTF-8 校验，最后看编码解析。',
    ],
    blocks: [
      {
        anchor: 'export function applyExecutionTextEnv(',
        lines: [
          '先解析兜底 locale。',
          '只补缺失或 C/POSIX 的键。',
          'Python 相关变量最后统一补齐。',
        ],
      },
      {
        anchor: 'function analyzeUtf8Buffer(buffer: Buffer): Utf8BufferAnalysis {',
        lines: [
          '逐字节扫描。',
          '截断标记为不完整。',
          '非法即提前返回。',
        ],
      },
      {
        anchor: 'export function decodeExecutionOutputBuffer(',
        lines: [
          '空缓冲直接返回空串。',
          '无 legacy 编码一律按 UTF-8。',
          '确定非法时才回退旧代码页。',
        ],
      },
      {
        anchor: 'export function createExecutionOutputStreamDecoder(legacyOutputEncoding: string | null) {',
        lines: [
          '无 legacy 时直接流式解码。',
          '有 legacy 先进入未知模式。',
          '判定后模式不再切换。',
        ],
      },
      {
        anchor: 'function readWindowsActiveCodePageEncoding(env: NodeJS.ProcessEnv): string | null {',
        lines: [
          '调用 chcp 读取活动代码页。',
          '65001 直接视为 UTF-8。',
          '失败与未知代码页返回空。',
        ],
      },
      {
        anchor: 'export function resolveLegacyExecutionOutputEncoding(options: {',
        lines: [
          '非 Windows 恒为空。',
          '覆盖变量优先且需可用。',
          '其次探测，最后按 locale 推断。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/cli/src/commands-command.ts',
    target: 39,
    header: [
      '// INV-01 子命令缺省为 list：守住位置 args 首项；改错故障 空参报用法错误。',
      '// INV-02 list 拒绝多余参数：守住位置 长度判断；改错故障 拼写错误被静默忽略。',
      '// INV-03 inspect 必须带名字：守住位置 长度与空白检查；改错故障 空名字进入发现层。',
      '// INV-04 未知子命令写用法：守住位置 末段；改错故障 用户只能猜测语法。',
      '// INV-05 用法错误统一出口：守住位置 failUsage；改错故障 文案多处漂移。',
      '// INV-06 退出码只由本层决定：守住位置 返回值；改错故障 低层直接退出进程。',
      '// INV-07 数据写 stdout 诊断写 stderr：守住位置 ctx 分流；改错故障 重定向拿不到数据。',
      '// INV-08 依赖可注入：守住位置 deps 结构；改错故障 单测被迫拉起 bootstrap。',
      '// INV-09 列举实现惰性解析：守住位置 resolve 函数；改错故障 启动即加载重依赖。',
      '// INV-10 工作目录取 cwd 依赖：守住位置 回退 process.cwd；改错故障 单测读到真实目录。',
      '// INV-11 错误统一上报：守住位置 reportCommandsError；改错故障 异常被吞成空输出。',
      '// INV-12 详细模式才附栈：守住位置 verbose 判断；改错故障 默认输出泄露实现细节。',
      '// INV-13 空列表给固定提示：守住位置 早退；改错故障 输出空行难以辨认。',
      '// INV-14 非交互命令加后缀：守住位置 描述格式化；改错故障 headless 误用只能交互的命令。',
      '// INV-15 诊断区仅详细模式：守住位置 appendDiagnostics；改错故障 默认输出被噪声淹没。',
      '// INV-16 列表 JSON 不含正文：守住位置 顶层字段；改错故障 大正文灌进列表输出。',
      '// INV-17 详情 JSON 含截断信息：守住位置 bytesRead 与 sizeBytes；改错故障 调用方无法判断完整度。',
      '// INV-18 可选字段仅在有值时出现：守住位置 条件展开；改错故障 缺失与空串无法区分。',
      '//',
      '// 模块职责：实现 `zcode commands` 的 list 与 inspect 子命令及两种输出格式。',
      '// 状态所有权：无状态；运行环境与发现实现均可注入。',
      '// 阅读顺序：先看入口分发，再看两个子命令，最后看输出格式化。',
    ],
    blocks: [
      {
        anchor: 'export async function runCommandsCommand(',
        lines: [
          '缺省子命令为 list。',
          'list 拒绝多余参数。',
          'inspect 必须带非空名字。',
          '未知子命令输出用法并返回 1。',
        ],
      },
      {
        anchor: 'async function runCommandsListCommand(',
        lines: [
          '工作目录优先取注入值。',
          '惰性解析列举实现。',
          '按 json 选项选择格式。',
          '异常统一交给错误出口。',
        ],
      },
      {
        anchor: 'async function runCommandsInspectCommand(',
        lines: [
          '惰性解析详情实现。',
          '名字原样传给发现层。',
          '详细模式才附正文。',
        ],
      },
      {
        anchor: 'function formatHumanCommandInspection(',
        lines: [
          '先输出固定字段。',
          '可选字段仅在有值时出现。',
          '大小行标记截断状态。',
        ],
      },
      {
        anchor: 'function formatCommandMetadataJson(command: CustomCommandListItem) {',
        lines: [
          '显式列出稳定字段。',
          '可选字段条件展开。',
          '列表与详情共用同一投影。',
        ],
      },
    ],
  },
  {
    file: 'packages/server/src/remote/remoteAssetPreflight.ts',
    target: 39,
    header: [
      '// INV-01 逐个探测远端工具：守住位置 单条 shell 脚本；改错故障 缺工具要到下载时才报。',
      '// INV-02 缺 tar 立即失败：守住位置 抛错分支；改错故障 解压阶段才暴露。',
      '// INV-03 下载器二选一：守住位置 parseDownloadTool；改错故障 未知命令被当成 curl。',
      '// INV-04 校验器三选一：守住位置 parseSha256Tool；改错故障 校验步骤被跳过。',
      '// INV-05 进度能力可选：守住位置 progress 判断；改错故障 无 awk 环境报错。',
      '// INV-06 探测结果结构固定：守住位置 RemoteAssetTools；改错故障 调用方处理缺失字段。',
      '// INV-07 探测命令单一往返：守住位置 命令拼接；改错故障 多次 ssh 往返变慢。',
      '// INV-08 解析按首个等号切分：守住位置 separatorIndex；改错故障 空行被当成键值。',
      '// INV-09 先收 stdout 再等关闭：守住位置 collectStdout；改错故障 输出被截断。',
      '// INV-10 关闭事件可能早于数据：守住位置 排空窗口；改错故障 探测结果丢失。',
      '// INV-11 排空窗口兜底：守住位置 定时器；改错故障 后端不触发 end 时卡死。',
      '// INV-12 只结算一次：守住位置 settled 标记；改错故障 重复 resolve。',
      '// INV-13 错误与关闭同样结算：守住位置 error 监听；改错故障 探测永久挂起。',
      '// INV-14 日志保留选型结果：守住位置 结束日志；改错故障 现场无法判断用了哪个工具。',
      '// INV-15 tar 探测独立入口：守住位置 detectRemoteTarTool；改错故障 只需 tar 时跑全量探测。',
      '// INV-16 非零退出不算成功：守住位置 waitForClose；改错故障 失败被当成功。',
      '// INV-17 缺失提示指向补救：守住位置 错误文案；改错故障 用户不知道装什么。',
      '// INV-18 仅依赖远端 sh：守住位置 命令语法；改错故障 探针在精简镜像上失败。',
      '//',
      '// 模块职责：远端部署前探测 tar、下载器、校验器与进度能力。',
      '// 状态所有权：无状态；每次调用都重新探测。',
      '// 阅读顺序：先看两个探测入口，再看命令构造，最后看输出收集。',
    ],
    blocks: [
      {
        anchor: 'export async function detectRemoteTarTool(',
        lines: [
          '单独探测 tar 一项。',
          '先收集标准输出再等关闭。',
          '解析为键值表。',
          '缺失即抛中文补救提示。',
        ],
      },
      {
        anchor: 'export async function detectRemoteAssetTools(',
        lines: [
          '单次往返探测全部工具。',
          '逐项解析选型。',
          '缺任一必需工具即失败。',
          '结束日志记录最终选型。',
        ],
      },
      {
        anchor: 'function buildPreflightCommand(): string {',
        lines: [
          '逐项探测可用命令。',
          '全部以分号串联。',
          '最后统一输出键值。',
        ],
      },
      {
        anchor: 'function parseToolLines(stdout: string): Record<string, string> {',
        lines: [
          '按首个等号切分。',
          '跳过没有键的行。',
          '值做首尾去空白。',
        ],
      },
      {
        anchor: 'async function collectStdout(stream: StdioStream): Promise<string> {',
        lines: [
          '只结算一次。',
          '数据到达后重排排空窗口。',
          '关闭事件给数据留出排空时间。',
        ],
      },
    ],
  },
  {
    file: 'packages/shared/src/cloudContent.ts',
    target: 39,
    header: [
      '// INV-01 按钮主题缺省为 default：守住位置 transform；改错故障 主题为空字符串。',
      '// INV-02 仅允许 http 与 https：守住位置 协议正则；改错故障 file 协议被放行。',
      '// INV-03 URL 禁止内嵌凭据：守住位置 username 与 password 判断；改错故障 凭据随链接下发。',
      '// INV-04 包体格式固定 zip：守住位置 literal；改错故障 未知格式进入解压。',
      '// INV-05 摘要必须是 64 位十六进制：守住位置 正则；改错故障 校验形同虚设。',
      '// INV-06 包体大小上限 8MB：守住位置 max；改错故障 大文件拖垮预检。',
      '// INV-07 hero 四型封闭：守住位置 判别联合；改错故障 未知类型落到默认分支。',
      '// INV-08 视频必须静音：守住位置 literal true；改错故障 自动播放带声音。',
      '// INV-09 动效速度限制在 0.1~4：守住位置 min 与 max；改错故障 极端速度导致不可用。',
      '// INV-10 沙箱退化为图片：守住位置 fallback；改错故障 加载失败留下空白。',
      '// INV-11 交互数据上限 64000 字节：守住位置 序列化长度；改错故障 超大数据进入消息通道。',
      '// INV-12 事件表最多 16 项：守住位置 键数判断；改错故障 事件数量失控。',
      '// INV-13 动作六型封闭：守住位置 判别联合；改错故障 未知动作被忽略。',
      '// INV-14 外链动作复用安全 URL：守住位置 url 常量；改错故障 绕过协议校验。',
      '// INV-15 按钮最多四个：守住位置 max；改错故障 弹窗布局溢出。',
      '// INV-16 按钮 id 必须唯一：守住位置 superRefine；改错故障 点击命中错误动作。',
      '// INV-17 按钮必须指向存在动作：守住位置 hasOwn；改错故障 点击后毫无响应。',
      '// INV-18 载荷字段全量声明：守住位置 顶层对象；改错故障 新字段被静默丢弃。',
      '//',
      '// 模块职责：定义云端内容弹窗的运行时校验 schema 与推导类型。',
      '// 状态所有权：纯 schema 声明，不持有任何运行状态。',
      '// 阅读顺序：先看按钮主题，再看各类联合，最后看顶层载荷与交叉校验。',
    ],
    blocks: [
      {
        anchor: 'export const cloudButtonThemeSchema = z.object({',
        lines: [
          '主题缺省回落 default。',
          '类名与内联样式各自限长。',
          '未知主题直接拒绝。',
        ],
      },
      {
        anchor: 'const url = z',
        lines: [
          '仅允许 http 与 https。',
          '禁止内嵌用户名与密码。',
          '长度上限 4096。',
          '解析失败即拒绝。',
        ],
      },
      {
        anchor: 'export const contentBundleSchema = z.object({',
        lines: [
          '格式固定为 zip。',
          '摘要要求 64 位小写十六进制。',
          '大小必须为正整数。',
          '大小上限 8MB。',
        ],
      },
      {
        anchor: 'export const cloudContentPayloadSchema = z',
        lines: [
          '顶层字段全量声明。',
          '按钮最多四个。',
          '动作表最多十六项。',
        ],
      },
      {
        anchor: '.superRefine((payload, context) => {',
        lines: [
          '按钮 id 必须唯一。',
          '按钮必须指向已声明动作。',
          '违规逐条记录问题。',
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
    `ZC-deep-b153-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
