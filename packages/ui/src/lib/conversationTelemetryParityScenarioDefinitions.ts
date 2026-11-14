// ══════════════════════════════════════════════════════════════════════════
// 文件头：本文件维持 / 依赖的不变量
//
// 本文件是一张「数据表」而不是普通逻辑：每个 case 是一组受控输入的时间线，
// 由新旧两套驱动分别回放，再比对 report / arms 两份清单。断言值本身也在表里，
// 所以任何一条 input 的改动都会同时改变「被测输入」和「期望输出」——这使得
// 单看代码无法发现自洽的错误。下面列出的前提就是防止这种自洽错误的护栏。
// 阅读顺序：INV-1..4（标识唯一性）→ INV-5..9（时序与幂等）→
// INV-10..12（断言口径）→ INV-13..27（逐 case 的互斥 / 依赖约束）。
//
// INV-1: caseId 必须与 SCENARIOS 的 key 一一对应且唯一 —— 破坏后果：Map 构造时后到者静默覆盖，getScenario 返回的用例与预期不符。
// INV-2: 同一 case 内 operation.now 必须单调不递减 —— 破坏后果：TTFT 出现负数被实现 clamp 成 0，真实回归被掩盖。
// INV-3: 同一 session 内 commandId 只能属于一个 turn —— 破坏后果：promotion 去重把两轮输入当成同一轮，少记一次 plan_request。
// INV-4: 同一 session 内 turnId 与 eventId 各自唯一（duplicate 标记的场景除外） —— 破坏后果：幂等去重误判，本该两次的事件被合并成一次。
// INV-5: duplicate:true 只允许出现在「此前已有同 eventId」的场景 —— 破坏后果：真正的重复检测路径被跳过，测试变成空转。
// INV-6: 每个 session 的 foreground.attach 必须早于该 session 的 seed / turn.started —— 破坏后果：前台归属缺失，全部 arms 落到 background 分支计数为 0。
// INV-7: foreground.detach 的 owner 必须与该 session 最近一次 attach 的 owner 相同 —— 破坏后果：detach 变成 no-op，TDP09 退化成普通成功轮。
// INV-8: includeNetwork:false 的 case 不得再断言 plan_request / plan_ttft —— 破坏后果：期望值恒不成立，用例永久红。
// INV-9: minimumReportInventory 与 minimumArmsInventory 是「下限」而不是精确值 —— 破坏后果：新增埋点后被误判为回归，团队倾向于删断言而不是查问题。
// INV-10: 断言不得由输入字段派生（例如用 operations 长度算 send_btn） —— 破坏后果：实现与断言同时写错时互相印证，双写失去意义。
// INV-11: proof 里的字符串是 spec 章节的可读锚点，重命名等于删除覆盖说明 —— 破坏后果：失败时无法定位到对应的产品要求。
// INV-12: buildScenarios 必须是纯函数、不读运行时状态 —— 破坏后果：同一 module 在不同进程构造出不同表，快照对比不稳定。
// INV-13: TDP02A/TDP02B 必须共享 sessionId，且第二轮 sendAt 晚于第一轮 terminal —— 破坏后果：测不到 message-scope reset，作用域泄漏可以蒙混过关。
// INV-14: TDP03 的第二条 seed 必须插在第一轮 terminal 之前，且带 duplicate:true —— 破坏后果：promotion 去重分支不被执行，TDP03 与 TDP02 等价。
// INV-15: TDP05 的两个变体除 withUsage 外必须完全一致 —— 破坏后果：无法二分定位「失败轮有/无 usage」哪条分支算错。
// INV-16: TDP06 的第二个 session 必须没有 terminal —— 破坏后果：stop-without-terminal-zero-completion 断言失去被测对象。
// INV-17: TDP07 的 thought chunk 必须插在 text chunk 之前且 firstChunk:true —— 破坏后果：thought-before-text 与 tail-finalize 两个断言都退化成普通文本轮。
// INV-18: TDP08 的 parented 变体不得再附加 tool 事件 —— 破坏后果：parentToolCallId 分支被工具事件路径掩盖，父子归属错误测不出来。
// INV-19: TDP10 的 negative 变体必须 chunkAt < sendAt；gap-3000 与 gap-3001 必须恰好在 3000ms 边界两侧 —— 破坏后果：stall 阈值边界失效，off-by-one 回归无法被发现。
// INV-20: TDP12 必须是 5 种 model.status × 2 种可见性 = 10 条 —— 破坏后果：plan_request=10 不成立，且某一种状态可能完全没被覆盖。
// INV-21: TDP13 的 provider 为空串表示「缺失」，不能写成未知 provider 名 —— 破坏后果：接上 safe fallback 而不是 skip 分支，negative/missing 两条断言互换。
// INV-22: TDP14 的 suppressed 事件不得计入 chat_error_banner —— 破坏后果：same-key-once 的计数被稀释，重复抑制失效也看不出来。
// INV-23: TDP17 的 verification.assert 必须排在 visible.error 之前 —— 破坏后果：one-shot header 语义测不到，重复求值不会被发现。
// INV-24: TDP18 追加的第一条重复 chunk 必须不带 duplicate 标记（靠 eventId 相同模拟网络重发） —— 破坏后果：测到的是「显式声明重复」而不是「驱动自身去重」。
// INV-25: scope.dispose 必须在该 scope 的期望事件之后 —— 破坏后果：后续事件落到新 generation，dispose 语义变成空断言。
// INV-26: 新增 case 必须同步三个消费方（驱动注册表、report 断言、e2e fixture），缺一即半覆盖 —— 破坏后果：表里有用例但没有任何驱动执行它，覆盖率虚高。
// INV-27: 不得把某个 case 的 sessionId 复用到另一个 case —— 破坏后果：跨 case 的前台归属与去重状态互相污染，失败无法归因。
// ══════════════════════════════════════════════════════════════════════════
import { requestSecurityMessagesEnUS } from "@/request-security-edition/messages.js";
/* eslint-disable max-lines -- 19 个差分 case 的受控输入必须集中保存，避免新旧驱动各自复制后悄悄漂移。 */

// 五个网络状态是 model.status 的合法取值，顺序与 TDP12 的遍历顺序一致。
// 之所以不合并成 "model_request_*" 前缀 + 后缀，是因为两套驱动对每一种状态
// 的 report 归类不同（completed 与 started 计 plan_request，stalled 不计），
// 类型层面拆分可以让新增状态时漏掉某个 case 变成编译期错误而不是静默 0。
export type ParityModelStatus =
  | "model_request_started"
  | "model_request_completed"
  | "model_request_failed"
  | "model_retry_scheduled"
  | "model_stream_stalled";

// seed 模拟「用户按下发送」这一刻的上下文快照，不是事件本身。
// sessionId/commandId/now 必填：三者共同决定这条输入落到哪个会话、哪次命令、
// 以及后续事件的时间基准；缺 any 一个，驱动只能猜，猜错就变成另一个 case 的断言。
export interface ParitySeed {
  sessionId: string;
  commandId: string;
  now: number;
  // scope 是「同一 case 内多套 UI 实例」的隔离键（TDP19），不是会话维度。
  scope?: string;
  // askMode / modelName / modelProvider / providerHostname 都来自发送时刻的
  // 运行环境；留空表示「用驱动默认」，显式写值才能断言 report 里的模型字段。
  askMode?: string;
  modelName?: string;
  modelProvider?: string;
  providerHostname?: string;
}

