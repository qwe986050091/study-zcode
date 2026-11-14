// INV-01 无全局依赖：守住位置 全部注入参数默认值；改错故障 测试必须伪造浏览器全局。
// INV-02 宿主接口最小化：守住位置 NavigatorLike / WindowLike；改错故障 直接引用 DOM 类型导致 Node 端报错。
// INV-03 只认有限数值：守住位置 readFiniteNumber；改错故障 NaN / Infinity 进入上报字段。
// INV-04 空串视为缺失：守住位置 readNonEmptyString 的 trim；改错故障 上报空 userAgent。
// INV-05 时区失败静默：守住位置 readTimezone 的 try；改错故障 老旧浏览器抛错中断整份设备信息。
// INV-06 像素比恒有值：守住位置 ?? 1；改错故障 缺字段时上报 undefined。
// INV-07 视口成对出现：守住位置 宽高同时判断；改错故障 只有单边时产出半个 viewport。
// INV-08 屏幕尺寸同理成对：守住位置 screen 展开判断；改错故障 半个 screen 对象。
// INV-09 语言列表先过滤空项：守住位置 filter；改错故障 空语言码进入上报。
// INV-10 在线态只收布尔：守住位置 typeof onLine 判断；改错故障 字符串被当成在线。
// INV-11 平台固定为 web：守住位置 platform 字段；改错故障 Web 端伪装成桌面端。
// INV-12 版本有兜底：守住位置 "web"；改错故障 缺版本时字段为 null。
// INV-13 可选字段按需展开：守住位置 条件展开语法；改错故障 缺数据时字段仍存在且为 undefined。
// INV-14 时间戳可注入：守住位置 now 参数；改错故障 无法断言上报时间。
//
// 模块职责：从浏览器全局收集移动端 Web 远控所需的设备信息快照。
// 阅读顺序：先看三个读取工具，再看时区容错，最后看返回对象的条件展开。
import type { WebRemoteControlMobileDeviceInfo } from "@zcode/shared";

interface NavigatorLike {
  userAgent?: string;
  language?: string;
  languages?: readonly string[];
  platform?: string;
  onLine?: boolean;
}

interface WindowLike {
  innerWidth?: number;
  innerHeight?: number;
  devicePixelRatio?: number;
  screen?: {
    width?: number;
    height?: number;
  };
}

interface DateTimeFormatLike {
  resolvedOptions(): {
    timeZone?: string;
  };
}

interface CollectWebRemoteControlMobileDeviceInfoOptions {
  appVersion?: string;
  now?: () => number;
  navigatorLike?: NavigatorLike;
  windowLike?: WindowLike;
  dateTimeFormat?: () => DateTimeFormatLike;
}

// 数值字段只接受有限数。
function readFiniteNumber(value: unknown): number | undefined {
  // Number.isFinite 为 false 时一律返回 undefined，不把 NaN 当数值。
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// 字符串字段排除纯空白。
function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

// 时区读取必须可失败。
function readTimezone(
  dateTimeFormat: CollectWebRemoteControlMobileDeviceInfoOptions["dateTimeFormat"],
): string | undefined {
  try {
    return readNonEmptyString(dateTimeFormat?.().resolvedOptions().timeZone);
  // resolvedOptions().timeZone 取不到时返回 undefined，不抛错，时区是可选字段。
  } catch {
    return undefined;
  }
}

// collectWebRemoteControlMobileDeviceInfo 的默认参数由浏览器全局 navigator 提供，可在测试中注入替换。
export function collectWebRemoteControlMobileDeviceInfo({
  appVersion,
  // 时钟可注入便于断言。
  now = () => Date.now(),
  // navigator 缺失时上层判空。
  navigatorLike = globalThis.navigator,
  windowLike = globalThis.window,
  dateTimeFormat = () => new Intl.DateTimeFormat(),
}: CollectWebRemoteControlMobileDeviceInfoOptions = {}): WebRemoteControlMobileDeviceInfo {
  const viewportWidth = readFiniteNumber(windowLike?.innerWidth);
  const viewportHeight = readFiniteNumber(windowLike?.innerHeight);
  // 像素比缺省按 1 上报。
  const devicePixelRatio = readFiniteNumber(windowLike?.devicePixelRatio) ?? 1;
  const screenWidth = readFiniteNumber(windowLike?.screen?.width);
  const screenHeight = readFiniteNumber(windowLike?.screen?.height);
  const timezone = readTimezone(dateTimeFormat);

  return {
    // 平台标识固定，不随 UA 变化。
    platform: "web",
    version: readNonEmptyString(appVersion) ?? "web",
    name: "mobile-browser",
    ...(readNonEmptyString(navigatorLike?.userAgent) ? { userAgent: navigatorLike.userAgent } : {}),
    ...(readNonEmptyString(navigatorLike?.language) ? { language: navigatorLike.language } : {}),
    // 语言列表非空才上报。
    ...(navigatorLike?.languages?.length
      ? { languages: navigatorLike.languages.filter((language) => language.trim()) }
      : {}),
    ...(readNonEmptyString(navigatorLike?.platform)
      ? { browserPlatform: navigatorLike.platform }
      : {}),
    // 视口宽高必须成对。
    ...(viewportWidth !== undefined && viewportHeight !== undefined
      ? {
          viewport: {
            width: viewportWidth,
            height: viewportHeight,
            devicePixelRatio,
          },
        }
      : {}),
    ...(screenWidth !== undefined && screenHeight !== undefined
      ? {
          screen: {
            width: screenWidth,
            height: screenHeight,
          },
        }
      : {}),
    ...(timezone ? { timezone } : {}),
    ...(typeof navigatorLike?.onLine === "boolean" ? { online: navigatorLike.onLine } : {}),
    // updatedAt 由注入的 now() 决定，测试可用固定时钟复现。
    updatedAt: now(),
  };
}
