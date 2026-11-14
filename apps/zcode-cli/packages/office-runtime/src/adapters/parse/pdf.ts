// PDF 解析器：用 pdf.js 逐页抽文本并沿书签树构建大纲，产出与格式无关的 ParsedDocument。
// 边界：解析完全在内存中执行，worker 跑在主线程；cmaps 与标准字体目录由上层通过 PdfAssets 注入。
// 失败语义：加密或语法损坏统一降级为 corrupt_file；单页/单书签失败只跳过该项，不中断整体解析。
import { OfficeError, type OutlineItem } from "#office/contract.ts";
import type { Locator } from "#office/domain/anchor.ts";
import {
  clampRange,
  matchAll,
  normalise,
  paginate,
  snippet,
  type Hit,
  type ParsedDocument,
} from "#office/domain/model.ts";
import { cut } from "#office/domain/text.ts";
import { normalizeCjkCompat } from "#office/domain/cjk.ts";
import { installDomMatrix } from "#office/adapters/parse/dommatrix.ts";

// pdf.js 运行所需的外部资源目录（cMapUrl、standardFontDataUrl 必须以 / 结尾）：
// 提供 CJK 字符映射与内置字体回退，缺失会让部分 PDF 抽取成乱码或丢字。
/** Directory with pdf.js `cmaps/` and `standard_fonts/`, ending in a slash. */
export interface PdfAssets {
  cMapUrl: string;
  standardFontDataUrl: string;
}

// pdf.js legacy 构建的类型别名；仅用于类型位置，运行时通过动态 import 加载。
type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
// 模块级单例缓存：并发解析共享同一次动态加载，避免重复安装 DOMMatrix 与 worker。
let pdfjs: Promise<PdfJs> | undefined;

// 懒加载 pdf.js：首次调用安装 DOMMatrix 垫片，再把 worker 模块挂到 globalThis.pdfjsWorker，
// 让 pdf.js 在主线程执行（stdio 服务无需独立 worker，单文件打包也无法给出 worker 文件路径）。
// 返回值是单例 Promise；加载失败不会自动重试，同一进程内错误会一直复现。
async function loadPdfJs(): Promise<PdfJs> {
  return (pdfjs ??= (async () => {
    installDomMatrix();
    // Run the worker code on the main thread: a stdio server has no use for a separate worker,
    // and bundling keeps the worker module available without a file path.
    const worker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
    return import("pdfjs-dist/legacy/build/pdf.mjs");
  })());
}

// 最多索引的页数上限：超出部分不抽取文本（防止超大 PDF 耗尽内存），units 仍使用真实页数。
const MAX_PAGES_INDEXED = 3000;

