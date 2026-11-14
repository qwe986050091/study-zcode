import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/settings/pluginCapabilityProjection.ts',
    first: 'import {',
    firstNth: 1,
    target: 45,
    header: [
      '// INV-01 未物化插件不进设置页：守住位置 packageStatus 过滤；改错故障 出现已装却缺失的矛盾行。',
      '// INV-02 内置组按文档优先级排序：守住位置 compareDocumentPluginPriority；改错故障 内置列表顺序随返回抖动。',
      '// INV-03 内置候选只取未安装：守住位置 selectBuiltInPlugins 双条件；改错故障 已装插件重复出现在内置区。',
      '// INV-04 名称归一化统一小写：守住位置 canonicalPluginName；改错故障 同插件名大小写不同即分组分裂。',
      '// INV-05 名称归一化先去空白：守住位置 trim 调用；改错故障 带空格插件名匹配失败。',
      '// INV-06 需要授权按 URL 判定：守住位置 needsMcpAttention；改错故障 需登录的 MCP 不显示提醒。',
      '// INV-07 空查询返回全部插件：守住位置 filterPluginsByQuery 提前返回；改错故障 初次进入列表为空。',
      '// INV-08 搜索同时匹配双语显示名：守住位置 第二组关键词；改错故障 中文名搜不到英文插件。',
      '// INV-09 市场条目按 id 对齐：守住位置 candidate.id 校验；改错故障 错配条目污染展示名。',
      '// INV-10 作用域不再做归属过滤：守住位置 selectPluginsForScope 原样返回；改错故障 工作区丢失继承插件。',
      '// INV-11 技能跟随插件启用态：守住位置 enabledPlugins 过滤；改错故障 停用插件的技能仍可搜索。',
      '// INV-12 旧协议按名称唯一回退：守住位置 matchingIds 长度判断；改错故障 跨市场同名插件被误纳入。',
      '// INV-13 用户命令按作用域映射：守住位置 isUserCommand 分支；改错故障 用户命令在工作区丢失。',
      '// INV-14 插件命令按市场拼 id：守住位置 名称与市场拼接；改错故障 同名插件命令互相串台。',
      '// INV-15 技能分组保留直属组：守住位置 direct 收集分支；改错故障 非插件技能整组消失。',
      '// INV-16 插件组按标签排序：守住位置 localeCompare；改错故障 顺序随 Map 插入顺序变化。',
      '// INV-17 插件组 id 带固定前缀：守住位置 plugin: 前缀；改错故障 与直属组 id 冲突。',
      '// INV-18 本模块不访问存储：守住位置 纯函数集合；改错故障 与设置状态形成隐式耦合。',
      '//',
      '// 模块职责：设置页插件、技能与命令的作用域投影和分组。',
      '// 状态所有权：无状态；全部为只读入参的纯函数。',
      '// 阅读顺序：先看名称归一与授权判定，再读插件分组，最后看技能与命令投影。',
    ],
    blocks: [
      {
        anchor: 'export function partitionPluginsForSettings(',
        lines: [
          '先剔除未物化插件。',
          '再按内置 id 集合分组。',
          '内置组按文档优先级排序。',
          '已安装组保持入参顺序。',
          '两个分组互斥不重叠。',
          '该函数不改写入参。',
        ],
      },
      {
        anchor: 'export function filterPluginsByQuery(',
        lines: [
          '空查询直接返回副本。',
          '查询归一化为小写。',
          '市场条目按 id 对齐。',
          '名称与描述合并匹配。',
          '双语显示名同时参与。',
          '任一关键词命中即保留。',
        ],
      },
      {
        anchor: 'export function selectSkillsForScope(',
        lines: [
          '先筛出启用插件。',
          '建立 id 与名称两张索引。',
          '非插件技能按作用域过滤。',
          '有插件 id 时只认 id。',
          '无 id 时按名称唯一回退。',
          '重名插件不纳入技能。',
        ],
      },
      {
        anchor: 'export function selectCommandsForScope(',
        lines: [
          '用户命令按作用域映射。',
          '非插件命令一律排除。',
          '有市场时拼完整插件 id。',
          '无市场时按名称唯一匹配。',
          '重名插件命令不被采用。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/settings/ShortcutSettingsSection.tsx',
    first: 'import { useCallback, useEffect, useMemo, useRef, useState } from "react";',
    target: 46,
    header: [
      '// INV-01 单行多绑定按数组存：守住位置 effective 条目为数组；改错故障 一个命令只剩一键可改。',
      '// INV-02 覆盖优先于默认：守住位置 resolveEffectiveShortcutBindings；改错故障 改键后仍显示默认键。',
      '// INV-03 保存必须串行：守住位置 savingRef 判断；改错故障 连点产生乱序写入。',
      '// INV-04 保存态禁用全部入口：守住位置 saving 标志；改错故障 保存期间重复提交。',
      '// INV-05 保存失败可见：守住位置 catch 内置错误态；改错故障 失败后界面无任何反馈。',
      '// INV-06 追加与替换分层：守住位置 两个构建器分别调用；改错故障 多绑定被整组覆盖。',
      '// INV-07 抢绑保留行级语义：守住位置 stealBinding 传入录制模式；改错故障 抢绑删掉同命令其余绑定。',
      '// INV-08 清除与恢复默认不同：守住位置 clearAllBindings 写空数组；改错故障 清除后回落到默认键。',
      '// INV-09 恢复默认遇占用只提示：守住位置 conflict 分支；改错故障 静默清掉他人绑定。',
      '// INV-10 恢复默认删除覆盖条目：守住位置 delete 操作；改错故障 覆盖条目残留成空数组。',
      '// INV-11 全部恢复需二次确认：守住位置 requestConfirmation；改错故障 一键清空所有自定义键位。',
      '// INV-12 录制期键盘独占：守住位置 keyboardExclusive 判断；改错故障 录制组合键先触发原命令。',
      '// INV-13 双通道同时关闭：守住位置 内核标记与菜单摘除；改错故障 macOS 菜单先吃掉按键。',
      '// INV-14 卸载即解除独占：守住位置 effect 清理函数；改错故障 离开设置页后按键失灵。',
      '// INV-15 录制与按键搜索互斥：守住位置 武装前清空录制；改错故障 两套监听互相吞键。',
      '// INV-16 隐藏命令仍参与冲突：守住位置 过滤只影响展示；改错故障 隐藏命令的键位被误判空闲。',
      '// INV-17 搜索按物理等价匹配：守住位置 isSamePhysicalBinding；改错故障 等价组合搜不到。',
      '// INV-18 本组件不实现键位语义：守住位置 全部委托 shortcuts 内核；改错故障 判定口径分叉。',
      '//',
      '// 模块职责：快捷键设置分区，展示命令表并提供录制、冲突与重置入口。',
      '// 状态所有权：覆盖数据归设置服务；录制态与搜索态为本组件局部状态。',
      '// 阅读顺序：先看过滤与保存，再读四种写入语义，最后看键盘独占与渲染。',
    ],
    blocks: [
      {
        anchor: 'const persistBindings = useCallback(',
        lines: [
          '保存前先抢占在途标记。',
          '保存期间禁用所有入口。',
          '每次写入先清空录制态。',
          '失败置错误标志不抛错。',
          '结束后释放在途标记。',
          '权威快照由设置服务回推。',
        ],
      },
      {
        anchor: 'const stealBinding = useCallback(',
        lines: [
          '抢绑复用录制时的模式。',
          '行级替换按下标写入。',
          '未指定下标时按追加处理。',
          '冲突键从占用命令移除。',
          '同命令其余绑定保持不动。',
          '抢绑后立即退出录制。',
        ],
      },
      {
        anchor: 'const requestConfirmation = useConfirmDialogStore((state) => state.requestConfirmation);',
        lines: [
          '仅在存在覆盖时询问。',
          '弹窗声明为破坏性操作。',
          '标题与描述走国际化。',
          '取消时不做任何写入。',
          '确认后写空覆盖表。',
          '该流程不触碰默认键位。',
        ],
      },
      {
        anchor: 'const keyboardExclusive = recording !== null || keySearch.armed;',
        lines: [
          '录制与按键搜索共用独占。',
          '进入独占时置内核标记。',
          '桌面端同时通知主进程。',
          '退出时双向复位。',
          '依赖只含独占标志与平台。',
          '该 effect 无渲染输出。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/settings/AddMarketplaceSourceDialog.tsx',
    first: 'import { useRef, useState, type DragEvent } from "react";',
    target: 43,
    header: [
      '// INV-01 操作按来源去重：守住位置 marketplace:add: 前缀拼接；改错故障 同一来源并发添加两次。',
      '// INV-02 空来源不可提交：守住位置 trimmedSource 判断；改错故障 空字符串被提交到后端。',
      '// INV-03 提交防重入：守住位置 pendingRef；改错故障 回写前重复发起同一请求。',
      '// INV-04 成功才清空并关闭：守住位置 added 分支；改错故障 同一市场源被重复添加。',
      '// INV-05 失败保留输入与弹层：守住位置 无 else 分支；改错故障 用户需重输整段地址。',
      '// INV-06 拖放仅桌面可用：守住位置 canPickPath；改错故障 Web 端拖入文件无响应。',
      '// INV-07 目录选择仅桌面可用：守住位置 按钮条件渲染；改错故障 Web 端点击无反应。',
      '// INV-08 拖入只取首个文件：守住位置 files 下标访问；改错故障 多文件拖入行为不确定。',
      '// INV-09 取不到路径则忽略：守住位置 path 判断；改错故障 空路径覆盖已有输入。',
      '// INV-10 拖离按容器判断：守住位置 contains 检查；改错故障 拖过子元素就丢高亮。',
      '// INV-11 输入法组合态不提交：守住位置 isImeComposingKeyEvent；改错故障 候选确认误触发添加。',
      '// INV-12 组合态用 ref 兜底：守住位置 compositionActiveRef；改错故障 组合标志提前翻假时误提交。',
      '// INV-13 仅 Enter 触发提交：守住位置 键值判断；改错故障 任意按键都尝试添加。',
      '// INV-14 提交前阻止默认行为：守住位置 preventDefault；改错故障 弹窗重复响应提交。',
      '// INV-15 错误提示可滚动：守住位置 错误块高度与溢出；改错故障 长错误撑破弹窗。',
      '// INV-16 弹窗宽度有上限：守住位置 min 宽度表达式；改错故障 窄屏横向溢出。',
      '// INV-17 添加中禁用提交：守住位置 adding 判断；改错故障 添加过程中可再次点击。',
      '// INV-18 本组件不发请求：守住位置 回调注入；改错故障 组件直接依赖数据层。',
      '//',
      '// 模块职责：添加插件市场源弹窗，支持地址输入、拖放与目录选择。',
      '// 状态所有权：输入、拖拽高亮与组合态为本组件局部；添加进度来自外部操作表。',
      '// 阅读顺序：先看三个入口处理器，再读提交防重入，最后看弹窗结构与按钮。',
    ],
    blocks: [
      {
        anchor: 'const handleAdd = async () => {',
        lines: [
          '空来源直接返回。',
          '已有提交在途时返回。',
          '进入即占用防重入标记。',
          '成功才清空输入。',
          '成功才关闭弹窗。',
          '无论成败都释放标记。',
        ],
      },
      {
        anchor: 'const handleChooseDirectory = async () => {',
        lines: [
          '无平台能力直接返回。',
          '选择结果为空则保留原值。',
          '取消与异常都被吞掉。',
          '不额外弹出错误提示。',
          '该入口不改弹层状态。',
        ],
      },
      {
        anchor: 'const handleDrop = (event: DragEvent<HTMLDivElement>) => {',
        lines: [
          '先阻止默认打开行为。',
          '落下即取消拖拽高亮。',
          '只取第一个文件。',
          '路径为空则忽略。',
          '取到路径才覆盖输入。',
        ],
      },
      {
        anchor: 'return (',
        lines: [
          '弹窗受控于外部开关。',
          '拖放能力按平台开关。',
          '输入框自动聚焦。',
          '桌面端才显示目录按钮。',
          '提交按钮展示加载态。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/settings/SettingsResourceHeaderActions.tsx',
    first: 'import {',
    firstNth: 1,
    target: 43,
    header: [
      '// INV-01 导入导出归入更多菜单：守住位置 hasOverflowActions；改错故障 顶栏按钮过多挤压标题。',
      '// INV-02 无导入导出不渲染菜单：守住位置 条件渲染；改错故障 出现空菜单按钮。',
      '// INV-03 刷新按钮可选：守住位置 onRefresh 判断；改错故障 不支持刷新页面出现无效按钮。',
      '// INV-04 刷新中展示加载图标：守住位置 refreshing 三元；改错故障 刷新中图标不变。',
      '// INV-05 刷新中禁用按钮：守住位置 disabled 组合；改错故障 刷新中重复触发请求。',
      '// INV-06 新建按钮可选：守住位置 onNew 判断；改错故障 无新建能力页面出现按钮。',
      '// INV-07 新建禁用独立传入：守住位置 newDisabled；改错故障 权限不足仍可点击。',
      '// INV-08 标签可被外部覆盖：守住位置 两个可选标签属性；改错故障 业务文案无法定制。',
      '// INV-09 标签缺省走国际化：守住位置 空值合并；改错故障 按钮出现空文本。',
      '// INV-10 图标对读屏隐藏：守住位置 aria-hidden；改错故障 读屏重复朗读图形名。',
      '// INV-11 按钮有可访问名称：守住位置 aria-label；改错故障 纯图标按钮无法识别。',
      '// INV-12 测试 id 由调用方注入：守住位置 两个测试 id 属性；改错故障 端到端选择器漂移。',
      '// INV-13 操作 id 由调用方注入：守住位置 三个 data 属性；改错故障 埋点无法区分入口。',
      '// INV-14 菜单右对齐：守住位置 align 属性；改错故障 菜单超出视口被裁剪。',
      '// INV-15 菜单触发只含图标：守住位置 MoreHorizontal；改错故障 顶栏宽度抖动。',
      '// INV-16 操作项按条件渲染：守住位置 两个回调判断；改错故障 出现无回调的禁用项。',
      '// INV-17 本组件不持有状态：守住位置 纯受控属性；改错故障 与设置页状态不同步。',
      '// INV-18 本组件不发请求：守住位置 回调注入；改错故障 组件直接耦合数据层。',
      '//',
      '// 模块职责：设置页资源头部操作区，统一刷新、导入导出与新建入口。',
      '// 状态所有权：无状态；刷新中与禁用态均由调用方传入。',
      '// 阅读顺序：先看属性默认值，再读标签解析，最后看三段按钮渲染。',
    ],
    blocks: [
      {
        anchor: 'const resolvedRefreshLabel = refreshLabel ?? intl.formatMessage({ id: "common.refresh" });',
        lines: [
          '外部标签优先于默认值。',
          '导入导出标签固定取字典。',
          '更多操作标签供读屏使用。',
          '新建标签同样可被覆盖。',
          '所有标签在渲染前解析。',
          '缺省值不回退硬编码。',
        ],
      },
      {
        anchor: 'const hasOverflowActions = Boolean(onImport || onExport);',
        lines: [
          '任一回调存在即显示菜单。',
          '两个回调都缺省时隐藏。',
          '菜单承载次要操作。',
          '主操作保留在顶栏。',
          '该判断只影响渲染。',
        ],
      },
      {
        anchor: 'const importLabel = intl.formatMessage({',
        lines: [
          '导入文案取自资源操作字典。',
          '导出文案与导入同组。',
          '文案不拼接动态参数。',
          '每次渲染重新解析。',
          '不缓存到模块级。',
        ],
      },
      {
        anchor: 'const newLabel = customNewLabel ?? intl.formatMessage({ id: "settings.create.action" });',
        lines: [
          '新建标签优先用外部值。',
          '缺省取通用创建文案。',
          '可访问名称与可见文本同源。',
          '该值每次渲染重算。',
          '空串视为有效覆盖。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/settings/usage-stats/usageStatsUiParts.tsx',
    first: 'import type { AppUsageRange } from "@zcode/shared";',
    target: 43,
    header: [
      '// INV-01 范围选项只有两档：守住位置 RANGE_OPTIONS；改错故障 后端不支持的区间被请求。',
      '// INV-02 标签栏样式集中导出：守住位置 两个类名常量；改错故障 多处标签样式漂移。',
      '// INV-03 非有限数显示占位：守住位置 Number.isFinite 判断；改错故障 非数值直接渲染。',
      '// INV-04 千位以上走紧凑格式：守住位置 notation 三元；改错故障 大数字撑破卡片。',
      '// INV-05 紧凑格式最多一位小数：守住位置 maximumFractionDigits；改错故障 数值宽度抖动。',
      '// INV-06 Token 格式统一入口：守住位置 formatCompactTokenUsage；改错故障 各处写法不一致。',
      '// INV-07 中文摘要保留单位间距：守住位置 零宽断言替换；改错故障 数字与单位粘连。',
      '// INV-08 百分比精度按量级切换：守住位置 阈值比较；改错故障 小比例显示成整数零。',
      '// INV-09 缺日期显示占位：守住位置 空值判断；改错故障 空日期渲染成非法值。',
      '// INV-10 非法日期原样返回：守住位置 时间戳判断；改错故障 图表因格式化异常崩溃。',
      '// INV-11 日期按 UTC 解析：守住位置 拼接零点后缀；改错故障 时区偏移导致日期错一天。',
      '// INV-12 横轴只取短月名：守住位置 month short；改错故障 标签过长互相遮挡。',
      '// INV-13 未知模型回退文案：守住位置 resolveModelLabel 兜底；改错故障 卡片标题为空。',
      '// INV-14 指标卡尺寸可调：守住位置 valueSize 映射；改错故障 不同卡片字号不一致。',
      '// INV-15 辅助文案可内联或下置：守住位置 helperPlacement；改错故障 两种布局互相覆盖。',
      '// INV-16 图标类型沿用图标库：守住位置 icon 属性类型；改错故障 传入非图标组件导致崩溃。',
      '// INV-17 空态只做展示：守住位置 UsageEmptyState；改错故障 空态混入业务逻辑。',
      '// INV-18 本文件不含数据请求：守住位置 纯格式化与展示；改错故障 展示层直接拉取接口。',
      '//',
      '// 模块职责：使用统计页的数值格式化、指标卡与空态展示部件。',
      '// 状态所有权：无状态；数值与文案全部由调用方传入。',
      '// 阅读顺序：先看三个导出常量，再读数值与日期格式化，最后看两个展示组件。',
    ],
    blocks: [
      {
        anchor: 'export function formatCompactNumber(locale: string, value: number): string {',
        lines: [
          '非有限数直接返回占位。',
          '千位以下用标准格式。',
          '千位以上用紧凑单位。',
          '小数位随量级切换。',
          '地区决定分隔符号。',
          '该函数不缓存结果。',
        ],
      },
      {
        anchor: 'export function formatSummaryCompactTokenUsage(locale: string, value: number): string {',
        lines: [
          '先走通用 token 格式。',
          '中文在数字与单位间补空格。',
          '其它语言原样返回。',
          '断言只匹配数字边界。',
          '该规则只用于摘要卡片。',
        ],
      },
      {
        anchor: 'export function formatDay(locale: string, dateKey: string | null): string {',
        lines: [
          '空日期返回占位。',
          '以 UTC 零点解析。',
          '非法日期原样返回。',
          '合法日期按短月日展示。',
          '时区固定为 UTC。',
        ],
      },
      {
        anchor: 'export function UsageMetricCard({',
        lines: [
          '图标由调用方传入。',
          '数值尺寸四档可选。',
          '内联模式与数值同一行。',
          '下置模式在数值之后。',
          '辅助文案可为空。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/project-sidebar/ProjectNode.tsx',
    first: 'import { useContext, useEffect, useMemo, useRef, useState } from "react";',
    target: 43,
    header: [
      '// INV-01 在线才可编辑：守住位置 editable 组合；改错故障 离线节点仍可接收会话拖入。',
      '// INV-02 单根旧项目禁拖入：守住位置 legacySingleRoot；改错故障 旧协议项目出现无效放置目标。',
      '// INV-03 拖入用深度计数：守住位置 dragDepth；改错故障 子元素切换导致高亮闪烁。',
      '// INV-04 深度归零才复位：守住位置 归零判断；改错故障 拖过子节点就丢高亮。',
      '// INV-05 拖出与松手都清理：守住位置 两个文档监听；改错故障 高亮残留不消失。',
      '// INV-06 监听走捕获阶段：守住位置 第三参数为真；改错故障 子组件阻止冒泡后收不到事件。',
      '// INV-07 目录失效不折叠：守住位置 isOpen 组合；改错故障 主目录缺失时历史消息不可见。',
      '// INV-08 手机远端禁用排序：守住位置 isWebRemoteControl；改错故障 滑动列表误触发拖动。',
      '// INV-09 拖拽数据只含稳定字段：守住位置 useMemo 两键；改错故障 数据变化引发重排抖动。',
      '// INV-10 落点由同一状态推导：守住位置 dropPosition 计算；改错故障 提示位置与提交目标分叉。',
      '// INV-11 落点仅在非拖动时显示：守住位置 isDragging 取反；改错故障 被拖动项自身出现插入线。',
      '// INV-12 只与同置顶状态比较：守住位置 pinned 相等判断；改错故障 置顶与普通项互相插入。',
      '// INV-13 缩放被显式还原：守住位置 两个缩放分量；改错故障 高度不一时活动项被拉伸。',
      '// INV-14 层级按状态提升：守住位置 zIndex 三元；改错故障 插入线被相邻项遮挡。',
      '// INV-15 放置只认会话载荷：守住位置 载荷解析函数；改错故障 普通文件拖入触发移动。',
      '// INV-16 放置效果标记为移动：守住位置 dropEffect；改错故障 光标显示复制语义。',
      '// INV-17 远端身份只对单根生成：守住位置 主机与根数判断；改错故障 本地项目被写入远端身份。',
      '// INV-18 本组件不持有排序结果：守住位置 全部交给排序库；改错故障 拖动结束状态与列表不一致。',
      '//',
      '// 模块职责：侧边栏单个项目节点，组合排序、折叠与会话拖入放置。',
      '// 状态所有权：拖入高亮与深度为局部状态；排序与折叠状态由外部持有。',
      '// 阅读顺序：先看可编辑判定，再读拖入监听与落点推导，最后看节点渲染。',
    ],
    blocks: [
      {
        anchor: 'const canOpen = online;',
        lines: [
          '在线才允许展开。',
          '目录失效不改变可展开性。',
          '实际展开再与折叠状态取与。',
          '折叠回调仅在可展开时生效。',
          '历史消息由独立存储读取。',
          '该判断不影响拖入能力。',
        ],
      },
      {
        anchor: 'const dropPosition =',
        lines: [
          '仅悬停且非拖动时计算。',
          '活动项必须可排序。',
          '置顶状态必须一致。',
          '下标靠前显示在上方。',
          '其余情况不显示插入线。',
        ],
      },
      {
        anchor: 'document.addEventListener("dragend", clear, true);',
        lines: [
          '捕获阶段监听拖拽结束。',
          '捕获阶段监听放置事件。',
          '任意位置松手都清理。',
          '清理同时复位深度与高亮。',
          '卸载时移除两个监听。',
        ],
      },
      {
        anchor: 'const data = useMemo(',
        lines: [
          '只放主机与置顶两个键。',
          '依赖数组与键一一对应。',
          '稳定引用避免排序抖动。',
          '该数据随排序句柄提交。',
          '不放入频繁变化的对象。',
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
    `ZC-deep-b118-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  index += 1;
}
