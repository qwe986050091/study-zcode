// session mode 归一化：把历史持久化值与 provider 原生 modeId 对齐到统一枚举。
import type { ZCodeConfigOption, ZCodeProvider, ZCodeTaskMode } from "@zcode/shared";

// 规范 mode 白名单：命中即可直接下发，无需再查 provider 选项。
// 新增规范值必须同时确认各 provider 的映射能力。
// 集合只增不减，删除会让历史会话无法恢复。
const CANONICAL_SESSION_MODES = new Set<ZCodeTaskMode>([
  "default",
  "yolo",
  "guarded",
  "plan",
  "edit",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
  "autoEdit",
  "build",
]);

// 读取可选字符串：空白串归为 undefined。
function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

// mode 选项是 category=mode 的 select，必须同时满足两个条件。
// 返回第一个命中项，配置中不应出现重复 mode 选项。
function getModeConfigOption(options: readonly ZCodeConfigOption[]): ZCodeConfigOption | undefined {
  return options.find((option) => option.category === "mode" && option.type === "select");
}

// 把历史/外部 modeId 映射为规范 mode；无法确定时返回 undefined。
// provider 参数目前不参与判定，保留形参以兼容未来按 provider 分化。
// 映射失败不抛错，由调用方决定回退策略。
function normalizePersistedSessionMode(
  modeId: string | null | undefined,
  _provider?: ZCodeProvider,
): ZCodeTaskMode | undefined {
  const trimmedModeId = readTrimmedString(modeId);
  if (!trimmedModeId) {
    return undefined;
  }

// 规范值优先直接返回，避免被下面的别名分支误改。
  if (CANONICAL_SESSION_MODES.has(trimmedModeId as ZCodeTaskMode)) {
    return trimmedModeId as ZCodeTaskMode;
  }

// 别名表按语义分组：只读、自动编辑、全自动、已下线 agent。
// 每组内不同写法都指向同一个规范 mode。
  switch (trimmedModeId) {
    // Bugfix: provider 原生 modeId 和本地持久化的 session mode 不是一套枚举。
    // 下发前需要把本地语义映射回 provider options 中真实存在的值。
// 只读语义统一映射为 plan，保持“先规划不改文件”的行为。
    case "read-only":
    case "read_only":
      return "plan";
// 自动编辑的多种历史写法统一为 acceptEdits。
    case "auto_edit":
    case "auto-edit":
    case "autoEdit":
    case "accept_edits":
    case "accept-edits":
      return "acceptEdits";
// 全自动映射为 yolo。
    case "full-auto":
    case "full_auto":
      return "yolo";
// 该值来自已下线的第三方 provider，不能映射到任何本地 mode。
// 返回 undefined 让调用方显式回退，而不是猜一个最接近的模式。
    case "agent":
      // 该 modeId 专属于已下线的第三方 provider；不再映射到任何本地 mode。
      return undefined;
// 全访问映射为 bypassPermissions。
    case "agent-full-access":
    case "agent_full_access":
    case "full-access":
    case "full_access":
      return "bypassPermissions";
    default:
      return undefined;
  }
}

// 解析最终下发给 provider 的 modeId：先精确匹配，再按语义匹配。
// 两次都失败返回 undefined，由调用方使用 provider 默认值。
export function resolveProviderModeIdFromConfigOptions(params: {
  configOptions: readonly ZCodeConfigOption[];
  modeId: string | null | undefined;
  provider?: ZCodeProvider;
}): string | undefined {
  const requestedMode = readTrimmedString(params.modeId);
  if (!requestedMode) {
    return undefined;
  }

  const modeOption = getModeConfigOption(params.configOptions);
  const candidates = modeOption?.options ?? [];
// 精确匹配优先：请求值本身就是 provider 认识的值时不做任何转换。
  const exactMatch = candidates.find((candidate) => candidate.value === requestedMode);
  if (exactMatch) {
    return exactMatch.value;
  }

  const requestedPersistedMode = normalizePersistedSessionMode(requestedMode, params.provider);
  if (!requestedPersistedMode) {
    return undefined;
  }

// [契约] 匹配用归一化比较：candidate.value 与 requestedMode 各自规范化后才等值，别名写法不同也能命中。
// 返回值必须取 provider 候选中的原始 value，不能写回规范 mode。
  const semanticMatch = candidates.find(
    (candidate) =>
      normalizePersistedSessionMode(candidate.value, params.provider) === requestedPersistedMode,
  );

  return semanticMatch?.value;
}
