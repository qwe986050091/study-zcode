// TUI 登录态适配：生成"需要登录"文案，并提供模型可用性探针，供 TUI 决定是否展示登录引导。
import { getZCodeCopy } from "@zcode/i18n";
import type { CommandCenterApp } from "./command-center.js";

// 生成"需要登录"的提示文本。
// 输入：locale 为界面语言标识；undefined 时由 i18n 回落到默认语言。
// 输出：两行文本（说明 + 操作指引），以 `\n` 连接，可直接交给 TUI 渲染或终端输出。
// 副作用：无 IO、无状态；纯函数。
export function loginRequiredResponse(locale?: string): string {
  const copy = getZCodeCopy(locale).tui.loginRequired;
  return [copy.message, copy.help].join("\n");
}

// 创建"是否存在可用模型"的检查函数，供 TUI 判断当前是否已具备登录态。
// 输入：getApp 为异步获取当前 CommandCenterApp 的回调；每次检查都重新取，避免持有过期 App。
// 输出：无参异步函数，true 表示至少有一个未禁用模型；listModels 缺失或返回空集合时结果为 false。
// 口径：disabledReason 非空即视为该模型不可用（已含 provider/账户维度的判定），本层不额外推断。
// 失败语义：getApp/listModels 抛错向上冒泡，由调用方决定是否降级展示登录入口。
/** Registry already applies provider/account availability, including personal providers. */
export function createTuiModelAvailabilityChecker(
  getApp: () => Promise<CommandCenterApp>,
): () => Promise<boolean> {
  return async () => {
    const app = await getApp();
    // `?? []` 把"未实现模型列表"当作空集合处理，等价于没有可用模型。
    return ((await app.listModels?.()) ?? []).some((model) => !model.disabledReason);
  };
}
