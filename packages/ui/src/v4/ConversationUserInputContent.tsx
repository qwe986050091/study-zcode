// INV-01 只认入口确认：守住位置 权威目标索引；改错故障：普通提示被画成控制命令。
// INV-02 原文可回退：守住位置 非权威分支；改错故障：复制或编辑得到被改写的文本。
// INV-03 附件即普通：守住位置 带附件时的判定；改错故障：带附件的同名文本被误判。
// INV-04 紧凑排除：守住位置 紧凑命令分支；改错故障：紧凑标记也走目标解析。
// INV-05 三段保留：守住位置 前中后文本切分；改错故障：高亮时丢失前后原文。
// INV-06 归一不改写：守住位置 标签归一小写；改错故障：展示文本被强制小写。
// INV-07 文件优先：守住位置 文件与目录分支；改错故障：文件标记退化成普通文本。
// INV-08 插件不成链：守住位置 插件分支；改错故障：插件标记被当成可打开链接。
// INV-09 图标受信：守住位置 来源校验；改错故障：任意地址被渲染成图标。
// INV-10 失败回退：守住位置 失败标记；改错故障：破图占位撑开行高。
// INV-11 键稳定：守住位置 片段键组成；改错故障：增删片段后组件状态错配。
// INV-12 类型收窄：守住位置 文本片段早退；改错故障：文本片段进入组件分支。
// INV-13 命令名判定：守住位置 两个别名比较；改错故障：目标别名不识别。
// INV-14 属性可控：守住位置 数据属性注入；改错故障：选中态与样式选择器失配。
// INV-15 空附件常量：守住位置 默认值；改错故障：每次渲染新建数组，记忆化失效。
// INV-16 记忆化：守住位置 memo 包装；改错故障：父组件更新引发全量重渲。
// INV-17 无副作用：守住位置 渲染体；改错故障：渲染期间修改外部状态。
// INV-18 局部状态：守住位置 图标失败引用；改错故障：失败状态泄漏到其它实例。
//
// 模块职责：渲染用户输入消息的提及片段，并解析权威目标查询。
// 状态所有权：解析为纯函数；图标失败状态归单个图标组件。
// 阅读顺序：模式与常量 → 目标解析 → 标签辅助 → 提及分派 → 图标 → 列表渲染。
import { memo, useState } from "react";
import {
  Bot,
  Cable,
  GoalIcon,
  MessagesSquare,
  ScrollText,
  SquareSlash,
  WandSparkles,
} from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { FileDisplayInline } from "@/lib/fileDisplay.js";
import { isTrustedPluginIconSource } from "@/lib/pluginIconSource.js";
import { usePluginReferenceIconProjection } from "@/v4/pluginReferenceIconContext.js";
import {
  getPromptMentionVariantClassName,
  PROMPT_MENTION_BASE_CLASS_NAME,
} from "@/mentions/mentionChip.js";
import {
  formatSkillMentionDisplayLabel,
  parseMentionMarkdown,
} from "@/mentions/mentionMarkdown.js";
import { parseV4VisibleSlashCommand } from "@/v4/slashCommands.js";

// 只匹配开头或空白后的目标标记。
// 后续内容整体保留，便于原样回显。
//
const GOAL_QUERY_TOKEN_PATTERN = /^(\s*)(\/(?:goal|target))(?=\s|$)([\s\S]*)$/i;
const EMPTY_ATTACHMENTS: readonly unknown[] = [];

// match 结果由三段组成：leadingText、commandText、trailingText，前后原文都保留。
// 命令文本单独返回，供界面高亮。
//
export interface V4UserInputGoalQueryDisplay {
  leadingText: string;
  commandText: string;
  trailingText: string;
}

/**
 * 只解析发送入口会消费的 goal query；普通正文和携带附件的同名文本保持原样。
 * 原因：用户消息展示不能仅凭包含 `/goal` 就重猜 command intent，否则上下文 prompt
 * 在隐藏附加块后会被误画成 goal 控制命令。
 */
// 只解析发送入口会消费的目标查询。
// 普通正文与带附件的同名文本保持原样。
// 仅凭包含关键字就重猜意图，会把上下文提示误画成控制命令。
// 紧凑命令不参与此解析，直接返回空。
//
export function parseV4UserInputGoalQuery(
  text: string,
  attachments: readonly unknown[] = EMPTY_ATTACHMENTS,
  contextAttachmentCount = 0,
): V4UserInputGoalQueryDisplay | null {
  const command = parseV4VisibleSlashCommand(text, attachments, {
    contextAttachmentCount,
  });
  if (!command || command.kind === "compact") return null;

  const match = GOAL_QUERY_TOKEN_PATTERN.exec(text);
  if (!match) return null;
  return {
    leadingText: match[1] ?? "",
    commandText: match[2] ?? "",
    trailingText: match[3] ?? "",
  };
}

type V4UserInputMentionPart = ReturnType<typeof parseMentionMarkdown>[number];

// normalizeCommandMentionLabel 先 trim 再去前导斜杠并转小写，仅为比较服务。
// 只用于比较，不改变展示文本。
//
function normalizeCommandMentionLabel(label: string): string {
  return label.trim().replace(/^\/+/, "").toLowerCase();
}

