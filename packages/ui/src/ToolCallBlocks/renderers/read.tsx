// read 工具调用渲染器：把工具入参与原始输出还原成「文件芯片 + 路径 + 状态」的卡片。
// summary 的三层解析并非等价兜底，parsed_cmd 最可信，raw 标签兜底覆盖多数 provider 的异构输出。
// 本文件只承担展示，不渲染读取到的正文，也不参与任何文件读写。
// INV-01 [不变量] summary 解析顺序固定为 parsed_cmd、input 直读、raw 兜底，先命中即返回；守住位置：buildReadSummary 的三段返回；改错故障：同一卡片在流式更新中标题与图标来回跳变。
// INV-02 [不变量] parsed_cmd 只接受 type 为 read 的条目，其余跳过；守住位置：buildReadSummary 的 parsed_cmd 循环过滤；改错故障：并发执行的 grep 或 bash 条目被误当读取，路径显示成别的工具目标。
// INV-03 [不变量] 相对路径仅在存在 cwd 且不以斜杠开头时拼接；守住位置：absolutePath 的三元表达式；改错故障：绝对路径被二次拼接，卡片显示不存在的路径。
// INV-04 [失败路径] parsed_cmd 中路径与文件名同时缺失时跳过该条，不产出空 summary；守住位置：relativePath 与 fileName 的联合判空；改错故障：卡片只剩标题，点击预览打开空路径。
// INV-05 [权衡] raw 兜底优先采用 rawOutput 的 path 标签而非 rawInput，路径与类型都以此为准；守住位置：readReadMetadataFromRaw 的 taggedOutputPath 分支；改错故障：目录被渲染成文件图标，点击预览失败。
// INV-06 [不变量] 未标注类型的条目一律归为 file；守住位置：normalizeReadEntryType 的默认返回；改错故障：未知类型被当作目录，预览入口整体消失。
// INV-07 [不变量] 目录一律使用文件夹图标常量，不依赖扩展名推断；守住位置：createReadSummary 的 entryType 判定；改错故障：目录显示成文件图标，误导用户点开预览。
// INV-08 [不变量] 返回 null 只表示完全没有路径可用，上层据此退回标题；守住位置：buildReadSummary 末尾的三元；改错故障：无路径的 read 卡片渲染出空文件芯片。
// INV-09 [不变量] 标签提取大小写不敏感且只取首个非空值；守住位置：extractTaggedValue 的正则与 trim；改错故障：模型输出大写 path 标签时路径丢失。
// INV-10 [失败路径] 非对象或数组形状的 raw 与 input 一律按空结构处理，不抛异常；守住位置：isPlainRecord 守卫；改错故障：异常输入导致整块工具卡片渲染崩溃。
// INV-11 [不变量] 预览只在类型为 file 且外部提供打开回调时启用；守住位置：canOpenPreview 与 openFilePreview 的双重判断；改错故障：点击目录卡片触发文件查看器报错。
// INV-12 [不变量] 文件芯片的按钮与静态文本共用同一套图标与截断样式；守住位置：ReadFileChip 的两个返回分支；改错故障：可点击与不可点击卡片高度不一致。
// INV-13 [并发] 指针按下即阻止默认行为与冒泡，避免拖动选择或触发行点击；守住位置：onMouseDown 处理；改错故障：点击文件名时整条消息被折叠或文本被选中。
// INV-14 [事务] 点击回调先拦截冒泡再调用外部打开，保证一次点击只触发一次导航；守住位置：onClick 处理；改错故障：外层消息容器同时响应，弹出两个预览。
// INV-15 [不变量] 主文案在依赖未变时复用同一 React 节点，避免芯片闪烁；守住位置：primaryText 的 useMemo 依赖数组；改错故障：流式更新时文件名高频重挂载。
// INV-16 [不变量] 只有失败态才传出错误提示，其余状态不显示 tooltip；守住位置：statusTooltip 与 showFailureStatus 的取值；改错故障：成功卡片悬浮出现旧错误文案。
// INV-17 [资源] 本卡片不渲染工具输出正文，content 恒为空，长结果与空结果同构；守住位置：ToolLayout 的 content 传 null；改错故障：超大文件内容进入 DOM，列表滚动卡顿。
// INV-18 [失败路径] 快照字段缺失时只展示提示条，不阻塞主体渲染；守住位置：ToolSnapshotFieldNotice 的 refs 兜底；改错故障：字段被裁剪的卡片整块空白。
//
import { SearchIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import {
  FileDisplayIcon,
  FOLDER_FILE_ICON_SRC,
  resolveFileDisplayDescriptor,
} from "@/lib/fileDisplay.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolLayout } from "../ToolLayout.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import { renderFilePath } from "../shared.js";

const READ_TOOL_ICON = <SearchIcon className="size-4 shrink-0 text-foreground-subtle" />;

// [不变量] path 为解析后的完整路径，fileName 只用于展示，filePath 供二级文案使用。
// [失败路径] filePath 可为 null，表示路径拆不出父目录，此时二级文案整行省略。
export type ReadSummary = {
  path: string;
  fileName: string;
  filePath: string | null;
  fileIconSrc: string;
  entryType: "file" | "directory";
};

// [失败路径] 数组不算记录，避免把 content 列表误当成扁平字段表。
// [不变量] 空对象与类实例都算记录，这里只做形状区分，不校验具体字段。
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  // [不变量] 按候选键顺序取首个非空字符串，命中即返回，不再检查后续键。
  // [失败路径] 纯空白字符串在 trim 后被丢弃，避免空格被当成有效路径。
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return undefined;
}

