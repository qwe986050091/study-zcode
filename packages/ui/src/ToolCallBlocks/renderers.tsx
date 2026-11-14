// INV-01 纯渲染：守住位置 全部渲染函数；改错故障：渲染过程发请求或改写入参。
// INV-02 零变化不渲染：守住位置 统计判空；改错故障：出现加零减零的噪声块。
// INV-03 增删独立：守住位置 两段条件；改错故障：只增或只删时多出一个空占位。
// INV-04 单次翻页：守住位置 数字动画参数；改错故障：为大文件逐行动画，主线程被占满。
// INV-05 方向可读：守住位置 无障碍标签；改错故障：读屏无法区分新增与删除。
// INV-06 可点即按钮：守住位置 文件芯片分支；改错故障：纯文本被赋予点击语义。
// INV-07 行选择隔离：守住位置 按下处理；改错故障：点芯片同时选中整条工具调用。
// INV-08 回调不吞：守住位置 点击处理；改错故障：阻止冒泡时顺手跳过业务回调。
// INV-09 标题兜底：守住位置 芯片标题；改错故障：悬停看不到完整路径。
// INV-10 叶子名：守住位置 文件名取法；改错故障：长路径把行宽撑破。
// INV-11 空路径不占位：守住位置 renderFilePath 判空；改错故障：空路径渲染出破折号。
// INV-12 窄屏让位：守住位置 路径样式；改错故障：窄容器里路径与文件名互相挤压。
// INV-13 推断先行：守住位置 编辑种类推断；改错故障：文案键与操作类型不符。
// INV-14 进行态区分：守住位置 isRunning 分支；改错故障：运行中显示完成文案。
// INV-15 无标签兜底：守住位置 动作标签为空分支；改错故障：未知操作被标成写入。
// INV-16 顺序稳定：守住位置 连接列表键；改错故障：文件顺序变化导致行内重排闪动。
// INV-17 分隔克制：守住位置 首项判断；改错故障：首个文件前多出逗号。
// INV-18 路径基址：守住位置 展示描述符解析；改错故障：相对路径显示成绝对路径。
//
// 模块职责：工具调用块内的 diff 统计、文件芯片与路径的纯渲染函数。
// 状态所有权：无状态；文件摘要、基址与回调全部由调用方传入。
// 阅读顺序：统计 → 文件芯片 → 路径 → 编辑种类 → 连接列表。
import {
  FileDisplayIcon,
  getFileDisplayPath,
  resolveFileDisplayDescriptor,
} from "@/lib/fileDisplay.js";
import { FlipMetricValue } from "@/components/ui/flip-metric-value.js";
import { getPathLeaf } from "@/lib/path.js";
import { inferEditOperation } from "@/ToolCallBlocks/fileSummaries.js";
import type {
  EditKindSource,
  EditKindLabelId,
  EditOperationKind,
  RawToolCallFileSummary,
} from "@/ToolCallBlocks/fileSummaryTypes.js";

// changeStat 缺省或增删都 ≤0（负值按无变化处理）时返回 null：不留「+0 −0」。
// 两段各自按 >0 决定是否出现；外层 tabular-nums 防抖动，aria-label/title 带 +/- 让读屏辨方向。
export function renderDiffCount(
  changeStat?: {
    added: number;
    removed: number;
  },
  options?: { animateInitial?: boolean },
) {
  if (!changeStat) {
    return null;
  }

  // changeStat.added 与 changeStat.removed 都非正数就当作没有变化；异常投影里的负值也走这里。
  if (changeStat.added <= 0 && changeStat.removed <= 0) {
    return null;
  }

  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap font-mono leading-none tabular-nums">
      {changeStat.added > 0 ? (
        <span
          aria-label={`+${changeStat.added}`}
          className="inline-flex items-center text-diff-added"
          role="text"
          title={`+${changeStat.added}`}
        >
          +{/* 性能修复：投影已按秒给出真实统计，数字只做一次短翻页，不再逐行 rAF 追赶。 */}
          <FlipMetricValue
            value={String(changeStat.added)}
            animateInitial={options?.animateInitial}
          />
        </span>
      ) : null}
      {changeStat.removed > 0 ? (
        <span
          aria-label={`-${changeStat.removed}`}
          className="inline-flex items-center text-diff-removed"
          role="text"
          title={`-${changeStat.removed}`}
        >
          -
          <FlipMetricValue
            value={String(changeStat.removed)}
            animateInitial={options?.animateInitial}
          />
        </span>
      ) : null}
    </span>
  );
}

