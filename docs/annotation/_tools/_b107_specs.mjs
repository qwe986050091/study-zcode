import fs from 'node:fs';

const specs = [
  {
    file: 'packages/provider-node/src/zcode-builtin-provider-config-source.ts',
    first: 'import { watch, type FSWatcher } from "node:fs";',
    target: 56,
    header: [
      '// INV-01 Bundled、Active 与 Remote 必须共用同一 Release 载体：守住位置 类注释与三段读写；改错故障 三份配置各自漂移。',
      '// INV-02 bundled 路径必须非空：守住位置 构造函数首行校验；改错故障 空路径让读取落在进程工作目录。',
      '// INV-03 Active 缺省时回落到 bundled 路径：守住位置 构造函数赋值；改错故障 未配置缓存时无法启动。',
      '// INV-04 来源键必须由 Active 绝对路径哈希得到：守住位置 sourceKey 构造；改错故障 不同 Endpoint 同序号被误复用。',
      '// INV-05 监听默认开启，只有显式传入 false 才关闭：守住位置 watchEnabled 计算；改错故障 默认静默不刷新。',
      '// INV-06 读取 Active 失败时必须回落到 Bundled：守住位置 read 的捕获分支；改错故障 缓存目录不可用直接阻断启动。',
      '// INV-07 Bundled 自身无效时仍要抛错：守住位置 回落分支的候选选择；改错故障 无有效配置却返回空快照。',
      '// INV-08 Active 的读写必须持有同一把文件锁：守住位置 三处 withFileLock；改错故障 并发写坏 JSON。',
      '// INV-09 远端版本低于当前版本时判定为过期：守住位置 applyRemoteRelease 的首个比较；改错故障 旧版本回滚覆盖新配置。',
      '// INV-10 相同版本必须内容一致，否则显式报错：守住位置 同版本比较分支；改错故障 同序号不同内容被静默接受。',
      '// INV-11 只有更新成功且未销毁时才广播：守住位置 结果判断；改错故障 销毁后仍通知订阅者。',
      '// INV-12 写入 Active 必须使用原子私有写：守住位置 writeActiveLocked；改错故障 半写文件在崩溃后无法解码。',
      '// INV-13 同版本冲突时以 Bundled 为准：守住位置 selectReleaseCandidate 的冲突分支；改错故障 可信基线被坏缓存拖住。',
      '// INV-14 无有效候选时必须聚合两侧错误：守住位置 空候选分支；改错故障 只看到一半失败原因。',
      '// INV-15 候选选择取修订号最大者：守住位置 reduce 比较；改错故障 旧缓存压过新基线。',
      '// INV-16 文件监听只关注目标文件名：守住位置 watch 回调过滤；改错故障 同目录无关写入触发刷新。',
      '// INV-17 刷新必须串行化：守住位置 watchRefresh 链；改错故障 并发刷新互相覆盖签名。',
      '// INV-18 dispose 必须幂等并关闭监听、清空订阅：守住位置 dispose；改错故障 重复关闭或监听泄漏。',
      '//',
      '// 模块职责：把内置 Provider 配置的 Bundled、Active 缓存与远端下发统一为一个可监听的配置来源。',
      '// 状态所有权：Release 内容归本类；签名与监听器由实例持有，文件系统只作为持久化边界。',
      '// 阅读顺序：先看构造与来源键，再读读取与远端应用，最后看监听刷新与候选选择。',
    ],
    blocks: [
      {
        anchor: 'constructor(options: NodeZCodeBuiltinProviderConfigSourceOptions) {',
        lines: [
          'bundled 路径去空白后必须非空。',
          'Active 缺省时与 bundled 指向同一文件。',
          '来源键取 Active 绝对路径的哈希，隔离不同 Endpoint。',
          '监听开关只在显式 false 时关闭。',
          '构造阶段不触碰文件系统。',
        ],
      },
      {
        anchor: 'async read(): Promise<ProviderConfigLayerSnapshot> {',
        lines: [
          '先确认实例仍可用，再尝试建立监听与读取缓存。',
          '缓存链路整体包在锁内，读取与物化保持原子。',
          '[失败路径] 缓存目录、监听或原子写失败都回落到 Bundled。',
          '回落时 Active 视为空，只信任 Bundled 候选。',
          '首次读取记录签名，供后续监听去重。',
          '快照中的修订号拼接来源键，保证跨来源唯一。',
        ],
      },
      {
        anchor: 'async applyRemoteRelease(release: ZCodeBuiltinRelease): Promise<ApplyZCodeBuiltinReleaseResult> {',
        lines: [
          '远端写入同样先确保监听可用。',
          '整个比较与写入都在同一把文件锁内完成。',
          '低版本直接返回过期，不触碰 Active。',
          '同版本内容一致返回未变化，内容不同则显式报错。',
          '只有更高版本才原子写入并更新签名。',
          '[并发] 广播前再次检查销毁标记，避免关闭后通知。',
        ],
      },
      {
        anchor: 'onDidChange(listener: (reason: string) => void): () => void {',
        lines: [
          '订阅前要求实例可用。',
          '监听器存入集合，天然去重。',
          '返回的取消函数只删除自身。',
          '销毁时集合整体清空。',
        ],
      },
      {
        anchor: 'async #readAndMaterializeLocked(): Promise<ZCodeBuiltinRelease> {',
        lines: [
          '并行读取 Bundled 与 Active，Active 与 Bundled 同路径时跳过。',
          '候选选择在纯函数内完成，读取层不参与优先级判断。',
          '仅当 Active 路径独立时才考虑回写。',
          '回写条件是比较签名，避免无意义写盘。',
          '返回值为最终选中的 Release。',
        ],
      },
      {
        anchor: 'async #ensureWatcher(): Promise<void> {',
        lines: [
          '先确保 Active 所在目录存在。',
          '监听关闭、已存在或已销毁时直接返回。',
          '只监听目标文件名，减少无关事件。',
          '监听错误统一转为 watch-error 广播。',
        ],
      },
      {
        anchor: '#scheduleWatchRefresh(): void {',
        lines: [
          '刷新任务串接到同一条 Promise 链上。',
          '每轮先检查销毁标记。',
          '读取与物化继续走文件锁。',
          '签名未变不广播，异常转为 watch-error。',
        ],
      },
    ],
  },
  {
    file: 'packages/shared/src/mcp.ts',
    first: '/**',
    firstNth: 1,
    target: 49,
    header: [
      '// INV-01 CUA 官方插件标识是跨包常量，不得复制字面量：守住位置 导出常量；改错故障 设置面板与启动器识别不一致。',
      '// INV-02 运行时命名空间名固定为插件加服务片段：守住位置 命名空间常量；改错故障 工具前缀与插件身份脱节。',
      '// INV-03 插件身份环境键由权威解析器写入，配置不可覆盖：守住位置 环境键常量；改错故障 用户环境变量伪造插件身份。',
      '// INV-04 配置来源枚举必须覆盖全部 CLI 来源：守住位置 McpSource 联合类型；改错故障 新来源无法持久化。',
      '// INV-05 请求头优先取标准字段，旧字段仅作兼容：守住位置 getMcpServerRequestHeaders；改错故障 历史鉴权头被忽略。',
      '// INV-06 CUA 判定必须同时比对原始值与路径叶子：守住位置 两个导出判定；改错故障 带路径的包规格漏判。',
      '// INV-07 包规格判定先把下划线归一成短横：守住位置 matchesZCodeCuaSpec；改错故障 Python 包名变体漏判。',
      '// INV-08 包规格只接受明确边界后缀：守住位置 四个 startsWith 分支；改错故障 近似包名被误判为 CUA。',
      '// INV-09 路径叶子先去掉结尾分隔符：守住位置 zcodeCuaArgLeaf；改错故障 尾斜杠得到空叶子导致漏判。',
      '// INV-10 判定方向宁可过判不可漏判：守住位置 两个判定函数的注释与实现；改错故障 权限边界 fail-open。',
      '// INV-11 未声明类型时按命令或地址推断：守住位置 convertToZCodeAgentMcpServer 首段；改错故障 合法配置被判为无效。',
      '// INV-12 Windows 上必须拆掉 cmd 包衣：守住位置 平台判断分支；改错故障 双重 cmd 包裹导致连接失败。',
      '// INV-13 平台检测同时兼容进程与浏览器环境：守住位置 isWin32 表达式；改错故障 渲染进程误判平台。',
      '// INV-14 环境变量与请求头必须转成名值数组：守住位置 两处映射；改错故障 Agent 收到对象而非协议数组。',
      '// INV-15 超时只透传正整数：守住位置 isValidMcpTimeoutMs；改错故障 存量非法配置从忽略变成创建失败。',
      '// INV-16 隔离模式与协议版本只透传白名单值：守住位置 两个类型守卫；改错故障 未知枚举进入严格协议。',
      '// INV-17 OAuth 配置按类型分别校验必填项：守住位置 isValidMcpOAuthConfig；改错故障 缺少密钥的凭据被接受。',
      '// INV-18 无法识别类型或地址时返回空：守住位置 函数末尾；改错故障 不完整配置被送入 Agent。',
      '//',
      '// 模块职责：定义 MCP 配置、来源与 OAuth 类型，并提供 CUA 识别和 Agent DTO 转换。',
      '// 状态所有权：本模块全是类型与纯函数；配置数据由调用方持有，函数不修改入参。',
      '// 阅读顺序：先看身份常量与配置类型，再读请求头与 CUA 判定，最后看 DTO 转换与校验守卫。',
    ],
    blocks: [
      {
        anchor: 'export const ZCODE_CUA_OFFICIAL_PLUGIN_ID = "computer-use@zcode-plugins-official";',
        lines: [
          '插件标识同时被设置面板与启动器使用。',
          '命名空间名刻意不带产品前缀，保持模型可见工具名稳定。',
          '环境键由权威解析器写入，配置层不得覆盖。',
          '三个常量都放在共享包，避免跨进程复制字面量。',
        ],
      },
      {
        anchor: 'export interface McpServerConfig {',
        lines: [
          '类型、地址与命令三类字段覆盖 stdio 与 HTTP 形态。',
          '旧鉴权头字段只为兼容历史配置。',
          '厂商专属字段通过索引签名保留。',
          '该接口是持久化格式，新增字段需考虑旧版本读取。',
        ],
      },
      {
        anchor: 'export function getMcpServerRequestHeaders(',
        lines: [
          '标准请求头优先，缺失时才读旧字段。',
          '返回引用而非拷贝，调用方只读使用。',
          '两处来源不会合并，避免鉴权头重复。',
        ],
      },
      {
        anchor: 'function zcodeCuaArgLeaf(value: string): string {',
        lines: [
          '先去掉结尾路径分隔符，避免空叶子。',
          '再按两种分隔符切分并取最后一段。',
          '无法切分时回退原值。',
          '该函数只做路径形态归一，不判断包名。',
        ],
      },
      {
        anchor: 'function matchesZCodeCuaSpec(candidate: string): boolean {',
        lines: [
          '先把下划线归一成短横，兼容 Python 包名。',
          '裸包名直接命中。',
          '版本、extras 与等号后缀按明确边界命中。',
          '点号分支同时覆盖 git 后缀与子模块。',
        ],
      },
      {
        anchor: 'export function isZCodeCuaMcpCommand(command: string): boolean {',
        lines: [
          '原始值与路径叶子各判定一次。',
          '这样既覆盖裸命令，也覆盖绝对路径与包规格。',
          '判定失败时宁可放过，不误伤普通命令。',
        ],
      },
      {
        anchor: 'export function convertToZCodeAgentMcpServer(',
        lines: [
          '未声明类型时按命令优先、地址兜底推断。',
          'stdio 分支处理 Windows 命令包衣与参数裁剪。',
          'HTTP 与 SSE 分支统一请求头来源。',
          '每个可选字段都经过守卫后才透传。',
          '两类分支都返回名值数组形态的环境与请求头。',
        ],
      },
    ],
  },
  {
    file: 'packages/shared/src/web-remote-relay/contract.ts',
    first: 'import { z } from "zod";',
    target: 47,
    header: [
      '// INV-01 请求与 WebSocket 消息使用严格对象：守住位置 全部 strictObject；改错故障 未知字段被静默接受。',
      '// INV-02 HTTP 响应允许多余字段：守住位置 响应侧 z.object；改错故障 服务端新增字段导致旧客户端解析失败。',
      '// INV-03 时间戳必须为非负整数且落在合理上限内：守住位置 unixSeconds；改错故障 毫秒值被当秒接受。',
      '// INV-04 标识符必须非空、长度受限且去除空白后仍非空：守住位置 identifier；改错故障 纯空白标识进入协议。',
      '// INV-05 设备标识按 UTF-8 字节数限制：守住位置 deviceSid；改错故障 多字节字符超出服务端限制。',
      '// INV-06 角色与配对状态只接受固定枚举：守住位置 两个枚举；改错故障 未知状态进入状态机。',
      '// INV-07 错误码覆盖全部已知分类：守住位置 errorCode；改错故障 新错误码被丢弃。',
      '// INV-08 出站消息按类型判别联合：守住位置 outgoingMessage；改错故障 类型与字段组合不匹配。',
      '// INV-09 解析失败统一返回空：守住位置 两个解析函数；改错故障 异常外泄到消息循环。',
      '// INV-10 入站消息同样按类型判别联合：守住位置 incomingMessage；改错故障 控制帧与数据帧混淆。',
      '// INV-11 HTTP 路由表是唯一地址来源：守住位置 常量表；改错故障 调用方各自拼接路径。',
      '// INV-12 请求体只包含声明字段：守住位置 四个请求 schema；改错故障 多余参数被转发到服务端。',
      '// INV-13 令牌格式按 16 字节无填充 Base64URL 校验：守住位置 token 正则；改错故障 非法令牌进入连接。',
      '// INV-14 错误响应的 code 不允许为 0：守住位置 httpError；改错故障 成功与失败响应无法区分。',
      '// INV-15 成功响应 code 必须为字面量 0：守住位置 response 联合；改错故障 错误响应被当成成功。',
      '// INV-16 删除响应允许省略 data：守住位置 delete 响应 schema；改错故障 服务端省略字段时解析失败。',
      '// INV-17 请求与响应 schema 必须按操作名对齐：守住位置 两张映射表；改错故障 操作与校验器错配。',
      '// INV-18 连接错误只保留分类，不携带服务端正文：守住位置 错误类；改错故障 令牌或正文进入日志。',
      '//',
      '// 模块职责：定义 Web 远控中继 V2 的 WebSocket 消息与 HTTP 接口契约，并提供安全解析入口。',
      '// 状态所有权：全部是 schema 与纯解析函数；连接状态归调用方，本模块不持有运行时数据。',
      '// 阅读顺序：先看基础标量，再读出站与入站消息，最后看 HTTP 路由、请求响应与错误分类。',
    ],
    blocks: [
      {
        anchor: 'const identifier = z',
        lines: [
          '长度上限覆盖会话与设备标识。',
          'trim 后仍为空视为非法。',
          '设备标识额外按 UTF-8 字节数限制。',
          '所有标识类字段都复用同一基础校验。',
        ],
      },
      {
        anchor: 'const authInit = z.strictObject({',
        lines: [
          '认证初始化只允许设备标识与可选元数据。',
          '客户端时间戳可选，缺失时由服务端补。',
          '严格对象拒绝任何额外字段。',
        ],
      },
      {
        anchor: 'export function parseWebRemoteControlRelayV2OutgoingMessage(',
        lines: [
          '使用安全解析，不抛异常。',
          '成功返回判别后的联合类型。',
          '失败统一返回空，交由调用方决定重连或忽略。',
        ],
      },
      {
        anchor: 'export function parseWebRemoteControlRelayV2IncomingMessage(',
        lines: [
          '入站消息同样走安全解析。',
          '数据帧与错误帧由判别字段区分。',
          '解析失败返回空，不把原始载荷透传。',
        ],
      },
      {
        anchor: 'const httpRequests = {',
        lines: [
          '每个操作声明独立请求 schema。',
          '注册与删除只接受必要标识。',
          '列表请求为空对象，严格模式下也不允许额外字段。',
          '令牌请求只声明角色。',
        ],
      },
      {
        anchor: 'const httpResponses = {',
        lines: [
          '成功响应与错误响应组成联合。',
          '列表响应复用设备对象数组。',
          '删除响应允许省略数据字段。',
          '响应侧使用宽松对象以兼容服务端新增字段。',
        ],
      },
      {
        anchor: 'export function parseWebRemoteControlRelayV2HttpRequest<',
        lines: [
          '按操作名从映射表取出对应 schema。',
          '安全解析失败返回空。',
          '泛型返回值与操作名绑定。',
          '响应解析使用同一套模式，只是换映射表。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/components/workflow-timeline/WorkflowAskSettingsParts.tsx',
    first: '// ============================================================',
    firstNth: 1,
    target: 47,
    header: [
      '// INV-01 类名常量是确认窗两句的唯一视觉来源：守住位置 三个导出常量；改错故障 芯片与条件行样式漂移。',
      '// INV-02 芯片悬停才显示边框与输入底色：守住位置 芯片类名；改错故障 静态行看起来像可编辑输入框。',
      '// INV-03 条件行允许换行且保持最小高度：守住位置 行类名；改错故障 窄容器下文字被裁切。',
      '// INV-04 尾部说明使用最淡前景色：守住位置 尾部常量；改错故障 次要信息抢走主句注意力。',
      '// INV-05 原值尾巴只在字段被改过时渲染：守住位置 父组件条件；改错故障 未修改也显示恢复按钮。',
      '// INV-06 重置按钮只有图标，必须同时提供读屏标签与悬停标题：守住位置 两个属性；改错故障 读屏无法识别操作。',
      '// INV-07 重置按钮的禁用态由外部统一控制：守住位置 disabled 入参；改错故障 清理过程中仍可点击。',
      '// INV-08 上界尾句按默认并发分三种文案：守住位置 tail 三元分支；改错故障 未设默认值时显示错误提示。',
      '// INV-09 等于默认并发时显示「默认」而不是数值：守住位置 相等分支；改错故障 两个不同数值显示同一文案。',
      '// INV-10 原值为空时文案使用「无」而不是空串：守住位置 initialText；改错故障 恢复按钮携带空值。',
      '// INV-11 减少按钮在上界为空或等于 1 时禁用：守住位置 禁用表达式；改错故障 减到 0 或对空值操作。',
      '// INV-12 增加按钮在上界为空时禁用：守住位置 禁用表达式；改错故障 从空值直接跳到 1。',
      '// INV-13 数值输入只接受有限整数并夹到合法范围：守住位置 onChange；改错故障 NaN 或越界值进入设置。',
      '// INV-14 空值输入显示占位符而不是 0：守住位置 value 计算；改错故障 用户误以为已设置并发。',
      '// INV-15 改过的数值使用中等字重：守住位置 条件类名；改错故障 修改态不可辨认。',
      '// INV-16 纯文本条件行只在有字段时渲染：守住位置 早退判断；改错故障 旧 agent 下出现空容器。',
      '// INV-17 脚本点名模型时文案改为「默认」：守住位置 文案键选择；改错故障 逐个子代理的默认被错误承诺。',
      '// INV-18 模型规范串只进悬停标题，不进入正文：守住位置 title 属性；改错故障 气泡被长规范串撑开。',
      '//',
      '// 模块职责：渲染确认窗里可调并发上界、原值恢复与旧 agent 的纯文本条件行。',
      '// 状态所有权：所有值都由 WorkflowAskSettings 持有；本文件只接收已计算好的展示值。',
      '// 阅读顺序：先看三个类名常量，再读原值尾巴与上界行，最后看纯文本条件行。',
    ],
    blocks: [
      {
        anchor: 'export const WORKFLOW_ASK_CHIP_CLASS_NAME =',
        lines: [
          '芯片默认无边框，悬停才显现交互感。',
          '宽度上限防止长值撑破整行。',
          '内部图标统一为小尺寸。',
          '该常量同时被确认窗其他零件复用。',
        ],
      },
      {
        anchor: 'export function WorkflowAskWasTail({',
        lines: [
          '文案与按钮标签都走国际化。',
          '按钮只显示图标，读屏依赖 aria-label。',
          '悬停标题与读屏标签使用同一文案。',
          '禁用态完全由父组件控制。',
        ],
      },
      {
        anchor: 'export function WorkflowAskBoundLine({',
        lines: [
          '默认并发只用于文案与相等判断，不是步进上界。',
          '尾句、原值文本与三个按钮共用同一格式化函数。',
          '减少与增加都通过统一夹取函数写回。',
          '输入框解析失败时不触发变更。',
          '改过状态同时影响字重与恢复尾巴。',
        ],
      },
      {
        anchor: 'const tail =',
        lines: [
          '未给默认并发时，只区分空值与非空值。',
          '等于默认并发时提示「默认」。',
          '其余情况展示默认数值。',
          '三种文案都走国际化键。',
        ],
      },
      {
        anchor: 'export function WorkflowAskPlainSettings({',
        lines: [
          '两个字段都缺失时整块不渲染。',
          '模型行在上，并发行在下，与可调版本同序。',
          '模型规范串只作为悬停标题。',
          '脚本点名模型时改用「默认」文案。',
        ],
      },
      {
        anchor: 'if (maxConcurrency === undefined && subagentModel === undefined) return null;',
        lines: [
          '旧 agent 可能两个字段都没有。',
          '此时返回空，避免留下空容器。',
          '只要任一字段存在就渲染对应行。',
          '该判断是纯文本条件行的唯一早退点。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/hooks/useWorkspaceProviderConfigFile.ts',
    first: 'import { useCallback, useEffect, useMemo, useRef, useState } from "react";',
    target: 48,
    header: [
      '// INV-01 配置路径必须由任务服务给出，UI 不得自行拼接：守住位置 读取调用；改错故障 路径规则在两端分叉。',
      '// INV-02 工作区作用域直接使用工作区服务：守住位置 解析函数首分支；改错故障 基础作用域被错误覆盖。',
      '// INV-03 基础作用域优先使用基础服务：守住位置 第二分支；改错故障 已就绪的基础服务被绕过。',
      '// INV-04 远程会话缺少基础服务时必须返回空：守住位置 远程分支；改错故障 回退到远端绝对路径，本机无法打开。',
      '// INV-05 远程会话就绪前保持加载态而不是报错：守住位置 空服务分支；改错故障 断连恢复被记录成读取失败。',
      '// INV-06 工作区路径或开关缺失时直接清空状态：守住位置 首段早退；改错故障 旧 provider 的路径继续展示。',
      '// INV-07 每次请求都必须递增版本号：守住位置 请求版本引用；改错故障 旧响应覆盖新 provider 的结果。',
      '// INV-08 发起请求时立即清空路径与存在标记：守住位置 请求前状态写入；改错故障 用户点到上一个 provider 的文件。',
      '// INV-09 成功与失败回调都必须校验销毁标记与版本号：守住位置 两处早退；改错故障 卸载后仍写状态。',
      '// INV-10 卸载时必须置销毁标记：守住位置 清理函数；改错故障 迟到响应触发状态更新警告。',
      '// INV-11 错误消息必须依次尝试消息、名称与字符串化：守住位置 getErrorMessage；改错故障 错误显示为空。',
      '// INV-12 初始状态固定为加载中：守住位置 INITIAL_STATE；改错故障 首帧闪现「文件不存在」。',
      '// INV-13 依赖数组必须覆盖请求涉及的全部输入：守住位置 副作用依赖；改错故障 provider 切换不重新读取。',
      '// INV-14 刷新通过递增版本触发，而不是直接调用读取：守住位置 refresh 回调；改错故障 绕过副作用生命周期。',
      '// INV-15 返回对象在字段未变时保持引用稳定：守住位置 末尾记忆化；改错故障 父级重渲击穿下游 memo。',
      '// INV-16 作用域展示值区分基础与远程两种来源：守住位置 作用域三元表达式；改错故障 日志中的来源标注错误。',
      '// INV-17 工作区 RPC 不可用时不得发起读取：守住位置 可用性判断；改错故障 断连代理被反复访问。',
      '// INV-18 日志必须带工作区、provider、作用域与会话：守住位置 两处日志；改错故障 多窗口问题无法定位。',
      '//',
      '// 模块职责：解析当前工作区与 provider 对应的配置文件路径，并暴露刷新入口。',
      '// 状态所有权：路径、存在标记、加载与错误状态由本 hook 持有；实际文件归任务服务管理。',
      '// 阅读顺序：先看错误格式化与服务解析，再读 hook 入参与副作用，最后看记忆化返回。',
    ],
    blocks: [
      {
        anchor: 'function getErrorMessage(error: unknown): string {',
        lines: [
          '标准错误优先取消息，其次名称。',
          '类错误对象按消息字段读取。',
          '其余值直接字符串化。',
        ],
      },
      {
        anchor: 'const INITIAL_STATE: WorkspaceProviderConfigFileState = {',
        lines: [
          '初始没有路径，也不假设文件存在。',
          '加载态从真开始，避免首帧误报。',
          '错误初始为空。',
        ],
      },
      {
        anchor: 'export function resolveWorkspaceProviderConfigZCodeService(params: {',
        lines: [
          '工作区作用域无条件使用工作区服务。',
          '基础作用域优先使用已就绪的基础服务。',
          '远程会话没有基础服务时返回空，等待就绪。',
          '本地场景最后回退到工作区服务。',
          '该函数是服务选择的唯一分派点。',
        ],
      },
      {
        anchor: 'export function useWorkspaceProviderConfigFile(',
        lines: [
          '入参包含工作区、provider、远程会话与作用域选项。',
          '工作区服务由统一 hook 解析。',
          '远程会话标识与基础服务分别订阅。',
          'RPC 可用性与服务选择都先于读取计算。',
          '返回值只包含状态快照与刷新函数。',
        ],
      },
      {
        anchor: 'useEffect(() => {',
        lines: [
          '每次副作用运行都创建独立销毁标记。',
          '路径缺失、关闭或 RPC 不可用时清空并结束。',
          '服务未就绪时保持加载态，不发起请求。',
          '请求前递增版本并立即清空旧路径。',
          '[并发] 成功与失败回调都同时校验销毁标记与版本号。',
          '依赖变化会重新运行，旧请求自然失效。',
        ],
      },
      {
        anchor: 'return useMemo(',
        lines: [
          '状态字段未变时复用同一对象。',
          '刷新函数引用稳定，可安全下传。',
          '该记忆化避免无关重渲击穿下游 memo。',
          '返回结构保持扁平，便于调用方展开。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/resource-manager/storage/StorageCategoryDetail.tsx',
    first: 'import { ChevronLeft, FolderOpen, Loader2 } from "lucide-react";',
    target: 47,
    header: [
      '// INV-01 分类图标只从集中映射读取：守住位置 图标查找；改错故障 新增分类缺少图标时整页崩溃。',
      '// INV-02 每个根只展示字节数为正的目标分类：守住位置 perRoot 过滤；改错故障 空分类占据版面。',
      '// INV-03 总字节数是各根同类分类之和：守住位置 reduce；改错故障 头部数字与明细不一致。',
      '// INV-04 可清理性取首个根的声明：守住位置 cleanability；改错故障 不同根状态不一致时按钮闪烁。',
      '// INV-05 清理按钮只在可清理且总量为正时出现：守住位置 条件渲染；改错故障 对不可清理分类展示按钮。',
      '// INV-06 清理中必须显示旋转图标并替换文案：守住位置 cleaning 分支；改错故障 用户重复点击。',
      '// INV-07 清理按钮的禁用态由外部统一控制：守住位置 disabled 入参；改错故障 清理中仍可再次触发。',
      '// INV-08 返回按钮始终可用：守住位置 顶部按钮；改错故障 清理进行中无法离开详情。',
      '// INV-09 根路径必须单行截断并保留完整悬停标题：守住位置 title 与类名；改错故障 长路径撑破布局。',
      '// INV-10 条目列表允许为空：守住位置 空数组兜底；改错故障 缺少条目时渲染异常。',
      '// INV-11 更多条目使用固定相对路径识别：守住位置 isMore 判断；改错故障 汇总行被当成普通文件。',
      '// INV-12 更多条目展示条目数而不是路径：守住位置 条件文案；改错故障 出现内部占位路径。',
      '// INV-13 更多条目不得显示定位按钮：守住位置 isMore 分支；改错故障 点击定位到不存在的路径。',
      '// INV-14 定位按钮必须同时提供标题与读屏标签：守住位置 两个属性；改错故障 图标按钮无含义。',
      '// INV-15 定位路径由根路径与相对路径统一拼接：守住位置 joinStoragePath；改错故障 分隔符重复或缺失。',
      '// INV-16 所有字节展示都走统一格式化：守住位置 三处 formatBytes；改错故障 单位与精度不一致。',
      '// INV-17 所有文案都走国际化：守住位置 全部 formatMessage；改错故障 多语言下出现硬编码英文。',
      '// INV-18 列表键使用根标识与相对路径：守住位置 两个 key；改错故障 重复渲染或状态错位。',
      '//',
      '// 模块职责：渲染单个存储分类的详情，包括各根路径、条目列表、清理与定位操作。',
      '// 状态所有权：分类用量与清理状态都来自入参；本组件不持有可变状态。',
      '// 阅读顺序：先看分类聚合，再读头部操作区，最后看按根分组的条目列表。',
    ],
    blocks: [
      {
        anchor: 'export function StorageCategoryDetail({',
        lines: [
          '入参包含分类、各根用量与三个操作回调。',
          '定位回调异步执行，失败由调用方处理。',
          '组件本身不订阅任何全局状态。',
          '所有展示值在这里一次聚合完成。',
          '渲染结果只依赖入参。',
        ],
      },
      {
        anchor: 'const perRoot = roots',
        lines: [
          '对每个根查找当前分类。',
          '只保留存在且字节数为正的分类。',
          '过滤后仍保留根信息，供分组渲染。',
          '总字节数按过滤结果累加。',
          '可清理性取首个根的声明。',
        ],
      },
      {
        anchor: 'const cleanability = perRoot[0]?.category?.cleanability ?? "none";',
        lines: [
          '没有根时按不可清理处理。',
          '该值只控制清理按钮是否出现。',
          '实际清理动作仍由父组件决定。',
        ],
      },
      {
        anchor: '{perRoot.map(({ root, category }) => (',
        lines: [
          '每个根渲染一个独立卡片。',
          '根路径与合计字节数放在卡片头部。',
          '条目按相对路径顺序渲染。',
          '键使用根标识，避免跨根冲突。',
        ],
      },
      {
        anchor: 'const isMore = entry.relativePath === STORAGE_MORE_ENTRIES_PATH;',
        lines: [
          '更多条目是固定的汇总占位。',
          '它展示条目总数而不是真实路径。',
          '该判断同时决定文案与定位按钮。',
          '普通条目直接展示相对路径。',
        ],
      },
      {
        anchor: '{isMore ? null : (',
        lines: [
          '汇总行没有可定位的真实路径。',
          '因此不渲染定位按钮。',
          '普通条目点击后按根路径拼接定位。',
          '定位按钮必须同时具备标题与读屏标签。',
        ],
      },
    ],
  },
];

let index = 0;
for (const spec of specs) {
  const firstItem = { anchor: spec.first, raw: spec.header };
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
    `ZC-deep-b107-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  index += 1;
}
