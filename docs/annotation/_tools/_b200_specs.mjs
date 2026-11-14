import fs from 'node:fs';

const specs = [
  {
    file: 'packages/shared/src/forceUpdate.ts',
    target: 31,
    header: [
      '// INV-01 先 trim 再去 v 前缀：守住位置 parseSemver 首行；改错故障 带空格或前缀的版本解析失败，强制更新永不触发。',
      '// INV-02 标准 semver 优先于简写补全：守住位置 三条匹配的顺序；改错故障 "4.5" 被先当成主版本号解析。',
      '// INV-03 构建元数据不参与比较：守住位置 正则的加号段；改错故障 同版本仅构建号不同被判为需要升级。',
      '// INV-04 预发布版低于同号正式版：守住位置 comparePrerelease 的空数组分支；改错故障 1.0.0-beta 被当成高于 1.0.0。',
      '// INV-05 预发布逐段比较，数字段按数值、其余按字典序：守住位置 循环内分支；改错故障 beta.10 排在 beta.9 之前。',
      '// INV-06 数字段小于字母段：守住位置 numeric 异或分支；改错故障 1.0.0-1 被判为高于 1.0.0-alpha。',
      '// INV-07 段数短的一方更小：守住位置 undefined 分支；改错故障 前缀相同的两个预发布版被判为相等。',
      '// INV-08 解析失败返回 null 而不是抛错：守住位置 三个解析出口；改错故障 脏配置让设置页崩溃。',
      '// INV-09 无法比较不得当作需要升级：守住位置 compareSemverVersions 的 null 出口；改错故障 部分用户被莫名强制更新。',
      '// INV-10 空或纯空白的最小版本视为不限制：守住位置 resolve 的前置判断；改错故障 空字符串触发全员强制更新。',
      '// INV-11 当前版本不低于最小版本即不提示：守住位置 comparison 大于等于零；改错故障 最新版用户仍被要求升级。',
      '// INV-12 返回值只带两个版本号：守住位置 返回对象；改错故障 UI 依赖额外字段后无法复用。',
      '// INV-13 比较不读远端顺序或时间：守住位置 整个模块无外部状态；改错故障 服务端下发顺序影响判断。',
      '//',
      '// 模块职责：把远端下发的 minimalVersion 与本地版本比较，决定是否必须更新。',
      '// 阅读顺序：先看解析与补全，再看预发布比较，最后看准入判定。',
    ],
    blocks: [
      {
        anchor: 'const normalized = version.trim().replace(/^v/i, "");',
        lines: [
          '去空白与 v 前缀都为了兼容服务端手写的版本串。',
          '不要在这里补全段数：补全依赖后续三条正则的先后顺序。',
          '大小写不敏感只作用于前缀，版本主体保持原样。',
        ],
      },
      {
        anchor: 'const strictMatch = normalized.match(',
        lines: [
          '严格 semver 优先，命中后不再走补全分支。',
          '预发布段按点切分，供逐段比较使用。',
          '构建元数据被正则吞掉但不入结构，天然不参与比较。',
        ],
      },
      {
        anchor: 'function comparePrerelease(left: string[], right: string[]): number {',
        lines: [
          '空数组代表正式版，正式版高于任何预发布版。',
          '逐段比较：纯数字段按数值，其余按字典序。',
          '数字段低于字母段，这是 semver 的明确规定。',
          '段数不等时短者更小，注意这里必须先判 undefined。',
        ],
      },
      {
        anchor: 'export function compareSemverVersions(leftVersion: string, rightVersion: string): number | null {',
        lines: [
          '主次补丁逐段比较，任一不等即返回，不再看预发布。',
          '两边都解析成功才比较预发布；解析失败统一返回 null。',
          '返回 null 是「无法比较」，调用方必须显式处理。',
        ],
      },
      {
        anchor: 'const minimalVersion = params.forceUpdate?.minimalVersion.trim();',
        lines: [
          '空串与纯空白都表示未配置，此时不强制更新。',
          '当前版本无法解析或已达标时同样不返回需求。',
        ],
      },
    ],
  },
  {
    file: 'packages/shared/src/sqlite-migrations/runner.ts',
    target: 31,
    header: [
      '// INV-01 任何 SQL 之前先校验 touchedTables：守住位置 migrate 的首个循环；改错故障 运行成功却没有备份。',
      '// INV-02 表名必须是合法标识符：守住位置 正则；改错故障 备份语句拼接可被注入。',
      '// INV-03 调用方已开事务时不再自开：守住位置 transactionOpen 分支；改错故障 嵌套 begin 直接报错。',
      '// INV-04 事务归属必须与选项一致：守住位置 migrateExclusive 首行；改错故障 半途接管别人的事务。',
      '// INV-05 备份目录必填：守住位置 长度判断；改错故障 破坏性迁移没有回滚点。',
      '// INV-06 同库迁移按路径串行：守住位置 flights 的注册与清理；改错故障 第二个同步锁等待阻塞第一个的异步备份。',
      '// INV-07 串行不传播前一个的失败：守住位置 catch 吞掉；改错故障 一次失败让后续迁移永远不跑。',
      '// INV-08 队列按身份释放：守住位置 finally 的比较；改错故障 后到者被误删，串行失效。',
      '// INV-09 校验和不一致立即失败：守住位置 MigrationChecksumError；改错故障 被改过的已应用 SQL 被静默接受。',
      '// INV-10 改号迁移只搬记录不重跑：守住位置 previousIds 分支；改错故障 容器被重复创建、归属被重置。',
      '// INV-11 备份只覆盖真正待执行的迁移：守住位置 pending 过滤；改错故障 无待办时仍产出备份。',
      '// INV-12 journal 建表走 identifier：守住位置 建表语句；改错故障 两种 journal 表结构不兼容。',
      '// INV-13 提交前回调失败即整体回滚：守住位置 onCommitting 之后才 commit；改错故障 回调失败但迁移已落库。',
      '// INV-14 回滚只在自己持有事务时执行：守住位置 catch 中的 isTransaction；改错故障 回滚掉调用方的事务。',
      '//',
      '// 模块职责：按清单顺序执行 SQLite 迁移，串行化同库并发并保证备份与校验和一致。',
      '// 阅读顺序：先看入口校验与并发闸门，再看待办筛选与改号，最后看备份、执行与事务收尾。',
    ],
    blocks: [
      {
        anchor: 'for (const migration of migrations) {',
        nth: 1,
        lines: [
          '这一步必须早于任何 pragma 与 SQL 写入。',
          '清单缺失或表名非法都直接抛错，不带病执行。',
          '正则同时挡住关键词与注入片段，不要放宽。',
        ],
      },
      {
        anchor: 'if (options.transactionOpen) return migrateExclusive(db, migrations, options);',
        lines: [
          '已在外层事务里就跳过并发闸门，避免自锁。',
          '此时事务归属由调用方负责，收尾不做 commit。',
        ],
      },
      {
        anchor: 'const previous = flights.get(location);',
        lines: [
          '按实际数据库文件路径串行，而不是按 db 对象。',
          '前一个失败不影响后一个：这里刻意吞掉错误。',
          '等待完成后才进入独占执行，避免同步锁互等。',
          '拿到不了路径时退化为不串行，保证单测可用。',
        ],
      },
      {
        anchor: 'if (!options.backupDirectories.length) throw new Error("Migration requires a backup directory");',
        lines: [
          '没有备份目录就不允许执行任何迁移。',
          '这条检查在开事务之前，失败时不留悬挂事务。',
        ],
      },
      {
        anchor: 'const appliedIds = ids.filter((id) => {',
        lines: [
          '同一迁移的旧 id 与新 id 一起查，兼容改号历史。',
          '已应用但校验和不符立即抛错，绝不静默跳过。',
          '只要任一 id 已应用就不进待办，交给改号分支搬记录。',
        ],
      },
    ],
  },
  {
    file: 'packages/shared/src/subagents-types.ts',
    target: 32,
    header: [
      '// INV-01 插件覆盖键必须带 plugin 前缀：守住位置 parse 的过滤；改错故障 内置 subagent 被插件覆盖。',
      '// INV-02 单条覆盖解析失败只丢该条：守住位置 safeParse 的 flatMap；改错故障 一条脏配置清空全部覆盖。',
      '// INV-03 非对象与数组一律当空：守住位置 入口判断；改错故障 数组下标被当成 agent id。',
      '// INV-04 插件 id 是 plugin 加 pluginId 加裸名小写：守住位置 createPluginAgentStateId；改错故障 插件升级后覆盖丢失。',
      '// INV-05 pluginId 不含版本：守住位置 注释约定的入参；改错故障 同插件不同版本各存一份覆盖。',
      '// INV-06 裸名先 trim 再小写：守住位置 拼接前处理；改错故障 大小写差异产生两个键。',
      '// INV-07 三类 id 靠 source 前缀区分：守住位置 createAgentStateId；改错故障 agents-state.json 键冲突。',
      '// INV-08 scope 与 source 取值集合固定：守住位置 两个联合类型；改错故障 新增取值后旧状态读不出来。',
      '// INV-09 三个列表各自独立：守住位置 AgentsListResult；改错故障 UI 分不清 agent 来源。',
      '// INV-10 不可用能力用 capability 表达：守住位置 userScopeReason；改错故障 前端靠空数组猜原因。',
      '// INV-11 诊断必须带 code 与 path：守住位置 AgentDiagnostic；改错故障 问题无法定位到具体文件。',
      '// INV-12 配置载荷与展示摘要分离：守住位置 SubAgentConfig 与 AgentSummary；改错故障 内部字段被 UI 回写。',
      '//',
      '// 模块职责：subagent 的标识、权限、模型覆盖与列表响应的共享类型契约。',
      '// 阅读顺序：先看覆盖解析与 id 生成，再看列表与诊断形状。',
    ],
    blocks: [
      {
        anchor: 'export function parsePluginSubagentModelSelectionOverrides(',
        lines: [
          '只接受结构化覆盖，不在读取时解释旧的双 map。',
          '返回值只保留能通过模型选择 schema 的条目。',
          '重复 id 后写覆盖前写，与对象展开语义一致。',
        ],
      },
      {
        anchor: 'if (!value || typeof value !== "object" || Array.isArray(value)) return {};',
        lines: [
          '空值与数组都不是合法覆盖表，直接当空处理。',
          '这里不抛错：读取旧状态时脏数据不应该让列表失败。',
        ],
      },
      {
        anchor: 'return Object.fromEntries(',
        lines: [
          '逐条 safeParse，失败条目静默丢弃而不是整表失败。',
          '前缀过滤把非插件键挡在外面，避免越权覆盖。',
          '最终键集合即写入 agents-state.json 的键集合。',
        ],
      },
      {
        anchor: 'export function createPluginAgentStateId(pluginId: string, agentName: string): string {',
        lines: [
          'pluginId 形如名字加市场，不含版本，升级后 id 不变。',
          '裸名统一 trim 加小写，避免大小写差异产生两个键。',
          'services 与 CLI bootstrap 必须共用这一处实现。',
        ],
      },
      {
        anchor: 'export function createAgentStateId(input: {',
        lines: [
          'source 与 scope 都进键，内置与用户同名也不会撞。',
          '名字同样 trim 加小写，保持与插件 id 一致的归一。',
          '修改拼接格式等于迁移所有存量状态，需同步写迁移。',
        ],
      },
      {
        anchor: 'export interface AgentsListResult {',
        lines: [
          '全量、用户与插件三份列表并存，UI 据此分组展示。',
          'capability 表达平台能力，不用空列表暗示不可用。',
          '诊断挂在结果上，单个 agent 的问题不阻断列表。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/app-shell/workflow-artifacts/presets/ArtifactBoard.tsx',
    target: 31,
    header: [
      '// INV-01 组件是 journal 的只读投影：守住位置 无任何事件处理器；改错故障 出现第二份权威状态。',
      '// INV-02 卡片只按 key upsert：守住位置 applyArtifactItems 的结果；改错故障 刷新后卡片重复或顺序漂移。',
      '// INV-03 卡片 id 即 React key：守住位置 BoardCard 的 key；改错故障 新卡不播揭示动画、旧卡被整体重建。',
      '// INV-04 状态变化只换列不重建卡：守住位置 key 的稳定性；改错故障 每次刷新都重播揭示动画。',
      '// INV-05 compact 只出各列计数：守住位置 compact 分支；改错故障 侧板被卡片撑爆。',
      '// INV-06 空态在两种形态下都渲染：守住位置 cardCount 判断；改错故障 侧板一片空白没有任何提示。',
      '// INV-07 全尺寸标题带总数：守住位置 PresetHeading 的 trailing；改错故障 用户无法确认投影是否完整。',
      '// INV-08 列标题优先取本地化文案：守住位置 columnLabel；改错故障 other 列直接显示英文 id。',
      '// INV-09 列宽固定并横向滚动：守住位置 w-44 与 overflow-x-auto；改错故障 窄面板挤压正文。',
      '// INV-10 长值截断但保留 title：守住位置 truncate 与 title 成对出现；改错故障 撑破布局且看不到全文。',
      '// INV-11 memo 与 useMemo 依赖 spec 与 items：守住位置 组件包裹与依赖数组；改错故障 上游换引用导致无谓重算。',
      '//',
      '// 模块职责：workflow-artifact 的 board 预置渲染器，按 status 分列展示卡片。',
      '// 阅读顺序：先看两类形态的分支，再看卡片与列标题的取值口径。',
    ],
    blocks: [
      {
        anchor: 'function columnLabel(column: BoardColumnModel, labels: PresetLabels): string {',
        lines: [
          'other 是脚本没给出 status 时的兜底列，文案走本地化。',
          '已知状态直接用 id 展示，避免文案与脚本取值不一致。',
        ],
      },
      {
        anchor: 'function BoardCard({ card }: { card: BoardCardModel }) {',
        lines: [
          'key 由父级按 card.id 提供，这里只负责渲染。',
          '揭示动画挂在卡片上，换列不会重建节点因此不会重播。',
          '详情逐条渲染为定义列表，标签与值分别截断。',
          'title 挂原值，截断后仍可悬停查看全文。',
        ],
      },
      {
        anchor: 'export const ArtifactBoard = memo(function ArtifactBoard({',
        lines: [
          '整体 memo 化：侧板高频刷新时不重算整块卡片墙。',
          'spec 与 items 都是上游不可变数据，比较成本低。',
          '只读组件，不接 onSelect 之类的回调。',
        ],
      },
      {
        anchor: 'const model = useMemo(() => applyArtifactItems("board", spec, items), [spec, items]);',
        lines: [
          '投影计算全部收敛到 applyArtifactItems，组件不做二次归并。',
          '依赖只有 spec 与 items，labels 变化不影响列结构。',
          '返回值同时给出列与总数，两种形态共用一份结果。',
        ],
      },
      {
        anchor: 'if (model.cardCount === 0) {',
        lines: [
          '空态也保留标题，用户能确认这是空而不是没加载。',
          'compact 下不渲染标题，避免侧板占用高度。',
        ],
      },
      {
        anchor: 'if (compact) {',
        lines: [
          '侧板只展示列名与计数，不渲染卡片本体。',
          '列数由脚本输出决定，可能多于一屏，因此允许换行。',
          '计数用等宽数字，避免刷新时宽度跳动。',
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
    `ZC-deep-b200-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
