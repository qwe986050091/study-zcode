// INV-01 每个面板独立游标：守住位置 panes；改错故障 换一批互相干扰。
// INV-02 面板注销即删条目：守住位置 unregister；改错故障 内存与避重集合残留。
// INV-03 修订号单调递增：守住位置 revision；改错故障 订阅方不刷新。
// INV-04 通知逐个调用：守住位置 notify；改错故障 某个订阅异常阻断其他。
// INV-05 订阅返回退订函数：守住位置 subscribe；改错故障 组件卸载后仍被通知。
// INV-06 同 id 同模式直接返回：守住位置 早退分支；改错故障 重建面板丢失游标。
// INV-07 换模式保留游标：守住位置 existing 游标；改错故障 切换布局后候选重头开始。
// INV-08 注册后立即选批：守住位置 selectForPane；改错故障 首次渲染为空。
// INV-09 避重只看同模式面板：守住位置 usedByOtherPanes；改错故障 办公与编码互相耗尽。
// INV-10 三个集合同时避重：守住位置 返回元组；改错故障 同图标或同插件重复出现。
// INV-11 插件标识来自稳定字段：守住位置 pluginIds；改错故障 同插件不同提示共存。
// INV-12 旧式插件标记也解析：守住位置 文本匹配；改错故障 历史提示绕过避重。
// INV-13 图标键优先 URL：守住位置 iconKey；改错故障 同名图标被误判相同。
// INV-14 环形候选自游标开始：守住位置 取模；改错故障 换一批总从首项开始。
// INV-15 每批最多三个：守住位置 上限判断；改错故障 候选区高度失控。
// INV-16 先避重后放宽：守住位置 双层循环；改错故障 候选不足时直接重复。
// INV-17 放宽时仍避免同屏冲突：守住位置 本地集合；改错故障 同批出现重复图标。
// INV-18 选中后回写全局集合：守住位置 末尾循环；改错故障 后续面板无法避重。
//
// 模块职责：维护各面板的建议提示候选与换一批游标。
// 状态所有权：面板表、订阅者与修订号均为模块级状态。
// 阅读顺序：先看面板注册与换批，再看避重集合，最后看候选选择。
import type { DraftSuggestedPromptItem } from "@/v4/draftSuggestedPromptItems.js";
import { getRecommendedPromptPool } from "@/v4/featureSuggestedPrompts.js";

type Mode = "office" | "coding";
type Pane = { mode: Mode; cursor: number; items: DraftSuggestedPromptItem[] };

// panes 按面板 id 保存独立 cursor。
// usedByOtherPanes 只看同 mode 的其他面板。
// panes.delete 成功即删除条目。
const panes = new Map<string, Pane>();
const listeners = new Set<() => void>();
let revision = 0;

// notify 每次把 revision 加一。
// notify 逐个调用 listeners 里的订阅者。
// 通知只携带 revision，不携带快照。
function notify() {
  revision += 1;
  for (const listener of listeners) listener();
}

