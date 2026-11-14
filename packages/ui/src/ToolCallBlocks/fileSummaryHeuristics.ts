// 职责：把任意形态的工具调用记录折算成 ToolCallBlocks 可渲染的文件摘要（路径、操作标签、行变更、diff）。
// 边界：不渲染 UI、不写盘、不做权限判定；也不负责多文件聚合与排序，本文件最多产出一个条目。
// 以下 INV 各对应一处“看着能简化、实则改变展示语义”的接缝，改前先读故障描述。
//
// INV-01 断言：写文件语义只能来自 resolveToolCallIdentity 的 family，不能用标题或输出里的关键字判断 —— 守住它的位置：hasWritableToolSemantic —— 改错故障：search/explore 的输出含 remove 字样时被误判为删除并渲染 Deleted 文件块。
// INV-02 断言：读类工具必须先于写类被排除 —— 守住它的位置：buildFallbackRawToolCallFileSummary 的 hasReadLikeToolSemantic 分支 —— 改错故障：带 write 字样的读取工具产出 Created 摘要。
// INV-03 断言：没有路径就没有文件摘要 —— 守住它的位置：readToolCallPathCandidate 与 !path 早退 —— 改错故障：出现没有来源路径的空文件条目。
// INV-04 断言：路径别名按声明顺序取第一个命中 —— 守住它的位置：readToolCallPathCandidate 内的 readStringField —— 改错故障：同时带 path 与 file 的工具展示错文件。
// INV-05 断言：空字符串是合法内容，不能用真值判断 —— 守住它的位置：readToolCallContentCandidate 的 content !== undefined —— 改错故障：新建空文件丢掉 0/0 行统计与空 patch。
// INV-06 断言：before 与 after 必须成对返回，newText 允许空串 —— 守住它的位置：readToolCallBeforeAfterCandidate —— 改错故障：整文件删除被降级成只有路径没有 diff。
// INV-07 断言：Deleted 不生成 patch —— 守住它的位置：buildFallbackRawToolCallFileSummary 的 patch 三元 —— 改错故障：删除预览显示整份文件被加回来。
// INV-08 断言：changeStat 缺失必须是 undefined 而不是 0 —— 守住它的位置：changeStat 条件链 —— 改错故障：界面显示误导性的 +0/-0。
// INV-09 断言：Created 的旧内容固定传 null —— 守住它的位置：computeLineChangeStat(null, content) —— 改错故障：新建文件的行统计把整份文件算成修改。
// INV-10 断言：文本推断按 delete、update、write、edit 的顺序取首个命中 —— 守住它的位置：inferEditOperationFromText —— 改错故障：updated and deleted 这类描述被展示成 Edited。
// INV-11 断言：候选文本的插入顺序就是优先级 —— 守住它的位置：readEditOperationCandidates 的 Set 与 key 数组 —— 改错故障：description 覆盖 kind，操作标签在不同会话间漂移。
// INV-12 断言：显式 operationKinds 优先于任何文本启发式 —— 守住它的位置：inferEditOperation 的首个分支 —— 改错故障：已声明 update 的工具因标题含 delete 被改成 Deleted。
// INV-13 断言：混合 kind 一律收敛为 edit，不做多数投票 —— 守住它的位置：allWrite/allUpdate/allDelete 之后 —— 改错故障：两个 write 加一个 delete 被判成 Created。
// INV-14 断言：actionLabel 全部同为 Created 或 Deleted 才返回 write 或 delete —— 守住它的位置：inferEditOperation 尾段 —— 改错故障：部分新建的文件被归到 Created 分组。
// INV-15 断言：fallback 只走文本启发式，不带外部 kind 与 label —— 守住它的位置：inferEditOperation 传入两个空数组 —— 改错故障：fallback 与上层推断互相覆盖，摘要重复或标签跳动。
// INV-16 断言：只有 pending 状态才把 title 提到最前 —— 守住它的位置：readEditOperationCandidatesByPhase 的 isRunning —— 改错故障：运行中的工具标题被历史内容挤掉。
// INV-17 断言：completed 且为读类工具时不采信 content —— 守住它的位置：shouldIgnoreCompletedContent —— 改错故障：把读到的文件正文当成写操作描述。
// INV-18 断言：content 载荷要同时支持数组与对象两种形态及两层嵌套 —— 守住它的位置：readRawContentTexts —— 改错故障：Claude 风格 tool_result 推断不出操作，只显示裸路径。
// INV-19 断言：结果固定为单元素数组，diff 标题只用路径叶子 —— 守住它的位置：buildFallbackRawToolCallFileSummary 返回处 —— 改错故障：diff 头出现绝对路径或条目数量异常。
// INV-20 断言：所有分支返回空数组表示“不展示”，不是失败 —— 守住它的位置：buildFallbackRawToolCallFileSummary 各早退 —— 改错故障：把不展示当成异常抛出，打断整个工具块渲染。
import { computeLineChangeStat } from "@zcode/shared";
import { resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { getPathLeaf } from "@/lib/path.js";
import { buildUnifiedDiff } from "@/lib/toolDiffPreview.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import {
  type EditKindSource,
  type EditOperationKind,
  type RawToolCallFileSummary,
  isPlainRecord,
  readRawToolCallInput,
  readStringField,
} from "@/ToolCallBlocks/fileSummaryTypes.js";

