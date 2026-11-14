// ModelTrajectoryPaneParts —— 模型轨迹面板的调用卡片展示层：把一次模型调用的输入消息、
// 响应文本/推理/工具调用、错误与用量元数据，投影为可展开的 subgrid 行。
// 本文件只被 ModelTrajectoryPane 组合使用，不对外导出子组件。
// 组件全部为同文件私有函数，改动前先确认调用方只做只读组合。
// 职责边界：
//   - 只做展示投影与 i18n 文案选择；不发起请求、不缓存、不改写 record。
//   - 上游 ZCodeModelTrajectoryRecord 是唯一事实源，此处不持有派生状态。
//   - 展开状态归 ExpandableTrajectoryMessage 所有，本文件仅拼接 expansionKey。
//   - 行序与列对齐由父级 grid-cols-subgrid 决定，子组件不得脱离列轨道。
//   - 角色/来源/结束原因文案映射在此收口，未知值降级为原始字符串。
// 展示约束：
//   - data-trajectory-* 属性是 E2E 与搜索定位合同，改样式不得改属性名。
//   - 文案一律走 intl.formatMessage，不在组件内硬编码中英文。
//   - 行 key 采用「卡片序号 + 段名 + 段内序号」，不依赖消息内容。
//   - sticky 摘要栏依赖父级行轨道，移除后长轨迹会丢失上下文。
//   - 空轨迹由外层空状态承接，本文件不渲染占位骨架。
// INV（不变量）—— 破坏任一条都会导致轨迹错行、错序或空白面板：
// INV-01 断言：同一 call 内输入行序号从 0 连续递增，输出行紧随其后 —— 守住它的位置：CallCard 中 inputMessages.map 的 messageIndex —— 改错故障：行交替底色与搜索定位跳错行。
// INV-02 断言：expansionKey 前缀＋段名＋序号全局唯一 —— 守住它的位置：各处 expansionKey 拼接 —— 改错故障：多张卡片展开状态互相串台。
// INV-03 断言：缺失 response/usage/callSource 时降级而非抛错 —— 守住它的位置：可选链与 ?? 默认值 —— 改错故障：轨迹面板整块白屏。
// INV-04 断言：输入段仅在 inputMessages 非空时渲染 —— 守住它的位置：hasInput 分支 —— 改错故障：出现空壳 section 与多余分隔线。
// INV-05 断言：输出行 key 在单个 response 内唯一 —— 守住它的位置：reasoning/message/toolCall 的 key 构造 —— 改错故障：React 复用错行，文本串位。
// INV-06 断言：错误块渲染在响应块之后 —— 守住它的位置：CallCard 子节点顺序 —— 改错故障：失败原因被输出内容掩盖。
// INV-07 断言：finishReason 未知值原样透出 —— 守住它的位置：finishReasonLabel 的 default —— 改错故障：无效 i18n key 或空白徽标。
// INV-08 断言：未知 role 不查询 i18n key —— 守住它的位置：knownRole 判定 —— 改错故障：控制台缺 key 告警且角色标签为空。
// INV-09 断言：无内容响应不渲染 section —— 守住它的位置：hasContent 早退 —— 改错故障：出现空输出框与相邻分隔线。
// INV-10 断言：行交替色基于全局行号而非局部下标 —— 守住它的位置：startRowIndex + rowIndex —— 改错故障：输入输出交界处出现同色相邻行。
// INV-11 断言：时间/时长缺失统一显示「—」 —— 守住它的位置：callDurationLabel 三元 —— 改错故障：undefined 直接上屏。
// INV-12 断言：用量元数据按 IN→OUT→时长→时间稳定排序 —— 守住它的位置：CallMetadata 的 items 推入顺序 —— 改错故障：元数据顺序随机抖动。
// INV-13 断言：所有行元素 col-span-full ＋ grid-cols-subgrid —— 守住它的位置：各 section/row 的 className —— 改错故障：列宽错位、横向溢出。
import type {
  ZCodeModelTrajectoryMessage,
  ZCodeModelTrajectoryRecord,
  ZCodeModelTrajectoryUsage,
} from "@zcode/services";
import { Fragment } from "react";
import { cn } from "@/components/lib/utils.js";
import { Badge } from "@/components/ui/badge.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ContentPartView, EmptyState, summarizeRecords } from "@/ModelTrajectoryPaneDetails.js";
import { ExpandableTrajectoryMessage } from "@/ModelTrajectoryExpandableMessage.js";
import { ModelTrajectoryErrorBlock } from "@/ModelTrajectoryErrorBlock.js";
import {
  formatTrajectoryClockTime,
  formatTrajectoryDateTime,
  formatTrajectoryDuration,
} from "@/ModelTrajectoryFormat.js";
import { trajectoryRoleTextClass } from "@/ModelTrajectoryRoleStyles.js";
import { TrajectorySectionTitle } from "@/ModelTrajectorySectionTitle.js";

