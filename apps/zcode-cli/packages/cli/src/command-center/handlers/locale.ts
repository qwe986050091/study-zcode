import { isUiLocale, SUPPORTED_LOCALES, type UiLocale } from "@zcode/i18n";
import type { TuiSubmitPromptResult } from "@zcode/tui";
import type { CommandCenterDeps } from "../types.js";

// 可通过 /locale 配置的取值：auto（跟随系统）加全部受支持语言；顺序决定提示中的展示顺序。
const CONFIGURABLE_LOCALES = ["auto", ...SUPPORTED_LOCALES] as const satisfies readonly UiLocale[];

// 处理 /locale：无参、"status"、"list" 均展示当前语言与可选项；带参切换并持久化。
// 切换失败保留当前语言并返回原因；客户端不支持切换时降级为提示文本。
// 副作用：可能写用户配置文件（由 setLocale 实现负责），本函数只做参数校验与格式化。
export async function handleLocaleCommand(
  args: string,
  deps: CommandCenterDeps,
): Promise<TuiSubmitPromptResult> {
  const current = (await readCurrentLocale(deps)) ?? "en-US";

  if (args.length === 0 || args === "status" || args === "list") {
    return {
      locale: current,
      mode: deps.getMode?.(),
      response: [
        `Current locale: ${current}.`,
        `Available locales: ${CONFIGURABLE_LOCALES.join(", ")}.`,
        "Use /locale <locale> to switch and persist the UI locale.",
      ].join("\n"),
    };
  }

  const requested = args.trim();
  if (!isUiLocale(requested)) {
    return {
      locale: current,
      mode: deps.getMode?.(),
      response: `Unsupported locale: ${args}. Available locales: ${CONFIGURABLE_LOCALES.join(", ")}.`,
    };
  }

  const setLocale = deps.setLocale ?? (await createAppLocaleSetter(deps));
  if (!setLocale) {
    // 两条注入路径都不可用时才降级，先尊重 deps 的显式覆盖。
    return {
      locale: current,
      mode: deps.getMode?.(),
      response: "Locale switching is not available in this client.",
    };
  }

  try {
    const result = await setLocale(requested);
    return {
      locale: result.locale,
      mode: deps.getMode?.(),
      response: formatLocaleSwitchResult(result.requestedLocale, result.locale, result.configPath),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      locale: current,
      mode: deps.getMode?.(),
      response: `Unable to switch locale: ${message}`,
    };
  }
}

// 读取当前语言：优先 CLI 层已有值，其次 app facade；两者都没有则返回 undefined（由调用方取默认 en-US）。
async function readCurrentLocale(deps: CommandCenterDeps) {
  const localLocale = deps.getLocale?.();
  if (localLocale) return localLocale;
  const app = await deps.getApp();
  return app.getLocale?.();
}

// 从 app facade 取语言切换能力并绑定 this；app 不支持时返回 undefined，调用方据此降级。
async function createAppLocaleSetter(
  deps: CommandCenterDeps,
): Promise<CommandCenterDeps["setLocale"]> {
  const app = await deps.getApp();
  return app.setLocale?.bind(app);
}

// 切换结果格式化：请求值与生效值一致时只说 switched，否则说明 effective locale；
// configPath 存在时追加配置文件路径，便于用户核对持久化位置。
function formatLocaleSwitchResult(
  requestedLocale: UiLocale,
  locale: string,
  configPath: string | undefined,
): string {
  const effective =
    requestedLocale === locale
      ? `Locale switched to ${locale}.`
      : `Locale set to ${requestedLocale}; effective locale is ${locale}.`;
  return configPath ? `${effective}\nConfig: ${configPath}` : effective;
}
