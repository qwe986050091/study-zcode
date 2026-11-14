// ZCode 图片预览面板：位图与 SVG 渲染，外带复制、下载、加入对话三项动作。
// 依赖 React 函数组件、Radix 上下文菜单与下拉菜单、平台 saveFile 适配层。
// 不变量清单（INV 编号对应实现处的守护点；改动前先读失败模式）：
// INV-01 剪贴板能力三要素缺一即失败，守护点在 copyPreviewImage 的能力联合判断。
// INV-02 复制前图片必须已解码，守护点为 complete 与自然宽高正数校验。
// INV-03 PNG 使用自然像素尺寸绘制，守护点为 canvas 宽高取自 naturalWidth。
// INV-04 Safari 用户激活在 await 后失效，守护点是同步发起 clipboard 写调用。
// INV-05 尺寸缓存必须与当前 imageSource 同源，守护点为 canUseImage 的 source 比较。
// INV-06 同一时刻只允许一个动作在途，守护点为 canUseImage 对 actionPending 取反。
// INV-07 同步闸门 actionPendingRef 与渲染态 actionPending 必须成对维护。
// INV-08 任何抛出路径都要在 finally 复位闸门，否则按钮永久禁用。
// INV-09 下载源优先取 loadDownloadSource 异步结果，缺失才退回 imageSource。
// INV-10 下载文件名优先取 sourcePath 末段，缺失时退回标题。
// INV-11 下载结果按 saved 与 started 两种 kind 分支提示，其余 kind 静默。
// INV-12 加入对话要求 fileReference 存在，缺失时按钮必须禁用。
// INV-13 加入对话为同步派发，返回值决定成功或失败文案。
// INV-14 像素倍率只从文件名解析，解析失败一律归一到 1。
// INV-15 倍率仅在非自适应、倍率大于 1 且尺寸同源时生效。
// INV-16 显示尺寸等于自然像素除以倍率，保证 Retina 素材按逻辑尺寸呈现。
// INV-17 图片解码失败必须清空 naturalSize，令动作按钮回到禁用态。
// INV-18 键盘菜单键需手动合成 contextmenu，坐标取容器中心。
// INV-19 移动端下拉菜单与桌面右键菜单共享同一组 data-image-preview 标记。
// INV-20 SVG 以 encodeURIComponent 内联 data URL，并强制自适应显示。
// 本文件是纯展示层：不得在此读写磁盘、拼接后端地址或调用平台私有能力。
// 所有用户可见文案走 intl 文案 id，禁止硬编码字符串，保持多语言一致。
//
import type { CSSProperties, SyntheticEvent } from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import { Copy, Download, Ellipsis, MessageSquarePlus } from "lucide-react";
import { downloadImagePreview } from "@/components/ai-elements/image-preview-dialog.js";
import { Button } from "@/components/ui/button.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { toast } from "@/components/ui/toast.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  dispatchWorkspaceFileAddToChat,
  type WorkspaceFileDragPayload,
} from "@/lib/workspaceFileDrag.js";
import { getPathLeaf } from "@/lib/path.js";
import { logger } from "@/logger.js";

interface ImagePreviewContentProps {
  title: string;
  imageSource: string;
  fitToContainer?: boolean;
  sourcePath?: string;
  fileReference?: WorkspaceFileDragPayload;
  loadDownloadSource?: () => Promise<string>;
}

interface ImageNaturalSize {
  source: string;
  width: number;
  height: number;
}

const IMAGE_PREVIEW_CHECKERBOARD_CLASS =
  "[background-color:var(--color-background)] [background-image:linear-gradient(45deg,var(--color-surface)_25%,transparent_25%),linear-gradient(-45deg,var(--color-surface)_25%,transparent_25%),linear-gradient(45deg,transparent_75%,var(--color-surface)_75%),linear-gradient(-45deg,transparent_75%,var(--color-surface)_75%)] [background-position:0_0,0_4px,4px_-4px,-4px_0] [background-size:8px_8px]";

