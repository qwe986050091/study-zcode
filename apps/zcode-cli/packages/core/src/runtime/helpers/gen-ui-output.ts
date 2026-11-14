// ============================================================
// gen-ui-output —— 桌面端 Gen UI 产物目录的解析与创建
// ============================================================
//
// 【职责】
//   在 zcode_desktop 展示面下,为当前 workspace/session 解析一个
//   "模型可写的 Gen UI 输出目录",并确保它真实存在。
//
// 【口径】
//   - 只有 presentationSurface === "zcode_desktop" 且配置了 genUiOutputRoot
//     才启用;其它展示面返回 undefined(不暴露可写目录给模型)。
//   - 目录身份用 workspaceIdentity(缺省回落到 workspacePath) + sessionId,
//     与仓库"身份 key 统一"的约定一致。
//
// 【失败语义】
//   - 未启用时静默跳过(返回 undefined / no-op);
//   - 已启用但缺少 FileSystemPort 时抛错,而不是悄悄写进 Git 工作区。
//
// 【副作用】
//   ensureGenUiOutputDirectory 会真实建目录(I/O),其余为纯计算。
// ============================================================
import { getGenUiOutputDirectory } from "@zcode/shared/node";
import type { AgentRuntimeInternal } from "../internal.js";

/**
 * 解析 Gen UI 输出目录(可能尚不存在)。
 * 输入:runtime(读取 presentationSurface / genUiOutputRoot / workspace 身份)。
 * 输出:绝对路径;未启用(非桌面展示面或未配置根目录)时返回 undefined。
 * 副作用:无(纯计算,不建目录)。
 */
export function resolveGenUiOutputDirectory(runtime: AgentRuntimeInternal): string | undefined {
  if (runtime.config.presentationSurface !== "zcode_desktop" || !runtime.config.genUiOutputRoot)
    return undefined;
  return getGenUiOutputDirectory(runtime.config.genUiOutputRoot, {
    workspacePath: runtime.config.workspacePath ?? runtime.workspaceRoot,
    workspaceIdentity: runtime.config.workspaceIdentity,
    sessionId: runtime.sessionId,
  });
}

/**
 * 确保 Gen UI 输出目录存在(会落盘创建)。
 * 输入:runtime。输出:无。副作用:createDirectory(递归创建)。
 * 失败语义:未启用时直接返回;启用但缺少 FileSystemPort 时抛错——
 *   宁可失败也不静默落回 Git 工作区,避免产物污染仓库。
 * 注意:只有创建成功后,上层才会把该目录声明给模型。
 */
export async function ensureGenUiOutputDirectory(runtime: AgentRuntimeInternal): Promise<void> {
  const path = resolveGenUiOutputDirectory(runtime);
  if (!path) return;
  if (!runtime.fileSystemPort) throw new Error("Gen UI output requires FileSystemPort");
  // 只有成功创建后才向模型声明可写目录；失败不能静默落到 Git 工作区。
  await runtime.fileSystemPort.createDirectory({ path, trace: runtime.rootTraceContext });
}
