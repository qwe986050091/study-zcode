// 背景任务控制面的纯函数归一化层：把 runtime/事件中形状不稳定的原始记录转成
// ZCodeBackgroundTaskControlItem，供上层展示耗时并决定是否提供取消入口。本文件不发起
// 取消、不杀进程、不持久化任务，也不判断任务是否真实存活——存活事实只来自上游状态字段。
// 不负责：协议版本协商、任务调度、UI 文案、浮层排序偏好与多帧事件合并；
// 每次调用都是无状态全量重算，调用方需用结果整体替换旧列表，不能增量追加。
// 所有字段读取都容忍 camelCase 与 snake_case，只取第一个非空值，顺序即优先级。
//
// INV-01 断言：只有 running 视为活跃 —— 守住它的位置：ACTIVE_BACKGROUND_TASK_CONTROL_STATUSES —— 改错故障：排队任务提前进入浮层，或运行中任务从浮层消失
// INV-02 断言：jobId 必须优先取 taskId 系字段 —— 守住它的位置：readJobId 的键序 —— 改错故障：取消请求带 call_*，后端返回 background_task_not_found
// INV-03 断言：无显式 id 时的回退 id 只由 pid、startedAt、展示命令决定 —— 守住它的位置：readJobId 模板 —— 改错故障：轮询生成新 id，同一任务重复堆叠
// INV-04 断言：同一 jobId 后写覆盖先写且保持首次出现顺序 —— 守住它的位置：jobsById 这个 Map —— 改错故障：旧状态覆盖新状态，或列表顺序每帧抖动
// INV-05 断言：无法识别的状态一律按 running 处理 —— 守住它的位置：normalizeStatus 末尾默认分支 —— 改错故障：新状态文案让任务从浮层消失且无法取消
// INV-06 断言：缺 taskKind 或缺展示命令的记录必须丢弃 —— 守住它的位置：parse 循环里的两个 continue —— 改错故障：出现无标题幽灵条目或不可取消的假任务
// INV-07 断言：startedAt 只按毫秒时间戳解释 —— 守住它的位置：readInstantMs 的数字分支 —— 改错故障：上游给秒级值时时长显示成数万小时
// INV-08 断言：耗时取 now-startedAt 与 elapsedMs 的较大值且不回退 —— 守住它的位置：getZCodeBackgroundTaskControlItemElapsedMs —— 改错故障：时钟回拨时计时归零或倒退
// INV-09 断言：kind 与 status 比较前必须统一过 normalizeToken —— 守住它的位置：normalizeToken —— 改错故障：local-agent 这类连字符写法被判为未知而整条丢弃
// INV-10 断言：可选字段缺省时不写入对象键 —— 守住它的位置：parse 中的条件展开 —— 改错故障：下游按键是否存在判断 cancellable，误判为可取消
// INV-11 断言：agent 的展示命令优先 description，bash 优先 command —— 守住它的位置：readDisplayCommand 分支 —— 改错故障：agent 行显示成工具名 task，多个子任务无法区分
// INV-12 断言：raw 保留上游原始引用不深拷贝 —— 守住它的位置：job.raw 赋值 —— 改错故障：上游后续改写对象时 raw 与展示字段不一致，或内存被放大
// INV-13 断言：cancellable 的三态不可折叠为 false —— 守住它的位置：readBooleanField 与条件展开 —— 改错故障：运行中任务失去取消按钮，或缺省被当成明确不可取消
// INV-14 断言：kind 解析优先级固定为显式任务类别、工具名、背景类型 —— 守住它的位置：resolveTaskKind —— 改错故障：旧事件被归到错误类别，同类任务分进不同 UI 分组
// INV-15 断言：timed_out 与 timeout 归 killed 而不是 failed —— 守住它的位置：normalizeStatus 终止类分支 —— 改错故障：超时任务显示为失败并触发错误态样式
// INV-16 断言：重复 jobId 不得合并两条不同任务 —— 守住它的位置：回退 id 组成里包含展示命令 —— 改错故障：并发同名命令的多个任务互相覆盖，只剩最后一条
// INV-17 断言：状态为未知时调用方看到 running —— 守住它的位置：normalizeStatus 的兜底返回值 —— 改错故障：统计口径把脏数据算作活跃，浮层常驻无法清理
// INV-18 断言：命令数组只做空格拼接用于展示 —— 守住它的位置：commandFromValue 的数组分支 —— 改错故障：含空格的参数被展示层误读为可重新执行的原始命令行
// INV-19 断言：可见列表用大于等于阈值筛选并按耗时降序 —— 守住它的位置：collectVisible 的 filter 与 sort —— 改错故障：临界值任务闪现闪烁，或最久任务被排到末尾
//
// 阅读顺序：先看 kind 与 status 的归一化，再看 readJobId 的键序与回退模板，最后看 parse 的
// 丢弃条件与去重；任何顺手放宽都可能让取消入口指向错误任务，或让列表在帧之间跳变。
export type ZCodeBackgroundTaskControlStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "killed"
  | "lost";

