// INV-01 卡片顺序即论点：守住位置 三段结构；改错故障 数字先于交付物出现。
// INV-02 纯展示不读字节：守住位置 props 边界；改错故障 卡片自己发起请求。
// INV-03 拿不到的格子写破折号：守住位置 parts 为 undefined；改错故障 用零冒充未知。
// INV-04 紧凑计数固定小数位：守住位置 formatCompactCount；改错故障 四格宽度随数据跳动。
// INV-05 千位保留一位小数：守住位置 toFixed；改错故障 读数精度不一致。
// INV-06 百万位保留两位小数：守住位置 第二个分支；改错故障 大数显示过长。
// INV-07 全值放 title：守住位置 title 属性；改错故障 用户看不到精确值。
// INV-08 首帧必须是终值：守住位置 useState 初值；改错故障 静态渲染出现零。
// INV-09 仅在明确允许时翻数字：守住位置 motionAllowed；改错故障 减少动效用户仍看到动画。
// INV-10 问不到媒体查询即落终值：守住位置 环境判断；改错故障 jsdom 下测试抖动。
// INV-11 动画帧在卸载时取消：守住位置 清理函数；改错故障 卸载后仍在 setState。
// INV-12 缓动函数保持单调：守住位置 easeOutCubic；改错故障 数字回跳。
// INV-13 四格共用同一延迟基准：守住位置 figureDelay；改错故障 四格先后错乱。
// INV-14 时长按语言拆分单位：守住位置 workDurationParts；改错故障 单位与语言不匹配。
// INV-15 分隔符随语言变化：守住位置 workDurationUnitSeparator；改错故障 中文出现英文空格。
// INV-16 标签构建只依赖 intl：守住位置 useMemo 依赖；改错故障 切换语言后标签不更新。
// INV-17 布局按截断标志计算：守住位置 useMemo 依赖；改错故障 产物增减后格数不刷新。
// INV-18 头部插槽缺席即不传：守住位置 条件展开；改错故障 空插槽占位。
//
// 模块职责：渲染完成态工作流收据卡，包括交付物、产物索引与四格数字。
// 状态所有权：仅数字翻动是本地动画状态，其余全部由宿主传入。
// 阅读顺序：先看计数格式化，再看数字翻动，最后看卡片组装。
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { buildPresetLabels } from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { workDurationParts, workDurationUnitSeparator } from "@/lib/workDuration.js";
import type { WorkflowCompletionArtifact } from "./WorkflowArtifactTile.js";
import {
  WORKFLOW_RUN_KIND_ID,
  WorkflowCardHeader,
  WorkflowRunStatus,
} from "./WorkflowCardChrome.js";
import {
  completionArtifactCellCount,
  completionArtifactLayout,
  WorkflowCompletionArtifacts,
} from "./WorkflowCompletionArtifacts.js";
import { PILL_STAGGER_MS } from "./WorkflowTimeline.js";

export { COMPLETION_INDEX_MAX } from "./WorkflowCompletionArtifacts.js";

/**
 * 完成卡：主代理消化一条 **completed** 工作流通知的那一轮，
 * 轮尾落下这张卡。顺序即论点——表头 → 这次 run **交付了什么**（交付物行）→ **还做了什么**（产物索引，
 * 一件一行）→ **花了多少**（四格数字）。三段之间各隔一条细线，像一张收据。产物区在 `WorkflowCompletionArtifacts`。
 *
 * 纯展示：产物清单、四个数字、每件产物的预览都由宿主交进来（预览要读字节，那是宿主的活）。
 * 没有 chevron——没有可展开的东西；整卡不是开关。
 *
 * 数字的诚实：拿不到的格写 `—`，不写 0。
 */
export interface WorkflowCompletionFigures {
  durationMs?: number;
  tokens?: number;
  subagents?: number;
  /** 进过的阶段数（`run.phases`）；没有 phase() 标记的脚本拿不到，写 `—`。 */
  phases?: number;
}

export interface WorkflowCompletionCardProps {
  name: string;
  figures: WorkflowCompletionFigures;
  artifacts: readonly WorkflowCompletionArtifact[];
  /** 发射侧砍过：「还有 N 个」的 N 写 `…`。 */
  artifactsTruncated?: boolean;
  /** 画出来的框的预览（只有交付物行有框）；缺席（或回 undefined）即纸页字形。 */
  renderPreview?: (artifact: WorkflowCompletionArtifact) => ReactNode;
  onOpenRun?: () => void;
  onOpenArtifact?: (artifactId: string) => void;
  /**
   * 表头状态之前的插槽：「已保存」芯片（docs/dynamic-workflow/transcript-and-notifications.md
   * 「Saving the run, and running it again」）。宿主建，卡只摆。
   */
  headerLeading?: ReactNode;
  /** 表头 ⤢ 之前的插槽：「保存」/「再次运行」。缺席即这张卡没有会话上下文，或两道门关着。 */
  headerTrailing?: ReactNode;
  testIdKey: string;
}

