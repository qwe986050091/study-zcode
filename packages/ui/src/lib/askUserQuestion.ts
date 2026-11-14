// AskUserQuestion 视图模型层：把 Agent 侧任意形状的题目输入归一化成稳定的选项结构，并从实时 output、
// 历史 raw 快照与 Claude 文本格式中逐级回退出用户答案。全部为纯函数，无 IO、无状态、无外部依赖。
// 不负责渲染与选中态，不负责写入工具状态，也不校验答案值是否属于当前题目集合。
//
// INV-01 断言：选项 requiresInput 为真时渲染层必须同时给出文本输入框，答案按选中项加自由文本合并 —— 守住它的位置：normalizeOption 的 requiresInput 计算 —— 改错故障：用户点「其他」后没有输入框，答案只剩标签文本
// INV-02 断言：带 placeholder 的对象选项一律视为可输入项，index >= 0 恒真不是冗余判断 —— 守住它的位置：normalizeOption 里 readBoolean 与 placeholder 的或运算 —— 改错故障：自定义输入项退化成普通选项，只能选预设项
// INV-03 断言：队尾选项命中自定义输入特征时必须从 options 剥离并单独放进 customInput —— 守住它的位置：normalizeQuestion 的 lastOptionIsCustomInput 分支 —— 改错故障：UI 同时渲染「其他」选项和输入框，选中态被双写
// INV-04 断言：剥离只作用于队尾最后一个选项，不能按标签做全局过滤 —— 守住它的位置：normalizeQuestion 的 options.slice(0, -1) —— 改错故障：中间一个叫「其他方案」的正常选项被误吞，题目少一项
// INV-05 断言：单题结构 { header, question, options } 必须归一化成单元素数组 —— 守住它的位置：readQuestions 末尾的三元返回 —— 改错故障：ZCode Agent 的工具块显示「没有可回答的问题」
// INV-06 断言：问题 id 缺省时按数组下标生成，保证同一输入多次归一化得到同一 id —— 守住它的位置：normalizeQuestion 的 id 兜底 —— 改错故障：每次重渲染 key 都变，已选状态和滚动位置丢失
// INV-07 断言：选项 id 缺省回退到 label，而不是下标，以保住答案匹配键的稳定 —— 守住它的位置：normalizeOption 的 id 兜底 —— 改错故障：两个同标签选项 id 相撞，选一个两个都高亮
// INV-08 断言：答案键既可能是题面原文也可能是 question.id，读取时必须两个都查 —— 守住它的位置：getAskUserQuestionAnswerText 的首行取值 —— 改错故障：历史消息明明答过却显示「未回答」
// INV-09 断言：答案解析顺序是 output 嵌套、Claude 文本、ZCode 结构化、input.answers、raw 各层，不可调换 —— 守住它的位置：readAskUserQuestionAnswers 的分支序列 —— 改错故障：实时答案被历史快照覆盖后读回旧值
// INV-10 断言：只接受 type 为 answered 的 selected 与 answered_custom 的 text，其余类型视为无答案 —— 守住它的位置：parseZCodeAskUserQuestionOutput 的 rawAnswer 计算 —— 改错故障：pending 或 cancelled 被当成已选，卡片提前收敛
// INV-11 断言：ZCode 结构化输出只回填第一题，因为该协议本身只携带单题答案 —— 守住它的位置：parseZCodeAskUserQuestionOutput 的 data.questions[0] —— 改错故障：多题场景答案挂到错题上或整块判为未回答
// INV-12 断言：Claude 文本格式只匹配双引号包裹的问答对，答案内不能含双引号 —— 守住它的位置：answerPattern 正则 —— 改错故障：答案含引号时被截断，展示残缺文本且无法复原
// INV-13 断言：解析出零个有效问答时必须返回 undefined 而不是空对象 —— 守住它的位置：parseClaudeAskUserQuestionOutput 的尾部判断 —— 改错故障：回退链被空对象短路，后续 raw 快照不再被读取
// INV-14 断言：空串与纯空白不算有效字符串字段，必须继续尝试下一个别名键 —— 守住它的位置：readString 的 trim 判空 —— 改错故障：标签为空格的白占位选项顶掉了真正的 label
// INV-15 断言：数组不得被识别成普通记录，否则答案数组会被当成答案映射 —— 守住它的位置：isPlainRecord 的 Array.isArray 排除 —— 改错故障：数组下标变成问题键，答案全部错位
// INV-16 断言：嵌套解析沿 content 数组逐项递归并在首个命中处返回，不聚合多题答案 —— 守住它的位置：readNestedAskUserQuestionAnswers 的 content 循环 —— 改错故障：多段 content 时答案互相覆盖，只剩最后一段
type ZCodeUserQuestionAnswers = Record<string, unknown>;

