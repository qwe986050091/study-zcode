// INV-01 守住 getLatestVersion 每次调用重新解析 endpoint 与通道的位置：改错故障是按旧配置缓存地址或通道，切换环境后仍请求旧清单。
// INV-02 守住 platform 参数取自归一化 releasePlatform 的位置：改错故障是大小写或别名分裂出两套清单，服务端只能命中其中一套。
// INV-03 守住通道映射只认 preview 的位置：改错故障是未知通道被服务端当作实验通道下发，正式用户收到预览产物。
// INV-04 守住请求同时带 accept 头与 X-Platform 的位置：改错故障是服务端回退默认产物，客户端拿到的清单与当前平台不匹配。
// INV-05 守住 X-Device-Mid 仅在去空白后非空时附带的位置：改错故障是空串被当作已绑定设备，灰度名单命中错误。
// INV-06 守住响应体为空立即抛错的位置：改错故障是空字符串继续进入 YAML 解析，后续以 undefined 版本走完下载流程。
// INV-07 守住 version 必须为字符串的校验位置：改错故障是缺版本号时仍返回结果，用坏清单覆盖本地已知版本。
// INV-08 守住返回对象回填 zcodeReleaseChannel 的位置：改错故障是 preview 与 stable 切换时旧请求晚到，覆盖新弹窗内容。
// INV-09 守住 isUseMultipleRangeRequest 固定为 false 的位置：改错故障是清单端点不支持分段时算出错误分片，校验必然失败。
// INV-10 守住 resolveBaseUrl 只由取清单写入的位置：改错故障是相对地址解析到默认端点，产物下载指向错误主机。
// INV-11 守住 linuxExtensions 由同一个 updater 实例派生的位置：改错故障是过滤规则与实际更新器不一致，合法产物被误删。
// INV-12 守住按小写 pathname 匹配扩展名的位置：改错故障是大小写或查询串干扰匹配，过滤后集合为空并中断更新。
// INV-13 守住过滤为空即抛错的位置：改错故障是回退到其他安装格式，跨格式更新装坏机器或留下非法缓存路径。
// INV-14 守住 sha512 或 sha2 缺失即抛错的位置：改错故障是把未校验的包交给安装器，完整性检查形同虚设。
// INV-15 守住 Pacman 下 info.url 只给 basename 的位置：改错故障是完整 URL 被拼进缓存名，产生非法临时路径。
// INV-16 守住 packages 兜底只补首个结果的位置：改错故障是多文件产物被同一份包信息覆盖，其余文件丢失元数据。
// INV-17 守住旧清单 path 字段的兼容分支位置：改错故障是存量客户端直接抛错，失去全部更新能力。
// INV-18 守住通道归一化只认 preview 的位置：改错故障是拼写错误静默启用实验通道，问题只能从线上表现反推。
//
// 模块职责：必须把 electron-updater 的 Provider 契约桥接到 ZCode 的 YAML 清单端点，负责地址构造、响应校验、产物过滤与校验和前置检查。
// 状态所有权：endpoint、通道与 deviceMid 必须归调用方选项所有，resolveBaseUrl 与 linuxExtensions 是实例内派生状态，不落盘不外泄。
// 阅读顺序：先看顶部常量与归一化函数，再看 getLatestVersion 的取数与校验，最后看 resolveManifestFiles 的过滤与失败路径。
import { posix } from "node:path";
import type { CustomPublishOptions, PackageFileInfo } from "builder-util-runtime";
import {
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  normalizeZCodeEndpointOrigin,
  type ElectronReleaseChannel,
} from "@zcode/shared";
import {
  Provider,
  AppImageUpdater,
  DebUpdater,
  RpmUpdater,
  PacmanUpdater,
  type AppUpdater,
  type ResolvedUpdateFileInfo,
  type UpdateFileInfo,
  type UpdateInfo,
} from "electron-updater";
import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider.js";
import { parse as parseYaml } from "yaml";

// 对外契约：清单路径固定为 /api/v1/releases/electron/manifest，与服务端路由一一对应。
// 该常量同时被地址构造与测试引用，单侧改动会让客户端请求落到 404 且静默失去更新。
// accept 头显式列出 yaml 与 text/plain，并用通配兜底，防止网关改写响应类型后请求被拒。
// 请求头与查询参数共同决定服务端返回哪份清单，缺少任一侧都会回退到默认产物。
// 响应体按 YAML 解析而非 JSON，服务端编码格式变更必须在此处同步，否则报错点会落到候选版本阶段。
// 这些常量不含凭据与主机名，端点一律必须在运行时解析，避免把环境地址固化进代码。
export const ELECTRON_MANIFEST_API_PATH = "/api/v1/releases/electron/manifest";

