// toolResultDisplay.ts —— 工具结果展示投影的唯一解析入口：把 IPC 收到的未知 payload 收敛成 ToolResultDisplay 联合类型，其余一概不认
// INV-01 解析对任意 unknown 输入都不抛异常，非记录与非法字段一律折成 undefined；守住位置：readToolResultDisplay 入口与全部分支；改错故障：一条脏载荷打断整段消息渲染，用户看到整条会话报错或白屏
// INV-02 结构化判定只认非空且非数组的对象，null 与数组都不算记录；守住位置：isRecord；改错故障：数组进入取值路径后所有字段都是 undefined，整条结果被当成未知类型静默丢弃
// INV-03 候选来源按 result、raw、metadata、rawOutput、output 的固定顺序排列，首个合法展示胜出且不再比较后续；守住位置：candidates 数组与循环内的早返回；改错故障：顺序被改动后旧路径的过期 display 覆盖新字段，用户看到上一轮工具的结果
// INV-04 纯空白字符串算非法而不是缺失，整条展示因此被拒；守住位置：readOptionalString 的 trim 判空；改错故障：空白被当成有效内容放行，卡片留出一块没有文字的空白区且不给兜底文案
// INV-05 字段缺省与字段非法严格区分：缺省允许被省略，非法让整条展示作废；守住位置：各 kind 分支对 undefined 与 null 的分别判定；改错故障：数字或对象型字段被当成缺失后静默丢字段，界面显示残缺内容且无任何提示
// INV-06 合法字符串按原样输出，不做 trim 归一化，只借 trim 判空；守住位置：readOptionalString 的返回分支；改错故障：命令与输出的缩进、空行被抹平，多行代码块排版错乱，用户复制到错误内容
// INV-07 task_output 的 output 超过 2000 字符即整条拒绝，展示层不做静默截断；守住位置：output 长度判定；改错故障：超长输出整块进入渲染树，长消息列表滚动卡顿，或用户误以为任务真只输出了这么多
// INV-08 task_output 的 taskStatus 上限 64 字符，它是状态短名而不是正文；守住位置：taskStatus 长度判定；改错故障：被拼接过的长状态串撑破任务卡标题区，挤掉后面的时间与操作按钮
// INV-09 task_output 的 truncated 只接受字面 true，false 与缺失等价且视为畸形；守住位置：truncated 的严格比较；改错故障：假截断让消费侧弹出续读入口，用户点了却读不到更多内容
// INV-10 cua 的 legacy input 只参与合法性校验，绝不写进输出；守住位置：legacyInput 的 null 判定与返回对象；改错故障：旧字段被当成正文渲染，用户在结果卡里看到与内容重复的原始参数
// INV-11 cua 的 schemaVersion 必须严格等于 1，不接受字符串形式与更高版本；守住位置：cua 分支的版本判定；改错故障：新版本载荷按旧字段表解读，字段含义漂移后展示错位甚至渲染出错内容
// INV-12 cua 的 media 逐项过滤，单项缺 mimeType 只丢该项，不牵连其余截图与文字；守住位置：media 的 flatMap 过滤；改错故障：一张坏图让整组截图消失，用户看不到本已成功的操作证据
// INV-13 targetApp 的 iconLocators 最多 3 项且必须全有或全无，任一坏项即整个 targetApp 判畸形；守住位置：数量上限与过滤前后长度比对；改错故障：半套图标被渲染，点击定位到错误应用或根本点不动
// INV-14 targetApp 的 displayName 上限 512 字符；守住位置：displayName 长度判定；改错故障：超长应用名撑破工具栏，把相邻的操作按钮挤到可视区外
// INV-15 展示对象的可选字段一律条件展开，不写 undefined 占位；守住位置：各 kind 的返回对象；改错故障：值为 undefined 的键在序列化时消失，浅比较层把字段消失误判成字段变化并重复渲染
// INV-16 未知 kind 不构造兜底展示对象，直接返回 undefined 交给上层兜底；守住位置：查表分支与函数末尾；改错故障：未知工具结果被画成空卡片，用户既看不到内容也没有「暂不支持」的提示
// INV-17 只有表内登记的 kind 才允许进入 schema 解析，查表键必须来自协议枚举；守住位置：kind 查表分支；改错故障：任意字符串 kind 命中原型链上的内建函数，返回值不是展示对象却为真值，上层拿到脏数据后渲染崩溃
// INV-18 整个模块是纯函数：不读时间、随机、全局状态与 DOM，同输入必得同输出；守住位置：全文件；改错故障：虚拟列表复用到同一行时重算结果不一致，滚动过程中内容闪变或错行
// INV-19 undefined 是唯一的降级信号，解析失败既不抛错也不返回空对象；守住位置：全部早返回与末尾返回；改错故障：调用方无法区分「没有展示」与「展示为空」，兜底卡片永远不出现
import {
  toolCallEvalWorkflowSnippetDisplaySchema,
  toolCallGetWorkflowRunDisplaySchema,
  toolCallListModelsDisplaySchema,
  toolCallListWorkflowRunsDisplaySchema,
  toolCallResumeWorkflowRunDisplaySchema,
  toolCallSavedWorkflowListDisplaySchema,
  type ToolCallEvalWorkflowSnippetDisplay,
  type ToolCallGetWorkflowRunDisplay,
  type ToolCallListModelsDisplay,
  type ToolCallListWorkflowRunsDisplay,
  type ToolCallResumeWorkflowRunDisplay,
  type ToolCallSavedWorkflowListDisplay,
} from "@zcode/shared/zcode-protocol-v4";