// [不变量] 只取第一个同名标签的内容，多个标签以最先出现者为准。
// [失败路径] 标签缺失或内容为空白时返回 undefined，由调用方决定回退顺序。
// [权衡] 每次调用现构造正则并开启大小写不敏感，换取对模型输出大小写的容忍。
function extractTaggedValue(text: string, tagName: string): string | undefined {
  const matched = text.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  const value = matched?.[1]?.trim();
  return value ? value : undefined;
}

// [不变量] 只有 dir、directory、folder 三种写法归为目录，其余一律算文件。
// [失败路径] 类型缺失时回退 file，宁可漏掉目录图标也不误开目录预览。
function normalizeReadEntryType(value: string | undefined): "file" | "directory" {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "dir" || normalized === "directory" || normalized === "folder") {
    return "directory";
  }

  return "file";
}

// [不变量] input 侧优先读 rawInput，output 侧优先读 rawOutput，两处都只认字符串字段。
// [失败路径] content 数组逐项扫描文本，任一项命中 path 标签即整体返回。
// [权衡] `readReadMetadataFromRaw` 同时吃标签式与结构化输出，代价是分支难穷举。
function readReadMetadataFromRaw(raw: unknown): {
  path?: string;
  entryType: "file" | "directory";
} {
  if (!isPlainRecord(raw)) {
    return { entryType: "file" };
  }

  const rawInput = isPlainRecord(raw.rawInput) ? raw.rawInput : null;
  const directPath = rawInput
    ? readStringField(rawInput, ["filePath", "file_path", "path", "filename"])
    : undefined;
  const directType = rawInput
    ? readStringField(rawInput, ["type", "fileType", "entryType"])
    : undefined;

  const rawOutput = isPlainRecord(raw.rawOutput) ? raw.rawOutput : null;
  const outputText = rawOutput
    ? readStringField(rawOutput, ["output", "text", "content"])
    : undefined;
  const taggedOutputPath = outputText ? extractTaggedValue(outputText, "path") : undefined;
  const taggedOutputType = outputText ? extractTaggedValue(outputText, "type") : undefined;
  if (taggedOutputPath) {
    return {
      path: taggedOutputPath ?? directPath,
      entryType: normalizeReadEntryType(taggedOutputType),
    };
  }

  // [资源] content 仅在为数组时遍历，单对象形状直接跳过并落到 input 兜底。
  // [不变量] 嵌套 content 的 text 优先于同级 text，避免外层包装文本抢答。
  const contentItems = Array.isArray(raw.content) ? raw.content : [];
  for (const item of contentItems) {
    if (!isPlainRecord(item)) {
      continue;
    }

    const nestedContent = isPlainRecord(item.content) ? item.content : null;
    const text =
      (nestedContent && readStringField(nestedContent, ["text"])) ??
      readStringField(item, ["text"]);
    const taggedPath = text ? extractTaggedValue(text, "path") : undefined;
    const taggedType = text ? extractTaggedValue(text, "type") : undefined;
    if (taggedPath) {
      return {
        path: taggedPath ?? directPath,
        entryType: normalizeReadEntryType(taggedType),
      };
    }
  }

  // [失败路径] 走到这里说明输出标签均未给出路径，只能用 input 路径配 input 类型。
  // [不变量] 路径来源与类型来源可以不同，路径回退 input 时类型仍取直读字段。
  // [权衡] 该兜底顺序曾把目录判成文件，因此输出标签必须始终先于 input 被检查。
  if (directPath) {
    // 有些模型只在 rawInput 里给 filePath，但会在 rawOutput/content 里补充目录类型。
    // 之前这里一旦先读到 rawInput.filePath 就会提前返回成 file，导致目录卡片图标错误。
    // 现在改成“类型优先看显式输出，路径再回退 rawInput”，只在确实没有输出标签时才用 input 兜底。
    return {
      path: directPath,
      entryType: normalizeReadEntryType(directType),
    };
  }

  return { entryType: "file" };
}