/** 数字翻上来的时长；四格同一拍，与条上药丸依次落地的节奏相接。 */
const COUNT_UP_MS = 640;

/**
 * tokens 的紧凑写法：`812` / `386.4k` / `1.30M`。千位一位小数、百万两位——固定位数让四格
 * 的等宽数字在 run 与 run 之间对得齐。全值进 title。
 */
// count < 1_000 直接返回 toLocaleString()，不加单位。
// [1e3, 1e6) 先除以 1e3 再 toFixed(1)，单位 "k"。
// >= 1e6 除以 1e6 后 toFixed(2)，单位 "M"。
// formatCompactCount 返回 { value, unit }，数值与单位分开。
export function formatCompactCount(count: number): { value: string; unit: string } {
  if (count < 1_000) return { value: count.toLocaleString(), unit: "" };
  if (count < 1_000_000) return { value: (count / 1_000).toFixed(1), unit: "k" };
  return { value: (count / 1_000_000).toFixed(2), unit: "M" };
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

/** 只在浏览器**明确**说了「不减少运动」时才翻数字；问不到（静态渲染、jsdom）就直接落终值。 */
function motionAllowed(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: no-preference)").matches
  );
}

/**
 * 数字从 0 翻到目标值。**首帧就是目标值**（静态渲染、测试、reduced-motion 看到的都是终值），
 * 挂载之后才回到 0 再翻上来——「页面在静止时是完整的」。
 */
