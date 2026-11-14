export type ParsedPatch =
  | { type: "add"; path: string; contents: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; movePath?: string; chunks: PatchChunk[] };

export interface PatchChunk {
  oldLines: string[];
  newLines: string[];
  changeContext?: string;
  endOfFile?: boolean;
}

const BEGIN_MARKER = "*** Begin Patch";
const END_MARKER = "*** End Patch";
const ADD_HEADER = "*** Add File:";
const DELETE_HEADER = "*** Delete File:";
const UPDATE_HEADER = "*** Update File:";
const MOVE_HEADER = "*** Move to:";
const END_OF_FILE_MARKER = "*** End of File";

/**
 * 解析模型给出的结构化 patch 文本，产出 add/delete/update 三类 section。
 * 输入：可能被包在 bash heredoc 里、可能带 CRLF 的原始 patch 文本。
 * 输出：ParsedPatch[]，路径保持模型原文（不做工作区解析，交给 apply-patch 处理）。
 * 失败语义：缺 Begin/End 标记、未知 section 头、add 行不以 `+` 开头、hunk 行非法等
 * 一律抛出带原文的 Error；不返回空数组假装成功，否则“无变更”会被误报为成功。
 * 副作用：无；纯文本解析。
 */
export function parseStructuredPatch(patchText: string): ParsedPatch[] {
  // 为什么先剥 heredoc：模型常用 `cat <<'EOF' ... EOF` 包裹 patch，
  // 不剥离会把 shell 包装行当成非法 section；CRLF 归一化保证跨平台行切分一致。
  const normalized = stripHeredoc(patchText).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.trim().split("\n");
  const beginIndex = lines.findIndex((line) => line.trim() === BEGIN_MARKER);
  const endIndex = lines.findIndex((line) => line.trim() === END_MARKER);

  if (beginIndex === -1 || endIndex === -1 || beginIndex >= endIndex) {
    // Begin/End 缺失或顺序颠倒时无法界定合法区间；直接失败比“截取一段试解析”更可诊断。
    throw new Error("Invalid patch format: missing Begin/End markers");
  }

  const sections: ParsedPatch[] = [];
  let index = beginIndex + 1;
  while (index < endIndex) {
    const line = lines[index] ?? "";
    if (line.startsWith(ADD_HEADER)) {
      const path = readHeaderPath(line, ADD_HEADER);
      const parsed = parseAddFile(lines, index + 1, endIndex);
      sections.push({ type: "add", path, contents: parsed.contents });
      index = parsed.nextIndex;
      continue;
    }
    if (line.startsWith(DELETE_HEADER)) {
      sections.push({ type: "delete", path: readHeaderPath(line, DELETE_HEADER) });
      index += 1;
      continue;
    }
    if (line.startsWith(UPDATE_HEADER)) {
      const path = readHeaderPath(line, UPDATE_HEADER);
      let movePath: string | undefined;
      index += 1;
      if (index < endIndex && (lines[index] ?? "").startsWith(MOVE_HEADER)) {
        movePath = readHeaderPath(lines[index] ?? "", MOVE_HEADER);
        index += 1;
      }
      const parsed = parseUpdateChunks(lines, index, endIndex);
      sections.push({ type: "update", path, movePath, chunks: parsed.chunks });
      index = parsed.nextIndex;
      continue;
    }

    if (line.trim().length === 0) {
      // 空行只作分隔，不产生 section；静默跳过可容忍模型在 section 之间多留空行。
      index += 1;
      continue;
    }
    throw new Error(`Invalid patch section header: ${line}`);
  }

  return sections;
}

/**
 * 解析 Add File 的内容区，直到下一个 section 头或 End 标记。
 * 每行必须以 `+` 开头（去掉 `+` 后才是内容）；返回 contents 时统一补一个末尾换行。
 * 失败语义：出现非 `+` 行抛 Error，消息带原始行，避免把说明文字静默写进文件。
 * 输出 nextIndex 指向下一个 section 头，供外层循环继续。
 */
