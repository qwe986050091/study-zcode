// B217 四个文件的注释 spec 生成器（各新增 30 行）。
import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/components/workflow-timeline/timeline-model.ts',
    target: 30,
    header: [
      '// INV-01 纯函数无 React/DOM/时间：守住位置 文件头注释；改错故障 同一输入在不同帧得到不同模型。',
      '// INV-02 一个模型三处消费：守住位置 共享缓存入口；改错故障 卡与侧栏各算一份，十字线对不上。',
      '// INV-03 显式留白标签不走缓存：守住位置 holeLabels 判断；改错故障 静态图与运行图共用同一份缓存。',
      '// INV-04 顺序是声明序：守住位置 phases 下标；改错故障 兄弟阶段被重新排秩，画面前后跳动。',
      '// INV-05 回边按方向判定：守住位置 arc.to < arc.from；改错故障 再入被当成前进，弧不出现在左侧。',
      '// INV-06 边先按下标去重：守住位置 seen 集合；改错故障 同一条边画两根弧。',
      '// INV-07 自环与未列阶段边丢弃：守住位置 continue 条件；改错故障 下标越界或出现零长度弧。',
      '// INV-08 回边端点在带内则整带上环：守住位置 bandOf 分支；改错故障 只有带内一站显示循环标记。',
      '// INV-09 头像按实例身份分配：守住位置 avatarKey；改错故障 同一代理跨阶段换头像。',
      '// INV-10 有 run 才折叠状态：守住位置 run === undefined 三元；改错故障 静态药丸显示 pending 空心。',
      '// INV-11 等待中的留白强制 running：守住位置 waiting 判定；改错故障 后续 stage 规则把它改回 pending。',
      '// INV-12 行进边三条优先级：守住位置 回边到轨道段到弧；改错故障 同时亮多条或一条都不亮。',
      '// INV-13 流轨与双线段不行进：守住位置 kind 过滤；改错故障 并行线被画成已流转。',
      '// INV-14 空集合默认省略字段：守住位置 各展开三元；改错故障 产物里出现大量空数组与空表。',
      '//',
      '// 模块职责：把工作流图与运行投影折成时间线的站、轨道段、弧与带。',
      '// 阅读顺序：先看类型与入口，再看边折叠与站构造，最后看墨迹、行进边与带。',
    ],
    blocks: [
      {
        anchor: 'export function buildWorkflowTimeline(',
        lines: [
          '缓存版本与显式标签版本共用一个计算函数。',
        ],
      },
      {
        anchor: 'if (holeLabels !== undefined) return computeWorkflowTimeline(input, run, holeLabels);',
        lines: [
          '给了留白标签就不走共享缓存。',
        ],
      },
      {
        anchor: 'const { graph, parents, phases } = timelineHoleGraph(withImplicitPhase(input));',
        lines: [
          '先补隐式阶段，再收缩留白头。',
        ],
      },
      {
        anchor: 'const index = new Map(phases.map((phase, i) => [phase.id, i]));',
        lines: [
          '下标是后续所有结构的唯一坐标。',
        ],
      },
      {
        anchor: 'const askingInstances = new Set(',
        lines: [
          '待答问题按实例身份收成集合。',
        ],
      },
      {
        anchor: 'if (from === undefined || to === undefined || from === to) continue;',
        lines: [
          '自环与未列出阶段在这一粒度丢弃。',
        ],
      },
      {
        anchor: 'const key = `${from}>${to}`;',
        lines: [
          '同向重复边按下标去重。',
        ],
      },
      {
        anchor: 'const folded = foldPhaseBands(phases.length, alongsideIndexes, streams);',
        lines: [
          '带折叠先于边折叠，弧把带当节点。',
        ],
      },
      {
        anchor: 'const avatarKey = `${participant.lane}@${instance?.ordinal ?? (participant.member?.index ?? 0) + 1}`;',
        lines: [
          '头像按实例身份分配，跨阶段复用。',
        ],
      },
      {
        anchor: 'const status =',
        lines: [
          '无 run 与无输出是两种不同的空。',
        ],
      },
      {
        anchor: 'const waiting = hole?.state === "waiting";',
        lines: [
          '等待中的留白就是当前站。',
        ],
      },
      {
        anchor: 'if (reentry !== undefined) {',
        lines: [
          '行进边优先走再入回边。',
        ],
      },
      {
        anchor: 'const landing = arcs.find((arc) => !arc.stream && arc.to === r && visited(arc.from));',
        lines: [
          '最后才落到进入该站的弧。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/feedback/FeedbackProcessView.tsx',
    target: 30,
    header: [
      '// INV-01 纯展示组件：守住位置 props 解构；改错故障 流程页自己发请求，与详情页状态分叉。',
      '// INV-02 时间线由事件与补充合并：守住位置 getFeedbackTimelineItems；改错故障 补充内容不出现在流程里。',
      '// INV-03 最新项可能不存在：守住位置 latestItem 条件渲染；改错故障 空数组下读取 undefined 崩溃。',
      '// INV-04 最新摘要按角色兜底：守住位置 isStaff 三元；改错故障 无摘要时显示空白一行。',
      '// INV-05 步骤数取合并后长度：守住位置 timelineItems.length；改错故障 与时间线实际条目数不一致。',
      '// INV-06 返回是唯一导航出口：守住位置 onBack；改错故障 页面内出现第二套路由逻辑。',
      '// INV-07 进度只消费状态与指派人：守住位置 FeedbackProgress 入参；改错故障 进度条自行解释状态。',
      '// INV-08 流程视图展示耗时：守住位置 showDurations；改错故障 各段耗时只在详情页可见。',
      '// INV-09 补充提交只回调刷新：守住位置 onSubmitted；改错故障 提交后组件内重复拉取，出现双份数据。',
      '// INV-10 标题最多两行：守住位置 line-clamp-2；改错故障 超长标题挤掉右侧计数。',
      '// INV-11 时间用相对格式：守住位置 formatRelativeTime；改错故障 不同区块时间口径不一致。',
      '// INV-12 全部文案走 intl：守住位置 formatMessage；改错故障 页面出现硬编码中文。',
      '// INV-13 区块间距固定：守住位置 gap-5；改错故障 补充编辑器出现后整体错位。',
      '// INV-14 组件不持有状态：守住位置 无 useState；改错故障 返回后筛选条件残留。',
      '//',
      '// 模块职责：反馈工单的处理流程页，展示进度、时间线与补充输入。',
      '// 阅读顺序：先看头部摘要，再看时间线区块，最后看补充编辑器。',
    ],
    blocks: [
      {
        anchor: 'export function FeedbackProcessView({',
        lines: [
          '所有数据来自 props，组件不发请求。',
        ],
      },
      {
        anchor: 'const formatMessage = intl.formatMessage;',
        lines: [
          '取出格式化函数，避免每处重复解构。',
        ],
      },
      {
        anchor: 'const timelineItems = getFeedbackTimelineItems(ticket.events ?? [], ticket.comments, formatMessage);',
        lines: [
          '事件与补充合并成一条时间线。',
        ],
      },
      {
        anchor: 'const latestItem = timelineItems.at(-1);',
        lines: [
          '最新项可能不存在。',
        ],
      },
      {
        anchor: 'onClick={onBack}',
        lines: [
          '返回是这里唯一的导航出口。',
        ],
      },
      {
        anchor: '{formatMessage({ id: "feedback.process.title" })}',
        lines: [
          '区块标题与图标同行。',
        ],
      },
      {
        anchor: '{ticket.title}',
        lines: [
          '标题最多两行，超出截断。',
        ],
      },
      {
        anchor: '{ count: String(timelineItems.length) },',
        lines: [
          '步骤数取合并后的时间线长度。',
        ],
      },
      {
        anchor: '<FeedbackProgress status={ticket.status} assigneeDisplay={ticket.assignee_display} />',
        lines: [
          '进度只消费状态与指派人。',
        ],
      },
      {
        anchor: '{latestItem ? (',
        lines: [
          '没有最新项时整块不渲染。',
        ],
      },
      {
        anchor: '{latestItem.summary ??',
        lines: [
          '摘要缺失时按角色给兜底文案。',
        ],
      },
      {
        anchor: '<FeedbackTimeline events={ticket.events ?? []} comments={ticket.comments} showDurations />',
        lines: [
          '流程视图展示各段耗时。',
        ],
      },
      {
        anchor: 'onSubmitted={onRefresh}',
        lines: [
          '提交后交给父级刷新，组件不自行重取。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/highspeed/highspeedOutputFooter.ts',
    target: 30,
    header: [
      '// INV-01 标记只打组尾：守住位置 lastUnitIndex === index；改错故障 一张卡出现多个 footer。',
      '// INV-02 footer 属于整张卡：守住位置 状态按 cardId 聚合；改错故障 多轮卡片每轮各显示一次。',
      '// INV-03 过期是必要条件：守住位置 expiresAt <= nowMs；改错故障 倒计时未结束就显示来源。',
      '// INV-04 组尾无正文也认前序输出：守住位置 hasOutput 或链；改错故障 中断的最后一轮吞掉 footer。',
      '// INV-05 timelineMarker 不算输出：守住位置 kind 过滤；改错故障 空卡片仅凭标记就展示指标。',
      '// INV-06 TPS 必须齐全且为正：守住位置 metas.some；改错故障 零除得到 Infinity 或 NaN。',
      '// INV-07 零令牌不聚合：守住位置 outputTokens <= 0；改错故障 分享参数出现 0 tok/s。',
      '// INV-08 普通耗时按令牌除 TPS 累加：守住位置 regularDurationSeconds；改错故障 加权方式与单轮不一致。',
      '// INV-09 savedDuration 优先取持久值：守住位置 ?? 右侧重算；改错故障 冷恢复与在线口径不同。',
      '// INV-10 model/tool 耗时需全齐：守住位置 metas.every；改错故障 部分轮次缺失时给出偏小的总和。',
      '// INV-11 other 工时是差值：守住位置 Math.max(0, ...)；改错故障 四段之和超过总耗时。',
      '// INV-12 卡级 TPS 取首条：守住位置 metas[0]；改错故障 各轮持久值不同时出现漂移。',
      '// INV-13 无指标仍打标：守住位置 metrics 三元；改错故障 footer 整块消失，文案跳动。',
      '// INV-14 冷恢复与在线同一聚合：守住位置 单一实现；改错故障 两条路径各写一份公式。',
      '//',
      '// 模块职责：为 Highspeed 卡片标记组尾 footer，并按持久化元数据聚合分享指标。',
      '// 阅读顺序：先看标记入口，再看按卡收口，最后看指标聚合的校验与加权。',
    ],
    blocks: [
      {
        anchor: 'export function markHighspeedOutputFooterUnits<T extends HighspeedFooterUnit>(',
        lines: [
          '标记只加在组尾单元上，不复制数据。',
        ],
      },
      {
        anchor: 'if (!footerByUnitIndex.has(index)) return unit;',
        lines: [
          '未命中的单元保持原引用。',
        ],
      },
      {
        anchor: 'showHighspeedOutputFooter: true as const,',
        lines: [
          '打标与 target 一起写入。',
        ],
      },
      {
        anchor: 'unit.visibleUserInputs.flatMap((row) => (row.highspeed ? [row.highspeed] : [])),',
        lines: [
          '只收集带 highspeed 元数据的用户输入。',
        ],
      },
      {
        anchor: 'lastUnitIndex: index,',
        lines: [
          '后写覆盖前写，最终停在组尾。',
        ],
      },
      {
        anchor: '(card.outputTokens ?? 0) > 0 ||',
        lines: [
          '前序 turn 有输出也算整卡有输出。',
        ],
      },
      {
        anchor: 'units[index]!.assistantWorkRows.some((row) => row.kind !== "timelineMarker"),',
        lines: [
          '时间线标记不是模型输出。',
        ],
      },
      {
        anchor: 'return card.expiresAt <= nowMs && state?.lastUnitIndex === index && state.hasOutput;',
        lines: [
          '过期、组尾、有输出三条同时成立。',
        ],
      },
      {
        anchor: 'footerByUnitIndex.set(index, metrics ? { cardId: footerCard.cardId, metrics } : null);',
        lines: [
          '无指标也打标，只是不带 target。',
        ],
      },
      {
        anchor: 'meta.highspeedTps <= 0,',
        lines: [
          '每个 turn 的 TPS 必须齐全且为正。',
        ],
      },
      {
        anchor: 'const outputTokens = metas.reduce((total, meta) => total + (meta.outputTokens ?? 0), 0);',
        lines: [
          '令牌总数按 turn 累加。',
        ],
      },
      {
        anchor: 'if (outputTokens <= 0) return null;',
        lines: [
          '零输出没有可分享的指标。',
        ],
      },
      {
        anchor: 'highspeedTps: metas[0]!.highspeedTps!,',
        lines: [
          '卡级 TPS 取首条权威值。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/hooks/useProviderSettingsView.ts',
    target: 30,
    header: [
      '// INV-01 两个 hook 面向不同来源：守住位置 两个导出；改错故障 编辑器误用全局快照，读不到目标 Environment。',
      '// INV-02 全局版本用外部 store：守住位置 useSyncExternalStore；改错故障 自建轮询导致撕裂。',
      '// INV-03 重载失败只记日志：守住位置 catch；改错故障 快照加载失败把设置页打成白屏。',
      '// INV-04 service 版本按代际号丢弃旧回调：守住位置 generationRef；改错故障 旧 service 的响应写进新页面。',
      '// INV-05 换代保留同 service 的 ready：守住位置 retainedReady；改错故障 每次 effect 重跑都闪一次 loading。',
      '// INV-06 只允许当前 service 提交：守住位置 两处 service 比较；改错故障 旧 Environment 回写新编辑器。',
      '// INV-07 revision 只增不减：守住位置 Math.max；改错故障 乱序事件把视图回退。',
      '// INV-08 同 revision 不重复渲染：守住位置 等值判断；改错故障 事件与 mutation 响应各渲染一次。',
      '// INV-09 失败只在无 ready 时展示：守住位置 hasReadyView；改错故障 已有数据被一个迟到错误覆盖。',
      '// INV-10 自增即作废旧订阅：守住位置 effect 首行与清理；改错故障 双订阅并存。',
      '// INV-11 清理退订再自增：守住位置 return 函数；改错故障 StrictMode 下重复回调。',
      '// INV-12 reloadVersion 只触发 effect：守住位置 useReducer；改错故障 重试走另一条未同步路径。',
      '// INV-13 service 不匹配时回 loading：守住位置 visibleState；改错故障 新 service 首帧显示旧数据。',
      '// INV-14 commit 外部回调不返回值：守住位置 包装函数；改错故障 调用方误以为拿到提交结果。',
      '//',
      '// 模块职责：Provider 设置视图的全局快照订阅，以及按 ServiceProvider 隔离的编辑器读取。',
      '// 阅读顺序：先看全局 hook，再看 service hook 的提交校验，最后看 effect 代际与清理。',
    ],
    blocks: [
      {
        anchor: 'export function useProviderSettingsView(): ProviderSettingsRead {',
        lines: [
          '全局版本只订阅快照，不持有本地状态。',
        ],
      },
      {
        anchor: 'const state = useSyncExternalStore(',
        lines: [
          '快照来源与订阅同源，避免竞态。',
        ],
      },
      {
        anchor: 'void reloadProviderSettingsSnapshot().catch((error) => {',
        lines: [
          '重载失败只记日志。',
        ],
      },
      {
        anchor: 'export function useProviderSettingsServiceView(',
        lines: [
          'service 版本面向编辑器，需要显式失败与重试。',
        ],
      },
      {
        anchor: 'const [reloadVersion, reload] = useReducer((value: number) => value + 1, 0);',
        lines: [
          '版本号只用来触发 effect 重跑。',
        ],
      },
      {
        anchor: 'const visibleState = owned.service === service ? owned.state : ({ status: "loading" } as const);',
        lines: [
          'service 换代时先回到 loading。',
        ],
      },
      {
        anchor: 'if (serviceRef.current !== service || ownedRef.current.service !== service) {',
        lines: [
          '旧 service 的 mutation 一律拒绝。',
        ],
      },
      {
        anchor: 'const latestRevision = Math.max(currentRevision, latestRevisionRef.current);',
        lines: [
          'revision 只增不减。',
        ],
      },
      {
        anchor: 'if (view.revision < latestRevision) {',
        lines: [
          '过期 revision 不得回写。',
        ],
      },
      {
        anchor: 'if (view.revision === latestRevision && current.status === "ready") {',
        lines: [
          '同 revision 的重复事件不重复渲染。',
        ],
      },
      {
        anchor: 'generationRef.current += 1;',
        nth: 1,
        lines: [
          '自增即作废旧代回调。',
        ],
      },
      {
        anchor: 'if (generation !== generationRef.current) return;',
        nth: 1,
        lines: [
          '代际不符的回调直接丢弃。',
        ],
      },
      {
        anchor: 'if (!hasReadyView) setOwned({ service, state: { status: "error", error } });',
        lines: [
          '已有 ready 时不覆盖为错误。',
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
    `ZC-deep-b217-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
