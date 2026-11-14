// INV-01 卸载顺序固定为先解除注册再删目录：守住位置 unregisterInstalledService；改错故障 服务管理器继续拉起孤儿进程。
// INV-02 主描述符不存在也要继续清理别名与旧版：守住位置 条件执行；改错故障 残留服务。
// INV-03 旧版描述符路径按平台固定：守住位置 路径拼接；改错故障 找不到旧注册。
// INV-04 旧版归属判定先做字面匹配再做规范化：守住位置 两级判断；改错故障 符号链接根被误判。
// INV-05 平台只归为 darwin、linux 与 win32：守住位置 平台归一；改错故障 其他平台走到错误分支。
// INV-06 文件存在性检查不得抛错：守住位置 访问捕获；改错故障 权限错误中断卸载。
// INV-07 别名扫描只在服务目录读取成功时进行：守住位置 目录读取捕获；改错故障 目录缺失导致卸载失败。
// INV-08 必须跳过当前描述符与旧版固定条目：守住位置 循环内跳过；改错故障 重复卸载同一服务。
// INV-09 只扫描平台对应后缀：守住位置 后缀判断；改错故障 处理无关文件。
// INV-10 归属比较必须使用规范化根：守住位置 规范化调用；改错故障 同目录不同拼写漏删。
// INV-11 无法解析根的条目直接跳过：守住位置 空值判断；改错故障 误删其他根的服务。
// INV-12 取不到服务名时跳过：守住位置 名称解析；改错故障 用错误名称解除注册。
// INV-13 Windows 根从参数数组的固定标志后读取：守住位置 索引查找；改错故障 读错参数。
// INV-14 Darwin 描述符以 XML 转义形式匹配根：守住位置 转义集合；改错故障 特殊字符根无法匹配。
// INV-15 Linux 描述符按 shell 单引号转义匹配：守住位置 转义替换；改错故障 引号根无法匹配。
// INV-16 描述符名提取按平台分派：守住位置 名称函数；改错故障 卸载目标错误。
// INV-17 归属判断对非 Windows 使用包含匹配：守住位置 分支；改错故障 结构化解析失败。
// INV-18 本模块所有写操作都带强制标志且可重复执行：守住位置 删除调用；改错故障 文件不存在时报错。
//
// 模块职责：卸载已注册的本地服务，并清理别名与旧版遗留描述符。
// 状态所有权：无状态；路径布局由入参提供，服务管理器状态由平台命令维护。
// 阅读顺序：先看卸载主流程，再读平台归一，最后看旧版归属与别名扫描。
import { access, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createDaemonServiceDescriptor,
  createServiceDescriptor,
  serviceDescriptorPath,
  unregisterService,
  type ServicePlatform,
} from "../platform/serviceManager.js";
import { resolveCanonicalServerRoot, type ServerLayout } from "./paths.js";

// 清理顺序固定：currentServicePlatform → createDaemonServiceDescriptor 算出 descriptor/descriptorPath → pathExists(descriptorPath) 为真才 unregisterService → unregisterRootScopedAliasServices → unregisterLegacyServiceForRoot；先解除 OS 注册再删目录，反序会让 launchd/systemd 在目录消失后继续拉起找不到 runtime 的孤儿进程。
// 主描述符不存在也必须执行后两步，否则 root 别名与旧版注册会残留；本函数不返回清理结果，调用方无法据此判断是否真的卸载过。
export async function unregisterInstalledService(layout: ServerLayout): Promise<void> {
  const platform = currentServicePlatform();
  const descriptor = createDaemonServiceDescriptor({ platform, layout });
  const descriptorPath = serviceDescriptorPath(layout, descriptor);
  // 卸载先解除 OS 服务注册，再清理 descriptor/data root；否则 systemd/launchd 可能
  // 在目录删除后继续拉起一个找不到 runtime 的孤儿服务。
  if (await pathExists(descriptorPath)) await unregisterService(descriptor, descriptorPath);
  await unregisterRootScopedAliasServices(layout, platform, descriptorPath);
  await unregisterLegacyServiceForRoot(layout);
}

export async function hasLegacyServiceRegistration(layout: ServerLayout): Promise<boolean> {
  return await resolveLegacyServiceRegistration(layout) !== null;
}

export async function unregisterLegacyServiceForRoot(layout: ServerLayout): Promise<boolean> {
  const legacy = await resolveLegacyServiceRegistration(layout);
  if (!legacy) return false;
  await unregisterService(legacy.descriptor, legacy.descriptorPath);
  await rm(legacy.descriptorPath, { force: true });
  return true;
}

// 旧版路径由平台固定：kind 取 darwin→launchd / linux→systemd / 其余→task-scheduler，descriptorPath = join(layout.serviceDir, `${kind}.service`)；legacyDescriptorBelongsToRoot 返回 false 时整体返回 null，避免删掉别的 serverRoot 的遗留注册。
// 返回的 descriptor 由 createServiceDescriptor 生成，command 固定 join(stableBinDir, win32 ? "zcode.cmd" : "zcode")、args 固定 ["serve","--supervisor","--server-root", layout.serverRoot]，与实际注册一一对应。
async function resolveLegacyServiceRegistration(layout: ServerLayout): Promise<{
  descriptor: ReturnType<typeof createServiceDescriptor>;
  descriptorPath: string;
} | null> {
  const platform = currentServicePlatform();
  const kind = platform === "darwin" ? "launchd" : platform === "linux" ? "systemd" : "task-scheduler";
  const descriptorPath = join(layout.serviceDir, `${kind}.service`);
  if (!await legacyDescriptorBelongsToRoot(descriptorPath, platform, layout.serverRoot)) return null;
  return {
    descriptor: createServiceDescriptor({
      platform,
      command: join(layout.stableBinDir, platform === "win32" ? "zcode.cmd" : "zcode"),
      args: ["serve", "--supervisor", "--server-root", layout.serverRoot],
    }),
    descriptorPath,
  };
}

