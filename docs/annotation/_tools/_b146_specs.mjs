import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/BotsDialog/WorkspaceAccessCard.tsx',
    target: 39,
    header: [
      '// INV-01 全权模式由哨兵值表达：守住位置 ALL_BOT_WORKSPACES；改错故障 空数组被当成未授权。',
      '// INV-02 访问模式固定两类取值：守住位置 Select value；改错故障 未知值渲染成空白。',
      '// INV-03 全权时计数取全部工作区：守住位置 allowedCount 分支；改错故障 描述里的数量归零。',
      '// INV-04 选中时计数只算现存工作区：守住位置 filter 交集；改错故障 已删除工作区仍被计入。',
      '// INV-05 保存只传两种列表：守住位置 onValueChange；改错故障 混合模式写入非法列表。',
      '// INV-06 无工作区时禁用选择：守住位置 disabled；改错故障 空列表仍能切到选中模式。',
      '// INV-07 加载中禁止交互：守住位置 loading；改错故障 并发提交互相覆盖。',
      '// INV-08 全权模式不渲染明细：守住位置 detail 分支；改错故障 全选状态仍逐项列一遍。',
      '// INV-09 勾选状态来自配置：守住位置 includes；改错故障 本地临时态与服务端脱节。',
      '// INV-10 点击即取反提交：守住位置 onToggleWorkspaceAccess 入参；改错故障 勾选方向与显示相反。',
      '// INV-11 工作区标识用 id：守住位置 key 与比较；改错故障 同名路径互相顶替。',
      '// INV-12 展示名允许重复：守住位置 label 渲染；改错故障 以名称作键引发错位。',
      '// INV-13 路径仅作辅助展示：守住位置 副标题；改错故障 路径被当成身份参与判定。',
      '// INV-14 计数来自服务端配置：守住位置 bot.allowedWorkspaces；改错故障 前端自算产生漂移。',
      '// INV-15 空列表回落到首个工作区：守住位置 切到选中模式；改错故障 选中模式没有可选项。',
      '// INV-16 图标仅作视觉提示：守住位置 勾选框图标；改错故障 无标签按钮失去语义。',
      '// INV-17 文案全部走国际化：守住位置 formatMessage；改错故障 中文硬编码直接透出。',
      '// INV-18 卡片不持有本地状态：守住位置 组件体；改错故障 刷新后回退旧值。',
      '//',
      '// 模块职责：渲染 Bot 的工作区访问范围选择卡与逐项勾选明细。',
      '// 状态所有权：全部来自 bot 配置与父级回调；组件无本地状态。',
      '// 阅读顺序：先看两种模式取值，再看计数与明细渲染，最后看事件回调。',
    ],
    blocks: [
      {
        anchor: 'const { intl } = useZCodeIntl();',
        lines: [
          '国际化实例取自上下文。',
          '文案键集中在 bots.allowedWorkspaces 前缀。',
          '组件不缓存格式化结果。',
          '语言切换随 Provider 重渲染。',
        ],
      },
      {
        anchor: 'const allAllowed = isAllWorkspacesAllowed(bot.allowedWorkspaces);',
        lines: [
          '全权判定只认哨兵值。',
          '空数组视为未授权而非全权。',
          '判定结果同时驱动下拉值与明细分支。',
          '判定逻辑与设置页共用同一函数。',
        ],
      },
      {
        anchor: 'const allowedCount = allAllowed',
        lines: [
          '全权时直接取工作区总数。',
          '选中时与现存工作区求交集。',
          '已删除的工作区不计入描述。',
        ],
      },
      {
        anchor: 'const checked = bot.allowedWorkspaces.includes(workspace.id);',
        lines: [
          '勾选态每次渲染从配置重算。',
          '不维护本地勾选集合。',
          '点击后由父级回写配置。',
        ],
      },
      {
        anchor: 'return (',
        nth: 1,
        lines: [
          '整卡交给设置行容器排版。',
          '描述与控件分区渲染。',
          '明细区只在部分授权时出现。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/components/workflow-timeline/WorkflowRunDigest.tsx',
    target: 46,
    header: [
      '// INV-01 折叠不影响数据：守住位置 expanded；改错故障 收起丢失运行进度。',
      '// INV-02 阶段线需图与投影同在：守住位置 model 构造；改错故障 已完成 run 被画成未跑。',
      '// INV-03 无轨道即退化为单行：守住位置 hasRail；改错故障 空轨道仍占用高度。',
      '// INV-04 收起只清空药丸：守住位置 shown 映射；改错故障 收起后子代理入口消失。',
      '// INV-05 空白区点击才切换折叠：守住位置 hitsControl；改错故障 点按钮误触折叠。',
      '// INV-06 键盘只认回车与空格：守住位置 onKeyDown；改错故障 其他按键被吞。',
      '// INV-07 问题数与留白数分列：守住位置 leading；改错故障 两类提示互相覆盖。',
      '// INV-08 待答问题用警示色：守住位置 questions 片段；改错故障 关键提示不可见。',
      '// INV-09 留白芯片可点开整体 run：守住位置 HolesWaitingChip；改错故障 只能看不能进。',
      '// INV-10 恢复与停止互斥：守住位置 resume 与 cancel 二选一；改错故障 同时出现两个动作。',
      '// INV-11 停止按钮按状态键控重挂：守住位置 key；改错故障 状态复位引发重复提交。',
      '// INV-12 配置钮位置固定：守住位置 configure；改错故障 出现时挤动详情入口。',
      '// INV-13 种类词随状态变化：守住位置 kind；改错故障 结束态仍显示运行中。',
      '// INV-14 结束态不显示运行动作：守住位置 live；改错故障 已结束 run 仍可取消。',
      '// INV-15 详情串不含 lineage：守住位置 cardDetail；改错故障 卡面信息过载。',
      '// INV-16 子代理模型名可缺省：守住位置 subagentModelProviderName；改错故障 内部标识被直接显示。',
      '// INV-17 只读投影驱动渲染：守住位置 summary；改错故障 卡内维护第二份状态。',
      '// INV-18 测试标识由宿主给出：守住位置 testIdKey；改错故障 多卡共用同一 id。',
      '//',
      '// 模块职责：渲染工作流 run 的摘要卡，含阶段线、留白与问题提示、运行控制。',
      '// 状态所有权：运行事实来自 summary 投影；仅折叠态为组件本地状态。',
      '// 阅读顺序：先看阶段模型与折叠，再看提示与动作，最后看表头与轨道渲染。',
    ],
    blocks: [
      {
        anchor: 'const run = summary?.run;',
        lines: [
          '运行对象来自活投影。',
          '缺席时整卡退成中性单行。',
          '组件不自行查询运行状态。',
          '状态变化由上层重渲染带入。',
        ],
      },
      {
        anchor: 'const hasRail = model !== undefined && model.stations.length > 0;',
        lines: [
          '有阶段站才有可折叠轨道。',
          '无图或无投影时不画轨道。',
          '该标志同时决定可点击与可聚焦。',
          '轨道高度由模型统一计算。',
        ],
      },
      {
        anchor: 'const hitsControl = (target: EventTarget | null, root: HTMLElement) => {',
        lines: [
          '只把空白区域当作折叠触发。',
          '交互控件一律放行给自身处理。',
          '比较节点避免误判根元素。',
          '冒泡到卡上的事件仍会经过此判断。',
        ],
      },
      {
        anchor: 'const format = intl.formatMessage.bind(intl);',
        lines: [
          '绑定后可在多处复用。',
          '文案键由运行状态映射得到。',
          '数量类文案带计数参数。',
          '缺键时由 Provider 回退。',
        ],
      },
      {
        anchor: 'const holesWaiting = (run?.holes ?? []).filter((hole) => hole.state === "waiting").length;',
        lines: [
          '只统计等待补全的留白。',
          '无运行对象时计数为零。',
          '数值驱动笔芯片显隐。',
          '笔芯片与问题芯片可以并存。',
        ],
      },
      {
        anchor: 'const configure =',
        lines: [
          '只在有配置宿主且 run 存在时出现。',
          '位置固定在恢复与停止之前。',
          '出现与否不挪动详情入口。',
          '配置内容由弹层宿主提供。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/feedback/feedbackTimelineSummary.ts',
    target: 39,
    header: [
      '// INV-01 摘要先去首尾空白：守住位置 trim；改错故障 空格导致匹配失败。',
      '// INV-02 只翻译已知系统摘要：守住位置 白名单；改错故障 用户原文被改写。',
      '// INV-03 已知摘要直出文案键：守住位置 映射表；改错故障 同类事件出现多种说法。',
      '// INV-04 状态变更需状态可识别：守住位置 toKnownFeedbackStatus；改错故障 未知状态被当已知。',
      '// INV-05 指派事件只换身份说法：守住位置 正则；改错故障 开发姓名被透出。',
      '// INV-06 匹配失败即原样返回：守住位置 各分支早退；改错故障 未匹配文本被吞掉。',
      '// INV-07 进度更新可带状态：守住位置 复合正则；改错故障 状态与正文混成一串。',
      '// INV-08 标记事件保留正文：守住位置 markedStatus；改错故障 处理结论丢失。',
      '// INV-09 代理提交提取名字：守住位置 agentSubmitted；改错故障 名字与模板硬拼。',
      '// INV-10 已知状态集合来自元数据：守住位置 FEEDBACK_STATUS_MESSAGE_IDS；改错故障 新增状态前端不认。',
      '// INV-11 状态标签统一走格式化：守住位置 formatStatusLabel；改错故障 中英文案混排。',
      '// INV-12 无格式化器时用回退串：守住位置 formatOptionalMessage；改错故障 纯函数抛异常。',
      '// INV-13 回退串与历史中文一致：守住位置 fallback 入参；改错故障 老数据展示错乱。',
      '// INV-14 消息标识集中在一处：守住位置 getKnownSystemSummaryMessageId；改错故障 键散落难维护。',
      '// INV-15 未知摘要一律原样：守住位置 末尾返回；改错故障 猜测性翻译误导用户。',
      '// INV-16 纯函数不读全局状态：守住位置 模块顶层；改错故障 测试依赖运行时。',
      '// INV-17 事件类型只影响个别分支：守住位置 assignee_changed；改错故障 所有事件被同等处理。',
      '// INV-18 状态参数允许为空：守住位置 toKnownFeedbackStatus 入参；改错故障 空值直接抛错。',
      '//',
      '// 模块职责：把反馈工单事件摘要翻译为可国际化的用户文案。',
      '// 状态所有权：纯函数与消息标识映射；无运行时状态。',
      '// 阅读顺序：先看入口函数的四条分支，再看已知摘要表，最后看格式化辅助。',
    ],
    blocks: [
      {
        anchor: 'const normalizedSummary = event.summary.trim();',
        lines: [
          '归一化只做去空白。',
          '原文用于后续所有匹配。',
          '不改动大小写与标点。',
        ],
      },
      {
        anchor: 'const directMessageId = getKnownSystemSummaryMessageId(summary);',
        lines: [
          '命中白名单即直接翻译。',
          '未命中继续走模式匹配。',
          '两条路径共用同一格式化出口。',
        ],
      },
      {
        anchor: 'function getKnownSystemSummaryMessageId(summary: string) {',
        lines: [
          '每个分支对应一条固定摘要。',
          '两种日志上传文案共用同一键。',
          '未知摘要返回空值。',
          '新增文案在此追加分支。',
        ],
      },
      {
        anchor: 'function formatProgressWithMessage(',
        lines: [
          '正文作为插值参数传入。',
          '回退串保持历史中文。',
          '带状态与不带状态两条入口共用。',
        ],
      },
      {
        anchor: 'function formatOptionalMessage(',
        lines: [
          '有格式化器时走国际化。',
          '缺席时返回调用方给的原文。',
          '插值参数原样传递。',
          '保证纯函数可独立测试。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/gen-ui/components/TweakPanel.tsx',
    target: 39,
    header: [
      '// INV-01 初始值由快照给出：守住位置 snapshot；改错故障 首次渲染为空白。',
      '// INV-02 原值集合只在渲染时构建：守住位置 Object.fromEntries；改错故障 重置拿到旧值。',
      '// INV-03 控件值以 id 为键：守住位置 change 入参；改错故障 同名控件互相覆盖。',
      '// INV-04 修改即写回页面：守住位置 page.setTweaks；改错故障 预览不刷新。',
      '// INV-05 重置回到原值：守住位置 重置按钮；改错故障 只能逐项手改。',
      '// INV-06 原值预览是开关：守住位置 preview；改错故障 无法对照改动前后。',
      '// INV-07 提交期间禁用按钮：守住位置 busy；改错故障 重复提交产生多份结果。',
      '// INV-08 提交错误就地展示：守住位置 error 与 role=alert；改错故障 失败没有任何提示。',
      '// INV-09 重试前先清空错误：守住位置 setError；改错故障 旧错误残留。',
      '// INV-10 提交结束必复位忙碌：守住位置 finally；改错故障 按钮永久禁用。',
      '// INV-11 三类控件分别渲染：守住位置 条件分支；改错故障 滑块被画成文本框。',
      '// INV-12 滑块数值转数字：守住位置 Number；改错故障 字符串值进入参数。',
      '// INV-13 颜色控件用原生取色：守住位置 type=color；改错故障 颜色格式不受控。',
      '// INV-14 滑块显示当前值与单位：守住位置 output；改错故障 拖动没有反馈。',
      '// INV-15 分组标题来自快照：守住位置 legend；改错故障 分组含义不明。',
      '// INV-16 控件标签同时作可访问名：守住位置 aria-label；改错故障 读屏无法识别。',
      '// INV-17 面板只做展示与转发：守住位置 组件体；改错故障 面板持有业务状态。',
      '// INV-18 分组键用位置索引：守住位置 key；改错故障 分组重排后状态错位。',
      '//',
      '// 模块职责：渲染生成式界面的调参面板，负责改动、预览与提交。',
      '// 状态所有权：参数值归页面快照；面板仅持有忙碌与错误两个局部态。',
      '// 阅读顺序：先看原值与改动回调，再看三类控件渲染，最后看底部动作。',
    ],
    blocks: [
      {
        anchor: 'const { groups, tweakValues: values, previewOriginal: preview } = snapshot;',
        lines: [
          '分组与当前值同源。',
          '预览标志控制对照视图。',
          '快照更新即整体重渲染。',
          '面板不复制参数值。',
        ],
      },
      {
        anchor: 'const original = Object.fromEntries(',
        lines: [
          '展平所有分组的控件。',
          '以控件 id 为键取初始值。',
          '仅在渲染期构建。',
          '重置按钮使用该集合。',
        ],
      },
      {
        anchor: 'const change = (id: string, value: string | number | boolean) => {',
        lines: [
          '只改动目标控件。',
          '其余值原样展开。',
          '写回由页面负责。',
          '不在此处做取值校验。',
        ],
      },
      {
        anchor: 'return (',
        nth: 1,
        lines: [
          '面板整体限高可滚动。',
          '分组以字段集组织。',
          '底部依次是重置、对照与提交。',
          '错误提示置于最末。',
          '外层容器带固定测试标识。',
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
    `ZC-deep-b146-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
