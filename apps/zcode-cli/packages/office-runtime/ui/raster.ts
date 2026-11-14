/**
 * Render a live DOM element to a PNG without network access: the element is cloned with its
 * ancestors' class context, canvases and images are inlined as data: URLs, and the result is drawn
 * through an SVG <foreignObject>. Used by the capture_view page tool.
 * 全程离线：图片按 blob:/同源 URL 转 data:，跨域样式表读不到时跳过；失败不抛给 UI，
 * 只是缺失的图片/画布留白。输出 PNG 时按 maxWidth 缩放，最多 2 倍放大以免超大位图。
 */

// 以地址为键缓存「转 data: 的 Promise」：同一文档里同一图片可能被多次引用，
// 失败也缓存（值为 null），避免对坏图反复解码重试。生命周期随页面，不主动清理。
const imageCache = new Map<string, Promise<string | null>>();

// 把图片地址解码成 HTMLImageElement；失败转为 reject，由上层折成 null。
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("image failed to load"));
    image.src = src;
  });
}

// 返回值语义：成功得到 data:image/png;失败（跨域受限、解码错误）返回 null，调用方保留原图或留白。
// 已是 data: 的图直接透传，不重复解码；其余走缓存，保证同一张图只处理一次。
/** Turn a blob:/same-origin image URL into a data: URL by drawing it on a canvas. */
function inlineImage(src: string): Promise<string | null> {
  if (src.startsWith("data:")) return Promise.resolve(src);
  let cached = imageCache.get(src);
  if (!cached) {
    cached = loadImage(src)
      .then((image) => {
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth || 1;
        canvas.height = image.naturalHeight || 1;
        canvas.getContext("2d")!.drawImage(image, 0, 0);
        return canvas.toDataURL("image/png");
      })
      .catch(() => null);
    imageCache.set(src, cached);
  }
  return cached;
}

// 汇总当前文档所有可读样式表的规则文本，用于塞进克隆树的 <style> 里；
// 跨域表访问 cssRules 会抛 SecurityError，直接跳过（沙箱内通常不存在这类表）。
function cssText(): string {
  const parts: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) parts.push(rule.cssText);
    } catch {
      // Cross-origin sheets cannot be read; there are none in the sandbox.
    }
  }
  return parts.join("\n");
}

