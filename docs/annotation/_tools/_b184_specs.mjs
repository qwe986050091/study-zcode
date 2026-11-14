import fs from 'node:fs';

const specs = [
  {
    file: 'apps/zcode-cli/packages/bootstrap/src/app/process-provider-registry-runtime.ts',
    target: 35,
    firstNth: 1,
    header: [
      '// INV-01 路径缺失立即抛错：守住位置 空值判断；改错故障 猜默认目录读到别人的库。',
      '// INV-02 装配顺序即契约：守住位置 调用顺序；改错故障 先建选择仓库再建注册表。',
      '// INV-03 凭据仓库只在独立进程创建：守住位置 独立态判断；改错故障 Host 进程多建一份凭据。',
      '// INV-04 快照解析回调本轮捕获：守住位置 闭包入参；改错故障 异步读到另一份文件。',
      '// INV-05 观测回调异常不外泄：守住位置 捕获分支；改错故障 账号观测错误改变账号事实。',
      '// INV-06 账号恢复按代际比较：守住位置 两版本比较；改错故障 每次检查都强制刷新账号。',
      '// INV-07 凭据变更串行发布：守住位置 顺序等待；改错故障 标题与账号各自发布产生裂口。',
      '// INV-08 失败按后建先关释放：守住位置 逆序语句；改错故障 失败后残留订阅与监听。',
      '// INV-09 成功对象冻结：守住位置 冻结调用；改错故障 调用方改写启动结果。',
      '// INV-10 Host 不能覆盖独立账号：守住位置 独立态判断；改错故障 两侧同时写账号快照。',
      '// INV-11 接收确认不等于应用确认：守住位置 返回值语义；改错故障 未生效也被当作已同步。',
      '// INV-12 释放顺序固定：守住位置 语句顺序；改错故障 先关注册表再撤订阅导致回调落空。',
      '// INV-13 内层失败只释放内层资源：守住位置 捕获分支；改错故障 账号服务被提前销毁。',
      '// INV-14 外层失败释放全部资源：守住位置 逆序语句；改错故障 部分资源泄漏到进程退出。',
      '// INV-15 两个版本都必须非空：守住位置 去空判断；改错故障 空版本写入账号覆盖层。',
      '// INV-16 账号信封整体校验：守住位置 映射解析；改错故障 部分信封落库。',
      '// INV-17 托管账号必须有当前标记：守住位置 类型判断；改错故障 投影不知道当前账号。',
      '// INV-18 状态与覆盖层同快照保留：守住位置 条件展开；改错故障 只更新版本丢了连接事实。',
      '//',
      '// 模块职责：装配进程级 Provider Registry 的三层事实源与可选独立态能力。',
      '// 状态所有权：注册表、账号服务与凭据订阅都归本函数所有，随返回对象释放。',
      '// 阅读顺序：先看选项接口，再看装配主体，最后看信封解析。',
    ],
    blocks: [
      {
        anchor: 'export interface ProcessProviderRegistryRuntimeOptions {',
        lines: [
          '可选面只在独立进程出现。',
          'Host 进程不提供账号与旧配置导入。',
          '字段全部只读。',
        ],
      },
      {
        anchor: 'export async function startProcessProviderRegistryRuntime(',
        lines: [
          '路径缺失直接抛错。',
          '装配顺序固定为三层事实源。',
          '成功返回冻结对象。',
          '失败按后建先关逆序释放。',
        ],
      },
      {
        anchor: 'const runtime = new NodeProviderRegistryRuntime({',
        lines: [
          '内置配置只在独立态接入。',
          '账号来源按需创建。',
          '旧配置导入同样只在独立态。',
        ],
      },
      {
        anchor: 'export function parseProcessAccountProviderConfigSnapshot(input: {',
        lines: [
          '两个版本先各自去空。',
          '账号信封整体校验。',
          '状态与覆盖层同快照返回。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/appTools.ts',
    target: 36,
    header: [
      '// INV-01 同作用域新代际替换旧代际：守住位置 遍历删除；改错故障 页面重载后旧工具仍可调用。',
      '// INV-02 同服务只暴露最新登记实例：守住位置 序号比较；改错故障 旧窗口的工具覆盖新窗口。',
      '// INV-03 登记序号首次分配后不变：守住位置 空值兜底；改错故障 重复登记让旧实例复活。',
      '// INV-04 暴露集合按键名去重：守住位置 集合判断；改错故障 模型看到重名工具。',
      '// INV-05 只返回本实例工具：守住位置 双字段过滤；改错故障 页面看到别人的工具。',
      '// INV-06 运行时不接受即清空会话：守住位置 空值判断；改错故障 本地残留幽灵工具。',
      '// INV-07 认领期与执行期两段计时：守住位置 两次设置；改错故障 页面卡住时模型永远等待。',
      '// INV-08 认领超时注销实例：守住位置 超时分支；改错故障 死页面一直占着工具名。',
      '// INV-09 认领幂等不重置计时：守住位置 已认领判断；改错故障 重放认领无限续命。',
      '// INV-10 只接受本实例认领后的回传：守住位置 实例键比较；改错故障 页面替别人伪造结果。',
      '// INV-11 参数超限在登记前拒绝：守住位置 字节判断；改错故障 大参数先占用调用槽。',
      '// INV-12 结果超限转为失败：守住位置 字节判断；改错故障 巨型结果回灌模型。',
      '// INV-13 每次调用重新解析实例：守住位置 调用内查找；改错故障 已替换实例仍被投递。',
      '// INV-14 中止信号先移除监听再拒绝：守住位置 语句顺序；改错故障 取消后监听泄漏。',
      '// INV-15 失败路径都清理待执行表：守住位置 统一结算；改错故障 模型侧承诺悬挂。',
      '// INV-16 会话关闭先删表再结算：守住位置 语句顺序；改错故障 结算回调把状态写回。',
      '// INV-17 日志带事件名与会话标识：守住位置 日志字段；改错故障 无法按会话排障。',
      '// INV-18 注册表不持久化：守住位置 内存映射；改错故障 重启后恢复已死页面的工具。',
      '//',
      '// 模块职责：会话内 App 提供工具的登记、暴露集合与待执行调用唯一 owner。',
      '// 状态所有权：三份内存状态全部由本注册表持有，会话关闭即清空。',
      '// 阅读顺序：先看宿主接口，再看登记与认领，最后看执行器与同步。',
    ],
    blocks: [
      {
        anchor: 'export interface McpUiAppToolsHost {',
        lines: [
          '暴露集合同步到会话运行时。',
          '信箱只投递给一个实例。',
          '日志与计时器可注入。',
        ],
      },
      {
        anchor: 'export class McpUiAppToolRegistry {',
        lines: [
          '每个会话三份状态。',
          '计时器默认不阻止进程退出。',
          '调用标识可注入便于测试。',
        ],
      },
      {
        anchor: 'register(params: McpUiRegisterAppToolsParams): McpUiRegisterAppToolsResult {',
        lines: [
          '新代际先替换旧代际。',
          '登记序号首次分配后不变。',
          '暴露集合整体替换。',
          '返回只属于本实例的工具。',
        ],
      },
      {
        anchor: 'claim(params: McpUiAppToolCallParams): boolean {',
        lines: [
          '实例键不匹配直接拒绝。',
          '已认领重放仍返回成功。',
          '认领成功后切换到执行期限。',
          '执行超时同样结算为失败。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/bootstrap/src/zcode-protocol/storage-startup.ts',
    target: 34,
    header: [
      '// INV-01 启动标识每次尝试唯一：守住位置 随机标识；改错故障 两次启动状态帧无法区分。',
      '// INV-02 数据库标识只存哈希：守住位置 摘要调用；改错故障 状态帧泄露真实路径。',
      '// INV-03 序号单调递增：守住位置 自增字段；改错故障 Host 丢弃乱序帧时丢错帧。',
      '// INV-04 失败帧只补发一次：守住位置 布尔标记；改错故障 同一失败铺满状态流。',
      '// INV-05 失败帧写入失败保留原错：守住位置 捕获分支；改错故障 传输异常覆盖数据库异常。',
      '// INV-06 写帧等待回调确认：守住位置 等待承诺；改错故障 帧还在缓冲就开始写库。',
      '// INV-07 失败分类取自统一函数：守住位置 分类调用；改错故障 界面无法区分磁盘满与权限。',
      '// INV-08 握手先发路径再等确认：守住位置 语句顺序；改错故障 未确认就打开数据库。',
      '// INV-09 确认行长度受限：守住位置 长度判断；改错故障 超长伪造行拖垮解析。',
      '// INV-10 确认复用才跳过打开：守住位置 布尔判断；改错故障 无授权也跳过迁移。',
      '// INV-11 握手超时给出明确错误：守住位置 定时器；改错故障 Host 不响应时进程永久挂起。',
      '// INV-12 输入关闭按传输断开结算：守住位置 关闭监听；改错故障 关闭后承诺悬挂。',
      '// INV-13 等待承诺预挂空捕获：守住位置 兜底捕获；改错故障 提前失败触发未处理拒绝。',
      '// INV-14 准备完成先关库再通知：守住位置 语句顺序；改错故障 通知到达时库仍被占用。',
      '// INV-15 失败通知后抛原始异常：守住位置 语句顺序；改错故障 调用方拿到通知异常。',
      '// INV-16 清理阶段不掩盖原错：守住位置 失败判断；改错故障 关闭异常覆盖真正原因。',
      '// INV-17 结束清掉超时定时器：守住位置 清理调用；改错故障 定时器拖住进程退出。',
      '// INV-18 本模块不含 Provider 装配：守住位置 文件职责；改错故障 观测边界被提前越过。',
      '//',
      '// 模块职责：协议启动时的存储打开、迁移进度上报与观测边界握手。',
      '// 状态所有权：启动标识、序号与失败标记都在单次调用内。',
      '// 阅读顺序：先看进度上报，再看打开流程，最后看握手准备。',
    ],
    blocks: [
      {
        anchor: 'export async function openProtocolStartupStorage(options: {',
        lines: [
          '启动标识每次尝试唯一。',
          '数据库标识只存哈希。',
          '序号单调递增。',
        ],
      },
      {
        anchor: 'const report = async (progress: SqliteMigrationProgress) => {',
        lines: [
          '失败帧只补发一次。',
          '写帧等待回调确认。',
          '失败分类取自统一函数。',
        ],
      },
      {
        anchor: 'export async function prepareProtocolStartupStorage(options: {',
        lines: [
          '先发路径再等确认。',
          '复用授权才跳过打开。',
          '准备完成先关库再通知。',
        ],
      },
      {
        anchor: 'const acknowledgement = new Promise<boolean>((resolve, reject) => {',
        lines: [
          '确认行长度受限。',
          '超时给出明确错误。',
          '输入关闭按传输断开结算。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/adapters/src/exec/embedded-search-prelude.ts',
    target: 34,
    firstNth: 1,
    header: [
      '// INV-01 非内置搜索不注入：守住位置 类型判断；改错故障 系统搜索被无端改写。',
      '// INV-02 非函数方言不注入：守住位置 方言判断；改错故障 cmd 里出现非法语法。',
      '// INV-03 关闭开关退回原命令：守住位置 空数组分支；改错故障 用户关闭后仍被劫持。',
      '// INV-04 无内容返回原引用：守住位置 三元返回；改错故障 上层判等失效导致重复执行。',
      '// INV-05 先撤别名再定义函数：守住位置 语句顺序；改错故障 旧别名优先于新函数。',
      '// INV-06 Git Bash 保留系统 find：守住位置 方言判断；改错故障 覆盖用户自定义 find。',
      '// INV-07 Windows 路径在 Git Bash 下改写：守住位置 路径归一；改错故障 bash 找不到可执行文件。',
      '// INV-08 UNC 路径同样识别：守住位置 前缀判断；改错故障 网络路径未转换。',
      '// INV-09 函数内先校验后端存在：守住位置 命令探测；改错故障 后端缺失时命令直接报错。',
      '// INV-10 后端缺失退回系统命令：守住位置 或分支；改错故障 搜索完全不可用。',
      '// INV-11 grep 不兼容参数绕回系统：守住位置 分支模式；改错故障 空字节语义被静默改变。',
      '// INV-12 绕回前逐参数扫描：守住位置 循环；改错故障 只检查第一个参数。',
      '// INV-13 rg 回退仅在缺失时定义：守住位置 外壳判断；改错故障 可用 rg 被同名函数遮蔽。',
      '// INV-14 内部命令无原生 rg 不定义：守住位置 早退分支；改错故障 出现必然失败的 rg。',
      '// INV-15 同名 rg 不作回退：守住位置 等值判断；改错故障 探测误报可用。',
      '// INV-16 环境变量赋值先于命令：守住位置 展开顺序；改错故障 后端读到错误分发名。',
      '// INV-17 引用按需加单引号：守住位置 字符判断；改错故障 含空格参数被拆开。',
      '// INV-18 单引号转义完整：守住位置 替换调用；改错故障 参数注入破坏脚本。',
      '//',
      '// 模块职责：生成把 find/grep/rg 指向内置后端的 Bash 启动前缀。',
      '// 状态所有权：无状态；纯字符串拼接，不探测可执行文件。',
      '// 阅读顺序：先看入口与前缀正文，再看三个 shim，最后看调用拼装。',
    ],
    blocks: [
      {
        anchor: 'export function applyEmbeddedSearchPrelude(',
        lines: [
          '有内容才拼接到命令前。',
          '无内容返回原引用。',
          '便于上层判等跳过。',
        ],
      },
      {
        anchor: 'export function buildEmbeddedSearchPreludeContent(',
        lines: [
          '非内置搜索直接返回。',
          '非函数方言直接返回。',
          '关闭开关时不生成函数。',
        ],
      },
      {
        anchor: 'function createFindFunction(backend: EmbeddedSearchBackend): string {',
        lines: [
          '三种后端分别拼命令行。',
          '统一追加默认参数。',
          '位置参数原样透传。',
        ],
      },
      {
        anchor: 'function createFunction(',
        lines: [
          '先校验后端可执行。',
          '缺失时退回系统命令。',
          'grep 额外先走绕回判断。',
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
    `ZC-deep-b184-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
