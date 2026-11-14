// ============================================================
// OpenCode Go 端点识别
// 定位：极端边缘的 baseURL 判定，用于决定是否走 OpenCode 专属的会话/请求装配路径。
// 输入：可能为 undefined 的 baseURL（未配置即 undefined）。输出：布尔值，永不抛错。
// 副作用：无（不解析凭据、不发请求）。失败语义：URL 非法或无法解析时保守返回 false。
// 不变量：必须同时满足"根域或子域 + 精确 /zen/go/v1 路径"，避免把普通 opencode.ai 域名误判。
// ============================================================

const OPENCODE_ROOT_DOMAIN = "opencode.ai";
const OPENCODE_GO_PATH = "/zen/go/v1";

/**
 * 判定 baseURL 是否指向 OpenCode Go 网关。
 * 空串/undefined/非法 URL 一律 false（配置缺失不等于命中）；hostname 与 path 均按大小写统一比较，
 * 尾部斜杠先剥除，使 `.../zen/go/v1/` 与 `.../zen/go/v1` 等价。
 */
export function isOpenCodeGoBaseUrl(baseURL: string | undefined): boolean {
  const trimmed = baseURL?.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed);
    const hostname = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/u, "").toLowerCase();
    return (
      (hostname === OPENCODE_ROOT_DOMAIN || hostname.endsWith(`.${OPENCODE_ROOT_DOMAIN}`)) &&
      path === OPENCODE_GO_PATH
    );
  } catch {
    return false;
  }
}
