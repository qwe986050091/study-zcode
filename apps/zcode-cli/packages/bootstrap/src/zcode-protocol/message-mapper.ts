// INV-01 纯投影不修改入参，只读字段重建新对象；守住位置：mapMessageWithParts 与 mapMessagePart；改错故障：入参被就地改写，同会话其他消费者读到被污染的会话事实。
// INV-02 所有 id 类字段统一 String() 化后出网；守住位置：base 三字段与 messageId/parentMessageId/锚点系列；改错故障：品牌化 id 进入 App，序列化后比较失败、消息定位错乱。
// INV-03 user 与 assistant 的 info 各自维护白名单，不共用一份字段表；守住位置：info 的 role 三元分支；改错故障：消费端按 role 判型取到 undefined，用户气泡或助手消息渲染异常。
// INV-04 assistant 的 model 只有 providerId 与 modelId 同时存在才产出；守住位置：info.model 条件表达式；改错故障：App 显示半截模型名，重试请求打到错误 provider。
// INV-05 reasoningLevel 只以 options.reasoningLevel 形式出现，无值时不产生空 options；守住位置：info.model 的展开；改错故障：下游误判显式推理等级，请求参数被覆盖。
// INV-06 error 只投影 name 与 data，剥离堆栈与原始对象；守住位置：assistant info.error 与 retry 分支；改错故障：内部错误结构或敏感细节进入 App 与 remote 回放。
// INV-07 不可用 tool 调用在投影前剔除，不生成半成品卡片；守住位置：parts 的 filter 谓词；改错故障：App 出现无工具名或参数不可恢复的卡片，用户无法重试或取消。
// INV-08 part 分派必须覆盖联合类型全部成员；守住位置：mapMessagePart 的 switch；改错故障：新增 part 类型静默消失，用户看不到该段内容。
// INV-09 subtask 在协议层改名为 subagent，字段集合不变；守住位置：case subtask；改错故障：App 按 core 类型匹配不到，子代理任务不显示。
// INV-10 timeline 的子类型字段按 timelineType 门控，非本类型一律 undefined；守住位置：case timeline 的逐字段三元；改错故障：跨类型字段串台，压缩事件被渲染成模型切换。
// INV-11 时间区间按协议拆成 startedAt 与 endedAt；守住位置：compaction 与 timeline 的 time 字段；改错故障：App 时间轴错位，压缩耗时显示为空或负值。
// INV-12 providerToolName 不进入公共协议；守住位置：mapToolPartMetadata；改错故障：内部 provider 空名占位透出，工具卡片标题空白。
// INV-13 readFileState 完整文件快照不进入任何客户端载荷；守住位置：mapToolStateMetadata；改错故障：单次 tool 更新携带整份文件，remote 带宽与隐私边界同时失守。
// INV-14 error state 的 modelContent 不透出；守住位置：mapErrorToolStateMetadata；改错故障：provider 原始消息进入 App，回放内容与模型历史不一致。
// INV-15 completed state 的 modelContentLayout 不透出；守住位置：mapCompletedToolStateMetadata；改错故障：内部媒体顺序泄漏，回放出现重复文本。
// INV-16 completed tool state 的 metadata 必须是对象，缺失时补空对象；守住位置：mapCompletedToolStateMetadata 的返回；改错故障：协议校验失败，整条 assistant 消息被客户端丢弃。
// INV-17 metadata 清洗采用无命中即原样返回，避免无谓拷贝；守住位置：三个 metadata 映射器的早返回；改错故障：高频 tool 流式更新产生多余对象分配，界面卡顿。
// INV-18 不设 default 分支，也不做 hydration 或补默认值；守住位置：mapMessagePart 的 switch 尾部；改错故障：兜底分支把未知类型降级成空 part，掩盖协议不兼容。
//
// 模块职责：把 core 的 MessageWithParts 单向投影为 App/remote 消费的 ZCodeMessageWithParts，只挑公共字段。
// 状态所有权：会话事实归 core 与 Agent，本文件只读不写、不缓存、不做 hydration 或补齐。
// 阅读顺序：info 的 role 分支 → parts 过滤 → mapMessagePart 穷举分派 → 三个 tool metadata 清洗器。
import type { ZCodeMessagePart, ZCodeMessageWithParts, ZCodeToolState } from "@zcode/shared";
// 入参类型来自 @zcode/contracts（core 事实），出参类型来自 @zcode/shared（公共协议），方向单向且不可逆。
// 本文件不提供反向映射：协议消息不回灌成 core 消息，避免出现第二个事实源。
import type { MessagePart, MessageWithParts, ToolState } from "@zcode/contracts";
// 工具调用可见性判据收敛在 tool-call-product-visibility 模块，本文件只消费判定结论，不重复实现规则。
import { shouldHideInvalidToolCallFromProduct } from "../tool-call-product-visibility.js";

