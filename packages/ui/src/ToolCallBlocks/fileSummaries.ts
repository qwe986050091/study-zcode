// INV-01 守住位置：readFileDiffDisplays 只从 display 结构读取 file_diff/file_diffs；改错故障：放宽成任意对象后，非 diff 的展示数据会被当成文件变更混入摘要。
// INV-02 守住位置：单文件 file_diff 与多文件 file_diffs 是两种并列形态，需分别展开成同一列表；改错故障：只认其中一种会让另一类工具行的摘要整段消失。
// INV-03 守住位置：files 数组必须过滤出普通记录后再遍历；改错故障：直接信任数组元素类型，遇到 null 或字符串会在取字段时抛错中断整条摘要。
// INV-04 守住位置：readDisplayStructuredPatch 在 structuredPatch 不是数组时返回 null；改错故障：空数组也拼出 patch，会让调用方把空补丁当成可展开的有效 diff。
// INV-05 守住位置：每个 hunk 的 oldStart/newStart 等坐标缺失时回落到 1；改错故障：坐标留空会让生成的 hunk 头无法被 diff 渲染器解析，补丁整体不可读。
// INV-06 守住位置：hunk.lines 只保留字符串元素；改错故障：混入非字符串会让拼接产出 undefined，污染整份补丁文本。
// INV-07 守住位置：无任何有效 hunk 时 readDisplayStructuredPatch 返回 null 而非空字符串；改错故障：返回空串会被上层判为有补丁，从而屏蔽统一 diff 的兜底生成。
// INV-08 守住位置：readDisplayFileDiffSummaries 用 seenPaths 按路径首次出现去重；改错故障：去掉去重后同一文件会在 raw.content 与 rawOutput 两个来源各出一条重复行。
// INV-09 守住位置：路径为空字符串时直接跳过；改错故障：空路径仍参与去重与展示，会让摘要列表出现无文件名且无法定位的幽灵条目。
// INV-10 守住位置：展示层摘要固定声明为 Edited/edit，因为它描述的是已发生的文件改动；改错故障：按 changeType 猜写入类别会把真实新增误标为编辑。
// INV-11 守住位置：additions/deletions 必须夹到非负整数；改错故障：负数或小数直接透传会让行数统计显示为 -3 或 2.5，破坏 UI 对齐。
// INV-12 守住位置：readRawToolCallFileSummaries 先按工具语义过滤，非写类工具立即返回空数组；改错故障：search/explore/execute 也会被当成 edit，渲染分流彻底走错分支。
// INV-13 守住位置：raw 不是普通记录时仍从 source.output 取展示摘要并回落启发式结果；改错故障：直接返回空数组会丢掉没有 raw 包裹的合法工具结果。
// INV-14 守住位置：有序路径集合按 rawDiffs、directChanges、rawInputChanges、rawOutputChanges 的顺序累积；改错故障：改成无序遍历会让同一批文件在两次渲染间顺序抖动。
// INV-15 守住位置：路径去重由 Set 保证，四条来源只产生一条摘要；改错故障：缺少去重时同一文件会按来源数量重复出现，行数统计被成倍放大。
// INV-16 守住位置：changeType 到 operationKind 的映射缺省回落到 edit，只有 add/update/delete 三个显式值才改写；改错故障：未知类型静默变成 write 会让删除的文件显示为新建。
// INV-17 守住位置：changeStat 只在文本配对完整或新增/删除单边成立时计算；改错故障：文本缺失仍强行算差值，会把无法比较的文件报成 0 行变更。
// INV-18 守住位置：无摘要时最终回落到 buildFallbackRawToolCallFileSummary；改错故障：删掉兜底会让未识别的写类工具在摘要区完全空白。
//
// 模块职责：把工具调用里形态各异的文件变更证据（display、structuredPatch、统一 diff、changes 映射）收敛成统一的 RawToolCallFileSummary 列表。
// 状态所有权：本模块不持有状态，去重集合与路径顺序都是单次调用的局部量，调用结束后即可丢弃。
// 阅读顺序：先看 readRawToolCallFileSummaries 的分支与兜底，再看两个 display 读取器，最后看单文件 diff 的坐标与行数计算。
import { computeLineChangeStat } from "@zcode/shared";
import { getPathLeaf } from "@/lib/path.js";
import { resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { buildUnifiedDiff } from "@/lib/toolDiffPreview.js";
import {
  buildFallbackRawToolCallFileSummary,
  hasWritableToolSemantic,
  inferEditOperation,
  type EditKindSource,
} from "@/ToolCallBlocks/fileSummaryHeuristics.js";
import {
  type EditOperationKind,
  type RawToolCallFileSummary,
  isPlainRecord,
  normalizeSingleFilePatch,
  readRawToolCallInput,
  readRawToolCallChanges,
  readStringField,
  readStructuredDiffBlock,
  readUnifiedDiffField,
} from "@/ToolCallBlocks/fileSummaryTypes.js";

export { inferEditOperation } from "@/ToolCallBlocks/fileSummaryHeuristics.js";

// 空输入是常态：source.output 缺失时这里收到 undefined，必须返回空数组而不是抛错
// single 与 plural 共用同一出口，调用方无需感知 display.kind 的两种写法
// 返回值只做浅过滤，元素仍是原始记录，后续字段读取全部交给惰性容错函数
// 这里不复制对象也不改写 kind，避免把展示层事实提前固化
function readFileDiffDisplays(value: unknown): Record<string, unknown>[] {
  if (!isPlainRecord(value)) {
    return [];
  }

  const display = isPlainRecord(value.display) ? value.display : value;
  if (display.kind === "file_diff") {
    return [display];
  }
  if (display.kind !== "file_diffs" || !Array.isArray(display.files)) {
    return [];
  }
  return display.files.filter(isPlainRecord);
}

// 输入是已经确认属于 file_diff 的那一份 display 记录，因此这里不再重复校验 kind
// structuredPatch 缺失或类型不符时返回 null，让调用方继续尝试其它补丁来源
// hunk 坐标与行数全部按原值透传，不做重排，保证与工具产出的补丁逐字节一致
// 唯一的重写是把文件头替换成 a/fileLabel 与 b/fileLabel，适配统一 diff 的展示约定
function readDisplayStructuredPatch(display: Record<string, unknown>, fileLabel: string) {
  const structuredPatch = display.structuredPatch;
  if (!Array.isArray(structuredPatch)) {
    return null;
  }

  const hunks: string[] = [];
  for (const hunk of structuredPatch) {
    if (!isPlainRecord(hunk) || !Array.isArray(hunk.lines)) {
      continue;
    }

    // 四个坐标字段各自独立回落，缺一个不会拖累其余三个
    // 回落值取 1 而不是 0，因为 diff 行号从 1 起算，0 会被渲染器判为非法
    // 只接受 number 类型，字符串数字不做隐式转换，防止上游脏数据伪造行号
    const oldStart = typeof hunk.oldStart === "number" ? hunk.oldStart : 1;
    const oldLines = typeof hunk.oldLines === "number" ? hunk.oldLines : 1;
    const newStart = typeof hunk.newStart === "number" ? hunk.newStart : 1;
    const newLines = typeof hunk.newLines === "number" ? hunk.newLines : 1;
    const lines = hunk.lines.filter((line): line is string => typeof line === "string");
    hunks.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`);
    hunks.push(...lines);
  }

  // 空补丁与无补丁必须区分：这里返回 null 表示没有任何可用 hunk
  // 文件头在确认有内容后才拼接，避免产出只有旧新两行文件头却没有 hunk 的假补丁
  // 拼接顺序固定为旧文件头、新文件头、全部 hunk，顺序错乱会让解析器只能读到第一段
  return hunks.length > 0
    ? [`--- a/${fileLabel}`, `+++ b/${fileLabel}`, ...hunks].join("\n")
    : null;
}

// 多个来源按传入顺序扫描，先命中的来源拥有该路径的展示权
// seenPaths 的生命周期仅限本次调用，跨调用共享会把不同工具的文件互相吞掉
// 同一路径可能同时出现在 raw、rawInput 与 source.output 中，去重后只保留首条
// 输出顺序即首次出现顺序，不做排序，保证工具行与摘要区的文件次序一致
function readDisplayFileDiffSummaries(...values: unknown[]): RawToolCallFileSummary[] {
  const summaries: RawToolCallFileSummary[] = [];
  const seenPaths = new Set<string>();

  for (const value of values) {
    for (const display of readFileDiffDisplays(value)) {
      // 路径来自三个候选键，覆盖驼峰与下划线两套命名，取到第一个非空字符串即停
      // 空路径直接跳过，因为后续的文件名、图标与补丁都需要路径才能定位
      // 去重发生在读取路径之后、构建描述符之前，重复项连图标解析都不会触发
      // 这里不对路径做规范化，大小写与分隔符差异由下游描述符统一处理
      const path = readStringField(display, ["filePath", "file_path", "path"]);
      if (!path || seenPaths.has(path)) {
        continue;
      }

      seenPaths.add(path);
      const descriptor = resolveFileDisplayDescriptor(path);
      // ZCode agent 的 edit/write/apply_patch 工具会把真实 diff 放在
      // rawOutput.display(file_diff/file_diffs)。summary 和工具轨迹必须复用这份结构化事实，
      // 否则会出现工具行能展开 diff、底部摘要却只能显示“无法预览”的分叉。
      // 展示层摘要的行数统计必须夹紧到非负整数，NaN 与 Infinity 也在这里被吞掉
      // patch 复用 structuredPatch 的结果，保证摘要区与工具行展开的内容完全同源
      // 即使行数是 0 与 0 也要保留字段，缺失字段会让 UI 退化成未知行数样式
      summaries.push({
        path,
        actionLabel: "Edited",
        operationKind: "edit",
        fileName: descriptor.fileName,
        filePath: descriptor.filePath,
        fileIconSrc: descriptor.fileIconSrc,
        changeStat: {
          added:
            typeof display.additions === "number" ? Math.max(0, Math.round(display.additions)) : 0,
          removed:
            typeof display.deletions === "number" ? Math.max(0, Math.round(display.deletions)) : 0,
        },
        patch: readDisplayStructuredPatch(display, getPathLeaf(path)),
      });
    }
  }

  return summaries;
}

// 这是唯一对外入口，内部按证据强度从高到低依次尝试，命中即返回
// source 可选，缺失时跳过工具语义过滤，兼容只拿到 raw 的调用点
// 返回空数组是合法结果，表示该工具确实没有文件变更，与解析失败不同
// 所有分支最终都会经过兜底函数，因此调用方无需区分空结果与未识别形态
export function readRawToolCallFileSummaries(
  raw: unknown,
  source?: EditKindSource,
): RawToolCallFileSummary[] {
  if (source && !hasWritableToolSemantic(source)) {
    // renderer 分流会把“存在 rawFileSummaries”视为 edit 证据。
    // 如果非写类工具也从 raw.changes 抽摘要，就会把 search / explore / execute 误导到 edit/delete。
    // 这里先按 kind/toolName 过滤，只允许明确写类工具继续读取文件变更摘要。
    return [];
  }

  // raw 非记录意味着工具结果没有被包装，展示摘要只能从 source.output 里挖
  // 这里的返回值优先使用 display 摘要，其次才回落到启发式推断
  // 两条路径都不抛错，最坏情况是返回空数组，让上层按无变更渲染
  if (!isPlainRecord(raw)) {
    const displaySummaries = readDisplayFileDiffSummaries(source?.output);
    return displaySummaries.length > 0
      ? displaySummaries
      : buildFallbackRawToolCallFileSummary(source);
  }

  const rawInput = readRawToolCallInput(raw);
  const rawOutput = isPlainRecord(raw.rawOutput) ? raw.rawOutput : null;
  const displaySummaries = readDisplayFileDiffSummaries(raw, rawInput, rawOutput, source?.output);
  if (displaySummaries.length > 0) {
    return displaySummaries;
  }

  const rawDiffs = Array.isArray(raw.content)
    ? raw.content
        .map((item) => readStructuredDiffBlock(item))
        .filter(
          (diff): diff is { path?: string; oldText: string; newText: string } =>
            diff !== null && typeof diff.path === "string",
        )
    : [];

  const { directChanges, rawInputChanges, rawOutputChanges } = readRawToolCallChanges(raw);

  // 四条来源按固定顺序并入同一个集合，顺序决定摘要区的稳定排序
  // Set 同时承担去重职责，同一路径只在首次插入时获得位置
  // rawDiffs 排在最前，因为结构化 diff 携带的文本最完整，值得优先展示
  // changes 映射只提供路径与类型，排在后面作为补足
  const orderedPaths = new Set<string>();
  for (const diff of rawDiffs) {
    if (diff.path) {
      orderedPaths.add(diff.path);
    }
  }
  if (directChanges) {
    for (const path of Object.keys(directChanges)) {
      orderedPaths.add(path);
    }
  }
  if (rawInputChanges) {
    for (const path of Object.keys(rawInputChanges)) {
      orderedPaths.add(path);
    }
  }
  if (rawOutputChanges) {
    for (const path of Object.keys(rawOutputChanges)) {
      orderedPaths.add(path);
    }
  }

  const summaries: RawToolCallFileSummary[] = [];
  for (const path of orderedPaths) {
    const diff = rawDiffs.find((item) => item.path === path);
    const change = rawOutputChanges?.[path] ?? rawInputChanges?.[path] ?? directChanges?.[path];
    const changeType =
      isPlainRecord(change) && typeof change.type === "string" ? change.type : undefined;
    const operationKind: EditOperationKind =
      changeType === "add"
        ? "write"
        : changeType === "update"
          ? "update"
          : changeType === "delete"
            ? "delete"
            : "edit";
    const actionLabel =
      changeType === "add" ? "Created" : changeType === "delete" ? "Deleted" : "Edited";
    const oldText =
      diff?.oldText ??
      (isPlainRecord(change)
        ? readStringField(change, [
            "oldText",
            "old_string",
            "oldString",
            "before",
            "old_content",
            "oldContent",
          ])
        : undefined);
    const newText =
      diff?.newText ??
      (isPlainRecord(change)
        ? readStringField(change, [
            "newText",
            "new_string",
            "newString",
            "after",
            "new_content",
            "newContent",
            "content",
          ])
        : undefined);
    const descriptor = resolveFileDisplayDescriptor(path);
    let changeStat: { added: number; removed: number } | undefined;
    if (oldText !== undefined && newText !== undefined) {
      changeStat = computeLineChangeStat(oldText, newText);
    } else if (changeType === "add" && newText !== undefined) {
      changeStat = computeLineChangeStat(null, newText);
    } else if (changeType === "delete" && oldText !== undefined) {
      changeStat = computeLineChangeStat(oldText, "");
    }
    const explicitPatch = normalizeSingleFilePatch(readUnifiedDiffField(change), getPathLeaf(path));
    const patch =
      explicitPatch ??
      (oldText !== undefined || newText !== undefined
        ? buildUnifiedDiff(oldText ?? "", newText ?? "", getPathLeaf(path))
        : null);

    summaries.push({
      path,
      actionLabel,
      operationKind,
      fileName: descriptor.fileName,
      filePath: descriptor.filePath,
      fileIconSrc: descriptor.fileIconSrc,
      changeStat,
      patch,
    });
  }

  return summaries.length > 0 ? summaries : buildFallbackRawToolCallFileSummary(source);
}