// [契约] jobId 是取消入口的唯一句柄，必须由 readJobId 产出，不在这里拼装；
// 其余字段全部可选，缺失与空字符串语义不同，下游不要用 falsy 判断替代存在性判断。
// raw 故意保留上游原对象，调用方只读，禁止在 UI 层写回或就地补字段。
export interface ZCodeBackgroundTaskControlItem {
  jobId: string;
  toolCallId?: string;
  command: string;
  taskKind: "agent" | "bash";
  cancellable?: boolean;
  title?: string;
  status: ZCodeBackgroundTaskControlStatus;
  startedAt?: number;
  elapsedMs?: number;
  pid?: number;
  stdoutTail?: string;
  stderrTail?: string;
  outputTail?: string;
  raw?: unknown;
}

// [契约] 活跃集合是浮层与取消入口的唯一开关，当前口径只有 running；
// pending 虽已入队但不可取消，不能顺手并入，否则排队任务会以零耗时抢占浮层。
// 也不要把 completed 或 failed 加回来做「刚结束仍可看」，那会把历史任务变成可操作项。
// 若未来新增 queued 之类状态，应先改 normalizeStatus 的映射，而不是往这里加成员。
// 该集合被模块级复用，调用方不得 clear 或 add，否则同进程内所有窗口的判定一起被改。
const ACTIVE_BACKGROUND_TASK_CONTROL_STATUSES = new Set<ZCodeBackgroundTaskControlStatus>([
  "running",
]);

// [契约] 只接受非数组的普通对象；数组与 null 都不算记录，避免把列表误当字段容器。
// 不使用 instanceof Object，跨 realm 或 structuredClone 出来的对象同样要能通过。
// 返回类型断言只影响编译期，运行期不会补字段，调用方仍需逐字段校验。
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// [契约] 键序即优先级：camelCase 在前、snake_case 在后，取到第一个非空值就返回。
// 空串与纯空白视同缺失，继续尝试下一个别名；不要把 trim 结果写回原记录。
// 非字符串（数字零、布尔）一律跳过，避免 0 被当成有效 id 或有效命令。
// [权衡] 不做类型宽松转换：`123` 可作为 id，但对象与数组不行，防止协议漂移静默通过。
function readStringField(value: unknown, keys: readonly string[]): string | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

// [契约] 数字字符串会被解析为数字，供上游把 pid 与耗时时序化成文本的链路使用。
// Number.isFinite 拒绝 NaN 与 Infinity，也避免 abc 解析成 NaN 后污染耗时计算。
// 十六进制与带单位字符串不被接受：Number 会把 0x10 当 16，不属于本函数承诺的格式。
// [失败路径] 解析失败不抛错，继续下一个别名，全部失败返回 undefined 交由调用方兜底。
function readNumberField(value: unknown, keys: readonly string[]): number | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      const parsed = Number(candidate);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

