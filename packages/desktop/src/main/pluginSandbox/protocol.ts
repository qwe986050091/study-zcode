// INV-01 守住位置：scheme 必须在与 zcode-media 的同一次 registerSchemesAsPrivileged 调用里注册；改错故障：第二次调用覆盖首次注册，插件资源请求被浏览器拒绝。
// INV-02 守住位置：URL host 前缀决定 kind，最终 host 必须等于 kind 加 appIdentity；改错故障：只信任路径里的 sandboxId，任意实例可读取他人页面。
// INV-03 守住位置：带凭据或端口的 URL 一律返回 null；改错故障：host 归属比较被绕过，出现跨实例读取。
// INV-04 守住位置：路径必须以 /instance/ 开头且第三段非空；改错故障：空实例 id 进入 registry 查询，行为退化为全局命中。
// INV-05 守住位置：资源路径规范化后必须仍在 baseDir 内；改错故障：出现路径穿越，可读取沙箱目录外的任意文件。
// INV-06 守住位置：registry 查不到记录即返回 404；改错故障：实例销毁后仍返回缓存内容，泄露旧文档。
// INV-07 守住位置：只接受 GET；改错故障：其他方法穿透到资源分支，产生非预期副作用。
// INV-08 守住位置：所有响应统一写入 Cache-Control: no-store；改错故障：稳定 origin 共享缓存，已载入脚本绕过后续归属检查。
// INV-09 守住位置：Content-Type 只取扩展名白名单并附加 nosniff；改错故障：未知类型被当 HTML 执行。
// INV-10 守住位置：shell 与 plugin 各自生成 CSP 与 Permissions-Policy；改错故障：权限策略串用，插件拿到 shell 的能力集。
// INV-11 守住位置：Gen UI 文档必须在最后一个 inner kit 槽位处替换；改错故障：脚本顺序错位，初始化语义被手写片段改写。
// INV-12 守住位置：Gen UI 运行时资源缺失返回 500；改错故障：返回半成品 HTML，页面看似成功但交互静默失效。
// INV-13 守住位置：别名脚本以同源 URL 注入 head 顶部；改错故障：页面脚本先执行，读到未定义的别名。
// INV-14 守住位置：dev 代理仅在 devServerUrl 存在时启用；改错故障：打包版把请求转发到不存在的 dev server，全部 502。
// INV-15 守住位置：vendor 文件先经 hasFile 预检再读取；改错故障：缺失文件走 500 而非 404，掩盖打包缺件。
// INV-16 守住位置：未知路径统一收敛为 404 且不区分原因；改错故障：通过状态码差异探测实例是否存在。
// INV-17 守住位置：安装与卸载以 WeakSet 做幂等；改错故障：重复 handle 覆盖既有 handler，无法正确卸载。
// INV-18 守住位置：仅插件与别名脚本请求记 info，错误记 warn；改错故障：日志噪音淹没真实失败，或失败被静默丢弃。
//
// 模块职责：把 zcode-sandbox 协议的全部请求解析、归属校验与资源分发收敛在一个工厂里，必须向上只暴露 Request 到 Response 的映射。
// 状态所有权：registry、资源目录、读取实现与 vendor 资源都由调用方注入，本模块不持有跨请求业务状态，仅用 WeakSet 记录协议安装结果。
// 阅读顺序：先看 URL 解析与归属校验，再看 shell 分支、Gen UI 分支与插件文档分支，最后看响应包装与日志分级。
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import type { PluginSandboxRegistryPort } from "./contract.js";
import {
  PLUGIN_SANDBOX_PLUGIN_HOST_PREFIX,
  PLUGIN_SANDBOX_SCHEME,
  PLUGIN_SANDBOX_SHELL_HOST_PREFIX,
} from "./contract.js";
import { PLUGIN_SANDBOX_SHELL_CSP, buildPluginSandboxPermissionsPolicy } from "./csp.js";
import { createGenUiVendorResources, type GenUiVendorResources } from "./genUiVendor.js";

