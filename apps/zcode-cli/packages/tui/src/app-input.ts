// 输入区纯函数与类型转换（L2）：斜杠/模型/effort 命令的过滤与选中窗口、附件与 prompt 载荷转换。
// 全部为纯函数（toDraftAttachments 只通过注入的 allocateId 产生副作用），不碰 React/终端。
// 空集合语义：候选为空时过滤结果为空数组、选中窗口为空窗口，reconcile* 返回 undefined 表示"该关面板"。
import type { ModelSelection } from "@zcode/shared";
import { modelOptionValue } from "./app-model-ref.js";
import type {
  DraftAttachment,
  EffortCommandSelectionState,
  ModelCommandSelectionState,
  SlashCommand,
  SlashSelectionState,
} from "./app-model.js";
import { clampIndex } from "./app-selection-keyboard.js";
import { matchesText } from "./state.js";
import type {
  TuiClipboardImage,
  TuiEffortOption,
  TuiModelOption,
  TuiPromptAttachment,
  TuiPromptInput,
} from "./types.js";

// 命令字面量常量：/variant 是 /effort 的别名，两者共用同一套查询与过滤逻辑。
const MODEL_COMMAND_NAME = "/model";
const MODEL_COMMAND_WITH_SPACE = `${MODEL_COMMAND_NAME} `;
const EFFORT_COMMAND_NAMES = ["/effort", "/variant"] as const;

// 选区键盘能力的纯 re-export，便于输入相关模块只从本文件取依赖（不改变导出面）。
export {
  clampIndex,
  filterSelectionItems,
  handleSelectionKey,
  printableKey,
} from "./app-selection-keyboard.js";

// 查询词只取命令词本身，出现空白即视为进入参数输入，因此不会在参数阶段误补全。
// 返回新数组，调用方可直接作为 React props，不得原地修改。
// 按草稿过滤斜杠命令：命令名或任一别名包含查询词即命中（大小写不敏感）。
// 草稿不以 "/" 开头或已含空白时返回空数组；返回顺序保持 commands 原序。
export function filterSlashCommands(
  draft: string,
  commands: readonly SlashCommand[],
): readonly SlashCommand[] {
  // 只对"单个斜杠词"生效：一旦出现空白说明已进入参数输入，不再算命令补全。
  if (!draft.startsWith("/") || /\s/.test(draft)) return [];
  const query = draft.slice(1).toLowerCase();
  return commands.filter(
    (command) =>
      command.name.toLowerCase().includes(query) ||
      command.aliases?.some((alias) => alias.toLowerCase().includes(query)),
  );
}

// 每次重算都重置到第一项，不保留旧选中位置，避免候选集合变化后索引错位。
// 返回 undefined 同时表示"无候选"与"应关闭面板"，调用方无需区分两种语义。
// 用草稿重算斜杠选择态：有匹配则回到第一项，否则返回 undefined（清空选择、关闭面板）。
export function reconcileSlashSelection(
  draft: string,
  commands: readonly SlashCommand[],
): SlashSelectionState | undefined {
  return filterSlashCommands(draft, commands).length > 0 ? { selectedIndex: 0 } : undefined;
}

// 这里使用完整 commands 而非过滤结果，索引口径必须与 UI 维护的列表一致。
// 返回值可能为 undefined，调用方不应假定 selectedIndex 一定能取到元素。
// 提交时取选中的斜杠命令：使用完整 commands 列表按 selectedIndex 取值（索引已由 UI 维护）。
// 无选择态、提交值不以 "/" 开头或候选为空时返回 undefined。
export function selectedSlashCommand(
  submittedValue: string,
  slashSelection: SlashSelectionState | undefined,
  commands: readonly SlashCommand[],
): SlashCommand | undefined {
  // 提交值不再以 "/" 开头，说明命令已被用户删掉，忽略残留的选择态。
  if (!slashSelection || !submittedValue.startsWith("/") || commands.length === 0) return undefined;
  return commands[clampIndex(slashSelection.selectedIndex, commands.length)];
}