export { EmptyState, summarizeRecords } from "@/ModelTrajectoryPaneDetails.js";

export type IntlShape = ReturnType<typeof useZCodeIntl>["intl"];

// [契约] CallCard 的入参全部由外部投影传入：record 只读，inputMessages 是已裁剪的输入快照。
// [契约] index 用于展示序号与行 key，必须由调用方按时间顺序给出，本组件不重排。
// [权衡] expansionKeyPrefix 允许为空：嵌入式展示不参与搜索定位，因此不生成可检索 key。
// [失败路径] record 字段缺失时不抛错，交给下游可选链逐项降级。
export function CallCard({
  record,
  index,
  inputMessages,
  expansionKeyPrefix,
  intl,
}: {
  record: ZCodeModelTrajectoryRecord;
  index: number;
  inputMessages: ZCodeModelTrajectoryMessage[];
  expansionKeyPrefix?: string;
  intl: IntlShape;
}) {
  // [契约] response 缺失代表该次调用没有任何产出（例如请求在首包前失败），是合法状态。
  // [失败路径] 后续所有响应相关渲染都必须先过 response 判空，不能假设结构完整。
  // [契约] 此处只取引用，不做结构拷贝，保证同一 record 在多次渲染间引用稳定。
  const response = record.response;
  // [契约] usage 是可选降级字段：老轨迹或网关裁剪后的记录可能整体缺失。
  // [失败路径] 缺失时元数据区只丢 token 两项，时长与开始时间仍要正常展示。
  // [权衡] 不在本层做 token 估算，避免与运行时统计口径产生第二份数字。
  const usage = response?.usage;
  // [契约] 输入段是否渲染由消息条数决定，空数组与 undefined 走同一分支。
  // [资源] 提前算成布尔值，避免在 JSX 中重复求长度、也避免三元里出现两次判断。
  // [失败路径] 上游传入非数组时长度访问退化为空值并落到 false，不渲染而非崩溃。
  const hasInput = inputMessages.length > 0;

  return (
    // [契约] 最外层 article 用 subgrid 对齐到父级列轨道，卡片本身不再定义列宽。
    // [契约] sticky 摘要栏与内容区共享同一组列，保证滚动时序号/标题/元数据不跳动。
    // [权衡] 全宽 span 牺牲局部布局自由度，换取与其他轨迹卡片严格对齐。
    // [资源] 卡片底部自带 1px 分隔线，父级不再为每张卡片追加边框，少一层节点。
    <article data-trajectory-call="" className="col-span-full grid grid-cols-subgrid">
      <div
        data-trajectory-call-summary=""
        className="sticky top-0 z-10 col-span-full flex w-full min-w-0 items-center gap-1.5 border-b border-border/50 bg-surface/90 px-3 py-2 text-left supports-[backdrop-filter]:backdrop-blur-sm"
      >
        <span className="flex size-5 shrink-0 items-center justify-center font-mono text-ui-xs text-foreground-subtlest">
          {String(index + 1).padStart(2, "0")}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <SourceTitle record={record} intl={intl} />
          {response?.finishReason ? (
            <Badge
              data-trajectory-finish-pill=""
              data-trajectory-finish-reason={response.finishReason}
              variant="outline"
              className="h-5 shrink-0 rounded-full border-border bg-tag px-2 text-ui-xs text-foreground-subtle"
            >
              {finishReasonLabel(response.finishReason, intl)}
            </Badge>
          ) : null}
        </span>
        <CallMetadata record={record} usage={usage} />
      </div>

      <div
        data-trajectory-call-content=""
        className="col-span-full grid grid-cols-subgrid gap-y-2 p-2"
      >
        {hasInput ? (
          <section
            data-trajectory-section=""
            className="col-span-full grid grid-cols-subgrid overflow-hidden rounded-lg border border-card-border"
          >
            <TrajectorySectionTitle
              kind="input"
              label={intl.formatMessage({ id: "modelTrajectory.inputSection" })}
            />
            {inputMessages.map((message, messageIndex) => (
              <Fragment key={`${index}:${messageIndex}`}>
                <TrajectoryRowDivider />
                <MessageBlock
                  message={message}
                  callStartedAt={record.startedAt}
                  callDurationMs={record.durationMs}
                  isAlt={messageIndex % 2 === 1}
                  expansionKey={
                    expansionKeyPrefix ? `${expansionKeyPrefix}:input:${messageIndex}` : undefined
                  }
                  intl={intl}
                />
              </Fragment>
            ))}
          </section>
        ) : null}

        {response ? (
          <ResponseBlock
            response={response}
            callStartedAt={record.startedAt}
            callDurationMs={record.durationMs}
            startRowIndex={inputMessages.length}
            expansionKeyPrefix={expansionKeyPrefix}
            intl={intl}
          />
        ) : null}

        {record.error ? <ModelTrajectoryErrorBlock error={record.error} /> : null}
      </div>
      <div data-trajectory-call-divider="" className="col-span-full h-px bg-border" />
    </article>
  );
}

