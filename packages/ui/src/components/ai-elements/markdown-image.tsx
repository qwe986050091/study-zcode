// ZCode Markdown 图片组件（packages/ui/src/components/ai-elements/markdown-image.tsx）
// 职责：把 markdown 的 img 节点解析成本地文件预览 / assistant artifact / 远程 URL 三种来源，输出缩略图、
// 同组图廊、点击放大预览与加载/失败占位，并保证键盘焦点可达；渲染链路为 Streamdown 分块 → harden 清洗 → 本组件映射。
// 不变量（INV-01..INV-20）：每条给出守卫位置与破坏后的具体故障；改动本文件前先确认对应守卫仍成立。
// INV-01 src 为空串时必须直接返回 null（守卫：resolvedSrc 判空后 return null），否则空图片会占据缩略图槽位并夺走键盘焦点。
// INV-02 来源优先级固定为 artifact > 本地 > 原始 src（守卫：displaySrc 三元表达式），调换顺序会让本地路径被当远程 URL 请求，得到 404 空白。
// INV-03 本地图片必须经 fileService.readMediaPreview 转 data URL（守卫：首个 useEffect），绕过它会因浏览器无法访问沙箱路径而永久停在骨架屏。
// INV-04 artifact 必须经 readAttachment 读取（守卫：第三个 useEffect），缺失 sessionId 或回调时须置 artifactImageFailed，否则永久显示加载态。
// INV-05 由字节构造的 Blob URL 必须在清理函数里 revoke（守卫：artifact effect 的 return），否则滚动消息列表会持续泄漏 Blob 内存直到刷新页面。
// INV-06 异步回调必须先用 disposed 短路（守卫：本地与 artifact 两个 effect），否则卸载后的 setState 会把旧会话图片写进新会话节点。
// INV-07 图片 load/error 状态必须按 source 归属（守卫：browserImageState.source === displaySrc 比较），只存 status 会让上一张图的 error 污染新图片。
// INV-08 img 节点必须用 displaySrc 作为 key 重建（守卫：img 的 key 属性），复用节点会让旧资源的迟到事件命中新处理器。
// INV-09 画廊识别要求子节点数不少于 2 且全部为 img（守卫：MarkdownImageParagraph 的 isImageGallery），降阈值会把普通段落错包成画廊。
// INV-10 纯图片行的空行压缩必须跳过代码围栏内部（守卫：activeFenceMarker 判定），否则围栏里的示例 markdown 会被改写，展示内容失真。
// INV-11 围栏闭合要求同标记、长度不短于开启、且无剩余后缀（守卫：闭合分支的三个条件），放宽会让三层反引号提前闭合围栏。
// INV-12 反引号围栏的信息串不得包含反引号（守卫：marker 为波浪号或后缀不含反引号这一条件），否则该行会被误判为开栏。
// INV-13 压缩连续图片行时只允许吞掉纯空白行（守卫：nextIndex 的跳过循环），吞掉非空行会静默丢弃用户正文。
// INV-14 跳过空行后必须确认下一行仍是纯图片行（守卫：第二次 markdownImageOnlyLinePattern 判定），否则会把图后正文一起并入图片块。
// INV-15 预览项的 src 必须取自真实 img 元素的 src（守卫：readPreviewGroup 的 querySelector），从 props 取会拿到未解析路径，放大大图时空白。
// INV-16 预览组作用域限定在同一画廊容器内（守卫：closest 到 data-markdown-image-gallery），跨容器收集会把整篇消息的图片混进同一次预览。
// INV-17 关闭预览后必须把焦点还给触发按钮（守卫：handlePreviewOpenChange 的 setTimeout），否则焦点掉到 body，键盘用户丢失阅读位置。
// INV-18 焦点恢复定时器必须在卸载与重复关闭时取消（守卫：focusTimerRef 清理 effect），悬空定时器会 focus 已卸载节点并触发 act 警告。
// INV-19 图片加载失败必须落 error 状态并写日志（守卫：img 的 onError），只透传外部回调会让远程图失败后既无可见反馈也无运行时线索。
// INV-20 日志中的 source 必须经 sanitizeImageSourceForLog 处理（守卫：onError 的 logger.warn 调用），否则 data URL 或带凭据地址会直出日志。
"use client";

