// INV-01 后缀决定预览种类：守住位置 扩展名表；改错故障 未知格式被当成可预览。
// INV-02 归一化先去空白再小写：守住位置 normalizedPath；改错故障 大写后缀漏判。
// INV-03 无路径直接返回空：守住位置 入口判断；改错故障 空路径抛出异常。
// INV-04 三种后缀判断顺序固定：守住位置 分支顺序；改错故障 doc 抢在 docx 之前。
// INV-05 缩放不超过原尺寸：守住位置 取最小值；改错故障 小图被放大后模糊。
// INV-06 宽高共用同一比例：守住位置 返回对象；改错故障 图形被拉伸变形。
// INV-07 非法尺寸返回空：守住位置 数值校验；改错故障 除零得到无穷大。
// INV-08 解码只做字节复制：守住位置 循环；改错故障 文本编码被二次转换。
// INV-09 链接必须是字符串：守住位置 类型判断；改错故障 对象被强转成协议串。
// INV-10 控制字符一律拒绝：守住位置 逐字符扫描；改错故障 换行伪装的脚本协议通过。
// INV-11 内部锚点需无空白与尖括号：守住位置 正则；改错故障 锚点注入额外属性。
// INV-12 外链只允许两种协议：守住位置 scheme 判断；改错故障 自定义协议被放行。
// INV-13 解析后再次校验协议：守住位置 URL 分支；改错故障 大小写或变体绕过检查。
// INV-14 写入 DOM 后再收口：守住位置 sanitizeDocumentLinks；改错故障 parser 生成的链接漏网。
// INV-15 不安全链接移除属性并标记禁用：守住位置 removeAttribute；改错故障 链接仍可点击。
// INV-16 点击统一交给受控入口：守住位置 handleClick；改错故障 主窗口被导航。
// INV-17 变更观察只扫新增子树：守住位置 MutationObserver；改错故障 大文档全树重扫。
// INV-18 卸载函数释放监听与观察：守住位置 返回闭包；改错故障 预览关闭后仍持有 DOM。
//
// 模块职责：识别 Office 文件预览种类，并提供尺寸计算、解码与链接净化。
// 状态所有权：纯函数与常量；不持有预览实例。
// 阅读顺序：先看后缀识别与尺寸，再看解码与链接净化，最后看点击拦截与观察。
export type OfficeFilePreviewKind = "excel" | "docx" | "doc";

export interface DocxPreviewFit {
  scale: number;
  width: number;
  height: number;
}

// EXCEL_FILE_EXTENSIONS 用 endsWith 匹配三种表格后缀，匹配前先小写。
// 匹配前先走 normalizedPath，大小写差异已被吸收。
// DOCX_FILE_EXTENSIONS 与 LEGACY_DOC_FILE_EXTENSIONS 是唯一来源。
const EXCEL_FILE_EXTENSIONS = [".xlsx", ".xlsm", ".xls"] as const;
const DOCX_FILE_EXTENSIONS = [".docx"] as const;
const LEGACY_DOC_FILE_EXTENSIONS = [".doc"] as const;

export function getOfficeFilePreviewKind(path?: string): OfficeFilePreviewKind | null {
  if (!path) {
    return null;
  }

  // normalizedPath 先 trim 再 toLowerCase。
  // 大小写差异在 normalizedPath 上吸收。
  // 归一化不改变调用方传入的展示路径。
  const normalizedPath = path.trim().toLowerCase();
  if (DOCX_FILE_EXTENSIONS.some((extension) => normalizedPath.endsWith(extension))) {
    return "docx";
  }
  if (LEGACY_DOC_FILE_EXTENSIONS.some((extension) => normalizedPath.endsWith(extension))) {
    return "doc";
  }
  if (EXCEL_FILE_EXTENSIONS.some((extension) => normalizedPath.endsWith(extension))) {
    return "excel";
  }
  return null;
}

export function calculateDocxPreviewFit({
  availableWidth,
  naturalHeight,
  naturalWidth,
}: {
  availableWidth: number;
  naturalHeight: number;
  naturalWidth: number;
}): DocxPreviewFit | null {
  if (
    !Number.isFinite(availableWidth) ||
    !Number.isFinite(naturalHeight) ||
    !Number.isFinite(naturalWidth) ||
    availableWidth <= 0 ||
    naturalHeight <= 0 ||
    naturalWidth <= 0
  ) {
    return null;
  }

  // scale 由 Math.min(1, availableWidth / naturalWidth) 计算并封顶为 1。
  // 按 availableWidth 等比缩放。
  // width 与 height 共用同一个 scale。
  const scale = Math.min(1, availableWidth / naturalWidth);
  return {
    scale,
    width: naturalWidth * scale,
    height: naturalHeight * scale,
  };
}

