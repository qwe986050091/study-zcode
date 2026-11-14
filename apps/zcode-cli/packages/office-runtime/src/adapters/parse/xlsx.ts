// INV-01 先做包级校验再解压：守住位置 openPackage；改错故障 zip 炸弹把内存打满。
// INV-02 解析失败统一映射 corrupt_file：守住位置 catch；改错故障 上层拿不到稳定错误码。
// INV-03 空表返回空文本而非报错：守住位置 usedBounds 返回 null；改错故障 空工作簿被当成坏文件。
// INV-04 合并区非主格不重复渲染：守住位置 readCell 早退；改错故障 同值在每格重复出现。
// INV-05 公式保留原文并标注未计算：守住位置 cached 判定；改错故障 用户以为读到了计算结果。
// INV-06 每页固定 25 行、最多 60 列：守住位置 ROWS_PER_UNIT/MAX_COLS；改错故障 一次倾倒整表撑爆上下文。
// INV-07 列被截断必须提示：守住位置 表头后缀；改错故障 用户以为拿到了全部列。
// INV-08 表名精确优先、大小写回退：守住位置 findSheet；改错故障 同名不同大小写选错表。
// INV-09 指定区间用已用区域裁边：守住位置 bounds 收敛；改错故障 整列区间渲染出海量空行。
// INV-10 check 只规范化不改数据：守住位置 展开返回；改错故障 校验动作产生副作用。
// INV-11 搜索命中定位到单格：守住位置 formatLocator 的 range；改错故障 命中无法回读原文。
// INV-12 达到 limit 立即停止：守住位置 两层提前 return；改错故障 大表搜索把全部单元格扫完。
// INV-13 display 兜底必须无损：守住位置 JSON.stringify；改错故障 未知类型被静默渲染成空串。
//
// 模块职责：用 ExcelJS 读取工作表、单元格文本与公式，产出按表/区域定位的模型文本。
// 阅读顺序：先看单元格取值与边界，再看分页渲染，最后看 read/search/check 三个投影入口。
// Excel（.xlsx）解析器：用 ExcelJS 读取工作表、单元格文本与公式，产出按表/区域定位的模型文本。
// 边界：只解析工作簿数据，不计算公式、不渲染样式；每个工作表是一个读取单元，定位符为 Sheet!A1:C9。
// 失败语义：工作簿损坏 → corrupt_file，解压超限 → file_too_large；空表返回空文本而不是报错。
import ExcelJS from "exceljs";
import { OfficeError, type OutlineItem } from "#office/contract.ts";
import {
  columnName,
  formatCell,
  formatLocator,
  formatSheet,
  type Locator,
} from "#office/domain/anchor.ts";
import {
  markdownTable,
  matchAll,
  paginate,
  snippet,
  type Hit,
  type ParsedDocument,
} from "#office/domain/model.ts";
import { openPackage } from "#office/adapters/parse/ooxml.ts";

// 每个读取单元（一页）覆盖的行数：既作分页粒度，也作默认预览行数，避免一次倾倒整表。
// `ROWS_PER_UNIT` 同时决定分页粒度与默认预览行数：调大减少页数，但单页更重。
const ROWS_PER_UNIT = 25;
// 单次渲染的最大列数；超出部分省略，并在段落标题里提示改用更窄的区间读取。
const MAX_COLS = 60;

// 单元格展示信息：display 可直接拼进表格（公式取缓存结果、富文本拼平）；
// formula 仅在单元格本身是公式时存在，形如 `=<原始公式>`，无缓存值时附“未计算”提示。
interface CellInfo {
  // 展示文本；合并区域的非主格为空串。
  display: string;
  // 公式原文（含 "=" 前缀），非公式单元格无此字段。
  formula?: string;
}

// 把任意 ExcelJS 单元格值转成展示字符串：null/undefined/无效日期 → ""；
// 富文本拼平、错误值取 error、超链接取 text（回退 hyperlink）、公式对象取缓存 result；
// 其余未知对象退化为 JSON.stringify，保证不丢信息。
// 判定顺序按值形状从具体到泛化，先富文本/错误/超链接，再公式对象。
// 未知对象退化为 JSON 而不是空串，保证不丢信息。
function display(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? "" : value.toISOString().replace(/T00:00:00\.000Z$/, "");
  if (typeof value === "object") {
    if ("richText" in value) return value.richText.map((run) => run.text).join("");
    if ("error" in value) return String(value.error);
    if ("hyperlink" in value) return String(value.text ?? value.hyperlink);
    if ("formula" in value || "sharedFormula" in value) {
      const result = (value as { result?: ExcelJS.CellValue }).result;
      return result === undefined ? "" : display(result);
    }
    return JSON.stringify(value);
  }
  return String(value);
}