import type { FileMediaPreview } from "@zcode/shared";
import { decodeMarkdownArtifactImageSource } from "@zcode/shared";
import { ImageIcon, ImageOffIcon } from "lucide-react";
import { Children, isValidElement } from "react";
import type { ComponentProps, MouseEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ImagePreviewDialog } from "@/components/ai-elements/image-preview-dialog.js";
import {
  sanitizeImageSourceForLog,
  type ImagePreviewDialogItem,
} from "@/components/ai-elements/image-preview-dialog.js";
import {
  ImageThumbnailGallery,
  imageThumbnailClassName,
  imageThumbnailTriggerClassName,
} from "@/components/ai-elements/image-thumbnail-gallery.js";
import { cn } from "@/components/lib/utils.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isImagePreviewPath } from "@/lib/codeViewer.js";
import { resolveMarkdownFileLink } from "@/lib/markdownFileLink.js";
import { logger } from "@/logger.js";

export { clampImagePreviewOffset as clampMarkdownImagePreviewOffset } from "@/components/ai-elements/image-preview-dialog.js";

export type MarkdownImageProps = ComponentProps<"img"> & {
  node?: unknown;
  workspacePath?: string;
  workspaceHomePath?: string;
  sessionId?: string;
  readAttachment?: (params: {
    sessionId: string;
    ref: string;
  }) => Promise<{ bytes: Uint8Array; mediaType: string } | { url: string; mediaType: string }>;
};

// 两个正则是 normalize 的唯一判据：前者识别整行只有一个图片的段落，后者识别代码围栏行。
// [权衡] 图片行正则允许前导与行尾空白，但不允许行内混入其他文字，避免把图文混排段落误合并。
// 围栏正则限定 0 到 3 个前导空格，超过三个空格按 CommonMark 属于缩进代码块，不参与围栏状态机。
const markdownImageOnlyLinePattern = /^\s*!\[[^\]]*]\([^\n]+\)\s*$/;
const markdownFenceLinePattern = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/**
 * Streamdown 会在 rehype 前按空行拆块。仅移除连续纯图片行之间的空行，让同组图片进入
 * 同一个 Markdown 块；代码围栏里的相似文本必须保持原样。
 */
// [失败路径] 该函数是纯函数：只做行级扫描与空行删除，不解析图片语义，输入含 CRLF 时依赖先拆行再拼回。
// 合并策略：仅当“图片行 + 若干空行 + 图片行”成立时才跳过空行，让同组图片落入同一 markdown 块。
// 破坏后果：若把非图片行也吞掉，用户正文会静默丢失；若合并跨围栏，代码示例里的 markdown 会被真实渲染。
// [并发] 无共享状态、无异步，可在流式增量渲染中安全重复执行，结果只取决于入参字符串。
export function normalizeConsecutiveMarkdownImageBlocks(markdown: string): string {
  const lines = markdown.split("\n");
  const normalized: string[] = [];
  let activeFenceMarker: "`" | "~" | null = null;
  let activeFenceLength = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fenceMatch = line.match(markdownFenceLinePattern);
    const fenceRun = fenceMatch?.[2];
    // [权衡] 围栏状态机按行推进：进入围栏后所有行原样透传，只有同标记且长度达标的闭合行才退出。
    // 若在该分支内继续做图片行合并，示例代码会被当作真实图片渲染，因此必须整块透传并跳过后续判定。
    if (fenceRun) {
      const marker = fenceRun[0] as "`" | "~";
      const suffix = fenceMatch[3] ?? "";
      if (
        activeFenceMarker === marker &&
        fenceRun.length >= activeFenceLength &&
        suffix.trim() === ""
      ) {
        activeFenceMarker = null;
        activeFenceLength = 0;
      } else if (!activeFenceMarker && (marker === "~" || !suffix.includes("`"))) {
        activeFenceMarker = marker;
        activeFenceLength = fenceRun.length;
      }
      normalized.push(line);
      continue;
    }

    // 仅在非围栏状态下才做图片行合并，这是 INV-10 的守卫点，也是与代码块内容隔离的唯一开关。
    // [失败路径] 匹配成功先入栈当前行，再向后探测空行；探测失败时不能回退索引，否则循环会重复处理同一行。
    // 空行探测使用 trim 判空，覆盖仅含空格与制表符的行，避免它们被当作块分隔符从而拆散图片组。
    if (!activeFenceMarker && markdownImageOnlyLinePattern.test(line)) {
      normalized.push(line);
      let nextIndex = index + 1;
      while (nextIndex < lines.length && !(lines[nextIndex] ?? "").trim()) {
        nextIndex += 1;
      }
      if (
        nextIndex > index + 1 &&
        nextIndex < lines.length &&
        markdownImageOnlyLinePattern.test(lines[nextIndex] ?? "")
      ) {
        // 跳到下一图片行前一行，for 的索引自增正好落在下一图片行，实现整段空行的跳过。
        // 边界：nextIndex 必须小于总行数，否则末尾图片之后紧跟的空白会越界读取。
        index = nextIndex - 1;
      }
      continue;
    }

    normalized.push(line);
  }

  return normalized.join("\n");
}

