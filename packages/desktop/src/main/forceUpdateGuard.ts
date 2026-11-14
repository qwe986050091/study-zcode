// INV-01 [启动门] 强更判定必须在创建主窗口之前完成；守住位置：maybeBlockStartupForForceUpdate 的 await 与调用方在建窗前的 await；改错故障：主窗口先出现再被关闭，旧客户端界面短暂可见。
// INV-02 [失败路径] 远端不可用时必须放行启动而不是拉闸；守住位置：resolveDesktopForceUpdateRequirement 的 catch 分支返回 null；改错故障：断网或配置服务抖动导致全体用户无法打开客户端。
// INV-03 [失败路径] 只有 code 为 0 的 envelope 才可信；守住位置：getForceUpdateMinimalVersionFromClientConfig 的 code 判定与抛错；改错故障：错误响应里残留旧 data 被当作新配置，误触发强制升级。
// INV-04 [权衡] 版本比较必须委托 shared 的 resolveForceUpdateRequirement；守住位置：resolveFromConfig 构造 currentVersion 与 minimalVersion；改错故障：本地再写一套比较逻辑，简写版本与预发布版的判断和服务端不一致。
// INV-05 [失败路径] 最低版本缺失时按未命中处理；守住位置：minimalVersion 的三级回落最终落到空串，由 shared 侧空串返回 null；改错故障：空版本被当成最低版本，全量用户被拦在启动页。
// INV-06 [失败路径] 读取远端配置失败必须记 warn 后跳过；守住位置：resolveDesktopForceUpdateRequirement 的 catch 里 logger.warn 与紧随的返回 null；改错故障：异常冒泡到启动流程，主窗口与提示窗口都不会出现。
// INV-07 [资源] 配置请求必须有硬超时；守住位置：fetchRemoteForceUpdateConfig 的 setTimeout 与 FORCE_UPDATE_CONFIG_REQUEST_TIMEOUT_MS；改错故障：远端挂起不返回，启动永久停在强更检查，用户看不到任何界面。
// INV-08 [资源] 超时计时器必须 unref；守住位置：fetchRemoteForceUpdateConfig 里 timer 创建后立即 unref；改错故障：仅剩配置请求存活时进程无法退出，退出流程被 10 秒计时器拖住。
// INV-09 [并发] 请求只能结算一次；守住位置：fail 与 finish 开头的 settled 早退与置位；改错故障：error 与 end 先后触发，同一个 Promise 被二次结算，日志重复且清理次序混乱。
// INV-10 [资源] 结算时必须清计时器并中止请求；守住位置：fail 里的 clearTimeout 与 request 中止调用；改错故障：请求已失败但底层连接与计时器仍存活，进程退出被拖慢。
// INV-11 [资源] 响应体必须限制体积；守住位置：response 的 data 回调里 receivedBytes 与 FORCE_UPDATE_CONFIG_MAX_RESPONSE_BYTES 的比较；改错故障：异常大响应在主窗口创建前撑爆 main 进程内存。
// INV-12 [失败路径] 非 2xx 响应不得进入解析；守住位置：response 回调的 statusCode 区间判断与 fail 早退；改错故障：4xx/5xx 或 HTML 错页被当 JSON 解析，错误信息不可读且可能带出旧配置。
// INV-13 [失败路径] 响应体解析失败必须走 fail；守住位置：end 回调里 JSON 解析外层的 try/catch；改错故障：解析异常逃出 Promise executor，启动流程收到未捕获错误。
// INV-14 [资源] electron 必须动态导入；守住位置：fetchRemoteForceUpdateConfig 内对 net 的动态 import 与 maybeBlockStartupForForceUpdate 内的 app、shell；改错故障：顶层引入 electron，在 app ready 前或单测环境加载即失败。
// INV-15 [契约] 请求 URL 必须带版本与平台查询参数；守住位置：resolveForceUpdateClientConfigUrl 里两次 searchParams 写入；改错故障：服务端无法按版本下发最低可用版本，强更配置永远不命中。
// INV-16 [契约] 命中强更后不能进入主界面；守住位置：maybeBlockStartupForForceUpdate 里 requirement 存在时所有分支最终都走到 app 退出；改错故障：用户处理完弹窗后继续建主窗口，旧客户端被放行。
// INV-17 [失败路径] 手动升级必须只打开下载页不自行安装；守住位置：action 为 manual 时 resolveForceUpdateDownloadUrl 与 shell 外部打开；改错故障：把下载页当安装器执行，或在打开页面前就退出，用户无处下载。
// INV-18 [契约] 弹窗文案必须按 locale 成对维护；守住位置：formatForceUpdateDialogText 的中英两个分支与六字段键集合；改错故障：新增字段只补一侧，另一语言弹窗出现空文案或版本信息缺失。
//
// 模块职责：启动前的强制更新闸门，读取 /api/v1/client/configs，按版本比较决定是否在建主窗口前拦截，并驱动提示窗口与升级动作。
// 状态所有权：本模块不保存跨调用状态，输入全部由 options 注入；判定结果经返回值 blocked 与 onBlocked 回调交还调用方。
// 阅读顺序：先看常量与 URL 构造，再读 envelope 校验和带超时的网络请求，最后沿 resolveDesktopForceUpdateRequirement 读到 maybeBlockStartupForForceUpdate 的拦截分支。
import {
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  ZCODE_VERSION,
  buildZCodeEndpointUrls,
  getForceUpdateMinimalVersionFromConfig,
  resolveForceUpdateRequirement,
  type ForceUpdateRequirement,
  type Locale,
// 从 shared 必须只取默认端点、编译期版本常量、端点拼装工具与强更判定函数，不在 desktop 侧复制版本比较。
// [契约] ForceUpdateRequirement 与 Locale 必须用 type 导入，运行期不加载只含类型的模块。
// 版本常量的唯一来源必须是 shared 的 ZCODE_VERSION，本地不读 package.json，避免产物版本与判定版本脱节。
// autoUpdater 与 forceUpdatePrompt 两个同目录模块必须提供升级执行与提示窗口，本文件只负责编排，不实现下载安装。
// [权衡] electron 不放在顶层导入，net、app、shell 都在使用处动态引入，保证启动早期与单测环境不依赖 Electron 运行时。
} from "@zcode/shared";
import { requestForceAutoUpdate, type ForceAutoUpdateState } from "./autoUpdater.js";
import { showForceUpdatePrompt } from "./forceUpdatePrompt.js";

