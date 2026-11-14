import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/settings/saved-workflows/SavedWorkflowMetaForm.tsx',
    target: 38,
    header: [
      '// INV-01 表单只渲染不持有状态：守住位置 props.draft；改错故障 放弃后仍残留编辑。',
      '// INV-02 脏标记由上层计算：守住位置 dirty 属性；改错故障 按钮显隐与真实差异脱节。',
      '// INV-03 保存中两个按钮同时禁用：守住位置 disabled={saving}；改错故障 重复提交覆盖。',
      '// INV-04 说明为必填项：守住位置 descriptionError；改错故障 空说明被静默保存。',
      '// INV-05 错误文案用内联段落呈现：守住位置 descriptionError 分支；改错故障 仅边框变色无提示。',
      '// INV-06 何时使用的帮助文案常驻：守住位置 whenToUse.help；改错故障 填写规则不可见。',
      '// INV-07 参数表整块交给子组件：守住位置 SavedWorkflowArgsTable；改错故障 行校验逻辑分裂两份。',
      '// INV-08 行错误按 key 索引：守住位置 rowErrors 属性；改错故障 重排后错误错位到别的行。',
      '// INV-09 新增与删除行都上抛：守住位置 onRowAdd 与 onRowRemove；改错故障 子组件私自改数组。',
      '// INV-10 放弃不做二次确认：守住位置 onDiscard 直连；改错故障 多一层弹窗打断流程。',
      '// INV-11 说明输入实时上抛：守住位置 onChange；改错故障 失焦才同步导致脏标记延迟。',
      '// INV-12 标签与输入框用 id 关联：守住位置 htmlFor 与 id 成对；改错故障 点击标签不聚焦。',
      '// INV-13 测试标识只挂在输入与按钮：守住位置 data-testid 常量；改错故障 E2E 选择器漂移。',
      '// INV-14 错误态同时挂 aria-invalid：守住位置 aria-invalid；改错故障 读屏用户无感知。',
      '// INV-15 按钮仅在脏时出现：守住位置 条件渲染；改错故障 无改动也显示保存按钮。',
      '// INV-16 国际化键集中声明：守住位置 TID 与 formatMessage；改错故障 文案硬编码散落。',
      '// INV-17 保存按钮带加载指示：守住位置 Spinner 条件渲染；改错故障 长请求看似无响应。',
      '// INV-18 布局只用 flex 与间距类：守住位置 section 容器；改错故障 表单在窄屏溢出。',
      '//',
      '// 模块职责：渲染工作流详情页的基本信息区，把编辑意图原样上抛给详情视图。',
      '// 状态所有权：草稿、脏标记与保存态全部由 SavedWorkflowDetailView 持有。',
      '// 阅读顺序：先看 props 契约，再看三块字段渲染，最后看脏态操作区。',
    ],
    blocks: [
      {
        anchor: 'interface SavedWorkflowMetaFormProps {',
        lines: [
          '草稿是唯一数据来源。',
          '回调全部由上层注入。',
          '错误按字段与行两层传入。',
          '本组件不引入本地副本。',
        ],
      },
      {
        anchor: 'export function SavedWorkflowMetaForm({',
        lines: [
          '解构顺序与契约保持一致。',
          '渲染过程不产生副作用。',
          '所有变更通过回调上抛。',
          '组件本身可被直接快照测试。',
        ],
      },
      {
        anchor: 'const { intl } = useZCodeIntl();',
        lines: [
          '文案统一走 intl 实例。',
          '键名与工作流命名空间对齐。',
          '不在组件内拼接自然语言。',
          '缺失键由平台兜底而非静默忽略。',
        ],
      },
      {
        anchor: '{descriptionError ? (',
        lines: [
          '失败路径只补错误段落。',
          '成功路径不渲染占位。',
          '输入框本身仍可继续编辑。',
          '错误样式与文案必须同时出现。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/settings/saved-workflows/SavedWorkflowRunHistoryPanel.tsx',
    target: 38,
    header: [
      '// INV-01 空历史直接给提示：守住位置 runs.length 判断；改错故障 渲染空表格边框。',
      '// INV-02 行键用 runId：守住位置 key 属性；改错故障 重排后行状态串位。',
      '// INV-03 状态徽标由纯函数决定：守住位置 savedWorkflowRunBadgeKind；改错故障 图标与文案不一致。',
      '// INV-04 运行中时长随 now 重算：守住位置 durationMs；改错故障 时长停在首次渲染值。',
      '// INV-05 分钟与秒分开格式化：守住位置 两条时长键；改错故障 出现 90 秒这类读数。',
      '// INV-06 查看实例需三个条件同时成立：守住位置 openable 表达式；改错故障 老行也显示入口。',
      '// INV-07 产物入口条件比查看实例松：守住位置 artifactsOpenable；改错故障 产物无法打开。',
      '// INV-08 老行缺产物键即整块缺席：守住位置 artifacts 判断；改错故障 渲染空白 chip 区。',
      '// INV-09 项目列仅在解析器存在时渲染：守住位置 resolveRunProject 判断；改错故障 单项目视图多一列。',
      '// INV-10 项目不可打开则隐藏入口：守住位置 project.canOpen；改错故障 跨项目行点了无响应。',
      '// INV-11 实参以 chip 形式平铺：守住位置 formatSavedWorkflowRunArgs；改错故障 长参数撑破行高。',
      '// INV-12 token 数走统一格式化：守住位置 formatSavedWorkflowTokens；改错故障 大数字无分隔。',
      '// INV-13 首行不加分隔线：守住位置 index 判断；改错故障 表格顶部多一条横线。',
      '// INV-14 状态色只由 switch 决定：守住位置 statusClass 赋值；改错故障 未知状态无配色。',
      '// INV-15 未知状态回落中性图标：守住位置 default 分支；改错故障 运行态误显示为完成。',
      '// INV-16 图标全部标记 aria-hidden：守住位置 图标属性；改错故障 读屏重复播报状态。',
      '// INV-17 时间统一走 formatDateTime：守住位置 createdAt 渲染；改错故障 时区展示不一致。',
      '// INV-18 底部说明常驻：守住位置 history.note；改错故障 用户不知道历史来自 journal。',
      '//',
      '// 模块职责：把已保存工作流的运行 journal 渲染成可按行追溯的历史列表。',
      '// 状态所有权：runs 与 now 由上层传入，本组件不做请求也不缓存。',
      '// 阅读顺序：先看空态与行模型，再看两种入口门槛，最后看状态分支。',
    ],
    blocks: [
      {
        anchor: 'export interface SavedWorkflowRunProject {',
        lines: [
          '标签用于展示。',
          '完整路径放 title 兜底。',
          '可打开性决定入口是否出现。',
          '解析失败返回空表示无项目列。',
        ],
      },
      {
        anchor: 'export function SavedWorkflowRunHistory({',
        lines: [
          '入参全部为只读数据或回调。',
          'props 中不含任何可变缓存。',
          '渲染顺序固定为状态、时间、参数、产物。',
          '回调缺席时对应入口自动降级。',
        ],
      },
      {
        anchor: 'const openable =',
        lines: [
          '全局开关先短路。',
          '会话与工具调用标识必须成对。',
          '跨项目时还要该行项目可打开。',
          '三者同时成立才渲染入口。',
        ],
      },
      {
        anchor: 'switch (kind) {',
        lines: [
          '四种徽标各自绑定图标与配色。',
          '未知值落到中性默认分支。',
          '颜色令牌只引用语义类。',
          '文案键由 kind 直接拼出。',
        ],
      },
    ],
  },
  {
    file: 'packages/web/src/web-remote-control/ui/webRemoteControlFailureScreen.tsx',
    target: 37,
    header: [
      '// INV-01 失败页不发起任何请求：守住位置 组件体；改错故障 渲染即触发重试风暴。',
      '// INV-02 文案解析是纯函数：守住位置 resolveWebRemoteControlScreenCopy；改错故障 同因不同文案。',
      '// INV-03 语言缺省由解析器兜底：守住位置 locale 入参；改错故障 未知语言渲染空白。',
      '// INV-04 色调只映射样式类：守住位置 resolveToneClassName；改错故障 组件内散落条件类名。',
      '// INV-05 危险态用破坏色：守住位置 danger 分支；改错故障 严重失败被弱化成中性。',
      '// INV-06 警告态用警示色：守住位置 warning 分支；改错故障 可恢复问题看起来不可恢复。',
      '// INV-07 未知色调回落中性：守住位置 default 分支；改错故障 类名缺失导致透明底。',
      '// INV-08 徽标与图标共用色调：守住位置 同一返回值；改错故障 两处配色割裂。',
      '// INV-09 下一步列表保持顺序：守住位置 nextSteps 映射；改错故障 操作指引乱序。',
      '// INV-10 步骤序号由下标生成：守住位置 index 加一；改错故障 序号重复或从零开始。',
      '// INV-11 详情段仅在消息非空时出现：守住位置 failure.message 判断；改错故障 空详情留白框。',
      '// INV-12 详情内容原样展示：守住位置 直接插值；改错故障 错误信息被改写后无法检索。',
      '// INV-13 设备不属主时走换账号弹窗：守住位置 reason 判断；改错故障 用户只能反复刷新。',
      '// INV-14 弹窗确认后统一重载：守住位置 onConfirm 传参；改错故障 换账号后仍停在失败页。',
      '// INV-15 主按钮文案可被覆盖：守住位置 primaryActionLabel；改错故障 特殊场景无法定制。',
      '// INV-16 次按钮完全可选：守住位置 secondaryAction 判断；改错故障 出现无行为的空按钮。',
      '// INV-17 页面撑满动态视口：守住位置 minHeight 样式；改错故障 移动端底部被工具栏遮挡。',
      '// INV-18 卡片宽度受限集中：守住位置 max-w 类；改错故障 宽屏下文本行长失控。',
      '//',
      '// 模块职责：远程控制失败时的整页兜底界面，负责解释原因并给出可执行下一步。',
      '// 状态所有权：无状态；失败对象、语言与回调全部由调用方注入。',
      '// 阅读顺序：先看色调映射，再看文案解析，最后看两类主操作分支。',
    ],
    blocks: [
      {
        anchor: 'function resolveToneClassName(tone: WebRemoteControlScreenCopy["tone"]): {',
        lines: [
          '输入只有三种语义色调。',
          '徽标与图标返回同一组令牌。',
          '未知值必须落到中性样式。',
          '这里不读主题状态。',
          '返回对象形状由调用方约定。',
        ],
      },
      {
        anchor: 'export function WebRemoteControlFailureScreen({',
        lines: [
          '失败对象决定文案与操作形态。',
          '语言只影响文案解析结果。',
          '重载回调由宿主注入。',
          '两个按钮文案都允许外部覆盖。',
          '组件本身不持有任何交互状态。',
        ],
      },
      {
        anchor: 'const copy = resolveWebRemoteControlScreenCopy(failure, locale);',
        lines: [
          '先解析文案再取色调。',
          '色调来自解析结果而非原始原因。',
          '解析失败由解析器自身兜底。',
          '后续渲染只依赖这两个派生值。',
          '派生过程可安全重复执行。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/adapters/src/storage/index.ts',
    target: 41,
    firstNth: 1,
    header: [
      '// INV-01 文件名由工具调用与产物标识拼成：守住位置 fileName 模板；改错故障 同会话产物互相覆盖。',
      '// INV-02 会话目录名经白名单化：守住位置 sanitizePathSegment；改错故障 特殊字符逃逸出根目录。',
      '// INV-03 空白路径段回落 unknown：守住位置 空串判断；改错故障 产物写进根目录本身。',
      '// INV-04 路径段长度上限一百二十：守住位置 slice 调用；改错故障 超长名触发系统错误。',
      '// INV-05 产物标识每次随机生成：守住位置 randomUUID；改错故障 重试复用旧标识。',
      '// INV-06 写入前先检查取消信号：守住位置 aborted 判断；改错故障 取消后仍落盘。',
      '// INV-07 目录创建允许已存在：守住位置 recursive 选项；改错故障 第二次写同一会话失败。',
      '// INV-08 字节数取实际内容长度：守住位置 byteLength；改错故障 声明值与真实大小不符。',
      '// INV-09 文本与二进制写入口分离：守住位置 两个方法；改错故障 二进制被当 utf8 损坏。',
      '// INV-10 扩展名优先取显式值：守住位置 空值合并顺序；改错故障 调用方指定后缀被忽略。',
      '// INV-11 未识别扩展名归一为 bin：守住位置 normalizeArtifactExtension；改错故障 未知格式按 JSON 读回。',
      '// INV-12 读回按 MIME 决定编码：守住位置 isTextArtifactContentType；改错故障 二进制被转成乱码字符串。',
      '// INV-13 找不到文件必须抛错：守住位置 fileName 判断；改错故障 返回空串掩盖数据丢失。',
      '// INV-14 定位靠目录扫描匹配标识：守住位置 readdir 加 find；改错故障 依赖内存索引导致重启丢失。',
      '// INV-15 派生媒体按 URI 去重：守住位置 flights 映射；改错故障 并发请求重复物化。',
      '// INV-16 去重表在完成后清理：守住位置 finally 分支；改错故障 映射持续增长泄漏内存。',
      '// INV-17 派生媒体先写临时文件再改名：守住位置 rename 调用；改错故障 读者看到半截文件。',
      '// INV-18 失败时删除临时文件后原样抛出：守住位置 catch 分支；改错故障 残留碎片且错误被吞。',
      '//',
      '// 模块职责：提供本地文件系统的工具产物存储，以及派生媒体附件的物化能力。',
      '// 状态所有权：仅缓存进行中的物化任务；产物元数据完全以文件系统为准。',
      '// 阅读顺序：先看写入路径，再看读取与元数据，最后看媒体物化与工具函数。',
    ],
    blocks: [
      {
        anchor: 'export class NodeToolArtifactStore implements ToolArtifactStorePort {',
        lines: [
          '四个根目录在构造时固化。',
          '产物目录与会话目录分层。',
          '派生媒体缓存与产物互不混放。',
          '去重表只记录进行中的任务。',
          '实例本身不持有产物索引。',
        ],
      },
      {
        anchor: 'private async readArtifactFile(',
        lines: [
          '先从 URI 解出会话与产物标识。',
          '再扫描会话目录查找包含标识的文件。',
          '定位失败直接抛错而不是返回空。',
          '内容类型按最终文件名反推。',
          '读取不产生任何写入副作用。',
        ],
      },
      {
        anchor: 'private runMediaAttachmentPathFlight(',
        lines: [
          '同一 URI 复用已存在的任务。',
          '未命中才真正开始物化。',
          '任务完成时仅删除自己那一份。',
          '不对结果做额外缓存。',
          '文件系统本身就是最终缓存。',
        ],
      },
      {
        anchor: 'private async writeDerivedMediaAttachment(',
        lines: [
          '无法命名的 MIME 返回不支持。',
          '已存在的普通文件直接视为就绪。',
          '写入先落在带随机后缀的临时文件。',
          '改名成功才算物化完成。',
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
    `ZC-deep-b161-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
