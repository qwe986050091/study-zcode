/**
 * ============================================================================
 * runtime/helpers/steering.ts —— steering 上限、fork 克隆与 rewind 提示文案
 * ============================================================================
 *
 * 【定位】本文件只提供可复用的"纯数据操作"：
 *   1) steering 输入的字节上限、UTF-8 计量与预览；
 *   2) fork 时对 MessageInfo / MessagePart 的值拷贝与 local id 重映射；
 *   3) rewind / fork 的系统提示文案（注入模型前统一 sanitize）。
 *
 * 【边界】guide（内联当前 turn）与 queue（作为独立轮排队）的投递语义、reservation
 *   与 TurnSteer 事件都在 runtime/methods/steering.ts；本文件不持有 active turn 状态、
 *   不落盘、不发事件。改这里只影响"数据形状/文案"，不会改变投递策略。
 *
 * 【不变量】fork 产生的 child 只允许引用 child 内的 local id；父 id 只能作为
 *   forkOrigin / originAnchor* 等 provenance 字段保留，不得参与 child 的落位与排序。
 * ============================================================================
 */
import { createPartId } from "../deps.js";
import type {
  MessageId,
  MessageInfo,
  MessagePart,
  ModelInputMessage,
  SessionId,
  TurnId,
} from "../deps.js";

/** steering 输入的硬上限（UTF-8 字节）；超限由 methods/steering.ts 拒绝，本文件只提供常量。 */
export const MAX_TURN_STEER_INPUT_BYTES = 200_000;

/** 预览文案的字符上限（不是字节），用于事件/UI 展示，不用于准入判定。 */
const TURN_STEER_INPUT_PREVIEW_CHARS = 200;

/**
 * 以 UTF-8 字节计量字符串长度（emojis/中文等多字节字符按真实传输体积计）。
 * 纯函数；用于与 MAX_TURN_STEER_INPUT_BYTES 比较，不能用 .length 替代。
 */
export function measureUtf8Bytes(value: string): number {
  // 不能用 string.length 代替：.length 数的是 UTF-16 code unit，中文/emoji 会被少算，
  // 200_000 字节的闸门实际放行数倍体积，请求到了 provider 才被拒绝，用户侧表现为"发送失败"。
  // TextEncoder 固定按 UTF-8 编码（孤立代理项替换为 U+FFFD），与 JSON 落盘的字节口径一致；
  // 它也同时能在浏览器侧运行，所以不能换成 Node 专有的 Buffer.byteLength。
  return new TextEncoder().encode(value).byteLength;
}

/**
 * 生成单行预览：把所有空白折叠成一个空格、trim，超过 200 字符截断并加 "..."。
 * 纯函数；只用于事件/UI 展示与日志，不参与准入，也不应被用作持久化正文。
 */
export function previewInput(value: string): string {
  // 先折叠所有空白（含换行/制表）再 trim：预览要落进事件 payload 的单行字段，
  // 保留换行会撑开 UI 列表，也会让按行解析日志的下游把一条事件读成多行。
  const normalized = value.replace(/\s+/g, " ").trim();
  // 这里按字符（UTF-16）而非字节判断：本函数只服务展示，不进准入判定，
  // 用字节口径反而会让同一句话在中文下被截得更短。
  if (normalized.length <= TURN_STEER_INPUT_PREVIEW_CHARS) return normalized;
  // 截断可能切断 emoji 的代理对，UI 会渲染出替换字符；因为预览不参与持久化与模型输入，
  // 这点损耗可接受，但绝不能把这段结果回灌成用户正文。
  return `${normalized.slice(0, TURN_STEER_INPUT_PREVIEW_CHARS)}...`;
}

/**
 * 从消息数组末尾向前找最近一条 user 消息，返回**距末尾的距离**（0 = 最后一条），
 * 不是绝对下标；找不到返回 undefined。
 * 为什么用距离：后续按"需要保留的尾部条数"切片，距离比下标更适合这个调用习惯。
 * 纯查询，不修改数组。
 */
