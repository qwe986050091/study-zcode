// B209 四个文件的注释 spec 生成器（target 全部为 30）。
import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/components/marketing-touch/MarketingDialogs.tsx',
    target: 30,
    header: [
      '// INV-01 claim 错误走独立弹窗：守住位置 errorAction 判定；改错故障 领取失败被普通 toast 吞掉。',
      '// INV-02 非 claim 错误只提示一次：守住位置 toast 后立即 clearError；改错故障 同一错误反复弹出。',
      '// INV-03 提示副作用依赖 claimError：守住位置 useEffect 依赖数组；改错故障 领取失败时又叠一层 toast。',
      '// INV-04 内容按投递位选择：守住位置 resource_position 三元；改错故障 banner 活动误用 popup 载荷。',
      '// INV-05 缺少内容即不渲染：守住位置 payload 与 content 双条件；改错故障 空弹窗遮罩无法关闭。',
      '// INV-06 升级导航打开时让位：守住位置 open 的 !openingUpgrade；改错故障 两个弹层同时抢占焦点。',
      '// INV-07 claim 错误优先于内容弹窗：守住位置 open 的 !claimError；改错故障 失败提示被营销内容盖住。',
      '// INV-08 pending 透传为 actionPending：守住位置 属性绑定；改错故障 重复点击造成多次领取。',
      '// INV-09 四个动作语义固定：守住位置 handlers 的键名；改错故障 载荷按照错误语义派发。',
      '// INV-10 导航动作要按 id 反查按钮：守住位置 find 的下标拼接；改错故障 点哪个都跳第一个按钮。',
      '// INV-11 动作失败必须抛错：守住位置 两处 status 判定；改错故障 失败被当成成功，弹窗直接关闭。',
      '// INV-12 复制失败用独立错误码：守住位置 marketing_copy_failed；改错故障 无法区分复制与导航故障。',
      '// INV-13 文案全部走 intl：守住位置 四处 formatMessage；改错故障 多语言环境出现硬编码英文。',
      '// INV-14 关闭动作不等待结果：守住位置 void controller.closeDialog；改错故障 React 收到 Promise 返回值。',
      '//',
      '// 模块职责：把营销触达控制器状态映射成失败弹窗与内容弹窗，并转译四类用户动作。',
      '// 阅读顺序：先看错误提示副作用，再看内容选择与两个弹窗的互斥条件，最后看动作处理表。',
    ],
    blocks: [
      {
        anchor: 'const claimError = state.errorAction === "claim_zcode_plan" ? state.error : null;',
        lines: [
          '只有领取动作的错误才升级为阻断式弹窗。',
        ],
      },
      {
        anchor: 'if (state.error && !claimError) {',
        lines: [
          '领取错误已交给弹窗，这里不能重复提示。',
        ],
      },
      {
        anchor: 'const content = !dialog',
        lines: [
          '先判空再取投递位，避免读 undefined 的 delivery。',
        ],
      },
      {
        anchor: '? dialog.delivery.popup',
        lines: [
          'popup 位直接取弹窗载荷。',
        ],
      },
      {
        anchor: ': dialog.delivery.banner.success_popup;',
        lines: [
          'banner 位只在成功场景展示，取 success_popup。',
        ],
      },
      {
        anchor: '? adaptMarketingPopup(',
        lines: [
          '载荷适配统一入口，页面层不直接拼字段。',
        ],
      },
      {
        anchor: '{claimError ? (',
        lines: [
          '领取失败优先级最高，单独渲染。',
        ],
      },
      {
        anchor: '{payload && content ? (',
        lines: [
          '内容与载荷都齐备才挂载对话框。',
        ],
      },
      {
        anchor: 'open={!openingUpgrade && !claimError}',
        lines: [
          '升级页已打开或领取失败时都不再显示。',
        ],
      },
      {
        anchor: 'void controller.closeDialog();',
        lines: [
          '关闭是异步的，这里显式丢弃返回值。',
        ],
      },
      {
        anchor: 'copy_text: async (action) => {',
        lines: [
          '复制结果由控制器返回，本层只做失败转抛。',
        ],
      },
      {
        anchor: 'navigate: async (_action, actionId) => {',
        lines: [
          '第一个参数不用，按 actionId 反查按钮。',
        ],
      },
      {
        anchor: 'if (button?.action.type !== "navigate")',
        lines: [
          '按钮缺失或动作类型不符都视为无效导航。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/gen-ui/app/tweaks.ts',
    target: 30,
    firstNth: 1,
    header: [
      '// INV-01 注册表只保留每个 target 的最新条目：守住位置 owners 的覆盖写入；改错故障 同一 tweak 出现两份控件。',
      '// INV-02 target 取 targets[0]：守住位置 三处首元素读取；改错故障 多目标注册的控件挂到错误节点。',
      '// INV-03 两种接受态都走同一代际校验：守住位置 register 与 update 的三元；改错故障 update 被当成首次注册或反之。',
      '// INV-04 注册上限 64：守住位置 registrations.size 判断；改错故障 异常页面持续注册耗尽内存。',
      '// INV-05 更新不得改 target：守住位置 update 分支的 id 比较；改错故障 控件静默搬家。',
      '// INV-06 回调名全局唯一：守住位置 otherCallbacks 集合；改错故障 两个 tweak 抢同一个回调。',
      '// INV-07 选择前校验目标仍存在：守住位置 select 分支的 owners 查找；改错故障 已卸载组件的选择残留在状态里。',
      '// INV-08 dispose 要清掉指向它的选择：守住位置 registrationId 判等；改错故障 标注引用已删除的注册。',
      '// INV-09 非法输入一律抛错而非忽略：守住位置 四处 throw；改错故障 静默失败让页面以为已生效。',
      '// INV-10 range 对外显示为 slider：守住位置 类型映射；改错故障 未知控件类型下发到渲染层。',
      '// INV-11 回调名与当前值分别映射为 id 与 value：守住位置 解构重命名；改错故障 前端拿不到可提交字段。',
      '// INV-12 标注恒为未激活：守住位置 active: false；改错故障 快照误报用户已确认。',
      '// INV-13 只收集值与当前值不同且合法的变更：守住位置 isGenUiAnnotationValue；改错故障 非法值被写进补丁。',
      '// INV-14 消息先过 zod 再分发：守住位置 schema.parse；改错故障 任意载荷进入状态机。',
      '//',
      '// 模块职责：页面内 Tweak 的注册、选择、列举与变更标注。',
      '// 阅读顺序：先看 owners 的去重规则，再看 handle 的四个分支，最后看 groups 与 annotation 的输出形状。',
    ],
    blocks: [
      {
        anchor: 'const registrations = new Map<string, Registration>();',
        lines: [
          '按 registrationId 保留原始注册消息，便于代际比较。',
        ],
      },
      {
        anchor: 'let selection: GenUiTweakAnnotation["selection"] = null;',
        lines: [
          '选择是全局单值，同一时刻只允许一个控件被选中。',
        ],
      },
      {
        anchor: 'for (const entry of registrations.values()) latest.set(entry.targets[0]!.id, entry);',
        lines: [
          '后写入覆盖先写入，实现同 target 的最新者胜。',
        ],
      },
      {
        anchor: 'const message = genUiTweakMessageSchema.parse(input);',
        lines: [
          '入口先校验，后续分支可放心按类型收窄。',
        ],
      },
      {
        anchor: 'if (message.type === "select") {',
        lines: [
          '选择前必须证明该 target 仍在当前注册表里。',
        ],
      },
      {
        anchor: 'const previous = registrations.get(message.registrationId);',
        lines: [
          '注册与更新共享同一条代际规则。',
        ],
      },
      {
        anchor: '? previous || registrations.size >= 64',
        lines: [
          'register 要求 id 未占用且未超上限。',
        ],
      },
      {
        anchor: ': !previous || previous.targets[0]!.id !== message.targets[0]!.id',
        lines: [
          'update 要求已存在且 target 未变。',
        ],
      },
      {
        anchor: 'const otherCallbacks = new Set(',
        lines: [
          '收集其它注册占用的回调名，用于全局唯一性检查。',
        ],
      },
      {
        anchor: 'registrations.set(message.registrationId, message);',
        lines: [
          '校验通过后才落表，失败不会留下半成品。',
        ],
      },
      {
        anchor: 'groups(): GenUiTweak[] {',
        lines: [
          '对外分组按 target 去重后的顺序输出。',
        ],
      },
      {
        anchor: 'const { callback: id, currentValue: value, ...rest } = control;',
        lines: [
          '回调名对前端暴露为 id，当前值暴露为 value。',
        ],
      },
      {
        anchor: 'const annotationControlChanges = entry.annotationControls.controls.flatMap((control) => {',
        lines: [
          '逐控件比较当前值与提交值，相同即跳过。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/git-action-menu/commitConversationContext.ts',
    target: 30,
    header: [
      '// INV-01 三个上限同时生效：守住位置 三个常量与两处判定；改错故障 提交信息被上下文撑爆。',
      '// INV-02 从最新消息往前收集：守住位置 逆序循环；改错故障 只有早期闲聊进入上下文。',
      '// INV-03 选中后恢复正序：守住位置 reverse；改错故障 模型看到的对话顺序倒置。',
      '// INV-04 首条不参与总长判定：守住位置 selectedMessages.length > 0；改错故障 长消息永远选不中，结果为 null。',
      '// INV-05 总长按字符加角色开销估算：守住位置 nextCost 的加八；改错故障 预算低估导致超限。',
      '// INV-06 单条超长截断并留标记：守住位置 clipConversationText；改错故障 一条长消息占满全部预算。',
      '// INV-07 截断保留头部而非尾部：守住位置 减去三十后的 slice；改错故障 用户看不到请求的开头。',
      '// INV-08 时间线消息不参与：守住位置 syntheticTimeline 与 uiTimeline 判空；改错故障 合成内容被当成用户原话。',
      '// INV-09 三级内容回退：守住位置 content、parts、mailboxMessage 顺序；改错故障 兼容旧结构时丢正文。',
      '// INV-10 parts 只取 content 类型：守住位置 type 过滤；改错故障 工具片段混入提交上下文。',
      '// INV-11 空白归一后再判空：守住位置 normalizeConversationText；改错故障 纯空白消息被当成有效内容。',
      '// INV-12 归一保留段落：守住位置 三个空行折成两个；改错故障 代码块间距被压平。',
      '// INV-13 sessionId 为空则整体省略：守住位置 trim 与条件展开；改错故障 下游收到空字符串身份。',
      '// INV-14 无有效消息返回 null：守住位置 末尾判空；改错故障 生成器拿到空上下文仍继续请求。',
      '//',
      '// 模块职责：把会话消息裁剪成提交信息生成可用的有限上下文。',
      '// 阅读顺序：先看上限常量与逆序收集，再看单条截断与总长预算，最后看内容来源回退与文本归一。',
    ],
    blocks: [
      {
        anchor: 'const MAX_COMMIT_CONVERSATION_TOTAL_CHARS = 4_000;',
        lines: [
          '总预算是硬上限，单条上限不能突破它。',
        ],
      },
      {
        anchor: 'const normalizedMessages = params.messages',
        lines: [
          '先统一成 role 与 content 二元组，后续只处理纯文本。',
        ],
      },
      {
        anchor: 'let totalChars = 0;',
        lines: [
          '预算随选中条数累加，用于提前终止。',
        ],
      },
      {
        anchor: 'let index = normalizedMessages.length - 1;',
        lines: [
          '从最后一条开始，保证最近对话优先入选。',
        ],
      },
      {
        anchor: 'const content = clipConversationText(',
        lines: [
          '单条先截断，再计入总预算。',
        ],
      },
      {
        anchor: 'const nextCost = content.length + message.role.length + 8;',
        lines: [
          '角色名与包裹开销按八字符估算。',
        ],
      },
      {
        anchor: 'selectedMessages.length > 0 &&',
        lines: [
          '至少保留一条，否则上下文永远为空。',
        ],
      },
      {
        anchor: 'selectedMessages.push({ role: message.role, content });',
        lines: [
          '只有通过预算判定才入列。',
        ],
      },
      {
        anchor: 'selectedMessages.reverse();',
        lines: [
          '逆序收集后必须还原成时间正序。',
        ],
      },
      {
        anchor: 'const sessionId = params.sessionId?.trim();',
        lines: [
          '空白 sessionId 视同未提供。',
        ],
      },
      {
        anchor: 'if (message.syntheticTimeline || message.uiTimeline) {',
        lines: [
          '带时间线的消息是渲染产物，不作为原文。',
        ],
      },
      {
        anchor: '.filter((part) => part.type === "content" && typeof part.content === "string")',
        lines: [
          '只接受字符串正文，排除工具与附件片段。',
        ],
      },
      {
        anchor: '.replace(/\\n{3,}/gu, "\\n\\n")',
        lines: [
          '连续空行折成一个空行，保留段落语义。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/mentions/providers/subagentsMentionProvider.ts',
    target: 30,
    header: [
      '// INV-01 优先级只看 scope 与 source：守住位置 workspace 优先于 user 优先于其它；改错故障 同名 agent 选错来源。',
      '// INV-02 同名去重保留高优先级：守住位置 严格小于比较；改错故障 后到的低优先级覆盖工作区配置。',
      '// INV-03 名称以小写 trim 为键：守住位置 toLowerCase 与 trim；改错故障 大小写差异产生重复候选。',
      '// INV-04 禁用的 agent 不出现：守住位置 enabled 判空；改错故障 用户关掉的子代理仍能被提及。',
      '// INV-05 空名直接跳过：守住位置 空键分支；改错故障 空字符串键把所有无名项合并。',
      '// INV-06 来源标签与优先级同源不同序：守住位置 两个函数的判断顺序；改错故障 标签与排序自相矛盾。',
      '// INV-07 id 带 subagent 前缀：守住位置 模板字符串；改错故障 与其它 mention provider 撞 id。',
      '// INV-08 描述前挂来源标签：守住位置 description 三元；改错故障 用户无法区分同名来源。',
      '// INV-09 关键词覆盖名称与描述与来源与路径：守住位置 keywords 数组；改错故障 搜索命中率下降。',
      '// INV-10 模型标识为两段拼接：守住位置 modelSelection 三元；改错故障 模型名歧义。',
      '// INV-11 空 query 不做三条截断：守住位置 requireQuery 取 false；改错故障 第四个之后的 agent 被藏起来。',
      '// INV-12 候选按 agents 记忆化：守住位置 第一个 useMemo 依赖；改错故障 每次渲染重建候选。',
      '// INV-13 过滤再按 query 记忆化：守住位置 第二个 useMemo；改错故障 输入每个字符都全量重算。',
      '// INV-14 关闭时只清空 items：守住位置 enabled 三元；改错故障 关闭后仍残留 loading 或 error。',
      '//',
      '// 模块职责：把子代理列表投影成 mention 候选分类结果。',
      '// 阅读顺序：先看优先级与去重，再看单项投影，最后看 hook 的两级记忆化与关闭时的返回。',
    ],
    blocks: [
      {
        anchor: 'if (agent.scope === "workspace") {',
        nth: 1,
        lines: [
          '工作区定义的子代理优先级最高。',
        ],
      },
      {
        anchor: 'if (agent.source === "user") {',
        lines: [
          '用户级次之。',
        ],
      },
      {
        anchor: 'return 2;',
        lines: [
          '其余来源（插件、内置）统一排在最后。',
        ],
      },
      {
        anchor: 'if (!agent.enabled) {',
        lines: [
          '禁用的条目在去重前就排除。',
        ],
      },
      {
        anchor: 'const key = agent.name.trim().toLowerCase();',
        lines: [
          '去重键忽略大小写与首尾空白。',
        ],
      },
      {
        anchor: 'if (!current || getSubagentSourcePriority(agent) < getSubagentSourcePriority(current)) {',
        lines: [
          '严格小于才替换，保证先到的高优先级不被覆盖。',
        ],
      },
      {
        anchor: 'const sourceLabel = getSubagentSourceLabel(agent);',
        lines: [
          '标签只算一次，供描述与关键词复用。',
        ],
      },
      {
        anchor: 'const model = agent.modelSelection',
        lines: [
          '模型标识缺失就留空，不写占位符。',
        ],
      },
      {
        anchor: 'id: `subagent:${agent.id}`,',
        lines: [
          '前缀保证与其它 provider 的 id 空间隔离。',
        ],
      },
      {
        anchor: 'description: agent.description ? `${sourceLabel} · ${agent.description}` : sourceLabel,',
        lines: [
          '有描述时把来源放在最前。',
        ],
      },
      {
        anchor: 'const { agents, loading, error } = useSubagents(workspacePath, provider);',
        lines: [
          '数据来源只有这一处，hook 本身不缓存。',
        ],
      },
      {
        anchor: 'requireQuery: false,',
        lines: [
          '空 query 也执行，避免候选被预览条数截断。',
        ],
      },
      {
        anchor: 'items: enabled ? items : [],',
        lines: [
          '关闭只影响候选列表，状态字段照常透传。',
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
    `ZC-deep-b209-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