// ZCODE_CLIENT_CONFIG_API_PATH 是客户端配置端点路径，与服务端路由一一对应，改这里必须同步服务端。
// [资源] FORCE_UPDATE_CONFIG_REQUEST_TIMEOUT_MS 固定 10 秒：超时即放弃远端判定并放行启动，绝不无限等待。
// [资源] FORCE_UPDATE_CONFIG_MAX_RESPONSE_BYTES 固定 1 MiB：配置报文远小于该值，超出即视为异常响应。
// 三个常量都不落配置、不读环境变量，改动必须只影响本地判定行为，重启即生效。
// [权衡] 超时取 10 秒而不是更短：启动阶段网络可能尚未稳定，过短会把可用网络误判为离线。
const ZCODE_CLIENT_CONFIG_API_PATH = "/api/v1/client/configs";
const FORCE_UPDATE_CONFIG_REQUEST_TIMEOUT_MS = 10_000;
const FORCE_UPDATE_CONFIG_MAX_RESPONSE_BYTES = 1024 * 1024;

// ForceUpdateDialogText 的六个字段是提示窗口的输入契约，字段名与 forceUpdatePrompt 的取值键一一对应。
// [契约] ForceUpdateGuardLogger 只约定 info 与 warn：判定失败属于可恢复异常，本模块不产生 error 级日志。
// ForceUpdateGuardResult 的 blocked 是调用方决定是否建主窗口的唯一信号，requirement 只在拦截时可选携带。
// [契约] ForceUpdateGuardOptions 全部依赖注入：locale、logger、endpointOrigin、fetchRemoteConfig、requestAutoUpdate、onBlocked。
// [权衡] fetchRemoteConfig 与 requestAutoUpdate 必须可选，便于测试与调用方替换实现，缺省时分别回落到 net 请求与内置升级器。
// onBlocked 只做通知，不参与判定：调用方在回调里标记主窗口禁止创建，判定本身仍以返回值的 blocked 为准。
export interface ForceUpdateDialogText {
  title: string;
  message: string;
  detail: string;
  autoUpdateButton: string;
  manualUpdateButton: string;
  quitButton: string;
}