const MANIFEST_ACCEPT_HEADER = "application/x-yaml,text/yaml,text/plain,*/*";

export interface ManifestUpdateProviderOptions extends CustomPublishOptions {
  endpointOrigin?: string;
  manifestUrl?: string;
  deviceMid?: string;
  releasePlatform?: string;
  releaseChannel?: ElectronReleaseChannel;
  resolveEndpointOrigin?: () => string | Promise<string>;
  resolveReleaseChannel?: () => ElectronReleaseChannel | Promise<ElectronReleaseChannel>;
}

// 通道归一化只把 preview 判为实验通道，其余输入一律落到 stable，拼写错误因此不会静默打开实验清单。
// 集中映射 string 到 API 数值，preview 为 3、stable 为 1，避免调用方各自拼数值而分裂出多种写法。
// 服务端按数值识别通道，传通道名会被当作默认值，拿到的是另一条通道的产物。
// 架构映射必须把 arm64 改成 aarch64、x64 改成 x86_64、ia32 改成 x86，未命中时原样透传。
// 平台映射把 win32 改成 windows，darwin 与 linux 保持不变，未命中时原样透传。
// 映射结果同时用于查询参数与请求头，两处必须同源，否则服务端无法定位清单。
function normalizeReleaseChannel(channel: string | null | undefined): ElectronReleaseChannel {
  return channel === "preview" ? "preview" : "stable";
}

function mapReleaseChannelToApiValue(channel: ElectronReleaseChannel): string {
  return channel === "preview" ? "3" : "1";
}

function mapElectronReleaseArch(arch: string): string {
  switch (arch) {
    case "arm64":
      return "aarch64";
    case "x64":
      return "x86_64";
    case "ia32":
      return "x86";
    default:
      return arch;
  }
}

function mapElectronReleasePlatform(platform: NodeJS.Platform): string {
  switch (platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    default:
      return platform;
  }
}

export function getElectronReleasePlatform(
  platform: NodeJS.Platform = process.platform,
  arch = process.env["TEST_UPDATER_ARCH"] || process.arch,
): string {
  return `${mapElectronReleasePlatform(platform)}-${mapElectronReleaseArch(arch)}`;
}

