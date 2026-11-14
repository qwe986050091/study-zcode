// LocalTtftObserver：Renderer 侧本地首输出（TTFT）观察器，把一次真实点击到首输出的事实拼成记录。
// 它只持有未收口观察的内存态，负责采样、合并 CLI 阶段事实、收口与分类丢弃；不负责传输、落盘、聚合与看板口径。
// 首输出只认 Renderer 的点击总时钟与内容帧，不用 ACK、队列时延或旁路 telemetry 反推，避免跨链路口径漂移。
//
// INV-01 断言：观察器关闭时不产生任何记录、也不占用 pending 容量 —— 守住它的位置：start 开头的 enabled 判断 —— 改错故障：线上默认关闭的埋点仍会发出 start 记录，看板出现无首输出的空观察。
// INV-02 断言：start 记录先于容量与 unsupported 判定发出，被拒绝的观察不再登记 pending —— 守住它的位置：start 中 emit 与两个 early return 的顺序 —— 改错故障：被拒绝的观察留下 start 却没有收口，看板分母虚高且无法解释。
// INV-03 断言：首输出一旦收口就冻结，后续阶段只能补 checkpoint 不能改写主样本 —— 守住它的位置：receive 的 pending.first 与 pending.closed 判断 —— 改错故障：晚到的重传会让 TTFT 时长或首输出类型在导出时来回跳变。
// INV-04 断言：首输出只由内容行产生的 delta 触发，不因命令行阶段或 ACK 触发 —— 守住它的位置：receive 里 row.appended 与 row.delta 的 kind 推导 —— 改错故障：阶段更新被误算成首输出，TTFT 系统性偏小。
// INV-05 断言：同一帧的 toSeq 只推进一次，重复投递不重复计数 —— 守住它的位置：receive 的 lastSeq 判断与赋值 —— 改错故障：重连重放把同一段文本计成两次首输出，样本翻倍。
// INV-06 断言：initial 订阅快照永远不参与 gap 归因 —— 守住它的位置：receive 开头的 delivery 等于 initial 提前返回 —— 改错故障：正常订阅被标成 recovery，恢复率与排除率同时虚高。
// INV-07 断言：desktop 的 online snapshot 记为 resync，只有真正的 recovery 投递才记 recovery —— 守住它的位置：receive 的 outcome 三元表达式 —— 改错故障：手机恢复语义被贴到桌面样本，两类故障无法分开定位。
// INV-08 断言：同一 observation 只接受同一 workspace、command、session 的事实 —— 守住它的位置：merge 的身份与 session 守卫 —— 改错故障：多窗口同号 command 互相污染，点击时间归到别的会话。
// INV-09 断言：观察在首次收口后再次 exclude 只能收尾正文，不能反转已有主样本 —— 守住它的位置：exclude 的 pending.closed 分支 —— 改错故障：CLI 中断会把已成立的 TTFT 改写成 interrupted，主样本凭空消失。
// INV-10 断言：容量淘汰只清理已收口观察，且淘汰失败时按 capacity 显式排除 —— 守住它的位置：start 的两个 LOCAL_TTFT_MAX_PENDING 分支 —— 改错故障：未收口的观察被静默顶掉，既无记录也无排除原因。
// INV-11 断言：校准按 workspace 独立缓存，超过时钟 TTL 视为需要重新校准 —— 守住它的位置：calibrate 与 needsCalibration —— 改错故障：过期偏移被继续套用，跨进程阶段整体错位几十毫秒。
// INV-12 断言：时钟采样间隔超过 5 秒即把在途观察标为时钟不可信 —— 守住它的位置：sampleClock 的 5000 毫秒阈值 —— 改错故障：休眠唤醒后的墙钟跳变被当成真实等待，TTFT 出现小时级异常值。
// INV-13 断言：checkpoint 用序列化签名去重，相同事实不重复出记录 —— 守住它的位置：checkpoint 的 checkpointSignature —— 改错故障：每次心跳都产出一条 checkpoint，导出体积和看板噪声暴涨。
// INV-14 断言：观察超过 TTL 时只按 unclosed 标记，不冒充 failed —— 守住它的位置：expire 的 closed 判断与 outcome —— 改错故障：崩溃或挂起被统计成失败，失败率口径失真。
// INV-15 断言：观测回调抛错必须被吞掉，绝不能影响提交、投影与清理 —— 守住它的位置：emit 的 try/catch —— 改错故障：埋点异常冒泡到消息处理链，正常对话被中断。
//
import { mergeLocalTtftFacts } from "@/v4/telemetry/localTtftFacts.js";
import {
  buildLocalTtftRecord,
  type LocalTtftPending as Pending,
} from "@/v4/telemetry/localTtftRecord.js";
import { logger } from "@/logger.js";
import {
  LOCAL_TTFT_MAX_PENDING,
  LOCAL_TTFT_TTL_MS,
  LOCAL_TTFT_CLOCK_TTL_MS,
  localTtftNow,
  type LocalTtftContext,
  type LocalTtftCalibration,
  type LocalTtftFacts,
  type LocalTtftRecord,
  type LocalTtftOutputKind,
} from "@zcode/shared";
import type {
  ConversationTopicFrame,
  TopicFrameDeliveryKind,
} from "@zcode/shared/zcode-protocol-v4";

