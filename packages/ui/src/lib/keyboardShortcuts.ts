// INV-01 平台隔离：守住位置 主修饰键判断；改错故障：macOS 的 Ctrl 被当作主快捷键，与系统编辑键冲突。
// INV-02 双键排除：守住位置 两侧修饰键互斥；改错故障：命令键与 Ctrl 同按也命中。
// INV-03 未知环境：守住位置 导航器缺失分支；改错故障：服务端渲染直接抛错。
// INV-04 判定顺序：守住位置 平台名优先于用户代理；改错故障：伪装代理导致标签显示错误。
// INV-05 标签一致：守住位置 修饰键标签与匹配判断共用同一平台判定；改错故障：显示与命中不一致。
// INV-06 键归一：守住位置 键名小写比较；改错故障：大小写差异导致快捷键失效。
// INV-07 代码回退：守住位置 按键代码匹配；改错故障：Option 组合在非美式布局下失效。
// INV-08 字母映射：守住位置 字母到代码的构造；改错故障：字母快捷键在布局改写后失效。
// INV-09 数字映射：守住 `1`–`9` 到 `Digit1`–`Digit9` 的构造；改错故障：数字快捷键在布局改写后失效。
// INV-10 括号映射：守住位置 两个括号键的代码；改错故障：括号快捷键在布局改写后失效。
// INV-11 标签不归一：守住位置 括号原样返回；改错故障：括号被大写成无意义字符。
// INV-12 Shift 组合：守住位置 Shift 判定；改错故障：Shift 组合被普通组合抢占。
// INV-13 Alt 组合：`altKey` 判定先于裸键匹配；改错故障：Alt 组合被普通组合抢占。
// INV-14 Ctrl 组合：守住位置 纯 Ctrl 判定；改错故障：Ctrl 组合被主快捷键抢占。
// INV-15 Tab 反向导航：守住位置 Shift+Tab 判定；改错故障：Tab 导航与工具栏快捷键冲突。
// INV-16 修饰符标签：守住位置 平台符号；改错故障：苹果平台显示 Ctrl 字样。
// INV-17 纯函数：守住位置 全部导出；改错故障：读取模块级环境导致测试不可控。
// INV-18 类型最小化：守住位置 事件接口字段；改错故障：调用方需构造完整事件对象。
//
// 模块职责：提供跨平台的快捷键标签格式化与按键匹配纯函数。
// 状态所有权：无状态；平台信息可由调用方注入，缺省时读取当前导航器。
// 阅读顺序：平台判定 → 标签格式化 → 组合键匹配 → 键与代码归一。
export interface KeyboardShortcutPlatformInfo {
  platform?: string;
  userAgent?: string;
}

