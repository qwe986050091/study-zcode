// 把导入的公开 rows 渲染成喂给模型的 Markdown 上下文（shared_context）。
// 这是「分享内容」进入本机会话的唯一通道，因此必须只读、确定性、且不引入本地路径。
// INV-01：同一输入必产出同一 markdown，否则 provenance 里的 markdownSha256 无法复现（守住它：无随机/无时间）。
// INV-02：认不出的 row kind 不抛错，只进 unsupportedKinds 由调用方记日志（守住它：default 分支）。
// INV-03：artifact 引用必须能在 installedArtifacts 里解析，解析不到即契约破裂（守住它：artifact case）。
// 改错后果：要么导入失败，要么模型看到的内容与分享者确认的内容不一致且无从察觉。
import { createHash } from "node:crypto";

import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

import { ConversationShareServiceError } from "#src/conversation-share/conversationShare.js";

export interface SharedContextFormatterInputV1 {
  share: { shareId: string; title: string };
  rows: ConversationRow[];
  installedArtifacts: Array<{
    artifactId: string;
    workspaceRelativePath: string;
    displayName: string;
    mimeType: string;
    sha256: string;
  }>;
}

export interface SharedContextDocumentV1 {
  formatterVersion: 1;
  markdown: string;
  markdownSha256: string;
  /** 本 build 认不出、没能进 Markdown 的 row kind；调用方负责记日志。 */
  unsupportedKinds: string[];
}

// 代码围栏必须比内容里出现的最长反引号串更长，否则工具输出里的 ``` 会提前关闭围栏，
// 后面的内容会被当成 Markdown 结构解析，等于让被分享内容改写上下文语义。
function fenced(value: string): string {
  const fence = value.includes("```") ? "````" : "```";
  return `${fence}\n${value}\n${fence}`;
}

// formatterVersion 写进 provenance，用于将来改格式时判断历史导入能否重放；
// 目前只有 v1，任何输出结构变化都必须升版本而不是就地改。
export function formatSharedContextV1(
  input: SharedContextFormatterInputV1,
): SharedContextDocumentV1 {
// 用 artifactId 建索引而不是数组线性查找：一次导入可能有上百个结果物，
// 每个附件行都要查一次，线性查找会把格式化变成平方复杂度。
  const paths = new Map(
    input.installedArtifacts.map((artifact) => [artifact.artifactId, artifact]),
  );
// artifactId 到落盘元数据的索引：附件行只带 zcode-artifact://share/<id>，
// 需要换成「可读文件名 + workspace 相对路径 + sha256」才能让模型定位文件。
  const sections = [`# Shared conversation: ${input.share.title}`];
  const unsupportedKinds = new Set<string>();
  for (const row of input.rows) {
// turnHeader 有意不输出：它只承载轮次边界，模型不需要看到；
// 其余每种 kind 都映射到一个固定二级标题，保证输出结构可预测。
    switch (row.kind) {
// 轮次边界不产出任何文本：标题已经从每行内容里体现，加了只会重复。
      case "turnHeader":
        break;
// 用户输入可能带附件；附件只有在已安装（paths 命中）时才展开，
// 未安装的引用直接丢弃，避免把服务端 artifact id 当成本地路径暴露给模型。
      case "userInput":
        {
// [失败路径] 只认 zcode-artifact://share/ 前缀：其它形状（file://、data:）说明投影被绕过，
// 这里静默跳过而不是解析，保持「不读非公开引用」的边界。
          const attachmentLines = (row.attachments ?? []).flatMap((attachment) => {
            const artifactId = attachment.ref.startsWith("zcode-artifact://share/")
              ? attachment.ref.slice("zcode-artifact://share/".length)
              : "";
            const installed = paths.get(artifactId);
            return installed
              ? [
                  `- ${installed.displayName}`,
                  `  - Path: ${installed.workspaceRelativePath}`,
                  `  - MIME: ${installed.mimeType}`,
                  `  - SHA-256: ${installed.sha256}`,
                ]
              : [];
          });
          sections.push(
            `## User\n\n${row.text}${
              attachmentLines.length > 0
                ? `\n\n### Attachments\n\n${attachmentLines.join("\n")}`
                : ""
            }`,
          );
        }
        break;
// 助手正文原样输出，不做转义：它是模型自己的输出，转义反而会让代码块失真。
      case "assistantText":
        sections.push(`## Assistant\n\n${row.text}`);
        break;
// 推理内容单独成节而非常规正文：分享者可能只想让模型参考结论，分离后便于调用方按需裁剪。
      case "reasoning":
        sections.push(`## Reasoning\n\n${row.text}`);
        break;
// 工具输入输出都走 fenced：内容是任意文本，不加围栏会被当成 Markdown 指令。
      case "toolCall":
        sections.push(
          `## Tool: ${row.toolName}\n\n### Input\n\n${fenced(row.inputText)}${
            row.output?.text ? `\n\n### Output\n\n${fenced(row.output.text)}` : ""
          }`,
        );
        break;
// marker 序列化后仍要进围栏，因为 JSON 里的反引号同样能破坏结构。
      case "timelineMarker":
        sections.push(`## Timeline\n\n${fenced(JSON.stringify(row.marker))}`);
        break;
// [失败路径] 解析不到即抛 invalid_contract：投影校验保证 artifact 与 manifest 一一对应，
// 走到这里解析失败只可能是本端状态被破坏，继续渲染会产出指向不存在文件的路径。
// 这是本文件唯一允许抛错的分支，因为静默跳过会让模型看到悬空引用。
      case "artifact": {
        const artifact = paths.get(row.artifactVersionId);
        if (!artifact) {
          throw new ConversationShareServiceError(
            "invalid_contract",
            "Shared context artifact was not installed",
          );
        }
        sections.push(
          [
            `## Artifact: ${artifact.displayName}`,
            `- Path: ${artifact.workspaceRelativePath}`,
            `- MIME: ${artifact.mimeType}`,
            `- SHA-256: ${artifact.sha256}`,
          ].join("\n"),
        );
        break;
      }
// subagent 与 hookInvocation 属于 V1 投影明确排除的本地结构；
// 它们出现在这里说明投影被绕过，必须显式失败而不是猜语义。
      case "subagent":
      case "hookInvocation":
        throw new ConversationShareServiceError(
          "invalid_contract",
          `Unsupported shared context row: ${row.kind}`,
        );
// 未知 kind 记入 unsupportedKinds 后继续；调用方据此打 info 日志，
// 让「新版分享在旧客户端少了内容」有可检索的证据。
      default:
        // 未来新增的 row kind：不抛（一行认不出不该让整次导入失败），但也不能静默——
        // 模型侧少内容必须留痕，否则只能靠用户发现回答漏了东西。
        unsupportedKinds.add((row as { kind?: string }).kind ?? "unknown");
        break;
    }
  }
// 统一以单个换行结尾，并固定用空行分隔区块；markdownSha256 依赖这一点，
// 任何格式微调（比如改成 \r\n）都会让同一份分享在不同平台上算出不同摘要。
  const markdown = `${sections.join("\n\n")}\n`;
  return {
    formatterVersion: 1,
    markdown,
    markdownSha256: createHash("sha256").update(markdown, "utf8").digest("hex"),
    unsupportedKinds: [...unsupportedKinds],
  };
}
