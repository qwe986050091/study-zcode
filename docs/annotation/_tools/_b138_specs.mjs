import fs from 'node:fs';

const specs = [
  {
    file: 'apps/zcode-cli/packages/adapters/src/config/schema.ts',
    target: 47,
    header: [
      '// INV-01 顶层 schema 用 passthrough：守住位置 对象末尾；改错故障 新增顶层字段被静默丢弃。',
      '// INV-02 MCP 三个分支都 strict：守住位置 服务 schema；改错故障 拼错字段被当成合法配置。',
      '// INV-03 environment 归一为 env：守住位置 解析入口；改错故障 旧配置 server 全被丢弃。',
      '// INV-04 enable 归一为 enabled：守住位置 布尔判断；改错故障 停用状态在 CLI 侧失效。',
      '// INV-05 冲突时以停用为准：守住位置 三目表达式；改错故障 用户关掉的 server 被重新拉起。',
      '// INV-06 remote 归一为 http：守住位置 类型改写；改错故障 外部导入的地址型服务无法加载。',
      '// INV-07 缺 type 时按字段推断：守住位置 双分支；改错故障 历史 app 配置阻断模型加载。',
      '// INV-08 http_headers 归一为 headers：守住位置 条件赋值；改错故障 旧字段鉴权头丢失。',
      '// INV-09 单 server 失败只丢自己：守住位置 循环内 safeParse；改错故障 一条坏配置拖垮整份。',
      '// INV-10 servers 非对象整体丢弃：守住位置 守卫分支；改错故障 数组输入引发致命错误。',
      '// INV-11 诊断码只用固定三类：守住位置 联合类型；改错故障 调用方被迫解析自由文本。',
      '// INV-12 非致命问题走 warning：守住位置 严重级字段；改错故障 局部问题被当成整份失败。',
      '// INV-13 插件 id 统一 canonical：守住位置 映射函数；改错故障 新旧 id 同时存在产生歧义。',
      '// INV-14 别名删除先于写入：守住位置 键迁移；改错故障 canonical 值被旧值覆盖。',
      '// INV-15 suppressedBuiltins 去重：守住位置 reduce；改错故障 同一内置插件出现两次。',
      '// INV-16 skills 只挑已知键：守住位置 抽取函数；改错故障 逐 skill 开关混进全局配置。',
      '// INV-17 覆盖表空则不产出：守住位置 长度判断；改错故障 空对象覆盖下层默认值。',
      '// INV-18 绝对路径才认覆盖：守住位置 路径判定；改错故障 相对键被误当成开关。',
      '//',
      '// 模块职责：定义配置文件的唯一校验形状，并把历史字段归一成运行态补丁。',
      '// 状态所有权：纯解析无状态；诊断数组由调用方传入并就地追加。',
      '// 阅读顺序：先看 schema 定义，再看归一化入口，最后看扁平映射与辅助判定。',
    ],
    blocks: [
      {
        anchor: 'const mcpServerBaseSchema = {',
        lines: [
          '基础字段被三个分支复用。',
          '协议版本与启用位并列。',
          '超时统一用有限正数。',
          '缺字段会让 strict 丢整条。',
          '因此新增字段先加到这里。',
        ],
      },
      {
        anchor: 'const mcpServerSchema = z.preprocess(',
        lines: [
          '预处理先于判别联合。',
          '归一化只改形状不改语义。',
          '判别键决定选哪个分支。',
          '未知类型在校验阶段报错。',
          '单个失败由外层捕获降级。',
        ],
      },
      {
        anchor: 'export const ZCodeConfigFileSchema = z',
        lines: [
          '顶层字段全部可选。',
          '未知键被保留而非拒绝。',
          '每个子域独立 schema。',
          'hook 与权限各有边界。',
          '类型由推导得出不手写。',
        ],
      },
      {
        anchor: 'function normalizeMcpServerConfigInput(value: unknown): unknown {',
        lines: [
          '非对象原样返回。',
          '先复制避免改入参。',
          '旧字段读完立即删除。',
          '类型推断只在缺失时生效。',
          '返回新对象供解析。',
        ],
      },
      {
        anchor: 'function normalizeConfigFileInput(value: unknown, diagnostics: ConfigDiagnostic[]): unknown {',
        lines: [
          '逐层确认对象形状。',
          '缺 servers 直接放行。',
          '非法 servers 换成空表。',
          '逐项校验并记录警告。',
          '合法项原样写回。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/android-emulator-plugin/src/mcp/server.ts',
    target: 46,
    header: [
      '// INV-01 仅暴露工具注册层：守住位置 各 provider 调用；改错故障 业务逻辑回流入口文件。',
      '// INV-02 每个 handler 都过守卫：守住位置 注册回调；改错故障 异常打断 MCP 连接。',
      '// INV-03 异常只保留消息：守住位置 守卫分支；改错故障 堆栈与内部路径泄露给模型。',
      '// INV-04 非 Error 统一字符串化：守住位置 兜底分支；改错故障 抛出物变成未定义文案。',
      '// INV-05 设备参数三件套：守住位置 共享对象；改错故障 各工具参数语义漂移。',
      '// INV-06 启动参数不复用：守住位置 独立对象；改错故障 误把 serial 当成新开模拟器。',
      '// INV-07 构建参数可覆盖：守住位置 合并对象；改错故障 调用方被迫硬编码模块名。',
      '// INV-08 服务名即命名空间：守住位置 实例构造；改错故障 宿主侧工具命名冲突。',
      '// INV-09 只读工具不写盘：守住位置 预检与发现；改错故障 探测动作产生副作用。',
      '// INV-10 写盘工具声明覆盖位：守住位置 创建工具；改错故障 存量文件被静默覆盖。',
      '// INV-11 组合流程失败即停：守住位置 构建并运行；改错故障 失败后继续安装旧产物。',
      '// INV-12 停止模拟器 serial 必填：守住位置 输入 schema；改错故障 误杀真实设备。',
      '// INV-13 打开链接限长：守住位置 长度上限；改错故障 超长输入撑爆设备命令。',
      '// INV-14 截图走图像内容：守住位置 返回构造；改错故障 大图以文本回灌模型上下文。',
      '// INV-15 日志双预算分离：守住位置 行数与字符数；改错故障 两个上限互相顶替。',
      '// INV-16 解析失败不猜坐标：守住位置 UI 解析；改错故障 点击落到错误控件。',
      '// INV-17 按键集合固定：守住位置 枚举声明；改错故障 任意输入事件可注入。',
      '// INV-18 入口阻塞在传输层：守住位置 main；改错故障 进程提前退出导致宿主失联。',
      '//',
      '// 模块职责：注册 Android 工具集，声明参数 schema 并包装结果。',
      '// 状态所有权：无状态；设备与工程状态都在 provider 与外部进程。',
      '// 阅读顺序：先看共享参数，再看服务实例与工具注册，最后看错误守卫。',
    ],
    blocks: [
      {
        anchor: 'const target = {',
        lines: [
          'serial 缺省由 provider 选设备。',
          'avd 只在需要新开时生效。',
          '超时约束整体等待。',
          '三条工具共享同一形状。',
          '改这里会波及十余个工具。',
        ],
      },
      {
        anchor: 'const build = {',
        lines: [
          '构建参数在设备参数之上扩展。',
          '模块与变体都可留空。',
          '应用标识允许显式覆盖。',
          '留空项由发现结果补齐。',
          '组合工具再添加启动项。',
        ],
      },
      {
        anchor: 'const server = new McpServer({',
        lines: [
          '名称与版本对客户端可见。',
          '改名会改变工具命名空间。',
          '实例是注册的唯一入口。',
          '传输在入口函数才连接。',
          '注册顺序不影响调用。',
        ],
      },
      {
        anchor: 'export async function main(): Promise<void> {',
        lines: [
          '仅使用标准输入输出传输。',
          '连接后阻塞在事件循环。',
          '由宿主作为子进程拉起。',
          '初始化失败会让进程退出。',
        ],
      },
      {
        anchor: 'async function guard(work: () => Promise<CallToolResult>): Promise<CallToolResult> {',
        lines: [
          '工具层的唯一错误收敛点。',
          '成功结果原样透传。',
          '异常转成失败结果。',
          '只保留消息不带堆栈。',
          '收敛后连接保持可用。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/components/workflow-timeline/WorkflowRunSettingsFields.tsx',
    target: 43,
    firstNth: 1,
    header: [
      '// INV-01 两个字段都是受控组件：守住位置 props 形状；改错故障 内部状态与服务端值分叉。',
      '// INV-02 只画不取数：守住位置 入参来源；改错故障 组件自行拉取配置产生第二份状态。',
      '// INV-03 模型清单为空时整格退文案：守住位置 提前返回；改错故障 空菜单被渲染成可点控件。',
      '// INV-04 引导项保持引用稳定：守住位置 useMemo；改错故障 memo 组件每次渲染都重算。',
      '// INV-05 徽标缺席即不画：守住位置 可选分支；改错故障 出现空徽标占位。',
      '// INV-06 思考档支持缺席：守住位置 空值判断；改错故障 没有档位时渲染空控件。',
      '// INV-07 禁用时思考档强制关闭：守住位置 open 计算；改错故障 弹层在禁用态仍然展开。',
      '// INV-08 标签走国际化：守住位置 消息 id；改错故障 文案无法随语言切换。',
      '// INV-09 并发下限为一：守住位置 输入校验；改错故障 出现零或负并发。',
      '// INV-10 并发没有上限：守住位置 递增逻辑；改错故障 默认值被误当成天花板。',
      '// INV-11 默认值提示区分两种：守住位置 三元分支；改错故障 停默认值时提示语义错误。',
      '// INV-12 默认值未知则不提示：守住位置 未定义分支；改错故障 老客户端显示错误提示。',
      '// INV-13 空值用占位符：守住位置 输入框取值；改错故障 显示 null 或 NaN。',
      '// INV-14 解析失败不回写：守住位置 有限数判断；改错故障 非法输入把状态写成 NaN。',
      '// INV-15 递减受下限夹取：守住位置 夹取函数；改错故障 减到一以下。',
      '// INV-16 递增不受上限夹取：守住位置 夹取函数；改错故障 无法调高并发。',
      '// INV-17 测试标识稳定：守住位置 data-testid；改错故障 端到端用例找不到控件。',
      '// INV-18 字段标签统一样式：守住位置 标签组件；改错故障 两格排版不一致。',
      '//',
      '// 模块职责：渲染配置弹层里的子代理模型与最大并发两个受控字段。',
      '// 状态所有权：无自有业务状态；只保留弹层开合等临时交互态。',
      '// 阅读顺序：先看模型字段，再看并发步进器，最后看共享标签组件。',
    ],
    blocks: [
      {
        anchor: 'const MODEL_ITEM_NEVER_LOCKED = () => false;',
        lines: [
          '模型项在本场景一律可选。',
          '常量函数避免内联新引用。',
          '锁定判断交给选择组件。',
          '替换时需要同步收紧入口。',
          '当前没有额外锁定条件。',
        ],
      },
      {
        anchor: 'const label = intl.formatMessage({ id: "chat.toolCall.workflow.run.settings.model" });',
        lines: [
          '标签在渲染期解析。',
          '语言切换会带来新文案。',
          '空清单分支复用同一标签。',
          '选择器只接收格式化结果。',
        ],
      },
      {
        anchor: 'function FieldLabel({ children }: { children: string }) {',
        lines: [
          '标签只承担排版。',
          '字号与颜色来自设计变量。',
          '不接收交互属性。',
          '两处字段共用同一形状。',
        ],
      },
      {
        anchor: 'const hint =',
        lines: [
          '提示随默认值变化。',
          '与默认值相等时改写文案。',
          '默认值缺失时整条不画。',
          '数字输入不受提示影响。',
        ],
      },
      {
        anchor: 'onChange={(event) => {',
        lines: [
          '只接受可解析的整数。',
          '解析后立即夹取。',
          '非法输入不写状态。',
          '输入框始终回显受控值。',
        ],
      },
    ],
  },
  {
    file: 'packages/desktop/src/main/processResourceMcpTelemetrySource.ts',
    target: 41,
    header: [
      '// INV-01 每窗口只交一份合计：守住位置 flushPending；改错故障 同一实例被重复计数。',
      '// INV-02 瞬时读数不落盘：守住位置 模块注释与存储；改错故障 采样进入会话或队列。',
      '// INV-03 入参先过 schema：守住位置 解析入口；改错故障 非法结构污染聚合表。',
      '// INV-04 过期样本先清理：守住位置 每次入口；改错故障 陈旧数据长期占用内存。',
      '// INV-05 乱序样本不回溯：守住位置 时间戳比较；改错故障 旧读数覆盖新读数。',
      '// INV-06 重复样本不二次计数：守住位置 相等分支；改错故障 并发转发的样本翻倍。',
      '// INV-07 实例上限保护：守住位置 容量判断；改错故障 异常客户端撑爆内存。',
      '// INV-08 分组键含运行面：守住位置 键构造；改错故障 本地与远程实例被合并。',
      '// INV-09 分组键含环境：守住位置 键构造；改错故障 多环境读数互相污染。',
      '// INV-10 分组键含硬件特征：守住位置 键构造；改错故障 换机后读数被平均。',
      '// INV-11 新鲜度取或：守住位置 合并逻辑；改错故障 已交付样本再次上报。',
      '// INV-12 接收时间取最大：守住位置 合并逻辑；改错故障 有效期被旧样本刷新。',
      '// INV-13 CPU 按核数归一：守住位置 增量换算；改错故障 多核机器读数虚高。',
      '// INV-14 驻留内存累加：守住位置 聚合分支；改错故障 总量只反映单个进程。',
      '// INV-15 单进程峰值取最大：守住位置 聚合分支；改错故障 峰值被最后一个样本覆盖。',
      '// INV-16 外部总量按组覆盖：守住位置 采样回调；改错故障 与真实读数重复叠加。',
      '// INV-17 交付后统一标记：守住位置 窗口末尾；改错故障 下一窗口重复提交。',
      '// INV-18 重置清空全表：守住位置 reset；改错故障 切换会话后残留旧读数。',
      '//',
      '// 模块职责：收集 MCP 实例资源样本，按窗口聚合成外部应用读数。',
      '// 状态所有权：模块级映射保存未交付样本；交付标记随窗口推进。',
      '// 阅读顺序：先看存储结构，再看摄入与分组，最后看采样源实现。',
    ],
    blocks: [
      {
        anchor: 'const MAX_MCP_GROUPS_PER_WINDOW = 32;',
        lines: [
          '每窗口分组数有硬上限。',
          '超出的分组在交付前丢弃。',
          '实例样本另有独立上限。',
          '两个上限保护不同阶段。',
          '调大之前先确认宿主预算。',
        ],
      },
      {
        anchor: 'function purgeExpired(now: number): void {',
        lines: [
          '按接收时间判断过期。',
          '有效期取采样间隔两倍。',
          '过期项直接从映射删除。',
          '摄入与采样都先调用。',
          '清理不区分是否已交付。',
        ],
      },
      {
        anchor: 'export function ingestMcpResourceSamples(',
        lines: [
          '整批样本一次校验。',
          '校验失败整批忽略。',
          '键由四段信息拼成。',
          '时间戳旧于已有样本则跳过。',
          '新样本以未交付状态写入。',
        ],
      },
      {
        anchor: 'function groupSamples(): Map<',
        lines: [
          '按运行面与环境再分组。',
          '硬件特征参与分组键。',
          '首次出现时建好角色骨架。',
          '后续样本就地累加。',
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
    `ZC-deep-b138-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
