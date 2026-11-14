// 任务变更摘要的纯函数层：把持久化文件快照与工具调用原始载荷两种来源，
// 归一成 UI 可直接渲染的 ZCodeTaskChangeSummary，并负责标题、文件名与相对路径的展示格式化。
// 本文件不采集快照、不落盘、不鉴权、不缓存，也不决定哪一轮该被展示。
//
// INV-01 断言：files 为空的摘要对外一律返回 null —— 守住它的位置：getTaskChangeSummary 的首处守卫 —— 改错故障：任务列表会多渲染一条「0 个文件」的空变更行。
// INV-02 断言：同一路径的原始内容只取首次快照，最终内容取末次快照 —— 守住它的位置：buildTaskChangeSummary 的 existing 分支 —— 改错故障：多轮重复写同一文件时增删行数被成倍放大。
// INV-03 断言：写入次数必须逐条累加而不能覆盖 —— 守住它的位置：两处 writeCount 自增赋值 —— 改错故障：文件改动次数恒显示为 1。
// INV-04 断言：无快照的轮次不得进入逐轮映射表 —— 守住它的位置：buildPerTurnFileChangeMap 的跳过分支 —— 改错故障：消费方把空快照当成「该轮无改动」，或对 undefined 取长度直接抛错。
// INV-05 断言：摘要文件列表按路径 localeCompare 固定排序 —— 守住它的位置：三处 sort 调用 —— 改错故障：同一批改动的展示顺序随数据来源漂移，界面抖动且快照测试随机失败。
// INV-06 断言：失败或被拒绝的工具调用绝不产生文件摘要 —— 守住它的位置：hasUnsuccessfulToolStatus 判断后的 continue —— 改错故障：plan mode 下被拒绝的写入被算成真实落盘，界面出现幽灵文件。
// INV-07 断言：error 字段一旦存在即视为失败，与 status 取值无关 —— 守住它的位置：hasUnsuccessfulToolStatus 的首个条件 —— 改错故障：工具报错但状态未同步时，该次改动仍被计入摘要。
// INV-08 断言：status 与 raw.status 都要小写归一后再比较 —— 守住它的位置：两处 toLowerCase —— 改错故障：后端返回 Failed 或 ERROR 时漏判，失败工具污染统计。
// INV-09 断言：多段 patch 必须保留工具调用顺序并以换行连接 —— 守住它的位置：appendPatch 的拼接分支 —— 改错故障：同一文件多次补丁顺序错乱，差异面板显示错位代码块。
// INV-10 断言：空白 patch 不得占用补丁表条目 —— 守住它的位置：appendPatch 的早退与 nextPatch 判断 —— 改错故障：差异面板被空串占位，显示空白改动。
// INV-11 断言：无补丁时该字段返回 undefined 而不是空 Map —— 守住它的位置：buildToolCallChangeSummary 的返回字面量 —— 改错故障：调用方按存在性判断失效，渲染空差异面板。
// INV-12 断言：只有文件确实位于工作区前缀之下才裁剪路径 —— 守住它的位置：toWorkspaceRelativePath 的两个前缀分支 —— 改错故障：工作区外文件被截断成同名相对路径，与其他文件混淆。
// INV-13 断言：大小写不敏感只用于判断包含关系，切片长度仍取原前缀 —— 守住它的位置：Windows 降级匹配分支 —— 改错故障：裁剪位置错位，路径少字符或多字符。
// INV-14 断言：行数差必须用首末两端内容重算，不能累加单次补丁增量 —— 守住它的位置：两处 computeLineChangeStat 调用 —— 改错故障：中间态增删被重复计数，总行数与文件实际不符。
// INV-15 断言：全任务聚合时轮次取最后一次写入所在轮 —— 守住它的位置：existing.lastTurnIndex 的直接赋值 —— 改错故障：从摘要点开文件会跳到错误的轮次。
// INV-16 断言：跨消息合并时轮次取最大值 —— 守住它的位置：buildTaskChangeSummaryFromToolCalls 的 Math.max —— 改错故障：消息未按轮序排列时摘要挂到旧轮次。
// INV-17 断言：逐轮摘要只能由传入的单轮快照重算 —— 守住它的位置：buildTurnChangeSummary 的入参与循环 —— 改错故障：历史轮文件混进当前轮摘要。
// INV-18 断言：轮次缺失时回退到消息下标 —— 守住它的位置：turnIndex 的三元表达式 —— 改错故障：摘要被挂到错误的轮次锚点，展开消息看不到改动。
import type {
  ZCodePersistedFileChange,
  ZCodeTaskChangeSummary,
  ZCodeTaskChangedFileSummary,
  ZCodeTaskMeta,
} from "@zcode/shared";
import { computeLineChangeStat } from "@zcode/shared";
import { getPathLeaf } from "@/lib/path.js";
import type { TaskChatMessage } from "@/lib/taskChatMessageTypes.js";
import { readRawToolCallFileSummaries } from "@/ToolCallBlocks/fileSummaries.js";

