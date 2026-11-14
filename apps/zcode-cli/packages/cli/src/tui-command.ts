// `zcode tui` 入口编排：解析启动语言、创建 prompt handler、注册退出清理，再把依赖交给 runTui。
// 本层不实现界面逻辑，只负责把 CLI 侧能力（剪贴板、模型列表、子 agent、工作流）以回调形式注入 TUI。
import type { ToolSearchMode } from "@zcode/contracts";
import type { RunContext, GlobalOptions } from "@zcode/shared-types";
import { resolveZCodeRuntimeEnv, type DynamicWorkflowMode } from "@zcode/shared";
import { createNodeClipboardImageReader } from "./clipboard-image.js";
import { createNodeClipboardTextWriter } from "./clipboard-text.js";
import { listSlashCommandSuggestions } from "./command-center.js";
import { registerCliShutdownHandlers } from "./shutdown.js";
import { listCustomCommandsForTui, loadInitialTuiSessionMetadata } from "./tui-command-data.js";
import { createTuiSubmitPrompt } from "./tui-prompt-handler.js";
import { loadTuiRuntime } from "./tui-runtime-loader.js";
import { resolveTuiStartupLocale } from "./tui-startup-locale.js";
import { createWorkspacePathSuggestionProvider } from "./tui-workspace-paths.js";
import { resolveWorkspaceGitBranch } from "./tui-workspace-git.js";
import { createCliModeState, currentCliMode } from "./tui-command-state.js";
import type { CliPermissionMode, CliResumeRequest, RunDependencies } from "./cli-types.js";
import { DEFAULT_CLI_WORKFLOW_MODE } from "./workflow-mode.js";

// 启动交互式 TUI 并等待其结束。
// 输入：options 为全局选项（locale/noColor/browserUse 等）；mode 为初始权限模式（undefined 表示沿用 "build"）；
//       resumeRequest 决定是否恢复历史会话；toolDisallowlist 与 toolsearchMode/workflowMode 控制工具与工作流能力。
// 输出：退出码 0 表示用户正常退出（含 /exit），1 表示启动或运行期异常。
// 副作用：替换 stdout/stderr 的终端使用权、注册信号处理、可能读写剪贴板；结束时关闭 prompt handler 并注销信号监听。
// 生命周期：runTui 返回后必定执行 finally（注销 + close），因此不存在"退出但会话未关闭"的路径。
// 失败语义：任何异常都转成一行 Error 文本（--verbose 附带栈），不向调用方抛出。
export const runTuiCommand = async (
  ctx: RunContext,
  options: GlobalOptions,
  deps: RunDependencies,
  version: string,
  mode?: CliPermissionMode,
  resumeRequest?: CliResumeRequest,
  toolDisallowlist?: readonly string[],
  forceMcs = false,
  toolsearchMode: ToolSearchMode = "off",
  workflowMode: DynamicWorkflowMode = DEFAULT_CLI_WORKFLOW_MODE,
): Promise<number> => {
  try {
    const modeState = createCliModeState(mode);
    const runTui = deps.runTui ?? (await loadTuiRuntime()).runTui;
    const workspaceDirectory = (deps.cwd ?? process.cwd)();
    const env = deps.env ?? process.env;
    const developerMode = resolveZCodeRuntimeEnv(env) === "development";
    const startupLocale = resolveTuiStartupLocale({
      deps,
      options,
      workingDirectory: workspaceDirectory,
    });
    const promptHandler = createTuiSubmitPrompt(
      deps,
      modeState,
      version,
      resumeRequest,
      options.locale,
      options.detectedLocale,
      startupLocale,
      toolDisallowlist,
      forceMcs,
      toolsearchMode,
      options.browserUse,
      options.browserExecutable,
      workflowMode,
      options.recordConversation,
      options.recordConversationDir,
    );
    // 信号清理与 finally 清理共用 promptHandler.close；close 需幂等，避免 Ctrl+C 与正常退出各关闭一次。
    const unregisterShutdownHandlers = registerCliShutdownHandlers({
      cleanup: async () => {
        await promptHandler.close?.();
      },
      cleanupTimeoutMs: deps.shutdownCleanupTimeoutMs,
      exitProcess: deps.exitProcess,
      process: deps.shutdownProcess,
    });
    try {
      return await runTui({
        loadStartupOptions: async () => {
          // 三路并行加载首屏所需数据；命令与 Git 分支失败只影响展示，不能阻断 TUI 启动。
          const [metadata, customCommands, workspaceGitBranch] = await Promise.all([
            loadInitialTuiSessionMetadata(promptHandler),
            listCustomCommandsForTui(deps).catch(() => undefined),
            (deps.resolveWorkspaceGitBranch ?? resolveWorkspaceGitBranch)({
              workspaceDirectory,
            }).catch(() => undefined),
          ]);
          return {
            initialMode: currentCliMode(modeState),
            initialModel: metadata.model,
            initialThoughtLevel: metadata.thoughtLevel,
            loginRequired: metadata.loginRequired,
            locale: metadata.locale ?? startupLocale,
            theme: metadata.theme ?? "auto",
            modelOptions: metadata.modelOptions,
            effortOptions: metadata.effortOptions,
            slashCommands: listSlashCommandSuggestions(customCommands, { workflowMode }),
            workspaceGitBranch,
          };
        },
        locale: startupLocale,
        developerMode,
        version,
        workspaceDirectory,
        noColor: options.noColor,
        readClipboardImage: deps.readClipboardImage ?? createNodeClipboardImageReader(),
        listModelOptions: promptHandler.listModelOptions,
        listWorkspacePathSuggestions: createWorkspacePathSuggestionProvider({
          workspaceDirectory,
        }),
        listMcpServers: promptHandler.listMcpServers,
        readSubagents: promptHandler.readSubagents,
        readSubagentTranscript: promptHandler.readSubagentTranscript,
        listWorkflowRuns: promptHandler.listWorkflowRuns,
        replayWorkflowRuns: promptHandler.replayWorkflowRuns,
        getMainSessionId: promptHandler.getMainSessionId,
        writeClipboardText:
          deps.writeClipboardText ?? createNodeClipboardTextWriter({ stdout: ctx.stdout }),
        stderr: ctx.stderr,
        stdin: ctx.stdin,
        stdout: ctx.stdout,
        recallPreviousInput: promptHandler.recallPreviousInput,
        sendInput: promptHandler.sendInput,
        setMode: promptHandler.setMode,
        submitPrompt: promptHandler,
        subscribeSessionEvents: promptHandler.subscribeSessionEvents,
      });
    } finally {
      // 必须先注销信号监听再关闭 handler：否则退出过程中收到信号会再次触发同一清理。
      unregisterShutdownHandlers();
      await promptHandler.close?.();
    }
  } catch (error) {
    // 非 Error 的抛出物也转字符串，保证启动失败一定有可见输出而不是静默返回 1。
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Error: ${message}\n`);
    if (options.verbose && error instanceof Error && error.stack) {
      ctx.stderr.write(`${error.stack}\n`);
    }
    return 1;
  }
};
