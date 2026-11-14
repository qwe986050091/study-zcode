import fs from 'node:fs';

const specs = [
  {
    file: 'apps/zcode-cli/packages/tui/src/app-shiki-diff-view.tsx',
    first: '// 语法高亮的 diff 视图渲染。',
    target: 49,
    header: [
      '// INV-01 视图模式只由终端宽度阈值决定：守住位置 diffViewForWidth；改错故障 宽度非法时两列挤压或布局跳变。',
      '// INV-02 行号宽度与 gutter 尾随空格是常量：守住位置 顶部布局常量；改错故障 行号与标记错位。',
      '// INV-03 统一视图行模型必须保留原始标记与两侧行号：守住位置 buildDiffRows；改错故障 删除行占用新行号导致错位。',
      '// INV-04 行号推进规则按侧独立：守住位置 展平循环的两个自增；改错故障 上下文行行号重复或跳号。',
      '// INV-05 左右对照必须左右行数一致：守住位置 buildSplitDiffRows 的配对；改错故障 行高不齐、滚动错位。',
      '// INV-06 上下文行左右复用同一行对象：守住位置 上下文分支；改错故障 同一行被构造两份，高亮索引分裂。',
      '// INV-07 变更块以首个上下文行收尾：守住位置 内层收集循环；改错故障 跨块配对把远处改动凑成一行。',
      '// INV-08 高亮结果必须带指纹校验后才落地：守住位置 cacheKey 比较；改错故障 旧 Promise 覆盖新内容的高亮。',
      '// INV-09 卸载后迟到的高亮结果必须丢弃：守住位置 副作用内的销毁标记；改错故障 卸载后写状态触发警告。',
      '// INV-10 高亮未完成时必须纯文本兜底：守住位置 highlightChunks 的早退；改错故障 首帧空白或丢行。',
      '// INV-11 片段行数必须与行模型一一对应：守住位置 高亮结果的消费方式；改错故障 行错位着色。',
      '// INV-12 左右单元格按 id 回指统一行序取片段：守住位置 indexById 映射；改错故障 左右行共用错误片段。',
      '// INV-13 行背景与 gutter 背景必须分色：守住位置 两个色调查询；改错故障 行号区与正文混在一起。',
      '// INV-14 截断提示固定缩进且只追加一行：守住位置 truncatedNode；改错故障 提示与正文错位或多行。',
      '// INV-15 指纹构造用 NUL 分隔行 id 与内容：守住位置 diffRowsCacheKey；改错故障 相邻行拼接产生歧义。',
      '// INV-16 shiki 与 opentui 的属性位不可互换：守住位置 位映射函数；改错故障 粗体斜体互相串位。',
      '// INV-17 未知 fontStyle 位直接丢弃：守住位置 四个已知位判断；改错故障 误点亮未定义属性。',
      '// INV-18 非法色值不兜底，由配置错误直接暴露：守住位置 rgba 解析；改错故障 静默使用错误颜色。',
      '//',
      '// 模块职责：把 diff hunk 展平为行模型，按终端宽度选择统一或左右视图，并叠加异步语法高亮。',
      '// 状态所有权：高亮状态由组件本地持有；行模型每次由 patch 纯函数派生，不缓存可变数据。',
      '// 阅读顺序：先看宽度与常量，再读行展平与配对，最后看节点拼装、gutter 与颜色工具。',
    ],
    blocks: [
      {
        anchor: 'const SPLIT_DIFF_WIDTH_BREAKPOINT = 120;',
        lines: [
          '宽度阈值决定左右对照是否启用。',
          '行号宽度固定，保证不同视图的 gutter 对齐。',
          '这些常量同时被布局、gutter 与缓存键使用。',
          '改常量前先确认窄终端的退让路径。',
        ],
      },
      {
        anchor: 'const rgbaCache = new Map<string, RGBA>();',
        lines: [
          '同一主题色在每帧每个片段都会被请求。',
          '缓存避免重复解析十六进制字符串。',
          '缓存无上限，但色值来自有限主题集合。',
        ],
      },
      {
        anchor: 'export function ShikiDiffView(props: {',
        lines: [
          '行模型与指纹都按 patch 记忆化，避免每帧重算。',
          '视图模式由宽度推导，调用方只能强制覆盖。',
          '副作用只做异步高亮，不修改 patch。',
          '[资源] 高亮 Promise 不取消，但结果由销毁标记与指纹双重过滤。',
          '渲染始终返回容器，空 patch 输出空内容。',
        ],
      },
      {
        anchor: 'React.useEffect(() => {',
        lines: [
          '依赖变化时先清空旧高亮，避免旧内容短暂错配。',
          '高亮入参只取纯文本与语言提示，不传样式。',
          '[并发] 迟到的结果同时检查销毁标记与返回空值。',
          '清理函数只置标记，不等待 Promise 结束。',
          '指纹变化必然触发重新高亮。',
        ],
      },
      {
        anchor: 'export function buildDiffRows(hunks: ToolResultDisplayHunk[]): DiffDisplayRow[] {',
        lines: [
          '每个 hunk 从各自的起始行号开始推进。',
          '标记取原始行首字符，内容去掉该前缀。',
          '删除行不占新文件行号，新增行不占旧文件行号。',
          '上下文行两侧行号同时推进。',
          'id 只在当前 patch 内唯一，用作渲染键与高亮索引。',
        ],
      },
      {
        anchor: 'export function buildSplitDiffRows(rows: DiffDisplayRow[]): SplitDiffRow[] {',
        lines: [
          '上下文行直接左右复用同一对象。',
          '变更块按出现顺序分离删除与新增。',
          '配对数量取两侧较大值，多出的一侧留空。',
          '留空位仍生成行，保证两列行高一致。',
          '输出顺序与统一视图行序保持可回指。',
        ],
      },
    ],
  },
  {
    file: 'docs/knip/docs/scripts/generate-plugin-docs.ts',
    first: "import fs from 'node:fs/promises';",
    target: 47,
    header: [
      '// INV-01 所有输出路径都由脚本文件位置推导：守住位置 根目录常量；改错故障 从其他工作目录执行时写到错误位置。',
      '// INV-02 模板目录必须跳过：守住位置 目录遍历判断；改错故障 生成一份无意义的模板文档。',
      '// INV-03 插件元数据只从插件入口模块读取：守住位置 动态导入；改错故障 文档与真实配置脱节。',
      '// INV-04 默认配置按键合并，空数组不写入：守住位置 defaults 构造；改错故障 文档出现空配置块。',
      '// INV-05 文档补充项追加在源码声明之后：守住位置 entry 合并顺序；改错故障 覆盖用户自定义条目。',
      '// INV-06 启用条件文案按声明数量分派：守住位置 enabledText 分支；改错故障 单依赖被写成列表。',
      '// INV-07 启用条件支持字符串、数组与正则三类：守住位置 分支内的类型判断；改错故障 正则源被打印成对象。',
      '// INV-08 默认配置块只在存在条目时生成：守住位置 hasDefaultConfig；改错故障 每页都带空 JSON。',
      '// INV-09 命令行参数说明过滤 binaries 字段：守住位置 argsText 构造；改错故障 内部字段暴露到文档。',
      '// INV-10 值打印必须区分数组、函数与普通值：守住位置 printCode；改错故障 函数被序列化成空对象。',
      '// INV-11 JSON 打印后补空格以便阅读：守住位置 正则替换；改错故障 生成物过于紧凑。',
      '// INV-12 每页固定包含来源链接与生成说明：守住位置 generated 片段；改错故障 无法回溯文档来源。',
      '// INV-13 页面根节点顺序固定：守住位置 tree 构造；改错故障 标题与正文错序。',
      '// INV-14 写文件失败只记录错误并继续：守住位置 writeTree 的捕获；改错故障 单个插件失败中断整轮生成。',
      '// INV-15 序列化配置固定使用 yaml 前置与短横线列表：守住位置 remarkStringify 选项；改错故障 生成物风格漂移。',
      '// INV-16 插件列表按目录名排序：守住位置 末尾排序；改错故障 索引顺序随文件系统变化。',
      '// INV-17 列表标题包含插件总数：守住位置 前置元数据；改错故障 数字与条目不一致。',
      '// INV-18 列表链接指向参考文档相对地址：守住位置 链接构造；改错故障 站点内跳转 404。',
      '//',
      '// 模块职责：扫描 knip 插件目录，为每个插件生成参考文档，并汇总插件索引页。',
      '// 状态所有权：全部为一次性脚本状态；插件清单在内存累积后统一排序写出。',
      '// 阅读顺序：先看路径与解析工具，再读目录遍历中的元数据合并，最后看页面树与索引页。',
    ],
    blocks: [
      {
        anchor: 'const writeTree = async (tree: Node, filePath: string) => {',
        lines: [
          '先运行插件链，再按统一选项序列化。',
          '前置元数据固定为 yaml，列表统一用短横线。',
          '[失败路径] 写文件异常只打印并继续，保证整轮生成不被单页阻断。',
          '该函数是所有文档落盘的唯一出口。',
          '调用方不关心序列化细节，只提供语法树。',
        ],
      },
      {
        anchor: 'for await (const dir of directories) {',
        lines: [
          '只处理目录并跳过模板目录。',
          '每个插件独立导入，元数据以模块导出为准。',
          '标题与目录名成对收集，供索引页复用。',
          '[资源] 目录句柄由 for-await 自动关闭。',
          '循环内不捕获导入错误，缺失插件应显式失败。',
        ],
      },
      {
        anchor: 'const defaults: Record<string, string[]> = {};',
        lines: [
          '配置可声明为函数，按插件目录作为工作目录求值。',
          '源码声明优先写入，文档补充项随后追加。',
          '同一键的补充项不覆盖已有条目，只做拼接。',
          '空数组视为未声明，不写入最终配置。',
          '该对象直接决定默认配置块的 JSON 内容。',
        ],
      },
      {
        anchor: 'const enabledText =',
        lines: [
          '数组声明区分单条与多条两种句式。',
          '单条字符串直接内联到启用说明。',
          '多条声明生成项目符号列表并保留正则源。',
          '字符串声明按 Markdown 片段解析。',
          '未声明时输出始终启用文案。',
        ],
      },
      {
        anchor: 'plugins.sort((a, b) => (a[1] < b[1] ? -1 : 1));',
        lines: [
          '排序键是目录名而不是展示标题。',
          '排序后再生成索引，保证输出稳定。',
          '标题中的总数取自排序后的数组长度。',
          '索引页只包含链接列表与前置元数据。',
          '列表链接使用站点内相对地址。',
        ],
      },
    ],
  },
  {
    file: 'packages/desktop/scripts/gen-ui-fixture/runtime-checks.ts',
    first: 'import assert from "node:assert/strict";',
    target: 47,
    header: [
      '// INV-01 等待条件必须在页面内轮询且有超时：守住位置 waitFor；改错故障 条件永不满足时挂死整个检查。',
      '// INV-02 超时错误必须携带焦点、提示与弹层快照：守住位置 拒绝分支；改错故障 失败时无法定位 DOM 状态。',
      '// INV-03 所有页面操作都通过注入的读取函数执行：守住位置 Read 类型与调用点；改错故障 直接在 Node 侧访问 DOM。',
      '// INV-04 每个探针节点使用独立 id 并在结束时移除：守住位置 探针构造与清理；改错故障 多次运行互相污染。',
      '// INV-05 选项卡切换同时校验显示与隐藏两侧：守住位置 前两组断言；改错故障 只测到单侧导致回归漏检。',
      '// INV-06 键盘事件必须冒泡，才能命中共享处理器：守住位置 KeyboardEvent 参数；改错故障 快捷键检查永远不触发。',
      '// INV-07 动态图标替换后必须重新查询标签名：守住位置 createIcons 前后的断言；改错故障 缓存旧节点导致误判。',
      '// INV-08 悬停提示必须走真实指针事件与延迟路径：守住位置 pointerover 派发；改错故障 脚本聚焦绕过 focus-visible 语义。',
      '// INV-09 提示关闭后必须恢复原有描述引用：守住位置 Escape 后的断言；改错故障 无障碍描述被永久改写。',
      '// INV-10 四种方位逐一校验弹层边界：守住位置 placement 循环；改错故障 某一侧溢出视口未被发现。',
      '// INV-11 每次方位切换后都要重新等待可见：守住位置 循环内的 waitFor；改错故障 读到上一次弹层位置。',
      '// INV-12 触摸点击后弹层只允许存在一个：守住位置 数量断言；改错故障 重复挂载导致叠层。',
      '// INV-13 阴影 DOM 内的事件必须 composed 才能穿透：守住位置 派发参数；改错故障 阴影内提示完全无响应。',
      '// INV-14 阴影宿主移除后弹层必须自动消失：守住位置 末尾等待；改错故障 孤儿弹层残留。',
      '// INV-15 日历初始变体与轮播双向切换都要覆盖：守住位置 轮播断言；改错故障 只验证前进方向。',
      '// INV-16 日历探针的事件选择回调必须记录索引：守住位置 事件监听；改错故障 点击后无法确认选中的是哪一条。',
      '// INV-17 非法日期必须渲染告警且不影响后续复位：守住位置 日期断言；改错故障 组件进入不可恢复状态。',
      '// INV-18 tweak 生命周期以分组数量为观测口径：守住位置 三处等待；改错故障 泄漏的控件被误认为正常。',
      '//',
      '// 模块职责：在真实 Electron 页面中驱动运行时探针，校验组件交互、定位与生命周期。',
      '// 状态所有权：探针节点与全局标记都挂在页面；每个检查结束时负责清理自己创建的内容。',
      '// 阅读顺序：先看等待工具，再读运行时组件检查，最后看日历轮播与 tweak 生命周期。',
    ],
    blocks: [
      {
        anchor: 'const waitFor = (read: Read, predicate: string) =>',
        lines: [
          '在页面内轮询，避免 Node 侧忙等。',
          '超时上限四秒，覆盖动画与延迟路径。',
          '失败时把焦点元素、提示与弹层快照拼进错误。',
          '[失败路径] 拒绝信息必须足以定位问题。',
        ],
      },
      {
        anchor: 'export async function checkRuntimeWidgets(read: Read) {',
        lines: [
          '先验证选项卡切换与键盘导航。',
          '再确认浮动定位与图标库已注入。',
          '随后插入一次性探针，覆盖动态图标、共享面板与提示。',
          '所有探针在函数末尾统一移除。',
          '断言失败会直接抛出，不吞异常。',
        ],
      },
      {
        anchor: 'for (const placement of ["top", "right", "bottom", "left"]) {',
        lines: [
          '每个方位都重设探针位置并触发触摸点击。',
          '弹层边界必须落在视口内，允许一像素误差。',
          '方位断言按上下左右分别检查相对关系。',
          '结束后关闭弹层并确认只剩一个实例。',
        ],
      },
      {
        anchor: 'export async function checkCalendarAndCarousel(read: Read) {',
        lines: [
          '先确认日历已就绪且轮播停在首个变体。',
          '前进与后退各点一次，验证状态可逆。',
          '再挂载带事件与重叠日程的日历探针。',
          '最后移除探针，避免影响后续检查。',
        ],
      },
      {
        anchor: 'const readCalendar = (expression: string) =>',
        lines: [
          '所有日历读取都限定在探针阴影根内。',
          '表达式由调用方提供，函数只负责包裹取值。',
          '这样避免与页面其他日历实例混淆。',
          '返回值直接透传，不做类型转换。',
        ],
      },
      {
        anchor: 'export async function checkTweakLifecycle(read: Read, win: BrowserWindow) {',
        lines: [
          '先创建带滑块的探针并等待分组出现。',
          '通过宿主注入修改值，确认状态同步。',
          '销毁后分组减少且状态回到初值。',
          '重新挂载开关后再次确认分组数量。',
        ],
      },
    ],
  },
  {
    file: 'packages/desktop/scripts/mcp-apps-host-fixture/managed-model-checks.ts',
    first: 'import assert from "node:assert/strict";',
    target: 46,
    header: [
      '// INV-01 页面调用一律通过注入的求值函数执行：守住位置 ui 与 page 两个包装；改错故障 在 Node 侧直接触碰页面对象。',
      '// INV-02 每条命令都携带新的命令标识：守住位置 command 构造；改错故障 重放场景被误判为重复命令。',
      '// INV-03 命令必须声明客户端、会话与签发时间：守住位置 命令载荷；改错故障 服务端拒绝或串会话。',
      '// INV-04 权限等待以输入键匹配：守住位置 permission；改错故障 并发任务拿到彼此的审批。',
      '// INV-05 终止事件等待必须带起始偏移：守住位置 terminal；改错故障 读到上一轮的历史终止事件。',
      '// INV-06 每次开始前记录通知历史长度：守住位置 begin；改错故障 断言命中旧帧。',
      '// INV-07 发送文本必须携带模型选择与构建模式：守住位置 begin 的命令载荷；改错故障 模型回退到默认。',
      '// INV-08 发送回执必须为已接受才继续：守住位置 begin 的断言；改错故障 后续等待在错误前提上超时。',
      '// INV-09 模型请求必须确实产生工具调用：守住位置 begin 的断言；改错故障 页面工具根本没被触发。',
      '// INV-10 重复实时帧只允许执行一次页面调用：守住位置 首个用例；改错故障 锚点切换时重复执行副作用。',
      '// INV-11 锚点切换不得中断已认领的调用：守住位置 用例中的切换与释放顺序；改错故障 合法调用被误取消。',
      '// INV-12 审批挂起时取消必须拒绝迟到的允许：守住位置 第二个用例；改错故障 取消后仍执行页面。',
      '// INV-13 认领前取消必须让认领回执失败：守住位置 第三个用例；改错故障 SDK 处理器被调用。',
      '// INV-14 执行中取消必须传到中止信号：守住位置 第四个用例；改错故障 页面调用继续跑完并写回结果。',
      '// INV-15 重试替换页面后旧目标必须失效：守住位置 末个用例；改错故障 审批落到新页面实例。',
      '// INV-16 页面调用计数断言必须按 key 过滤：守住位置 三处 filter；改错故障 其他用例的调用污染计数。',
      '// INV-17 每个用例结束都要确认终止状态：守住位置 terminal 调用；改错故障 用例之间状态串扰。',
      '// INV-18 环境句柄通过窗口内容 id 获取：守住位置 末个用例的句柄读取；改错故障 对比到错误的页面实例。',
      '//',
      '// 模块职责：在托管 MCP App 夹具中验证模型发起页面工具的发现、审批、取消与重试语义。',
      '// 状态所有权：夹具状态归托管环境；本文件只通过命令、事件与页面求值观察和驱动。',
      '// 阅读顺序：先看命令与等待包装，再读 begin，最后按取消时序逐个读五个用例。',
    ],
    blocks: [
      {
        anchor: 'export async function checkModel(',
        lines: [
          '把页面求值、命令、审批与终止事件拆成四个包装。',
          '审批按输入键匹配，避免并发用例互相认领。',
          '终止事件只认本会话的 turn.terminal。',
          '所有等待都带历史偏移，保证只看本轮。',
        ],
      },
      {
        anchor: 'async function begin(key: string) {',
        lines: [
          '先记录通知历史长度作为本轮偏移。',
          '登记延迟计划后再发送文本，模拟模型先思考。',
          '命令载荷固定构建模式与当前模型选择。',
          '回执必须为已接受，且请求确实带工具。',
          '返回偏移供后续事件等待复用。',
        ],
      },
      {
        anchor: '"model discovers page tool, duplicate live frames execute once across anchor switch",',
        lines: [
          '记录事件偏移后发起一次页面工具调用。',
          '批准审批并等待认领事件被接受。',
          '把同一帧重复投递五次，验证只执行一次。',
          '切换锚点后释放页面调用，结果仍应成功。',
          '最后确认认领事件只有一条且终止状态成功。',
        ],
      },
      {
        anchor: '"model cancellation before claim denies stale claim and never invokes SDK handler",',
        lines: [
          '用门闩卡住认领事件，制造取消窗口。',
          '发送停止命令后再放行门闩。',
          '认领回执必须为未接受。',
          '页面调用计数保持为零，证明处理器未执行。',
          '等待终止事件收尾，避免影响下一用例。',
        ],
      },
      {
        anchor: 'await check("model target stays bound when retry replaces page during approval", async () => {',
        lines: [
          '先保存旧页面实例句柄。',
          '审批挂起期间触发重试并等待进入运行态。',
          '放行审批后终止事件仍应到达。',
          '新实例标识必须变化，且旧页面没有产生调用。',
          '该用例验证审批绑定的是发起时的目标。',
        ],
      },
    ],
  },
  {
    file: 'packages/desktop/src/main/desktopCronScheduler.ts',
    first: '// desktop main 侧的 cron scheduler 进程管理器。',
    target: 48,
    header: [
      '// INV-01 scheduler 进程只通过 utilityProcess 拉起：守住位置 spawn 调用；改错故障 子进程脱离 Electron 生命周期。',
      '// INV-02 子进程环境必须带进程标签与宿主环境：守住位置 env 构造；改错故障 遥测无法区分 scheduler 角色。',
      '// INV-03 派发只路由给可用的本地 host：守住位置 resolveDispatchHost；改错故障 无窗口时任务丢失。',
      '// INV-04 无可用 host 必须回执 transient：守住位置 两处空 host 分支；改错故障 scheduler 永久放弃任务。',
      '// INV-05 退出中拒绝新派发且不等待：守住位置 isDisposing 判断；改错故障 退出延迟被拉长。',
      '// INV-06 转发失败必须回执 transient 并带错误文本：守住位置 两个转发捕获；改错故障 派发悬空不结算。',
      '// INV-07 消息入口必须丢弃非对象载荷：守住位置 消息监听首行；改错故障 非法帧导致主进程异常。',
      '// INV-08 日志级别只允许三档：守住位置 scheduler-log 分支；改错故障 未知级别丢失日志。',
      '// INV-09 闲时活跃计数变化只做透传：守住位置 offpeak-active-count 分支；改错故障 主进程自行推断唤醒状态。',
      '// INV-10 资源样本必须走统一入口校验：守住位置 scheduler-resource-sample 分支；改错故障 非法样本污染遥测。',
      '// INV-11 关闭流程必须幂等：守住位置 disposePromise 缓存；改错故障 重复调用发送多次关闭消息。',
      '// INV-12 关闭消息发出后必须等待退出或强杀：守住位置 dispose 定时器；改错故障 主进程先退出留下孤儿进程。',
      '// INV-13 强杀超时固定为 1.5 秒：守住位置 常量；改错故障 退出体验过慢。',
      '// INV-14 强杀异常必须吞掉，不能阻断收尾：守住位置 定时器内的捕获；改错故障 已经退出的进程让关闭失败。',
      '// INV-15 进程退出必须注销角色注册：守住位置 exit 监听；改错故障 资源面板残留死进程。',
      '// INV-16 CronRun 转发字段必须逐个映射：守住位置 host.postMessage 载荷；改错故障 任务缺少工作区或模型信息。',
      '// INV-17 闲时任务与定时任务使用独立消息类型：守住位置 两个 HostMessageTypes；改错故障 host 侧分派错分支。',
      '// INV-18 唤醒只在非关闭状态发送：守住位置 wake；改错故障 关闭后仍向 scheduler 投递消息。',
      '//',
      '// 模块职责：托管 cron scheduler 子进程，并在 scheduler 与本地 host 之间转发派发请求与结算结果。',
      '// 状态所有权：子进程句柄与关闭状态归本模块；任务与运行结果归 scheduler 与 host 各自持有。',
      '// 阅读顺序：先看接口与常量，再读 spawn，随后读消息路由，最后看关闭流程。',
    ],
    blocks: [
      {
        anchor: 'const DISPOSE_FORCE_KILL_MS = 1_500;',
        lines: [
          '关闭消息发出后最多等待 1.5 秒。',
          '超时即强杀，避免退出流程被卡住。',
          '该常量只影响关闭，不影响正常派发。',
        ],
      },
      {
        anchor: 'export function spawnCronScheduler(deps: CronSchedulerDeps): CronSchedulerHandle {',
        lines: [
          '以固定服务名与无警告参数拉起子进程。',
          '环境继承宿主变量并附加 scheduler 标签。',
          'spawn 后立即登记角色，供资源遥测使用。',
          '关闭状态用标记加 Promise 双重缓存。',
          '所有对外方法都围绕同一个子进程句柄。',
        ],
      },
      {
        anchor: 'child.on("message", (raw: unknown) => {',
        lines: [
          '非对象载荷直接丢弃，不尝试解析。',
          '日志、活跃计数与资源样本各自早退。',
          '派发请求统一在后续分支处理。',
          '该监听不向外抛异常，避免主进程崩溃。',
        ],
      },
      {
        anchor: 'if (msg.type === "cron-dispatch-request") {',
        lines: [
          '关闭中先回执失败，避免把任务交给正在关闭的 host。',
          '没有可用 host 时按瞬态失败回执。',
          '转发成功即返回，结算由 host 回报触发。',
          '转发异常时把错误文本带回 scheduler。',
          '字段逐个映射，不直接透传整条消息。',
        ],
      },
      {
        anchor: 'if (msg.type === "offpeak-dispatch-request") {',
        lines: [
          '闲时任务与定时任务共用 host 选择。',
          '无 host 时同样回执瞬态失败，由 scheduler 自行退避。',
          '消息类型使用独立的 OffPeakRun。',
          '转发失败时保留任务标识，便于 scheduler 重试。',
          '该分支不处理关闭中的特殊回执，由 host 选择兜底。',
        ],
      },
      {
        anchor: 'dispose() {',
        lines: [
          '已有关闭 Promise 时直接复用，保证幂等。',
          '先置关闭标记，再发送关闭消息。',
          '等待子进程退出或超时强杀。',
          '无论哪条路径都只兑现一次 Promise。',
        ],
      },
    ],
  },
  {
    file: 'packages/desktop/src/main/pluginSandbox/registry.ts',
    first: 'import type { PluginSandboxHandle } from "@zcode/shared/mcp-apps";',
    target: 47,
    header: [
      '// INV-01 沙箱标识必须落在 CSP 允许的字符集内：守住位置 createId；改错故障 下划线导致整条 host-source 被忽略。',
      '// INV-02 标识前缀固定，主体去掉随机 UUID 的短横线：守住位置 默认标识生成；改错故障 资源路径与 CSP 不匹配。',
      '// INV-03 幂等键必须覆盖所有者、工作区、会话、内容类型与插件身份：守住位置 idempotencyKey；改错故障 不同插件互相覆盖 HTML。',
      '// INV-04 工作区标识优先于路径：守住位置 幂等键中的工作区字段；改错故障 同一工作区因路径写法不同重复登记。',
      '// INV-05 登记前必须先清理过期条目：守住位置 register 的 pruneExpired；改错故障 过期项占用配额。',
      '// INV-06 命中幂等键时直接返回原句柄，不刷新过期时间：守住位置 已存在分支；改错故障 重复登记让沙箱永不过期。',
      '// INV-07 配额只按条目总数判断：守住位置 maxEntries 检查；改错故障 超限后新插件无法打开。',
      '// INV-08 被引用的条目不参与过期清理：守住位置 pinned 判断；改错故障 活跃页面中途被销毁。',
      '// INV-09 内容类型必须与来源字段一致：守住位置 register 的两段校验；改错故障 缺来源的 MCP App 或带能力的 Gen UI 混入。',
      '// INV-10 Gen UI 与 MCP App 使用不同分区规则：守住位置 partition 构造；改错故障 两类内容共享存储与权限。',
      '// INV-11 CSP 必须由统一构造器生成：守住位置 cspHeader 字段；改错故障 放松策略绕过校验。',
      '// INV-12 句柄只暴露登记输入声明过的呈现字段：守住位置 resourceMetaOf；改错故障 未声明的边框或高度被误启用。',
      '// INV-13 读取必须刷新最近使用时间：守住位置 get；改错故障 活跃沙箱被当成闲置清理。',
      '// INV-14 释放必须校验初始化代际：守住位置 dispose 的 initId 判断；改错故障 旧页面卸载误删新页面沙箱。',
      '// INV-15 按所有者释放要覆盖该窗口全部条目：守住位置 disposeOwner；改错故障 窗口关闭后沙箱泄漏。',
      '// INV-16 用户手势时间戳一次性消费：守住位置 consumeUserGesture；改错故障 一次点击可重复触发敏感能力。',
      '// INV-17 手势有效期固定为五秒：守住位置 常量与新鲜度判断；改错故障 过期手势仍被接受。',
      '// INV-18 关闭回调只在真正移除时触发：守住位置 remove 的 notify 参数；改错故障 重复通知导致端口被二次关闭。',
      '//',
      '// 模块职责：在 main 进程内登记、查询与回收插件 UI 沙箱，并维护幂等键、配额与用户手势状态。',
      '// 状态所有权：条目表与幂等索引都由本注册表持有；沙箱内容与生命周期归 main 进程唯一管理。',
      '// 阅读顺序：先看常量与选项，再读幂等键与清理工具，最后读注册、读取与释放接口。',
    ],
    blocks: [
      {
        anchor: 'const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;',
        lines: [
          '默认存活六小时，覆盖一次完整工作会话。',
          '默认上限六十四条，防止异常插件无限登记。',
          '两个值都可被选项覆盖，便于测试缩短时间。',
        ],
      },
      {
        anchor: 'export function createPluginSandboxRegistry(',
        lines: [
          '时间来源、TTL、上限与标识生成都可注入。',
          '条目表保存完整记录与生命周期计数。',
          '幂等索引把稳定键映射到沙箱标识。',
          '返回值在端口之外额外暴露诊断用的数量与清空方法。',
        ],
      },
      {
        anchor: 'const idempotencyKey = (',
        lines: [
          '键由数组序列化，字段顺序固定。',
          '工作区标识优先，缺失才退回路径。',
          '内容类型缺省为 MCP App。',
          '插件、作用域、服务名与实例令牌共同区分来源。',
        ],
      },
      {
        anchor: 'const remove = (sandboxId: string, notify: boolean) => {',
        lines: [
          '不存在时直接返回，保证重复释放安全。',
          '先删条目再删幂等索引，避免半删除状态。',
          '只有需要通知时才调用宿主回调。',
        ],
      },
      {
        anchor: 'register(input: PluginSandboxRegisterInput): PluginSandboxHandle {',
        lines: [
          '先校验内容类型与来源字段的组合合法性。',
          '登记前清理过期条目，再计算幂等键。',
          '命中已有条目时原样返回，不改变其生命周期。',
          '配额只在新登记时检查。',
          '构造记录时按内容类型选择分区并生成 CSP。',
        ],
      },
      {
        anchor: 'consumeUserGesture(sandboxId) {',
        lines: [
          '没有记录或没有手势时间时直接失败。',
          '新鲜度按五秒窗口判断。',
          '无论是否新鲜都清空时间戳，保证一次性。',
        ],
      },
      {
        anchor: 'clear() {',
        lines: [
          '逐项删除并通知宿主收尾。',
          '遍历中删除当前项是安全的。',
          '清空后幂等索引与条目表同时为空。',
        ],
      },
    ],
  },
];

let index = 0;
for (const spec of specs) {
  const firstItem = { anchor: spec.first, raw: spec.header };
  if (spec.firstNth) firstItem.nth = spec.firstNth;
  const items = [firstItem];
  for (const block of spec.blocks) {
    const item = { anchor: block.anchor, lines: block.lines };
    if (block.nth) item.nth = block.nth;
    items.push(item);
  }
  const total = spec.header.length + spec.blocks.reduce((sum, b) => sum + b.lines.length, 0);
  const bodyTotal = spec.blocks.reduce((sum, b) => sum + b.lines.length, 0);
  console.log(`${spec.file} header=${spec.header.length} body=${bodyTotal} total=${total} expect=${spec.target} ${total === spec.target ? 'OK' : 'MISMATCH'}`);
  fs.writeFileSync(
    `ZC-deep-b106-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  index += 1;
}