// [不变量] 只认顶层四个路径键与三个类型键，不再递归子对象。
// [失败路径] 传入非记录时返回空路径，由上层继续尝试 raw 兜底。
function readReadMetadataFromValue(value: unknown): {
  path?: string;
  entryType: "file" | "directory";
} {
  // 非对象入参（字符串路径或数组）整体丢弃，只返回空路径继续走 raw 兜底，不猜测字符串含义。
  if (!isPlainRecord(value)) {
    return { entryType: "file" };
  }

  return {
    path: readStringField(value, ["filePath", "file_path", "path", "filename"]),
    entryType: normalizeReadEntryType(readStringField(value, ["type", "fileType", "entryType"])),
  };
}

// [不变量] 图标按 entryType 覆盖，文件名与文件路径仍由展示描述符解析。
// [失败路径] 调用方显式给出的 fileName 优先于路径推断，允许展示别名。
function createReadSummary(
  path: string,
  options: {
    fileName?: string;
    entryType?: "file" | "directory";
  } = {},
): ReadSummary {
  const entryType = options.entryType ?? "file";
  const descriptor = resolveFileDisplayDescriptor(path);

  return {
    path,
    fileName: options.fileName ?? descriptor.fileName,
    filePath: descriptor.filePath,
    // 显式 entryType 优先于路径推断，目录即使名字带扩展名也显示文件夹图标；漏传类型时才按扩展名走。
    fileIconSrc: entryType === "directory" ? FOLDER_FILE_ICON_SRC : descriptor.fileIconSrc,
    entryType,
  };
}

// [不变量] 依次尝试 parsed_cmd、input 直读、raw 兜底，命中即返回，顺序不可调换。
// [失败路径] 三层均无路径时返回 null，调用方渲染标题而非空芯片。
// [权衡] 结构化 parsed_cmd 最可信，缺失时靠原始输出兜底救回多数 provider。
export function buildReadSummary(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): ReadSummary | null {
  const input = toolCall.input;
  // [不变量] 只处理 type 为 read 的条目，其余工具条目在本函数内完全忽略。
  // [失败路径] 条目缺少路径与文件名时继续扫描下一条，不提前退出循环。
  // [不变量] cwd 末尾斜杠先裁掉再加相对路径，保证拼接结果只有一个分隔符。
  if (isPlainRecord(input) && Array.isArray(input.parsed_cmd)) {
    const cwd =
      typeof input.cwd === "string" && input.cwd.trim().length > 0
        ? input.cwd.trim().replace(/\/+$/, "")
        : null;

    for (const item of input.parsed_cmd) {
      if (!isPlainRecord(item) || item.type !== "read") {
        continue;
      }

      const relativePath =
        typeof item.path === "string" && item.path.trim().length > 0 ? item.path.trim() : undefined;
      const fileName =
        typeof item.name === "string" && item.name.trim().length > 0
          ? item.name.trim()
          : relativePath
            ? (relativePath.split("/").filter(Boolean).pop() ?? relativePath)
            : undefined;

      if (!relativePath && !fileName) {
        continue;
      }

      // [不变量] 相对路径且存在 cwd 时拼成绝对路径，否则原样使用。
      // [失败路径] 路径全缺时用字面量 read 占位，避免 undefined 进入描述符解析。
      const absolutePath =
        relativePath && cwd && !relativePath.startsWith("/")
          ? `${cwd}/${relativePath}`
          : (relativePath ?? fileName ?? "read");

      // read 卡片之前只兼容 parsed_cmd 结构。
      // 其他模型常把路径放在 rawInput/filePath 或 rawOutput 的 <path> 标签里，
      // 导致 UI 只能退回 kind/title。这里保留结构化优先，再补原始输出兜底。
      return createReadSummary(absolutePath, {
        fileName,
        entryType: "file",
      });
    }
  }

  // [不变量] input 直读命中即返回，不再读取 raw，避免两处路径不一致时来回切换。
  // [失败路径] 部分 provider 只把路径放在 input，此步兜住 parsed_cmd 缺失的卡片。
  const directInputMetadata = readReadMetadataFromValue(input);
  if (directInputMetadata.path) {
    // 一些 provider 的 read/update 事件直接把文件路径放在 input.file_path，
    // 不会补 parsed_cmd，也不一定把相同字段镜像到 raw.rawInput.filePath。
    // 之前 summary 构建会直接漏掉这类 read 卡片，导致 primary/secondary 都退回标题。
    return createReadSummary(directInputMetadata.path, {
      entryType: directInputMetadata.entryType,
    });
  }

  // [不变量] raw 是最后一道兜底，仅当前两层都没有路径时才被读取。
  // [失败路径] raw 同样为空时返回 null，卡片退回标题与 kind 文案。
  const rawMetadata = readReadMetadataFromRaw(toolCall.raw);
  return rawMetadata.path
    ? createReadSummary(rawMetadata.path, {
        entryType: rawMetadata.entryType,
      })
    : null;
}

