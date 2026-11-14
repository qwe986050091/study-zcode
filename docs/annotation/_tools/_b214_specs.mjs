// B214 四个文件的注释 spec 生成器（各新增 30 行）。
import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/v4/composer/modelTriggerDisplay.ts',
    target: 30,
    header: [
      '// INV-01 套餐身份只看 providerId：守住位置 formatModelChangeLabel 的 switch；改错故障 从当前连接反推出错误的历史套餐。',
      '// INV-02 三档套餐映射固定：守住位置 三个 case 组；改错故障 个人/Start/团队文案互相串。',
      '// INV-03 非套餐 provider 回退通用拼接：守住位置 default 分支；改错故障 普通连接没有模型文案。',
      '// INV-04 内置连接名不进模型文案：守住位置 resolveModelProviderFamilyIdByProviderId；改错故障 标题重复出现 Coding Plan。',
      '// INV-05 套餐类型由切换提示补充：守住位置 括号后缀；改错故障 用户看不出套餐差异。',
      '// INV-06 无 provider 名时只留模型名：守住位置 末尾三元；改错故障 出现「/model」这种半截文案。',
      '// INV-07 provider 名先 trim：守住位置 normalizedProviderName；改错故障 空白名被当成有效前缀。',
      '// INV-08 触发器标签先查菜单项：守住位置 find + items.some；改错故障 菜单内已有项仍显示原始值。',
      '// INV-09 查不到就原样回退：守住位置 !selectedGroup 分支；改错故障 失效模型显示空白。',
      '// INV-10 仅当前菜单项按 ID 兜底：守住位置 providerName 的或链；改错故障 历史记录被当下连接改写。',
      '// INV-11 展示模型保留结构化前缀：守住位置 providerPrefix；改错故障 只能整段隐藏，无法按断点裁剪。',
      '// INV-12 前缀显隐交给容器：守住位置 返回结构；改错故障 JS 里再写一套宽度分支。',
      '// INV-13 完整标签与模型标签同源：守住位置 先算 fullLabel；改错故障 两处拼接规则漂移。',
      '// INV-14 内置 family 不加前缀：守住位置 resolveV4ModelTriggerDisplay 的提前返回；改错故障 同一模型出现两种写法。',
      '//',
      '// 模块职责：v4 composer 的模型触发器与切换提示文案，区分套餐身份与 provider 前缀。',
      '// 阅读顺序：先看套餐判定，再看通用拼接，最后看触发器标签与结构化展示。',
    ],
    blocks: [
      {
        anchor: 'export function formatModelChangeLabel(',
        lines: [
          '切换记录必须保留当时的套餐身份。',
        ],
      },
      {
        anchor: 'case BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan:',
        lines: [
          '两家厂商的个人套餐共用同一文案。',
        ],
      },
      {
        anchor: 'case BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan:',
        lines: [
          'Start 套餐单独归类。',
        ],
      },
      {
        anchor: 'case BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan:',
        lines: [
          '团队套餐单独归类。',
        ],
      },
      {
        anchor: 'return formatProviderModelLabel(providerId, providerName, modelName);',
        lines: [
          '非套餐连接回退通用拼接。',
        ],
      },
      {
        anchor: 'if (providerId && resolveModelProviderFamilyIdByProviderId(providerId)) {',
        lines: [
          '内置连接名不再拼进模型文案。',
        ],
      },
      {
        anchor: 'const normalizedProviderName = providerName?.trim();',
        lines: [
          'provider 名先 trim 再参与拼接。',
        ],
      },
      {
        anchor: 'const selectedGroup = modelGroups.find((group) =>',
        nth: 1,
        lines: [
          '先按 value 找到所属分组。',
        ],
      },
      {
        anchor: 'if (!selectedGroup || !selectedItem) {',
        nth: 1,
        lines: [
          '菜单里没有就原样回退。',
        ],
      },
      {
        anchor: 'providerName?.trim() || providerId,',
        lines: [
          '没有展示名时退回 id，保证仍可辨识。',
        ],
      },
      {
        anchor: 'const fullLabel = resolveV4ModelTriggerLabel({',
        lines: [
          '完整标签复用同一套解析。',
        ],
      },
      {
        anchor: 'providerPrefix: `${normalizedProviderName}/`,',
        lines: [
          '前缀单独存放，由容器决定显隐。',
        ],
      },
      {
        anchor: 'const modelLabel = selectedItem.name;',
        lines: [
          '模型名是断点内最小可见单位。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/v4/index.ts',
    target: 30,
    header: [
      '// INV-01 纯新增 barrel：守住位置 文件头说明；改错故障 新旧入口同时被删，出现空窗。',
      '// INV-02 只做 re-export：守住位置 全部 export 语句；改错故障 聚合文件里藏实现，难以定位。',
      '// INV-03 传输层最先导出：守住位置 transport 组；改错故障 其余层引用到未导出的契约。',
      '// INV-04 sessions-index 单独分组：守住位置 组注释；改错故障 读路径与写入路径混在一起。',
      '// INV-05 持久行不属于本组：守住位置 注释中的 tasks-index；改错故障 调用方以为这里能拿到持久数据。',
      '// INV-06 布局导出集中在 paneLayoutStore：守住位置 分屏组；改错故障 分屏动作分散到多个文件。',
      '// INV-07 两套租约不混用：守住位置 两个 registry 组；改错故障 连接租约被当成索引租约释放。',
      '// INV-08 类型与值成组导出：守住位置 每个 export 块；改错故障 调用方需要二次导入类型。',
      '// INV-09 文件头标注里程碑：守住位置 前两行注释；改错故障 后续维护者不知道删除波次。',
      '// INV-10 分组注释不写实现细节：守住位置 组标题；改错故障 注释随实现漂移。',
      '// INV-11 新增导出要归组：守住位置 现有分组边界；改错故障 文件尾部无限堆积。',
      '// INV-12 兼容期双入口并存：守住位置 与旧 store 的说明；改错故障 调用方误以为旧入口已移除。',
      '// INV-13 barrel 无副作用：守住位置 只有 export；改错故障 引入即触发注册或请求。',
      '// INV-14 交互弹窗宿主独立成行：守住位置 V4InteractionDialogs；改错故障 宿主被塞进会话面板。',
      '//',
      '// 模块职责：v4 UI 数据层的统一出口，按传输、投影、索引、布局与交互分组。',
      '// 阅读顺序：先看文件头里程碑，再按组读 export，最后看待处理交互适配。',
    ],
    blocks: [
      {
        anchor: '// 纯新增：与旧 store/zcodeSessionStore* 并存，删除发生在竖切可用后（11-deletion-plan 波次 1）。',
        lines: [
          '新旧入口并存，迁移完成后再删旧实现。',
        ],
      },
      {
        anchor: '} from "@/v4/transport.js";',
        lines: [
          '会话传输契约最先导出，其余层依赖它。',
        ],
      },
      {
        anchor: '} from "@/v4/conversationProjectionStore.js";',
        lines: [
          '投影 store 与乐观命令一起导出。',
        ],
      },
      {
        anchor: '} from "@/v4/sessionDataLayer.js";',
        lines: [
          '会话数据层与租约类型同组。',
        ],
      },
      {
        anchor: '// ── sessions-index 读路径（列表活性/detail 数据源；持久行来自 tasks-index）──',
        lines: [
          '读路径单独分组，持久行不在这里。',
        ],
      },
      {
        anchor: '} from "@/v4/sessionsIndexStore.js";',
        lines: [
          '索引状态与归约函数一起导出。',
        ],
      },
      {
        anchor: '} from "@/v4/sessionsIndexRegistry.js";',
        lines: [
          '租约注册表连同常量一起暴露。',
        ],
      },
      {
        anchor: '// ── 分屏二期：Layout/Focus 两层（二叉分割树）+ workspace 工作台宿主 ──',
        lines: [
          '布局与工作台宿主归为同一分组。',
        ],
      },
      {
        anchor: '} from "@/v4/paneLayoutStore.js";',
        lines: [
          '分屏动作与类型集中自同一 store。',
        ],
      },
      {
        anchor: '} from "@/v4/workspaceConnectionRegistry.js";',
        lines: [
          '连接租约与索引租约是两个独立注册表。',
        ],
      },
      {
        anchor: 'export { V4InteractionDialogs } from "@/v4/V4InteractionDialogs.js";',
        lines: [
          '交互弹窗宿主独立导出。',
        ],
      },
      {
        anchor: '} from "@/v4/pendingInteractionAdapter.js";',
        lines: [
          '待处理交互适配保持最后。',
        ],
      },
      {
        anchor: 'export { SessionPane, type SessionPaneProps } from "@/v4/SessionPane.js";',
        lines: [
          '主会话面板连同 props 类型一起导出。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/v4/useDraftSuggestedPluginActionPopover.ts',
    target: 30,
    header: [
      '// INV-01 成功与失败时长不同：守住位置 两个常量；改错故障 错误提示一闪而过。',
      '// INV-02 计时从 effect 开始：守住位置 第二个 effect；改错故障 异步渲染吞掉可见时长。',
      '// INV-03 只有终态才计时：守住位置 success/error 判断；改错故障 确认态被自动关闭。',
      '// INV-04 新操作先清旧计时：守住位置 show 内第一行；改错故障 旧计时器关掉新弹层。',
      '// INV-05 清理按 operationId 校验：守住位置 clearTimer 的或链；改错故障 清理误伤并发操作。',
      '// INV-06 隐藏同样校验 operationId：守住位置 函数式 setState；改错故障 旧回调隐藏新弹层。',
      '// INV-07 计时器记归属操作：守住位置 OperationTimer；改错故障 无法判断计时器属于谁。',
      '// INV-08 卸载清计时器：守住位置 第一个 effect 的返回；改错故障 卸载后晚到回调写状态。',
      '// INV-09 弹层携带锚点与操作 id：守住位置 状态字段；改错故障 无法定位到具体条目。',
      '// INV-10 action 可选：守住位置 展开三元；改错故障 无动作时也渲染空按钮。',
      '// INV-11 onDismiss 再可选：守住位置 二次展开；改错故障 无关闭回调却显示关闭。',
      '// INV-12 文案走 intl 并注入插件名：守住位置 formatMessage 第二参；改错故障 文案里缺插件名。',
      '// INV-13 弹层变化重置计时：守住位置 effect 依赖；改错故障 阶段切换后仍按旧时刻关闭。',
      '// INV-14 返回稳定引用：守住位置 四个 useCallback；改错故障 调用方每次渲染都拿到新函数。',
      '//',
      '// 模块职责：草稿建议插件的操作弹层状态，含成功/失败自动消失与按操作隔离的清理。',
      '// 阅读顺序：先看时长常量与状态形状，再看清理与展示回调，最后看自动消失 effect。',
    ],
    blocks: [
      {
        anchor: 'const PLUGIN_ACTION_SUCCESS_DURATION_MS = 2_000;',
        lines: [
          '成功提示较短，失败提示留更久。',
        ],
      },
      {
        anchor: 'const PLUGIN_ACTION_ERROR_DURATION_MS = 3_000;',
        lines: [
          '错误需要更长的阅读时间。',
        ],
      },
      {
        anchor: 'const resultTimerRef = useRef<OperationTimer | null>(null);',
        lines: [
          '计时器连同归属操作一起保存。',
        ],
      },
      {
        anchor: 'if (!current || (operationId && current.operationId !== operationId)) return;',
        lines: [
          '只清匹配的操作，避免清掉新计时器。',
        ],
      },
      {
        anchor: 'setPluginActionPopover((current) => {',
        lines: [
          '隐藏同样按 operationId 校验。',
        ],
      },
      {
        anchor: 'return () => {',
        lines: [
          '卸载时清计时器，防止晚到回调写状态。',
        ],
      },
      {
        anchor: 'clearTimer(resultTimerRef);',
        nth: 2,
        lines: [
          '每次展示新操作前先作废旧计时。',
        ],
      },
      {
        anchor: 'message: intl.formatMessage({ id: messageId }, { pluginLabel: flow.plugin.label }),',
        lines: [
          '消息文案注入插件名，位置由翻译模板决定。',
        ],
      },
      {
        anchor: 'actionLabel: action.label,',
        lines: [
          '动作可选，仅有传参时才出现按钮。',
        ],
      },
      {
        anchor: '...(action.onDismiss ? { onDismiss: action.onDismiss } : {}),',
        lines: [
          '关闭回调同样是可选的。',
        ],
      },
      {
        anchor: 'if (!current || (current.phase !== "success" && current.phase !== "error")) return;',
        lines: [
          '只有终态才启动自动消失。',
        ],
      },
      {
        anchor: 'const durationMs =',
        lines: [
          '时长按成功与失败分流。',
        ],
      },
      {
        anchor: '}, [clearPluginActionPopover, clearTimer, pluginActionPopover]);',
        lines: [
          '弹层变化会重置计时，阶段切换从头计时。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/v4/workspaceSessionsIndexSubscriptionSet.ts',
    target: 30,
    header: [
      '// INV-01 输入是期望集合：守住位置 reconcile 的 desired；改错故障 每次渲染全量重建订阅。',
      '// INV-02 key 由 endpoint 与 workspaceKey 组成：守住位置 buildSessionsIndexEntryKey；改错故障 跨端点的同名项目互相覆盖。',
      '// INV-03 等价判断逐字段比较：守住位置 isSameBinding；改错故障 引用变化导致无意义重订阅。',
      '// INV-04 远程换代先 acquire 再 release：守住位置 注释与执行顺序；改错故障 registry 关闭旧 store，投影中断。',
      '// INV-05 同 store 复用旧订阅：守住位置 sameStore 分支；改错故障 consumer listener 被重复注册。',
      '// INV-06 不同 store 先 dispose 旧条目：守住位置 else 分支；改错故障 旧订阅泄漏。',
      '// INV-07 删除项统一 dispose：守住位置 第二段释放；改错故障 只从 map 删除不还租约。',
      '// INV-08 新增项 acquire 并订阅：守住位置 第二段循环；改错故障 新项目永远没有快照。',
      '// INV-09 有变化只通知一次：守住位置 末尾 onStoreChange；改错故障 每个条目各触发一次渲染。',
      '// INV-10 无变化只记 debug：守住位置 else 分支；改错故障 空转也触发渲染。',
      '// INV-11 dispose 清空全部条目：守住位置 公开 dispose；改错故障 hooks 卸载后仍持有租约。',
      '// INV-12 日志键缺省用 __base__：守住位置 scopeLogKey；改错故障 本地与远程日志无法区分。',
      '// INV-13 类内不持有 React 状态：守住位置 只有 active map；改错故障 订阅逻辑与渲染耦合。',
      '// INV-14 释放必须配对：守住位置 disposeEntry；改错故障 退订与还租约只做一半。',
      '//',
      '// 模块职责：按 endpoint 与 workspaceKey 维护 sessions-index 订阅集合，只对差异做副作用。',
      '// 阅读顺序：先看 key 与等价判断，再看 reconcile 两段循环，最后看查询、销毁与日志。',
    ],
    blocks: [
      {
        anchor: 'function scopeLogKey(scope: SessionsIndexScope): string {',
        lines: [
          '日志键只用于诊断，不参与 map 定位。',
        ],
      },
      {
        anchor: 'function isSameBinding(',
        lines: [
          '等价判断逐字段比较，不看对象引用。',
        ],
      },
      {
        anchor: 'private readonly active = new Map<string, ActiveWorkspaceSessionsIndexEntry>();',
        lines: [
          '活动条目按 entry key 索引。',
        ],
      },
      {
        anchor: 'reconcile(bindings: readonly WorkspaceSessionsIndexBinding[]): boolean {',
        lines: [
          '输入被解释成期望集合，而非全量重建指令。',
        ],
      },
      {
        anchor: 'desired.set(buildSessionsIndexEntryKey(binding.scope), binding);',
        lines: [
          '同一 key 后写覆盖前写，顺序稳定。',
        ],
      },
      {
        anchor: 'if (next && isSameBinding(current, next)) {',
        lines: [
          '完全相同的绑定直接跳过。',
        ],
      },
      {
        anchor: 'const store = acquireSessionsIndex(next.scope, next.agentService);',
        lines: [
          '换代时先 acquire，避免 registry 关掉旧 store。',
        ],
      },
      {
        anchor: 'const sameStore = store === current.store;',
        lines: [
          '同一个 store 就复用旧订阅，不断开投影。',
        ],
      },
      {
        anchor: 'if (sameStore) {',
        lines: [
          '同 store 只需释放旧租约。',
        ],
      },
      {
        anchor: 'releasedScopeKeys.push(scopeLogKey(current.scope));',
        nth: 2,
        lines: [
          '其余情况整条释放并移除。',
        ],
      },
      {
        anchor: 'const store = acquireSessionsIndex(binding.scope, binding.agentService);',
        lines: [
          '新增项单独 acquire 并订阅。',
        ],
      },
      {
        anchor: 'this.onStoreChange();',
        lines: [
          '有变化时统一通知一次。',
        ],
      },
      {
        anchor: 'entry.unsubscribeStore();',
        lines: [
          '释放顺序：先退订，再还租约。',
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
    `ZC-deep-b214-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