// 解析 PDF：逐页抽取文本（保留 pdf.js 给出的换行），每页一个读取单元；
// 依赖 PdfAssets 指定的 cmaps 与标准字体目录，并禁用 eval/系统字体以保证跨环境确定性。
// 打开失败（密码保护或语法损坏）统一降级为 corrupt_file 并附明确文案。
// 大纲沿书签树递归（最多 3 层、截断 200 条），单个目标解析失败只跳过该条目。
// 页数超过 MAX_PAGES_INDEXED 时仅索引前 3000 页；无文本页（扫描件）渲染成占位提示。
// 成功与否都会在 finally 中 destroy() 释放 pdf.js 文档资源。
export async function parsePdf(
  bytes: Uint8Array,
  label: string,
  assets: PdfAssets,
): Promise<ParsedDocument> {
  const { getDocument } = await loadPdfJs();
  let doc;
  try {
    // isEvalSupported=false / useSystemFonts=false：禁用 eval 与系统字体，避免不可控执行与跨环境差异。
    doc = await getDocument({
      data: bytes.slice(),
      cMapUrl: assets.cMapUrl,
      cMapPacked: true,
      standardFontDataUrl: assets.standardFontDataUrl,
      isEvalSupported: false,
      useSystemFonts: false,
      verbosity: 0,
    }).promise;
  } catch (error) {
    const name = (error as Error).name;
    throw new OfficeError(
      "corrupt_file",
      name === "PasswordException"
        ? `${label} is password protected.`
        : `${label} could not be read as a PDF: ${(error as Error).message}`,
    );
  }
  try {
    const pages: string[] = [];
    // 逐页抽取：只拼接文本项（str），hasEOL 时补换行；去掉行尾空格后做 CJK 兼容归一化。
    for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES_INDEXED); n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        text += item.str + (item.hasEOL ? "\n" : "");
      }
      pages.push(normalizeCjkCompat(text.replace(/[ \t]+\n/g, "\n").trim()));
      // 及时释放页面缓存，避免大文档把已解析页面累积在内存里。
      page.cleanup();
    }

    const outline: OutlineItem[] = [];
    // 递归展开书签树，level 从 1 起且最多下钻到第 3 层：
    // 目标可为命名目的地（字符串，需 getDestination 解析）或数组；解析失败或无页码的条目跳过；
    // 页码统一转成 1 起的 `page:N` 锚点，label 归一化后截断 120 字。
    const walk = async (items: Awaited<ReturnType<typeof doc.getOutline>>, level: number) => {
      for (const item of items ?? []) {
        if (outline.length >= 200) return;
        let pageNumber: number | null = null;
        try {
          const dest =
            typeof item.dest === "string" ? await doc.getDestination(item.dest) : item.dest;
          const ref = Array.isArray(dest) ? dest[0] : null;
          if (ref && typeof ref === "object") pageNumber = (await doc.getPageIndex(ref)) + 1;
          else if (typeof ref === "number") pageNumber = ref + 1;
        } catch {
          pageNumber = null;
        }
        if (pageNumber)
          outline.push({
            at: `page:${pageNumber}`,
            label: cut(normalise(item.title), 0, 120),
            level,
          });
        if (level < 3) await walk(item.items, level + 1);
      }
    };
    await walk(await doc.getOutline(), 1);
    const info = (await doc.getMetadata().catch(() => null))?.info as
      | { Title?: string }
      | undefined;
    const numPages = doc.numPages;

    // 渲染单页：带 `## Page N` 标题；无文本时明确提示可能为扫描件，避免被误认为解析失败。
    const render = (n: number) =>
      `## Page ${n}\n${pages[n - 1] || "(no extractable text; the page may be scanned)"}`;
    // 按定位器选页：null → 全部页；否则 clamp 页区间后只渲染已索引的页，越界由 clampRange 报错。
    const select = (locator: Locator | null) => {
      if (!locator) return pages.map((_, i) => render(i + 1));
      if (locator.kind !== "pdf") throw new OfficeError("invalid_anchor", "Not a PDF location.");
      const { from, to } = clampRange(locator.from, locator.to, numPages, "page");
      return Array.from({ length: Math.min(to, pages.length) - from + 1 }, (_, i) =>
        render(from + i),
      );
    };

    // 返回与格式无关的文档模型；标题只认 PDF 元数据 Title，不拿正文首行臆测。
    return {
      kind: "pdf",
      title: info?.Title?.trim() || null,
      units: numPages,
      outline,
      read: (locator, cursor) => paginate(select(locator), cursor),
      check: (locator) => (select(locator), locator),
      // 逐页扫描，每条命中定位到 `page:N`；同页多个命中都会返回，直到 limit 为止。
      search(query, limit) {
        const hits: Hit[] = [];
        pages.forEach((text, i) => {
          for (const index of matchAll(text, query)) {
            // 达到上限立即停止（forEach 无法 break，用 return 跳过后续页）。
            if (hits.length >= limit) return;
            hits.push({ at: `page:${i + 1}`, snippet: snippet(text, index, query.length) });
          }
        });
        return hits;
      },
    };
  } finally {
    // 无论解析成功与否都释放 pdf.js 文档资源（worker 与字体缓存）。
    await doc.destroy();
  }
}