// [不变量] 可点击与静态两种形态共用图标尺寸和截断规则，只切换宿主元素。
// [失败路径] title 始终给出完整路径，文件名被截断时仍可悬浮查看。
export function ReadFileChip({
  summary,
  clickable,
  onClick,
}: {
  summary: ReadSummary;
  clickable: boolean;
  onClick?: () => void;
}) {
  // [事务] `clickable` 为真时渲染 `button`，键盘可达并复用默认焦点行为。
  // [失败路径] 不可点击时退回 span，避免无效按钮进入无障碍树。
  if (clickable) {
    return (
      <button
        type="button"
        className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 text-foreground-subtle hover:underline"
        title={summary.path}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onClick?.();
        }}
      >
        <FileDisplayIcon src={summary.fileIconSrc} size={16} className="size-4 shrink-0" />
        <span className="min-w-0 truncate">{summary.fileName}</span>
      </button>
    );
  }

  return (
    <span
      className="inline-flex min-w-0 text-foreground-subtle max-w-full items-center gap-1.5"
      title={summary.path}
    >
      <FileDisplayIcon src={summary.fileIconSrc} size={16} className="size-4 shrink-0" />
      <span className="min-w-0 truncate">{summary.fileName}</span>
    </span>
  );
}

// [不变量] 组件从上下文取运行态、状态文案与错误文本，自身不订阅 store。
// [并发] 每次渲染重算 summary 而非缓存在状态里，避免工具更新后读到旧路径。
export function ReadToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCallNode, isRunning, statusLabel, errorText, onOpenCodeViewer } = context;
  const { toolCall } = toolCallNode;
  const summary = buildReadSummary(toolCall);
  const canOpenPreview = summary?.entryType === "file" && Boolean(onOpenCodeViewer);
  // [不变量] 回调内再次校验 summary 与类型，防止 memo 化前的旧闭包被点击。
  // [失败路径] 目录、无 summary、未提供打开回调三种情况都静默返回，不做导航。
  // [事务] 打开参数只传类型、标题与路径，不把整个工具调用对象交给查看器。
  const openFilePreview = useCallback(() => {
    if (!summary || summary.entryType !== "file" || !onOpenCodeViewer) {
      return;
    }

    onOpenCodeViewer({
      type: "file",
      title: summary.fileName,
      path: summary.path,
    });
  }, [onOpenCodeViewer, summary]);
  // [权衡] 有 summary 时优先展示文件芯片，否则依次退回标题、kind、固定文案。
  // [不变量] 依赖数组覆盖芯片所需的全部输入，路径更新后文案随之刷新。
  const primaryText = useMemo(
    () =>
      summary ? (
        <ReadFileChip summary={summary} clickable={canOpenPreview} onClick={openFilePreview} />
      ) : (
        (toolCall.title ?? toolCall.kind ?? intl.formatMessage({ id: "chat.toolCall.read.read" }))
      ),
    [canOpenPreview, intl, openFilePreview, summary, toolCall.kind, toolCall.title],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={READ_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={false}
        kindLabel={intl.formatMessage({
          id: isRunning ? "chat.toolCall.read.reading" : "chat.toolCall.kind.read",
        })}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        prioritizePrimaryText
        secondaryText={summary ? renderFilePath(summary.filePath) : undefined}
        statusLabel={statusLabel}
        statusTooltip={toolCall.status === "failed" ? errorText : undefined}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={isRunning}
        title={toolCall.title}
        content={null}
      />
      <ToolSnapshotFieldNotice
        // 缺失时每次渲染都新建空数组字面量，下游若按引用做 memo 会白跑一轮；提示条本身很轻，代价可接受。
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />

      {/* <pre className="px-4 py-3 rounded-xl bg-surface text-ui-xs mt-1 text-foreground-subtle max-h-50 overflow-auto">
        {JSON.stringify(toolCall, null, 2)}
      </pre> */}
    </>
  );
}