interface TaskChangeSummaryIntl {
  formatMessage: (
    desc: { id: string },
    values?: Record<string, string>,
  ) => string;
}

interface AggregatedFileChange {
  path: string;
  originalContent: string | null;
  finalContent: string;
  writeCount: number;
  lastTurnIndex: number;
}

function trimTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

// [契约] 这里只做「读取并判空」的投影，绝不补算、不缓存、不克隆对象
// 返回的是持久化对象本体，调用方就地改写 files 会污染任务元数据
// 旧版本任务可能没有 changeSummary 字段，缺失时按无摘要处理
// 不校验摘要与实际工作区是否一致，那是采集端的责任
export function getTaskChangeSummary(
  task: Pick<ZCodeTaskMeta, "changeSummary"> | null | undefined,
): ZCodeTaskChangeSummary | null {
  // task?.changeSummary 缺失或 files.length === 0 都返回 null：旧版本任务没有 changeSummary 字段，
  // INV-01 要求「0 文件」摘要不得进入任务列表；该守卫同时挡住摘要已创建但 files 还没填充的中间态，
  // 不要在这里补生成空摘要，否则下游所有「无摘要」分支都会变成死代码。
  if (!task?.changeSummary || task.changeSummary.files.length === 0) {
    return null;
  }

  return task.changeSummary;
}

// [契约] 文案统一走 intl，不在本文件拼「加几行减几行」的中文串
// 统计值必须先转成字符串，直接传数字会被格式化器判为非法参数
// 消息 id 固定，改动它等于改动整个任务列表的文案契约
// 这里只做展示，不根据正负号或零值做分支
function formatTaskChangeStats(
  summary: ZCodeTaskChangeSummary,
  intl: TaskChangeSummaryIntl,
): string {
  return intl.formatMessage(
    { id: "taskList.changeStats" },
    {
      added: String(summary.added),
      removed: String(summary.removed),
    },
  );
}

// formatTaskTitleWithChanges 的标题后缀固定为「title (统计)」，括号与空格由本函数决定；
// summary 为空时原样返回 title，不能返回空串；不截断标题，长度控制交给调用方布局。
export function formatTaskTitleWithChanges(
  title: string,
  summary: ZCodeTaskChangeSummary | null,
  intl: TaskChangeSummaryIntl,
): string {
  if (!summary) {
    return title;
  }

  return `${title} (${formatTaskChangeStats(summary, intl)})`;
}

// [契约] 只做前缀裁剪，不解析上级目录、不跟软链接、不访问文件系统
// 入参可能是 Windows 反斜杠路径，统一转正斜杠后再比较
// 文件不在工作区之下时原样返回，调用方需容忍绝对路径
// 工作区带尾分隔符或就是根目录时仍要能正确裁剪
export function toWorkspaceRelativePath(
  workspacePath: string,
  filePath: string,
): string {
  // 只对 workspacePath 去尾分隔符，filePath 保留原样：若也 trim 文件路径，目录级快照会被误判成父目录；
  // 大小写转换只发生在比较副本上，返回切片必须保留原始大小写。
  const normalizedWorkspacePath = trimTrailingSeparators(
    workspacePath.replace(/\\/g, "/"),
  );
  const normalizedFilePath = filePath.replace(/\\/g, "/");

  if (normalizedFilePath === normalizedWorkspacePath) {
    return getPathLeaf(filePath);
  }

  const exactPrefix = `${normalizedWorkspacePath}/`;
  if (normalizedFilePath.startsWith(exactPrefix)) {
    return normalizedFilePath.slice(exactPrefix.length) || getPathLeaf(filePath);
  }

  // Windows 路径在不同来源下大小写可能不一致，这里做一次只用于比较的降级匹配。
  // exactPrefix 与 caseInsensitivePrefix 长度相等，切片仍用 exactPrefix.length。
  const caseInsensitivePrefix = exactPrefix.toLowerCase();
  if (normalizedFilePath.toLowerCase().startsWith(caseInsensitivePrefix)) {
    return normalizedFilePath.slice(exactPrefix.length) || getPathLeaf(filePath);
  }

  return normalizedFilePath;
}