export interface LocalAgentMessageToolResultDisplay {
  kind: "local_agent_message";
  status: "success" | "failed";
  error?: string;
  message?: string;
}

export interface TaskStopToolResultDisplay {
  kind: "task_stop";
  taskId: string;
  taskType: string;
  command?: string;
  message: string;
  truncated?: boolean;
}

export interface TaskOutputToolResultDisplay {
  kind: "task_output";
  retrievalStatus: "success" | "not_ready" | "timeout";
  taskStatus?: string;
  output?: string;
  truncated?: true;
}

export interface RespondToCoordinatorToolResultDisplay {
  kind: "respond_to_coordinator";
  status: "success" | "failed";
}

export interface CuaToolResultDisplay {
  kind: "cua";
  schemaVersion: 1;
  toolName: string;
  status: "success" | "failed";
  structuredContent?: string;
  text?: string;
  errorCode?: string;
  suggestedAction?: string;
  media?: Array<{ mimeType: string; data?: string; artifactUri?: string }>;
  truncated?: boolean;
  targetApp?: {
    schemaVersion: 1;
    displayName?: string;
    iconLocators: Array<
      | { kind: "darwin-bundle-id"; value: string }
      | { kind: "windows-executable-path"; value: string }
      | { kind: "windows-aumid"; value: string }
    >;
  };
}

export type ToolResultDisplay =
  | LocalAgentMessageToolResultDisplay
  | TaskStopToolResultDisplay
  | TaskOutputToolResultDisplay
  | RespondToCoordinatorToolResultDisplay
  | CuaToolResultDisplay
  | ToolCallGetWorkflowRunDisplay
  | ToolCallListWorkflowRunsDisplay
  | ToolCallEvalWorkflowSnippetDisplay
  | ToolCallSavedWorkflowListDisplay
  | ToolCallListModelsDisplay
  | ToolCallResumeWorkflowRunDisplay;

