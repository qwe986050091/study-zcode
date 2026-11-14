// INV-01 已存在的技能不可通过卡片切换：守住位置 存在判断；改错故障 已安装项被重复选中。
// INV-02 点击交互控件不得冒泡成卡片切换：守住位置 选择器匹配；改错故障 展开描述时误选整卡。
// INV-03 目标节点缺少最近祖先方法时视为可切换：守住位置 函数类型判断；改错故障 纯文本点击失效。
// INV-04 选中态必须同时满足未存在与被选中：守住位置 选中计算；改错故障 已存在项显示勾选。
// INV-05 复选框禁用与卡片可点击保持一致：守住位置 禁用属性；改错故障 卡片可点但控件禁用。
// INV-06 卡片点击读取当前选中态取反：守住位置 切换调用；改错故障 连续点击状态不变。
// INV-07 复选框变更使用实际勾选值：守住位置 事件读取；改错故障 状态与服务端不一致。
// INV-08 空列表渲染统一空态文案：守住位置 空判断；改错故障 出现空白区域。
// INV-09 空态文案键可由调用方覆盖：守住位置 默认参数；改错故障 其他场景无法复用组件。
// INV-10 展开状态是组件本地集合：守住位置 状态初始化；改错故障 展开影响外部选择。
// INV-11 展开切换必须复制集合后再改：守住位置 集合复制；改错故障 原地修改导致不重渲染。
// INV-12 描述展开只影响当前条目：守住位置 按标识判断；改错故障 展开一个条目全部同时展开。
// INV-13 标签通过标识与复选框关联：守住位置 关联属性；改错故障 读屏读不出名称。
// INV-14 展开按钮必须报告展开状态：守住位置 展开状态属性；改错故障 读屏无法感知折叠。
// INV-15 展开按钮必须带可切换的读屏标签：守住位置 标签条件；改错故障 按钮名称始终是展开。
// INV-16 展开按钮必须标记为卡片内动作：守住位置 数据属性；改错故障 点击冒泡回卡片。
// INV-17 折叠态依赖单行截断而不是块级显示：守住位置 类名条件；改错故障 折叠仍显示多行。
// INV-18 目录名允许任意位置换行：守住位置 换行类名；改错故障 长目录撑破卡片。
//
// 模块职责：渲染远程技能同步候选列表，支持整卡选中与描述展开。
// 状态所有权：选中集合由调用方持有；描述展开集合由组件本地持有。
// 阅读顺序：先看点击命中判定，再读空态与卡片切换，最后看展开与无障碍属性。
import { useState, type MouseEvent } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { SkillSyncCandidate } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface RemoteSkillSyncRow {
  candidate: SkillSyncCandidate;
  exists: boolean;
}

const REMOTE_SKILL_SYNC_CARD_ACTION_SELECTOR =
  "button,input,a,textarea,select,label,[data-remote-skill-sync-card-action]";

// shouldToggleRemoteSkillSyncCardSelection 在 exists 为 true 时返回 false，已安装条目不可再切换；target 为空或缺少 closest 方法都按可切换；只有 closest.call(target, REMOTE_SKILL_SYNC_CARD_ACTION_SELECTOR) 命中按钮/input/label 等交互控件时才返回 false，避免点勾选框本身又触发卡片。
export function shouldToggleRemoteSkillSyncCardSelection({
  exists,
  target,
}: {
  exists: boolean;
  target: EventTarget | null;
}): boolean {
  if (exists) {
    return false;
  }
  const closest = (target as { closest?: unknown } | null)?.closest;
  return (
    typeof closest !== "function" || !closest.call(target, REMOTE_SKILL_SYNC_CARD_ACTION_SELECTOR)
  );
}