function parseAddFile(
  lines: string[],
  startIndex: number,
  endIndex: number,
): { contents: string; nextIndex: number } {
  const contents: string[] = [];
  let index = startIndex;
  while (index < endIndex && !isSectionHeader(lines[index] ?? "")) {
    const line = lines[index] ?? "";
    if (!line.startsWith("+")) {
      // Add File 的内容行必须显式带 `+`；缺标记通常意味着模型混入了说明文字，
      // 写进新文件会污染内容，因此在解析阶段就失败。
      throw new Error(`Invalid add file line: ${line}`);
    }
    contents.push(line.slice(1));
    index += 1;
  }
  return { contents: `${contents.join("\n")}\n`, nextIndex: index };
}

/**
 * 解析 Update File 的 hunk 区，直到下一个 section 头或 End 标记。
 * 每个 hunk 以 `@@` 开头，`@@` 后的文本作为 changeContext（用于消歧）。
 * hunk 内：` ` 行同时进入 old/new（上下文），`-` 只进 old，`+` 只进 new；
 * 遇到 `*** End of File` 则给当前 hunk 打 endOfFile 标记并结束该 hunk。
 * 失败语义：hunk 头不是 `@@` 且非空、或行首不是三种标记之一，抛 Error 带原文。
 */
function parseUpdateChunks(
  lines: string[],
  startIndex: number,
  endIndex: number,
): { chunks: PatchChunk[]; nextIndex: number } {
  const chunks: PatchChunk[] = [];
  let index = startIndex;
  while (index < endIndex && !isSectionHeader(lines[index] ?? "")) {
    const header = lines[index] ?? "";
    if (!header.startsWith("@@")) {
      if (header.trim().length === 0) {
        index += 1;
        continue;
      }
      throw new Error(`Invalid update hunk header: ${header}`);
    }

    const changeContext = header.slice(2).trim() || undefined;
    index += 1;
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let endOfFile = false;

    while (index < endIndex && !startsNextHunkOrSection(lines[index] ?? "")) {
      const line = lines[index] ?? "";
      if (line === END_OF_FILE_MARKER) {
        // 该标记属于当前 hunk（表示 hunk 贴文件末尾），消费后结束本 hunk；
        // 不放进 old/new 行，否则会被当成待匹配内容。
        endOfFile = true;
        index += 1;
        break;
      }
      if (line.startsWith(" ")) {
        oldLines.push(line.slice(1));
        newLines.push(line.slice(1));
      } else if (line.startsWith("-")) {
        oldLines.push(line.slice(1));
      } else if (line.startsWith("+")) {
        newLines.push(line.slice(1));
      } else {
        throw new Error(`Invalid update hunk line: ${line}`);
      }
      index += 1;
    }

    chunks.push({ oldLines, newLines, changeContext, endOfFile });
  }
  return { chunks, nextIndex: index };
}

/**
 * 判断某行是否开启新 hunk 或新 section，用于结束当前内容区扫描。
 * `@@` 开启同文件的下一个 hunk；Add/Delete/Update 头或 End 标记开启新 section。
 */
function startsNextHunkOrSection(line: string): boolean {
  return line.startsWith("@@") || isSectionHeader(line);
}

/** 判断某行是否 section 边界（Add/Delete/Update 头或 End 标记）；注意不含 `@@`。 */
function isSectionHeader(line: string): boolean {
  return (
    line.startsWith(ADD_HEADER) ||
    line.startsWith(DELETE_HEADER) ||
    line.startsWith(UPDATE_HEADER) ||
    line.trim() === END_MARKER
  );
}

/** 从 section 头中取出路径；空路径直接抛错，避免生成指向空字符串的写操作。 */
function readHeaderPath(line: string, prefix: string): string {
  const value = line.slice(prefix.length).trim();
  if (value.length === 0) {
    throw new Error(`Missing path for ${prefix}`);
  }
  return value;
}

/**
 * 剥离包裹 patch 的 heredoc：仅匹配 `cat <<'EOF' ... EOF` 或 `<<EOF ... EOF` 形态。
 * 匹配失败时原样返回输入（不在解析层猜测其他 shell 语法）。
 * 注意：这是容错处理，不是安全边界——heredoc 内的内容仍走同一套 section 校验。
 */
function stripHeredoc(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/^(?:cat\s+)?<<['"]?([A-Za-z0-9_]+)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
  return match ? (match[2] ?? "") : input;
}