/** 打包产物在 out/renderer 下的文件名（vite input 名 `plugin-sandbox`）。 */
export const PLUGIN_SANDBOX_SHELL_HTML_FILE = "plugin-sandbox.html";
/** 注入插件 HTML 顶部的 `window.zcode` 别名脚本；同源加载，避免依赖 inline nonce。 */
export const PLUGIN_SANDBOX_ALIAS_SCRIPT_PATH = "/__zcode__/alias.js";
// 别名脚本的磁盘文件名，需与 vite 构建产物名一致，重命名会让注入标签指向 404。
export const PLUGIN_SANDBOX_ALIAS_SCRIPT_FILE = "plugin-sandbox-alias.js";

// 只声明注册特权 scheme 的最小接口，便于单测传入假实现而不引入 Electron。
export interface PluginSandboxSchemeRegistrar {
  // 该方法只允许在 app ready 之前调用一次，重复调用按 INV-01 会整体覆盖。
  registerSchemesAsPrivileged(
    // 入参是数组而非单个值，调用方必须把本模块的 scheme 与 zcode-media 合并后一次提交。
    schemes: Array<{ scheme: string; privileges: Record<string, boolean> }>,
  ): void;
}

/** 与 zcode-media 必须在同一次 registerSchemesAsPrivileged 调用里注册（第二次调用会覆盖第一次）。 */
// 该常量必须与 zcode-media 的 scheme 在同一数组里提交给特权注册接口。
// 原因：Electron 只保留首次调用的注册集，第二次调用整体覆盖，后来者静默失效。
// 改错后果：插件页面的 fetch 与 CORS 语义丢失，文档能加载但所有资源请求被拒。
// standard 与 secure 缺一不可，否则该 scheme 不算安全上下文，模块脚本无法执行。
// corsEnabled 保持 false：跨源请求必须走失败路径，不能由浏览器静默放行。
export const PLUGIN_SANDBOX_PRIVILEGED_SCHEME = {
  // scheme 名取自契约常量，与 URL 解析处比较的字符串必须同源，避免两处字面量漂移。
  scheme: PLUGIN_SANDBOX_SCHEME,
  // corsEnabled 固定 false，跨源请求只能走显式失败路径，这是 INV-03 之外的第二道闸。
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
} as const;

// protocol 宿主的抽象，让安装函数不直接依赖 Electron protocol 模块。
export interface PluginSandboxProtocolHost {
  // 注册后同一 scheme 只会有一个 handler，重复调用会覆盖而不是排队。
  handle(scheme: string, handler: (request: Request) => Promise<Response> | Response): void;
  // 卸载必须传同一个 scheme 值，传错不会报错但会留下悬挂 handler。
  unhandle(scheme: string): void;
  // 卸载前的存在性探测，未注册时 unhandle 的行为由宿主决定，不能依赖它幂等。
  isProtocolHandled(scheme: string): boolean;
}

// 两个目录职责不同：rendererDir 只放 shell 产物，aliasDir 放别名脚本与 Gen UI 运行时。
// aliasDir 独立于 out/renderer，是为了躲开 vite 的 emptyOutDir，构建清理不会带走运行时脚本。
// devServerUrl 是唯一区分 dev 与打包版的分支依据，缺失即代表产物已在磁盘上。
// 新增资源目录先在这里声明再由 handler 读取，禁止在分支内拼接隐式路径。
// 改错后果：路径来源分散后打包版会读到 dev 目录，表现为本地正常、安装包空白。
export interface PluginSandboxAssetSource {
  /** out/renderer 目录；shell HTML 与其 assets 从这里读。 */
  rendererDir: string;
  /** out/plugin-sandbox 目录；别名脚本从这里读（独立目录，避免被 vite emptyOutDir 清掉）。 */
  aliasDir: string;
  /**
   * 开发模式（vite dev）下 out/renderer 没有 shell 产物：shell 的 HTML、/src/*.ts、/@vite/* 全部
   * 从 renderer dev server 代理（ELECTRON_RENDERER_URL）。打包版缺省，走 rendererDir。
   */
  devServerUrl?: string;
}