// RemoteSkillSyncSelectionList 的 rows/selectedIds/onToggle 全部由调用方提供，emptyMessageId 默认 "settings.skills.remoteSync.empty"；expandedDescriptionIds 是组件本地展开态，切换只上报 (skillId, checked)，组件不修改 selectedIds。
export function RemoteSkillSyncSelectionList({
  rows,
  selectedIds,
  emptyMessageId = "settings.skills.remoteSync.empty",
  onToggle,
}: {
  rows: readonly RemoteSkillSyncRow[];
  selectedIds: ReadonlySet<string>;
  emptyMessageId?: string;
  onToggle: (skillId: string, checked: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const [expandedDescriptionIds, setExpandedDescriptionIds] = useState<Set<string>>(new Set());

  // toggleDescription 用 setExpandedDescriptionIds((current) => ...) 先 new Set(current) 再 has/delete/add，返回新集合触发重渲染；直接改 current 不会更新引用，描述展开状态不会变化。
  const toggleDescription = (skillId: string) => {
    setExpandedDescriptionIds((current) => {
      const next = new Set(current);
      if (next.has(skillId)) {
        next.delete(skillId);
      } else {
        next.add(skillId);
      }
      return next;
    });
  };

  // rows.length === 0 时只渲染 div.rounded-lg 内的 intl.formatMessage({ id: emptyMessageId })，不渲染复选框也不进入选中逻辑；容器与卡片用同一套 border/bg-surface 样式，避免空态与列表态跳变。
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: emptyMessageId })}
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      {rows.map((row) => {
        const checkboxId = `remote-skill-sync-${row.candidate.id}`;
        const labelId = `${checkboxId}-label`;
        const descriptionExpanded = expandedDescriptionIds.has(row.candidate.id);
        const selected = !row.exists && selectedIds.has(row.candidate.id);
        // handleCardClick 先调 shouldToggleRemoteSkillSyncCardSelection({ exists: row.exists, target: event.target })，false 立即 return；允许时 onToggle(row.candidate.id, !selected)，selected 由 !row.exists && selectedIds.has(row.candidate.id) 得出，保证已存在条目的勾选态始终为 false。
        const handleCardClick = (event: MouseEvent<HTMLDivElement>) => {
          if (
            !shouldToggleRemoteSkillSyncCardSelection({
              exists: row.exists,
              target: event.target,
            })
          ) {
            return;
          }
          onToggle(row.candidate.id, !selected);
        };

        return (
          <div
            key={row.candidate.id}
            className={`grid grid-cols-[auto_1fr] gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-ui-base ${
              row.exists
                ? "cursor-default"
                : "cursor-pointer hover:border-border-hover hover:bg-surface-hover"
            }`}
            onClick={handleCardClick}
          >
            <input
              id={checkboxId}
              type="checkbox"
              aria-labelledby={labelId}
              className="mt-1 size-4"
              disabled={row.exists}
              checked={selected}
              onChange={(event) => onToggle(row.candidate.id, event.currentTarget.checked)}
            />
            <span className="min-w-0">
              <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                <label id={labelId} htmlFor={checkboxId} className="font-medium text-foreground">
                  {row.candidate.name}
                </label>
                {row.candidate.description ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="size-5 rounded-sm text-foreground-subtle hover:text-foreground"
                    aria-expanded={descriptionExpanded}
                    aria-label={intl.formatMessage({
                      id: descriptionExpanded
                        ? "settings.skills.remoteSync.collapseDescription"
                        : "settings.skills.remoteSync.expandDescription",
                    })}
                    data-remote-skill-sync-card-action="description-toggle"
                    onClick={() => toggleDescription(row.candidate.id)}
                  >
                    {descriptionExpanded ? (
                      <ChevronDown className="size-3.5" aria-hidden="true" />
                    ) : (
                      <ChevronRight className="size-3.5" aria-hidden="true" />
                    )}
                  </Button>
                ) : null}
                {row.exists ? (
                  <span className="text-ui-base text-foreground-subtlest">
                    {intl.formatMessage({ id: "settings.skills.remoteSync.existing" })}
                  </span>
                ) : null}
              </span>
              {row.candidate.description ? (
                <span className="mt-1 block min-w-0">
                  {/* Tailwind v4 下 block 会覆盖 line-clamp 所需的 display:-webkit-box；
                      折叠态不能同时带 block，否则描述仍会按普通文本换行展示。 */}
                  <span
                    className={`text-ui-base text-foreground-subtle ${
                      descriptionExpanded ? "block whitespace-pre-wrap" : "line-clamp-1"
                    }`}
                  >
                    {row.candidate.description}
                  </span>
                </span>
              ) : null}
              <span className="mt-1 block break-all font-mono text-ui-base text-foreground-subtlest">
                {row.candidate.directoryName}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
