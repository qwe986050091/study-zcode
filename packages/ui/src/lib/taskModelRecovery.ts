// INV-01 解析 provider/model 时只认第一个斜杠：分隔符位于首尾即判负，守住位置语义（provider 在左、model 在右），避免带路径的模型名改错故障地被拆成多段。
// INV-02 拆分后两侧必须 trim 后非空，任一侧为空即整体返回 null，守住位置后再判空，避免空白填充的模型串改错故障地进入自定义模型分支。
// INV-03 占位符 synthetic（大小写不敏感、允许首尾空白）一律视为无模型，守住位置在解码之前，避免占位符改错故障地被当作真实模型回显。
// INV-04 已是自定义模型编码串（providerId 与 modelName 均非空）的输入原样返回，守住位置在二次编码之前，避免重复编码把模型值改错故障地套两层。
// INV-05 未编码但带 provider 前缀的模型串会按 providerId/modelName 重新编码，守住位置在“已解码”判定之后，顺序颠倒会把原始串改错故障地直传。
// INV-06 既无前缀也非编码串的裸模型名原样透传，守住位置在兜底返回处，避免为统一格式而给裸名字改错故障地补造 provider。
// INV-07 glm 分支必须先走 GLM 专用解析再做通用返回，守住位置保证 provider 判定优先于格式判定，避免大小写或路径差异带来的改错故障。
// INV-08 非 glm 的 provider 只做 trim 与占位符过滤，不触发编码，守住位置在 provider 分支出口，避免通用恢复路径改错故障地改写其它厂商的模型串。
// INV-09 展示名解析顺序固定为先自定义编码的 modelName、再前缀后的 modelName、最后原始值，守住位置保证短路顺序，避免展示名改错故障地带上前缀。
// INV-10 合并模型项只作用在 category 为 model 且 type 为 select 的项，守住位置在类型过滤处，避免顺带改写 mode 与 thought_level 造成改错故障。
// INV-11 已有同名选项且 currentValue 已对齐时返回原对象引用，守住位置在引用相等判断，避免无变化时改错故障地造新数组并触发重复提交。
// INV-12 缺少模型项时合成的最小模型项放在数组最前，守住位置保证首帧优先读取，避免真实配置回填前改错故障地退回选择模型占位。
// INV-13 合并结果无变化时返回 null 而非空数组，守住位置在调用方判空分支，避免空数组被当成有效配置引发改错故障的状态覆盖。
// INV-14 mode 与 thought_level 回显仅在 glm 且 meta 值 trim 后非空时执行，守住位置在 provider 与空值双门禁，避免改错故障地注入不支持的选项。
// INV-15 mode 缺失时合成项插到数组头部，thought_level 缺失时追加到尾部，守住位置固定插入侧，避免工具栏顺序改错故障地抖动。
// INV-16 恢复函数返回新数组而不原地修改入参，守住位置在不变量拷贝上，避免调用方持有的缓存被改错故障地污染。
// INV-17 task 级缓存在恢复期整体保留，仅由真实 settings 覆盖，守住位置在最后无条件返回，避免缺项时改错故障地先清空再重建。
// INV-18 glm 合并入口先做 provider 短路再委托通用实现，守住位置在委托之前，避免非 glm 任务改错故障地进入 GLM 专属路径。
//
// 模块职责：把持久化的 task meta（provider/model/mode/thoughtLevel）恢复成 composer 工具栏可直接渲染的 configOptions，并在缺项时合成最小可用的 model/mode/thought 项。
// 状态所有权：本模块无状态；入参 configOptions 与缓存均只读，返回值是新数组或 null，null 表示无变化、不要提交。
// 阅读顺序：先看两个纯解析函数（按斜杠拆 provider/model、识别 synthetic 占位），再看三层 resolve 的 provider 分支，最后看 merge 与 preload 的选项合成与插入侧。
import type { ZCodeConfigOption, ZCodeTaskMeta } from "@zcode/shared";
import { getZCodeAgentModeSelectOptions } from "@zcode/shared";
import {
  decodeCustomModelValue,
  encodeCustomModelValue,
} from "@/lib/zcodeCustomModelValue.js";