// formatTaskChangedFileLabel 只把 > 0 的 file.added/file.removed 拼进标签，0 不显示；
// 两者都为 0 时只返回 toWorkspaceRelativePath 的结果，不带尾随空格；顺序固定为 +added 在前、-removed 在后；
// 路径裁剪失败时返回绝对路径，这是可接受降级而不是错误。
export function formatTaskChangedFileLabel(
  workspacePath: string,
  file: ZCodeTaskChangedFileSummary,
): string {
  const relativePath = toWorkspaceRelativePath(workspacePath, file.path);
  const statParts: string[] = [];
  if (file.added > 0) {
    statParts.push(`+${file.added}`);
  }
  if (file.removed > 0) {
    statParts.push(`-${file.removed}`);
  }

  return statParts.length > 0
    ? `${relativePath} ${statParts.join(" ")}`
    : relativePath;
}

// buildPerTurnFileChangeMap 只为 turn.snapshots.length > 0 的轮次建条目，存入 turn 引用；
// 空快照轮次不写空数组，调用方按键存在性区分「无数据」与「无改动」（INV-04）；同一 turnIndex 后者覆盖前者。
export function buildPerTurnFileChangeMap(
  fileChanges: readonly ZCodePersistedFileChange[] | undefined,
): Map<number, ZCodePersistedFileChange> {
  const result = new Map<number, ZCodePersistedFileChange>();
  if (!fileChanges || fileChanges.length === 0) {
    return result;
  }

  for (const turn of fileChanges) {
    // turn.snapshots.length === 0 时 continue：写入空数组会让消费方把该轮渲染成「无文件改动」，
    // 而按 INV-04，缺键才代表没有快照；将来要展示「本轮只跑了命令」应新增字段，不要复用该映射。
    if (turn.snapshots.length === 0) {
      continue;
    }

    result.set(turn.turnIndex, turn);
  }

  return result;
}

