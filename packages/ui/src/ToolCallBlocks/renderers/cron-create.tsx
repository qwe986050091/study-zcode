// INV-01 摘要必须按候选数组声明顺序短路取第一个可用值：守住位置是 readCronCreateAutomationSummary 中 candidates 的排列；改错故障是顺序被打乱后残缺原文抢先命中，卡片标题被一大段 JSON 片段覆盖。
// INV-02 只有 title 与 cronExpr 至少存在其一时才算有效摘要：守住位置是输出摘要函数里的早退判断；改错故障是空摘要被当作正常结果，卡片渲染默认标题并吞掉本应走降级路径的失败。
// INV-03 工具名比较必须先转小写再去掉非字母数字字符：守住位置是 normalizeToolName 的两步处理；改错故障是 cron_create 与 cron-create 被判定为两个工具，一半卡片直接不渲染。
// INV-04 规则单位必须落在模块级白名单内：守住位置是 SCHEDULE_RULE_UNITS 集合；改错故障是未知单位流入描述层，拼出没有实质信息的排期文案。
// INV-05 间隔必须是有限数字：守住位置是 isScheduleRule 里对 interval 的有限性判断；改错故障是 NaN 或 Infinity 被当成合法间隔，文案出现「每 NaN 小时」这类荒谬表述。
// INV-06 小时与分钟字段必须是数字类型：守住位置是 isScheduleRule 的两个 typeof 判断；改错故障是字符串型小时被放行，后续算术退化成字符串拼接，展示时间整体错位。
// INV-07 锚点时间必须存在且为数字：守住位置是 isScheduleRule 末尾那条校验；改错故障是缺失锚点的规则被判为合法，锚定型间隔全部塌陷成默认文案。
// INV-08 权威规则只在结构校验通过后才写入摘要：守住位置是输出摘要函数里的条件展开；改错故障是半成品规则被透传给卡片，描述层拿到不可信的输入开始静默降级。
// INV-09 循环标识与次数上限必须保持可选，缺失时不写入对象：守住位置是返回值的条件展开；改错故障是写入 undefined 后覆盖了下游的默认值判断，循环任务被误显示为单次。
// INV-10 嵌套 automation 记录存在时必须优先于顶层同名字段：守住位置是输出摘要函数里对 automation 记录的选择；改错故障是顶层脏字段抢先命中，标题与 cron 取自两个不同来源。
// INV-11 任务标识与 cron 表达式要同时兼容驼峰与下划线两种命名：守住位置是这两个字段的三元回退链；改错故障是历史结果只带下划线字段时卡片丢失标识，打开按钮无法定位具体任务。
// INV-12 字符串型输出必须先按起始字符预判再尝试解析：守住位置是 parseJsonString 的首字符判断；改错故障是对普通文本反复解析抛出异常，异常被吞后摘要静默消失。
// INV-13 解析失败必须返回空值而不是向上抛异常：守住位置是 parseJsonString 的 catch 分支；改错故障是历史脏数据让整个工具块渲染中断，聊天界面局部白屏。
// INV-14 记录判定必须排除数组与空值：守住位置是 isPlainRecord 的首行判断；改错故障是数组被当成记录读取，字段访问结果为 undefined 并被误判为「无摘要」。
// INV-15 失败态与无摘要态必须共用同一个降级出口：守住位置是 CronCreateToolCallBlock 的早退分支；改错故障是失败的工具调用仍渲染成功卡片，用户误以为定时任务已经创建。
// INV-16 打开按钮可用性必须由回调是否存在派生：守住位置是 canOpenAutomations 这个布尔量；改错故障是无回调时按钮仍可点击，点击后没有任何反馈形成死按钮。
// INV-17 打开回调必须显式携带任务标识：守住位置是按钮点击处理对 automationId 的传参；改错故障是详情页打开后无法定位任务，用户只能在长列表里手动查找。
// INV-18 排期文案必须优先使用权威规则而不是裸 cron：守住位置是描述函数的条件展开入参；改错故障是每 50 小时的规则被降级显示为每小时，用户据此误判执行频率。
//
// 模块职责：把 cron 创建类工具调用的输出解析成可展示摘要，并渲染成带「打开」入口的卡片；解析不出来或调用失败时整体交给通用降级组件。
// 状态所有权：本模块不持有任何可写状态，摘要与排期文案都是每次渲染现算的派生值，唯一的外部状态是 intl 上下文与宿主注入的打开回调。
// 阅读顺序：先看头部不变量表建立契约，再按解析层（单位白名单、类型守卫、候选遍历）到展示层（卡片、降级分支）的顺序阅读。
import { ClockIcon } from "lucide-react";
import { TID_CRON_CREATE_CARD, TID_CRON_CREATE_OPEN } from "@zcode/shared/test-ids";
import type { ZCodeAutomationScheduleRule } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { describeAutomationCardSchedule } from "@/settings/automationCardSchedule.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { FallbackToolCallBlock } from "@/ToolCallBlocks/renderers/fallback.js";

