// B210 四个文件的注释 spec 生成器（target 全部为 30）。
import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/ModelTrajectorySearchBar.tsx',
    target: 30,
    header: [
      '// INV-01 打开即聚焦并全选：守住位置 mount 副作用；改错故障 用户需再点一次才能输入。',
      '// INV-02 空匹配禁用跳转：守住位置 disabled 判定；改错故障 0 条结果仍可点上下键。',
      '// INV-03 Escape 关闭且阻止默认：守住位置 keydown 分支；改错故障 搜索框吞掉 Esc，面板关不掉。',
      '// INV-04 Enter 正向、Shift+Enter 反向：守住位置 shiftKey 三元；改错故障 快捷键方向与按钮相反。',
      '// INV-05 计数器只在有匹配时显示序号：守住位置 matchCount 大于零的三元；改错故障 0/0 与索引 0 混淆。',
      '// INV-06 受控输入：守住位置 value 与 onChange 绑定；改错故障 输入框可被外部状态覆盖成脏值。',
      '// INV-07 三个按钮文案全部走 intl：守住位置 三处 formatMessage；改错故障 多语言下按钮无标签。',
      '// INV-08 关闭按钮不受匹配数影响：守住位置 第三个 Button 无 disabled；改错故障 无结果时连关闭都点不了。',
      '// INV-09 搜索框身份用 data 属性：守住位置 data-trajectory-search-bar；改错故障 测试与样式选择器失效。',
      '// INV-10 原生取消按钮隐藏：守住位置 尾部 appearance-none；改错故障 与自定义关闭按钮重叠。',
      '// INV-11 aria-hidden 只给装饰图标：守住位置 SearchIcon；改错故障 读屏重复播报图标名。',
      '// INV-12 面板高度与横向约束：守住位置 h-8 与 min-w-0；改错故障 长查询把面板撑开。',
      '// INV-13 导航语义固定为上一处与下一处：守住位置 onMove 的字面量；改错故障 上层收到未知方向。',
      '//',
      '// 模块职责：轨迹面板内的查找条，负责输入、计数与上一处/下一处/关闭三种操作。',
      '// 阅读顺序：先看挂载聚焦与受控输入，再看键盘分支与计数器，最后看三个按钮的可用性差异。',
    ],
    blocks: [
      {
        anchor: 'const inputRef = useRef<HTMLInputElement>(null);',
        lines: [
          '持有输入框句柄，仅用于挂载时聚焦。',
        ],
      },
      {
        anchor: 'useEffect(() => {',
        lines: [
          '空依赖，只在首次挂载执行一次。',
        ],
      },
      {
        anchor: 'inputRef.current?.select();',
        lines: [
          '预选中已有查询，便于直接覆盖输入。',
        ],
      },
      {
        anchor: 'const disabled = matchCount === 0;',
        lines: [
          '没有匹配时上下跳转没有意义，统一禁用。',
        ],
      },
      {
        anchor: 'data-trajectory-search-bar=""',
        lines: [
          '稳定身份标记，供测试与样式定位。',
        ],
      },
      {
        anchor: 'type="search"',
        lines: [
          '用原生搜索类型获得系统级语义。',
        ],
      },
      {
        anchor: 'value={query}',
        lines: [
          '完全受控，匹配状态由上层维护。',
        ],
      },
      {
        anchor: 'if (event.key === "Escape") {',
        lines: [
          'Esc 优先关闭，避免落到上层快捷键。',
        ],
      },
      {
        anchor: '} else if (event.key === "Enter") {',
        lines: [
          'Enter 触发跳转，方向由修饰键决定。',
        ],
      },
      {
        anchor: 'onMove(event.shiftKey ? "previous" : "next");',
        lines: [
          'Shift 反转方向，与按钮顺序保持一致。',
        ],
      },
      {
        anchor: 'placeholder={intl.formatMessage({ id: "modelTrajectory.searchPlaceholder" })}',
        lines: [
          '占位文案走 intl，跟随界面语言。',
        ],
      },
      {
        anchor: 'onClick={() => onMove("previous")}',
        lines: [
          '上一个按钮与 Shift+Enter 走同一条路径。',
        ],
      },
      {
        anchor: 'onClick={() => onMove("next")}',
        lines: [
          '下一个按钮与 Enter 走同一条路径。',
        ],
      },
      {
        anchor: 'onClick={onClose}',
        lines: [
          '关闭按钮始终可用，不受匹配数影响。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/openWorkspacePageThemeHero.tsx',
    target: 30,
    header: [
      '// INV-01 主题名到调色板是穷举映射：守住位置 switch 四个分支；改错故障 新主题掉进深色兜底。',
      '// INV-02 system 先解析成具体明暗：守住位置 useResolvedThemeHeroPalette；改错故障 system 被当成 dark 直接使用。',
      '// INV-03 zai-light 与 light 不共用：守住位置 case 顺序；改错故障 品牌浅色套上默认浅色蓝。',
      '// INV-04 zai-dark 与 dark 不共用：守住位置 两个分支各自的字面量；改错故障 品牌深色丢失蓝色基调。',
      '// INV-05 dark 与 system 落到同一兜底：守住位置 default 前的连续 case；改错故障 未识别主题渲染成空白。',
      '// INV-06 面板渐变属于调色板而非组件：守住位置 palette.panel 拼接；改错故障 主题切换只换字色不换背景。',
      '// INV-07 两团光晕同源不同色：守住位置 glowPrimary 与 glowSecondary；改错故障 明暗主题光晕冲突。',
      '// INV-08 光晕是纯装饰：守住位置 pointer-events-none；改错故障 光晕挡住内容点击。',
      '// INV-09 内容层置顶：守住位置 z-10；改错故障 内容被渐层覆盖。',
      '// INV-10 内容可选：守住位置 children 三元；改错故障 无内容时渲染空壳。',
      '// INV-11 外部类名追加而非覆盖：守住位置 cn 参数顺序；改错故障 调用方样式被内部覆盖。',
      '// INV-12 调色板只读：守住位置 每次返回新对象；改错故障 调用方修改污染其它实例。',
      '// INV-13 颜色值集中在此文件：守住位置 各 case 的字面量；改错故障 主题色散落到组件里。',
      '//',
      '// 模块职责：把主题名映射成首页 Hero 的渐层与光晕配色，并渲染可选内容层。',
      '// 阅读顺序：先看主题映射的四个分支，再看 system 解析，最后看 Hero 的两团光晕与内容层。',
    ],
    blocks: [
      {
        anchor: 'interface ThemeHeroPalette {',
        lines: [
          '调色板的七个字段决定 Hero 的全部视觉。',
        ],
      },
      {
        anchor: 'function getThemeHeroPalette(theme: Theme): ThemeHeroPalette {',
        lines: [
          '纯函数映射，便于在不同主题间比对取值。',
        ],
      },
      {
        anchor: 'case "light":',
        lines: [
          '默认浅色，蓝白渐层配天蓝光晕。',
        ],
      },
      {
        anchor: 'case "zai-light":',
        lines: [
          '品牌浅色，白底与品牌蓝单色光晕。',
        ],
      },
      {
        anchor: 'case "zai-dark":',
        lines: [
          '品牌深色，墨黑过渡到深蓝。',
        ],
      },
      {
        anchor: 'case "system":',
        lines: [
          'system 与 dark 共用兜底分支。',
        ],
      },
      {
        anchor: 'default:',
        lines: [
          '未知主题一律落到深色，保证可读。',
        ],
      },
      {
        anchor: 'const theme = useZCodeStore((state) => state.theme);',
        lines: [
          '订阅全局主题，变化时组件自动重算。',
        ],
      },
      {
        anchor: 'theme === "system" ? (resolveTheme(theme) === "dark" ? "dark" : "light") : theme;',
        lines: [
          'system 取解析后的明暗，不把 system 传下去。',
        ],
      },
      {
        anchor: 'const palette = useResolvedThemeHeroPalette();',
        lines: [
          '每次渲染重新取调色板，保证跟随主题。',
        ],
      },
      {
        anchor: '<div className={cn("relative overflow-hidden", palette.panel, props.className)}>',
        lines: [
          'panel 负责底色与网格，外部类名只做追加。',
        ],
      },
      {
        anchor: 'palette.glowPrimary,',
        lines: [
          '主光晕锚在左上，营造聚光。',
        ],
      },
      {
        anchor: 'palette.glowSecondary,',
        lines: [
          '次光晕在右下，补足层次。',
        ],
      },
      {
        anchor: '{props.children ? (',
        lines: [
          '内容层可选，无内容时只留背景。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/project-sidebar/remote-project-connection.ts',
    target: 30,
    header: [
      '// INV-01 最近目录必须唯一定位：守住位置 entries.length 不等于一；改错故障 多份同名目录被静默选中第一份。',
      '// INV-02 同时比对 roots 与 legacyWorkspace：守住位置 some 的两段；改错故障 迁移前的老项目找不到入口。',
      '// INV-03 host 必须存在：守住位置 hosts.some 过滤；改错故障 失效主机的目录残留仍被当作候选。',
      '// INV-04 有 profileId 就优先 profile：守住位置 三元展开；改错故障 目录绑定被降级成按来源服务器匹配。',
      '// INV-05 连接前固定已有入口：守住位置 entries 首元素 id；改错故障 连接完成后误入创建器。',
      '// INV-06 workspaceKey 反查路径：守住位置 pathForEntry；改错故障 用错路径连接到另一目录。',
      '// INV-07 缺任一要素即抛错：守住位置 entry、host、path 三条件；改错故障 用空值继续连接。',
      '// INV-08 Direct Server 走原出口：守住位置 host.kind 判定后提前返回；改错故障 服务器主机被误当成员走向导。',
      '// INV-09 凭据返回前再验成员仍在：守住位置 stillRetained 首次调用；改错故障 已移除项目被重新拉起。',
      '// INV-10 向导打开前再验一次：守住位置 末尾的 stillRetained；改错故障 迟到的结果把已删项目复活。',
      '// INV-11 保留判断要同时校验主机与条目：守住位置 membershipId 与 pathForEntry；改错故障 同名主机换绑后仍判定保留。',
      '// INV-12 展示聚合不替换默认线路：守住位置 profile 的取用；改错故障 失败线路被误设为默认操作线路。',
      '// INV-13 已定线路时错误只取线路：守住位置 projectError 三元；改错故障 Host 聚合错误盖住真实线路错误。',
      '//',
      '// 模块职责：把最近远程项目与保留中的远程项目解析成连接请求，并守住成员移除的竞态。',
      '// 阅读顺序：先看最近目录的唯一定位，再看保留连接的路径反查与 Direct Server 分支，最后看两次复验。',
    ],
    blocks: [
      {
        anchor: 'export function resolveRecentRemoteProjectPreference(',
        lines: [
          '最近目录是只读匹配，不产生副作用。',
        ],
      },
      {
        anchor: 'const entries = directory.entries.filter(',
        lines: [
          '候选必须属于现存主机，否则视为陈旧记录。',
        ],
      },
      {
        anchor: 'if (entries.length !== 1) return null;',
        lines: [
          '只有唯一匹配才敢固定入口，多份时交回调用方。',
        ],
      },
      {
        anchor: 'preferredProjectEntryId: entries[0]!.id,',
        lines: [
          '记录命中的条目，连接后据此恢复选中。',
        ],
      },
      {
        anchor: 'export async function requestRetainedRemoteProjectConnection(input: {',
        lines: [
          '保留连接是异步流程，全程可能被并发移除打断。',
        ],
      },
      {
        anchor: 'const pathForEntry = (entry: (typeof directory.entries)[number]) =>',
        lines: [
          '把 workspaceKey 翻译成条目下的真实路径。',
        ],
      },
      {
        anchor: 'const entry = directory.entries.find((candidate) => pathForEntry(candidate));',
        lines: [
          '先找到持有该路径的条目，再由条目取主机。',
        ],
      },
      {
        anchor: 'if (!entry || !host || !path) throw new Error("remote-project.entry-not-found");',
        lines: [
          '三要素缺一不可，直接失败而不是猜测。',
        ],
      },
      {
        anchor: 'if (host.kind === "server") {',
        lines: [
          'Direct Server 不经 Source Profile，保持原行为。',
        ],
      },
      {
        anchor: 'const stillRetained = async () => {',
        lines: [
          '复验闭包重新读取目录，不接受旧快照。',
        ],
      },
      {
        anchor: 'if (!(await stillRetained())) return;',
        lines: [
          '动任何副作用之前先确认成员仍在。',
        ],
      },
      {
        anchor: 'const state = snapshot?.states.find((candidate) => candidate.profileId === profile?.profileId);',
        lines: [
          '按线路取状态，用于展示与错误归类。',
        ],
      },
      {
        anchor: 'reconnect: async () => {',
        lines: [
          '重连只作用于当前主机，不改线路偏好。',
        ],
      },
      {
        anchor: 'if (pendingWizard && (await stillRetained())) input.openWizard(pendingWizard);',
        lines: [
          '向导是最后一步，打开前再复验一次。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/project-sidebar/RemoteProjectMenu.tsx',
    target: 30,
    header: [
      '// INV-01 远程子菜单随回调可选：守住位置 onOpenRemoteWorkspace 三元；改错故障 无远程能力时仍显示空子菜单。',
      '// INV-02 服务器列表来自快照：守住位置 snapshot 的可选链；改错故障 快照缺失时渲染报错。',
      '// INV-03 每台设备独立解析展示态：守住位置 getRemoteDevicePresentationInput；改错故障 多设备共用一份状态。',
      '// INV-04 连接中禁用点击：守住位置 status 等值判断；改错故障 重复点击发起重复连接。',
      '// INV-05 有 profileId 优先按 profile 打开：守住位置 三元展开；改错故障 已配置线路被降级成按服务器打开。',
      '// INV-06 新建连接不带偏好：守住位置 无参调用；改错故障 新建被旧选择污染。',
      '// INV-07 图标与短消息同源：守住位置 presentation 的两处读取；改错故障 图标显示在线而文案显示失败。',
      '// INV-08 列表为空不画分隔线：守住位置 servers.length 判定；改错故障 只有新建项时出现孤立分隔。',
      '// INV-09 分隔线在设备之后、新建之前：守住位置 JSX 顺序；改错故障 新建项混进设备列表。',
      '// INV-10 打开本地目录始终可用：守住位置 第一个菜单项无禁用；改错故障 远程异常拖累本地入口。',
      '// INV-11 设备名截断不挤压右侧状态：守住位置 truncate 与 shrink-0；改错故障 长设备名把文案挤出容器。',
      '// INV-12 触发器带测试标识：守住位置 data-testid；改错故障 自动化找不到新增入口。',
      '// INV-13 文案全部走 intl：守住位置 四处 formatMessage；改错故障 短消息 id 直接显示在界面上。',
      '//',
      '// 模块职责：项目侧边栏的新增入口，提供本地打开、按设备打开远程项目与新建远程连接。',
      '// 阅读顺序：先看触发器，再看本地入口，最后看远程子菜单的设备映射与新建项。',
    ],
    blocks: [
      {
        anchor: 'snapshot?: SourceServerManagementSnapshot | null;',
        lines: [
          '快照可空，未加载时只保留本地与新建入口。',
        ],
      },
      {
        anchor: 'onOpenRemoteWorkspace?: (preference?: RemoteConnectionOpenPreference) => void;',
        lines: [
          '远程入口由调用方决定是否存在。',
        ],
      },
      {
        anchor: '<DropdownMenu>',
        lines: [
          '单一菜单根，触发器与内容同源。',
        ],
      },
      {
        anchor: 'data-testid={TID_VIRTUAL_PROJECT_ADD}',
        lines: [
          '测试标识挂在触发器上，便于端到端定位。',
        ],
      },
      {
        anchor: '<DropdownMenuItem onSelect={onOpenFolder}>',
        lines: [
          '本地打开不依赖远程状态。',
        ],
      },
      {
        anchor: '{onOpenRemoteWorkspace ? (',
        lines: [
          '没有远程能力就整块省略。',
        ],
      },
      {
        anchor: '{snapshot?.servers.map((server) => {',
        lines: [
          '逐台设备生成条目，顺序与快照一致。',
        ],
      },
      {
        anchor: 'getRemoteDevicePresentationInput(snapshot, server.sourceServerId),',
        lines: [
          '展示输入按设备聚合，避免跨设备串状态。',
        ],
      },
      {
        anchor: 'disabled={presentation.status === "connecting"}',
        lines: [
          '连接中的设备不可再次点击。',
        ],
      },
      {
        anchor: 'presentation.profileId',
        lines: [
          '已绑定线路时按 profile 打开。',
        ],
      },
      {
        anchor: ': { preferredSourceServerId: server.sourceServerId },',
        lines: [
          '未绑定线路时退回按来源服务器打开。',
        ],
      },
      {
        anchor: '<RemoteConnectionStateIcon presentation={presentation} project />',
        lines: [
          '状态图标与右侧文案来自同一份展示结果。',
        ],
      },
      {
        anchor: '{snapshot?.servers.length ? <DropdownMenuSeparator /> : null}',
        lines: [
          '只有存在设备时才需要分隔线。',
        ],
      },
      {
        anchor: '<DropdownMenuItem onSelect={() => onOpenRemoteWorkspace()}>',
        lines: [
          '新建连接不携带任何偏好，从空白开始。',
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
    `ZC-deep-b210-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
