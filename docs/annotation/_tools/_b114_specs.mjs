import fs from 'node:fs';

const specs = [
  {
    file: 'packages/desktop/scripts/mcp-apps-host-fixture/retention-main.ts',
    first: 'import { app, BrowserWindow, ipcMain, protocol, webContents } from "electron";',
    target: 44,
    header: [
      '// INV-01 以 argv 传入 root 与 profile：守住位置 首两行解构；改错故障 路径缺失时写入错误目录。',
      '// INV-02 userData 必须在 ready 前设置：守住位置 启动段；改错故障 Electron 使用默认配置目录。',
      '// INV-03 特权 scheme 必须先声明：守住位置 registerSchemesAsPrivileged；改错故障 webview 加载被拒。',
      '// INV-04 沙箱宿主与 preload 分别装配：守住位置 whenReady 首段；改错故障 guest 无法桥接。',
      '// INV-05 窗口隐藏但禁用后台节流：守住位置 BrowserWindow 选项；改错故障 压测时序被打乱。',
      '// INV-06 will-attach-webview 阶段统一配置 guest：守住位置 事件回调；改错故障 越权选项生效。',
      '// INV-07 配置失败必须阻止附加：守住位置 preventDefault；改错故障 非法 guest 被挂载。',
      '// INV-08 sandboxId 在附加事件按队列取用：守住位置 pending 数组；改错故障 guest 与会话错配。',
      '// INV-09 每页注册递增 generation：守住位置 注册闭包；改错故障 宿主判定为陈旧绑定。',
      '// INV-10 应用标识与令牌长度固定：守住位置 instance 字段；改错故障 校验分支提前拒绝。',
      '// INV-11 IPC 只暴露 register 一个方法：守住位置 ipcMain.handle；改错故障 fixture 面被扩大。',
      '// INV-12 容量上限固定 64：守住位置 循环与断言；改错故障 上限回归无法发现。',
      '// INV-13 超限后既不新增也不误释放：守住位置 overflow 三段断言；改错故障 计数漂移被掩盖。',
      '// INV-14 busy 页面不参与 LRU 淘汰：守住位置 task 段断言；改错故障 活跃页被回收。',
      '// INV-15 可见页面不因时长被释放：守住位置 deadline 段；改错故障 前台页被误杀。',
      '// INV-16 隐藏且空闲页面按截止时间释放：守住位置 advance 调用；改错故障 快照泄漏。',
      '// INV-17 释放以 destroyed 事件为准：守住位置 Promise 等待；改错故障 用 sleep 造成偶发失败。',
      '// INV-18 失败必须带栈退出非零：守住位置 catch 分支；改错故障 CI 把错误当通过。',
      '//',
      '// 模块职责：真实 Electron 环境下的插件沙箱 retention 压测 fixture。',
      '// 状态所有权：无持久状态；所有计数与阶段结论只写入结果 JSON。',
      '// 阅读顺序：先看启动装配，再读注册入口，最后看容量、LRU 与截止时间三段断言。',
    ],
    blocks: [
      {
        anchor: 'const [root, profile] = process.argv.slice(2);',
        lines: [
          'root 是打包资源目录。',
          'profile 是隔离的 userData。',
          '两者都由调用方创建。',
          '缺失时以非空断言继续。',
          '本脚本不做参数校验。',
        ],
      },
      {
        anchor: 'const win = new BrowserWindow({',
        lines: [
          '窗口不显示，仅承载 webview。',
          'preload 来自资源目录。',
          '开启 webviewTag 才能挂载 guest。',
          '关闭后台节流保证压测时序。',
          '尺寸只影响布局计算。',
        ],
      },
      {
        anchor: 'win.webContents.on("will-attach-webview", (event, webPreferences, params) => {',
        lines: [
          '附加前由宿主改写 webPreferences。',
          '成功时记录 sandboxId。',
          '失败直接阻止附加。',
          '阻止后计数不应变化。',
          'owner 是承载窗口自身。',
        ],
      },
      {
        anchor: 'const register = (key: string, task: string) =>',
        lines: [
          'generation 每次注册递增。',
          'token 使用随机 UUID。',
          '应用标识为固定长度占位。',
          '工作区路径固定为根。',
        ],
      },
      {
        anchor: 'const started = performance.now();',
        lines: [
          '容量段先填满 64 个 guest。',
          '任务段验证 LRU 与 busy 保护。',
          '结果写入 JSON 供上层断言。',
        ],
      },
    ],
  },
  {
    file: 'packages/desktop/src/main/unreadBadge.ts',
    first: 'type AppBadgeSetter = (count: number) => void;',
    target: 47,
    header: [
      '// INV-01 未读入参只接受非负整数：守住位置 parseWindowUnreadCount；改错故障 负数或小数进入角标。',
      '// INV-02 多窗口计数取最大值而非求和：守住位置 maxWindowUnreadCounts；改错故障 角标随窗口数翻倍。',
      '// INV-03 平台能力判定集中两个函数：守住位置 supports 系列；改错故障 各调用点分支漂移。',
      '// INV-04 macOS 与 Linux 走应用级 badge：守住位置 sync 首分支；改错故障 桌面端角标缺失。',
      '// INV-05 Windows 走窗口级 overlay：守住位置 sync 次分支；改错故障 任务栏没有角标。',
      '// INV-06 其余平台静默不处理：守住位置 两个分支之后；改错故障 未知平台抛错。',
      '// INV-07 overlay 文案 0 表示移除：守住位置 resolveBadgeOverlayLabel；改错故障 清除后仍显示零。',
      '// INV-08 超过 9 统一显示 9 加：守住位置 三元比较；改错故障 长数字挤爆槽位。',
      '// INV-09 徽章图按 32 像素渲染：守住位置 常量；改错故障 高 DPI 下发虚。',
      '// INV-10 点阵字体只覆盖有限字符：守住位置 BADGE_FONT；改错故障 缺字形被静默跳过。',
      '// INV-11 无字形且非圆点直接返回空图：守住位置 提前返回；改错故障 画出空白圆圈。',
      '// INV-12 圆点锚点分两档：守住位置 anchor 选项；改错故障 任务栏圆点悬在图标中部。',
      '// INV-13 右下锚定留 2px 安全边：守住位置 anchorMargin；改错故障 系统缩放吃掉边缘。',
      '// INV-14 输出预乘 BGRA 且圆外透明：守住位置 像素写入；改错故障 底色被遮挡。',
      '// INV-15 混合按 src 不透明短路：守住位置 alpha 255 分支；改错故障 半透明叠出脏色。',
      '// INV-16 越界像素安全裁剪：守住位置 双重边界判断；改错故障 数组越界写坏内存。',
      '// INV-17 抗锯齿用超采样覆盖率：守住位置 renderAntialiasedStatusDotPixels；改错故障 圆边出现硬齿。',
      '// INV-18 徽章图按 label 缓存：守住位置 createWindowsTaskbarOverlayApplier；改错故障 每次更新重复渲染。',
      '//',
      '// 模块职责：未读角标的跨平台换算、任务栏 overlay 像素渲染与窗口应用。',
      '// 状态所有权：纯函数无状态；徽章图缓存由应用器闭包持有。',
      '// 阅读顺序：先看计数与平台分派，再读像素渲染，最后看混合与应用器。',
    ],
    blocks: [
      {
        anchor: 'export function parseWindowUnreadCount(payload: unknown): number | null {',
        lines: [
          '未读入参先做整数与非负校验。',
          '非法输入返回空值。',
          '合法输入原样返回。',
          '该函数是角标链路的唯一入口。',
        ],
      },
      {
        anchor: 'export function maxWindowUnreadCounts(windowUnreadCountMap: ReadonlyMap<number, number>): number {',
        lines: [
          '空映射返回 0。',
          '逐窗口取最大值。',
          '多个窗口上报同一权威计数。',
          '取最大避免角标翻倍。',
        ],
      },
      {
        anchor: 'export function syncUnreadBadgeForPlatform(options: {',
        lines: [
          '先判应用级 badge 能力。',
          '再判窗口级 overlay 能力。',
          '两个分支互斥且都提前返回。',
          '未知平台不产生任何副作用。',
        ],
      },
      {
        anchor: 'export function renderTaskbarBadgePixels(',
        lines: [
          '尺寸、字形缩放与边距都可覆盖。',
          '圆点模式跳过字形收集。',
          '字形总宽决定居中起点。',
          '半径由去掉边距后的可用宽决定。',
          '逐像素先判圆内再判字形。',
        ],
      },
      {
        anchor: 'export function blendBadgeIntoBitmap(options: {',
        lines: [
          '越界行直接跳过。',
          '全透明像素不改底色。',
          '全不透明像素直接覆盖。',
          '半透明按保留比例逐通道混合。',
        ],
      },
      {
        anchor: 'export function renderAntialiasedStatusDotPixels(',
        lines: [
          '默认每像素横向与纵向各四次采样。',
          '圆内采样数换算为覆盖率。',
          '零覆盖像素保持全透明。',
          '四个通道统一乘覆盖率。',
        ],
      },
    ],
  },
  {
    file: 'packages/desktop/src/main/zcodeDataSizeScanner.ts',
    first: 'import { lstat, opendir } from "node:fs/promises";',
    target: 45,
    header: [
      '// INV-01 三个上限都来自请求：守住位置 选项接口；改错故障 调用方无法收紧扫描。',
      '// INV-02 结果状态与部分原因互斥：守住位置 联合类型；改错故障 完整结果带残留原因。',
      '// INV-03 终止信号必须转 AbortError：守住位置 ensureWithinLimits；改错故障 上层收到普通异常。',
      '// INV-04 超时优先于文件上限：守住位置 先判时长再判文件数；改错故障 超时被记成文件上限。',
      '// INV-05 首次目录缺失视为空目录完整：守住位置 首个 opendir 失败分支；改错故障 未初始化数据根被报错。',
      '// INV-06 非首次目录错误计入 scanErrorCount：守住位置 捕获续扫；改错故障 单个坏目录中断整次扫描。',
      '// INV-07 符号链接一律跳过：守住位置 isSymbolicLink；改错故障 循环或越界统计。',
      '// INV-08 目录后进先出：守住位置 directories.pop；改错故障 扫描顺序不可预测。',
      '// INV-09 文件上限只统计普通文件：守住位置 filesScanned 递增；改错故障 目录被计入文件数。',
      '// INV-10 局部 lstat 失败标记 partial：守住位置 内层捕获；改错故障 把下界当完整值上报。',
      '// INV-11 目录句柄必须关闭：守住位置 finally；改错故障 句柄泄漏。',
      '// INV-12 关闭失败不覆盖主错误：守住位置 关闭的 catch；改错故障 真实原因被吞。',
      '// INV-13 io_error 只在无更强原因时使用：守住位置 原因折叠；改错故障 超时被降级。',
      '// INV-14 计时函数可注入：守住位置 now 选项；改错故障 时间上限无法单测。',
      '// INV-15 耗时按单调时间差计算并夹到 0：守住位置 elapsed；改错故障 时钟回拨产生负数。',
      '// INV-16 Worker 外调用不安全：守住位置 文档注释；改错故障 主线程被大目录阻塞。',
      '// INV-17 结果守卫校验五个数值字段：守住位置 isZCodeDataSizeScanResult；改错故障 非法负载进入界面。',
      '// INV-18 完整结果不得带 partialReason：守住位置 守卫分支；改错故障 状态与原因同时成立。',
      '//',
      '// 模块职责：在 Worker 中统计 ZCode 数据根的逻辑字节数并给出完整或部分结果。',
      '// 状态所有权：无长期状态；计数与终止原因都在单次调用闭包内。',
      '// 阅读顺序：先看类型与选项，再读扫描主循环，最后看结果守卫。',
    ],
    blocks: [
      {
        anchor: 'export async function scanZCodeDataDirectory(',
        lines: [
          '根目录作为唯一初始工作项。',
          '所有累计值在闭包内推进。',
          '终止原因只记录非 io 类别。',
          '时长与文件数在上限内均放宽。',
          '返回值始终包含五项计数。',
        ],
      },
      {
        anchor: 'const ensureWithinLimits = (): boolean => {',
        lines: [
          '已中止时立即抛出。',
          '到达时长上限记为超时。',
          '超时返回 false 让调用方退出。',
          '返回 true 表示可以继续。',
          '该函数在每次取值前调用。',
        ],
      },
      {
        anchor: 'while (directories.length > 0 && terminalPartialReason == null) {',
        lines: [
          '终止原因一旦写入即停止外层循环。',
          '每轮先复查时长。',
          '出栈目录为空时跳过。',
          '打开失败按首目录与后续目录分别处理。',
          '遍历条目时再次复查上限。',
        ],
      },
      {
        anchor: 'const partialReason = terminalPartialReason ?? (scanErrorCount > 0 ? "io_error" : null);',
        lines: [
          '文件或时间上限优先。',
          '没有更强原因才回落到 io 错误。',
          '两个原因都为空时结果为完整。',
          '部分结果保留已统计的下界。',
        ],
      },
      {
        anchor: 'export function isZCodeDataSizeScanResult(value: unknown): value is ZCodeDataSizeScanResult {',
        lines: [
          '非对象直接拒绝。',
          '五个计数字段必须是非负有限数。',
          '完整状态不允许出现部分原因。',
          '部分状态的原因必须是三个枚举之一。',
        ],
      },
    ],
  },
  {
    file: 'packages/provider/src/config/schema.ts',
    first: 'import { z } from "zod";',
    target: 44,
    header: [
      '// INV-01 所有入口都先经 zod 校验：守住位置 parse 系列首步；改错故障 非法形状进入领域层。',
      '// INV-02 内置、个人与账号是三种来源：守住位置 三组 parse 函数；改错故障 规则互相覆盖。',
      '// INV-03 账号配置只取成员与权益：守住位置 pick 字段；改错故障 磁盘规则被当运行时事实。',
      '// INV-04 账号访问信息可为空：守住位置 nullable 与 optional；改错故障 无权益账号解析失败。',
      '// INV-05 规则数组到映射保持原顺序：守住位置 ProviderConfigMap 构造；改错故障 覆盖优先级漂移。',
      '// INV-06 模板映射以 templateId 为键：守住位置 createTemplateRules；改错故障 同模板被覆盖。',
      '// INV-07 模型规则按五类来源拼接：守住位置 内置模型分支；改错故障 某类规则丢失。',
      '// INV-08 个人模型只有两类：守住位置 个人分支；改错故障 混入内置来源。',
      '// INV-09 type 字段在构造时显式声明：守住位置 as const；改错故障 联合类型被放宽成字符串。',
      '// INV-10 访问配置按 type 分派子类：守住位置 createProviderConfig；改错故障 智谱账号被当 API Key。',
      '// INV-11 空访问配置原样保留：守住位置 空值判断；改错故障 空值被替换成默认对象。',
      '// INV-12 api 配置同样按需构造：守住位置 api 三元；改错故障 空 api 生成空壳实例。',
      '// INV-13 模型配置统一走工厂：守住位置 createModelConfig；改错故障 不同来源字段语义不一致。',
      '// INV-14 解析函数不吞异常：守住位置 直接返回 parse 结果；改错故障 上层无法区分配置错误。',
      '// INV-15 校验只复用严格 schema：守住位置 rule-data-schema；改错故障 未知字段被静默忽略。',
      '// INV-16 解析不修改入参：守住位置 展开后重建；改错故障 调用方数据被意外改写。',
      '// INV-17 账号映射用非空字符串键：守住位置 record 约束；改错故障 空 providerId 进入映射。',
      '// INV-18 本文件不持有运行时状态：守住位置 纯函数边界；改错故障 解析结果被缓存共享。',
      '//',
      '// 模块职责：把磁盘与账号的原始配置解析为 Provider 与 Model 领域对象。',
      '// 状态所有权：无状态；所有产物都是新建实例，不缓存也不回写入参。',
      '// 阅读顺序：先看账号片段与各 parse 入口，再看规则转换，最后看两个构造器。',
    ],
    blocks: [
      {
        anchor: 'const accountProviderConfigSchema = providerConfigDataSchema',
        lines: [
          '账号片段只保留成员字段。',
          '访问信息可空。',
          '该片段不参与磁盘规则解析。',
          '仅用于运行时事实。',
        ],
      },
      {
        anchor: 'export function parseProviderConfigMap(input: unknown): ProviderConfigMap {',
        lines: [
          '规则数组先校验再转换。',
          '内置入口与个人入口结构不同。',
          '账号入口只接受成员与权益。',
          '单条配置交由统一构造器。',
          '所有入口返回同类映射。',
        ],
      },
      {
        anchor: 'export function parseZCodeBuiltinModelConfigRules(input: unknown): ModelConfigRules {',
        lines: [
          '五类规则依次展开。',
          '每类都补上稳定的 type 字面量。',
          '配置本体交由模型工厂。',
          '拼接顺序即查找优先级。',
          '结果包装为规则集合。',
        ],
      },
      {
        anchor: 'function createProviderRules(rules: readonly ProviderConfigRuleData[]): ProviderConfigMap {',
        lines: [
          '逐条剥离 config 字段。',
          '其余规则字段原样保留。',
          '配置交给统一构造器。',
          '结果保持输入顺序。',
        ],
      },
      {
        anchor: 'function createProviderConfig(config: z.infer<typeof providerConfigDataSchema>): ProviderConfig {',
        lines: [
          '先展开原始字段。',
          '空访问配置原样透传。',
          '非智谱类型包装为 API Key 配置。',
          '智谱类型包装为账号配置。',
        ],
      },
    ],
  },
  {
    file: 'packages/shared/src/feedbackPrivacy.ts',
    first: '/** 仅用于用户反馈的排障材料；不得应用到模型请求或认证载荷。 */',
    target: 45,
    header: [
      '// INV-01 只用于反馈材料：守住位置 顶部说明；改错故障 被误用于请求或认证载荷。',
      '// INV-02 键名先归一再去匹配：守住位置 normalizeKey；改错故障 变体命名绕过敏感名单。',
      '// INV-03 敏感键与诊断正文键分级：守住位置 shouldRedactKey；改错故障 普通模式漏掉正文。',
      '// INV-04 带引号字段与无引号字段同判：守住位置 fieldKeys；改错故障 引号形式逃逸。',
      '// INV-05 无法解码的键仍按字面处理：守住位置 解析失败分支；改错故障 转义键名绕过。',
      '// INV-06 URL 凭据在任何位置都要清除：守住位置 shouldRedactUrlPath；改错故障 webhook 路径泄露。',
      '// INV-07 带签名参数的查询串整体判敏感：守住位置 参数名判定；改错故障 签名链接外泄。',
      '// INV-08 无法解码的路径按不安全处理：守住位置 捕获分支；改错故障 编码形式绕过。',
      '// INV-09 认证头与私钥先整体替换：守住位置 redactValues 前两步；改错故障 跨行密钥残留。',
      '// INV-10 键值对按分隔符替换值：守住位置 正则替换；改错故障 值保留原文。',
      '// INV-11 路径统一替换为用户占位：守住位置 最后一条替换；改错故障 本机路径泄露。',
      '// INV-12 诊断模式额外替换邮箱：守住位置 diagnostic 分支；改错故障 反馈含个人信息。',
      '// INV-13 递归深度上限 32：守住位置 scrubValue 与 redactText；改错故障 深层对象导致栈溢出。',
      '// INV-14 对象按键判定后递归清洗：守住位置 fromEntries；改错故障 值已脱敏而键仍泄露。',
      '// INV-15 纯文本按行二次判定：守住位置 redactPlainText；改错故障 已替换值被再次切断。',
      '// INV-16 JSON 片段按括号配对截取：守住位置 jsonFragmentEnd；改错故障 截断对象漏值。',
      '// INV-17 片段解析失败整行舍弃：守住位置 内层捕获；改错故障 半截值泄露。',
      '// INV-18 公开入口只接受文本与诊断开关：守住位置 redactFeedbackText；改错故障 调用方绕过管道。',
      '//',
      '// 模块职责：反馈排障文本的脱敏管道，覆盖结构化与半结构化日志。',
      '// 状态所有权：无状态；全部替换基于入参文本生成新字符串。',
      '// 阅读顺序：先看键名判定，再读值级清洗，最后看片段切分与公开入口。',
    ],
    blocks: [
      {
        anchor: 'const REDACTED = "[REDACTED]";',
        lines: [
          '本文件是纯函数管道。',
          '不读取磁盘也不发送网络。',
          '所有替换都保持原文结构。',
          '占位符为固定常量。',
          '调用方只传入文本与模式。',
        ],
      },
      {
        anchor: 'function shouldRedactUrlPath(url: URL, diagnostic: boolean): boolean {',
        lines: [
          '诊断模式一律视为敏感。',
          '含 userinfo 或密码即敏感。',
          'Slack webhook 主机整体敏感。',
          '签名类查询参数同样敏感。',
          '路径段按敏感名与动作名判断。',
        ],
      },
      {
        anchor: 'function redactValues(text: string, diagnostic: boolean): string {',
        lines: [
          '认证头优先整体替换。',
          '私钥块跨行匹配。',
          'Bearer 令牌保留前缀。',
          '键值对按分隔符保留结构。',
          'URL 的路径、查询与片段清空。',
        ],
      },
      {
        anchor: 'function scrubValue(value: unknown, diagnostic: boolean, depth = 0): unknown {',
        lines: [
          '超深直接整体替换。',
          '字符串回到完整文本管道。',
          '数组逐项递归。',
          '对象先按键判定再递归。',
        ],
      },
      {
        anchor: 'export function redactFeedbackText(text: string, options: { diagnostic?: boolean } = {}): string {',
        lines: [
          '诊断开关缺省为关闭。',
          '深度从 0 开始。',
          '其余逻辑全部复用内部函数。',
          '返回值为脱敏后的新字符串。',
        ],
      },
    ],
  },
  {
    file: 'packages/shared/src/gen-ui/tweakProtocol.ts',
    first: 'import { z } from "zod";',
    target: 45,
    header: [
      '// INV-01 控件类型由判别联合收窄：守住位置 genUiAnnotationControlSchema；改错故障 未知类型进入下游。',
      '// INV-02 四种控件共享三项基础字段：守住位置 base 常量；改错故障 各类型字段不一致。',
      '// INV-03 回调名长度受限且必填：守住位置 callback 约束；改错故障 超长回调进入消息。',
      '// INV-04 颜色值只接受十六进制：守住位置 正则；改错故障 任意字符串被当颜色。',
      '// INV-05 选择项数量限制在 1 到 12：守住位置 options 约束；改错故障 浮层被无限撑开。',
      '// INV-06 每个控件都拒绝未知字段：守住位置 strict；改错故障 字段污染被静默接受。',
      '// INV-07 值校验与类型分支一一对应：守住位置 isGenUiAnnotationValue；改错故障 越界值被提交。',
      '// INV-08 回调名在控件间必须唯一：守住位置 superRefine；改错故障 两个控件共用回调。',
      '// INV-09 控件当前值必须自洽：守住位置 同一 refine；改错故障 初始值越界。',
      '// INV-10 序列化长度上限 16384：守住位置 refine 最后一项；改错故障 大载荷进入 IPC。',
      '// INV-11 目标只允许单个：守住位置 targets 长度约束；改错故障 多目标请求被接受。',
      '// INV-12 目标矩形宽高非负：守住位置 rect 约束；改错故障 负尺寸进入布局。',
      '// INV-13 注册与更新共用同一结构：守住位置 registration 常量；改错故障 两种消息字段漂移。',
      '// INV-14 销毁与选择只带定位字段：守住位置 后三类消息；改错故障 变更被顺带提交。',
      '// INV-15 转义消息不带任何数据：守住位置 escape 分支；改错故障 取消仍触发更新。',
      '// INV-16 结果只包含可选控件块：守住位置 genUiTweakResultSchema；改错故障 多余字段外泄。',
      '// INV-17 批注变更数量上限 64：守住位置 changes 约束；改错故障 单次提交过大。',
      '// INV-18 类型均由 schema 推导：守住位置 infer；改错故障 手写类型与校验分叉。',
      '//',
      '// 模块职责：GenUI tweak 消息、控件、结果与批注的协议定义。',
      '// 状态所有权：无状态；只有 schema 与由其推导的类型。',
      '// 阅读顺序：先看控件联合，再读注册结构与消息联合，最后看结果与批注。',
    ],
    blocks: [
      {
        anchor: 'const value = z.union([z.string(), z.number().finite(), z.boolean()]);',
        lines: [
          '本文件只有 schema 与纯校验。',
          '不依赖 React 或运行时环境。',
          '所有长度上限都是硬约束。',
          '导出类型全部由 schema 推导。',
          '消息与结果分两组导出。',
        ],
      },
      {
        anchor: 'export function isGenUiAnnotationValue(',
        lines: [
          '区间控件只接受有限数字且落在边界内。',
          '颜色控件复用同一正则。',
          '开关控件只接受布尔值。',
          '选择控件要求值命中某一项。',
          '分支穷尽后返回布尔判定。',
        ],
      },
      {
        anchor: 'const annotationControls = z',
        lines: [
          '控件数量同样限制在 1 到 12。',
          '回调集合大小必须等于控件数量。',
          '每个控件当前值都要通过自洽校验。',
          '整体序列化长度设上限。',
          '任一条件不满足即整体拒绝。',
        ],
      },
      {
        anchor: 'export const genUiTweakMessageSchema = z.discriminatedUnion("type", [',
        lines: [
          '注册与更新复用同一注册结构。',
          '销毁只带注册标识。',
          '选择额外带目标标识。',
          '转义消息不携带负载。',
        ],
      },
      {
        anchor: 'export const genUiTweakAnnotationSchema = z',
        lines: [
          '激活态为布尔值。',
          '选择可为空。',
          '变更数组上限 64。',
          '每条变更的控件变更上限 12。',
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
    `ZC-deep-b114-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  index += 1;
}