// 返回的命令是原数组切片，元素引用不变，不会复制命令对象。
// startIndex 供调用方把窗口内相对下标换算回绝对下标（点击/键盘定位时使用）。
// 计算滚动窗口：选中项尽量贴底（向上溢出时才滚动），返回窗口内的命令切片、相对选中下标与窗口起点。
// 空列表或 maxVisible <= 0 返回空窗口（selectedIndex=0, startIndex=0）。
export function visibleSlashCommandWindow(
  commands: readonly SlashCommand[],
  selectedIndex: number,
  maxVisible: number,
): {
  commands: readonly SlashCommand[];
  selectedIndex: number;
  startIndex: number;
} {
  if (commands.length === 0 || maxVisible <= 0) {
    return {
      commands: [],
      selectedIndex: 0,
      startIndex: 0,
    };
  }

  const clampedSelectedIndex = clampIndex(selectedIndex, commands.length);
  const visibleCount = Math.min(maxVisible, commands.length);
  const maxStartIndex = commands.length - visibleCount;
  // 起点取"选中项 - 可见数 + 1"，保证选中项在末行；再夹到 [0, maxStartIndex] 防止越界。
  const startIndex = Math.min(Math.max(0, clampedSelectedIndex - visibleCount + 1), maxStartIndex);

  return {
    commands: commands.slice(startIndex, startIndex + visibleCount),
    selectedIndex: clampedSelectedIndex - startIndex,
    startIndex,
  };
}

// 从草稿提取 /model 的查询词。返回 undefined 表示草稿根本不是 /model 命令；
// 返回 "" 表示刚敲下命令、无过滤词（此时应展示全部模型）。
// 支持 "/model"、"/model xxx"、"/modelxxx" 三种写法；"/model list" 视为命令本身而非查询。
export function modelCommandQuery(draft: string): string | undefined {
  // "/model list" 是命令本身的完整形态，不能把 list 当作查询词（否则会把候选全过滤掉）。
  if (draft.trim() === "/model list") return undefined;
  if (draft === MODEL_COMMAND_NAME) return "";
  if (draft.startsWith(MODEL_COMMAND_WITH_SPACE)) {
    return draft.slice(MODEL_COMMAND_WITH_SPACE.length);
  }
  if (draft.startsWith(MODEL_COMMAND_NAME) && !/\s/u.test(draft)) {
    return draft.slice(MODEL_COMMAND_NAME.length);
  }
  return undefined;
}

// 匹配范围包含完整 "/model xxx" 写法，便于用户直接粘贴带命令前缀的值。
// 返回数组保持 models 原序，不按匹配度排序，避免选中项顺序抖动。
// 按查询词过滤模型候选：匹配 model 值、展示名、provider 名或完整 "/model xxx" 写法（大小写不敏感）。
// 草稿不是 /model 命令时返回空数组。
export function filterModelOptions(
  draft: string,
  models: readonly TuiModelOption[],
): readonly TuiModelOption[] {
  const query = modelCommandQuery(draft);
  if (query === undefined) return [];
  return models.filter((model) =>
    matchesText(query, [
      modelOptionValue(model),
      model.label,
      model.providerLabel,
      `${MODEL_COMMAND_WITH_SPACE}${modelOptionValue(model)}`,
    ]),
  );
}

// 只看命令语法与候选总数，不做查询词匹配，因此"有命令但零命中"时面板仍会打开。
// 返回 undefined 表示应关闭面板，调用方需同时清空残留的 selectedIndex。
// 用草稿重算模型选择态：草稿是 /model 命令且候选非空时回到第一项，否则 undefined。
export function reconcileModelCommandSelection(
  draft: string,
  models: readonly TuiModelOption[],
): ModelCommandSelectionState | undefined {
  return modelCommandQuery(draft) !== undefined && models.length > 0
    ? { selectedIndex: 0 }
    : undefined;
}

// 提交值必须仍是合法 /model 命令，否则视为用户已改为普通文本，忽略残留选择态。
// 返回的 option 原样来自 models，调用方不要修改其 ref 字段。
// 提交时取选中的模型：按完整 models 列表 + selectedIndex 取值（越界由 clampIndex 兜底）。
// 无选择态、提交值已不是 /model 命令或候选为空时返回 undefined。
export function selectedModelOption(
  submittedValue: string,
  modelSelection: ModelCommandSelectionState | undefined,
  models: readonly TuiModelOption[],
): TuiModelOption | undefined {
  if (!modelSelection || modelCommandQuery(submittedValue) === undefined || models.length === 0) {
    return undefined;
  }
  return models[clampIndex(modelSelection.selectedIndex, models.length)];
}

