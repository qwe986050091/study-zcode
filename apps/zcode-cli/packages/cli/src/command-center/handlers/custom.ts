import type { TuiSubmitPromptResult } from "@zcode/tui";
import { buildCustomCommandPrompt } from "../../command-center-custom.js";
import { attachCurrentSessionMetadata } from "../metadata.js";
import type { CommandCenterDeps, TuiSubmitOptions } from "../types.js";

// 处理未知命令对应的自定义命令：展开模板后交给 app 执行，并补齐 session 元数据。
// 命令不存在或未注入 loader 时返回 undefined，让调用方继续走「未知命令」提示；执行失败向上抛。
export async function handleCustomCommand(
  name: string,
  args: string,
  deps: CommandCenterDeps,
  options: TuiSubmitOptions,
): Promise<TuiSubmitPromptResult | undefined> {
  const prompt = await buildCustomCommandPrompt(name, args, deps);
  if (!prompt) return undefined;
  const app = await deps.getApp();
  const result = await app.submitPrompt(prompt, options);
  return attachCurrentSessionMetadata(result, deps, app);
}