// [契约] 布尔三态：true、false、undefined，调用方必须区分 undefined 与 false。
// 字符串仅认 true/yes/1 与 false/no/0，大小写与空白不敏感，其余一律视为未知。
// 不把 on/off 纳入：语义更接近开关状态，容易与协议里的其他字段混淆。
function readBooleanField(value: unknown, keys: readonly string[]): boolean | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "boolean") {
      return candidate;
    }
    if (typeof candidate === "string") {
      const normalized = candidate.trim().toLowerCase();
      if (normalized === "true" || normalized === "yes" || normalized === "1") {
        return true;
      }
      if (normalized === "false" || normalized === "no" || normalized === "0") {
        return false;
      }
    }
  }
  return undefined;
}

// [契约] 先按数字读，失败再按字符串日期解析，两者都按毫秒时间戳返回。
// 数字分支直接返回，不做秒到毫秒的猜测放大；上游若给秒级值，症状是耗时异常大而不是报错。
// Date.parse 对无时区字符串按本地时区解释，跨时区机器可能差数小时，仅作最后兜底。
// 返回 undefined 表示没有可信起点，调用方应退回 elapsedMs，而不是用 now 顶替。
function readInstantMs(value: unknown, keys: readonly string[]): number | undefined {
  const numberValue = readNumberField(value, keys);
  if (numberValue !== undefined) {
    return numberValue;
  }
  if (!isPlainRecord(value)) {
    return undefined;
  }
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate !== "string" || candidate.trim().length === 0) {
      continue;
    }
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function commandFromValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0);
    return parts.length > 0 ? parts.join(" ") : undefined;
  }
  return undefined;
}

// [契约] 命令来源按 command、cmd、script 顺序回退，嵌套在 input 时再走同一套别名。
// 顶层命中即返回，不再看 input；两层都取不到才返回 undefined，由 parse 丢弃该条记录。
// [权衡] 不递归更深的 payload：协议只保证一层 input，深挖会让错误结构意外变成可展示命令。
// 命令只用于展示与兜底 id，绝不在这里做执行、转义或 shell 拼接。
function readCommand(record: Record<string, unknown>): string | undefined {
  const direct =
    commandFromValue(record.command) ??
    commandFromValue(record.cmd) ??
    commandFromValue(record.script);
  if (direct) {
    return direct;
  }
  const input = isPlainRecord(record.input) ? record.input : null;
  return input
    ? (commandFromValue(input.command) ??
        commandFromValue(input.cmd) ??
        commandFromValue(input.script))
    : undefined;
}

// [契约] 归一化只做三件事：trim、转小写、非字母数字压成单个下划线。
// 因此 local-agent、Local_Agent、local agent 都折叠为 local_agent，别名表才对得上。
// 连续符号会被压成一个下划线，undefined 经兜底变成空串而不是字符串 undefined。
// [失败路径] 入参为 undefined 时返回空串，调用方无需判空，但空串不会命中任何别名。
function normalizeToken(value: string | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "_") ?? ""
  );
}

type BackgroundTaskControlKind = ZCodeBackgroundTaskControlItem["taskKind"];

// [契约] 别名表是兼容旧事件的白名单，新增别名只会放宽识别，不会改变已有归类。
// agent 与 bash 两组互斥，先判 agent；两个都写错的 token 返回 undefined 并被 parse 丢弃。
// 不要把 task 加进这里：只有工具名位置的 task 才代表 agent，混入会误判 bash 任务。
function taskKindFromToken(token: string): BackgroundTaskControlKind | undefined {
  if (
    token === "agent" ||
    token === "local_agent" ||
    token === "subagent" ||
    token === "background_agent"
  ) {
    return "agent";
  }
  if (
    token === "bash" ||
    token === "local_bash" ||
    token === "shell" ||
    token === "terminal" ||
    token === "background_bash" ||
    token === "background_shell"
  ) {
    return "bash";
  }
  return undefined;
}

function readExplicitTaskKind(
  record: Record<string, unknown>,
): BackgroundTaskControlKind | undefined {
  const token = normalizeToken(
    readStringField(record, ["taskKind", "task_kind", "taskType", "task_type"]),
  );
  return taskKindFromToken(token);
}

