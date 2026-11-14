// 解析器注册表：把构建期保留的各格式解析函数收敛成一个按 kind 查询的入口。
// 构建脚本按行尾 `kind:` 标记裁剪 import，因此新增格式必须同时更新 kinds 与标记，否则打包会漏解析器。
// 本文件不持有状态，调用方需自行把缺失解析器转成 unsupported_type。
import type { DocKind } from "#office/contract.ts";
import type { ParsedDocument } from "#office/domain/model.ts";
import type { PdfAssets } from "#office/adapters/parse/pdf.ts";
// One line per format, tagged `kind:<format>`: scripts/build.mjs keeps only the plugin's formats,
// so a plugin bundles only the parsers it uses.
import { parseDocx } from "#office/adapters/parse/docx.ts"; // kind:docx
import { parsePdf } from "#office/adapters/parse/pdf.ts"; // kind:pdf
import { parsePptx } from "#office/adapters/parse/pptx.ts"; // kind:pptx
import { parseXlsx } from "#office/adapters/parse/xlsx.ts"; // kind:xlsx

// 统一解析入口签名：输入原始字节、仅用于报错文案的展示路径、PDF 所需的资源目录；
// 输出与格式无关的 ParsedDocument。约定失败一律转成带 code 的 OfficeError，不向上抛原始解析异常。
// 解析器不持有状态、每次调用独立，因此同一文件可被并发解析而不共享缓存。
export type ParseFormat = (
  bytes: Uint8Array,
  path: string,
  pdfAssets: PdfAssets,
) => Promise<ParsedDocument>;

// 格式 → 解析器注册表；只含本插件构建时保留的格式（构建脚本按 kind: 标记裁剪）。
// 未注册的格式由调用方（adapters/main.ts）转成 unsupported_type；docx/xlsx/pptx 忽略 pdfAssets。
// 新增格式需同时更新 kinds.ts 与各 import 行的 kind: 标记，否则打包会漏掉解析器。
export const PARSERS: Partial<Record<DocKind, ParseFormat>> = {
  docx: (bytes, path) => parseDocx(bytes, path), // kind:docx
  pdf: (bytes, path, pdfAssets) => parsePdf(bytes, path, pdfAssets), // kind:pdf
  pptx: (bytes, path) => parsePptx(bytes, path), // kind:pptx
  xlsx: (bytes, path) => parseXlsx(bytes, path), // kind:xlsx
};
