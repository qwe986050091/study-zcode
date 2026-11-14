// INV-01 全权模式由哨兵值表达：守住位置 ALL_BOT_WORKSPACES；改错故障 空数组被当成未授权。
// INV-02 访问模式固定两类取值：守住位置 Select value；改错故障 未知值渲染成空白。
// INV-03 全权时计数取全部工作区：守住位置 allowedCount 分支；改错故障 描述里的数量归零。
// INV-04 选中时计数只算现存工作区：守住位置 filter 交集；改错故障 已删除工作区仍被计入。
// INV-05 保存只传两种列表：守住位置 onValueChange；改错故障 混合模式写入非法列表。
// INV-06 无工作区时禁用选择：守住位置 disabled；改错故障 空列表仍能切到选中模式。
// INV-07 加载中禁止交互：守住位置 loading；改错故障 并发提交互相覆盖。
// INV-08 全权模式不渲染明细：守住位置 detail 分支；改错故障 全选状态仍逐项列一遍。
// INV-09 勾选状态来自配置：守住位置 includes；改错故障 本地临时态与服务端脱节。
// INV-10 点击即取反提交：守住位置 onToggleWorkspaceAccess 入参；改错故障 勾选方向与显示相反。
// INV-11 工作区标识用 id：守住位置 key 与比较；改错故障 同名路径互相顶替。
// INV-12 展示名允许重复：守住位置 label 渲染；改错故障 以名称作键引发错位。
// INV-13 路径仅作辅助展示：守住位置 副标题；改错故障 路径被当成身份参与判定。
// INV-14 计数来自服务端配置：守住位置 bot.allowedWorkspaces；改错故障 前端自算产生漂移。
// INV-15 空列表回落到首个工作区：守住位置 切到选中模式；改错故障 选中模式没有可选项。
// INV-16 图标仅作视觉提示：守住位置 勾选框图标；改错故障 无标签按钮失去语义。
// INV-17 文案全部走国际化：守住位置 formatMessage；改错故障 中文硬编码直接透出。
// INV-18 卡片不持有本地状态：守住位置 组件体；改错故障 刷新后回退旧值。
//
// 模块职责：渲染 Bot 的工作区访问范围选择卡与逐项勾选明细。
// 状态所有权：全部来自 bot 配置与父级回调；组件无本地状态。
// 阅读顺序：先看两种模式取值，再看计数与明细渲染，最后看事件回调。
import { Check, LoaderCircle } from "lucide-react";
import type { BotConfig, BotWorkspaceRef } from "@zcode/shared";
import { ALL_BOT_WORKSPACES } from "@zcode/shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";
import { cn } from "@/components/lib/utils.js";
import { isAllWorkspacesAllowed } from "./shared.js";

export function WorkspaceAccessCard({
  bot,
  workspaceRefs,
  loading,
  onPatchAllowedWorkspaces,
  onToggleWorkspaceAccess,
}: {
  bot: BotConfig;
  workspaceRefs: BotWorkspaceRef[];
  loading: boolean;
  onPatchAllowedWorkspaces: (allowedWorkspaces: string[]) => Promise<void>;
  onToggleWorkspaceAccess: (workspaceId: string, checked: boolean) => Promise<void>;
}) {
  // intl 来自 useZCodeIntl()，不新建实例。
  // 文案键集中在 bots.allowedWorkspaces 前缀。
  // 组件不缓存格式化结果。
  // 语言切换随 Provider 重渲染。
  const { intl } = useZCodeIntl();
  // isAllWorkspacesAllowed 只认哨兵值（如 "*"）。
  // 空数组返回 false，表示未授权而非全权。
  // allAllowed 同时驱动下拉值与明细区分支。
  // isAllWorkspacesAllowed 与设置页共用同一实现。
  const allAllowed = isAllWorkspacesAllowed(bot.allowedWorkspaces);
  // 全权时 allowedCount 直接取 workspaceRefs.length。
  // 部分授权时与现存 workspaceRefs 求交集再计数。
  // 已删除的工作区不在 workspaceRefs 里，自然不计入。
  const allowedCount = allAllowed
    ? workspaceRefs.length
    : bot.allowedWorkspaces.filter((workspaceId) =>
        workspaceRefs.some((workspace) => workspace.id === workspaceId),
      ).length;

  // 整卡交给 SettingsRow 排版。
  // label 走 SettingsRow，描述与控件在 children 分区渲染。
  // allAllowed 为真时不渲染明细区。
  return (
    <SettingsRow
      label={intl.formatMessage({ id: "bots.allowedWorkspaces" })}
      description={intl.formatMessage(
        {
          id: allAllowed
            ? "bots.allowedWorkspaces.allDescription"
            : "bots.allowedWorkspaces.selectedDescription",
        },
        { count: String(allowedCount) },
      )}
      control={
        <div className="flex items-center justify-end gap-2">
          {loading ? <LoaderCircle className="size-4 animate-spin text-foreground-subtle" /> : null}
          <Select
            value={allAllowed ? "all" : "selected"}
            onValueChange={(value) => {
              void onPatchAllowedWorkspaces(
                value === "all" ? [ALL_BOT_WORKSPACES] : [workspaceRefs[0]!.id],
              );
            }}
            disabled={loading || workspaceRefs.length === 0}
          >
            <SelectTrigger
              data-testid="bots-project-access-trigger"
              size="lg"
              className="w-48 justify-between"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {intl.formatMessage({
                  id: "bots.allowedWorkspaces.mode.all",
                })}
              </SelectItem>
              <SelectItem value="selected">
                {intl.formatMessage({
                  id: "bots.allowedWorkspaces.mode.selected",
                })}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      }
      detail={
        allAllowed ? null : (
          <div className="rounded-lg bg-background p-1">
            <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
              {workspaceRefs.map((workspace) => {
                // checked 每次渲染由 bot.allowedWorkspaces.includes 重算。
                // 组件不维护本地勾选 Set，避免与配置源双写。
                // onClick 调 onToggleWorkspaceAccess，由父级回写配置。
                const checked = bot.allowedWorkspaces.includes(workspace.id);
                return (
                  <button
                    key={workspace.id}
                    type="button"
                    className="flex min-w-0 items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => void onToggleWorkspaceAccess(workspace.id, !checked)}
                    disabled={loading}
                    title={workspace.label}
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center">
                      <div
                        className={cn(
                          "flex size-4 items-center justify-center rounded-sm border",
                          checked
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-input-border bg-input text-transparent",
                        )}
                      >
                        <Check className="size-3.5" />
                      </div>
                    </span>
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="truncate text-ui-base font-medium text-foreground">
                        {workspace.label}
                      </div>
                      <div className="truncate font-mono text-ui-base text-foreground-subtlest">
                        {workspace.workspacePath}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )
      }
    />
  );
}
