// CUA（computer-use）工具调用与“当前 App 列表”快照的纯解析工具。
//
// 职责：从官方 CUA 工具名、工具入参（app_ref/app/target.app_ref）与 list_apps 的
// 混合返回形状中，稳定提取 pid / bundleId / AppIdentity。全部是无副作用纯函数：
// 不缓存快照、不写事件；快照本身由调用方在每次 list_apps 成功后重建。
// 口径：pid 是首选身份（进程级精确），bundleId 只在快照内唯一匹配时才认；
// 解析失败一律返回 null/undefined，由上层按“未知 App”处理，不猜进程。
import type { CuaAppIdentity } from "@zcode/shared/zcode-protocol-v4";

const OFFICIAL_CUA_PREFIXES = [
  "mcp__computer-use__",
  "mcp__plugin_zcode-cua_computer-use__",
] as const;

/**
 * 从 MCP 工具名剥离官方 CUA 前缀，得到动作名（如 request_access / list_apps）。
 * 输入是完整工具名；非官方前缀（第三方同名工具）一律返回 null，避免误判权限语义。
 */
export function readOfficialCuaAction(toolName: string): string | null {
  const prefix = OFFICIAL_CUA_PREFIXES.find((candidate) => toolName.startsWith(candidate));
  return prefix ? toolName.slice(prefix.length) : null;
}

// 只接受普通对象：数组与 null 都不是合法的结构化入参。
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// app_ref 既可能是对象，也可能是 JSON 字符串（MCP 参数常被字符串化），两种都归一为对象。
function asAppRef(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") return asRecord(parseJson(value));
  return asRecord(value);
}

/**
 * 从工具入参读取目标进程 pid。
 * 探测顺序：app_ref → app → target.app_ref（覆盖官方工具的几种入参写法）；
 * 只接受正整数整数，字符串数字与 0/负数视为未知。
 */
export function readCuaInputPid(input: unknown): number | null {
  const root = asRecord(input);
  const candidates = [root?.app_ref, root?.app, asRecord(root?.target)?.app_ref];
  for (const candidate of candidates) {
    const pid = asAppRef(candidate)?.pid;
    if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

/**
 * 从同一组入参位置读取 bundleId，作为没有 pid 时的次级身份；空串/纯空白视为未知。
 */
export function readCuaInputBundleId(input: unknown): string | null {
  const root = asRecord(input);
  const candidates = [root?.app_ref, root?.app, asRecord(root?.target)?.app_ref];
  for (const candidate of candidates) {
    const bundleId = asAppRef(candidate)?.bundle_id;
    if (typeof bundleId === "string" && bundleId.trim()) return bundleId.trim();
  }
  return null;
}

/**
 * 用 list_apps 快照把工具入参解析成具体 App 身份。
 * 输入：原始入参与“pid → AppIdentity”快照；输出：命中的身份或 undefined。
 * 优先级：有 pid 就只按 pid 精确查（快照里没有即未知，不回退 bundleId）；
 * 无 pid 才按 bundleId 匹配，且要求快照内唯一；不唯一或为空均返回 undefined。
 * 纯查表，不刷新快照、不产生副作用。
 */
export function resolveCuaAppIdentity(
  input: unknown,
  snapshot: ReadonlyMap<number, CuaAppIdentity>,
): CuaAppIdentity | undefined {
  const pid = readCuaInputPid(input);
  if (pid !== null) return snapshot.get(pid);
  const bundleId = readCuaInputBundleId(input);
  if (!bundleId) return undefined;
  const matches = [...snapshot.values()].filter((app) => app.bundleId === bundleId);
  // 同一 bundle 可能存在多个进程；没有 PID 时不能猜测具体进程身份。
  return matches.length === 1 ? matches[0] : undefined;
}

// MCP 文本结果常在 JSON 后追加 "Structured content:" 段；只解析第一段，避免整体解析失败。
function parseJson(value: string | undefined): unknown {
  if (!value) return undefined;
  const candidate = value.split("\n\nStructured content:", 1)[0]?.trim();
  if (!candidate) return undefined;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

// App 列表可能出现在数组、{apps}、{result: 数组}、{result: JSON 字符串} 等形状；
// 递归剥壳直到拿到数组，拿不到返回 null（由上层判定快照解析失败）。
function unwrapApps(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record) return null;
  if (Array.isArray(record.apps)) return record.apps;
  if (typeof record.result === "string") return unwrapApps(parseJson(record.result));
  return unwrapApps(record.result);
}

/**
 * 解析 list_apps 结果，构建“pid → AppIdentity”快照。
 * 来源优先级：display 为 kind=cua 且带 structuredContent 时优先用它；否则退回正文 content。
 * 口径：只收 pid 为正整数且 name 非空的条目；bundleId 有值才写入（缺省即不带该字段）；
 * 非法条目直接跳过而不是整表失败。返回 null 表示整体不是可识别的列表（调用方应保持旧快照）；
 * 返回空 Map 表示列表确实为空。无 side effect。
 */
export function parseListAppsSnapshot(
  content: string,
  display: unknown,
): Map<number, CuaAppIdentity> | null {
  const displayRecord = asRecord(display);
  const structured =
    displayRecord?.kind === "cua" && typeof displayRecord.structuredContent === "string"
      ? parseJson(displayRecord.structuredContent)
      : undefined;
  const rows = unwrapApps(structured) ?? unwrapApps(parseJson(content));
  if (!rows) return null;
  const snapshot = new Map<number, CuaAppIdentity>();
  for (const value of rows) {
    const record = asRecord(value);
    if (!record) continue;
    const pid = record?.pid;
    const name = typeof record?.name === "string" ? record.name.trim() : "";
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || !name) continue;
    const bundleId =
      typeof record.bundle_id === "string" && record.bundle_id.trim()
        ? record.bundle_id.trim()
        : undefined;
    snapshot.set(pid, { pid, name, ...(bundleId ? { bundleId } : {}) });
  }
  return snapshot;
}