function readToolTaskKind(record: Record<string, unknown>): BackgroundTaskControlKind | undefined {
  const token = normalizeToken(readStringField(record, ["toolName", "tool_name"]));
  if (token === "task") {
    return "agent";
  }
  return taskKindFromToken(token);
}

function readBackgroundTypeTaskKind(
  record: Record<string, unknown>,
): BackgroundTaskControlKind | undefined {
  const token = normalizeToken(readStringField(record, ["type", "kind", "category"]));
  if (
    token === "local_agent" ||
    token === "subagent" ||
    token === "background_agent" ||
    token === "agent_background"
  ) {
    return "agent";
  }
  if (
    token === "local_bash" ||
    token === "background_bash" ||
    token === "background_shell" ||
    token === "bash_background" ||
    token === "shell_background"
  ) {
    return "bash";
  }
  return undefined;
}

// [契约] 优先级固定为显式任务类别、工具名、背景类型字段，前者命中即短路。
// 三处都缺失时返回 undefined，parse 会整条跳过，而不是猜一个默认类别。
// 调换顺序会让旧记录的工具名覆盖新协议显式字段，造成同类任务在 UI 分到不同分组。
function resolveTaskKind(record: Record<string, unknown>): BackgroundTaskControlKind | undefined {
  return (
    readExplicitTaskKind(record) ?? readToolTaskKind(record) ?? readBackgroundTypeTaskKind(record)
  );
}

/**
 * 旧 background task 事件的唯一 kind 兼容入口。
 * 新协议应直接携带 taskKind；只有历史记录缺字段时才从工具名/类型别名恢复。
 */
export function resolveZCodeBackgroundTaskControlKind(
  value: unknown,
): BackgroundTaskControlKind | undefined {
  return isPlainRecord(value) ? resolveTaskKind(value) : undefined;
}

// [契约] agent 任务优先用 description 等可读名，bash 任务优先用真实命令行。
// 顺序反过来时，agent 行会显示工具名 task，多个并行子任务在浮层里无法区分。
// [契约] 该返回值同时是无显式 id 时兜底 jobId 的组成部分，改优先级会让旧记录换 id、列表重复。
// 两类都保留另一侧作为兜底：agent 无描述时退回命令，bash 无命令时退回描述。
function readDisplayCommand(
  record: Record<string, unknown>,
  taskKind: BackgroundTaskControlKind,
): string | undefined {
  if (taskKind === "agent") {
    return (
      readStringField(record, ["description", "summary", "title", "label"]) ?? readCommand(record)
    );
  }
  return (
    readCommand(record) ?? readStringField(record, ["description", "summary", "title", "label"])
  );
}

// [契约] 状态别名按语义分组：排队类归 pending、进行类归 running、成功类归 completed、
// 错误类归 failed、终止类归 killed；timed_out 与 timeout 归 killed 而不是 failed。
// [权衡] 未知或缺失状态默认 running：宁可多给一个可取消入口，也不让任务从浮层消失。
// 这个默认值让统计口径把脏数据算作活跃，调用方需要自己用原始 raw 做二次甄别。
// 修改分组前先确认 UI 的图标与取消可用性只依赖这六个值，不要新增第七种状态。
function normalizeStatus(value: string | undefined): ZCodeBackgroundTaskControlStatus {
  const normalized = normalizeToken(value);
  if (
    normalized === "queued" ||
    normalized === "scheduled" ||
    normalized === "starting" ||
    normalized === "pending"
  ) {
    return "pending";
  }
  if (
    normalized === "running" ||
    normalized === "in_progress" ||
    normalized === "started" ||
    normalized === "active"
  ) {
    return "running";
  }
  if (
    normalized === "completed" ||
    normalized === "complete" ||
    normalized === "success" ||
    normalized === "succeeded" ||
    normalized === "done"
  ) {
    return "completed";
  }
  if (
    normalized === "failed" ||
    normalized === "failure" ||
    normalized === "error" ||
    normalized === "spawn_error"
  ) {
    return "failed";
  }
  if (
    normalized === "killed" ||
    normalized === "cancelled" ||
    normalized === "canceled" ||
    normalized === "stopped" ||
    normalized === "terminated" ||
    normalized === "timed_out" ||
    normalized === "timeout"
  ) {
    return "killed";
  }
  if (normalized === "lost" || normalized === "unknown") {
    return "lost";
  }
  return "running";
}

