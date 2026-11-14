import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/browser-use/useBrowserScreenshotSurfaceReady.ts',
    target: 39,
    header: [
      '// INV-01 窗口被遮挡时不能只靠 rAF：守住位置 timer 竞速；改错故障 后台窗口永远超时。',
      '// INV-02 一次验证两路竞速：守住位置 verify；改错故障 rAF 与 timer 双重上报。',
      '// INV-03 取消即作废旧验证：守住位置 版本号自增；改错故障 旧回调触发 ready。',
      '// INV-04 截止时间兜底停止重试：守住位置 retry；改错故障 死循环请求动画帧。',
      '// INV-05 guest 不一致就重试：守住位置 guestId 比对；改错故障 截到旧页面。',
      '// INV-06 viewport 未对齐就重试：守住位置 像素比对；改错故障 截到错误尺寸。',
      '// INV-07 连续两帧一致才上报：守住位置 firstFrame；改错故障 尺寸仍在变化就截图。',
      '// INV-08 只上报一次：守住位置 reported 标记；改错故障 重复 ready 握手。',
      '// INV-09 尺寸变化重启验证：守住位置 ResizeObserver；改错故障 沿用过期稳定帧。',
      '// INV-10 dom-ready 重启验证：守住位置 事件监听；改错故障 guest 重挂后不再验证。',
      '// INV-11 回到前台重启验证：守住位置 visibilitychange；改错故障 恢复可见仍用旧帧。',
      '// INV-12 卸载后不再上报：守住位置 disposed 标记；改错故障 组件已卸载仍调用平台。',
      '// INV-13 超时取请求值优先：守住位置 超时解析；改错故障 忽略主进程下发的超时。',
      '// INV-14 释放宽限单独计时：守住位置 verifyDeadlineMs；改错故障 Release 丢失后循环不退。',
      '// INV-15 负缩放先还原布局尺寸：守住位置 layoutScale 换算；改错故障 逻辑 viewport 偏小。',
      '// INV-16 表面缩放必须稳定：守住位置 sameSurface；改错故障 缩放动画中截图。',
      '// INV-17 未收窄引用固定复用：守住位置 activeRequest 与 activeWebview；改错故障 闭包读到空值。',
      '// INV-18 依赖变化重跑整个验证：守住位置 effect 依赖；改错故障 切换标签后仍验证旧 webview。',
      '//',
      '// 模块职责：在后台合成层中等候两个稳定帧，再向平台上报截图 surface 就绪。',
      '// 状态所有权：验证状态全部封装在 effect 闭包内，随组件卸载销毁。',
      '// 阅读顺序：先看就绪入口，再看竞速与重试，最后看三个重启触发点。',
    ],
    blocks: [
      {
        anchor: 'export function useBrowserScreenshotSurfaceReady({',
        lines: [
          '请求或 webview 缺失时直接返回。',
          '收窄后的引用固定给整个验证链。',
          '所有监听在卸载时统一拆除。',
          '超时取请求值优先。',
        ],
      },
      {
        anchor: 'function verify(): void {',
        lines: [
          'rAF 与 timer 竞速同一次检查。',
          '先自增版本作废旧回调。',
          '已上报或已卸载则不再调度。',
        ],
      },
      {
        anchor: 'function retry(): void {',
        lines: [
          '超过截止时间即停止重试。',
          '停止时记录一次告警。',
          '未超时则重新发起验证。',
        ],
      },
      {
        anchor: 'function runVerification(): void {',
        lines: [
          'guest 不一致就等待重试。',
          'viewport 未对齐就等待重试。',
          '连续两帧一致才上报。',
          '上报后标记为已上报。',
        ],
      },
      {
        anchor: 'function restartVerification(): void {',
        lines: [
          '尺寸或挂载变化时清空稳定帧。',
          '重置后立即重新验证。',
          '已上报或已卸载则忽略。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/ControlHintTooltip.tsx',
    target: 38,
    header: [
      '// INV-01 触发元素直接合并 ref：守住位置 cloneElement；改错故障 SlotClone 渲染栈错误。',
      '// INV-02 回调 ref 身份稳定：守住位置 useCallback 依赖；改错故障 每次渲染触发更新循环。',
      '// INV-03 双 ref 同时转发：守住位置 setRef 两次；改错故障 外部拿不到触发器引用。',
      '// INV-04 非元素子节点包 span：守住位置 三元分支；改错故障 文本触发器无法挂载。',
      '// INV-05 有描述时改纵向布局：守住位置 description 判断；改错故障 标题与快捷键挤压。',
      '// INV-06 无描述允许自然换行：守住位置 whitespace 类；改错故障 长文案被裁剪。',
      '// INV-07 快捷键仅在无描述时下排：守住位置 条件渲染；改错故障 徽标重复出现。',
      '// INV-08 共享 Provider 不逐项创建：守住位置 Root 级 Provider；改错故障 上下文树放大到消息数量级。',
      '// INV-09 独立渲染按需补 Provider：守住位置 standalone 分支；改错故障 SSR 与单测缺少上下文。',
      '// INV-10 侧栏统一延迟三百毫秒：守住位置 delayDuration；改错故障 连续划过跳过等待。',
      '// INV-11 侧栏禁用悬停内容：守住位置 disableHoverableContent；改错故障 移动鼠标时提示闪烁。',
      '// INV-12 侧栏范围用上下文标记：守住位置 SidebarTooltipContext；改错故障 其它页面行为被改变。',
      '// INV-13 非侧栏原样透传插槽：守住位置 inSidebar 判断；改错故障 普通按钮丢失原生 title。',
      '// INV-14 去掉原生 title 防重复：守住位置 cloneElement 覆盖；改错故障 原生提示与自定义提示叠加。',
      '// INV-15 收缩场景不继承 shrink-0：守住位置 triggerClassName；改错故障 图标按钮撑开菜单行。',
      '// INV-16 禁用元素外包一层 span：守住位置 disabled 分支；改错故障 禁用按钮无法触发提示。',
      '// INV-17 提示内容单一出口：守住位置 tooltip 常量；改错故障 组合逻辑散落多处。',
      '// INV-18 触发器类名与外部合并：守住位置 cn 调用；改错故障 业务自定义样式被覆盖。',
      '//',
      '// 模块职责：包装 Radix Tooltip，统一标题、描述、快捷键与侧栏延迟语义。',
      '// 状态所有权：提示开关可由外部受控；其余为渲染期派生值。',
      '// 阅读顺序：先看引用合并，再看主组件，最后看侧栏两个变体。',
    ],
    blocks: [
      {
        anchor: 'function setRef<T>(ref: Ref<T> | undefined, value: T | null) {',
        lines: [
          '空引用直接忽略。',
          '函数引用按回调调用。',
          '对象引用写入 current。',
          '不返回值。',
        ],
      },
      {
        anchor: 'export function ControlHintTooltip({',
        lines: [
          '稳定回调 ref 身份。',
          '同时转发子元素与外部引用。',
          '共享 Provider 放在 Root。',
          '独立渲染时才补 Provider。',
        ],
      },
      {
        anchor: 'export function SidebarTooltipProvider({ children }: { children: ReactNode }) {',
        lines: [
          '侧栏统一三百毫秒延迟。',
          '连续划过不跳过等待。',
          '禁用悬停内容避免闪烁。',
          '用上下文标记侧栏范围。',
        ],
      },
      {
        anchor: 'export function SidebarNativeTooltip({',
        lines: [
          '非侧栏原样透传插槽。',
          '去掉原生 title 防重复。',
          '收缩场景不继承 shrink-0。',
          '禁用元素外包一层 span。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/embeddedBrowserHelpers.ts',
    target: 40,
    header: [
      '// INV-01 仅可恢复原因才原位恢复：守住位置 集合判断；改错故障 完整性失败进入无限重建。',
      '// INV-02 未挂载错误在边界吞掉：守住位置 isWebviewDetachedError；改错故障 全局异常量被单点打满。',
      '// INV-03 其余错误继续抛出：守住位置 重新抛出；改错故障 真正的 bug 被静默。',
      '// INV-04 回退值由调用方给出：守住位置 fallback 参数；改错故障 调用方拿到 undefined。',
      '// INV-05 内置浏览器白名单更宽：守住位置 协议集合；改错故障 about 与 file 无法打开。',
      '// INV-06 默认浏览器只接受三种协议：守住位置 显式比较；改错故障 内联协议被交给系统。',
      '// INV-07 显式协议优先判定：守住位置 hasAllowedExplicitProtocol；改错故障 地址被错误补全。',
      '// INV-08 非法协议直接拒绝：守住位置 hasDisallowedExplicitProtocol；改错故障 javascript 协议被执行。',
      '// INV-09 无协议输入按地址栏习惯补全：守住位置 inferBrowserUrl；改错故障 localhost 被补成 https。',
      '// INV-10 本机与私网默认走 HTTP：守住位置 isLocalDevelopmentHost；改错故障 开发端口无法访问。',
      '// INV-11 其它端口非 443 也走 HTTP：守住位置 端口判断；改错故障 自定义端口连不上。',
      '// INV-12 裸 IPv6 回环补方括号：守住位置 normalizeBareIpv6LoopbackInput；改错故障 解析失败。',
      '// INV-13 证书错误按区间识别：守住位置 上下界常量；改错故障 DNS 失败被提示忽略证书。',
      '// INV-14 链接目标显式标志优先：守住位置 forceExternal；改错故障 右键两项行为重复。',
      '// INV-15 左键按本机启发式分流：守住位置 末尾三元；改错故障 公网链接在应用内打开。',
      '// INV-16 初始状态集中声明：守住位置 INITIAL_BROWSER_STATE；改错故障 首帧字段缺失。',
      '// INV-17 加载错误与 guest 失败分开：守住位置 两个字段；改错故障 可恢复错误被当成进程级失败。',
      '// INV-18 展示用地址隐藏空白页：守住位置 displayBrowserUrl；改错故障 地址栏出现 about:blank。',
      '//',
      '// 模块职责：内置浏览器的 URL 归一化、协议白名单、本机判定与 guest 生命周期容错。',
      '// 状态所有权：无状态；所有导出均为纯函数或常量。',
      '// 阅读顺序：先看 guest 容错，再看协议与 URL 归一化，最后看本机与链接分流。',
    ],
    blocks: [
      {
        anchor: 'export function isRecoverableBrowserGuestExitReason(reason: string): boolean {',
        lines: [
          '只有可恢复原因才允许重建。',
          '完整性失败不进入重建循环。',
          '未知原因一律不恢复。',
          '集合外新增原因需显式登记。',
        ],
      },
      {
        anchor: 'export function isWebviewDetachedError(error: unknown): boolean {',
        lines: [
          '先取出可读消息。',
          '空消息直接判否。',
          '命中片段才算生命周期竞态。',
        ],
      },
      {
        anchor: 'export function safeWebviewCall<T>(',
        lines: [
          '正常调用直接返回结果。',
          '生命周期竞态回退到兜底值。',
          '命中时可回调记录。',
          '其余错误继续向上抛。',
        ],
      },
      {
        anchor: 'export interface BrowserState {',
        lines: [
          '加载错误与 guest 失败分开。',
          '地址与标题随导航更新。',
          '就绪与加载中互不覆盖。',
          '初始值集中声明。',
        ],
      },
      {
        anchor: 'export function normalizeBrowserUrl(input: string): string | null {',
        lines: [
          '空输入返回空。',
          '非法协议直接拒绝。',
          '无协议按地址栏习惯补全。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/lib/chatSessionScrollMemory.ts',
    target: 38,
    header: [
      '// INV-01 容量上限固定两百条：守住位置 MAX_ENTRIES；改错故障 内存随会话数无界增长。',
      '// INV-02 命中即移到队尾：守住位置 delete 再 set；改错故障 常用会话被优先淘汰。',
      '// INV-03 超限从最旧开始淘汰：守住位置 prune 循环；改错故障 一次性清空全部。',
      '// INV-04 工作区身份优先于路径：守住位置 空值合并；改错故障 同一工作区分裂成两个桶。',
      '// INV-05 面板参与隔离键：守住位置 paneScope；改错故障 左右分栏共享滚动位置。',
      '// INV-06 会话优先于任务：守住位置 sessionScope；改错故障 同一会话出现两个桶。',
      '// INV-07 都缺失时返回空：守住位置 末尾三元；改错故障 生成全局共享键。',
      '// INV-08 任务桶迁移到会话桶：守住位置 migrate；改错故障 元数据补齐后位置丢失。',
      '// INV-09 已存在的会话桶不覆盖：守住位置 has 判断；改错故障 旧位置覆盖新位置。',
      '// INV-10 迁移后删除任务桶：守住位置 delete 调用；改错故障 旧桶继续占用容量。',
      '// INV-11 迁移时间戳刷新：守住位置 updatedAt；改错故障 刚迁移的条目被优先淘汰。',
      '// INV-12 读取也刷新顺序：守住位置 touch；改错故障 恢复后立刻被淘汰。',
      '// INV-13 保存后立即裁剪：守住位置 prune 调用；改错故障 容量延迟一轮才生效。',
      '// INV-14 恢复位置夹在合法区间：守住位置 min 与 max；改错故障 滚动到不存在的偏移。',
      '// INV-15 空键读写直接返回：守住位置 早退；改错故障 空键共享同一份状态。',
      '// INV-16 测试清理入口独立：守住位置 clearForTest；改错故障 单测之间互相污染。',
      '// INV-17 键段空白归一：守住位置 normalizeKeyPart；改错故障 前后空格产生新桶。',
      '// INV-18 淘汰时只删最旧一条：守住位置 循环体；改错故障 单次写入清空全部缓存。',
      '//',
      '// 模块职责：按工作区、面板与会话记住聊天滚动位置，并提供有界淘汰与任务桶迁移。',
      '// 状态所有权：模块级 Map 是唯一存储，容量由常量约束。',
      '// 阅读顺序：先看键构造与归一化，再看迁移，最后看读写与淘汰。',
    ],
    blocks: [
      {
        anchor: 'function touchChatSessionScrollMemoryEntry(',
        lines: [
          '先删除再写入。',
          '写入即视为最近使用。',
          '返回同一份状态。',
        ],
      },
      {
        anchor: 'function pruneChatSessionScrollMemory(): void {',
        lines: [
          '超限才进入循环。',
          '每次只淘汰最旧一条。',
          '空键直接停止。',
        ],
      },
      {
        anchor: 'export function buildChatSessionScrollMemoryKey({',
        lines: [
          '身份优先于路径。',
          '面板作为二级隔离。',
          '会话优先于任务。',
          '都缺失时返回空。',
        ],
      },
      {
        anchor: 'export function migrateTaskScrollMemoryToSession({',
        lines: [
          '先分别构造两类键。',
          '已有会话桶不覆盖。',
          '迁移后删除任务桶。',
        ],
      },
      {
        anchor: 'export function readChatSessionScrollMemoryState(',
        lines: [
          '空键直接返回空。',
          '读到即刷新顺序。',
          '未命中不影响容量。',
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
    const anchor =
      block.anchorLine === undefined
        ? block.anchor
        : srcLines[block.anchorLine - 1].replace(/\r$/, '').trim();
    const item = { anchor, lines: block.lines };
    if (block.nth !== undefined) item.nth = block.nth;
    items.push(item);
  }
  const total = spec.header.length + spec.blocks.reduce((n, b) => n + b.lines.length, 0);
  if (total !== spec.target) {
    console.error(`TARGET MISMATCH ${spec.file}: ${total} != ${spec.target}`);
    process.exit(1);
  }
  fs.writeFileSync(
    `ZC-deep-b154-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
