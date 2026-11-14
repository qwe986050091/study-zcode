/**
 * Android 构建/模拟器默认参数集中定义：API level、build-tools 版本、系统镜像 variant/ABI 与 JDK 主版本。
 *
 * 职责边界：只读取环境变量并给默认值，不校验环境是否满足、不写盘、不启动命令。
 * 输入输出：所有函数返回合法缓存值；优先级为显式环境变量 > 代码默认值。
 * 失败语义：非法值（空串、非正整数）静默回退默认值，避免插件因一个坏环境变量整体不可用。
 * 不变式：默认口径只在本文件维护，其它 provider 必须调用这里，不得各自硬编码版本号。
 */
/**
 * 返回 Android compileSdk 默认级别（35）。
 * 环境变量 ANDROID_PLUGIN_API_LEVEL 仅在为正整数时生效，否则用默认值，供生成项目模板使用。
 */
export function androidApiLevel(): number {
  return intEnv("ANDROID_PLUGIN_API_LEVEL", 35);
}

/**
 * 返回 Gradle buildToolsVersion 默认值（35.0.0），用于生成的模块配置与 SDK 校验。
 */
export function androidBuildToolsVersion(): string {
  return stringEnv("ANDROID_PLUGIN_BUILD_TOOLS_VERSION", "35.0.0");
}

/**
 * 系统镜像 variant（default / google_apis / google_apis_playstore 等），影响是否带 Google 服务。
 * 仅影响 AVD 创建时的 package 选择，不改变已存在 AVD。
 */
export function androidSystemImageVariant(): string {
  return stringEnv("ANDROID_PLUGIN_SYSTEM_IMAGE_VARIANT", "default");
}

/**
 * 系统镜像 ABI。默认按宿主架构推导：arm64 机器用 arm64-v8a，其余用 x86_64，
 * 这样 Apple Silicon 上无需用户额外配置，Intel/AMD 的 Windows/Linux 也能直接创建 AVD。
 */
export function androidSystemImageAbi(): string {
  return stringEnv(
    "ANDROID_PLUGIN_SYSTEM_IMAGE_ABI",
    process.arch === "arm64" ? "arm64-v8a" : "x86_64",
  );
}

/**
 * 组装 sdkmanager/avdmanager 可识别的系统镜像包名：
 * system-images;android-<API>;<variant>;<ABI>。三段分别由上面的函数统一提供，避免调用方手拼字符串。
 */
export function androidSystemImagePackage(): string {
  return `system-images;android-${androidApiLevel()};${androidSystemImageVariant()};${androidSystemImageAbi()}`;
}

/**
 * 生成项目所用 JDK 主版本（默认 17），反射到 Gradle 的 sourceCompatibility 与 preflight 的 Java 检查。
 */
export function javaMajorVersion(): string {
  return stringEnv("ANDROID_PLUGIN_JDK_MAJOR", "17");
}

/**
 * 读取字符串型环境变量：去空白后为空则回退默认值。
 * 空串视为未配置，避免用户导出空变量（常见于 CI）意外覆盖合理默认。
 */
function stringEnv(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value || fallback;
}

/**
 * 读取正整数型环境变量；非法值（NaN、小数、<=0）一律回退默认值。
 * 不做抛错是为了让配置错误只降级当前能力，而不是让整个插件无法启动。
 */
function intEnv(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