/** Renderer 独占点击总时钟；不使用 ACK 或旁路 telemetry 判定首输出。 */
export class LocalTtftObserver {
  // [契约] 默认关闭：构造出实例不等于开始采样，任何写记录的分支都必须先看这个开关。
  // 漏掉一次开关判断不会报错，只会在生产看板上混入空观察。
  enabled = false;
  // [契约] pending 只保存尚未收口的观察，收口后保留引用仅供补 checkpoint 与去重。
  // 容量上限按这里的条目数计，别换成 LRU 之类会提前丢在途观察的策略。
  // 已收口条目被过早删除，晚到的阶段事实就再也补不回 complete 质量。
  private readonly pending = new Map<string, Pending>();
  private isForeground = true;
  private lastClockSample?: number;
  private readonly clocks = new Map<string, LocalTtftCalibration>();
  constructor(
    private readonly onRecord: (record: LocalTtftRecord) => void,
    private readonly now = localTtftNow,
    private readonly wallNow = Date.now,
    private readonly readForeground?: () => boolean,
  ) {}
  // [失败路径] onRecord 由调用方注入，实现里可能抛错，这里是唯一的隔离边界。
  // 不要在这里重抛或改成异步投递：观测失败不能反向阻断提交，顺序也不能乱。
  // 异步化会让 first_output 与 checkpoint 的先后关系失真，导出端无法还原时序。
  private emit(record: LocalTtftRecord): void {
    try {
      this.onRecord(record);
    } catch {
      /* 观测失败不能阻断提交、内容投影或清理。 */
    }
  }
  // start 的起点就是用户点击 Renderer 的瞬间，之后所有阶段都相对它测量。
  // busy 只决定 sendMode 初值，不推迟起点：排队时长本来就该算进 TTFT。
  // 每次调用先 expire，把过期的旧观察收口，避免容量被长期挂起的条目吃掉。
  start(workspace: string, busy: boolean, unsupported = false): LocalTtftContext | undefined {
    // 关闭状态下连 start 记录都不发，调用方拿到 undefined 自然跳过后续 dispatch 与 ack。
    // 改成先建观察再判断，会让关闭态产生只有 start 的半截记录。
    if (!this.enabled) return undefined;
    this.expire();
    if (this.readForeground) this.visibility(this.readForeground());
    const context: LocalTtftContext = { version: 1, observationId: crypto.randomUUID() };
    const pending: Pending = {
      context,
      workspace,
      start: this.now(),
      wallStart: this.wallNow(),
      checkpointRevision: 0,
      lastSeq: -1,
      rows: new Map(),
      sendMode: busy ? "queued" : "idle",
      visibility: this.isForeground ? "foreground" : "background",
      visibilityChanges: [{ at: this.now(), foreground: this.isForeground }],
      confirmations: [],
    };
    // [契约] start 记录在登记 pending 之前发出，给看板提供分母与点击时刻。
    // 它必须早于容量与 unsupported 判定，被排除的观察也才有完整起点可对齐。
    // 此时 pending 尚未入表，后续任何提前返回都不会残留观察状态。
    this.emit(this.record(pending, "start", "success"));
    // 容量满 `LOCAL_TTFT_MAX_PENDING` 时只回收一条已收口观察，在途观察一律不顶掉。
    // 顺序不能反过来：先回收再判断，满载时的下一次点击才有位置。
    // 代价是这条已收口观察之后无法再补质量，但主样本已经落盘。
    if (this.pending.size >= LOCAL_TTFT_MAX_PENDING) {
      const completed = [...this.pending].find(([, value]) => value.closed);
      if (completed) this.pending.delete(completed[0]);
    }
    if (this.pending.size >= LOCAL_TTFT_MAX_PENDING) {
      this.emit(this.record(pending, "excluded", "capacity"));
      return undefined;
    }
    // unsupported 表示这类命令永远不会有首输出，直接按原因排除。
    // 它和 capacity 一样只在 start 判定，不能拖到终态再补分类。
    if (unsupported) {
      this.emit(this.record(pending, "excluded", "unsupported"));
      return;
    }
    this.pending.set(context.observationId, pending);
    return context;
  }
  dispatch(
    context: LocalTtftContext,
    workspace: string,
    commandId: string,
    sessionId?: string | null,
  ): LocalTtftContext | undefined {
    const pending = this.pending.get(context.observationId);
    if (!pending || pending.workspace !== workspace) return undefined;
    // dispatch 只补第一次：重试或重复命令不能把渲染端准备阶段拉长。
    // commandId 与 sessionId 同样只认首个绑定，后续事件只能沿用这个身份。
    pending.dispatch ??= this.now();
    pending.commandId ??= commandId;
    pending.sessionId ??= sessionId ?? undefined;
    this.emit(this.record(pending, "checkpoint", "success"));
    return context;
  }
  // ack 只做排除分类，不参与首输出判定：首输出必须来自内容帧。
  // accepted 与 duplicate 都算正常，重复提交在服务端可能表现为 duplicate。
  // rejected 与其它状态分别落到 rejected、failed，别把所有非 accepted 都并成 failed。
  ack(context: LocalTtftContext, status: string, excluded?: "capacity"): void {
    if (excluded) {
      this.exclude(context, excluded);
      return;
    }
    if (status !== "accepted" && status !== "duplicate")
      this.exclude(context, status === "rejected" ? "rejected" : "failed");
  }
  // [资源] 校准缓存按 workspace 隔离，条数上限沿用 128，超出时淘汰最早写入的一项。
  // Map 的插入顺序即缓存顺序，改成果断清空会让所有工作区同时失去可用偏移。
  // 同一 workspace 再次校准时直接覆盖，避免旧偏移与新偏移并存导致阶段错位。
  calibrate(workspace: string, clock: LocalTtftCalibration): void {
    if (this.clocks.size >= LOCAL_TTFT_MAX_PENDING)
      this.clocks.delete(this.clocks.keys().next().value!);
    this.clocks.set(workspace, clock);
  }
  // TTL 到期或从未校准都返回 true，调用方据此重新握手；关闭态一律不请求校准。
  // 这个判断不修改缓存，别在里面顺手删除样本，否则并发校准会互相踩掉。
  needsCalibration(workspace: string): boolean {
    const sample = this.clocks.get(workspace);
    return this.enabled && (!sample || this.now() - sample.measuredAt > LOCAL_TTFT_CLOCK_TTL_MS);
  }
  checkpoint(workspace: string, incoming: LocalTtftFacts): void {
    const pending = this.merge(workspace, incoming);
    if (!pending) return;
    const signature = JSON.stringify(pending.facts);
    // [权衡] 用完整事实的 JSON 签名去重，而不是比对 revision：阶段可能只补一个时间戳。
    // 签名只覆盖 facts，不含 pending 自身的首输出状态，避免收口后签名变化。
    // 去掉这层去重会让每次心跳都产出 checkpoint，导出量按秒增长。
    if (signature === pending.checkpointSignature) return;
    pending.checkpointSignature = signature;
    this.emit(this.record(pending, "checkpoint", pending.outcome ?? "unclosed"));
    if (pending.facts?.sendMode === "guided" && !pending.closed)
      this.exclude(pending.context, "guided");
    if (pending.facts?.terminal && pending.facts.outputAt === undefined && !pending.closed)
      this.exclude(
        pending.context,
        pending.facts.terminal === "completed" ? "unsupported" : pending.facts.terminal,
      );
  }
  // [契约] 合并前先验身份：workspace、commandId、sessionId 任一冲突都视为别人的事实。
  // sessionId 只在两边都存在时比较，草稿首次绑定前允许为空，不能因此拒绝。
  // mergeLocalTtftFacts 返回 undefined 表示事实互相矛盾，必须原样放弃。
  private merge(workspace: string, incoming: LocalTtftFacts): Pending | undefined {
    const pending = this.pending.get(incoming.observationId);
    if (
      !pending ||
      pending.workspace !== workspace ||
      pending.commandId !== incoming.commandId ||
      (pending.sessionId && incoming.sessionId && pending.sessionId !== incoming.sessionId)
    )
      return;
    const facts = mergeLocalTtftFacts(pending.facts, incoming);
    if (!facts) return;
    pending.facts = facts;
    return pending;
  }
  receive(
    workspace: string,
    frame: ConversationTopicFrame,
    delivery: TopicFrameDeliveryKind,
  ): void {
    // 首次订阅快照可能晚于准备检查点；它不是 gap recovery，也绝不是首输出。
    // [失败路径] initial 快照是订阅建立时的全量状态，可能晚于准备检查点到达。
    // 它既不是 gap recovery，也不含首输出归因，直接返回才不会把正常订阅记成恢复。
    // 移动端重放与桌面监听的差异就在这里，不要为了看起来完整而给它补记录。
    if (delivery === "initial") return;
    for (const facts of frame.ttftRelated ?? [])
      this.receive(workspace, { ...frame, ttft: facts, ttftRelated: undefined }, delivery);
    if (delivery === "recovery" || frame.payload.kind === "snapshot") {
      // Bug 原因：桌面 continuous 在订阅缓冲溢出或投影重建后会用 online snapshot 代替 deltas，
      // 之前一律记为 recovery，把手机恢复语义贴到桌面样本上。snapshot 内无法唯一归因首输出，
      // 仍需排除，但按 resync 单独标记；recovery 只保留给真正的 recovery 投递。
      // [权衡] online 却带 snapshot，说明桌面 continuous 的订阅缓冲溢出或投影刚重建。
      // 此时无法把首输出唯一归因到某条命令，按 resync 排除比猜一个更新更可信。
      // recovery 只留给真正的 replayable 恢复投递，混用会让恢复率与丢帧率无法区分。
      const outcome = delivery === "recovery" ? "recovery" : "resync";
      for (const pending of this.pending.values()) {
        if (
          pending.workspace === workspace &&
          frame.topic === `conversation/${pending.sessionId ?? pending.facts?.sessionId}`
        )
          this.exclude(pending.context, outcome);
      }
      return;
    }
    let facts = frame.ttft;
    if (!facts) return;
    if (
      delivery !== "online" ||
      frame.payload.kind !== "deltas" ||
      frame.topic !== `conversation/${facts.sessionId}`
    )
      return;
    const pending = this.merge(workspace, facts);
    if (!pending) return;
    if (!pending.facts?.outputAt && facts.outputAt)
      logger.debug("[local-ttft] actual content frame", {
        commandId: facts.commandId,
        turnId: facts.turnId,
        productTurnId: facts.productTurnId,
        outputKind: facts.outputKind,
        rows: frame.payload.deltas.flatMap((delta) =>
          delta.op === "row.appended" || delta.op === "row.upserted"
            ? [{ kind: delta.row.kind, turnId: delta.row.turnId }]
            : [],
        ),
      });
    this.checkpoint(workspace, facts);
    facts = pending.facts!;
    if (pending.textClosed) return;
    if (facts.excluded) {
      this.exclude(pending.context, facts.excluded);
      return;
    }
    // [并发] toSeq 是单调水位：小于等于已处理值说明是重放或乱序旧帧。
    // 水位在进入 delta 循环前推进，保证同一帧只被消费一次，重复帧在这里挡掉。
    // 把它挪到循环之后或删掉，会把同一次输出重复计入 first_text 与首输出。
    if (frame.toSeq <= pending.lastSeq) return;
    pending.lastSeq = frame.toSeq;
    for (const delta of frame.payload.deltas) {
      let kind: LocalTtftOutputKind | undefined;
      // 新增行只有在 turnId 与 facts.productTurnId 一致时才算这条命令的输出。
      // 空文本的 assistantText 或 reasoning 行会登记行号但不算首输出，等 delta 到达再判。
      // toolCall 要等输入流结束或已有输入才成立，inputStreaming 的空壳不是首输出。
      if (delta.op === "row.appended" || delta.op === "row.upserted") {
        const row = delta.row;
        if (row.turnId !== facts.productTurnId) continue;
        // [资源] 行索引上限 128，超出后只保留已登记的行，新行不再记 kind。
        // 这是内存护栏而非精度取舍：丢掉的行后续 delta 会因找不到行号被跳过。
        if (pending.rows.size < 128)
          pending.rows.set(row.rowId, { turnId: row.turnId, kind: row.kind });
        if ((row.kind === "assistantText" || row.kind === "reasoning") && row.text.trim())
          kind = row.kind === "assistantText" ? "text" : "reasoning";
        if (
          row.kind === "toolCall" &&
          row.toolName.trim() &&
          (row.inputText.trim() || row.status !== "inputStreaming")
        )
          kind = "tool";
      } else if (delta.op === "row.delta" && delta.append.trim()) {
        const row = pending.rows.get(delta.rowId);
        if (!row || row.turnId !== facts.productTurnId) continue;
        if (row.kind === "assistantText" && delta.path === "text") kind = "text";
        if (row.kind === "reasoning" && delta.path === "text") kind = "reasoning";
        if (row.kind === "toolCall" && delta.path === "inputText") kind = "tool";
      }
      // 首输出判定要求两件事同时成立：本行产出可读内容，且 CLI 已报告 outputAt。
      // 二者缺一就跳过，不要用 Renderer 收到帧的时间顶替 outputAt。
      if (!kind || facts.outputAt === undefined) continue;
      // [契约] 首输出只写一次：pending.first 与 closed 双条件挡住重复帧和迟到重传。
      // closed 在这里立刻置位，同一帧后面的 text 行只能产出 first_text。
      // firstAt 取 Renderer 时钟，checkpoint 的 end 也会被它钳住，保证首输出时刻不回退。
      if (!pending.first && !pending.closed) {
        pending.first = kind;
        pending.firstAt = this.now();
        pending.closed = true;
        pending.outcome = "success";
        const completed = this.record(pending, "first_output", "success");
        this.emit(completed);
      }
      // 正文首出现单独发 first_text，用于区分先思考后回答与只有思考没有正文。
      // 正文收口后 return，同一帧剩余 delta 不再处理；这是有意的截断，不是漏循环。
      // textClosed 与 closed 语义不同：前者只结束正文观察，后者结束整条观察。
      if (kind === "text") {
        this.emit(this.record(pending, "first_text", "success"));
        pending.textClosed = true;
        return;
      }
    }
    // 终态到达仍没有正文时，按是否已有首输出来决定 no_text 还是 excluded。
    // terminal 为 completed 却没有 outputAt，说明输出路径不受观测支持，记 unsupported 而非 failed。
    // 这里只补一次收口，重复终态帧会被 textClosed 挡住。
    if (facts.terminal && !pending.textClosed) {
      this.emit(
        this.record(
          pending,
          pending.first ? "no_text" : "excluded",
          pending.first
            ? "success"
            : facts.terminal === "completed"
              ? "unsupported"
              : facts.terminal,
        ),
      );
      pending.closed = true;
      pending.textClosed = true;
    }
  }
  // [失败路径] 已收口观察再被排除，只能补一条 no_text 收尾，不能改写已成立的首输出。
  // 未收口时才发 excluded 或 no_text 主记录，并把 closed 与 textClosed 一起置位。
  // 先结束用户确认区间再出记录，否则确认等待时长会把排除样本的 userWaitMs 算重。
  exclude(context: LocalTtftContext, outcome: LocalTtftRecord["outcome"]): void {
    const pending = this.pending.get(context.observationId);
    if (!pending) return;
    if (pending.closed) {
      if (pending.first && !pending.textClosed) {
        this.emit(this.record(pending, "no_text", outcome));
        pending.textClosed = true;
      }
      return;
    }
    if (pending.confirmationStart !== undefined) this.confirmation(context, false);
    this.emit(this.record(pending, pending.first ? "no_text" : "excluded", outcome));
    pending.closed = true;
    pending.outcome = outcome;
    pending.textClosed = true;
  }
  // [契约] stale 确认被拒后没有 accepted input，必须解绑 commandId 与 facts。
  // 保留旧绑定会让下一次点击沿用被拒 attempt 的阶段时间。
  confirmationRetry(context: LocalTtftContext): void {
    const pending = this.pending.get(context.observationId);
    if (!pending || pending.closed) return;
    // stale 确认拒绝没有 accepted input；下一次命令仍沿首次点击，但不能绑定已拒绝命令。
    pending.commandId = undefined;
    pending.facts = undefined;
  }
  confirmation(context: LocalTtftContext, waiting: boolean): void {
    const pending = this.pending.get(context.observationId);
    if (!pending) return;
    // [事务] 用户确认等待单独成区间，只在 waiting 首次为真时记起点。
    // 结束时间取本次调用时钟并成对闭合，重复 waiting 不会重置起点，等待时长不会被截短。
    if (waiting) pending.confirmationStart ??= this.now();
    else if (pending.confirmationStart !== undefined) {
      if (pending.confirmations.length < 32)
        pending.confirmations.push({
          id: `confirmation:${pending.confirmations.length}`,
          stage: "user_confirmation",
          start: pending.confirmationStart,
          end: this.now(),
          source: "renderer",
          outcome: "completed",
        });
      pending.confirmationStart = undefined;
    }
  }
  background(): void {
    this.visibility(false);
  }
  foreground(): void {
    this.visibility(true);
  }
  // [并发] 只对未收口且状态确实变化的观察记一次可见性切换并出 checkpoint。
  // background_returned 表示曾离开再回来，不能简单覆盖成 foreground。
  // 切换记录上限 32，防止长时间挂起的观察撑爆数组；丢的是明细，不影响主样本。
  private visibility(foreground: boolean): void {
    this.isForeground = foreground;
    for (const pending of this.pending.values()) {
      if (pending.closed) continue;
      if ((pending.visibility !== "background") === foreground) continue;
      pending.visibility = foreground ? "background_returned" : "background";
      if (pending.visibilityChanges.length < 32)
        pending.visibilityChanges.push({ at: this.now(), foreground });
      this.emit(this.record(pending, "checkpoint", "unclosed"));
    }
  }
  // [资源] 两次采样间隔超过 5 秒，基本只能来自休眠或墙钟跳变。
  // 把所有在途观察标为 clockInvalid，让后续记录降级为不可信，而不是丢弃已采到的同进程阶段。
  sampleClock(): void {
    const now = this.now();
    if (this.lastClockSample !== undefined && now - this.lastClockSample > 5000)
      for (const pending of this.pending.values()) if (!pending.closed) pending.clockInvalid = true;
    this.lastClockSample = now;
  }
  // [失败路径] 指定 workspace 时只中断该工作区，未指定才清空全部观察与校准缓存。
  // 已经收口的首输出不会被反转，exclude 内部会转成一条 no_text 收尾。
  interrupt(workspace?: string): void {
    for (const pending of this.pending.values())
      if (workspace === undefined || pending.workspace === workspace)
        this.exclude(pending.context, "interrupted");
    if (workspace === undefined) this.clocks.clear();
    else this.clocks.delete(workspace);
  }
  // [资源] TTL 只看观察起点，超期的未收口观察按 unclosed 收口后立即从表里删除。
  // 已收口但过期的条目直接删除，不做二次记录，避免同一观察被重复导出。
  expire(): void {
    for (const pending of this.pending.values())
      if (this.now() - pending.start > LOCAL_TTFT_TTL_MS) {
        if (!pending.closed) this.exclude(pending.context, "unclosed");
        this.pending.delete(pending.context.observationId);
      }
  }
  private record(
    pending: Pending,
    kind: LocalTtftRecord["kind"],
    outcome: LocalTtftRecord["outcome"],
  ): LocalTtftRecord {
    return buildLocalTtftRecord(
      pending,
      kind,
      outcome,
      this.now(),
      this.wallNow(),
      this.clocks.get(pending.workspace),
    );
  }
}
let observer: LocalTtftObserver | undefined;
export function setLocalTtftObserver(value: LocalTtftObserver | undefined): void {
  observer = value;
}
export function getLocalTtftObserver(): LocalTtftObserver | undefined {
  return observer;
}