// 读取单元格：合并区域的非主格返回空串（内容只在主格，避免重复渲染）；
// 公式保留原文，缺缓存结果时标注 "(not calculated in file)"，提示调用方该值可能为空。
// 合并区只有主格持有内容，非主格返回空避免重复渲染。
// 公式原文与缓存结果分开保存，缓存缺失时追加提示。
// 不伪造数值：没有缓存就留空并标注未计算。
function readCell(cell: ExcelJS.Cell): CellInfo {
  if (cell.isMerged && cell.master !== cell) return { display: "" };
  const formula = cell.formula || undefined;
  const value = cell.value;
  const cached =
    typeof value === "object" && value !== null && "result" in value ? value.result : undefined;
  return {
    display: display(value),
    ...(formula
      ? { formula: `=${formula}${cached === undefined ? "  → (not calculated in file)" : ""}` }
      : {}),
  };
}

// 工作表已用区域的 1 起行列边界（含首尾）；renderRange 以左上角为起点逐页输出。
interface Bounds {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

// 已用区域：dimensions 与 actualRowCount 都存在才算有内容，否则返回 null（空表）。
// dimensions 与 actualRowCount 任一缺失都视为空表。
// 返回边界含首尾，供渲染与区间裁剪共用。
function usedBounds(sheet: ExcelJS.Worksheet): Bounds | null {
  const dims = sheet.dimensions as unknown as Bounds | undefined;
  if (!dims || !sheet.actualRowCount) return null;
  return { top: dims.top, left: dims.left, bottom: dims.bottom, right: dims.right };
}

// 渲染区间为若干分页单元：每 25 行一页、最多 60 列，首行为列字母表头。
// 每页标题形如 `<intro> rows A–B`，列被截断时提示未输出的列范围；
// 该页出现的公式集中输出在末尾（单元格: =公式），便于核对而不混进表格正文。
function renderRange(sheet: ExcelJS.Worksheet, bounds: Bounds, intro: string): string[] {
  // 列截断只影响渲染，不改变定位语义。
  // 截断后用真实列字母标注省略范围，提示改用更窄区间。
  const right = Math.min(bounds.right, bounds.left + MAX_COLS - 1);
  const units: string[] = [];
  // 分页按行推进，末页可能不足 25 行。
  // 每页独立生成表头与公式区，便于单独读取。
  for (let start = bounds.top; start <= bounds.bottom; start += ROWS_PER_UNIT) {
    const end = Math.min(bounds.bottom, start + ROWS_PER_UNIT - 1);
    const header = [
      "",
      ...Array.from({ length: right - bounds.left + 1 }, (_, i) => columnName(bounds.left + i)),
    ];
    const rows: string[][] = [header];
    const formulas: string[] = [];
    for (let r = start; r <= end; r++) {
      const row = sheet.getRow(r);
      const line = [String(r)];
      for (let c = bounds.left; c <= right; c++) {
        const info = readCell(row.getCell(c));
        line.push(info.display);
        if (info.formula) formulas.push(`${formatCell({ row: r, col: c })}: ${info.formula}`);
      }
      rows.push(line);
    }
    const parts = [
      `${intro} rows ${start}–${end}${right < bounds.right ? ` (columns ${columnName(right + 1)}–${columnName(bounds.right)} omitted; read a narrower range)` : ""}`,
      markdownTable(rows),
    ];
    if (formulas.length) parts.push(`Formulas:\n${formulas.join("\n")}`);
    units.push(parts.join("\n"));
  }
  return units;
}

// 解析 .xlsx：先用 openPackage 做 zip 炸弹检查，再交给 ExcelJS 读入工作簿（样式/合并/公式）。
// 读入失败统一降级为 corrupt_file；标题取文档属性 workbook.title。
// 每张工作表一个 outline 单元（level 1），label 带已用区域或 "(empty)"，隐藏表标注状态。
// 默认读取每张表前 25 行预览，提示剩余行数与完整读取的定位串；空表只输出占位行。
// 定位：sheet 名先精确匹配、失败后大小写不敏感回退；给定 range 时用已用区域裁剪下/右边界，
// 避免整列区间把海量空行也渲染出来。check 只把名字规范化成真实表名。
export async function parseXlsx(bytes: Uint8Array, label: string): Promise<ParsedDocument> {
  // 先做包级校验：避免把压缩比异常的 xlsx 直接交给 ExcelJS 解压。
  // 必须在 ExcelJS 解压前完成压缩比检查。
  // 这里失败直接向上抛，不降级成 corrupt_file。
  await openPackage(bytes, label); // zip-bomb guard before ExcelJS inflates everything
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );
  } catch (error) {
    throw new OfficeError(
      "corrupt_file",
      `${label} could not be read as a workbook: ${(error as Error).message}`,
    );
  }
  const sheets = workbook.worksheets;
  // 合并区域列表（形如 "A1:B2"）；ExcelJS 的 model 字段无类型声明，缺省为空数组。
  const merges = (sheet: ExcelJS.Worksheet) => (sheet.model as { merges?: string[] }).merges ?? [];

  // 工作表标签：有内容 → "Name (A1:X99[, hidden])"；空表 → "Name (empty...)"。
  const sheetLabel = (sheet: ExcelJS.Worksheet) => {
    const bounds = usedBounds(sheet);
    const hidden = sheet.state && sheet.state !== "visible" ? `, ${sheet.state}` : "";
    return bounds
      ? `${sheet.name} (${formatCell({ row: bounds.top, col: bounds.left })}:${formatCell({ row: bounds.bottom, col: bounds.right })}${hidden})`
      : `${sheet.name} (empty${hidden})`;
  };

  const outline: OutlineItem[] = sheets.map((sheet) => ({
    at: formatSheet(sheet.name),
    label: sheetLabel(sheet),
    level: 1,
  }));

  // 按名查找工作表：先精确匹配，再做一次大小写不敏感回退；找不到报 invalid_anchor 并列出表名。
  function findSheet(name: string) {
    const sheet =
      sheets.find((item) => item.name === name) ??
      sheets.find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (!sheet)
      throw new OfficeError(
        "invalid_anchor",
        `No sheet named "${name}". Sheets: ${sheets.map((item) => item.name).join(", ")}.`,
      );
    return sheet;
  }

  // 按定位器选内容：null → 每张表一份 25 行预览（并提示剩余行数与完整读取的定位串）；
  // 指定 sheet/range 时按区间分页渲染，区间越界或表名不存在报 invalid_anchor。
  function select(locator: Locator | null): string[] {
    // `locator` 为空时每张 sheet 只给一份预览，并提示剩余行数。
    // 空表只输出 `sheetLabel` 标题占位，不构造假行。
    if (!locator) {
      return sheets.flatMap((sheet) => {
        const bounds = usedBounds(sheet);
        const head = `## Sheet ${sheetLabel(sheet)}`;
        if (!bounds) return [head];
        const preview = {
          ...bounds,
          bottom: Math.min(bounds.bottom, bounds.top + ROWS_PER_UNIT - 1),
        };
        const more =
          bounds.bottom > preview.bottom
            ? `\n(${bounds.bottom - preview.bottom} more rows; read ${formatLocator({ kind: "xlsx", sheet: sheet.name })} for all)`
            : "";
        const merged = merges(sheet);
        return [
          `${head}\n${renderRange(sheet, preview, `${formatSheet(sheet.name)}`)[0]}${more}${merged.length ? `\nMerged cells: ${merged.slice(0, 30).join(", ")}` : ""}`,
        ];
      });
    }
    if (locator.kind !== "xlsx")
      throw new OfficeError("invalid_anchor", "Not a spreadsheet location.");
    const sheet = findSheet(locator.sheet);
    const used = usedBounds(sheet);
    const bounds = locator.range
      ? {
          top: locator.range.start.row,
          left: locator.range.start.col,
          bottom: locator.range.end.row,
          right: locator.range.end.col,
        }
      : used;
    if (!bounds) return [`## Sheet ${sheetLabel(sheet)}\n(empty)`];
    if (used && locator.range) {
      // Do not page through millions of empty rows when a whole column range is requested.
      bounds.bottom = Math.min(bounds.bottom, Math.max(used.bottom, bounds.top));
      bounds.right = Math.min(bounds.right, Math.max(used.right, bounds.left));
    }
    return renderRange(sheet, bounds, formatSheet(sheet.name));
  }

  // 返回与格式无关的文档模型；read 分页输出，check 只校验并规范化 sheet 名。
  return {
    kind: "xlsx",
    title: workbook.title || null,
    units: sheets.length,
    outline,
    read: (locator, cursor) => paginate(select(locator), cursor),
    check(locator) {
      if (locator.kind !== "xlsx")
        throw new OfficeError("invalid_anchor", "Not a spreadsheet location.");
      return { ...locator, sheet: findSheet(locator.sheet).name };
    },
    // 全表逐单元格匹配（含公式原文），命中定位到单格（A1 形式）；达到 limit 立即停止。
    search(query, limit) {
      const hits: Hit[] = [];
      for (const sheet of sheets) {
        sheet.eachRow({ includeEmpty: false }, (row, r) => {
          if (hits.length >= limit) return;
          row.eachCell({ includeEmpty: false }, (cell, c) => {
            if (hits.length >= limit) return;
            const info = readCell(cell);
            const text = info.formula ? `${info.display} ${info.formula}` : info.display;
            const index = matchAll(text, query)[0];
            if (index !== undefined)
              hits.push({
                at: formatLocator({
                  kind: "xlsx",
                  sheet: sheet.name,
                  range: { start: { row: r, col: c }, end: { row: r, col: c } },
                }),
                snippet: snippet(text, index, query.length),
              });
          });
        });
        if (hits.length >= limit) break;
      }
      return hits;
    },
  };
}
