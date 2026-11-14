// endpoint routing 请求来源头。
//
// 与 model-config 的同步 headers 不同，这里额外读取 Desktop 管理的 deviceMid（遥测状态文件）。
// 设备身份归 Desktop telemetry 所有：Agent 只复用已存在的值，不创建、不修改、不落盘。
// 读取失败（文件缺失/损坏/权限/非法字符）一律静默降级为 undefined，绝不因此阻断模型请求。
import { readFile } from "node:fs/promises";
import { arch as readOsArch, homedir, release as readOsRelease } from "node:os";
import { join } from "node:path";
import {
  buildZCodeSourceHeadersFromContext,
  resolveRuntimeZCodeEndpointOrigin,
  resolveRuntimeZCodeEnv,
  ZCODE_APP_VERSION_ENV,
} from "@zcode/shared";
import type { ModelProviderSourceTitle } from "./model-config.js";

const ZCODE_DATA_BASE_DIR_ENV_KEY = "ZCODE_DATA_BASE_DIR";
const cachedDeviceMidByStateFile = new Map<string, string>();

interface CreateProviderEndpointRoutingSourceHeadersOptions {
  appVersion?: string;
  env?: NodeJS.ProcessEnv;
  sourceTitle?: ModelProviderSourceTitle;
}

/**
 * 生成一组来源头：版本、平台/架构、语言/时区、deviceMid、端点 origin、发布渠道与来源标签。
 *
 * - appVersion 优先 env[ZCODE_APP_VERSION_ENV]，其次 options.appVersion（最终由 shared 归一化）；
 * - deviceMid 异步读取，失败即为 undefined，不补随机值（否则会伪造新设备）；
 * - sourceTitle 缺省 "cli"（此端口主要给 CLI 侧使用）；
 * - 所有值最终由 shared 的 buildZCodeSourceHeadersFromContext 统一清洗/拼装。
 */
export async function createProviderEndpointRoutingSourceHeaders(
  options: CreateProviderEndpointRoutingSourceHeadersOptions = {},
): Promise<Record<string, string>> {
  const env = options.env ?? process.env;
  const deviceMid = await readExistingDeviceMid(resolveTelemetryStateFile(env));
  return buildZCodeSourceHeadersFromContext({
    appVersion: env[ZCODE_APP_VERSION_ENV] ?? options.appVersion,
    arch: readOsArch(),
    clientLanguage: resolveClientLanguage(),
    clientTimezone: resolveClientTimezone(),
    deviceMid,
    endpointOrigin: resolveRuntimeZCodeEndpointOrigin(env),
    osVersion: readOsRelease(),
    platform: process.platform,
    releaseChannel: resolveRuntimeZCodeEnv(env),
    sourceTitle: options.sourceTitle ?? "cli",
  });
}

function resolveClientLanguage(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale;
}

function resolveClientTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// 数据根优先 ZCODE_DATA_BASE_DIR（测试/多实例隔离），否则用 homedir；
// 固定拼到 .zcode/v2/telemetry-state.json，与 Desktop 的写入位置保持一致。
function resolveTelemetryStateFile(env: NodeJS.ProcessEnv): string {
  const dataBaseDir = env[ZCODE_DATA_BASE_DIR_ENV_KEY]?.trim() || homedir();
  return join(dataBaseDir, ".zcode", "v2", "telemetry-state.json");
}

// 按状态文件路径缓存已读到的 deviceMid：同一进程多次发请求只读一次盘。
// 只接受非空且全为可打印 ASCII（可安全放入 HTTP 头）的值；任何异常都视为「没有」，
// 不记录文件内容，避免把设备身份或损坏的 JSON 写进日志。
async function readExistingDeviceMid(
  stateFile: string,
): Promise<string | undefined> {
  const cached = cachedDeviceMidByStateFile.get(stateFile);
  if (cached) {
    return cached;
  }

  try {
    const parsed = JSON.parse(await readFile(stateFile, "utf8")) as {
      deviceMid?: unknown;
    };
    if (typeof parsed.deviceMid !== "string") {
      return undefined;
    }

    const deviceMid = parsed.deviceMid.trim();
    if (!deviceMid || !/^[\x20-\x7e]+$/.test(deviceMid)) {
      return undefined;
    }

    cachedDeviceMidByStateFile.set(stateFile, deviceMid);
    return deviceMid;
  } catch {
    // deviceMid 由 Desktop telemetry 管理；Agent 只异步复用已存在值，不创建或修改设备身份。
    return undefined;
  }
}