// 只认第一个斜杠：provider 段不允许再含分隔语义，模型名里若还有斜杠则整体保留在右侧，避免被拆成多段。
// 分隔符出现在首字符或末字符时直接判负，那意味着 provider 或 model 缺失，而不是格式待修。
// 返回值是新建对象，调用方可安全继续 trim 或编码，不必担心共享引用被后续步骤改写。
// `parseProviderQualifiedModel` 无副作用且不读环境：同一入参在渲染期得到同一结果。
// 失败统一用 null 表达，调用方据此回退到裸模型值，而不是抛异常打断整条恢复链路。
function parseProviderQualifiedModel(
  model: string,
): { providerId: string; modelName: string } | null {
  const normalizedModel = model.trim();
  const separatorIndex = normalizedModel.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex >= normalizedModel.length - 1) {
    return null;
  }

  const providerId = normalizedModel.slice(0, separatorIndex).trim();
  const modelName = normalizedModel.slice(separatorIndex + 1).trim();
  if (!providerId || !modelName) {
    return null;
  }

  return { providerId, modelName };
}

// 占位标记来自引擎默认写入，任何 provider 都可能出现，判定不区分大小写以覆盖历史落盘的大小写差异。
// 先 trim 再比较，避免首尾空白让占位符漏判，进而把占位符当成真实模型写进配置项。
// 用常量比较而非正则，成本低且不受正则元字符影响，尖括号无需额外转义。
// 该判定只回答“是否可恢复”，不负责清空其它字段，回退值由调用方决定。
function isSyntheticModelPlaceholder(model: string): boolean {
  return model.trim().toLocaleLowerCase() === "<synthetic>";
}

// GLM 侧的恢复目标是可被再次解码的规范串：已编码或带 provider 前缀的输入都会收敛到编码后的形态。
// 判定顺序不可交换：先占位符过滤、再判已编码、再判 provider 前缀，顺序一变就会重复编码或漏编码。
// 已编码判定要求 providerId 与 modelName 同时非空，半个编码串按未编码处理，避免产出不可解码的值。
// 裸模型名走最后兜底原样返回，保证缺失 provider 信息的旧任务仍能显示，只是无法切到自定义模型分组。
// `resolveGlmRecoveredTaskModelValue` 只关心值的形态，选项缺失由上层合成逻辑补齐。
export function resolveGlmRecoveredTaskModelValue(
  taskModel: string | undefined,
): string | null {
  const normalizedTaskModel = taskModel?.trim();
  if (!normalizedTaskModel || isSyntheticModelPlaceholder(normalizedTaskModel)) {
    return null;
  }

  const customModel = decodeCustomModelValue(normalizedTaskModel);
  if (customModel?.providerId && customModel.modelName) {
    return normalizedTaskModel;
  }

  const providerQualifiedModel = parseProviderQualifiedModel(normalizedTaskModel);
  if (providerQualifiedModel) {
    return encodeCustomModelValue(
      providerQualifiedModel.providerId,
      providerQualifiedModel.modelName,
    );
  }

  return normalizedTaskModel;
}

// 通用入口只做 provider 路由：glm 交给专用解析，其余原样返回，避免厂商差异下沉到每个调用点。
// 空模型与占位符在此统一短路为 null，调用方无需重复这两项判断。
// 返回的串已是可直接写入选项 currentValue 的形态，上层不再做二次编码。
// provider 比较是精确等值、不做大小写归一，历史 meta 的来源单一因此风险可控。
// null 代表无从恢复，与恢复出空串严格区分，后者会被下游当成有效选中值。
export function resolveRecoveredTaskModelValue(
  taskMeta: Pick<ZCodeTaskMeta, "provider" | "model">,
): string | null {
  const normalizedTaskModel = taskMeta.model?.trim();
  if (!normalizedTaskModel || isSyntheticModelPlaceholder(normalizedTaskModel)) {
    return null;
  }

  if (taskMeta.provider === "glm") {
    return resolveGlmRecoveredTaskModelValue(normalizedTaskModel);
  }

  return normalizedTaskModel;
}