// [失败路径] 先把反斜杠统一成斜杠再取末段，兼容 Windows 路径与纯文件名两类入参
// [边界] 只匹配文件名末端的 @Nx 或 @N.Mx，目录名里的同名片段不参与判定
// [权衡] 不读取图片元数据，纯靠命名约定推断倍率，避免额外解码与异步等待
// [失败路径] 匹配不到、非有限数、非正数三种情况统一回落为 1，杜绝下游除零
//
export function getImagePreviewPixelRatio(sourceName: string): number {
  const fileName = sourceName.replace(/\\/g, "/").split("/").at(-1) ?? "";
  const match = /@(\d+(?:\.\d+)?)x(?=(?:\.[^./\\]+)?$)/i.exec(fileName);
  const ratio = match ? Number(match[1]) : 1;

  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

// [并发] 函数无内部可变状态，多次并发调用互不影响，也不会共享同一块 canvas
// [资源] canvas 与 blob 都是脱离 DOM 的临时对象，随引用释放被回收
// [失败路径] 全部以 rejected Promise 上报，调用方只需捕获异常，无需判空返回
// [权衡] 直接绘制已解码元素而非引入第三方截图库，保持零依赖与体积可控
//
export function copyPreviewImage(image: HTMLImageElement): Promise<void> {
  if (
    typeof navigator === "undefined" ||
    !navigator.clipboard?.write ||
    typeof ClipboardItem === "undefined"
  ) {
    return Promise.reject(new Error("Image clipboard is unavailable"));
  }
  if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    return Promise.reject(new Error("Preview image is not loaded"));
  }

  // [事务] 先构造 Blob 的 Promise 再交给剪贴板，转换失败时由 reject 阻断写入
  // [边界] 2d 上下文获取失败立刻 reject，避免对空上下文继续绘制
  // [资源] 绘制使用自然尺寸，不叠加 CSS 缩放，避免写出模糊或带棋盘底的图片
  // [失败路径] toBlob 回调收到空值表示编码失败，需与成功但体积为零区分
  //
  // 剪贴板通常只接受 PNG；使用已加载图片的自然尺寸，保留透明度且不复制预览棋盘背景。
  const png = new Promise<Blob>((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      reject(new Error("Image canvas is unavailable"));
      return;
    }
    context.drawImage(image, 0, 0);
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed"))),
      "image/png",
    );
  });
  // Safari 在异步转换后可能丢失用户激活，必须在点击调用栈内提交带 Promise 的 ClipboardItem。
  // [并发] 剪贴板写入是原子替换，成功覆盖既有内容，失败则保持原内容不变
  // [失败路径] 窗口未获焦点或权限被拒时写入会 reject，上层统一提示复制失败
  //
  return navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