// 这里是全文件唯一的类型收窄入口，之后所有按下标取值都以它为前提，收窄成立才谈得上索引签名的意义
// [失败路径] 排除 null 不是冗余：typeof null 同样是 object，漏掉这一项会让空载荷进入取值路径并在字段判定处抛错
// 数组一并排除：数组也满足 typeof object，放行后 value.kind 恒为空，整条结果会被当成未知类型静默丢弃
// 不检查原型链：payload 来自 IPC 序列化，只带自有属性，跨 realm 的 instanceof 判定在这里反而不可靠
// [权衡] 不引入 schema 库做这一层：该函数对每条消息都要调用，只做对象判定，多余解析会拖慢消息列表的首帧
// 返回布尔而不抛错：调用方用早返回的 undefined 表达「不是展示对象」，异常会把整段消息渲染打断
// 收窄目标写成未知值的记录而非具体类型：本文件不掌握各工具的字段表，具体字段交给各 kind 分支逐项验证
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 工作流 display kind → 解析函数的查表（新增 kind 只改这一处）。每个条目用 shared 侧的
 * strict schema safeParse，输出类型即各自 schema 的推断类型——成员输出不是 ToolResultDisplay
 * 的 union 成员时这里直接编译失败，而不是靠运行时兜住。
 */
const WORKFLOW_DISPLAY_PARSERS_BY_KIND: Record<
  string,
  (value: Record<string, unknown>) => ToolResultDisplay | undefined
> = {
  get_workflow_run: (value) => parseWorkflowDisplay(toolCallGetWorkflowRunDisplaySchema, value),
  list_workflow_runs: (value) =>
    parseWorkflowDisplay(toolCallListWorkflowRunsDisplaySchema, value),
  eval_workflow_snippet: (value) =>
    parseWorkflowDisplay(toolCallEvalWorkflowSnippetDisplaySchema, value),
  saved_workflow_list: (value) =>
    parseWorkflowDisplay(toolCallSavedWorkflowListDisplaySchema, value),
  list_models: (value) => parseWorkflowDisplay(toolCallListModelsDisplaySchema, value),
  resume_workflow_run: (value) =>
    parseWorkflowDisplay(toolCallResumeWorkflowRunDisplaySchema, value),
};

function parseWorkflowDisplay<T extends ToolResultDisplay>(
  schema: { safeParse: (data: unknown) => { success: true; data: T } | { success: false } },
  value: Record<string, unknown>,
): ToolResultDisplay | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

// 三态返回是核心约定：缺省、非法、合法字符串，调用方据此区分「没给」与「给错了」
// 缺省允许被省略出展示对象，非法则让整条展示作废，宁可不展示也不展示半截数据
// 非法包含非字符串与纯空白：纯空白在界面上与空串无法区分，放行后卡片会留出一块没有文字的空白
// [权衡] 返回原始 candidate 而非 trim 过的副本：命令与输出里的缩进、空行就是信息本体，归一化会毁掉排版
// trim 只用于判空，不参与输出，判空与取值分离是这里唯一的职责边界
// [权衡] 取值不做自有属性判定：payload 经序列化后只带自有属性，多一次分支只增加开销
// 空串与纯空白统一折成非法值，与「字段缺失」严格区分，两者在消费侧的降级路径不同
// 键名以字符串传入而非写死属性访问：各 kind 分支共用同一份判空规则，改规则只需改这一处
function readOptionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined | null {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string") return null;
  const normalized = candidate.trim();
  return normalized.length > 0 ? candidate : null;
}