// 窗口算法与斜杠命令共享同一套"选中项贴底"规则，两者行为需保持一致。
// 返回的 models 为切片引用，selectedIndex 是窗口内相对下标而非全局下标。
// 模型候选的滚动窗口，语义与 visibleSlashCommandWindow 一致（选中项贴底）。
export function visibleModelOptionWindow(
  models: readonly TuiModelOption[],
  selectedIndex: number,
  maxVisible: number,
): {
  models: readonly TuiModelOption[];
  selectedIndex: number;
  startIndex: number;
} {
  if (models.length === 0 || maxVisible <= 0) {
    return {
      models: [],
      selectedIndex: 0,
      startIndex: 0,
    };
  }

  const clampedSelectedIndex = clampIndex(selectedIndex, models.length);
  const visibleCount = Math.min(maxVisible, models.length);
  const maxStartIndex = models.length - visibleCount;
  const startIndex = Math.min(Math.max(0, clampedSelectedIndex - visibleCount + 1), maxStartIndex);

  return {
    models: models.slice(startIndex, startIndex + visibleCount),
    selectedIndex: clampedSelectedIndex - startIndex,
    startIndex,
  };
}

// "/effort" 与 "/variant" 共用查询结果，调用方无需知道用户实际输入了哪一个。
// 查询词只做字符串切分、不 trim，前导空格会原样保留并影响匹配。
// 从草稿提取 effort 查询词（/effort 与 /variant 等价）：undefined 表示不是该命令，"" 表示无过滤词。
// 一旦命令后出现空白即视为进入参数输入，剩余部分全部作为查询词。
export function effortCommandQuery(draft: string): string | undefined {
  for (const commandName of EFFORT_COMMAND_NAMES) {
    const commandWithSpace = `${commandName} `;
    if (draft === commandName) return "";
    if (draft.startsWith(commandWithSpace)) {
      return draft.slice(commandWithSpace.length);
    }
    if (draft.startsWith(commandName) && !/\s/u.test(draft)) {
      return draft.slice(commandName.length);
    }
  }
  return undefined;
}

// 匹配字段包含 id、label、description 与完整命令写法，空字符串字段不会命中。
// 返回数组保持 efforts 原序，不做去重或排序。
// 按查询词过滤 effort 候选：匹配 id、label、description 以及两种完整命令写法。
// 草稿不是 effort 命令时返回空数组。
export function filterEffortOptions(
  draft: string,
  efforts: readonly TuiEffortOption[],
): readonly TuiEffortOption[] {
  const query = effortCommandQuery(draft);
  if (query === undefined) return [];
  return efforts.filter((effort) =>
    matchesText(query, [
      effort.id,
      effort.label,
      effort.description,
      `/effort ${effort.id}`,
      `/variant ${effort.id}`,
    ]),
  );
}

// 只看语法与候选数量，不调用 filterEffortOptions，零命中时面板仍会打开并显示占位行。
// 返回 undefined 表示应关闭面板，调用方需同时清空选择态。
// 用草稿重算 effort 选择态：是 effort 命令且候选非空时回到第一项，否则 undefined。
export function reconcileEffortCommandSelection(
  draft: string,
  efforts: readonly TuiEffortOption[],
): EffortCommandSelectionState | undefined {
  return effortCommandQuery(draft) !== undefined && efforts.length > 0
    ? { selectedIndex: 0 }
    : undefined;
}

// 提交值仍需是合法 effort 命令（/effort 或 /variant），否则忽略残留选择态。
// 候选非空时越界索引由 clampIndex 收敛，不会返回 undefined。
// 提交时取选中的 effort：按完整 efforts 列表 + selectedIndex 取值（越界由 clampIndex 兜底）。
// 无选择态、提交值已不是 effort 命令或候选为空时返回 undefined。
export function selectedEffortOption(
  submittedValue: string,
  effortSelection: EffortCommandSelectionState | undefined,
  efforts: readonly TuiEffortOption[],
): TuiEffortOption | undefined {
  if (
    !effortSelection ||
    effortCommandQuery(submittedValue) === undefined ||
    efforts.length === 0
  ) {
    return undefined;
  }
  return efforts[clampIndex(effortSelection.selectedIndex, efforts.length)];
}

// 与 visibleModelOptionWindow 同构，仅切换数据字段名，修改滚动规则需三处同步。
// 空窗口时 selectedIndex=0 只是占位值，调用方不得据此索引原数组。
// effort 候选的滚动窗口，语义与 visibleSlashCommandWindow 一致（选中项贴底）。
export function visibleEffortOptionWindow(
  efforts: readonly TuiEffortOption[],
  selectedIndex: number,
  maxVisible: number,
): {
  efforts: readonly TuiEffortOption[];
  selectedIndex: number;
  startIndex: number;
} {
  if (efforts.length === 0 || maxVisible <= 0) {
    return {
      efforts: [],
      selectedIndex: 0,
      startIndex: 0,
    };
  }

  const clampedSelectedIndex = clampIndex(selectedIndex, efforts.length);
  const visibleCount = Math.min(maxVisible, efforts.length);
  const maxStartIndex = efforts.length - visibleCount;
  const startIndex = Math.min(Math.max(0, clampedSelectedIndex - visibleCount + 1), maxStartIndex);

  return {
    efforts: efforts.slice(startIndex, startIndex + visibleCount),
    selectedIndex: clampedSelectedIndex - startIndex,
    startIndex,
  };
}

