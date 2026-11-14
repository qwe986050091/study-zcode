import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/components/ui/highlighted-lightweight-diff-preview.tsx',
    first: 'import { useEffect, useMemo, useState, type HTMLAttributes } from "react";',
    target: 45,
    header: [
      '// INV-01 超长文本不再高亮：守住位置 字符数上限；改错故障 大 diff 阻塞主线程。',
      '// INV-02 上限按字符数计：守住位置 常量 120000；改错故障 按行数判断漏掉超长单行。',
      '// INV-03 空文本直接跳过高亮：守住位置 effect 首段；改错故障 空串进入 highlighter。',
      '// INV-04 入参变化先清空旧结果：守住位置 effect 首行；改错故障 新文件短暂显示旧颜色。',
      '// INV-05 语言不支持仍走回调：守住位置 shouldUseSyntaxHighlighting；改错故障 纯文本高亮卡死。',
      '// INV-06 取消标志阻止迟到写入：守住位置 cancelled；改错故障 卸载后仍 setState。',
      '// INV-07 同步结果立即写入：守住位置 tokenized 判断；改错故障 首帧无颜色。',
      '// INV-08 清理只置取消位：守住位置 effect 返回函数；改错故障 清理阶段触发额外渲染。',
      '// INV-09 无令牌时返回空：守住位置 render 首段；改错故障 空数组渲染出空片段。',
      '// INV-10 令牌片段带色输出：守住位置 style 构造；改错故障 高亮颜色丢失。',
      '// INV-11 片段键含序号与内容：守住位置 key 拼接；改错故障 重复内容导致 React 警告。',
      '// INV-12 缺色时继承外层颜色：守住位置 条件 style；改错故障 令牌被强制黑色。',
      '// INV-13 高亮文本按行拼接：守住位置 build 函数；改错故障 行号与令牌错位。',
      '// INV-14 行内容仍用原行：守住位置 renderLineContent；改错故障 标记符号被高亮吞掉。',
      '// INV-15 高亮状态写入数据属性：守住位置 data 属性；改错故障 测试无法区分回退态。',
      '// INV-16 其余属性透传底层组件：守住位置 展开 props；改错故障 外层事件与样式丢失。',
      '// INV-17 设置项只取三项：守住位置 类型 Pick；改错故障 无关设置触发重渲。',
      '// INV-18 本组件不持有全局状态：守住位置 仅 useState 令牌；改错故障 多实例共享高亮结果。',
      '//',
      '// 模块职责：带语法高亮的轻量 diff 预览容器。',
      '// 状态所有权：令牌结果为本组件局部状态；高亮器由 lib 层持有缓存。',
      '// 阅读顺序：先看行拆分，再读高亮 hook，最后看渲染与属性透传。',
    ],
    blocks: [
      {
        anchor: 'const HIGHLIGHTED_LIGHTWEIGHT_DIFF_MAX_CHARS = 120_000;',
        lines: [
          '超长文本不再高亮。',
          '上限按字符数计。',
          '只在渲染时判断。',
          '超过后回退纯文本。',
          '常量不随主题变化。',
          '该阈值是性能护栏。',
        ],
      },
      {
        anchor: 'function useHighlightedLightweightDiffTokens({',
        lines: [
          '入参变化先清空旧结果。',
          '空文本与超长文本直接返回。',
          '语言不支持时仍走回调。',
          '取消标志阻止迟到写入。',
          '同步结果立即写入。',
          '清理函数只置取消位。',
        ],
      },
      {
        anchor: 'function renderHighlightedLightweightDiffTokens(tokens: readonly ThemedToken[] | undefined) {',
        lines: [
          '无令牌时返回空。',
          '逐令牌生成带色片段。',
          '键由序号与内容组成。',
          '缺色时继承外层颜色。',
          '片段内容原样输出。',
          '不合并相邻同色片段。',
        ],
      },
      {
        anchor: 'export function HighlightedLightweightDiffPreview({',
        lines: [
          '先拼出高亮用代码文本。',
          '行内容仍由原行提供。',
          '高亮结果按行切分。',
          '状态写入数据属性供测试。',
          '其余属性透传到底层组件。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/components/workflow-timeline/WorkflowTimelineLedge.tsx',
    first: 'import {',
    target: 46,
    header: [
      '// INV-01 留白灯优先于状态灯：守住位置 stationLampClass 首支；改错故障 等待留白显示成运行灯。',
      '// INV-02 已补全留白回到普通灯：守住位置 state 判断；改错故障 补全后仍是虚线。',
      '// INV-03 等待留白用警示描边：守住位置 warning 分支；改错故障 等待态不可辨。',
      '// INV-04 其余留白用最浅描边：守住位置 默认分支；改错故障 留白比实体更抢眼。',
      '// INV-05 运行灯带呼吸光晕：守住位置 wf-lamp-running；改错故障 画面失去唯一动效焦点。',
      '// INV-06 减少动效时关闭呼吸：守住位置 motion-reduce；改错故障 前庭敏感用户被迫看动画。',
      '// INV-07 双线段用于并行两站：守住位置 Segment 首支；改错故障 并行被画成单线。',
      '// INV-08 两条线相距两像素：守住位置 top 偏移；改错故障 双线黏成一条。',
      '// INV-09 单线段缺轨道时隐藏：守住位置 invisible 分支；改错故障 空段出现接缝。',
      '// INV-10 线宽固定一像素：守住位置 border-t；改错故障 檐与主轨粗细不一致。',
      '// INV-11 墨色随轨道数据变化：守住位置 data-ledge-ink；改错故障 分叉与汇合无法区分。',
      '// INV-12 空索引直接不渲染：守住位置 首行返回；改错故障 空檐占位。',
      '// INV-13 超过五枚折叠为加号：守住位置 ledgeLamps；改错故障 檐被灯挤爆。',
      '// INV-14 靠内容一侧接短轨道：守住位置 stub 三元；改错故障 檐与内容断开。',
      '// INV-15 每枚灯是可点按钮：守住位置 button 元素；改错故障 键盘无法回到折叠站。',
      '// INV-16 标签含站名与状态：守住位置 aria-label；改错故障 读屏只剩编号。',
      '// INV-17 左右两侧镜像排列：守住位置 末尾三元；改错故障 加号与短轨位置颠倒。',
      '// INV-18 滚动条点击到此终止：守住位置 stopClick；改错故障 拖拇指折叠宿主卡片。',
      '//',
      '// 模块职责：时间线边檐灯带与底部滚动条。',
      '// 状态所有权：拖动状态与指针标识为滚动条局部状态；视口数据由外部传入。',
      '// 阅读顺序：先看灯样式，再读轨道段，最后看边檐与滚动条。',
    ],
    blocks: [
      {
        anchor: 'export function stationLampClass(',
        lines: [
          '留白灯优先于状态灯。',
          '已补全的留白回到普通灯。',
          '等待留白用警示色描边。',
          '其余留白用最浅描边。',
          '运行灯带呼吸光晕。',
          '减少动效时关闭呼吸。',
        ],
      },
      {
        anchor: 'function Segment({ rail, width }: { rail: TimelineRail | undefined; width: number }) {',
        lines: [
          '双线段用于并行两站。',
          '两条线相距两像素。',
          '单线段缺轨道时隐藏。',
          '线宽固定一像素。',
          '墨色随轨道数据变化。',
          '段宽由调用方给定。',
        ],
      },
      {
        anchor: 'export function WorkflowLedge({',
        lines: [
          '空索引直接不渲染。',
          '灯数超过五枚折叠为加号。',
          '靠内容一侧接短轨道。',
          '每枚灯是可选按钮。',
          '标签含站名与状态。',
          '左右两侧镜像排列。',
        ],
      },
      {
        anchor: 'export function WorkflowTimelineScrollbar({',
        lines: [
          '拇指不存在时不渲染。',
          '拖动按指针标识跟踪。',
          '位移按滚动比例换算。',
          '轨道点击按半屏翻页。',
          '减少动效时改为瞬时滚动。',
          '点击事件到此终止。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/feedback/feedbackMeta.ts',
    first: 'import type {',
    target: 45,
    header: [
      '// INV-01 四种反馈类型保持固定顺序：守住位置 FEEDBACK_TYPE_META；改错故障 选择器顺序随版本漂移。',
      '// INV-02 类型值对接共享枚举：守住位置 TypeMeta.value；改错故障 提交值后端不识别。',
      '// INV-03 每项都带图标与选中色：守住位置 iconText；改错故障 选中态失去类型区分。',
      '// INV-04 三档严重度固定：守住位置 SEVERITY_META；改错故障 表单出现第四档。',
      '// INV-05 严重度提示只保留缩写：守住位置 hint；改错故障 列表被长文案撑开。',
      '// INV-06 状态表覆盖全部枚举值：守住位置 STATUS_META 类型；改错故障 缺项时渲染崩溃。',
      '// INV-07 归档与答复关闭共用样式：守住位置 两个键；改错故障 同一终态显示两种颜色。',
      '// INV-08 归档是接口归一后的值：守住位置 注释与键；改错故障 后端改名后崩溃。',
      '// INV-09 拒绝态用最浅前景色：守住位置 已拒绝 项；改错故障 拒绝与通过同样醒目。',
      '// INV-10 状态颜色只表达分组：守住位置 className；改错故障 颜色被误读成优先级。',
      '// INV-11 严重度徽章三档齐全：守住位置 SEVERITY_BADGE；改错故障 某档无边框样式。',
      '// INV-12 模块文案标识集中一处：守住位置 FEEDBACK_MODULE_MESSAGE_IDS；改错故障 文案散落各组件。',
      '// INV-13 模块键为后端枚举：守住位置 Record 类型；改错故障 拼写不一致导致空文案。',
      '// INV-14 其它作为兜底项：守住位置 末项；改错故障 未列模块显示空白。',
      '// INV-15 状态文案标识同样集中：守住位置 FEEDBACK_STATUS_MESSAGE_IDS；改错故障 状态名直接外露。',
      '// INV-16 归档映射到已完成文案：守住位置 已归档 项；改错故障 用户看到内部命名。',
      '// INV-17 格式化函数不读全局：守住位置 入参 formatter；改错故障 组件无法替换国际化实现。',
      '// INV-18 本文件只有常量与纯函数：守住位置 无副作用模块；改错故障 导入时触发注册。',
      '//',
      '// 模块职责：反馈工单的类型、严重度、状态与模块展示元数据。',
      '// 状态所有权：无状态；全部为只读常量表与标签格式化函数。',
      '// 阅读顺序：先看类型与严重度，再读状态表，最后看文案标识与格式化。',
    ],
    blocks: [
      {
        anchor: 'export const FEEDBACK_TYPE_META: TypeMeta[] = [',
        lines: [
          '四种反馈类型保持固定顺序。',
          '每项含值、文案、说明与图标。',
          '图标颜色随主题切换。',
          '类型值直接对接共享枚举。',
          '新增类型必须补图标。',
          '数组用于选择器渲染。',
        ],
      },
      {
        anchor: 'export const SEVERITY_META: {',
        lines: [
          '三档严重度固定。',
          '提示词只保留级别缩写。',
          '圆点颜色与级别对应。',
          '标签用于表单选项。',
          '值必须与后端枚举一致。',
          '数组顺序即优先级。',
        ],
      },
      {
        anchor: 'export const STATUS_META: Record<FeedbackTicketStatus, StatusMeta> = {',
        lines: [
          '状态表覆盖全部枚举值。',
          '归档与答复关闭共用样式。',
          '归档是接口归一后的值。',
          '缺项会导致渲染崩溃。',
          '拒绝态用最浅前景色。',
          '颜色只表达分组不表达优先级。',
        ],
      },
      {
        anchor: 'export const FEEDBACK_MODULE_MESSAGE_IDS: Record<FeedbackTicketModule, string> = {',
        lines: [
          '模块文案标识集中一处。',
          '键为后端模块枚举。',
          '值交给国际化层解析。',
          '新增模块必须同步映射。',
          '其它作为兜底项。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/hooks/useTabPersistence.ts',
    first: null,
    firstNth: 1,
    target: 46,
    header: [
      '// INV-01 恢复与持久化是两个开关：守住位置 restoreSession 与 persistSession；改错故障 新窗口覆盖主窗口会话。',
      '// INV-02 持久化默认跟随恢复：守住位置 默认参数；改错故障 只恢复不写回。',
      '// INV-03 完成态绑定服务与开关：守住位置 生命周期比较；改错故障 换服务后误判已完成。',
      '// INV-04 恢复中标志驱动外层 loading：守住位置 isRestoring；改错故障 启动闪一下打开项目页。',
      '// INV-05 首次恢复未完成不写回：守住位置 initialRestoreFullyCompletedRef；改错故障 半份快照落盘。',
      '// INV-06 门禁关闭时跳过写回：守住位置 canPersist；改错故障 远程断连覆盖设置。',
      '// INV-07 恢复失败必须 fail-closed：守住位置 捕获分支；改错故障 空 tabs 被当成真实状态。',
      '// INV-08 恢复失败仍结束 loading：守住位置 completed 置真；改错故障 界面永久转圈。',
      '// INV-09 写回带防抖：守住位置 DEBOUNCE_MS；改错故障 每次 store 事件都写盘。',
      '// INV-10 连续变化重置定时器：守住位置 clearTimeout；改错故障 旧快照后写覆盖新快照。',
      '// INV-11 写前读取同一设置快照：守住位置 get 与 update 串联；改错故障 冻结身份被改写。',
      '// INV-12 补丁可由调用方覆盖：守住位置 buildPersistPatch；改错故障 远程会话无法定制写回。',
      '// INV-13 默认补丁只写本地工作区：守住位置 身份与远端判断；改错故障 远端路径被当最近项目。',
      '// INV-14 次级窗口不写回：守住位置 persistSession 判断；改错故障 恢复到最后关闭的窗口。',
      '// INV-15 延迟恢复优先空闲回调：守住位置 scheduleDeferredRestore；改错故障 启动阶段抢占主线程。',
      '// INV-16 延迟恢复可取消：守住位置 返回的取消函数；改错故障 卸载后仍补标签页。',
      '// INV-17 恢复异常只记日志：守住位置 catch；改错故障 启动被未处理拒绝打断。',
      '// INV-18 卸载时退订并清定时器：守住位置 两个 effect 的清理；改错故障 泄漏订阅与写回。',
      '//',
      '// 模块职责：标签页会话的恢复、持久化与写回门禁接线。',
      '// 状态所有权：恢复生命周期为 hook 局部状态；标签页数据归 tab store。',
      '// 阅读顺序：先看门禁与调度，再读恢复 effect，最后看持久化 effect。',
    ],
    blocks: [
      {
        anchor: 'function openWorkspacePersistenceGate(',
        lines: [
          '无门禁时直接返回。',
          '可写状态由是否持久化决定。',
          '开门后回调一次。',
          '回调可异步但不等待。',
          '门禁对象由调用方共享。',
          '该函数不改恢复状态。',
        ],
      },
      {
        anchor: 'function scheduleDeferredRestore(callback: () => void): () => void {',
        lines: [
          '优先使用空闲回调。',
          '空闲回调带一秒超时。',
          '不支持时退回零延时定时器。',
          '返回值统一为取消函数。',
          '取消只清尚未执行的回调。',
          '该调度不抛异常。',
        ],
      },
      {
        anchor: 'export function useTabPersistence({',
        lines: [
          '恢复开关默认开启。',
          '持久化开关默认跟随恢复。',
          '完成态绑定服务与开关。',
          '恢复中标志驱动外层 loading。',
          '门禁在恢复失败时保持关闭。',
          '返回三个只读状态。',
        ],
      },
      {
        anchor: 'const unsubscribe = store.subscribe((state) => {',
        lines: [
          '未完成首次恢复不写回。',
          '门禁关闭时跳过写回。',
          '连续变化重置防抖定时器。',
          '写前读取同一设置快照。',
          '补丁可由调用方覆盖。',
          '卸载时退订并清定时器。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/hooks/useWorkspaceActiveTaskState.ts',
    first: 'import { useEffect, useRef, useState } from "react";',
    target: 45,
    header: [
      '// INV-01 元数据比较按序列化结果：守住位置 areTaskMetaJsonFieldsEqual；改错故障 等价对象被判不等。',
      '// INV-02 空值统一归一：守住位置 两侧 null 合并；改错故障 未定义与空值被判不等。',
      '// INV-03 等价元数据复用旧引用：守住位置 useStableResolvedActiveTaskMeta；改错故障 流式更新拖动标题栏重渲。',
      '// INV-04 不等时才替换引用：守住位置 条件赋值；改错故障 旧标题长期不更新。',
      '// INV-05 目标键含身份与远端：守住位置 targetKey；改错故障 同 ID 跨远端互相污染。',
      '// INV-06 订阅先于查询：守住位置 effect 顺序；改错故障 读取与订阅之间漏掉重命名。',
      '// INV-07 迟到结果不得覆盖新结果：守住位置 serial 比较；改错故障 旧响应盖回旧标题。',
      '// INV-08 卸载后不写状态：守住位置 disposed；改错故障 卸载后 setState 警告。',
      '// INV-09 目标变化立即拒绝旧结果：守住位置 渲染期比较；改错故障 切换后短暂显示旧标题。',
      '// INV-10 乐观元数据只按当前任务取：守住位置 activeTaskId 判断；改错故障 显示其它任务标题。',
      '// INV-11 乐观值作为回退：守住位置 indexedMeta 合并；改错故障 首帧无标题。',
      '// INV-12 标题缺省区分分叉与新建：守住位置 forkedFromTaskId 三元；改错故障 分叉任务显示新会话。',
      '// INV-13 提供方回退到选中项：守住位置 resolveWorkspaceHeaderProvider；改错故障 标题栏显示空提供方。',
      '// INV-14 变更摘要当前恒为空：守住位置 activeTaskChangeSummary；改错故障 展示已退役的消息流字段。',
      '// INV-15 读取失败只告警：守住位置 catch；改错故障 单次读取失败打断整页。',
      '// INV-16 动态事件与广播都触发刷新：守住位置 两个订阅；改错故障 重命名后标题不更新。',
      '// INV-17 订阅随目标释放：守住位置 effect 清理；改错故障 事件处理器累积。',
      '// INV-18 本 hook 不写 store：守住位置 只读选择器；改错故障 渲染期产生副作用。',
      '//',
      '// 模块职责：按工作区与任务标识汇总活动任务的展示状态。',
      '// 状态所有权：索引元数据为 hook 局部状态；任务事实归任务服务与会话 store。',
      '// 阅读顺序：先看元数据比较，再读稳定引用，最后看订阅与返回值。',
    ],
    blocks: [
      {
        anchor: 'function areTaskMetaJsonFieldsEqual(left: unknown, right: unknown) {',
        lines: [
          '两个未定义值都归一为空。',
          '按序列化结果比较。',
          '键序不同会被判为不等。',
          '仅用于元数据片段。',
          '不递归比较原型。',
          '该比较不产生副作用。',
        ],
      },
      {
        anchor: 'export function useStableResolvedActiveTaskMeta(taskMeta: ZCodeTaskMeta | null) {',
        lines: [
          '首次渲染先存当前值。',
          '等价元数据复用旧引用。',
          '避免流式更新拖动标题栏重渲。',
          '不等时替换引用。',
          '该 hook 不做深拷贝。',
          '空值也会被稳定。',
        ],
      },
      {
        anchor: 'export function useWorkspaceActiveTaskState({',
        lines: [
          '先取任务服务与广播服务。',
          '版本号驱动重新订阅。',
          '乐观元数据只按当前任务取。',
          '目标键包含身份与远端。',
          '订阅先于查询避免漏事件。',
          '迟到的结果不得覆盖新结果。',
        ],
      },
      {
        anchor: 'const indexedMeta =',
        lines: [
          '服务或目标变化即拒绝旧结果。',
          '渲染期就完成拒绝。',
          '乐观值作为回退。',
          '标题缺省按分叉与新建区分。',
          '日志文件路径随提供方解析。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/lib/automationTelemetry.ts',
    first: 'import {',
    target: 44,
    header: [
      '// INV-01 模型值先去空白：守住位置 resolveAutomationModelTelemetry；改错故障 空白值进入维度。',
      '// INV-02 自定义编码优先解析：守住位置 decodeCustomModelValue；改错故障 斜杠拆分破坏编码。',
      '// INV-03 斜杠形式按首段拆提供方：守住位置 slash 判断；改错故障 模型名带提供方前缀。',
      '// INV-04 显式提供方优先于解析：守住位置 三元顺序；改错故障 调用方覆盖失效。',
      '// INV-05 提供方名只对个人标准配置解析：守住位置 四项联合条件；改错故障 企业配置泄露主机名。',
      '// INV-06 主机名解析失败记空串：守住位置 try 捕获；改错故障 非法地址打断埋点。',
      '// INV-07 提供方标识做历史归一：守住位置 legacyTelemetryProviderId；改错故障 看板出现新旧两套标识。',
      '// INV-08 错误只输出固定类别：守住位置 classifyAutomationTelemetryError；改错故障 自由文本进入看板。',
      '// INV-09 额度错误最优先：守住位置 首条判断；改错故障 额度失败被归为校验失败。',
      '// INV-10 超时与网络分列：守住位置 两条正则；改错故障 连接失败与超时混为一类。',
      '// INV-11 认证错误单独归类：守住位置 auth 正则；改错故障 登录失效被记为未知。',
      '// INV-12 校验错误最后判断：守住位置 validation 正则；改错故障 表单错误被记成网络错误。',
      '// INV-13 未知模式不猜测：守住位置 末尾 unknown；改错故障 原始错误被回传。',
      '// INV-14 错误信息先统一脱敏：守住位置 sanitizeAutomationTelemetryError；改错故障 秘密值进入埋点。',
      '// INV-15 创建结果按标识判成功：守住位置 automationId 判断；改错故障 成功也带错误码。',
      '// INV-16 失败才填错误字段：守住位置 条件三元；改错故障 成功事件含残留错误。',
      '// INV-17 事件区域固定：守住位置 EVENT_REGION；改错故障 自动化指标散落多个区域。',
      '// INV-18 点击事件按动作分派：守住位置 elementName 三元；改错故障 运行与删除无法区分。',
      '//',
      '// 模块职责：自动化创建与操作点击的埋点构造与错误归类。',
      '// 状态所有权：无状态；全部为纯函数，事件对象每次新建。',
      '// 阅读顺序：先看模型字段解析，再读错误归类，最后看两类上报。',
    ],
    blocks: [
      {
        anchor: 'export function resolveAutomationModelTelemetry(',
        lines: [
          '模型值先去空白。',
          '自定义编码优先解析。',
          '斜杠形式按首段拆提供方。',
          '提供方名只对个人标准配置解析。',
          '主机名解析失败记空串。',
          '返回值固定三个键。',
        ],
      },
      {
        anchor: 'function classifyAutomationTelemetryError(',
        lines: [
          '错误只输出固定类别。',
          '额度错误最优先。',
          '超时与网络错误分列。',
          '认证错误单独归类。',
          '校验错误最后判断。',
          '未知模式不猜测。',
        ],
      },
      {
        anchor: 'export function reportAutomationCreateResult(',
        lines: [
          '创建结果按标识判成功。',
          '失败才填错误码与信息。',
          '错误信息先经统一脱敏。',
          '模型字段平铺进详情。',
          '事件区域固定为自动化。',
        ],
      },
      {
        anchor: 'export function reportAutomationActionClick(',
        lines: [
          '运行与删除共用点击事件。',
          '事件名按动作分派。',
          '来源区分列表与编辑器。',
          '仅运行动作附带模型字段。',
          '自动化标识始终上报。',
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
    `ZC-deep-b116-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  index += 1;
}