// useState 初值直接取 target，首帧就是终值。
// target 为 undefined、!motionAllowed() 或无 rAF 时同步 setShown(target)。
// tick 回调里用 easeOutCubic 进度算当前值并 Math.round 取整。
// 进度到 1 后不再 requestAnimationFrame，避免空转。
function useCountUp(target: number | undefined): number | undefined {
  const [shown, setShown] = useState(target);
  useEffect(() => {
    if (target === undefined || !motionAllowed() || typeof requestAnimationFrame !== "function") {
      setShown(target);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / COUNT_UP_MS);
      setShown(Math.round(target * easeOutCubic(progress)));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    setShown(0);
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return shown;
}

// Figure 把 parts 里的数值段与单位段交替渲染。
// 缺席值渲染破折号，并用 aria-label 补可访问名。
// delayMs 由外部传入，组件不自行计算进场顺序。
// 测试标识由 testKey 拼进 data-testid，便于 e2e 定位单格。
function Figure({
  delayMs,
  label,
  parts,
  testKey,
  title,
}: {
  testKey: string;
  label: string;
  /** `[数字, 单位]` 交替；缺席即 `—`。 */
  parts: readonly { value: string; unit: string }[] | undefined;
  title?: string;
  delayMs: number;
}) {
  const { intl } = useZCodeIntl();
  const unavailable = intl.formatMessage({ id: "chat.toolCall.workflow.completion.unavailable" });
  const style: CSSProperties = { animationDelay: `${delayMs}ms`, animationFillMode: "backwards" };
  return (
    <div
      className="wf-arrive flex min-w-0 flex-col"
      data-testid={`workflow-completion-figure-${testKey}`}
      data-value={
        parts === undefined ? undefined : parts.map((part) => part.value + part.unit).join(" ")
      }
      style={style}
    >
      <span
        aria-label={parts === undefined ? unavailable : undefined}
        className={cn(
          "whitespace-nowrap font-mono text-ui-lg leading-tight tabular-nums",
          parts === undefined ? "text-foreground-subtlest" : "font-medium text-foreground",
        )}
        title={title}
      >
        {parts === undefined
          ? "—"
          : parts.map((part, index) => (
              <span key={index}>
                {index > 0 ? " " : null}
                {part.value}
                {part.unit.length === 0 ? null : (
                  <span className="text-ui-sm font-normal text-foreground-subtle">{part.unit}</span>
                )}
              </span>
            ))}
      </span>
      <span className="truncate text-ui-sm text-foreground-subtle">{label}</span>
    </div>
  );
}

// 标签构建集中在一次 memo。
// 标签构建集中在一次 useMemo，依赖 artifacts 与 artifactsTruncated。
// 四个计数各自调用 useCountUp，互不阻塞。
// 数字 delayMs 接在产物条落位之后，避免同时起跳。
export function WorkflowCompletionCard({
  artifacts,
  artifactsTruncated = false,
  figures,
  headerLeading,
  headerTrailing,
  name,
  onOpenArtifact,
  onOpenRun,
  renderPreview,
  testIdKey,
}: WorkflowCompletionCardProps) {
  const { intl, locale } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  const labels = useMemo(
    () => buildPresetLabels((descriptor, values) => intl.formatMessage(descriptor, values)),
    [intl],
  );

  const layout = useMemo(
    () => completionArtifactLayout(artifacts, artifactsTruncated),
    [artifacts, artifactsTruncated],
  );

  // 四格的数字翻上来；时长翻的是毫秒，再拆成「11m 48s」。
  const durationMs = useCountUp(figures.durationMs);
  const tokens = useCountUp(figures.tokens);
  const subagents = useCountUp(figures.subagents);
  const phases = useCountUp(figures.phases);
  const separator = workDurationUnitSeparator(locale);
  const timeParts =
    durationMs === undefined
      ? undefined
      : workDurationParts(durationMs, format).map((part) => ({
          value: String(part.value),
          unit: `${separator}${part.unit}`,
        }));
  const tokenParts = tokens === undefined ? undefined : [formatCompactCount(tokens)];
  const plain = (value: number | undefined) =>
    value === undefined ? undefined : [{ value: value.toLocaleString(), unit: "" }];

  const figureDelay = PILL_STAGGER_MS * (completionArtifactCellCount(layout) + 1);

  return (
    <section
      aria-label={format({ id: WORKFLOW_RUN_KIND_ID.completed })}
      // `@container/wf-card`：窄卡（<480px）上动词只剩图标——判据必须是**卡自己的宽度**，
      // 视口断点在分栏、侧板与手机三种窄法之间对不上（docs/dynamic-workflow/transcript-and-notifications.md）。
      className="wf-motion wf-arrive @container/wf-card flex w-full min-w-0 flex-col gap-2.5 rounded-xl border border-border/70 bg-card/70 px-3.5 pb-3 pt-1.5"
      data-testid={`workflow-completion-card-${testIdKey}`}
      data-workflow-completion-card="true"
    >
      <WorkflowCardHeader
        expanded={false}
        kind={format({ id: WORKFLOW_RUN_KIND_ID.completed })}
        name={name}
        status={<WorkflowRunStatus status="completed" testId="workflow-completion-status" />}
        {...(headerLeading === undefined ? {} : { leading: headerLeading })}
        {...(headerTrailing === undefined ? {} : { trailing: headerTrailing })}
        {...(onOpenRun === undefined ? {} : { onOpenDetails: onOpenRun })}
      />
      <WorkflowCompletionArtifacts
        artifactsTruncated={artifactsTruncated}
        labels={labels}
        layout={layout}
        {...(renderPreview === undefined ? {} : { renderPreview })}
        {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })}
        {...(onOpenRun === undefined ? {} : { onOpenRun })}
      />
      <div
        className="grid grid-cols-4 gap-x-3 border-t border-[var(--color-workflow-rule)] pt-2.5"
        data-testid="workflow-completion-figures"
      >
        <Figure
          delayMs={figureDelay}
          label={format({ id: "chat.toolCall.workflow.completion.time" })}
          parts={timeParts}
          testKey="time"
        />
        <Figure
          delayMs={figureDelay + PILL_STAGGER_MS}
          label={format({ id: "chat.toolCall.workflow.completion.tokens" })}
          parts={tokenParts}
          testKey="tokens"
          {...(figures.tokens === undefined
            ? {}
            : {
                title: format(
                  { id: "chat.toolCall.workflow.card.tokens" },
                  { count: figures.tokens.toLocaleString() },
                ),
              })}
        />
        <Figure
          delayMs={figureDelay + PILL_STAGGER_MS * 2}
          label={format({ id: "chat.toolCall.workflow.completion.subagents" })}
          parts={plain(subagents)}
          testKey="subagents"
        />
        <Figure
          delayMs={figureDelay + PILL_STAGGER_MS * 3}
          label={format({ id: "chat.toolCall.workflow.completion.phases" })}
          parts={plain(phases)}
          testKey="phases"
        />
      </div>
    </section>
  );
}