// decodeBase64ToArrayBuffer 先用 atob 解成二进制字符串。
// 逐字节写入 Uint8Array。
// 返回 bytes.buffer 本体。
export function decodeBase64ToArrayBuffer(dataBase64: string): ArrayBuffer {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

/**
 * 文档内容来自不受信任的 OOXML relationship，不能把 Target 原样交给 DOM。
 * 只允许普通 Web 外链和当前文档内部锚点；其余协议一律降级为不可点击文本。
 */
export function sanitizeDocumentHref(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  // typeof value !== "string" 时返回 null。
  // trim 后为空串视为无链接。
  // 后续判断只基于归一化后的 href。
  const href = value.trim();
  if (!href) {
    return null;
  }

  // 控制字符可以把 `java\nscript:` 伪装成看似普通的协议；先拒绝而不是尝试修复。
  // 逐字符判断避免安全正则本身触发 lint 的 no-control-regex 警告。
  for (const character of href) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return null;
    }
  }

  if (href.startsWith("#")) {
    return href.length > 1 && !/[\s<>"']/u.test(href) ? href : null;
  }

  // scheme 由正则 ^([a-z][a-z0-9+.-]*): 取出。
  // scheme 统一 toLowerCase 后与 http / https 比较。
  // 非两种 Web 协议一律拒绝。
  const scheme = href.match(/^([a-z][a-z0-9+.-]*):/iu)?.[1]?.toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    return null;
  }

  try {
    const parsed = new URL(href);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? href : null;
  } catch {
    return null;
  }
}

/**
 * renderer 写入 DOM 后再做一次安全收口，覆盖 parser 生成的 HTML/SVG 超链接。
 */
const DOCUMENT_LINK_SELECTOR = "a[href], a[xlink\\:href]";

function sanitizeDocumentLinkElement(element: Element): void {
  for (const attribute of ["href", "xlink:href"] as const) {
    const value = element.getAttribute(attribute);
    if (value === null) {
      continue;
    }

    const safeHref = sanitizeDocumentHref(value);
    if (safeHref === null) {
      element.removeAttribute(attribute);
      if (element instanceof HTMLElement && element.tagName === "A") {
        element.setAttribute("aria-disabled", "true");
      }
      continue;
    }

    if (safeHref !== value) {
      element.setAttribute(attribute, safeHref);
    }
  }
}

export function sanitizeDocumentLinks(root: ParentNode): void {
  if (root instanceof Element && root.matches(DOCUMENT_LINK_SELECTOR)) {
    sanitizeDocumentLinkElement(root);
  }
  root.querySelectorAll(DOCUMENT_LINK_SELECTOR).forEach(sanitizeDocumentLinkElement);
}

/** 为各 Office renderer 安装统一的 DOM 净化和点击阻断；返回卸载函数。 */
export function installDocumentLinkSafety(
  root: HTMLElement,
  onOpenBrowserUrl?: (url: string) => void,
): () => void {
  const handleClick = (event: Event) => {
    const target = event.target instanceof Element ? event.target.closest("a") : null;
    if (!target) {
      return;
    }

    const safeHref = sanitizeDocumentHref(
      target.getAttribute("href") ?? target.getAttribute("xlink:href"),
    );
    if (safeHref === null) {
      event.preventDefault();
      return;
    }
    if (safeHref.startsWith("#")) {
      return;
    }

    // 文档外链不能直接导航主 renderer；统一交给受控 Browser/外部浏览器入口。
    event.preventDefault();
    onOpenBrowserUrl?.(safeHref);
  };

  sanitizeDocumentLinks(root);
  root.addEventListener("click", handleClick);
  const observer =
    typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver((records) => {
          const addedRoots = new Set<ParentNode>();
          for (const record of records) {
            if (record.type === "attributes" && record.target instanceof Element) {
              sanitizeDocumentLinkElement(record.target);
              continue;
            }
            for (const addedNode of record.addedNodes) {
              if (addedNode instanceof Element || addedNode instanceof DocumentFragment) {
                addedRoots.add(addedNode);
              }
            }
          }
          // 第三方 renderer 分批挂载或虚拟化重挂载时，每批 mutation 都曾扫描
          // 完整预览 DOM，导致大文档重复 O(全树) 查询。这里只扫描实际新增的子树。
          addedRoots.forEach(sanitizeDocumentLinks);
        });
  observer?.observe(root, {
    attributeFilter: ["href", "xlink:href"],
    attributes: true,
    childList: true,
    subtree: true,
  });

  return () => {
    observer?.disconnect();
    root.removeEventListener("click", handleClick);
  };
}