type AskUserQuestionType = "single" | "multiple";

interface AskUserQuestionOption {
  id: string;
  label: string;
  description?: string;
  placeholder?: string;
  requiresInput: boolean;
}

interface AskUserQuestionItem {
  id: string;
  question: string;
  type: AskUserQuestionType;
  options: AskUserQuestionOption[];
  customInput?: AskUserQuestionOption;
}

interface AskUserQuestionData {
  questions: AskUserQuestionItem[];
  answers?: ZCodeUserQuestionAnswers;
}

interface AskUserQuestionAnswerDraft {
  selectedOptionIds: string[];
  customInput: string;
}

// [契约] 这五个键是「该选项需要自由文本」的唯一白名单，跨 Claude 与 ZCode 两套字段命名
// 新增别名只能加在这里，不能在下游各自判断，否则两处判断迟早分叉
// 下游按 === true 严格比较，字符串 "true" 或数字 1 一律不算，兼容第三方工具写入的字符串标记
// 这里同时影响 requiresInput 计算与 customInput 生成，属于双向敏感点，改动前先看 normalizeQuestion
// 若误删 customInput 键，队尾自定义选项会被当成普通选项，输入框彻底消失
const CUSTOM_INPUT_FLAGS = [
  "requiresInput",
  "customInput",
  "isCustom",
  "freeText",
  "allowFreeText",
] as const;
// [权衡] 靠标签文案兜底识别「其他」类选项，是因为部分 Agent 只给 label 不给任何标记
// 中英双语加宽松匹配换来召回率，代价是「其他方案」这类正常业务选项可能被误判
// \s* 允许 free text 与 write in 这类带空格写法，删掉会漏掉英文客户端的自定义项
// 正则没有首尾锚点，label 里只要出现关键词就命中，因此不能拿它做严格校验
// 改错后果是自定义输入项被误剥离或漏剥离：前者少一个选项，后者出现重复输入框
const CUSTOM_INPUT_LABEL_PATTERN =
  /(其他|其它|自定义|自行|自己|补充|填写|填入|输入|other|custom|free\s*text|specify|write\s*in)/i;

