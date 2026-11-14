// 面板静态资源名的白名单校验，供资源路由与二进制读取共用。
// 策略只由本文件的正则决定；新增资源种类（扩展名或子目录）必须同步修改正则与构建脚本，否则会被拒绝。
/**
 * Names served from `${ASSET_PREFIX}{name}`: bundle chunks, styles, wasm, pdf.js data and the
 * bundled CJK fallback font. pdf.js wasm decodes JPEG 2000 images (openjpeg) and ICC colours (qcms).
 */
// 白名单正则本体：顶层文件只允许单段文件名，pdfjs/ 与 fonts/ 允许固定子目录，避免任意嵌套。
const ASSET_NAME =
  /^(?:[\w-]+\.(?:txt|css|json|js|wasm)|pdfjs\/(?:cmaps\/[\w-]+\.bcmap|standard_fonts\/[\w-]+\.(?:pfb|ttf)|wasm\/[\w-]+\.wasm)|fonts\/[\w-]+\.woff2)$/;

// 资源名白名单校验：只接受构建产物中真实存在的形态（顶层 txt/css/json/js/wasm、pdf.js 的 cmaps、
// standard_fonts 与 wasm、以及 woff2 字体），供面板资源与二进制资源路由共用。
// 入参为 URL 解码后的相对资源名；返回 true 才允许拼到 assetRoot 下读取，false 一律视作非法资源。
// 副作用：无，纯函数；与 ASSET_NAME 正则即唯一策略源，扩展资源种类时须同步修改正则与构建脚本。
export function isAssetName(name: string): boolean {
  // 正则已限定形态，但仍需单独拦截 ".."：pdfjs/ 子路径允许斜杠，拼接后可能逃出 assetRoot。
  return ASSET_NAME.test(name) && !name.includes("..");
}
