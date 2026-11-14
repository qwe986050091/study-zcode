// tui-prompt-handler.ts 顶到 oxlint max-lines 上限（400 行），把 submitPrompt 上
// 那组「拿到当前 App 就只读转发」的查询方法拆到本文件；公开面仍从 tui-prompt-handler.ts 导出。
// 统一约定：每次查询都重新 getApp()（不缓存，避免持有已切换/已关闭的 App）；
// 能力缺失时返回空集合或空对象而非抛错，只有子 agent transcript 这类"无实现即不可用"的能力才显式报错。
import type { CommandCenterApp } from "./command-center.js";
import { listAppEffortOptions } from "./command-center/effort-options.js";
import type { TuiPromptHandler } from "./tui-command-state.js";
import type { TuiSessionMetadata } from "@zcode/tui";

// 汇总一次会话元数据快照。
// 输入：app 为当前活跃 CommandCenterApp（只读使用）。
// 输出：TuiSessionMetadata。modelOptions/effortOptions 缺失或为空时统一为空数组（空集合语义）。
// 副作用：读取模型列表可能触发远程/缓存查询；不修改任何状态。
// 口径：loginRequired 由"是否存在未禁用模型"反推 —— 一个可用模型都没有即视为需要登录。
export async function readTuiSessionMetadata(app: CommandCenterApp): Promise<TuiSessionMetadata> {
  const modelOptions = (await app.listModels?.()) ?? [];
  return {
    locale: app.getLocale?.(),
    model: app.getModel?.(),
    theme: app.getTheme?.(),
    thoughtLevel: app.getThoughtLevel?.(),
    modelOptions,
    effortOptions: (await listAppEffortOptions(app)) ?? [],
    loginRequired: !modelOptions.some((model) => !model.disabledReason),
  };
}

// 把只读查询能力挂到 submitPrompt 上。
// 输入：submitPrompt 为可变 handler（本函数就地赋属性）；getApp 为异步取 App 的回调。
// 输出：无返回值；副作用是给 handler 增加 readSubagents/readSubagentTranscript/recallPreviousInput
//       与 getSessionMetadata/listModelOptions/listEffortOptions/listMcpServers/listWorkflowRuns/replayWorkflowRuns。
// 失败语义：除 readSubagentTranscript 在能力缺失时抛错外，其余均降级为空值，保证 TUI 面板不会因能力缺失而崩溃。
export const attachTuiAppQueries = (
  submitPrompt: TuiPromptHandler,
  getApp: () => Promise<CommandCenterApp>,
): void => {
  // 子 agent 列表：无实现时返回"空快照"（revision 0、空列表），而不是让面板显示错误。
  submitPrompt.readSubagents = async (input) => {
    const app = await getApp();
    return (
      app.readSubagents?.(input) ?? {
        revision: 0,
        childSessionIds: [],
        running: [],
        ended: { total: 0, items: [] },
      }
    );
  };
  submitPrompt.readSubagentTranscript = async (childSessionId) => {
    const app = await getApp();
    // transcript 无法伪造空内容（会误导用户），因此能力缺失时显式抛错，由界面提示不可用。
    if (!app.readSubagentTranscript) throw new Error("Subagent transcript is unavailable.");
    return app.readSubagentTranscript(childSessionId);
  };
  // 历史召回：约定用 null（而不是空串）表示"没有更早的输入"，供界面停止继续上翻。
  submitPrompt.recallPreviousInput = async (skip) => {
    const activeApp = await getApp();
    return (await activeApp.recallPreviousInputHistory?.(skip)) ?? null;
  };

  submitPrompt.getSessionMetadata = async () => {
    const activeApp = await getApp();
    return readTuiSessionMetadata(activeApp);
  };

  // 模型列表按 App 口径原样返回（含 disabledReason），不做过滤——是否可用由 TUI 展示层判断。
  submitPrompt.listModelOptions = async () => {
    const activeApp = await getApp();
    return activeApp.listModels?.() ?? [];
  };

  submitPrompt.listEffortOptions = async () => {
    const activeApp = await getApp();
    return (await listAppEffortOptions(activeApp)) ?? [];
  };

  // MCP server 快照：空对象表示"还没有任何 server 配置"，与"未实现"对外表现一致。
  submitPrompt.listMcpServers = async () => {
    const activeApp = await getApp();
    return activeApp.listMcpServers?.() ?? {};
  };

  submitPrompt.listWorkflowRuns = async () => {
    const activeApp = await getApp();
    // 会话级摘要；服务端已按「最近更新在前」给序，读侧不重排（端口注释的裁定）。
    return (await activeApp.listDynamicWorkflowRuns?.({})) ?? [];
  };

  submitPrompt.replayWorkflowRuns = async (input) => {
    const activeApp = await getApp();
    // 与 v4 冷物化同一条链：journal → 与 live
    // 同一种进度载荷 → 镜像的共享 reducer。
    return (await activeApp.replayDynamicWorkflowRuns?.(input)) ?? [];
  };
};
