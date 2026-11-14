// B206 四个文件的注释 spec 生成器。
// 目标行数 = round(code * 0.314) - comment：
//   app-selection-keyboard.ts                    290/58 -> 33
//   browserVirtualClipboardPageScript.ts          98/1  -> 30
//   desktopLinuxAppImageIcon.ts                  108/4  -> 30
//   windowsAumidIcon.ts                          106/3  -> 30
import fs from 'node:fs';

const specs = [
  {
    file: 'apps/zcode-cli/packages/tui/src/app-selection-keyboard.ts',
    target: 33,
    header: [
      '// INV-01 三态分发自上而下且互斥：守住位置 handleSelectionKey 的两次早退；改错故障 等待态按键被列表逻辑吞掉。',
      '// INV-02 等待态只认 Escape：守住位置 handlePendingSelectionKey 的早退；改错故障 请求飞行中还能翻列表。',
      '// INV-03 输入态抢占全部按键：守住位置 selection.input 分支；改错故障 输入参数时退格删掉过滤串。',
      '// INV-04 Escape 语义分级：列表态整体关闭，输入/等待态只退一级；守住位置 三处 escape 分支；改错故障 一次误按丢掉整轮输入。',
      '// INV-05 过滤串变更必须把 selectedIndex 归零：守住位置 三处 selectedIndex: 0；改错故障 旧下标指向新集合里的错误条目。',
      '// INV-06 下标统一走 clampIndex：守住位置 上下移动与提交取值；改错故障 过滤后越界取到 undefined。',
      '// INV-07 不可过滤集合不消费字符与退格：守住位置 filterable === false 判断；改错故障 字符被吞，用户无法输入。',
      '// INV-08 空候选只提示不提交：守住位置 submitSelectedItem 的 !item 分支；改错故障 提交空命令。',
      '// INV-09 禁用项只展示原因：守住位置 disabledReason 分支；改错故障 禁用命令被执行。',
      '// INV-10 提交三路径互斥：输入态、等待态、普通命令；守住位置 submitSelectedItem 的三个分支；改错故障 两种流程叠加。',
      '// INV-11 空白输入不提交且保留输入态：守住位置 value.trim() 判定；改错故障 提交空参数并关闭选区。',
      '// INV-12 提交即发即忘：守住位置 void submitValue；改错故障 失败无人观察且阻塞渲染。',
      '// INV-13 可见窗口跟随选中项：守住位置 visibleSelectionItemWindow 的 startIndex；改错故障 翻页后高亮停在首屏。',
      '// INV-14 脱敏只影响展示：守住位置 selectionInputDisplayValue；改错故障 星号被当成提交内容。',
      '// INV-15 删字符按码点：守住位置 Array.from；改错故障 emoji 被拆成半个代理对。',
      '//',
      '// 模块职责：按 pending / input / 列表三态分发按键，完成过滤、选中推进与提交。',
      '// 阅读顺序：先看三态早退，再看列表移动与过滤，最后看提交三分支与展示辅助。',
    ],
    blocks: [
      {
        anchor: 'export function clampIndex(index: number, length: number): number {',
        lines: [
          'length<=0 返回 0 只是空集合的占位，调用方仍须自己判断是否有候选。',
          '上下移动与提交取值都走这里，避免过滤后长度变化造成越界。',
        ],
      },
      {
        anchor: 'export function visibleSelectionItemWindow(',
        lines: [
          '先夹选中项再算起点，maxStartIndex 保证窗口不会越过尾部。',
          '返回的 selectedIndex 是相对窗口的下标，渲染层可直接使用。',
          '空集合与 maxVisible<=0 都返回空窗口，调用方无需判 null。',
        ],
      },
      {
        anchor: 'export function filterSelectionItems(selection: SelectionState): TuiSelectionItem[] {',
        lines: [
          '不可过滤时返回浅拷贝，调用方不会意外改动 selection.items 本身。',
          '匹配字段覆盖主副标题、meta、命令名与 keywords，input 缺失项自动跳过。',
        ],
      },
      {
        anchor: 'export function printableKey(key: KeyEvent): string | undefined {',
        lines: [
          'ctrl/meta 一律拒绝，避免 Ctrl-U 之类被当成字符追加。',
          '单字符键名优先于 sequence，shift 时转大写，其余回落到 sequence。',
        ],
      },
      {
        anchor: 'export function selectionInputDisplayValue(input: NonNullable<SelectionState["input"]>): string {',
        lines: [
          'mask 宽度按字符数而非终端显示列宽，CJK 与 emoji 的真实占宽并不一致。',
          '超过 24 字符追加省略号，只作提示，不参与提交。',
        ],
      },
      {
        anchor: 'function handleSelectionInputKey(',
        lines: [
          'Enter 提交格式为「命令 + 空格 + 值」，与普通命令文本同构。',
          '退格与 Ctrl-U 只改 input.value，不动过滤串与选中项。',
        ],
      },
      {
        anchor: 'function submitSelectedItem(',
        lines: [
          '需参数的条目把 command/itemId 固化进 input，过滤串清空但选区委保留。',
          '需异步候选的条目先进入等待态再发命令，preserveSelection 防止选区被清掉。',
        ],
      },
    ],
  },
  {
    file: 'packages/desktop/src/main/browserView/browserVirtualClipboardPageScript.ts',
    target: 30,
    header: [
      '// INV-01 只认当前深度活跃元素：守住位置 deepestActiveElement 递归；改错故障 富文本编辑器内层输入框收不到粘贴。',
      '// INV-02 输入目标令牌必须匹配：守住位置 inputTargetToken 比对；改错故障 焦点漂移后把内容粘到别的控件。',
      '// INV-03 空剪贴板直接报错：守住位置 clipboardItems.length 判定；改错故障 静默无操作，调用方以为成功。',
      '// INV-04 优先走原生 paste 事件：守住位置 DataTransfer/ClipboardEvent 可用性判断；改错故障 富文本编辑器丢格式。',
      '// INV-05 原生事件无人处理才回退：守住位置 dispatchEvent 返回值；改错故障 两种写入叠加，文本重复。',
      '// INV-06 回退只认输入框与 contenteditable：守住位置 fallbackPaste 两处类型判断；改错故障 往普通 div 上 execCommand。',
      '// INV-07 只读与禁用控件不写值：守住位置 disabled/readOnly 早退；改错故障 试图改写不可编辑区域。',
      '// INV-08 输入框写入优先走原型 setter：守住位置 prototypeSetter 判定；改错故障 React 受控组件感知不到变更。',
      '// INV-09 有选区就替换选区：守住位置 setRangeText；改错故障 光标中间插入变成追加到末尾。',
      '// INV-10 写完必须派发冒泡 input 事件：守住位置 InputEvent 构造；改错故障 框架状态不同步。',
      '// INV-11 富文本回退优先 HTML：守住位置 html.length 判断；改错故障 富文本降级成纯文本。',
      '// INV-12 跨文档元素按自身 window 判定：守住位置 asElement；改错故障 跨源元素 instanceof 失败。',
      '// INV-13 成功路径统一返回空对象：守住位置 两处 return {}；改错故障 返回值破坏协议约定。',
      '//',
      '// 模块职责：把虚拟剪贴板内容注入页面当前焦点控件，源码整体作为字符串在页面上下文执行。',
      '// 阅读顺序：先看活跃元素定位与令牌校验，再看原生 paste 路径，最后看三档回退写入。',
    ],
    blocks: [
      {
        anchor: 'const asElement = (candidate) => {',
        lines: [
          '跨文档元素必须用自身 defaultView 的 Element 构造判定，不能直接 instanceof 全局 Element。',
          'ownerDocument 缺失的代理对象一律视为非元素。',
        ],
      },
      {
        anchor: 'const deepestActiveElement = (root) => {',
        lines: [
          'shadowRoot 存在时优先向内递归，找不到再回退到宿主元素。',
          '读取 contentDocument 可能抛跨源异常，此时退回 frame 元素本身。',
        ],
      },
      {
        anchor: 'const fallbackPaste = (target, html, text, replaceInputValue) => {',
        lines: [
          'setRangeText 在部分控件上不可用，失败后退回整体赋值。',
          'contenteditable 用 execCommand 保留富文本，空 html 时降级插入纯文本。',
        ],
      },
      {
        anchor: 'const textForMime = (items, mimeType) =>',
        lines: [
          '同一 mime 取第一个条目，缺失时返回空串而不是 undefined。',
          'flatMap 展平所有条目的 entries，顺序即写入顺序。',
        ],
      },
      {
        anchor: 'if (options.inputTargetToken != null) {',
        lines: [
          '令牌由宿主在聚焦时写入元素属性，这里只做一致性校验。',
          '不匹配直接抛错，宁可失败也不粘错位置。',
        ],
      },
      {
        anchor: 'for (const item of options.clipboardItems)',
        lines: [
          '只用字符串条目构造 DataTransfer，其余类型在页面侧无法还原。',
          'bubbles/composed 必须开启，否则编辑器无法拦截或跨 shadow 传播。',
        ],
      },
      {
        anchor: 'if (target.dispatchEvent(pasteEvent))',
        lines: [
          '返回 true 表示无人取消默认行为，说明编辑器没接管，需要回退写入。',
          '返回 false 表示编辑器已处理，不能再写一遍。',
        ],
      },
    ],
  },
  {
    file: 'packages/desktop/src/main/desktopLinuxAppImageIcon.ts',
    target: 30,
    header: [
      '// INV-01 图标安装是可选增强：守住位置 installLinuxAppImageDesktopIconBestEffort 的 try/catch；改错故障 图标失败连累 deep link 注册。',
      '// INV-02 未以 AppImage 运行就不安装：守住位置 APPIMAGE 判定；改错故障 deb 安装被写入重复图标。',
      '// INV-03 源图标缺失只告警不创建：守住位置 existsSync 早退；改错故障 生成空图标文件。',
      '// INV-04 目标路径固定为 hicolor/512x512/apps：守住位置 resolveLinuxUserIconFilePath；改错故障 任务栏按名字找不到图标。',
      '// INV-05 内容相同不复制：守住位置 copyFileIfChanged 比较；改错故障 每次启动都重写文件并触发缓存刷新。',
      '// INV-06 未变更不刷新缓存：守住位置 changed 早退；改错故障 启动期无谓调用 gtk-update-icon-cache。',
      '// INV-07 缓存刷新失败只告警：守住位置 三个 warn 分支；改错故障 图标已就位却被判安装失败。',
      '// INV-08 只刷新用户级 hicolor 目录：守住位置 join 出来的路径；改错故障 扫描系统图标拖慢启动。',
      '// INV-09 命令执行可注入：守住位置 runCommand 默认值；改错故障 测试真的去 spawn 外部进程。',
      '// INV-10 超时单独识别：守住位置 signal === "SIGTERM"；改错故障 超时被当成普通非零退出。',
      '// INV-11 结果三态明确：守住位置 installed/changed 两个字段；改错故障 调用方无法区分跳过与失败。',
      '// INV-12 源与目标路径不重叠：守住位置 常量拼接；改错故障 复制到自身导致内容截断。',
      '//',
      '// 模块职责：AppImage 直跑时在用户级 hicolor 目录补齐应用图标，并尽力刷新图标缓存。',
      '// 阅读顺序：先看路径解析与内容比较，再看缓存刷新的三个告警分支，最后看 best-effort 包装。',
    ],
    blocks: [
      {
        anchor: 'function resolveLinuxUserIconFilePath(dataDir: string): string {',
        lines: [
          '路径必须与 desktop entry 的图标名同尺寸，否则主题查找落空。',
          '全部落在 dataDir 下，卸载时随用户数据一起清理。',
        ],
      },
      {
        anchor: 'function copyFileIfChanged(sourcePath: string, targetPath: string): boolean {',
        lines: [
          '先比内容再决定是否写，避免 mtime 变化引发无意义的缓存重建。',
          '比较读的是两份完整文件，512x512 PNG 体积可控。',
          '返回 false 表示无需后续刷新，调用方据此短路。',
        ],
      },
      {
        anchor: 'export function shouldInstallAppImageDesktopIcon(params: {',
        lines: [
          '两个条件同时成立才安装：运行时是 AppImage 且打包时带了源图标。',
          'trim 后判空，防止空白字符串通过真值判断。',
        ],
      },
      {
        anchor: 'export function installLinuxAppImageDesktopIcon(params: {',
        lines: [
          '源图标不存在时返回 installed=false，与创建目录失败区分开。',
          'mkdir recursive 覆盖首次运行目录缺失的情况。',
          '图标已存在且内容相同也算 installed=true，只是 changed=false。',
          'changed=false 直接返回，省掉一次外部命令。',
        ],
      },
      {
        anchor: 'if (cacheResult.error) {',
        lines: [
          '命令无法启动单独告警，不当作安装失败。',
          '超时通过 signal 判定，与普通非零退出分开提示。',
          'stderr 只取 trimmed 摘要，避免日志里塞入整段输出。',
        ],
      },
      {
        anchor: 'export function installLinuxAppImageDesktopIconBestEffort(params: {',
        lines: [
          '前置判断已保证 iconSourcePath 非空，try 内不再重复校验。',
        ],
      },
    ],
  },
  {
    file: 'packages/desktop/src/main/windowsAumidIcon.ts',
    target: 30,
    header: [
      '// INV-01 AUMID 只接受 Shell 标识而非路径：守住位置 SAFE_AUMID 正则；改错故障 任意路径被拼进 Powershell 命令。',
      '// INV-02 必须走 SHCreateItemInKnownFolder：守住位置 C# 里的 P/Invoke；改错故障 图标退化成宿主 exe 缩略图。',
      '// INV-03 AppsFolder 的 GUID 固定不可改：守住位置 appsFolder 常量；改错故障 Shell 找不到应用集合。',
      '// INV-04 取图标志固定为 BIGGERSIZEOK 与 ICONONLY：守住位置 GetImage 的 0x5；改错故障 拿到的是缩略图不是应用图标。',
      '// INV-05 GDI 位图必须释放：守住位置 finally 的 DeleteObject；改错故障 句柄泄漏。',
      '// INV-06 COM 对象必须释放：守住位置 finally 的 ReleaseComObject；改错故障 Shell 引用计数只增不减。',
      '// INV-07 失败一律返回 null：守住位置 三处 return null；改错故障 上层拿到半成品图标。',
      '// INV-08 编码参数防注入：守住位置 createEncodedPowerShellArgs；改错故障 引号与换行破坏命令边界。',
      '// INV-09 输出必须是纯 base64：守住位置 字符集正则；改错故障 警告文本被拼进 data URL。',
      '// INV-10 输出体积设上限：守住位置 MAX_ICON_BASE64_CHARS；改错故障 异常大图标撑爆 IPC。',
      '// INV-11 执行超时硬上限 5 秒：守住位置 execute 的 timeoutMs；改错故障 Powershell 挂住主进程。',
      '// INV-12 依赖可注入以便测试：守住位置 默认参数；改错故障 单测被迫真的启动进程。',
      '// INV-13 系统根目录兜底：守住位置 SystemRoot 默认值；改错故障 环境变量缺失时路径解析抛错。',
      '//',
      '// 模块职责：按 AUMID 通过 Shell 接口取出应用真实图标，转成 PNG 的 data URL。',
      '// 阅读顺序：先看 AUMID 校验与 Powershell 调用，再看 C# 取图与资源释放，最后看输出校验。',
    ],
    blocks: [
      {
        anchor: String.raw`const SAFE_AUMID = /^[^\\/\s!]+![^\\/\s!]+$/u;`,
        lines: [
          '形如「包族!应用」的两段式，禁止路径分隔符与空白，杜绝命令拼接面。',
          '常量放在模块顶层，正则无 g 标志，可安全复用。',
        ],
      },
      {
        anchor: 'const WINDOWS_AUMID_ICON_SCRIPT = String.raw`',
        lines: [
          '整段脚本以 EncodedCommand 传入，避免命令行转义问题。',
          'C# 部分只用 System.Drawing 与 shell32，不依赖额外程序集。',
        ],
      },
      {
        anchor: 'int loaded = shellItem.GetImage(new SIZE { cx = 64, cy = 64 }, 0x5, out bitmap);',
        lines: [
          '64x64 足够任务栏与列表展示，再大只会增加传输体积。',
        ],
      },
      {
        anchor: 'if (created != 0 || shellItem == null) Marshal.ThrowExceptionForHR(created);',
        lines: [
          '创建失败直接抛 HRESULT，由 C# 侧统一转成进程非零退出。',
        ],
      },
      {
        anchor: 'interface WindowsAumidIconDependencies {',
        lines: [
          '只有执行器与系统根目录两项，测试可完全替换掉真实进程调用。',
          'execute 返回 stdout 原文，解码与校验都在调用方完成。',
        ],
      },
      {
        anchor: 'const defaultDependencies: WindowsAumidIconDependencies = {',
        lines: [
          'execFile 只接受参数数组，不经过 shell，天然抗注入。',
          'windowsHide 保证不闪黑窗，timeout 直接杀掉挂住的子进程。',
          'SystemRoot 缺失时退回 C 盘默认路径，保证可解析。',
        ],
      },
      {
        anchor: 'if (!SAFE_AUMID.test(normalized)) return null;',
        lines: [
          '非法的 AUMID 不进入外部进程，直接在边界拒绝。',
        ],
      },
      {
        anchor: 'return { iconDataUrl: `data:image/png;base64,${encoded}` };',
        lines: [
          '到这里 encoded 已通过非空、长度与字符集三重校验。',
          '只拼接 data URL，不回传原始字节，避免 IPC 体积翻倍。',
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
    `ZC-deep-b206-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
