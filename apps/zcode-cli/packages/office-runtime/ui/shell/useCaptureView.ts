// capture_view 页面工具的注册与实现：把当前文档的指定位置或可视区域栅格化为 PNG 返回给模型。
// 边界：通过 ref 读取最新文档与查看器句柄，不持有业务状态；路径与锚点校验在此完成，渲染细节委托查看器。
// 副作用：只读 DOM 与样式表并生成离屏图像，不改文档/面板状态；工具声明为只读且幂等。
import { useEffect, type RefObject } from "react";
import { formatAnchor, splitAnchor } from "#office/domain/anchor.ts";
import { PROFILE } from "#office/profile.ts";
import { getHost } from "#ui/host.ts";
import type { LoadedDoc } from "#ui/shell/state.ts";
import type { ViewerHandle } from "#ui/viewers/types.ts";

// 捕获语义：把当前面板文档的某处（或可视区域）栅格化为 PNG，作为图片内容回给模型，
// 让模型看到文字提取拿不到的版式、图表与图片。
// 输入：anchor 可选（带路径前缀时必须与当前文档一致），maxWidth 夹在 [320, 2000]、缺省 1600。
// 失败一律抛错：面板无文档、路径不匹配、锚点找不到、尚未渲染完成，都会变成模型的 isError 文本。
// 副作用：只读 DOM 并截一张图，不改文档与面板状态（工具声明为只读/幂等）。
/**
 * 页面工具 capture_view：Agent 截取面板当前文档的某处画面。
 * 从 main.tsx 的 Shell 拆出以控制单文件规模，行为不变；只在挂载时注册一次，通过 ref 读取最新文档与查看器。
 */
export function useCaptureView(
  docRef: RefObject<LoadedDoc | null>,
  viewer: RefObject<ViewerHandle | null>,
) {
  useEffect(() => {
    const host = getHost();
    host.handleTool("capture_view", async (args) => {
      const current = docRef.current;
      // 无文档或无查看器句柄时明确失败，而不是截一张空图让模型误判。
      if (!current || !viewer.current)
        throw new Error(
          `No document is open in the ${PROFILE.title.en} panel. Call open_document first.`,
        );
      let at: string | null = null;
      // 带路径的锚点必须指向当前面板文档，否则会让模型误以为截了别的文件；
      // 去掉可能的 "./" 前缀后再比较，兼容调用方写法差异。
      if (typeof args.anchor === "string" && args.anchor.trim()) {
        const split = splitAnchor(args.anchor);
        if (split.path.replace(/^\.\//, "") !== current.info.path)
          throw new Error(
            `The panel shows ${current.info.path}, not ${split.path}. Call open_document with that path first.`,
          );
        at = split.at;
      }
      // 宽度夹取在此处兜底（模型可能给出界外值），默认 1600 与工具描述保持一致。
      const maxWidth =
        typeof args.maxWidth === "number" ? Math.min(2000, Math.max(320, args.maxWidth)) : 1600;
      const shot = await viewer.current.capture(at, maxWidth);
      return {
        content: [
          { type: "image", data: shot.data, mimeType: "image/png" },
          {
            type: "text",
            text: `Captured ${formatAnchor(current.info.path, shot.at)} (${shot.width}×${shot.height} px).`,
          },
        ],
      };
    });
  }, [docRef, viewer]);
}