// 只收敛成 "darwin" | "linux" | "win32"：process.platform 命中前两者原样返回，其余（freebsd/aix 等）统一归为 win32 走 task-scheduler 分支；返回值决定 descriptor 格式，新增平台必须同时改这里与 descriptor 生成。
function currentServicePlatform(): ServicePlatform {
  return process.platform === "darwin" || process.platform === "linux" ? process.platform : "win32";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// 判定顺序：readFile 失败（ENOENT/EACCES）一律 false；先 serviceDescriptorBelongsToRoot 做字面匹配，命中即 true；否则 extractServerRoot 取声明根，取不到就 false；最后比较 resolveCanonicalServerRoot(declaredRoot) === serverRoot，规范化抛错也视为不匹配，避免删掉符号链接根的注册。
async function legacyDescriptorBelongsToRoot(
  descriptorPath: string,
  platform: ServicePlatform,
  serverRoot: string,
): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(descriptorPath, "utf8");
  } catch {
    return false;
  }
  if (serviceDescriptorBelongsToRoot(content, platform, serverRoot)) return true;
  const declaredRoot = extractServerRoot(content, platform);
  if (!declaredRoot) return false;
  try {
    return await resolveCanonicalServerRoot(declaredRoot) === serverRoot;
  } catch {
    return false;
  }
}

// 先定 extension（darwin .plist / linux .service / win32 .json）与 legacyEntry（launchd.service 等固定名），readdir(serviceDir) 失败直接 return；循环里跳过 descriptorPath === currentDescriptorPath、entry === legacyEntry、!entry.endsWith(extension) 三类，再用 extractServerRoot + resolveCanonicalServerRoot 比对 layout.serverRoot。
// 只有 belongs 且 descriptorNameFromContent 取到名称才 unregisterService 再 rm(descriptorPath, { force: true })；规范化抛错时 continue，无法判定归属的条目不删。
async function unregisterRootScopedAliasServices(
  layout: ServerLayout,
  platform: ServicePlatform,
  currentDescriptorPath: string,
): Promise<void> {
  // 过去只按当前拼写的 stablePathId 卸载 descriptor，root 别名留下的旧注册会
  // 在卸载后继续被 launchd/systemd 拉起。扫描同一 service 目录并按 canonical root 比对。
  const extension = platform === "darwin" ? ".plist" : platform === "linux" ? ".service" : ".json";
  const legacyEntry = platform === "darwin" ? "launchd.service" : platform === "linux" ? "systemd.service" : "task-scheduler.service";
  let entries: string[];
  try {
    entries = await readdir(layout.serviceDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const descriptorPath = join(layout.serviceDir, entry);
    if (descriptorPath === currentDescriptorPath || entry === legacyEntry || !entry.endsWith(extension)) continue;
    const content = await readFile(descriptorPath, "utf8").catch(() => null);
    if (!content) continue;
    const declaredRoot = extractServerRoot(content, platform);
    if (!declaredRoot) continue;
    let belongs = false;
    try {
      belongs = await resolveCanonicalServerRoot(declaredRoot) === layout.serverRoot;
    } catch {
      continue;
    }
    if (!belongs) continue;
    const name = descriptorNameFromContent(content, platform, entry);
    if (!name) continue;
    await unregisterService({ kind: platform === "darwin" ? "launchd" : platform === "linux" ? "systemd" : "task-scheduler", name, content }, descriptorPath);
    await rm(descriptorPath, { force: true });
  }
}

function extractServerRoot(content: string, platform: ServicePlatform): string | null {
  if (platform === "win32") {
    try {
      const parsed = JSON.parse(content) as { args?: unknown };
      if (!Array.isArray(parsed.args)) return null;
      const index = parsed.args.indexOf("--server-root");
      return typeof parsed.args[index + 1] === "string" ? parsed.args[index + 1] : null;
    } catch {
      return null;
    }
  }
  const match = platform === "darwin"
    ? content.match(/<string>--server-root<\/string><string>([^<]+)<\/string>/u)
    : content.match(/'--server-root'\s+'((?:[^']|'\\'\\'\\'')*)'/u);
  return match?.[1]?.replaceAll("'\\''", "'") ?? null;
}

function descriptorNameFromContent(content: string, platform: ServicePlatform, entry: string): string | null {
  if (platform === "darwin") return content.match(/<key>Label<\/key><string>([^<]+)<\/string>/u)?.[1] ?? null;
  if (platform === "win32") {
    try {
      const parsed = JSON.parse(content) as { taskName?: unknown };
      return typeof parsed.taskName === "string" ? parsed.taskName : null;
    } catch {
      return null;
    }
  }
  return entry.endsWith(".service") ? entry.slice(0, -".service".length) : null;
}

export function serviceDescriptorBelongsToRoot(
  content: string,
  platform: ServicePlatform,
  serverRoot: string,
): boolean {
  if (platform === "win32") {
    try {
      const parsed = JSON.parse(content) as { args?: unknown };
      if (!Array.isArray(parsed.args)) return false;
      const index = parsed.args.indexOf("--server-root");
      return index >= 0 && parsed.args[index + 1] === serverRoot;
    } catch {
      return false;
    }
  }
  const encodedRoot = platform === "darwin"
    ? serverRoot.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
    : `'${serverRoot.replaceAll("'", "'\\''")}'`;
  return platform === "darwin"
    ? content.includes(`<string>--server-root</string><string>${encodedRoot}</string>`)
    : content.includes(`'--server-root' ${encodedRoot}`);
}