// 该函数是唯一的清单地址构造入口，调用方不得自行拼接查询参数。
// manifestUrl 去空白后非空时整体覆盖，用于灰度或自建镜像，此时不再拼默认路径。
// 否则以归一化后的 endpoint 为基址拼接固定路径，origin 归一化保证协议与斜杠一致。
// platform 与 channel 始终覆盖写入，避免调用方传入的旧参数残留导致通道错配。
// device_mid 只在去空白后非空时附带，空值会被服务端解析成已绑定设备。
// 返回 URL 对象而非字符串，便于调用方直接取 origin 作为后续相对地址的基址。
export function buildElectronManifestUrl(options: {
  endpointOrigin: string;
  manifestUrl?: string;
  platform: string;
  deviceMid?: string;
  channel: ElectronReleaseChannel;
}): URL {
  const url = options.manifestUrl?.trim()
    ? new URL(options.manifestUrl.trim())
    : new URL(ELECTRON_MANIFEST_API_PATH, normalizeZCodeEndpointOrigin(options.endpointOrigin));
  url.searchParams.set("platform", options.platform);
  if (options.deviceMid?.trim()) {
    url.searchParams.set("device_mid", options.deviceMid.trim());
  }
  url.searchParams.set("channel", mapReleaseChannelToApiValue(options.channel));
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

// 清单文件列表优先取 files 数组，数组存在且非空才算有效。
// 旧版清单只给 path 与 sha2 或 sha512，兼容分支必须把它们组装成单文件列表，保留存量客户端的更新能力。
// 两种形态都不满足时抛错，不能返回空数组，否则上游会在无候选文件时走到空指针路径。
// legacy 字段逐个判类型后再带上，避免把 null 当成有效校验和写进结果。
// 错误信息带固定前缀，便于日志检索与测试断言区分清单结构问题与其他失败。
// 该函数只做结构归一，不校验扩展名与主机，产物可用性必须在后续解析阶段才判断。
function readManifestFileList(updateInfo: UpdateInfo): UpdateFileInfo[] {
  if (Array.isArray(updateInfo.files) && updateInfo.files.length > 0) {
    return updateInfo.files;
  }

  const legacyInfo = updateInfo as UpdateInfo & {
    path?: unknown;
    sha2?: unknown;
    sha512?: unknown;
  };
  if (typeof legacyInfo.path === "string") {
    return [
      {
        url: legacyInfo.path,
        ...(typeof legacyInfo.sha2 === "string" ? { sha2: legacyInfo.sha2 } : {}),
        ...(typeof legacyInfo.sha512 === "string" ? { sha512: legacyInfo.sha512 } : {}),
      } as UpdateFileInfo,
    ];
  }

  throw new Error("Manifest update info does not contain files or path");
}

function resolveManifestUrl(pathname: string, baseUrl: URL): URL {
  return new URL(pathname, baseUrl);
}

// 扩展名列表必须按 updater 实例类型派生，各自对应自己的产物后缀，避免把所有 Linux 包当成同一种格式。
// 复用 electron-updater 已创建的实例，重新读取安装类型会产生第二套结论，导致过滤规则与实际更新器不一致。
// 返回 null 表示无需过滤，此时保留上游原有行为，不在这里替调用方猜测平台。
function getLinuxUpdateExtensions(updater: AppUpdater): readonly string[] | null {
  // Linux 的实际更新器由安装包类型决定，不能把 deb/rpm/pacman 统一当作
  // 不支持更新的产物删除；复用已有 updater 实例，避免再次读取安装类型产生分歧。
  if (updater instanceof AppImageUpdater) return [".appimage"];
  if (updater instanceof DebUpdater) return [".deb"];
  if (updater instanceof RpmUpdater) return [".rpm"];
  if (updater instanceof PacmanUpdater) return [".pkg.tar.zst", ".pacman"];
  return null;
}

// 扩展名过滤必须按小写 pathname 判断，查询串与大小写不参与匹配，避免合法产物被误删。
// 过滤后为空必须抛错，禁止回退到其他安装格式的包，跨格式更新会装坏机器或留下非法缓存路径。
// 校验和缺失时在解析边界抛错，让失败发生在下载前，而不是下载后无法验证时才发现。
// Pacman 下只把 basename 交给 info.url，完整 URL 会被拼进缓存名并产生非法临时路径。
// packages 兜底只补第一个结果并解析成绝对 href，避免相对路径被下游当成本地文件路径。
function resolveManifestFiles(
  updateInfo: UpdateInfo,
  baseUrl: URL,
  linuxExtensions: readonly string[] | null,
): ResolvedUpdateFileInfo[] {
  const updateFiles = readManifestFileList(updateInfo).filter((file) => {
    const pathname = resolveManifestUrl(file.url, baseUrl).pathname.toLowerCase();
    return !linuxExtensions || linuxExtensions.some((extension) => pathname.endsWith(extension));
  });
  // 缺少当前格式时，上游 findFile 会回退其他包或返回 undefined，
  // 随后报非法缓存路径/TypeError；在解析边界失败，禁止跨安装格式更新。
  if (updateFiles.length === 0) {
    throw new Error(`Manifest contains no update file for ${linuxExtensions?.join(" / ")}`);
  }
  const resolved: ResolvedUpdateFileInfo[] = updateFiles.map((fileInfo) => {
    if (!fileInfo.sha512 && !("sha2" in fileInfo && fileInfo.sha2)) {
      throw new Error(`Manifest file is missing checksum: ${fileInfo.url}`);
    }

    const url = resolveManifestUrl(fileInfo.url, baseUrl);
    // PacmanUpdater 仍用 .pacman 后缀识别缓存名，.pkg.tar.zst 会退回
    // info.url；只给缓存提供文件名，避免完整 URL 被拼进 pending/temp-https:/...。
    const info = linuxExtensions?.includes(".pkg.tar.zst")
      ? { ...fileInfo, url: posix.basename(decodeURIComponent(url.pathname)) }
      : fileInfo;
    return {
      url,
      info,
    } satisfies ResolvedUpdateFileInfo;
  });

  const packages = isRecord((updateInfo as { packages?: unknown }).packages)
    ? ((updateInfo as { packages?: Record<string, PackageFileInfo> }).packages ?? null)
    : null;
  const packageInfo = packages?.[process.arch] ?? packages?.ia32;
  if (packageInfo && resolved[0]) {
    resolved[0].packageInfo = {
      ...packageInfo,
      path: resolveManifestUrl(packageInfo.path, baseUrl).href,
    };
  }

  return resolved;
}

// 实例状态只有选项、releasePlatform、linuxExtensions 与 resolveBaseUrl，均为构造期派生或取数时写入。
// releasePlatform 优先用调用方显式值，其次按当前平台与架构推导，二者不能在同一次更新内混用。
// getLatestVersion 每次调用都重新解析 endpoint 与通道，保证设置变更后下一次检查立即生效。
// resolveBaseUrl 在取到清单地址后改写为清单主机根路径，供后续相对地址解析使用。
// resolveFiles 只读取 resolveBaseUrl，因此必须先完成取清单，否则相对 URL 会指向构造期的默认端点。
// zcodeReleaseChannel 随 UpdateInfo 回填，避免 preview 与 stable 切换时旧请求晚到并覆盖新弹窗。
export class ManifestUpdateProvider extends Provider<UpdateInfo> {
  private readonly options: ManifestUpdateProviderOptions;
  private readonly releasePlatform: string;
  private readonly linuxExtensions: readonly string[] | null;
  private resolveBaseUrl = new URL(DEFAULT_ZCODE_ENDPOINT_ORIGIN);

  constructor(
    options: ManifestUpdateProviderOptions,
    updater: AppUpdater,
    runtimeOptions: ProviderRuntimeOptions,
  ) {
    super(runtimeOptions);
    this.options = options;
    this.linuxExtensions = getLinuxUpdateExtensions(updater);
    this.releasePlatform = options.releasePlatform?.trim() || getElectronReleasePlatform();
    this.resolveBaseUrl = new URL(
      normalizeZCodeEndpointOrigin(options.endpointOrigin ?? DEFAULT_ZCODE_ENDPOINT_ORIGIN),
    );
  }

  override get isUseMultipleRangeRequest(): boolean {
    return false;
  }

  override async getLatestVersion(): Promise<UpdateInfo> {
    const endpointOrigin = await this.resolveEndpointOrigin();
    const releaseChannel = await this.resolveReleaseChannel();
    const manifestUrl = buildElectronManifestUrl({
      endpointOrigin,
      manifestUrl: this.options.manifestUrl,
      platform: this.releasePlatform,
      deviceMid: this.options.deviceMid,
      channel: releaseChannel,
    });
    this.resolveBaseUrl = new URL("/", manifestUrl);
    const releaseChannelApiValue = mapReleaseChannelToApiValue(releaseChannel);

    const raw = await this.httpRequest(manifestUrl, {
      accept: MANIFEST_ACCEPT_HEADER,
      "X-Platform": this.releasePlatform,
      "X-Release-Channel": releaseChannelApiValue,
      ...(this.options.deviceMid?.trim() ? { "X-Device-Mid": this.options.deviceMid.trim() } : {}),
    });
    if (!raw) {
      throw new Error(`Empty electron update manifest: ${manifestUrl.toString()}`);
    }

    const parsed = parseYaml(raw);
    if (!isRecord(parsed) || typeof parsed.version !== "string") {
      throw new Error(`Invalid electron update manifest: ${manifestUrl.toString()}`);
    }

    return {
      ...(parsed as unknown as UpdateInfo),
      // Bugfix: preview/stable 切换时旧 manifest 请求可能晚于新请求返回。
      // electron-updater 的 update-available 事件默认不带请求通道，main 进程无法识别过期结果；
      // 这里把本次请求通道随 UpdateInfo 带回去，避免旧通道覆盖更新弹窗内容。
      zcodeReleaseChannel: releaseChannel,
    } as UpdateInfo;
  }

  override resolveFiles(updateInfo: UpdateInfo): ResolvedUpdateFileInfo[] {
    return resolveManifestFiles(updateInfo, this.resolveBaseUrl, this.linuxExtensions);
  }

  private async resolveEndpointOrigin(): Promise<string> {
    const resolved =
      (await this.options.resolveEndpointOrigin?.()) ??
      this.options.endpointOrigin ??
      DEFAULT_ZCODE_ENDPOINT_ORIGIN;
    return normalizeZCodeEndpointOrigin(resolved);
  }

  private async resolveReleaseChannel(): Promise<ElectronReleaseChannel> {
    const resolved =
      (await this.options.resolveReleaseChannel?.()) ?? this.options.releaseChannel ?? "stable";
    return normalizeReleaseChannel(resolved);
  }
}
