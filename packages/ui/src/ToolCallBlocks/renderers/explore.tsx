// explore.tsx —— Explore 聚合工具调用渲染器：分类、摘要与子调用列表。
//
// 职责边界
//   做什么：把一次 explore 工具调用及其子调用投影成可读的行内摘要，
//   包括四类桶计数、折叠态主副文案、动画 key 和子调用内容列表。
//   不做什么：不发 IO、不解析 diff、不读写 store、不决定工具成败。
//   依赖谁：@zcode/shared 的计划步骤解析、各家族 renderer 的摘要函数、ToolLayout 外壳。
//   被谁调用：工具调用树按家族分派到本 renderer；摘要函数另被时间线复用。
//   边界：所有判断只服务展示，任何分支都不能反向影响执行或持久化。
//
//
// INV-01 分类只决定展示分组，不决定执行结果：分类函数只能读取 kind/title/input 做字符串判断 —— 守住它的位置：classifyExploreToolCall —— 改错故障：工具已成功执行却被摘要显示为其他类型，用户误判执行路径
// INV-02 未知输入必须得到兜底摘要而不是抛错：任何 null 或异常结构都要落到 fallbackText —— 守住它的位置：getLatestExploreChildSummary 末尾分支 —— 改错故障：单条脏数据让整个工具调用行渲染崩溃
// INV-03 命令拆分必须先解包再按分隔符切分：顺序颠倒会把 sh -lc 包装本身当成命令 —— 守住它的位置：collectCommandStrings 的两处返回 —— 改错故障：分类命中率下降，搜索类调用被统计成文件类
// INV-04 shell 包装只剥离一层：不要递归解包 —— 守住它的位置：unwrapShellCommand —— 改错故障：嵌套引号被多吃一层，展示的命令与实际执行不一致
// INV-05 动画 key 必须同时包含 toolId 与内容指纹：缺任意一段都会让不同调用的动画串味 —— 守住它的位置：各摘要返回对象的 animationKey —— 改错故障：切换工具时摘要文字不刷新或错误地重播动画
// INV-06 子调用倒序扫描不能改成正序：需要最近一次调用 —— 守住它的位置：getLatestExploreChildSummaryFromChildren 的循环 —— 改错故障：折叠态长期停留在最早的一次子调用上
// INV-07 计划为空时仍要返回摘要对象：不能返回 null —— 守住它的位置：getTodoChildSummary 的空计划分支 —— 改错故障：todo 子调用让整行摘要消失，只剩工具名
// INV-08 文件 chip 可点击必须同时满足条目为文件与回调存在：两个条件都不能省 —— 守住它的位置：canOpenPreview 计算 —— 改错故障：点击目录项触发文件预览并报错
// INV-09 子渲染 key 必须用 toolId：不要退回数组下标 —— 守住它的位置：childToolCalls.map 的 key —— 改错故障：子调用增删后行内展开状态错位到别的调用
// INV-10 renderContent 的 useCallback 依赖必须保留全部 onOpen 回调：少一个就闭包旧值 —— 守住它的位置：useCallback 依赖数组 —— 改错故障：点击打开的是上一次的工具目标
// INV-11 子调用摘要只在运行中计算：结束后必须回落到整体统计 —— 守住它的位置：collapsedChildSummary 的三元表达式 —— 改错故障：完成后主文案仍显示最后一条路径，看起来像卡住
// INV-12 失败信息通过 statusTooltip 透传，不改写 summary：两层语义不能混合 —— 守住它的位置：ToolLayout 的 statusTooltip/errorText 传参 —— 改错故障：失败原因被摘要覆盖，用户看不到错误
// INV-13 快照 refs 缺省必须是空数组：不能传 undefined —— 守住它的位置：ToolSnapshotFieldNotice 的 refs —— 改错故障：无快照的调用也会触发一次无意义的字段加载
// INV-14 所有用户可见文案走 i18n：禁止在摘要里硬编码中文 —— 守住它的位置：formatMessage 调用点 —— 改错故障：切换语言后摘要保持旧语言
// INV-15 web-fetch 判定必须先于关键字正则：顺序不可交换 —— 守住它的位置：classifyExploreToolCall 首行 —— 改错故障：URL 中含 search 字样的抓取被归入搜索桶
// INV-16 计划步骤优先读 output 再退回 input：成功结果比入参更可信 —— 守住它的位置：readTodoPlanFromToolCall —— 改错故障：旧的计划快照覆盖最新进度，进度数字倒退
// INV-17 折叠态与展开态主文案必须同源：两者都来自同一次计数结果 —— 守住它的位置：summary 变量 —— 改错故障：展开前后数量不一致，被误认为状态丢失
// INV-18 本文件不得引入新的服务依赖：只能依赖纯函数与渲染上下文 —— 守住它的位置：文件顶部 import 区 —— 改错故障：渲染层耦合服务，时间线复用处被拖进网络请求
//
// 维护提示
//   新增工具家族时，先补分类判定，再补摘要分支，最后补 i18n，三步缺一不可。
//   分类与摘要都是纯函数，可以被单测直接覆盖，不要把它们挪进组件体内。
//   折叠态文案会进入动画容器，key 构造规则的变更需要同步设计评审。
//   若此处逻辑开始需要 IO，说明职责放错了层，应先拆到 hooks 或 service。
//   组件体内只做订阅与拼装，任何业务判断都应留在纯函数里。
//   注释块位置与密度基线由 DEEP-SPEC 统一维护，改动时不要打乱既有块顺序。
/* eslint-disable max-lines -- Explore 聚合渲染同时维护分类、父级摘要和可复用子工具摘要，拆开会让父子展示规则更难对齐 */
import { SearchIcon } from "lucide-react";
import { extractPlanStepsFromToolInput, extractPlanStepsFromToolOutput } from "@zcode/shared";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getExecuteSecondaryText } from "@/ToolCallBlocks/renderers/execute.js";
import { buildReadSummary, ReadFileChip } from "@/ToolCallBlocks/renderers/read.js";
import { getWebFetchPrimaryText } from "@/ToolCallBlocks/renderers/web-fetch.js";
import { getSearchPrimaryText } from "@/ToolCallBlocks/renderers/search.js";
import { renderFilePath } from "@/ToolCallBlocks/shared.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import { useCallback, type ReactNode } from "react";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import type { ZCodePlanStep } from "@zcode/shared";