// 只校验前缀与负载非空，不校验 base64 字符集或实际解码，解码失败由下游处理。
// 纯字符串判断，不做长度上限；超大 dataUrl 的传输成本由调用方控制。
// 剪贴板图片合法性：dataUrl 必须以 "data:<mediaType>;base64," 开头且后面还有内容（非空负载）。
// mediaType 由 TuiClipboardImage 类型约束（png/jpeg/gif/webp）。
export function isValidClipboardImage(image: TuiClipboardImage): boolean {
  const prefix = `data:${image.mediaType};base64,`;
  return image.dataUrl.startsWith(prefix) && image.dataUrl.length > prefix.length;
}

// 把草稿文本 + 附件 + 可选模型选择转换成提交给会话的 TuiPromptInput。
// 只有占位符仍出现在文本中的附件才会随请求发送（被用户删掉占位符的附件自动失效）。
// 无有效附件且无 modelSelection 时降级为纯字符串，保持旧调用方兼容。
export function toPromptInput(
  text: string,
  attachments: DraftAttachment[],
  modelSelection?: ModelSelection,
): TuiPromptInput {
  // 只保留"占位符还在最终文本里"的附件：用户删掉占位符即视为收回该附件。
  const activeAttachments: TuiPromptAttachment[] = attachments
    .filter((attachment) => text.includes(attachment.placeholder))
    .map((attachment) =>
      attachment.type === "image"
        ? {
            content: attachment.dataUrl,
            path: attachment.placeholder,
            type: attachment.type,
          }
        : {
            path: attachment.path,
            type: attachment.type,
          },
    );

  return activeAttachments.length === 0 && !modelSelection
    ? text
    : {
        attachments: activeAttachments,
        text,
        ...(modelSelection ? { modelSelection } : {}),
      };
}

// 把会话侧附件还原成草稿附件：每个条目分配新 id（通过注入的 allocateId）。
// file：用 "@path" 作为占位符；image：从 dataUrl 推 mediaType，占位符优先沿用 path，
// 并从 "[image #N]" 里还原 id 以保持跨刷新稳定。
// 缺路径的文件、缺 content 的图片、无法识别 mediaType 的 dataUrl 一律丢弃（返回空数组项被 flatMap 过滤）。
export function toDraftAttachments(
  attachments: readonly TuiPromptAttachment[] | undefined,
  allocateId: () => number,
): DraftAttachment[] {
  return (attachments ?? []).flatMap((attachment): DraftAttachment[] => {
    if (attachment.type === "file" && attachment.path) {
      const placeholder = `@${attachment.path}`;
      return [
        {
          id: allocateId(),
          path: attachment.path,
          placeholder,
          type: "file" as const,
        },
      ];
    }
    if (attachment.type !== "image" || !attachment.content) return [];
    // 无法从 dataUrl 解析出受支持的 mediaType 时丢弃，而不是把不可渲染的附件塞进草稿。
    const mediaType = imageMediaTypeFromDataUrl(attachment.content);
    if (!mediaType) return [];
    const placeholder = attachment.path ?? `[image #${allocateId()}]`;
    const id = imagePlaceholderId(placeholder) ?? allocateId();
    return [
      {
        dataUrl: attachment.content,
        id,
        mediaType,
        placeholder,
        type: "image" as const,
      },
    ];
  });
}

// 从 "data:image/*;base64," 前缀解析媒体类型；只接受 png/jpeg/gif/webp，其余返回 undefined。
function imageMediaTypeFromDataUrl(dataUrl: string): TuiClipboardImage["mediaType"] | undefined {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,/i.exec(dataUrl);
  return match?.[1]?.toLowerCase() as TuiClipboardImage["mediaType"] | undefined;
}

// 从 "[image #N]" 占位符还原 id；非该格式、非正整数或超出安全整数范围时返回 undefined，
// 由调用方另行分配 id。
function imagePlaceholderId(placeholder: string): number | undefined {
  const match = /^\[image #(\d+)\]$/i.exec(placeholder);
  if (!match?.[1]) return undefined;
  const id = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}
