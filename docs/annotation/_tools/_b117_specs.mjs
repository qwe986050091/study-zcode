import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/lib/composerRecent.ts',
    first: 'import { isHighspeedProviderId } from "@zcode/shared";',
    target: 46,
    header: [
      '// INV-01 存储键沿用旧前缀：守住位置 COMPOSER_RECENT_KEY_PREFIX；改错故障 升级后旧偏好全部丢失。',
      '// INV-02 读取同时兼容旧格式：守住位置 readComposerRecent 两个叶子；改错故障 历史记录整条失效。',
      '// INV-03 模型与模式独立校验：守住位置 两个 safeParse；改错故障 坏模型连带丢掉合法模式。',
      '// INV-04 加速 Provider 写入即自愈：守住位置 isHighspeedProviderId 判断；改错故障 新草稿模型选择器空态。',
      '// INV-05 回执按单调序号排序：守住位置 lastReceiptOrder；改错故障 同毫秒回执互相覆盖。',
      '// INV-06 回执深拷贝入参：守住位置 JSON 解析拷贝；改错故障 后续修改污染已发出回执。',
      '// INV-07 旧回执不得回滚新配置：守住位置 previous.order 比较；改错故障 刷新后回到旧模型。',
      '// INV-08 损坏偏好可被真实接纳替换：守住位置 内层 catch；改错故障 一次损坏后永久无法写入。',
      '// INV-09 存储不可用返回失败：守住位置 首行存储判断；改错故障 无存储环境直接抛错。',
      '// INV-10 提交在 ACK 后才落盘：守住位置 返回的函数；改错故障 发送失败也改最近偏好。',
      '// INV-11 加速卡提交跳过记录：守住位置 capture 内判断；改错故障 Recent 指向不可解析模型。',
      '// INV-12 输入非法只放弃记录：守住位置 模式与模型校验；改错故障 附带偏好阻断权威发送。',
      '// INV-13 同 Renderer 取最近序号：守住位置 acceptedSequences 比较；改错故障 跨 Pane 迟到 ACK 回写旧偏好。',
      '// INV-14 未接纳候选不推进水位：守住位置 accepted.set 位置；改错故障 失败提交占住序号。',
      '// INV-15 模型与模式一起保存：守住位置 recent 对象；改错故障 首发迁移 Root 后丢失权限。',
      '// INV-16 Registry 未到不判失效：守住位置 无视图分支；改错故障 启动期草稿被清空。',
      '// INV-17 失效档位只清档位：守住位置 reasoningLevel 判断；改错故障 整条模型选择被丢弃。',
      '// INV-18 不直接读全局存储：守住位置 browserStorage 兜底；改错故障 测试无法注入存储。',
      '//',
      '// 模块职责：编辑器最近提交的模型与模式偏好存取。',
      '// 状态所有权：回执序号与已接纳水位为模块级；偏好数据归浏览器存储。',
      '// 阅读顺序：先看键与回执，再读读取自愈，最后看提交捕获与草稿解析。',
    ],
    blocks: [
      {
        anchor: 'const COMPOSER_RECENT_KEY_PREFIX = "zcode-model-selection-recent-v1";',
        lines: [
          '存储键沿用旧前缀。',
          '版本后缀区分代际。',
          '作用域键优先于工作区键。',
          '空身份回退工作区路径。',
          '迁移时不改已有键名。',
          '该常量不随语言变化。',
        ],
      },
      {
        anchor: 'export function captureComposerRecentSubmission(',
        lines: [
          '捕获提交时先生成序号。',
          '加速卡提交直接跳过。',
          '输入非法只放弃记录。',
          '返回函数只在 ACK 后调用。',
          '同一存储按序号取最近。',
          '未接纳候选不推进水位。',
        ],
      },
      {
        anchor: 'export function readComposerRecent(',
        lines: [
          '无存储直接返回空。',
          '两个叶子独立校验。',
          '坏模型不连带丢模式。',
          '加速 Provider 按叶子丢弃。',
          '两叶子都空才算无记录。',
          '解析失败一律返回空。',
        ],
      },
      {
        anchor: 'export function resolveDraftInitialModelSelection(',
        lines: [
          'Registry 未到时保留原意图。',
          '模型不存在才判失效。',
          '档位失效只清档位。',
          '偏好选择需在视图内。',
          '返回值带失效标记。',
          '该函数不写存储。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/lib/fileDisplayHelpers.ts',
    first: null,
    firstNth: 1,
    target: 45,
    header: [
      '// INV-01 默认图标名固定：守住位置 DEFAULT_FILE_ICON_NAME；改错故障 未知扩展名没有图标。',
      '// INV-02 调色板缺项回退文档色：守住位置 getIconPalette 兜底；改错故障 图标透明不可见。',
      '// INV-03 调色板只含前景与背景：守住位置 ICON_COLOR_MAP 值类型；改错故障 深色主题对比度不足。',
      '// INV-04 文件名别名优先于扩展名：守住位置 两轮查找顺序；改错故障 .gitignore 显示成普通文档。',
      '// INV-05 别名键统一小写：守住位置 normalizedLeaf；改错故障 大小写不同命中失败。',
      '// INV-06 多段文件名逐段回退：守住位置 stemCandidate 循环；改错故障 vitest.config.ts 丢失配置语义。',
      '// INV-07 图标匹配大小写不敏感：守住位置 toLowerCase；改错故障 README 与 readme 显示不同图标。',
      '// INV-08 无扩展名回退默认图标：守住位置 lastDot 判断；改错故障 Makefile 显示空图标。',
      '// INV-09 扩展名别名集中一处：守住位置 EXTENSION_ICON_ALIASES；改错故障 同一类型出现两套图标。',
      '// INV-10 Office 扩展名显式收敛：守住位置 doc 与 docx；改错故障 Word 文件图标错位。',
      '// INV-11 未列扩展名原样返回：守住位置 末尾兜底；改错故障 未知类型被强转文档图标。',
      '// INV-12 尾点文件名不进入映射：守住位置 尾点切片；改错故障 空扩展名命中异常分支。',
      '// INV-13 路径分隔符统一为正斜杠：守住位置 normalizePath；改错故障 Windows 路径取不到叶名。',
      '// INV-14 末尾分隔符可裁掉：守住位置 trimTrailingSeparator；改错故障 目录路径多出空段。',
      '// INV-15 图标缩写最多三字符：守住位置 slice 与 toUpperCase；改错故障 标签撑破徽章。',
      '// INV-16 文档与目录用固定缩写：守住位置 两个分支；改错故障 徽章显示扩展名残片。',
      '// INV-17 内联 SVG 走统一编码：守住位置 buildInlineSvgDataUrl；改错故障 图标在 data URL 中破图。',
      '// INV-18 本文件不含 JSX：守住位置 纯工具模块；改错故障 组件与工具形成循环依赖。',
      '//',
      '// 模块职责：文件图标的名称解析、配色与缩写标签。',
      '// 状态所有权：无状态；全部为只读常量表与纯函数。',
      '// 阅读顺序：先看别名表，再读图标解析，最后看配色与标签。',
    ],
    blocks: [
      {
        anchor: 'const ICON_COLOR_MAP: Record<string, { accent: string; background: string }> = {',
        lines: [
          '每个图标一组前景与背景。',
          '颜色以十六进制写死。',
          '缺项由调用方回退文档色。',
          '新增图标需同步补两色。',
          '颜色不随主题反转。',
          '该表只供参考展示。',
        ],
      },
      {
        anchor: 'const FILE_NAME_ICON_ALIASES: Record<string, string> = {',
        lines: [
          '键统一为小写。',
          '覆盖常见点文件名。',
          '锁文件共用同一图标。',
          '别名值指向调色板键。',
          '新增别名需与调色板对齐。',
          '该表只匹配文件名。',
        ],
      },
      {
        anchor: 'export function resolveIconName(filePath: string): string {',
        lines: [
          '先取路径叶名并小写。',
          '文件名别名优先匹配。',
          '多段文件名逐段回退。',
          '无扩展名直接回退默认图标。',
          '扩展名别名最后兜底。',
          '未收录扩展名原样返回。',
        ],
      },
      {
        anchor: 'export function getIconLabel(iconName: string): string {',
        lines: [
          '文档固定三字缩写。',
          '目录固定三字缩写。',
          '其余取首词前三字符。',
          '分隔符统一为空格。',
          '结果统一大写。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/lib/workspaceFileDrag.ts',
    first: 'import { buildFileMentionMarkdown } from "@/mentions/mentionMarkdown.js";',
    target: 45,
    header: [
      '// INV-01 拖拽 MIME 固定：守住位置 WORKSPACE_FILE_DRAG_MIME；改错故障 与外部文件拖拽混淆。',
      '// INV-02 两类自定义事件名固定：守住位置 两个事件常量；改错故障 监听方收不到事件。',
      '// INV-03 载荷只认文件与目录：守住位置 type 判断；改错故障 其它类型混入提及。',
      '// INV-04 五个必填字段全为字符串：守住位置 联合校验；改错故障 非字符串进入面板。',
      '// INV-05 可选身份去空白后才保留：守住位置 workspaceIdentity 判断；改错故障 空身份被当有效。',
      '// INV-06 解析失败一律返回空：守住位置 末尾 catch；改错故障 坏数据中断整个拖拽。',
      '// INV-07 读取前先查类型存在：守住位置 hasWorkspaceFileDragPayload；改错故障 取到空串再解析。',
      '// INV-08 拖拽状态跨窗口广播：守住位置 dispatchWorkspaceFileDragState；改错故障 遮罩不消失。',
      '// INV-09 无 window 时静默返回：守住位置 环境判断；改错故障 服务端渲染直接报错。',
      '// INV-10 加入聊天事件可取消：守住位置 cancelable 选项；改错故障 面板无法接管拖放。',
      '// INV-11 返回值表示是否已处理：守住位置 取反 dispatchEvent；改错故障 重复插入同一条提及。',
      '// INV-12 跨工作区回退绝对路径：守住位置 sameWorkspace 三元；改错故障 提及指向不存在的相对路径。',
      '// INV-13 同工作区用相对路径：守住位置 mentionTarget；改错故障 提及文本过长且难读。',
      '// INV-14 身份为空与缺省等价：守住位置 空串归一；改错故障 同工作区被误判跨区。',
      '// INV-15 提及结构只含必要字段：守住位置 data 三键；改错故障 冗余字段进入协议。',
      '// INV-16 Markdown 由统一函数生成：守住位置 buildFileMentionMarkdown；改错故障 提及渲染不一致。',
      '// INV-17 本模块不持有拖拽状态：守住位置 纯函数集合；改错故障 多面板共享脏状态。',
      '// INV-18 事件名集中导出：守住位置 常量导出；改错故障 各处硬编码字符串漂移。',
      '//',
      '// 模块职责：工作区文件拖拽载荷的序列化、解析与提及构造。',
      '// 状态所有权：无状态；拖拽视觉状态由各订阅方自行持有。',
      '// 阅读顺序：先看常量与载荷类型，再读解析与事件，最后看提及构造。',
    ],
    blocks: [
      {
        anchor: 'export function parseWorkspaceFileDragPayload(',
        lines: [
          '空载荷直接返回空。',
          '解析结果必须是对象。',
          '五个必填字段联合校验。',
          '身份去空白后才保留。',
          '多余字段被丢弃。',
          '解析失败返回空。',
        ],
      },
      {
        anchor: 'export function readWorkspaceFileDragPayload(',
        lines: [
          '先确认类型存在。',
          '再读取指定 MIME 数据。',
          '两者都走同一解析函数。',
          '该函数不写回 dataTransfer。',
          '返回空表示不是本应用拖拽。',
          '供放置处理器直接使用。',
        ],
      },
      {
        anchor: 'export function dispatchWorkspaceFileAddToChat(payload: WorkspaceFileDragPayload): boolean {',
        lines: [
          '无 window 时返回未处理。',
          '事件声明为可取消。',
          '载荷原样放入 detail。',
          '被取消视为已处理。',
          '返回值供调用方决定是否继续。',
          '该函数不修改载荷。',
        ],
      },
      {
        anchor: 'export function createWorkspaceFileComposerMention(',
        lines: [
          '先判断是否同一工作区。',
          '同区用相对路径。',
          '跨区回退绝对路径。',
          'Markdown 交由统一函数生成。',
          'data 只保留三个字段。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/project-sidebar/contract.ts',
    first: 'import type { Locale, RemoteTarget, UserInfo } from "@zcode/shared";',
    target: 44,
    header: [
      '// INV-01 侧边栏三种视图固定：守住位置 ProjectSidebarView；改错故障 未知视图渲染空白。',
      '// INV-02 设备行只带展示字段：守住位置 ProjectDevice；改错故障 组件直接依赖服务对象。',
      '// INV-03 设备来源可缺省：守住位置 sourceServerId 可选；改错故障 远端设备被误判本地。',
      '// INV-04 行操作可带图标：守住位置 ProjectRowAction.icon；改错故障 菜单项只剩文字。',
      '// INV-05 行操作可标危险：守住位置 destructive；改错故障 删除与普通操作同色。',
      '// INV-06 可用性只含展示态：守住位置 ProjectAvailability；改错故障 组件缓存服务内部状态。',
      '// INV-07 升级入口不改变项目身份：守住位置 upgradeEntryId 注释；改错故障 升级后项目重复出现。',
      '// INV-08 未解析状态单独标记：守住位置 unresolved；改错故障 远端项目被当成离线。',
      '// INV-09 文件树目标带可选身份：守住位置 SidebarFileTreeTarget；改错故障 同路径跨远端串台。',
      '// INV-10 外部目录请求可标记临时：守住位置 temporaryExternalDirectory；改错故障 临时目录被记忆。',
      '// INV-11 打开请求带自增编号：守住位置 SidebarFileTreeOpenRequest.id；改错故障 连续请求被合并。',
      '// INV-12 侧边栏属性只做导航：守住位置 ProjectSidebarProps 注释；改错故障 侧边栏持有组织状态。',
      '// INV-13 选中任务带预期未读时间：守住位置 expectedUnreadAt；改错故障 未读角标反复回弹。',
      '// INV-14 远端连接返回会话标识：守住位置 onConnectRemote 返回类型；改错故障 调用方无法定位会话。',
      '// INV-15 远端项目选择可取消：守住位置 isCurrent 回调；改错故障 切换后旧请求仍然生效。',
      '// INV-16 主题由外部注入：守住位置 theme 字段；改错故障 组件自行读取系统主题。',
      '// INV-17 桌面平台标志集中传入：守住位置 三个平台字段；改错故障 组件直接探测运行平台。',
      '// INV-18 本文件只声明类型与再导出：守住位置 无运行时实现；改错故障 出现循环依赖。',
      '//',
      '// 模块职责：项目侧边栏的公开类型契约与共享类型再导出。',
      '// 状态所有权：无状态；只声明属性与回调形状。',
      '// 阅读顺序：先看基础类型，再读文件树目标，最后看侧边栏属性。',
    ],
    blocks: [
      {
        anchor: 'export interface ProjectDevice {',
        lines: [
          '设备标识参与选择。',
          '标签用于界面展示。',
          '状态为展示字符串。',
          '来源服务可缺省。',
          '该类型不承载连接状态。',
          '新增字段保持可选。',
        ],
      },
      {
        anchor: 'export interface ProjectAvailability {',
        lines: [
          '入口标识用于定位。',
          '升级入口只替换排序键。',
          '在线与未解析分列。',
          '注释说明不改变身份。',
          '缺省表示本地可用。',
          '该类型只供渲染判断。',
        ],
      },
      {
        anchor: 'export interface SidebarFileTreeTarget {',
        lines: [
          '工作区路径必填。',
          '身份与远端会话可选。',
          '定位路径可指定。',
          '临时外部目录可标记。',
          '该类型不包含打开状态。',
        ],
      },
      {
        anchor: 'export interface ProjectSidebarProps {',
        lines: [
          '属性只做导航与展示。',
          '组织状态留在服务层。',
          '回调可返回 Promise。',
          '平台能力由布尔传入。',
          '新增属性保持可选。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/project-sidebar/grouped/virtualized-top-level-list.tsx',
    first: 'import type { ZCodeGroupedTaskViewNode } from "@/project-sidebar/grouped/types.js";',
    target: 50,
    header: [
      '// INV-01 未超阈值不启用虚拟化：守住位置 shouldVirtualizeGroupedTopLevelNodes；改错故障 小列表多一层绝对定位。',
      '// INV-02 阈值固定八十：守住位置 虚拟化阈值常量；改错故障 滚动切换点随数据漂移。',
      '// INV-03 任务行估算三十二像素：守住位置 任务行常量；改错故障 滚动高度持续跳动。',
      '// INV-04 分组头估算四十像素：守住位置 分组头常量；改错故障 折叠后出现大块空白。',
      '// INV-05 展开分组按封顶任务数估算：守住位置 Math.min；改错故障 超大分组撑爆滚动高度。',
      '// INV-06 缺失节点给出稳定键：守住位置 getTopLevelNodeKey 首支；改错故障 复用错误行状态。',
      '// INV-07 分组与任务键前缀不同：守住位置 三元拼接；改错故障 分组与任务键冲突。',
      '// INV-08 只认当前已可滚祖先：守住位置 isPotentialVerticalScrollContainer；改错故障 过渡帧丢失滚动元素。',
      '// INV-09 找不到滚动容器回退零边距：守住位置 setScrollMargin(0)；改错故障 列表整体偏移。',
      '// INV-10 边距含列表相对位置：守住位置 resolveScrollMargin；改错故障 虚拟行与真实行错位。',
      '// INV-11 布局副作用在绘制前完成：守住位置 useLayoutEffect；改错故障 首帧位置闪烁。',
      '// INV-12 容器尺寸变化重新测量：守住位置 ResizeObserver；改错故障 折叠后高度不更新。',
      '// INV-13 窗口尺寸变化也重测：守住位置 resize 监听；改错故障 缩放窗口后行错位。',
      '// INV-14 副作用全部可清理：守住位置 返回的清理函数；改错故障 监听与观察器泄漏。',
      '// INV-15 初始偏移从 DOM 反查：守住位置 resolveInitialScrollOffset；改错故障 首次绑定即回顶。',
      '// INV-16 共享滚动器用自定义位移：守住位置 scrollToFn；改错故障 与外层滚动竞争。',
      '// INV-17 虚拟行只渲染窗口附近：守住位置 renderedVirtualNodes；改错故障 两千行全量挂载。',
      '// INV-18 禁用子树滚动锚点：守住位置 overflowAnchor 注释；改错故障 滚动中突然回顶。',
      '//',
      '// 模块职责：分组任务视图顶层节点的轻量虚拟化列表。',
      '// 状态所有权：滚动元素与边距为本组件局部状态；节点数据由外部传入。',
      '// 阅读顺序：先看阈值与估算，再读滚动容器探测，最后看虚拟器与渲染。',
    ],
    blocks: [
      {
        anchor: 'const GROUPED_TOP_LEVEL_VIRTUALIZATION_THRESHOLD = 80;',
        lines: [
          '超过八十才启用虚拟化。',
          '任务行与分组头分别估算。',
          '阈值只影响渲染方式。',
          '估算值不参与业务计算。',
          '该常量不随语言变化。',
          '小列表保持原生渲染。',
        ],
      },
      {
        anchor: 'function findNearestScrollableAncestor(element: HTMLElement): HTMLElement | null {',
        lines: [
          '从父元素逐级向上找。',
          '只认可纵向滚动的祖先。',
          '注释解释过渡帧场景。',
          '找不到返回空。',
          '该函数只读样式。',
          '不修改任何元素。',
        ],
      },
      {
        anchor: 'function estimateTopLevelNodeSize(',
        lines: [
          '任务行高度固定估算。',
          '分组头高度固定估算。',
          '展开分组按封顶任务数。',
          '折叠分组只算头部。',
          '缺失节点按任务估算。',
          '估算误差由实测修正。',
        ],
      },
      {
        anchor: 'function VirtualizedGroupedTopLevelList({',
        lines: [
          '列表引用用于探测滚动容器。',
          '阈值决定是否虚拟化。',
          '键与高度回调按节点缓存。',
          '边距随布局变化更新。',
          '虚拟器只在启用时计数。',
          '初始偏移从现场反查。',
        ],
      },
      {
        anchor: 'const rowVirtualizer = useVirtualizer({',
        lines: [
          '计数为零时等价关闭。',
          '滚动元素可为空等待绑定。',
          '共享滚动器用自定义位移函数。',
          '初始偏移不默认归零。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/root/RootWorkspaceContent.tsx',
    first: 'import { memo, useEffect } from "react";',
    target: 67,
    header: [
      '// INV-01 工作区壳层常驻挂载：守住位置 壳层外层容器；改错故障 关闭设置时整树重挂载。',
      '// INV-02 设置页以覆盖层出现：守住位置 条件渲染的设置层；改错故障 主界面被整体替换。',
      '// INV-03 切层用透明度不拆树：守住位置 透明类名分支；改错故障 侧边栏可见性闪烁。',
      '// INV-04 保留布局占位：守住位置 pointer-events-none；改错故障 菜单锚点丢失定位。',
      '// INV-05 不用隐藏类收起底层：守住位置 类名与注释；改错故障 quickpick 继承 display none。',
      '// INV-06 设置期间标记 inert：守住位置 inert 属性；改错故障 底层卡片抢走表单焦点。',
      '// INV-07 设置期禁用遥测前台：守住位置 foregroundEnabled；改错故障 设置页仍计前台活跃。',
      '// INV-08 工作区键优先身份：守住位置 workspaceKey 三元；改错故障 同路径跨远端不重置边界。',
      '// INV-09 边界重置键含设置状态：守住位置 设置层 resetKeys；改错故障 设置层报错后无法恢复。',
      '// INV-10 App 实例稳定化：守住位置 memo 包裹；改错故障 每次渲染重建子树。',
      '// INV-11 工作区服务由上层注入：守住位置 ServiceProvider；改错故障 组件自建第二份服务。',
      '// INV-12 设置层单独错误边界：守住位置 第二个 ScopedErrorBoundary；改错故障 设置崩溃带崩主界面。',
      '// INV-13 回流设置时同步记录：守住位置 可见性日志 effect；改错故障 无法定位切层抖动。',
      '// INV-14 注销与登录透传：守住位置 两个账号回调；改错故障 设置页无法切换账号。',
      '// INV-15 活跃路径存在才可返回：守住位置 onBack 三元；改错故障 无工作区时返回空白页。',
      '// INV-16 窗口控制内边距透传：守住位置 右侧内边距属性；改错故障 标题栏与按钮重叠。',
      '// INV-17 桌面能力以布尔下传：守住位置 三个平台字段；改错故障 分支行为不一致。',
      '// INV-18 本组件不持有业务状态：守住位置 仅一个日志 effect；改错故障 工作区状态出现第二份。',
      '//',
      '// 模块职责：工作区壳层与设置页覆盖层的组合根。',
      '// 状态所有权：无业务状态；工作区状态归 App 与各 store。',
      '// 阅读顺序：先看属性入口，再读壳层挂载策略，最后看设置层覆盖。',
    ],
    blocks: [
      {
        anchor: 'const StableWorkspaceApp = memo(App);',
        lines: [
          'App 实例做稳定化。',
          '属性变化仍会正常重渲。',
          '避免切层重建子树。',
          '该常量不持有状态。',
          '稳定化不改变行为。',
          '仅在模块加载时求值。',
        ],
      },
      {
        anchor: 'interface RootWorkspaceContentProps {',
        lines: [
          '属性全部由上层注入。',
          '服务与回调分组排列。',
          '平台能力用布尔传入。',
          '远端会话数据可缺省。',
          '新增属性保持可选。',
          '该接口只描述形状。',
        ],
      },
      {
        anchor: 'export function RootWorkspaceContent({',
        lines: [
          '解构即属性全量。',
          '不在此处构造服务。',
          '工作区键由身份优先。',
          '壳层始终挂载。',
          '设置页作为覆盖层。',
          '返回只有一层目录提供者。',
        ],
      },
      {
        anchor: 'const workspaceKey = workspaceIdentity?.trim() || workspaceShellPath;',
        lines: [
          '身份去空白后优先。',
          '缺省回退工作区路径。',
          '键用于错误边界重置。',
          '键不参与状态归属。',
          '远程切换会改变键。',
          '该值每次渲染重算。',
        ],
      },
      {
        anchor: 'useEffect(() => {',
        lines: [
          '切到设置页时记录一次。',
          '日志带工作区路径。',
          '该 effect 无业务副作用。',
        ],
      },
      {
        anchor: 'logger.info("[RootWorkspaceContent] settings layer visibility changed", {',
        lines: [
          '日志字段只含可见性。',
          '布局隐藏标志恒为假。',
          '仅依赖设置状态与路径。',
          '输出走统一日志器。',
          '日志不阻塞渲染。',
          '用于定位切层抖动。',
        ],
      },
      {
        anchor: '}, [isSettingsTabActive, workspaceShellPath]);',
        lines: [
          '依赖数组只含两个值。',
          '身份变化不触发该日志。',
          '清理由框架托管。',
          '该 effect 无返回值。',
          '依赖不得省略。',
          '日志失败不影响界面。',
        ],
      },
      {
        anchor: 'return (',
        lines: [
          '壳层始终挂载。',
          '设置期整层透明。',
          '保留布局与菜单锚点。',
          'inert 阻止底层交互。',
          '遥测跟随前台标志。',
          '错误边界按工作区键重置。',
        ],
      },
    ],
  },
];

let index = 0;
for (const spec of specs) {
  const srcLines = fs.readFileSync('D:/code/ZCode/' + spec.file, 'utf8').split('\n');
  const firstAuto = srcLines[0].replace(/\r$/, '').trim();
  const firstAnchor = spec.first ?? firstAuto;
  if (spec.first && firstAnchor !== firstAuto) {
    console.error(`FIRST MISMATCH ${spec.file}\n  spec: ${spec.first}\n  file: ${firstAuto}`);
    process.exit(1);
  }
  const firstItem = { anchor: firstAnchor, raw: spec.header };
  if (spec.firstNth) firstItem.nth = spec.firstNth;
  const items = [firstItem];
  for (const block of spec.blocks) {
    const item = { anchor: block.anchor, lines: block.lines };
    if (block.nth) item.nth = block.nth;
    items.push(item);
  }
  const total = spec.header.length + spec.blocks.reduce((sum, b) => sum + b.lines.length, 0);
  const bodyTotal = spec.blocks.reduce((sum, b) => sum + b.lines.length, 0);
  console.log(`${spec.file} header=${spec.header.length} body=${bodyTotal} total=${total} expect=${spec.target} ${total === spec.target ? 'OK' : 'MISMATCH'}`);
  fs.writeFileSync(
    `ZC-deep-b117-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  index += 1;
}
