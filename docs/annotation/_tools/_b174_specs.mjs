import fs from 'node:fs';

const specs = [
  {
    file: 'apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/handlers.ts',
    target: 38,
    header: [
      '// INV-01 活动调用表按会话隔离：守住位置 键前缀；改错故障 关闭一个会话误杀另一个会话的调用。',
      '// INV-02 调用结束即删活动项：守住位置 清理分支；改错故障 取消命中已结束的调用。',
      '// INV-03 已完成墓碑防止标识复用：守住位置 重复检查；改错故障 同一调用标识拿到错配结果。',
      '// INV-04 关闭会话同时清墓碑：守住位置 前缀清理；改错故障 重开会话后旧标识永久失效。',
      '// INV-05 终止返回数量可观测：守住位置 计数返回；改错故障 关闭流程无法判断是否有残留。',
      '// INV-06 归属校验失败即关闭：守住位置 服务器存在性判断；改错故障 非本会话服务器可被访问。',
      '// INV-07 插件标识不作授权依据：守住位置 仅用服务器名；改错故障 展示字段被当成凭证。',
      '// INV-08 处理器集合无实例状态：守住位置 每次请求新建；改错故障 跨请求串用会话状态。',
      '// INV-09 工具必须对页面可见：守住位置 可见性判断；改错故障 仅模型可用的工具被页面调用。',
      '// INV-10 两个取消信号合并：守住位置 信号组合；改错故障 宿主取消无法中断底层请求。',
      '// INV-11 调用前后都检查中止：守住位置 双次抛出；改错故障 已取消仍返回结果。',
      '// INV-12 结果保留原始形状：守住位置 直接返回；改错故障 页面拿到改写后的结构。',
      '// INV-13 日志区分取消与失败：守住位置 状态字段；改错故障 用户取消被记成错误。',
      '// INV-14 清理只删自己登记的项：守住位置 引用比较；改错故障 后到调用被前一次清理误删。',
      '// INV-15 取消未命中仍写墓碑：守住位置 空值分支；改错故障 重复取消产生二次登记。',
      '// INV-16 订阅键绑定实例代次：守住位置 双重相等判断；改错故障 旧页面继续收到推送。',
      '// INV-17 退订与订阅键同构：守住位置 键构造复用；改错故障 退订漏掉真实订阅。',
      '// INV-18 资源读取按大小与类型设限：守住位置 边界函数；改错故障 超大内容内联进页面。',
      '//',
      '// 模块职责：为 MCP App 页面提供工具调用、资源列表、订阅与读取的宿主适配。',
      '// 状态所有权：进行中调用与完成墓碑是模块级表，处理器实例本身无状态。',
      '// 阅读顺序：先看会话级清理，再看归属校验，最后看各处理器与资源边界。',
    ],
    blocks: [
      {
        anchor: 'export function abortMcpUiToolCallsForSession(sessionId: string): number {',
        lines: [
          '关闭会话时先清墓碑，再中断调用。',
          '只处理本会话前缀，避免误伤。',
          '返回被中断的数量供日志核对。',
          '已完成的键也要一并消失。',
        ],
      },
      {
        anchor: 'export async function assertMcpUiServerScope(',
        lines: [
          '归属只看服务器名是否属于本会话。',
          '插件标识不参与授权判断。',
          '校验失败抛专用错误交给协议层。',
          '校验通过才允许触碰会话端口。',
        ],
      },
      {
        anchor: 'export function createMcpUiHandlers(options: CreateMcpUiHandlersOptions = {}): McpUiHandlers {',
        lines: [
          '每次请求新建，不持有实例状态。',
          '所有入口第一步都做归属校验。',
          '工具调用先查重再登记控制器。',
          '取消路径保证重复调用幂等。',
        ],
      },
      {
        anchor: 'function boundUiResourceContents(',
        lines: [
          '总量按文本字节与解码后二进制累加。',
          '类型不在白名单直接拒绝。',
          '二进制缺类型视为不可判定。',
          '超限拒绝而不是截断内容。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/core/src/mcp/app-tools.ts',
    target: 35,
    header: [
      '// INV-01 条目与执行器解耦：守住位置 构造参数；改错故障 工具层反向依赖宿主实现。',
      '// INV-02 超时取三段之和：守住位置 常量表达式；改错故障 认领等待把执行时间挤掉。',
      '// INV-03 只读免审批：守住位置 提示位判断；改错故障 只读工具也弹审批。',
      '// INV-04 破坏性提升风险等级：守住位置 三元判断；改错故障 危险工具按中等风险放行。',
      '// INV-05 页面代码按不可信处理：守住位置 最低风险档；改错故障 沙箱代码获得低风险。',
      '// INV-06 模型侧名字唯一：守住位置 名字格式；改错故障 不同服务器同名工具互相覆盖。',
      '// INV-07 描述携带来源与时效：守住位置 尾段文案；改错故障 页面关闭后模型仍在调用。',
      '// INV-08 输入模式先归一：守住位置 构造时替换；改错故障 缺失属性导致校验崩溃。',
      '// INV-09 输出模式固定：守住位置 常量引用；改错故障 模型侧解析失败。',
      '// INV-10 并发安全由只读或幂等决定：守住位置 布尔合成；改错故障 共享页面状态被并发调用。',
      '// INV-11 副作用范围统一为网络：守住位置 字段常量；改错故障 被误判为本地文件操作。',
      '// INV-12 审批粒度为会话级：守住位置 始终允许选项；改错故障 名字被其他页面复用后越权。',
      '// INV-13 结果预算内联与模型分离：守住位置 两个上限；改错故障 大结果挤爆上下文。',
      '// INV-14 预算策略为截断：守住位置 策略字段；改错故障 大结果整体丢弃。',
      '// INV-15 超时不可被调用方覆盖：守住位置 覆盖开关；改错故障 页面调用绕过期限。',
      '// INV-16 取消声明与清理策略明确：守住位置 取消配置；改错故障 中断后残留待执行调用。',
      '// INV-17 追踪必开但不向适配器传播：守住位置 追踪字段；改错故障 内部标识泄露给页面。',
      '// INV-18 执行入参规范化：守住位置 处理器入口；改错故障 数组被当成对象解构。',
      '//',
      '// 模块职责：把页面提供的 MCP 工具描述转换成 core 可调度的工具条目。',
      '// 状态所有权：无状态；执行器由宿主注入，条目只做静态投影。',
      '// 阅读顺序：先看超时常量与条目构造，再看权限与预算，最后看处理器与模式归一。',
    ],
    blocks: [
      {
        anchor: 'export const MCP_APP_PROVIDED_TOOL_ENTRY_TIMEOUT_MS =',
        lines: [
          '条目超时是三段期限之和。',
          '认领与执行期限由执行器各自判定。',
          '这里只兜住最坏情况。',
          '常量导出供上层对齐超时展示。',
        ],
      },
      {
        anchor: 'export function createMcpAppProvidedToolEntry(',
        lines: [
          '只读即免审批，其余按现有策略。',
          '页面代码不可信，风险至少中等。',
          '条目只描述能力，不执行调用。',
        ],
      },
      {
        anchor: 'handler: async (input: unknown, context: ToolExecutionContext) => {',
        lines: [
          '入参不是对象时按空对象处理。',
          '调用交给宿主注入的执行器。',
          '结果统一走 MCP 结果归一化。',
        ],
      },
      {
        anchor: 'function normalizeObjectSchema(schema: JsonSchema): JsonSchema {',
        lines: [
          '顶层类型强制为对象。',
          '属性缺失时补空表，避免下游判空。',
          '其余字段原样透传。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/dynamic-workflow/src/testing/journal-contract-nodes.ts',
    target: 35,
    header: [
      '// INV-01 用例顺序与拆分前逐字一致：守住位置 注册函数排列；改错故障 失败定位整体偏移。',
      '// INV-02 只登记用例不另开分组：守住位置 文件内容形态；改错故障 套件层级与旧报告不符。',
      '// INV-03 公开面仍由原文件导出：守住位置 调用关系；改错故障 契约套件漏跑本文件。',
      '// INV-04 存储实例按用例新建：守住位置 用例首行工厂调用；改错故障 用例之间互相污染。',
      '// INV-05 运行前先建运行记录：守住位置 建运行调用；改错故障 外键约束先失败。',
      '// INV-06 同键重写是覆盖：守住位置 两次写入与长度断言；改错故障 出现重复行。',
      '// INV-07 冻结身份与宿主事实分列：守住位置 记录字段；改错故障 身份被模型选择覆盖。',
      '// INV-08 缺席字段必须保持缺席：守住位置 整条相等断言；改错故障 升级后旧行比对全线失败。',
      '// INV-09 节点按站点与序号取：守住位置 键参数；改错故障 读到相邻序号的行。',
      '// INV-10 列表过滤同时覆盖种类与结果：守住位置 查询参数；改错故障 结果字段被静默丢弃。',
      '// INV-11 结算整条替换带回输入：守住位置 展开写入；改错故障 输入在结算后消失。',
      '// INV-12 截断输入仍原样回读：守住位置 独立记录；改错故障 截断标记丢失。',
      '// INV-13 报告节点只写一次：守住位置 单次写入；改错故障 出现准入占位行。',
      '// INV-14 报告节点不带执行者坐标：守住位置 字段缺席断言；改错故障 面板显示伪造归属。',
      '// INV-15 空结果与缺席可区分：守住位置 两种记录对照；改错故障 真结果被当成未完成。',
      '// INV-16 边界零值合法：守住位置 相等比较；改错故障 零被当成未记录。',
      '// INV-17 回填是读改写：守住位置 先读后铺开；改错故障 其他列被清空。',
      '// INV-18 边界用于修订截断：守住位置 契约注释与用例；改错故障 前驱失去唯一截断依据。',
      '//',
      '// 模块职责：节点与执行者记录的存储契约用例，从主契约文件拆出以控制单文件行数。',
      '// 状态所有权：无状态；每个用例自建存储实例并自建运行记录。',
      '// 阅读顺序：先看执行者用例，再看节点用例，最后看边界回填与整条替换。',
    ],
    blocks: [
      {
        anchor: 'export function registerNodeCases(factory: () => JournalStorePort): void {',
        lines: [
          '本文件只注册用例，不新建分组。',
          '用例顺序与拆分前保持一致。',
          '由主契约入口按原顺序调用。',
          '每个用例都从新建存储开始。',
        ],
      },
      {
        anchor: 'it("puts, gets and lists nodes", () => {',
        lines: [
          '节点按站点标识与序号定位。',
          '未命中的序号必须返回空。',
          '列表结果按查询参数裁剪。',
        ],
      },
      {
        anchor: "it(\"round-trips a world-read node's bounded input and keeps it absent elsewhere\", () => {",
        lines: [
          '输入与输入哈希同一次写入。',
          '结算整条替换必须带回输入。',
          '截断输入只保留标记与片段。',
        ],
      },
      {
        anchor: 'it("keeps a null node result distinguishable from an absent one", () => {',
        lines: [
          '空结果与没有结果是两件事。',
          '存储层不得把两者压成同一种空。',
          '缺席的可选键要原样缺席。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/office-runtime/src/adapters/parse/docx.ts',
    target: 37,
    header: [
      '// INV-01 解析只处理字节：守住位置 依赖范围；改错故障 解析器耦合文件系统或 DOM。',
      '// INV-02 解压走统一入口：守住位置 打开包调用；改错故障 解压总量限制被绕过。',
      '// INV-03 缺正文即判损坏：守住位置 空值检查；改错故障 空文档被当成成功。',
      '// INV-04 样式表缺失可容忍：守住位置 读样式早退；改错故障 无样式文档整体失败。',
      '// INV-05 段落编号按出现顺序：守住位置 计数拼接；改错故障 锚点重复或跳号。',
      '// INV-06 表格编号独立计数：守住位置 独立数组长度；改错故障 段落与表格锚点冲突。',
      '// INV-07 标题推导分级优先：守住位置 直接级别判断；改错故障 正文被误判为标题。',
      '// INV-08 样式继承链有上限：守住位置 深度循环；改错故障 环引用导致卡死。',
      '// INV-09 可见文本排除删除与域码：守住位置 分支跳过；改错故障 修订内容混入正文。',
      '// INV-10 符号不产出字符：守住位置 空分支；改错故障 出现乱码字形。',
      '// INV-11 单元格文本按段落拼接：守住位置 逐行收集；改错故障 单元格内换行丢失。',
      '// INV-12 嵌套表格递归取文本：守住位置 递归调用；改错故障 嵌套内容整块漏掉。',
      '// INV-13 空段落渲染占位：守住位置 空文本分支；改错故障 锚点行完全消失。',
      '// INV-14 标题渲染至少一个井号：守住位置 级别兜底；改错故障 零级标题没有前缀。',
      '// INV-15 大纲只收前三且有文字：守住位置 过滤条件；改错故障 空标题进入目录。',
      '// INV-16 标题优先文档属性：守住位置 取值顺序；改错故障 首段正文冒充标题。',
      '// INV-17 定位越界统一报错：守住位置 表与单元格检查；改错故障 越界返回空块。',
      '// INV-18 搜索按块顺序且达到上限即停：守住位置 循环中断；改错故障 命中数量失控。',
      '//',
      '// 模块职责：解析 Word 文档为块模型、大纲与可检索的模型文本。',
      '// 状态所有权：无状态；块表与索引只在单次解析内存在。',
      '// 阅读顺序：先看模型与样式读取，再看标题推导与文本提取，最后看解析入口与定位搜索。',
    ],
    blocks: [
      {
        anchor: 'interface Paragraph {',
        lines: [
          '段落模型只保留渲染与检索需要的字段。',
          '锚点串与读、搜接口返回保持一致。',
          '标题级别由直接格式或样式链推导。',
          '列表标记只影响渲染前缀。',
        ],
      },
      {
        anchor: 'async function readStyles(xml: string | null): Promise<Map<string, Style>> {',
        lines: [
          '样式表缺失不算错误，返回空表。',
          '名称缺省回退到样式标识。',
          '大纲级别不声明时保持未定义。',
          '父样式标识留待继承链查找。',
        ],
      },
      {
        anchor: 'function headingLevel(styles: Map<string, Style>, styleId: string | undefined, direct?: number) {',
        lines: [
          '直接格式优先于样式声明。',
          '样式链最多追十层，防止环引用。',
          '标题样式映射到零级。',
          '全部未命中视为正文。',
        ],
      },
      {
        anchor: 'export async function parseDocx(bytes: Uint8Array, label: string): Promise<ParsedDocument> {',
        lines: [
          '正文与样式分别解析。',
          '缺正文文件直接判为损坏。',
          '内容控件等包装层必须下钻。',
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
    `ZC-deep-b174-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
