import fs from 'node:fs';

const specs = [
  {
    file: 'packages/zcode-server-cli/src/runtime/paths.ts',
    target: 36,
    header: [
      '// INV-01 默认根目录可由环境变量覆盖：守住位置 读取与兜底拼接；改错故障 部署到不可写目录。',
      '// INV-02 布局路径全部由根目录派生：守住位置 单次解析；改错故障 各处拼接口径不一。',
      '// INV-03 运行期文件集中在运行目录：守住位置 子目录拼接；改错故障 锁与状态文件散落。',
      '// INV-04 控制端点按平台分流：守住位置 平台判断；改错故障 Windows 尝试创建套接字。',
      '// INV-05 端点名需稳定且不泄露路径：守住位置 哈希派生；改错故障 管道名包含完整家目录。',
      '// INV-06 根目录先做绝对化：守住位置 解析调用；改错故障 相对路径随工作目录漂移。',
      '// INV-07 规范化容忍缺失祖先：守住位置 循环回退；改错故障 首次安装直接失败。',
      '// INV-08 只对不存在错误回退：守住位置 错误码判断；改错故障 权限错误被吞掉。',
      '// INV-09 到根即停止回退：守住位置 父目录比较；改错故障 无限循环。',
      '// INV-10 缺失段逆序拼回：守住位置 反转；改错故障 路径层级颠倒。',
      '// INV-11 规范化布局复用同一入口：守住位置 组合函数；改错故障 两套布局字段分叉。',
      '// INV-12 数据根目录按标准结构识别：守住位置 双层名称判断；改错故障 数据写进安装目录。',
      '// INV-13 非标准根保持隔离：守住位置 兜底返回；改错故障 向上扩散污染其他数据。',
      '// INV-14 包含判断按相对路径：守住位置 差分计算；改错故障 前缀相同被误判为内部。',
      '// INV-15 父级引用一律拒绝：守住位置 分段检查；改错故障 路径穿越通过校验。',
      '// INV-16 卸载目标必须绝对：守住位置 绝对性判断；改错故障 相对路径删错目录。',
      '// INV-17 家目录与其父目录受保护：守住位置 双比较；改错故障 误删用户主目录。',
      '// INV-18 非法根目录直接抛错：守住位置 校验函数；改错故障 空根被当成当前盘符。',
      '//',
      '// 模块职责：推导本地服务端的目录布局、控制端点与卸载路径校验。',
      '// 状态所有权：无状态；所有路径都由入参根目录确定性派生。',
      '// 阅读顺序：先看默认根与布局，再看规范化回退，最后看包含判断与卸载校验。',
    ],
    blocks: [
      {
        anchor: 'export function getDefaultServerDataRoot(): string {',
        lines: [
          '未配置时落在用户主目录下的固定子目录。',
          '配置值先去空白，空串同样视为未配置。',
          '默认根本身不创建目录，交给安装流程。',
          '布局推导不读取其他环境变量。',
        ],
      },
      {
        anchor: 'export function resolveServerLayout(serverRoot = getDefaultServerDataRoot()): ServerLayout {',
        lines: [
          '先绝对化，再做所有拼接。',
          '运行目录承载锁、状态与会话端点。',
          '预期与事务文件留在根目录便于人工排查。',
          'Windows 用命名管道，其他平台用套接字。',
        ],
      },
      {
        anchor: 'export async function resolveCanonicalServerRoot(',
        lines: [
          '从目标根开始逐级向上寻找存在祖先。',
          '不存在错误才继续回退，其余原样抛出。',
          '缺失段收集后逆序拼回。',
        ],
      },
      {
        anchor: 'export function isPathWithin(rootPath: string, candidatePath: string): boolean {',
        lines: [
          '两边都先规范化再比较。',
          '以父级引用开头即判定越界。',
          '分段再查一次，防止拼接绕过。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/adapters/src/exec/execution-command.ts',
    target: 36,
    firstNth: 1,
    header: [
      '// INV-01 环境构建不改动进程环境：守住位置 新建对象；改错故障 子进程配置污染父进程。',
      '// INV-02 空环境起点可选：守住位置 基础判断；改错故障 需要隔离时仍继承全部变量。',
      '// INV-03 运行时变量先清洗：守住位置 继承后调用；改错故障 代理与证书变量泄漏给工具。',
      '// INV-04 文本编码注入与平台相关：守住位置 平台入参；改错故障 非 Windows 写入无效变量。',
      '// INV-05 网络出口策略最后应用：守住位置 调用顺序；改错故障 洗干净的网络变量又被覆盖。',
      '// INV-06 删除与设置分两步：守住位置 两个循环；改错故障 同名键残留旧值。',
      '// INV-07 环境键比较按平台语义：守住位置 删除实现；改错故障 Windows 出现重复键。',
      '// INV-08 已解析 shell 优先复用：守住位置 早退返回；改错故障 重复解析导致方言不一致。',
      '// INV-09 仅 posix-bash 配置尝试 Git Bash：守住位置 配置判断；改错故障 系统 shell 被错误替换。',
      '// INV-10 非 Windows 直接 argv：守住位置 平台分支；改错故障 多走一次扩展名解析。',
      '// INV-11 Windows 可执行文件按候选查找：守住位置 解析函数；改错故障 命令找不到。',
      '// INV-12 候选全不存在保留原值：守住位置 兜底返回；改错故障 在此处抛错掩盖真实原因。',
      '// INV-13 批处理脚本强制走解释器：守住位置 扩展名判断；改错故障 直接 spawn 失败。',
      '// INV-14 解释器路径取系统变量：守住位置 大小写不敏感读取；改错故障 自定义 ComSpec 被忽略。',
      '// INV-15 方言跟随 provider：守住位置 字段透传；改错故障 cwd 转换用错规则。',
      '// INV-16 登录 shell 可无副作用降级：守住位置 形态检查；改错故障 非该形态被改坏。',
      '// INV-17 命令行替换保留登录标志：守住位置 参数重组；改错故障 降级后仍带登录参数。',
      '// INV-18 未命中形态退化为整串命令：守住位置 末尾分支；改错故障 旧命令残留在参数里。',
      '//',
      '// 模块职责：把命令描述编译成可 spawn 的文件、参数、shell 与方言。',
      '// 状态所有权：无状态；平台、环境与存在性探测都由调用方注入。',
      '// 阅读顺序：先看环境构建，再看命令解析的三条分支，最后看登录模式与辅助函数。',
    ],
    blocks: [
      {
        anchor: 'export function buildExecutionEnv(',
        lines: [
          '默认从当前进程环境复制，不改原对象。',
          '空环境起点时跳过继承与清洗。',
          '文本编码在网络策略之前注入。',
          '覆盖项的删除先于设置。',
        ],
      },
      {
        anchor: 'export function resolveExecutionCommand(',
        lines: [
          '已解析 shell 只替换命令行文本。',
          '仅 posix 配置尝试外部 bash。',
          '其余 shell 模式交给系统 shell。',
          'argv 模式在 Windows 才需要查扩展名。',
        ],
      },
      {
        anchor: 'export function setResolvedShellLoginMode(',
        lines: [
          '只处理直接执行且带登录标志的形态。',
          '命令行取参数末位。',
          '重组时按开关决定是否保留登录参数。',
        ],
      },
      {
        anchor: 'export function applyResolvedShellCommand(',
        lines: [
          'cmd 方言直接替换整条命令行。',
          '登录形态保留登录标志只换末位。',
          '其他形态退化为文件即命令行。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-process.ts',
    target: 36,
    firstNth: 1,
    header: [
      '// INV-01 平台差异收敛在单文件：守住位置 类职责边界；改错故障 Windows 与 POSIX 逻辑互相污染。',
      '// INV-02 资源遥测只在 Bash 开启：守住位置 双重判断；改错故障 普通命令上报空遥测。',
      '// INV-03 终止原因按优先级归类：守住位置 三元链；改错故障 超时被记成主动终止。',
      '// INV-04 准备阶段不启动进程：守住位置 纯准备注释与实现；改错故障 探测阶段泄漏子进程。',
      '// INV-05 快照环境含提供方覆盖：守住位置 合并表达式；改错故障 探测到的别名与实际执行不符。',
      '// INV-06 快照仅限直接执行形态：守住位置 四条件；改错故障 系统 shell 被注入启动脚本。',
      '// INV-07 有快照即关闭登录模式：守住位置 布尔推导；改错故障 登录重读配置抵消可复现性。',
      '// INV-08 启动脚本作为可选前置：守住位置 可选标记；改错故障 快照被清理后命令直接失败。',
      '// INV-09 cwd 包装后按新命令重解析：守住位置 命令行比较；改错故障 方言与包装文本不匹配。',
      '// INV-10 POSIX 必须独立进程组：守住位置 detached 表达式；改错故障 无法整体清理后代。',
      '// INV-11 标准输入按需接入：守住位置 三元选择；改错故障 无输入时也占用管道。',
      '// INV-12 无进程号退回根进程信号：守住位置 早退分支；改错故障 无法终止时静默卡住。',
      '// INV-13 Windows 用整树强制终止：守住位置 参数列表；改错故障 只杀根进程留下孤儿。',
      '// INV-14 终止器失败仍有兜底：守住位置 错误监听；改错故障 等待永不结算。',
      '// INV-15 Bash 清理纳入关机等待：守住位置 登记表写入；改错故障 关机提前释放资源。',
      '// INV-16 通用进程组保持既有边界：守住位置 分支选择；改错故障 修复能力扩散到其他调用方。',
      '// INV-17 输出接入同时喂收集器与事件：守住位置 双写顺序；改错故障 事件与落盘内容不一致。',
      '// INV-18 排空超时先杀树再销毁：守住位置 三步顺序；改错故障 孙进程持管道导致永久挂起。',
      '//',
      '// 模块职责：把执行请求编译成子进程调用，并负责终止、输出接入与排空。',
      '// 状态所有权：子进程句柄与待清理表由基类持有，本类不缓存跨请求状态。',
      '// 阅读顺序：先看遥测与准备，再看两条终止路径，最后看输出接入与排空。',
    ],
    blocks: [
      {
        anchor: 'export class NodeExecutionAdapterProcess extends NodeExecutionAdapterResults {',
        lines: [
          '进程层只处理平台相关的执行细节。',
          '向上被生命周期层复用，不感知业务。',
          '所有 Windows 与 POSIX 差异收在此处。',
          '类本身不保存跨请求状态。',
        ],
      },
      {
        anchor: 'protected async prepareChildSpawn(request: ExecutionRequest): Promise<PreparedChildSpawn> {',
        lines: [
          '先构环境，再解析命令。',
          '快照探测用最终环境，避免别名错位。',
          '只有直接执行的 posix 配置才做快照。',
          '命令被包装过则重新解析一次。',
        ],
      },
      {
        anchor: 'protected terminateProcessTree(child: ChildProcess, useBashProcessTreeStop: boolean): void {',
        lines: [
          '没有进程号时只对根进程发信号。',
          'Windows 用系统命令整树强杀。',
          'POSIX 分通用组与 Bash 全树两套。',
        ],
      },
      {
        anchor: 'protected async drainChildOutput(',
        lines: [
          '先给固定窗口等待管道自然关闭。',
          '保留型执行必须无限等待。',
          '超时后先杀树，再销毁流。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/core/src/tool/handlers/bash-read-file-state.ts',
    target: 35,
    header: [
      '// INV-01 副作用不改变执行结果：守住位置 全函数捕获；改错故障 Bash 成功被增强逻辑改成失败。',
      '// INV-02 先算提示再回填：守住位置 调用顺序；改错故障 提示基于回填后的新状态。',
      '// INV-03 跳过条件统一判定：守住位置 共享判断函数；改错故障 后台或图片输出污染读状态。',
      '// INV-04 只有写命令才查 stale：守住位置 标记匹配；改错故障 每条命令都遍历已读文件。',
      '// INV-05 缺少端口即静默返回：守住位置 能力检查；改错故障 无端口时抛错。',
      '// INV-06 修改判定需同时晚于两点：守住位置 双比较；改错故障 旧修改被误报。',
      '// INV-07 时间缺失不参与比较：守住位置 归一化函数；改错故障 无效时间产生误报。',
      '// INV-08 stat 失败只跳过该条：守住位置 单条捕获；改错故障 一个文件失败拖垮整批。',
      '// INV-09 提示最多展示固定条数：守住位置 截断常量；改错故障 提示挤占上下文。',
      '// INV-10 回填要求输出未截断：守住位置 字段判断；改错故障 绕过先读后写语义。',
      '// INV-11 来源按退出码过滤：守住位置 条件过滤；改错故障 失败命令被当成已读。',
      '// INV-12 已有状态不重复写：守住位置 查找早退；改错故障 覆盖更精确的既有记录。',
      '// INV-13 只回填普通文件：守住位置 类型判断；改错故障 目录被当作可读文件。',
      '// INV-14 超大文件不回填：守住位置 大小比较；改错故障 一次读取塞满会话状态。',
      '// INV-15 读取截断即放弃：守住位置 结果判断；改错故障 半份内容冒充完整已读。',
      '// INV-16 取消后不再写入：守住位置 中止检查；改错故障 用户取消后仍更新状态。',
      '// INV-17 条目记录修订信息：守住位置 字段兜底链；改错故障 后续编辑判断拿到旧版本。',
      '// INV-18 键包含范围参数：守住位置 键构造；改错故障 局部读取覆盖整文件记录。',
      '//',
      '// 模块职责：Bash 执行后生成过期读取提示，并把确实读到的内容回填到读状态。',
      '// 状态所有权：读状态由执行上下文持有，本模块只按既有键写入条目。',
      '// 阅读顺序：先看入口顺序，再看过期提示，最后看回填与跳过判定。',
    ],
    blocks: [
      {
        anchor: 'export async function applyBashReadFileStateEffects(',
        lines: [
          '入口只有两步，顺序即语义。',
          '提示写回输出对象，供模型看到。',
          '回填失败不影响已产生的输出。',
        ],
      },
      {
        anchor: 'async function createStaleReadFileStateHint(',
        lines: [
          '非写命令不产生过期提示。',
          '只比较命令开始前的已读记录。',
          '修改时间必须同时晚于两点。',
          '提示按相对路径展示并限制条数。',
        ],
      },
      {
        anchor: 'async function backfillReadFileStateFromBash(input: BashReadFileStateEffectsInput): Promise<void> {',
        lines: [
          '截断输出不参与回填。',
          '来源按退出码与内容选择过滤。',
          '已有状态优先，不覆盖。',
        ],
      },
      {
        anchor: 'function shouldSkipBashReadFileStateEffects(output: BashOutput): boolean {',
        lines: [
          '后台任务没有完整正文。',
          '图片输出不代表文本已读。',
          '中断与提供方错误同样跳过。',
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
    `ZC-deep-b173-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