// 解析结果的唯一形状，handler 只读这三个字段，不回头再解析原始 URL。
export interface PluginSandboxRequestTarget {
  // kind 决定后续分支与 host 校验里的前缀，取错会让插件请求走 shell 的资源目录。
  kind: "shell" | "plugin";
  // sandboxId 取自路径第三段，registry 必须用它作键，空值已在解析层拦截。
  sandboxId: string;
  // pathname 已剥掉 /instance/<id> 前缀并以 / 开头，后续可直接拼目录。
  pathname: string;
}

/** 解析 zcode-sandbox:// URL；host 不匹配前缀、带凭据或端口一律 null。 */
// 返回值是协议层唯一的目标描述，调用方只依赖 kind、sandboxId 与 pathname 三个字段。
// 解析失败一律 null 而不抛异常：URL 属于外部输入，不能中断请求处理链。
// 凭据或端口出现即判非法，避免 user@host:port 形式绕过后续的 host 归属比较。
// 路径必须以 /instance/ 开头，sandboxId 取第三段，其余段重新拼成子路径。
// shell 与 plugin 两支保持同构，任何一支放宽都会让实例隔离在另一支上失效。
export function parsePluginSandboxUrl(rawUrl: string): PluginSandboxRequestTarget | null {
  // 声明与赋值分开是为了让 try 只包住构造，catch 之后仍能安全使用变量。
  let url: URL;
  try {
    // 构造失败（相对地址、非法字符）必须直接落到 catch，不尝试修补输入。
    url = new URL(rawUrl);
  } catch {
    // 解析层唯一的失败出口之一，返回 null 而不抛错，调用方统一转 404。
    return null;
  }
  // 协议名、端口、用户名、口令四项必须一次判完，任何一项出现都足以破坏 host 归属比较。
  if (url.protocol !== `${PLUGIN_SANDBOX_SCHEME}:` || url.port || url.username || url.password) {
    // 非法协议或带凭据时立即返回，不再做 host 前缀判断。
    return null;
  }
  // hostname 不含端口与凭据，前面的检查已保证它可以直接做前缀比较。
  const host = url.hostname;
  // 按 host 前缀分流而不是按路径，路径由外部完全可控，不能作为类型依据。
  if (host.startsWith(PLUGIN_SANDBOX_SHELL_HOST_PREFIX)) {
    // 先取第三段再校验前缀，顺序反了会让 /instance/ 之外的路径也进入取值。
    const sandboxId = url.pathname.split("/")[2];
    // 前缀校验必须发生在使用 sandboxId 之前，否则 /x/y 会被误解析成实例 y。
    if (!url.pathname.startsWith("/instance/")) return null;
    // 三段式表达式把第三段为空直接收敛为 null，与 INV-04 对应。
    return sandboxId
      // shell 目标的 pathname 从第四段起重新拼接，保留原始子路径但去掉实例前缀。
      ? { kind: "shell", sandboxId, pathname: "/" + url.pathname.split("/").slice(3).join("/") }
      // 空实例 id 不进入 registry 查询，避免退化成分全局命中。
      : null;
  }
  // plugin 分支与 shell 分支结构对称，改动其中一支时必须同步另一支。
  if (host.startsWith(PLUGIN_SANDBOX_PLUGIN_HOST_PREFIX)) {
    // plugin 侧同样取第三段，不能复用上面的局部变量，两支前缀不同源。
    const sandboxId = url.pathname.split("/")[2];
    // 先算子路径再校验前缀，失败分支直接 return，不影响已算出的值。
    const pathname = "/" + url.pathname.split("/").slice(3).join("/");
    // plugin 分支独立再做一次前缀校验，避免只改一支就放宽隔离。
    if (!url.pathname.startsWith("/instance/")) return null;
    // 空 sandboxId 返回 null 而不是抛错，交由 handler 统一 404。
    return sandboxId ? { kind: "plugin", sandboxId, pathname } : null;
  }
  // host 不匹配任何已知前缀时返回 null，新增前缀必须在这里显式加分支。
  return null;
}