// mentionClassName 统一拼装提及块样式，正文与助手消息体共用 text-ui-base。
// 正文与助手消息体保持同一字号。
//
function mentionClassName(category: Parameters<typeof getPromptMentionVariantClassName>[0]) {
  return cn(
    "mx-0.5 max-w-full",
    PROMPT_MENTION_BASE_CLASS_NAME,
    // userInput 正文使用 text-ui-base，与 assistant 消息体保持一致。
    "text-ui-base leading-6",
    getPromptMentionVariantClassName(category),
  );
}

// V4UserInputMention 由 part.type 分派渲染，命令块走独立分支，非权威命令必须退回纯文本。
// 非权威目标命令必须退回纯文本形态。
//
function V4UserInputMention({
  part,
  authoritativeGoal,
  pluginIcon,
}: {
  part: Exclude<V4UserInputMentionPart, { type: "text" }>;
  authoritativeGoal: boolean;
  pluginIcon?: string;
}) {
  if (part.type === "file" || part.type === "directory") {
    return (
      <span className={mentionClassName("files")}>
        <FileDisplayInline
          path={part.label}
          options={{
            className: "inline-flex min-w-0 max-w-full items-center gap-1 align-middle",
            iconSize: 16,
            kind: part.type === "directory" ? "directory" : "file",
            fileNameClassName: "truncate text-ui-base leading-6 font-medium text-current",
          }}
        />
      </span>
    );
  }

  if (part.type === "skill") {
    return (
      <span className={mentionClassName("skills")}>
        <WandSparkles aria-hidden="true" className="size-4 shrink-0" />
        {formatSkillMentionDisplayLabel(part.label)}
      </span>
    );
  }

  if (part.type === "session") {
    return (
      <span className={mentionClassName("sessions")}>
        <MessagesSquare aria-hidden="true" className="size-4 shrink-0" />
        {part.label}
      </span>
    );
  }

  // 插件引用渲染为标记块，不进文件分支。
  // 也不作为外链打开，避免点击跳走。
  //
  if (part.type === "plugin") {
    // Plugin 引用在气泡里渲染为 chip：不进 file 分支、不可作外链打开。
    return (
      <span className={mentionClassName("plugins")} data-plugin-mention-id={part.pluginId}>
        <PluginUserMessageIcon src={pluginIcon} />
        {part.label}
      </span>
    );
  }

  if (part.type === "subagent") {
    return (
      <span className={mentionClassName("subagents")}>
        <Bot aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.5} />
        {part.label}
      </span>
    );
  }

  const commandName = normalizeCommandMentionLabel(part.label);
  if ((commandName === "goal" || commandName === "target") && !authoritativeGoal) {
    // 旧版纯文本嗅探会把带附件的 `/goal` 普通 prompt 也画成控制命令。
    // V4 只允许发送入口确认的首个 goal token 使用特殊 UI，其余情况必须保持用户原文。
    return `/${part.label}`;
  }

  return (
    <span
      {...(authoritativeGoal ? { "data-v4-user-input-command": "goal" } : {})}
      className={mentionClassName("commands")}
    >
      {commandName === "goal" || commandName === "target" ? (
        <GoalIcon aria-hidden="true" className="size-4 shrink-0" />
      ) : commandName === "compact" ? (
        <ScrollText aria-hidden="true" className="size-4 shrink-0" />
      ) : (
        <SquareSlash aria-hidden="true" className="size-4 shrink-0" />
      )}
      {/* Bug 根因：authoritative goal 使用原始 slash token 回显，导致用户气泡重复暴露
          控制语法。标签保留 Goal 语义，只省略 `/`；复制、编辑和协议仍使用原始 row.text。 */}
      {part.label}
    </span>
  );
}

// 图标来源受信且未失败时才显示图片。
// 加载失败回退为线缆图标，保持布局稳定。
//
function PluginUserMessageIcon({ src }: { src?: string }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = isTrustedPluginIconSource(src) && failedSrc !== src;

  if (!showImage) {
    return <Cable aria-hidden="true" className="size-4 shrink-0" />;
  }

  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      draggable={false}
      data-plugin-mention-icon="true"
      className="inline-block size-4 shrink-0 rounded-sm object-contain align-middle"
      onError={() => setFailedSrc(src ?? null)}
    />
  );
}

// 只有发送入口确认的首个目标标记才用特殊界面。
// 其余情况保持用户原文，复制与编辑仍用原始文本。
//
export const ConversationUserInputContent = memo(function ConversationUserInputContent({
  text,
  attachments = EMPTY_ATTACHMENTS,
  contextAttachmentCount = 0,
}: {
  text: string;
  attachments?: readonly unknown[];
  contextAttachmentCount?: number;
}) {
  const pluginIconProjection = usePluginReferenceIconProjection();
  const goalQuery = parseV4UserInputGoalQuery(text, attachments, contextAttachmentCount);
  const parts = parseMentionMarkdown(text);
  const authoritativeGoalPartIndex = goalQuery
    ? parts.findIndex(
        (part) =>
          part.type === "command" &&
          ["goal", "target"].includes(normalizeCommandMentionLabel(part.label)),
      )
    : -1;

  return (
    <>
      {parts.map((part, index) => {
        if (part.type === "text") {
          return part.text;
        }

        return (
          <V4UserInputMention
            key={`${part.type}-${index}`}
            part={part}
            authoritativeGoal={index === authoritativeGoalPartIndex}
            pluginIcon={
              part.type === "plugin" && part.pluginId
                ? pluginIconProjection?.iconByPluginId.get(part.pluginId)
                : undefined
            }
          />
        );
      })}
    </>
  );
});
