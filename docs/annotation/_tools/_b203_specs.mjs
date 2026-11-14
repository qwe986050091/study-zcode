import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/settings/model-provider-section/ProviderModelModalityOptions.tsx',
    target: 31,
    header: [
      '// INV-01 可见模态固定四项：守住位置 INPUT_MODALITY_OPTIONS；改错故障 设置页出现没有附件入口的选项。',
      '// INV-02 audio 只在 Draft 中保留不进入 UI：守住位置 常量注释约定；改错故障 用户开启后却无法真正使用。',
      '// INV-03 text 恒为选中且不可关闭：守住位置 disabled 判断与 selected 兜底；改错故障 模型被配置成不接受纯文本。',
      '// INV-04 切换其他模态时必须把 supportsText 置真：守住位置 onChange 的展开；改错故障 顺手把 text 关掉。',
      '// INV-05 覆盖标记只对非 text 生效：守住位置 overridden 的取反；改错故障 text 永远显示被覆盖。',
      '// INV-06 覆盖来源二选一：overrideFields 优先于 personalValue；改错故障 两套状态各说各话。',
      '// INV-07 字段映射与选项表必须同步：守住位置 INPUT_MODALITY_FIELDS 的 satisfies；改错故障 新增模态没有对应字段。',
      '// INV-08 禁用按钮保持不透明：守住位置 disabled 透明度类；改错故障 锁定项在深色下看不清。',
      '// INV-09 锁定图标只在禁用时出现：守住位置 条件渲染；改错故障 普通选项也显示锁。',
      '// INV-10 aria-pressed 反映真实选中：守住位置 Button 属性；改错故障 读屏软件读不出开关状态。',
      '// INV-11 组件完全受控：守住位置 无本地 state；改错故障 草稿与表单显示不一致。',
      '// INV-12 key 用模态名：守住位置 map 的 key；改错故障 顺序调整后节点重建。',
      '// INV-13 文案 key 由模态名拼接：守住位置 formatMessage；改错故障 新增模态直接显示原始 key。',
      '//',
      '// 模块职责：模型输入模态的多选按钮组，支持个人覆盖标记。',
      '// 阅读顺序：先看选项表与字段映射，再看禁用与覆盖判定，最后看切换时的字段更新。',
    ],
    blocks: [
      {
        anchor: 'const INPUT_MODALITY_OPTIONS = ["text", "image", "video", "pdf"] as const;',
        lines: [
          '这四个是当前有附件入口的模态，顺序即展示顺序。',
          'pdf 曾经漏掉，导致用户无法修正输入事实，不要按旧版删回三项。',
          'audio 只在草稿里无损保留，加进这里之前必须先有入口。',
        ],
      },
      {
        anchor: 'function ModalityOption({',
        lines: [
          '单项按钮只负责展示与回调，选中状态完全由外部传入。',
          'overridden 只影响边框与配色，不改变可点击性。',
          '禁用态保留完整不透明度，锁定应靠图标而不是变淡表达。',
        ],
      },
      {
        anchor: 'const selected = {',
        lines: [
          '把草稿字段摊平成以模态名为键的表，避免循环里做 switch。',
          '四个键必须与选项表一一对应，新增模态要同时补这里。',
          '这里只读 value，不读取个人覆盖值。',
        ],
      },
      {
        anchor: 'const disabled = modality === "text";',
        lines: [
          'text 是模型的基本能力，不允许在设置页关闭。',
          '禁用项仍按选中渲染，避免视觉上出现「未选中的基本能力」。',
          '覆盖判定优先看字段集合，没有集合时回退到个人值是否存在。',
          'overrideFields 是当前编辑上下文的权威来源，不能被个人值覆盖。',
        ],
      },
      {
        anchor: 'onToggle={',
        lines: [
          '切换时总是先把 supportsText 置真，再翻转目标字段。',
          '禁用项不传回调，从根上杜绝被点开的可能。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/settings/saved-workflows/savedWorkflowArgsForm.ts',
    target: 33,
    header: [
      '// INV-01 表单形状由声明决定：守住位置 buildSavedWorkflowArgFields；改错故障 旧实参凭空长出字段。',
      '// INV-02 initialArgs 优先于 default：守住位置 三元选择；改错故障 「再次运行」丢失上次实参。',
      '// INV-03 空文本对非 boolean 等于不传：守住位置 trim 长度判断；改错故障 空串被当成合法实参下发。',
      '// INV-04 必填且无默认值才是 required 错误：守住位置 双条件；改错故障 有默认值的字段也报必填。',
      '// INV-05 boolean 永远有值：守住位置 提前返回；改错故障 布尔字段被当成缺席。',
      '// INV-06 number 必须有限：守住位置 Number.isFinite；改错故障 NaN 进入 JSON 请求。',
      '// INV-07 错误一次收齐：守住位置 collectSavedWorkflowArgs；改错故障 用户逐个提交逐个报错。',
      '// INV-08 声明空表回 undefined：守住位置 rowsToArgsDeclaration 收尾；改错故障 frontmatter 出现空 args 键。',
      '// INV-09 名字只要求非空且唯一：守住位置 seen 集合；改错故障 合法但非标识符的名字被拒。',
      '// INV-10 行身份用下标加名字：守住位置 key 生成；改错故障 重命名导致行重建、输入框失焦。',
      '// INV-11 默认值文本按类型解析：守住位置 parseDefaultText；改错故障 布尔默认值以字符串落库。',
      '// INV-12 描述与 required 只在有值时写入：守住位置 条件展开；改错故障 声明里出现空描述键。',
      '// INV-13 格式化与解析必须互为逆运算：守住位置 formatSavedWorkflowArgValue；改错故障 往返后值变形。',
      '//',
      '// 模块职责：已保存工作流实参表单与元数据实参表的纯函数转换层。',
      '// 阅读顺序：先看声明到字段，再看字段到实参袋，最后看实参表到声明。',
    ],
    blocks: [
      {
        anchor: 'export function formatSavedWorkflowArgValue(',
        lines: [
          'undefined 时按类型给初值：布尔给 false，其余给空串。',
          '字符串原样返回，非字符串退回 JSON 序列化。',
          'json 默认缩进两格，便于在单行输入框里也能看清结构。',
        ],
      },
      {
        anchor: 'export function buildSavedWorkflowArgFields(',
        lines: [
          '遍历声明而不是实参：表单形状只由声明决定。',
          'initialArgs 命中字段就优先，未命中才回落到 default。',
          'description 为 undefined 时不写键，保持对象干净。',
        ],
      },
      {
        anchor: 'export function parseSavedWorkflowArgField(field: SavedWorkflowArgField): SavedWorkflowArgParse {',
        lines: [
          '布尔字段永远返回有值，空文本按 false 处理。',
          '空文本对其它类型表示不传，是否报错由必填与默认值共同决定。',
          'number 与 json 的失败要分开报，提示文案不同。',
          'json 解析失败只记错误码，不把异常抛给调用方。',
        ],
      },
      {
        anchor: 'export function collectSavedWorkflowArgs(',
        lines: [
          '有任一错误就整表失败，错误按字段名归集。',
          '省略的字段不进结果，服务端据此回填默认值。',
        ],
      },
      {
        anchor: 'export function argsDeclarationToRows(',
        lines: [
          'key 用下标加名字，重命名会让这一行重建，这是刻意的取舍。',
          '布尔默认值单独走 true 与 false 文本，其余复用格式化函数。',
        ],
      },
      {
        anchor: 'export function rowsToArgsDeclaration(',
        lines: [
          '空名与重名分别报错，重名判定基于 trim 后的结果。',
          '默认值解析失败不落库，避免半合法声明进入 frontmatter。',
          '空表返回 undefined，语义是「没有 args 键」而不是空对象。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/ToolCallBlocks/renderers/resolve-workflow-question.tsx',
    target: 32,
    header: [
      '// INV-01 input 读侧只宽容解析一次：守住位置 toRecord；改错故障 多层字符串反复解析。',
      '// INV-02 非对象与数组一律视为无输入：守住位置 类型判断；改错故障 数组下标被当字段读取。',
      '// INV-03 空白文本不算有效值：守住位置 readText 与 trim；改错故障 空答案渲染出空段落。',
      '// INV-04 单行概要只用于折叠行：守住位置 toInlinePreview；改错故障 折叠行换行把高度撑开。',
      '// INV-05 只有 failed 才走失败样式：守住位置 isFailed；改错故障 成功确认被标红。',
      '// INV-06 进行中优先于 pending 判断：守住位置 isAnswering 组合；改错故障 运行中显示已成答。',
      '// INV-07 结构化拒绝优先取错误通道：守住位置 outcomeText 三元；改错故障 拒绝原因被成功输出盖住。',
      '// INV-08 无详情时不可展开：守住位置 hasDetails；改错故障 展开后是一片空白。',
      '// INV-09 qid 用等宽且可断行：守住位置 code 的 break-all；改错故障 长标识撑破卡片。',
      '// INV-10 答案保留换行：守住位置 whitespace-pre-wrap；改错故障 多段答案挤成一行。',
      '// INV-11 概要截断必须加省略号：守住位置 模板拼接；改错故障 用户误以为答案就这么短。',
      '// INV-12 失败时状态标签与提示同源：守住位置 statusTooltip；改错故障 悬浮提示与正文不一致。',
      '// INV-13 折叠行为由外部 context 决定：守住位置 canToggle 与 forceOpen；改错故障 工具卡绕过统一展开策略。',
      '//',
      '// 模块职责：ResolveWorkflowQuestion 工具卡的折叠概要、详情与失败态渲染。',
      '// 阅读顺序：先看输入读取，再看状态判定，最后看详情分区与工具外壳参数。',
    ],
    blocks: [
      {
        anchor: 'function toRecord(value: unknown): Record<string, unknown> | undefined {',
        lines: [
          '对象直接返回，数组不算记录。',
          '字符串只尝试一次宽容解析，失败即放弃。',
          '解析结果仍要求是普通对象，防止把数组当输入。',
        ],
      },
      {
        anchor: 'const isAnswering =',
        lines: [
          '失败态一律不算进行中，失败优先于其它状态。',
          '外层 context 的运行态与工具自身的 pending 都算在飞。',
          '这个组合决定折叠行的标签文案，不要在别处重复推导。',
        ],
      },
      {
        anchor: 'const outcomeText = isFailed',
        lines: [
          '失败时按错误文本、错误字段、输出字段的顺序回退。',
          '进行中不展示结果文本，避免出现半截确认。',
          '成功时只认 output，这是服务端的确认原文。',
        ],
      },
      {
        anchor: 'const hasDetails = questionId !== undefined || answer !== undefined || outcomeText !== undefined;',
        lines: [
          '三个字段全缺时不提供展开，避免空白详情。',
          '有任一字段即允许展开，哪怕只有结果文本。',
        ],
      },
      {
        anchor: 'const renderContent = useCallback(',
        lines: [
          'qid 是不透明标识，必须等宽并允许任意位置断行。',
          '答案正文保留换行与原样空白，交给 pre-wrap 处理。',
          '结果段落按 failed 切换边框颜色，文案同源不另算。',
        ],
      },
      {
        anchor: 'const inlinePreview = useMemo(() => toInlinePreview(answer), [answer]);',
        lines: [
          '概要只在折叠行用，超长时截断并加省略号。',
          '依赖只有 answer，其它字段变化不触发重算。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/v4/agentConversationTransportWorkflowRuns.ts',
    target: 31,
    header: [
      '// INV-01 每个方法先握手再请求：守住位置 七个方法首行；改错故障 首次调用被服务端拒绝。',
      '// INV-02 工作区字段整体展开：守住位置 各方法的 workspace 展开；改错故障 身份缺失后跨区读错数据。',
      '// INV-03 可选参数按存在性展开：守住位置 六处条件展开；改错故障 未提供的字段以 undefined 下发。',
      '// INV-04 只做参数搬运不做校验：守住位置 方法体结构；改错故障 出现第二套默认值口径。',
      '// INV-05 返回值类型与协议一一对应：守住位置 方法签名；改错故障 上层拿到未声明的形状。',
      '// INV-06 artifact 读面与 run 读面分开：守住位置 方法分组；改错故障 把用户产物当 run 顶层返回值。',
      '// INV-07 artifactRead 必须带版本与区间：守住位置 入参映射；改错故障 读到错误的版本片段。',
      '// INV-08 节点结果按 siteId 与序号定位：守住位置 workflowRunNodeResult；改错故障 取错节点的 transcript。',
      '// INV-09 依赖通过闭包显式注入：守住位置 工厂入参；改错故障 直接 import 服务造成循环依赖。',
      '// INV-10 本文件不持有状态：守住位置 无模块级变量；改错故障 握手状态在多个会话间串扰。',
      '// INV-11 拆分只为行数约束：守住位置 文件头注释；改错故障 行为被误当作有意的语义变更。',
      '//',
      '// 模块职责：createAgentConversationTransport 的 workflow-run 只读查询面。',
      '// 阅读顺序：先看工厂入参与握手，再看 events 与 runs，最后看 artifact 三面与节点结果。',
    ],
    blocks: [
      {
        anchor: 'export function createWorkflowRunTransportMethods(input: {',
        lines: [
          '依赖全部来自入参，便于主文件按需拼装并保持无环。',
          'agentService 只取用到的七个方法，缩小耦合面。',
          'workspace 是值对象，展开时随每次请求一起带上。',
        ],
      },
      {
        anchor: 'async workflowRunEvents(',
        lines: [
          '事件查询按 afterSequence 增量拉取，不传则从头。',
          'limit 为空时不下发键，交给服务端默认值。',
          '握手必须在请求前完成，失败会向上抛出。',
        ],
      },
      {
        anchor: 'async workflowRunArtifacts(',
        lines: [
          'artifact 是脚本发布给用户看的产出，不是 run 的返回值。',
          '列表查询不需要版本号，只按 run 维度取。',
          '这里只搬运 sessionId 与 runId，不做额外过滤。',
        ],
      },
      {
        anchor: 'async workflowRunArtifactRead(',
        lines: [
          '读取必须同时给出 artifactId、version 与字节区间。',
          'offset 与 limit 是必填的，缺一个都会读到错误片段。',
          '不要在这里做区间裁剪，校验属于服务端。',
        ],
      },
      {
        anchor: 'async workflowRunNodeResult(',
        lines: [
          '节点结果按 siteId 加序号定位，两者缺一不可。',
          'maxBytes 为空时不下发，由服务端决定默认上限。',
          '返回值是节点 transcript 片段，不是整份 run 输出。',
        ],
      },
      {
        anchor: 'async workflowRuns(',
        lines: [
          '会话级 run 列表只接受 limit，分页由调用方推进。',
          '返回顺序以服务端为准，这里不做二次排序。',
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
    `ZC-deep-b203-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
