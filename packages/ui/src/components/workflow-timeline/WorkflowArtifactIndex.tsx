// INV-01 预览要么读得清要么不画：守住位置 文件头规则；改错故障 出现模糊缩略图。
// INV-02 交付物与其余产物形态区分：守住位置 有框与无框；改错故障 两段层级混淆。
// INV-03 每行高度固定 26px：守住位置 LINE_CLASS；改错故障 长标题把行撑高。
// INV-04 一行永远渲染按钮：守住位置 button 元素；改错故障 不可打开时无法禁用。
// INV-05 不可打开即禁用：守住位置 disabled 属性；改错故障 点击无效却仍获焦点。
// INV-06 关闭态不挂点击处理：守住位置 onClick 条件；改错故障 禁用按钮仍触发回调。
// INV-07 版本号缺省为一：守住位置 空值合并；改错故障 老产物显示 v1 尾槽。
// INV-08 尾槽仅从第二版出现：守住位置 showVersion 判断；改错故障 首版就占位。
// INV-09 版本号变化才重挂：守住位置 key 属性；改错故障 再发布时不播放进场。
// INV-10 打开箭头与版本号共用槽：守住位置 叠放容器；改错故障 两者并排挤压缩略。
// INV-11 详情仅在存在时渲染：守住位置 hasDetail 判断；改错故障 出现空等宽段。
// INV-12 门不是产物：守住位置 MoreLine 语义；改错故障 「还有 N 个」被计入产物数。
// INV-13 被砍过的清单不报数字：守住位置 truncated 判断；改错故障 显示错误的总数。
// INV-14 门的箭头常驻：守住位置 无悬停样式；改错故障 用户不知道还有内容。
// INV-15 列布局由参数决定：守住位置 columns 属性；改错故障 侧板出现两列。
// INV-16 细线仅在跟交付物后出现：守住位置 rule 属性；改错故障 独占卡时多一条横线。
// INV-17 进场延迟按序递增：守住位置 PILL_STAGGER_MS 乘下标；改错故障 所有行同时出现。
// INV-18 可选属性用条件展开：守住位置 展开语法；改错故障 传入 undefined 覆盖默认值。
//
// 模块职责：渲染产物索引的普通行、门的行与整体列布局。
// 状态所有权：无状态；回调、标签与延迟全部由上层注入。
// 阅读顺序：先看行组件，再看门的行，最后看索引容器的布局与延迟。
import type { CSSProperties } from "react";
import { ArrowUpRightIcon, EllipsisIcon } from "lucide-react";
import {
  ArtifactDetail,
  ArtifactKindIcon,
  artifactDetailText,
  artifactDisplayTitle,
  artifactKindMessageId,
} from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import type { PresetLabels } from "@/app-shell/workflow-artifacts/presets/index.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkflowCompletionArtifact } from "./WorkflowArtifactTile.js";
import { PILL_STAGGER_MS } from "./WorkflowTimeline.js";

/**
 * 产物索引（侧板）：交付物行之后的**其余产物**，一件一行。
 *
 * 规则只有一条：**预览要么读得清，要么不画**。交付物留着它的框；其余产物把框丢掉，只剩瓦片说明行
 * 那一套语法——kind 图标、完整标题、等宽细节（迷你瓦片曾把它藏进 tooltip）、尾槽（v{n}，悬停让位
 * 给 ↗）——独立成行。层级由此来自**形态**（有图的一件 vs 只有字的其余），而不是大框与小框。
 *
 * 一行 26px。卡上按 `repeat(auto-fit, minmax(220px, 1fr))` 流成两列（窄卡一列）；侧板恒为一列。
 * 与交付物行之间隔一条细线（`--color-workflow-rule`，四格数字前的那条），卡因此读作收据的三段：
 * 交付了什么、还做了什么、花了多少。
 *
 * 「还有 N 个」是一扇门不是一件产物：省略号图标、次要色的字、↗ 不等悬停就在（与名册的「还有 n 个」
 * 一行同一条规则），点开 run 侧板看全部。
 *
 * 每一行永远是一颗 `<button>`：宿主没给回调时是**禁用**的按钮（「交付了什么」是事实，「能不能
 * 打开」是能力），与药丸、瓦片同一条门。悬停 / 聚焦时整行填 `surface-hover`（像侧栏行），填色向
 * 文字左右各多出 6px（负外边距），文字本身仍与交付物框的左边对齐。
 *
 * ⚠ 术语：artifact = 脚本经 `artifact.*` 发布给用户看的产出。
 */
