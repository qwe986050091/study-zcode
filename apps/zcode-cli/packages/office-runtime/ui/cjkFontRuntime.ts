// CJK 字体运行时：把 cjkFonts.ts 的纯规则落到 FontFace 注册与 pdf.js 字体链替换上。
// 边界：只使用 local() 系统字体与构建产物内的兜底分片，不发起网络请求；注册结果进程内缓存。
// 失败语义：单个系统字体缺失只跳过该 face；兜底分片失败仅告警并关闭兜底，不影响 PDF 打开。
import { readBinary, readText } from "#ui/assets.ts";
import {
  CJK_UNICODE_RANGE,
  FALLBACK_FAMILY,
  FALLBACK_MANIFEST,
  LOCAL_FONTS,
  cjkFamilies,
  familyOf,
  withCjkFamilies,
  type FaceKey,
  type PdfFontLike,
} from "#ui/cjkFonts.ts";

/**
 * Registers the `zcode-cjk-*` faces and the bundled fallback for the PDF canvas. scripts/build.mjs
 * patches pdf.js so the canvas asks `pdfTypeface` for every font it sets.
 */

// 准备只执行一次：共享同一个 Promise；fallbackReady 记录兜底字体是否可用，供 pdfTypeface 决策。
let prepared: Promise<void> | undefined;
let fallbackReady = false;

// 注册 zcode-cjk-* 字体面；仅用 local() 查找系统字体，不下载任何内容。
// 若一个 CJK 字体都没找到，则加载内置 Noto Sans SC 分片作为兜底；必须在打开 PDF 前完成，
// 因为画布首帧不会等待字体，迟到加载会导致整页重绘。
/**
 * Look up the installed fonts behind every `zcode-cjk-*` face (local() only, nothing is
 * downloaded); with no CJK font installed at all, load the bundled fallback instead. Runs before a
 * PDF opens: the canvas never waits for a font, so every face must be ready before the first page
 * is drawn.
 */
export function prepareCjkFonts(): Promise<void> {
  return (prepared ??= (async () => {
    const found = await Promise.all(
      Object.entries(LOCAL_FONTS).map(async ([key, names]) => {
        const face = new FontFace(
          familyOf(key as FaceKey),
          names.map((name) => `local("${name}")`).join(", "),
          { unicodeRange: CJK_UNICODE_RANGE },
        );
        try {
          await face.load();
          document.fonts.add(face);
          return true;
        } catch {
          return false;
        }
      }),
    );
    // 在首次绘制前决定并加载兜底字体：画布不会等字体，事后加载就得重画页面。
    if (!found.some(Boolean)) fallbackReady = await loadFallback();
  })());
}

// 按 manifest 注册内置字体分片；任一分片失败即整体视为失败，仅告警不抛出。
/** Register the bundled Noto Sans SC slices as `zcode-cjk-fallback`; false when that failed. */
async function loadFallback(): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readText(FALLBACK_MANIFEST)) as {
      faces: { file: string; unicodeRange: string }[];
    };
    await Promise.all(
      manifest.faces.map(async ({ file, unicodeRange }) => {
        const face = new FontFace(FALLBACK_FAMILY, await readBinary(file), { unicodeRange });
        await face.load();
        document.fonts.add(face);
      }),
    );
    return true;
  } catch (error) {
    console.warn("CJK fallback font", error);
    return false;
  }
}

// 为 pdf.js 设置的字体拼出 CSS font-family 列表：pdf.js 没有字体文件的字体会在通用族前插入
// zcode-cjk-* 面，从而用系统 CJK 字体或内置兜底渲染；不改变有内嵌字体文件的字体顺序。
// 纯字符串拼接，依赖 prepareCjkFonts 是否已运行来读取 fallbackReady；未准备时只插系统字体族。
/**
 * The CSS font-family list for a font the PDF canvas sets. `css` is pdf.js's own list; fonts pdf.js
 * has no file for get the `zcode-cjk-*` faces before its generic family.
 */
export function pdfTypeface(font: PdfFontLike, css: string): string {
  return withCjkFamilies(css, cjkFamilies(font, fallbackReady));
}
