/**
 * ============================================================================
 * tool-part-metadata.ts —— ToolPart 完成元数据的组装
 * ============================================================================
 * 定位：链路 3（工具结果序列化与展示）落库前的 metadata：display、modelContent、
 *       serialization、readFileState，供冷恢复与 UI 投影使用。
 * 输入/输出：输入 ToolExecutionResult / MCP presentation；输出 CompletedToolPartMetadata。
 * 关键不变量：serialization 必须记录真实预算与 returnedBytes（不变量 #4）；modelContent
 *       只在 schema 校验通过后持久化；readFileState 独立落库，恢复不依赖 provider 展示文本。
 * ============================================================================
 */
import { PersistedToolSearchContentSchema } from "@zcode/contracts";
import {
  COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION,
  type CompletedToolPartMetadata,
  type ToolExecutionResult,
} from "../deps.js";
import { createMcpToolDisplay } from "../../tool/executor/result-display.js";

export function mcpToolPartMetadata(
  presentation: { serverName: string; toolName: string; description?: string } | undefined,
): CompletedToolPartMetadata | undefined {
  const display = createMcpToolDisplay(presentation);
  // 没有合法 display 就整体返回 undefined：让调用方区分「无 MCP 元数据」与有空壳对象。
  return display
    ? { schemaVersion: COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION, display }
    : undefined;
}

export function completedToolPartMetadata(result: ToolExecutionResult): CompletedToolPartMetadata {
  // modelContent 来自工具执行结果，必须先过契约 schema 再持久化，不能信任内存态。
  const modelContent = PersistedToolSearchContentSchema.safeParse(result.modelContent);
  // 只拷贝序列化里的预算事实；returnedBytes 是真实发给模型的字节（不变量 #4）。
  const serialization = result.serialization
    ? {
        truncated: result.serialization.truncated,
        originalBytes: result.serialization.originalBytes,
        returnedBytes: result.serialization.returnedBytes,
        budgetStrategy: result.serialization.budgetStrategy,
        // artifactPath 只在有落盘产物时出现，省略而不是写 undefined。
        ...(result.serialization.artifactPath
          ? { artifactPath: result.serialization.artifactPath }
          : {}),
      }
    : undefined;
  return {
    // schemaVersion 固定当前版本，冷恢复据此决定能否按该结构解析。
    schemaVersion: COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION,
    // schema 校验失败就省略 modelContent：宁可恢复后少一段可搜索内容，也不写入非法结构。
    ...(modelContent.success ? { modelContent: modelContent.data } : {}),
    // display 是可选展示投影，不影响工具结果本身。
    ...(result.display ? { display: result.display } : {}),
    ...(serialization ? { serialization } : {}),
    // resume 需要恢复模型当时真实读到的文件快照；只依赖 tool_result 文本
    // 会把主路径绑死在 provider 展示格式上，所以新 session 结构化持久化 read-state。
    ...(result.readFileStateMetadata ? { readFileState: result.readFileStateMetadata } : {}),
  };
}
