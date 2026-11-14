// 窗口级查看状态的 localStorage 持久化：按窗口 key 保存当前文档路径与最近文件列表。
// 边界：只做 JSON 读写与字段校验，不依赖 React；存储键带插件名与 v1 版本，便于整体弃用旧数据。
// 副作用：读写 localStorage；不可用、配额超限或数据损坏时静默降级为空状态/放弃写入，不抛错。
import { kindOf, type DocKind } from "#office/contract.ts";
import { PROFILE } from "#office/profile.ts";

// 窗口级查看状态（当前文件与最近文件列表）的 localStorage 封装。
// 每个窗口一个 key（由外壳传入），全部窗口共享同一个 JSON 对象；写入按最近使用顺序裁剪，
// 存储不可用或配额超限时静默降级（返回空状态 / 放弃写入），不影响查看器本身。
type StoragePort = Pick<Storage, "getItem" | "setItem">;
// 单个窗口的持久状态；全部字段可选，读取时逐字段校验，缺失即视为未设置。
// path 只保存文档路径，kind 只出现在 recent 条目里；两者都由 UI 在写入前校验格式。
export interface WindowState {
  // 窗口当前打开的文档路径；缺失表示没有。
  path?: string;
  // 最近打开列表（保持写入顺序，最新在后）；kind 由创建时校验，读取时会再校验一次。
  recent?: { path: string; kind: DocKind }[];
}
// 存储键带插件名与版本号：profile 隔离不同宿主，v1 便于将来结构变更时弃用旧数据。
const KEY = `${PROFILE.name}:windows:v1`;
// 最多保留的窗口条目数；超出时按插入顺序丢弃最旧的（见 writeWindowState）。
const MAX_WINDOWS = 128;
// 读取整个窗口映射。JSON 非法、类型不对或存储抛错时一律返回空对象，调用方无需防御。
function readAll(storage: StoragePort): Record<string, WindowState> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, WindowState>)
      : {};
  } catch {
    return {};
  }
}
// 读取并清洗单个窗口状态：逐字段做类型校验，非法字段直接丢弃而不是抛出。
// recent 会过滤掉 path 非字符串或 kind 与扩展名不一致的条目（防止旧版本/手改数据导致误判格式）。
// 返回新对象，不返回存储内部引用；任何异常都降级为空状态，调用方无需 try/catch。
export function readWindowState(storage: StoragePort, key: string): WindowState {
  const item = readAll(storage)[key];
  if (!item || typeof item !== "object") return {};
  return {
    ...(typeof item.path === "string" ? { path: item.path } : {}),
    ...(Array.isArray(item.recent)
      ? {
          recent: item.recent.filter(
            (file) => typeof file?.path === "string" && kindOf(file.path) === file.kind,
          ),
        }
      : {}),
  };
}
// 合并写入单个窗口状态（patch 覆盖同名字段），并把该窗口移到映射末尾表示最近使用。
// 超出 MAX_WINDOWS 时删除最旧条目，避免关闭标签页后无限累积；写失败（禁用存储/配额）静默忽略。
// 先读后写：保留其他窗口与 patch 未覆盖的字段；空 patch 也会把当前窗口移到最近使用位置。
export function writeWindowState(storage: StoragePort, key: string, patch: WindowState): void {
  try {
    const items = readAll(storage);
    const value = { ...readWindowState(storage, key), ...patch };
    // 按最近使用顺序保留有限窗口，避免关闭标签页后无限累积独立 localStorage 键。
    delete items[key];
    items[key] = value;
    for (const oldest of Object.keys(items).slice(0, -MAX_WINDOWS)) delete items[oldest];
    storage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* 禁用存储或达到配额时不阻断查看器。 */
  }
}