// 只匹配内联 style 里的 url(blob:...)，用于把 CSS 背景图也转成 data:；引号可有可无。
const URL_IN_CSS = /url\((['"]?)(blob:[^'")]+)\1\)/g;

// 就地改写克隆树：把画布/图片/内联样式里的 blob: 引用换成 data:，使序列化后的 SVG 自包含。
// 副产物是若干异步任务（图片解码）；全部完成后才返回，避免截到半成品。
// 结构上按两侧 children 的下标逐一配对，因为克隆与源 DOM 结构一一对应。
async function inlineTree(original: Element, clone: Element) {
  const jobs: Promise<void>[] = [];
  const walk = (source: Element, target: Element) => {
    if (source instanceof HTMLCanvasElement) {
      try {
        // 画布无法直接序列化，先转成 <img> 并显式带上像素尺寸，保持原有布局。
        const image = document.createElement("img");
        image.src = source.toDataURL("image/png");
        image.setAttribute(
          "style",
          (source.getAttribute("style") ?? "") +
            `;width:${source.offsetWidth}px;height:${source.offsetHeight}px`,
        );
        image.className = source.className;
        target.replaceWith(image);
      } catch {
        // A tainted or WebGL canvas without a preserved buffer: leave it blank.
      }
      return;
    }
    if (source instanceof HTMLImageElement && target instanceof HTMLImageElement) {
      const src = source.currentSrc || source.src;
      jobs.push(
        inlineImage(src).then((data) => {
          if (data) target.src = data;
          target.removeAttribute("srcset");
        }),
      );
    }
    if (source instanceof SVGImageElement) {
      const href = source.href.baseVal;
      jobs.push(
        inlineImage(href).then((data) => {
          if (data) {
            target.setAttribute("href", data);
            target.removeAttributeNS("http://www.w3.org/1999/xlink", "href");
          }
        }),
      );
    }
    const style = target.getAttribute("style");
    if (style?.includes("blob:")) {
      // 逐个替换 style 中的 blob: url；转不出来的换空串，等价于该背景图缺失。
      const urls = [...style.matchAll(URL_IN_CSS)].map((match) => match[2]);
      jobs.push(
        Promise.all(urls.map(inlineImage)).then((data) => {
          let next = style;
          urls.forEach((url, i) => {
            next = next.split(url).join(data[i] ?? "");
          });
          target.setAttribute("style", next);
        }),
      );
    }
    const sourceChildren = source.children;
    const targetChildren = Array.from(target.children);
    for (let i = 0; i < sourceChildren.length && i < targetChildren.length; i++)
      walk(sourceChildren[i], targetChildren[i]);
  };
  walk(original, clone);
  await Promise.all(jobs);
}

// 只重建标签名、className 与 data-* 属性：scoped 选择器据此仍能命中，但祖先盒模型被归一化，
// 避免原布局（定位/滚动/裁剪）影响截图。stopAt 的父级与 body 之外停止，防止把整页外壳抄进来。
/** Recreate the ancestor chain (tags and classes only) so scoped selectors still match. */
function wrapInAncestors(element: Element, clone: Element, stopAt: Element | null): Element {
  let inner: Element = clone;
  for (
    let node = element.parentElement;
    node && node !== stopAt?.parentElement && node !== document.body;
    node = node.parentElement
  ) {
    const shell = document.createElement(
      node.tagName.toLowerCase() === "body" ? "div" : node.tagName.toLowerCase(),
    );
    if (node.className && typeof node.className === "string") shell.className = node.className;
    for (const name of node.getAttributeNames())
      if (name.startsWith("data-")) shell.setAttribute(name, node.getAttribute(name)!);
    shell.setAttribute(
      "style",
      "display:block;margin:0;padding:0;border:0;background:none;width:auto;height:auto;transform:none;overflow:visible;position:static",
    );
    shell.append(inner);
    inner = shell;
  }
  return inner;
}

// 截图结果：data 是 base64 编码的 PNG 负载（不含 "data:image/png;base64," 前缀，
// 由调用方拼成 MCP 的 image content），width/height 是实际像素尺寸（已按缩放计算）。
export interface Raster {
  data: string;
  width: number;
  height: number;
}

// 把元素当前渲染结果栅格化为 PNG，返回纯 base64 负载与像素尺寸。
// 输入：element 必须是已挂载且有布局的节点；context 用于裁剪祖先链（通常是滚动容器）；
// background 缺省白底，保证深色主题下截图仍清晰可读。
// 副作用：只读 DOM 与样式表，绝不写回页面；会创建离屏 canvas 与临时 DOM。
// 失败语义：抛错（元素尺寸为 0 也按 1px 处理，不抛）；图片转 data: 失败不抛，只留白。
export async function rasterize(
  element: HTMLElement,
  options: { maxWidth: number; context?: Element | null; background?: string },
): Promise<Raster> {
  const width = Math.max(1, element.offsetWidth);
  const height = Math.max(1, element.offsetHeight);
  const clone = element.cloneNode(true) as HTMLElement;
  clone.style.transform = "none";
  clone.style.margin = "0";
  await inlineTree(element, clone);
  const computed = getComputedStyle(element);
  const root = document.createElement("div");
  root.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  root.setAttribute(
    "style",
    `width:${width}px;height:${height}px;overflow:hidden;font-family:${computed.fontFamily};color:${computed.color};background:${options.background ?? "#fff"}`,
  );
  const style = document.createElement("style");
  style.textContent = cssText();
  root.append(style, wrapInAncestors(element, clone, options.context ?? null));
  const markup = new XMLSerializer().serializeToString(root);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject x="0" y="0" width="100%" height="100%">${markup}</foreignObject></svg>`;
  const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  // 缩放上限 2 倍：再高的分辨率对模型识图无收益，却会显著增大 base64 体积。
  const scale = Math.min(2, options.maxWidth / width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d")!;
  context.fillStyle = options.background ?? "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return {
    data: canvas.toDataURL("image/png").split(",")[1],
    width: canvas.width,
    height: canvas.height,
  };
}

// 只做缩小（scale 上限 1），用于把已有 canvas（如表格网格）导出；返回格式与 rasterize 一致。
// 输入 canvas 必须已绘制完成，本函数不感知其内容是否就绪。
// maxWidth 小于等于 0 时不缩小，直接导出；编码失败会抛错，由调用方决定是否降级为文本结果。
/** Scale a canvas down to `maxWidth` and encode it. */
export function canvasToPng(source: HTMLCanvasElement, maxWidth: number): Raster {
  const scale = Math.min(1, maxWidth / source.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  canvas.getContext("2d")!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return {
    data: canvas.toDataURL("image/png").split(",")[1],
    width: canvas.width,
    height: canvas.height,
  };
}