function parseDisplay(value: unknown): ToolResultDisplay | undefined {
  if (!isRecord(value)) return undefined;

  // status 只接受 success 与 failed 两个字面量，其它值（含缺失）与协议联合类型不匹配，整条结果退回兜底
  // error 与 message 都是可选的，但一旦出现就必须是非空字符串，两个字段一起校验通过后才构造对象
  // [失败路径] 任一字段非法即整条返回 undefined，不保留另一半：只带 error 不带 message 的半条数据在界面上无法自洽
  // 可选字段用条件展开，而不是先写空值再靠消费侧过滤：序列化时值为 undefined 的键会消失，比较层会误判字段变化
  // 最终对象的 kind 是字面量而不是回填的 value.kind，收窄后的字面量让联合类型判别在编译期成立
  // [权衡] 手写逐字段校验而不复用 shared schema：这是 UI 本地消息，协议侧没有对应 schema，为它单建一份只服务 UI 的 schema 不划算
  if (value.kind === "local_agent_message") {
    if (value.status !== "success" && value.status !== "failed") return undefined;
    const error = readOptionalString(value, "error");
    const message = readOptionalString(value, "message");
    if (error === null || message === null) return undefined;
    return {
      kind: "local_agent_message",
      status: value.status,
      ...(error !== undefined ? { error } : {}),
      ...(message !== undefined ? { message } : {}),
    };
  }

  // taskId、taskType、message 是必填三件套，缺任一即整条丢弃，停止任务卡没有这三项就无法定位到具体任务
  // command 是可选：停止后台 shell 时才有，停止子代理时本来就没有命令行
  // command 判 null 表示字段给了但不是字符串，与「没给」严格区分，前者按畸形载荷拒绝
  // truncated 在这里只做类型校验不做真假约束，因为停止输出可能被截断也可能完整
  // [失败路径] 校验按必填优先排列，避免在缺失 taskId 的对象上继续读取后面的字段
  // [权衡] 空白串被判成非法后必填项直接算缺失，不再单独给出「字段为空」的错误码：展示层只需要一个降级出口
  if (value.kind === "task_stop") {
    const taskId = readOptionalString(value, "taskId");
    const taskType = readOptionalString(value, "taskType");
    const command = readOptionalString(value, "command");
    const message = readOptionalString(value, "message");
    const truncated = value.truncated;
    if (
      !taskId ||
      !taskType ||
      command === null ||
      !message ||
      (truncated !== undefined && typeof truncated !== "boolean")
    ) {
      return undefined;
    }
    return {
      kind: "task_stop",
      taskId,
      taskType,
      ...(command !== undefined ? { command } : {}),
      message,
      ...(truncated !== undefined ? { truncated } : {}),
    };
  }

  // retrievalStatus 是三值枚举，未知值一律拒绝：检索态决定卡片显示内容还是继续轮询，猜错会让用户停在错误状态
  // taskStatus 上限 64 字符，它是状态短名而非正文，超过该长度只可能是被拼接过的脏数据
  // [资源] output 上限 2000 字符，单条消息在列表行里驻留的文本量因此有界，超限说明上游没有按约定截断
  // [权衡] 超长不是截断后展示而是整条拒绝：本函数不认识省略标记的文案，截在这里会让用户以为任务真的只输出了这么多
  // truncated 只接受字面 true，false 与缺失语义相同，放行 false 会让消费侧多出一种「假」状态
  // taskStatus 与 output 先判 null 再判长度：先排除类型错误再谈长度，错误归因只有一条路径
  // [失败路径] 任一条不满足就返回 undefined，调用方转去下一个候选或走兜底渲染，不会拿到部分字段
  // 三个可选字段各自条件展开，顺序与接口声明一致，产出对象的键序因此稳定，便于浅比较
  if (value.kind === "task_output") {
    if (
      value.retrievalStatus !== "success" &&
      value.retrievalStatus !== "not_ready" &&
      value.retrievalStatus !== "timeout"
    ) {
      return undefined;
    }
    const taskStatus = readOptionalString(value, "taskStatus");
    const output = readOptionalString(value, "output");
    const truncated = value.truncated;
    if (
      taskStatus === null ||
      (taskStatus !== undefined && taskStatus.length > 64) ||
      output === null ||
      (output !== undefined && output.length > 2_000) ||
      (truncated !== undefined && truncated !== true)
    ) {
      return undefined;
    }
    return {
      kind: "task_output",
      retrievalStatus: value.retrievalStatus,
      ...(taskStatus !== undefined ? { taskStatus } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(truncated === true ? { truncated: true } : {}),
    };
  }

  if (value.kind === "respond_to_coordinator") {
    if (value.status !== "success" && value.status !== "failed") {
      return undefined;
    }
    return {
      kind: "respond_to_coordinator",
      status: value.status,
    };
  }

  // cua 分支字段最多，但仍是先取后判：七个可选字符串与 media、targetApp 全部读出后一次性判定
  // legacyInput 只参与校验不进入输出，老版本把 input 塞在结果里，新结构已由 structuredContent 取代
  // media 的每一项独立过滤，坏项直接丢弃而不牵连整条：一张截图缺字段不该让其余截图与文字一起消失
  // mimeType 必填，data 与 artifactUri 可以都缺，此时该项仍保留，仅凭 mimeType 也够消费侧决定占位形态
  // schemaVersion 严格等于 1，既不做字符串转换也不做大于等于比较，否则新载荷会按旧字段表解读
  // [失败路径] 任一标量字段为 null（给了但不是字符串）即整条拒绝，避免半截字段进入渲染
  // [权衡] targetApp 先递归解析成结构化值再判空，而不是就地取字段：解析结果需要同时表达「缺失」与「畸形」，两个返回值刚好够用
  if (value.kind === "cua") {
    const toolName = readOptionalString(value, "toolName");
    const legacyInput = readOptionalString(value, "input");
    const structuredContent = readOptionalString(value, "structuredContent");
    const text = readOptionalString(value, "text");
    const errorCode = readOptionalString(value, "errorCode");
    const suggestedAction = readOptionalString(value, "suggestedAction");
    const media = Array.isArray(value.media)
      ? value.media.flatMap((item) => {
          if (!isRecord(item)) return [];
          const mimeType = readOptionalString(item, "mimeType");
          const data = readOptionalString(item, "data");
          const artifactUri = readOptionalString(item, "artifactUri");
          return mimeType && data !== null && artifactUri !== null
            ? [
                {
                  mimeType,
                  ...(data ? { data } : {}),
                  ...(artifactUri ? { artifactUri } : {}),
                },
              ]
            : [];
        })
      : undefined;
    const targetApp = parseCuaTargetApp(value.targetApp);
    if (
      value.schemaVersion !== 1 ||
      !toolName ||
      legacyInput === null ||
      (value.status !== "success" && value.status !== "failed") ||
      structuredContent === null ||
      text === null ||
      errorCode === null ||
      suggestedAction === null ||
      targetApp === null ||
      (value.truncated !== undefined && typeof value.truncated !== "boolean")
    )
      return undefined;
    return {
      kind: "cua",
      schemaVersion: 1,
      toolName,
      status: value.status,
      ...(structuredContent !== undefined ? { structuredContent } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(errorCode !== undefined ? { errorCode } : {}),
      ...(suggestedAction !== undefined ? { suggestedAction } : {}),
      ...(media?.length ? { media } : {}),
      ...(value.truncated !== undefined ? { truncated: value.truncated } : {}),
      ...(targetApp !== undefined ? { targetApp } : {}),
    };
  }

  // 工作流工具的 display kind（观察五件套 + ResumeWorkflowRun 恢复卡）：按 kind 查表后用
  // shared 的 strict schema 解析，保证 UI 消费侧与协议侧字段表永远同步——手写第二套结构
  // 校验是漂移温床。
  if (typeof value.kind === "string") {
    // 查表而不是长串条件分支：六个工作流 kind 的解析形态完全一致，表驱动让新增 kind 只动一张表
    // [失败路径] 表是普通对象字面量，原型链上的键（如 constructor、toString）也会被索引命中，取到的是内建函数而不是解析器
    // 上一条不是本文件要兜的错：真实载荷的 kind 来自协议枚举，出现这种键说明上游已经损坏，展示层只保证不抛错
    // 命中后直接返回解析结果，不再二次判断结果是否为空：字段组合的合法性由 shared 的 strict schema 一处裁决
    // [权衡] 不用 Map 封装：Map 需要额外初始化与类型断言，对象字面量的键还能在编译期被 schema 集合约束住
    // [失败路径] 末尾统一返回 undefined 而不是造兜底对象：兜底对象会让上层以为解析成功，从而跳过「结果形状未知」的提示
    // kind 必须是字符串才进查表，数字或对象型 kind 直接落到末尾，避免把数字索引协议混进来
    const parseWorkflowDisplayByKind = WORKFLOW_DISPLAY_PARSERS_BY_KIND[value.kind];
    if (parseWorkflowDisplayByKind !== undefined) {
      return parseWorkflowDisplayByKind(value);
    }
  }

  return undefined;
}

// 返回值三态与字段解析同构：缺省表示没有这个字段，畸形表示给了但不可用，调用方据此决定省略还是整条拒绝
// 先判形状再读字段：不是记录或版本不为 1 时立即判畸形，不在错误形状上继续取值
// displayName 上限 512 字符，这是应用显示名，超出该长度只可能是被拼接过的脏数据
// iconLocators 上限 3 项，工具栏图标位宽度固定，再多就会溢出并挤掉相邻操作
// [权衡] 定位串全有或全无，不保留还能认出来的那几项：少一个定位途径就可能点不到应用，半套定位比没有更误导
// [失败路径] 用过滤前后长度相等来发现坏项，比另起一轮布尔收集少一次遍历，也少一处漏判
// 输出里重建新的图标对象而非透传原元素：原元素可能带额外字段，透传会把未校验的数据带进协议类型
function parseCuaTargetApp(value: unknown): CuaToolResultDisplay["targetApp"] | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.iconLocators)) {
    return null;
  }
  const displayName = readOptionalString(value, "displayName");
  if (displayName === null || (displayName !== undefined && displayName.length > 512)) return null;
  if (value.iconLocators.length > 3) return null;
  const iconLocators: NonNullable<CuaToolResultDisplay["targetApp"]>["iconLocators"] =
    value.iconLocators.flatMap((locator) => {
      if (!isRecord(locator)) return [];
      const locatorValue = readOptionalString(locator, "value");
      if (
        !locatorValue ||
        (locator.kind !== "darwin-bundle-id" &&
          locator.kind !== "windows-executable-path" &&
          locator.kind !== "windows-aumid")
      ) {
        return [];
      }
      return [{ kind: locator.kind, value: locatorValue }];
    });
  if (iconLocators.length !== value.iconLocators.length) return null;
  return {
    schemaVersion: 1,
    ...(displayName !== undefined ? { displayName } : {}),
    iconLocators,
  };
}

