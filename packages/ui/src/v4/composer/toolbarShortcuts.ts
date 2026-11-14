// INV-01 只处理工具条三条命令：守住位置 candidates 表；改错故障 抢占其他区域的快捷键。
// INV-02 修饰键精确匹配：守住位置 matchesShortcutBinding；改错故障 Ctrl+M 也命中 Ctrl+Shift+M。
// INV-03 任一前置条件不满足即整体退出：守住位置 开头早退；改错故障 禁用态仍能打开模型菜单。
// INV-04 defaultPrevented 与 repeat 必须尊重：守住位置 早退判断；改错故障 与上层监听重复触发。
// INV-05 输入法组合态不响应：守住位置 isComposing；改错故障 中文输入中按 m 就开菜单。
// INV-06 选项归属必须与命令一致：守住位置 getChatToolbarShortcutKey 比对；改错故障 用模型选项去切思考深度。
// INV-07 同一命令可绑多个键位：守住位置 内层绑定循环；改错故障 只认第一个绑定。
// INV-08 候选顺序即优先级：守住位置 candidates 数组顺序；改错故障 键位重叠时行为随机。
// INV-09 录制态键盘归录制器独占：守住位置 isShortcutRecordingActive 早退；改错故障 改键时按键真的触发了动作。
// INV-10 生效表通过 ref 读取：守住位置 effectiveRef；改错故障 改绑后必须重建监听才生效。
// INV-11 监听挂在 capture 阶段并成对移除：守住位置 addEventListener 第三参；改错故障 监听泄漏或抢在录制器之前。
// INV-12 诊断日志只在确实绑定了该命令时打：守住位置 openModelMenuBound；改错故障 改绑后按旧键刷日志。
// INV-13 命中后必须 preventDefault：守住位置 动作分发之前；改错故障 浏览器默认行为与工具条动作叠加。
//
// 模块职责：V4 composer 工具条热键的动作解析与 window 级监听装配。
// 阅读顺序：先看纯函数解析的三层过滤，再看 hook 的监听与诊断日志。
/**
 * V4 composer 工具条键盘热键（composer parity）。
 *
 * 判定为纯逻辑（无 store / 协议依赖，仅消费 config 目录选项与回调）。
 * 绑定处的回调只修改 Composer：
 * - Ctrl+M        → 打开模型菜单（openRequestKey 递增，ModelConfigSelect 消费）
 * - Ctrl+Shift+M  → 循环下一次 Submission 的模式
 * - Ctrl+T        → 循环下一次 Submission 的思考深度
 *
 * 三条热键已转正为命令表命令（openModelMenu / cycleSessionMode /
 * cycleThoughtLevel，window 通道全局作用域），键位匹配读生效表，可在设置页改绑；
 * 默认键位保持既有行为，零变化。
 */
import { useEffect, useRef } from "react";
import type { ShortcutCommandId, ZCodeConfigOption } from "@zcode/shared";
import {
  isShortcutRecordingActive,
  matchesShortcutBinding,
  type EffectiveShortcutBindings,
} from "@/shortcuts/bindings.js";
import { useEffectiveShortcutBindings } from "@/shortcuts/useShortcutBindings.js";
import { logger } from "@/logger.js";

type ChatToolbarShortcutKey = "m" | "ctrlShiftM" | "t" | null;

/** 旧 chatInputControlShortcuts.getChatToolbarShortcutKey 原样恢复。 */
export function getChatToolbarShortcutKey(
  category: ZCodeConfigOption["category"],
): ChatToolbarShortcutKey {
  switch (category) {
    case "model":
      return "m";
    case "mode":
      return "ctrlShiftM";
    case "thought_level":
      return "t";
    default:
      return null;
  }
}

