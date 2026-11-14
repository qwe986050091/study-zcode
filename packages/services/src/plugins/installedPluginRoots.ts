// 已安装插件根目录读取：数据源是插件安装器维护的 installed_plugins.json。
// 该文件属于外部输入，结构不合法时必须按“无插件”处理，不能抛错阻断服务启动。
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

// 对外契约：只暴露运行时关心的三个字段；rootPath 必须是绝对路径，
// defaultEnabled 统一为 false，安装态默认不启用，需由用户显式开启。
export interface InstalledPluginRoot {
  defaultEnabled: boolean;
  marketplace: string;
  rootPath: string;
}

// 文件名与安装器约定一致，改名会导致读写两侧错位；
// 固定放在插件存储根目录下，不随 marketplace 变化。
const INSTALLED_PLUGINS_FILE = "installed_plugins.json";

// InstalledPluginRecord 比对外结构多一个 id，仅在本文件用于非空校验。
interface InstalledPluginRecord {
  id: string;
  installPath: string;
  marketplace: string;
}

// 读取全部已安装插件根目录；文件缺失或损坏时返回空数组，属于可预期的“未安装”状态。
// 不做去重与排序，保持文件中的原始顺序，避免隐式改变加载优先级；
// readInstalledPluginRoots 不向上抛 IO 异常，防止插件目录问题阻断整个服务。
export async function readInstalledPluginRoots(
  pluginStorageRoot: string,
): Promise<InstalledPluginRoot[]> {
  // pluginStorageRoot 由装配层传入，通常指向用户数据目录；本函数不创建目录也不写回。
  const records = await readInstalledPluginRecords(pluginStorageRoot);
  // 映射只做字段裁剪与默认值填充，不校验重复 id：加载优先级由调用方按顺序决定。
  return records.map((record) => ({
    defaultEnabled: false,
    marketplace: record.marketplace,
    rootPath: record.installPath,
  }));
}

// readInstalledPluginRecords 逐层宽松解析：读文件失败、JSON 解析失败或结构不符合预期时都必须返回空列表。
// 记录级字段 trim 后再校验，必填项缺失或 installPath 非绝对路径的条目直接跳过；
// 严格校验绝对路径的原因：后续直接以 rootPath 作为加载根，相对路径会随 cwd 漂移。
async function readInstalledPluginRecords(
  pluginStorageRoot: string,
): Promise<InstalledPluginRecord[]> {
// 先读原始文本再单独解析，便于把 IO 失败与格式失败分开处理并各自降级。
  let raw: string;
  try {
// installed_plugins.json 可能不存在（首次启动）或不可读（权限不足），两种情况都视为没有已安装插件。
    raw = await readFile(join(pluginStorageRoot, INSTALLED_PLUGINS_FILE), "utf-8");
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    // JSON.parse 只接受严格 JSON；安装器若写入尾逗号会走 catch 并退化为空列表。
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
// 顶层必须是对象且 plugins 为数组；旧版本或手工编辑产生的其它形态一律当空处理。
  if (!isRecord(parsed) || !Array.isArray(parsed.plugins)) {
    return [];
  }

  const records: InstalledPluginRecord[] = [];
// 逐条累积而非 map，遇到非法条目可以静默跳过，保证局部损坏不影响其余插件。
  for (const item of parsed.plugins) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const marketplace =
      typeof item.marketplace === "string" ? item.marketplace.trim() : "";
    const installPath =
      typeof item.installPath === "string" ? item.installPath.trim() : "";
// 单条 InstalledPluginRecord 无效只跳过该条，不影响同一文件中其它合法插件的加载。
    if (!id || !marketplace || !installPath || !isAbsolute(installPath)) {
      continue;
    }
    // records 保持文件顺序，调用方据此决定同名插件的覆盖关系。
    records.push({ id, installPath, marketplace });
  }
  return records;
}

// 判别辅助：排除数组与 null，保证后续属性访问安全。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
