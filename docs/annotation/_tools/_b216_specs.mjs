// B216 四个文件的注释 spec 生成器（各新增 30 行）。
import fs from 'node:fs';

const specs = [
  {
    file: 'packages/shared/src/zcode-protocol-v4/apply.ts',
    target: 30,
    header: [
      '// INV-01 不可变入口不改入参：守住位置 applyConversationDelta；改错故障 已发布快照被后续事件篡改。',
      '// INV-02 可变累加器只服务未发布快照：守住位置 接口注释与 create；改错故障 订阅者看到半成品。',
      '// INV-03 两套实现语义一致：守住位置 同名 case 分支；改错故障 冷恢复与在线增量结果不同。',
      '// INV-04 未加载 rowId 一律 no-op：守住位置 index === -1 与 undefined 判断；改错故障 被逐出的行被局部复活。',
      '// INV-05 row.delta 按路径分派：守住位置 appendToRow 的 switch；改错故障 文本追加写错字段。',
      '// INV-06 行类型不符即原样返回：守住位置 每个 case 的 kind 判断；改错故障 reasoning 被追加到文本行。',
      '// INV-07 row.removed 从 fromRowId 起裁剪：守住位置 filter 与写指针；改错故障 删除边界偏移一位。',
      '// INV-08 裁掉整条活跃分支要清计数：守住位置 removesEntireActiveBranch；改错故障 UI 误判可加载更早。',
      '// INV-09 state.updated 键级替换：守住位置 展开与 Object.assign；改错故障 深层对象被静默合并。',
      '// INV-10 pluginUi 通知不改快照：守住位置 四个空分支；改错故障 renderer 派发被重复计为状态变更。',
      '// INV-11 workflowRuns 增量规则外置：守住位置 两个转调点；改错故障 两个 twin 各写一份规则而走散。',
      '// INV-12 首行锚点只在空时建立：守住位置 ??= 与 ??；改错故障 追加覆盖已有 firstRowId。',
      '// INV-13 原地删除后重建索引：守住位置 clear 与 forEach；改错故障 后续 upsert 命中错位置。',
      '// INV-14 批量函数只按序归约：守住位置 两个 for 循环；改错故障 合并顺序改变最终语义。',
      '//',
      '// 模块职责：协议 delta 的规范应用语义，同时提供不可变与候选快照原地两套实现。',
      '// 阅读顺序：先看累加器与 appendToRow，再看不可变 switch，最后逐分支对照可变实现。',
    ],
    blocks: [
      {
        anchor: 'export interface MutableConversationSnapshotAccumulator {',
        lines: [
          '可变累加器只允许在隔离边界内使用。',
        ],
      },
      {
        anchor: 'const window = [...snapshot.rows.window];',
        nth: 1,
        lines: [
          '构造时复制一次窗口，之后原地改写。',
        ],
      },
      {
        anchor: 'function appendToRow(',
        lines: [
          '文本追加按路径分派，行类型不符即原样返回。',
        ],
      },
      {
        anchor: 'if (row.kind === "toolCall" && row.output) {',
        lines: [
          '输出文本只在已有 output 时追加。',
        ],
      },
      {
        anchor: 'case "row.appended":',
        nth: 1,
        lines: [
          '追加同时更新总数与首行锚点。',
        ],
      },
      {
        anchor: 'if (index === -1) return snapshot;',
        lines: [
          '未加载的 rowId 一律 no-op。',
        ],
      },
      {
        anchor: 'const removesEntireActiveBranch =',
        nth: 1,
        lines: [
          '从首行开始裁剪要重置整条活跃分支。',
        ],
      },
      {
        anchor: 'totalCount: removesEntireActiveBranch',
        lines: [
          '整条分支裁剪后计数归零。',
        ],
      },
      {
        anchor: 'case "state.updated":',
        nth: 1,
        lines: [
          '键级整体替换，绝不深合并。',
        ],
      },
      {
        anchor: 'case "pluginUi.appToolCall":',
        lines: [
          'live-only 通知不改变快照。',
        ],
      },
      {
        anchor: 'workflowRuns: applyWorkflowRunUpdated(snapshot.workflowRuns, delta),',
        lines: [
          '增量规则外置，两个 twin 只转调。',
        ],
      },
      {
        anchor: 'accumulator.rowIndexById.clear();',
        lines: [
          '删除后重建索引，保证后续 upsert 命中。',
        ],
      },
      {
        anchor: 'snapshot.workflowRuns = applyWorkflowRunUpdated(snapshot.workflowRuns, delta);',
        lines: [
          '赋新容器，不触碰已发布快照。',
        ],
      },
    ],
  },
  {
    file: 'packages/shared/src/zcode-protocol-v4/rows.ts',
    target: 30,
    header: [
      '// INV-01 行自包含：守住位置 行类型注释；改错故障 渲染一行还要读取相邻行。',
      '// INV-02 rowId 单调且不复用：守住位置 rowBaseFields；改错故障 分页出现错行或重影。',
      '// INV-03 结构变化换整行：守住位置 upsert 与 delta 的分工；改错故障 客户端被迫拼装结构。',
      '// INV-04 turn 是标签不是容器：守住位置 turnId 与各行并列；改错故障 出现嵌套 turn 树。',
      '// INV-05 兼容字段一律 optional：守住位置 各 schema 的 optional；改错故障 旧 transcript 整条被拒。',
      '// INV-06 闭集加值的偏斜已记录：守住两个 origin 注释；改错故障 后续维护者重复踩坑。',
      '// INV-07 actions 只下发 true：守住位置 rowBaseFields.actions；改错故障 每个键都传一遍 false。',
      '// INV-08 未加载行 patch 由 apply no-op：守住位置 注释；改错故障 UI 侧另写一套容错。',
      '// INV-09 display 失败不拒整行：守住位置 catch(undefined)；改错故障 装饰载荷拖垮整帧。',
      '// INV-10 分享投影替换本地 ref：守住位置 artifact 注释；改错故障 本地路径泄漏到公开分享。',
      '// INV-11 hook 描述不进 wire row：守住位置 拆分注释；改错故障 命令与环境变量被下发到客户端。',
      '// INV-12 marker 泳道由 CLI 裁决：守住位置 lane 注释；改错故障 UI 按类型猜测落位。',
      '// INV-13 判别联合按 kind 收口：守住位置 conversationRowSchema；改错故障 未知 kind 静默通过。',
      '// INV-14 大文件已按职责拆分：守住位置 toolDisplay 与 workflow-row-meta 的导入导出；改错故障 rows.ts 超出 max-lines。',
      '//',
      '// 模块职责：v4 会话行 schema 集合，定义行自包含结构与兼容字段边界。',
      '// 阅读顺序：先看 rowBaseFields 与轮头，再看各内容行，最后看 marker 与判别联合。',
    ],
    blocks: [
      {
        anchor: 'const rowBaseFields = {',
        lines: [
          '公共字段只在这里定义一次。',
        ],
      },
      {
        anchor: 'rowId: z.number(),',
        lines: [
          'rowId 在会话内单调且永不复用。',
        ],
      },
      {
        anchor: 'entityId: z.string().min(1).optional(),',
        lines: [
          'canonical 身份字段，旧帧可缺省。',
        ],
      },
      {
        anchor: 'export const turnHeaderRowSchema = z.object({',
        lines: [
          '轮头承载产品轮边界与权威工时。',
        ],
      },
      {
        anchor: 'origin: z.enum([',
        nth: 1,
        lines: [
          '闭集枚举加值的偏斜已记录并接受。',
        ],
      },
      {
        anchor: 'executionKind: z.enum(["agent", "controlOnly"]).optional(),',
        lines: [
          '执行语义由 CLI 投影裁决，UI 不反推。',
        ],
      },
      {
        anchor: 'export const assistantTextRowSchema = z.object({',
        lines: [
          '文本追加只允许进入流式行。',
        ],
      },
      {
        anchor: 'display: toolCallDisplaySchema.optional().catch(undefined),',
        lines: [
          '装饰载荷失败不拒整行。',
        ],
      },
      {
        anchor: 'export const conversationArtifactTypeSchema = z.enum([',
        lines: [
          '产物类型是闭集，新增需同步投影。',
        ],
      },
      {
        anchor: 'ref: z.string().trim().min(1),',
        lines: [
          '分享投影必须把本地引用换成分享地址。',
        ],
      },
      {
        anchor: 'export const hookExecutionDescriptorSchema = z',
        lines: [
          '描述只用于兼容输入，不进 wire row。',
        ],
      },
      {
        anchor: 'lane: timelineMarkerLaneSchema.optional(),',
        lines: [
          '泳道缺省时由 UI 按 marker 类型回落。',
        ],
      },
      {
        anchor: 'export const conversationRowSchema = z.discriminatedUnion("kind", [',
        lines: [
          '判别联合按 kind 收口所有行类型。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/browser-use/useBrowserResizeOperationWarning.ts',
    target: 30,
    header: [
      '// INV-01 只做本地弱提示：守住位置 文件头注释；改错故障 提示顺带取消工具或改写快照。',
      '// INV-02 同一 active 周期只提示一次：守住位置 warnedForActiveCycleRef；改错故障 连续拖拽提示风暴。',
      '// INV-03 提示三秒后自动消失：守住位置 RESIZE_WARNING_DURATION_MS；改错故障 提示常驻遮挡页面。',
      '// INV-04 离开 active 立即复位：守住位置 isAgentOperating effect；改错故障 下一周期不再提示。',
      '// INV-05 回调前同步 ref：守住位置 render 期赋值；改错故障 首帧回调读到上一帧状态。',
      '// INV-06 零尺寸不算变化：守住位置 <= 0 判断；改错故障 隐藏面板触发误报。',
      '// INV-07 首次尺寸只建基线：守住位置 previousSize !== null；改错故障 挂载即弹提示。',
      '// INV-08 稳定期内不提示：守住位置 isAgentLayoutSettling；改错故障 模型布局动画被当成用户拖拽。',
      '// INV-09 稳定期三段时长：守住位置 三个常量；改错故障 静默窗口无限延长或瞬间结束。',
      '// INV-10 只有模型布局 marker 开稳定期：守住位置 hasInitialAgentMarker 与 changed；改错故障 用户切 tab 被静默。',
      '// INV-11 普通挂载不扩大窗口：守住位置 注释与条件；改错故障 用户主动 resize 被吞掉。',
      '// INV-12 baseline 版本变化清旧尺寸：守住位置 lastSizeRef 赋值；改错故障 跨版本比较出错行提示。',
      '// INV-13 卸载清计时器：守住位置 末尾 effect；改错故障 定时器在卸载后写状态。',
      '// INV-14 只暴露 ref 与三个入口：守住位置 返回值；改错故障 调用方直接改内部 state。',
      '//',
      '// 模块职责：Browser Use active 周期内的浏览器区域尺寸监听与本地弱提示。',
      '// 阅读顺序：先看四个时长常量，再看提示与稳定期回调，最后看监听与清理。',
    ],
    blocks: [
      {
        anchor: 'const RESIZE_WARNING_DURATION_MS = 3_000;',
        lines: [
          '提示三秒后自动消失。',
        ],
      },
      {
        anchor: 'const AGENT_LAYOUT_SETTLE_MIN_DURATION_MS = 300;',
        lines: [
          '稳定期至少覆盖首帧。',
        ],
      },
      {
        anchor: 'const AGENT_LAYOUT_SETTLE_QUIET_DURATION_MS = 100;',
        lines: [
          '每次回调顺延，但有上限。',
        ],
      },
      {
        anchor: 'const AGENT_LAYOUT_SETTLE_MAX_DURATION_MS = 500;',
        lines: [
          '稳定期最多半秒，避免吞掉用户操作。',
        ],
      },
      {
        anchor: 'if (!isVisibleRef.current || !isAgentOperatingRef.current || warnedForActiveCycleRef.current) {',
        lines: [
          '不可见、非 active 或已提示过都直接返回。',
        ],
      },
      {
        anchor: 'warnedForActiveCycleRef.current = true;',
        lines: [
          '同一周期只提示一次，避免拖拽风暴。',
        ],
      },
      {
        anchor: 'const beginAgentLayoutSettlement = useCallback(() => {',
        lines: [
          '稳定期从布局变化那一刻起算。',
        ],
      },
      {
        anchor: 'useLayoutEffect(() => {',
        lines: [
          'baseline 用 layout effect，抢在绘制前生效。',
        ],
      },
      {
        anchor: 'if (hasInitialAgentMarker || agentMarkerChanged) beginAgentLayoutSettlement();',
        lines: [
          '只有模型布局 marker 才开稳定期。',
        ],
      },
      {
        anchor: 'if (isAgentOperating) return;',
        lines: [
          'active 期间不复位，避免状态抖动。',
        ],
      },
      {
        anchor: 'if (!element || typeof ResizeObserver === "undefined") return;',
        lines: [
          '无元素或无观察器时静默退出。',
        ],
      },
      {
        anchor: 'if (nextSize.width <= 0 || nextSize.height <= 0) return;',
        lines: [
          '零尺寸不算变化。',
        ],
      },
      {
        anchor: 'if (!sizeChanged || isAgentLayoutSettling) return;',
        lines: [
          '首次回调与稳定期内都不提示。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/command-center/commandCenterSearchHistory.ts',
    target: 30,
    header: [
      '// INV-01 历史按 workspace 分键：守住位置 getHistoryKey；改错故障 多项目共用一份搜索历史。',
      '// INV-02 上限二十条：守住位置 LIMIT 与两处 slice；改错故障 历史无限增长拖慢启动。',
      '// INV-03 存储不可用降级为空：守住位置 getStorage 返回 null；改错故障 SSR 或隐私模式直接崩。',
      '// INV-04 读取失败返回空数组：守住位置 JSON.parse 的 catch；改错故障 一条脏数据丢掉整个面板。',
      '// INV-05 写入失败静默：守住位置 setItem 的 catch；改错故障 配额满时阻断搜索主流程。',
      '// INV-06 每条记录过形状校验：守住位置 isCommandCenterSearchHistoryEntry；改错故障 旧格式混入渲染。',
      '// INV-07 纯前缀符号不入历史：守住位置 ">" "#" "@" 判断；改错故障 历史被单字符占满。',
      '// INV-08 去重忽略大小写：守住位置 toLocaleLowerCase；改错故障 同一查询出现多条。',
      '// INV-09 新记录置顶：守住位置 数组构造顺序；改错故障 最近搜索沉底。',
      '// INV-10 去重只移除同名旧记录：守住位置 filter；改错故障 其它 scope 的历史被误删。',
      '// INV-11 清除即写空数组：守住位置 clear；改错故障 只改内存不落盘，刷新后复活。',
      '// INV-12 键前缀集中一处：守住位置 KEY_PREFIX；改错故障 读写前缀不一致，历史永远读不到。',
      '// INV-13 时间戳本地生成：守住位置 Date.now；改错故障 使用服务端时间导致排序错乱。',
      '// INV-14 模块无 React 依赖：守住位置 纯函数导出；改错故障 非组件环境无法预取历史。',
      '//',
      '// 模块职责：命令中心搜索历史的本地读写、去重、截断与清除。',
      '// 阅读顺序：先看存储与键，再看校验与读取，最后看写入与去重追加。',
    ],
    blocks: [
      {
        anchor: 'const COMMAND_CENTER_HISTORY_LIMIT = 20;',
        lines: [
          '历史上限只在这里调整。',
        ],
      },
      {
        anchor: 'const COMMAND_CENTER_HISTORY_KEY_PREFIX = "zcode-command-center-search-history:";',
        lines: [
          '键前缀集中一处，避免读写漂移。',
        ],
      },
      {
        anchor: 'function getStorage(): Storage | null {',
        lines: [
          '无 window 时返回 null，SSR 可用。',
        ],
      },
      {
        anchor: 'return window.localStorage;',
        lines: [
          '访问本身也可能抛错，所以包在 try 里。',
        ],
      },
      {
        anchor: 'function isCommandCenterSearchHistoryEntry(',
        lines: [
          '每条记录都要过形状校验。',
        ],
      },
      {
        anchor: 'typeof entry.query === "string" &&',
        lines: [
          'query 与时间戳类型必须正确。',
        ],
      },
      {
        anchor: 'const storage = getStorage();',
        nth: 1,
        lines: [
          '存储不可用时按空历史处理。',
        ],
      },
      {
        anchor: 'const parsed = JSON.parse(storage.getItem(getHistoryKey(workspaceKey)) ?? "[]");',
        lines: [
          '解析失败与缺键都回落为空。',
        ],
      },
      {
        anchor: '? parsed.filter(isCommandCenterSearchHistoryEntry).slice(0, COMMAND_CENTER_HISTORY_LIMIT)',
        lines: [
          '先过滤非法项，再裁剪上限。',
        ],
      },
      {
        anchor: 'JSON.stringify(entries.slice(0, COMMAND_CENTER_HISTORY_LIMIT)),',
        lines: [
          '写入前再裁剪一次。',
        ],
      },
      {
        anchor: 'if (!query || query === ">" || query === "#" || query === "@") {',
        lines: [
          '纯前缀符号不写入历史。',
        ],
      },
      {
        anchor: 'const dedupeKey = query.toLocaleLowerCase();',
        lines: [
          '去重忽略大小写。',
        ],
      },
      {
        anchor: '].slice(0, COMMAND_CENTER_HISTORY_LIMIT);',
        lines: [
          '新记录置顶后整体裁剪。',
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
    `ZC-deep-b216-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
