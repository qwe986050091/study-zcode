/**
 * Swift bridge placeholder.
 * To be implemented when Swift integration is needed.
 *
 * 中文口径：本模块是 macOS 上 Swift 集成的占位实现，对外只暴露「是否可用」和
 * 「探测版本」两个能力，当前一律返回未可用。
 * 副作用：无，不做任何子进程调用或文件探测。
 * 失败语义：不抛错；不可用时返回 false / null，调用方必须据此关闭 Swift 相关能力，
 * 不能假设返回值为真。
 * 边界：真正接入时必须补齐平台判定、`swift --version` 探测与错误处理。
 */

/**
 * 判断当前环境是否具备 Swift 集成能力。
 *
 * 目前仅在非占位前提下才会返回 true，因此实际恒为 false；
 * 调用方据此跳过所有依赖 Swift 的分支。
 */
export const isSwiftAvailable = (): boolean => {
  // 非 darwin 平台不存在 Swift 工具链，直接短路避免任何平台相关的副作用。
  if (process.platform !== "darwin") {
    return false;
  }
  // TODO: Check for Swift availability
  return false;
};

/**
 * 探测 Swift 版本号。
 *
 * 输出：可用的版本字符串，或 null 表示不可用/探测失败。
 * 失败语义：不可用时静默返回 null，因为版本探测是可选能力，不应阻断主流程。
 */
export const detectSwiftVersion = async (): Promise<string | null> => {
  // 先复用可用性判断：平台不支持时无需启动子进程，也避免在 Windows/Linux 上误报。
  if (!isSwiftAvailable()) {
    return null;
  }
  // TODO: Run `swift --version` and parse output
  return null;
};