// enterDelayMs 缺省或非正时返回 undefined。
// 延迟只作用于进场动画。
// 填充模式用 backwards 保证首帧。
// 返回 undefined 表示交给默认样式。
function enterStyle(enterDelayMs: number | undefined): CSSProperties | undefined {
  return enterDelayMs === undefined || enterDelayMs <= 0
    ? undefined
    : { animationDelay: `${enterDelayMs}ms`, animationFillMode: "backwards" };
}

const LINE_CLASS =
  "wf-line wf-arrive -mx-1.5 flex h-[26px] min-w-0 items-center gap-2 rounded-md bg-transparent px-1.5 text-left text-ui-sm outline-none";

// tooltip 缺席时标题由 artifactDisplayTitle() 给出。
// 种类文案走 artifactKindMessageId() 的消息键映射。
// onOpen 缺席时整行是禁用按钮。
// 版本尾槽从 version >= 2 开始显示。
function WorkflowArtifactLine({
  artifact,
  enterDelayMs,
  labels,
  onOpen,
  testId = "workflow-artifact-line",
  title: tooltip,
}: {
  artifact: WorkflowCompletionArtifact;
  labels: PresetLabels;
  onOpen?: (artifactId: string) => void;
  enterDelayMs?: number;
  testId?: string;
  /** tooltip 覆盖（侧板把工作区出处放进来）；缺席时是「种类词 · 标题」。 */
  title?: string;
}) {
  const { intl } = useZCodeIntl();
  const title = artifactDisplayTitle(artifact);
  const kindLabel = intl.formatMessage({ id: artifactKindMessageId(artifact.kind) });
  const hasDetail = artifactDetailText(artifact, labels) !== undefined;
  const openable = onOpen !== undefined;
  const version = artifact.version ?? 1;
  const showVersion = version >= 2;

  return (
    <button
      aria-label={
        openable
          ? `${intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.open" })}: ${title}`
          : undefined
      }
      className={cn(LINE_CLASS, openable ? "wf-line-open cursor-pointer" : "cursor-default")}
      data-artifact-id={artifact.id}
      data-artifact-kind={artifact.kind}
      data-artifact-open={openable ? "true" : undefined}
      data-artifact-version={String(version)}
      data-testid={testId}
      data-variant="line"
      disabled={!openable}
      onClick={openable ? () => onOpen(artifact.id) : undefined}
      style={enterStyle(enterDelayMs)}
      title={tooltip ?? `${kindLabel} · ${title}`}
      type="button"
    >
      <ArtifactKindIcon
        className="wf-line-icon size-3.5 shrink-0 text-foreground-subtle"
        kind={artifact.kind}
      />
      <span className="min-w-0 flex-1 truncate text-foreground">{title}</span>
      {hasDetail ? (
        <span
          className="flex shrink-0 items-center gap-1 font-mono text-ui-xs tabular-nums text-foreground-subtlest"
          data-testid="workflow-artifact-line-detail"
        >
          <ArtifactDetail artifact={artifact} labels={labels} />
        </span>
      ) : null}
      {showVersion || openable ? (
        <span className="grid size-3 shrink-0 place-items-center [&>*]:col-start-1 [&>*]:row-start-1">
          {showVersion ? (
            // 按版本重挂：同 id 再发布时尾槽弹入一次（wf-mark 的进场），悬停时让位给 ↗。
            <span
              className="wf-mark font-mono text-ui-xs leading-none tabular-nums text-foreground-subtlest"
              data-testid="workflow-artifact-tile-version"
              key={version}
              title={intl.formatMessage(
                { id: "chat.toolCall.workflow.run.artifacts.version" },
                { version: String(version) },
              )}
            >
              {intl.formatMessage(
                { id: "chat.toolCall.workflow.run.artifacts.versionTail" },
                { version: String(version) },
              )}
            </span>
          ) : null}
          {openable ? (
            <span
              aria-hidden
              className="wf-pill-go flex items-center justify-center text-foreground-subtlest"
              data-testid="workflow-artifact-tile-open"
            >
              <ArrowUpRightIcon className="size-3" />
            </span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}

/** 「还有 N 个」——门，不是产物。砍过的清单不知道 N，写 `…`。 */
// count 可能被发射侧截断，不可直接展示。
// truncated 为真时用省略号替代 count。
// 门本身不携带 artifactId。
// 可打开性同样只看 onOpen 是否存在。
function WorkflowArtifactMoreLine({
  count,
  enterDelayMs,
  onOpen,
  testId = "workflow-artifact-more-line",
  truncated = false,
}: {
  count: number;
  /** 发射侧砍过（超 8）：N 不可知，写 `…`。 */
  truncated?: boolean;
  onOpen?: () => void;
  enterDelayMs?: number;
  testId?: string;
}) {
  const { intl } = useZCodeIntl();
  const openable = onOpen !== undefined;
  return (
    <button
      className={cn(LINE_CLASS, openable ? "wf-line-open cursor-pointer" : "cursor-default")}
      data-testid={testId}
      data-variant="more"
      disabled={!openable}
      onClick={onOpen}
      style={enterStyle(enterDelayMs)}
      title={intl.formatMessage({ id: "chat.toolCall.workflow.openRunDetails" })}
      type="button"
    >
      <EllipsisIcon aria-hidden className="size-3.5 shrink-0 text-foreground-subtlest" />
      <span className="min-w-0 flex-1 truncate text-foreground-subtle">
        {intl.formatMessage(
          { id: "chat.toolCall.workflow.completion.moreArtifacts" },
          { count: truncated ? "…" : count.toLocaleString() },
        )}
      </span>
      {openable ? (
        // 一扇门没有状态标记可让位：↗ 在场即在，不等悬停（wf-pill-go-rest）。
        <span className="grid size-3 shrink-0 place-items-center">
          <span
            aria-hidden
            className="wf-pill-go wf-pill-go-rest flex items-center justify-center text-foreground-subtlest"
            data-testid="workflow-artifact-tile-open"
          >
            <ArrowUpRightIcon className="size-3" />
          </span>
        </span>
      ) : null}
    </button>
  );
}

type WorkflowArtifactIndexColumns = "auto" | "one";

/**
 * 索引本身：行 + 可选的门。`columns="auto"` 是卡上的两列流（≥ 2 × 220px 才成两列），`"one"` 是侧板
 * 的单列。`rule` 在上方画那条细线（跟在交付物行之后时要；索引独占卡时不要）。行依次落地，从
 * `firstDelayMs` 起每行错 30ms，门排在最后一行之后。
 */
// columns 只区分 auto 与 one 两种布局。
// rule 布尔参数控制上方细线。
// 行延迟从 firstDelayMs 起每行递增 30ms。
// 门排在所有 artifact 行之后。
export function WorkflowArtifactIndex({
  artifacts,
  columns = "auto",
  firstDelayMs = 0,
  folded = 0,
  labels,
  lineTestId,
  more = false,
  moreTestId,
  onOpenArtifact,
  onOpenRun,
  rule = false,
  testId = "workflow-artifact-index",
  tooltipOf,
  truncated = false,
}: {
  artifacts: readonly WorkflowCompletionArtifact[];
  labels: PresetLabels;
  columns?: WorkflowArtifactIndexColumns;
  rule?: boolean;
  /** 画「还有 N 个」；`folded` 是 N。 */
  more?: boolean;
  folded?: number;
  truncated?: boolean;
  firstDelayMs?: number;
  onOpenArtifact?: (artifactId: string) => void;
  onOpenRun?: () => void;
  testId?: string;
  lineTestId?: string;
  moreTestId?: string;
  tooltipOf?: (artifact: WorkflowCompletionArtifact) => string;
}) {
  return (
    <div
      className={cn(
        "grid gap-x-5",
        columns === "auto" ? "grid-cols-[repeat(auto-fit,minmax(220px,1fr))]" : "grid-cols-1",
        rule && "border-t border-[var(--color-workflow-rule)] pt-1.5",
      )}
      data-columns={columns}
      data-testid={testId}
    >
      {artifacts.map((artifact, index) => (
        <WorkflowArtifactLine
          artifact={artifact}
          enterDelayMs={firstDelayMs + PILL_STAGGER_MS * index}
          key={artifact.id}
          labels={labels}
          {...(lineTestId === undefined ? {} : { testId: lineTestId })}
          {...(tooltipOf === undefined ? {} : { title: tooltipOf(artifact) })}
          {...(onOpenArtifact === undefined ? {} : { onOpen: onOpenArtifact })}
        />
      ))}
      {more ? (
        <WorkflowArtifactMoreLine
          count={folded}
          enterDelayMs={firstDelayMs + PILL_STAGGER_MS * artifacts.length}
          truncated={truncated}
          {...(moreTestId === undefined ? {} : { testId: moreTestId })}
          {...(onOpenRun === undefined ? {} : { onOpen: onOpenRun })}
        />
      ) : null}
    </div>
  );
}