export type { EditKindSource } from "@/ToolCallBlocks/fileSummaryTypes.js";

function normalizeActionText(value: string) {
  return value.trim().toLowerCase();
}

export function hasWritableToolSemantic(source?: EditKindSource): boolean {
  if (!source) {
    return false;
  }

  // TodoWrite/AskUserQuestion 这类固定工具名不能再靠字符串片段判断写文件。
  // 统一走 tool identity，旧 ZCode Agent 的 kind/title/raw 兼容只留在 resolver fallback 里。
  return resolveToolCallIdentity(source).family === "file-write";
}

function hasReadLikeToolSemantic(source?: EditKindSource): boolean {
  if (!source) {
    return false;
  }

  return resolveToolCallIdentity(source).family === "file-read";
}

function inferEditOperationFromText(value: string): EditOperationKind | null {
  // 先统一小写再跑正则，否则大写的 DELETE 会直接漏判成 null
  // trim 只去首尾空白，句中标点保留，正则靠词界而不是精确词匹配
  // 不要在这里叠加同义词归一，所有候选文本共用这一处，改动会同时影响 delete 与 write 的判定
  // 返回 null 表示文本无法判断，交给上层用 operationKinds 或 actionLabels 兜底
  const text = normalizeActionText(value);
  if (!text) {
    return null;
  }

  // [权衡] delete 分支排在最前，created and deleted 这类混合描述会先落到删除，这是刻意的悲观归类
  // 词界只加在尾部，perform 这类词尾含 rm 的文本会误命中 delete，write 分支的 renew 同理，属已知启发式代价
  // 要收紧匹配必须同时补回归用例，否则历史会话里的删除标签会成片变化
  // remov(e|ed) 覆盖 remove 与 removed 却漏掉 removing，新增词形时沿用同一词族写法
  if (/(delete|deleted|remov(e|ed)|eras(e|ed)|unlink|destroy|rm)\b/.test(text)) {
    return "delete";
  }

  if (/(update|updating|updated)\b/.test(text)) {
    return "update";
  }

  if (/(write|wrote|written|create|creating|created|add|added|save|saved|new)\b/.test(text)) {
    return "write";
  }

  if (
    /(edit|editing|edited|modify|modifying|modified|change|changed|patch|replace|replaced|fix|fixed)\b/.test(
      text,
    )
  ) {
    return "edit";
  }

  return null;
}

function readEditOperationCandidates(source: EditKindSource): string[] {
  const candidates = new Set<string>();

  if (typeof source.title === "string" && source.title.trim().length > 0) {
    candidates.add(source.title);
  }

  if (typeof source.kind === "string" && source.kind.trim().length > 0) {
    candidates.add(source.kind);
  }

  if (isPlainRecord(source.input)) {
    // input 内的候选按数组顺序入 Set，顺序即优先级，description 会先于 kind 被抽出来
    // 改成对象键遍历会打乱顺序，同一条工具可能从 Edited 漂成 Deleted
    // Set 顺带完成去重，title 与 description 文案相同时后续候选不会被挤掉
    // 只收 trim 后非空的字符串，数字或对象形态的操作字段一律忽略
    for (const key of ["description", "action", "operation", "mode", "title", "kind"] as const) {
      const value = source.input[key];
      if (typeof value === "string" && value.trim().length > 0) {
        candidates.add(value);
      }
    }
  }

  // raw 是旧版 ZCode Agent 的原始记录，在这里统一收窄一次，避免每处都写类型判断
  // raw.input 可能是 JSON 字符串，必须经 readRawToolCallInput 解析，直接下标会永远取不到字段
  // raw.kind 与 raw.title 先入集合，rawInput 的候选排在其后，保持旧字段的优先级
  // raw 不是普通对象时整块跳过而不抛错，宁可推断不出也不打断渲染
  if (isPlainRecord(source.raw)) {
    const rawKind = source.raw.kind;
    if (typeof rawKind === "string" && rawKind.trim().length > 0) {
      candidates.add(rawKind);
    }

    const rawTitle = source.raw.title;
    if (typeof rawTitle === "string" && rawTitle.trim().length > 0) {
      candidates.add(rawTitle);
    }

    const rawInput = readRawToolCallInput(source.raw);
    if (isPlainRecord(rawInput)) {
      for (const key of ["description", "action", "operation", "mode", "title", "kind"] as const) {
        const value = rawInput[key];
        if (typeof value === "string" && value.trim().length > 0) {
          candidates.add(value);
        }
      }
    }
  }

  return [...candidates];
}