// 这是唯一对外导出的函数，也是唯一解析入口：组件不得自己读 raw.result.display，否则五条候选路径的优先级会被各写一份
// 五条候选路径对应历史上出现过的五种载荷形状：协议结果、raw 直挂、metadata、rawOutput、output 嵌套
// [失败路径] 每条路径都先收窄成记录再取 display，中间任意一层不是对象时按「这条路径没有」处理，而不是抛错或跳到最后
// 首个命中即返回，这是纯函数语义的一部分：同样的 raw 必然得到同一个展示，不依赖调用次数与执行顺序
// [权衡] 不做字段合并：把多条路径的 display 拼起来会让字段来源不可追溯，某一轮多出一个字段就无法解释
// 路径顺序即优先级，靠前的路径被视为更可信，调整顺序属于行为变更，等同于改变旧数据展示出来的内容
// undefined 是完整的语义出口，调用方据此渲染兜底卡片，这里不提供任何默认展示对象
export function readToolResultDisplay(raw: unknown): ToolResultDisplay | undefined {
  if (!isRecord(raw)) return undefined;

  const result = isRecord(raw.result) ? raw.result : undefined;
  const metadata = isRecord(raw.metadata) ? raw.metadata : undefined;
  const rawOutput = isRecord(raw.rawOutput) ? raw.rawOutput : undefined;
  const output = isRecord(raw.output) ? raw.output : undefined;
  const candidates = [
    result?.display,
    raw.display,
    metadata?.display,
    rawOutput?.display,
    output?.display,
  ];

  for (const candidate of candidates) {
    const display = parseDisplay(candidate);
    if (display) return display;
  }

  return undefined;
}
