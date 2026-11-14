/**
 * ============================================================================
 * zcode-cua/frame-contract.js —— CUA 帧契约的"占位实现"(fail closed)
 * ============================================================================
 *
 * ⚠ 本包是 API-compatible placeholder(package.json 的 zcodeCuaPlaceholder=true):
 *   此构建不包含 Computer Use,所有运行时能力都应报告"unavailable"并 fail closed。
 *   因此本文件的函数不是"帧契约的完整实现",而是**空实现**:
 *     布尔判定恒 false、解析恒 undefined、attestation 恒 undefined、
 *     preserve 原样返回。
 *
 * 【调用方(见 @zcode/core)如何依赖这些符号】
 *   - result-serialization 只在 entry.modelContentProtection 等于
 *     OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION 且结果含 image 块时调用
 *     find/attest;占位实现返回 undefined 会让 core 走通用 resultBudget 或被
 *     "最终 attestation 缺失"的 fail-closed 分支拦住。
 *   - hook-flow / result-serialization 用 containsOfficialCuaImageRefCredentialText
 *     过滤 hook 上下文里的帧凭证;占位实现恒 false,即"没有可识别的凭证"。
 *   - 常量是契约的一部分(meta key / protection 标记 / 单帧内联 base64 上限),
 *     真实实现必须保持同名同值,core 侧才能按这些值做分支。
 *
 * 【替换约束】CUA-enabled 构建替换本文件时,必须保持导出名、常量值、
 *   参数/返回形状与 frame-contract.d.ts 完全一致;任何"更宽松"的实现都会
 *   破坏 core 里以 fail-closed 为前提的序列化/attestation 分支。
 * ============================================================================
 */

// 帧完整性元数据的稳定 key:真实实现把 attestation 写在这个 _meta 键下,
// core/display 侧按同一个键读取。
export const OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY = "zcode.cua/official-frame-integrity-v1";

// 内容保护模式标记:entry.modelContentProtection 命中该值时,
// core 才会启用"image + image_ref 原子对"投影与最终 attestation 校验。
export const OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION = "official_cua_frame_v1";

// 单帧内联 base64 的字节上限(与 core 侧 200 KiB 的 bridge 上限一致);
// 超过该值的栅格不应以内联形态进入 display/请求。
export const OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES = 200 * 1024;

// 占位:真实实现应判断文本是否是合法 image_ref。恒 false = "识别不到任何 image_ref"。
export function isOfficialCuaImageRefText(_text) {
  return false;
}

// 占位:真实实现应判断文本是否包含 image_ref 凭证(用于防止 hook 回显凭证)。
// 恒 false 表示占位构建没有可泄漏的凭证,因此不需要过滤。
export function containsOfficialCuaImageRefCredentialText(_text) {
  return false;
}

// 占位:真实实现应判断文本是否携带 image_ref 的 authority 片段。恒 false。
export function containsImageRefAuthority(_text) {
  return false;
}

// 占位:真实实现应从 image_ref 文本解析出 authority;解析不到返回 undefined。
// 占位恒 undefined → core 不会认为存在合法引用。
export function parseOfficialCuaImageRef(_text) {
  return undefined;
}

// 占位:真实实现应从 CUA 栅格信封里读出完整性身份(如哈希算法)。
// 恒 undefined 表示"无法证明这帧来自官方 producer"。
export function readRasterEnvelopeIdentity(_input) {
  return undefined;
}

// 占位:真实实现应在返回结果前固化帧(image/image_ref 顺序、预算、attestation)。
// 占位原样返回:不承诺任何帧保护,由 core 的通用 resultBudget 接管。
export async function preserveOfficialCuaFrameResult(result) {
  return result;
}

// 占位:真实实现应对最终模型内容生成 attestation(kind 等)。
// 恒 undefined 会让 core 的"声明了保护但拿不到 attestation"分支 fail closed。
export function attestOfficialCuaFrameContent(_content, _expectedKind) {
  return undefined;
}

// 占位:真实实现应找出 image + image_ref 的原子对及其下标,
// 供 core 校验"前两块必须是帧对"并保序投影。恒 undefined = 没有可识别的帧对。
export function findOfficialCuaFrameContentPair(_content) {
  return undefined;
}