// [契约] SourceTitle 只负责来源标签：展示文案、稳定属性与悬停提示三件事。
// [契约] data-trajectory-source-kind/query-source 是 E2E 与搜索的稳定锚点，不随语言变化。
// [失败路径] callSource 缺失时按 main 兜底，避免标签整体消失。
function SourceTitle({ record, intl }: { record: ZCodeModelTrajectoryRecord; intl: IntlShape }) {
  const callSource: NonNullable<ZCodeModelTrajectoryRecord["callSource"]> = record.callSource ?? {
    kind: "main",
  };
  // [契约] 标签 id 由 querySource 优先、kind 兜底的两级 switch 决定。
  // [权衡] 先算 id 再渲染，保证 formatMessage 只调用一次；重复调用会让缺 key 告警翻倍。
  // [失败路径] kind 是联合类型的穷尽分支，编译期即可保证有返回值，无需运行期再兜底。
  const labelId = sourceLabelId(callSource);

  return (
    <span
      data-trajectory-source-title=""
      // E2E 曾把英文展示文案当成功能合同，切换到中文后误报轨迹投影失败；稳定属性保留原始语义，文案继续独立国际化。
      data-trajectory-source-kind={callSource.kind}
      data-trajectory-query-source={callSource.querySource}
      className="min-w-0 shrink truncate text-ui-sm font-medium text-foreground"
      title={callSource.querySource ? `querySource: ${callSource.querySource}` : undefined}
    >
      {intl.formatMessage({ id: labelId })}
    </span>
  );
}