/**
 * 把 core 的 MessageWithParts 投影为 App/remote 协议消息：只挑公共字段，剥离 provider 内部状态。
 * user/assistant 走两套 info 形状；parts 先过滤不应展示的非法 tool 调用，再按 type 投影。
 * 纯映射：不修改入参、不做 hydration，会话恢复所需数据由 Agent 自己保留。
 */
// [契约] 逐条映射：每条消息独立投影，不跨消息聚合、不排序、不补默认值；异常向上抛给调用方。
// [权衡] 逐字段显式列举而非对象展开：core 新增字段不会自动透出，必须先确认再进白名单。
export function mapMessageWithParts(message: MessageWithParts): ZCodeMessageWithParts {
  return {
    info:
      message.info.role === "user"
        ? {
            agent: message.info.agent,
            messageId: String(message.info.id),
            model: message.info.modelSelection,
            // user info 逐字段白名单：metadata、system、tools、visibility 等按原样透传，未列出的 core 字段不下发。
            // synthetic 与 system 表达消息来源，App 据此隐藏用户气泡或标注系统注入，因此不能省略。
            metadata: message.info.metadata,
            role: "user",
            semantics: message.info.semantics,
            sessionId: String(message.info.sessionID),
            source: message.info.source,
            system: message.info.system,
            synthetic: message.info.synthetic,
            time: message.info.time,
            tools: message.info.tools,
            visibility: message.info.visibility,
          }
        : {
            agent: message.info.agent,
            cost: message.info.cost,
            // error 只在存在时产出 name 与 data，并存成宽松记录：堆栈、cause 等内部结构不进协议。
            // [失败路径] 缺省时字段为 undefined 而不是空对象，App 才能区分「没有错误」与「错误信息为空」。
            error: message.info.error
              ? ({ name: message.info.error.name, data: message.info.error.data } as Record<
                  string,
                  unknown
                >)
              : undefined,
            finish: message.info.finish,
            messageId: String(message.info.id),
            // model 由 providerId 与 modelId 拼装，两者缺一就整体置 undefined，避免下游拼出无效模型。
            // reasoningLevel 非空时才展开 options，防止出现空 options 被当作显式推理等级下发给 provider。
            model:
              message.info.providerId && message.info.modelId
                ? {
                    providerId: message.info.providerId,
                    modelId: message.info.modelId,
                    ...(message.info.reasoningLevel
                      ? { options: { reasoningLevel: message.info.reasoningLevel } }
                      : {}),
                  }
                : undefined,
            // [权衡] parentMessageId 直接 String() 不做兜底：core 若丢失 parentID 会得到字符串 undefined，这属于契约违背，应回 core 修。
            parentMessageId: String(message.info.parentID),
            path: message.info.path,
            role: "assistant",
            semantics: message.info.semantics,
            sessionId: String(message.info.sessionID),
            structured: message.info.structured,
            time: message.info.time,
            tokens: message.info.tokens,
          },
    // 非法工具调用（缺工具名/参数不可恢复）不进入产品协议，避免 App 渲染出不可用的卡片。
    // parts 保持 core 数组原序：文本、推理与工具调用的交错顺序就是流式呈现顺序，映射不重排不合并。
    // [失败路径] filter 只针对 type 为 tool 的项，其它 part 一律保留，避免可见性规则误删正文。
    parts: message.parts
      .filter(
        (part) =>
          part.type !== "tool" || !shouldHideInvalidToolCallFromProduct(part.tool, part.metadata),
      )
      .map(mapMessagePart),
  };
}

