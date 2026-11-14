import type { ModelMessageContentBlock } from "../deps.js";
import { containsOfficialCuaImageRefCredentialText } from "@zcode/zcode-cua/frame-contract";

/**
 * 官方 CUA 栅格图在当前请求中不可见时，用来替换该图片块的提示文本。
 *
 * 选择"替换为提示"而不是"直接省略"：模型看不到截图却继续发送坐标点击时，会点到
 * 错误位置；提示语明确要求先重新截图，属于 fail closed 的安全降级。
 */
export const OFFICIAL_CUA_RASTER_UNAVAILABLE_TEXT =
  "This CUA raster is not visible in this request. " +
  "Do not send a coordinate target; capture a new raster first.";

/**
 * 找出与"被剔除的图片块"紧邻配对的 image_ref 文本块下标。
 *
 * 官方 CUA 的 image 与紧随其后的 image_ref 文本是原子对：图片一旦不可见，
 * 该文本里的 ref 也已失效，必须一起替换，否则模型会拿旧 ref 去发坐标。
 *
 * 输入：content 是单条消息的块数组；unavailableMediaIndexes 是被剔除的媒体块下标。
 * 判定规则：仅当 unavailableMediaIndexes 中的下标对应 image，且下一个块是 text、
 * 其内容被 containsOfficialCuaImageRefCredentialText 识别时，才把 i+1 计入。
 * 输出：需要一并置空的文本块下标集合；未命中返回空集合。
 * 失败语义：不做任何写入、不抛错；占位包实现下 contains... 恒为 false，即
 * 在缺少官方 CUA 能力时自然 fail closed（不会误判、也不会误删普通文本）。
 * 纯函数，无副作用。
 */
export function officialCuaImageRefIndexesForUnavailableMedia(
  content: readonly ModelMessageContentBlock[],
  unavailableMediaIndexes: ReadonlySet<number>,
): Set<number> {
  const imageRefIndexes = new Set<number>();
  for (const mediaIndex of unavailableMediaIndexes) {
    if (content[mediaIndex]?.type !== "image") continue;
    const candidate = content[mediaIndex + 1];
    if (
      candidate?.type === "text" &&
      containsOfficialCuaImageRefCredentialText(candidate.text)
    ) {
      imageRefIndexes.add(mediaIndex + 1);
    }
  }
  return imageRefIndexes;
}

/**
 * 构造官方 CUA 栅格不可用时的占位文本块。
 *
 * 与 unavailability 文本常量一一对应，供媒体预算/能力投影在替换图片块时使用；
 * 返回新块对象，不依赖原块的 mediaType/dataUrl。纯函数，无副作用。
 */
export function officialCuaRasterUnavailableBlock(): ModelMessageContentBlock {
  return { type: "text", text: OFFICIAL_CUA_RASTER_UNAVAILABLE_TEXT };
}