/** 在插件 HTML 的 `<head>` 顶部（或文档最前）注入别名脚本引用。 */
// 注入点必须在 head 开标签之后，保证别名脚本先于业务脚本执行。
// 缺少 head 时退化为文档最前插入，仍保持先于任何页面脚本的语义。
// sandboxId 决定脚本 URL 前缀，缺失时必须按无实例路径处理，仅适用于无沙箱场景。
// 脚本标签走同源路径而非内联，因此不依赖 inline nonce，CSP 无需额外放行。
// 改错后果：注入位置后移会让页面脚本先读到未定义的别名，初始化直接失败。
export function injectPluginSandboxAliasScript(html: string, sandboxId?: string): string {
  // 标签内联拼接同源路径，sandboxId 为空时退化为无实例前缀的绝对路径。
  const tag = `<script src="${sandboxId ? `/instance/${sandboxId}` : ""}${PLUGIN_SANDBOX_ALIAS_SCRIPT_PATH}"></script>`;
  // 用不区分大小写的正则找 head 开标签，只取第一个匹配。
  const headMatch = /<head[^>]*>/i.exec(html);
  // 有 head 走头部注入，没有 head 走文档最前插入，两条路径都保证脚本先于业务脚本。
  if (headMatch) {
    // 插入点取整个开标签之后，保留 head 上的属性不被截断。
    const index = headMatch.index + headMatch[0].length;
    // 用切片拼接而不是 replace，避免 HTML 中重复出现 head 字符串时插错位置。
    return `${html.slice(0, index)}${tag}${html.slice(index)}`;
  }
  // 无 head 时把标签放在最前，仍满足先于任何页面脚本的约束。
  return `${tag}${html}`;
}

// 扩展名到 Content-Type 的映射是白名单，未命中回退 octet-stream，再由 nosniff 阻止猜测。
// 未知扩展名不得回退成 text/html，否则任意文件都会被当页面执行。
// 新增可加载资源类型必须同时补这里，否则前端表现为资源加载失败而非解析失败。
// MIME_BY_EXTENSION 与读取逻辑解耦：读取成功不代表类型可信，类型只由扩展名决定。
const MIME_BY_EXTENSION: Record<string, string> = {
  // html 显式带 charset，页面里的中文与 emoji 不依赖浏览器默认编码。
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
};