export function subscribeRecommendedPrompts(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRecommendedPromptsRevision() {
  return revision;
}

// existing.mode === mode 时直接返回，不重建面板。
// existing.cursor 被保留，重启后不回到 0。
// registerRecommendedPromptPane 注册后立即调用 selectForPane。
// 选完立即调用 notify。
export function registerRecommendedPromptPane(id: string, mode: Mode) {
  const existing = panes.get(id);
  if (existing?.mode === mode) return;
  const cursor = existing?.cursor ?? 0;
  const pane: Pane = { mode, cursor, items: [] };
  panes.set(id, pane);
  pane.items = selectForPane(
    getRecommendedPromptPool(mode === "office"),
    cursor,
    ...usedByOtherPanes(id, mode),
  );
  notify();
}

export function unregisterRecommendedPromptPane(id: string) {
  if (panes.delete(id)) notify();
}

export function advanceRecommendedPromptPane(id: string) {
  const pane = panes.get(id);
  if (!pane) return;
  // 每个候选都要有机会成为本批首项；固定跳三格会让避重时跳过的候选永远不可达。
  pane.cursor += 1;
  pane.items = selectForPane(
    getRecommendedPromptPool(pane.mode === "office"),
    pane.cursor,
    ...usedByOtherPanes(id, pane.mode),
    new Set(pane.items.map((item) => item.id)),
  );
  notify();
}

// usedByOtherPanes 只遍历 pane.mode === mode 的面板。
// usedByOtherPanes 分别收集 ids、plugins、icons 并返回三个 Set。
// 三个 Set 在 selectForPane 中用于避重。
// 返回顺序与 selectForPane 的解构顺序一致。
function usedByOtherPanes(id: string, mode: Mode): [Set<string>, Set<string>, Set<string>] {
  const ids = new Set<string>();
  const plugins = new Set<string>();
  const icons = new Set<string>();
  for (const [paneId, pane] of panes) {
    if (paneId === id || pane.mode !== mode) continue;
    for (const item of pane.items) {
      ids.add(item.id);
      icons.add(iconKey(item));
      for (const pluginId of pluginIds(item)) plugins.add(pluginId);
    }
  }
  return [ids, plugins, icons];
}

function pluginIds(item: DraftSuggestedPromptItem): string[] {
  const ids = new Set<string>();
  if (item.plugin) ids.add(item.plugin.stableId);
  for (const prompt of [item.prompt.cn, item.prompt.en]) {
    for (const match of prompt?.matchAll(/\(plugin:\/\/([\w.-]+@[\w.-]+)\)/g) ?? []) {
      if (match[1]) ids.add(match[1]);
    }
  }
  return [...ids];
}

function iconKey(item: DraftSuggestedPromptItem): string {
  return item.iconUrl ?? item.iconName ?? item.plugin?.stableId ?? item.id;
}

// candidates 从 pool[cursor] 起按取模环形展开。
// selected 上限取 Math.min(3, pool.length)。
// 外层遍历 avoidPrevious 与 avoidGlobal 两层开关，从严格避重逐层放宽。
function selectForPane(
  pool: DraftSuggestedPromptItem[],
  cursor: number,
  globalIds: Set<string>,
  globalPlugins: Set<string>,
  globalIcons: Set<string>,
  previousIds: Set<string> = new Set(),
): DraftSuggestedPromptItem[] {
  if (pool.length === 0) return [];
  const selected: DraftSuggestedPromptItem[] = [];
  const localPlugins = new Set<string>();
  const localIcons = new Set<string>();
  const candidates = pool.map((_, index) => pool[(cursor + index) % pool.length]!);

  // 换一批优先全部换新；候选不足时才复用旧条目，并继续尽量保证同屏图标不同。
  for (const avoidPrevious of [true, false]) {
    for (const avoidGlobal of [true, false]) {
      for (const item of candidates) {
        if (selected.length >= Math.min(3, pool.length)) break;
        if (
          selected.some((chosen) => chosen.id === item.id) ||
          ((avoidGlobal || previousIds.size === 0) && globalIds.has(item.id)) ||
          (avoidPrevious && previousIds.has(item.id))
        )
          continue;
        const plugins = pluginIds(item);
        const icon = iconKey(item);
        if (localIcons.has(icon)) continue;
        if (plugins.some((id) => localPlugins.has(id))) continue;
        if (avoidGlobal && (globalIcons.has(icon) || plugins.some((id) => globalPlugins.has(id))))
          continue;
        selected.push(item);
        localIcons.add(icon);
        for (const id of plugins) localPlugins.add(id);
      }
    }
  }
  for (const avoidPrevious of [true, false]) {
    for (const item of candidates) {
      if (selected.length >= Math.min(3, pool.length)) break;
      if (avoidPrevious && previousIds.has(item.id)) continue;
      if (!selected.some((chosen) => chosen.id === item.id)) selected.push(item);
    }
  }
  for (const item of selected) {
    globalIds.add(item.id);
    globalIcons.add(iconKey(item));
    for (const id of pluginIds(item)) globalPlugins.add(id);
  }
  return selected;
}

export function getRecommendedPromptsForPane(id: string, mode: Mode): DraftSuggestedPromptItem[] {
  const pane = panes.get(id);
  if (pane?.mode === mode) return pane.items;
  return selectForPane(
    getRecommendedPromptPool(mode === "office"),
    0,
    ...usedByOtherPanes(id, mode),
  );
}