function readRawContentTexts(raw: unknown): string[] {
  if (!isPlainRecord(raw)) {
    return [];
  }

  const texts = new Set<string>();
  const content = raw.content;

  const addText = (value: unknown) => {
    if (typeof value === "string" && value.trim().length > 0) {
      texts.add(value);
    }
  };

  // content 可能是数组或多模态对象，两种形态都要覆盖，否则不同 provider 的工具结果只有一半能推断
  // item.content 还可能再是对象，需要多取一层 text，漏掉这层会让 Claude 风格 tool_result 直接断链
  // 空串与纯空白都会被 addText 过滤，这里不 trim 原文，保留写入内容的原始缩进
  // 这里只收集原文不加工，大小写与标点都由后续 normalize 与正则负责
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!isPlainRecord(item)) {
        continue;
      }

      addText(item.text);
      addText(item.content);

      if (isPlainRecord(item.content)) {
        addText(item.content.text);
        addText(item.content.content);
      }
    }
  } else if (isPlainRecord(content)) {
    addText(content.text);
    addText(content.content);
  }

  return [...texts];
}

// [契约] 查找顺序是 input、output、raw input、raw output，先命中即返回
// input 排最前，因为 output 里的路径常是被读取或被引用的文件，先看 output 会把读对象当成写目标
// 四个来源都用 isPlainRecord 收窄，字符串形态的载荷不参与路径提取
// 没命中返回 undefined 而不是空串，调用方直接用真值判断即可
function readToolCallPathCandidate(source?: EditKindSource): string | undefined {
  if (!source) {
    return undefined;
  }

  for (const value of [
    source.input,
    source.output,
    readRawToolCallInput(source.raw),
    isPlainRecord(source.raw) ? source.raw.rawOutput : undefined,
  ]) {
    if (!isPlainRecord(value)) {
      continue;
    }

    // 别名数组的顺序就是优先级，path 先于 filePath 与 file
    // 新别名只能追加到末尾，插到头部会改变既有工具的展示路径
    // 命中空串时会继续向后找，readStringField 内部按非空判断，这里无需重复
    // 路径不做规范化，保留工具的原始写法，叶子名由展示层自行解析
    const path = readStringField(value, [
      "path",
      "filePath",
      "file_path",
      "targetPath",
      "target_path",
      "filename",
      "file",
    ]);
    if (path) {
      return path;
    }
  }

  return undefined;
}

function readToolCallContentCandidate(source?: EditKindSource): string | undefined {
  if (!source) {
    return undefined;
  }

  for (const value of [
    source.input,
    source.output,
    readRawToolCallInput(source.raw),
    isPlainRecord(source.raw) ? source.raw.rawOutput : undefined,
  ]) {
    if (!isPlainRecord(value)) {
      continue;
    }

    const content = readStringField(value, [
      "content",
      "newText",
      "new_text",
      "newString",
      "new_string",
      "text",
      "fileContent",
      "file_content",
      "contents",
      "code",
    ]);
    // [失败路径] 这里用未定义判断而不是真值，空字符串是合法内容
    // 改成真值判断后，新建空文件会被判成没有内容，行统计与 patch 一起消失
    // 返回 undefined 表示四个来源都没有内容字段，与内容为空是两种语义
    // 命中第一个就停，不合并多来源，避免把 output 的回显当成写入内容
    if (content !== undefined) {
      return content;
    }
  }

  return undefined;
}