// [契约] querySource 比 kind 更具体，因此映射优先级高于 kind。
// [契约] 返回值必须是已注册的 i18n key，未知 querySource 必须落回 kind 分支。
// [权衡] 用两个 switch 而非查表，换取类型收窄与穷尽检查。
// [失败路径] 新增枚举值时此处编译报错，促使同步补文案而不是静默显示原值。
function sourceLabelId(callSource: NonNullable<ZCodeModelTrajectoryRecord["callSource"]>): string {
  // [契约] 六个 querySource 与轨迹来源一一对应，改名需同步 i18n 资源。
  // [失败路径] 未覆盖的 querySource 直接 break，交由下方 kind 映射决定最终标签。
  // [权衡] 不为每个 querySource 建独立组件，统一用标签区分，减少分支爆炸。
  switch (callSource.querySource) {
    case "main_turn":
      return "modelTrajectory.source.main";
    case "session_title":
      return "modelTrajectory.source.sessionTitle";
    case "compact":
      return "modelTrajectory.source.compact";
    case "prompt_enhance":
      return "modelTrajectory.source.promptEnhance";
    case "target_completion_verification":
      return "modelTrajectory.source.targetCompletion";
    case "subagent":
      return "modelTrajectory.source.subagent";
    default:
      break;
  }

  switch (callSource.kind) {
    case "main":
      return "modelTrajectory.source.main";
    case "subagent":
      return "modelTrajectory.source.subagent";
    case "compact":
      return "modelTrajectory.source.compact";
    case "sidecar":
      return "modelTrajectory.source.sidecar";
    case "unknown":
      return "modelTrajectory.source.unknown";
  }
}

// [契约] MessageBlock 同时承担输入行与普通消息行的渲染，形态由 role 与 parts 决定。
// [契约] callStartedAt/callDurationMs 属于所属调用的属性，逐条消息只做展示透传。
// [权衡] 有 parts 且角色已知时交给可展开组件，其余走轻量行，避免无谓的展开状态。
function MessageBlock({
  message,
  callStartedAt,
  callDurationMs,
  isAlt,
  expansionKey,
  intl,
}: {
  message: ZCodeModelTrajectoryMessage;
  callStartedAt: string;
  callDurationMs?: number;
  isAlt: boolean;
  expansionKey?: string;
  intl: IntlShape;
}) {
  // 只有已知角色才有 i18n key，未知角色直接展示原始 role，避免触发缺失 key。
  // [契约] knownRole 只影响文案与配色，不参与内容渲染分支。
  // [失败路径] 未知角色保留原始 role 字符串上屏，便于定位上游新增角色。
  const knownRole = ["system", "user", "assistant", "tool"].includes(message.role);
  // [契约] 已知角色走 i18n key，未知角色直接用原始值。
  // [权衡] 用数组 includes 而非 switch，保持判定与下方角色类型断言一致。
  // [失败路径] 缺失文案 key 时由 intl 兜底显示 key 本身，不会中断渲染。
  const roleLabel = knownRole
    ? intl.formatMessage({ id: `modelTrajectory.role.${message.role}` })
    : message.role;

  // [契约] 只有 system/user/tool 且含 parts 的消息进入可展开视图。
  // [契约] assistant 回复统一走 ResponseBlock 的行模型，避免与输入消息双路径渲染。
  // [权衡] parts 为空时降级为单行占位，而不是隐藏该条消息，保持行号连续。
  // [失败路径] role 不在白名单时跳过展开逻辑，直接落到下方只读行。
  if (
    (message.role === "system" || message.role === "user" || message.role === "tool") &&
    message.parts.length > 0
  ) {
    return (
      <ExpandableTrajectoryMessage
        message={message}
        role={message.role}
        roleLabel={roleLabel}
        callDurationLabel={
          typeof callDurationMs === "number" ? formatTrajectoryDuration(callDurationMs) : "—"
        }
        callDatetimeLabel={formatTrajectoryDateTime(callStartedAt)}
        callDatetimeTitle={callStartedAt}
        isAlt={isAlt}
        expansionKey={expansionKey}
        intl={intl}
      />
    );
  }

  return (
    <div
      data-trajectory-message-role={message.role}
      data-trajectory-search-target-key={expansionKey}
      data-trajectory-row-alt={isAlt || undefined}
      className={cn(
        "col-span-full grid min-h-8 min-w-0 grid-cols-subgrid px-3",
        isAlt && "bg-surface/30",
      )}
    >
      <span
        data-trajectory-role-label={knownRole ? message.role : "unknown"}
        className={cn(
          "pr-1 pt-0.5 font-mono text-ui-sm uppercase",
          knownRole
            ? trajectoryRoleTextClass(
                message.role === "tool"
                  ? "tool-result"
                  : (message.role as "system" | "user" | "assistant"),
              )
            : "text-foreground-subtlest",
        )}
      >
        {roleLabel}
      </span>
      <div
        data-trajectory-search-field="content"
        className="col-span-2 flex min-w-0 flex-col gap-1.5"
      >
        {message.parts.length === 0 ? (
          <span className="text-ui-sm text-foreground-subtlest">—</span>
        ) : (
          message.parts.map((part, partIndex) => (
            <ContentPartView key={partIndex} part={part} intl={intl} />
          ))
        )}
      </div>
    </div>
  );
}

