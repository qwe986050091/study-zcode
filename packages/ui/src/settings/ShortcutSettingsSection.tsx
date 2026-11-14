// INV-01 单行多绑定按数组存：守住位置 effective 条目为数组；改错故障 一个命令只剩一键可改。
// INV-02 覆盖优先于默认：守住位置 resolveEffectiveShortcutBindings；改错故障 改键后仍显示默认键。
// INV-03 保存必须串行：守住位置 savingRef 判断；改错故障 连点产生乱序写入。
// INV-04 保存态禁用全部入口：守住位置 saving 标志；改错故障 保存期间重复提交。
// INV-05 保存失败可见：守住位置 catch 内置错误态；改错故障 失败后界面无任何反馈。
// INV-06 追加与替换分层：守住位置 两个构建器分别调用；改错故障 多绑定被整组覆盖。
// INV-07 抢绑保留行级语义：守住位置 stealBinding 传入录制模式；改错故障 抢绑删掉同命令其余绑定。
// INV-08 清除与恢复默认不同：守住位置 clearAllBindings 写空数组；改错故障 清除后回落到默认键。
// INV-09 恢复默认遇占用只提示：守住位置 conflict 分支；改错故障 静默清掉他人绑定。
// INV-10 恢复默认删除覆盖条目：守住位置 delete 操作；改错故障 覆盖条目残留成空数组。
// INV-11 全部恢复需二次确认：守住位置 requestConfirmation；改错故障 一键清空所有自定义键位。
// INV-12 录制期键盘独占：守住位置 keyboardExclusive 判断；改错故障 录制组合键先触发原命令。
// INV-13 双通道同时关闭：守住位置 内核标记与菜单摘除；改错故障 macOS 菜单先吃掉按键。
// INV-14 卸载即解除独占：守住位置 effect 清理函数；改错故障 离开设置页后按键失灵。
// INV-15 录制与按键搜索互斥：守住位置 武装前清空录制；改错故障 两套监听互相吞键。
// INV-16 隐藏命令仍参与冲突：守住位置 过滤只影响展示；改错故障 隐藏命令的键位被误判空闲。
// INV-17 搜索按物理等价匹配：守住位置 isSamePhysicalBinding；改错故障 等价组合搜不到。
// INV-18 本组件不实现键位语义：守住位置 全部委托 shortcuts 内核；改错故障 判定口径分叉。
//
// 模块职责：快捷键设置分区，展示命令表并提供录制、冲突与重置入口。
// 状态所有权：覆盖数据归设置服务；录制态与搜索态为本组件局部状态。
// 阅读顺序：先看过滤与保存，再读四种写入语义，最后看键盘独占与渲染。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import {
  SHORTCUT_COMMANDS,
  getDefaultShortcutBindings,
  type ShortcutCommandId,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  buildShortcutOverridesAfterAppend,
  buildShortcutOverridesAfterSteal,
  buildShortcutOverridesWithBindingAt,
  checkShortcutBindingConflict,
  isSamePhysicalBinding,
} from "@/shortcuts/conflicts.js";
import { formatShortcutBindingLabel } from "@/shortcuts/label.js";
import {
  resolveEffectiveShortcutBindings,
  setShortcutRecordingActive,
} from "@/shortcuts/bindings.js";
import { ShortcutBindingRow, type RecordingState } from "@/settings/ShortcutBindingRow.js";
import { ShortcutSearchBar } from "@/settings/ShortcutSearchBar.js";
import { useShortcutKeySearch } from "@/settings/useShortcutKeySearch.js";
import { useShortcutRecording } from "@/settings/useShortcutRecording.js";

/**
 * 快捷键设置分区：命令表只读展示 + 键盘录入 + 冲突处理。
 * 只读写 shortcutBindings 覆盖数据，键位语义（匹配/录制/冲突/抢绑）全部经 shortcuts 内核。
 * 系统保留键直接拒绝；app 内命令占用提示占用者并支持二次确认抢绑。
 * 单行多绑定：一个命令一行，多组键帽在键位列纵向排列；每条可替换/删除，
 * 命令级「+」追加；同命令物理等价重复在录制入口拒绝。
 */
