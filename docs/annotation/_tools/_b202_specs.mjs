import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/lib/providerBusinessError.ts',
    target: 33,
    header: [
      '// INV-01 业务码集合是唯一真值：守住位置 PROVIDER_BUSINESS_ERROR_CODES；改错故障 判定与映射表不同步。',
      '// INV-02 消息表必须覆盖每个业务码：守住位置 Record 键类型；改错故障 新增码没有文案，界面显示空串。',
      '// INV-03 动作表与动作文案表成对：守住位置 两个 Record；改错故障 出现没有按钮文案的动作。',
      '// INV-04 无可用动作显式写 null：守住位置 3001 与 3102；改错故障 横幅渲染出空按钮。',
      '// INV-05 包装码只在对齐文案时才推断：守住位置 两个 resolve 的 includes；改错故障 普通报错被误判为额度或并发问题。',
      '// INV-06 直接命中业务码优先于推断：守住位置 三个 resolve 的头部判断；改错故障 正确的码被文案覆盖。',
      '// INV-07 模型级并发退化为 3009 而不是 3008：守住位置 文案二次判断；改错故障 恢复后 composer 仍被锁住。',
      '// INV-08 1006 与 1005 重试前都要刷新配额：守住位置 shouldRefreshQuotaOnProviderBusinessRetry；改错故障 UI 本地误扣额度。',
      '// INV-09 闲时票据错误靠稳定标记兜底：守住位置 isOffPeakTicketExpiredError；改错故障 上游原文直接展示给用户。',
      '// INV-10 空闲重试耗尽文案是稳定常量：守住位置 START_PLAN_BUSY_AUTO_RETRY_EXHAUSTED_MESSAGE；改错故障 横幅原因永远判成初始繁忙。',
      '// INV-11 GLM 额度码不并入通用业务码：守住位置 独立常量与 Set；改错故障 额度提示被普通错误横幅盖住。',
      '// INV-12 空结果提示文案与 core 保持一致：守住位置 文件首行常量；改错故障 前后端识别出两种文案。',
      '// INV-13 判定函数接受 undefined：守住位置 所有入参类型；改错故障 调用方还要先判空。',
      '//',
      '// 模块职责：把 provider 业务码翻译成稳定的界面动作、文案键与横幅归类。',
      '// 阅读顺序：先看码表与三张映射，再看两个包装码推断，最后看横幅与文案判定。',
    ],
    blocks: [
      {
        anchor: 'export function isProviderBusinessErrorCode(',
        lines: [
          '唯一入口的类型守卫：其余查询函数都先经过它。',
          '空串与 undefined 一律为假，避免误命中。',
        ],
      },
      {
        anchor: 'export function getProviderBusinessErrorMessageId(code: string | undefined): string | undefined {',
        lines: [
          '未知码返回 undefined，由调用方回退到通用错误文案。',
          '这里的返回值是 i18n key，不是可直接展示的文本。',
        ],
      },
      {
        anchor: 'export function resolveStartPlanQuotaExhaustedBusinessCode(',
        lines: [
          '真实 1005 直接通过，不再看文案。',
          '旧链路只保留包装码，因此用三段额度文案加包装码白名单兜底。',
          '调用方限定在 Start Plan provider 边界内，避免误伤同名错误。',
        ],
      },
      {
        anchor: 'export function resolveStartPlanConcurrentLimitBusinessCode(',
        lines: [
          '三个并发码逐一早期返回，保持与上游取值一一对应。',
          '兜底只在包装码加并发文案同时成立时触发。',
          '带 model 或模型字样的是模型级并发，降级为 3009。',
          '降级是必要的：3008 会锁住 composer，恢复后用户仍然动不了。',
        ],
      },
      {
        anchor: 'export function resolveGlmQuotaBannerBusinessCode(',
        lines: [
          'GLM 额度码是一组独立取值，刻意不并入通用业务码。',
          '命中即返回，让横幅优先展示升级入口。',
        ],
      },
      {
        anchor: 'export function resolveStartPlanConcurrentLimitBannerReason(',
        lines: [
          '只比较稳定常量，不做模糊匹配。',
          '其余情况一律按初始繁忙处理，保证横幅总有一个原因。',
        ],
      },
      {
        anchor: 'export function isSuspiciousEmptyModelResultMessage(message: string | undefined): boolean {',
        lines: [
          '同时认常量全文与旧版前缀，兼容历史持久化消息。',
          '空消息直接为假，避免把无错误当成异常结果。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/lib/slashCommands.ts',
    target: 31,
    header: [
      '// INV-01 只认行首斜杠：守住位置 extractActiveSlashQuery 的 lineStart；改错故障 句中斜杠也弹出命令面板。',
      '// INV-02 查询词一旦含空白即失活：守住位置 WHITESPACE_RE；改错故障 输入参数时面板一直挂着。',
      '// INV-03 空查询返回全部命令：守住位置 空串分支；改错故障 刚输入斜杠看到空列表。',
      '// INV-04 null 查询返回空数组：守住位置 首个判断；改错故障 未激活时也渲染命令。',
      '// INV-05 评分分层而不是连续：前缀 0 起、子串 100 起、散点 200 起；改错故障 字段权重被散点分淹没。',
      '// INV-06 描述与提示有固定加分基数：守住位置 加 300 与加 500；改错故障 描述命中排在名称命中之前。',
      '// INV-07 前缀分含长度差：守住位置 startsWith 分支；改错故障 短名与长名同分导致排序不稳。',
      '// INV-08 散点匹配按顺序推进且失败即淘汰：守住位置 searchStart；改错故障 乱序命中被当成匹配。',
      '// INV-09 排序先分数后名称长度再字典序：守住位置 三级比较；改错故障 每次输入面板顺序跳变。',
      '// INV-10 替换必须包含前置行内容：守住位置 slice 到 lineStart；改错故障 上一行被截断。',
      '// INV-11 光标偏移按命令名加空格再加一计：守住位置 cursorOffset；改错故障 光标落在斜杠前。',
      '// INV-12 同行后续参数整体保留：守住位置 textAfterCursor.search；改错故障 命令后的参数被吞。',
      '// INV-13 替换失败返回 null 由调用方放弃：守住位置 查询失活分支；改错故障 在非命令位置插入命令名。',
      '//',
      '// 模块职责：斜杠命令的查询提取、模糊过滤排序与文本替换。',
      '// 阅读顺序：先看评分函数的分层，再看查询提取与过滤，最后看替换与光标计算。',
    ],
    blocks: [
      {
        anchor: 'function scoreFuzzyMatch(text: string, query: string): number | null {',
        lines: [
          '空查询得 0 分：调用方已单独处理「全部展示」，这里只兜底。',
          '前缀命中分最低，且名称越短越靠前。',
          '子串命中加 100 再加下标，越靠前越优。',
          '散点匹配从 200 起，逐字符推进，任一字符缺失即淘汰。',
        ],
      },
      {
        anchor: 'const lineStart = textBeforeCursor.lastIndexOf("\\n") + 1;',
        nth: 1,
        lines: [
          '只看光标所在行，行首之前的斜杠不算命令。',
          '查询词含空白说明已进入参数输入，面板应当收起。',
          '末尾不做 trim：用户正在输入的空格也要让面板失活。',
        ],
      },
      {
        anchor: 'return commands',
        lines: [
          '名称命中不加权，描述加 300，提示加 500。',
          '三个分数取最小，任一项为 null 视为无穷大。',
          '不可匹配的条目返回 null，在下一步统一剔除。',
        ],
      },
      {
        anchor: '.sort((left, right) => {',
        lines: [
          '分数相同先比名称长度，短命令更可能是用户想要的。',
          '再按字典序兜底，保证渲染顺序稳定可预期。',
          '不要改成按注册顺序，历史行为依赖这套排序。',
        ],
      },
      {
        anchor: 'return {',
        lines: [
          '新文本保留行首之前的内容，只替换命令片段。',
          '光标停在命令名加空格之后，紧接参数输入位置。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/previewPaneCodeContent.tsx',
    target: 31,
    header: [
      '// INV-01 mermaid 走专用组件而不是代码高亮：守住位置 isMermaidLanguage 分支；改错故障 流程图被渲染成源码文本。',
      '// INV-02 两种形态共用同一个滚动容器 ref：守住位置 ref 挂载位置；改错故障 外部定位滚动失效。',
      '// INV-03 mermaid 分支自己承担滚动与内边距：守住位置 overflow-auto 与 p-4；改错故障 图被裁切。',
      '// INV-04 主题缺省按 system 兜底：守住位置 theme 透传；改错故障 暗色主题下图表仍用亮色。',
      '// INV-05 展示参数全部来自 codePreviewSettings：守住位置 showLineNumbers 与 fontSizePx；改错故障 设置项不生效。',
      '// INV-06 firstLineNumber 只在代码形态透传：守住位置 CodeViewer 入参；改错故障 行号起点错位。',
      '// INV-07 批注参数整体透传不加工：守住位置 五个 comment props；改错故障 选中范围与聚焦请求错位。',
      '// INV-08 行选择与行内工具默认关闭：守住位置 两个默认值；改错故障 只读预览被误触发行内输入。',
      '// INV-09 onScroll 两种形态都要挂：守住位置 两处 onScroll；改错故障 外部同步滚动失效。',
      '// INV-10 className 是追加而不是替换：守住位置 cn 调用；改错故障 外部布局类覆盖内边距。',
      '// INV-11 组件不持有任何状态：守住位置 无 hook；改错故障 预览与父级不同步。',
      '// INV-12 语言类型即 shiki 语言集合：守住位置 BundledLanguage；改错故障 传入未注册语言时高亮失败。',
      '//',
      '// 模块职责：按语言在 mermaid 预览与通用代码查看器之间分流。',
      '// 阅读顺序：先看 mermaid 分支的容器约定，再看代码分支的参数映射。',
    ],
    blocks: [
      {
        anchor: 'if (isMermaidLanguage(language)) {',
        lines: [
          'mermaid 不进入代码高亮，直接交给图表组件渲染。',
          '判断放在最前，避免为图表语言准备无用的高亮参数。',
          '分支返回自己的容器，滚动与背景与代码形态保持一致的观感。',
        ],
      },
      {
        anchor: 'ref={scrollContainerRef}',
        lines: [
          '外层容器承接 ref，调用方据此恢复滚动位置。',
          '两种形态必须挂同一个 ref，否则切换语言后定位错乱。',
        ],
      },
      {
        anchor: '<MermaidBlock',
        lines: [
          '只透传代码与主题，尺寸由外层容器决定。',
          '边框与圆角在这里给，保证图表与代码块的视觉一致。',
        ],
      },
      {
        anchor: 'showLineNumbers={codePreviewSettings.showLineNumbers}',
        lines: [
          '行号与字号都读预览设置，不在组件内写死。',
          '行号起点由调用方决定，代码形态才需要。',
          '换行开关来自调用方，与设置项解耦。',
        ],
      },
      {
        anchor: 'theme={codeTheme}',
        lines: [
          '高亮主题与 mermaid 主题是两个来源，不要混用。',
          '批注、聚焦范围与选中能力全部透传，组件不做二次解释。',
        ],
      },
      {
        anchor: 'enableLineSelection={enableLineSelection}',
        lines: [
          '只读预览下这两项保持关闭，避免误触发行内输入。',
          '需要可编辑能力时由父级显式打开。',
        ],
      },
      {
        anchor: 'className={className}',
        lines: [
          '外部类通过 cn 追加，不能覆盖内部内边距与尺寸。',
          'scroll 回调与 ref 一起透传，保证两个形态行为一致。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/settings/model-provider-section/ModelConfigHelp.tsx',
    target: 31,
    header: [
      '// INV-01 帮助按钮是 label 的兄弟不是子节点：守住位置 ModelConfigInputLabel 的 Fragment；改错故障 点帮助按钮触发输入聚焦。',
      '// INV-02 htmlFor 必须指向调用方给的输入 id：守住位置 透传；改错故障 标签点不到输入框。',
      '// INV-03 提示内容只来自定稿语言包：守住位置 两次 formatMessage；改错故障 用户输入被当成文案渲染。',
      '// INV-04 只有鼠标悬停才自动开关：守住位置 pointerType 判断；改错故障 触摸设备点一下又立刻关掉。',
      '// INV-05 点击阻止默认与冒泡：守住位置 onClick；改错故障 Radix 在已打开时反向关闭并触发相邻控件。',
      '// INV-06 打开浮层不抢焦点：守住位置 两个 autoFocus 阻止；改错故障 键盘用户焦点被弹出内容吞掉。',
      '// INV-07 浮层宽度与高度都设上限：守住位置 w-80 与 max-h；改错故障 小屏溢出、内容不可达。',
      '// INV-08 段落按空行切分：守住位置 split 两个换行；改错故障 整段说明挤成一行。',
      '// INV-09 以短横线开头才渲染列表：守住位置 startsWith 判断；改错故障 普通段落被拆成条目。',
      '// INV-10 列表项去掉前两个字符再强调：守住位置 slice(2)；改错故障 条目里残留短横线。',
      '// INV-11 强调只认加粗与行内代码：守住位置 emphasis 正则；改错故障 HTML 或链接被解释执行。',
      '// INV-12 文案键由 field 拼成：守住位置 模板字符串；改错故障 新增字段忘记注册 help 文案后直接显示 key。',
      '// INV-13 组件只受控于本地 open 状态：守住位置 useState；改错故障 浮层无法被 Esc 关闭。',
      '//',
      '// 模块职责：模型配置字段的标签与悬停帮助气泡。',
      '// 阅读顺序：先看标签与按钮的相对结构，再看交互开关，最后看文案渲染。',
    ],
    blocks: [
      {
        anchor: 'const label = intl.formatMessage({ id: `settings.modelProvider.${field}` });',
        lines: [
          '标签与帮助标题共用同一个字段文案，避免两处写法不一致。',
          '帮助正文的 key 只多一段 help，新增字段必须同时补两条文案。',
        ],
      },
      {
        anchor: 'onPointerEnter={(event) => {',
        lines: [
          '只在鼠标指针下自动打开，触摸与手写笔交给点击处理。',
          '离开同样按指针类型过滤，避免触摸端反复开关。',
          '键盘用户通过 focus 打开，不依赖悬停。',
        ],
      },
      {
        anchor: 'onClick={(event) => {',
        lines: [
          '阻止默认行为，防止按钮把焦点转给相邻输入。',
          '阻止冒泡，避免外层表单控件被误触。',
          '点击总是打开而不是切换，关闭交给 Esc 或点击外部。',
        ],
      },
      {
        anchor: '{copy.split("\\n\\n").map((paragraph, index) =>',
        lines: [
          '空行分段是语言包的唯一结构化约定。',
          '短横线开头的段落渲染成无序列表，其余按段落保留换行。',
          '段落与条目的 key 用下标，文案是静态的不需要稳定 id。',
        ],
      },
      {
        anchor: 'function emphasis(text: string) {',
        lines: [
          '只解析两种定稿标记：双星加粗与反引号行内代码。',
          '正则带捕获组，split 后奇偶位置正好是标记片段。',
          '纯文本原样返回，不解释 HTML、链接或用户输入。',
          '这是渲染安全的边界，不要为方便引入 markdown 解析器。',
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
    `ZC-deep-b202-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
