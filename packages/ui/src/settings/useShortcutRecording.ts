// INV-01 仅录制态监听：守住位置 useEffect 的 recording 早退；改错故障 普通输入被吞键。
// INV-02 捕获阶段拦截：守住位置 addEventListener 第三参 true；改错故障 组件先处理按键，录制不到。
// INV-03 监听随录制态收放：守住位置 依赖数组含 recording；改错故障 结束后仍抢占键盘。
// INV-04 Escape 取消：守住位置 第一个按键分支；改错故障 无法退出录制。
// INV-05 Backspace 恢复默认：守住位置 clearBinding 调用；改错故障 用户只能逐条删。
// INV-06 未完成组合保留预览：守住位置 pending 分支；改错故障 按下修饰键就丢失已录内容。
// INV-07 无效组合转错误文案：守住位置 invalid 分支；改错故障 界面无反馈，像没响应。
// INV-08 同命令重复直接拒绝：守住位置 duplicate 判定；改错故障 一个命令挂两组相同键。
// INV-09 replace 跳过目标条：守住位置 index === bindingIndex；改错故障 原位重录被判为重复。
// INV-10 冲突检查区分保留与占用：守住位置 conflict.kind；改错故障 系统键被允许抢绑。
// INV-11 Web 端菜单键按保留处理：守住位置 menuChannelReserved；改错故障 Web 抢走菜单快捷键。
// INV-12 落盘按模式分派：守住位置 mode 与 bindingIndex 判断；改错故障 替换变成追加。
// INV-13 监听必须解绑：守住位置 cleanup；改错故障 多次进入录制后重复写入绑定。
// INV-14 依赖完整：守住位置 依赖数组；改错故障 闭包拿到过期绑定表。
//
// 模块职责：快捷键录制态下的键盘捕获与冲突校验，把结果写回绑定表。
// 阅读顺序：先看录制早退与按键分派，再看重复与冲突拒绝，最后看落盘分支。
import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ShortcutCommandId } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { checkShortcutBindingConflict, isSamePhysicalBinding } from "@/shortcuts/conflicts.js";
import { formatShortcutBindingLabel } from "@/shortcuts/label.js";
import { recordShortcutBinding, type EffectiveShortcutBindings } from "@/shortcuts/bindings.js";
import type { RecordingState } from "./ShortcutBindingRow.js";

interface UseShortcutRecordingOptions {
  recording: RecordingState | null;
  setRecording: Dispatch<SetStateAction<RecordingState | null>>;
  /** 生效绑定表（Section 已按 overrides resolve）。 */
  effective: EffectiveShortcutBindings;
  overrides: Record<string, readonly string[]> | undefined;
  isDesktop: boolean;
  /** 录制态 Backspace：恢复默认（Section 的预检逻辑）。 */
  clearBinding: (commandId: ShortcutCommandId) => void;
  appendBinding: (commandId: ShortcutCommandId, binding: string) => void;
  replaceBindingAt: (commandId: ShortcutCommandId, bindingIndex: number, binding: string) => void;
}

/**
 * 录制态键盘捕获：window keydown capture。Escape 取消；Backspace 恢复默认；
 * 其余交给内核录制器。落盘按 RecordingState.mode 分派：add → 追加一条；replace → 替换
 * bindingIndex 指向的条（null = 未分配占位行录第一条，等价追加）。
 * 同命令物理等价重复在录制入口标红拒绝（add 比全部条目，replace 跳过目标条）。
 */