export function findLatestUserMessageFromEnd(
  messages: ModelInputMessage[],
): number | undefined {
  // 倒序扫描而不是 filter/findIndex：只需要最近一条 user 的位置，
  // 从尾部开始通常几步就命中，长会话里省掉一次全量遍历。
  for (let index = messages.length - 1; index >= 0; index--) {
    // 可选链是必需的：入参数组可能由裁剪逻辑拼出，尾部元素未完整构造而为空，
    // 直接读 .role 会在裁剪边界上抛 TypeError 并中断整个 turn 提交。
    if (messages[index]?.role === "user") {
      // 返回"距末尾的距离"而非绝对下标：调用方按 slice(-distance) 取尾部，
      // 后续追加消息时相对尾部的语义不变，而绝对下标会随长度变化而失效。
      return messages.length - 1 - index;
    }
  }
  // 找不到时返回 undefined 而不是 -1 或 0：0 与"最后一条就是 user"无法区分，
  // 调用方必须能分辨"没有 user"和"user 在末尾"这两种完全不同的裁剪起点。
  return undefined;
}

/**
 * fork 时克隆一条消息：生成 child-local 的 messageId，并重映射 parentID 与 anchor。
 *
 * 输入：父消息、fork 目标 sessionId、id 映射表（父→子）、新 messageId、各类身份映射、
 *   strictLocalReferences（严格模式：引用父会话之外的 id 直接抛错）。
 * 输出：新 MessageInfo；metadata 合并 forkOrigin（父 sessionId + 父 messageId）作为溯源。
 * 副作用：无 I/O、无持久化；只创建内存对象。caller 负责落库与排序。
 * 失败语义：assistant 消息的 parentID 无法重映射时，严格模式抛错；非严格模式保留父 id
 *   （兼容 legacy workspace fork 的残缺映射），但该引用不作为 child 落位依据。
 * 不变量：user 消息不改 parentID；每个 child 消息 id 必须唯一（由 caller 生成）。
 */
export function cloneMessageForFork(
  message: MessageInfo,
  options: {
    forkedSessionId: SessionId;
    messageIdMap: Map<MessageId, MessageId>;
    nextMessageId: MessageId;
    turnIdMap?: Map<string, string>;
    productTurnIdMap?: Map<string, string>;
    targetIdMap?: Map<string, string>;
    verificationEntryIdMap?: Map<string, string>;
    strictLocalReferences?: boolean;
  },
): MessageInfo {
  // copy by value + provenance：child 用新 local id 排序/渲染/
  // 续写，forkOrigin 只供溯源与 debug，不参与 child 的 UI placement。
  // 这两个字段必须在克隆前从入参读出：往下走 message.id 会被替换成 nextMessageId，
  // 晚一步取到的就是 child 自己的 id，溯源链自指、再也回不到父消息。
  const forkOrigin = {
    sessionId: String(message.sessionID),
    messageId: String(message.id),
  };
  // 只有父消息带 anchor 时才深克隆：anchor 里的 turnId/目标/边界全是父会话身份，
  // 原样被 ...message 带进 child 会让 UI 按父 id 定位滚动位置（落空或跳到别的消息）。
  const anchor = message.anchor
    ? cloneMessageAnchorForFork(message.anchor, options)
    : undefined;
  // user 消息不参与 assistant 的父子链：它的 parentID 保持原值（通常为空），
  // 若也走下面的重映射，严格模式会因"父 id 不在 child 内"误报错，合法 fork 直接被拒。
  if (message.role === "user") {
    // 拷贝后只覆盖身份字段，正文/时间戳/usage 一律沿用父值；
    // 换新 id 是 child 内唯一性的前提，messageIdMap 的反查也依赖这份新 id。
    return {
      ...message,
      id: options.nextMessageId,
      sessionID: options.forkedSessionId,
      ...(anchor ? { anchor } : {}),
      // metadata 先展开父值再覆盖 forkOrigin：整体替换会丢掉 usage/来源等诊断字段，
      // 而只写 { forkOrigin } 会让父 metadata 与 child 的溯源混成同一份。
      metadata: { ...message.metadata, forkOrigin },
    };
  }

  // assistant 的父消息未必一起被复制（fork 点切在 assistant 上时，父 user 可能在裁剪范围外），
  // 所以"查不到"是正常情况，必须显式区分命中与未命中。
  const parentID = options.messageIdMap.get(message.parentID);
  // 严格模式直接抛错：保留父 id 会让 child 的消息树挂到另一个会话的节点上，
  // 投影按 parentID 建树时把整条父分支拉进来，表现为 child 首屏重复出现旧消息。
  if (!parentID && options.strictLocalReferences) {
    throw new Error(`Fork assistant parent is outside child transcript: ${message.parentID}`);
  }
  // 未命中时回退父值，仅服务 legacy workspace fork 的残缺映射：
  // 该引用只能作溯源，不得再被 caller 用于排序、挂载或裁剪切片。
  return {
    ...message,
    id: options.nextMessageId,
    sessionID: options.forkedSessionId,
    parentID: parentID ?? message.parentID,
    ...(anchor ? { anchor } : {}),
    metadata: { ...message.metadata, forkOrigin },
  };
}