// [契约] ResponseBlock 把一次响应拆成 reasoning、text、toolCalls 三类行。
// [契约] startRowIndex 是输入行数，用于延续全局交替底色，而不是从 0 重新计数。
// [资源] 行模型一次性构建后渲染，避免在 map 内再做条件判断。
function ResponseBlock({
  response,
  callStartedAt,
  callDurationMs,
  startRowIndex,
  expansionKeyPrefix,
  intl,
}: {
  response: NonNullable<ZCodeModelTrajectoryRecord["response"]>;
  callStartedAt: string;
  callDurationMs?: number;
  startRowIndex: number;
  expansionKeyPrefix?: string;
  intl: IntlShape;
}) {
  // [契约] 有内容 = 文本非空 或 推理非空 或 存在工具调用，三者取或。
  // [权衡] 用 Boolean 包裹而非长度判断，兼容上游把空串写进字段的情况。
  // [失败路径] 全部为空时整段返回 null，父级不会留下空 section 与相邻分隔线。
  // [契约] 该判定只看存在性，不校验内容合法性，格式问题交给 ContentPartView。
  const hasContent =
    Boolean(response.text) || Boolean(response.reasoningText) || response.toolCalls.length > 0;

  // [契约] 空响应是合法状态，必须早退而不是渲染空框。
  // [失败路径] 早退发生在 rows 构建之前，避免为无内容响应创建一次性数组。
  // [权衡] 返回 null 而非占位文案，空轨迹的整体提示由外层空状态负责。
  // [契约] 早退不影响错误块：调用失败时错误由 CallCard 独立渲染。
  if (!hasContent) {
    return null;
  }

  // [契约] 行 key 在单个 response 内必须唯一：reasoning、message、kind:index 三类前缀互不冲突。
  // [契约] 工具调用 key 用 kind + 下标，下标来自 forEach，顺序与响应数组一致。
  // [资源] 复用 ZCodeModelTrajectoryMessage 形状包装单行，让行组件无需区分来源。
  // [权衡] 工具调用不复用 message 的 key 前缀，避免与同名字段碰撞导致 React 复用错行。
  // [失败路径] 相同 kind 的多次调用依靠下标区分，因此禁止在上游重排 toolCalls。
  const rows: Array<{
    message: ZCodeModelTrajectoryMessage;
    roleLabel: string;
    key: string;
    visualRole?: "reasoning";
  }> = [];
  // [契约] 推理行排在文本行之前，与模型先思考后回答的时间顺序一致。
  // [契约] 推理内容用 visualRole 标记，由行组件决定弱化样式，不在此处写颜色。
  // [权衡] 推理与正文拆成两行，避免长推理把正文挤出可视区。
  if (response.reasoningText) {
    rows.push({
      key: "reasoning",
      message: { role: "assistant", parts: [{ kind: "text", text: response.reasoningText }] },
      roleLabel: intl.formatMessage({ id: "modelTrajectory.reasoning" }),
      visualRole: "reasoning",
    });
  }
  // [契约] 正文行使用 assistant 角色文案，与推理行区分。
  // [失败路径] 空串文本不生成行，保证 key 集合与可视行一一对应。
  // [资源] 单段 text 包装为一个 part，复用统一的内容渲染器。
  if (response.text) {
    rows.push({
      key: "message",
      message: { role: "assistant", parts: [{ kind: "text", text: response.text }] },
      roleLabel: intl.formatMessage({ id: "modelTrajectory.role.assistant" }),
    });
  }
  // [契约] 工具调用逐条成行，顺序严格跟随响应中的 toolCalls 数组。
  // [契约] 行内只放该次调用本身，参数与结果由 ContentPartView 按 kind 展开。
  // [失败路径] 数组为空则不产生任何行，section 仍可由文本或推理支撑。
  // [权衡] 不用嵌套列表，换取与消息行一致的展开与搜索行为。
  response.toolCalls.forEach((toolCall, toolCallIndex) => {
    rows.push({
      key: `${toolCall.kind}:${toolCallIndex}`,
      message: { role: "assistant", parts: [toolCall] },
      roleLabel: intl.formatMessage({ id: "modelTrajectory.toolCall" }),
    });
  });

  return (
    <section
      data-trajectory-section=""
      data-trajectory-response-section=""
      className="col-span-full grid grid-cols-subgrid overflow-hidden rounded-lg border border-card-border"
    >
      <TrajectorySectionTitle
        kind="output"
        label={intl.formatMessage({ id: "modelTrajectory.outputSection" })}
      />
      {rows.map((row, rowIndex) => (
        <Fragment key={row.key}>
          <TrajectoryRowDivider />
          <ResponseMessageRow
            message={row.message}
            roleLabel={row.roleLabel}
            visualRole={row.visualRole}
            callStartedAt={callStartedAt}
            callDurationMs={callDurationMs}
            isAlt={(startRowIndex + rowIndex) % 2 === 1}
            expansionKey={
              expansionKeyPrefix ? `${expansionKeyPrefix}:output:${row.key}` : undefined
            }
            intl={intl}
          />
        </Fragment>
      ))}
    </section>
  );
}

