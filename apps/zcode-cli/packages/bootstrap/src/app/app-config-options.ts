// ============================================================
// App 装配的配置口径：CLI 覆盖 → 有效 locale
// ============================================================
// create-app 在配置解析之后、runtimeConfig 合并之前调用这里：把 ZCodeAppOptions 里的权限与
// locale 意图折算成 RuntimeConfigPatch，并把 ConfigResult 的 ui.locale 从 "auto" 落成具体值。
// 本文件不写配置文件、不抛错；改写只发生在读结果上，磁盘上的 "auto" 保持原样。

import type { ConfigResult } from "@zcode/adapters/config";
import { detectLocale, resolveLocale } from "@zcode/i18n";
import type { RuntimeConfigPatch, SupportedLocale, UiLocale } from "@zcode/contracts";
import type { ZCodeAppOptions } from "./types.js";

/**
 * 消息通道总开关：只有字符串 "1" 或 "true"（区分大小写）算开启，其余一律关闭。
 *
 * 刻意不做真假值宽松解析：环境变量来自宿主/脚本，`ZCODE_MESSAGE_ENABLED=0` 或拼写错误
 * 不该被读成开启。关闭时调用方根本不装配消息端口，因此这里没有第三态。
 */
export function isMessageEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.ZCODE_MESSAGE_ENABLED === "1" || env.ZCODE_MESSAGE_ENABLED === "true";
}

/**
 * 把 CLI 侧选项折算成 runtimeConfig 覆盖块；没有任何要覆盖的项时返回 undefined。
 *
 * 权限三项（mode / allowlist / disallowlist）只落在 permission 子对象里，不触碰文件配置中的
 * 其余字段；数组都做浅拷贝，避免调用方后续改 options 时反向污染一份已生效的运行时配置。
 * 返回 undefined 而不是空对象，是为了让上层能区分「用户没给覆盖」与「给了但化简为空」。
 */
export function createConfigCliOverrides(options: ZCodeAppOptions): RuntimeConfigPatch | undefined {
  const overrides: RuntimeConfigPatch = {};
  const permission: NonNullable<RuntimeConfigPatch["permission"]> = {};

  if (options.runtimeConfig?.mode) {
    permission.mode = options.runtimeConfig.mode;
  }
  if (options.runtimeConfig?.toolAllowlist) {
    permission.allowedTools = [...options.runtimeConfig.toolAllowlist];
  }
  if (options.runtimeConfig?.toolDisallowlist) {
    // headless CLI 的 denylist 同时投影到 permission config，让执行期权限
    // 路径与 provider-visible 工具面共享同一份禁用清单。
    permission.disallowedTools = [...options.runtimeConfig.toolDisallowlist];
  }
  if (Object.keys(permission).length > 0) {
    overrides.permission = permission;
  }
  if (options.uiLocale) {
    overrides.ui = {
      locale: options.uiLocale,
    };
  }

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

/**
 * 返回一份 ui.locale 已落地的 ConfigResult 视图；请求值本来就是具体 locale 时原样返回。
 *
 * 不改写入参：命中 "auto" 时逐层展开 config / ui，只替换 locale 一个字段，其余引用保持不变。
 * 调用方拿到的结果既可读也可继续参与 runtimeConfig 推导，但**不能**把它当成待持久化的配置。
 */
export function resolveEffectiveConfigResult(
  configResult: ConfigResult,
  options: ZCodeAppOptions,
): ConfigResult {
  const requestedLocale = configResult.config.ui.locale;
  const effectiveLocale = resolveEffectiveLocale(requestedLocale, options);

  if (effectiveLocale === requestedLocale) {
    return configResult;
  }

  return {
    ...configResult,
    config: {
      ...configResult.config,
      ui: {
        ...configResult.config.ui,
        locale: effectiveLocale,
      },
    },
  };
}

/**
 * 请求的 UiLocale → 实际要用的 SupportedLocale。
 *
 * 只有 "auto" 才触发探测；显式 locale 直接交给 resolveLocale 归一（含不受支持值的回退），
 * 因此宿主给的 intl 信息永远不会覆盖用户明确选定的语言。
 */
export function resolveEffectiveLocale(
  requestedLocale: UiLocale,
  options: ZCodeAppOptions,
): SupportedLocale {
  // 探测只在 "auto" 时发生；显式值不再看宿主环境。
  const detectedLocale = requestedLocale === "auto" ? detectAppLocale(options) : undefined;
  return resolveLocale(requestedLocale, detectedLocale);
}

/**
 * "auto" 时的探测输入：宿主显式给的 uiDetectedLocale 优先，其次才是 env + Intl 运行时默认值。
 * 两者都交给 i18n 的 detectLocale 判定，本函数不自己猜语言。
 */
function detectAppLocale(options: ZCodeAppOptions): SupportedLocale | undefined {
  if (options.uiDetectedLocale !== undefined) {
    return detectLocale({
      intlLocale: options.uiDetectedLocale,
    });
  }

  return detectLocale({
    env: options.env ?? process.env,
    intlLocale: resolveIntlLocale(),
  });
}

/** 读运行时的 Intl 默认 locale；ICU 数据缺失等环境下取不到时回 undefined，不影响启动。 */
function resolveIntlLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}