/**
 * 克隆消息 anchor：把 turnId / productTurnId / orderedMessageIds / boundaryMessageId
 * 与 goalBoundary 内的 target / verificationEntryIds 全部重映射到 child 身份。
 *
 * 输入：父 anchor、同 cloneMessageForFork 的 options（含 target/verification/turn 映射）。
 * 输出：新 anchor；未提供的映射在非严格模式保留父值（仅作溯源）。
 * 失败语义：严格模式下找不到 child-local 身份时抛错，防止 child 引用父会话的 turn/目标。
 * 副作用：无；只读映射表，不写入。
 * 注意：goalBoundary 只处理 kind="snapshot" 分支，非 snapshot 原样保留。
 */
function cloneMessageAnchorForFork(
  anchor: NonNullable<MessageInfo["anchor"]>,
  options: Parameters<typeof cloneMessageForFork>[1],
): NonNullable<MessageInfo["anchor"]> {
  // 统一的消息 id 重映射口：命中即换 child-local id；未命中在严格模式抛错，
  // 因为静默沿用父 id 会让 child 的 orderedMessageIds/boundary 指向不存在消息，
  // 投影按该 id 找不到边界，历史会少掉一截却不报错。
  const mapMessage = (id: MessageId, field: string): MessageId => {
    const mapped = options.messageIdMap.get(id);
    if (!mapped && options.strictLocalReferences) {
      throw new Error(`Fork ${field} is outside child transcript: ${id}`);
    }
    // 非严格模式的回退值只作 provenance：一旦有调用方拿它去比较或切片，
    // 父会话消息就会混进 child 的渲染集。
    return mapped ?? id;
  };
  // turn/target/verification 的身份映射走可选 Map（一次 fork 只带部分身份域），
  // 所以"map 缺席"与"查不到"要分开表达：缺席在非严格模式可回退，查不到在严格模式即失败。
  const mapIdentity = (
    id: string,
    map: Map<string, string> | undefined,
    field: string,
  ): string => {
    // 可选链查表：该身份域的映射表可能整张缺席（这次 fork 没带它），
    // 所以不能先断言存在再 get，否则会抛 TypeError 而不是走显式降级。
    const mapped = map?.get(id);
    if (!mapped && options.strictLocalReferences) {
      throw new Error(`Fork ${field} has no child-local identity: ${id}`);
    }
    // 非严格模式回退父身份：child 会继承父会话的 turn/target 语义，
    // 只可用于展示溯源，调用方不能再据此发起续跑或写回。
    return mapped ?? id;
  };
  // 只有 snapshot 形态携带运行坐标（target/verification）需要重映射；
  // 其他形态是父值的纯数据拷贝，改写反而破坏既有语义。
  const goalBoundary =
    anchor.goalBoundary?.kind === "snapshot"
      ? {
          kind: "snapshot" as const,
          target: {
            ...anchor.goalBoundary.target,
            // 归属 session 必须换成 child：仍指向父会话时，child 的目标续跑会去父会话
            // 找 active run，两个会话会争抢同一份执行权。
            sessionID: options.forkedSessionId,
            // target 实体在 fork 时会为 child 另建一条记录，必须按 targetIdMap 换 id；
            // 漏映射会让 child 的 goal 直接操作父会话的目标。
            targetID: mapIdentity(
              anchor.goalBoundary.target.targetID,
              options.targetIdMap,
              "goal target",
            ),
            // 进行中的输入提示属于父 turn 的瞬态，继承下来会让 child 首屏显示一条
            // 并不存在的"正在处理"，用户会等一个永远不会来的结果。
            activeInputId: null,
            // 父会话的在飞 run 事实不能被 child 继承，否则续跑会误认领父 run；
            // 必须显式清空，child 从"没有 active run"开始。
            activeRunStartedAtMs: null,
            activeRunLastSeenAtMs: null,
          },
          // 每条验证记录都要换 child 身份：漏映射会让 child 的验收结果写回父条目，
          // 后续按 verificationEntryId 查进度时读到的是另一个会话的记录。
          verificationEntryIds: anchor.goalBoundary.verificationEntryIds.map((id) =>
            mapIdentity(id, options.verificationEntryIdMap, "goal verifier entry"),
          ),
        }
      : anchor.goalBoundary;
  // 所有可选字段都用"有值才展开"：写成 turnId: undefined 会把父 anchor 的同名字段
  // 显式抹成空值，投影据此判定"不属于任何回合"，消息会掉出回合视图。
  return {
    ...anchor,
    ...(anchor.turnId
      ? {
          turnId: mapIdentity(
            String(anchor.turnId),
            options.turnIdMap,
            "anchor turn",
          ) as TurnId,
        }
      : {}),
    ...(anchor.productTurnId
      ? {
          productTurnId: mapIdentity(
            anchor.productTurnId,
            options.productTurnIdMap,
            "anchor product turn",
          ),
        }
      : {}),
    // orderedMessageIds 是 UI 渲染顺序的权威列表，必须逐项重映射：
    // 漏掉任意一项，child 首屏就会出现空洞——消息已落库但不显示。
    ...(anchor.orderedMessageIds
      ? {
          orderedMessageIds: anchor.orderedMessageIds.map((id) =>
            mapMessage(id, "anchor orderedMessageId"),
          ),
        }
      : {}),
    // boundaryMessageId 标记可见历史的下界；保留父 id 时投影比较不到边界，
    // 会把本该裁掉的历史重新渲染出来（表现为 fork 后看到父分支的旧内容）。
    ...(anchor.boundaryMessageId
      ? {
          boundaryMessageId: mapMessage(
            anchor.boundaryMessageId,
            "anchor boundaryMessageId",
          ),
        }
      : {}),
    // goalBoundary 用条件展开而不是直接赋值：非 snapshot 时它可能是 undefined，
    // 显式写入会让 anchor 多出一个"存在但为空"的字段，下游解构时误判为已设置。
    ...(goalBoundary ? { goalBoundary } : {}),
  };
}