export type ConversationTelemetryParityOperation =
  // focus / text 是「界面动作」而非遥测事件：它们只驱动 UI 侧的输入态，
  // 用来验证 report 不会把一次聚焦或一次按键误计成发送。缺了这两类，
  // TDP01 的 send_btn=1 就无法证明「只有 seed 才计数」。
  | { kind: "focus"; now: number; scope?: string }
  | { kind: "text"; now: number; value: string; scope?: string }
  // seed 是唯一会「创建一轮输入」的操作；duplicate 表示同 commandId 的第二次
  // 送达（网络重发 / 双端提交），用于验证驱动自身的幂等，而不是显式去重。
  | ({ kind: "seed"; duplicate?: boolean } & ParitySeed)
  // attach / detach 维护「哪个 UI 实例正在看这个 session」。owner 是显式的，
  // 不能从 sessionId 派生：同一 session 可能被多个 pane 同时观察（TDP10 split）。
  | {
      kind: "foreground.attach";
      sessionId: string;
      owner: string;
      scope?: string;
    }
  | { kind: "foreground.detach"; owner: string; scope?: string }
  // turn.started 与 seed 分离：seed 只表达「输入被接纳」，turn.started 才是
  // 「开始执行」。中间可能插入 queue / promotion，二者合并就测不到排队路径。
  | {
      kind: "turn.started";
      now: number;
      eventId: string;
      sessionId: string;
      commandId: string;
      turnId: string;
      scope?: string;
    }
  // model.status 覆盖网络层的全部生命周期。commandId / turnId 可选，是因为
  // TDP12 只关心网络状态与可见性（前台/后台），不需要绑定到某一轮输入。
  // 各状态专用字段（durationMs / delayMs / idleMs / timeoutMs）只在对应状态下
  // 有意义，混填会让断言在错误的分支上通过。
  | {
      kind: "model.status";
      now: number;
      eventId: string;
      sessionId: string;
      commandId?: string;
      turnId?: string;
      requestId: string;
      status: ParityModelStatus;
      providerId: string;
      modelId: string;
      providerHostname?: string;
      durationMs?: number;
      reason?: string;
      retryable?: boolean;
      statusCode?: number;
      delayMs?: number;
      nextAttempt?: number;
      idleMs?: number;
      timeoutMs?: number;
      scope?: string;
    }
  // chunk 的 firstChunk 是 TTFT 的唯一触发器：false 的 chunk 只会延长流，
  // 不能重算首字时间。parentToolCallId 存在表示这是子代理的输出，
  // 必须与主线程文本分开统计（TDP08 parented 变体专门验证这一点）。
  | {
      kind: "chunk";
      now: number;
      eventId: string;
      sessionId: string;
      commandId: string;
      turnId: string;
      channel: "thought" | "text";
      firstChunk: boolean;
      parentToolCallId?: string;
      scope?: string;
    }
  // permission 的 requested / resolved / denied 是三个不同阶段，
  // 用同一个 requestId 串联。decision 只在 resolved/denied 出现；
  // 在 requested 上填 decision 会让工具等待时长提前结算。
  | {
      kind: "permission";
      now: number;
      eventId: string;
      sessionId: string;
      commandId: string;
      turnId: string;
      phase: "requested" | "resolved" | "denied";
      requestId: string;
      toolCallId: string;
      decision?: "allow" | "deny" | "escalate" | "modify";
      scope?: string;
    }
  // tool 的 phase 与 toolCallId 共同构成状态机；completed/failed 必须与
  // 同一 toolCallId 的 started 配对，否则 report 里会多出一条永不终结的调用。
  // performance 是可选的明细块，缺省表示「不采集」，不是「全为 0」。
  | {
      kind: "tool";
      now: number;
      eventId: string;
      sessionId: string;
      commandId: string;
      turnId: string;
      phase: "scheduled" | "started" | "progress" | "completed" | "failed";
      toolCallId: string;
      toolName: string;
      errorCode?: string;
      errorMessage?: string;
      parentToolCallId?: string;
      performance?: {
        totalMs?: number;
        permissionWaitMs?: number;
        commandRunMs?: number;
        exitCode?: number;
        timedOut?: boolean;
        outputBytes?: number;
        commandCategory?: string;
        commandName?: string;
        commandCount?: number;
        commandStatus?:
          | "completed"
          | "failed"
          | "timed_out"
          | "cancelled"
          | "spawn_error"
          | "backgrounded";
        commandHash?: string;
        workspaceKind?: "local" | "remote" | "unknown";
      };
      scope?: string;
    }
  // usage 是 token 账本，独立于 terminal：失败轮也可能有部分用量（TDP05），
  // 因此它不能由 terminal.status 推导，必须显式给一条事件。
  | {
      kind: "usage";
      now: number;
      eventId: string;
      sessionId: string;
      commandId: string;
      turnId: string;
      inputTokens: number;
      outputTokens: number;
      reasoningTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      scope?: string;
    }
  // terminal 是「这一轮结束」的唯一信号；没有它，驱动会认为轮次仍在进行，
  // message_completion 计数保持 0（TDP06 的第二个 session 就是这种负例）。
  // duplicate 用于验证重复终态不会二次结算用量。
  | {
      kind: "terminal";
      now: number;
      eventId: string;
      sessionId: string;
      commandId: string;
      turnId: string;
      status: "success" | "failed" | "interrupted";
      errorCode?: string;
      errorMessage?: string;
      duplicate?: boolean;
      scope?: string;
    }
  // compaction 不挂在 turn 上（用 operationId），因为它可以发生在两轮之间、
  // 也可以由后台触发。trigger 决定它是否计入 report：partial / reactive
  // 属于被动压缩，与用户手动 /compact 的计数口径不同。
  | {
      kind: "compaction";
      now: number;
      eventId: string;
      sessionId: string;
      operationId: string;
      status: "completed" | "failed" | "interrupted";
      trigger: "manual" | "auto" | "partial" | "reactive" | "session_memory";
      summaryMessageId?: string;
      reason?: string;
      compactReason?: string;
      modelName?: string;
      modelProvider?: string;
      startedAt?: number;
      endedAt?: number;
      preCompactTokenCount?: number;
      postCompactTokenCount?: number;
      truePostCompactTokenCount?: number;
      duplicate?: boolean;
      scope?: string;
    }
  // visible.error 的 errorKey 是去重键：同 key 的重复上报只显示一次；
  // suppressed 表示这条错误被本地策略吞掉，绝不能计入 banner 数。
  | {
      kind: "visible.error";
      errorKey: string;
      displayMessage: string;
      code: string;
      traceId: string;
      sessionId: string;
      detail?: string;
      duplicate?: boolean;
      suppressed?: boolean;
      scope?: string;
    }
  // feedback 是消息级操作（不是 turn 级）：同一 messageId 的多次点击会互相覆盖，
  // 因此 TDP15 用一个 turn 内的 like → dislike → none 验证覆盖而不是累加。
  | {
      kind: "feedback";
      sessionId: string;
      messageId: string;
      reaction: "like" | "dislike" | "none";
      scope?: string;
    }
  // 三个 assert 型操作不产生遥测，只用来标记「这里应当出现某个横幅 / 校验」，
  // 让 case 在缺少对应驱动能力时明确失败，而不是安静通过。
  | { kind: "quota.assert" }
  | { kind: "verification.assert" }
  // scope.dispose 销毁一个 UI 实例代际；之后的事件必须落到新代际，
  // 所以它只能排在期望事件之后（INV-25）。
  | { kind: "scope.dispose"; scope?: string }
  // web.noop 把一组操作标记为「Web 端不产生任何 arms」。它不是容器而是断言：
  // 内部操作被回放但期望计数为 0，用来证明平台分支没有偷偷复用桌面计数路径。
  | { kind: "web.noop"; operations: ConversationTelemetryParityOperation[] };

// 场景结构刻意保持「四个平行字段」而不是嵌套对象：两套驱动各自按 case 读表，
// 任何一层嵌套都会让它们对「此 case 是否有 arms 期望」的理解不一致。
export interface ConversationTelemetryParityScenario {
  // caseId 同时是 Map key 与快照文件名，改名等于换一个用例（INV-1）。
  caseId: string;
  // operations 是有序时间线，顺序即语义，不允许排序或去重后再回放。
  operations: ConversationTelemetryParityOperation[];
  // 两份 inventory 分开命名而不是一个 map 加前缀：report 与 arms 的采集端不同，
  // 合并会让「漏采集」和「多采集」在同一个数字里互相抵消。
  minimumReportInventory: Record<string, number>;
  minimumArmsInventory: Record<string, number>;
  // proof 是给人看的：失败时用它反查 spec 段落，不参与任何运行时计算。
  proof: string[];
}

// seedDetail 是「同一台测试机」的环境常量。抽出来是为了让 TDP05/TDP06 这类
// 需要多个 session 的 case 不会各自抄一份不同的 provider，否则失败时无法判断
// 是逻辑分支不同还是环境不同。
const seedDetail = {
  askMode: "build",
  modelName: "glm-model",
  modelProvider: "glm",
  providerHostname: "api.example.com",
} as const;

// id() 统一把 caseId 转小写再加后缀：两套驱动用同一规则生成 eventId，
// 才能在比对时按字符串直接对齐。若某处手写大写 id，重复检测会认为它们不同。
function id(caseId: string, suffix: string): string {
  return `${caseId.toLowerCase()}-${suffix}`;
}