// 展示名优先取自定义编码里的 modelName，其次是 provider 前缀之后的部分，最后才退回原始值。
// 两次解析互相独立，允许其中一个失败，只要另一个成功就能给出可读名称。
// 名称只用于文案，不参与等值比较，因此回退到带前缀的原始串也不影响选中态。
// 这里不做编码归一，避免展示层与取值层使用不同规则造成认知偏差。
function resolveModelOptionName(modelValue: string): string {
  const customModel = decodeCustomModelValue(modelValue);
  const providerQualifiedModel = parseProviderQualifiedModel(modelValue);
  return customModel?.modelName?.trim() || providerQualifiedModel?.modelName || modelValue;
}

function ensureModelOptionValue(
  option: ZCodeConfigOption,
  modelValue: string,
): ZCodeConfigOption {
  const options = option.options ?? [];
  const hasOption = options.some((candidate) => candidate.value === modelValue);
  if (hasOption && option.currentValue === modelValue) {
    return option;
  }

  return {
    ...option,
    currentValue: modelValue,
    options: hasOption
      ? options
      : [
          ...options,
          {
            name: resolveModelOptionName(modelValue),
            value: modelValue,
          },
        ],
  };
}

function createRecoveredModelOption(modelValue: string): ZCodeConfigOption {
  return {
    category: "model",
    currentValue: modelValue,
    id: "model",
    name: "Model",
    options: [
      {
        name: resolveModelOptionName(modelValue),
        value: modelValue,
      },
    ],
    type: "select",
  };
}

function createRecoveredModeOption(modeValue: string): ZCodeConfigOption {
  return {
    category: "mode",
    currentValue: modeValue,
    id: "mode",
    name: "Mode",
    options: getZCodeAgentModeSelectOptions(),
    type: "select",
  };
}

function createRecoveredThoughtLevelOption(thoughtLevel: string): ZCodeConfigOption {
  return {
    category: "thought_level",
    currentValue: thoughtLevel,
    id: "thought_level",
    name: "Effort",
    options: [
      {
        name: thoughtLevel,
        value: thoughtLevel,
      },
    ],
    type: "select",
  };
}

// 与模型版 ensure 的差异只有名称来源：这里直接用值本身作为名称，适用于值即可读的枚举。
// 命中已有选项且 currentValue 已对齐时返回原引用，让调用方能用引用相等判定无变化。
// 未命中时追加新选项并保留原数组顺序，避免已渲染的下拉候选出现跳动。
// 追加产生的是原数组加一项而非去重重建，历史选项的引用保持稳定。
// 不校验值是否属于合法枚举，非法值会在真实 settings 到达后被覆盖。
function ensureSelectOptionCurrentValue(
  option: ZCodeConfigOption,
  value: string,
): ZCodeConfigOption {
  const options = option.options ?? [];
  const hasOption = options.some((candidate) => candidate.value === value);
  if (hasOption && option.currentValue === value) {
    return option;
  }

  return {
    ...option,
    currentValue: value,
    options: hasOption
      ? options
      : [
          ...options,
          {
            name: value,
            value,
          },
        ],
  };
}

// 先算可恢复模型值，拿不到就直接返回 null，把无模型可恢复与无需修改两种结果收进同一契约。
// 遍历时只认 category 为 model 且 type 为 select 的项，其余项原样透传，模式与思考强度不会被顺带改动。
// hasModelOption 与 changed 是两套语义：前者决定要不要合成，后者决定要不要提交新数组。
// 没有任何模型项时在头部合成最小模型项，保证首帧就有选中态，真实配置回填后自然覆盖。
// 有模型项但值已一致时返回 null，避免与工具栏恢复 effect 形成反复提交的循环。
export function mergeRecoveredTaskModelConfigOptions({
  taskMeta,
  configOptions,
}: {
  taskMeta: Pick<ZCodeTaskMeta, "provider" | "model">;
  configOptions: readonly ZCodeConfigOption[];
}): ZCodeConfigOption[] | null {
  const recoveredModelValue = resolveRecoveredTaskModelValue(taskMeta);
  if (!recoveredModelValue) {
    return null;
  }

  let hasModelOption = false;
  let changed = false;
  const nextConfigOptions = configOptions.map((option) => {
    if (option.category !== "model" || option.type !== "select") {
      return option;
    }

    hasModelOption = true;
    const nextOption = ensureModelOptionValue(option, recoveredModelValue);
    changed = changed || nextOption !== option;
    return nextOption;
  });

  if (!hasModelOption) {
    // 历史 task 恢复时，resume/config_option_update 可能晚于首帧渲染。
    // 只清空上一条 task 的配置会让工具栏短暂退回“选择模型”；这里用 task.meta.model
    // 合成最小模型项，先稳定展示持久化模型，真实 configOptions 回来后再覆盖。
    return [createRecoveredModelOption(recoveredModelValue), ...nextConfigOptions];
  }

  // 旧会话恢复时 task.meta.model 可能已经被写回 task 配置。
  // 如果这里在无变化时仍返回新数组，调用方会反复 setTaskConfigOptions，和工具栏恢复 effect 互相触发。
  return changed ? nextConfigOptions : null;
}