export interface CronCreateAutomationSummary {
  automationId?: string;
  title?: string;
  cronExpr?: string;
  /** 权威重复规则；卡片优先用它展示 cron 无法表达的真实间隔（如每50小时、每40天）。 */
  scheduleRule?: ZCodeAutomationScheduleRule;
  recurring?: boolean;
  maxRuns?: number;
}

// 单位白名单与规则类型的联合定义一一对应，是类型系统之外多出的一道运行时防线。
// 协议输出与历史工具结果都不受类型约束，静态类型在这条路径上只能当注释看。
// 白名单放在模块级只构造一次，避免每次读取摘要都新建集合拖慢消息列表渲染。
// 若放宽为任意字符串，描述层会收到它不认识的单位并拼出空洞的排期文案。
// 新增单位必须同时改这里与描述层，只改一处会造成静默降级而非报错。
// 这里刻意不做大小写归一，单位约定为小写，混用大小写说明上游已经出错。
const SCHEDULE_RULE_UNITS = new Set([
  "minute",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "yearly",
]);

// isScheduleRule 只做外部数据到内部契约的准入检查，完整结构校验由 describe 层负责。
// 校验顺序按代价从低到高：先判记录形态，再判枚举成员，最后判数值类型。
// [权衡] 字段宽松放行是刻意的，过严会让新版本输出直接失去卡片、只能退化成降级展示。
// 但每个被放行的字段都要在描述层再兜底一次，否则不合格数据会在文案层暴露。
// 返回否定时上层把它理解为「没有权威规则」而不是「数据损坏」，因此不记录错误。
// 最容易引入的回归是顺手加严小时与分钟的取值范围，导致跨时区历史数据被判无效。
function isScheduleRule(value: unknown): value is ZCodeAutomationScheduleRule {
  // 宽松结构校验：输出可能来自协议或历史工具结果，字段宽松地放行后由 describe 层兜底。
  if (!isPlainRecord(value)) return false;
  if (typeof value.unit !== "string" || !SCHEDULE_RULE_UNITS.has(value.unit)) return false;
  if (typeof value.interval !== "number" || !Number.isFinite(value.interval)) return false;
  if (typeof value.hour !== "number" || typeof value.minute !== "number") return false;
  if (typeof value.anchorAt !== "number") return false;
  return true;
}