// 工厂只做依赖装配：registry、资源目录、读取实现与日志都由调用方注入，自身不持进程级状态。
// readAsset 可替换是为了单测与不同打包形态，默认实现直接读文件且不缓存。
// vendorResources 仅在未注入时延迟创建，避免无关实例承担 Gen UI 的初始化开销。
// 返回的 handler 是纯请求到响应的映射，闭包内不得反向修改 registry。
// 改错后果：把目录或 registry 写死，会让多实例与多环境共用同一份错误状态。
export function createPluginSandboxProtocolHandler(options: {
  // registry 由调用方注入，工厂不持有实例表，销毁实例不需要通知本模块。
  registry: PluginSandboxRegistryPort;
  // 三个目录路径整体由 PluginSandboxAssetSource 注入，分支内不得再拼隐式相对路径。
  assets: PluginSandboxAssetSource;
  // 读取实现可替换，默认为 node:fs/promises 的 readFile，单测可传内存实现。
  readAsset?: (absolutePath: string) => Promise<Uint8Array>;
  // 显式注入可复用已初始化的 vendor 表，缺省时才在工厂内延迟创建。
  vendorResources?: GenUiVendorResources;
  // logger 的 info 是可选的，缺省时只丢 info 不丢 warn。
  logger?: { warn: (...args: unknown[]) => void; info?: (...args: unknown[]) => void };
}): (request: Request) => Promise<Response> {
  // 缺省实现不缓存，每次请求都落盘读，避免热更新后仍返回旧文件。
  const readAsset = options.readAsset ?? ((path: string) => readFile(path));
  // 统一的 404 响应不带 body，避免通过错误文案区分失败原因（INV-16）。
  const notFound = () => new Response(null, { status: 404 });
  // vendorResources 只在未注入时延迟创建，构造工厂不触碰磁盘。
  const vendorResources =
    options.vendorResources ?? createGenUiVendorResources(options.assets.aliasDir, readAsset);

  // serveAsset 是单一读文件出口，所有静态资源都经它做穿越校验与类型映射。
  const serveAsset = async (
    // baseDir 是可信根目录，必须来自配置而不是请求，relativePath 才是外部输入。
    baseDir: string,
    // 相对路径允许带子目录，但必须在 baseDir 内，拼接后再规范化。
    relativePath: string,
    // 调用方附加的 CSP 等头最后展开，可覆盖默认头但不能绕过类型白名单。
    headers: Record<string, string>,
  ) => {
    // 防路径穿越：规范化后必须仍在 baseDir 内。
    const absolute = normalize(join(baseDir, relativePath));
    // 根路径补 sep 再 normalize，防止 /a/bc 被 /a/b 前缀误判为内部路径。
    const root = normalize(baseDir + sep);
    // 穿越校验用前缀比较，失败返回 404 而不是 403，避免暴露目录存在性。
    if (!absolute.startsWith(root)) return notFound();
    try {
      // 读取异常由下面 catch 收敛，读不到与越界对外表现一致。
      const body = await readAsset(absolute);
      // 复制成 Uint8Array 再交给 Response，避免 Buffer 视图共享底层内存。
      return new Response(new Uint8Array(body), {
        // serveAsset 命中文件一律 200，404 与 500 只在上层分支出现。
        status: 200,
        // 默认头先写类型与 nosniff，再展开调用方头，顺序决定谁能覆盖谁。
        headers: {
          // 类型只由扩展名决定，未命中白名单回退 octet-stream，不猜内容。
          "Content-Type": MIME_BY_EXTENSION[extname(absolute)] ?? "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
          ...headers,
        },
      });
    } catch {
      // 读取失败与穿越失败都走 notFound，调用方无法据此区分原因。
      return notFound();
    }
  };

  // 方法白名单放在最前，非 GET 直接 405，后续分支不再重复判断。
  // 目标解析、registry 查询、host 归属三层校验依次早返回，任何一层缺失都收敛为 404。
  // host 必须等于 kind 加 appIdentity 的组合，这是实例隔离的核心，不能只信任 URL 里的 sandboxId。
  // shell 分支先 dev 代理再磁盘资源，两套语义不重叠，避免本地读到过期产物。
  // 末尾必须统一 404 且不区分不存在与无权限，防止用状态码探测实例信息。
  const handle = async (request: Request): Promise<Response> => {
    // 方法白名单放在解析之前，非 GET 不消耗后续任何校验。
    if (request.method !== "GET") return new Response(null, { status: 405 });
    // 解析失败不抛错，拿到 null 后统一 404。
    const target = parsePluginSandboxUrl(request.url);
    // 解析层已保证 kind 与 sandboxId 有效，这里不再重复校验。
    if (!target) return notFound();
    // registry 查询以解析出的 id 为键，查不到即视为实例不存在。
    const record = options.registry.get(target.sandboxId);
    // 实例销毁后立即 404，不返回缓存内容（INV-06）。
    if (!record) return notFound();
    // host 必须等于 kind 加 appIdentity，只信任路径里的 sandboxId 会被任意实例冒用（INV-02）。
    if (new URL(request.url).hostname !== `${target.kind}-${record.instance.appIdentity}`)
      // 归属不符与实例不存在都回 notFound，防止用状态码枚举实例。
      return notFound();

    // shell 分支与 plugin 分支共享前置校验，只在这里分叉。
    if (target.kind === "shell") {
      // shell 的 CSP 与权限策略在分支入口一次算好，后续每个响应复用。
      const shellHeaders = {
        // shell 用固定 CSP，不能读实例 record.cspHeader，否则插件策略会串到 shell（INV-10）。
        "Content-Security-Policy": PLUGIN_SANDBOX_SHELL_CSP,
        "Permissions-Policy": buildPluginSandboxPermissionsPolicy(record.permissions, "shell"),
      };
      // 只有显式配置 devServerUrl 才走代理，打包版缺省走磁盘（INV-14）。
      if (options.assets.devServerUrl) {
        // dev：同源代理整个 shell 路径空间，vite 的模块脚本才能在 zcode-sandbox://shell-<id> 下解析。
        const upstreamPath =
          target.pathname === "/" || target.pathname === "/index.html"
            // 根路径与 /index.html 都映射到打包产物名，其他路径原样透传。
            ? `/${PLUGIN_SANDBOX_SHELL_HTML_FILE}`
            // 透传时不再拼前缀，保证 vite 的 /src 与 /@vite 路径可解析。
            : target.pathname;
        // 保留查询串，vite 的 ?t= 时间戳与 ?import 参数丢失会导致模块解析失败。
        const search = new URL(request.url).search;
        try {
          // 代理请求不带自定义头，dev server 只认同源普通请求。
          const upstream = await fetch(`${options.assets.devServerUrl}${upstreamPath}${search}`);
          // 上游状态码原样透出，404 与 500 的区分交给 dev server。
          if (!upstream.ok) return new Response(null, { status: upstream.status });
          // 读完整个 body 再返回，避免流式响应在 Electron 协议层被截断。
          return new Response(await upstream.arrayBuffer(), {
            // 上游成功统一改写为 status 200，不复制 2xx 的具体码。
            status: 200,
            // 只保留上游的 content-type，其余头由 shellHeaders 接管。
            headers: {
              // 上游缺 content-type 时回退 octet-stream，防止被当 HTML 执行。
              "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
              ...shellHeaders,
            },
          });
        } catch {
          // fetch 抛错（dev server 未起）收敛为 502，与上游 4xx/5xx 可区分。
          return new Response(null, { status: 502 });
        }
      }
      // 打包版根路径固定读 shell HTML，文件名来自常量。
      if (target.pathname === "/" || target.pathname === "/index.html") {
        // shell HTML 走 serveAsset，因此同样受穿越校验与类型白名单约束。
        return serveAsset(options.assets.rendererDir, PLUGIN_SANDBOX_SHELL_HTML_FILE, shellHeaders);
      }
      // 只放行 /assets/ 前缀，其它路径不读 rendererDir。
      if (target.pathname.startsWith("/assets/")) {
        // 去掉开头斜杠后拼相对路径，serveAsset 会再规范化。
        return serveAsset(options.assets.rendererDir, target.pathname.slice(1), shellHeaders);
      }
      // shell 分支未命中的路径直接 404，不回退到插件资源目录。
      return notFound();
    }

    // vendor 分支只对 gen-ui 实例开放，普通插件请求同名路径不会命中。
    if (record.contentKind === "gen-ui" && target.pathname.startsWith("/__zcode__/vendor/")) {
      // 截掉前缀得到相对文件名，交给 hasFile 与 serveAsset 再用。
      const file = target.pathname.slice("/__zcode__/vendor/".length);
      try {
        // 先预检再读，缺失文件返回 404 而不是 500（INV-15）。
        if (!(await vendorResources.hasFile(file))) return notFound();
        // vendor 根固定在 aliasDir/vendor，file 只能是其子路径。
        return serveAsset(join(options.assets.aliasDir, "vendor"), file, {
          // vendor 资源附带实例 CSP，脚本执行权限与文档一致。
          "Content-Security-Policy": record.cspHeader,
        });
      } catch {
        // hasFile 自身异常视为服务端故障，不能伪装成 404 掩盖打包缺件。
        return new Response(null, { status: 500 });
      }
    }
    // 运行时脚本只对 gen-ui 开放，路径固定不可拼接。
    if (record.contentKind === "gen-ui" && target.pathname === "/__zcode__/gen-ui.js") {
      // 从 aliasDir 根读，不经过 vendor 子目录。
      return serveAsset(options.assets.aliasDir, "gen-ui.js", {
        // 运行时脚本同样受实例 CSP 约束，避免放宽到 shell 策略。
        "Content-Security-Policy": record.cspHeader,
      });
    }
    // 别名脚本只对非 gen-ui 实例提供，gen-ui 走自己的运行时注入。
    if (record.contentKind !== "gen-ui" && target.pathname === PLUGIN_SANDBOX_ALIAS_SCRIPT_PATH) {
      // 文件名与注入标签里的路径必须成对，改一处会让脚本 404。
      return serveAsset(options.assets.aliasDir, PLUGIN_SANDBOX_ALIAS_SCRIPT_FILE, {
        // 脚本响应带 CSP，防止被当作文档加载时获得额外权限。
        "Content-Security-Policy": record.cspHeader,
      });
    }
    // 插件文档根路径是唯一返回 HTML 的分支，其余都是静态资源。
    if (target.pathname === "/" || target.pathname === "/index.html") {
      // html 先按 contentKind 二选一，gen-ui 走占位替换，普通插件走别名注入。
      let html =
        record.contentKind === "gen-ui"
          // gen-ui 文档用占位符替换运行时地址，替换不到时页面会缺脚本而非报错。
          ? record.html.replace(
              "__ZCODE_GEN_UI_RUNTIME__",
              `/instance/${record.sandboxId}/__zcode__/gen-ui.js`,
            )
          // 普通插件在 head 顶部注入别名脚本，注入点在函数内统一处理。
          : injectPluginSandboxAliasScript(record.html, record.sandboxId);
      // 只有 gen-ui 才做样式与 kit 注入，普通插件直接返回上面的 html。
      if (record.contentKind === "gen-ui") {
        try {
          // 两份资源并行读取，任一失败都会让整个分支进 catch。
          const [styles, kit] = await Promise.all([
            readAsset(join(options.assets.aliasDir, "visualize.css")),
            readAsset(join(options.assets.aliasDir, "visualize.html")),
          ]);
          // 统一用 TextDecoder 解码，避免 Buffer.toString 在非 UTF-8 内容上静默替换。
          const decode = (value: Uint8Array) => new TextDecoder().decode(value);
          // bridge/Tweak 在作者脚本前，inner kit 在片段后；原手写 Widgets 改变了上游初始化语义。
          html = html.replace(
            "<!--__ZCODE_GEN_UI_STYLES__-->",
            `<style>${decode(styles)}\n:root { --visualize-paint-gutter: 5px; --viz-fg: var(--foreground); }</style>`,
          );
          // 按文档内容判断是否需要日历脚本，判据是原始 html 而不是注入后的 html。
          if (/\bviz-calendar\b/i.test(record.html)) {
            // 日历脚本单独读取并解码，缺失时与其它运行时资源一样进 catch 返回 500。
            const calendar = decode(await readAsset(join(options.assets.aliasDir, "calendar.js")));
            // 把日历脚本内联进 head 末尾，先于 body 脚本执行。
            html = html.replace(
              "</head>",
              `<script>${calendar.replaceAll("</script", "<\\/script")}</script></head>`,
            );
          }
          // kit 槽位标记必须与运行时模板一致，改名会让 lastIndexOf 找不到。
          const marker = "<!--__ZCODE_GEN_UI_INNER_KIT__-->";
          // 取最后一个槽位，保证多槽位模板下替换到最内层（INV-11）。
          const index = html.lastIndexOf(marker);
          // 缺少槽位视为模板损坏，抛错后由 catch 统一转 500。
          if (index < 0) throw new Error("Gen UI document is missing its runtime slot");
          // 按前半加 kit 加滚动条样式加后半拼接，槽位标记本身被替换掉。
          html =
            html.slice(0, index) +
            decode(kit).replace("<!--__INLINE_VISUALIZATION_FRAGMENT__-->", "") +
            // 标签切换的短暂溢出可能在撑高后残留空滚动条；只隐藏根滚动条，不裁切内容或禁用作者滚动区。
            '<style id="zcode-gen-ui-document-scrollbar">html,body{scrollbar-width:none!important}html::-webkit-scrollbar,body::-webkit-scrollbar{display:none!important}</style>' +
            html.slice(index + marker.length);
        } catch {
          // 资源缺失不能返回半成品文档，否则页面看似加载成功但交互静默失效。
          options.logger?.warn("[plugin-sandbox] Gen UI runtime resources unavailable");
          // 资源缺失时返回 500 而不是半成品 HTML，避免交互静默失效（INV-12）。
          return new Response(null, { status: 500 });
        }
      }
      // 最终文档响应，头里同时给出文档 CSP 与插件权限策略。
      return new Response(html, {
        // 只有完整注入成功才走到这里，失败分支已提前返回。
        status: 200,
        // HTML 头必须按类型、CSP、Permissions-Policy、nosniff 顺序固定，后续不得插入其它头。
        headers: {
          // 文档类型固定带 charset，插件 HTML 里的中文不依赖 meta 声明。
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": record.cspHeader,
          "Permissions-Policy": buildPluginSandboxPermissionsPolicy(record.permissions, "plugin"),
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    // 所有已知路径都不匹配时统一回 notFound，不区分不存在与无权限。
    return notFound();
  };

  // 外层包装只做缓存头与日志，真正的分发在 handle 内。
  return async (request) => {
    // 先拿到完整响应再附加头，保证 404 与 500 也带 no-store。
    const response = await handle(request);
    // 稳定 origin 会共享 Chromium 资源缓存；只禁止 HTML 缓存仍会让已载入脚本
    // 绕过后续 guest 归属检查。全部实例响应禁用缓存，浏览器业务存储保持独立语义。
    response.headers.set("Cache-Control", "no-store");
    // 插件文档与别名脚本的请求记 info（shell 静态资源不记），沙箱空白页可据此区分 404 与脚本未跑。
    const isShellAsset = request.url.includes(`://${PLUGIN_SANDBOX_SHELL_HOST_PREFIX}`);
    // shell 静态资源成功时不记日志，避免每个 assets 请求刷屏（INV-18）。
    if (!isShellAsset || response.status >= 400) {
      // 日志行必须包含方法、URL、状态、类型与 CSP，空白页排查靠这一行定位。
      const line = `[plugin-sandbox] ${request.method} ${request.url} -> ${response.status} type=${response.headers.get("Content-Type") ?? ""} csp=${response.headers.get("Content-Security-Policy") ?? ""}`;
      // 4xx 与 5xx 记 warn，保证失败不会被 info 级别过滤掉。
      if (response.status >= 400) options.logger?.warn(line);
      // 成功但非 shell 资源的请求记 info，logger 未提供 info 时静默丢弃。
      else options.logger?.info?.(line);
    }
    // 原样返回已加头的响应，不再复制 body。
    return response;
  };
}

// WeakSet 记录已安装的 protocol 宿主，保证安装与卸载严格配对且幂等。
// 重复安装直接返回，避免第二次 handle 覆盖既有 handler 而无法还原。
// 卸载前先确认 isProtocolHandled，防止对未注册 scheme 调用 unhandle 抛错。
// 宿主被回收后 installedProtocols 条目自动消失，不需要额外清理钩子。
// 改错后果：去掉幂等判断会出现重复注册与悬挂 handler，请求被错误实例接管。
const installedProtocols = new WeakSet<PluginSandboxProtocolHost>();

// 安装函数只做幂等登记与一次 handle，不解析 scheme 以外的参数。
export function installPluginSandboxProtocol(
  // 宿主抽象允许测试传入假 protocol，生产由 Electron 适配。
  protocol: PluginSandboxProtocolHost,
  // handler 必须是纯 Request 到 Response 的映射，安装层不包装异常。
  handler: (request: Request) => Promise<Response>,
): void {
  // 重复安装直接返回，避免第二次 handle 覆盖既有 handler（INV-17）。
  if (installedProtocols.has(protocol)) return;
  // 注册只发生在这里，scheme 固定取自契约常量。
  protocol.handle(PLUGIN_SANDBOX_SCHEME, handler);
  // 登记发生在 handle 之后，handle 抛错时不会留下已安装的假记录。
  installedProtocols.add(protocol);
}

// uninstall 与 install 成对，未登记的宿主直接忽略。
export function uninstallPluginSandboxProtocol(protocol: PluginSandboxProtocolHost): void {
  // 未安装时直接返回，避免对未注册 scheme 调用 unhandle。
  if (!installedProtocols.has(protocol)) return;
  // 先探测再卸载，防止宿主对未注册 scheme 抛错。
  if (protocol.isProtocolHandled(PLUGIN_SANDBOX_SCHEME)) protocol.unhandle(PLUGIN_SANDBOX_SCHEME);
  // 卸载后从 WeakSet 移除登记，允许同一宿主再次安装。
  installedProtocols.delete(protocol);
}
