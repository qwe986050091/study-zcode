// B227 四个文件的注释 spec 生成器（各新增 30 行）。
import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/hooks/useBackgroundBashOutput.ts',
    target: 30,
    header: [
      '// INV-01 隐藏即停轮询：守住位置 if (!visible) return；改错故障 面板关闭后仍每秒发请求。',
      '// INV-02 迟到响应不可应用：守住位置 disposed 三处判断；改错故障 旧响应覆盖新目标的输出。',
      '// INV-03 轮询串行化：守住位置 inFlight.current 等待；改错故障 多次轮询并发打满连接。',
      '// INV-04 in-flight 自清理：守住位置 相等判断；改错故障 已完成的 Promise 被永久缓存。',
      '// INV-05 目标变化清空状态：守住位置 首个 useEffect；改错故障 切换任务后仍显示上一个任务的输出。',
      '// INV-06 非 output 即错误：守住位置 result.kind 判断；改错故障 错误结果被当正常输出渲染。',
      '// INV-07 仅运行中续轮询：守住位置 status === "running"；改错故障 结束后仍空转或运行中停更。',
      '// INV-08 先握手再查询：守住位置 ensureAgentV4ConnectionHandshake；改错故障 冷启动首个请求被拒。',
      '// INV-09 查询失败只记 debug：守住位置 catch 内 logger.debug；改错故障 偶发失败刷屏告警。',
      '// INV-10 失败要有错误态：守住位置 setError("query_failed")；改错故障 UI 无法区分空输出与失败。',
      '// INV-11 暂停冻结当前值：守住位置 current ?? latest；改错故障 暂停后画面仍跳到最新。',
      '// INV-12 恢复即重查：守住位置 resume 内调用 refresh；改错故障 恢复后要等下一个计时器。',
      '// INV-13 display 优先冻结：守住位置 frozen ?? latest；改错故障 暂停语义被展示层绕过。',
      '// INV-14 刷新靠 revision：守住位置 递增函数与依赖数组；改错故障 手动刷新不触发重查。',
      '//',
      '// 模块职责：轮询后台 Bash 输出，并提供暂停与恢复的前端状态。',
      '// 阅读顺序：先看状态与 in-flight 句柄，再看轮询 effect 的串行与清理，最后看返回的暂停语义。',
    ],
    blocks: [
      {
        anchor: 'export function useBackgroundBashOutput(target: BackgroundBashOutputTarget, visible: boolean) {',
        lines: [
          '目标解构后逐个进入依赖数组。',
        ],
      },
      {
        anchor: 'const [latest, setLatest] = useState<BackgroundBashOutput | null>(null);',
        lines: [
          '最新成功响应，失败时不覆盖旧值。',
        ],
      },
      {
        anchor: 'const inFlight = useRef<Promise<BackgroundBashOutputResult> | null>(null);',
        lines: [
          '用于串行化轮询并识别过期请求。',
        ],
      },
      {
        anchor: 'const refresh = useCallback(() => setRevision((value) => value + 1), []);',
        lines: [
          '用递增版本号触发一次重查。',
        ],
      },
      {
        anchor: '}, [workspacePath, workspaceIdentity, remoteSessionId, sessionId, workId]);',
        lines: [
          '目标切换必须丢掉上一任务的输出。',
        ],
      },
      {
        anchor: 'if (!visible) return;',
        lines: [
          '不可见时完全不发起请求。',
        ],
      },
      {
        anchor: 'let disposed = false;',
        lines: [
          '卸载标记用于丢弃迟到响应。',
        ],
      },
      {
        anchor: 'if (inFlight.current) await inFlight.current.catch(() => undefined);',
        lines: [
          '新轮询先等在途请求，避免并发叠加。',
        ],
      },
      {
        anchor: 'await ensureAgentV4ConnectionHandshake(service);',
        lines: [
          '查询前确保 v4 连接已建立。',
        ],
      },
      {
        anchor: 'if (result.kind !== "output") {',
        lines: [
          '非 output 结果按错误展示。',
        ],
      },
      {
        anchor: 'if (result.status === "running") timer = setTimeout(() => void poll(), 1000);',
        lines: [
          '运行中每秒续轮询一次。',
        ],
      },
      {
        anchor: 'if (inFlight.current === request) inFlight.current = null;',
        lines: [
          '只清理自己那一次的句柄。',
        ],
      },
      {
        anchor: 'pause: () => setFrozen((current) => current ?? latest),',
        lines: [
          '暂停把当前显示值冻结下来。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/lib/archivedTaskDeletion.ts',
    target: 30,
    header: [
      '// INV-01 按工作区去重：守住位置 buildTaskWorkspaceKey 作 Map 键；改错故障 同一工作区被重复删除。',
      '// INV-02 只用完整归档集合：守住位置 service.listArchivedTasks；改错故障 漏删被 UI 过滤掉的项。',
      '// INV-03 无 service 记为不可用：守住位置 targets: null；改错故障 静默跳过让用户以为已删干净。',
      '// INV-04 taskId 去重：守住位置 new Set(tasks.map)；改错故障 重复 id 让计数翻倍。',
      '// INV-05 读失败不中断：守住位置 逐工作区 try/catch；改错故障 一个工作区失败拖垮整批。',
      '// INV-06 计数只算可用项：守住位置 reduce 里的 ?? 0；改错故障 null 组被算成负数或抛错。',
      '// INV-07 不可用工作区要回传：守住位置 unavailableWorkspaces；改错故障 UI 无法提示部分失败。',
      '// INV-08 同工作区一次 RPC：守住位置 按 groups 组织删除；改错故障 逐项调用引发事件风暴。',
      '// INV-09 批失败整组计失败：守住位置 catch 内 failed += targets.length；改错故障 失败项被当成未处理。',
      '// INV-10 逐项三态归因：守住位置 deleted/skipped/failed 三支；改错故障 用户看不到跳过原因。',
      '// INV-11 已删回调逐项触发：守住位置 onDeleted(target)；改错故障 列表残留已删除条目。',
      '// INV-12 工作区之间并行：守住位置 外层 Promise.all；改错故障 多工作区串行拖慢删除。',
      '// INV-13 空目标早退：守住位置 if (!targets?.length) return；改错故障 空批次仍发请求。',
      '// INV-14 返回值带不可用列表：守住位置 末行 return；改错故障 调用方丢失部分失败信息。',
      '//',
      '// 模块职责：跨工作区收集待删归档任务，并按工作区分批执行删除与结果归因。',
      '// 阅读顺序：先看收集阶段的去重与降级，再看删除阶段的批调用，最后看逐项三态统计。',
    ],
    blocks: [
      {
        anchor: 'export async function collectArchivedTaskDeletion(workspaces: ArchivedTaskDeletionWorkspace[]) {',
        lines: [
          '先按工作区去重，再并发读取归档。',
        ],
      },
      {
        anchor: 'const unique = new Map(',
        lines: [
          '同一工作区只保留一份，后写覆盖前写。',
        ],
      },
      {
        anchor: 'const results = await Promise.all(',
        lines: [
          '工作区之间并行，单项失败不扩散。',
        ],
      },
      {
        anchor: 'if (!workspace.service) return { workspace, targets: null };',
        lines: [
          '不可用工作区以 null 目标占位。',
        ],
      },
      {
        anchor: 'const tasks = await workspace.service.listArchivedTasks({',
        lines: [
          '直接读服务端归档全集，不用 UI 过滤后的列表。',
        ],
      },
      {
        anchor: 'const targets = [...new Set(tasks.map((task) => task.taskId))].map((taskId) => ({',
        lines: [
          'taskId 去重后附带工作区身份。',
        ],
      },
      {
        anchor: 'logger.warn("[ArchivedTaskDeletion] 读取归档项目失败", {',
        lines: [
          '读失败降级为不可用，不中断整批。',
        ],
      },
      {
        anchor: 'groups: results.filter((result) => result.targets !== null),',
        lines: [
          '只把有目标的组交给删除阶段。',
        ],
      },
      {
        anchor: 'export async function deleteArchivedTaskSelection(',
        lines: [
          '删除阶段按组统计三态结果。',
        ],
      },
      {
        anchor: 'let deleted = 0;',
        lines: [
          '三个计数器与 UI 回执一一对应。',
        ],
      },
      {
        anchor: 'result = await workspace.service!.deleteArchivedTasks({',
        lines: [
          '同一工作区一次 RPC，事件只发一轮。',
        ],
      },
      {
        anchor: 'failed += targets.length;',
        lines: [
          '整组失败并保留日志便于排查。',
        ],
      },
      {
        anchor: 'const deletedIds = new Set(result.deletedTaskIds);',
        lines: [
          '按服务端回执逐项归因。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/lib/modelSelectionGroups.ts',
    target: 30,
    header: [
      '// INV-01 缺 apiFormat 即跳过：守住位置 supportsRegistryApiFormat 早退；改错故障 无格式的 provider 混进菜单。',
      '// INV-02 只认 ZCode Agent：守住位置 isZCodeAgentProvider；改错故障 已下线 provider 重新出现。',
      '// INV-03 账号信息强校验：守住位置 safeParse；改错故障 畸形 access 让整组渲染崩溃。',
      '// INV-04 解析失败不抛：守住位置 success 三元；改错故障 一个坏配置拖垮整个菜单。',
      '// INV-05 徽标来源优先账号：守住位置 labelBadge 的 ??；改错故障 套餐徽标被 API 徽标覆盖。',
      '// INV-06 名称三级回退：守住位置 label 三元链；改错故障 无名称时出现空分组标题。',
      '// INV-07 值必须是编码串：守住位置 encodeCustomModelValue；改错故障 选中回填时找不到 provider。',
      '// INV-08 key 带 provider 前缀：守住位置 registry-provider:；改错故障 不同 provider 的模型 id 冲突。',
      '// INV-09 视觉徽标按配置：守住位置 shouldShowModelVisionBadge；改错故障 纯文本模型显示图片标志。',
      '// INV-10 Start Plan 固定文案：守住位置 access.mode 分支；改错故障 免费档显示成团队档。',
      '// INV-11 团队档用 family 名称：守住位置 familySpec?.label；改错故障 标题退化成 providerId。',
      '// INV-12 默认个人套餐：守住位置 末行 return；改错故障 未知模式没有徽标。',
      '// INV-13 反查先扫已加载组：守住位置 resolveModelDisplayName 循环；改错故障 已选模型显示原始编码。',
      '// INV-14 反查兜底解码：守住位置 decodeCustomModelValue；改错故障 自定义模型名显示为空。',
      '//',
      '// 模块职责：把 registry 的 provider 视图转换成模型选择菜单分组，并提供显示名反查。',
      '// 阅读顺序：先看过滤条件，再看分组与徽标构造，最后看反查的回退链。',
    ],
    blocks: [
      {
        anchor: 'function supportsRegistryApiFormat(',
        lines: [
          'registry 菜单只服务 ZCode Agent。',
        ],
      },
      {
        anchor: 'if (!apiFormat) return false;',
        lines: [
          '没有 api 格式的 provider 直接排除。',
        ],
      },
      {
        anchor: 'export function buildRegistryModelSelectGroups(',
        lines: [
          '按 provider 展开为菜单分组。',
        ],
      },
      {
        anchor: 'return view.providers.flatMap((provider) => {',
        lines: [
          '不匹配的 provider 返回空数组被摊平。',
        ],
      },
      {
        anchor: 'if (!supportsRegistryApiFormat(selectedProvider, provider.config.api?.type)) {',
        lines: [
          '判断基于当前选中 provider 而非候选自身。',
        ],
      },
      {
        anchor: 'const accountAccess = zcodeProviderAccountAccessSchema.safeParse(provider.config.access);',
        lines: [
          '账号信息走 schema 校验，失败不抛。',
        ],
      },
      {
        anchor: 'const labelBadge =',
        lines: [
          '账号展示优先，其次按 access 类型兜底。',
        ],
      },
      {
        anchor: 'key: `registry-provider:${provider.providerId}`,',
        lines: [
          'provider 级与模型级 key 共用前缀。',
        ],
      },
      {
        anchor: 'items: provider.models.map(({ modelId, config }) => ({',
        lines: [
          '模型项的值是编码串，回填时才能定位 provider。',
        ],
      },
      {
        anchor: 'function getRegistryAccountProviderGroupPresentation(',
        lines: [
          '按套餐模式给分组加徽标。',
        ],
      },
      {
        anchor: 'if (access.mode === "start-plan") {',
        lines: [
          '免费档固定文案，不被 family 名称覆盖。',
        ],
      },
      {
        anchor: 'export function resolveModelDisplayName(',
        lines: [
          '先查已加载组，再退回解码。',
        ],
      },
      {
        anchor: 'return decodeCustomModelValue(value)?.modelName ?? null;',
        lines: [
          '解码失败返回 null 交由调用方决定。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/lib/permissionRequest.ts',
    target: 30,
    header: [
      '// INV-01 归一化不抛错：守住位置 三个导出函数；改错故障 畸形 kind 让审批卡直接崩溃。',
      '// INV-02 常驻优先于一次性：守住位置 always 判断在前；改错故障 allow always 被降级成一次性。',
      '// INV-03 全小写匹配：守住位置 toLowerCase；改错故障 大写 kind 一律落到 custom。',
      '// INV-04 空白折叠：守住位置 normalizeInlineText；改错故障 多空格名称与通用表匹配不上。',
      '// INV-05 空名不显示：守住位置 length === 0 早退；改错故障 空白标签占位。',
      '// INV-06 custom 一律用名称：守住位置 displayKind 判断；改错故障 自定义选项被通用文案覆盖。',
      '// INV-07 通用表只用于抑制：守住位置 Set.has 取反；改错故障 有信息量的名称被隐藏。',
      '// INV-08 排序稳定：守住位置 index 兜底比较；改错故障 同优先级选项顺序抖动。',
      '// INV-09 全权限固定插队：守住位置 1.5 常量；改错故障 全权限排到末尾导致误点拒绝。',
      '// INV-10 排序不改入参：守住位置 先 map 再 sort；改错故障 直接变异调用方数组。',
      '// INV-11 映射保留原对象：守住位置 .map(({ option }) => option)；改错故障 引用变化让选中态失效。',
      '// INV-12 未知类型排最后：守住位置 default 返回 4；改错故障 未知项挤到允许项前面。',
      '// INV-13 预览与类型直接透传：守住位置 顶部 export from；改错故障 本地重复定义与共享层漂移。',
      '// INV-14 分组表覆盖全枚举：守住位置 Record 类型约束；改错故障 新增枚举缺表项，运行时报 undefined。',
      '//',
      '// 模块职责：把权限选项的 kind 文本归一成展示语义，并提供稳定的选项排序。',
      '// 阅读顺序：先看通用名表与归一化，再看 kind 判定优先级，最后看排序的插队与稳定性。',
    ],
    blocks: [
      {
        anchor: 'const GENERIC_PERMISSION_OPTION_NAMES: Record<PermissionOptionDisplayKind, Set<string>> = {',
        lines: [
          '通用名用于抑制没有信息量的标签。',
        ],
      },
      {
        anchor: 'function normalizeInlineText(value: string): string {',
        lines: [
          '折叠空白后再比对通用名。',
        ],
      },
      {
        anchor: 'export function getPermissionOptionDisplayKind(kind: string): PermissionOptionDisplayKind {',
        lines: [
          '从 kind 文本推断展示语义。',
        ],
      },
      {
        anchor: 'const isAllow = normalizedKind.includes("allow") || normalizedKind.includes("approve");',
        lines: [
          '三段判定：允许、拒绝、常驻。',
        ],
      },
      {
        anchor: 'if (isAllow && isAlways) {',
        lines: [
          '常驻判断必须优先于一次性。',
        ],
      },
      {
        anchor: 'export function shouldPreferPermissionOptionName(',
        lines: [
          '决定标签用名称还是通用文案。',
        ],
      },
      {
        anchor: 'const displayKind = getPermissionOptionDisplayKind(option.kind);',
        lines: [
          '自定义类型一律使用名称。',
        ],
      },
      {
        anchor: 'return !GENERIC_PERMISSION_OPTION_NAMES[displayKind].has(normalizedName);',
        lines: [
          '不属于通用名说明名称携带信息。',
        ],
      },
      {
        anchor: 'function getPermissionOptionSortPriority(kind: string): number {',
        lines: [
          '固定优先级：允许在前，拒绝在后。',
        ],
      },
      {
        anchor: 'export function sortPermissionOptions(',
        lines: [
          '排序不改动入参数组。',
        ],
      },
      {
        anchor: '.sort((left, right) => {',
        lines: [
          '比较器先看优先级再看原序。',
        ],
      },
      {
        anchor: 'if (priorityDelta !== 0) {',
        lines: [
          '优先级不同直接返回差值。',
        ],
      },
      {
        anchor: 'return left.index - right.index;',
        lines: [
          '同优先级保持稳定顺序。',
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
    `ZC-deep-b227-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