// [契约] 显式 id 的键序是本文件最敏感的部分：taskId 系必须排在 toolCallId 之前。
// 若落到 toolCallId，取消请求会带 call_ 前缀，后端按 runtime task 查找失败，
// 用户看到的是 background_task_not_found，而任务仍在后台跑，这正是文件内既有注释所警告的。
// 全部显式键缺失时，用 pid、startedAt、展示命令拼出确定性 id，保证同一任务多次轮询同 id；
// [失败路径] 不要把 Date.now 或随机数放进兜底 id，否则每次解析都生成一个新任务。
function readJobId(record: Record<string, unknown>, command: string): string {
  const explicitId = readStringField(record, [
    // ZCode Protocol 后台任务取消入口按 taskId 查找 runtime task 记录；
    // 若这里落到 toolCallId，UI 会发送 call_*，后端只能返回 background_task_not_found。
    "taskId",
    "task_id",
    "backgroundTaskId",
    "background_task_id",
    "jobId",
    "job_id",
    "backgroundJobId",
    "background_job_id",
    "id",
  ]);
  if (explicitId) {
    return explicitId;
  }
  const startedAt = readInstantMs(record, ["startedAt", "started_at", "startTime", "start_time"]);
  const pid = readNumberField(record, ["pid", "processId", "process_id"]);
  return `background-task:${pid ?? "no-pid"}:${startedAt ?? "no-start"}:${command}`;
}

// [契约] 入参必须是数组，否则返回空数组而不是抛错；非对象元素逐个跳过，不中断整批。
// 单条记录缺 kind 或缺展示命令即丢弃，宁可少一条也不生成不可取消的幽灵任务。
// 输出按 jobId 去重，同一 id 后出现的记录覆盖先出现的字段，Map 保留首次插入位置。
// 本函数不修改入参、不做排序与阈值过滤，可见性由 collectVisible 统一决定。
export function parseZCodeBackgroundTaskControlItems(
  value: unknown,
): ZCodeBackgroundTaskControlItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  // [并发] 这里只做单次同步解析，不持有跨调用状态；并发调用各自建 Map，互不影响。
  // 去重键是 jobId 字符串，大小写与空白已由 readStringField 规整，不会出现仅空格不同的重复项。
  // 不要换成以 toolCallId 为键：取消链路按 taskId 找任务，键错会导致覆盖或漏项。
  const jobsById = new Map<string, ZCodeBackgroundTaskControlItem>();
  for (const item of value) {
    if (!isPlainRecord(item)) {
      continue;
    }
    const taskKind = resolveZCodeBackgroundTaskControlKind(item);
    // [失败路径] 无法判定 agent 或 bash 的记录直接丢弃：没有 kind 就决定不了取命令还是描述，
    // 也无法在 UI 上分组；猜默认值会把 bash 输出错挂到 agent 卡片上。
    // 丢弃是静默的，排查时请用上游原始事件对照，而不是在这里加日志刷屏。
    if (!taskKind) {
      continue;
    }
    const command = readDisplayCommand(item, taskKind);
    if (!command) {
      continue;
    }
    const jobId = readJobId(item, command);
    const toolCallId = readStringField(item, ["toolCallId", "tool_call_id"]);
    const startedAt = readInstantMs(item, ["startedAt", "started_at", "startTime", "start_time"]);
    const elapsedMs = readNumberField(item, [
      "elapsedMs",
      "elapsed_ms",
      "durationMs",
      "duration_ms",
    ]);
    const pid = readNumberField(item, ["pid", "processId", "process_id"]);
    const title = readStringField(item, ["title", "name", "label", "description"]);
    const status = normalizeStatus(readStringField(item, ["status", "state", "phase"]));
    const cancellable = readBooleanField(item, ["cancellable"]);
    const stdoutTail = readStringField(item, ["stdoutTail", "stdout_tail"]);
    const stderrTail = readStringField(item, ["stderrTail", "stderr_tail"]);
    const outputTail = readStringField(item, ["outputTail", "output_tail"]);
    // [契约] 条件展开保证缺省字段不写键：undefined 与「没有这个键」对下游是不同的。
    // cancellable 尤其如此，false 表示明确不可取消，缺失表示上游未表态，两者不能合并。
    // 不要改成统一写 undefined：结构化克隆、深比较和部分序列化都会因此产生差异。
    const job: ZCodeBackgroundTaskControlItem = {
      jobId,
      ...(toolCallId ? { toolCallId } : {}),
      command,
      taskKind,
      ...(cancellable !== undefined ? { cancellable } : {}),
      ...(title ? { title } : {}),
      status,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
      ...(pid !== undefined ? { pid } : {}),
      ...(stdoutTail ? { stdoutTail } : {}),
      ...(stderrTail ? { stderrTail } : {}),
      ...(outputTail ? { outputTail } : {}),
      raw: item,
    };
    // [并发] Map 后写覆盖先写是刻意行为：同一任务的新帧应携带更新后的状态与耗时。
    // 覆盖不会改变键的插入顺序，所以列表顺序仍按任务首次出现，避免每帧重排造成闪烁。
    // 重复解析同一帧没有额外副作用，只是同值覆盖，因此 parse 可以安全重放。
    // 若上游把两条不同任务错误地给出同一 jobId，这里只能保留后者，需靠回退 id 的组成避免碰撞。
    jobsById.set(job.jobId, job);
  }
  return Array.from(jobsById.values());
}