// [契约] 行分隔线独立成组件，保证标题与首行之间、行与行之间插入同一条 1px 线。
// [资源] 分隔线是 subgrid 全宽元素，不参与列内容，避免影响列宽计算。
// [权衡] 用背景色而非 border，避免相邻行边框叠加成 2px。
function TrajectoryRowDivider() {
  return <div data-trajectory-row-divider="" className="col-span-full h-px bg-border/50" />;
}

// [契约] ResponseMessageRow 是响应行的薄封装，角色固定 assistant，仅透传视觉角色。
// [契约] 时长缺失展示「—」，与输入消息行保持一致的空值策略。
// [权衡] 不在此组件内持有展开状态，key 由调用方统一拼接。
function ResponseMessageRow({
  message,
  roleLabel,
  visualRole,
  callStartedAt,
  callDurationMs,
  isAlt,
  expansionKey,
  intl,
}: {
  message: ZCodeModelTrajectoryMessage;
  roleLabel: string;
  visualRole?: "reasoning";
  callStartedAt: string;
  callDurationMs?: number;
  isAlt: boolean;
  expansionKey?: string;
  intl: IntlShape;
}) {
  return (
    <ExpandableTrajectoryMessage
      message={message}
      role="assistant"
      visualRole={visualRole}
      roleLabel={roleLabel}
      callDurationLabel={
        typeof callDurationMs === "number" ? formatTrajectoryDuration(callDurationMs) : "—"
      }
      callDatetimeLabel={formatTrajectoryDateTime(callStartedAt)}
      callDatetimeTitle={callStartedAt}
      isAlt={isAlt}
      expansionKey={expansionKey}
      intl={intl}
    />
  );
}

