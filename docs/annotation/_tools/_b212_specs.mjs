// B212 四个文件的注释 spec 生成器（各新增 30 行）。
import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/resource-manager/storage/StorageCategoryList.tsx',
    target: 30,
    firstNth: 1,
    header: [
      '// INV-01 分类总数由父级算好：守住位置 props.categories；改错故障 组件内重复求和，两处数字不一致。',
      '// INV-02 可清理需双条件：守住位置 cleanability 与 bytes 的与运算；改错故障 零字节分类仍出现清理按钮。',
      '// INV-03 清理中按 id 匹配：守住位置 cleaningCategory 等值判断；改错故障 点一行让所有行都转圈。',
      '// INV-04 打开入口有两个：守住位置 整行按钮与箭头按钮；改错故障 只有点箭头才进详情。',
      '// INV-05 标题与描述 id 统一生成：守住位置 storageCategoryTitleId；改错故障 新增分类没有翻译键。',
      '// INV-06 图标表集中一处：守住位置 STORAGE_CATEGORY_ICONS；改错故障 同类图标在不同页面不一致。',
      '// INV-07 字节只经 formatBytes：守住位置 尺寸文本；改错故障 各分类单位换算规则不同。',
      '// INV-08 测试 id 以分类 id 为后缀：守住位置 testId 调用；改错故障 自动化无法定位具体分类行。',
      '// INV-09 禁用只作用于清理：守住位置 Button 的 disabled；改错故障 清理进行中连详情都打不开。',
      '// INV-10 清理文案随状态切换：守住位置 cleaning 三元；改错故障 转圈同时仍写「清理」。',
      '// INV-11 首行不吃上边框：守住位置 first:border-t-0；改错故障 列表顶端多出一条分隔线。',
      '// INV-12 装饰图标对读屏隐藏：守住位置 两处 aria-hidden；改错故障 读屏重复念出图标名。',
      '// INV-13 箭头按钮补 aria-label：守住位置 标题文案复用；改错故障 无可见文字的按钮没有名称。',
      '// INV-14 组件完全受控：守住位置 无本地 state；改错故障 父级刷新后行内状态残留。',
      '//',
      '// 模块职责：渲染存储分类列表，负责打开详情与触发清理两个动作。',
      '// 阅读顺序：先看可清理判定，再看行内两处入口，最后看清理按钮的加载与禁用。',
    ],
    blocks: [
      {
        anchor: 'export function StorageCategoryList({',
        lines: [
          '分类数据与回调全部来自父级，这里不持有状态。',
        ],
      },
      {
        anchor: 'key={category.id}',
        lines: [
          '用分类 id 作 key，顺序变化不会复用错行。',
        ],
      },
      {
        anchor: 'const Icon = STORAGE_CATEGORY_ICONS[category.id];',
        lines: [
          '图标按分类 id 查表，只作视觉标识。',
        ],
      },
      {
        anchor: 'const cleanable = category.cleanability !== "none" && category.bytes > 0;',
        lines: [
          '可清理要同时满足：允许清理且确实占用空间。',
        ],
      },
      {
        anchor: 'const cleaning = cleaningCategory === category.id;',
        lines: [
          '只有正在清理的那一行显示进度。',
        ],
      },
      {
        anchor: 'data-testid={testId(TID_RESOURCE_MANAGER_STORAGE_CATEGORY_ROW, category.id)}',
        lines: [
          '整行主体就是打开详情入口，测试 id 带分类后缀。',
        ],
      },
      {
        anchor: 'className="block text-ui-caption tabular-nums text-foreground-subtle"',
        lines: [
          '尺寸用等宽数字，刷新时宽度不跳动。',
        ],
      },
      {
        anchor: '{cleanable ? (',
        lines: [
          '不可清理的分类不渲染按钮，避免无效操作。',
          '禁用只影响清理，不影响行导航。',
        ],
      },
      {
        anchor: '{cleaning ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}',
        lines: [
          '转圈图标同样对读屏隐藏。',
        ],
      },
      {
        anchor: 'id: cleaning',
        lines: [
          '按钮文案随清理状态切换。',
        ],
      },
      {
        anchor: 'aria-label={intl.formatMessage({ id: storageCategoryTitleId(category.id) })}',
        lines: [
          '箭头按钮没有可见文字，用标题补上名称。',
        ],
      },
      {
        anchor: '<ChevronRight className="size-4" aria-hidden="true" />',
        lines: [
          '箭头是第二个打开入口，回调与整行一致。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/resource-manager/storage/useStorageUsage.ts',
    target: 30,
    header: [
      '// INV-01 生命周期绑 enabled：守住位置 第一个 effect 的提前返回；改错故障 切走 tab 后仍在扫描。',
      '// INV-02 只认当前 jobId：守住位置 进度回调的 id 比较；改错故障 旧作业尾包覆盖新结果。',
      '// INV-03 进入先展示旧快照：守住位置 getSnapshot 回填；改错故障 首屏空白直到扫描结束。',
      '// INV-04 终态即清 jobId：守住位置 status 不等于 scanning；改错故障 已完成作业仍被当成在跑。',
      '// INV-05 取消先置空再调远端：守住位置 cancel 的前三行；改错故障 取消失败后 jobId 残留。',
      '// INV-06 清理前先作废旧作业：守住位置 clean 内的 jobIdRef 赋值；改错故障 清理期间旧进度继续写入。',
      '// INV-07 清理后自动重扫：守住位置 clean 末尾的 start；改错故障 清理完数字还是旧的。',
      '// INV-08 失焦六十秒才取消：守住位置 STORAGE_SCAN_BLUR_CANCEL_MS；改错故障 短暂切窗打断扫描。',
      '// INV-09 聚焦仅在取消过时重启：守住位置 cancelledByBlur；改错故障 每次聚焦重复开扫。',
      '// INV-10 桥缺失时静默降级：守住位置 start 的首行返回；改错故障 未注入桥的环境直接抛错。',
      '// INV-11 扫描错误只记日志：守住位置 catch 分支；改错故障 失败冒泡打断资源管理器整页。',
      '// INV-12 回填不覆盖新扫描：守住位置 !jobIdRef.current；改错故障 旧快照盖掉正在扫描的结果。',
      '// INV-13 卸载清理三件事：守住位置 effect 的返回函数；改错故障 监听器与定时器泄漏。',
      '// INV-14 rescan 即 start：守住位置 返回值映射；改错故障 外部刷新走另一条未同步的路径。',
      '//',
      '// 模块职责：资源管理器存储 tab 的扫描、进度订阅、失焦取消与清理数据源。',
      '// 阅读顺序：先看 jobId 与两个回调，再看生命周期 effect，最后看失焦取消与 clean。',
    ],
    blocks: [
      {
        anchor: 'const jobIdRef = useRef<string | null>(null);',
        lines: [
          '当前作业 id 是唯一有效的快照来源。',
        ],
      },
      {
        anchor: 'const start = useCallback(async () => {',
        lines: [
          '开扫成功后才记 jobId 并进入扫描态。',
          '失败只复位 scanning，不向调用方抛出。',
        ],
      },
      {
        anchor: 'if (!jobId || !bridge) return;',
        lines: [
          '先清本地态再调远端，保证重复取消幂等。',
        ],
      },
      {
        anchor: 'if (disposed || next.jobId !== jobIdRef.current) return;',
        lines: [
          '卸载后与旧作业的尾包都在这里丢弃。',
        ],
      },
      {
        anchor: 'if (next.status !== "scanning") {',
        lines: [
          '终态后清掉 jobId，后续进度不再被接受。',
        ],
      },
      {
        anchor: 'if (!disposed && previous && !jobIdRef.current) setSnapshot(previous);',
        lines: [
          '回填只在新扫描尚未开始时发生。',
        ],
      },
      {
        anchor: 'void start();',
        nth: 1,
        lines: [
          '挂载或启用变化时立即开扫。',
        ],
      },
      {
        anchor: 'disposed = true;',
        lines: [
          '卸载标记要早于退订，防止尾包写状态。',
        ],
      },
      {
        anchor: 'blurTimer = setTimeout(() => {',
        lines: [
          '失焦只启动延迟取消，回焦会清掉定时器。',
        ],
      },
      {
        anchor: 'void start();',
        nth: 2,
        lines: [
          '只有失焦确实取消过，聚焦才重新开扫。',
        ],
      },
      {
        anchor: 'const result = await bridge.clean(request);',
        lines: [
          '清理完成后主动重扫，避免展示过期数字。',
        ],
      },
      {
        anchor: 'if (!bridge) throw new Error("storage bridge unavailable");',
        lines: [
          '清理缺桥时明确抛错，与扫描的静默降级不同。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/settings/automationAgentConfigOptions.ts',
    target: 30,
    firstNth: 1,
    header: [
      '// INV-01 表单是纯本地草稿：守住位置 模块顶部说明与各构造函数；改错故障 打开编辑就改掉项目运行配置。',
      '// INV-02 默认模式固定 build：守住位置 AUTOMATION_DEFAULT_MODE；改错故障 新建任务继承上次会话模式。',
      '// INV-03 新建固化具体模型：守住位置 resolveAutomationPreferredModelValue；改错故障 保存虚拟「默认模型」。',
      '// INV-04 模型项先精确后回退：守住位置 findDirectModelItem 的短路；改错故障 完整 value 已命中仍走模糊匹配。',
      '// INV-05 纯模型名仅唯一时回填：守住位置 modelMatches 长度判断；改错故障 同名跨 provider 被猜错来源。',
      '// INV-06 包装值 provider 不符不猜：守住位置 providerMatches 长度判断；改错故障 默认模型丢失 think 元数据。',
      '// INV-07 展示标签复用会话侧规则：守住位置 resolveV4ModelTriggerLabel；改错故障 两侧身份文案不一致。',
      '// INV-08 解析失败只影响展示：守住位置 !selectedItem 分支；改错故障 回退时改写了保存值。',
      '// INV-09 失效档位置空：守住位置 validCurrentValue 三元；改错故障 刷新候选后自动保存默认档。',
      '// INV-10 更新不支持 Think 用 null：守住位置 末尾三元；改错故障 undefined 被当成不修改，旧档位残留。',
      '// INV-11 编辑中未换模型沿用持久化档位：守住位置 editing 与 modelChanged 双条件；改错故障 打开就重置用户档位。',
      '// INV-12 输出预算不属于模型选择：守住位置 buildAutomationModelSelection；改错故障 预算被写进持久化模型。',
      '// INV-13 空白 reasoningLevel 视为未设置：守住位置 trim 后判空；改错故障 空串写进 options。',
      '// INV-14 全部构造函数纯函数：守住位置 无外部读写；改错故障 单元测试需要 mock 全局状态。',
      '//',
      '// 模块职责：定时任务表单的模型、模式与 Think 档位选项构造，以及模型值解析。',
      '// 阅读顺序：先看默认值与首选模型，再看模型项解析，最后看档位更新与选择持久化。',
    ],
    blocks: [
      {
        anchor: 'export const AUTOMATION_DEFAULT_MODE = "build";',
        lines: [
          '默认模式只作为新建表单的初值。',
        ],
      },
      {
        anchor: 'export function resolveAutomationPreferredModelValue(',
        lines: [
          '首选模型必须落成 provider 与 model 的具体值。',
        ],
      },
      {
        anchor: 'export function buildAutomationModelSelectGroups(params: {',
        lines: [
          '分组直接复用注册表构建器，不另起一套规则。',
        ],
      },
      {
        anchor: 'function findDirectModelItem(',
        lines: [
          '先按完整 value 精确命中。',
        ],
      },
      {
        anchor: 'const separator = modelValue.indexOf("/");',
        lines: [
          '没有分隔符时整串都按模型名处理。',
        ],
      },
      {
        anchor: 'const modelMatches = modelGroups.flatMap((group) =>',
        lines: [
          '回退时按模型名跨 provider 收集候选。',
        ],
      },
      {
        anchor: 'if (qualifiedProviderId) {',
        lines: [
          '带 provider 前缀时，必须在同一 provider 内唯一。',
        ],
      },
      {
        anchor: 'return modelMatches.length === 1 ? (modelMatches[0] ?? null) : null;',
        lines: [
          '全局唯一才回填，否则放弃解析。',
        ],
      },
      {
        anchor: 'if (!selectedItem) {',
        lines: [
          '解析失败只影响展示文案，不改动保存值。',
        ],
      },
      {
        anchor: 'return resolveV4ModelTriggerLabel({',
        lines: [
          '展示规则与会话侧共用同一实现。',
        ],
      },
      {
        anchor: 'const resolvedValue = validCurrentValue ? currentValue : "";',
        lines: [
          '失效档位置空，交由界面显示未选择。',
        ],
      },
      {
        anchor: 'return params.editing ? null : undefined;',
        lines: [
          '编辑时用 null 显式清值，新建时保持 undefined。',
        ],
      },
      {
        anchor: 'const options = reasoningLevel ? { reasoningLevel } : {};',
        lines: [
          '空白档位不写入 options。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/settings/model-provider-section/useStartPlanPreview.ts',
    target: 30,
    header: [
      '// INV-01 缓存有效期一天：守住位置 TTL 常量；改错故障 每次进入升级页都打远端。',
      '// INV-02 并发请求合并：守住位置 previewRequest；改错故障 多个面板同时挂载打出多份请求。',
      '// INV-03 命中未过期缓存直接返回：守住位置 expiresAt 比较；改错故障 缓存写了却从不生效。',
      '// INV-04 请求结束必清在飞引用：守住位置 finally；改错故障 失败后永久卡在同一个被拒 Promise。',
      '// INV-05 禁用时不请求：守住位置 enabled 分支；改错故障 隐藏面板仍消耗配额。',
      '// INV-06 服务缺失报 service_unavailable：守住位置 方法存在性判断；改错故障 面板空白且无原因。',
      '// INV-07 错误文案统一归一化：守住位置 normalizeCodingPlanErrorMessage；改错故障 HTML 响应原样显示。',
      '// INV-08 刷新保留旧预览：守住位置 函数式 setState；改错故障 每次刷新面板闪一下空白。',
      '// INV-09 失败清空预览：守住位置 catch 内的 preview；改错故障 失败后仍展示过期套餐。',
      '// INV-10 初始 loading 需三条件：守住位置 enabled 与服务与缓存；改错故障 有缓存时首帧仍显示转圈。',
      '// INV-11 初始预览取缓存：守住位置 useState 初值；改错故障 首帧无内容，出现布局跳动。',
      '// INV-12 effect 依赖 refresh：守住位置 依赖数组；改错故障 enabled 变化后不重新取数。',
      '// INV-13 测试钩子只动模块缓存：守住位置 clear 与 prime；改错故障 测试需要挂载组件才能重置。',
      '// INV-14 预览与套餐列表共用远端配置：守住位置 同一 client/configs；改错故障 两处限流互相踩踏。',
      '//',
      '// 模块职责：读取 Start Plan 预览配置，提供模块级缓存、请求合并与错误归一化。',
      '// 阅读顺序：先看缓存与在飞变量，再看 hook 的初始态与刷新，最后看 loadStartPlanPreview。',
    ],
    blocks: [
      {
        anchor: 'const START_PLAN_PREVIEW_CACHE_TTL_MS = 24 * 60 * 60 * 1000;',
        lines: [
          '缓存一天，跨会话复用同一份配置。',
        ],
      },
      {
        anchor: 'let previewCache: { preview: StartPlanPreviewConfig | null; expiresAt: number } | null = null;',
        lines: [
          '模块级缓存独立于组件实例，卸载不丢。',
        ],
      },
      {
        anchor: 'let previewRequest: Promise<StartPlanPreviewConfig | null> | null = null;',
        lines: [
          '同一时刻只允许一个请求在飞。',
        ],
      },
      {
        anchor: 'loading: enabled && Boolean(service) && !previewCache,',
        lines: [
          '已有缓存时首帧不再显示加载。',
        ],
      },
      {
        anchor: 'if (!service || typeof service.getStartPlanPreview !== "function") {',
        lines: [
          '服务或方法缺失都按不可用处理。',
        ],
      },
      {
        anchor: 'setState((current) => ({',
        lines: [
          '刷新时保留旧预览，避免面板闪空。',
        ],
      },
      {
        anchor: 'const message = normalizeCodingPlanErrorMessage(error);',
        lines: [
          '错误统一归一化，非 JSON 响应不直接展示。',
        ],
      },
      {
        anchor: 'useEffect(() => {',
        lines: [
          'refresh 标识变化即重新取数。',
        ],
      },
      {
        anchor: 'previewCache = {',
        nth: 1,
        lines: [
          '测试钩子写入与真实缓存同形状。',
        ],
      },
      {
        anchor: 'previewCache = {',
        nth: 2,
        lines: [
          '成功结果连同过期时间一起缓存。',
        ],
      },
      {
        anchor: 'if (previewCache && previewCache.expiresAt > now) {',
        lines: [
          '未过期直接命中，不再打远端。',
        ],
      },
      {
        anchor: 'if (previewRequest) {',
        lines: [
          '已有在飞请求就复用，避免重复打 client/configs。',
        ],
      },
      {
        anchor: 'previewRequest = null;',
        nth: 3,
        lines: [
          '无论成功失败都要清掉在飞引用。',
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
    `ZC-deep-b212-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
