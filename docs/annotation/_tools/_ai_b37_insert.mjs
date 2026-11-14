// B37 insert: oauth.ts + oauth-types.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/mcp/src/tool/';
const files = [
  {
    name: 'oauth.ts',
    want: [220, 228],
    blocks: [
      { at: 1, expect: "import pkceChallenge from 'pkce-challenge';", lines: [
        '// ============================================================================',
        '// oauth：MCP 的 OAuth 2.1 授权流程实现',
        '// 覆盖受保护资源元数据发现、授权服务器发现、PKCE 授权、令牌交换/刷新与动态注册。',
        '// 所有外部 URL 在使用前都会经过同源校验与 SSRF 守卫。',
        '// 凭据始终与授权服务器绑定，防止元数据切换导致凭据被复用。',
        '// ============================================================================',
      ] },
      { at: 2, expect: 'import {', lines: [
        '// OAuth 相关的 zod schema 与类型，集中来自 oauth-types。',
        '// 解析响应时统一走这些 schema，避免手写字段校验。',
      ] },
      { at: 16, expect: 'import {', lines: [
        '// OAuth 错误类型：按 RFC 错误码映射到不同子类。',
      ] },
      { at: 25, expect: 'import {', lines: [
        '// 资源 URL 归一化与同源判定工具。',
      ] },
      { at: 31, expect: 'import {', lines: [
        '// 受控 URL 抓取原语：限制重定向、校验目标并解析 JSON。',
      ] },
      { at: 38, expect: "export type AuthResult = 'AUTHORIZED' | 'REDIRECT';", lines: [
        '// 授权流程结果：已完成（有可用令牌）或需要重定向用户去授权。',
        '// 调用方据此决定是继续请求 MCP 服务还是返回授权地址。',
        '// REDIRECT 时调用方应把授权 URL 交给用户。',
      ] },
      { at: 40, expect: 'export interface OAuthAuthorizationServerInformation {', lines: [
        '// 授权服务器的凭据绑定信息。',
        '// issuer 用于校验，URL 与 tokenEndpoint 用于后续请求。',
        '// 该结构会被持久化到令牌与客户端信息中。',
      ] },
      { at: 46, expect: 'export interface OAuthClientProvider {', lines: [
        '// 调用方实现的 OAuth 状态提供者。',
        '// 负责令牌、客户端信息、PKCE verifier、state 与重定向的存取。',
        '// 所有方法都允许同步或异步实现，便于对接不同存储。',
        '// 可选方法用于自定义客户端认证与凭据失效处理。',
      ] },
      { at: 149, expect: 'export class UnauthorizedError extends Error {', lines: [
        '// 表示请求需要授权：调用方应触发 OAuth 流程。',
        '// 单独的类型便于上层区分“未授权”与其他网络错误。',
      ] },
      { at: 156, expect: 'function normalizeUrl(url: string | URL): string {', lines: [
        '// 统一 URL 的序列化形式，便于比较与持久化。',
        '// 输入已保证是 URL 或可解析字符串。',
      ] },
      { at: 161, expect: 'function isOAuthLoopbackHost(hostname: string): boolean {', lines: [
        '// 判断主机名是否属于本机回环地址。',
        '// 允许 localhost、*.localhost、127.0.0.1 与 IPv6 回环。',
        '// 末尾的点会被去掉，避免 localhost. 绕过判断。',
      ] },
      { at: 181, expect: 'function assertSafeOAuthEndpoint(', lines: [
        '// 在请求元数据中的 OAuth 端点前做安全守卫。',
        '// 仅当调用方确认属于本地 OAuth 服务时才放行回环地址。',
        '// 其余目标走共享的 URL 校验，失败转换为 OAuth 错误。',
        '// 携带凭据的 POST 还会强制禁止重定向，防止凭据被转发。',
      ] },
      { at: 185, expect: 'if (', lines: [
        '// 回环放行要求协议为 http(s) 且主机确属本机。',
      ] },
      { at: 193, expect: 'try {', lines: [
        '// 非回环目标交给统一校验，异常统一包装。',
      ] },
      { at: 203, expect: 'function getTrustedLoopbackOrigin(', lines: [
        '// 若授权服务器位于本机，返回其 origin 作为可信目标。',
        '// 用于让本地开发环境的 http 回环地址通过校验。',
      ] },
      { at: 210, expect: 'function validateAuthorizationResponseIssuer({', lines: [
        '// 校验授权响应中的 iss 参数是否与预期签发者一致。',
        '// 该参数可选；一旦提供就必须完全匹配，用于防御混租攻击。',
      ] },
      { at: 217, expect: 'if (callbackIssuer != null && callbackIssuer !== expectedIssuer) {', lines: [
        '// iss 与预期不符时立即拒绝回调。',
      ] },
      { at: 224, expect: 'function createAuthorizationServerInformation(', lines: [
        '// 由授权服务器 URL 与元数据构造凭据绑定信息。',
        '// token 端点优先取元数据，其次回退到约定的 /token。',
        '// 所有 URL 都会归一化，保证后续比较稳定。',
      ] },
      { at: 239, expect: 'function addAuthorizationServerInformationToTokens(', lines: [
        '// 把授权服务器绑定信息写入令牌对象。',
        '// 令牌与签发它的服务器绑定，避免跨服务器复用。',
      ] },
      { at: 251, expect: 'function addAuthorizationServerInformationToClientInformation<', lines: [
        '// 把授权服务器绑定信息写入客户端信息。',
        '// 保留泛型，返回值与入参类型一致。',
      ] },
      { at: 265, expect: 'function getAuthorizationServerInformationFromCredentials(credentials?: {', lines: [
        '// 从已持久化的凭据中还原授权服务器绑定信息。',
        '// 缺少授权服务器 URL 或 token 端点时视为未绑定。',
        '// 返回前会归一化两个 URL。',
      ] },
      { at: 281, expect: 'async function getStoredAuthorizationServerInformation({', lines: [
        '// 依次从令牌、提供者与客户端信息中查找授权服务器绑定。',
        '// 令牌优先级最高，因为它是最近一次签发的凭据。',
        '// 提供者实现可覆盖默认的客户端信息查找。',
        '// 全部缺失时返回 undefined，由调用方决定是否拒绝。',
      ] },
      { at: 290, expect: 'const tokenAuthorizationServerInformation =', lines: [
        '// 优先使用令牌中记录的绑定。',
      ] },
      { at: 296, expect: 'const providerAuthorizationServerInformation =', lines: [
        '// 其次询问提供者的显式绑定。',
      ] },
      { at: 313, expect: 'async function saveAuthorizationServerInformation({', lines: [
        '// 持久化授权服务器绑定信息。',
        '// 优先使用专用的保存方法，其次写入客户端信息。',
        '// 两者都不可用时返回 false，调用方应拒绝继续。',
      ] },
      { at: 322, expect: 'if (provider.saveAuthorizationServerInformation) {', lines: [
        '// 专用保存方法优先级最高。',
      ] },
      { at: 329, expect: 'if (provider.saveClientInformation) {', lines: [
        '// 回退到把绑定写进客户端信息。',
      ] },
      { at: 342, expect: 'function assertResourceMetadataUrlSameOrigin(', lines: [
        '// 校验受保护资源元数据 URL 与 MCP 服务器同源。',
        '// 未提供元数据 URL 时直接通过。',
        '// 不同源会让攻击者借元数据把客户端引向其他服务器。',
      ] },
      { at: 346, expect: 'if (!resourceMetadataUrl) {', lines: [
        '// 没有显式元数据 URL 时无需校验。',
      ] },
      { at: 358, expect: 'function assertAuthorizationServerInformationMatches({', lines: [
        '// 比较存储的绑定与当前发现的绑定是否一致。',
        '// issuer 仅在两侧都存在时比较，兼容未声明 issuer 的服务器。',
        '// 授权服务器 URL 与 token 端点必须完全一致。',
        '// 不一致说明元数据被切换，直接拒绝以防凭据被劫持。',
      ] },
      { at: 365, expect: 'if (', lines: [
        '// 任一关键字段不一致即判定为绑定不匹配。',
      ] },
      { at: 382, expect: 'export function extractWWWAuthenticateParams(response: Response): {', lines: [
        '// 从 WWW-Authenticate 头中解析 OAuth 挑战参数。',
        '// 仅处理 Bearer 方案，其他方案直接忽略。',
        '// 提取 resource_metadata 与 scope 两个参数。',
        '// URL 解析失败时只保留 scope，保证流程不中断。',
      ] },
      { at: 398, expect: 'const resourceMetadataMatch = header.match(', lines: [
        '// 用正则提取带引号的参数值，兼容逗号与空格分隔。',
      ] },
      { at: 403, expect: 'let resourceMetadataUrl: URL | undefined;', lines: [
        '// 元数据 URL 可能非法，解析失败时降级为 undefined。',
      ] },
      { at: 416, expect: 'export function extractResourceMetadataUrl(', lines: [
        '// 便捷方法：只返回 WWW-Authenticate 中的元数据 URL。',
        '// 未在响应中找到元数据 URL 时返回 undefined。',
      ] },
      { at: 422, expect: 'function selectScope({', lines: [
        '// 选择本次授权请求使用的 scope。',
        '// 优先级：显式传入 > 资源元数据声明 > 客户端默认。',
      ] },
      { at: 431, expect: 'if (scope) {', lines: [
        '// 显式 scope 优先。',
      ] },
      { at: 446, expect: 'function buildWellKnownPath(', lines: [
        '// 构造 .well-known 元数据发现路径。',
        '// prependPathname 决定路径前缀在前还是在后。',
        '// 末尾斜杠会被去掉，避免出现双斜杠。',
      ] },
      { at: 454, expect: "if (pathname.endsWith('/')) {", lines: [
        '// 去掉路径末尾斜杠，保持拼接结果规整。',
      ] },
      { at: 463, expect: 'async function fetchWithCorsRetry(', lines: [
        '// 抓取元数据并处理 CORS 失败的重试。',
        '// 首次带 MCP-Protocol-Version 头，失败时去掉头再试一次。',
        '// 使用受控抓取：手动处理重定向并限制跨源凭据。',
        '// TypeError 视为 CORS 失败，其余错误原样抛出。',
      ] },
      { at: 504, expect: 'async function tryMetadataDiscovery(', lines: [
        '// 在指定 URL 上尝试元数据发现，附带协议版本头。',
      ] },
      { at: 510, expect: 'const headers = {', lines: [
        '// 协议版本头帮助服务端选择正确的元数据。',
      ] },
      { at: 519, expect: 'function shouldAttemptFallback(', lines: [
        '// 判断是否需要回退到根路径再发现一次。',
        '// 仅当首次请求失败且路径不是根时才回退。',
      ] },
      { at: 532, expect: 'async function discoverMetadataWithFallback(', lines: [
        '// 带根路径回退的通用元数据发现。',
        '// 支持显式元数据 URL 与独立元数据服务器。',
        '// 首次失败且路径非根时，再尝试根路径下的 well-known。',
        '// 返回原始响应，由调用方决定如何解析。',
      ] },
      { at: 543, expect: 'const issuer = new URL(serverUrl);', lines: [
        '// 以服务器 URL 为基准构造发现地址。',
      ] },
      { at: 555, expect: 'let response = await tryMetadataDiscovery(', lines: [
        '// 先按指定或推导出的地址请求。',
      ] },
      { at: 562, expect: 'if (!opts?.metadataUrl && shouldAttemptFallback(response, issuer.pathname)) {', lines: [
        '// 未显式指定地址时才回退到根路径。',
      ] },
      { at: 575, expect: 'export async function discoverOAuthProtectedResourceMetadata(', lines: [
        '// 发现 OAuth 受保护资源元数据（RFC 9728）。',
        '// 把 MCP 服务器 origin 作为可信目标，允许其正常响应。',
        '// 404 表示未实现该元数据，其他非 2xx 视为失败。',
        '// 成功时按 schema 解析并返回。',
      ] },
      { at: 614, expect: 'export function buildDiscoveryUrls(', lines: [
        '// 构造授权服务器元数据的候选发现地址。',
        '// 根路径按 OAuth 与 OIDC 两个端点尝试。',
        '// 有路径时再补充携带路径的变体，保持优先级顺序。',
        '// 每个候选都记录期望的 issuer，供解析后校验。',
      ] },
      { at: 689, expect: 'const issuerMatches =', lines: [
        '// 根 issuer 允许带末尾斜杠的等价写法。',
        '// 非根 issuer 必须精确匹配。',
      ] },
      { at: 701, expect: 'export async function discoverAuthorizationServerMetadata(', lines: [
        '// 发现并校验授权服务器元数据。',
        '// 请求前先确认所有候选地址未改变授权的服务器 origin。',
        '// 4xx 与 CORS 失败会继续尝试下一个候选，5xx 直接失败。',
        '// OIDC 结果还要求支持 S256 PKCE。',
      ] },
      { at: 720, expect: 'if (urlsToTry.some(({ url }) => url.origin !== authorizationServerOrigin)) {', lines: [
        '// 任何候选地址跨源都说明发现配置被篡改，直接拒绝。',
      ] },
      { at: 726, expect: 'for (const { url: endpointUrl, type, expectedIssuer } of urlsToTry) {', lines: [
        '// 按优先级逐个尝试候选地址。',
      ] },
      { at: 742, expect: 'if (!response.ok) {', lines: [
        '// 4xx 视为该候选不存在，5xx 视为服务端故障。',
      ] },
      { at: 752, expect: "if (type === 'oauth') {", lines: [
        '// OAuth 与 OIDC 元数据使用不同 schema 解析。',
      ] },
      { at: 774, expect: 'export async function startAuthorization(', lines: [
        '// 构造授权 URL 并生成 PKCE 挑战。',
        '// 有元数据时校验响应类型与 S256 支持。',
        '// 无元数据时回退到约定的 /authorize 端点。',
        '// 返回授权 URL 与本地需保存的 code verifier。',
      ] },
      { at: 792, expect: "const responseType = 'code';", lines: [
        '// 固定使用授权码模式与 S256 挑战方法。',
      ] },
      { at: 817, expect: 'const challenge = await pkceChallenge();', lines: [
        '// 生成本次流程唯一的 PKCE 挑战与 verifier。',
      ] },
      { at: 821, expect: 'authorizationUrl.searchParams.set(\'response_type\', responseType);', lines: [
        '// 依次写入授权码流程所需的查询参数。',
      ] },
      { at: 838, expect: "if (scope?.includes('offline_access')) {", lines: [
        '// 请求离线访问时追加 consent 提示，确保用户明确授权。',
      ] },
      { at: 845, expect: 'if (resource) {', lines: [
        '// 资源参数指向本次要访问的 MCP 资源。',
      ] },
      { at: 855, expect: "type ClientAuthMethod = 'client_secret_basic' | 'client_secret_post' | 'none';", lines: [
        '// 支持的 OAuth 客户端认证方式。',
        '// none 表示公共客户端，仅携带 client_id。',
      ] },
      { at: 869, expect: 'function selectClientAuthMethod(', lines: [
        '// 根据服务端支持与是否有机密选择认证方式。',
        '// 服务端未声明时：有机密用 post，否则用 none。',
        '// 优先级 basic > post > none。',
        '// 调用方可用其覆盖默认选择。',
      ] },
      { at: 873, expect: 'const hasClientSecret = clientInformation.client_secret !== undefined;', lines: [
        '// 只有存在 client_secret 才考虑机密客户端方式。',
      ] },
      { at: 908, expect: 'function applyClientAuthentication(', lines: [
        '// 按选定方式把客户端凭据写入请求。',
        '// basic 写请求头，post 写请求体，none 只写 client_id。',
        '// 该函数不发起请求，只修改传入的 headers 与 params。',
      ] },
      { at: 914, expect: 'const { client_id, client_secret } = clientInformation;', lines: [
        '// 解构出凭据，后续各方式复用。',
      ] },
      { at: 931, expect: 'function applyBasicAuth(', lines: [
        '// HTTP Basic 认证：base64 编码 client_id 与 secret。',
        '// 缺少 secret 时直接抛错，避免发出无效请求。',
      ] },
      { at: 949, expect: 'function applyPostAuth(', lines: [
        '// 请求体认证：把凭据写入表单参数。',
        '// 与 basic 一样要求 client_secret 存在。',
      ] },
      { at: 963, expect: 'function applyPublicAuth(clientId: string, params: URLSearchParams): void {', lines: [
        '// 公共客户端只需在请求体声明 client_id。',
        '// 没有 secret，因此不需要额外认证信息。',
      ] },
      { at: 978, expect: 'export async function parseErrorResponse(', lines: [
        '// 解析 OAuth 错误响应并映射到具体错误类型。',
        '// 兼容 Response 与字符串两种输入。',
        '// 解析失败时回退为携带原始内容的 ServerError。',
        '// 映射依据是响应中的 error 字段。',
      ] },
      { at: 1013, expect: 'export async function exchangeAuthorization(', lines: [
        '// 用授权码换取访问令牌。',
        '// 先校验 token 端点安全性与授权类型支持。',
        '// 支持自定义客户端认证，否则自动选择认证方式。',
        '// 非 2xx 会解析为标准 OAuth 错误后抛出。',
      ] },
      { at: 1040, expect: 'const trustedOrigin = getTrustedLoopbackOrigin(authorizationServerUrl);', lines: [
        '// 仅当 token 端点与本地授权服务器同源时才允许回环。',
      ] },
      { at: 1054, expect: 'const headers = new Headers({', lines: [
        '// 令牌请求使用表单编码并接受 JSON 响应。',
      ] },
      { at: 1058, expect: 'const params = new URLSearchParams({', lines: [
        '// 授权码、verifier 与回调地址构成交换请求主体。',
      ] },
      { at: 1065, expect: 'if (addClientAuthentication) {', lines: [
        '// 调用方可完全接管客户端认证逻辑。',
      ] },
      { at: 1087, expect: 'const response = await fetchWithValidatedEndpoint({', lines: [
        '// 令牌请求禁止重定向，避免凭据被转发到其他地址。',
      ] },
      { at: 1098, expect: 'if (!response.ok) {', lines: [
        '// 失败响应解析为 OAuth 错误。',
      ] },
      { at: 1117, expect: 'export async function refreshAuthorization(', lines: [
        '// 用 refresh token 换取新令牌。',
        '// 端点选择、安全校验与认证方式与授权码交换一致。',
        '// 服务端未返回新 refresh_token 时保留原值。',
        '// 其余字段按令牌 schema 解析。',
      ] },
      { at: 1157, expect: 'const headers = new Headers({', lines: [
        '// 刷新请求同样使用表单编码。',
      ] },
      { at: 1161, expect: 'const params = new URLSearchParams({', lines: [
        '// 刷新请求只携带 grant_type 与 refresh_token。',
      ] },
      { at: 1188, expect: 'const response = await fetchWithValidatedEndpoint({', lines: [
        '// 禁止重定向，保护刷新令牌。',
      ] },
      { at: 1198, expect: 'if (!response.ok) {', lines: [
        '// 非 2xx 统一转换为 OAuth 错误。',
      ] },
      { at: 1211, expect: 'export async function registerClient(', lines: [
        '// 按 RFC 7591 执行动态客户端注册。',
        '// 有元数据时要求声明注册端点，否则回退到约定路径。',
        '// 未指定应用类型时根据回调地址推断。',
        '// 注册前同样校验端点安全性。',
      ] },
      { at: 1223, expect: 'let registrationUrl: URL;', lines: [
        '// 注册端点优先取元数据声明。',
      ] },
      { at: 1241, expect: 'const applicationType =', lines: [
        '// 未显式指定时按回调地址推断 native 或 web。',
      ] },
      { at: 1244, expect: 'const response = await fetchWithValidatedEndpoint({', lines: [
        '// 注册请求以 JSON 提交客户端元数据。',
      ] },
      { at: 1260, expect: 'if (!response.ok) {', lines: [
        '// 注册失败按 OAuth 错误解析。',
      ] },
      { at: 1267, expect: "function inferOAuthApplicationType(redirectUris: string[]): 'native' | 'web' {", lines: [
        '// 推断 OAuth 应用类型。',
        '// 非 http(s) 协议或回环 http(s) 视为 native。',
        '// 全部回调都满足 native 判定时才返回 native。',
      ] },
      { at: 1280, expect: 'export async function auth(', lines: [
        '// OAuth 授权流程入口。',
        '// 先执行一次内部流程，失败时按错误类型决定是否重试。',
        '// 动态注册的客户端被拒时清除凭据后重试一次。',
        '// 刷新失败且是令牌问题时，清除旧令牌后重新授权。',
      ] },
      { at: 1303, expect: 'if (', lines: [
        '// 仅动态注册且非回调交换时才允许清除并重试。',
      ] },
      { at: 1312, expect: '} else if (error instanceof InvalidGrantError && refreshAttempt.tokens) {', lines: [
        '// 刷新令牌失效：先保留绑定信息用于重试校验。',
      ] },
      { at: 1333, expect: 'export async function selectResourceURL(', lines: [
        '// 选择并校验本次授权的资源 URL。',
        '// 提供者可通过 validateResourceURL 完全接管选择。',
        '// 否则与资源元数据声明比对，确保未越权。',
        '// 默认返回由服务器 URL 推导的资源地址。',
      ] },
      { at: 1348, expect: 'if (!resourceMetadata) {', lines: [
        '// 没有资源元数据时使用默认资源地址。',
      ] },
      { at: 1352, expect: 'if (', lines: [
        '// 声明的资源必须与默认资源或其源一致。',
      ] },
      { at: 1365, expect: 'async function authInternal(', lines: [
        '// 授权流程的实际实现。',
        '// 依次完成资源元数据发现、绑定校验、凭据加载与注册。',
        '// 有授权码时校验 state 与 issuer 后交换令牌。',
        '// 有绑定且可刷新时优先刷新，否则发起新的授权重定向。',
        '// 每个阶段都在使用前完成安全与一致性校验。',
      ] },
      { at: 1387, expect: 'let resourceMetadata: OAuthProtectedResourceMetadata | undefined;', lines: [
        '// 本次流程中逐步填充的上下文状态。',
      ] },
      { at: 1398, expect: 'try {', lines: [
        '// 资源元数据发现失败不致命，可回退到服务器自身作为授权服务器。',
      ] },
      { at: 1417, expect: 'if (authorizationCode !== undefined) {', lines: [
        '// 回调场景：提前读取客户端信息与其绑定的授权服务器。',
      ] },
      { at: 1429, expect: 'if (!authorizationServerUrl) {', lines: [
        '// 未发现授权服务器时，优先复用之之前固定下来的服务器。',
      ] },
      { at: 1435, expect: 'const parsedServerUrl = new URL(serverUrl);', lines: [
        '// 计算服务器与授权服务器的 origin 关系。',
      ] },
      { at: 1449, expect: 'if (!trustedAuthorizationServerOrigin) {', lines: [
        '// 跨源授权服务器在请求前必须通过 SSRF 守卫。',
      ] },
      { at: 1454, expect: 'const resource = await selectResourceURL(', lines: [
        '// 校验并确定本次要访问的资源。',
      ] },
      { at: 1461, expect: 'await provider.validateAuthorizationServerURL?.(', lines: [
        '// 给应用一次在抓取元数据前限制授权服务器的机会。',
      ] },
      { at: 1467, expect: 'const metadata = await discoverAuthorizationServerMetadata(', lines: [
        '// 发现授权服务器元数据。',
      ] },
      { at: 1474, expect: 'const currentAuthorizationServerInformation =', lines: [
        '// 由当前发现结果推导本次流程的凭据绑定。',
      ] },
      { at: 1482, expect: 'const clientMetadata = provider.clientMetadata;', lines: [
        '// 读取客户端元数据并选择 scope。',
      ] },
      { at: 1490, expect: 'if (authorizationCode === undefined) {', lines: [
        '// 非回调场景稍后才读取客户端信息与令牌。',
      ] },
      { at: 1493, expect: 'const tokens =', lines: [
        '// 回调场景不再读取现有令牌。',
      ] },
      { at: 1495, expect: 'if (clientInformation) {', lines: [
        '// 客户端信息必须与当前授权服务器绑定一致。',
      ] },
      { at: 1555, expect: 'if (tokens?.refresh_token) {', lines: [
        '// 刷新令牌同样必须带有可校验的绑定。',
      ] },
      { at: 1577, expect: 'if (!clientInformation) {', lines: [
        '// 无客户端信息时需要动态注册。',
      ] },
      { at: 1584, expect: 'if (!provider.saveClientInformation) {', lines: [
        '// 动态注册要求客户端信息可持久化，否则下次无法复用。',
      ] },
      { at: 1590, expect: 'const fullInformation = await registerClient(authorizationServerUrl, {', lines: [
        '// 注册新客户端并把绑定信息一并保存。',
      ] },
      { at: 1607, expect: 'if (authorizationCode !== undefined) {', lines: [
        '// 回调分支：先校验 state，再校验绑定，最后交换令牌。',
      ] },
      { at: 1608, expect: 'if (provider.storedState) {', lines: [
        '// state 不一致视为可能的 CSRF，直接拒绝。',
      ] },
      { at: 1623, expect: 'if (!storedAuthorizationServerInformation) {', lines: [
        '// 没有绑定信息就无法安全交换授权码。',
      ] },
      { at: 1641, expect: 'const codeVerifier = await provider.codeVerifier();', lines: [
        '// 取出 PKCE verifier 并完成授权码交换。',
      ] },
      { at: 1663, expect: 'if (tokens?.refresh_token && refreshAuthorizationServerInformation) {', lines: [
        '// 仅在令牌有绑定且存在 refresh token 时尝试刷新。',
      ] },
      { at: 1685, expect: '} catch (error) {', lines: [
        '// 刷新失败：服务器错误或未知错误降级为重新授权，其余上抛。',
      ] },
      { at: 1700, expect: 'const state = provider.state ? await provider.state() : undefined;', lines: [
        '// 生成并保存 state，用于回调时防御 CSRF。',
      ] },
      { at: 1706, expect: 'const { authorizationUrl, codeVerifier } = await startAuthorization(', lines: [
        '// 构造授权 URL 并生成 PKCE 挑战。',
      ] },
      { at: 1718, expect: 'const savedAuthorizationServerInformation =', lines: [
        '// 重定向前必须成功持久化绑定信息。',
      ] },
      { at: 1724, expect: 'if (!savedAuthorizationServerInformation) {', lines: [
        '// 无法保存绑定则拒绝重定向，避免后续无法校验。',
      ] },
      { at: 1731, expect: 'await provider.saveCodeVerifier(codeVerifier);', lines: [
        '// 保存 verifier 并重定向用户去授权。',
      ] },
    ],
  },
  {
    name: 'oauth-types.ts',
    want: [34, 36],
    blocks: [
      { at: 1, expect: "import { z } from 'zod/v4';", lines: [
        '// ============================================================================',
        '// oauth-types：OAuth 2.1 与 OpenID Connect 的 zod schema 与推导类型',
        '// 统一约束令牌、元数据、客户端注册与错误响应的形状。',
        '// ============================================================================',
      ] },
      { at: 5, expect: 'export const SafeUrlSchema = z', lines: [
        '// 安全的 URL 校验：必须是可解析的 URL。',
        '// 额外拒绝 javascript:、data: 与 vbscript: 等危险协议。',
        '// 供所有来自外部元数据的 URL 字段复用。',
      ] },
      { at: 34, expect: 'export const OAuthTokensSchema = z', lines: [
        '// OAuth 2.1 令牌响应。',
        '// 除访问令牌外，还可携带绑定信息与刷新令牌。',
        '// 使用 strip 丢弃未知字段，避免污染内部状态。',
      ] },
      { at: 48, expect: 'export const OAuthProtectedResourceMetadataSchema = z.looseObject({', lines: [
        '// 受保护资源元数据（RFC 9728）。',
        '// 使用 looseObject 保留未知字段，兼容后续扩展。',
        '// 其中授权服务器与各类 URI 都走安全 URL 校验。',
      ] },
      { at: 65, expect: 'export const OAuthMetadataSchema = z.looseObject({', lines: [
        '// 授权服务器元数据。',
        '// 声明端点、支持的响应类型与认证方式等。',
        '// 端点均为安全 URL，避免被注入危险协议。',
      ] },
      { at: 86, expect: 'export const OpenIdProviderMetadataSchema = z.looseObject({', lines: [
        '// OpenID Connect Discovery 提供者元数据。',
        '// 在 OAuth 元数据基础上增加用户信息与签名算法等字段。',
        '// 同样允许未知字段透传。',
      ] },
      { at: 109, expect: 'export const OpenIdProviderDiscoveryMetadataSchema =', lines: [
        '// OIDC 元数据与 OAuth 字段的合并视图。',
        '// 现实中的 OIDC 提供者常同时返回两类字段。',
        '// 这里只补充 code_challenge_methods_supported。',
      ] },
      { at: 116, expect: 'export const OAuthClientInformationSchema = z', lines: [
        '// 客户端注册信息。',
        '// 包含 client_id/secret 与可选的授权服务器绑定字段。',
        '// strip 保证持久化内容只保留已知字段。',
      ] },
      { at: 128, expect: 'export const OAuthClientMetadataSchema = z', lines: [
        '// 动态注册时提交的客户端元数据。',
        '// 回调地址必须是安全 URL，应用类型限定为 native 或 web。',
        '// 其余字段按 RFC 7591 可选声明。',
      ] },
      { at: 152, expect: 'export type OAuthMetadata = z.infer<typeof OAuthMetadataSchema>;', lines: [
        '// 由 schema 推导的对外类型，避免手写重复定义。',
      ] },
      { at: 167, expect: 'export const OAuthErrorResponseSchema = z.object({', lines: [
        '// 标准 OAuth 错误响应。',
        '// 只包含 error 与可选的描述、URI。',
      ] },
      { at: 172, expect: 'export const OAuthClientInformationFullSchema = OAuthClientMetadataSchema.merge(', lines: [
        '// 完整客户端信息：注册元数据与注册结果的合并。',
        '// 动态注册响应按该 schema 解析。',
        '// 合并后同时具备元数据与凭据字段。',
      ] },
    ],
  },
];

let grand = 0;
for (const f of files) {
  const path = ROOT + f.name;
  const raw = fs.readFileSync(path, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(eol);
  let total = 0;
  let bad = 0;
  for (const b of f.blocks) {
    const actual = (lines[b.at - 1] ?? '').trim();
    if (actual !== b.expect) {
      console.error(`MISMATCH ${f.name}:${b.at} expected [${b.expect}] actual [${actual}]`);
      bad++;
    }
    total += b.lines.length;
  }
  if (bad) process.exit(1);
  if (process.env.DRY) {
    console.log('DRY', f.name, total);
    grand += total;
    continue;
  }
  if (total < f.want[0] || total > f.want[1]) {
    console.error(`COUNT ${f.name}=${total} want ${f.want[0]}..${f.want[1]}`);
    process.exit(1);
  }
  const sorted = [...f.blocks].sort((a, b) => b.at - a.at);
  for (const b of sorted) lines.splice(b.at - 1, 0, ...b.lines);
  fs.writeFileSync(path, lines.join(eol), 'utf8');
  console.log('ADDED', f.name, total);
  grand += total;
}
console.log('TOTAL', grand);