/**
 * Streamdown 的 harden 会过滤 rehype 自定义属性，因此在 React component mapping
 * 层识别纯图片段落，确保画廊标记和响应式 class 不会被安全层剥离。
 */
// 段落映射层：在 React component mapping 里做画廊识别，是绕开 harden 属性剥离的兜底方案。
// [权衡] 识别放在渲染期而非 rehype 插件期，代价是每次渲染都要遍历子节点，收益是不依赖清洗白名单。
// 破坏后果：若移除该组件，多图段落会退化为逐张 inline 图片，失去响应式画廊布局与组预览能力。
// [并发] 纯函数式渲染、无副作用；children 来自 React 树快照，遍历期间不会变化。
// 非图廊分支必须原样透传 props 与 children，任何属性裁剪都会影响正文段落样式。
export function MarkdownImageParagraph({
  children,
  node: _node,
  ...props
}: ComponentProps<"p"> & { node?: unknown }) {
  // 先剔除纯空白文本节点（markdown 换行会引入只剩空白的字符串），否则图片数量统计永远不达标。
  // [失败路径] Children.toArray 会重新分配 key 但不改变元素顺序，可安全用于 every 判定。
  const meaningfulChildren = Children.toArray(children).filter(
    (child) => typeof child !== "string" || child.trim().length > 0,
  );
  // 画廊判定要求至少两张图且每个子元素都是 img 标签，单图仍走普通段落布局。
  // 依赖 node.tagName 而非 DOM 属性：rehype 阶段的 node 是判断图片来源的唯一可靠信号。
  const isImageGallery =
    meaningfulChildren.length >= 2 &&
    meaningfulChildren.every(
      (child) =>
        isValidElement(child) &&
        (child.props as { node?: { tagName?: string } }).node?.tagName === "img",
    );

  if (isImageGallery) {
    return (
      <ImageThumbnailGallery data-markdown-image-gallery="">
        {meaningfulChildren}
      </ImageThumbnailGallery>
    );
  }

  return <p {...props}>{children}</p>;
}

function formatMediaPreviewDataUrl(preview: FileMediaPreview): string {
  return `data:${preview.mediaType};base64,${preview.dataBase64}`;
}

// 从点击的按钮反向收集同组预览项，保持画廊内顺序与图片一致，供预览弹窗左右切换。
// [失败路径] 找不到 img 或 src 为空时返回空数组，调用方退回默认索引 0，不会抛错。
// [资源] 每次点击都做一次 DOM 查询，属于事件期一次性开销，刻意不缓存以免读到过期的 src。
function readPreviewGroup(target: HTMLButtonElement): ImagePreviewDialogItem[] {
  const gallery = target.closest("[data-markdown-image-gallery]");
  const buttons = gallery
    ? Array.from(gallery.querySelectorAll<HTMLButtonElement>("[data-markdown-image-trigger]"))
    : [target];
  return buttons.flatMap((button) => {
    const image = button.querySelector<HTMLImageElement>("img[data-markdown-image]");
    return image?.src ? [{ alt: image.alt, filename: image.alt, src: image.src }] : [];
  });
}

