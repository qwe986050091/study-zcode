/**
 * ============================================================================
 * hooks/configured-runner-input.ts —— 配置 Hook 的外部进程输入适配层
 * ============================================================================
 *
 * 配置 hook 是外部命令,契约按 Claude Code 兼容形状喂 stdin 与环境变量;
 * ZCode 自有 camelCase 字段仍是内部主契约,这里只做无损 alias,不改写调用方数据。
 * transcript 必须落到真实文件才能被脚本读取,故写临时目录并由 cleanup 负责删除。
 *
 * 本层只做形状转换,不做授权判断:能否执行由 dispatch 前的 admission 决定
 * （链路 9）,allow/deny 的语义收紧由 output.ts 收口（不变量 #3）。
 * ============================================================================
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspaceHookTimeoutMs } from "@zcode/shared/workspace-hook-discovery";
import {
  CoreErrorType,
  HookEventName,
  createCoreError,
  type HookConfig,
  type HookInput,
  type HookPluginContext,
} from "@zcode/contracts";

export async function createCompatibleHookStdin(input: HookInput): Promise<{
  cleanup: () => Promise<void>;
  value: string;
}> {
  // 用 spread 保留全部内部字段,再逐项补兼容 alias:
  // 既不丢原始 hook 输入,也让只认 snake_case 的脚本拿到一致取值。
  const compatible: Record<string, unknown> = {
    ...input,
    agent_type: input.agentName,
    hook_event_name: input.hookEventName,
    permission_mode: input.mode,
    session_id: input.sessionId,
  };
  // transcript 必须是真实存在的文件:部分 hook 会直接读取它;
  // 每次 run 用独立临时目录,避免并发 hook 串写同一份历史。
  const tempDir = await mkdtemp(join(tmpdir(), "zcode-hook-"));
  const transcriptPath = join(tempDir, "transcript.jsonl");
  // 内容只取当前事件相关的那条消息,其余事件写空文件:
  // 不给 hook 额外的历史可见面,也就不会把无关上下文带进判断。
  await writeFile(transcriptPath, formatTranscript(input), "utf8");
  compatible.transcript_path = transcriptPath;
  compatible.transcriptPath = transcriptPath;

  // 只有工具相关事件才带 toolName:按字段存在性收窄,避免给非工具事件
  // 伪造 tool_* 字段,让 hook 误判当前上下文。
  if ("toolName" in input) {

    // 这里只补无损 alias，继续保留 ZCode camelCase 字段作为内部主契约。
    compatible.tool_name = input.toolName;
    compatible.tool_input = input.toolInput;
    compatible.tool_use_id = input.toolCallId;
  }

  // 按事件分派补充字段:每个事件只暴露该语义下有效的上下文,
  // 错放字段会让 hook 基于不存在的信息做决定。
  switch (input.hookEventName) {
    case HookEventName.PermissionRequest:
      // 权限事件额外给 suggestions,hook 可据此决定 deny 还是放行（不变量 #3）。
      compatible.permission_suggestions = input.permissionSuggestions;
      break;
    case HookEventName.PostToolUse:
      compatible.tool_response = input.toolResponse;
      break;
    case HookEventName.PostToolUseFailure:

      // 结构化 error 供诊断链路使用,扁平 message 供脚本直接打印,两者都要给。
      compatible.error_details = input.error;
      compatible.error = input.error.message;
      compatible.is_interrupt = input.isInterrupt;
      break;
    case HookEventName.Stop:
      // stop_hook_active 表示"本次 Stop 由 hook 续跑触发";
      // 少了它,Stop hook 无法识别递归,会一直把回合续下去。
      compatible.last_assistant_message = input.responseText ?? input.responsePreview;
      compatible.stop_hook_active = input.stopHookActive;
      break;
    case HookEventName.SessionStart:
    case HookEventName.UserPromptSubmit:
    case HookEventName.PreToolUse:
      // 这三个事件没有额外兼容字段;显式列出空分支,新增事件时类型检查会提醒补齐。
      break;
  }

  // cleanup 与 value 一起返回:调用方在 hook 结束后必须删临时目录,
  // 否则每次 run 都会在 tmp 里留下 transcript。
  return {
    value: `${JSON.stringify(compatible)}\n`,
    cleanup: async () => {
      // force + recursive:hook 自己可能已删掉部分文件,清理不能因 ENOENT 反向报错。
      await rm(tempDir, { force: true, recursive: true });
    },
  };
}

export function resolveHookTimeoutMs(hook: HookConfig, defaultTimeoutMs: number): number {
  // 超时解析统一委托共享实现:配置 hook 与工作区 hook 必须得到同一套上限,
  // 否则在配置侧绕过超时会在执行器里变成"永不超时"。
  return resolveWorkspaceHookTimeoutMs(hook, defaultTimeoutMs);
}

export function createPluginEnvOverlay(
  plugin: HookPluginContext | undefined,
  input: HookInput,
  workingDirectory: string,
) {
  // 只注入显式白名单变量:环境变量是 hook 最容易读到的外泄通道,
  // 不能把整个 process.env 透传给它。
  const set: Record<string, string> = {
    CLAUDE_CODE_SESSION_ID: input.sessionId,
    CLAUDE_PROJECT_DIR: input.cwd || workingDirectory,
    CLAUDE_SESSION_ID: input.sessionId,
    ZCODE_PROJECT_DIR: input.cwd || workingDirectory,
    ZCODE_SESSION_ID: input.sessionId,
  };
  // 非插件 hook 只拿到 session/project 身份;插件路径仅在确有插件上下文时补,
  // 避免把宿主目录结构暴露给无关脚本。
  if (!plugin) return { set };
  return {
    set: {
      ...set,
      CLAUDE_PLUGIN_DATA: plugin.dataPath,
      CLAUDE_PLUGIN_ROOT: plugin.rootPath,
      ZCODE_PLUGIN_DATA: plugin.dataPath,
      ZCODE_PLUGIN_ID: plugin.id,
      ZCODE_PLUGIN_NAME: plugin.name,
      ZCODE_PLUGIN_ROOT: plugin.rootPath,
    },
  };
}

export function expandPluginVariables(
  value: string,
  plugin: HookPluginContext | undefined,
  input: HookInput,
  workingDirectory: string,
): string {
  // 展开用的映射与环境变量注入保持同一份白名单与同一取值,
  // 否则会出现"环境里有、模板里展不开"的不一致。
  const replacements: Record<string, string> = {
    CLAUDE_CODE_SESSION_ID: input.sessionId,
    CLAUDE_PROJECT_DIR: input.cwd || workingDirectory,
    CLAUDE_SESSION_ID: input.sessionId,
    ZCODE_PROJECT_DIR: input.cwd || workingDirectory,
    ZCODE_SESSION_ID: input.sessionId,
  };
  // 插件变量只在确有插件上下文时进入替换表;缺失时下方回退原文,
  // 而不是展开成空串让命令悄悄指向错误目录。
  if (plugin) {
    replacements.CLAUDE_PLUGIN_DATA = plugin.dataPath;
    replacements.CLAUDE_PLUGIN_ROOT = plugin.rootPath;
    replacements.ZCODE_PLUGIN_DATA = plugin.dataPath;
    replacements.ZCODE_PLUGIN_ROOT = plugin.rootPath;
  }
  return value.replace(
    /\$\{(CLAUDE_CODE_SESSION_ID|CLAUDE_PLUGIN_DATA|CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR|CLAUDE_SESSION_ID|CLAUDE_SKILL_DIR|ZCODE_PLUGIN_DATA|ZCODE_PLUGIN_ROOT|ZCODE_PROJECT_DIR|ZCODE_SESSION_ID|ZCODE_SKILL_DIR)\}/gu,
    (_match, key: string) => {
      // 失败而非降级:空目录会让命令静默跑在错误路径,事故不可观测（链路 9）。
      if (key === "CLAUDE_SKILL_DIR" || key === "ZCODE_SKILL_DIR") {
        // hook 运行时没有“当前 skill”语义，不能把该变量交给 shell 展开为空字符串。
        // 这里提前报错，插件诊断/日志能看到明确的上下文缺失原因。
        throw createCoreError(
          CoreErrorType.ConfigurationError,
          `Hook variable requires a skill context: ${key}`,
          {
            context: {
              hookEventName: input.hookEventName,
              variable: key,
            },
            recoverable: true,
          },
        );
      }
      // 未登记的 key 原样返回:替换表与上面的正则必须保持同步,
      // 宁可留下 ${...} 让用户看见,也不擅自替换成空。
      return replacements[key] ?? _match;
    },
  );
}

function formatTranscript(input: HookInput): string {
  // 只在这两个事件重建 transcript;其余事件返回空串,
  // 让 hook 看到"没有历史",而不是上一次运行残留的内容。
  if (input.hookEventName === HookEventName.Stop) {
    return formatMessageLine("assistant", input.responseText ?? input.responsePreview);
  }
  if (input.hookEventName === HookEventName.UserPromptSubmit) {
    return formatMessageLine("user", input.prompt);
  }
  return "";
}

function formatMessageLine(role: "assistant" | "user", text: string): string {
  // 兼容格式是 JSONL:一行一条消息;role 由事件方向决定,
  // 内容按 text part 包装,保证 hook 侧解析器拿到的结构与真实 transcript 一致。
  return `${JSON.stringify({
    message: {
      content: [{ text, type: "text" }],
      role,
    },
  })}\n`;
}