// [资源] imageRef 指向真实图片元素，复制时直接读取其已解码像素，避免二次请求
// [并发] actionPendingRef 用 ref 而非 state，是为了在连续同步点击中立刻生效
// [权衡] 尺寸缓存带 source 字段，用值相等替代引用相等，避免超长 data URL 比较
// [失败路径] 图片换了但尚未触发加载回调时，缓存源不匹配，动作按钮自然降级为禁用
// [边界] fitToContainer 默认关闭，仅 SVG 预览显式开启，避免位图被强行拉伸
//
export function ImagePreviewContent({
  title,
  fitToContainer = false,
  imageSource,
  sourcePath,
  fileReference,
  loadDownloadSource,
}: ImagePreviewContentProps) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const imageRef = useRef<HTMLImageElement>(null);
  const actionPendingRef = useRef(false);
  const [actionPending, setActionPending] = useState(false);
  const [naturalSize, setNaturalSize] = useState<ImageNaturalSize | null>(null);
  const copyLabel = intl.formatMessage({ id: "preview.image.copy" });
  // [并发] 四个条件用逻辑与串联，任一不满足即为假，保证动作入口只有一处判据
  // [事务] 尺寸缓存、当前图片地址、在途标记三者必须同时成立才视为可用
  // [失败路径] 尺寸缓存为空时可选链短路，绝不会抛读取空对象属性
  // [边界] 宽高必须严格大于零，零尺寸占位图与解码失败的图都被排除
  // [权衡] 不做 canvas 探测，只信任加载回调上报的自然尺寸，降低渲染期开销
  //
  const canUseImage =
    !actionPending &&
    naturalSize?.source === imageSource &&
    naturalSize.width > 0 &&
    naturalSize.height > 0;
  // [并发] 进入即查同步闸门，防止双击或快捷键连发造成重复写剪贴板
  // [事务] 闸门先于 await 置位，保证等待期间后续调用全部被拦下
  // [失败路径] 失败分支只记 warn 并提示，不向上抛出，避免触发渲染错误边界
  // [事务] finally 同时复位闸门与状态，任何异常都不会让界面停在忙碌态
  //
  const handleCopy = useCallback(async () => {
    const image = imageRef.current;
    if (!image || actionPendingRef.current || !canUseImage) return;
    actionPendingRef.current = true;
    setActionPending(true);
    try {
      await copyPreviewImage(image);
      toast(intl.formatMessage({ id: "preview.image.copied" }));
      logger.info("[ImagePreview] 图片已复制");
    } catch (error) {
      logger.warn("[ImagePreview] 复制图片失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "preview.image.copyFailed" }));
    } finally {
      actionPendingRef.current = false;
      setActionPending(false);
    }
  }, [canUseImage, intl]);
  // [并发] 与复制共用同一闸门，复制进行中点击下载会被直接忽略
  // [资源] 下载源可能由异步回调给出更清晰的原始地址，平台保存能力以可选链传入
  // [失败路径] 用户取消保存或磁盘写入失败都会 reject，统一按下载失败提示
  //
  const handleDownload = useCallback(async () => {
    if (actionPendingRef.current || !canUseImage) return;
    actionPendingRef.current = true;
    setActionPending(true);
    try {
      const src = loadDownloadSource ? await loadDownloadSource() : imageSource;
      const result = await downloadImagePreview(
        { alt: title, filename: sourcePath ? getPathLeaf(sourcePath) : title, src },
        platform?.saveFile,
      );
      if (result.kind === "saved") {
        toast(intl.formatMessage({ id: "markdownImage.downloadSucceeded" }));
      } else if (result.kind === "started") {
        toast(intl.formatMessage({ id: "markdownImage.downloadStarted" }));
      }
    } catch (error) {
      logger.warn("[ImagePreview] 下载图片失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "markdownImage.downloadFailed" }));
    } finally {
      actionPendingRef.current = false;
      setActionPending(false);
    }
  }, [canUseImage, imageSource, intl, loadDownloadSource, platform, sourcePath, title]);
  // [事务] 派发为同步调用，返回值直接决定提示文案，不假设一定成功
  // [失败路径] 无拖拽载荷或图片不可用时静默返回，不产生误导性提示
  // [边界] 加入对话与复制下载不同，它消费的是拖拽载荷而非像素数据
  //
  const handleAddToChat = useCallback(() => {
    if (!fileReference || !canUseImage) return;
    const added = dispatchWorkspaceFileAddToChat(fileReference);
    toast(intl.formatMessage({ id: added ? "preview.image.added" : "preview.image.addFailed" }));
  }, [canUseImage, fileReference, intl]);
  // [权衡] 以源路径优先、标题兜底作为命名来源，覆盖有路径与仅标题两种入口
  // [资源] 依赖仅两项字符串，倍率计算廉价但仍用 memo 避免每次渲染重复正则
  //
  const pixelRatio = useMemo(
    () => getImagePreviewPixelRatio(sourcePath ?? title),
    [sourcePath, title],
  );
  // [边界] 自适应模式、倍率不大于 1、尺寸不同源、尺寸非正，四种情况一律不写内联样式
  // [事务] 返回空表示交给类名布局接管，避免内联与类名互相覆盖
  // [失败路径] 尺寸缺失时宁可放大到容器，也不复用上一张图的宽高
  //
  const imageStyle = useMemo<CSSProperties | undefined>(() => {
    if (
      fitToContainer ||
      pixelRatio <= 1 ||
      naturalSize?.source !== imageSource ||
      naturalSize.width <= 0 ||
      naturalSize.height <= 0
    ) {
      return undefined;
    }

    return {
      // Retina 文件名里的 @2x/@3x 表示物理像素倍率，预览时折算为 CSS 像素，避免素材被放大显示。
      height: naturalSize.height / pixelRatio,
      width: naturalSize.width / pixelRatio,
    };
  }, [fitToContainer, imageSource, naturalSize, pixelRatio]);
  // [事务] 记录的是元素自然像素而非渲染尺寸，显示时再按倍率折算
  // [失败路径] 加载失败会清空缓存，故此处无需校验尺寸为正，交给可用性判断兜底
  //
  const handleLoad = useCallback(
    (event: SyntheticEvent<HTMLImageElement>) => {
      const image = event.currentTarget;

      setNaturalSize({
        source: imageSource,
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
    },
    [imageSource],
  );
  // [边界] 自适应模式铺满容器，否则保持原始宽高比且不超过容器，避免溢出裁切
  //
  const imageClassName = fitToContainer
    ? "h-full max-h-full w-full max-w-full object-contain"
    : "h-auto max-h-full w-auto max-w-full object-contain";

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-image-preview
          aria-busy={actionPending || undefined}
          tabIndex={0}
          aria-label={title}
          // [失败路径] 非菜单键直接返回，不做默认行为拦截，保留其他快捷键语义
          // [权衡] 合成事件坐标取容器中心，牺牲精确落点换取菜单必定出现在视口内
          //
          onKeyDown={(event) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            event.preventDefault();
            // Radix 只监听 contextmenu；Chromium/Electron 不会始终为聚焦的 div 派发键盘菜单事件。
            const bounds = event.currentTarget.getBoundingClientRect();
            event.currentTarget.dispatchEvent(
              new MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
                clientX: bounds.left + bounds.width / 2,
                clientY: bounds.top + bounds.height / 2,
              }),
            );
          }}
          className={`relative flex h-full min-h-0 items-center justify-center overflow-hidden p-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${IMAGE_PREVIEW_CHECKERBOARD_CLASS}`}
        >
          <img
            ref={imageRef}
            alt={title}
            className={imageClassName}
            onLoad={handleLoad}
            onError={() => setNaturalSize(null)}
            src={imageSource}
            style={imageStyle}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                className="absolute top-3 right-3 min-h-11 gap-2 bg-menu sm:hidden"
                variant="outline"
                aria-label={intl.formatMessage({ id: "preview.image.actions" })}
              >
                <Ellipsis aria-hidden="true" />
                {intl.formatMessage({ id: "preview.image.actions" })}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                className="min-h-11"
                data-image-preview-add
                disabled={!canUseImage || !fileReference}
                onSelect={handleAddToChat}
              >
                <MessageSquarePlus aria-hidden="true" />
                {intl.formatMessage({ id: "workspaceFileTree.addToChat" })}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="min-h-11"
                data-image-preview-copy
                disabled={!canUseImage}
                onSelect={() => void handleCopy()}
              >
                <Copy aria-hidden="true" />
                {copyLabel}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="min-h-11"
                data-image-preview-download
                disabled={!canUseImage}
                onSelect={() => void handleDownload()}
              >
                <Download aria-hidden="true" />
                {intl.formatMessage({ id: "markdownImage.download" })}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          data-image-preview-add
          disabled={!canUseImage || !fileReference}
          onSelect={handleAddToChat}
        >
          <MessageSquarePlus aria-hidden="true" />
          {intl.formatMessage({ id: "workspaceFileTree.addToChat" })}
        </ContextMenuItem>
        <ContextMenuItem
          data-image-preview-copy
          disabled={!canUseImage}
          onSelect={() => void handleCopy()}
        >
          <Copy aria-hidden="true" />
          {copyLabel}
        </ContextMenuItem>
        <ContextMenuItem
          data-image-preview-download
          disabled={!canUseImage}
          onSelect={() => void handleDownload()}
        >
          <Download aria-hidden="true" />
          {intl.formatMessage({ id: "markdownImage.download" })}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// [边界] SVG 预览复用位图实现，仅把内容编码成 data URL 并强制自适应
// [失败路径] 非法 SVG 会在图片解码阶段失败，走同一套错误降级链路
//
export function SvgPreviewContent({
  title,
  svgContent,
  fileReference,
  sourcePath,
  loadDownloadSource,
}: {
  title: string;
  svgContent: string;
  fileReference?: WorkspaceFileDragPayload;
  sourcePath?: string;
  loadDownloadSource?: () => Promise<string>;
}) {
  return (
    <ImagePreviewContent
      fitToContainer
      title={title}
      fileReference={fileReference}
      sourcePath={sourcePath}
      loadDownloadSource={loadDownloadSource}
      // [事务] 用 encodeURIComponent 编码，避免 SVG 内的井号与引号截断 data URL
      //
      imageSource={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgContent)}`}
    />
  );
}