// buildTaskChangeSummary 的任务级口径：每个 snapshot.path 只保留首个 beforeContent 与末个 afterContent，
// 行数差由两端内容经 computeLineChangeStat 重算而不是累加单次补丁（INV-14）；
// writeCount/lastTurnIndex 原样带出；路径不做大小写归一，同一文件的不同写法会算成两个条目。
export function buildTaskChangeSummary(
  fileChanges: readonly ZCodePersistedFileChange[] | undefined,
): ZCodeTaskChangeSummary | null {
  if (!fileChanges || fileChanges.length === 0) {
    return null;
  }

  const changedFileMap = new Map<string, AggregatedFileChange>();

  for (const turn of fileChanges) {
    for (const snapshot of turn.snapshots) {
      // [事务] 命中已有条目时只更新最终内容、写入次数与最后轮次
      // 绝不能覆盖首次记录的前置内容，否则增删统计退化成「最后一次写入的差异」
      // 写入次数用累加，同一文件多轮多次写入必须如实反映
      // 最后轮次取当前遍历到的轮次，前提是传入的快照已按轮次升序排列
      // 上游顺序若被打乱，这里会给出更早的轮次，顺序保证必须在调用方
      const existing = changedFileMap.get(snapshot.path);
      if (existing) {
        existing.finalContent = snapshot.afterContent;
        existing.writeCount += snapshot.writeCount;
        existing.lastTurnIndex = turn.turnIndex;
        continue;
      }

      changedFileMap.set(snapshot.path, {
        path: snapshot.path,
        originalContent: snapshot.beforeContent,
        finalContent: snapshot.afterContent,
        writeCount: snapshot.writeCount,
        lastTurnIndex: turn.turnIndex,
      });
    }
  }

  if (changedFileMap.size === 0) {
    return null;
  }

  let added = 0;
  let removed = 0;
  // [契约] 行数差在映射回调内逐文件计算，并同步累加总量
  // 排序固定用路径的 localeCompare，结果顺序是界面与测试的稳定契约
  const files: ZCodeTaskChangedFileSummary[] = Array.from(changedFileMap.values())
    .map((file) => {
      const fileStat = computeLineChangeStat(
        file.originalContent,
        file.finalContent,
      );
      added += fileStat.added;
      removed += fileStat.removed;
      return {
        path: file.path,
        added: fileStat.added,
        removed: fileStat.removed,
        writeCount: file.writeCount,
        lastTurnIndex: file.lastTurnIndex,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    fileCount: files.length,
    added,
    removed,
    files,
  };
}

// [契约] appendPatch 把空白补丁视为无效，直接返回 current 原值
// 多段 normalizedPatch 之间用换行连接，顺序即工具调用发生顺序
// current 为空时直接采用首段 normalizedPatch，不产生前导换行
function appendPatch(current: string | undefined, patch: string | null | undefined) {
  const normalizedPatch = patch?.trim();
  if (!normalizedPatch) {
    return current;
  }

  return current ? `${current}\n${normalizedPatch}` : normalizedPatch;
}

// [契约] 只接受普通对象，数组与空值一律视为缺失
// 字段存在但不是字符串时返回 undefined，不做数字转字符串
// 该读取只服务状态判断，不用于透传业务数据
function readRecordString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

// [契约] error 字段存在即判失败，优先级高于状态字符串
// 状态与原始状态都要小写后再比较，避免大小写差异漏判
// 被拒绝与被取消同属失败，因为它们同样没有真实落盘
// 未知状态默认按成功处理，新增状态名时需同步这里
function hasUnsuccessfulToolStatus(
  toolCall: NonNullable<TaskChatMessage["toolCalls"]>[number],
): boolean {
  const status = toolCall.status.toLowerCase();
  const rawStatus = readRecordString(toolCall.raw, "status")?.toLowerCase();
  return (
    toolCall.error !== undefined ||
    status === "failed" ||
    status === "denied" ||
    status === "error" ||
    status === "cancelled" ||
    rawStatus === "failed" ||
    rawStatus === "denied" ||
    rawStatus === "error" ||
    rawStatus === "cancelled"
  );
}

// [契约] 只处理助手消息，其它角色一律返回空摘要
// 同一消息内同一路径多次出现时，增删行数与写入次数累加
// 补丁表只收集非空补丁，为空时整个字段返回 undefined
// 摘要与补丁表必须同源，不能出现一个有值另一个没有
// 本函数不读磁盘，全部信息来自工具调用的输入、输出与原始载荷
export function buildToolCallChangeSummary(
  message: TaskChatMessage,
  turnIndex: number,
): {
  patchesByPath?: ReadonlyMap<string, string>;
  summary: ZCodeTaskChangeSummary | null;
} {
  if (message.role !== "assistant" || !message.toolCalls?.length) {
    return { summary: null };
  }

  const filesByPath = new Map<string, ZCodeTaskChangedFileSummary>();
  const patchesByPath = new Map<string, string>();
  for (const toolCall of message.toolCalls) {
    // [失败路径] 被拒绝或报错的工具调用必须整条跳过
    // 修复背景：plan mode 会把被拒绝的写入保留在工具调用列表里
    // 保留这些调用会让摘要显示从未落盘的文件改动
    // 跳过发生在读取文件摘要之前，不能只在最终结果上过滤
    // 逐条跳过而不是整条消息跳过，同一消息里成功的调用仍要统计
    if (hasUnsuccessfulToolStatus(toolCall)) {
      // Bugfix: plan mode 会把被拒绝的 Write 保留成 tool call 输入，但它没有真实落盘。
      // 从 tool input 派生变更摘要时必须跳过失败/拒绝工具，否则会显示不存在的文件改动。
      continue;
    }

    const fileSummaries = readRawToolCallFileSummaries(toolCall.raw, {
      toolName: toolCall.toolName,
      kind: toolCall.kind,
      title: toolCall.title,
      input: toolCall.input,
      output: toolCall.output,
      raw: toolCall.raw,
    });
    for (const file of fileSummaries) {
      if (!file.changeStat) {
        continue;
      }

      const existing = filesByPath.get(file.path);
      filesByPath.set(file.path, {
        added: (existing?.added ?? 0) + file.changeStat.added,
        lastTurnIndex: turnIndex,
        path: file.path,
        removed: (existing?.removed ?? 0) + file.changeStat.removed,
        writeCount: (existing?.writeCount ?? 0) + 1,
      });
      const nextPatch = appendPatch(patchesByPath.get(file.path), file.patch);
      if (nextPatch) {
        patchesByPath.set(file.path, nextPatch);
      }
    }
  }

  if (filesByPath.size === 0) {
    return { summary: null };
  }

  const files = [...filesByPath.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  return {
    patchesByPath: patchesByPath.size > 0 ? patchesByPath : undefined,
    summary: {
      added: files.reduce((total, file) => total + file.added, 0),
      fileCount: files.length,
      files,
      removed: files.reduce((total, file) => total + file.removed, 0),
    },
  };
}

// [契约] filesByPath 跨消息按路径合并，writeCount 与 added / removed 相加
// lastTurnIndex 用 Math.max 合并，消息乱序时仍取最新轮次
// assistant 消息优先用自身 turnIndex，缺失时回退到 messageIndex
// 被跳过的调用不会出现在结果里，结果只反映可验证的改动
// 总量在生成列表时累加，必须与列表内容始终一致
export function buildTaskChangeSummaryFromToolCalls(
  messages: readonly TaskChatMessage[] | undefined,
): ZCodeTaskChangeSummary | null {
  if (!messages || messages.length === 0) {
    return null;
  }

  const filesByPath = new Map<string, ZCodeTaskChangedFileSummary>();
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex]!;
    const turnIndex =
      message.role === "assistant"
        ? (message.turnIndex ?? messageIndex)
        : messageIndex;
    const summary = buildToolCallChangeSummary(message, turnIndex).summary;
    if (!summary) {
      continue;
    }

    for (const file of summary.files) {
      const existing = filesByPath.get(file.path);
      if (!existing) {
        filesByPath.set(file.path, { ...file });
        continue;
      }

      filesByPath.set(file.path, {
        path: file.path,
        added: existing.added + file.added,
        removed: existing.removed + file.removed,
        writeCount: existing.writeCount + file.writeCount,
        lastTurnIndex: Math.max(existing.lastTurnIndex, file.lastTurnIndex),
      });
    }
  }

  if (filesByPath.size === 0) {
    return null;
  }

  let added = 0;
  let removed = 0;
  const files = Array.from(filesByPath.values())
    .map((file) => {
      added += file.added;
      removed += file.removed;
      return file;
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    fileCount: files.length,
    added,
    removed,
    files,
  };
}

// [契约] 只用传入的单个轮次快照重算，不跨轮聚合
// 同一路径多次快照保留首个前置内容与末个后置内容，写入次数累加
// 最后轮次恒等于该轮次的编号，不做最大值比较
// 这是逐轮展示的唯一入口，调用方不得把任务级摘要传进来
export function buildTurnChangeSummary(
  turn: ZCodePersistedFileChange | null | undefined,
): ZCodeTaskChangeSummary | null {
  if (!turn || turn.snapshots.length === 0) {
    return null;
  }

  // 调用方需要严格只显示当前轮的文件摘要。
  // 这里把单轮摘要计算抽成独立 helper，只从传入的当前轮快照重算，
  // 避免任何 task/session 级聚合误传进来时把历史轮次文件一起展示出来。
  const filesByPath = new Map<
    string,
    {
      beforeContent: string | null;
      afterContent: string;
      writeCount: number;
    }
  >();

  for (const snapshot of turn.snapshots) {
    const existing = filesByPath.get(snapshot.path);
    if (existing) {
      existing.afterContent = snapshot.afterContent;
      existing.writeCount += snapshot.writeCount;
      continue;
    }

    filesByPath.set(snapshot.path, {
      beforeContent: snapshot.beforeContent,
      afterContent: snapshot.afterContent,
      writeCount: snapshot.writeCount,
    });
  }

  let added = 0;
  let removed = 0;
  const files: ZCodeTaskChangedFileSummary[] = Array.from(filesByPath.entries())
    .map(([path, snapshot]) => {
      const fileStat = computeLineChangeStat(
        snapshot.beforeContent,
        snapshot.afterContent,
      );
      added += fileStat.added;
      removed += fileStat.removed;
      return {
        path,
        added: fileStat.added,
        removed: fileStat.removed,
        writeCount: snapshot.writeCount,
        lastTurnIndex: turn.turnIndex,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    fileCount: files.length,
    added,
    removed,
    files,
  };
}

/**
 * 从 fileChanges 中按轮次构建 per-turn 文件变更摘要。
 * 用于在每条 assistant 消息下方显示该轮的文件改动。
 */
// [契约] buildPerTurnChangeSummaries 只为有内容的轮次建条目，空轮次不占位
// Map 的键是 turnIndex，调用方按消息轮次查表
// 同一 turnIndex 重复出现时后者覆盖前者
export function buildPerTurnChangeSummaries(
  fileChanges: readonly ZCodePersistedFileChange[] | undefined,
): Map<number, ZCodeTaskChangeSummary> {
  const result = new Map<number, ZCodeTaskChangeSummary>();
  if (!fileChanges || fileChanges.length === 0) {
    return result;
  }

  for (const turn of fileChanges) {
    const summary = buildTurnChangeSummary(turn);
    if (!summary) {
      continue;
    }

    result.set(turn.turnIndex, summary);
  }

  return result;
}