function readToolCallBeforeAfterCandidate(
  source?: EditKindSource,
): { oldText: string; newText: string } | null {
  if (!source) {
    return null;
  }

  for (const value of [
    source.input,
    source.output,
    readRawToolCallInput(source.raw),
    isPlainRecord(source.raw) ? source.raw.rawOutput : undefined,
    source.raw,
  ]) {
    if (!isPlainRecord(value)) {
      continue;
    }

    const oldText = readStringField(value, [
      "oldText",
      "old_string",
      "oldString",
      "before",
      "old_content",
      "oldContent",
    ]);
    const newText = readStringField(value, [
      "newText",
      "new_string",
      "newString",
      "after",
      "new_content",
      "newContent",
      "content",
    ]);
    // [契约] 必须同时拿到旧文本与新文本才返回，只有一半时继续找下一个来源
    // newText 允许空串，整文件删除正是靠这个分支保留 diff 依据
    // source.raw 放在候选末尾，避免 raw 的 content 抢占正式 input 的字段
    // 返回对象而不是数组，调用方按成对语义使用，不会出现新旧错位
    if (oldText !== undefined && newText !== undefined) {
      return { oldText, newText };
    }
  }

  return null;
}

export function buildFallbackRawToolCallFileSummary(
  source?: EditKindSource,
): RawToolCallFileSummary[] {
  const path = readToolCallPathCandidate(source);
  // [失败路径] 没有路径就没有可展示的文件摘要，直接返回空数组
  // 不要拿 descriptor 的 fileName 兜底，那会产出没有来源路径的条目
  // 空数组对界面是“不渲染”而非错误，上层不需要 try/catch 兜底
  // 这一判断必须早于工具语义判断，避免对无路径工具做无意义的 identity 解析
  if (!path) {
    return [];
  }

  // [契约] 读类判断排在写类之前，读取工具即便标题含 write 也不产出摘要
  // 两个 family 由 resolveToolCallIdentity 互斥给出，这里不做字符串兜底
  // 顺序反过来会让带写文件字样的读取工具产出 Created 条目
  // identity 解析失败时 family 为 unknown，两支都不命中，最终返回空数组
  if (hasReadLikeToolSemantic(source)) {
    return [];
  }

  // [契约] 非写类工具一律不产出文件摘要，这是本函数唯一的功能开关
  // 不要用标题里出现 write 或 delete 作为兜底，搜索与执行工具会被大面积误判
  // source 缺省时 hasWritableToolSemantic 返回 false，与未知工具不展示的约定一致
  // 将来要支持无 identity 的新工具，应扩展 resolver 而不是放开这里的判断
  if (!hasWritableToolSemantic(source)) {
    return [];
  }

  // [权衡] 这里刻意传两个空数组，只允许文本启发式参与推断
  // fallback 负责补上层拿不到 kind 与 label 的场景，带外部数据会和上层推断重复
  // 空数组让 actionLabels 分支必然跳过，避免 fallback 与正式推断互相覆盖
  // source 为空时不调用，直接得到 null 并返回空数组
  const inferredOperation = source ? inferEditOperation([], [], source) : null;
  if (!inferredOperation) {
    return [];
  }

  const descriptor = resolveFileDisplayDescriptor(path);
  // update 没有独立的展示标签，与 edit 一起归到 Edited
  // 新增 Updated 标签需要同步改类型与所有消费方，否则分组文案会出现空白
  // write 与 delete 各自成支，其余一律 Edited，保证 actionLabel 覆盖全部取值
  // operationKind 将来新增取值时，这里必须同步补一支，否则会静默落到 Edited
  const actionLabel: RawToolCallFileSummary["actionLabel"] =
    inferredOperation === "write"
      ? "Created"
      : inferredOperation === "delete"
        ? "Deleted"
        : "Edited";
  const content = readToolCallContentCandidate(source);
  const beforeAfter = readToolCallBeforeAfterCandidate(source);
  // [契约] 三段条件分别对应新建、删除、编辑，其他组合一律 undefined
  // 删除用 content 当旧文本、空串当新文本，算出来是整文件删减
  // 创建必须把旧值传 null，传空串会把行统计算成修改而不是新增
  // 编辑依赖成对的 before 与 after，缺一半就不给统计；undefined 与 0 不同，前者未知后者是真实零变更
  const changeStat =
    actionLabel === "Created" && content !== undefined
      ? computeLineChangeStat(null, content)
      : actionLabel === "Deleted" && content !== undefined
        ? computeLineChangeStat(content, "")
        : actionLabel === "Edited" && beforeAfter
          ? computeLineChangeStat(beforeAfter.oldText, beforeAfter.newText)
          : undefined;
  // [契约] Deleted 刻意不生成 patch，删除没有可预览的新文本
  // 给 Deleted 补 diff 会让预览显示整份文件被加回来，是用户可见的错
  // diff 的路径参数用 getPathLeaf，只拿叶子名做标题，避免泄漏绝对路径
  // Created 的旧文本固定空串，与 changeStat 的 null 语义不要混用
  const patch =
    actionLabel === "Created" && content !== undefined
      ? buildUnifiedDiff("", content, getPathLeaf(path))
      : actionLabel === "Edited" && beforeAfter
        ? buildUnifiedDiff(beforeAfter.oldText, beforeAfter.newText, getPathLeaf(path))
        : null;

  return [
    {
      path,
      actionLabel,
      operationKind: inferredOperation,
      fileName: descriptor.fileName,
      filePath: descriptor.filePath,
      fileIconSrc: descriptor.fileIconSrc,
      changeStat,
      patch,
    },
  ];
}

