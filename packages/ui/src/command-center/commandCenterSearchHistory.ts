// INV-01 历史按 workspace 分键：守住位置 getHistoryKey；改错故障 多项目共用一份搜索历史。
// INV-02 上限二十条：守住位置 LIMIT 与两处 slice；改错故障 历史无限增长拖慢启动。
// INV-03 存储不可用降级为空：守住位置 getStorage 返回 null；改错故障 SSR 或隐私模式直接崩。
// INV-04 读取失败返回空数组：守住位置 JSON.parse 的 catch；改错故障 一条脏数据丢掉整个面板。
// INV-05 写入失败静默：守住位置 setItem 的 catch；改错故障 配额满时阻断搜索主流程。
// INV-06 每条记录过形状校验：守住位置 isCommandCenterSearchHistoryEntry；改错故障 旧格式混入渲染。
// INV-07 纯前缀符号不入历史：守住位置 ">" "#" "@" 判断；改错故障 历史被单字符占满。
// INV-08 去重忽略大小写：守住位置 toLocaleLowerCase；改错故障 同一查询出现多条。
// INV-09 新记录置顶：守住位置 数组构造顺序；改错故障 最近搜索沉底。
// INV-10 去重只移除同名旧记录：守住位置 filter；改错故障 其它 scope 的历史被误删。
// INV-11 清除即写空数组：守住位置 clear；改错故障 只改内存不落盘，刷新后复活。
// INV-12 键前缀集中一处：守住位置 KEY_PREFIX；改错故障 读写前缀不一致，历史永远读不到。
// INV-13 时间戳本地生成：守住位置 Date.now；改错故障 使用服务端时间导致排序错乱。
// INV-14 模块无 React 依赖：守住位置 纯函数导出；改错故障 非组件环境无法预取历史。
//
// 模块职责：命令中心搜索历史的本地读写、去重、截断与清除。
// 阅读顺序：先看存储与键，再看校验与读取，最后看写入与去重追加。
export type CommandCenterSearchScope = "all" | "commands" | "conversations" | "files";

export interface CommandCenterSearchHistoryEntry {
  query: string;
  scope: CommandCenterSearchScope;
  updatedAt: number;
}

// 历史上限只由 COMMAND_CENTER_HISTORY_LIMIT 一处决定。
const COMMAND_CENTER_HISTORY_LIMIT = 20;
// 键前缀集中一处，避免读写漂移。
const COMMAND_CENTER_HISTORY_KEY_PREFIX = "zcode-command-center-search-history:";

// 无 window 时返回 null，SSR 可用。
function getStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    // 访问本身也可能抛错，所以包在 try 里。
    return window.localStorage;
  } catch {
    return null;
  }
}

function getHistoryKey(workspaceKey: string): string {
  return `${COMMAND_CENTER_HISTORY_KEY_PREFIX}${workspaceKey}`;
}

// isCommandCenterSearchHistoryEntry 对每条记录做形状校验。
function isCommandCenterSearchHistoryEntry(
  value: unknown,
): value is CommandCenterSearchHistoryEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const entry = value as Partial<CommandCenterSearchHistoryEntry>;
  return (
    // query 与时间戳类型必须正确。
    typeof entry.query === "string" &&
    typeof entry.updatedAt === "number" &&
    (entry.scope === "all" ||
      entry.scope === "commands" ||
      entry.scope === "conversations" ||
      entry.scope === "files")
  );
}

export function readCommandCenterSearchHistory(
  workspaceKey: string,
): CommandCenterSearchHistoryEntry[] {
  // getStorage 返回 null 时直接 return []。
  const storage = getStorage();
  if (!storage) {
    return [];
  }

  try {
    // 解析失败与缺键都回落为空。
    const parsed = JSON.parse(storage.getItem(getHistoryKey(workspaceKey)) ?? "[]");
    return Array.isArray(parsed)
      // 先 filter 掉非法项，再用 slice 裁到 HISTORY_LIMIT。
      ? parsed.filter(isCommandCenterSearchHistoryEntry).slice(0, COMMAND_CENTER_HISTORY_LIMIT)
      : [];
  } catch {
    return [];
  }
}

export function writeCommandCenterSearchHistory(
  workspaceKey: string,
  entries: CommandCenterSearchHistoryEntry[],
) {
  const storage = getStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(
      getHistoryKey(workspaceKey),
      // 写入前再 slice 一次，防止外部传入超长数组。
      JSON.stringify(entries.slice(0, COMMAND_CENTER_HISTORY_LIMIT)),
    );
  } catch {
    // 搜索历史只是快捷入口，localStorage 不可用时不应阻断命令中心主流程。
  }
}

export function pushCommandCenterSearchHistory(params: {
  workspaceKey: string;
  query: string;
  scope: CommandCenterSearchScope;
}): CommandCenterSearchHistoryEntry[] {
  const query = params.query.trim();
  // query 为 > 或 # 或 @ 这类纯前缀符号时直接返回旧历史。
  if (!query || query === ">" || query === "#" || query === "@") {
    return readCommandCenterSearchHistory(params.workspaceKey);
  }

  const nextEntry: CommandCenterSearchHistoryEntry = {
    query,
    scope: params.scope,
    updatedAt: Date.now(),
  };
  // dedupeKey 用 toLocaleLowerCase 去重，忽略大小写。
  const dedupeKey = query.toLocaleLowerCase();
  const entries = [
    nextEntry,
    ...readCommandCenterSearchHistory(params.workspaceKey).filter(
      (entry) => entry.query.toLocaleLowerCase() !== dedupeKey,
    ),
  // nextEntry 置顶后整体 slice 到 COMMAND_CENTER_HISTORY_LIMIT。
  ].slice(0, COMMAND_CENTER_HISTORY_LIMIT);
  writeCommandCenterSearchHistory(params.workspaceKey, entries);
  return entries;
}

export function clearCommandCenterSearchHistory(workspaceKey: string) {
  writeCommandCenterSearchHistory(workspaceKey, []);
}