// 「一次成功文本轮」的最小事件序列。绝大多数 case 都是它的变体，因此这里的时间
// 常量同时充当全局基线：sendAt=100 / chunkAt=200 / terminalAt=300 让 TTFT=100、
// 总时长=200 可以直接心算，任何 case 若改了这三个值就不再可比。
// [权衡] 允许 case 覆盖 sessionId 而不是让调用方自己拼数组：覆盖能保证「除了
// 标识之外的事件序列完全相同」，手拼则很容易漏一条 usage 导致断言漂移。
function successfulTextTurn(input: {
  caseId: string;
  sessionId?: string;
  commandId?: string;
  scope?: string;
  sendAt?: number;
  chunkAt?: number;
  terminalAt?: number;
  includeNetwork?: boolean;
}): ConversationTelemetryParityOperation[] {
  const sessionId = input.sessionId ?? id(input.caseId, "session");
  const commandId = input.commandId ?? id(input.caseId, "command");
  const turnId = id(input.caseId, "turn");
  const sendAt = input.sendAt ?? 100;
  const chunkAt = input.chunkAt ?? 200;
  const terminalAt = input.terminalAt ?? 300;
  const scope = input.scope;
  return [
    // attach 必须排在第一位：驱动在收到 seed 之前要先知道「这个 session 正被前台
    // 哪个 owner 看着」，否则首轮 arms 会被归到 background（INV-6）。
    {
      kind: "foreground.attach",
      sessionId,
      owner: id(input.caseId, "owner"),
      scope,
    },
    // focus 与 text 卡在 seed 之前 20/10ms：它们模拟用户真正敲键盘的过程，
    // 用来证明 report 的 send_btn 只由 seed 触发，而不是任意 UI 交互。
    { kind: "focus", now: sendAt - 20, scope },
    { kind: "text", now: sendAt - 10, value: "x", scope },
    { kind: "seed", sessionId, commandId, now: sendAt, ...seedDetail, scope },
    // turn.started 比 seed 晚 5ms：真实链路里 seed 先被接纳、再由调度器启动执行。
    // 两者同 now 会让「接纳即执行」与「排队后执行」在时间轴上无法区分。
    {
      kind: "turn.started",
      now: sendAt + 5,
      eventId: id(input.caseId, "started"),
      sessionId,
      commandId,
      turnId,
      scope,
    },
    // includeNetwork:false 时整段消失，而不是把 status 改成某个「无网络」值：
    // TDP06/TDP07 要验证的是「没有网络事件时仍能结算」，多一条假事件就测不到。
    ...(input.includeNetwork === false
      ? []
      : ([
          {
            kind: "model.status",
            now: sendAt + 10,
            eventId: id(input.caseId, "request-started"),
            sessionId,
            commandId,
            turnId,
            requestId: id(input.caseId, "request"),
            status: "model_request_started",
            providerId: "glm",
            modelId: "glm-model",
            providerHostname: "api.example.com",
            scope,
          },
        ] satisfies ConversationTelemetryParityOperation[])),
    // 只有一条 firstChunk:true 的 chunk：这是 TTFT 的唯一来源。多加一条 false 的
    // chunk 不会改变期望值，但会让 TDP18 的「重复 chunk 只算一次」变得含混。
    {
      kind: "chunk",
      now: chunkAt,
      eventId: id(input.caseId, "chunk"),
      sessionId,
      commandId,
      turnId,
      channel: "text",
      firstChunk: true,
      scope,
    },
    // usage 必须在 terminal 之前：驱动以 terminal 为结算点，之后到达的 usage
    // 会被视为下一轮或直接丢弃（TDP18 的 initial-hydration 断言即依赖此顺序）。
    {
      kind: "usage",
      now: terminalAt - 10,
      eventId: id(input.caseId, "usage"),
      sessionId,
      commandId,
      turnId,
      inputTokens: 10,
      outputTokens: 5,
      scope,
    },
    // 完成事件与 request-started 共用 requestId，靠 status 区分首尾：
    // 复用 id 是刻意的，用来验证驱动按 requestId 关联而不是按事件序号配对。
    ...(input.includeNetwork === false
      ? []
      : ([
          {
            kind: "model.status",
            now: terminalAt - 5,
            eventId: id(input.caseId, "request-completed"),
            sessionId,
            commandId,
            turnId,
            requestId: id(input.caseId, "request"),
            status: "model_request_completed",
            providerId: "glm",
            modelId: "glm-model",
            providerHostname: "api.example.com",
            durationMs: terminalAt - sendAt - 15,
            scope,
          },
        ] satisfies ConversationTelemetryParityOperation[])),
    // terminal 放最后：它是「本轮结束」的唯一信号，也是 message_completion 的
    // 计数点。放在中间会让后面的 usage 变成 orphan 事件，覆盖不到结算顺序。
    {
      kind: "terminal",
      now: terminalAt,
      eventId: id(input.caseId, "terminal"),
      sessionId,
      commandId,
      turnId,
      status: "success",
      scope,
    },
  ];
}

// scenario() 只是把位置参数改名成具名字段，不做校验也不补默认值。
// [权衡] 故意不在这里校验 operations 的 now 单调性：校验要写一条与生产实现等价的
// 排序逻辑，一旦实现改动，校验就成了第二份真相；顺序错误交给快照 diff 暴露更可靠。
function scenario(
  caseId: string,
  operations: ConversationTelemetryParityOperation[],
  report: Record<string, number>,
  arms: Record<string, number>,
  proof: string[],
): ConversationTelemetryParityScenario {
  return {
    caseId,
    operations,
    minimumReportInventory: report,
    minimumArmsInventory: arms,
    proof,
  };
}