// [资源] 这个图标元素在模块加载期创建一次，被所有 explore 块共享。
// 它不持有 props 也不读状态，因此可以安全复用。
// 一旦挪进组件体内，每次 render 都会生成新元素引用，
// ToolLayout 的摘要比较会失去稳定性，折叠态出现无谓重渲染。
const EXPLORE_TOOL_ICON = <SearchIcon className="size-4 shrink-0 text-foreground-subtle" />;

type IntlLike = {
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string;
};

export type ExploreChildSummary = {
  animationKey: string;
  primaryText: ReactNode;
  secondaryText?: ReactNode;
  title?: string;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  // [契约] 这里刻意排除数组：explore 的 input 既可能是单个命令字符串，也可能是命令数组。
  // 把数组当成普通记录，后续按 key 取值会读到 length 这类伪装字段。
  // null 检查也不能省，typeof null 仍然返回 object。
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapShellCommand(command: string): string {
  // [契约] 先 trim 再匹配，避免命令前的缩进让正则的起始锚点失效。
  // 返回的始终是去掉外层包装后的内层命令，调用方不要再二次剥离，
  // 否则嵌套的引号会被多吃掉一层。
  const trimmed = command.trim();
  const shellCommandMatch = trimmed.match(/^(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+([\s\S]+)$/i);
  // [失败路径] 不是 sh -lc 包装的命令原样返回。
  // 这里不能用空串兜底，否则纯命令会被整体丢弃，
  // 分类器就再也看不到 search 之类的关键字。
  if (!shellCommandMatch?.[1]) {
    return trimmed;
  }

  const rawInnerCommand = shellCommandMatch[1].trim();
  if (
    (rawInnerCommand.startsWith('"') && rawInnerCommand.endsWith('"')) ||
    (rawInnerCommand.startsWith("'") && rawInnerCommand.endsWith("'"))
  ) {
    // [权衡] 只在首尾引号成对时剥壳，命令中间的引号保持原样。
    // 单双引号分开判断是为了兼容混用写法，
    // 不能用一次性正则替换，否则会误伤参数里的转义引号。
    return rawInnerCommand.slice(1, -1).trim();
  }

  return rawInnerCommand;
}

function collectCommandStrings(input: unknown): string[] {
  // [契约] 候选命令按收集顺序累积，顺序决定去重后保留的第一条。
  // 分类只看关键字是否命中，所以顺序不影响桶归属，
  // 但摘要展示的拼接文本会随顺序变化，不要为了稳定输出而重排。
  // 真正需要稳定的是去重本身，它在最后统一执行。
  // 收集阶段保持原貌，便于排查时还原用户实际输入。
  const commandCandidates: string[] = [];

  const collectFromValue = (value: unknown) => {
    if (typeof value === "string") {
      const command = value.trim();
      if (command.length > 0) {
        commandCandidates.push(command);
      }
      return;
    }

    if (!Array.isArray(value)) {
      return;
    }

    if (value.every((item) => typeof item === "string")) {
      const commandParts = value as string[];
      // [契约] 只有 -lc 后面的那个参数才是真实命令。
      // 先找下标再取下一个元素，避免把 shell 可执行文件名当成命令。
      // 找不到 -lc 时才退回整段 join 的结果。
      const shellCommandIndex = commandParts.findIndex((part) => part === "-lc");
      if (shellCommandIndex >= 0 && typeof commandParts[shellCommandIndex + 1] === "string") {
        const shellCommand = commandParts[shellCommandIndex + 1]!.trim();
        if (shellCommand.length > 0) {
          commandCandidates.push(shellCommand);
          return;
        }
      }

      const joinedCommand = commandParts.join(" ").trim();
      if (joinedCommand.length > 0) {
        commandCandidates.push(joinedCommand);
      }
      return;
    }

    for (const item of value) {
      if (!isPlainRecord(item)) {
        continue;
      }

      const parsedCommand = item.cmd;
      if (typeof parsedCommand === "string" && parsedCommand.trim().length > 0) {
        commandCandidates.push(parsedCommand.trim());
      }
    }
  };

  collectFromValue(input);

  // [权衡] 输入不是记录时直接返回拆分后的结果。
  // 跳过下面按 command/cmd/script 枚举的分支，
  // 防止对字符串再做一次属性读取拿到 undefined。
  if (!isPlainRecord(input)) {
    return Array.from(
      new Set(
        commandCandidates.flatMap((candidate) => unwrapShellCommand(candidate).split(/&&|\|\||;/g)),
      ),
    )
      .map((item) => item.trim())
      .filter(Boolean);
  }

  for (const key of ["command", "cmd", "script", "parsed_cmd"] as const) {
    collectFromValue(input[key]);
  }

  return Array.from(
    new Set(
      commandCandidates.flatMap((candidate) => unwrapShellCommand(candidate).split(/&&|\|\||;/g)),
    ),
  )
    .map((item) => item.trim())
    .filter(Boolean);
}

// [契约] 四个桶是 UI 分类的封闭集合，新增类型必须同时更新三处：
// 分类函数、计数初始值、以及四条 i18n 文案分支。
// 漏改任意一处，reduce 会写入不存在的键，汇总时静默少算一次调用。
// 这个联合类型也是 reduce 泛型的唯一来源，
// 不要在组件里另写一套字符串字面量。
type ExploreBucket = "search" | "fetch" | "list" | "file";

function getBucketLabel(intl: IntlLike, bucket: ExploreBucket, count: number) {
  // [契约] 单复数文案靠 count === 1 选择 id。
  // 不要在调用侧拼接数量后缀，否则英文复数规则失效。
  // default 分支只服务类型收窄，正常路径不会走到。
  switch (bucket) {
    case "fetch":
      return intl.formatMessage({
        id:
          count === 1
            ? "chat.toolCall.explore.bucket.fetch.one"
            : "chat.toolCall.explore.bucket.fetch.other",
      });
    case "search":
      return intl.formatMessage({
        id:
          count === 1
            ? "chat.toolCall.explore.bucket.search.one"
            : "chat.toolCall.explore.bucket.search.other",
      });
    case "list":
      return intl.formatMessage({
        id:
          count === 1
            ? "chat.toolCall.explore.bucket.list.one"
            : "chat.toolCall.explore.bucket.list.other",
      });
    case "file":
      return intl.formatMessage({
        id:
          count === 1
            ? "chat.toolCall.explore.bucket.file.one"
            : "chat.toolCall.explore.bucket.file.other",
      });
    default:
      return intl.formatMessage({ id: "chat.toolCall.explore.bucket.items" });
  }
}

function classifyExploreToolCall({
  kind,
  title,
  input,
}: {
  kind: string;
  title?: string;
  input: unknown;
}): ExploreBucket {
  // [契约] web-fetch 必须在关键字匹配之前返回。
  // 否则 URL 里带 search 字样的网页抓取会被统计成搜索，
  // 折叠摘要的数量分组与用户预期不符。
  if (resolveToolCallIdentity({ kind, title, input }).family === "web-fetch") return "fetch";
  const fingerprint = `${kind} ${title ?? ""}`.toLowerCase();
  const command = collectCommandStrings(input).join(" ; ").toLowerCase();

  if (
    /(\bgrep\b|\bsearch\b|\bfetch\b|\bweb.?search\b|\bweb.?fetch\b)/i.test(fingerprint) ||
    /(^|\s)(rg|grep|ripgrep|git\s+grep)(\s|$)/i.test(command)
  ) {
    return "search";
  }

  if (
    /(\bglob\b|\bfind\b|\blist\b|\btree\b|\bdir\b|\bls\b)/i.test(fingerprint) ||
    /(^|\s)(ls|find|tree|dir)(\s|$)/i.test(command)
  ) {
    return "list";
  }

  return "file";
}

function formatExploreSummary(intl: IntlLike, counts: Record<ExploreBucket, number>) {
  // [契约] 汇总顺序固定为 fetch、search、list、file。
  // 这是产品约定的展示顺序，不随数量大小调整。
  // 改动会让同一组调用在不同语言下顺序跳变。
  const summaryParts: string[] = [];

  // [契约] 每段汇总都带自己的计数与单位，缺省为 0 的桶不出现。
  // 因此空输入的整行文案依赖下面的兜底分支，而不是四条空字符串。
  // 若改成先拼空段再过滤，会出现多余的分隔逗号。
  // 单位文案随 count 变化，数量和单位必须成对生成。
  // 不要把这些片段提前用变量缓存，语言切换后缓存不会失效。
  if (counts.fetch > 0)
    summaryParts.push(`${counts.fetch} ${getBucketLabel(intl, "fetch", counts.fetch)}`);
  if (counts.search > 0) {
    summaryParts.push(`${counts.search} ${getBucketLabel(intl, "search", counts.search)}`);
  }
  if (counts.list > 0) {
    summaryParts.push(`${counts.list} ${getBucketLabel(intl, "list", counts.list)}`);
  }
  if (counts.file > 0) {
    summaryParts.push(`${counts.file} ${getBucketLabel(intl, "file", counts.file)}`);
  }

  return summaryParts.length > 0
    ? summaryParts.join(", ")
    : intl.formatMessage({ id: "chat.toolCall.explore.emptySummary" });
}

function getChildActionKindLabel(
  intl: IntlLike,
  family: ReturnType<typeof resolveToolCallIdentity>["family"],
) {
  switch (family) {
    case "file-read":
      return intl.formatMessage({ id: "chat.toolCall.read.reading" });
    case "web-fetch":
      return intl.formatMessage({ id: "chat.toolCall.webFetch.fetching" });
    case "search":
      return intl.formatMessage({ id: "chat.toolCall.search.searching" });
    case "shell":
      return intl.formatMessage({ id: "chat.toolCall.execute.running" });
    default:
      return intl.formatMessage({ id: "chat.toolCall.status.running" });
  }
}

// [权衡] 动作前缀是可选装饰，缺省时直接返回原内容。
// 不要为了对齐给空前缀保留占位元素，
// 否则每行左侧都会出现一段无法解释的空白。
function renderChildActionKindPrefix(actionKindLabel: string | null, content: ReactNode) {
  if (!actionKindLabel) {
    return content;
  }

  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-foreground-subtle">{actionKindLabel}</span>
      {content}
    </span>
  );
}

function readTodoPlanFromToolCall(
  childToolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): ZCodePlanStep[] | null {
  return (
    extractPlanStepsFromToolOutput({
      title: childToolCall.title,
      kind: childToolCall.kind,
      output: childToolCall.output,
    }) ??
    extractPlanStepsFromToolInput({
      title: childToolCall.title,
      kind: childToolCall.kind,
      input: childToolCall.input,
    })
  );
}

function getTodoChildSummary(
  intl: IntlLike,
  childToolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): ExploreChildSummary | null {
  const plan = readTodoPlanFromToolCall(childToolCall);
  // [失败路径] 计划解析不出来时不能返回 null。
  // 子调用仍然存在，摘要若为空会让整行看起来没有内容。
  // 这里退化成正在更新的文案，并保留 toolId 作为动画 key。
  if (!plan || plan.length === 0) {
    return {
      animationKey: `todo:${childToolCall.toolId}:empty`,
      primaryText: (
        <span className="min-w-0 truncate">
          {intl.formatMessage({ id: "chat.toolCall.todo.updating" })}
        </span>
      ),
      title: childToolCall.title,
    };
  }

  // [契约] 完成计数只认 completed。
  // in_progress 与 pending 一律不计，
  // 否则进度数字会在步骤切换的瞬间跳变。
  const completedCount = plan.filter((step) => step.status === "completed").length;
  // [契约] 当前步骤的选择顺序是 in_progress、第一个未完成、最后一个步骤。
  // 三层兜底保证即使计划全部完成也仍有可展示的标题。
  // 顺序不能调整：跳过 in_progress 会让进度看起来停在初始步骤。
  // 最后一步只作为兜底，不能提到最前，否则运行中会一直显示末项。
  // activeStep 同时决定标题与动画 key，两处必须使用同一个结果。
  const activeStep =
    plan.find((step) => step.status === "in_progress") ??
    plan.find((step) => step.status !== "completed") ??
    plan.at(-1);
  const isComplete = completedCount === plan.length;
  const actionLabel = intl.formatMessage({
    id: isComplete ? "chat.toolCall.todo.updated" : "chat.toolCall.todo.updating",
  });
  const progressText = `${completedCount}/${plan.length}`;
  const primaryText = activeStep?.title ? `${progressText} · ${activeStep.title}` : progressText;

  return {
    animationKey: `todo:${childToolCall.toolId}:${completedCount}:${plan.length}:${activeStep?.id ?? "none"}:${activeStep?.title ?? ""}`,
    primaryText: (
      <span className="inline-flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-foreground-subtle">{actionLabel}</span>
        <span className="min-w-0 truncate">{primaryText}</span>
      </span>
    ),
    title: activeStep?.title ?? childToolCall.title,
  };
}

function getLatestExploreChildSummary(
  intl: IntlLike,
  childToolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
  context: ToolCallBlockRenderContext,
  options: { includeChildActionKindLabel?: boolean } = {},
): ExploreChildSummary | null {
  const childIdentity = resolveToolCallIdentity(childToolCall);
  const actionKindLabel =
    options.includeChildActionKindLabel === true
      ? getChildActionKindLabel(intl, childIdentity.family)
      : null;

  // [契约] todo 家族走独立摘要，它需要进度数字而不是文件路径。
  // 先判 todo 再判 file-read 是有意的：
  // 计划步骤的 input 里也可能带 path 字段，
  // 顺序颠倒会渲染出与计划无关的路径。
  // 两个分支的摘要结构相同，但文案来源完全不同。
  if (childIdentity.family === "todo") {
    return getTodoChildSummary(intl, childToolCall);
  }

  // [契约] 可点击前提有两个：条目类型是文件，且宿主提供了打开回调。
  // 缺任意一个都退化为纯文本 chip。
  // 不能只判断回调存在，否则目录读取也会被当成可打开文件。
  // 点击回调里还要再判一次类型，
  // 因为闭包捕获的 summary 可能来自上一次渲染。
  // 这层重复判断是防御，不是冗余。
  if (childIdentity.family === "file-read") {
    const readSummary = buildReadSummary(childToolCall);
    // [失败路径] 读取摘要解析失败时返回 null，而不是伪造一条空 chip。
    // 调用方会继续向前寻找更早的子调用，
    // 伪造内容会让折叠摘要停在一条无法点击的空行上。
    // 这里也不再回退到 title：文件读取的 title 常是模型描述，不是路径。
    // null 是本函数与上层的约定信号，不要改成语义相近的空对象。
    if (!readSummary) {
      return null;
    }
    const canOpenPreview = readSummary.entryType === "file" && Boolean(context.onOpenCodeViewer);
    const openFilePreview = () => {
      if (readSummary.entryType !== "file") {
        return;
      }

      context.onOpenCodeViewer?.({
        type: "file",
        title: readSummary.fileName,
        path: readSummary.path,
      });
    };

    return {
      animationKey: `read:${childToolCall.toolId}:${actionKindLabel ?? "plain"}:${readSummary.path}`,
      primaryText: renderChildActionKindPrefix(
        actionKindLabel,
        <ReadFileChip summary={readSummary} clickable={canOpenPreview} onClick={openFilePreview} />,
      ),
      secondaryText: renderFilePath(readSummary.filePath),
      title: readSummary.path,
    };
  }

  // [契约] 网页抓取的主文案来自输入 URL，而不是 title。
  // title 由上层生成，可能随模型输出变化。
  // 用 URL 才能让同一请求在多次刷新后保持稳定。
  if (childIdentity.family === "web-fetch") {
    const primaryText = getWebFetchPrimaryText(childToolCall.input);
    return {
      animationKey: `fetch:${childToolCall.toolId}:${primaryText}`,
      primaryText: renderChildActionKindPrefix(
        actionKindLabel,
        <span className="min-w-0 truncate">{primaryText}</span>,
      ),
      title: primaryText,
    };
  }
  if (childIdentity.family === "search") {
    const primaryText = getSearchPrimaryText(intl, childToolCall.input);

    return {
      animationKey: `search:${childToolCall.toolId}:${actionKindLabel ?? "plain"}:${primaryText}`,
      primaryText: renderChildActionKindPrefix(
        actionKindLabel,
        <span className="min-w-0 truncate">{primaryText}</span>,
      ),
      title: primaryText,
    };
  }

  // [权衡] shell 家族把可执行命令放在副文案的代码标签里。
  // 主文案只保留动作前缀，
  // 这样长命令可以被截断，而动作语义始终可见。
  if (childIdentity.family === "shell") {
    const secondaryText =
      getExecuteSecondaryText(childToolCall.input) ?? childToolCall.title ?? childToolCall.kind;

    return {
      animationKey: `shell:${childToolCall.toolId}:${actionKindLabel ?? "plain"}:${secondaryText}`,
      primaryText: actionKindLabel ? (
        <span className="shrink-0 text-foreground-subtle">{actionKindLabel}</span>
      ) : null,
      secondaryText: <code className="min-w-0 truncate font-sans">{secondaryText}</code>,
      title: typeof secondaryText === "string" ? secondaryText : childToolCall.title,
    };
  }

  // [失败路径] 兜底文案依次尝试 title、kind，最后走 i18n 空摘要。
  // 顺序不能反：kind 是稳定的工具名，而 i18n 文案随语言变化。
  // 优先展示更具体的信息，未知工具仍然可辨认。
  // 这里不要追加 input 的字符串化结果，
  // 原始入参可能很长，会把整行折叠摘要挤爆。
  const fallbackText =
    childToolCall.title ??
    childToolCall.kind ??
    intl.formatMessage({ id: "chat.toolCall.explore.emptySummary" });

  return {
    animationKey: `tool:${childToolCall.toolId}:${actionKindLabel ?? "plain"}:${fallbackText}`,
    primaryText: renderChildActionKindPrefix(
      actionKindLabel,
      <span className="min-w-0 truncate">{fallbackText}</span>,
    ),
    title: typeof fallbackText === "string" ? fallbackText : childToolCall.title,
  };
}

export function getLatestExploreChildSummaryFromChildren(
  intl: IntlLike,
  childToolCalls: readonly TaskChatToolCallTreeNode[],
  context: ToolCallBlockRenderContext,
  options: { includeChildActionKindLabel?: boolean } = {},
) {
  // [契约] 从末尾倒序遍历，找到第一条能产出摘要的子调用就返回。
  // 必须跳过返回 null 的项，而不是直接返回 null。
  // 否则最后一个失败的子调用会让整行折叠摘要消失。
  for (let index = childToolCalls.length - 1; index >= 0; index -= 1) {
    const childToolCall = childToolCalls[index]?.toolCall;
    if (!childToolCall) {
      continue;
    }

    const summary = getLatestExploreChildSummary(intl, childToolCall, context, options);
    if (summary) {
      return summary;
    }
  }

  return null;
}

export function ExploreToolCallBlock(context: ToolCallBlockRenderContext) {
  const ToolCallBlock = context.nestedToolRenderer;
  const { intl } = useZCodeIntl();
  const { toolCallNode, isRunning, statusLabel, errorText } = context;
  const { toolCall, childToolCalls } = toolCallNode;
  // [契约] 计数在一次 render 内完成，不做缓存。
  // 子调用数量通常很小，缓存反而要维护依赖与失效逻辑。
  // 初始值必须四个键齐全，
  // 否则 acc[bucket] += 1 会得到 NaN，
  // 汇总时整行显示成 NaN。
  const counts = childToolCalls.reduce<Record<ExploreBucket, number>>(
    (acc, childToolCallNode) => {
      const bucket = classifyExploreToolCall({
        kind: childToolCallNode.toolCall.kind,
        title: childToolCallNode.toolCall.title,
        input: childToolCallNode.toolCall.input,
      });
      acc[bucket] += 1;
      return acc;
    },
    { search: 0, fetch: 0, list: 0, file: 0 },
  );
  const summary = formatExploreSummary(intl, counts);
  // [契约] kindLabel 同时用于折叠态与展开态标题。
  // 两侧共用一个变量可以保证文案一致，
  // 若分别格式化，切换展开时会出现短暂的字样闪烁。
  const kindLabel = intl.formatMessage({
    id: "chat.toolCall.explore.label",
  });
  // [契约] 只有运行中才计算子调用摘要。
  // 结束后主文案切回整体统计，避免最后一次路径长期停留。
  // isRunning 同时参与动画 key 的构造，
  // 状态切换时动画才能重新触发一次。
  // 这两个用途共用同一个布尔值，不要拆成两份状态。
  const collapsedChildSummary = isRunning
    ? getLatestExploreChildSummaryFromChildren(intl, childToolCalls, context, {
        includeChildActionKindLabel: true,
      })
    : null;
  // [契约] 这里必须用 useCallback 包住。
  // ToolLayout 会把 renderContent 当作稳定的渲染入口。
  // 依赖数组里要保留全部 onOpen 回调，
  // 漏一个就会拿到闭包里的旧回调，
  // 点击后打开的是上一次的工具目标。
  const renderContent = useCallback(
    () =>
      childToolCalls.length > 0 ? (
        <div className="ml-2 space-y-2 border-border border-l pl-3.5 border-border">
          {childToolCalls.map((childToolCallNode) => (
            <ToolCallBlock
              key={childToolCallNode.toolCall.toolId}
              toolCallNode={childToolCallNode}
              workspacePath={context.workspacePath}
              showIcon={false}
              onOpenCodeViewer={context.onOpenCodeViewer}
              onOpenFileLink={context.onOpenFileLink}
              onOpenBrowserUrl={context.onOpenBrowserUrl}
              onOpenAutomationsMain={context.onOpenAutomationsMain}
              onLoadFullToolCallFields={context.onLoadFullToolCallFields}
            />
          ))}
        </div>
      ) : null,
    [
      childToolCalls,
      context.onLoadFullToolCallFields,
      context.onOpenAutomationsMain,
      context.onOpenBrowserUrl,
      context.onOpenCodeViewer,
      context.onOpenFileLink,
      context.workspacePath,
    ],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={EXPLORE_TOOL_ICON}
        canToggle={context.canToggle ?? true}
        forceOpen={context.forceOpen ?? false}
        kindLabel={kindLabel}
        expandedKindLabel={kindLabel}
        sourceLabel={context.sourceLabel}
        primaryText={collapsedChildSummary ? collapsedChildSummary.primaryText : summary}
        expandedPrimaryText={summary}
        secondaryText={collapsedChildSummary?.secondaryText}
        expandedSecondaryText={null}
        summaryContentSeparator="·"
        animateSummaryContent
        disableSummaryContentAnimation={context.disableSummaryContentAnimation}
        summaryContentKey={
          collapsedChildSummary?.animationKey ??
          `explore:${toolCall.toolId}:${isRunning ? "running" : "done"}:${summary}`
        }
        statusLabel={statusLabel}
        statusTooltip={toolCall.status === "failed" ? errorText : undefined}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={isRunning}
        title={collapsedChildSummary?.title ?? (isRunning ? summary : toolCall.title)}
        expandedTitle={toolCall.title}
        renderContent={renderContent}
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
    </>
  );
}
