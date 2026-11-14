/* oxlint-disable eslint(max-lines) -- Share 与 Desktop 共用的只读 Row/turn presentation 需要保持在同一安全边界。
 * 安全边界约束：本文件被匿名公开分享页（packages/web/src/share）直接引用，新增依赖必须考虑
 * 公开页 bundle 体积与无 Desktop 宿主（window.zcode / PlatformProvider / tab store）的运行环境；
 * Desktop 专属能力（如 open-with 子树）一律由消费方经组件注入，不得静态 import。 */
// ============================================================================
// ConversationShareReadonlyTimeline.tsx — 只读会话分享时间线
//
// 使用面：匿名公开分享页（packages/web/src/share）与 Desktop 的只读历史。
// 与实时时间线的差别不是「少了交互」，而是输入完全不同：
//   实时版消费 store 里的运行态 row 与本地工具结果；
//   本文件消费「已落盘的协议快照」+「分享内容信封」两份只读数据。
//
// 安全边界（文件顶部 block 注释已有说明，这里给出可执行版本）：
//  1) 不得静态 import Desktop 专属能力（open-with 子树、tab store、platform hooks），
//     否则公开分享页 bundle 会整体拖入桌面运行环境；
//  2) 所有外链必须先校验协议与主机名，未通过一律不打开；
//  3) 图片/资源 URL 来自发布方，只允许经 manifest 映射取用，不拼路径。
//
// INV 不变量表（每条注明守住它的位置）
// INV-01 快照与信封必须先与 rows 交叉校验，未命中的内容一律丢弃。
//         守住：allBlocks 的 filter（rowId + productTurnId + kind 三重匹配）。
// INV-02 被内容块认领的 row 必须从 fallback 时间线中剔除，否则会渲染两次。
//         守住：claimed / claimedResources 两个集合。
// INV-03 被认领但不可用的块仍要占用 fallback 名额，避免删卡后占位文字复活。
//         守住：fallbackBlocks 的 !blocks.some(...) 条件。
// INV-04 工具展示快照只在 row 同属一个 productTurn 时才注入。
//         守住：toolSnapshots 的 rows.some 检查。
// INV-05 marker 只渲染已知类型；识别不了返回 null，绝不打印枚举名。
//         守住：resolveReadonlyMarkerLabel。
// INV-06 附件图片预览失败后要永久降级为文件 pill，不能无限重试。
//         守住：failedPreviewUrl 与 imageSrc 的比较。
// INV-07 导入工件路径必须限制在 .zcode-share/<dir>/shared-artifacts/<file> 四段。
//         守住：resolveImportedArtifactPath 的形状校验。
// INV-08 工件打开动作是注入的，缺注入时只渲染信息卡，不渲染死按钮。
//         守住：artifactOpenContext 的四项齐全条件。
// INV-09 只读时间线不渲染 turnHeader / subagent / hookInvocation 行。
//         守住：renderReadonlyRow 末尾的显式 null 分支。
// INV-10 历史折叠态以 row 的默认值为准；segment 变化时必须重新同步。
//         守住：ReadonlySegment 的 useEffect。
// INV-11 历史状态条只插在「第一个非 userInput 项之前」，且整段只插一次。
//         守住：firstAssistantFlowItemIndex 与 hasHistory 的组合判断。
// INV-12 外链只允许 http/https，且 localhost 类地址必须拒绝。
//         守住：openShareExternalUrl 的两道判断。
// INV-13 分享页的日志不得输出 URL 或文件名（签名地址可能含凭据）。
//         守住：图片 onError 里只记录 MIME。
// INV-14 分组工具调用必须逐个把 snapshot 注入子行，不能只注入父节点。
//         守住：GroupedToolPresentation 的 childToolCalls 映射。
// INV-15 Intl Provider 包在最外层，且默认 zh-CN，保证匿名页不依赖宿主 locale。
//         守住：ConversationShareReadonlyTimeline 的 Provider 包裹。
// INV-16 不可识别行提示用中性信息样式，不用警告色：分享本身没有出错。
//         守住：unsupportedRowCount 的渲染分支。
// INV-17 同一 row 只能出现一次；units 与 blocks 的渲染顺序必须稳定。
//         守住：units 按 allUnits 原始顺序取用（Map 只做查找）。
// INV-18 本文件所有 hook 都必须在叶子组件内，不得在条件分支里调用。
//         守住：renderReadonlyRow 只负责选择组件，不直接调用 hook。
// ============================================================================
import { ToolPresentation } from "@/ToolCallBlocks/ToolPresentation.js";
import {
  useToolPresentationCapabilities,
  ToolPresentationCapabilitiesProvider,
} from "@/ToolCallBlocks/presentationCapabilities.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import type { ShareToolPresentationPayload } from "@zcode/shared";
import {
  createContext,
  Fragment,
  memo,
  type ComponentType,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { ChevronRightIcon, FileTextIcon, InfoIcon } from "lucide-react";
import {
  conversationShareContentEnvelopeSchema,
  decodeConversationShareContentBlocks,
  type Locale,
} from "@zcode/shared";
import type {
  ArtifactRow,
  AssistantTextRow,
  ConversationRow,
  ReasoningRow,
  TimelineMarkerRow,
  ToolCallRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { MessageResponse, type MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import {
  ConversationShareWorkflow,
  hasConversationShareWorkflowDisplay,
} from "@/v4/ConversationShareWorkflow.js";
import { ConversationUserInputBody } from "@/v4/ConversationUserInputBody.js";
import { ConversationUserInputContent } from "@/v4/ConversationUserInputContent.js";
import { PluginReferenceIconProvider } from "@/v4/pluginReferenceIconContext.js";
import {
  buildAssistantWorkRenderItems,
  type ConversationAssistantWorkRenderItem,
} from "@/v4/conversationAssistantWorkItems.js";
import type { ConversationCuaGroupRenderItem } from "@/v4/conversationCuaGroups.js";
import {
  buildConversationTurnRenderUnits,
  type ConversationTurnRenderUnit,
} from "@/v4/conversationTurnRenderUnits.js";
import type { AssistantWorkRow, ConversationTurnFlowItem } from "@/v4/conversationTurnFlowItems.js";
import type { ConversationTurnWorkSegment } from "@/v4/conversationTurnWorkSegments.js";
import { formatConversationWorkDuration } from "@/v4/conversationWorkDuration.js";
import { normalizeConversationShareMarkdown } from "@/v4/conversationShareMarkdown.js";
import {
  DEFAULT_CODE_PREVIEW_SETTINGS,
  type CodePreviewSettings,
} from "@/lib/codePreviewSettings.js";
import { ZCodeIntlProvider, useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { Theme } from "@/useTheme.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { formatAttachmentSize } from "@/lib/chatAttachmentMetadata.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { isAbsoluteFilePath, joinFilePath } from "@/lib/path.js";
// 仅类型引用，构建期擦除：静态 import OpenSplitButton 会把其整棵 open-with 子树
// （platform hooks、tab store、workspace-file-tree/model、editorPreference）打进匿名
// 公开页 bundle，因此打开动作组件改由 Desktop 消费方经 artifactOpenAction 注入。
import type { OpenSplitButtonTarget } from "@/OpenSplitButton.js";

import { ConversationShareContent } from "@/v4/ConversationShareContent.js";
import { logger } from "@/logger.js";

// 输入契约分为四组：
//   1) 主数据：rows 与 contentBlocks；
//   2) 渲染配置：locale / theme / codePreviewSettings；
//   3) 资源映射：artifactUrls / artifactNames / workspace 相对路径；
//   4) 可选能力注入：打开文件、打开代码预览、artifact 打开动作。
// 所有可选能力缺省时都必须退化为「只读不可操作」，而不是报错。
export interface ConversationShareReadonlyTimelineProps {
  contentBlocks?: readonly unknown[];
  rows: readonly ConversationRow[];
  locale?: Locale;
  theme?: Theme;
  codePreviewSettings?: CodePreviewSettings;
  artifactUrls?: ReadonlyMap<string, string>;
  artifactNames?: ReadonlyMap<string, string>;
  artifactWorkspaceRelativePaths?: ReadonlyMap<string, string>;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  /**
   * Desktop 侧注入的 artifact 打开动作组件（实现即 OpenSplitButton）。
   * 公开分享页不传：一是公开页没有本地打开能力，二是避免 open-with 子树进公开页 bundle。
   */
  artifactOpenAction?: ConversationShareArtifactOpenAction;
  /**
   * 本 build 认不出、已被跳过的行数（见 decodeConversationShareRows）。
   *
   * >0 时在时间线顶部出一条中性提示。必须提示：分享内容是跨版本流动的，老客户端/老落地页
   * 镜像遇到新 row kind 时会静默少几行，用户没法自己发现——他会以为分享者就发了这些。
   */
  // 这个数字由 decodeConversationShareRows 在解码阶段统计，本组件只负责提示。
  // 为什么必须提示：分享内容是跨版本流动的。老客户端遇到新 row kind 会静默少几行，
  // 用户没有任何线索，只会以为分享者本来就没发那些内容。
  // 为什么用中性样式：数据本身没损坏，只是当前 build 不认识，不属于错误态。
  unsupportedRowCount?: number;
}

/** 注入契约：Desktop 侧提供的「带本地打开动作」组件，与 OpenSplitButton 的关键 props 对齐。 */
// 注入契约刻意只声明与 OpenSplitButton 对齐的三个 props，
// 而不是直接引用它的类型：引用会在类型层把 open-with 子树拉进编译依赖，
// 最终仍可能被 bundler 收进公开页。
// Desktop 侧实现负责把 target 翻译成本地打开动作。
export type ConversationShareArtifactOpenAction = ComponentType<{
  target: OpenSplitButtonTarget;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
}>;

// 文案集合在入口处一次性解析，避免每个行组件各自 formatMessage。
// 字段名即语义：history/computerUse/explore/execute/changes 对应分组标题，
// markerCompact/markerModelChange 对应时间线分割线。
interface ReadonlyLabels {
  history: string;
  computerUse: string;
  explore: string;
  execute: string;
  changes: string;
  artifactPreview: string;
  markerCompact: string;
  markerModelChange: string;
  unsupportedRows: string;
}

/**
 * 只读时间线里 marker 的文案。
 *
 * 这里刻意不复刻实时时间线的全部状态细分（compact 的 started/failed/interrupted、
 * modelChange 的 from→to、goalVerify 的迭代序号）：发布会拦掉运行中的 marker，
 * 而 from→to 需要 model-provider store 才能解析显示名，只读历史里价值很低。
 * 识别不了的类型返回 null，由调用方整行不渲染 —— 绝不回退成打印枚举名。
 */
// 只读场景的 marker 文案解析，刻意比实时版窄：
//   compact 只在 success 时展示（失败/中断的压缩过程不该出现在已发布历史里）；
//   modelChange 不展示 from->to（需要 model-provider store 解析显示名）；
//   goalVerify 等其他类型一律 null。
// 返回 null 的语义是「整行不渲染」，调用方不能退化成打印 row.marker.type。
// 这条曾经是真实缺陷：分享页出现过一条写着字面量 compact 的分割线。
function resolveReadonlyMarkerLabel(
  marker: TimelineMarkerRow["marker"],
  labels: ReadonlyLabels,
): string | null {
  switch (marker.type) {
    case "compact":
      return marker.status === "success" ? labels.markerCompact : null;
    case "modelChange":
      return labels.markerModelChange;
    default:
      return null;
  }
}

// 四个空常量用于 props 缺省值。
// 必须是模块级常量而不是每次渲染 new Map()：
// 空 Map 的新引用会让下游 useMemo 每次都重算。
const EMPTY_ARTIFACT_URLS: ReadonlyMap<string, string> = new Map();
const EMPTY_ARTIFACT_NAMES: ReadonlyMap<string, string> = new Map();
const EMPTY_ARTIFACT_WORKSPACE_RELATIVE_PATHS: ReadonlyMap<string, string> = new Map();
const EMPTY_ATTACHMENTS: readonly unknown[] = [];

interface ArtifactOpenContextValue {
  artifactWorkspaceRelativePaths: ReadonlyMap<string, string>;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  openAction?: ConversationShareArtifactOpenAction;
}

const ArtifactOpenContext = createContext<ArtifactOpenContextValue | null>(null);

// 把「工作区相对路径」解析成绝对路径，用于本地打开注入的工件。
// 校验分两步：绝对路径直接拒绝；再按四段形状校验。
// 为什么只校验形状、不交叉比对 shareId：
//   元数据由本端导入服务写入（目录名是 sanitize 后的 share_id），自洽；
//   UI 侧再比对就得复制 service 的 sanitize 规则，两边漂移会让合法导入静默失去按钮；
//   而路径始终被限制在 .zcode-share/<dir>/shared-artifacts/ 内，没有越权放大。
// 返回 null 时调用方只渲染不可点击的信息卡。
function resolveImportedArtifactPath(
  workspacePath: string,
  workspaceRelativePath: string | undefined,
): string | null {
  // 取舍：这里只校验形状（.zcode-share/<dir>/shared-artifacts/<file> 四段），刻意不把
  // 段 2 与导入记录的 shareId 交叉比对。元数据由本端导入服务自写（conversationShareService
  // 落盘时用 sanitizeFileSegment(share_id) 作目录名），自洽；若在 UI 侧比对，就得复制
  // service 层的 sanitize 规则，两边漂移会让合法导入静默丢打开按钮，而收益仅是防住
  // 「指向另一 share 目录」这种一致性噪声——路径仍被限制在 workspace 的
  // .zcode-share/*/shared-artifacts/ 内，无越权读放大。
  const normalizedPath = workspaceRelativePath?.trim();
  // 先拒绝绝对路径，再做分段校验：Windows 盘符路径可能被 split 成奇怪段数，
  // 如果先分段，某些畸形输入会恰好凑出四段而绕过检查。
  if (!normalizedPath || isAbsoluteFilePath(normalizedPath)) {
    return null;
  }

  const segments = normalizedPath.replace(/\\/g, "/").split("/");
  if (
    segments.length !== 4 ||
    segments.some((segment) => !segment || segment === "." || segment === "..") ||
    segments[0] !== ".zcode-share" ||
    segments[2] !== "shared-artifacts"
  ) {
    return null;
  }

  return joinFilePath(workspacePath, segments.join("/"));
}

// 用户输入附件：图片走缩略图预览，其余走文件 pill。
// URL 通过 artifactUrls 按 ref 的末段文件名查找 —— manifest 的键是文件名，
// 不是完整 ref 路径，因此这里必须取 .at(-1)。
// 预览与下载可以是两个不同 URL：previewRef 缺失时退回原图。
function UserInputAttachment({
  attachment,
  artifactUrls,
}: {
  attachment: NonNullable<UserInputRow["attachments"]>[number];
  artifactUrls: ReadonlyMap<string, string>;
}) {
  // 只记录「失败的 URL」而不是布尔值：
  // URL 变化（同一附件换了签名地址）时应自动重试，布尔值会一直锁死降级态。
  const [failedPreviewUrl, setFailedPreviewUrl] = useState<string>();
  // manifest 的键是文件名而不是完整 ref，因此这里按末段查找。
  // split 后 at(-1) 在空串上返回 ""，get 得到 undefined，
  // 最终附件退化成不可点击的 pill（aria-disabled），不会渲染坏链接。
  const url = artifactUrls.get(attachment.ref.split("/").at(-1) ?? "");
  // 预览图与下载地址可以不同：previewRef 指向缩略图，ref 指向原文件。
  // 两者都按 ref 末段文件名去 manifest 里查，查不到则该路为空。
  const previewUrl = attachment.previewRef
    ? artifactUrls.get(attachment.previewRef.split("/").at(-1) ?? "")
    : undefined;
  // 只按 MIME 前缀决定是否当图片渲染，不嗅探扩展名：
  // 扩展名来自不可信输入，MIME 至少是发布端声明的类型。
  // imageSrc 为空时走 pill 分支，因此不会出现破图占位。
  const imageSrc = attachment.mime.startsWith("image/") ? (previewUrl ?? url) : undefined;
  // Bug 根因：只读分享把所有输入附件都画成文件 pill，丢失了已上传图片的展示。
  // 复用公开 manifest 地址取图；不读取原宿主文件，失败时仍保留原附件下载入口。
  if (imageSrc && failedPreviewUrl !== imageSrc) {
    return (
      <a
        href={url}
        target={url ? "_blank" : undefined}
        rel={url ? "noopener noreferrer" : undefined}
        aria-disabled={url ? undefined : "true"}
        title={attachment.fileName}
        className="block size-24 max-w-full overflow-hidden rounded-lg border border-border bg-surface hover:border-border-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
      >
        <img
          src={imageSrc}
          alt={attachment.fileName}
          loading="lazy"
          referrerPolicy="no-referrer"
          className="size-full object-contain"
          onError={() => {
            setFailedPreviewUrl(imageSrc);
            // 签名下载地址可能含凭据，诊断仅记录 MIME，不输出 URL 或附件名。
            logger.warn("[share-input-image] preview failed", { mime: attachment.mime });
          }}
        />
      </a>
    );
  }
  return (
    <a
      href={url}
      target={url ? "_blank" : undefined}
      rel={url ? "noopener noreferrer" : undefined}
      aria-disabled={url ? undefined : "true"}
      className="flex max-w-full min-w-0 items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-ui-sm text-foreground hover:bg-surface-hover"
      data-v4-user-input-attachment-pill="true"
    >
      <FileTextIcon aria-hidden="true" className="size-4 shrink-0" />
      <span className="min-w-0 max-w-64 truncate">{attachment.fileName}</span>
      <span className="shrink-0 text-foreground-subtlest">
        {formatAttachmentSize(attachment.bytes)}
      </span>
    </a>
  );
}

// 一条用户输入 = 可选附件区 + 文本气泡。
// `UserInputPresentation` 的附件与气泡都右对齐，与实时时间线保持同一套视觉。
// attachments 为空时完全不渲染附件容器，避免多出一段 8px 间距。
function UserInputPresentation({
  row,
  artifactUrls,
}: {
  row: UserInputRow;
  artifactUrls: ReadonlyMap<string, string>;
}) {
  // 缺省空数组而不是 undefined，后面直接读 length 与 map，
  // 避免在三处分支重复写可选链。
  const attachments = row.attachments ?? [];
  return (
    <div className="flex flex-col items-end" data-conversation-share-row-kind="userInput">
      {attachments.length > 0 ? (
        <div
          className="mb-2 flex w-full max-w-xl flex-wrap items-start justify-end gap-2"
          data-v4-user-input-attachments="true"
        >
          {attachments.map((attachment, index) => (
            <UserInputAttachment
              key={`${attachment.ref}-${index}`}
              attachment={attachment}
              artifactUrls={artifactUrls}
            />
          ))}
        </div>
      ) : null}
      <div
        data-v4-user-input-bubble="true"
        className="flex max-w-xl flex-col gap-2 rounded-xl rounded-tr-xs border border-border bg-surface px-4 py-3 text-ui-base text-foreground"
      >
        <ConversationUserInputBody contentText={row.text} rowId={row.rowId}>
          <ConversationUserInputContent
            text={row.text}
            attachments={row.attachments ?? EMPTY_ATTACHMENTS}
          />
        </ConversationUserInputBody>
      </div>
    </div>
  );
}

// assistant 正文。memo 是必要的：流式历史里同一个 turn 可能有上百行，
// 每次父级重渲染都重新解析 markdown 会明显卡顿。
// renderZCodeFileCitations 关闭：只读快照里没有可用的文件引用上下文。
const AssistantTextPresentation = memo(function AssistantTextPresentation({
  row,
  theme,
  codePreviewSettings,
  artifactNames,
  onOpenExternalUrl,
}: {
  row: AssistantTextRow;
  theme: Theme;
  codePreviewSettings: CodePreviewSettings;
  artifactNames: ReadonlyMap<string, string>;
  onOpenExternalUrl: (url: string) => void;
}) {
  // 分享正文需要先做一次 markdown 归一化：把引用/附件标记替换成纯文本，
  // 因为只读快照里没有可跳转的引用目标。
  // 依赖只有 [artifactNames, row.text]，artifactNames 变化会触发重新归一化。
  const markdown = useMemo(
    () => normalizeConversationShareMarkdown(row.text, artifactNames),
    [artifactNames, row.text],
  );
  return (
    <div data-conversation-share-row-kind="assistantText" className="group/assistant-row">
      <div data-conversation-selectable="true" className="w-full text-ui-base">
        <MessageResponse
          streaming={false}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          renderZCodeFileCitations={false}
          onOpenExternalUrl={onOpenExternalUrl}
        >
          {markdown}
        </MessageResponse>
      </div>
    </div>
  );
});

// 思考过程折叠块。durationMs 向上取整到秒并至少为 1，
// 避免「思考了 0 秒」这种不可能是真实值的展示。
// autoCollapseKey 用 row.state，让只读历史里的多个 reasoning 各自独立展开。
const ReasoningPresentation = memo(function ReasoningPresentation({ row }: { row: ReasoningRow }) {
  // Math.max(1, ...) 保证至少显示 1 秒：
  // 0ms 的思考块在视觉上不应出现「思考了 0 秒」。
  const durationSeconds =
    row.durationMs === undefined ? undefined : Math.max(1, Math.ceil(row.durationMs / 1000));
  return (
    <div data-conversation-share-row-kind="reasoning">
      <Reasoning
        className="w-full"
        isStreaming={false}
        autoCollapseKey={row.state}
        {...(durationSeconds === undefined ? {} : { duration: durationSeconds })}
      >
        <ReasoningTrigger streamingText={row.text} />
        <div data-conversation-selectable="true">
          <ReasoningContent>{row.text}</ReasoningContent>
        </div>
      </Reasoning>
    </div>
  );
});

// 工具快照通过 context 下发，而不是逐层传 props：
// 工具渲染树深度由 ToolPresentation 决定，逐层传参会迫使中间层透传不关心的数据。
// 默认值是空 Map，任何未包 Provider 的调用点都退化为「没有分享镜像」，不会崩。
const ToolSnapshotContext = createContext<ReadonlyMap<number, ShareToolPresentationPayload>>(
  new Map(),
);
// 把协议 row 转成工具展示节点，再叠加分享侧快照。
// 叠加顺序（后者覆盖前者）：display -> sharedImages -> cuaApp。
// sharedImages 只在至少一张图能解析出 URL 时写入；
// sharedImageSrc 取第一张，是给只接受单图的老渲染器兜底。
// snapshot 缺失时直接返回原节点，零成本路径。
function toolNodeWithSnapshot(
  row: ToolCallRow,
  snapshot: ShareToolPresentationPayload | undefined,
  resourceUrl: (ref: string) => string | undefined,
) {
  const node = toolCallRowToLegacyNode(row);
  if (!snapshot) return node;
  // flatMap 而不是 map + filter：解析不出 URL 的图片要整条丢弃，
  // 保留空对象会让渲染器拿到 undefined src 并渲染破图。
  const images = snapshot.images?.flatMap((image) => {
    const src = resourceUrl(image.resource_id);
    return src ? [{ src, mimeType: image.mime_type }] : [];
  });
  // 只覆盖快照实际提供的字段，用条件展开而不是赋 undefined：
  // raw 会被工具渲染器按 key 存在性判断分支，写入 undefined 会命中错误分支。
  // sharedImageSrc 取第一张图，仅为兼容只接受单图的旧渲染器。
  node.toolCall.raw = {
    ...(node.toolCall.raw as Record<string, unknown>),
    ...(snapshot.display ? { display: snapshot.display } : {}),
    ...(images?.length ? { sharedImages: images, sharedImageSrc: images[0]!.src } : {}),
    ...(snapshot.app_name ? { cuaApp: { name: snapshot.app_name } } : {}),
  };
  return node;
}
// 工具调用展示。两条分支互斥：
//   workflow 类 row 走 ConversationShareWorkflow（分享专用聚合视图）；
//   其余走通用 ToolPresentation，并传入 authoritativeAgentType 与 showTodoToolCalls=false。
// 只读历史不展示 todo 工具调用：它们的中间态对读者没有意义，只会制造噪音。
const ToolCallPresentation = memo(function ToolCallPresentation({
  row,
  theme,
  codePreviewSettings,
  // 该组件不消费 artifactNames，但仍保留同名 prop：
  // 统一的行组件签名让 renderReadonlyRow 的传参保持同构，减少分支差异。
  artifactNames: _artifactNames,
  onOpenExternalUrl,
}: {
  row: ToolCallRow;
  theme: Theme;
  codePreviewSettings: CodePreviewSettings;
  artifactNames: ReadonlyMap<string, string>;
  onOpenExternalUrl: (url: string) => void;
}) {
  // 按 rowId 取快照。rowId 在分享快照里是稳定的数值 id，
  // 不能用数组下标或显示序号替代 —— 跨版本合并后序号会变。
  // 取不到时 toolNodeWithSnapshot 走原节点路径，这是常态而非异常。
  const snapshots = useContext(ToolSnapshotContext);
  // resourceUrl 由外层 capabilities provider 注入，用于把 resource_id 映射成可访问地址。
  // 这里给 ?? (() => undefined) 兜底：未包 provider 时工具组件仍能渲染纯文本结果。
  const { resourceUrl } = useToolPresentationCapabilities();
  const snapshot = snapshots.get(row.rowId);
  const node = useMemo(
    () => toolNodeWithSnapshot(row, snapshot, resourceUrl ?? (() => undefined)),
    [row, snapshot, resourceUrl],
  );
  // workflow 类行有专门的聚合渲染器，必须优先于通用工具渲染，
  // 否则会出现「一个 workflow 被拆成多张工具卡」的重复展示。
  if (hasConversationShareWorkflowDisplay(row))
    return (
      <div data-conversation-share-row-kind="toolCall" data-conversation-selectable="true">
        <ConversationShareWorkflow row={row} theme={theme} />
      </div>
    );
  return (
    <div data-conversation-share-row-kind="toolCall" data-conversation-selectable="true">
      <ToolPresentation
        toolCallNode={node}
        theme={theme}
        codePreviewSettings={codePreviewSettings}
        onOpenBrowserUrl={onOpenExternalUrl}
        authoritativeAgentType={snapshot?.agent_type}
        showTodoToolCalls={false}
      />
    </div>
  );
});

/** 与正文的 AssistantPreviewCards 对齐：同一套 chat.previewCards.* 副标题词汇。 */
// 工件类型 -> 副标题文案 id 的静态映射，与正文预览卡共用同一套 chat.previewCards.* 词表。
// 未收录的类型回退到大写枚举名（如 PDF 之外的未知类型），而不是空字符串。
const ARTIFACT_SUBTITLE_MESSAGE_IDS: Readonly<Record<string, string>> = {
  pdf: "chat.previewCards.pdf",
  docx: "chat.previewCards.docx",
  xlsx: "chat.previewCards.xlsx",
  pptx: "chat.previewCards.pptx",
  md: "chat.previewCards.markdown",
  text: "chat.previewCards.text",
  html: "chat.previewCards.htmlWebsite",
};

// 工件卡片固定 4 段布局：图标 / 名称 / 类型与大小 / 右侧动作。
// 右侧动作有三种优先级：
//   1) 有远程 URL：显示「下载文件」（真实语义是下载，不是预览）；
//   2) 无 URL 但能解析出本地路径且注入了 OpenAction：显示桌面打开动作；
//   3) 都没有：不渲染任何按钮。
// data-share-preview-button 是结构性测试标记，不要因为改样式而删除。
const ArtifactPresentation = memo(function ArtifactPresentation({
  row,
  url,
  previewLabel,
}: {
  row: ArtifactRow;
  url?: string;
  previewLabel: string;
}) {
  // 这里依赖外层 ConversationShareReadonlyTimeline 提供的 Intl Provider。
  // 如果单独渲染 ArtifactPresentation（如测试），必须自行包 Provider，
  // 否则 useZCodeIntl 会抛出「missing provider」而不是静默回退。
  const { intl } = useZCodeIntl();
  // 工件打开上下文为 null 表示「当前环境不支持本地打开」，
  // 此时卡片只展示信息与可选下载，不渲染任何会失败的按钮。
  const artifactOpenContext = useContext(ArtifactOpenContext);
  const OpenAction = artifactOpenContext?.openAction;
  // 与 AssistantPreviewCards 保持同一视觉：44px 图标底板 + 真实文件类型图标 + 中粗标题 + 类型副标题。
  // 图标描述符按显示名解析（扩展名驱动），解析失败时回退到通用文件图标，
  // 不能因为未知扩展名就整卡不渲染。
  const descriptor = resolveFileDisplayDescriptor(row.displayName);
  // artifactType 是协议枚举，不是文件扩展名：
  // 同名扩展（如 md）在不同 artifactType 下可能对应不同副标题，
  // 因此必须先按类型查表，查不到才用大写枚举名兜底。
  const subtitleMessageId = ARTIFACT_SUBTITLE_MESSAGE_IDS[row.artifactType];
  // toUpperCase 兜底只对 ASCII 枚举安全；新增枚举若含连字符，
  // 应补进映射表而不是依赖大写化（会得到 PDF-PREVIEW 这类不可读文案）。
  const typeLabel = subtitleMessageId
    ? intl.formatMessage({ id: subtitleMessageId })
    : row.artifactType.toUpperCase();
  // 只有在「没有远程 URL」时才尝试本地路径：
  // 公开分享页永远没有 URL 之外的打开能力，本地路径只属于 Desktop 导入场景。
  const localPath =
    artifactOpenContext && !url
      ? resolveImportedArtifactPath(
          artifactOpenContext.workspacePath,
          artifactOpenContext.artifactWorkspaceRelativePaths.get(row.artifactVersionId),
        )
      : null;
  // 代码预览源只在「有本地路径」时构造。
  // workspaceIdentity 与 workspaceRemoteSessionId 用条件展开而不是赋 undefined：
  // 序列化与相等比较都会把显式 undefined 当成字段存在，导致下游缓存键抖动。
  // type 固定 file：分享工件在本地就是一个已导入的文件。
  const previewSource: CodeViewerSource | null =
    artifactOpenContext && localPath
      ? {
          type: "file",
          title: row.displayName,
          path: localPath,
          workspacePath: artifactOpenContext.workspacePath,
          ...(artifactOpenContext.workspaceIdentity
            ? { workspaceIdentity: artifactOpenContext.workspaceIdentity }
            : {}),
          ...(artifactOpenContext.workspaceRemoteSessionId
            ? { workspaceRemoteSessionId: artifactOpenContext.workspaceRemoteSessionId }
            : {}),
        }
      : null;
  return (
    // ReadonlyTurn 已提供与正文一致的水平 inset，这里再加 px-4 会让资源卡片两侧各多缩进 16px。
    // 外层不额外加左右 padding：只读 turn 已经提供与正文一致的水平 inset，
    // 再加 px-4 会让资源卡比正文窄 32px，视觉上像嵌套了一层。
    <div data-conversation-share-row-kind="artifact" className="py-1">
      <div className="flex w-full items-center gap-3 rounded-xl border border-card-border bg-card p-3 pr-4 text-foreground">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-md bg-background text-foreground-subtle">
          {descriptor ? (
            <FileDisplayIcon src={descriptor.fileIconSrc} size={24} />
          ) : (
            <FileTextIcon className="size-6" aria-hidden="true" />
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="truncate text-ui-base font-medium leading-5">{row.displayName}</p>
          <p className="truncate text-ui-base leading-5 text-foreground-subtlest">
            {typeLabel} · {formatAttachmentSize(row.sizeBytes)}
          </p>
        </div>
        {url ? (
          // 与正文卡片右侧的 OpenSplitButton 同一视觉（h-7 圆角描边 + input 底色）；
          // 资源 URL 实际触发下载，原「预览文件」文案会误导用户；分享页只保留「下载文件」动作。
          // data-share-preview-button 是测试断言用的结构性标记：语义锁定不依赖 Tailwind 类字符串。
          <div
            data-share-preview-button="true"
            className="flex h-7 shrink-0 items-center overflow-hidden rounded-lg border border-border bg-input transition-all hover:border-border-hover"
          >
            <button
              type="button"
              className="flex h-7 items-center gap-1 px-2 text-ui-sm text-foreground"
              onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
            >
              {previewLabel}
            </button>
          </div>
        ) : previewSource && OpenAction ? (
          <OpenAction
            target={{
              type: "file",
              path: previewSource.path,
              title: row.displayName,
              label: row.displayName,
              previewSource,
            }}
            onOpenFileLink={artifactOpenContext?.onOpenFileLink}
            onOpenCodeViewer={artifactOpenContext?.onOpenCodeViewer}
          />
        ) : null}
      </div>
    </div>
  );
});

// 按 row.kind 分派到具体展示组件。
// 每个分支都必须传 key=row.rowId：同一 turn 内 rowId 唯一，
// 而数组下标在内容块增删时会错位。
// 三个显式返回 null 的类型（subagent / hookInvocation / turnHeader）
// 是「已知但不展示」，与 default 缺失不同 —— 新增 kind 时 TS 会强制补分支。
function renderReadonlyRow(
  row: ConversationRow,
  theme: Theme,
  codePreviewSettings: CodePreviewSettings,
  artifactUrls: ReadonlyMap<string, string>,
  artifactNames: ReadonlyMap<string, string>,
  labels: ReadonlyLabels,
  onOpenExternalUrl: (url: string) => void,
): ReactNode {
  switch (row.kind) {
    case "userInput":
      return <UserInputPresentation key={row.rowId} row={row} artifactUrls={artifactUrls} />;
    case "assistantText":
      return (
        <AssistantTextPresentation
          key={row.rowId}
          row={row}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          artifactNames={artifactNames}
          onOpenExternalUrl={onOpenExternalUrl}
        />
      );
    case "reasoning":
      return <ReasoningPresentation key={row.rowId} row={row} />;
    case "toolCall":
      return (
        <ToolCallPresentation
          key={row.rowId}
          row={row}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          artifactNames={artifactNames}
          onOpenExternalUrl={onOpenExternalUrl}
        />
      );
    case "artifact":
      return (
        <ArtifactPresentation
          key={row.rowId}
          row={row}
          url={artifactUrls.get(row.artifactVersionId)}
          previewLabel={labels.artifactPreview}
        />
      );
    // 分割线渲染。文案为空时返回 null（不是空 div）：
    // 空 div 仍会占用 py-2 与两条 1px 线，视觉上出现无意义的分隔。
    // data-marker-type 保留原始类型，供 E2E 断言；它不参与视觉。
    case "timelineMarker": {
      // 这里原本直接把 row.marker.type 当文案渲染，于是分享页会出现一条写着
      // 字面量 compact / modelChange / goalVerify 的分割线（发布只剥掉 fork/checkpoint 类）。
      // 改为取本地化文案；识别不了的类型不渲染，不再泄漏枚举名。
      // 空文案直接返回 null，且必须早于 JSX 构造 ——
      // 返回 null 后不应继续创建带边框的容器，否则会留下一条 1px 的空白分割带。
      const markerLabel = resolveReadonlyMarkerLabel(row.marker, labels);
      if (!markerLabel) return null;
      return (
        <div
          key={row.rowId}
          data-conversation-share-row-kind="timelineMarker"
          data-marker-type={row.marker.type}
          className="flex w-full items-center gap-3 px-4 py-2 text-ui-base text-foreground-subtle"
        >
          <div aria-hidden="true" className="h-px min-w-8 flex-1 bg-border/50" />
          <span className="min-w-0 break-words text-center leading-5">{markerLabel}</span>
          <div aria-hidden="true" className="h-px min-w-8 flex-1 bg-border/50" />
        </div>
      );
    }
    case "subagent":
    case "hookInvocation":
    case "turnHeader":
      return null;
  }
}

// 分组项只取四种可聚合类型：CUA、explore、execute、changes。
// changes 分组在只读侧被显式关闭（见 ReadonlyAssistantWorkItems），
// 但类型里保留它，因为 buildAssistantWorkRenderItems 的返回类型包含该分支。
type GroupedToolItem = Extract<
  ConversationAssistantWorkRenderItem,
  { kind: "cuaGroup" | "exploreGroup" | "executeGroup" | "changesGroup" }
>;

// 分组展示：把父节点与所有子行一起交给 ToolPresentation。
// 子行必须逐个注入 snapshot（INV-14）：只注入父节点会让组内工具丢失分享镜像。
// cuaGroup 的 events 里包含非工具事件（assistant 文本、reasoning），
// 因此只在 event.kind === "tool" 时注入节点，其余原样透传。
function GroupedToolPresentation({
  item,
  theme,
  codePreviewSettings,
  artifactUrls: _artifactUrls,
  artifactNames,
  labels: _labels,
  onOpenExternalUrl,
}: {
  item: GroupedToolItem;
  theme: Theme;
  codePreviewSettings: CodePreviewSettings;
  artifactUrls: ReadonlyMap<string, string>;
  artifactNames: ReadonlyMap<string, string>;
  labels: ReadonlyLabels;
  onOpenExternalUrl: (url: string) => void;
}) {
  const snapshots = useContext(ToolSnapshotContext);
  const { resourceUrl } = useToolPresentationCapabilities();
  // 分组节点的构造方式：展开父节点字段，再用映射后的子行覆盖 childToolCalls。
  // 不能就地修改 item.node.childToolCalls（上游数据可能被多处引用），
  // 也不能只传父节点（子行会丢失快照），这两种写法都会产生难查的展示缺失。
  const node = {
    ...item.node,
    childToolCalls: item.rows.map((row) =>
      toolNodeWithSnapshot(row, snapshots.get(row.rowId), resourceUrl ?? (() => undefined)),
    ),
  };
  return (
    <div data-conversation-share-work-group={item.kind} data-conversation-selectable="true">
      <ToolPresentation
        toolCallNode={node}
        theme={theme}
        codePreviewSettings={codePreviewSettings}
        onOpenBrowserUrl={onOpenExternalUrl}
        cuaGroupEvents={
          item.kind === "cuaGroup"
            ? item.events.map((event) =>
                event.kind === "tool"
                  ? {
                      ...event,
                      node: toolNodeWithSnapshot(
                        event.row,
                        snapshots.get(event.row.rowId),
                        resourceUrl ?? (() => undefined),
                      ),
                    }
                  : event,
              )
            : undefined
        }
        renderCuaAssistantMessage={(event) => (
          <AssistantTextPresentation
            row={event.row}
            theme={theme}
            codePreviewSettings={codePreviewSettings}
            artifactNames={artifactNames}
            onOpenExternalUrl={onOpenExternalUrl}
          />
        )}
        renderCuaReasoning={(event) => <ReasoningPresentation row={event.row} />}
      />
    </div>
  );
}

// 把一组 assistant 工作行聚合成可渲染项。
// 分组开关的取值是产品决定，不是性能开关：
//   reasoning 全展示、CUA/explore/terminal 开启聚合、changes 关闭聚合。
// stageTailIsRunning 只影响最后一段的「进行中」指示，只读历史里恒为 false。
function ReadonlyAssistantWorkItems({
  rows,
  stageTailIsRunning,
  theme,
  codePreviewSettings,
  artifactUrls,
  artifactNames,
  labels,
  onOpenExternalUrl,
}: {
  rows: readonly AssistantWorkRow[];
  stageTailIsRunning: boolean;
  theme: Theme;
  codePreviewSettings: CodePreviewSettings;
  artifactUrls: ReadonlyMap<string, string>;
  artifactNames: ReadonlyMap<string, string>;
  labels: ReadonlyLabels;
  onOpenExternalUrl: (url: string) => void;
}) {
  // 聚合结果按 [rows, stageTailIsRunning] 记忆。
  // rows 是数组引用，父级必须保证同内容同引用，否则这里每次都会重算全组。
  // useMemo 的第二个参数是固定的展示选项对象，故意内联 —— 它没有外部依赖。
  const items = useMemo(
    () =>
      buildAssistantWorkRenderItems(
        rows,
        { messageStreamShowReasoning: true },
        {
          stageTailIsRunning,
          enableCuaGrouping: true,
          enableExploreGrouping: true,
          enableTerminalGrouping: true,
          enableChangesGrouping: false,
        },
      ),
    [rows, stageTailIsRunning],
  );
  return (
    <div className="flex flex-col gap-4" data-conversation-share-work-items>
      {items.map((item) => {
        if (item.kind === "row") {
          return renderReadonlyRow(
            item.row,
            theme,
            codePreviewSettings,
            artifactUrls,
            artifactNames,
            labels,
            onOpenExternalUrl,
          );
        }
        if (item.kind === "agentToolCall") {
          return (
            <ToolCallPresentation
              key={item.key}
              row={item.row}
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              artifactNames={artifactNames}
              onOpenExternalUrl={onOpenExternalUrl}
            />
          );
        }
        return (
          <GroupedToolPresentation
            key={item.key}
            item={item}
            theme={theme}
            codePreviewSettings={codePreviewSettings}
            artifactUrls={artifactUrls}
            artifactNames={artifactNames}
            labels={labels}
            onOpenExternalUrl={onOpenExternalUrl}
          />
        );
      })}
    </div>
  );
}

// 历史段的头部状态条：已停止 / 已工作 X / 工作中 X / 兜底「历史」。
// 四个优先级自上而下，duration 缺失时不能渲染「已工作」空串。
// ChevronRight 只在「默认收起」时显示：默认展开的段不需要折叠提示。
function ReadonlyHistoryStatus({
  segment,
  open,
  labels,
  locale,
}: {
  segment: ConversationTurnWorkSegment;
  open: boolean;
  labels: ReadonlyLabels;
  locale: Locale;
}) {
  const { intl } = useZCodeIntl();
  // 时长格式化返回 null 表示「没有可用时长」，三处分支都依赖这个 null：
  // running 显示「工作中（无时长）」，其余兜底到 history 文案。
  // 不要在调用处用 ?? 0 兜底，那会渲染出「已工作 0 秒」。
  const duration = formatConversationWorkDuration(segment.workStatus?.durationMs, intl, locale);
  // 状态文案的四级优先：interrupted > running > 有 duration 的 workedFor > history 兜底。
  // interrupted 必须优先于 running：中断的段可能仍带着 running 标记的旧字段，
  // 展示「工作中」会让读者以为会话还在跑。
  const label =
    segment.workStatus?.state === "interrupted"
      ? intl.formatMessage({ id: "chat.history.stopped" })
      : segment.workStatus?.state === "running"
        ? intl.formatMessage({ id: "chat.history.workingFor" }, { duration: duration ?? "" })
        : duration
          ? intl.formatMessage({ id: "chat.history.workedFor" }, { duration })
          : labels.history;
  return (
    <div className="flex w-full border-b border-border/50 pb-2">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          data-conversation-share-history-trigger="true"
          data-history-open={String(open)}
          className="group/history-message inline-flex max-w-full items-center gap-2 text-left text-ui-base text-foreground-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
        >
          <span className="truncate">{label}</span>
          {!segment.assistantHistoryDefaultOpen ? (
            <ChevronRightIcon
              aria-hidden="true"
              className={`size-4 shrink-0 text-foreground-subtlest opacity-70 transition-transform ${open ? "rotate-90" : "rotate-0"}`}
            />
          ) : null}
        </button>
      </CollapsibleTrigger>
    </div>
  );
}

function ReadonlyCuaGroup({
  item,
  theme,
  codePreviewSettings,
  artifactUrls,
  artifactNames,
  labels,
  onOpenExternalUrl,
}: {
  item: ConversationCuaGroupRenderItem;
  theme: Theme;
  codePreviewSettings: CodePreviewSettings;
  artifactUrls: ReadonlyMap<string, string>;
  artifactNames: ReadonlyMap<string, string>;
  labels: ReadonlyLabels;
  onOpenExternalUrl: (url: string) => void;
}) {
  return (
    <GroupedToolPresentation
      item={item}
      theme={theme}
      codePreviewSettings={codePreviewSettings}
      artifactUrls={artifactUrls}
      artifactNames={artifactNames}
      labels={labels}
      onOpenExternalUrl={onOpenExternalUrl}
    />
  );
}

// 一个工作段 = 一个 Collapsible，内部按 flowItems 顺序渲染。
// open 的计算是「默认展开 或 用户手动展开」：
// 默认展开的段禁止用户收起（onOpenChange 传 undefined），
// 因为这类段通常是当前轮的正文，收起会让页面看起来缺内容。
// 四种 flowItem 分支的渲染顺序不可交换，它决定正文与工具块的相对位置。
function ReadonlySegment({
  segment,
  locale,
  theme,
  codePreviewSettings,
  artifactUrls,
  artifactNames,
  labels,
  onOpenExternalUrl,
}: {
  segment: ConversationTurnWorkSegment;
  locale: Locale;
  theme: Theme;
  codePreviewSettings: CodePreviewSettings;
  artifactUrls: ReadonlyMap<string, string>;
  artifactNames: ReadonlyMap<string, string>;
  labels: ReadonlyLabels;
  onOpenExternalUrl: (url: string) => void;
}) {
  // 折叠态是 local state，因为只读页没有全局 UI store。
  // 初值取默认展开态；下面的 effect 在 segment 变化时重新同步，
  // 否则虚拟列表复用组件实例会把上一段的展开态带到下一段。
  const [historyOpen, setHistoryOpen] = useState(segment.assistantHistoryDefaultOpen);
  useEffect(() => {
    setHistoryOpen(segment.assistantHistoryDefaultOpen);
  }, [segment.assistantHistoryDefaultOpen, segment.key]);
  // 历史块可以是独立 item，也可以嵌在 cuaGroup 内部（flowKind=assistantHistory），
  // 两处都要检测，否则「只有分组历史」的段不会出现折叠状态条。
  const hasHistory = segment.flowItems.some(
    (item) =>
      item.kind === "assistantHistory" ||
      (item.kind === "cuaGroup" && item.flowKind === "assistantHistory"),
  );
  // 「默认展开」与「用户展开」是或关系，不是赋值关系：
  // 默认展开的段即使 historyOpen 被置 false 也必须保持展开，
  // 否则会出现「点了折叠但内容还在」的不一致。
  const open = segment.assistantHistoryDefaultOpen || historyOpen;
  // 状态条插在第一个非 userInput 项之前：用户输入属于本轮开头，
  // 把「已工作 3 分钟」放在提问上方会读成上一轮的总结。
  const firstAssistantFlowItemIndex = segment.flowItems.findIndex(
    (flowItem) => flowItem.kind !== "userInput",
  );
  return (
    <Collapsible
      open={open}
      onOpenChange={segment.assistantHistoryDefaultOpen ? undefined : setHistoryOpen}
      className="history-message flex flex-col [&>*+*:not([data-slot='collapsible-content'])]:mt-5"
    >
      {segment.flowItems.map((item: ConversationTurnFlowItem, index) => {
        let content: ReactNode;
        if (item.kind === "userInput") {
          content = <UserInputPresentation row={item.row} artifactUrls={artifactUrls} />;
        } else if (item.kind === "assistantText") {
          content = (
            <AssistantTextPresentation
              row={item.row}
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              artifactNames={artifactNames}
              onOpenExternalUrl={onOpenExternalUrl}
            />
          );
        } else if (item.kind === "cuaGroup") {
          const group = (
            <ReadonlyCuaGroup
              item={item}
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              artifactUrls={artifactUrls}
              artifactNames={artifactNames}
              labels={labels}
              onOpenExternalUrl={onOpenExternalUrl}
            />
          );
          content =
            item.flowKind === "assistantHistory" ? (
              <CollapsibleContent data-history-open={String(open)}>
                <div className="pt-5">{group}</div>
              </CollapsibleContent>
            ) : (
              <div>{group}</div>
            );
        } else if (item.kind === "assistantHistory") {
          content = (
            <CollapsibleContent data-history-open={String(open)}>
              <div className="pt-5">
                <ReadonlyAssistantWorkItems
                  rows={item.rows}
                  stageTailIsRunning={false}
                  theme={theme}
                  codePreviewSettings={codePreviewSettings}
                  artifactUrls={artifactUrls}
                  artifactNames={artifactNames}
                  labels={labels}
                  onOpenExternalUrl={onOpenExternalUrl}
                />
              </div>
            </CollapsibleContent>
          );
        } else {
          content = (
            <ReadonlyAssistantWorkItems
              rows={item.rows}
              stageTailIsRunning={
                segment.workStatus?.state === "running" && index === segment.flowItems.length - 1
              }
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              artifactUrls={artifactUrls}
              artifactNames={artifactNames}
              labels={labels}
              onOpenExternalUrl={onOpenExternalUrl}
            />
          );
        }
        const showHistoryStatus = hasHistory && index === firstAssistantFlowItemIndex;
        return (
          <Fragment key={`${segment.key}:${item.kind}:${index}`}>
            {showHistoryStatus ? (
              <ReadonlyHistoryStatus
                segment={segment}
                open={open}
                labels={labels}
                locale={locale}
              />
            ) : null}
            {content}
          </Fragment>
        );
      })}
      {hasHistory && segment.flowItems.length === 0 ? (
        <ReadonlyHistoryStatus segment={segment} open={open} labels={labels} locale={locale} />
      ) : null}
    </Collapsible>
  );
}

function fallbackWorkSegment(unit: ConversationTurnRenderUnit): ConversationTurnWorkSegment {
  return {
    key: unit.key,
    flowItems: unit.flowItems,
    assistantWorkRows: unit.assistantWorkRows,
    assistantHistoryRows: unit.assistantHistoryRows,
    assistantFollowingRows: unit.assistantFollowingRows,
    assistantHistoryDefaultOpen: unit.assistantHistoryDefaultOpen,
    ...(unit.workStatus ? { workStatus: unit.workStatus } : {}),
  };
}

// 一个 turn 的容器。workSegments 缺失时用 fallbackWorkSegment 把 unit 包成单段，
// 保证新旧两种投影数据都能渲染。
// 三段内容按固定顺序：leadingBoundaryRows -> segments -> browserTurnEndRows -> assistantTailRows。
// content-visibility:auto + contain-intrinsic-size 是长历史页的性能契约：
// 它让浏览器跳过屏外 turn 的布局，改动这两个类会直接影响分享页滚动帧率。
function ReadonlyTurn({
  unit,
  locale,
  theme,
  codePreviewSettings,
  artifactUrls,
  artifactNames,
  labels,
  onOpenExternalUrl,
}: {
  unit: ConversationTurnRenderUnit;
  locale: Locale;
  theme: Theme;
  codePreviewSettings: CodePreviewSettings;
  artifactUrls: ReadonlyMap<string, string>;
  artifactNames: ReadonlyMap<string, string>;
  labels: ReadonlyLabels;
  onOpenExternalUrl: (url: string) => void;
}) {
  // 兼容两种投影：新版 unit 自带 workSegments，旧版只有顶层 rows。
  // fallback 不是错误路径，而是跨版本读取旧分享链接的正常路径，
  // 因此不能在这里打日志或上报。
  const segments = unit.workSegments?.length ? unit.workSegments : [fallbackWorkSegment(unit)];
  return (
    <section
      data-conversation-share-turn={unit.turnId}
      className="mx-auto flex w-full flex-col gap-5 px-4 pb-5 pt-14 @md/conversation:px-6 [content-visibility:auto] [contain-intrinsic-size:0_420px]"
    >
      {unit.leadingBoundaryRows.map((row) =>
        renderReadonlyRow(
          row,
          theme,
          codePreviewSettings,
          artifactUrls,
          artifactNames,
          labels,
          onOpenExternalUrl,
        ),
      )}
      <div className="group/assistant-turn flex w-full flex-col gap-5">
        {segments.map((segment) => (
          <ReadonlySegment
            key={segment.key}
            segment={segment}
            locale={locale}
            theme={theme}
            codePreviewSettings={codePreviewSettings}
            artifactUrls={artifactUrls}
            artifactNames={artifactNames}
            labels={labels}
            onOpenExternalUrl={onOpenExternalUrl}
          />
        ))}
        {unit.browserTurnEndRows.length > 0 ? (
          <ReadonlyAssistantWorkItems
            rows={unit.browserTurnEndRows}
            stageTailIsRunning={false}
            theme={theme}
            codePreviewSettings={codePreviewSettings}
            artifactUrls={artifactUrls}
            artifactNames={artifactNames}
            labels={labels}
            onOpenExternalUrl={onOpenExternalUrl}
          />
        ) : null}
        {unit.assistantTailRows.length > 0 ? (
          <ReadonlyAssistantWorkItems
            rows={unit.assistantTailRows}
            stageTailIsRunning={false}
            theme={theme}
            codePreviewSettings={codePreviewSettings}
            artifactUrls={artifactUrls}
            artifactNames={artifactNames}
            labels={labels}
            onOpenExternalUrl={onOpenExternalUrl}
          />
        ) : null}
      </div>
    </section>
  );
}

// 外层只做一件事：套 Intl Provider。
// 默认 zh-CN 而不是 navigator.language：匿名分享页没有用户配置，
// 分享内容的主要受众是中文用户，跟随浏览器语言会产生混合语言页面。
export function ConversationShareReadonlyTimeline(props: ConversationShareReadonlyTimelineProps) {
  return (
    <ZCodeIntlProvider initialLocale={props.locale ?? "zh-CN"}>
      <ConversationShareReadonlyTimelineContent {...props} />
    </ZCodeIntlProvider>
  );
}

function ConversationShareReadonlyTimelineContent({
  rows,
  contentBlocks,
  locale = "zh-CN",
  theme = "system",
  codePreviewSettings = DEFAULT_CODE_PREVIEW_SETTINGS,
  artifactUrls = EMPTY_ARTIFACT_URLS,
  artifactNames = EMPTY_ARTIFACT_NAMES,
  artifactWorkspaceRelativePaths = EMPTY_ARTIFACT_WORKSPACE_RELATIVE_PATHS,
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  onOpenFileLink,
  onOpenCodeViewer,
  artifactOpenAction,
  unsupportedRowCount = 0,
}: ConversationShareReadonlyTimelineProps) {
  const { intl } = useZCodeIntl();
  // rowId 索引用于交叉校验内容块。
  // 内容块携带 fallback_row_id 与 product_turn_id 两个坐标，
  // 只校验其中一个都可能把 A turn 的富内容贴到 B turn 的同名 row 上。
  const rowsById = new Map(rows.map((row) => [row.rowId, row] as const));
  // 解码后的块必须同时满足三个条件才算有效：
  //   1) fallback_row_id 能查到 row；
  //   2) row.productTurnId 与块的 product_turn_id 一致；
  //   3) row.kind 与块类型匹配（tool-presentation -> toolCall，其余 -> assistantText）。
  // 任何一条不满足都说明快照与内容不同源，宁可退回纯文本也不能错位渲染。
  // decode 函数本身对坏数据返回空数组，因此这里不需要额外 try/catch。
  const allBlocks = decodeConversationShareContentBlocks(contentBlocks).filter((block) => {
    const row = rowsById.get(block.fallback_row_id);
    return (
      row?.productTurnId === block.product_turn_id &&
      row.kind === (block.type === "tool-presentation" ? "toolCall" : "assistantText")
    );
  });
  // 工具快照只收 tool-presentation 块，且再次校验 row 存在、kind 与 turn 匹配。
  // 这里重复了 allBlocks 的部分校验，是刻意的：toolSnapshots 会被后续
  // 多个 memo 组件消费，不能依赖上游过滤顺序。
  const toolSnapshots = new Map(
    allBlocks.flatMap((block) =>
      block.type === "tool-presentation" &&
      rows.some(
        (row) =>
          row.kind === "toolCall" &&
          row.rowId === block.fallback_row_id &&
          row.productTurnId === block.product_turn_id,
      )
        ? [[block.fallback_row_id, block.payload] as const]
        : [],
    ),
  );
  // 真正参与 ConversationShareContent 渲染的是 workflow 块。
  // 其他块要么已被 toolSnapshots 消费，要么作为附件信息存在。
  // 再次要求 row 为 assistantText 且 turn 匹配，避免 workflow 挂到工具行上。
  const blocks = allBlocks
    .filter((block) => block.type === "workflow")
    .filter((block) =>
      rows.some(
        (row) =>
          row.rowId === block.fallback_row_id &&
          row.kind === "assistantText" &&
          row.productTurnId === block.product_turn_id,
      ),
    );
  // 信封是 contentBlocks 的原始 schema，用于识别「已知但未渲染」的块。
  // safeParse 失败直接丢弃：坏信封的存在与否不影响页面的正确性。
  // 保留 turn 校验，理由同上。
  const envelopes = (contentBlocks ?? []).flatMap((raw) => {
    const parsed = conversationShareContentEnvelopeSchema.safeParse(raw);
    return parsed.success &&
      rows.some(
        (row) =>
          row.kind === "assistantText" &&
          row.rowId === parsed.data.fallback_row_id &&
          row.productTurnId === parsed.data.product_turn_id,
      )
      ? [parsed.data]
      : [];
  });
  // 两个认领集合分别处理两种重复来源：
  //   claimed：被富内容接管的 assistantText 行；
  //   claimedResources：被内容块引用过的工件版本。
  // 漏掉任一集合，时间线就会和富内容同时渲染同一份数据。
  const claimed = new Set(envelopes.map((block) => block.fallback_row_id));
  // 资源认领按 artifactVersionId 记录，而不是按 rowId：
  // 同一个工件版本可能对应多行引用，只按行剔除会留下重复的工件卡。
  const claimedResources = new Set(allBlocks.flatMap((block) => block.resource_ids));
  // 纯文本兜底表：rowId -> assistantText。
  // 只收 assistantText，因为只有这类行能作为富内容的降级文本；
  // 工具行没有可读的纯文本形态。
  const fallbacks = new Map(
    rows.flatMap((row) => (row.kind === "assistantText" ? [[row.rowId, row.text] as const] : [])),
  );
  // allUnits 保留完整投影，只用于「遍历顺序」；
  // units 是剔除被认领行之后的实际渲染单元，用 key 建索引。
  // 渲染时遍历 allUnits 并以 key 查 units，是为了保持 turn 的原始顺序 ——
  // 直接遍历 units 的 values 会按插入顺序，遇到被整段认领的 turn 时分组会漂移。
  const allUnits = buildConversationTurnRenderUnits(rows);
  // 剔除「已被富内容认领」的行之后重建渲染单元，并按 key 建索引。
  // 重新构建而不是过滤已有 unit：认领可能抽掉某个 turn 的中间行，
  // 就地过滤会留下空段与错误的归属。
  // 两个 buildConversationTurnRenderUnits 调用的参数不同，不是重复代码。
  const units = new Map(
    buildConversationTurnRenderUnits(
      rows.filter(
        (row) =>
          !claimed.has(row.rowId) &&
          !(row.kind === "artifact" && claimedResources.has(row.artifactVersionId)),
      ),
    ).map((unit) => [unit.key, unit]),
  );

  // 外链打开的唯二入口。两道闸：
  //   1) 协议必须 http/https，防止 javascript:/data:/file: 被当作外链；
  //   2) 主机名禁止 localhost/127.x/0.0.0.0/[::1]，防止分享页被用来探测读者本机服务。
  // 解析失败时静默返回：URL 来自不可信 markdown，报错没有可执行动作。
  // window.open 必须带 noopener,noreferrer，避免被打开页拿到 window.opener。
  const openShareExternalUrl = useCallback((url: string) => {
    try {
      const parsed = new URL(url);
      // 协议白名单必须显式枚举，不能用 startsWith("http")：
      // 那会把 httpfoo: 之类的自定义协议放行给系统处理器。
      // 两条判断都 return（而不是 throw），因为调用方在 onClick 里，
      // 异常会冒泡成未捕获错误并打断 React 事件链。
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
      if (/^(localhost|127\..*|0\.0\.0\.0|\[::1\])$/iu.test(parsed.hostname)) return;
      // 重新 toString 而不是直接传原始 url：
      // URL 解析会做归一化（大小写主机、去默认端口），减少畸形串进入浏览器。
      // noopener 与 noreferrer 必须同时给：前者阻止被开页访问 window.opener，
      // 后者避免把分享页地址通过 Referer 泄漏给第三方站点。
      window.open(parsed.toString(), "_blank", "noopener,noreferrer");
    } catch {
      // 外链来自不可信 Markdown；解析失败时保持不可操作，不交给浏览器未知协议。
    }
  }, []);
  // 文案在内容组件内解析一次，经 props 下发给所有行组件。
  // 字段数量与 ReadonlyLabels 一一对应；新增字段时 TS 会强制补齐，
  // 这也是为什么这里用显式对象而不是展开 + 局部覆盖。
  const labels: ReadonlyLabels = {
    history: intl.formatMessage({ id: "conversationShare.readonly.history" }),
    computerUse: intl.formatMessage({ id: "conversationShare.readonly.computerUse" }),
    explore: intl.formatMessage({ id: "conversationShare.readonly.explore" }),
    execute: intl.formatMessage({ id: "conversationShare.readonly.execute" }),
    changes: intl.formatMessage({ id: "conversationShare.readonly.changes" }),
    artifactPreview: intl.formatMessage({ id: "conversationShare.readonly.artifactPreview" }),
    markerCompact: intl.formatMessage({ id: "conversationShare.readonly.markerCompact" }),
    markerModelChange: intl.formatMessage({ id: "conversationShare.readonly.markerModelChange" }),
    unsupportedRows: intl.formatMessage({ id: "conversationShare.readonly.unsupportedRows" }),
  };
  // 只有四项条件全部满足才建立打开上下文：
  //   workspacePath、至少一条相对路径映射、至少一个打开回调、注入的 OpenAction。
  // 缺任一项就返回 null，ArtifactPresentation 会退化成纯信息卡。
  // 这不是防御性冗余 —— 公开页天然缺其中至少两项，必须走 null 路径。
  const artifactOpenContext = useMemo<ArtifactOpenContextValue | null>(() => {
    if (
      !workspacePath ||
      artifactWorkspaceRelativePaths.size === 0 ||
      (!onOpenFileLink && !onOpenCodeViewer) ||
      !artifactOpenAction
    ) {
      return null;
    }

    return {
      artifactWorkspaceRelativePaths,
      workspacePath,
      openAction: artifactOpenAction,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(workspaceRemoteSessionId ? { workspaceRemoteSessionId } : {}),
      ...(onOpenFileLink ? { onOpenFileLink } : {}),
      ...(onOpenCodeViewer ? { onOpenCodeViewer } : {}),
    };
  }, [
    artifactOpenAction,
    artifactWorkspaceRelativePaths,
    onOpenCodeViewer,
    onOpenFileLink,
    workspaceIdentity,
    workspacePath,
    workspaceRemoteSessionId,
  ]);
  return (
    <ToolSnapshotContext.Provider value={toolSnapshots}>
      <ToolPresentationCapabilitiesProvider
        value={{
          readonly: true,
          resourceUrl: (ref) => artifactUrls.get(ref),
          normalizeOutputText: (text) => normalizeConversationShareMarkdown(text, artifactNames),
        }}
      >
        <TooltipProvider delayDuration={0}>
          <PluginReferenceIconProvider value={null}>
            <ArtifactOpenContext.Provider value={artifactOpenContext}>
              <div
                className="@container/conversation flex flex-col"
                data-conversation-share-timeline
              >
                {unsupportedRowCount > 0 ? (
                  // 中性信息语义，不用黄色 warning：分享本身没出错，只是这个 build 认不出其中几行。
                  <div
                    // 结构标记供 E2E 断言「不可识别行提示」是否出现，
                    // 不要改成依赖文案或 class，否则多语言环境会失效。
                    data-conversation-share-unsupported-notice="true"
                    className="mx-4 mb-2 flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-ui-xs text-foreground-subtle"
                  >
                    <InfoIcon aria-hidden="true" className="size-3.5 shrink-0" />
                    <span className="min-w-0 break-words">{labels.unsupportedRows}</span>
                  </div>
                ) : null}
                {allUnits.map((original) => {
                  const unit = units.get(original.key);
                  // 按 turn 过滤富内容块，并剔除「不可用且无运行记录且无工件」的空块。
                  // 剔除条件三项同时成立才生效：只缺一项时仍要渲染（例如有工件但没有 run）。
                  const turnBlocks = blocks.filter(
                    (block) =>
                      block.product_turn_id === original.header?.productTurnId &&
                      !(
                        block.payload.unavailable &&
                        !block.payload.run &&
                        block.payload.artifacts.length === 0
                      ),
                  );
                  // 已知但隐藏的占位块仍认领摘要，避免删卡后占位文字又作为 fallback 出现。
                  // 兜底信封只渲染「已认出但没有对应 workflow 块」的项。
                  // 已被 blocks 覆盖的信封必须排除，否则同一段摘要会出现两次。
                  // 这里用 id 比较而不是 rowId：一个 row 可能对应多个信封变体。
                  const fallbackBlocks = envelopes.filter(
                    (block) =>
                      block.product_turn_id === original.header?.productTurnId &&
                      !blocks.some((known) => known.id === block.id),
                  );
                  return (
                    // 以 allUnits 的原始 key 作为 Fragment key：
                    // 它同时覆盖 turn 文本与随后的富内容区，保证两者在重排时作为整体移动。
                    <Fragment key={original.key}>
                      {unit ? (
                        <ReadonlyTurn
                          unit={unit}
                          locale={locale}
                          theme={theme}
                          codePreviewSettings={codePreviewSettings}
                          artifactUrls={artifactUrls}
                          artifactNames={artifactNames}
                          labels={labels}
                          onOpenExternalUrl={openShareExternalUrl}
                        />
                      ) : null}
                      {turnBlocks.length ? (
                        <div className="min-w-0 px-4 pb-5 @md/conversation:px-6">
                          <ConversationShareContent
                            blocks={turnBlocks}
                            fallbacks={fallbacks}
                            artifactUrls={artifactUrls}
                            locale={locale}
                            onOpenResource={
                              artifactOpenContext && onOpenFileLink
                                ? (id) => {
                                    const path = workspacePath
                                      ? resolveImportedArtifactPath(
                                          workspacePath,
                                          artifactWorkspaceRelativePaths.get(id),
                                        )
                                      : null;
                                    if (path && workspacePath)
                                      onOpenFileLink({
                                        path,
                                        label: artifactNames.get(id) ?? path,
                                        workspacePath,
                                        workspaceIdentity,
                                        workspaceRemoteSessionId,
                                      });
                                  }
                                : undefined
                            }
                          />
                        </div>
                      ) : null}
                      {fallbackBlocks.map((block) => (
                        <div
                          key={block.id}
                          className="px-4 pb-5 @md/conversation:px-6"
                          data-share-content-fallback={block.id}
                        >
                          <MessageResponse>
                            {fallbacks.get(block.fallback_row_id) ?? ""}
                          </MessageResponse>
                        </div>
                      ))}
                    </Fragment>
                  );
                })}
              </div>
            </ArtifactOpenContext.Provider>
          </PluginReferenceIconProvider>
        </TooltipProvider>
      </ToolPresentationCapabilitiesProvider>
    </ToolSnapshotContext.Provider>
  );
}