// [契约] 记录判定必须排除 null 与数组，这个守卫被答案解析与输入归一化共同复用
// typeof 数组同样是 object，漏掉 Array.isArray 会把答案数组当成 answers 映射
// 类实例在这里也算记录，下游只读属性，不会调用方法或回写原对象
// 返回类型谓词让调用方直接拿到 Record 类型，删掉类型守卫会连带一片手工断言
// 不要为 Promise、Map、Date 加特判：解析入口拿到的都是 JSON 反序列化产物
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// [契约] 按别名顺序取第一个非空字符串，空串与纯空白视为没有该字段，继续看下一个别名
// 返回值不 trim，因为 label 可能靠前后空格排版；trim 只用于判空
// 别名顺序即优先级，调换会让 id 被 name 顶掉，进而影响答案键匹配
// 返回值只有 string 或 undefined，调用方的 ?? 兜底依赖这个约定，别改成返回 null
function readString(record: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function readBoolean(record: Record<string, unknown>, keys: readonly string[]) {
  return keys.some((key) => record[key] === true);
}

// 字符串选项走最简分支：直接当 label，id 用下标生成，天然不可输入
// 对象选项的 label 兜底是 JSON.stringify，宁可显示难看字段也不能丢选项
// id 缺省回退 label：同标签选项会撞 id，这是已知权衡，选中态可能一起高亮
// requiresInput 由显式标记与 placeholder 存在性共同决定，后者说明 Agent 默认该选项可填
// 未知类型（数字、布尔）返回 null 交给上层过滤，不要改成抛异常，否则一题坏掉整块工具卡
function normalizeOption(value: unknown, index: number): AskUserQuestionOption | null {
  if (typeof value === "string") {
    return {
      id: `option-${index}`,
      label: value,
      requiresInput: false,
    };
  }

  if (!isPlainRecord(value)) {
    return null;
  }

  const label =
    readString(value, ["label", "name", "title", "text", "value"]) ??
    JSON.stringify(value);
  const id = readString(value, ["id", "optionId", "value", "key"]) ?? label;
  // [契约] 三个 placeholder 别名对应不同 Agent 的字段拼写，顺序不影响命中结果只影响可读性
  // 只要读到 placeholder 就认定可输入，即使 Agent 没有给 requiresInput 标记
  // 同一个值既作输入框提示语又作 customInput 的 label，所以不能在这里改写或裁剪文案
  // 删掉任一别名会让对应来源的自定义输入退化成不可输入的普通单选项
  const placeholder = readString(value, [
    "placeholder",
    "customInputPlaceholder",
    "freeTextPlaceholder",
    "inputPlaceholder",
  ]);

  return {
    id,
    label,
    description: readString(value, ["description", "detail", "help", "hint"]),
    placeholder,
    requiresInput:
      readBoolean(value, CUSTOM_INPUT_FLAGS) ||
      (index >= 0 && placeholder !== undefined),
  };
}

// [失败路径] undefined 返回 false 而不是抛错，队列为空或末项缺失是常见输入
// 只读 label 不看 id，所以 id 叫 other 而 label 叫「补充说明」的选项不会被识别
// 这是纯文案启发式，判错只影响本题的一个选项，不会污染其他题目
// 匹配用的正则刻意不带 g 标志，带 g 的 test 会残留 lastIndex 导致隔次失效
function isImplicitCustomInputOption(option: AskUserQuestionOption | undefined) {
  if (!option) {
    return false;
  }
  return CUSTOM_INPUT_LABEL_PATTERN.test(option.label);
}

// [契约] 数组优先：questions 是数组就直接用，不做元素合法性校验，交给 normalizeQuestion 过滤
// 单题结构是 ZCode Agent 的真实形状，返回 [input] 时保留 header 等额外字段供渲染层使用
// 只认 input.question 为字符串且 input.options 为数组，缺一即视为没有题目，避免渲染空卡片
// 这里不抛错也不返回 undefined，调用方用 length 判断，异常输入被静默降级为空数组
// 若把选项归一化写在这里，会与 normalizeQuestion 重复，日后改一处漏一处
function readQuestions(input: unknown): unknown[] {
  if (!isPlainRecord(input)) {
    return [];
  }
  const questions = input.questions;
  if (Array.isArray(questions)) {
    return questions;
  }
  // Bugfix: ZCode Agent 的 AskUserQuestion 工具输入是单题结构：
  // { header, question, options }，不是多题结构 { questions: [...] }。
  // 这里把单题结构归一化成同一条 questions 管线，避免消息流工具块显示“没有可回答的问题”。
  return typeof input.question === "string" && Array.isArray(input.options)
    ? [input]
    : [];
}

function readAnswers(input: unknown): ZCodeUserQuestionAnswers | undefined {
  if (!isPlainRecord(input)) {
    return undefined;
  }
  const answers = input.answers;
  return isPlainRecord(answers) ? answers : undefined;
}

// [失败路径] 只处理字符串，非字符串、空串、纯空白一律返回 undefined 让上层继续回退
// 这是 Claude 历史消息的落盘兼容：output 是一段 "问题"="答案" 文本而不是结构化 JSON
// 逐对 matchAll 累加，同一问题重复出现以后者为准，与快照保存的最终态一致
// 空答案保留为空串而不是丢弃，避免用户主动跳过被当成未回答
// 返回空对象会短路上层回退链，所以零命中必须返回 undefined，这条最容易在重构中被改坏
function parseClaudeAskUserQuestionOutput(output: unknown): ZCodeUserQuestionAnswers | undefined {
  if (typeof output !== "string" || output.trim().length === 0) {
    return undefined;
  }

  const answers: ZCodeUserQuestionAnswers = {};
  // [契约] 答案允许空串（第二个捕获组用 *），问题至少一个字符（第一个用 +）
  // 引号内不允许出现转义双引号，含引号的答案会被截断成两段，属于已知限制
  // g 标志必须有，matchAll 才能遍历全部问答对；去掉后只剩第一对
  // 正则字面量在函数内新建，没有 lastIndex 残留，不要提到模块作用域复用
  const answerPattern = /"([^"]+)"="([^"]*)"/g;
  for (const match of output.matchAll(answerPattern)) {
    const question = match[1]?.trim();
    if (!question) {
      continue;
    }
    answers[question] = match[2] ?? "";
  }

  return Object.keys(answers).length > 0 ? answers : undefined;
}

function parseJsonRecord(output: unknown): Record<string, unknown> | undefined {
  if (isPlainRecord(output)) {
    return output;
  }
  if (typeof output !== "string" || output.trim().length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(output) as unknown;
    return isPlainRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// [契约] 探测顺序固定：先直接文本，再 JSON 记录，再 content、text、rawOutput、output
// 任何一层命中立刻返回，不做合并，多来源答案以最先命中的为准
// record.content 既可能是对象也可能是数组，两条分支都要保留，缺一会漏掉工具块数组形态
// 递归深度由数据形状决定且没有显式上限，不要为 JSON 产物加环检测额外分支
// 调整顺序会让某层旧答案压过外层新答案，表现为用户选完卡片不刷新
function readNestedAskUserQuestionAnswers(input: unknown): ZCodeUserQuestionAnswers | undefined {
  const directTextAnswers = parseClaudeAskUserQuestionOutput(input);
  if (directTextAnswers) {
    return directTextAnswers;
  }

  const record = parseJsonRecord(input);
  if (!record) {
    return undefined;
  }

  const directAnswers = readAnswers(record);
  if (directAnswers) {
    return directAnswers;
  }

  const contentAnswers = readNestedAskUserQuestionAnswers(record.content);
  if (contentAnswers) {
    return contentAnswers;
  }

  if (Array.isArray(record.content)) {
    for (const item of record.content) {
      const itemAnswers = readNestedAskUserQuestionAnswers(item);
      if (itemAnswers) {
        return itemAnswers;
      }
    }
  }

  const textAnswers = parseClaudeAskUserQuestionOutput(record.text);
  if (textAnswers) {
    return textAnswers;
  }

  const rawOutputAnswers = readNestedAskUserQuestionAnswers(record.rawOutput);
  if (rawOutputAnswers) {
    return rawOutputAnswers;
  }

  return readNestedAskUserQuestionAnswers(record.output);
}

// [契约] 只认结构化 JSON 输出，且必须能反查到第一条题目，否则返回 undefined
// 类型为 answered 时取 selected，answered_custom 取 text，其余状态一律视为没有答案
// 题目文本取自 input 归一化结果而不是 output，所以 input 缺失时本题无法回填
// 答案键用 question.question 原文而非 id，与 answers 映射的键约定保持一致
// 不要在这里补 pending 或 cancelled 的兜底文案，会让卡片误显示为已回答
function parseZCodeAskUserQuestionOutput(
  output: unknown,
  input: unknown,
): ZCodeUserQuestionAnswers | undefined {
  const outputRecord = parseJsonRecord(output);
  if (!outputRecord) {
    return undefined;
  }

  const data = normalizeAskUserQuestionInput(input);
  const question = data.questions[0];
  if (!question) {
    return undefined;
  }

  const type = outputRecord.type;
  const rawAnswer =
    type === "answered"
      ? outputRecord.selected
      : type === "answered_custom"
        ? outputRecord.text
        : undefined;
  if (typeof rawAnswer !== "string") {
    return undefined;
  }

  return {
    [question.question]: rawAnswer,
  };
}

// [契约] 题面必须是字符串，缺题面的条目直接丢弃，避免渲染出空标题卡片
// options 非数组时按空数组处理，题目仍保留，用户还能走题目级 placeholder 输入
// 类型判定兼容 multiple 与 multiSelect 两种布尔标记，都未标记时默认单选
// customInput 有两条来源：队尾自定义选项，或题目级 placeholder 兜底，二者互斥
// id 兜底用下标，保证同一输入重复归一化结果稳定，否则重渲染会丢选中态
function normalizeQuestion(value: unknown, index: number): AskUserQuestionItem | null {
  if (!isPlainRecord(value)) {
    return null;
  }

  const question = readString(value, ["question", "prompt", "label", "title", "text"]);
  if (!question) {
    return null;
  }

  const rawOptions = Array.isArray(value.options) ? value.options : [];
  const options = rawOptions
    .map((option, optionIndex) => normalizeOption(option, optionIndex))
    .filter((option): option is AskUserQuestionOption => option !== null);
  const questionPlaceholder = readString(value, [
    "customInputPlaceholder",
    "freeTextPlaceholder",
    "inputPlaceholder",
  ]);
  // [权衡]「最后一个选项是可输入项」是 Agent 的普遍约定，不是协议保证，属于启发式
  // 这里只用 === true 判断 requiresInput，标签正则的兜底放在 isImplicitCustomInputOption
  // lastOption 可能为 undefined，后续判断必须先判存在再取字段，否则运行期报错
  // 不要改成「任意选项满足就提取」，否则一次剥掉多个选项，题面直接缺项
  // 队尾是普通选项时只生成题目级 placeholder 输入项，两条来源绝不叠加
  const lastOption = options.at(-1);
  const lastOptionIsCustomInput =
    lastOption !== undefined &&
    (lastOption.requiresInput === true || isImplicitCustomInputOption(lastOption));
  const customInput =
    lastOptionIsCustomInput && lastOption
      ? {
          ...lastOption,
          placeholder: lastOption.placeholder ?? lastOption.label,
          requiresInput: true,
        }
      : questionPlaceholder
        ? {
            id: `custom-${index}`,
            label: questionPlaceholder,
            placeholder: questionPlaceholder,
            requiresInput: true,
          }
        : undefined;
  const normalizedOptions =
    lastOptionIsCustomInput ? options.slice(0, -1) : options;
  const type =
    value.multiple === true ||
    value.multiSelect === true ||
    value.type === "multiple" ||
    value.type === "multi"
      ? "multiple"
      : "single";

  return {
    id: readString(value, ["id", "key", "name"]) ?? `question-${index}`,
    question,
    type,
    options: normalizedOptions,
    customInput,
  };
}

// [契约] 对外只暴露这一个归一化入口，返回结构固定含 questions 与 answers 两个键
// 题目过滤在 map 之后做 null 剔除，长度可能小于原始数组，调用方不能按下标回查原题
// answers 原样透传不做归一化，键的兼容匹配交给 getAskUserQuestionAnswerText
// 函数无副作用无缓存，同一输入多次调用结果相等，这是 memo 化与测试断言的前提
// 不要在返回前补默认题目或占位答案，空数组本身就是合法状态
export function normalizeAskUserQuestionInput(input: unknown): AskUserQuestionData {
  return {
    questions: readQuestions(input)
      .map((question, index) => normalizeQuestion(question, index))
      .filter((question): question is AskUserQuestionItem => question !== null),
    answers: readAnswers(input),
  };
}

// [契约] 取值优先级：value.input 有题就先用，否则依次尝试 raw.rawInput 与 raw.input
// 有效指 readQuestions 能返回非空数组，而不是 input 是非空对象
// raw 只在实时输入为空时兜底，历史快照不能覆盖实时输入，否则重新加载会回退旧题目
// 末尾仍返回 value.input，保证调用方一定拿到原始值而不是 undefined
export function readAskUserQuestionInput(value: {
  input?: unknown;
  output?: unknown;
  raw?: unknown;
}): unknown {
  if (readQuestions(value.input).length > 0) {
    return value.input;
  }
  if (isPlainRecord(value.raw)) {
    if (readQuestions(value.raw.rawInput).length > 0) {
      return value.raw.rawInput;
    }
    if (readQuestions(value.raw.input).length > 0) {
      return value.raw.input;
    }
  }
  return value.input;
}

// [契约] 顺序是 output 嵌套、Claude 文本、ZCode 结构化、input.answers、raw 各层
// 实时 output 优先，因为历史 raw 快照可能在答案写入前生成，先读 raw 会读到旧态
// raw 内部再按 rawOutput、output、content 重复同样三种解析，层序不能重排
// 任一步命中即返回，后续分支只在前序全部落空时执行，删分支会静默改变结果
// 全部失败返回 undefined 而非空对象，上层据此显示「未回答」而不是错位答案
export function readAskUserQuestionAnswers(value: {
  input?: unknown;
  output?: unknown;
  raw?: unknown;
}): ZCodeUserQuestionAnswers | undefined {
  const nestedOutputAnswers = readNestedAskUserQuestionAnswers(value.output);
  if (nestedOutputAnswers) {
    return nestedOutputAnswers;
  }
  // Bugfix: Claude 历史里的 AskUserQuestion output 会落成一段文本
  // `"问题"="答案"`，而不是结构化 answers。历史 snapshot 覆盖实时态后，
  // 只读结果会因为读不到 answers 退回 No answer provided，这里兼容解析该格式。
  const parsedOutputAnswers = parseClaudeAskUserQuestionOutput(value.output);
  if (parsedOutputAnswers) {
    return parsedOutputAnswers;
  }
  const parsedZCodeOutputAnswers = parseZCodeAskUserQuestionOutput(
    value.output,
    readAskUserQuestionInput(value),
  );
  if (parsedZCodeOutputAnswers) {
    return parsedZCodeOutputAnswers;
  }
  if (isPlainRecord(value.input) && isPlainRecord(value.input.answers)) {
    return value.input.answers;
  }
  if (isPlainRecord(value.raw)) {
    const nestedRawOutputAnswers = readNestedAskUserQuestionAnswers(value.raw.rawOutput);
    if (nestedRawOutputAnswers) {
      return nestedRawOutputAnswers;
    }
    const parsedRawOutputAnswers = parseClaudeAskUserQuestionOutput(value.raw.rawOutput);
    if (parsedRawOutputAnswers) {
      return parsedRawOutputAnswers;
    }
    const parsedRawZCodeOutputAnswers = parseZCodeAskUserQuestionOutput(
      value.raw.rawOutput,
      readAskUserQuestionInput(value),
    );
    if (parsedRawZCodeOutputAnswers) {
      return parsedRawZCodeOutputAnswers;
    }
    const nestedRawAnswers = readNestedAskUserQuestionAnswers(value.raw.output);
    if (nestedRawAnswers) {
      return nestedRawAnswers;
    }
    const parsedRawAnswers = parseClaudeAskUserQuestionOutput(value.raw.output);
    if (parsedRawAnswers) {
      return parsedRawAnswers;
    }
    const parsedRawZCodeAnswers = parseZCodeAskUserQuestionOutput(
      value.raw.output,
      readAskUserQuestionInput(value),
    );
    if (parsedRawZCodeAnswers) {
      return parsedRawZCodeAnswers;
    }
    const nestedRawContentAnswers = readNestedAskUserQuestionAnswers(value.raw.content);
    if (nestedRawContentAnswers) {
      return nestedRawContentAnswers;
    }
  }
  return undefined;
}

// [契约] 先按题面原文取，再按 question.id 取，覆盖历史与实时两种写入习惯
// 数组答案逐项转字符串并 trim，丢掉空项后用中文顿号连接，空数组回落无答案文案
// 字符串答案只在 trim 后非空时返回原值，保留用户输入里的换行与内部空格
// null 与 undefined 同样回落文案，不要改成或运算合并，否则 0 与 false 会被吞掉
// 其余类型直接转字符串兜底，保证渲染层拿到的始终是字符串而不是对象
export function getAskUserQuestionAnswerText(
  question: AskUserQuestionItem,
  answers: ZCodeUserQuestionAnswers | undefined,
  noAnswerText: string,
) {
  const value = answers?.[question.question] ?? answers?.[question.id];
  if (Array.isArray(value)) {
    const values = value
      .map((item) => String(item).trim())
      .filter((item) => item.length > 0);
    return values.length > 0 ? values.join("，") : noAnswerText;
  }
  if (typeof value === "string") {
    return value.trim().length > 0 ? value : noAnswerText;
  }
  if (value === undefined || value === null) {
    return noAnswerText;
  }
  return String(value);
}