/** 计算 select 选项的下一次循环取值（模式循环用）。 */
// 只有 select 且有选项才可循环，其余类型返回 null。
// currentValue 不在 options 里时 getNextConfigSelectValue 从第一项开始，而不是返回 null 报错。
// 取不到下一项时返回 null，调用方据此跳过本次切换。
export function getNextConfigSelectValue(
  option: Pick<ZCodeConfigOption, "type" | "currentValue" | "options">,
): string | null {
  if (option.type !== "select" || !option.options?.length) {
    return null;
  }

  const currentValue = String(option.currentValue);
  const currentIndex = option.options.findIndex((candidate) => candidate.value === currentValue);
  const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % option.options.length;

  return option.options[nextIndex]?.value ?? null;
}

interface ToolbarShortcutKeyboardEvent {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  repeat: boolean;
  isComposing: boolean;
}

interface ToolbarShortcutState {
  hasAnyOption: boolean;
  toolbarDisabled: boolean;
  modelMenuDisabled: boolean;
  modelOption?: ZCodeConfigOption;
  modeOption?: ZCodeConfigOption;
  thoughtOption?: ZCodeConfigOption;
}

type ToolbarShortcutAction = "openModelMenu" | "cycleSessionMode" | "cycleThoughtLevel";

/**
 * 按生效表解析工具条动作（工具条热键转正为可配置命令）。
 * 键位匹配走内核（命令表 + matcher，修饰精确匹配，与旧 matchesCtrlShortcut 系列
 * 对 "Ctrl+m" / "Ctrl+Shift+m" / "Ctrl+t" 的语义一致）；原 option 归属与 disabled
 * 门控保持不变。事件与生效表由调用方传入，纯函数可独立单测。
 */
export function resolveToolbarShortcutAction(
  event: ToolbarShortcutKeyboardEvent,
  effective: EffectiveShortcutBindings,
  {
    hasAnyOption,
    toolbarDisabled,
    modelMenuDisabled,
    modelOption,
    modeOption,
    thoughtOption,
  }: ToolbarShortcutState,
): ToolbarShortcutAction | null {
  if (
    // hasAnyOption 为假时直接 return null，没有可选项整条匹配链都没有意义。
    // 组合键的修饰键由 matcher 精确比较，这里不重复判定。
    // 正在输入法与长按重复都不响应。
    !hasAnyOption ||
    toolbarDisabled ||
    event.defaultPrevented ||
    event.repeat ||
    event.isComposing
  ) {
    return null;
  }

  // 顺序即优先级：模型菜单先于模式，模式先于思考深度。
  // 每个候选同时绑定命令 id 与旧的热键归属键，便于迁移期对齐。
  // disabled 只对模型菜单生效，其余两个由 toolbarDisabled 统一管。
  // expectedKey 必须与 getChatToolbarShortcutKey 的返回值一致。
  const candidates: ReadonlyArray<{
    action: ToolbarShortcutAction;
    commandId: ShortcutCommandId;
    expectedKey: ChatToolbarShortcutKey;
    option?: ZCodeConfigOption;
    disabled?: boolean;
  }> = [
    {
      action: "openModelMenu",
      commandId: "openModelMenu",
      expectedKey: "m",
      option: modelOption,
      disabled: modelMenuDisabled,
    },
    {
      action: "cycleSessionMode",
      commandId: "cycleSessionMode",
      expectedKey: "ctrlShiftM",
      option: modeOption,
    },
    {
      action: "cycleThoughtLevel",
      commandId: "cycleThoughtLevel",
      expectedKey: "t",
      option: thoughtOption,
    },
  ];

  for (const candidate of candidates) {
    // candidate.disabled 为真就 continue，禁用项不参与后续的 category 匹配。
    if (candidate.disabled) {
      continue;
    }
    if (!candidate.option || getChatToolbarShortcutKey(candidate.option.category) !== candidate.expectedKey) {
      continue;
    }
    for (const binding of effective[candidate.commandId] ?? []) {
      if (matchesShortcutBinding(event, binding)) {
        return candidate.action;
      }
    }
  }

  return null;
}

