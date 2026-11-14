// B213 四个文件的注释 spec 生成器（各新增 30 行）。
import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/settings/saved-workflows/SavedWorkflowDetailHeader.tsx',
    target: 30,
    firstNth: 1,
    header: [
      '// INV-01 头行只读展示：守住位置 props.entry 的用法；改错故障 头行自己拉数据，与详情页状态不一致。',
      '// INV-02 运行要同时满足不忙且有条目：守住位置 disabled 的或运算；改错故障 条目缺失时仍可点运行。',
      '// INV-03 菜单只受忙碌约束：守住位置 ⋯ 按钮的 disabled；改错故障 运行中连复制路径都被锁住。',
      '// INV-04 归属是标签不是链接：守住位置 面包屑改两级后的说明；改错故障 出现一个点不动的假链接。',
      '// INV-05 归属小标与组头同款样式：守住位置 边框与弱化字色；改错故障 用户把它当成可点控件。',
      '// INV-06 空说明不渲染段落：守住位置 description 三元；改错故障 空段落占掉一行高度。',
      '// INV-07 作用域动作仅在传入时出现：守住位置 onMove 三元；改错故障 项目档出现无法执行的菜单项。',
      '// INV-08 移动与提升按作用域换文案：守住位置 entry.scope 判断；改错故障 全局档显示「移到项目」。',
      '// INV-09 删除项常驻且用危险色：守住位置 text-destructive；改错故障 破坏性动作与普通项难以区分。',
      '// INV-10 菜单项测试 id 带工作流名：守住位置 testId 第二参；改错故障 同名工作流无法逐条定位。',
      '// INV-11 装饰图标全部隐藏：守住位置 三处 aria-hidden；改错故障 读屏把图标名重复念出。',
      '// INV-12 标题是详情页唯一 h1：守住位置 h1 标签；改错故障 页面出现多个一级标题。',
      '// INV-13 长名称可截断：守住位置 内层 min-w-0；改错故障 超长名称把操作区挤出视口。',
      '// INV-14 组件从详情页拆出：守住位置 文件级 JSDoc；改错故障 详情页超过 400 行上限。',
      '//',
      '// 模块职责：已保存工作流详情页的头行，含标题、归属小标、说明与运行、菜单动作。',
      '// 阅读顺序：先看左侧标题与归属，再看运行按钮，最后看 ⋯ 菜单的作用域与删除项。',
    ],
    blocks: [
      {
        anchor: 'export function SavedWorkflowDetailHeader({',
        lines: [
          '头行只消费 props，不自己取数。',
        ],
      },
      {
        anchor: 'data-testid={TID_WORKFLOW_DETAIL_PROJECT}',
        lines: [
          '归属小标有独立测试 id，便于断言作用域。',
        ],
      },
      {
        anchor: '{description ? <p className="text-ui-base text-foreground-subtle">{description}</p> : null}',
        lines: [
          '说明为空就不占位。',
        ],
      },
      {
        anchor: '<div className="flex min-w-0 flex-col gap-1.5">',
        lines: [
          'min-w-0 让长名称可以被截断。',
        ],
      },
      {
        anchor: '<h1 className="min-w-0 text-ui-xl font-semibold text-foreground">{name}</h1>',
        lines: [
          '标题是详情页唯一的一级标题。',
        ],
      },
      {
        anchor: 'disabled={busy || !entry}',
        lines: [
          '忙碌或条目缺失时禁止运行。',
        ],
      },
      {
        anchor: 'disabled={busy}',
        lines: [
          '菜单只受忙碌约束，浏览类动作不受影响。',
        ],
      },
      {
        anchor: '{onMove ? (',
        lines: [
          '作用域动作由调用方决定是否出现。',
          '全局档与项目档共用同一条目。',
        ],
      },
      {
        anchor: 'entry?.scope === "global"',
        lines: [
          '文案按当前作用域切换。',
        ],
      },
      {
        anchor: 'className="text-destructive focus:text-destructive"',
        lines: [
          '删除是破坏性动作，全程使用危险色。',
        ],
      },
      {
        anchor: 'data-testid={testId(TID_WORKFLOW_ACTION_DELETE, name)}',
        lines: [
          '测试 id 带工作流名，定位到具体条目。',
        ],
      },
      {
        anchor: '<AutomationTrashIcon />',
        lines: [
          '删除图标与文案同组出现。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/side-pane-full-view/model.ts',
    target: 30,
    header: [
      '// INV-01 纯计算模块：守住位置 无 DOM 与存储访问；改错故障 几何计算被宿主副作用污染，无法单测。',
      '// INV-02 入场状态固定：守住位置 surface 与 floating 初值；改错故障 首次进入停在错误形态。',
      '// INV-03 宽高都由槽尺寸推导：守住位置 两处 Math.min/max；改错故障 小窗口下浮窗溢出或为负。',
      '// INV-04 位置必须钳制：守住位置 clampFloatingPosition；改错故障 拖动后浮窗一半在槽外。',
      '// INV-05 吸附坐标由锚点字符串推导：守住位置 includes 与 startsWith；改错故障 新增锚点无法定位。',
      '// INV-06 默认吸附点属于集合：守住位置 DEFAULT_FLOATING_ANCHOR；改错故障 默认值解析失败返回 null。',
      '// INV-07 缩放原点与吸附角一致：守住位置 resolveFloatingTransformOrigin；改错故障 展开动画从屏幕中心飞出。',
      '// INV-08 最近吸附按静止坐标距离：守住位置 Math.hypot；改错故障 松手后吸到更远的角。',
      '// INV-09 锚点解析收敛外部输入：守住位置 集合判断；改错故障 任意字符串被当成合法锚点。',
      '// INV-10 首次看到 owner 建立基线：守住位置 seenTurnKey 为 undefined 分支；改错故障 已结束回合重复弹气泡。',
      '// INV-11 同 turnKey 不重复弹：守住位置 turnKey 不等判断；改错故障 每次状态刷新都弹一次。',
      '// INV-12 关闭气泡保留基线：守住位置 dismiss 只清 answer；改错故障 关闭后同一回答再次弹出。',
      '// INV-13 离开浮窗清基线留气泡：守住位置 rebaseline 的映射；改错故障 回浮窗时旧回答又弹一遍。',
      '// INV-14 预览只留纯文本：守住位置 正则链；改错故障 气泡里出现 markdown 标记或代码块。',
      '//',
      '// 模块职责：Side Pane 完整视图的纯模型，含浮窗几何、吸附与回答气泡状态推进。',
      '// 阅读顺序：先看常量与三个类型，再看几何函数，最后看气泡归约、关闭与预览清洗。',
    ],
    blocks: [
      {
        anchor: 'export const SIDE_PANE_FULL_VIEW_ENTER_STATE: SidePaneFullViewState = {',
        lines: [
          '进入完整视图的初始形态固定。',
        ],
      },
      {
        anchor: 'export const FLOATING_ANCHORS: readonly FloatingAnchor[] = [',
        lines: [
          '七个吸附点是对外契约的一部分。',
        ],
      },
      {
        anchor: 'export const FLOATING_DRAG_CLICK_THRESHOLD_PX = 4;',
        lines: [
          '位移小于阈值按点击处理，避免误拖。',
        ],
      },
      {
        anchor: 'export function resolveFloatingWidth(slotWidth: number): number {',
        lines: [
          '宽度不超上限，也不小于 0。',
        ],
      },
      {
        anchor: 'export function clampFloatingPosition(',
        lines: [
          '钳制保证浮窗整体落在槽内。',
        ],
      },
      {
        anchor: 'const horizontal = anchor.includes("left")',
        lines: [
          '只看字符串前缀即可恢复水平与垂直分量。',
        ],
      },
      {
        anchor: 'export function resolveFloatingTransformOrigin(anchor: FloatingAnchor): string {',
        lines: [
          '缩放原点贴在同一个吸附角。',
        ],
      },
      {
        anchor: 'let best: FloatingAnchor = DEFAULT_FLOATING_ANCHOR;',
        lines: [
          '以默认值兜底，再按距离取更近者。',
        ],
      },
      {
        anchor: 'export function parseFloatingAnchor(raw: unknown): FloatingAnchor | null {',
        lines: [
          '外部输入必须收敛到集合内，否则返回 null。',
        ],
      },
      {
        anchor: 'if (!turn?.turnKey) return bubbles;',
        lines: [
          '没有回合键就没有可推进的状态。',
        ],
      },
      {
        anchor: 'if (current.seenTurnKey === undefined) {',
        lines: [
          '第一次看到 owner 时建立基线。',
        ],
      },
      {
        anchor: 'if (!current?.answer) return bubbles;',
        lines: [
          '没有气泡可关时返回原引用。',
        ],
      },
      {
        anchor: 'return new Map([...bubbles].map(([key, bubble]) => [key, { ...bubble, seenTurnKey: undefined }]));',
        lines: [
          '只清基线，已经弹出的回答保留。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/ToolCallBlocks/renderers/submit-result.tsx',
    target: 30,
    header: [
      '// INV-01 读时归一化不抛错：守住位置 所有 try/catch；改错故障 一条畸形载荷让整张卡崩掉。',
      '// INV-02 字符串只解析一次：守住位置 normalizeSubmittedResult；改错故障 多层 parse 把普通文本改成结构。',
      '// INV-03 标量字面量保持原样：守住位置 typeof parsed 判断；改错故障 模型写的数字被当成结构化载荷。',
      '// INV-04 展开门是 result 键在场：守住位置 "result" in input；改错故障 提交 null 时没有展开入口。',
      '// INV-05 驳回态是扁平行：守住位置 hasDetails 的 !isRejected；改错故障 驳回时仍提供空展开面板。',
      '// INV-06 驳回原文按通道优先：守住位置 errorText 到 output 的空值链；改错故障 只显示泛化失败。',
      '// INV-07 拒绝与停止同一句话：守住位置 isStopped 合并 denied；改错故障 状态文案缺词条。',
      '// INV-08 提交中三条件：守住位置 isSubmitting 的与运算；改错故障 失败态仍显示转圈。',
      '// INV-09 概要截断有上限：守住位置 INLINE_PREVIEW_MAX_LENGTH；改错故障 折叠头被长文本撑开。',
      '// INV-10 结构化走 CodeBlock：守住位置 isProse 的另一分支；改错故障 JSON 被当普通文本挤成一行。',
      '// INV-11 文本结果不渲染 markdown：守住位置 isProse 分支的 p；改错故障 用户原话被当成文档解析。',
      '// INV-12 序列化失败退回 String：守住位置 stringifyResult 的 catch；改错故障 循环引用让卡片白屏。',
      '// INV-13 快照提示独立挂载：守住位置 ToolSnapshotFieldNotice；改错故障 不展开就看不到字段缺失。',
      '// INV-14 图标纯装饰：守住位置 aria-hidden；改错故障 读屏重复播报图标语义。',
      '//',
      '// 模块职责：submit_result 工具卡的折叠头与展开体，含结果归一化与两种渲染形态。',
      '// 阅读顺序：先看归一化与序列化，再看状态判定，最后看折叠摘要与展开内容。',
    ],
    blocks: [
      {
        anchor: 'const INLINE_PREVIEW_MAX_LENGTH = 160;',
        lines: [
          '概要只给大概，完整内容在展开体里。',
        ],
      },
      {
        anchor: 'function toRecord(value: unknown): Record<string, unknown> | undefined {',
        lines: [
          '输入可能是对象，也可能是 JSON 字符串。',
        ],
      },
      {
        anchor: 'function normalizeSubmittedResult(value: unknown): unknown {',
        lines: [
          '与引擎侧一致，只做一次宽容解析。',
        ],
      },
      {
        anchor: 'return typeof parsed === "object" && parsed !== null ? parsed : value;',
        lines: [
          '标量字面量保留原字符串。',
        ],
      },
      {
        anchor: 'function stringifyResult(value: unknown): string {',
        lines: [
          '序列化失败退回字符串，卡片不能崩。',
        ],
      },
      {
        anchor: 'const hasResult = input !== undefined && "result" in input;',
        lines: [
          '门是键在场，提交 null 也是一次真实提交。',
        ],
      },
      {
        anchor: 'const isRejected = toolCall.status === "failed";',
        lines: [
          '驳回与停止在卡面上是两句话。',
        ],
      },
      {
        anchor: 'const isStopped = toolCall.status === "stopped" || toolCall.status === "denied";',
        lines: [
          '拒绝与停止共用「未走完」文案。',
        ],
      },
      {
        anchor: 'const rejectionText = isRejected',
        lines: [
          '错误通道优先，其次错误字段与纯文本输出。',
        ],
      },
      {
        anchor: 'const hasDetails = !isRejected && hasResult;',
        lines: [
          '驳回态扁平展示，不提供展开。',
        ],
      },
      {
        anchor: '{isProse ? (',
        lines: [
          '文本结果按人话展示，刻意不渲染 markdown。',
        ],
      },
      {
        anchor: 'code={stringifyResult(normalizedResult)}',
        lines: [
          '结构化载荷交给 CodeBlock 渲染。',
        ],
      },
      {
        anchor: 'renderContent={hasDetails ? renderContent : undefined}',
        lines: [
          '只有可展开时才挂内容渲染器。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/updateStatusModel.ts',
    target: 30,
    header: [
      '// INV-01 版本显示有优先级：守住位置 ready 到 progress 到 available 的空值链；改错故障 下载中显示旧版本。',
      '// INV-02 下载态缺版本用占位符：守住位置 "…" 分支；改错故障 某一帧缺版本让弹窗卸载。',
      '// INV-03 阶段与版本同源：守住位置 dialogPhase 三元；改错故障 显示已下载但仍处于下载阶段。',
      '// INV-04 legacy ready 仅在新状态缺位时兜底：守住位置 updateState === null；改错故障 旧缓存盖掉新状态。',
      '// INV-05 有新状态就不再显示重启：守住位置 resolveReadyVersion 末尾；改错故障 checking 时仍提示重启。',
      '// INV-06 跳过只对两种状态开放：守住位置 skippableVersion 判定；改错故障 已下载版本还能跳过。',
      '// INV-07 通道只在三种状态暴露：守住位置 updateChannel 判定；改错故障 未知状态带出过期通道。',
      '// INV-08 进度值钳制到 0~100：守住位置 Math.max/min；改错故障 异常进度把进度条撑破。',
      '// INV-09 非有限进度归零：守住位置 Number.isFinite；改错故障 NaN 进入样式计算。',
      '// INV-10 进度文案需字节齐全：守住位置 四个类型与范围检查；改错故障 显示 NaNMB / 0MB。',
      '// INV-11 缺总大小时不显示百分比：守住位置 末尾 return null；改错故障 新旧口径混在同一条文案里。',
      '// INV-12 下载完成需看到进度或完成态：守住位置 action 与 kind 的与运算；改错故障 过渡态提前释放按钮锁。',
      '// INV-13 取消完成要求离开下载态：守住位置 cancel 分支；改错故障 取消失败也解锁。',
      '// INV-14 跳过完成要求离开可更新与下载态：守住位置 skip 的双不等；改错故障 仍在可更新时解锁。',
      '//',
      '// 模块职责：把主进程更新状态推导成弹窗视图模型，并判定动作是否完成。',
      '// 阅读顺序：先看两个类型与推导函数，再看动作完成判定，最后看进度、发布说明与格式化。',
    ],
    blocks: [
      {
        anchor: 'export function deriveUpdateStatusViewModel({',
        lines: [
          '视图模型一次推导完，组件不再自行分支。',
        ],
      },
      {
        anchor: 'const displayVersion =',
        lines: [
          '版本按就绪、下载中、可更新依次回退。',
        ],
      },
      {
        anchor: '(isDownloadingUpdate ? "…" : null);',
        lines: [
          '下载态缺版本用占位符，避免弹窗卸载。',
        ],
      },
      {
        anchor: 'dialogPhase: readyVersion',
        lines: [
          '阶段与可见版本同源。',
        ],
      },
      {
        anchor: 'return updateState === null ? legacyReadyVersion : null;',
        lines: [
          '旧缓存只在新状态完全缺位时兜底。',
        ],
      },
      {
        anchor: 'export function isUpdateActionCompleted(',
        lines: [
          '动作锁的释放条件集中在此。',
        ],
      },
      {
        anchor: '(action === "download" &&',
        lines: [
          '下载完成要看到进度或完成态。',
        ],
      },
      {
        anchor: '(action === "cancel" && updateState?.kind !== "download-progress") ||',
        lines: [
          '离开下载态才算取消完成。',
        ],
      },
      {
        anchor: 'if (updateState?.kind !== "download-progress") {',
        lines: [
          '非下载态没有进度文案。',
        ],
      },
      {
        anchor: 'typeof transferredBytes === "number" &&',
        lines: [
          '字节数必须有限且非负才展示。',
        ],
      },
      {
        anchor: 'return Number.isFinite(rawProgressValue)',
        lines: [
          '进度值钳制到 0~100。',
        ],
      },
      {
        anchor: 'return updateState?.kind === "update-available" ||',
        lines: [
          '发布说明只随三种状态透传。',
        ],
      },
      {
        anchor: 'function formatMegabytes(bytes: number) {',
        lines: [
          '统一按 MB 保留一位小数。',
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
    `ZC-deep-b213-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
