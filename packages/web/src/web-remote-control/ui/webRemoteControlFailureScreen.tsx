// INV-01 失败页不发起任何请求：守住位置 组件体；改错故障 渲染即触发重试风暴。
// INV-02 文案解析是纯函数：守住位置 resolveWebRemoteControlScreenCopy；改错故障 同因不同文案。
// INV-03 语言缺省由解析器兜底：守住位置 locale 入参；改错故障 未知语言渲染空白。
// INV-04 色调只映射样式类：守住位置 resolveToneClassName；改错故障 组件内散落条件类名。
// INV-05 危险态用破坏色：守住位置 danger 分支；改错故障 严重失败被弱化成中性。
// INV-06 警告态用警示色：守住位置 warning 分支；改错故障 可恢复问题看起来不可恢复。
// INV-07 未知色调回落中性：守住位置 default 分支；改错故障 类名缺失导致透明底。
// INV-08 徽标与图标共用色调：守住位置 同一返回值；改错故障 两处配色割裂。
// INV-09 下一步列表保持顺序：守住位置 nextSteps 映射；改错故障 操作指引乱序。
// INV-10 步骤序号由下标生成：守住位置 index 加一；改错故障 序号重复或从零开始。
// INV-11 详情段仅在消息非空时出现：守住位置 failure.message 判断；改错故障 空详情留白框。
// INV-12 详情内容原样展示：守住位置 直接插值；改错故障 错误信息被改写后无法检索。
// INV-13 设备不属主时走换账号弹窗：守住位置 reason 判断；改错故障 用户只能反复刷新。
// INV-14 弹窗确认后统一重载：守住位置 onConfirm 传参；改错故障 换账号后仍停在失败页。
// INV-15 主按钮文案可被覆盖：守住位置 primaryActionLabel；改错故障 特殊场景无法定制。
// INV-16 次按钮完全可选：守住位置 secondaryAction 判断；改错故障 出现无行为的空按钮。
// INV-17 页面撑满动态视口：守住位置 minHeight 样式；改错故障 移动端底部被工具栏遮挡。
// INV-18 卡片宽度受限集中：守住位置 max-w 类；改错故障 宽屏下文本行长失控。
//
// 模块职责：远程控制失败时的整页兜底界面，负责解释原因并给出可执行下一步。
// 状态所有权：无状态；失败对象、语言与回调全部由调用方注入。
// 阅读顺序：先看色调映射，再看文案解析，最后看两类主操作分支。
import { Button } from "@zcode/ui/button";
import type { WebRemoteControlFailure } from "@zcode/shared";
import { WebRemoteControlSwitchAccountDialog } from "#src/web-remote-control/ui/webRemoteControlSwitchAccountDialog.js";

import {
  resolveWebRemoteControlScreenCopy,
  type WebRemoteControlScreenLocale,
  type WebRemoteControlScreenCopy,
} from "#src/web-remote-control/domain/webRemoteControlScreenCopy.js";
export {
  resolveWebRemoteControlScreenCopy,
  resolveWebRemoteControlScreenLocale,
} from "#src/web-remote-control/domain/webRemoteControlScreenCopy.js";

// resolveToneClassName 只接受 tone 枚举里的三种语义色调。
// 返回的 badge 与 icon 来自同一组 CSS 令牌。
// 未知 tone 走 default 分支，落到中性样式。
// 这里只查静态 token，不读主题状态。
// 返回 { badge, icon } 两个字符串字段，形状由调用方约定。
function resolveToneClassName(tone: WebRemoteControlScreenCopy["tone"]): {
  badge: string;
  icon: string;
} {
  switch (tone) {
    case "danger":
      return {
        badge: "border-destructive/30 bg-destructive/10 text-destructive",
        icon: "border-destructive/30 bg-destructive/10 text-destructive",
      };
    case "warning":
      return {
        badge: "border-warning/30 bg-warning/10 text-foreground",
        icon: "border-warning/30 bg-warning/10 text-warning",
      };
    default:
      return {
        badge: "border-border bg-surface text-foreground-subtle",
        icon: "border-border bg-surface text-foreground-subtle",
      };
  }
}