export function useToolbarShortcutBindings(params: {
  hasAnyOption: boolean;
  toolbarDisabled: boolean;
  modelMenuDisabled: boolean;
  modelOption?: ZCodeConfigOption;
  modeOption?: ZCodeConfigOption;
  thoughtOption?: ZCodeConfigOption;
  onOpenModelMenu: () => void;
  /** Ctrl+Shift+M：参考 thought level，按选项顺序快速切换会话模式，不打开菜单。 */
  onCycleSessionMode: () => void;
  /** Ctrl+T：保留 thought level 快速切换，不受默认 select 菜单交互影响。 */
  onCycleThoughtLevel: () => void;
}) {
  const {
    hasAnyOption,
    toolbarDisabled,
    modelMenuDisabled,
    modelOption,
    modeOption,
    thoughtOption,
    onOpenModelMenu,
    onCycleSessionMode,
    onCycleThoughtLevel,
  } = params;
  // 工具条热键已转正为命令表命令，键位匹配读生效表——设置页改绑后即时生效
  // 生效表可能随设置页改绑变化，必须每次渲染同步到 ref。
  // 监听只注册一次，匹配时读 ref 里的最新表。
  const effectiveBindings = useEffectiveShortcutBindings();
  const effectiveRef = useRef(effectiveBindings);
  effectiveRef.current = effectiveBindings;

  useEffect(() => {
    if (!hasAnyOption) {
      return;
    }

    function handleWindowKeydown(event: KeyboardEvent) {
      // 录制态键盘归录制器独占。本监听先于录制监听注册（同 capture 阶段），
      // 不短路的话录制期按键预览会真的触发工具条动作。
      // isShortcutRecordingActive 为真时按键只给录制器采集，工具条动作一律不触发。
      // 录制态判断必须放在 handleWindowKeydown 的第一行，早于任何匹配与诊断日志。
      if (isShortcutRecordingActive()) {
        return;
      }
      // Windows/Linux 上 Cmd/Ctrl+P 已由 useAppKeyboard 用于「搜索
      // 文件」，与工具栏旧版 ⌃P 同类按键冲突。模式切换改为 Ctrl+Shift+M，仍尊重
      // defaultPrevented，避免与其它捕获阶段快捷键重复处理。
      const state = {
        hasAnyOption,
        toolbarDisabled,
        modelMenuDisabled,
        modelOption,
        modeOption,
        thoughtOption,
      };
      const action = resolveToolbarShortcutAction(event, effectiveRef.current, state);
      if (!action) {
        // 诊断日志与生效表解耦——只在按下的键确实绑定了 openModelMenu 时才打
        // 「未打开模型菜单」（改绑后按旧键不应误打，改绑后的新键失败不再无日志）。
        const openModelMenuBound = (effectiveRef.current.openModelMenu ?? []).some((binding) =>
          matchesShortcutBinding(event, binding),
        );
        if (openModelMenuBound) {
          logger.debug("[V4ComposerToolbar] 模型菜单热键未打开模型菜单", {
            hasModelOption: Boolean(modelOption),
            shortcutKey: getChatToolbarShortcutKey(modelOption?.category),
            modelMenuDisabled,
          });
        }
        return;
      }

      // 命中才阻止默认行为，未命中保持浏览器原有处理。
      // 顺序是先阻止再分发，避免回调里再操作事件。
      event.preventDefault();
      if (action === "openModelMenu") {
        logger.debug("[V4ComposerToolbar] Ctrl+M 打开模型菜单");
        onOpenModelMenu();
        return;
      }

      if (action === "cycleSessionMode") {
        onCycleSessionMode();
        return;
      }

      if (action === "cycleThoughtLevel") {
        onCycleThoughtLevel();
      }
    }

    window.addEventListener("keydown", handleWindowKeydown, true);
    return () => {
      window.removeEventListener("keydown", handleWindowKeydown, true);
    };
  }, [
    hasAnyOption,
    toolbarDisabled,
    modelMenuDisabled,
    modeOption,
    modelOption,
    onOpenModelMenu,
    onCycleSessionMode,
    onCycleThoughtLevel,
    thoughtOption,
  ]);
}
