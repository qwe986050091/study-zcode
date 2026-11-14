import fs from 'node:fs';

const specs = [
  {
    file: 'apps/zcode-cli/packages/adapters/src/browser/snapshot.ts',
    target: 41,
    firstNth: 1,
    header: [
      '// INV-01 ref 只在最近一次快照内有效：守住位置 句柄替换；改错故障 旧 ref 操作到新页面元素。',
      '// INV-02 句柄表只存 adapter 侧：守住位置 WeakMap；改错故障 不可信页面脚本篡改 ref 映射。',
      '// INV-03 新表就位后释放旧表：守住位置 替换顺序；改错故障 ElementHandle 持续累积。',
      '// INV-04 三个临时句柄必释放：守住位置 末尾 Promise.all；改错故障 每次快照泄漏句柄。',
      '// INV-05 非数字属性立即释放：守住位置 过滤分支；改错故障 无关属性句柄随快照泄漏。',
      '// INV-06 元素数量有上限：守住位置 截断；改错故障 超大页面快照撑爆上下文。',
      '// INV-07 语义节点单列上限：守住位置 独立常量；改错故障 两处上限互相牵连。',
      '// INV-08 截断要显式标记：守住位置 布尔字段；改错故障 模型误以为看到完整页面。',
      '// INV-09 隐藏过滤可关闭：守住位置 参数；改错故障 调试时无法看到零尺寸元素。',
      '// INV-10 可见性为近似判定：守住位置 判定函数；改错故障 遮挡与离屏元素被误判为隐藏。',
      '// INV-11 文本折叠并截断：守住位置 归一化；改错故障 长文本撑爆快照体积。',
      '// INV-12 属性走白名单：守住位置 键列表；改错故障 任意属性被带出页面。',
      '// INV-13 选择器优先安全 id：守住位置 早退；改错故障 特殊字符 id 生成非法选择器。',
      '// INV-14 选择器深度有上限：守住位置 循环条件；改错故障 超深 DOM 生成巨长选择器。',
      '// INV-15 XPath 不截断深度：守住位置 循环；改错故障 精确复用定位失效。',
      '// INV-16 ref 编号按文档顺序：守住位置 映射下标；改错故障 ref 与实际元素错位。',
      '// INV-17 父引用取最近已编号祖先：守住位置 上溯循环；改错故障 层级归属错误。',
      '// INV-18 脱离文档即视为失效：守住位置 isConnected 判定；改错故障 向幽灵元素发命令。',
      '//',
      '// 模块职责：在页面内采集可交互元素与语义 DOM，并维护 ref 到句柄的映射。',
      '// 状态所有权：句柄表按 Page 隔离放在 adapter 侧 WeakMap。',
      '// 阅读顺序：先看采集函数，再看句柄接管，最后看两个解析入口。',
    ],
    blocks: [
      {
        anchor: 'function collectSnapshot(options: SnapshotOptions): SnapshotCollection {',
        lines: [
          '本函数会被序列化进页面执行。',
          '因此不能引用模块闭包。',
          '先采集可交互元素并编号。',
          '再采集语义节点并记录深度。',
          '返回纯数据与元素数组。',
        ],
      },
      {
        anchor: 'export async function captureManagedCdpSnapshot(',
        lines: [
          '采集参数先做下限保护。',
          '结果拆成快照与元素数组。',
          '只有数字键才转成 ref。',
          '新表替换旧表。',
          '旧句柄在替换后统一释放。',
        ],
      },
      {
        anchor: 'export async function resolveSnapshotElement(',
        lines: [
          '只查最近一次快照的表。',
          '查不到直接返回未定义。',
          '连接性判定失败按失效处理。',
          '宁可让调用方重拍快照。',
          '不主动释放调用方句柄。',
        ],
      },
      {
        anchor: 'export async function resolveSnapshotRef(',
        lines: [
          '先解析出元素句柄。',
          '滚动到可见区再取包围盒。',
          '无布局时包围盒为空。',
          '坐标取包围盒中心并取整。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/bootstrap/src/custom-command-shell-expansion.ts',
    target: 41,
    header: [
      '// INV-01 只做语法提取不执行：守住位置 模块边界；改错故障 审批与沙箱职责被绕过。',
      '// INV-02 片段顺序替换：守住位置 主循环；改错故障 多个片段的输出顺序错乱。',
      '// INV-03 片段之间不重叠：守住位置 游标推进；改错故障 嵌套片段被重复执行。',
      '// INV-04 前一片段失败即中断：守住位置 循环内 await；改错故障 失败后继续执行后续片段。',
      '// INV-05 空命令展开为空串：守住位置 早退；改错故障 产生一次无意义子进程。',
      '// INV-06 片段外原文逐字保留：守住位置 拼接；改错故障 换行与缩进被改写。',
      '// INV-07 行内与围栏双正则：守住位置 采集；改错故障 只支持一种语法形态。',
      '// INV-08 同位置围栏优先：守住位置 比较符；改错故障 围栏被误判成行内片段。',
      '// INV-09 扫描后重置 lastIndex：守住位置 函数末尾；改错故障 跨调用漏匹配。',
      '// INV-10 围栏命令先去首尾换行：守住位置 归一化；改错故障 命令带多余换行。',
      '// INV-11 固定超时：守住位置 执行参数；改错故障 片段长期挂起。',
      '// INV-12 输出上限固定：守住位置 预算字段；改错故障 大输出撑爆上下文。',
      '// INV-13 展开结果不落产物：守住位置 persistOutput；改错故障 中间文件残留。',
      '// INV-14 环境变量只注入白名单：守住位置 env 构造；改错故障 CLI 密钥泄露给子进程。',
      '// INV-15 新旧前缀双写：守住位置 赋值；改错故障 旧命令读不到项目目录。',
      '// INV-16 缺上下文先报错再执行：守住位置 校验顺序；改错故障 执行出半成品再失败。',
      '// INV-17 成功条件含退出码：守住位置 判定；改错故障 非零退出被当成成功。',
      '// INV-18 失败错误带命令与详情：守住位置 格式化；改错故障 用户看不到失败原因。',
      '//',
      '// 模块职责：展开自定义命令里的 shell 片段并拼接输出。',
      '// 状态所有权：无状态；正则游标在调用内局部维护。',
      '// 阅读顺序：先看主展开循环，再看片段采集，最后看执行与环境构造。',
    ],
    blocks: [
      {
        anchor: 'export async function expandCustomCommandShellSyntax(input: {',
        lines: [
          '游标之前的原文原样保留。',
          '每个片段单独执行一次。',
          '执行结果直接拼进输出。',
          '游标推进到片段末尾。',
          '末尾剩余原文一次补齐。',
        ],
      },
      {
        anchor: 'function collectShellExpansionMatches(content: string): ShellExpansionMatch[] {',
        lines: [
          '两个正则各自从游标起扫。',
          '取位置更靠前的匹配。',
          '无匹配即结束扫描。',
          '命中后游标跳到片段末尾。',
          '返回前重置两个正则的游标。',
        ],
      },
      {
        anchor: 'async function runShellExpansion(input: {',
        lines: [
          '空命令在此提前返回。',
          '插件上下文可显式给出或推导。',
          '变量校验先于任何执行。',
          '执行参数全部固定。',
          'trace 属性区分片段形态。',
        ],
      },
      {
        anchor: 'function createShellExpansionEnv(input: {',
        lines: [
          '只构造增量补丁。',
          '不传基础环境变量。',
          '项目目录总是可用。',
          '会话与插件变量按需写入。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/bootstrap/src/subagents.ts',
    target: 42,
    header: [
      '// INV-01 迁移先于读取：守住位置 加载入口；改错故障 旧格式文件被当成新格式解析。',
      '// INV-02 迁移失败保留原文件：守住位置 失败分支；改错故障 用户数据在迁移中被删。',
      '// INV-03 迁移失败转诊断：守住位置 循环；改错故障 单个坏文件中断启动。',
      '// INV-04 额外目录按解析路径去重：守住位置 Set 构造；改错故障 同一目录被读两次。',
      '// INV-05 排除当前工作区：守住位置 比较；改错故障 同名目录自我嵌套。',
      '// INV-06 额外目录以 basename 加前缀：守住位置 入队；改错故障 同名 profile 跨目录覆盖。',
      '// INV-07 只读根目录直接文件：守住位置 列目录；改错故障 递归读取拖慢启动。',
      '// INV-08 扩展名只认两种：守住位置 过滤；改错故障 无关文件被当成 profile。',
      '// INV-09 列目录失败按空处理：守住位置 捕获；改错故障 首次启动因缺目录失败。',
      '// INV-10 结果按路径排序：守住位置 排序；改错故障 诊断顺序随文件系统抖动。',
      '// INV-11 解析统一交给纯函数：守住位置 调用；改错故障 禁用态与覆盖逻辑分散在多处。',
      '// INV-12 只遍历已启用插件：守住位置 早退；改错故障 停用插件仍暴露 agent。',
      '// INV-13 模板路径固定拼接：守住位置 路径构造；改错故障 模板里的任意路径被读取。',
      '// INV-14 单模板失败只产诊断：守住位置 逐项处理；改错故障 一个坏模板阻断全部插件。',
      '// INV-15 正名恒带插件前缀：守住位置 命名函数；改错故障 不同插件同名 agent 冲突。',
      '// INV-16 裸名别名要求全局唯一：守住位置 计数；改错故障 别名指向不确定的实现。',
      '// INV-17 保留名不给别名：守住位置 集合判断；改错故障 内置 agent 被插件顶替。',
      '// INV-18 状态文件坏则退空：守住位置 捕获；改错故障 状态损坏导致无法启动。',
      '//',
      '// 模块职责：从用户、项目与插件来源汇总 Agent profile 与诊断。',
      '// 状态所有权：无长驻状态；覆盖与禁用信息经参数传入。',
      '// 阅读顺序：先看磁盘加载，再看插件模板，最后看命名与状态归一。',
    ],
    blocks: [
      {
        anchor: 'export async function loadZCodeAgentProfiles(',
        lines: [
          '先执行两类迁移。',
          '根目录按用户与项目排列。',
          '额外目录去重后再入列。',
          '迁移失败逐条转成诊断。',
          '所有 root 并行读取后拍平。',
        ],
      },
      {
        anchor: 'export function loadPluginAgentTemplates(',
        lines: [
          '同步读盘供启动期调用。',
          '只处理已启用插件。',
          'agent 声明来自组件分组。',
          '路径固定为 agents 目录。',
          '单模板结果互不影响。',
        ],
      },
      {
        anchor: 'export function resolvePluginAgentProfiles(',
        lines: [
          '保留名集合合并外部输入。',
          '先统计裸名出现次数。',
          '覆盖在展开别名之前应用。',
          '唯一且非保留才追加别名。',
          '冲突时保留正名并记诊断。',
        ],
      },
      {
        anchor: 'async function readAgentState(storageRoot: string): Promise<{',
        lines: [
          '任何读取失败都退空状态。',
          '插件覆盖走共享解析器。',
          '内置覆盖只认两个保留名。',
          '禁用标识过滤空串。',
          '未知字段直接忽略。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/core/src/repl/node-repl-session.ts',
    target: 43,
    header: [
      '// INV-01 每次 run 重建 sink：守住位置 run 起始；改错故障 上一次输出串进本次结果。',
      '// INV-02 run 结束清空 sink：守住位置 finally；改错故障 迟到的异步写入污染下次结果。',
      '// INV-03 已释放会话拒绝执行：守住位置 早退；改错故障 释放后仍操作旧 context。',
      '// INV-04 请求元数据随 run 重置：守住位置 结束分支；改错故障 上一轮元数据泄漏到下一轮。',
      '// INV-05 沙箱内定时器受管：守住位置 包装函数；改错故障 cell 创建的定时器无法清理。',
      '// INV-06 重建上下文前先清资源：守住位置 顺序；改错故障 旧定时器在新内核继续写状态。',
      '// INV-07 超时与取消即重建内核：守住位置 判定；改错故障 迟到的续体污染持久状态。',
      '// INV-08 重建后提示需重新初始化：守住位置 消息改写；改错故障 模型连续遇到引用错误。',
      '// INV-09 错误按结构提取：守住位置 归一化；改错故障 跨 realm 错误被当成未知异常。',
      '// INV-10 错误消息不被二次包装：守住位置 提取；改错故障 消息前缀重复。',
      '// INV-11 受限 process 只拦模块入口：守住位置 注入；改错故障 第三方模块拿到完整进程。',
      '// INV-12 图片接受四种输入：守住位置 分支；改错故障 截图结果无法回传。',
      '// INV-13 图片缺载荷即报错：守住位置 末尾判断；改错故障 空图片块进入模型上下文。',
      '// INV-14 结构化结果必须先校验：守住位置 写入前；改错故障 非法内容块进入结果。',
      '// INV-15 元数据只接受普通对象：守住位置 守卫；改错故障 数组或空值被合并进结果。',
      '// INV-16 截图来源按载荷配对：守住位置 索引计算；改错故障 顺序截图被标错来源。',
      '// INV-17 CUA 身份取最后一次：守住位置 末尾取值；改错故障 身份被无身份调用覆盖。',
      '// INV-18 工具面元数据合并保序：守住位置 合并分支；改错故障 后续读取覆盖先前动作。',
      '//',
      '// 模块职责：维护单次会话的持久 JavaScript 执行上下文与输出汇集。',
      '// 状态所有权：context、输出 sink 与注入全局都归本类。',
      '// 阅读顺序：先看类字段与上下文构建，再看 run 主流程，最后看输出通道。',
    ],
    blocks: [
      {
        anchor: 'export class NodeReplSession {',
        lines: [
          '上下文可整体重建。',
          '注入全局支持函数形式按需求值。',
          '受限进程外观可选。',
          '输出 sink 每次 run 重建。',
          '释放标志阻止后续执行。',
        ],
      },
      {
        anchor: 'private buildContext(): Context {',
        lines: [
          '定时器句柄分类登记。',
          '清理函数覆盖两类资源。',
          'console 全部汇入当前 sink。',
          'require 以工作目录为基准。',
          '全局自引用在上下文创建后立即执行。',
        ],
      },
      {
        anchor: 'async run(',
        lines: [
          '起始先判释放状态。',
          '本次输出容器全部新建。',
          'sink 在 try 之前就位。',
          '执行委托给可替换的 executor。',
          '成功与失败返回同一形状。',
        ],
      },
      {
        anchor: 'dispose(): void {',
        lines: [
          '置位后拒绝新执行。',
          '清理沙箱内定时器。',
          '断开输出 sink。',
          '不主动销毁已导出句柄。',
          '上下文由运行时回收。',
          '重复释放无副作用。',
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
    items.push({ anchor: block.anchor, lines: block.lines });
  }
  const total = spec.header.length + spec.blocks.reduce((n, b) => n + b.lines.length, 0);
  if (total !== spec.target) {
    console.error(`TARGET MISMATCH ${spec.file}: ${total} != ${spec.target}`);
    process.exit(1);
  }
  fs.writeFileSync(
    `ZC-deep-b142-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