export interface ForceUpdateGuardLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export interface ForceUpdateGuardResult {
  blocked: boolean;
  requirement?: ForceUpdateRequirement;
}

export interface ForceUpdateGuardOptions {
  locale: Locale;
  logger: ForceUpdateGuardLogger;
  endpointOrigin?: string;
  fetchRemoteConfig?: () => Promise<unknown>;
  requestAutoUpdate?: (onStateChange?: (state: ForceAutoUpdateState) => void) => (() => void) | void;
  onBlocked?: (requirement: ForceUpdateRequirement) => void;
}

// [契约] 先用 buildZCodeEndpointUrls 取 origin 再拼固定路径，避免自定义 endpoint 自带路径时出现重复拼接。
// 查询参数必须固定为 app_version 与 platform，前者取编译期版本，后者取 process 的 platform 与 arch 组合。
// [契约] 用 URL 与 searchParams 组装而不是字符串拼接，参数自动编码，平台串里的连字符不会被破坏。
// 函数是纯函数且默认参数为 DEFAULT_ZCODE_ENDPOINT_ORIGIN，测试可覆盖 endpoint 而不触碰全局状态。
// [失败路径] endpointOrigin 非法时构造函数会抛错，调用方在请求 Promise 之外就失败，需要外层 catch 兜底。
export function resolveForceUpdateClientConfigUrl(
  endpointOrigin = DEFAULT_ZCODE_ENDPOINT_ORIGIN,
): string {
  const url = new URL(
    `${buildZCodeEndpointUrls(endpointOrigin).origin}${ZCODE_CLIENT_CONFIG_API_PATH}`,
  );
  url.searchParams.set("app_version", ZCODE_VERSION);
  url.searchParams.set("platform", `${process.platform}-${process.arch}`);
  return url.toString();
}

// 本函数是 envelope 与业务配置之间的唯一适配层，其他位置不再直接读取 configs。
// [失败路径] 非对象或 null 直接返回 undefined，交由后续回落链路处理，不在这里抛错。
// [事务] code 为数字且非 0 时立即抛错：此时 data 不可信，宁可走离线放行也不能拿旧配置触发强更。
// code 缺失或不是数字时不做拦截，继续读取 data 下的 configs，兼容未包 envelope 的测试夹具。
// 真正的最低版本解析复用 shared 的 getForceUpdateMinimalVersionFromConfig，本层只做形状收敛。
function getForceUpdateMinimalVersionFromClientConfig(config: unknown): string | undefined {
  if (typeof config !== "object" || config === null) {
    return undefined;
  }

  const envelope = config as {
    code?: unknown;
    data?: {
      configs?: unknown;
    };
  };
  if (typeof envelope.code === "number" && envelope.code !== 0) {
    // /client/configs 与服务层一样只有 code=0 才可信，避免错误 envelope 携带旧 data 时误触发启动强更。
    throw new Error(`ZCode client config failed: ${envelope.code}`);
  }
  return getForceUpdateMinimalVersionFromConfig(envelope.data?.configs);
}