/**
 * fork 时克隆一个 part，并重映射其内嵌引用（timeline 锚点、compaction 边界、tool 调用与附件）。
 *
 * 输入：父 part、fork 目标 sessionId、新 messageId/partId 与各类 id 映射、strict 开关。
 * 输出：新 MessagePart；**不修改入参数**（浅拷贝后按需替换引用字段）。
 * 副作用：无 I/O；附件会生成新的 part id（未提供 partIdMap 时）并指向新 message。
 * 失败语义：严格模式下任何父会话引用无法重映射都抛错；非严格模式：
 *   timeline 锚点不可映射时降级为 originAnchorMessageId / originAnchorTurnId 并删除本地锚点。
 * 口径差异：compaction 引用属于 provider-context 语义（非 UI 落位），不可映射时保留原值。
 */
export function clonePartForFork(
  part: MessagePart,
  options: {
    forkedSessionId: SessionId;
    nextMessageId: MessageId;
    nextPartId?: MessagePart["id"];
    partIdMap?: Map<MessagePart["id"], MessagePart["id"]>;
    messageIdMap?: Map<MessageId, MessageId>;
    turnIdMap?: Map<string, string>;
    targetIdMap?: Map<string, string>;
    verificationIdMap?: Map<string, string>;
    toolCallIdMap?: Map<string, string>;
    strictLocalReferences?: boolean;
  },
): MessagePart {
  // 先浅拷贝再按需替换：入参 part 可能仍被父会话持有，就地改字段会让父分支一起变；
  // 嵌套对象（state/compactBoundary）在下面整体重建，不复用共享引用。
  const cloned = {
    ...part,
    id: options.nextPartId ?? createPartId(),
    sessionID: options.forkedSessionId,
    messageID: options.nextMessageId,
  } as MessagePart;
  const messageIdMap = options.messageIdMap;
  // 没有映射表说明调用方只要求"换身份后原样复制"（例如侧会话的首条 part），
  // 此时不能继续走引用重映射，否则每个引用都会因查不到而落到非严格回退分支。
  if (!messageIdMap) return cloned;
  // 这里另建一份而不复用 anchor 侧的闭包：part 的重映射只看 messageIdMap，
  // 严格判定参数相同但影响面不同（part 悬空引用会被当作该片段不存在而静默丢弃）。
  const mapMessage = (id: MessageId, field: string): MessageId => {
    // 用闭包捕获的 messageIdMap 而不是再读 options：上面已确认它非空，
    // 这里若重新取属性，后续重构成可选字段时会悄悄退回父 id。
    const mapped = messageIdMap.get(id);
    if (!mapped && options.strictLocalReferences) {
      throw new Error(`Fork ${field} is outside child transcript: ${id}`);
    }
    // 回退值只在非严格模式出现（legacy 残缺映射）；它一旦被用于落位，
    // 该 part 就会挂到父会话的消息上，重放时查不到而整段消失。
    return mapped ?? id;
  };
  // turn 映射表可缺省（legacy 落盘数据只有 message 级身份），缺省时调用方需自行走非严格
  // 降级；但表一旦在场就必须命中，静默保留父 turn 会让时间线挂到父会话的回合上。
  const mapTurn = (id: TurnId, field: string): TurnId => {
    // String(id) 是查表键归一化：turnId 可能是模板字符串拼出的字符串字面量类型，
    // 直接用对象身份比较永远不命中，必须转成同一种 string 再查。
    const mapped = options.turnIdMap?.get(String(id));
    if (!mapped && options.strictLocalReferences) {
      throw new Error(`Fork ${field} has no child-local identity: ${id}`);
    }
    // 断言回 TurnId 是安全的：映射表的值由 caller 用 child 的 turnId 构造，
    // 非严格模式的回退值本来就是 TurnId，不引入新的身份。
    return (mapped ?? id) as TurnId;
  };

  // part 级内嵌引用 remap（不得原样拷贝父 id）。
  // anchor 类引用参与 child 落位：可 remap 则换 local id，不可 remap 必须清空并
  // 降级 originAnchorMessageId（不得把父 id 当 child 本地锚点）。
  if (cloned.type === "timeline") {
    // 没有 anchorMessageId 的 timeline 是纯展示块，不持有跨消息引用，无需重映射。
    if (cloned.anchorMessageId) {
      // 直接查表而不复用 mapMessage：这里要区分命中/未命中两种落法，
      // 而 mapMessage 的兜底会把父 id 原样写回，等于没有降级。
      const mapped = messageIdMap.get(cloned.anchorMessageId);
      if (mapped) {
        cloned.anchorMessageId = mapped;
      } else if (options.strictLocalReferences) {
        throw new Error(
          `Fork timeline anchorMessageId is outside child transcript: ${cloned.anchorMessageId}`,
        );
      } else {
        // 先备份再删除：originAnchorMessageId 保留溯源，而 anchorMessageId 必须彻底消失，
        // 只要它还在，UI 就会按父 id 去找滚动锚点（落空后跳到列表顶部）。
        cloned.originAnchorMessageId = cloned.anchorMessageId;
        delete cloned.anchorMessageId;
      }
    }
    if (cloned.anchorTurnId) {
      // 先 has 再 map：mapTurn 对"查不到"在严格模式会抛错，而这里的意图是
      // "整张映射表缺失"时走下面的降级分支，两种情况必须先用 has 区分开。
      if (options.turnIdMap?.has(String(cloned.anchorTurnId))) {
        cloned.anchorTurnId = mapTurn(cloned.anchorTurnId, "timeline anchorTurnId");
      } else if (options.strictLocalReferences) {
        throw new Error(
          `Fork timeline anchorTurnId has no child-local identity: ${cloned.anchorTurnId}`,
        );
      } else {
        // legacy workspace fork 没有完整 turn identity map，只能显式降级为 provenance。
        cloned.originAnchorTurnId = cloned.anchorTurnId;
        delete cloned.anchorTurnId;
      }
    }
    // 压缩时间线指向摘要消息，是 UI 可见引用：必须换成 child 的摘要，
    // 否则点击压缩卡片会跳到父会话消息（或查无此消息而显示空白）。
    if (cloned.timelineType === "context_compaction" && cloned.summaryMessageId) {
      cloned.summaryMessageId = mapMessage(
        cloned.summaryMessageId,
        "timeline summaryMessageId",
      );
    }
    // 验收卡片同时带 target 与 verification 两个身份：任一缺失都说明父侧实体没随 fork
    // 复制，严格模式必须整体失败——只修好一半会让卡片可点但重试落到父会话。
    if (cloned.timelineType === "goal_verification") {
      const targetId = options.targetIdMap?.get(cloned.targetId);
      const verificationId = options.verificationIdMap?.get(cloned.verificationId);
      if ((!targetId || !verificationId) && options.strictLocalReferences) {
        throw new Error("Fork goal verification timeline has no child-local identity");
      }
      // 非严格模式各自兜底父值：卡片仍可展示，但已失去点击/重试能力，
      // 调用方须按 provenance 处理，不能当作有效的 child 实体。
      cloned.targetId = targetId ?? cloned.targetId;
      cloned.verificationId = verificationId ?? cloned.verificationId;
    }
  }
  // compaction 内部引用是 provider-context 语义（非 UI 落位）：可 remap 则换，
  // 否则保留原值（保持既有语义，不引入破坏性变更）。
  if (cloned.type === "compaction") {
    // 逐字段判断而非整体重建：compaction 的字段随 provider 版本增量出现，
    // 统一构造会把"本版本还没有"的可选字段显式写成 undefined。
    if (cloned.summaryMessageId) {
      cloned.summaryMessageId = mapMessage(cloned.summaryMessageId, "compaction summaryMessageId");
    }
    // tail_start_id 是"保留未压缩尾部"的起点，映射错了模型会从父会话的中断处续读，
    // 表现为 fork 后首轮回答复述父分支的内容。
    if (cloned.tail_start_id) {
      cloned.tail_start_id = mapMessage(cloned.tail_start_id, "compaction tail_start_id");
    }
    if (cloned.compactBoundary) {
      // 取出父引用后整体重建：就地改 boundary 会污染父 part 共享的同一对象，
      // 父会话下一次压缩会读到被改写的 id。
      const boundary = cloned.compactBoundary;
      cloned.compactBoundary = {
        ...boundary,
        ...(boundary.lastSummarizedMessageId
          ? {
              lastSummarizedMessageId: mapMessage(
                boundary.lastSummarizedMessageId,
                "compact boundary lastSummarizedMessageId",
              ),
            }
          : {}),
        // 数组必须整表重映射：漏掉任一项都会让 child 的边界引用父消息，
        // 下次压缩按不存在的 id 计算保留段，可能整段上下文被丢弃。
        summaryMessageIds: boundary.summaryMessageIds.map((id) =>
          mapMessage(id, "compact boundary summaryMessageId"),
        ),
        // 附件与 hook 结果同样是消息级引用，在这里一并换 id；
        // 未随 fork 复制时严格模式会由 mapMessage 抛出，不会留下悬空引用。
        ...(boundary.attachmentMessageIds
          ? {
              attachmentMessageIds: boundary.attachmentMessageIds.map((id) =>
                mapMessage(id as MessageId, "compact boundary attachmentMessageId"),
              ),
            }
          : {}),
        ...(boundary.hookResultMessageIds
          ? {
              hookResultMessageIds: boundary.hookResultMessageIds.map((id) =>
                mapMessage(id as MessageId, "compact boundary hookResultMessageId"),
              ),
            }
          : {}),
        // preservedSegment 描述"压缩后仍要展示的原始片段"，head/anchor/tail 三个端点
        // 必须同时换成 child 消息，否则区间跨界，渲染出重复或缺失的消息。
        ...(boundary.preservedSegment
          ? {
              preservedSegment: {
                headMessageId: mapMessage(
                  boundary.preservedSegment.headMessageId,
                  "compact preserved headMessageId",
                ),
                anchorMessageId: mapMessage(
                  boundary.preservedSegment.anchorMessageId,
                  "compact preserved anchorMessageId",
                ),
                tailMessageId: mapMessage(
                  boundary.preservedSegment.tailMessageId,
                  "compact preserved tailMessageId",
                ),
              },
            }
          : {}),
        // 边界所属回合也要换成 child-local turn：它决定这条压缩卡片显示在哪个回合分隔符下。
        ...(boundary.turnId
          ? { turnId: mapTurn(boundary.turnId, "compact boundary turnId") }
          : {}),
      };
    }
  }
  if (cloned.type === "tool") {
    // callID 是"调用—结果"的配对键：必须与 child 里重新登记的工具调用一致，
    // 不一致时结果找不到调用，UI 会把该步骤显示为执行中且永不结束。
    const callID = options.toolCallIdMap?.get(cloned.callID);
    if (!callID && options.strictLocalReferences) {
      throw new Error(`Fork tool call has no child-local identity: ${cloned.callID}`);
    }
    cloned.callID = callID ?? cloned.callID;
    // 只有 completed 才可能带 attachments：这是 state 联合类型收窄的前提，
    // 也避免把进行中调用的半成品附件复制到 child。
    if (cloned.state.status === "completed" && cloned.state.attachments) {
      // 整体替换 state 而不是改字段：state 在父消息里被共享，就地追加会让父分支也长出新附件。
      cloned.state = {
        ...cloned.state,
        attachments: cloned.state.attachments.map((attachment) => {
          // 附件自身也是 part，必须换新 part id 与新的 message 归属：
          // 沿用父 id 会让 child 与父会话在存储层指向同一行，后续编辑互相覆盖。
          const nextPartId = options.partIdMap?.get(attachment.id);
          if (!nextPartId && options.strictLocalReferences) {
            throw new Error(
              `Fork tool attachment has no child-local part identity: ${attachment.id}`,
            );
          }
          // 无现成映射时新建 part id：附件按值复制，调用方需把它登记进 partIdMap
          // 供后续引用解析，否则同一附件在 child 内会有两个身份。
          return {
            ...attachment,
            id: nextPartId ?? createPartId(),
            sessionID: options.forkedSessionId,
            messageID: options.nextMessageId,
          };
        }),
      };
    }
  }
  // 只返回值副本，不写任何存储：落库与排序由 caller 负责，
  // 重复调用会生成不同的 part id，调用方需保证一对一使用。
  return cloned;
}
