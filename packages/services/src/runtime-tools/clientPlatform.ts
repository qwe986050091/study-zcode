// 职责：把 Node 运行时三元组（process.platform / process.arch）归一为发布产物与客户端配置所用的命名。
// 边界：只做纯字符串映射，不读磁盘、不探测环境能力，因此可在任意宿主平台安全调用。
// INV：映射表是唯一真相，未命中时原样透传平台/架构名，避免新平台被静默改写成错误目标。
// 改错后果：命名漂移会让下载路径与配置目录指向不存在的产物，表现为安装后启动即失败。
const RELEASE_TARGET_MAP: Record<string, string> = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
};

const RELEASE_ARCH_MAP: Record<string, string> = {
  x64: "x86_64",
  arm64: "aarch64",
};

// 测试专用覆盖优先于真实宿主：端到端测试需要在同一台机器上模拟多平台产物选择。
// 空串与纯空白一律视为未设置，防止 CI 里 `VAR=` 这类空值把 override 变成空平台名。
function readOverride(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

// 优先级：override 高于映射表，映射表高于原值；未知平台不抛错，交由下游以产物缺失显式暴露。
export function resolveReleaseTarget(platform: string = process.platform): string {
  const override = readOverride("ZCODE_TEST_RELEASE_TARGET");
  return override ?? RELEASE_TARGET_MAP[platform] ?? platform;
}

// 与 target 独立解析：允许 target 走覆盖而 arch 仍取真实宿主，便于构造交叉产物组合。
export function resolveReleaseArch(arch: string = process.arch): string {
  const override = readOverride("ZCODE_TEST_RELEASE_ARCH");
  return override ?? RELEASE_ARCH_MAP[arch] ?? arch;
}

// 结果形如 darwin-x86_64：分隔符只在此处拼接，避免各调用方各自拼出不一致的配置键。
export function resolveClientConfigPlatform(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  const override = readOverride("ZCODE_TEST_CLIENT_CONFIG_PLATFORM");
  return override ?? `${resolveReleaseTarget(platform)}-${resolveReleaseArch(arch)}`;
}