interface PrimaryShortcutKeyboardEvent {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

// 平台信息来源：服务端渲染或测试环境没有导航器时返回空对象。
// 空对象会让平台判定回落到用户代理，最终得到非苹果分支。
// 只读取平台名与用户代理两个字段，其余信息不参与判断。
//
function readNavigatorPlatformInfo(): KeyboardShortcutPlatformInfo {
  if (typeof navigator === "undefined") {
    return {};
  }

  return {
    platform: navigator.platform,
    userAgent: navigator.userAgent,
  };
}

// 苹果平台判定：平台名包含 mac、iphone、ipad 或 ipod 即成立。
// 平台名缺失时再看用户代理，覆盖浏览器把平台字段留空的情况。
// `isAppleKeyboardPlatform` 只影响标签与修饰键选择，不改变业务行为。
//
export function isAppleKeyboardPlatform(
  platformInfo: KeyboardShortcutPlatformInfo = readNavigatorPlatformInfo(),
): boolean {
  const platform = platformInfo.platform?.toLowerCase() ?? "";
  const userAgent = platformInfo.userAgent ?? "";

  if (
    platform.includes("mac") ||
    platform.includes("iphone") ||
    platform.includes("ipad") ||
    platform.includes("ipod")
  ) {
    return true;
  }

  return /Mac|iPhone|iPad|iPod/.test(userAgent);
}

// 命令修饰键标签：苹果平台用符号，其余平台用 Ctrl 字样。
//
function getCommandModifierLabel(platformInfo?: KeyboardShortcutPlatformInfo): string {
  return isAppleKeyboardPlatform(platformInfo) ? "⌘" : "Ctrl";
}

function getCtrlModifierLabel(platformInfo?: KeyboardShortcutPlatformInfo): string {
  return isAppleKeyboardPlatform(platformInfo) ? "⌃" : "Ctrl";
}

function formatAppleShortcutLabel(...parts: string[]): string {
  return parts.join(" ");
}

// 命令组合标签：苹果平台用空格分隔符号与键名，其余平台用加号连接。
//
export function formatCommandShortcutLabel(
  key: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): string {
  const mod = getCommandModifierLabel(platformInfo);
  if (isAppleKeyboardPlatform(platformInfo)) {
    return formatAppleShortcutLabel(mod, formatShortcutKeyLabel(key));
  }
  return `${mod}+${key.toUpperCase()}`;
}

export function formatAltCommandShortcutLabel(
  key: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): string {
  const isApple = isAppleKeyboardPlatform(platformInfo);
  const command = getCommandModifierLabel(platformInfo);
  if (isApple) {
    return formatAppleShortcutLabel("⌥", command, formatShortcutKeyLabel(key));
  }
  return `Ctrl+Alt+${key.toUpperCase()}`;
}

export function formatShiftCommandShortcutLabel(
  key: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): string {
  const isApple = isAppleKeyboardPlatform(platformInfo);
  const command = getCommandModifierLabel(platformInfo);
  const displayKey = formatShortcutKeyLabel(key);
  if (isApple) {
    return formatAppleShortcutLabel("⇧", command, displayKey);
  }
  return `Ctrl+Shift+${displayKey}`;
}

// 键名展示：`[` 与 `]` 保持原样，其余走 `toUpperCase()`。
//
function formatShortcutKeyLabel(key: string): string {
  switch (key) {
    case "[":
      return "[";
    case "]":
      return "]";
    default:
      return key.toUpperCase();
  }
}

// 主组合匹配：主修饰键成立，且没有 Shift 与 Alt，键名命中。
//
export function matchesPrimaryShortcut(
  event: PrimaryShortcutKeyboardEvent,
  key: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): boolean {
  return (
    matchesPrimaryModifier(event, platformInfo) &&
    !event.shiftKey &&
    !event.altKey &&
    matchesShortcutKey(event, key)
  );
}

// Shift 组合：主修饰键成立且 Shift 按下、Alt 未按下，键名命中。
// Alt 组合同理单独封装，避免调用方手写修饰键判断。
//
export function matchesPrimaryShiftShortcut(
  event: PrimaryShortcutKeyboardEvent,
  key: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): boolean {
  return (
    matchesPrimaryModifier(event, platformInfo) &&
    event.shiftKey &&
    !event.altKey &&
    matchesShortcutKey(event, key)
  );
}

// Alt 组合：主修饰键成立且 Alt 按下、Shift 未按下，键名命中。
// 三种组合互斥，Shift 与 Alt 同时按下时都不命中。
//
export function matchesPrimaryAltShortcut(
  event: PrimaryShortcutKeyboardEvent,
  key: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): boolean {
  return (
    matchesPrimaryModifier(event, platformInfo) &&
    !event.shiftKey &&
    event.altKey &&
    matchesShortcutKey(event, key)
  );
}

// 主修饰键：苹果平台要求命令键且不含 Ctrl，其余平台要求 Ctrl 且不含命令键。
// macOS 的 Ctrl 保留给系统文本编辑，混用会把编辑操作误判成快捷键。
//
function matchesPrimaryModifier(
  event: PrimaryShortcutKeyboardEvent,
  platformInfo?: KeyboardShortcutPlatformInfo,
): boolean {
  const isApple = isAppleKeyboardPlatform(platformInfo);
  // 主快捷键要按平台隔离。macOS 的 Ctrl 保留给系统 Emacs 风格文本编辑，
  // Windows/Linux 才使用 Ctrl；同时按下 Ctrl 和 Command 不视作主快捷键，避免误触发。
  return isApple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export function matchesCtrlShortcut(event: PrimaryShortcutKeyboardEvent, key: string): boolean {
  return (
    event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.altKey &&
    matchesShortcutKey(event, key)
  );
}

export function matchesCtrlShiftShortcut(
  event: PrimaryShortcutKeyboardEvent,
  key: string,
): boolean {
  return (
    event.ctrlKey &&
    !event.metaKey &&
    event.shiftKey &&
    !event.altKey &&
    matchesShortcutKey(event, key)
  );
}

/**
 * 纯 Shift+Tab（不含 Ctrl/Cmd/Alt）匹配工具。
 * 历史上聊天工具栏 mode 曾使用该组合键；保留给仍需要区分反向 Tab 导航的调用方。
 */
export function matchesShiftTab(event: PrimaryShortcutKeyboardEvent): boolean {
  return (
    event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    (event.key === "Tab" || event.code === "Tab")
  );
}

export function formatShiftTabShortcutLabel(platformInfo?: KeyboardShortcutPlatformInfo): string {
  return isAppleKeyboardPlatform(platformInfo) ? formatAppleShortcutLabel("⇧", "Tab") : "Shift+Tab";
}

// 键匹配：先按小写键名比较，命中即返回。
// 未命中时再按物理键代码比较，规避 Option 组合在部分布局下改写键名。
// 代码映射只覆盖字母、数字与两个括号，其余键仍以键名为准。
//
function matchesShortcutKey(
  event: Pick<PrimaryShortcutKeyboardEvent, "key" | "code">,
  key: string,
): boolean {
  const normalizedKey = key.toLowerCase();
  if (event.key.toLowerCase() === normalizedKey) {
    return true;
  }

  // 修复说明：macOS 上按下 Option 参与组合键时，event.key 可能会被当前键盘布局改写成其他字符，
  // 直接按 key 比较会把 ⌥⌘B 这类快捷键误判成未命中。这里补一层 code 匹配，避免受输入法/布局影响。
  const expectedCode = getExpectedShortcutCode(normalizedKey);
  return expectedCode != null && event.code === expectedCode;
}

// 键代码映射：单字符字母映射到 Key 前缀，数字映射到 Digit 前缀，括号单独映射。
//
function getExpectedShortcutCode(key: string): string | null {
  if (key.length === 1) {
    const lower = key.toLowerCase();
    if (lower >= "a" && lower <= "z") {
      return `Key${lower.toUpperCase()}`;
    }
    if (lower >= "0" && lower <= "9") {
      return `Digit${lower}`;
    }
  }

  switch (key) {
    case "[":
      return "BracketLeft";
    case "]":
      return "BracketRight";
    default:
      return null;
  }
}