// hook 只负责录制，不持有绑定事实。
export function useShortcutRecording({
  recording,
  setRecording,
  effective,
  overrides,
  isDesktop,
  clearBinding,
  appendBinding,
  replaceBindingAt,
}: UseShortcutRecordingOptions): void {
  const { intl } = useZCodeIntl();

  useEffect(() => {
    // recording 为 false 时不挂 window keydown 监听。
    if (!recording) {
      return;
    }
    // 录制期间 handleRecordingKeydown 先 preventDefault 再解析。
    function handleRecordingKeydown(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();

      setRecording((current) => {
        if (!current) {
          return current;
        }
        // Escape 只调 cancelRecording，不改动已有绑定。
        if (event.key === "Escape") {
          return null;
        }
        // Backspace 恢复该 commandId 的默认键位。
        if (event.key === "Backspace") {
          clearBinding(current.commandId);
          return null;
        }

        // 组合判定交给 recordShortcutBinding，本层不做键位解析。
        const result = recordShortcutBinding(event);
        // 组合未完成时清掉上一次提示。
        if (result.kind === "pending") {
          // 残留的冲突/无效提示会让人以为录制器没在听新按键 —— 修饰键按下即刻清空，
          // 保证「冲突后直接重按第二组组合」在视觉上是活的（实际本来就一直监听着）。
          if (
            current.preview === null &&
            current.error === null &&
            current.conflictBinding === null
          ) {
            return current;
          }
          return { ...current, preview: null, error: null, conflictBinding: null };
        }
        // 无效组合按原因给出不同文案。
        if (result.kind === "invalid") {
          return {
            ...current,
            preview: null,
            conflictBinding: null,
            error: intl.formatMessage({
              id:
                result.reason === "no-modifier"
                  ? "settings.shortcuts.invalidNoModifier"
                  : "settings.shortcuts.invalidKey",
            }),
          };
        }

        // 同命令物理等价重复：add 与全部生效条目比；replace 跳过正在替换的
        // 目标条。一个命令挂同一组键没有意义，直接标红拒绝。
        // 只与 effective[commandId] 比较，跨命令同键不算冲突。
        const sameCommandBindings = effective[current.commandId] ?? [];
        const duplicate = sameCommandBindings.some((binding, index) =>
          current.mode === "replace" && index === current.bindingIndex
            ? false
            : isSamePhysicalBinding(binding, result.binding),
        );
        // 重复组合同样只标红，不落盘。
        if (duplicate) {
          return {
            ...current,
            preview: formatShortcutBindingLabel(result.binding),
            conflictBinding: null,
            error: intl.formatMessage({ id: "settings.shortcuts.duplicateBinding" }),
          };
        }

        // Web 端 menu 通道命令不可配置但默认键仍被根级回退监听消费，按保留键拒绝抢绑
        const conflict = checkShortcutBindingConflict(
          current.commandId,
          result.binding,
          overrides,
          {
            menuChannelReserved: !isDesktop,
          },
        );
        // 冲突分支保留预览以便用户改按。
        if (conflict) {
          return {
            ...current,
            preview: formatShortcutBindingLabel(result.binding),
            // 系统保留键直接拒绝（无确认入口）；app 内命令占用提示占用者并支持二次确认抢绑
            conflictBinding: conflict.kind === "occupied" ? result.binding : null,
            error:
              conflict.kind === "reserved"
                ? intl.formatMessage({ id: "settings.shortcuts.conflictReserved" })
                : intl.formatMessage(
                    { id: "settings.shortcuts.conflictOccupied" },
                    {
                      command:
                        conflict.ownerCommandId !== undefined
                          ? intl.formatMessage({
                              id: `settings.shortcuts.command.${conflict.ownerCommandId}`,
                            })
                          : "",
                    },
                  ),
          };
        }

        // mode === "add" 或 bindingIndex === null 时录制等价于追加。
        if (current.mode === "add" || current.bindingIndex === null) {
          appendBinding(current.commandId, result.binding);
        } else {
          replaceBindingAt(current.commandId, current.bindingIndex, result.binding);
        }
        return null;
      });
    }

    // 捕获阶段注册，先于业务组件。
    window.addEventListener("keydown", handleRecordingKeydown, true);
    return () => {
      window.removeEventListener("keydown", handleRecordingKeydown, true);
    };
  }, [
    appendBinding,
    clearBinding,
    effective,
    intl,
    isDesktop,
    overrides,
    recording,
    replaceBindingAt,
    setRecording,
  ]);
}