// clickable 时出 button，否则退化成 span；两者 title 都取完整展示路径（缺省 getFileDisplayPath）；正文只放叶子。
// onMouseDown 阻止默认行为与冒泡，避免拖选行；onClick 停冒泡后照样调用 onClick。
export function renderFileChip({
  summary,
  clickable = false,
  onClick,
  title,
  basePath,
}: {
  summary: RawToolCallFileSummary;
  clickable?: boolean;
  onClick?: () => void;
  title?: string;
  basePath?: string;
}) {
  const descriptor = resolveFileDisplayDescriptor(summary.path, {
    basePath,
  });
  const chipTitle = title ?? getFileDisplayPath(summary.path, basePath);

  if (clickable) {
    return (
      <button
        type="button"
        className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-foreground-subtle hover:underline"
        title={chipTitle}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onClick?.();
        }}
      >
        <FileDisplayIcon src={descriptor.fileIconSrc} size={16} className="size-4 shrink-0" />
        <span className="min-w-0 truncate text-foreground-subtle">{getPathLeaf(summary.path)}</span>
      </button>
    );
  }

  return (
    <span
      className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-foreground-subtle"
      title={chipTitle}
    >
      <FileDisplayIcon src={descriptor.fileIconSrc} size={16} className="size-4 shrink-0" />
      <span className="min-w-0 truncate">{getPathLeaf(summary.path)}</span>
    </span>
  );
}

// path 为空返回 null；文本 truncate 且不换行，父容器负责宽度。
export function renderFilePath(path: string | null | undefined, basePath?: string) {
  if (!path) {
    return null;
  }

  return (
    <span className="min-w-0 truncate text-foreground-subtlest @max-[360px]/conversation:hidden">
      {/* 窄会话流里父目录会与文件名争抢空间，Read/Edit 最终只剩动作标签和省略号。
          小容器隐藏次要路径，让文件名继续承担主识别信息。 */}
      {getFileDisplayPath(path, basePath)}
    </span>
  );
}

// 种类由 inferEditOperation 推断（操作类型 + 动作标签，缺省看 source）：write / delete 各有进行态与完成态两套文案键。
// 没有动作标签或来源未知时落到 edit；本函数只选文案键，不改变渲染结构。
export function getEditKindLabelMessageId(
  operationKinds: EditOperationKind[],
  actionLabels: Array<RawToolCallFileSummary["actionLabel"]>,
  isRunning: boolean,
  source?: EditKindSource,
): EditKindLabelId {
  const inferredOperation = inferEditOperation(operationKinds, actionLabels, source);

  if (inferredOperation === "write") {
    return isRunning ? "chat.toolCall.edit.writing" : "chat.toolCall.kind.write";
  }

  if (inferredOperation === "delete") {
    return isRunning ? "chat.toolCall.edit.deleting" : "chat.toolCall.kind.delete";
  }

  if (actionLabels.length === 0) {
    return isRunning ? "chat.toolCall.edit.editing" : "chat.toolCall.kind.edit";
  }

  return isRunning ? "chat.toolCall.edit.editing" : "chat.toolCall.kind.edit";
}

// 首个芯片前不加逗号（index > 0 才插分隔）；key 取 summary.path，回调按每个摘要重新绑定。
export function renderJoinedFileChips(
  summaries: RawToolCallFileSummary[],
  options: {
    clickable?: boolean;
    onClick?: (summary: RawToolCallFileSummary) => void;
    basePath?: string;
  } = {},
) {
  return (
    <div className="inline-flex min-w-0 items-center">
      {summaries.map((summary, index) => (
        <span key={summary.path} className="inline-flex min-w-0 items-center">
          {index > 0 ? <span className="mx-1 text-foreground-subtlest">,</span> : null}
          {renderFileChip({
            summary,
            clickable: options.clickable,
            basePath: options.basePath,
            onClick: options.onClick ? () => options.onClick?.(summary) : undefined,
          })}
        </span>
      ))}
    </div>
  );
}
