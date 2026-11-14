// CUA Helper 安装器的架构名归一化包装：上游返回原始架构串，本层统一成 Node 口径。
// 边界：只做字符串/数组归一化与依赖包装，不触碰文件系统与安装流程本身。
// 不变量：installer 拿到的 readExecutableArchs 必须已经归一化，否则 macOS Intel 会被误判不可用；
// 因此唯一装配入口是 createCanonicalCuaHelperInstaller，绕过它直接构造会重新引入该缺陷。
import {
  createCuaHelperInstaller,
  defaultCuaHelperVerifierDependencies,
  type CuaHelperInstaller,
  type CuaHelperInstallerOptions,
} from "@zcode/zcode-cua/broker/server";

type CuaHelperInstallerFactory = (options: CuaHelperInstallerOptions) => CuaHelperInstaller;

// 归一化的唯一目的是跨平台比较相等：调用方统一拿 x64 / arm64 与其他架构名对比。
// 未识别的值原样返回（仅 trim），让上层当作「不匹配」，而不是猜测出一份错误映射。
/**
 * macOS `lipo -archs` 对 Intel 二进制返回 `x86_64`，而 Node 的运行时架构名是 `x64`。
 * 两者表示同一架构；如果直接比较字符串，合法的 Intel Helper 会被误判为不可用。
 */
export function normalizeCuaHelperArch(rawArch: string): string {
  // 比较前统一 trim 与小写；调用方拿到的值可能来自 lipo 或环境变量，大小写不一致会让相等判断失效。
  switch (rawArch.trim().toLowerCase()) {
    case "amd64":
    case "x86_64":
    case "x64":
      return "x64";
    case "aarch64":
    case "arm64":
      return "arm64";
    // 未识别架构原样返回（仅 trim），上层据此判为不匹配，而不是猜测出一份错误映射。
    default:
      return rawArch.trim();
  }
}

// 必须先去重再交给比较逻辑，避免同一二进制被多次探测后产生重复架构项、放大后续比较成本。
export function normalizeCuaHelperArchs(archs: readonly string[]): string[] {
  // 先去重再过滤空串：重复探测会产出重复架构项，空串则不能作为可选架构参与比较。
  return [...new Set(archs.map(normalizeCuaHelperArch).filter(Boolean))];
}

// 包装而非改写：其余 options 与 dependencies 原样透传，保持上游默认行为可预期。
// readExecutableArchs 缺失时回落到默认实现，保证归一化在任何注入组合下都生效。
export function canonicalizeCuaHelperInstallerOptions(
  options: CuaHelperInstallerOptions,
): CuaHelperInstallerOptions {
  // 注入缺失时回落到默认实现的 readExecutableArchs，保证归一化在任何依赖组合下都生效。
  const readExecutableArchs =
    options.dependencies?.readExecutableArchs ??
    defaultCuaHelperVerifierDependencies.readExecutableArchs;
  return {
    ...options,
    dependencies: {
      ...options.dependencies,
      // 上游返回的原始架构串在这里统一成 Node 口径，installer 不再需要认识 x86_64 之类的别名。
      readExecutableArchs: async (executablePath) =>
        normalizeCuaHelperArchs(await readExecutableArchs(executablePath)),
    },
  };
}

// 工厂参数只用于测试替换 installer，归一化本身不能被替换——这正是本模块存在的理由。
export function createCanonicalCuaHelperInstaller(
  options: CuaHelperInstallerOptions,
  createInstaller: CuaHelperInstallerFactory = createCuaHelperInstaller,
): CuaHelperInstaller {
  // 工厂参数只为单测替换 installer；归一化包装始终加在最外层，绕过它构造会重新引入 Intel 误判。
  return createInstaller(canonicalizeCuaHelperInstallerOptions(options));
}