// 按 part.type 穷举分派；base 统一提供 id/session 关联字段，各分支只补自己的公共载荷。
// base 由 messageID、id、sessionID 三个关联字段派生，所有分支共用同一套前缀，避免逐分支重复写。
// [失败路径] switch 不写 default：新增 part 类型时由类型检查拦住缺少返回，而不是运行时静默返回 undefined。
function mapMessagePart(part: MessagePart): ZCodeMessagePart {
  const base = {
    messageId: String(part.messageID),
    partId: String(part.id),
    sessionId: String(part.sessionID),
  };
  switch (part.type) {
    case "text":
      return {
        ...base,
        // [权衡] ignored 只属于 text：不抬升为 base 字段，避免其它 part 出现永远为空的键。
        ignored: part.ignored,
        metadata: part.metadata,
        synthetic: part.synthetic,
        text: part.text,
        type: "text",
      };
    case "reasoning":
      return { ...base, metadata: part.metadata, text: part.text, type: "reasoning" };
    case "file":
      return {
        ...base,
        filename: part.filename,
        // file 的 metadata 在 core 侧是具体联合类型，协议层放宽为宽松记录，因为 App 只做展示不解析结构。
        metadata: part.metadata as Record<string, unknown> | undefined,
        mime: part.mime,
        type: "file",
        url: part.url,
      };
    case "tool":
      return {
        ...base,
        callId: part.callID,
        // tool 是唯一需要二次清洗的 part：metadata 走 mapToolPartMetadata，state 走 mapToolState 四态映射。
        // [失败路径] 清洗只删已知内部键，未知内部键仍会透传；新增内部字段必须同步加入删除清单。
        metadata: mapToolPartMetadata(part.metadata),
        state: mapToolState(part.state),
        tool: part.tool,
        type: "tool",
      };
    case "step-start":
      // step-start 与 snapshot 只带快照标识，作为回滚与时间轴锚点；不在此扩展执行细节。
      return { ...base, snapshot: part.snapshot, type: "step-start" };
    case "step-finish":
      return {
        ...base,
        cost: part.cost,
        reason: part.reason,
        snapshot: part.snapshot,
        tokens: part.tokens,
        type: "step-finish",
      };
    case "snapshot":
      return { ...base, snapshot: part.snapshot, type: "snapshot" };
    case "patch":
      return { ...base, files: part.files, hash: part.hash, type: "patch" };
    // compaction 把时间窗拆成 startedAt/endedAt，并保留 attempt/phase 供 App 展示重试进度。
    // compaction 的 metadata 是一次性重建的普通对象，不做事后删键：内部字段必须在构造时就没被列出。
    // time 不复用 core 对象，而是拆成 startedAt 与 endedAt，App 无需理解 core 的时间结构。
    case "compaction":
      return {
        ...base,
        auto: part.auto,
        metadata: {
          attempt: part.attempt,
          boundaryId: part.boundaryId,
          compactReason: part.compactReason,
          endedAt: part.time?.end,
          maxAttempts: part.maxAttempts,
          operationId: part.operationId,
          phase: part.phase,
          postCompactTokenCount: part.postCompactTokenCount,
          preCompactTokenCount: part.preCompactTokenCount,
          reason: part.reason,
          replace: part.replace,
          startedAt: part.time?.start,
          summaryMessageId: part.summaryMessageId,
          timelineStatus: part.timelineStatus,
          truePostCompactTokenCount: part.truePostCompactTokenCount,
          trigger: part.trigger,
        },
        reason: part.reason,
        summaryMessageId: part.summaryMessageId,
        type: "compaction",
      };
    // timeline 是多类事件的合流：context_compaction/session_fork/model_change/goal_verification
    // 各自只投影相关字段，其余置 undefined，避免跨类型字段泄漏。
    case "timeline":
      return {
        ...base,
        anchorMessageId: part.anchorMessageId ? String(part.anchorMessageId) : undefined,
        anchorTurnId: part.anchorTurnId ? String(part.anchorTurnId) : undefined,
        // timeline 每个可选字段都写成命中判据在前的三元表达式，逐字段即可核对归属，避免统一前置分支漏字段。
        // [失败路径] 漏写门控会把 compaction 的 attempt 带到 model_change 事件上，App 重试进度条凭空出现。
        attempt: part.timelineType === "context_compaction" ? part.attempt : undefined,
        boundaryId: part.timelineType === "context_compaction" ? part.boundaryId : undefined,
        compactReason: part.timelineType === "context_compaction" ? part.compactReason : undefined,
        display: part.display,
        fromModel: part.timelineType === "model_change" ? part.fromModel : undefined,
        goalIteration: part.timelineType === "goal_verification" ? part.goalIteration : undefined,
        maxAttempts: part.timelineType === "context_compaction" ? part.maxAttempts : undefined,
        operationId: part.timelineType === "context_compaction" ? part.operationId : undefined,
        parentSessionId:
          part.timelineType === "session_fork" ? String(part.parentSessionId) : undefined,
        phase: part.timelineType === "context_compaction" ? part.phase : undefined,
        postCompactTokenCount:
          part.timelineType === "context_compaction" ? part.postCompactTokenCount : undefined,
        preCompactTokenCount:
          part.timelineType === "context_compaction" ? part.preCompactTokenCount : undefined,
        reason: part.timelineType === "context_compaction" ? part.reason : undefined,
        restoredFileCount:
          part.timelineType === "session_fork" ? part.restoredFileCount : undefined,
        status: part.status,
        summaryMessageId:
          part.timelineType === "context_compaction" && part.summaryMessageId
            ? String(part.summaryMessageId)
            : undefined,
        targetCheckpointId:
          part.timelineType === "session_fork" ? part.targetCheckpointId : undefined,
        targetId: part.timelineType === "goal_verification" ? part.targetId : undefined,
        targetMessageId:
          part.timelineType === "session_fork" ? String(part.targetMessageId) : undefined,
        time: part.time,
        timelineType: part.timelineType,
        toModel: part.timelineType === "model_change" ? part.toModel : undefined,
        trigger: part.timelineType === "context_compaction" ? part.trigger : undefined,
        truePostCompactTokenCount:
          part.timelineType === "context_compaction" ? part.truePostCompactTokenCount : undefined,
        // display、status、time、timelineType 是各子类型共用的展示字段，原样透传；锚点 id 只在存在时字符串化。
        type: "timeline",
        verification: part.timelineType === "goal_verification" ? part.verification : undefined,
        verificationId: part.timelineType === "goal_verification" ? part.verificationId : undefined,
      };
    case "subtask":
      return {
        ...base,
        agent: part.agent,
        command: part.command,
        description: part.description,
        model: part.model,
        prompt: part.prompt,
        // subtask 到 subagent 的改名只发生在协议 type 上，agent、command、description、model、prompt 字段名保持不变。
        // [失败路径] 消费端若按 core 的 subtask 匹配会漏掉整条记录，子任务列表出现空缺。
        type: "subagent",
      };
    case "agent":
      return { ...base, name: part.name, type: "agent" };
    case "retry":
      return {
        ...base,
        attempt: part.attempt,
        // retry 的 error 与 assistant info.error 采用同一裁剪口径，只保留 name 与 data，两处错误展示才一致。
        // [权衡] retry 不带 title、output：它只表达失败与重试次数，工具结果仍挂在原 tool part 上。
        error: { name: part.error.name, data: part.error.data },
        type: "retry",
      };
  }
}

function mapToolPartMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  // 用 hasOwnProperty 而不是 in：只有自身属性才触发克隆，避免原型链同名键导致误删。
  // [权衡] 无命中时直接返回原引用不复制，在 tool 高频更新路径上省掉一次次浅拷贝。
  if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, "providerToolName")) {
    return metadata;
  }
  // providerToolName 只用于 Agent cold hydration 恢复模型原始空名；App 使用
  // ToolPart.tool 的 non-empty 占位值，不能把内部 provider 字段投影到公共协议。
  const visibleMetadata = { ...metadata };
  delete visibleMetadata.providerToolName;
  // 删空后返回 undefined 而不是空对象：协议用 undefined 表示没有 metadata，空对象会被当成有值。
  return Object.keys(visibleMetadata).length > 0 ? visibleMetadata : undefined;
}

// 工具状态四态映射：running/completed 带 title，error 不带 title 但保留 error 结构。
// 四态与 core 的 ToolState 状态一一对应，不合并也不新增中间态，App 直接按 status 渲染。
// [权衡] pending 不带 title 与 startedAt：尚未开始执行，补值会误导进度展示。
function mapToolState(state: ToolState): ZCodeToolState {
  switch (state.status) {
    case "pending":
      return { input: state.input, raw: state.raw, status: "pending" };
    case "running":
      return {
        input: state.input,
        metadata: mapToolStateMetadata(state.metadata),
        startedAt: state.time.start,
        status: "running",
        title: state.title,
      };
    case "completed":
      return {
        completedAt: state.time.end,
        input: state.input,
        // completed 用专用清洗器：先剔 readFileState，再剔 modelContentLayout，最后保证返回对象。
        // [失败路径] 该分支清洗链最长，任一环漏删都会把内部快照带进 remote 可回放载荷。
        metadata: mapCompletedToolStateMetadata(state.metadata),
        output: state.output,
        startedAt: state.time.start,
        status: "completed",
        title: state.title,
      };
    case "error":
      return {
        completedAt: state.time.end,
        // error 态不透传 title：失败时 title 往往只是工具名占位，保留会让 App 误以为已有结果。
        error: state.error,
        input: state.input,
        metadata: mapErrorToolStateMetadata(state.metadata),
        startedAt: state.time.start,
        status: "error",
      };
  }
}

function mapToolStateMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  // readFileState 是 agent 恢复用的完整文件快照，只允许留在 core 内部，不进入任何客户端载荷。
  // [失败路径] 一旦透出，单次更新可能携带整份文件，带宽与隐私边界同时失守。
  if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, "readFileState")) {
    return metadata;
  }
  const protocolMetadata = { ...metadata };
  // readFileState 携带完整文件快照，只用于 agent resume 内部恢复；
  // app/remote protocol 只需要展示 metadata，不能把文件内容藏在 tool state metadata 里透出。
  delete protocolMetadata.readFileState;
  return protocolMetadata;
}

function mapErrorToolStateMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const protocolMetadata = mapToolStateMetadata(metadata);
  if (
    !protocolMetadata ||
    !Object.prototype.hasOwnProperty.call(protocolMetadata, "modelContent")
  ) {
    return protocolMetadata;
  }
  // error modelContent 只用于 Agent 精确恢复 provider history，
  // 不能作为新的 App / remote protocol metadata 暴露。
  const visibleMetadata = { ...protocolMetadata };
  // modelContent 保存 provider 原始消息，仅用于 Agent 精确恢复 history，不能出现在 error state 的 metadata。
  // [失败路径] 漏删会让错误卡片附带模型原始输出，既暴露内部提示，也让重试拼错历史。
  delete visibleMetadata.modelContent;
  return visibleMetadata;
}

function mapCompletedToolStateMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const protocolMetadata = mapToolStateMetadata(metadata);
  if (
    !protocolMetadata ||
    !Object.prototype.hasOwnProperty.call(protocolMetadata, "modelContentLayout")
  ) {
    // [契约] completed tool state 的 metadata 必须是对象，缺失时统一补空对象而不是留 undefined。
    // [失败路径] 补位只发生在 completed：running 与 error 允许 undefined，扩散补位会让下游分不清无值与空值。
    return protocolMetadata ?? {};
  }
  // modelContentLayout 只供 Agent 冷恢复重建 tool result 媒体顺序，
  // completed metadata 原样映射会把内部布局和重复文本带入 App / remote replayable payload。
  const visibleMetadata = { ...protocolMetadata };
  // modelContentLayout 描述 tool result 媒体的内部顺序，仅供 Agent 冷恢复重建，不属于公共协议。
  // [权衡] 与 modelContent 分两步删键而非一次白名单重建，保留展示字段时改动面更小。
  delete visibleMetadata.modelContentLayout;
  // core 的历史/异常 completed tool part 可能没有 metadata，但
  // ZCode protocol 的 completed tool state 要求 metadata 必须是 object。
  return visibleMetadata;
}