// [契约] 活跃判定只查模块级集合，不读 elapsedMs，也不看 cancellable。
// 因此 pending 任务即使长时间排队也不会出现在浮层，running 但不可取消的任务仍然可见。
// 调用方不要在这里加时间条件（如超过 N 分钟才算活跃），那会让阈值逻辑重复且口径分裂。
export function isActiveZCodeBackgroundTaskControlItem(
  job: ZCodeBackgroundTaskControlItem,
): boolean {
  return ACTIVE_BACKGROUND_TASK_CONTROL_STATUSES.has(job.status);
}

// [契约] 耗时取「按 startedAt 推算」与「上游 elapsedMs」的较大值，保证不回退。
// now 可注入，测试与多窗口共享同一时刻时避免各自 Date.now 造成数值抖动。
// startedAt 在未来（时钟回拨或时区错）时 Math.max 把增量压到 0，再与 elapsedMs 取大。
// 不要改成两者相加：上游 elapsedMs 已经是累计值，相加会双倍计时。
export function getZCodeBackgroundTaskControlItemElapsedMs(
  job: ZCodeBackgroundTaskControlItem,
  now = Date.now(),
): number {
  const elapsedFromStart =
    job.startedAt !== undefined ? Math.max(0, now - job.startedAt) : undefined;
  return Math.max(elapsedFromStart ?? 0, job.elapsedMs ?? 0);
}

// [契约] 只有活跃且耗时达到阈值的任务可见，阈值比较用大于等于，边界值必须显示。
// 排序按耗时降序，用于让最久运行的任务占据首位；耗时相同依赖输入顺序，属稳定排序结果。
// [权衡] 这里重新计算 elapsedMs 并覆盖原字段，返回值是新的浅拷贝，不回写输入数组。
// 不要把过滤阈值下推到 parse：parse 是无时间语义的纯归一化，加时间会让缓存失效。
export function collectVisibleZCodeBackgroundTaskControlItems(
  jobs: readonly ZCodeBackgroundTaskControlItem[],
  now = Date.now(),
  thresholdMs = 30_000,
): Array<ZCodeBackgroundTaskControlItem & { elapsedMs: number }> {
  return jobs
    .filter(isActiveZCodeBackgroundTaskControlItem)
    .map((job) => ({
      ...job,
      elapsedMs: getZCodeBackgroundTaskControlItemElapsedMs(job, now),
    }))
    .filter((job) => job.elapsedMs >= thresholdMs)
    .sort((left, right) => right.elapsedMs - left.elapsedMs);
}
