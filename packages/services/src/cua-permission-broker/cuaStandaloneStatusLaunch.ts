// 独立 CUA helper 的状态页启动路径解析：给出可执行 App 的候选与最终选择。
// 候选顺序即优先级：先开发态注入路径，再安装根目录，最后跨环境回退。
// 本文件只做路径选择，不负责启动进程；实际 spawn 由调用方完成。
// 所有选择结果都可能为 null，调用方必须处理找不到 helper 的情况。
import { join } from "node:path";

import { DEV_HELPER_APP_NAME, HELPER_APP_NAME } from "@zcode/zcode-cua/broker/helperConstants";
import {
  isCuaLocalDevelopmentRuntime,
  resolveCuaHelperInstallRoot,
  resolveHelperAppName,
  standaloneHelperCandidatePaths,
} from "@zcode/zcode-cua/broker/server";

// 候选列表来自共享 broker 的 standaloneHelperCandidatePaths，顺序不可重排。
// 开发运行时额外补一个另一种 App 名的回退，便于在 dev/prod 构建之间来回切换调试。
export function resolveStandaloneStatusLaunchCandidates(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
// 复制一份再追加：共享函数返回的数组可能被缓存，直接 push 会污染其他调用方。
  const candidates = [...standaloneHelperCandidatePaths(env)];
  if (isCuaLocalDevelopmentRuntime(env)) {
    const installRoot = resolveCuaHelperInstallRoot(env);
    if (installRoot) {
      const fallbackName =
        resolveHelperAppName(env) === DEV_HELPER_APP_NAME ? HELPER_APP_NAME : DEV_HELPER_APP_NAME;
      candidates.push(join(installRoot, fallbackName));
    }
  }
  return candidates;
}

// 依赖注入形式传入 env、存在性判断与安装动作，便于单测覆盖各分支。
export interface StandaloneStatusLaunchAppPathOptions {
  env: NodeJS.ProcessEnv;
  bundledAppPath: string | undefined;
  exists: (path: string) => boolean;
  ensureInstalled: (bundledAppPath: string) => Promise<string>;
}

// 优先使用打包内置路径：存在即安装并返回安装结果，保证版本与当前客户端一致。
// 内置路径不可用时才回落到候选列表，返回第一个存在的路径，全部不存在则返回 null。
export async function resolveStandaloneStatusLaunchAppPath({
  env,
  bundledAppPath,
  exists,
  ensureInstalled,
}: StandaloneStatusLaunchAppPathOptions): Promise<string | null> {
// ensureInstalled 的返回值而非入参才是最终路径：安装可能落到用户目录。
  if (bundledAppPath && exists(bundledAppPath)) {
    return ensureInstalled(bundledAppPath);
  }
// find 返回 undefined 时统一转成 null，契约里不出现 undefined。
  return resolveStandaloneStatusLaunchCandidates(env).find(exists) ?? null;
}