function normalizeToolName(value: unknown): string {
  return typeof value === "string"
    ? value.toLowerCase().replace(/[^a-z0-9]/gu, "")
    : "";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCronCreateToolCall(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): boolean {
  return [toolCall.toolName, toolCall.kind, toolCall.title].some(
    (value) => normalizeToolName(value) === "croncreate",
  );
}

export function isCronAutomationCardToolCall(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): boolean {
  return [toolCall.toolName, toolCall.kind, toolCall.title].some((value) => {
    const normalized = normalizeToolName(value);
    return normalized === "croncreate" || normalized === "cronupdate";
  });
}

function parseJsonString(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function normalizeOutputCandidate(value: unknown): unknown {
  return typeof value === "string" ? parseJsonString(value) : value;
}

export function readCronCreateAutomationOutputSummary(
  value: unknown,
): CronCreateAutomationSummary | null {
  const normalizedValue = normalizeOutputCandidate(value);
  if (!isPlainRecord(normalizedValue)) {
    return null;
  }

  const automation = isPlainRecord(normalizedValue.automation)
    ? normalizedValue.automation
    : normalizedValue;
  const automationId =
    typeof automation.automationId === "string" && automation.automationId.trim()
      ? automation.automationId.trim()
      : typeof automation.automation_id === "string" && automation.automation_id.trim()
        ? automation.automation_id.trim()
        : undefined;
  const title =
    typeof automation.title === "string" && automation.title.trim()
      ? automation.title.trim()
      : undefined;
  const cronExpr =
    typeof automation.cronExpr === "string" && automation.cronExpr.trim()
      ? automation.cronExpr.trim()
      : typeof automation.cron_expr === "string" && automation.cron_expr.trim()
        ? automation.cron_expr.trim()
        : undefined;
  if (!title && !cronExpr) {
    return null;
  }

  // 读取权威 scheduleRule 与循环/次数信息，供卡片展示 cron 无法表达的真实间隔。
  const scheduleRule = isScheduleRule(automation.scheduleRule)
    ? (automation.scheduleRule as ZCodeAutomationScheduleRule)
    : undefined;
  const recurring =
    typeof automation.recurring === "boolean" ? automation.recurring : undefined;
  const maxRuns =
    typeof automation.maxRuns === "number" && Number.isFinite(automation.maxRuns)
      ? automation.maxRuns
      : undefined;

  return {
    ...(automationId ? { automationId } : {}),
    ...(title ? { title } : {}),
    ...(cronExpr ? { cronExpr } : {}),
    ...(scheduleRule ? { scheduleRule } : {}),
    ...(recurring !== undefined ? { recurring } : {}),
    ...(maxRuns !== undefined ? { maxRuns } : {}),
  };
}

export function readCronCreateAutomationSummary(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): CronCreateAutomationSummary | null {
  const raw = isPlainRecord(toolCall.raw) ? toolCall.raw : null;
  const rawResult = isPlainRecord(raw?.result) ? raw.result : null;
  // 候选来源覆盖新协议字段与三代历史结果的落点，数组顺序本身就是优先级。
  // [权衡] candidates 先取 toolCall.output：它最接近最终展示意图，但历史数据里常为空。
  // 原始包字段可能只是协议原文，内容与展示字段才是已经为人整理过的文本。
  // [失败路径] 任一候选解析成功即短路返回，避免后面的脏数据覆盖已确认的摘要。
  // 顺序一旦打乱，残缺原文会抢先命中，卡片上出现大段无意义的片段。
  // 新增字段应追加在末尾而非插入中间，插队会让存量会话的渲染结果整体改变。
  const candidates = [
    toolCall.output,
    raw?.rawOutput,
    raw?.output,
    rawResult?.content,
    rawResult?.display,
    raw?.result,
    toolCall.content,
  ];

  for (const candidate of candidates) {
    const summary = readCronCreateAutomationOutputSummary(candidate);
    if (summary) {
      return summary;
    }
  }

  return null;
}

export function CronCreateAutomationCard({
  automation,
  onOpenAutomationsMain,
}: {
  automation: CronCreateAutomationSummary;
  onOpenAutomationsMain?: (automationId?: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const title =
    automation.title ?? intl.formatMessage({ id: "automations.chatCreated.defaultTitle" });
  // 分支只判断 cron 表达式是否存在，没有它就直接使用降级文案而不是留空行。
  // [权衡] 优先展示权威规则而非裸 cron，因为 cron 无法表达每 50 小时这类真实间隔。
  // 条件展开保持了入参对象的稀疏性，缺失字段不会以 undefined 形式进入描述层。
  // 排期文案是纯派生值，每次渲染重算且不缓存，因为它依赖实时的国际化上下文。
  // 若在这里缓存字符串，切换语言后卡片会残留旧语言文案直到组件重新挂载。
  // 降级文案走国际化键而非硬编码，保证未识别排期在每种语言下都有人话可读。
  const schedule = automation.cronExpr
    ? describeAutomationCardSchedule(
        {
          cronExpr: automation.cronExpr,
          // 透传权威 scheduleRule/循环态，否则「每50小时」「每40天」会回退成「每小时的第00分」。
          ...(automation.scheduleRule ? { scheduleRule: automation.scheduleRule } : {}),
          ...(automation.recurring !== undefined ? { recurring: automation.recurring } : {}),
          ...(automation.maxRuns !== undefined ? { maxRuns: automation.maxRuns } : {}),
        },
        intl,
      )
    : intl.formatMessage({ id: "automations.chatCreated.scheduleFallback" });
  const canOpenAutomations = Boolean(onOpenAutomationsMain);

  return (
    <div
      data-testid={TID_CRON_CREATE_CARD}
      className="my-1 w-full rounded-xl border border-border/70 bg-card/70 px-3 py-3 shadow-sm backdrop-blur-sm"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface text-foreground-subtle">
          <ClockIcon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui-base font-medium text-foreground">{title}</div>
          <div className="mt-0.5 truncate text-ui-base text-foreground-subtle">{schedule}</div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid={TID_CRON_CREATE_OPEN}
          className={cn(
            // 次级文字色加尾箭头会让明确的导航操作显得像辅助说明。
            // 固定 h-7 会压缩文字热区，导致视觉内边距无法达到上下 6px。
            "h-auto rounded-lg border-border/70 bg-transparent px-3 py-1.5 text-ui-base text-foreground hover:bg-hover hover:text-foreground",
            !canOpenAutomations && "opacity-50",
          )}
          // 禁用态与视觉透明度由同一个布尔驱动，避免出现看着可点、实际被禁的按钮。
          // [失败路径] 没有注入打开回调时按钮不可用，表达的是能力缺失而不是加载失败。
          // [权衡] 这里禁用而不是隐藏按钮，让有无 onOpenAutomationsMain 时卡片高度保持 1 档不变。
          // onClick 仍用可选链调用，防止热更新撤掉回调后触发空引用异常。
          // 把任务标识一并传出，让宿主可以直接跳到目标任务详情而无需二次查找。
          // 若改成在组件内部自行导航，就会把路由依赖注入纯展示层，复用成本立刻上升。
          disabled={!canOpenAutomations}
          onClick={() => onOpenAutomationsMain?.(automation.automationId)}
        >
          <span>{intl.formatMessage({ id: "automations.chatCreated.open" })}</span>
        </Button>
      </div>
    </div>
  );
}

export function CronCreateToolCallBlock(context: ToolCallBlockRenderContext) {
  const { toolCall } = context.toolCallNode;
  const automation = readCronCreateAutomationSummary(toolCall);

  // 两个条件合并成同一个出口：调用失败与解析不出摘要都交给通用降级组件。
  // [失败路径] 失败判断优先于摘要可用性，即使结果里残留旧数据也不允许渲染成功卡片。
  // [权衡] 宁可少渲染一张卡片，也不能让用户误以为定时任务已经创建成功。
  // 降级组件接管测试标识与状态展示，这里只负责把上下文原样透传下去。
  // 该分支位于 CronCreateToolCallBlock 组件体最前且无副作用，先于任何 hook 返回，避免多余计算。
  // 摘要读取刻意放在判断之前，它无副作用，同时充当失败分支的判定输入。
  if (toolCall.status === "failed" || !automation) {
    return <FallbackToolCallBlock {...context} />;
  }

  return (
    <CronCreateAutomationCard
      automation={automation}
      onOpenAutomationsMain={context.onOpenAutomationsMain}
    />
  );
}