// 所有 case 在这里集中构造。写成一个大函数而不是 19 个导出常量，
// 是因为两套驱动都按数组顺序回放；拆分导出会让「执行顺序」依赖 import 顺序，
// 而 ES module 的求值顺序在循环依赖下并不稳定（INV-12）。
function buildScenarios(): ConversationTelemetryParityScenario[] {
  // TDP01 是基线：一条最朴素的成功轮，只断言最少量的计数。
  // 它存在的意义不是覆盖功能，而是给其它 case 提供「基线数值」参照，
  // 所以这里刻意不附加任何额外事件（多一条都会让基线随实现漂移）。
  const tdp01 = successfulTextTurn({ caseId: "TDP01" });
  // TDP02 用一个 session 连跑两轮，第二轮时间整体后移 300ms（100/200/300 → 400/500/600）。
  // [并发] 共享 sessionId 是刻意的：message 级作用域必须在第二轮 terminal 后重置，
  // 若两轮用不同 session，作用域泄漏会被「新会话天然干净」掩盖（INV-13）。
  const tdp02 = [
    ...successfulTextTurn({ caseId: "TDP02A", sessionId: "tdp02-session" }),
    ...successfulTextTurn({
      caseId: "TDP02B",
      sessionId: "tdp02-session",
      sendAt: 400,
      chunkAt: 500,
      terminalAt: 600,
    }),
  ];

  // TDP03 验证「排队中重复送达同一 commandId」。
  // [事务] 两轮命令 id 必须不同（command-1 / command-2）：相同的话去重会把整轮吞掉，
  // 测到的就不是「promotion 去重」而是「seed 幂等」。
  const tdp03First = successfulTextTurn({
    caseId: "TDP03A",
    sessionId: "tdp03-session",
    commandId: "tdp03-command-1",
    terminalAt: 500,
  });
  const tdp03Second = successfulTextTurn({
    caseId: "TDP03B",
    sessionId: "tdp03-session",
    commandId: "tdp03-command-2",
    sendAt: 150,
    chunkAt: 600,
    terminalAt: 700,
  });
  // 第二轮 seed 在第一轮 terminal 前接纳；promotion 时重复 seed 必须被去重。
  // [时序] slice(0,7) / slice(0,4) 的下标是「契约的一部分」：7 恰好切到第一轮
  // turn.started 之后（attach/focus/text/seed/started/request-started/chunk 之外的
  // 位置固定），4 恰好切到第二轮 turn.started 之后。若有人往 successfulTextTurn
  // 里插事件而不改这里，插入的重复 seed 会落到错误位置——但不会报错，只会让断言数值
  // 悄悄改变。改 successfulTextTurn 结构时必须同步复核这段。
  const tdp03 = [
    ...tdp03First.slice(0, 7),
    ...tdp03Second.slice(0, 4),
    ...tdp03First.slice(7),
    // now=550 落在第一轮 terminal(500) 之后、第二轮 chunk(600) 之前，
    // 这正是 promotion 发生的时间窗；提前或推后都会让「重复被丢弃」的分支不执行。
    {
      kind: "seed",
      sessionId: "tdp03-session",
      commandId: "tdp03-command-2",
      now: 550,
      duplicate: true,
      ...seedDetail,
    } satisfies ConversationTelemetryParityOperation,
    ...tdp03Second.slice(4),
  ];

  // TDP05 用同一个循环体跑两次，唯一变量是 withUsage。
  // [权衡] 两个变体共用循环而不是各写一遍：这保证除 usage 之外的事件逐字段相同，
  // 失败时可以二分定位「失败轮有没有 usage」各自算错，而不是先怀疑两份输入不同。
  const tdp05: ConversationTelemetryParityOperation[] = [];
  for (const [index, withUsage] of [true, false].entries()) {
    // index 同时驱动 suffix 与 400ms 的时间偏移：两个 session 在时间轴上不重叠，
    // 否则前台的 attach/detach 会互相干扰，arms 归属混在一起。
    const suffix = String(index + 1);
    const sessionId = `tdp05-session-${suffix}`;
    const commandId = `tdp05-command-${suffix}`;
    const turnId = `tdp05-turn-${suffix}`;
    tdp05.push(
      // 每个 session 单独 attach：复用同一个 owner 会让第二个 session 的前台归属
      // 继承第一个的状态，测不到「失败轮也有独立前台」。
      { kind: "foreground.attach", sessionId, owner: `tdp05-owner-${suffix}` },
      // 时间基准统一 100 + index*400，三处偏移（+10/+20/+50）分别对应
      // 启动、请求、首字，与 successfulTextTurn 的节奏保持一致，便于横向比较。
      {
        kind: "seed",
        sessionId,
        commandId,
        now: 100 + index * 400,
        ...seedDetail,
      },
      {
        kind: "turn.started",
        now: 110 + index * 400,
        eventId: `tdp05-start-${suffix}`,
        sessionId,
        commandId,
        turnId,
      },
      {
        kind: "model.status",
        now: 120 + index * 400,
        eventId: `tdp05-request-start-${suffix}`,
        sessionId,
        commandId,
        turnId,
        requestId: `tdp05-request-${suffix}`,
        status: "model_request_started",
        providerId: "glm",
        modelId: "glm-model",
      },
      {
        kind: "chunk",
        now: 150 + index * 400,
        eventId: `tdp05-chunk-${suffix}`,
        sessionId,
        commandId,
        turnId,
        channel: "text",
        firstChunk: true,
      },
      // withUsage=false 的变体不是「漏了一条事件」，而是「协议允许缺失」。
      // 若把它改成 usage 全 0，就测不出「缺失」与「读到 0」在报表上的区别。
      ...(withUsage
        ? ([
            {
              kind: "usage",
              now: 170,
              eventId: "tdp05-usage-1",
              sessionId,
              commandId,
              turnId,
              inputTokens: 9,
              outputTokens: 3,
            },
          ] satisfies ConversationTelemetryParityOperation[])
        : []),
      // [失败路径] 两个变体的失败原因刻意不同：index 0 带 reason 与 errorCode，
      // index 1 两者都缺。这样能同时覆盖「有原因」与「协议省略原因」两条分支；
      // 若两个都填，缺省路径就永远没被走到（报错归因与 0 值归因是两回事）。
      {
        kind: "model.status",
        now: 180 + index * 400,
        eventId: `tdp05-request-fail-${suffix}`,
        sessionId,
        commandId,
        turnId,
        requestId: `tdp05-request-${suffix}`,
        status: "model_request_failed",
        providerId: "glm",
        modelId: "glm-model",
        reason: index === 0 ? "provider failed" : "",
        statusCode: 500,
      },
      {
        kind: "terminal",
        now: 200 + index * 400,
        eventId: `tdp05-terminal-${suffix}`,
        sessionId,
        commandId,
        turnId,
        status: "failed",
        errorCode: index === 0 ? "PROVIDER_ERROR" : undefined,
        errorMessage: index === 0 ? "provider failed" : undefined,
      },
    );
  }

  // TDP06 是「中断 / 无终态」两个负例的合集。
  // includeNetwork:false 让成功轮退化成纯中断：若保留 request-started/completed，
  // 中断轮会被网络事件误判为正常结束，USER_INTERRUPT 就测不到。
  const tdp06 = [
    ...successfulTextTurn({ caseId: "TDP06A", includeNetwork: false }).map((operation) =>
      operation.kind === "terminal"
        ? {
            ...operation,
            status: "interrupted" as const,
            errorCode: "USER_INTERRUPT",
          }
        : operation,
    ),
    // 第二个 session 只到 turn.started 为止：它的存在就是为了验证「没有 terminal
    // 时 completion 必须为 0」。补上 chunk / usage 会让断言变成「部分完成」而不是
    // 「完全没有完成」，测不到最极端的漏终态场景（INV-16）。
    {
      kind: "foreground.attach",
      sessionId: "tdp06-no-terminal",
      owner: "tdp06-owner-2",
    },
    {
      kind: "seed",
      sessionId: "tdp06-no-terminal",
      commandId: "tdp06-no-terminal-command",
      now: 500,
      ...seedDetail,
    },
    {
      kind: "turn.started",
      now: 510,
      eventId: "tdp06-no-terminal-start",
      sessionId: "tdp06-no-terminal",
      commandId: "tdp06-no-terminal-command",
      turnId: "tdp06-no-terminal-turn",
    },
  ] satisfies ConversationTelemetryParityOperation[];

  // TDP07 在成功轮的首个 text chunk 之前插入一条 thought chunk。
  // [时序] 用 splice 而不是重排数组：splice 保证「除了多出的 thought，其余事件与
  // TDP01 逐项相同」，才能证明 thought 不改变 TTFT 之外的任何计数。
  const tdp07 = successfulTextTurn({ caseId: "TDP07", includeNetwork: false });
  const tdp07ChunkIndex = tdp07.findIndex((operation) => operation.kind === "chunk");
  // now=150 早于 text chunk 的 200，firstChunk:true 又让驱动把 TTFT 记在这一条上。
  // 两者必须同时成立：只改时间而把 firstChunk 留成 false，驱动就不会把它当首字，
  // thought-before-text 的断言会静默变成普通文本轮（INV-17）。
  tdp07.splice(tdp07ChunkIndex, 0, {
    kind: "chunk",
    now: 150,
    eventId: "tdp07-thought",
    sessionId: "tdp07-session",
    commandId: "tdp07-command",
    turnId: "tdp07-turn",
    channel: "thought",
    firstChunk: true,
  });

  // TDP08 用四个变体覆盖工具调用的四条路径。base 每次 +500ms 是为了让四个
  // session 在时间轴上完全不重叠（否则前台归属会互相覆盖，arms 全部算到最后一个）。
  const tdp08: ConversationTelemetryParityOperation[] = [];
  const toolVariants = ["success", "failed", "permission", "parented"] as const;
  toolVariants.forEach((variant, index) => {
    // 每个变体独立 session / command / turn：复用标识会让四个变体在后处理阶段
    // 被当成同一轮的四次重试，工具调用数被去重成 1。
    const sessionId = `tdp08-${variant}-session`;
    const commandId = `tdp08-${variant}-command`;
    const turnId = `tdp08-${variant}-turn`;
    const base = 100 + index * 500;
    tdp08.push(
      { kind: "foreground.attach", sessionId, owner: `tdp08-${variant}-owner` },
      { kind: "seed", sessionId, commandId, now: base, ...seedDetail },
      {
        kind: "turn.started",
        now: base + 10,
        eventId: `tdp08-${variant}-start`,
        sessionId,
        commandId,
        turnId,
      },
    );
    if (variant === "parented") {
      // parented 分支刻意不产生任何 tool 事件（INV-18）：如果带上 tool started，
      // 驱动会优先走工具归并路径，parentToolCallId 的文本归属分支就永远不执行。
      // 两条 chunk 的 firstChunk 分别 true/false，用来验证「子代理首字」不会
      // 抢走主线程 TTFT。
      tdp08.push(
        {
          kind: "chunk",
          now: base + 30,
          eventId: "tdp08-parented-thought",
          sessionId,
          commandId,
          turnId,
          channel: "thought",
          firstChunk: true,
          parentToolCallId: "parent-agent",
        },
        {
          kind: "chunk",
          now: base + 40,
          eventId: "tdp08-parented-text",
          sessionId,
          commandId,
          turnId,
          channel: "text",
          firstChunk: false,
          parentToolCallId: "parent-agent",
        },
        {
          kind: "chunk",
          now: base + 60,
          eventId: "tdp08-main-text",
          sessionId,
          commandId,
          turnId,
          channel: "text",
          firstChunk: false,
        },
      );
    } else {
      if (variant === "permission") {
        // requested 单独先发、且不带 decision：工具等待时长从这里开始计。
        // 若把 decision 一起塞进来，等待区间会被算成 0，permission_wait 永远测不到。
        tdp08.push({
          kind: "permission",
          now: base + 20,
          eventId: "tdp08-permission-request",
          sessionId,
          commandId,
          turnId,
          phase: "requested",
          requestId: "tdp08-permission",
          toolCallId: "tdp08-permission-tool",
        });
      }
      // toolName 在 failed 变体用 Bash：Bash 才有 exitCode/错误码语义，
      // 用 Read 会走到「工具不支持命令执行」的降级分支，测不到真正的失败归因。
      tdp08.push(
        {
          kind: "tool",
          now: base + 30,
          eventId: `tdp08-${variant}-tool-start`,
          sessionId,
          commandId,
          turnId,
          phase: "started",
          toolCallId: `tdp08-${variant}-tool`,
          toolName: variant === "failed" ? "Bash" : "Read",
        },
        // resolved 必须与 requested 共用 requestId 与 toolCallId：任一不匹配，
        // 驱动会认为这是一次新的权限请求，工具等待时长被重置而非结算（INV-4 同类约束）。
        ...(variant === "permission"
          ? ([
              {
                kind: "permission",
                now: base + 80,
                eventId: "tdp08-permission-resolved",
                sessionId,
                commandId,
                turnId,
                phase: "resolved",
                requestId: "tdp08-permission",
                toolCallId: "tdp08-permission-tool",
                decision: "allow",
              },
            ] satisfies ConversationTelemetryParityOperation[])
          : []),
        {
          kind: "tool",
          now: base + 120,
          eventId: `tdp08-${variant}-tool-terminal`,
          sessionId,
          commandId,
          turnId,
          phase: variant === "failed" ? "failed" : "completed",
          toolCallId: `tdp08-${variant}-tool`,
          toolName: variant === "failed" ? "Bash" : "Read",
          errorCode: variant === "failed" ? "TOOL_EXEC_ERROR" : undefined,
          errorMessage: variant === "failed" ? "exit 2" : undefined,
          // performance 块里的每个字段都只在特定工具下有意义：Read 没有退出码，
          // 所以 exitCode=0 表达「不适用」而不是「成功退出」；驱动必须按 toolName
          // 分流，这一条正好可以暴露「不区分工具就累加 exitCode」的实现错误。
          performance: {
            totalMs: 90,
            // permissionWaitMs 只在 permission 变体非 0：若所有变体都给 0，
            // 「等待时长从 requested 记到 resolved」这条逻辑不会被验证。
            permissionWaitMs: variant === "permission" ? 60 : 0,
            commandRunMs: variant === "permission" ? 30 : 90,
            exitCode: variant === "failed" ? 2 : 0,
            timedOut: false,
            outputBytes: 12,
            commandCategory: "read",
            // commandHash 是脱敏后的命令指纹，缺省会被当成「无命令」。给一个固定值
            // 让断言可以验证「同一命令的重试命中同一 hash」。
            commandHash: "0123456789abcdef",
            workspaceKind: "local",
          },
        },
      );
    }
    // 四个变体都以 success 收尾、错误只出现在工具层：这样工具失败与轮次失败
    // 解耦，agent_error 与 tool_error 两个计数才能分别验证，不会互相顶替。
    tdp08.push({
      kind: "terminal",
      now: base + 200,
      eventId: `tdp08-${variant}-terminal`,
      sessionId,
      commandId,
      turnId,
      status: "success",
    });
  });

  // TDP09 验证「前台关闭后重开」：detach 必须发生在 terminal 之前，
  // 这样这一轮会在「没有前台」的状态下结束，才能断言它仍被算进前台时长之外的
  // 后台补齐逻辑；若 detach 放在 terminal 之后，本轮已结算，测不到中途失焦。
  const tdp09 = successfulTextTurn({ caseId: "TDP09", includeNetwork: true });
  const tdp09Terminal = tdp09.findIndex((operation) => operation.kind === "terminal");
  // owner 必须与 successfulTextTurn 内部生成的 "tdp09-owner" 完全一致（INV-7）：
  // 写成别的前缀会让 detach 变成 no-op，而这个 case 仍然「通过」——只是什么都没测。
  tdp09.splice(tdp09Terminal, 0, {
    kind: "foreground.detach",
    owner: "tdp09-owner",
  });
  // 重开用不同的 owner：若复用 "tdp09-owner"，就无法区分「重新 attach 生效」
  // 与「detach 根本没生效」这两种情况。
  tdp09.push({
    kind: "foreground.attach",
    sessionId: "tdp09-session",
    owner: "tdp09-reopen",
  });

  // TDP10 是时间边界的参数表：六个变体各自压一个数值边界，
  // 因此所有 sendAt 都是手写绝对值而不是递增计算——边界值本身必须一眼可读。
  const tdp10: ConversationTelemetryParityOperation[] = [];
  const timingVariants = [
    // [时序] firstAt < sendAt 制造负 TTFT：实现应当 clamp 到 0，而不是算出负数
    // 写进报表。若这里改成 firstAt > sendAt，这条断言就退化成普通成功轮。
    { name: "negative", sendAt: 200, firstAt: 100, secondAt: undefined },
    // 没有首字：TTFT 必须留空而不是 0，否则「首字很慢」与「从未首字」混为一谈。
    { name: "no-token", sendAt: 500, firstAt: undefined, secondAt: undefined },
    // 恰好 3000ms 间隔卡在 stall 阈值上（不触发）；3001 越过阈值（触发）。
    // 两条必须成对存在，只留一条就测不出 off-by-one。
    { name: "gap-3000", sendAt: 800, firstAt: 900, secondAt: 3_900 },
    { name: "gap-3001", sendAt: 4_200, firstAt: 4_300, secondAt: 7_301 },
    // tool-clear 在长间隔中插入工具调用：验证「工具活动会清除 stall 计时」，
    // 若实现只按 chunk 间隔算，这条会误报 stall。
    { name: "tool-clear", sendAt: 7_600, firstAt: 7_700, secondAt: 13_000 },
    // split 有两个前台 owner：验证同一 session 多 pane 观察时 TTFT 不被重复计。
    { name: "split", sendAt: 13_300, firstAt: 13_400, secondAt: undefined },
  ] as const;
  timingVariants.forEach((variant) => {
    // 每个变体独立 session：共享会让 stall 计时器跨变体延续，边界值全被污染。
    const sessionId = `tdp10-${variant.name}-session`;
    const commandId = `tdp10-${variant.name}-command`;
    const turnId = `tdp10-${variant.name}-turn`;
    tdp10.push(
      {
        kind: "foreground.attach",
        sessionId,
        owner: `tdp10-${variant.name}-owner-1`,
      },
      // 第二个 owner 只在 split 变体出现，且 sessionId 相同（这是唯一允许
      // 同一 session 多个 owner 的 case）。
      ...(variant.name === "split"
        ? ([
            {
              kind: "foreground.attach",
              sessionId,
              owner: "tdp10-split-owner-2",
            },
          ] satisfies ConversationTelemetryParityOperation[])
        : []),
      {
        kind: "seed",
        sessionId,
        commandId,
        now: variant.sendAt,
        ...seedDetail,
      },
      // turn.started 固定在 sendAt+1：让 sendAt 本身就是「开始发送」的边界，
      // 不能因为多轮改表而漂移。
      {
        kind: "turn.started",
        now: variant.sendAt + 1,
        eventId: `tdp10-${variant.name}-start`,
        sessionId,
        commandId,
        turnId,
      },
    );
    if (variant.firstAt !== undefined) {
      tdp10.push({
        kind: "chunk",
        now: variant.firstAt,
        eventId: `tdp10-${variant.name}-chunk-1`,
        sessionId,
        commandId,
        turnId,
        channel: "text",
        firstChunk: true,
      });
    }
    if (variant.name === "tool-clear") {
      // 工具区间落在 firstAt(7700) 与 secondAt(13000) 之间：如果把工具调用挪到
      // 区间外，stall 仍会被 chunk 间隔触发，这个变体就失去意义。
      tdp10.push(
        {
          kind: "tool",
          now: 11_500,
          eventId: "tdp10-tool-clear-start",
          sessionId,
          commandId,
          turnId,
          phase: "started",
          toolCallId: "tdp10-tool-clear-tool",
          toolName: "Read",
        },
        {
          kind: "tool",
          now: 12_000,
          eventId: "tdp10-tool-clear-complete",
          sessionId,
          commandId,
          turnId,
          phase: "completed",
          toolCallId: "tdp10-tool-clear-tool",
          toolName: "Read",
        },
      );
    }
    if (variant.secondAt !== undefined) {
      // 第二条 chunk 必须 firstChunk:false：true 会把 TTFT 改写到这条上，
      // gap-3000/3001 两个变体的断言就都变成「首字时间」而不是「停顿」。
      tdp10.push({
        kind: "chunk",
        now: variant.secondAt,
        eventId: `tdp10-${variant.name}-chunk-2`,
        sessionId,
        commandId,
        turnId,
        channel: "text",
        firstChunk: false,
      });
    }
    // terminal 取 max(sendAt+200, lastChunk+100) 而不是固定值：保证终态永远晚于
    // 最后一条事件，避免造出「先结束再收到 chunk」的非法时序（那会让驱动丢弃后者）。
    tdp10.push({
      kind: "terminal",
      now: Math.max(
        variant.sendAt + 200,
        (variant.secondAt ?? variant.firstAt ?? variant.sendAt) + 100,
      ),
      eventId: `tdp10-${variant.name}-terminal`,
      sessionId,
      commandId,
      turnId,
      status: "success",
    });
  });

  // TDP11 覆盖压缩的三种终态 + 重复 + 后台触发。
  // attach 与 compaction 分成两批 map 而不是交错的：attach 必须先全部完成，
  // 否则后台压缩会在「无前台」时被误归到 background。
  const tdp11: ConversationTelemetryParityOperation[] = [
    ...["completed", "failed", "interrupted"].map(
      (status) =>
        ({
          kind: "foreground.attach",
          sessionId: `tdp11-${status}-session`,
          owner: `tdp11-${status}-owner`,
        }) satisfies ConversationTelemetryParityOperation,
    ),
    // 三个状态的 provider 刻意交替（external/glm）：用来验证报表按 provider 分组时
    // 不会把「同一个模型名」误合并——index 2 的 glm 与 index 0/1 的 anthropic
    // 必须落在两个桶里。
    ...["completed", "failed", "interrupted"].map(
      (status, index) =>
        ({
          kind: "compaction",
          now: 200 + index * 100,
          eventId: `tdp11-${status}`,
          sessionId: `tdp11-${status}-session`,
          operationId: `tdp11-${status}-operation`,
          summaryMessageId: `tdp11-${status}-summary`,
          status: status as "completed" | "failed" | "interrupted",
          // trigger 也随 index 变化：manual 与 auto 的计数口径不同（INV 未单列，
          // 但报表把 manual 计入用户触发的压缩，auto 计入被动触发）。
          trigger: index === 0 ? "manual" : "auto",
          reason: index === 0 ? "manual request" : undefined,
          compactReason: index === 1 ? "context_limit" : undefined,
          modelName: index === 2 ? "glm-model" : "external-model",
          modelProvider: index === 2 ? "glm" : "anthropic",
          startedAt: 100,
          endedAt: 150 + index * 10,
          preCompactTokenCount: 100,
          postCompactTokenCount: 40,
          // truePost 与 post 刻意不同（35 vs 40）：用来验证报表采用哪一个口径，
          // 两者相等时任何实现都能「通过」。
          truePostCompactTokenCount: 35,
        }) satisfies ConversationTelemetryParityOperation,
    ),
    // duplicate 复用了 completed 的 sessionId 与 operationId，但状态不同（failed）。
    // 这是刻意的：重复事件必须按 operationId 去重，而不是按 eventId——若按 eventId，
    // 这条会被当成一次新压缩，重复检测就测不到（INV-5）。
    {
      kind: "compaction",
      now: 600,
      eventId: "tdp11-duplicate",
      sessionId: "tdp11-completed-session",
      operationId: "tdp11-completed-operation",
      status: "failed",
      trigger: "manual",
      duplicate: true,
    },
    // 后台压缩没有对应的 attach：它必须仍被计入 report（trigger=auto），
    // 这条用来证明「无前台 ≠ 不采集」。
    {
      kind: "compaction",
      now: 700,
      eventId: "tdp11-background",
      sessionId: "tdp11-background-session",
      operationId: "tdp11-background-operation",
      status: "completed",
      trigger: "auto",
      modelName: "glm-model",
      modelProvider: "glm",
    },
  ];

  // TDP12 是笛卡尔积：5 个网络状态 × 2 种可见性。
  // [权衡] 用 flatMap 而不是手写 10 条：手写很容易漏掉某一种状态，
  // 而漏掉的那条不会报错，只会让 plan_request 总数从 10 变成 9（INV-20）。
  // 代价是事件 id 由模板拼接，改状态名等于改 id，因此状态名必须与 events 契约一致。
  const tdp12 = [
    "model_request_started",
    "model_request_completed",
    "model_request_failed",
    "model_retry_scheduled",
    "model_stream_stalled",
  ].flatMap((status, index) =>
    ["foreground", "background"].map(
      (visibility, visibilityIndex) =>
        ({
          kind: "model.status",
          // now 用 index*20 + visibilityIndex 保证 10 条事件严格递增且互不重叠：
          // 同一时间戳会让「按时间排序后取最后一条状态」的实现拿到不确定结果。
          now: 100 + index * 20 + visibilityIndex,
          eventId: `tdp12-${status}-${visibility}`,
          // sessionId 只按可见性区分（不是每个状态一个）：这样前台/后台各自是一个
          // 会话，report 才能按会话聚合出 5:5 的分布。
          sessionId: `tdp12-${visibility}-session`,
          requestId: `tdp12-request-${visibility}`,
          status: status as ParityModelStatus,
          providerId: "custom-provider",
          modelId: "custom-model",
          providerHostname: "safe.example.com",
          // started 没有耗时的语义，显式给 undefined：给 0 会被算成「瞬间完成」，
          // 让 plan_ttft 的平均值被拉低。
          durationMs: status === "model_request_started" ? undefined : 20 + index,
          reason: status === "model_request_failed" ? "failed" : undefined,
          retryable: status === "model_retry_scheduled" ? true : undefined,
          delayMs: status === "model_retry_scheduled" ? 500 : undefined,
          // idleMs 略大于 timeoutMs（3001 > 3000）：stalled 的定义是「超时之后才判定」，
          // 两者相等时无法区分「刚好到点」与「已超时」。
          idleMs: status === "model_stream_stalled" ? 3_001 : undefined,
          timeoutMs: status === "model_stream_stalled" ? 3_000 : undefined,
        }) satisfies ConversationTelemetryParityOperation,
    ),
  );

  // TDP13 是 TTFT 的四象限：正常 / 负值 / provider 缺失 / 后台。
  // provider 用空串表示缺失，而不是省略字段或写 "unknown"：省略会让驱动回落到
  // 默认 provider 并算出有效 TTFT，写 "unknown" 会走「未知但存在」的 safe fallback，
  // 两者都不该计入 (INV-21)。
  const tdp13: ConversationTelemetryParityOperation[] = [];
  const ttftVariants = [
    // 合法样本：180-100=80ms，作为其它三个变体的对照基准。
    {
      name: "valid",
      sendAt: 100,
      chunkAt: 180,
      provider: "glm",
      foreground: true,
    },
    // 负值样本：chunkAt 早于 sendAt，必须被丢弃而不是 clamp 成 0 后计入平均。
    {
      name: "negative",
      sendAt: 400,
      chunkAt: 350,
      provider: "glm",
      foreground: true,
    },
    // provider 缺失样本：即便时间合法也不计入（无法归属到某个 provider 维度）。
    {
      name: "missing",
      sendAt: 700,
      chunkAt: 780,
      provider: "",
      foreground: true,
    },
    // 后台样本：时间合法、provider 合法，但不在前台，必须单列而不是混入前台均值。
    {
      name: "background",
      sendAt: 1_000,
      chunkAt: 1_080,
      provider: "glm",
      foreground: false,
    },
  ];
  ttftVariants.forEach((variant) => {
    const sessionId = `tdp13-${variant.name}-session`;
    const commandId = `tdp13-${variant.name}-command`;
    const turnId = `tdp13-${variant.name}-turn`;
    // background 变体没有 attach：这是它与 foreground=false 的唯一区别点，
    // 若给它也 attach，四个变体就都变成前台样本，负例全部失效。
    if (variant.foreground) {
      tdp13.push({
        kind: "foreground.attach",
        sessionId,
        owner: `tdp13-${variant.name}-owner`,
      });
    }
    tdp13.push(
      // seed 里显式展开三个环境字段而不是用 ...seedDetail：这个 case 正是要
      // 逐个改变 provider，复用 seedDetail 会让"缺失"难以表达（空串会被覆盖）。
      {
        kind: "seed",
        sessionId,
        commandId,
        now: variant.sendAt,
        askMode: "build",
        modelName: "glm-model",
        modelProvider: variant.provider,
      },
      {
        kind: "turn.started",
        now: variant.sendAt + 1,
        eventId: `tdp13-${variant.name}-start`,
        sessionId,
        commandId,
        turnId,
      },
      // 唯一一条 firstChunk:true：TTFT 只可能来自这里。给多条会让「取第一条」
      // 与「取最后一条」两种实现都能通过。
      {
        kind: "chunk",
        now: variant.chunkAt,
        eventId: `tdp13-${variant.name}-chunk`,
        sessionId,
        commandId,
        turnId,
        channel: "text",
        firstChunk: true,
      },
      // terminal 固定在 sendAt+200（与 chunk 的相对位置随变体变化）：
      // 负值变体里 terminal 仍在 chunk 之后，保证断裂的是 TTFT 而不是整体时序。
      {
        kind: "terminal",
        now: variant.sendAt + 200,
        eventId: `tdp13-${variant.name}-terminal`,
        sessionId,
        commandId,
        turnId,
        status: "success",
      },
    );
  });

  // TDP14 用同一个 errorKey 连发两次验证「同键只显示一次」，再用 suppressed
  // 验证被策略吞掉的错误完全不计数，最后换 key 证明去重不是全局的。
  const tdp14: ConversationTelemetryParityOperation[] = [
    // 第一次出现：detail 有值，用来确认去重时保留的是首条的详情还是末条的。
    {
      kind: "visible.error",
      errorKey: "tdp14-key-1",
      displayMessage: "Visible provider failure",
      code: "PROVIDER_ERROR",
      traceId: "tdp14-trace-1",
      sessionId: "tdp14-session",
      detail: "bounded detail",
    },
    // 第二次：同 errorKey、同 traceId，但 duplicate:true。若没有 duplicate 标记，
    // 驱动仍应去重；这里显式标记是为了让「协议声明重复」这条路径也有人覆盖。
    {
      kind: "visible.error",
      errorKey: "tdp14-key-1",
      displayMessage: "Visible provider failure",
      code: "PROVIDER_ERROR",
      traceId: "tdp14-trace-1",
      sessionId: "tdp14-session",
      duplicate: true,
    },
    // suppressed 的 key 是独立的一个：若复用 key-1，抑制与去重两种原因会混在一起，
    // 无法判断 banner 数少 1 到底是哪条规则生效（INV-22）。
    {
      kind: "visible.error",
      errorKey: "tdp14-suppressed",
      displayMessage: "Suppressed local error",
      code: "LOCAL_ERROR",
      traceId: "tdp14-trace-suppressed",
      sessionId: "tdp14-session",
      suppressed: true,
    },
    // 换 key：证明去重作用域是「同 key」而不是「同会话」。若实现按会话去重，
    // 这一条会被丢弃，banner 数少 1。
    {
      kind: "visible.error",
      errorKey: "tdp14-key-2",
      displayMessage: "Second visible provider failure",
      code: "SECOND_ERROR",
      traceId: "tdp14-trace-2",
      sessionId: "tdp14-session",
    },
  ];

  // TDP15 验证「同一 message 的反馈是覆盖而不是累加」：
  // like → dislike → none 三次操作共用 messageId，最终应是「无反馈」而不是 3 条。
  // [权衡] 不在这里加第二个 messageId：加了就无法区分「按 message 覆盖」与
  // 「按会话覆盖」——只有一个 message 时两种实现结果相同。
  const tdp15: ConversationTelemetryParityOperation[] = [
    {
      kind: "feedback",
      sessionId: "tdp15-session",
      messageId: "tdp15-assistant",
      reaction: "like",
    },
    {
      kind: "feedback",
      sessionId: "tdp15-session",
      messageId: "tdp15-assistant",
      reaction: "dislike",
    },
    {
      kind: "feedback",
      sessionId: "tdp15-session",
      messageId: "tdp15-assistant",
      reaction: "none",
    },
  ];

  // TDP17 用真实的产品文案（从 messages 里取 3007）而不是硬编码字符串：
  // 文案变更时这个 case 会跟着变，从而证明「报表里的错误文案来自同一个 i18n 源」，
  // 而不是各端各拼一份。
  const tdp17: ConversationTelemetryParityOperation[] = [
    {
      kind: "visible.error",
      errorKey: "tdp17-3007",
      displayMessage: requestSecurityMessagesEnUS["zcode.error.providerBusiness.3007"],
      code: "3007",
      traceId: "tdp17-trace",
      sessionId: "tdp17-session",
    },
  ];

  // TDP18 验证驱动自身的幂等：同 eventId 的事件重发不能二次计数。
  // [失败路径] 第一条重发的 chunk 刻意不带 duplicate 标记，靠 eventId 相同来模拟
  // 「网络层重发」——如果这里也打上 duplicate，测到的就只是「协议声明重复」，
  // 而驱动自己是否去重完全没被验证（INV-24）。
  const tdp18 = successfulTextTurn({ caseId: "TDP18", includeNetwork: true });
  const duplicateChunk = tdp18.find(
    (operation): operation is Extract<ConversationTelemetryParityOperation, { kind: "chunk" }> =>
      operation.kind === "chunk",
  );
  const duplicateTerminal = tdp18.find(
    (operation): operation is Extract<ConversationTelemetryParityOperation, { kind: "terminal" }> =>
      operation.kind === "terminal",
  );
  if (duplicateChunk) tdp18.push({ ...duplicateChunk });
  // terminal 则显式带 duplicate:true：这里要覆盖的是「重复终态不得二次结算用量」，
  // 与上一条形成两种重复来源的对照（隐含标记 vs 显式标记）。
  if (duplicateTerminal) tdp18.push({ ...duplicateTerminal, duplicate: true });
  // dispose 放在所有事件之后：它之后不能再有事件，否则那些事件会落到新代际，
  // 让「旧代际的重复计数」这条断言失去被测对象（INV-25）。
  tdp18.push({ kind: "scope.dispose" });

  // TDP19 验证多 UI 实例（scope）隔离：两个身份各自跑一轮完整成功轮，
  // 若计数没有按 scope 分区，report 会得到 2 倍的 send_btn 而不是各 1。
  // web.noop 里再塞一轮：Web 端必须一条都不计，用来证明平台分支不会复用桌面路径。
  const tdp19 = [
    ...successfulTextTurn({ caseId: "TDP19A", scope: "identity-a" }),
    ...successfulTextTurn({ caseId: "TDP19B", scope: "identity-b" }),
    // 只销毁 identity-a：identity-b 必须继续存在，否则「销毁只影响自己的 scope」
    // 这条语义测不到（全部销毁与全部保留的结果相同）。
    { kind: "scope.dispose", scope: "identity-a" },
    {
      kind: "web.noop",
      operations: successfulTextTurn({ caseId: "TDP19WEB", scope: "web" }),
    },
  ] satisfies ConversationTelemetryParityOperation[];

  // 返回顺序即执行顺序，也是快照里的输出顺序；调换任意两项都会让快照全红，
  // 即使语义没变。这是刻意的：顺序本身是契约的一部分（见 INV-12）。
  //
  // 下表是「case → 覆盖点 → 必须同步的消费方」的索引，新增 case 时先在这里登记，
  // 再写 scenario()，最后去驱动注册表 / report 断言 / e2e fixture 三处补齐（INV-26）：
  // TDP01 基线成功轮         → report 三项 + arms 五项，所有差分的对照值
  // TDP02 同会话两轮         → message 级作用域重置
  // TDP03 排队中重复 seed     → promotion 去重（依赖 slice 下标）
  // TDP04 与 TDP01 同构        → 成功轮 usage 与 runtime 模型主机名
  // TDP05 失败轮 ±usage       → 用量缺失不得与 0 混淆
  // TDP06 中断 / 无终态       → completion 必须在缺终态时为 0
  // TDP07 thought 先于 text   → TTFT 归属与尾部 finalize
  // TDP08 工具四变体          → 工具/权限/父子归属的 arms 数
  // TDP09 焦点丢失后重开      → 后台补齐与不重放
  // TDP10 时间边界六变体      → 负值 clamp、stall 阈值、工具清除计时
  // TDP11 压缩三态 + 重复     → 按 operationId 去重、后台仍计数
  // TDP12 网络状态 × 可见性   → plan_request=10 的笛卡尔积
  // TDP13 TTFT 四象限         → provider 缺失必须整条跳过
  // TDP14 错误横幅去重        → 同 key 一次、suppressed 不计数
  // TDP15 消息反馈覆盖        → 最终状态而非累计次数
  // TDP16 配额横幅（仅断言）  → 不产生遥测，靠 quota.assert 触发
  // TDP17 3007 文案一次性     → header 只求值一次
  // TDP18 重复事件幂等        → 同 eventId 不得二次计数
  // TDP19 多 scope 隔离       → 分区计数与 web.noop
  return [
    // TDP01：最小基线。三个 report 计数各为 1，arms 里 plan_request=2 是因为
    // request-started/completed 各算一次；这个 2 是后续所有 case 的算术基准，
    // 改它等于改全部断言，必须先确认 events 契约。
    scenario(
      "TDP01",
      tdp01,
      { send_btn: 1, agent_step: 1, message_completion: 1 },
      {
        plan_request: 2,
        plan_ttft: 1,
        perf_ui_first_token: 1,
        perf_ui_message_complete: 1,
        perf_ui_turn_breakdown: 1,
      },
      ["draft-create-ack", "source-command-link"],
    ),
    // TDP02：两轮数值全部是 TDP01 的 2 倍，唯一新增信息是 proof 里的 same-talk-id。
    // 如果实现把作用域泄漏到第二轮，plan_ttft 会仍为 1（第二次首字被当成重复），
    // 而 total 仍是 2——所以这里必须比对「内部 bundle 的分配」而不只是总数。
    scenario(
      "TDP02",
      tdp02,
      { send_btn: 2, agent_step: 2, message_completion: 2 },
      {
        plan_request: 4,
        plan_ttft: 2,
        perf_ui_first_token: 2,
        perf_ui_message_complete: 2,
        perf_ui_turn_breakdown: 2,
      },
      ["same-talk-id", "message-scope-reset"],
    ),
    // TDP03：数值与 TDP02 完全相同——这是刻意的。
    // 若数值不同，说明重复 seed 被计成了第二份输入；相同才证明去重生效。
    // proof 里的 promotion-seed-deduped 是这条「相同」的唯一解释依据。
    scenario(
      "TDP03",
      tdp03,
      { send_btn: 2, agent_step: 2, message_completion: 2 },
      {
        plan_request: 4,
        plan_ttft: 2,
        perf_ui_first_token: 2,
        perf_ui_message_complete: 2,
        perf_ui_turn_breakdown: 2,
      },
      ["queued-before-first-terminal", "promotion-seed-deduped"],
    ),
    // TDP04 直接内联调用 successfulTextTurn：它不保留变量，因为它就是 TDP01
    // 的另一个实例，仅 proof 不同（成功轮 usage 与 runtime 模型主机名）。
    // [权衡] 保留这个重复 case 是为了让「同一份输入、不同采集关注点」可以独立失败，
    // 合并到 TDP01 会让一个回归同时指向两个根因。
    scenario(
      "TDP04",
      successfulTextTurn({ caseId: "TDP04" }),
      { send_btn: 1, agent_step: 1, message_completion: 1 },
      {
        plan_request: 2,
        plan_ttft: 1,
        perf_ui_first_token: 1,
        perf_ui_message_complete: 1,
        perf_ui_turn_breakdown: 1,
      },
      ["success-usage", "runtime-model-hostname"],
    ),
    // TDP05：两轮都是失败轮，所以 agent_step 与 completion 仍记 2（失败也算一步），
    // 但 arms 里没有 error 计数——失败由 report 侧的表达承担，arms 只记性能点。
    // 若有人把 completion 改成 0，会与 TDP06 的「无终态」语义混淆。
    scenario(
      "TDP05",
      tdp05,
      { send_btn: 2, agent_step: 2, message_completion: 2 },
      {
        plan_request: 4,
        plan_ttft: 2,
        perf_ui_first_token: 2,
        perf_ui_message_complete: 2,
        perf_ui_turn_breakdown: 2,
      },
      ["failed-with-usage", "failed-without-usage"],
    ),
    // TDP06：send_btn=2 但 agent_step=1、completion=1。
    // 这个「发送了两次、只完成一次」的关系是本 case 的全部价值：无终态的那一轮
    // 必须只体现在 send_btn 上，若 agent_step 也变成 2，说明驱动把「开始」当成了
    // 「完成」，这正是漏终态最典型的错误实现。
    // arms 里没有 plan_request 也是刻意的：includeNetwork:false 让两轮都没有网络
    // 事件，若这一项出现，就意味着驱动凭空造了请求（INV-8）。
    scenario(
      "TDP06",
      tdp06,
      { send_btn: 2, agent_step: 1, message_completion: 1 },
      {
        plan_ttft: 1,
        perf_ui_first_token: 1,
        perf_ui_message_complete: 1,
        perf_ui_turn_breakdown: 1,
      },
      ["interrupted-terminal", "stop-without-terminal-zero-completion"],
    ),
    // TDP07：agent_step=2 而 completion=1，说明 thought 会被算作一次额外的步骤，
    // 但不完成消息。这个不对称正是 thought 与 text 的分界：若实现把 thought 也
    // 计入 completion，两者会同时变成 2，tail-finalize 就测不到。
    // plan_ttft 仍为 1：thought 是首字但不产生第二个 TTFT，验证 TTFT 只记一次。
    scenario(
      "TDP07",
      tdp07,
      { send_btn: 1, agent_step: 2, message_completion: 1 },
      {
        plan_ttft: 1,
        perf_ui_first_token: 1,
        perf_ui_message_complete: 1,
        perf_ui_turn_breakdown: 1,
      },
      ["thought-before-text", "tail-finalize"],
    ),
    // TDP08：四个 session 各一轮，所以 send_btn/completion=4。
    // agent_step=5 而不是 4——多出来的一步来自 permission 变体：权限请求被计为
    // 一次额外的 agent 步骤。这条「+1」是权限路径被正确识别的唯一外部证据，
    // 若改成 4，permission 分支实际没跑也不会被发现。
    // perf_ui_tool_call_detail=3 而不是 4：parented 变体没有 tool 事件（INV-18）。
    scenario(
      "TDP08",
      tdp08,
      { send_btn: 4, agent_step: 5, message_completion: 4 },
      {
        plan_ttft: 4,
        perf_ui_first_token: 4,
        perf_ui_message_complete: 4,
        perf_ui_turn_breakdown: 4,
        perf_ui_tool_call_detail: 3,
      },
      ["tool-success", "tool-failed", "permission-wait", "parented-child"],
    ),
    // TDP09：report 侧与 TDP01 完全一致，arms 只保留 plan_request=2。
    // 这是本 case 的核心断言：detach 之后重开，不能补发任何 UI 性能 arm
    // （perf_ui_* 全部缺席），否则说明重开会重放一遍首字/完成埋点。
    scenario(
      "TDP09",
      tdp09,
      { send_btn: 1, agent_step: 1, message_completion: 1 },
      { plan_request: 2 },
      ["terminal-after-detach", "reopen-no-replay", "background-ui-arms-zero"],
    ),
    // TDP10：六个变体各一轮，report 三项均为 6。
    // 关键的不对称在 arms：plan_ttft=4 而 perf_ui_first_token=6——
    // 说明 negative 与 no-token 两个变体只产生 UI arm、不产生 plan_ttft：
    // 负数被丢弃、缺失不被当成 0。若两个数字相等，负值/缺失的处理一定写错了。
    // perf_ui_stream_stall=1 只来自 gap-3001（3000 恰好不触发）。
    scenario(
      "TDP10",
      tdp10,
      { send_btn: 6, agent_step: 6, message_completion: 6 },
      {
        plan_ttft: 4,
        perf_ui_first_token: 6,
        perf_ui_message_complete: 6,
        perf_ui_turn_breakdown: 6,
        perf_ui_stream_stall: 1,
      },
      [
        "negative-ttft-clamped",
        "no-token",
        "stall-3000-zero",
        "stall-3001-one",
        "tool-clears-stall",
        "split-pane-once",
      ],
    ),
    // TDP11：report 只有 context_compaction=3——三种终态各一条。
    // 重复的第四条（duplicate）与后台第五条都不计入，才得到 3 而不是 5。
    // arms 为空对象是断言本身：压缩不产生任何 UI 性能点，若出现非空就说明
    // 压缩路径被错误地接进了 turn 埋点。
    scenario("TDP11", tdp11, { context_compaction: 3 }, {}, [
      "three-terminal-statuses",
      "nonterminal-zero",
      "duplicate-operation-zero",
      "background-zero",
      "legacy-model-encoding",
    ]),
    // TDP12：report 为空、arms 只有 plan_request=10。
    // 「report 空」是刻意的：model.status 是网络层事件，不应污染扩展报表；
    // 若这里出现任何非 0 项，说明某条网络状态被误当成 agent 步骤。
    scenario("TDP12", tdp12, {}, { plan_request: 10 }, [
      "five-network-statuses",
      "foreground-background",
      "accepted-queued-apiRetry-zero",
      "hostname-only",
    ]),
    // TDP13：四个变体全部计入 report（send_btn/step/completion 各 4），
    // 但 plan_ttft=1、perf_ui_first_token=3。
    // 「1 vs 3」是本 case 唯一的有效判据：只有 valid 产生 plan_ttft，
    // 而三个「合法时序」的变体都产生 UI arm。若两者都变成 4，说明缺失/负值被接受；
    // 若两者都变成 1，说明后台样本被错误地排除了。
    scenario(
      "TDP13",
      tdp13,
      { send_btn: 4, agent_step: 4, message_completion: 4 },
      {
        plan_ttft: 1,
        perf_ui_first_token: 3,
        perf_ui_message_complete: 3,
        perf_ui_turn_breakdown: 3,
      },
      ["valid-ttft", "negative-no-plan-ttft", "missing-provider-no-plan-ttft", "background-zero"],
    ),
    // TDP14：只有 chat_error_banner=2——第一条 key-1 与唯一的 key-2。
    // 第二条（同 key 重复）与 suppressed 都不计。这个 2 同时验证了两条规则，
    // 所以 proof 里把它拆成 same-key-once 与 suppressed-zero 两项分别说明。
    scenario("TDP14", tdp14, {}, { chat_error_banner: 2 }, [
      "visible",
      "suppressed-zero",
      "same-key-once",
      "new-key-new-event",
    ]),
    // TDP15：assistant_message_feedback=3 是「三次操作」而不是「最终一个状态」，
    // 因为 report 记的是操作次数，状态覆盖语义由 proof 的 toggle-none 表达。
    // arms 为空：反馈不产生任何性能点，避免把用户交互混进耗时统计。
    scenario("TDP15", tdp15, { assistant_message_feedback: 3 }, {}, [
      "like",
      "dislike",
      "toggle-none",
      "command-failure-rollback",
      "reopen-persisted",
    ]),
    // TDP16 只有 quota.assert 一个操作：它不产生遥测，全部期望为空对象。
    // 这个「空 case」存在的意义是占据一个明确的 caseId，让配额横幅的 UI 断言
    // 有地方挂；若把期望也留空但不给 assert，用例会在配额功能缺失时静默通过。
    scenario("TDP16", [{ kind: "quota.assert" }], {}, {}, [
      "quota-banner",
      "dismiss",
      "blocking-and-nonblocking",
      "entitlement-refresh",
      "upgrade-context",
      "purchase-events-pruned",
    ]),
    // TDP17：verification.assert 排在 visible.error 之前（INV-23）。
    // 顺序保证「先求值校验、再显示错误」，header 只被读取一次；若交换位置，
    // one-shot 语义就测不到，重复求值也会被接受。
    // chat_error_banner=1 说明 3007 文案只产生一条横幅，且与 TDP14 无关。
    scenario("TDP17", [{ kind: "verification.assert" }, ...tdp17], {}, { chat_error_banner: 1 }, [
      "visible-3007",
      "exact-zcode-plan-provider",
      "one-shot-header",
      "accepted-duplicate-handled",
      "failure-retryable",
      "non-zcode-plan-skipped",
    ]),
    // TDP18：数值与 TDP01 完全相同。这正是幂等断言的形式：
    // 重复的 chunk 与 duplicate 的 terminal 都不能让任何计数增加。
    // 若 send_btn/plan_request 变多，说明驱动按「收到即计数」而不是按 eventId 去重。
    // scope.dispose 之后没有期望，用来确认销毁本身不产生埋点。
    scenario(
      "TDP18",
      tdp18,
      { send_btn: 1, agent_step: 1, message_completion: 1 },
      {
        plan_request: 2,
        plan_ttft: 1,
        perf_ui_first_token: 1,
        perf_ui_message_complete: 1,
        perf_ui_turn_breakdown: 1,
      },
      ["duplicate-live-once", "initial-hydration-recovery-zero", "reload-zero-replay"],
    ),
    // TDP19：report 与 arms 都是 2/4，等于「两轮」，因为 web.noop 里的第三轮
    // 必须完全不计。若实现没有按平台分流，这里会变成 3/6——这是最直接的判据。
    // identity-a 被 dispose 但 identity-b 未销毁，两轮的数值都不受影响，
    // 说明销毁只清理自己的 scope 而不影响其它实例。
    scenario(
      "TDP19",
      tdp19,
      { send_btn: 2, agent_step: 2, message_completion: 2 },
      {
        plan_request: 4,
        plan_ttft: 2,
        perf_ui_first_token: 2,
        perf_ui_message_complete: 2,
        perf_ui_turn_breakdown: 2,
      },
      ["workspace-identity-isolated", "remote-session-isolated", "generation-disposed", "web-noop"],
    ),
  ];
}

// Map 的构造顺序即 buildScenarios 的返回顺序；用 Map 而不是对象，
// 是因为 caseId 未来可能包含 "constructor"/"__proto__" 这类与对象原型冲突的字符串，
// 用对象字面量会让它们变成原型属性而不是用例。
const SCENARIOS = new Map(buildScenarios().map((item) => [item.caseId, item]));

// 导出的 case 列表顺序必须稳定：调用方用它渲染快照名与进度条，
// 顺序一乱，测试报告的行号就全部错位（虽然用例本身没变）。
export const CONVERSATION_TELEMETRY_PARITY_CASE_IDS = [...SCENARIOS.keys()];

// [失败路径] 未知 caseId 抛错而不是返回 undefined：
// 返回 undefined 会让调用方在后续解构时抛 TypeError，错误信息变成
// 「cannot read properties of undefined」，真正的原因（拼错 caseId）被掩盖。
export function getConversationTelemetryParityScenario(
  caseId: string,
): ConversationTelemetryParityScenario {
  const found = SCENARIOS.get(caseId);
  if (!found) {
    throw new Error(`Unknown conversation telemetry parity case: ${caseId}`);
  }
  return found;
}
