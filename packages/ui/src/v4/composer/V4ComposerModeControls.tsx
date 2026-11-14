// INV-01 [契约] 本组件只改写草稿、不下发运行时切换命令；守住位置：文件末尾 memo 包裹的 V4ComposerModeSwitchImpl 与 onSwitchMode 这个唯一出口；改错故障：直接调运行时会让受控草稿与真实会话模式分叉。
// INV-02 [契约] props 只从 V4ComposerToolbarProps 中挑字段，不做整包透传；守住位置：V4ComposerModeSwitchImpl 参数上的 Pick 泛型与字段清单；改错故障：透传整个工具栏 props 后任意无关字段变动都会触发本组件重渲染。
// INV-03 [资源] provider 缺省要回落到 ZCODE_AGENT_PROVIDER 才能查文案表；守住位置：displayProvider 的空值合并行；改错故障：缺省时以空值查模式标签与说明，菜单出现空白项。
// INV-04 [契约] 候选模式必须每次现取，不能在模块级缓存；守住位置：函数体内 modes 的赋值行与 modeOption 内的二次调用；改错故障：缓存后能力集变化不生效，菜单缺少新权限项。
// INV-05 [权衡] permissions 必须排除 plan，因为 Plan 已改为独立勾选项；守住位置：permissions 的 filter 条件 mode.id !== "plan"；改错故障：Plan 同时出现在单选组与勾选项，两处状态互相打架。
// INV-06 [失败路径] 历史 edit 草稿即使不在候选集也要回显；守住位置：selected 的 find 结果后面接的 edit 兜底分支；改错故障：打开旧会话时整块模式入口消失，用户无法切回其他权限。
// INV-07 [失败路径] 无可用模式时必须整体返回空；守住位置：if (!selected) return null 的提前返回；改错故障：继续渲染会在空值上取 id 与图标，首帧直接崩掉输入区。
// INV-08 [并发] modeOption 只在当前模式变化时重建；守住位置：useMemo 的依赖数组只含 draftConfig?.mode；改错故障：依赖写成整个草稿对象后，计划开关一改就换引用并反复重注册快捷键。
// INV-09 [契约] modeOption 的 currentValue 缺省必须是 build；守住位置：useMemo 内 currentValue 的空值合并；改错故障：缺省给空串时循环切换找不到起点，快捷键在首帧无响应。
// INV-10 [事务] 循环切换只有一条路径：先算下一档再上抛；守住位置：cycle 内 getNextConfigSelectValue 与 next 判空；改错故障：空值也上抛，把空串写进草稿的 mode。
// INV-11 [并发] 快捷键只在存在选项且未禁用时生效；守住位置：useToolbarShortcutBindings 的 hasAnyOption 与 toolbarDisabled；改错故障：禁用态仍响应循环，用户在看灰掉的入口时模式被悄悄改掉。
// INV-12 [契约] 本组件不接管模型菜单与思考档位快捷键；守住位置：绑定参数里 modelMenuDisabled 为真、两个回调指向 noop；改错故障：多个子组件同时抢占同一快捷键，切换落到非预期档位。
// INV-13 [事务] 下拉开合由受控的 activeConfigPicker 决定，本地不留副本；守住位置：DropdownMenu 的 open 比较与 onOpenChange 上抛；改错故障：本地再存一份开合态后工具栏互斥失效，两个菜单同时展开。
// INV-14 [权衡] 菜单展开时提示气泡必须强制关闭；守住位置：ControlHintTooltip 的 open 三元表达式；改错故障：气泡浮在菜单之上，点击穿透触发器导致菜单反复开合。
// INV-15 [资源] 关闭菜单后要把焦点还给输入框；守住位置：DropdownMenuContent 的 onCloseAutoFocus 与阻止默认聚焦；改错故障：焦点落回文档根节点，菜单关闭后快捷键与输入法一起失效。
// INV-16 [权衡] 粗指针设备跳过手动回焦，交给系统处理；守住位置：onCloseAutoFocus 内的 isCoarseTouchDevice 判定；改错故障：手机端强制聚焦输入框，软键盘弹出遮住半屏并顶起布局。
// INV-17 [事务] Plan 勾选项的两个结果都要合成成一次模式切换；守住位置：onCheckedChange 的 "plan" 与 "plan-off" 分支；改错故障：只改勾选布尔不动模式，运行时收到的权限与界面勾选态不一致。
// INV-18 [契约] 计划标记条与勾选项共用同一开关，且同样受 disabled 约束；守住位置：draftConfig?.planEnabled 条件渲染与标记按钮的 disabled；改错故障：禁用态仍能撤掉计划，或标记与勾选态短暂相反。
//
// 模块职责：V4 输入框工具栏里的模式入口，用一个下拉承载 Plan 勾选与三档权限单选，并在计划开启时额外渲染可移除标记。
// 状态所有权：模式与计划开关的事实都在上层草稿 draftConfig，本组件只做展示投影、菜单开合上抛与切换意图上抛，不持有业务状态。
// 阅读顺序：先看 props 契约与 displayProvider、selected 的推导，再看 modeOption 与快捷键绑定，最后看下拉内容、回焦处理与计划标记分支。
import { memo, useCallback, useMemo } from "react";
import { LightbulbIcon, XIcon, ChevronDownIcon } from "lucide-react";
import {
  ZCODE_AGENT_PROVIDER,
  getZCodeAgentAvailableModes,
  type ZCodeConfigOption,
} from "@zcode/shared";
import {
  TID_CHAT_MODE_SELECT_TRIGGER,
  TID_CHAT_MODE_SELECT_ITEM,
  TID_V4_COMPOSER_INPUT,
  testId,
} from "@zcode/shared/test-ids";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu.js";
import { RollingToolbarLabel } from "@/chat-input-toolbar/RollingToolbarLabel.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import {
  getModeOptionDisplayLabel,
  getModeOptionDescriptionMessageId,
  resolveModeOptionIcon,
} from "@/chat-input-toolbar/display.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isCoarseTouchDevice } from "@/lib/pickerFocus.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  getNextConfigSelectValue,
  useToolbarShortcutBindings,
} from "@/v4/composer/toolbarShortcuts.js";
import type { V4ComposerToolbarProps } from "@/v4/composer/V4ComposerToolbar.js";

