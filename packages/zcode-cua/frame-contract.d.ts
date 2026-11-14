/**
 * CUA 帧契约的 API 形状。
 *
 * 注意:当前仓库里的实现是 API-compatible placeholder(package.json 的
 * zcodeCuaPlaceholder=true),运行时全部 fail closed:布尔判定恒 false、
 * 解析/attestation 恒 undefined、preserve 原样返回。
 * 真实 CUA 构建替换本包时必须保持这里的导出名/常量值/签名不变——
 * @zcode/core 的序列化与 attestation 分支是按该形状编写的。
 */
export const OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY: string;
export const OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION: string;
export const OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES: number;

export declare function isOfficialCuaImageRefText(text: string): boolean;
export declare function containsOfficialCuaImageRefCredentialText(text: string): boolean;
export declare function containsImageRefAuthority(text: string): boolean;
export declare function parseOfficialCuaImageRef(text: string): { authority: string } | undefined;
export declare function readRasterEnvelopeIdentity(
  input: unknown,
): { algorithm: string } | undefined;
export declare function preserveOfficialCuaFrameResult<
  T extends { content?: unknown; isError?: boolean },
>(result: T, options?: unknown): Promise<T>;
export interface OfficialCuaFrameAttestation {
  kind: string;
}
export declare function attestOfficialCuaFrameContent(
  content: unknown,
  expectedKind?: string,
): OfficialCuaFrameAttestation | undefined;
export interface OfficialCuaFrameContentPair {
  image: any;
  imageRef: any;
  imageRefIndex: number;
  imageIndex: number;
}
export declare function findOfficialCuaFrameContentPair(
  content: unknown,
): OfficialCuaFrameContentPair | undefined;