// [契约] 元数据只读 record 与 usage，不触发任何派生计算。
// [契约] 顺序固定为 IN、OUT、时长、开始时间，缺项直接跳过而不留空位。
// [资源] 时间展示同时给 clock 文案与原始时间 title，便于悬停核对。
function CallMetadata({
  record,
  usage,
}: {
  record: ZCodeModelTrajectoryRecord;
  usage?: ZCodeModelTrajectoryUsage;
}) {
  // [契约] items 是渲染前的扁平列表，与最终 span 一一对应。
  // [权衡] 先收集再 map，避免在 JSX 里堆叠四个条件片段。
  // [失败路径] token 为非数字（缺失或异常）时不生成条目，而不是显示 NaN。
  const items: Array<{ text: string; title?: string }> = [];
  // [契约] 输入 token 用本地化千分位展示，数值本身不做单位换算。
  // [失败路径] 仅接受 number，字符串化的数字同样被跳过，避免隐式转换出错。
  if (typeof usage?.inputTokens === "number") {
    items.push({ text: `IN ${usage.inputTokens.toLocaleString()}` });
  }
  if (typeof usage?.outputTokens === "number") {
    items.push({ text: `OUT ${usage.outputTokens.toLocaleString()}` });
  }
  if (typeof record.durationMs === "number") {
    items.push({ text: formatTrajectoryDuration(record.durationMs) });
  }
  // [契约] `startedAt` 永远存在，直接入列作为元数据末项且不做条件判断。
  // [契约] title 保留原始时间字符串，展示值走时钟格式，二者不可互换。
  // [权衡] `formatTrajectoryClockTime` 放最后：宽度变化时右侧最不易被压缩。
  items.push({ text: formatTrajectoryClockTime(record.startedAt), title: record.startedAt });

  return (
    <span
      data-trajectory-call-metadata=""
      className="ml-auto flex shrink-0 items-center gap-1 font-mono text-ui-xs text-foreground-subtlest"
    >
      {items.map((item, index) => (
        <span key={`${item.text}:${index}`} title={item.title}>
          {index > 0 ? "· " : ""}
          {item.text}
        </span>
      ))}
    </span>
  );
}

// [契约] finishReason 归一化后再匹配：转小写并把下划线折叠成连字符。
// [失败路径] 未知原因原样返回，不走 i18n，避免出现无效 key。
// [权衡] 只在标签层归一化，不修改 record 中的原始结束原因。
function finishReasonLabel(reason: string, intl: IntlShape): string {
  // [契约] stop、tool-call(s)、length、content-filter 四类映射到固定文案。
  // [契约] tool-call 与 tool-calls 是同一语义的两种拼写，必须映射到同一 key。
  // [失败路径] default 分支返回原字符串，保留上游新增原因的可见性。
  // [权衡] 用 replaceAll 处理下划线变体，避免为每种写法各写一个 case。
  // [契约] 调用方已保证 reason 为真值，此处不再重复判空。
  switch (reason.toLowerCase().replaceAll("_", "-")) {
    case "stop":
      return intl.formatMessage({ id: "modelTrajectory.finish.stop" });
    case "tool-call":
    case "tool-calls":
      return intl.formatMessage({ id: "modelTrajectory.finish.toolCalls" });
    case "length":
      return intl.formatMessage({ id: "modelTrajectory.finish.length" });
    case "content-filter":
      return intl.formatMessage({ id: "modelTrajectory.finish.contentFilter" });
    default:
      return reason;
  }
}
