// INV-01 组件只读迁移状态：守住位置 props.migration；改错故障 引导步骤自己发起探测，与 hook 状态分叉。
// INV-02 可选中要求 supported：守住位置 selected 与 supported 的与；改错故障 缺源文件时仍能勾选。
// INV-03 重新扫描受 loading 约束：守住位置 按钮 disabled；改错故障 连续点击发起多次探测。
// INV-04 错误条独立于卡片：守住位置 卡片外的 error 块；改错故障 探测失败时整步不可操作。
// INV-05 整卡就是切换入口：守住位置 外层 button；改错故障 只有小勾选框可点。
// INV-06 不支持时整卡禁用：守住位置 disabled={!supported}；改错故障 点击无反馈但状态被改。
// INV-07 勾选空态用透明文字：守住位置 text-transparent；改错故障 空态尺寸与选中态不一致。
// INV-08 源与目标路径各一行：守住位置 两个 grid；改错故障 路径挤在一行无法复制。
// INV-09 缺路径回落加载文案：守住位置 两处 ??；改错故障 首帧出现空白单元格。
// INV-10 路径等宽并截断：守住位置 font-mono truncate；改错故障 长路径撑破卡片。
// INV-11 缺源警告只在非加载态：守住位置 双条件；改错故障 扫描中先闪一次警告。
// INV-12 全部文案走 intl：守住位置 所有 formatMessage；改错故障 页面出现硬编码中文。
// INV-13 勾选框无独立点击区：守住位置 内层 div；改错故障 出现两个焦点目标。
// INV-14 不派生额外状态：守住位置 组件内无 useState；改错故障 刷新后选中态与 hook 脱节。
//
// 模块职责：引导流程的 AGENTS.md 迁移步骤，展示路径并允许勾选复制。
// 阅读顺序：先看 supported 与 selected，再看顶部扫描按钮，最后看卡片与警告。
import {
  AlertTriangleIcon,
  CheckIcon,
  FileTextIcon,
  Loader2Icon,
  RefreshCwIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { OnboardingAgentsFileMigrationState } from "@/onboarding/useOnboardingAgentsFileMigration.js";

// 组件只读迁移状态，探测由 hook 负责。
export function OnboardingAgentsFileStep(props: { migration: OnboardingAgentsFileMigrationState }) {
  const { intl } = useZCodeIntl();
  const status = props.migration.status;
  // 严格比较 true，未知状态不算支持。
  const supported = status?.supported === true;
  // status?.supported 不为 true 时 selected 必须为 false，避免选中不可用的迁移项。
  const selected = props.migration.selected && supported;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex shrink-0 items-center justify-end gap-3">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          // 加载中禁止重复触发扫描。
          disabled={props.migration.loading}
          onClick={() => void props.migration.refresh()}
        >
          {props.migration.loading ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <RefreshCwIcon className="size-3.5" />
          )}
          {intl.formatMessage({ id: "settingsSync.action.rescan" })}
        </Button>
      </div>

      {props.migration.error ? (
        <div className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-ui-base text-foreground">
          {intl.formatMessage(
            { id: "onboarding.agentsFile.error" },
            { error: props.migration.error },
          )}
        </div>
      ) : null}

      <button
        type="button"
        // supported 为 false 时 disabled 直接为 true，整卡不可点。
        disabled={!supported}
        // 整卡 button 就是切换入口，onClick 必须调 setSelected(!selected)，不额外渲染按钮。
        onClick={() => props.migration.setSelected(!selected)}
        className="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-background p-4 text-left transition-colors enabled:hover:bg-surface-hover/50 disabled:cursor-not-allowed disabled:opacity-70"
      >
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-5 shrink-0 items-center justify-center">
            <div
              // 用透明文字模拟空图标占位，size-4 尺寸保持不跳动。
              className={`flex size-4 items-center justify-center rounded-sm border ${selected ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-transparent"}`}
            >
              <CheckIcon className="size-3.5" />
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <FileTextIcon className="size-4 shrink-0 text-foreground-subtle" />
              <div className="min-w-0 text-ui-base font-medium text-foreground">
                {intl.formatMessage({ id: "onboarding.agentsFile.copyTitle" })}
              </div>
            </div>
          </div>
        </div>

        <div className="grid min-w-0 gap-2 rounded-lg border border-border bg-surface px-3 py-3 text-ui-base">
          <div className="grid min-w-0 gap-1 sm:grid-cols-[5rem_1fr] sm:items-center">
            <span className="text-foreground-subtle">
              {intl.formatMessage({ id: "onboarding.agentsFile.sourceLabel" })}
            </span>
            <span className="min-w-0 truncate font-mono text-foreground">
              {status?.sourcePath ?? intl.formatMessage({ id: "onboarding.agentsFile.loading" })}
            </span>
          </div>
          <div className="grid min-w-0 gap-1 sm:grid-cols-[5rem_1fr] sm:items-center">
            <span className="text-foreground-subtle">
              {intl.formatMessage({ id: "onboarding.agentsFile.targetLabel" })}
            </span>
            <span className="min-w-0 truncate font-mono text-foreground">
              {status?.targetPath ?? intl.formatMessage({ id: "onboarding.agentsFile.loading" })}
            </span>
          </div>
        </div>

        {!supported && !props.migration.loading ? (
          <div className="flex gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-ui-base leading-6 text-foreground">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning" />
            <span>{intl.formatMessage({ id: "onboarding.agentsFile.missingSource" })}</span>
          </div>
        ) : null}
      </button>
    </div>
  );
}
