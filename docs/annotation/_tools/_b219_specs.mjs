// B219 四个文件的注释 spec 生成器（各新增 30 行）。
import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/root/botsTaskBroadcast.ts',
    target: 30,
    header: [
      '// INV-01 只处理专用频道：守住位置 频道早退；改错故障 其他广播被当作任务事件。',
      '// INV-02 载荷先过类型守卫：守住位置 isBotTaskBroadcastPayload；改错故障 脏数据进入 store 打崩侧栏。',
      '// INV-03 事件名白名单：守住位置 validEvents；改错故障 新增事件未登记时静默丢消息。',
      '// INV-04 必填三字段类型严格：守住位置 workspacePath / taskId / updatedAt；改错故障 缺字段的消息触发无主刷新。',
      '// INV-05 可选字段逐个校验：守住位置 各 undefined 分支；改错故障 半截载荷混入并覆盖完整状态。',
      '// INV-06 只在已打开工作区刷新：守住位置 hasOpenWorkspace；改错故障 未打开的项目也发请求。',
      '// INV-07 工作区键统一构造：守住位置 buildTaskWorkspaceKey；改错故障 远程与本地路径被当成两个工作区。',
      '// INV-08 非工作区页签不参与匹配：守住位置 isWorkspaceTab；改错故障 设置页签被计入打开判定。',
      '// INV-09 未命中返回 null：守住位置 末尾三元；改错故障 调用方要多判断一次 undefined。',
      '// INV-10 created 映射 creating：守住位置 首个 case；改错故障 新建任务先显示运行中。',
      '// INV-11 error 映射 failed：守住位置 独立 case；改错故障 失败任务仍显示流式中。',
      '// INV-12 权限与 elicitation 都算 streaming：守住位置 四个合并 case；改错故障 等待确认时状态跳回就绪。',
      '// INV-13 updated 映射 ready：守住位置 最后一个 case；改错故障 改配置后对话一直转圈。',
      '// INV-14 事件枚举穷尽：守住位置 switch 无 default；改错故障 新增事件返回 undefined 破坏状态机。',
      '//',
      '// 模块职责：Bot 任务广播的载荷校验、打开工作区过滤与运行状态映射。',
      '// 阅读顺序：先看载荷守卫字段，再看刷新判定，最后看事件到状态的映射表。',
    ],
    blocks: [
      {
        anchor: 'function isBotTaskBroadcastPayload(',
        lines: [
          '守卫只做结构校验，不修改载荷。',
        ],
      },
      {
        anchor: 'if (typeof payload !== "object" || payload === null) {',
        lines: [
          '非对象直接判为非法，避免属性访问抛错。',
        ],
      },
      {
        anchor: 'const validEvents = new Set<BotTaskBroadcastPayload["event"]>([',
        lines: [
          '事件白名单与协议枚举保持同步。',
        ],
      },
      {
        anchor: 'export function resolveBotTaskBroadcastRefresh(',
        lines: [
          '只有命中已打开工作区才返回载荷。',
        ],
      },
      {
        anchor: 'if (message.channel !== BOT_TASK_BROADCAST_CHANNEL) {',
        lines: [
          '频道不符立即退出。',
        ],
      },
      {
        anchor: 'if (!isBotTaskBroadcastPayload(message.payload)) {',
        lines: [
          '结构不符同样视为无关消息。',
        ],
      },
      {
        anchor: 'const targetWorkspaceKey = buildTaskWorkspaceKey(',
        lines: [
          '目标键与页签键用同一函数构造。',
        ],
      },
      {
        anchor: 'const hasOpenWorkspace = tabs.some(',
        lines: [
          '逐个页签比对工作区身份。',
        ],
      },
      {
        anchor: 'export function resolveBotTaskBroadcastRuntimeStatus(',
        lines: [
          '状态映射是纯函数，不读写外部状态。',
        ],
      },
      {
        anchor: 'case "completed":',
        lines: [
          '完成事件直接落到终态。',
        ],
      },
      {
        anchor: 'case "prompt_sent":',
        lines: [
          '这些事件都表示仍在运行。',
        ],
      },
      {
        anchor: 'case "updated":',
        lines: [
          '更新事件只同步元数据，不是新一轮流式。',
        ],
      },
      {
        anchor: 'return "ready";',
        lines: [
          '回到就绪，清掉对话的加载指示。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/settings/CodingPlanUpgradeDialogProvider.tsx',
    target: 30,
    firstNth: 1,
    header: [
      '// INV-01 唯一弹窗实例：守住位置 Provider 渲染的单个 Dialog；改错故障 多处入口各弹一层。',
      '// INV-02 库存来自 hook：守住位置 useCodingPlanEntryPlanList；改错故障 弹窗自行请求套餐列表。',
      '// INV-03 ref 镜像最新库存：守住位置 inventoryRef 赋值；改错故障 回调闭包拿到过期套餐。',
      '// INV-04 入口守卫未就绪：守住位置 status !== "ready"；改错故障 列表未加载完就打开空弹窗。',
      '// INV-05 已中止不再打开：守住位置 signal.aborted；改错故障 卸载后仍设置 target 造成泄漏。',
      '// INV-06 错误态允许重试：守住位置 retry 分支；改错故障 首次失败后所有入口永久失效。',
      '// INV-07 观察者单槽位：守住位置 opening ref；改错故障 并发点击时旧观察者收到新结果。',
      '// INV-08 结果只回传一次：守住位置 finish 的身份比较；改错故障 关闭时重复回调。',
      '// INV-09 abort 监听要移除：守住位置 removeEventListener；改错故障 信号释放后仍触发关闭。',
      '// INV-10 卸载当作未打开：守住位置 空依赖 useEffect；改错故障 观察者永远等不到结果。',
      '// INV-11 点击时冻结套餐列表：守住位置 funnelContext 展开；改错故障 埋点里列表与展示不一致。',
      '// INV-12 openVersion 隔离 webview：守住位置 key 自增；改错故障 旧 dom-ready 确认新的观察请求。',
      '// INV-13 上下文必须存在：守住位置 useCodingPlanUpgradeDialog 抛错；改错故障 购买入口静默失效。',
      '// INV-14 可选上下文不抛错：守住位置 useOptionalCodingPlanUpgradeDialog；改错故障 独立挂载的会话面板崩溃。',
      '//',
      '// 模块职责：套餐升级弹窗的全局入口，负责就绪守卫、观察者回调与埋点。',
      '// 阅读顺序：先看 context 形状，再看 openCodingPlanUpgrade 的守卫顺序，最后看 Provider 渲染。',
    ],
    blocks: [
      {
        anchor: 'export function CodingPlanUpgradeDialogProvider({ children }: { children: ReactNode }) {',
        lines: [
          'Provider 只持有一个弹窗与一个待观察回调。',
        ],
      },
      {
        anchor: 'const inventoryRef = useRef(inventory);',
        lines: [
          '用 ref 镜像，避免回调依赖库存对象。',
        ],
      },
      {
        anchor: 'const [openVersion, setOpenVersion] = useState(0);',
        lines: [
          '版本号用于重建 webview。',
        ],
      },
      {
        anchor: 'const opening = useRef<((opened: boolean) => void) | null>(null);',
        lines: [
          '单槽位保存当前观察者。',
        ],
      },
      {
        anchor: 'useEffect(() => () => opening.current?.(false), []);',
        lines: [
          '卸载时补一次未打开，防止调用方悬挂。',
        ],
      },
      {
        anchor: 'const openCodingPlanUpgrade = useCallback(',
        lines: [
          '所有入口共用这一条打开路径。',
        ],
      },
      {
        anchor: 'if (status !== "ready") {',
        lines: [
          '未就绪直接拒绝，不排队重放。',
        ],
      },
      {
        anchor: 'if (observation) {',
        lines: [
          '有观察者时才登记回调与中止监听。',
        ],
      },
      {
        anchor: 'const abort = () => finish(false);',
        lines: [
          '中止等价于未打开。',
        ],
      },
      {
        anchor: 'nextTarget = nextTarget.funnelContext',
        lines: [
          '点击瞬间把整份套餐列表冻进埋点上下文。',
        ],
      },
      {
        anchor: 'setOpenVersion((version) => version + 1);',
        lines: [
          '每次显式打开都换 key，断开旧 webview 事件。',
        ],
      },
      {
        anchor: 'onOpenResult={opening.current ?? undefined}',
        lines: [
          '结果回调只指向当前观察者。',
        ],
      },
      {
        anchor: 'if (!context) {',
        lines: [
          '必选上下文缺失属于接线错误，直接抛错。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/settings/model-provider-section/ProviderModelDraftState.ts',
    target: 30,
    header: [
      '// INV-01 草稿不是事实：守住位置 全部函数；改错故障 前端另存一份可写 Effective Config。',
      '// INV-02 推荐模式直接返回原草稿：守住位置 首个早退；改错故障 每次渲染都重建对象引发抖动。',
      '// INV-03 默认值只由模型推导：守住位置 createProviderModelDraftValues；改错故障 默认值与 Host 规则分叉。',
      '// INV-04 继承配置优先于本地配置：守住位置 inheritedConfig ?? config；改错故障 展示的默认值落后于 Host。',
      '// INV-05 显式覆写集合是唯一豁免：守住位置 overriddenFieldsValue；改错故障 用户改动被默认值覆盖。',
      '// INV-06 输入格式逐字段豁免：守住位置 inputFormatValue.字段名；改错故障 只改了一个子项却整组回填。',
      '// INV-07 投影不修改入参：守住位置 展开复制；改错故障 父组件状态被隐式改写。',
      '// INV-08 恢复是显式动作：守住位置 restoreModelDraft；改错故障 切换开关时静默丢掉编辑。',
      '// INV-09 恢复清除手工配置：守住位置 clearManualModelConfig；改错故障 旧覆盖在下次保存时复活。',
      '// INV-10 恢复保留标识与启用态：守住位置 idValue / enabledValue；改错故障 恢复后模型身份变化。',
      '// INV-11 关闭推荐只补空字段：守住位置 三处 || 兜底；改错故障 用户输入被默认值吞掉。',
      '// INV-12 覆写集合按补丁累加：守住位置 两个 explicit.add；改错故障 改过的字段仍被当作继承。',
      '// INV-13 覆写集合只读返回：守住位置 ReadonlySet；改错故障 调用方就地修改影响后续判断。',
      '// INV-14 关闭推荐时覆写集合为空：守住位置 modelDraftOverrides 早退；改错故障 保存时提交无意义覆盖。',
      '//',
      '// 模块职责：Provider 模型编辑草稿的投影、补丁与恢复，负责推荐配置与用户覆写的边界。',
      '// 阅读顺序：先看字段清单与 projectModelDraft，再看 updateModelDraft，最后看 restore 与 overrides。',
    ],
    blocks: [
      {
        anchor: 'const CONFIG_VALUE_FIELDS = [',
        lines: [
          '可被推荐配置接管的标量字段清单。',
        ],
      },
      {
        anchor: 'export function projectModelDraft(',
        lines: [
          '投影只回填未被显式覆写的字段。',
        ],
      },
      {
        anchor: 'if (draft.useRecommendedConfigValue === false) return draft;',
        lines: [
          '关闭推荐时不投影，原样返回。',
        ],
      },
      {
        anchor: 'const defaults = createProviderModelDraftValues({',
        lines: [
          '默认值用继承配置推导，与 Host 同源。',
        ],
      },
      {
        anchor: 'const explicit = new Set(draft.overriddenFieldsValue ?? []);',
        nth: 1,
        lines: [
          '用户显式改过的字段不参与回填。',
        ],
      },
      {
        anchor: 'export function updateModelDraft(',
        lines: [
          '补丁入口负责切换推荐与记录覆写。',
        ],
      },
      {
        anchor: 'if (patch.useRecommendedConfigValue) {',
        lines: [
          '重新开启推荐等价于恢复。',
        ],
      },
      {
        anchor: 'const projected = projectModelDraft(draft, model);',
        lines: [
          '关闭推荐时先保留当前投影结果。',
        ],
      },
      {
        anchor: 'if (patch.inputFormatValue) {',
        lines: [
          '输入格式按子字段逐个比较。',
        ],
      },
      {
        anchor: 'export function restoreModelDraft(',
        lines: [
          '恢复会重建整份草稿。',
        ],
      },
      {
        anchor: 'export function modelDraftOverrides(draft: ProviderModelDraftValues): ReadonlySet<string> {',
        lines: [
          '保存前把实际覆写汇总成只读集合。',
        ],
      },
      {
        anchor: 'const explicit = new Set(draft.overriddenFieldsValue ?? []);',
        nth: 2,
        lines: [
          '在已有覆写基础上更新集合。',
        ],
      },
      {
        anchor: 'if (draft[field].trim()) result.add(field);',
        lines: [
          '三个文本字段非空即视为覆写。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/settings/model-provider-section/SectionLayout.tsx',
    target: 30,
    header: [
      '// INV-01 布局只做排版：守住位置 组件体；改错故障 设置页自行取服务或管状态。',
      '// INV-02 加载态由两路合并：守住位置 shouldShowModelProviderRefreshLoading；改错故障 只等预设或只等自定义。',
      '// INV-03 刷新按钮文案跟加载切换：守住位置 refreshLabel 三元；改错故障 转圈时仍显示「刷新」。',
      '// INV-04 新增入口唯一：守住位置 SettingsResourceHeaderActions；改错故障 头部出现两个添加入口。',
      '// INV-05 分栏比例固定：守住位置 grid-cols 两档；改错故障 窄屏导航挤占详情宽度。',
      '// INV-06 导航列独立滚动：守住位置 data-model-provider-navigation-scroll；改错故障 长供应商列表拖走整页。',
      '// INV-07 详情列独立滚动：守住位置 data-model-provider-detail-scroll；改错故障 切换供应商后焦点位置丢失。',
      '// INV-08 详情底部留白：守住位置 pb-20 / sm:pb-24；改错故障 最后一个字段被浮层遮挡。',
      '// INV-09 反馈边界按节点重建：守住位置 key=selectedNodeKey；改错故障 切换供应商后错误横幅残留。',
      '// INV-10 未选中用稳定占位键：守住位置 ?? "unselected-provider"；改错故障 空值导致边界反复重建。',
      '// INV-11 点击回调原样下传：守住位置 onSelectNavItem；改错故障 布局层改写选中语义。',
      '// INV-12 拖拽能力可选透传：守住位置 onReorderProviderIds；改错故障 不支持拖拽的调用方也拿到入口。',
      '// INV-13 test id 集中引用：守住位置 TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON；改错故障 E2E 选择器漂移。',
      '// INV-14 内容由调用方决定：守住位置 children；改错故障 布局层耦合具体供应商详情。',
      '//',
      '// 模块职责：模型供应商设置页的整体骨架，包含头部动作、左侧导航与右侧详情分栏。',
      '// 阅读顺序：先看加载态合并，再看头部动作，最后看分栏与反馈边界。',
    ],
    blocks: [
      {
        anchor: 'export function shouldShowModelProviderRefreshLoading(params: {',
        lines: [
          '任一来源在加载就显示刷新态。',
        ],
      },
      {
        anchor: 'return params.presetLoading || params.customLoading;',
        lines: [
          '两路加载是或的关系。',
        ],
      },
      {
        anchor: 'export function ModelProviderSectionLayout({',
        lines: [
          '布局组件全部输入来自 props。',
        ],
      },
      {
        anchor: 'const refreshButtonLoading = shouldShowModelProviderRefreshLoading({',
        lines: [
          '合并结果只算一次。',
        ],
      },
      {
        anchor: '<div className="flex items-start justify-between gap-3">',
        lines: [
          '描述与操作同一行两端对齐。',
        ],
      },
      {
        anchor: '<SettingsResourceHeaderActions',
        lines: [
          '刷新与新增共用统一头部动作组件。',
        ],
      },
      {
        anchor: 'refreshLabel={refreshButtonLoading ? loadingLabel : refreshLabel}',
        lines: [
          '加载中文案可替换。',
        ],
      },
      {
        anchor: 'data-model-provider-split-panel="true"',
        lines: [
          '分栏标记供 E2E 定位。',
        ],
      },
      {
        anchor: 'data-model-provider-navigation-scroll="true"',
        lines: [
          '导航列自己滚动。',
        ],
      },
      {
        anchor: '<ModelProviderSectionNavigation',
        lines: [
          '导航只接展示所需数据与回调。',
        ],
      },
      {
        anchor: 'data-model-provider-detail-scroll="true"',
        lines: [
          '详情列自己滚动。',
        ],
      },
      {
        anchor: '<ProviderDetailFeedbackBoundary key={selectedNodeKey ?? "unselected-provider"}>',
        lines: [
          '切换供应商时重置反馈边界。',
        ],
      },
      {
        anchor: '<div className="space-y-4">',
        lines: [
          '外层只负责纵向间距。',
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
    `ZC-deep-b219-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