export function resolveTaskRestorePreloadConfigOptions({
  taskMeta,
  cachedTaskConfigOptions,
}: {
  taskMeta: Pick<ZCodeTaskMeta, "provider" | "model"> &
    Partial<Pick<ZCodeTaskMeta, "mode" | "thoughtLevel">>;
  cachedTaskConfigOptions?: readonly ZCodeConfigOption[];
}): ZCodeConfigOption[] {
  let cachedOptions = [...(cachedTaskConfigOptions ?? [])];
  const recoveredOptions = mergeRecoveredTaskModelConfigOptions({
    taskMeta,
    configOptions: cachedOptions,
  });

  if (recoveredOptions) {
    cachedOptions = recoveredOptions;
  }

  // mode 回显只在 glm 且 meta 值 trim 后非空时触发，其它 provider 的 mode 由真实 settings 决定，不能凭空合成。
  // 遍历同样只认 mode 与 select 组合，命中后替换为把 currentValue 对齐的新项。
  // 没有 mode 项时合成项插到头部而非尾部，工具栏按数组顺序决定哪一项先占位渲染。
  // 合成项的下拉候选取自共享的 agent mode 列表，保证与真实 settings 回填后的视觉一致。
  // 此处只决定显示哪一项，不校验该 mode 在当前模型下是否合法，合法性留给后续 settings。
  const mode = taskMeta.mode?.trim();
  if (taskMeta.provider === "glm" && mode) {
    let hasModeOption = false;
    cachedOptions = cachedOptions.map((option) => {
      if (option.category !== "mode" || option.type !== "select") {
        return option;
      }
      hasModeOption = true;
      return ensureSelectOptionCurrentValue(option, mode);
    });
    if (!hasModeOption) {
      // 定时任务触发出的 task 在真实 settings 回来前，composer 只能拿到 task meta。
      // 这里从 meta 合成最小 mode option，避免权限入口短暂显示 workspace 默认值。
      cachedOptions = [createRecoveredModeOption(mode), ...cachedOptions];
    }
  }

  const thoughtLevel = taskMeta.thoughtLevel?.trim();
  if (taskMeta.provider === "glm" && thoughtLevel) {
    let hasThoughtOption = false;
    cachedOptions = cachedOptions.map((option) => {
      if (option.category !== "thought_level" || option.type !== "select") {
        return option;
      }
      hasThoughtOption = true;
      return ensureSelectOptionCurrentValue(option, thoughtLevel);
    });
    if (!hasThoughtOption) {
      // 和 mode 一样，automation task-local thoughtLevel 需要先从 task meta 回显；
      // 后续 session settings 会补齐该模型支持的完整 thought options。
      cachedOptions = [...cachedOptions, createRecoveredThoughtLevelOption(thoughtLevel)];
    }
  }

  // 历史 task 已经打开过时，taskConfigOptionsByTaskId 里有完整的
  // model/mode/thought_level。恢复期如果只因为 task.meta.model 缺失就清空，
  // 工具栏会先隐藏 mode/thought，等新快照回来后再出现；这里保留 task 级缓存，
  // 真正的新 settings 缺项时再由 setTaskConfigOptions 覆盖并隐藏。
  return cachedOptions;
}

export function mergeGlmRecoveredTaskModelConfigOptions({
  taskMeta,
  configOptions,
}: {
  taskMeta: Pick<ZCodeTaskMeta, "provider" | "model">;
  configOptions: readonly ZCodeConfigOption[];
}): ZCodeConfigOption[] | null {
  if (taskMeta.provider !== "glm") {
    return null;
  }

  return mergeRecoveredTaskModelConfigOptions({ taskMeta, configOptions });
}