// [权衡] noop 是占位回调，用于关闭本组件并不负责的模型菜单与思考档位快捷键。
// [契约] 不直接传空值是为了满足绑定参数的类型要求，同时明确表达本组件不处理，而不是忘记处理。
// [资源] noop 定义在模块顶层，引用恒定，可以安全进入依赖数组而不引发重复订阅。
// [契约] 空函数体带显式 void 返回类型，避免静态检查把它判成隐式 any。
// [权衡] 日后若本组件真要接管模型切换，应替换这个 noop 而不是再挂一套绑定，避免同一快捷键被两处消费。
function noop(): void {}

/** Plan 是独立勾选项，三种权限仍为单选；只编辑草稿，不向 Runtime 发切换命令。 */
// [契约] 组件接收 provider、draftConfig 与 disabled 三组受控输入，回传切换模式与切换菜单开合两类意图，自身不写持久状态。
// [契约] draftConfig 是唯一可信来源：mode 表示三档权限中的一项，planEnabled 是独立布尔，二者不互相推导。
// [边界] workspacePath 与 workspaceIdentity 虽在挑选清单里却未被使用，保留只为与工具栏其余子组件的入参形状对齐。
// [权衡] activeConfigPicker 用字符串而非布尔，保证同一时刻只有一个下拉被打开；本组件只认 mode 这一个值。
// [契约] 切换回调的入参是模式 id 字符串，并额外接受 plan 与 plan-off 两个合成值，草稿写入与运行时下发都由上层决定。
// [权衡] 对外只暴露一个 memo 包装的具名导出，选择器状态提到上层，切换逻辑保持纯净便于替换与测试。
function V4ComposerModeSwitchImpl({
  provider,
  draftConfig,
  disabled,
  activeConfigPicker,
  onConfigPickerOpenChange,
  onSwitchMode,
}: Pick<
  V4ComposerToolbarProps,
  | "workspacePath"
  | "workspaceIdentity"
  | "provider"
  | "draftConfig"
  | "disabled"
  | "activeConfigPicker"
  | "onConfigPickerOpenChange"
  | "onSwitchMode"
>) {
  const { intl } = useZCodeIntl();
  // [契约] displayProvider 只用于查标签与说明文案，不参与模式计算，缺省时回落到 ZCode Agent 常量。
  // [契约] 快捷键提示文案来自 cycleSessionMode 命令，展示与真实绑定同源，避免提示与实际行为不符。
  // [资源] 此处与 modeOption 内各取一次候选模式，都是纯函数读取，不得改成模块级常量。
  // [失败路径] permissions 直接排除 plan，把 Plan 的展示权移交下方勾选项，单选组里不出现重复项。
  // [失败路径] selected 先用 find 命中当前模式，再为历史 edit 草稿补一个最小对象，保证旧会话仍有入口。
  // [权衡] 补出来的 edit 对象只有 id 与 name，没有描述，此时说明行整段不渲染，不伪造国际化 key。
  // [契约] 小工具函数把模式 id 与 name 转成显示文案，触发器与每个单选项共用同一套映射，命名风格统一。
  const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
  const modeShortcutLabel = useShortcutCommandLabel("cycleSessionMode");
  const modes = getZCodeAgentAvailableModes();
  const permissions = modes.filter((mode) => mode.id !== "plan");
  // 新菜单隐藏 Edit，但历史草稿仍可回显，不能因候选变化隐藏整个权限入口。
  const selected =
    permissions.find((mode) => mode.id === draftConfig?.mode) ??
    (draftConfig?.mode === "edit" ? { id: "edit", name: "Edit" } : undefined);
  const label = (mode: (typeof modes)[number]) =>
    getModeOptionDisplayLabel(intl, displayProvider, { value: mode.id, name: mode.name });
  const plan = modes.find((mode) => mode.id === "plan")!;
  const planLabel = label(plan);
  // Plan 拆成独立勾选项后仍需保留原菜单说明，复用相同的国际化映射。
  const planDescriptionId = getModeOptionDescriptionMessageId(displayProvider, { value: plan.id });
  // [契约] modeOption 是给快捷键层的最小配置投影，字段固定为 id、name、category、type、currentValue 与 options。
  // [并发] 依赖数组只有当前模式，保证计划开关变化时不重建对象，绑定副作用也不会重跑。
  // [权衡] options 再次取候选并过滤 plan，与 permissions 同源，避免快捷键循环到独立勾选项上。
  // [契约] currentValue 缺省 build，是循环取下一档的起点，缺失会让快捷键在首帧无效。
  // [事务] cycle 先算下一档再判空上抛，空值直接丢弃，不允许把空串写进草稿。
  // [并发] cycle 依赖 modeOption 与切换回调，两者稳定才能保证绑定不随渲染次数抖动。
  // [契约] 绑定参数中模型菜单禁用恒为真，本组件主动让出该快捷键，避免与别的子组件争抢。
  const modeOption = useMemo<ZCodeConfigOption>(
    () => ({
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: draftConfig?.mode ?? "build",
      options: getZCodeAgentAvailableModes()
        .filter((mode) => mode.id !== "plan")
        .map((mode) => ({ value: mode.id, name: mode.name })),
    }),
    [draftConfig?.mode],
  );
  const cycle = useCallback(() => {
    const next = getNextConfigSelectValue(modeOption);
    if (next) onSwitchMode(next);
  }, [modeOption, onSwitchMode]);
  useToolbarShortcutBindings({
    hasAnyOption: Boolean(selected),
    toolbarDisabled: disabled,
    modelMenuDisabled: true,
    modeOption,
    onCycleSessionMode: cycle,
    onOpenModelMenu: noop,
    onCycleThoughtLevel: noop,
  });
  // [失败路径] 提前返回发生在所有 hook 之后，保证两次渲染的 hook 顺序一致，不触发 React 规则告警。
  // [失败路径] 返回空时模式按钮与计划标记一起消失，因为标记分支同样依赖 selected 存在。
  // [契约] 图标由 resolveModeOptionIcon 按模式 id 解析，与菜单内每个选项走同一解析器，风格一致。
  // [契约] 触发器是 ghost 小尺寸按钮，禁用态直接透传，禁用时既不展开菜单也不响应快捷键。
  // [资源] 折叠优先级标记为 1，窄屏压缩时先保模式入口，后让计划标记。
  // [权衡] 无障碍标签与提示气泡取同一个国际化 key，读屏与视觉提示不会说法不一。
  if (!selected) return null;
  const Icon = resolveModeOptionIcon(selected.id);
  return (
    <div className="flex min-w-0 items-center gap-1">
      <DropdownMenu
        open={activeConfigPicker === "mode"}
        onOpenChange={(open) => onConfigPickerOpenChange("mode", open)}
      >
        <ControlHintTooltip
          title={intl.formatMessage({ id: "chat.toolbar.mode.label" })}
          shortcut={modeShortcutLabel}
          open={activeConfigPicker === "mode" ? false : undefined}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              data-testid={TID_CHAT_MODE_SELECT_TRIGGER}
              data-composer-collapse-priority="1"
              aria-label={intl.formatMessage({ id: "chat.toolbar.mode.label" })}
              className={cn(
                "group/mode h-7 gap-1 rounded-lg px-2 text-ui-base data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0",
                selected.id === "yolo" && "text-warning hover:text-warning",
                selected.id === "guarded" &&
                  "text-icon-blue hover:text-icon-blue aria-expanded:text-icon-blue",
              )}
            >
              <Icon className="size-4" />
              <span className="inline group-data-[composer-compact=true]/mode:hidden">
                {/* Plan 菜单重写时普通 span 丢失了旧 ConfigSelect 的翻滚；复用同一动画组件恢复。 */}
                <RollingToolbarLabel label={label(selected)} />
              </span>
              <ChevronDownIcon className="size-3.5 group-data-[composer-compact=true]/mode:hidden" />
            </Button>
          </DropdownMenuTrigger>
        </ControlHintTooltip>
        <DropdownMenuContent
          side="top"
          sideOffset={4}
          className="w-64"
          // [资源] 关闭菜单先阻止默认聚焦，再由本组件把焦点送回输入框，避免焦点随菜单卸载丢到文档根节点。
          // [失败路径] 输入框按 data-testid 查找，查不到时可选链直接跳过，不抛异常也不阻塞关闭。
          // [权衡] 粗指针设备提前返回，保留系统焦点与软键盘原状，只有桌面端做手动回焦。
          // [契约] 下拉内容固定向上弹出并偏移 4，位于输入区上方，不遮挡正在编辑的文本。
          // [事务] 内容宽度固定，说明文案换行时不会把菜单压成与触发器等宽的窄条。
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!isCoarseTouchDevice())
              document
                .querySelector<HTMLElement>(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`)
                ?.focus();
          }}
        >
          <DropdownMenuCheckboxItem
            checked={draftConfig?.planEnabled ?? false}
            onCheckedChange={(checked) => onSwitchMode(checked ? "plan" : "plan-off")}
            data-testid={testId(TID_CHAT_MODE_SELECT_ITEM, "plan")}
            className="min-h-13 items-start gap-3 py-2"
          >
            <LightbulbIcon className="mt-0.5 size-4.5 shrink-0" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span>{planLabel}</span>
              {planDescriptionId && (
                <span className="text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({ id: planDescriptionId })}
                </span>
              )}
            </span>
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup value={selected.id} onValueChange={onSwitchMode}>
            {permissions.map((mode) => {
              const ModeIcon = resolveModeOptionIcon(mode.id);
              const descriptionId = getModeOptionDescriptionMessageId(displayProvider, {
                value: mode.id,
              });
              return (
                <DropdownMenuRadioItem
                  key={mode.id}
                  value={mode.id}
                  data-testid={testId(TID_CHAT_MODE_SELECT_ITEM, mode.id)}
                  className="min-h-13 items-start gap-3 py-2"
                >
                  <ModeIcon className="mt-0.5 size-4.5 shrink-0" />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span>{label(mode)}</span>
                    {descriptionId && (
                      <span className="text-ui-sm text-foreground-subtle">
                        {intl.formatMessage({ id: descriptionId })}
                      </span>
                    )}
                  </span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {draftConfig?.planEnabled && (
        <span data-testid="v4-composer-plan-marker" className="flex items-center gap-1">
          <span
            role="separator"
            aria-orientation="vertical"
            className="h-3 w-px shrink-0 bg-border"
          />
          <ControlHintTooltip title={intl.formatMessage({ id: "chat.plan.removeMarker" })}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              data-composer-collapse-priority="2"
              onClick={() => onSwitchMode("plan-off")}
              aria-label={intl.formatMessage({ id: "chat.plan.removeMarker" })}
              className="group/plan h-7 gap-1 rounded-lg px-2 text-ui-base text-foreground-subtle hover:text-foreground-subtle data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0"
            >
              <LightbulbIcon className="size-4 group-hover/plan:hidden group-focus-visible/plan:hidden" />
              <XIcon className="hidden size-4 group-hover/plan:block group-focus-visible/plan:block" />
              <span className="inline group-data-[composer-compact=true]/plan:hidden">
                {intl.formatMessage({ id: "mode.plan" })}
              </span>
            </Button>
          </ControlHintTooltip>
        </span>
      )}
    </div>
  );
}
export const V4ComposerModeSwitch = memo(V4ComposerModeSwitchImpl);
