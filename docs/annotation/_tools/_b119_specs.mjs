import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/terminal/terminalLinks.ts',
    first: 'import type { IBuffer, IBufferLine, ILink } from "@xterm/xterm";',
    target: 44,
    header: [
      '// INV-01 URL 不跨越空白：守住位置 HTTP_URL_PATTERN；改错故障 链接吞掉后文参数。',
      '// INV-02 尾部标点先裁剪：守住位置 TRAILING_PUNCTUATION_PATTERN；改错故障 句末标点进入可点击地址。',
      '// INV-03 闭合括号需配对：守住位置 CLOSING_BRACKET_PAIRS；改错故障 带括号的链接丢失右括号。',
      '// INV-04 括号数不配时才裁：守住位置 countChar 比较；改错故障 合法路径被截断。',
      '// INV-05 裁剪循环到稳定为止：守住位置 无界循环退出条件；改错故障 尾标点只裁一层。',
      '// INV-06 空候选直接跳过：守住位置 trimmed 判断；改错故障 生成空文本链接区间。',
      '// INV-07 区间按原始下标回填：守住位置 startIndex 与长度；改错故障 高亮范围整体错位。',
      '// INV-08 单元格按字符落位：守住位置 positions 逐字符追加；改错故障 双宽字符映射偏移。',
      '// INV-09 零宽单元格跳过：守住位置 宽度判断；改错故障 代理对位置重复计数。',
      '// INV-10 单元格对象复用：守住位置 reusableCell；改错故障 大缓冲区逐格分配内存。',
      '// INV-11 折行从首行起算：守住位置 向前回溯折行标志；改错故障 长链接被截成半段。',
      '// INV-12 折行到尾行结束：守住位置 向后推进折行标志；改错故障 跨行链接丢尾部。',
      '// INV-13 缺失缓冲行返回空：守住位置 行对象判断；改错故障 越界读取直接崩溃。',
      '// INV-14 空快照不生成链接：守住位置 文本判断；改错故障 空行也进入匹配流程。',
      '// INV-15 坐标转为一基索引：守住位置 两处加一；改错故障 链接整体左移一格。',
      '// INV-16 跨行链接按当前行裁剪：守住位置 起止行包含判断；改错故障 相邻行重复高亮。',
      '// INV-17 无命中返回未定义：守住位置 结果长度判断；改错故障 调用方把空数组当命中。',
      '// INV-18 本模块不持有终端实例：守住位置 纯函数与缓冲入参；改错故障 生命周期与终端耦合。',
      '//',
      '// 模块职责：从终端缓冲区文本中识别并定位 HTTP 链接。',
      '// 状态所有权：无状态；缓冲区与行列数均由调用方传入。',
      '// 阅读顺序：先看正则与裁剪，再读快照构建，最后看链接定位。',
    ],
    blocks: [
      {
        anchor: 'export function findHttpLinksInTerminalText(text: string): TerminalHttpLinkMatch[] {',
        lines: [
          '逐个匹配全部地址。',
          '保留匹配的原始下标。',
          '先裁掉尾部标点。',
          '空候选直接跳过。',
          '结束下标按裁剪后长度算。',
          '结果为原始文本区间。',
        ],
      },
      {
        anchor: 'function appendCellText(',
        lines: [
          '空字符按空格占位。',
          '文本追加到快照。',
          '每个字符重复同一坐标。',
          '位置数组与文本等长。',
          '该函数不裁剪宽度。',
          '供折行拼装复用。',
        ],
      },
      {
        anchor: 'function getWrappedLineRange(buffer: IBuffer, bufferLineNumber: number) {',
        lines: [
          '先向前找到折行首行。',
          '再向后找到折行末行。',
          '范围包含当前行本身。',
          '首行不再继续回溯。',
          '返回值用于整段读取。',
        ],
      },
      {
        anchor: 'export function getHttpLinksForTerminalBufferLine(',
        lines: [
          '先拼出折行快照。',
          '空快照直接返回未定义。',
          '起止坐标加一转换。',
          '只保留覆盖当前行的链接。',
          '无命中返回未定义。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/lib/exploreToolCall.ts',
    first: 'import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";',
    target: 43,
    header: [
      '// INV-01 身份判定先于形状猜测：守住位置 resolveToolCallIdentity；改错故障 工具家族判断分叉。',
      '// INV-02 纯对象判定排除数组：守住位置 isPlainRecord；改错故障 数组被当成命令记录。',
      '// INV-03 命令按连接符切段：守住位置 splitCommandSegments；改错故障 混合命令被当成单条。',
      '// INV-04 空段被过滤：守住位置 长度过滤；改错故障 空命令进入只读判定。',
      '// INV-05 剥壳支持登录 shell：守住位置 第一个正则；改错故障 包装命令被误判为执行。',
      '// INV-06 剥壳支持 PowerShell：守住位置 第二个正则；改错故障 Windows 包装命令漏判。',
      '// INV-07 包裹引号成对才剥：守住位置 成对判断；改错故障 单侧引号命令被截断。',
      '// INV-08 字符串入参即候选：守住位置 字符串分支；改错故障 纯字符串命令无法识别。',
      '// INV-09 数组入参取 -lc 后一项：守住位置 下标加一；改错故障 包装命令取到错误片段。',
      '// INV-10 记录数组只读 cmd 字段：守住位置 记录分支；改错故障 结构化命令被整体忽略。',
      '// INV-11 多键合并后去重：守住位置 四键遍历与集合；改错故障 同一命令重复计数。',
      '// INV-12 写命令优先排除：守住位置 写正则先行；改错故障 写操作被当作只读探查。',
      '// INV-13 重定向视为写：守住位置 重定向正则；改错故障 覆盖文件的命令被折叠。',
      '// INV-14 只读命令命中即真：守住位置 读正则判断；改错故障 搜索探查不再折叠。',
      '// INV-15 循环内只读仍算探查：守住位置 循环与读双条件；改错故障 批量查看不被识别。',
      '// INV-16 无命令的 shell 不算执行：守住位置 空命令判断；改错故障 待补命令被标成执行中。',
      '// INV-17 执行判定排除探查：守住位置 两个取反判断；改错故障 同一调用两种状态并存。',
      '// INV-18 本模块不读全局状态：守住位置 纯函数入参；改错故障 判定依赖渲染上下文。',
      '//',
      '// 模块职责：依据工具身份与入参判定 shell 调用属于探查还是执行。',
      '// 状态所有权：无状态；全部为纯函数。',
      '// 阅读顺序：先看身份与命令抽取，再读剥壳与切段，最后看三类判定。',
    ],
    blocks: [
      {
        anchor: 'function extractToolCommands(input: unknown): string[] {',
        lines: [
          '字符串直接作为候选。',
          '数组分两种形态处理。',
          '纯字符串数组先找 -lc。',
          '找不到则整体拼接。',
          '记录数组只读 cmd 字段。',
          '最终统一剥壳与去重。',
        ],
      },
      {
        anchor: 'function unwrapShellCommand(command: string): string {',
        lines: [
          '先去除首尾空白。',
          '登录 shell 取参数之后。',
          'PowerShell 取命令参数之后。',
          '包裹引号成对才剥离。',
          '不匹配则原样返回。',
        ],
      },
      {
        anchor: 'export function isShellToolCallAwaitingCommand({ kind, input }: { kind: string; input: unknown }) {',
        lines: [
          '先解析工具身份。',
          '仅 shell 家族参与。',
          '无命令视为待补。',
          '该判定不区分读写。',
          '供执行判定复用。',
        ],
      },
      {
        anchor: 'export function isExploreToolCall({ kind, input }: { kind: string; input: unknown }) {',
        lines: [
          '写文件家族直接排除。',
          '读搜索抓取家族直接通过。',
          '非 shell 家族一律排除。',
          '写命令与重定向先行排除。',
          '只读或循环只读视为探查。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/hooks/useSystemService.ts',
    first: null,
    firstNth: 1,
    target: 44,
    header: [
      '// INV-01 超时下限一百毫秒：守住位置 归一化下界；改错故障 过小超时导致误判离线。',
      '// INV-02 超时上限十秒：守住位置 归一化上界；改错故障 极端配置长时间拖住界面。',
      '// INV-03 非数值回落默认超时：守住位置 有限值判断；改错故障 非数值进入请求。',
      '// INV-04 尝试次数上限三次：守住位置 次数上界；改错故障 重试风暴拖垮探针。',
      '// INV-05 尝试次数至少一次：守住位置 次数下界；改错故障 零次尝试永远没有结果。',
      '// INV-06 成功数不超过目标数：守住位置 上界取目标长度；改错故障 门槛永远无法满足。',
      '// INV-07 成功数至少一：守住位置 门槛下界；改错故障 空门槛让探测恒为真。',
      '// INV-08 服务目标标识可缺省：守住位置 空值回退地址；改错故障 分组键为空互相覆盖。',
      '// INV-09 标记与令牌去空白：守住位置 裁剪后判空；改错故障 空白被当成有效标记。',
      '// INV-10 TCP 端口范围校验：守住位置 端口上下界；改错故障 非法端口进入连接。',
      '// INV-11 非法端口回落二十二：守住位置 默认端口常量；改错故障 连接直接失败。',
      '// INV-12 稳定键不重排目标：守住位置 保持入参顺序；改错故障 键随顺序变化。',
      '// INV-13 稳定键含尝试与门槛：守住位置 三字段序列化；改错故障 参数变化不触发重探。',
      '// INV-14 空请求键为固定串：守住位置 空值分支；改错故障 空请求键变成未定义。',
      '// INV-15 仅最新探测可写回：守住位置 编号相等判断；改错故障 迟到结果覆盖新状态。',
      '// INV-16 每次探测自增代际：守住位置 前置自增；改错故障 两次探测共用同一编号。',
      '// INV-17 自动探测按稳定键触发：守住位置 effect 依赖；改错故障 内联对象导致持续重探。',
      '// INV-18 本模块不缓存系统信息：守住位置 状态归各 hook；改错故障 多组件共享过期数据。',
      '//',
      '// 模块职责：系统信息与内网探测的 React hooks 及稳定键工具。',
      '// 状态所有权：结果与加载态归各 hook 实例；服务实例来自服务容器。',
      '// 阅读顺序：先看四个归一化函数，再读稳定键，最后看两个 hook 的代际控制。',
    ],
    blocks: [
      {
        anchor: 'export function createIntranetProbeRequestStableKey(',
        lines: [
          '空请求返回固定字符串。',
          '目标逐个归一化。',
          '尝试次数与门槛一并入键。',
          '键为 JSON 字符串。',
          '目标顺序保持入参顺序。',
          '该函数不缓存结果。',
        ],
      },
      {
        anchor: 'export function useSystemInfo() {',
        lines: [
          '初始假定加载中。',
          '刷新前先清错误。',
          '成功写入系统信息。',
          '失败统一包装为错误。',
          '结束无论成败都关加载。',
          '挂载时自动刷新一次。',
        ],
      },
      {
        anchor: 'const probeNow = useCallback(async () => {',
        lines: [
          '先自增代际编号。',
          '读取最新请求引用。',
          '未启用或无请求即清空。',
          '写回前校验代际。',
          '失败同样校验后落错误。',
        ],
      },
      {
        anchor: 'useEffect(() => {',
        nth: 2,
        lines: [
          '关闭自动探测时直接返回。',
          '探测函数引用保持稳定。',
          '内容变化由稳定键感知。',
          '内联对象不触发重探。',
          '该 effect 无清理函数。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/project-sidebar/RemoteIdentityHoverCard.tsx',
    first: 'import { useEffect, useRef, useState, type ReactElement } from "react";',
    target: 44,
    header: [
      '// INV-01 悬停结束即关闭：守住位置 scheduleClose；改错故障 浮层常驻遮挡列表。',
      '// INV-02 关闭保留缓冲延迟：守住位置 关闭延迟常量；改错故障 移向详情途中闪关。',
      '// INV-03 进入详情取消关闭：守住位置 cancelClose；改错故障 无法选中详情文字。',
      '// INV-04 离开详情重新计时：守住位置 指针离开回调；改错故障 浮层永不关闭。',
      '// INV-05 菜单内失焦不算离开：守住位置 焦点目标判断；改错故障 鼠标进详情即被关闭。',
      '// INV-06 无新焦点不立即关：守住位置 详情标记判断；改错故障 点击文字复制即消失。',
      '// INV-07 主机换代即重置：守住位置 effect 依赖主机标识；改错故障 旧设备详情残留。',
      '// INV-08 无主机直接渲染子节点：守住位置 空值返回；改错故障 本地项目出现空浮层。',
      '// INV-09 定位读取菜单外沿：守住位置 锚点矩形测量；改错故障 浮层与菜单错位。',
      '// INV-10 无菜单回退行矩形：守住位置 三元回退；改错故障 普通列表浮层偏移。',
      '// INV-11 锚点仅在菜单模式启用：守住位置 菜单锚点开关；改错故障 非菜单场景多出虚拟锚点。',
      '// INV-12 连接状态先经协议解析：守住位置 协议校验；改错故障 未知状态直入展示层。',
      '// INV-13 解析失败回退主机状态：守住位置 空值合并；改错故障 浮层状态显示空白。',
      '// INV-14 升级目标透传展示层：守住位置 升级目标字段；改错故障 操作名与设备卡矛盾。',
      '// INV-15 状态文案用短消息：守住位置 短消息标识；改错故障 浮层出现过长的泛化文案。',
      '// INV-16 恢复参数单独传递：守住位置 参数映射；改错故障 占位符未被替换。',
      '// INV-17 待处理才显示设置入口：守住位置 待处理判断；改错故障 正常设备出现无意义按钮。',
      '// INV-18 本组件不写入主机状态：守住位置 只读投影；改错故障 悬停触发连接副作用。',
      '//',
      '// 模块职责：远端项目身份的悬停详情卡，展示设备、连接与路径信息。',
      '// 状态所有权：开关与关闭计时为局部状态；主机数据由调用方传入且只读。',
      '// 阅读顺序：先看常量与锚点，再读开关时序，最后看展示投影与内容结构。',
    ],
    blocks: [
      {
        anchor: 'const menuAnchor = useRef({',
        lines: [
          '上下文元素取触发节点。',
          '行矩形由触发节点测量。',
          '菜单矩形按最近菜单取。',
          '有菜单时以菜单宽度为准。',
          '纵向始终跟随行高。',
          '该锚点不写入文档结构。',
        ],
      },
      {
        anchor: 'const scheduleClose = () => {',
        lines: [
          '先取消已有计时。',
          '计时到期才关闭。',
          '文字选区不阻止关闭。',
          '延迟值集中在一处。',
          '关闭只改局部开关。',
          '不触发任何网络请求。',
        ],
      },
      {
        anchor: 'const presentation = resolveRemoteConnectionPresentation({',
        lines: [
          '状态先经协议校验。',
          '解析失败回退主机字段。',
          '升级目标原样透传。',
          '项目错误优先于主机错误。',
          '展示对象只读使用。',
        ],
      },
      {
        anchor: 'useEffect(() => {',
        lines: [
          '主机变化即关闭浮层。',
          '同时复位详情标记。',
          '卸载时清除计时器。',
          '依赖只含主机标识。',
          '该 effect 无返回值。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/ToolCallBlocks/renderers/cuaDetails.tsx',
    first: 'import { CheckCircle2, XCircle } from "lucide-react";',
    target: 44,
    header: [
      '// INV-01 只读记录判定排除数组：守住位置 asRecord；改错故障 数组被当作对象读取。',
      '// INV-02 文本字段去空白：守住位置 readText 判断；改错故障 空白串占用详情行。',
      '// INV-03 非字符串视为缺失：守住位置 类型判断；改错故障 数字被强转成文本。',
      '// INV-04 行标签走本地化：守住位置 标签标识查表；改错故障 详情出现原始键名。',
      '// INV-05 状态为真显示成功图标：守住位置 严格等于真；改错故障 任意真值都显示成功。',
      '// INV-06 状态为假显示失败图标：守住位置 严格等于假；改错故障 失败行没有标记。',
      '// INV-07 代码值用等宽字体：守住位置 代码分支；改错故障 命令与路径难以辨认。',
      '// INV-08 结果区始终渲染：守住位置 无条件分区；改错故障 失败时看不到结果。',
      '// INV-09 结果文案支持占位参数：守住位置 结果参数；改错故障 数量占位符未被替换。',
      '// INV-10 失败原因二选一：守住位置 标识优先于文本；改错故障 同时渲染两段原因。',
      '// INV-11 建议动作二选一：守住位置 标识优先；改错故障 重复展示同一建议。',
      '// INV-12 截图独立成节：守住位置 条件渲染；改错故障 截图信息被挤进文本。',
      '// INV-13 权限行有项才渲染：守住位置 长度判断；改错故障 空权限显示空表。',
      '// INV-14 环境行有项才渲染：守住位置 长度判断；改错故障 空环境显示空表。',
      '// INV-15 列表按有项才渲染：守住位置 条目长度；改错故障 空列表占位撑高卡片。',
      '// INV-16 状态行最后渲染：守住位置 分区顺序；改错故障 关键状态被折叠在最后。',
      '// INV-17 输入文本长度用于计数：守住位置 计数变量；改错故障 结果数量始终为零。',
      '// INV-18 本组件不解析旧格式：守住位置 只读展示模型；改错故障 详情层承担协议兼容。',
      '//',
      '// 模块职责：CUA 工具调用的详情卡，按模型渲染动作、结果与状态分区。',
      '// 状态所有权：无状态；展示模型由上层构建并传入。',
      '// 阅读顺序：先看记录与文本读取，再读详情行组件，最后看分区顺序。',
    ],
    blocks: [
      {
        anchor: 'function readText(record: Record<string, unknown> | null, key: string): string | null {',
        lines: [
          '记录为空返回空。',
          '只接受字符串值。',
          '去空白后判空。',
          '返回裁剪后的文本。',
          '不修改原记录。',
        ],
      },
      {
        anchor: 'function CuaDetailRows({ rows }: { rows: CuaDetailsModel["actionRows"] }) {',
        lines: [
          '每行由标签与值组成。',
          '键由标签与值拼接。',
          '值为空时仍占一行。',
          '状态图标在值左侧。',
          '代码值走等宽样式。',
          '该组件不裁剪行数。',
        ],
      },
      {
        anchor: 'export function CuaToolCallDetails({',
        lines: [
          '输入文本长度用于计数。',
          '只渲染用户可见字段。',
          '动作区有行才显示。',
          '结果区始终显示。',
          '失败与建议按需追加。',
          '截图与列表独立成节。',
        ],
      },
      {
        anchor: 'return (',
        nth: 2,
        lines: [
          '外层卡片统一间距。',
          '各分区以分隔线切分。',
          '分区顺序固定。',
          '条件区缺省不占位。',
          '该结构不包裹交互。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/ToolCallBlocks/renderers/todo.tsx',
    first: 'import { ArrowRightIcon, CircleCheckIcon, CircleIcon, ListTodoIcon } from "lucide-react";',
    target: 44,
    header: [
      '// INV-01 计划优先取输出：守住位置 输出提取函数；改错故障 已完成计划回退成空。',
      '// INV-02 输出缺失再取输入：守住位置 空值合并；改错故障 运行中计划不可见。',
      '// INV-03 三态样式集中映射：守住位置 状态样式表；改错故障 各状态样式漂移。',
      '// INV-04 当前项优先进行中：守住位置 第一层查找；改错故障 高亮错误任务。',
      '// INV-05 无进行中取首个未完成：守住位置 第二层查找；改错故障 当前项恒为首条。',
      '// INV-06 全完成取最后一项：守住位置 末尾兜底；改错故障 完成后标题为空。',
      '// INV-07 标题逐级回退：守住位置 步骤与工具标题；改错故障 卡片标题缺失。',
      '// INV-08 进度显示完成比总数：守住位置 模板拼接；改错故障 副标题只剩数字。',
      '// INV-09 无计划回退状态文案：守住位置 三元回退；改错故障 副标题为空。',
      '// INV-10 主副文本节点缓存：守住位置 两个缓存钩子；改错故障 每次渲染重建节点。',
      '// INV-11 有计划渲染清单：守住位置 计划分支；改错故障 有数据仍显示原始内容。',
      '// INV-12 无计划回退通用正文：守住位置 片段分支；改错故障 空计划丢失工具输出。',
      '// INV-13 快照提示两处一致：守住位置 两个分支的提示组件；改错故障 提示不同步。',
      '// INV-14 加载全字段按工具标识：守住位置 回调包裹；改错故障 加载到其它工具字段。',
      '// INV-15 失败态才传状态文案：守住位置 失败判断；改错故障 成功卡片显示错误文案。',
      '// INV-16 失败态才传错误提示：守住位置 三元透传；改错故障 悬浮出现无关错误。',
      '// INV-17 进行中状态单独传入：守住位置 运行标志；改错故障 运行指示不显示。',
      '// INV-18 本组件不改写计划数据：守住位置 只读渲染；改错故障 渲染层回写任务状态。',
      '//',
      '// 模块职责：待办工具调用的折叠卡，展示计划进度与逐步状态。',
      '// 状态所有权：无状态；计划来自工具输入输出，展示状态由上下文传入。',
      '// 阅读顺序：先看计划提取与当前项推导，再读文本缓存，最后看两个分支。',
    ],
    blocks: [
      {
        anchor: 'function readTodoPlan(context: ToolCallBlockRenderContext): ZCodePlanStep[] | null {',
        lines: [
          '先尝试从输出提取。',
          '输出为空再看输入。',
          '两种情况都可能为空。',
          '该函数不改写工具调用。',
          '返回原始计划数组。',
          '读取只依赖标题与参数。',
        ],
      },
      {
        anchor: 'export function TodoToolCallBlock(context: ToolCallBlockRenderContext) {',
        lines: [
          '计划缺失时计数为零。',
          '当前项按三优先级选取。',
          '标题缺失回退面板文案。',
          '副标题优先显示进度。',
          '失败状态单独透传。',
          '卡片布局交由通用外壳。',
        ],
      },
      {
        anchor: 'const primaryTextNode = useMemo(',
        lines: [
          '节点只依赖主文本。',
          '截断交给样式类。',
          '不在此处拼接图标。',
          '节点复用避免重排。',
          '副标题使用独立缓存。',
        ],
      },
      {
        anchor: 'const renderContent = useCallback(',
        lines: [
          '有计划时渲染清单。',
          '每个步骤带状态图标。',
          '样式按状态集中取。',
          '无计划时回退通用正文。',
          '两个分支都带快照提示。',
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
    `ZC-deep-b119-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  index += 1;
}