// [资源] 先看注入实现：fetchRemoteConfig 存在则直接调用，测试无需启动 Electron 网络栈。
// [资源] 默认实现必须动态导入 electron 的 net，用一个 Promise 收敛请求、响应与超时三类事件。
// [并发] settled 是唯一结算闸门：fail 与 finish 都先判 settled 再置位，保证只结算一次。
// [资源] 计时器创建后立刻 unref，避免这条启动期请求成为进程退出的阻碍。
// [失败路径] 状态码非 2xx 立即 fail 并 return，不再注册后续数据回调，错误响应体一律不解析。
// [资源] data 累加前按字节数对照 1 MiB 上限，超限即 fail；end 事件里才做 JSON 解析。
async function fetchRemoteForceUpdateConfig(
  endpointOrigin?: string,
  fetchRemoteConfig?: () => Promise<unknown>,
): Promise<unknown> {
  if (fetchRemoteConfig) {
    return fetchRemoteConfig();
  }

  const { net } = await import("electron");
  return new Promise<unknown>((resolve, reject) => {
    let request: ReturnType<typeof net.request>;
    let timer: ReturnType<typeof setTimeout>;
    let data = "";
    let receivedBytes = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      request?.abort();
      reject(error);
    };

    const finish = (value: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    timer = setTimeout(() => {
      fail(new Error("force update config request timeout"));
    }, FORCE_UPDATE_CONFIG_REQUEST_TIMEOUT_MS);
    timer.unref?.();

    request = net.request(resolveForceUpdateClientConfigUrl(endpointOrigin));
    request.on("response", (response) => {
      const statusCode = response.statusCode ?? 0;
      if (statusCode < 200 || statusCode >= 300) {
        // 启动前强更 gate 不能把 4xx/5xx/HTML 错页当正常配置解析，统一走离线降级路径。
        fail(new Error(`force update config request failed with status ${statusCode}`));
        return;
      }

      response.on("data", (chunk) => {
        receivedBytes += Buffer.byteLength(chunk);
        if (receivedBytes > FORCE_UPDATE_CONFIG_MAX_RESPONSE_BYTES) {
          // 远端配置在主窗口创建前读取，必须限制响应体，避免异常响应撑爆 main 进程内存。
          fail(new Error("force update config response too large"));
          return;
        }
        data += chunk.toString();
      });
      response.on("end", () => {
        try {
          finish(JSON.parse(data));
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      response.on("error", (error) => {
        fail(error instanceof Error ? error : new Error(String(error)));
      });
    });
    request.on("error", (error) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });
    request.end();
  });
}

// 本函数把远端读取、envelope 校验与版本判定串成一条链路，返回 null 表示放行。
// resolveFromConfig 固定 currentVersion 为 ZCODE_VERSION，并让 minimalVersion 依次尝试 client config、整包 config、空串。
// [失败路径] 远端命中即提前 return，不再尝试其他来源，命中优先级由这次 return 的位置决定。
// [失败路径] 读取或解析抛错时只记 warn 并返回 null，这是完全离线不拉闸的唯一实现点。
// [权衡] 远端未命中时直接返回 null 而不保留本地缓存：启动期只判定一次，缓存反而会引入跨版本残留。
// 版本比较必须全权交给 shared 的 resolveForceUpdateRequirement，本函数不解释 semver，只负责拿到候选字符串。
export async function resolveDesktopForceUpdateRequirement(options: {
  logger: ForceUpdateGuardLogger;
  endpointOrigin?: string;
  fetchRemoteConfig?: () => Promise<unknown>;
}): Promise<ForceUpdateRequirement | null> {
  const resolveFromConfig = (config: unknown) =>
    resolveForceUpdateRequirement({
      currentVersion: ZCODE_VERSION,
      forceUpdate: {
        minimalVersion:
          getForceUpdateMinimalVersionFromClientConfig(config) ??
          getForceUpdateMinimalVersionFromConfig(config) ??
          "",
      },
    });

  try {
    const remoteConfig = await fetchRemoteForceUpdateConfig(
      options.endpointOrigin,
      options.fetchRemoteConfig,
    );
    const remoteRequirement = resolveFromConfig(remoteConfig);
    if (remoteRequirement) {
      return remoteRequirement;
    }
  } catch (error) {
    // 预留离线跳过接口：完全离线时先不拉闸，后续可在这里接入显式 offline bypass 策略。
    options.logger.warn("[force-update] 读取远端强制升级配置失败，跳过强制升级校验", { error });
    return null;
  }

  return null;
}

export function resolveForceUpdateDownloadUrl(
  locale: Locale,
  endpointOrigin = DEFAULT_ZCODE_ENDPOINT_ORIGIN,
): string {
  const origin = buildZCodeEndpointUrls(endpointOrigin).origin;
  return locale === "zh-CN" ? `${origin}/cn` : `${origin}/en`;
}

export function formatForceUpdateDialogText(
  requirement: ForceUpdateRequirement,
  locale: Locale,
): ForceUpdateDialogText {
  if (locale === "zh-CN") {
    return {
      title: "需要升级 ZCode",
      message: "当前版本无法继续使用",
      detail: `当前版本：v${requirement.currentVersion}\n最低可用版本：v${requirement.minimalVersion}`,
      autoUpdateButton: "自动升级",
      manualUpdateButton: "手动升级",
      quitButton: "退出",
    };
  }

  return {
    title: "Update ZCode",
    message: "The current version can no longer be used",
    detail: `Current version: v${requirement.currentVersion}\nMinimum supported version: v${requirement.minimalVersion}`,
    autoUpdateButton: "Auto update",
    manualUpdateButton: "Manual update",
    quitButton: "Quit",
  };
}

// 本函数是启动门：拿到 requirement 后先记 warn、再调用 onBlocked，最后才弹提示。
// [事务] 弹窗结果分三支：auto 直接返回 blocked，manual 打开下载页后退出，quit 直接退出，任何分支都不进入主界面。
// [失败路径] 手动升级的下载地址由 resolveForceUpdateDownloadUrl 按 locale 选择 /cn 或 /en，打开失败不会回退到自动升级。
// [契约] 自动升级通过 options.requestAutoUpdate 注入，缺省时回落到 requestForceAutoUpdate 并带上 minimalVersion。
// [失败路径] 结尾统一 app 退出；弹窗或外部打开抛错时 Promise 会拒绝，调用方需要保证进程仍然终止。
export async function maybeBlockStartupForForceUpdate(
  options: ForceUpdateGuardOptions,
): Promise<ForceUpdateGuardResult> {
  const requirement = await resolveDesktopForceUpdateRequirement({
    ...options,
    endpointOrigin: options.endpointOrigin,
  });
  if (!requirement) {
    return { blocked: false };
  }

  options.logger.warn("[force-update] 远端配置要求强制升级，阻止创建主窗口", requirement);
  options.onBlocked?.(requirement);
  const { app, shell } = await import("electron");
  const action = await showForceUpdatePrompt(
    formatForceUpdateDialogText(requirement, options.locale),
    options.locale,
    options.logger,
    {
      startAutoUpdate: (onStateChange) =>
        options.requestAutoUpdate?.(onStateChange) ??
        requestForceAutoUpdate(onStateChange, "force-update", requirement.minimalVersion),
    },
  );
  if (action === "auto") {
    return { blocked: true, requirement };
  }

  if (action === "manual") {
    const url = resolveForceUpdateDownloadUrl(options.locale, options.endpointOrigin);
    options.logger.info(`[force-update] 用户选择手动升级：${url}`);
    await shell.openExternal(url);
  }

  // 强制升级命中后不能进入主界面；非自动升级路径处理完弹窗后退出，避免露出旧客户端功能。
  app.quit();
  return { blocked: true, requirement };
}