function readEditOperationCandidatesByPhase(source: EditKindSource): string[] {
  const prioritized = new Set<string>();
  const raw = source.raw;
  // [并发] 只认 pending 为运行中，completed 走另一条分支
  // running 与 in_progress 不算运行中，这是协议字段约定，改成不等于 completed 会打乱优先级
  // raw 不是普通对象时两个状态标记都是 false，候选只走静态字段
  // 状态只影响 title 是否提前，不改变最终返回的条数
  const isRunning = isPlainRecord(raw) && raw.status === "pending";
  const isCompleted = isPlainRecord(raw) && raw.status === "completed";
  const shouldIgnoreCompletedContent = hasReadLikeToolSemantic(source);

  if (isRunning && typeof source.title === "string" && source.title.trim().length > 0) {
    prioritized.add(source.title);
  }

  // [失败路径] 读类工具完成后不采信 content，读到的正是别人的文件正文
  // 不采信后仍会走静态 title 与 kind，不会丢掉整个工具
  // completed 之外的状态不读 content，防止半成品输出被当成操作描述
  // 这批候选先并入，顺序决定 content 优先于静态字段
  if (isCompleted && !shouldIgnoreCompletedContent) {
    for (const text of readRawContentTexts(raw)) {
      prioritized.add(text);
    }
  }

  for (const candidate of readEditOperationCandidates(source)) {
    prioritized.add(candidate);
  }

  return [...prioritized];
}

export function inferEditOperation(
  operationKinds: EditOperationKind[],
  actionLabels: Array<RawToolCallFileSummary["actionLabel"]>,
  source?: EditKindSource,
): EditOperationKind | null {
  if (source && !hasWritableToolSemantic(source)) {
    // 之前 search / explore / execute 等非写类工具，只要标题或输出里带 delete/remove，
    // 就可能被文本启发式误判成 delete。这里先要求工具本身具备“写文件”语义，再继续细分操作。
    return null;
  }

  // [契约] 显式 kind 优先于任何文本启发式，这是上层声明的强信号
  // 三种取值全一致才返回具体类型，混合一律收敛为 edit
  // 不要改成多数投票，两个 write 加一个 delete 会被误判成 Created
  // 该分支返回后不再看 source，保证声明与文本冲突时以声明为准
  if (operationKinds.length > 0) {
    const allWrite = operationKinds.every((kind) => kind === "write");
    const allUpdate = operationKinds.every((kind) => kind === "update");
    const allDelete = operationKinds.every((kind) => kind === "delete");

    if (allWrite) {
      return "write";
    }

    if (allUpdate) {
      return "update";
    }

    if (allDelete) {
      return "delete";
    }

    return "edit";
  }

  if (source) {
    for (const candidate of readEditOperationCandidatesByPhase(source)) {
      const inferred = inferEditOperationFromText(candidate);
      if (inferred) {
        return inferred;
      }
    }
  }

  if (actionLabels.length === 0) {
    return null;
  }

  const allCreated = actionLabels.every((label) => label === "Created");
  const allEdited = actionLabels.every((label) => label === "Edited");
  const allDeleted = actionLabels.every((label) => label === "Deleted");

  if (allCreated) {
    return "write";
  }

  if (allDeleted) {
    return "delete";
  }

  // 后半句在前面已排除空数组，此处恒真，保留只为让有标签但不纯创建或纯删除的情况显式落到 edit
  // 删掉后半句行为不变，但会把兜底意图藏进隐式控制流，回归时容易误判成 null 分支
  if (allEdited || actionLabels.length > 0) {
    return "edit";
  }

  return null;
}