export function ShortcutSettingsSection({ isDesktop = false }: { isDesktop?: boolean }) {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  const platform = usePlatform();
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<RecordingState | null>(null);
  const keySearch = useShortcutKeySearch();
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const overrides = settings?.shortcutBindings;
  const effective = useMemo(() => resolveEffectiveShortcutBindings(overrides), [overrides]);
  const commandLabel = useCallback(
    (commandId: ShortcutCommandId) =>
      intl.formatMessage({ id: `settings.shortcuts.command.${commandId}` }),
    [intl],
  );

  const visibleCommands = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    // 取局部变量：some 回调闭包里 TS 无法保持 keySearch.binding 的非空收窄
    const keyBinding = keySearch.binding;
    return SHORTCUT_COMMANDS.filter((entry) => {
      // 这些快捷键保留注册和冲突检测，但不在用户可见列表中展示。
      if (entry.id === "openOnboarding" || entry.id === "toggleInterfaceMode") return false;
      // 完整视图只在桌面端提供，Web 没有处理器，不展示无效的改键入口。
      if (entry.id === "toggleSidePaneFullView" && !isDesktop) return false;
      const matchesText =
        !keyword ||
        entry.id.toLowerCase().includes(keyword) ||
        commandLabel(entry.id).toLowerCase().includes(keyword);
      // 按键过滤走冲突检测的物理等价口径（win 的 Ctrl+m ≡ CmdOrCtrl+m），
      // 与「这组键占了谁」的冲突提示看到的是同一张表。
      const matchesKey =
        keyBinding === null ||
        (effective[entry.id] ?? []).some((binding) => isSamePhysicalBinding(binding, keyBinding));
      return matchesText && matchesKey;
    });
  }, [commandLabel, effective, isDesktop, keySearch.binding, query]);

  // persistBindings 用 savingRef 挡住重入，同时把 saving 置真禁用入口；写入前先清 recording，避免录制态跟着旧值走。
  // update 抛错只置 saveFailed 不向外抛；finally 释放 savingRef 与 saving，权威快照等设置服务回推。
  const persistBindings = useCallback(
    async (next: Record<string, string[]>) => {
      if (savingRef.current) {
        return;
      }
      // 原因：仅用 ref 拦截会静默丢弃后续点击；保存态同步禁用入口，直到权威快照刷新完成。
      savingRef.current = true;
      setSaving(true);
      setSaveFailed(false);
      setRecording(null);
      try {
        await update({ shortcutBindings: next });
      } catch (error) {
        logger.error("[shortcuts] 保存快捷键绑定失败", { error: String(error) });
        setSaveFailed(true);
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [update],
  );

  /** 追加一条（占位行录第一条也走这里：生效列表为空时等价于写入第一条）。 */
  const appendBinding = useCallback(
    (commandId: ShortcutCommandId, binding: string) => {
      void persistBindings(buildShortcutOverridesAfterAppend(overrides, commandId, binding));
    },
    [overrides, persistBindings],
  );

  /** 替换生效列表第 bindingIndex 条（覆盖整组替换语义，须写完整生效列表）。 */
  const replaceBindingAt = useCallback(
    (commandId: ShortcutCommandId, bindingIndex: number, binding: string) => {
      void persistBindings(
        buildShortcutOverridesWithBindingAt(overrides, commandId, bindingIndex, binding),
      );
    },
    [overrides, persistBindings],
  );

  /**
   * 二次确认后的抢绑：目标命令按录制时的行级语义写入新键（replace 指定条 / 未分配录
   * 第一条 → append），并从占用命令移除冲突键。抢绑只改变冲突处理方式，不改变用户
   * 原本选择的行级操作（多绑定命令抢绑不得静默删除其余绑定）。
   */
  // stealBinding 只改冲突处理方式：按 recording.mode 与 bindingIndex 走 replace / append，再经 persistBindings 退出录制。
  const stealBinding = useCallback(
    (commandId: ShortcutCommandId, binding: string) => {
      const next = buildShortcutOverridesAfterSteal(overrides, commandId, binding, {
        mode: recording?.mode,
        bindingIndex: recording?.bindingIndex,
      });
      void persistBindings(next);
    },
    [overrides, persistBindings, recording],
  );

  /** 操作列垃圾桶「清除」= 清空该命令全部绑定 = 未分配：覆盖写显式空数组，不回退默认
   * （含 menu 通道 accelerator 摘除）。与录制态 Backspace 的「恢复默认」是两个语义。 */
  const clearAllBindings = useCallback(
    (commandId: ShortcutCommandId) => {
      void persistBindings({ ...overrides, [commandId]: [] });
    },
    [overrides, persistBindings],
  );

  /**
   * 录制态 Backspace「恢复默认」= 删除覆盖条目。默认键被同作用域其他命令占用
   * （含物理等价，如 win 的 Ctrl+m ≡ CmdOrCtrl+m）时提示冲突且不落盘——恢复默认与录制
   * 是同一不变量（一键一命令）的两个入口；按用户口径只提示不自动清占用方。
   */
  const clearBinding = useCallback(
    (commandId: ShortcutCommandId) => {
      if (overrides?.[commandId] === undefined) {
        return;
      }
      const defaultBinding = getDefaultShortcutBindings(commandId)[0];
      if (defaultBinding) {
        const conflict = checkShortcutBindingConflict(commandId, defaultBinding, overrides, {
          menuChannelReserved: !isDesktop,
        });
        if (conflict?.kind === "occupied" && conflict.ownerCommandId) {
          toast(
            intl.formatMessage(
              { id: "settings.shortcuts.clearConflict" },
              { command: commandLabel(conflict.ownerCommandId) },
            ),
          );
          return;
        }
      }
      const next = { ...overrides };
      delete next[commandId];
      void persistBindings(next);
    },
    [overrides, persistBindings, isDesktop, intl, commandLabel],
  );

  // 「全部恢复默认」是破坏性操作（清空全部自定义键位覆盖），复用全局确认弹窗（Promise 式）防一键误触
  // 只有 overrides 非空才弹；取消不写、确认才 persistBindings({})，默认键位表不在覆盖里所以不受影响。
  const requestConfirmation = useConfirmDialogStore((state) => state.requestConfirmation);
  const resetAll = useCallback(async () => {
    if (!overrides || Object.keys(overrides).length === 0) {
      return;
    }
    const confirmed = await requestConfirmation({
      confirmVariant: "destructive",
      title: intl.formatMessage({ id: "settings.shortcuts.resetAllConfirmTitle" }),
      description: intl.formatMessage({ id: "settings.shortcuts.resetAllConfirmDescription" }),
    });
    if (confirmed) {
      void persistBindings({});
    }
  }, [overrides, persistBindings, requestConfirmation, intl]);

  // 录制态抑制：录制监听注册晚于 useAppKeyboard 的 capture 监听（同阶段先注册先执行），
  // 不抑制的话录制按下的组合会先触发原命令，改键永远不成功。
  // renderer 通道靠内核标记短路 useAppKeyboard；menu 通道靠 main 摘除菜单 accelerator
  // （macOS 系统菜单先于 renderer 吃键，preventDefault 拦不住）。
  // 按键搜索武装态复用同一套键盘独占（同样是显式意图下捕获组合键，不触发命令）。
  // keyboardExclusive 由 recording 与 keySearch.armed 合成；effect 只做 setShortcutRecordingActive 的双向复位且无渲染输出，依赖只有这两项与 platform。
  const keyboardExclusive = recording !== null || keySearch.armed;
  useEffect(() => {
    if (!keyboardExclusive) {
      return;
    }
    setShortcutRecordingActive(true);
    platform.setShortcutRecordingActive?.(true);
    return () => {
      setShortcutRecordingActive(false);
      platform.setShortcutRecordingActive?.(false);
    };
  }, [keyboardExclusive, platform]);

  useShortcutRecording({
    recording,
    setRecording,
    effective,
    overrides,
    isDesktop,
    clearBinding,
    appendBinding,
    replaceBindingAt,
  });

  const recordingCommandId = recording?.commandId ?? null;

  return (
    <div className="min-w-0 space-y-6" aria-busy={saving} data-testid="settings-shortcuts-section">
      <ShortcutSearchBar
        query={query}
        onQueryChange={setQuery}
        keySearch={keySearch}
        // 与行内录制互斥：武装前取消进行中的录制，两套 window capture 监听不并存
        onArmKeySearch={() => setRecording(null)}
        actions={
          <Button
            variant="outline"
            onClick={resetAll}
            disabled={saving || !settings || !overrides || Object.keys(overrides).length === 0}
            data-testid="settings-shortcut-reset-all"
          >
            <RotateCcw className="size-3.5" />
            {intl.formatMessage({ id: saving ? "common.saving" : "settings.shortcuts.resetAll" })}
          </Button>
        }
      />

      {saveFailed ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive"
          data-testid="settings-shortcut-save-error"
        >
          {intl.formatMessage({ id: "settings.shortcuts.saveFailed" })}
        </div>
      ) : null}
      <div className="min-w-0 rounded-xl border border-card-border">
        <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_80px_40px] rounded-t-xl bg-surface sm:grid px-4 py-3 text-ui-sm text-foreground-subtle">
          <span>{intl.formatMessage({ id: "settings.shortcuts.columnHeaderCommand" })}</span>
          <span>{intl.formatMessage({ id: "settings.shortcuts.columnHeaderBinding" })}</span>
          <span>{intl.formatMessage({ id: "settings.shortcuts.columnHeaderScope" })}</span>
          <span>{intl.formatMessage({ id: "settings.shortcuts.columnHeaderActions" })}</span>
        </div>
        {visibleCommands.map((entry) => (
          <ShortcutBindingRow
            key={entry.id}
            entry={entry}
            commandLabel={commandLabel(entry.id)}
            bindings={effective[entry.id] ?? []}
            saving={saving || !settings}
            isOverridden={overrides?.[entry.id] !== undefined}
            isRecording={recordingCommandId === entry.id}
            recording={recording}
            menuChannelUnavailable={entry.channel === "menu" && !isDesktop}
            onRecord={(bindingIndex) => {
              // 行内录制与按键搜索武装态互斥：两套 window capture 监听并存会互相吞键
              keySearch.disarm();
              setRecording({
                commandId: entry.id,
                mode: "replace",
                bindingIndex,
                preview: null,
                error: null,
                conflictBinding: null,
              });
            }}
            onSteal={(binding) => {
              stealBinding(entry.id, binding);
              setRecording(null);
            }}
            onClearAll={() => clearAllBindings(entry.id)}
          />
        ))}
        {visibleCommands.length === 0 ? (
          <div
            className="border-t border-border px-4 py-8 text-center text-ui-sm text-foreground-subtle"
            data-testid="settings-shortcut-search-empty"
          >
            {keySearch.binding !== null
              ? intl.formatMessage(
                  { id: "settings.shortcuts.keySearchEmpty" },
                  { keys: formatShortcutBindingLabel(keySearch.binding) },
                )
              : intl.formatMessage({ id: "settings.shortcuts.searchEmpty" })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