interface WebRemoteControlFailureScreenProps {
  failure: WebRemoteControlFailure;
  locale: WebRemoteControlScreenLocale;
  onReload(): void;
  primaryActionLabel?: string;
  secondaryAction?: { label: string; onClick(): void };
}

// failure.kind 决定文案与操作形态。
// locale 只影响 resolveWebRemoteControlScreenCopy 的解析结果。
// onReload 由宿主注入，组件不自己重载。
// primaryActionLabel 与 secondaryAction 都允许外部覆盖。
// 组件不持有 useState，渲染完全由 props 决定。
export function WebRemoteControlFailureScreen({
  failure,
  locale,
  onReload,
  primaryActionLabel,
  secondaryAction,
}: WebRemoteControlFailureScreenProps) {
  // 先 resolveWebRemoteControlScreenCopy(failure, locale)，再取 tone。
  // 色调取自 copy.tone，不看 failure 的原始字段。
  // 解析失败时解析器自己给兜底文案，这里不再判空。
  // 后续渲染只用 copy 与 toneClassName 两个派生值。
  // resolveToneClassName 是纯函数，重复执行结果一致。
  const copy = resolveWebRemoteControlScreenCopy(failure, locale);
  const toneClassName = resolveToneClassName(copy.tone);

  return (
    <div
      className="flex min-h-screen items-center justify-center bg-background px-4 py-8 text-foreground"
      style={{ minHeight: "100dvh" }}
    >
      <main className="w-full max-w-md rounded-xl border border-card-border bg-card p-5 shadow-sm">
        <div className="flex items-start gap-3">
          <div
            className={`flex size-10 shrink-0 items-center justify-center rounded-lg border text-ui-lg font-semibold ${toneClassName.icon}`}
            aria-hidden="true"
          >
            !
          </div>
          <div className="min-w-0 flex-1">
            <div
              className={`mb-2 inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-ui-xs font-medium ${toneClassName.badge}`}
            >
              <span className="min-w-0 truncate">{copy.badge}</span>
            </div>
            <h1 className="text-ui-lg font-medium text-foreground">{copy.title}</h1>
            <p className="mt-2 text-ui-xs leading-6 text-foreground-subtle">{copy.description}</p>
          </div>
        </div>

        <section className="mt-5 border-t border-border pt-4">
          <h2 className="text-ui-xs font-medium text-foreground">{copy.nextStepsTitle}</h2>
          <ol className="mt-2 space-y-2 text-ui-xs leading-6 text-foreground-subtle">
            {copy.nextSteps.map((step, index) => (
              <li key={step} className="flex gap-2">
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-surface text-ui-xs text-foreground-subtle">
                  {index + 1}
                </span>
                <span className="min-w-0">{step}</span>
              </li>
            ))}
          </ol>
        </section>

        {failure.message ? (
          <section className="mt-4 rounded-lg border border-border bg-surface px-3 py-2.5">
            <div className="text-ui-xs font-medium text-foreground">{copy.detailLabel}</div>
            <div className="mt-1 break-words font-mono text-ui-xs leading-5 text-foreground-subtle">
              {failure.message}
            </div>
          </section>
        ) : null}

        {failure.reason === "device-not-owned" ? (
          <WebRemoteControlSwitchAccountDialog locale={locale} onConfirm={onReload}>
            <Button type="button" className="mt-5 w-full">
              {primaryActionLabel ?? copy.action}
            </Button>
          </WebRemoteControlSwitchAccountDialog>
        ) : (
          <Button type="button" className="mt-5 w-full" onClick={onReload}>
            {primaryActionLabel ?? copy.action}
          </Button>
        )}
        {secondaryAction ? (
          <Button
            type="button"
            variant="ghost"
            className="mt-2 w-full"
            onClick={secondaryAction.onClick}
          >
            {secondaryAction.label}
          </Button>
        ) : null}
      </main>
    </div>
  );
}
