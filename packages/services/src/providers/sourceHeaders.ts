import { readFileSync } from "node:fs";
import { version as readOsVersion } from "node:os";
import { join } from "node:path";
import {
  buildZCodeSourceHeadersFromContext,
  normalizeZCodeSourceHeaderValue,
  ZCODE_ENV,
  ZCODE_SOURCE_HEADERS,
  ZCODE_VERSION,
} from "@zcode/shared";
import { getAppConfigDir } from "../paths.js";

export { ZCODE_SOURCE_HEADERS };

// 构建来源请求头所需的运行环境信息，调用方可覆盖任意字段用于测试或特殊部署。
// 未提供的字段按当前进程的实际情况取默认值。
interface ZCodeSourceHeaderOptions {
  appVersion?: string;
  arch?: string;
  clientLanguage?: string;
  clientTimezone?: string;
  osVersion?: string;
  platform?: NodeJS.Platform;
  releaseChannel?: string;
}

// deviceMid 只从既有遥测状态文件读取并缓存，避免每次请求都同步读盘。
// 缓存同时记录状态文件路径，配置目录切换后自动失效。
let cachedDeviceMid: { stateFile: string; value: string } | null = null;

// 请求头只能包含可见字符，统一走共享归一化逻辑过滤非法值。
function normalizePrintableHeaderValue(value: string | undefined): string | undefined {
  return normalizeZCodeSourceHeaderValue(value);
}

// 语言取运行时 locale；无法识别时用 unknown 占位，保证字段始终存在。
function resolveClientLanguage(): string {
  return normalizePrintableHeaderValue(Intl.DateTimeFormat().resolvedOptions().locale) ?? "unknown";
}

// 时区同样按运行时环境推导，缺失时回落为 unknown。
function resolveClientTimezone(): string {
  return (
    normalizePrintableHeaderValue(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? "unknown"
  );
}

// 读取遥测状态文件中的 deviceMid；文件不存在或内容非法时返回 undefined。
// 这里不生成新身份，设备标识的创建与轮换由 desktop/telemetry 负责。
function readExistingDeviceMid(): string | undefined {
// 状态文件位置与应用配置目录绑定，路径变化会让缓存自然失效。
// 同步读取只发生在首次构建请求头时，后续命中内存缓存。
  const stateFile = join(getAppConfigDir(), "telemetry-state.json");
  if (cachedDeviceMid?.stateFile === stateFile) {
    return cachedDeviceMid.value;
  }

// 文件缺失、权限不足或 JSON 损坏都按无 deviceMid 处理，不影响请求构建。
  try {
    const raw = readFileSync(stateFile, "utf-8");
// 解析结果视为不可信输入，只接受字符串并通过归一化校验。
    const parsed = JSON.parse(raw) as { deviceMid?: unknown };
// 空值或只含不可见字符的 deviceMid 视为无效，不写入缓存。
    const deviceMid = normalizePrintableHeaderValue(
      typeof parsed.deviceMid === "string" ? parsed.deviceMid : undefined,
    );
    if (!deviceMid) {
      return undefined;
    }

// 只有成功解析出有效值才更新缓存，失败结果不缓存以便下次重试。
    cachedDeviceMid = { stateFile, value: deviceMid };
    return deviceMid;
  } catch {
    // deviceMid 的生命周期由 desktop/telemetry 负责；这里仅复用已存在值，不生成新身份。
    return undefined;
  }
}

// 汇总版本、平台、语言、时区与设备标识，产出统一的来源请求头。
// 返回对象只含字符串值，供 API 客户端原样附加到出站请求。
export function buildZCodeSourceHeaders(
  options: ZCodeSourceHeaderOptions = {},
): Record<string, string> {
// 平台与架构默认取当前进程，调用方可显式覆盖以模拟其他客户端环境。
// 这两个值不经过归一化，因为它们来自受限枚举而非自由文本。
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
// 版本与发布通道缺省取自共享常量，保证与服务端约定的取值一致。
  const appVersion = normalizePrintableHeaderValue(options.appVersion ?? ZCODE_VERSION);
  const releaseChannel = normalizePrintableHeaderValue(options.releaseChannel ?? ZCODE_ENV);
// 语言与时区优先使用显式入参，其次读运行时环境，最后回落 unknown。
  const clientLanguage =
    normalizePrintableHeaderValue(options.clientLanguage) ?? resolveClientLanguage();
  const clientTimezone =
    normalizePrintableHeaderValue(options.clientTimezone) ?? resolveClientTimezone();
  const osVersion = normalizePrintableHeaderValue(options.osVersion ?? readOsVersion());
// deviceMid 可能为空，构造函数会据此省略对应请求头而不是发送空字符串。
  const deviceMid = readExistingDeviceMid();

// 最终组装交给共享构造器，保证桌面、Web 与 CLI 的头部键名和格式一致。
// sourceTitle 固定标识 electron 客户端，用于服务端区分来源。
  return buildZCodeSourceHeadersFromContext({
    appVersion,
    arch,
    clientLanguage,
    clientTimezone,
    deviceMid,
    osVersion,
    platform,
    releaseChannel,
    sourceTitle: "electron",
  });
}