// 组件主体：三个来源解析、两类失败占位、一层预览弹窗；所有异步都在 effect 内受 disposed 保护。
// [并发] 同一节点 src 变化会触发新 effect，旧请求不会被取消网络，但结果会被 disposed 丢弃。
// 渲染分支顺序固定：空 src → 来源解析中或失败 → 浏览器加载失败 → 正常缩略图，顺序改变会闪错占位。
export function MarkdownImage({
  alt,
  className,
  node: _node,
  onError,
  onLoad,
  readAttachment,
  sessionId,
  src,
  workspacePath,
  workspaceHomePath,
  ...props
}: MarkdownImageProps) {
  const { intl } = useZCodeIntl();
  const services = useOptionalServices();
  // src 可能来自 markdown 的任意属性类型，统一收敛为字符串，避免下游反复判空。
  // 空字符串是未提供图片的哨兵值，与 undefined 行为等价，由下方提前返回分支处理。
  const resolvedSrc = typeof src === "string" ? src : "";
  // artifact 来源由 @zcode/shared 的协议前缀解码，返回 ref 或 null；解码失败按普通 URL 处理。
  // [失败路径] useMemo 让解码结果在 resolvedSrc 不变时保持引用稳定，否则 effect 依赖抖动会无限读取附件。
  // 破坏后果：若改为每次渲染直接调用解码函数，依赖数组每轮都变，效应会持续重跑并覆盖用户已看到的图。
  const artifactRef = useMemo(() => decodeMarkdownArtifactImageSource(resolvedSrc), [resolvedSrc]);
  // 本地链接解析：只有落在工作区或家目录内、且扩展名属于可预览图片时才接管渲染。
  // 非图片路径返回 null，继续交给浏览器按普通 URL 加载，保持对其他 markdown 链接行为的兼容。
  const localImageLink = useMemo(() => {
    const fileLink = resolveMarkdownFileLink(workspacePath, resolvedSrc, {
      homePath: workspaceHomePath,
    });
    return fileLink && isImagePreviewPath(fileLink.path) ? fileLink : null;
  }, [resolvedSrc, workspaceHomePath, workspacePath]);
  // 状态按来源拆成四组：本地数据与失败、artifact 地址与失败，互不覆盖，便于分别定位故障。
  // [权衡] 未合并为单一状态机是为了让两个 effect 独立收敛，代价是渲染前需要组合判断。
  // 失败标记与数据分离，保证先失败后重试时 UI 能立即从错误占位回到加载态。
  const [localImageDataUrl, setLocalImageDataUrl] = useState<string | null>(null);
  const [localImageFailed, setLocalImageFailed] = useState(false);
  const [artifactImageUrl, setArtifactImageUrl] = useState<string | null>(null);
  const [artifactImageFailed, setArtifactImageFailed] = useState(false);
  const [previewItems, setPreviewItems] = useState<ImagePreviewDialogItem[]>([]);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [browserImageState, setBrowserImageState] = useState<{
    source: string;
    status: "loading" | "loaded" | "error";
  }>({ source: "", status: "loading" });
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const focusTimerRef = useRef<number | null>(null);

  // [并发] 本地预览 effect：依赖变化先重置状态再发起读取，disposed 保证卸载后不回写。
  // 依赖 localImageLink 是 useMemo 结果，其稳定性由上游依赖保证，否则会重复读盘。
  // 缺少 services（测试或纯展示环境）时直接跳过，不进入加载态，避免永久骨架屏。
  useEffect(() => {
    setLocalImageDataUrl(null);
    setLocalImageFailed(false);
    if (!localImageLink || !services) return;

    // 闭包内的 disposed 与清理函数配对，是 INV-06 的实现；Promise 本身无法取消，只能丢弃结果。
    // [失败路径] catch 内同样要先判 disposed，否则卸载后仍会 setState 并写错误日志。
    let disposed = false;
    services.fileService
      .readMediaPreview({ path: localImageLink.path })
      .then((preview) => {
        if (!disposed) setLocalImageDataUrl(formatMediaPreviewDataUrl(preview));
      })
      // [失败路径] 读取失败只置 failed 并记录路径与错误消息，不抛出，避免单个坏图中断整条消息渲染。
      // 日志不含文件内容，仅路径与消息，符合敏感信息最小化要求。
      .catch((error) => {
        if (disposed) return;
        setLocalImageFailed(true);
        logger.warn("[MarkdownImage] markdown 本地图片预览失败", {
          path: localImageLink.path,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      disposed = true;
    };
  }, [localImageLink, services]);

  // [资源] 卸载清理：焦点恢复定时器是这里唯一的跨渲染资源，必须在组件销毁时取消。
  // 若不取消，定时器回调会 focus 已脱离文档的按钮，键盘焦点丢失且测试环境出现 act 警告。
  // 该 effect 依赖为空，只在挂载与卸载时各执行一次，不参与每次渲染的清理链。
  useEffect(
    () => () => {
      // 关闭预览后的异步焦点恢复可能晚于消息节点卸载，
      // 必须取消旧任务，避免焦点落到已脱离文档的图片按钮。
      if (focusTimerRef.current !== null) {
        window.clearTimeout(focusTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    // [资源] artifact effect：先清空旧 URL 与失败标记，再按 sessionId 与 readAttachment 是否齐备决定后续。
    // objectUrl 声明在 effect 作用域内，清理函数闭包捕获的是本次请求创建的地址，不会误撤销他人的。
    // [事务] 读取成功才写入状态；失败时保持 null 并置 failed，渲染层据此显示不可用占位。
    setArtifactImageUrl(null);
    setArtifactImageFailed(false);
    if (!artifactRef) return;
    if (!sessionId || !readAttachment) {
      setArtifactImageFailed(true);
      return;
    }

    // 第二个 disposed 属于 artifact 请求，与本地读取互不影响，两个 effect 可同时进行。
    // [失败路径] 组件卸载时 disposed 置真，迟到的 resolve 会被直接丢弃，不会创建 Blob。
    let disposed = false;
    let objectUrl: string | null = null;
    readAttachment({ sessionId, ref: artifactRef })
      .then((result) => {
        if (disposed) return;
        if ("url" in result) {
          setArtifactImageUrl(result.url);
          return;
        }
        // [资源] 字节结果转 Blob URL；Uint8Array.from 复制一份，防止底层 buffer 被复用后内容被改写。
        // mediaType 原样透传，浏览器据此选择解码器；类型错误会在图片加载阶段走 onError 而不是这里。
        objectUrl = URL.createObjectURL(
          new Blob([Uint8Array.from(result.bytes)], { type: result.mediaType }),
        );
        setArtifactImageUrl(objectUrl);
      })
      .catch((error) => {
        if (disposed) return;
        setArtifactImageFailed(true);
        logger.warn("[MarkdownImage] assistant artifact 图片预览失败", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifactRef, readAttachment, sessionId]);

  // [权衡] 来源优先级 artifact 高于本地、本地高于原始 src，是 INV-02 的守卫点，顺序即语义。
  // 三种来源都可能为空：artifact 与本地在解析中返回 null，因此下方必须再判一次空。
  // 原始 src 永远非空（前面已保证），所以远程图片不经过任何占位分支。
  const displaySrc = artifactRef
    ? artifactImageUrl
    : localImageLink
      ? localImageDataUrl
      : resolvedSrc;
  if (!resolvedSrc) return null;
  // [失败路径] 需要异步解析但尚未拿到数据时渲染占位：失败显示图标，进行中显示加载文案。
  // role 随状态在 img 与 status 间切换，保证屏幕阅读器在失败与加载时读出不同语义。
  // 占位尺寸与缩略图一致，避免数据到达后布局跳动。
  if ((artifactRef || localImageLink) && !displaySrc) {
    const failed = artifactRef ? artifactImageFailed : localImageFailed;
    return (
      <div
        aria-label={failed ? intl.formatMessage({ id: "codeViewer.imageUnavailable" }) : undefined}
        className={cn(
          "flex min-h-32 w-full items-center justify-center rounded-xl border border-border bg-surface px-3 py-2 text-center text-ui-base text-foreground-subtle md:h-44 md:w-56 md:shrink-0",
          className,
        )}
        data-markdown-local-image={failed ? "error" : "loading"}
        role={failed ? "img" : "status"}
        title={localImageLink?.path}
      >
        {failed ? (
          <ImageOffIcon aria-hidden="true" className="size-6" />
        ) : (
          intl.formatMessage({ id: "common.loading" })
        )}
      </div>
    );
  }
  // [并发] 状态归属校验：只有记录的 source 与当前 displaySrc 相同才采信，否则一律视为加载中。
  // 这是 INV-07 的守卫点；缺少该比较会让上一张图的 error 直接隐藏本可加载的新图片。
  const effectiveImageStatus =
    browserImageState.source === displaySrc ? browserImageState.status : "loading";
  if (effectiveImageStatus === "error") {
    return (
      <div
        aria-label={intl.formatMessage({ id: "codeViewer.imageUnavailable" })}
        className={cn(
          "flex min-h-32 w-full items-center justify-center rounded-xl border border-border bg-surface px-3 py-2 text-center text-ui-base text-foreground-subtle md:h-44 md:w-56 md:shrink-0",
          className,
        )}
        data-markdown-image-state="error"
        role="img"
        title={localImageLink?.path}
      >
        <ImageOffIcon aria-hidden="true" className="size-6" />
      </div>
    );
  }

  const openPreview = (event: MouseEvent<HTMLButtonElement>) => {
    const items = readPreviewGroup(event.currentTarget);
    setPreviewItems(items);
    setPreviewIndex(
      Math.max(
        0,
        items.findIndex((item) => item.src === displaySrc),
      ),
    );
    setPreviewOpen(true);
  };
  const imageAlt = alt || intl.formatMessage({ id: "chat.attachments.preview.title" });
  // 开关回调只在关闭时走焦点恢复；打开时仅调用 `setPreviewOpen` 开关，不附加副作用。
  // [资源] 恢复前先清旧定时器，连续开关只保留最后一次，避免多次 focus 互相抢焦点。
  const handlePreviewOpenChange = (open: boolean) => {
    setPreviewOpen(open);
    if (!open) {
      // Dialog 关闭后手动将焦点归还图片触发按钮，避免焦点落到 body，
      // 让键盘用户能够从原图继续浏览消息。
      if (focusTimerRef.current !== null) {
        window.clearTimeout(focusTimerRef.current);
      }
      focusTimerRef.current = window.setTimeout(() => {
        previewTriggerRef.current?.focus();
        focusTimerRef.current = null;
      }, 0);
    }
  };

  return (
    <>
      <button
        ref={previewTriggerRef}
        type="button"
        aria-label={intl.formatMessage({ id: "chat.attachments.preview.open" })}
        className={cn(
          imageThumbnailTriggerClassName,
          effectiveImageStatus === "loading" &&
            // 画廊父级的响应式 w-auto/h-44 选择器优先级高于普通尺寸类，
            // 加载态内部又是绝对定位，导致按钮宽度塌缩；仅在加载期间强制固定方形。
            "relative !h-44 !w-44 !max-w-full cursor-default",
        )}
        data-image-thumbnail-trigger=""
        data-markdown-image-trigger=""
        onClick={openPreview}
        title={localImageLink?.path}
      >
        {effectiveImageStatus === "loading" ? (
          <span
            aria-label={intl.formatMessage({ id: "common.loading" })}
            className="markdown-image-loading-shimmer absolute inset-0 flex size-full items-center justify-center text-foreground-subtle"
            data-markdown-image-state="loading"
            role="status"
          >
            <ImageIcon aria-hidden="true" className="size-6" />
          </span>
        ) : null}
        <img
          // React 复用同一 img 时，旧资源的异步事件可能命中新 src 的处理器。
          // 按资源重建节点，确保 load/error 只更新触发该事件的图片状态。
          key={displaySrc}
          alt={imageAlt}
          className={cn(
            imageThumbnailClassName,
            effectiveImageStatus === "loading" && "invisible",
            className,
          )}
          data-markdown-image=""
          data-streamdown="image"
          draggable={false}
          loading="lazy"
          // [失败路径] 加载失败写入带 source 的错误状态并记录脱敏后的地址，再透传外部 onError。
          // 不透传会破坏调用方的埋点；不脱敏则会把 data URL 或查询参数写进日志。
          onError={(event) => {
            // 远程 Markdown 图片不能直接交给浏览器渲染：加载失败时既没有状态，
            // 也没有运行时轨迹，用户只能看到空白区域。
            setBrowserImageState({ source: displaySrc ?? "", status: "error" });
            logger.warn("[MarkdownImage] markdown 图片加载失败", {
              source: sanitizeImageSourceForLog(displaySrc ?? ""),
            });
            onError?.(event);
          }}
          onLoad={(event) => {
            setBrowserImageState({ source: displaySrc ?? "", status: "loaded" });
            onLoad?.(event);
          }}
          src={displaySrc ?? undefined}
          {...props}
        />
      </button>
      <ImagePreviewDialog
        initialIndex={previewIndex}
        items={previewItems}
        onOpenChange={handlePreviewOpenChange}
        open={previewOpen}
      />
    </>
  );
}
