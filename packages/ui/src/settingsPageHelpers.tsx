/* oxlint-disable eslint(max-lines) -- settings helper 聚合多个设置分组；终端、网络与自动归档多侧能力暂时超过行数限制。 */
// 设置页通用设置区的表单聚合层：把 SettingsPage 持有的设置值与 on*Change 回写动作渲染成行，只做草稿态与脏判定。
// 数据目录、代理生效、终端 shell 探测、动态工作流与主动建议分别由各自组件与服务负责，本文件不复制它们的业务规则。
// 本文件不负责分区索引与可用性判断（settingsPageConfig）、不负责设置持久化，也不做任何 IPC 直连。
//
// INV-01 断言：设置值只由 props 进入、只经 on*Change 回写，本文件不缓存任何服务端事实 —— 守住它的位置：GeneralSectionContent 各 useState 仅作输入草稿 —— 改错故障：本地再存一份开关值，外部更新后界面与实际配置长期不一致
// INV-02 断言：本地草稿在 props 变化时无条件覆盖 —— 守住它的位置：localTerminalFontFamily 与 localHttpProxy* 的 useEffect 依赖数组 —— 改错故障：去掉依赖后切换分区回来仍显示旧值，保存成功后界面回弹
// INV-03 断言：脏判定比较的是 trim 后草稿与原值 —— 守住它的位置：isTerminalFontFamilyDirty 与 isHttpProxy*Dirty —— 改错故障：只加空格就被判脏，保存按钮常亮且回车触发无意义写入
// INV-04 断言：保存按钮 disabled 与回车提交共用同一个脏标记 —— 守住它的位置：各 SettingsRow 的 Button disabled 与 Input onKeyDown —— 改错故障：按钮灰着但回车仍提交，未确认内容被写入配置
// INV-05 断言：No Proxy 先按英文逗号拆分、逐项 trim、丢弃空项再拼回 —— 守住它的位置：normalizedHttpProxyNoProxy —— 改错故障：空项原样写入，下游把空串当匹配规则并绕过代理
// INV-06 断言：终端 shell 下拉值只在 auto 与 shell.id 之间映射 —— 守住它的位置：integratedTerminalShellValue —— 改错故障：把选项对象当值，切回 auto 时匹配不到项，终端卡在旧 shell
// INV-07 断言：选中项不在探测列表时用 props 字段合成兜底项而不是丢弃 —— 守住它的位置：selectedIntegratedTerminalShellOption —— 改错故障：外部配置的 shell 被移出列表后下拉空白，用户看不出当前用哪个
// INV-08 断言：兜底项排在列表首位并对其余项按 id 去重 —— 守住它的位置：visibleIntegratedTerminalShellOptions —— 改错故障：同一 shell 出现两次，React key 冲突且选中态跳动
// INV-09 断言：shell 回调找不到选项时静默返回，不回退成 auto —— 守住它的位置：handleIntegratedTerminalShellChange 的 if (!option) 分支 —— 改错故障：选项刷新后一次误点把用户显式配置的 shell 重置为自动
// INV-10 断言：终端 shell 行仅在 showIntegratedTerminalShell 为真时渲染 —— 守住它的位置：终端 SettingsGroupCard 内的三元 —— 改错故障：未探测平台也出现下拉，用户能选到本机不存在的 shell
// INV-11 断言：代理地址、No Proxy 与自定义 CA 三行始终同卡片相邻 —— 守住它的位置：HTTP 代理 SettingsGroupCard —— 改错故障：拆卡后用户只改其中一项，出口策略自相矛盾
// INV-12 断言：托盘开关在 Linux 能力探测中或不可用时锁定 —— 守住它的位置：Switch 的 disabled={Boolean(linuxCloseToTray?.disabled)} —— 改错故障：探测中允许开启，关窗后无托盘可恢复
// INV-13 断言：通知声音开关随通知总开关禁用 —— 守住它的位置：notificationSound 的 Switch disabled —— 改错故障：总通知关闭后仍能调声音，用户误以为声音设置生效
// INV-14 断言：依赖服务的行用 hasServices 判定，缺服务时整行不渲染 —— 守住它的位置：ProactiveSuggestionsSetting 与 DynamicWorkflowModeSetting —— 改错故障：无服务环境下渲染即抛错，整页设置白屏
// INV-15 断言：所有 on*Change 一律 void 调用，既不 await 也不吞异常 —— 守住它的位置：各 Switch 与 Select 的 onValueChange/onCheckedChange —— 改错故障：改成 await 后未捕获拒绝，保存失败被静默丢弃
// INV-16 断言：归档天数行不依赖归档总开关 —— 守住它的位置：时长 Select 不受 taskAutoArchiveEnabled 控制 —— 改错故障：恢复联动后必须先开归档才能改天数，旧阈值立即生效
import type {
  AppToolSearchMode,
  IntegratedTerminalShellOption,
  IntegratedTerminalShellSelection,
  LocalePreference,
  ZCodeInteractionBehavior,
} from "@zcode/shared";
import { appToolSearchModeSchema } from "@zcode/shared";
import {
  TID_SETTINGS_ASK_USER_QUESTION_AUTO_RESOLUTION_SWITCH,
  TID_SETTINGS_NATIVE_SEARCH_SWITCH,
  TID_SETTINGS_TOOL_SEARCH_SELECT,
  TID_SETTINGS_TOOL_SEARCH_OPTION,
} from "@zcode/shared/test-ids";
import { useState, useCallback, useEffect } from "react";
import type { IPlatformService } from "@zcode/shared";
import {
  TID_SETTINGS_LOCALE_SELECT_ITEM,
  TID_SETTINGS_LOCALE_SELECT_TRIGGER,
  testId,
} from "@zcode/shared/test-ids";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { Input } from "@/components/ui/input.js";
import { Button } from "@/components/ui/button.js";
import { SettingsBadge, SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { DataBaseDirControl } from "@/settings/DataBaseDirControl.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { ProactiveSuggestionsSetting } from "@/settings/ProactiveSuggestionsSetting.js";
import { DynamicWorkflowModeSetting } from "@/settings/DynamicWorkflowModeSetting.js";
import { normalizeInterfaceMode, type InterfaceMode } from "@/lib/interfaceMode.js";
import {
  createSettingsPageConfig,
  resolveSettingsSectionForPlatform,
  SETTINGS_SECTION_GROUPS,
  SETTINGS_SECTIONS,
  isSettingsSectionAvailable,
  type SettingsSectionId,
} from "@/settings/settingsPageConfig.js";

export type { Locale, LocalePreference } from "@zcode/shared";
export { type SettingsSectionId };
export { createSettingsPageConfig, resolveSettingsSectionForPlatform };
export { SETTINGS_SECTION_GROUPS, SETTINGS_SECTIONS };
export { isSettingsSectionAvailable };

// 归档阈值只开放 3/7/14/30 四档，数组顺序即下拉顺序，也是文案键的取值来源。
// 该常量用 as const 保持数字字面量，Select 里必须 String(days) 后再比较，否则选中态恒空。
// 新增档位要同步补 settings.taskAutoArchiveDays.option.* 文案，否则界面直接显示键名。
const TASK_AUTO_ARCHIVE_DAY_OPTIONS = [3, 7, 14, 30] as const;
const ZCODE_INTERACTION_BEHAVIOR_OPTIONS: readonly ZCodeInteractionBehavior[] = ["queue", "guide"];

/**
 * 归档偏好与归档列表集中展示，设置值和保存动作继续由 SettingsPage 持有。
 * Bugfix：关闭时禁用时长会迫使用户先开启归档，旧阈值可能立即生效；允许先保存时长再开启。
 */
// [契约] 归档开关与归档天数拆成两个受控行，值仍由 SettingsPage 保存，本组件不保留副本。
// [权衡] 天数行刻意不受开关禁用：早期实现关闭时禁用，迫使先开启归档才能改阈值，旧值会立即生效。
// 组件只接收 enabled/days 与两个异步回调，不读 store，也不把两次保存合并成一次。
// 保存失败的提示由上层负责，这里不重复弹错。
export function TaskAutoArchiveSettings({
  taskAutoArchiveEnabled,
  taskAutoArchiveOlderThanDays,
  onTaskAutoArchiveEnabledChange,
  onTaskAutoArchiveOlderThanDaysChange,
}: {
  taskAutoArchiveEnabled: boolean;
  taskAutoArchiveOlderThanDays: number;
  onTaskAutoArchiveEnabledChange: (enabled: boolean) => Promise<void>;
  onTaskAutoArchiveOlderThanDaysChange: (days: number) => Promise<void>;
}) {
  // 文案全部走 intl.formatMessage，键名以 settings.taskAutoArchive 为前缀派生，不拼裸字符串。
  // 天数选项文案按 settings.taskAutoArchiveDays.option.<days> 生成，新增档位必须同时补文案。
  // 这里只取 intl，不订阅平台能力，保证两行在桌面与 Web 渲染一致。
  const { intl } = useZCodeIntl();
  // [契约] 两行在同一卡片内的顺序固定：开关在上、天数在下，读屏的因果顺序依赖它。
  // controlLayout 固定 wide，窄屏时控件换行但不压缩描述文案。
  // 开关回调用 void 包裹，保存失败不会冒泡成未处理的 Promise 拒绝。
  return (
    <SettingsGroupCard>
      <SettingsRow
        controlLayout="wide"
        label={intl.formatMessage({ id: "settings.taskAutoArchive" })}
        description={intl.formatMessage({
          id: "settings.taskAutoArchiveDescription",
        })}
        control={
          <Switch
            data-testid="archive-auto-archive-switch"
            aria-label={intl.formatMessage({ id: "settings.taskAutoArchive" })}
            checked={taskAutoArchiveEnabled}
            onCheckedChange={(checked) => {
              void onTaskAutoArchiveEnabledChange(checked);
            }}
          />
        }
      />
      <SettingsRow
        controlLayout="wide"
        label={intl.formatMessage({ id: "settings.taskAutoArchiveDays" })}
        description={intl.formatMessage({
          id: "settings.taskAutoArchiveDaysDescription",
        })}
        control={
          <Select
            value={String(taskAutoArchiveOlderThanDays)}
            onValueChange={(value) => {
              void onTaskAutoArchiveOlderThanDaysChange(Number(value));
            }}
          >
            <SelectTrigger
              data-testid="archive-auto-archive-days"
              aria-label={intl.formatMessage({ id: "settings.taskAutoArchiveDays" })}
              size="lg"
              className="w-full min-w-0 justify-between"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TASK_AUTO_ARCHIVE_DAY_OPTIONS.map((days) => (
                <SelectItem key={days} value={String(days)}>
                  {intl.formatMessage({
                    id: `settings.taskAutoArchiveDays.option.${days}`,
                  })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
    </SettingsGroupCard>
  );
}

// 通用设置区主容器：语言、界面模式、终端、搜索、代理、桌面行为、通知、交互与数据目录集中在此。
// [契约] 所有能力开关都以 props 传入并带默认值，SSR 单测可用精简 props 直接渲染而不崩。
// 默认值只在参数解构处生效，函数体内不得再散落第二套缺省判断。
// 本组件不判断分区是否可见，也不决定平台是否支持某项能力，只按传入布尔值渲染。
// 分区标题与语言徽标在 GeneralSectionHeader，不在这里重复输出。
export function GeneralSectionContent({
  localePreference,
  interfaceMode = "coding",
  setInterfaceMode = () => {},
  notificationEnabled,
  notificationSoundEnabled,
  closeToTrayOnWindows,
  keepAwakeWhileRunning = false,
  desktopChromiumHardwareAccelerationEnabled = true,
  receivePreviewUpdates,
  autoDownloadAndInstallUpdates,
  dataBaseDir,
  terminalInheritSystemProfile = true,
  terminalFontFamily = "",
  integratedTerminalShell = { mode: "auto" },
  integratedTerminalShellOptions = [],
  toolSearchMode = "off",
  onToolSearchModeChange,
  nativeSearchEnhancementsEnabled,
  httpProxy = "",
  httpProxyNoProxy = "",
  httpProxyCaCertPath = "",
  defaultHomeDir,
  isDesktop,
  isWindowsDesktop,
  isLinuxDesktop,
  linuxCloseToTray,
  showIntegratedTerminalShell = false,
  setLocalePreference,
  setNotificationEnabled,
  setNotificationSoundEnabled,
  messageStreamShowReasoning,
  messageStreamShowTodos,
  toolGroupingExploreEnabled,
  toolGroupingTerminalEnabled,
  toolGroupingChangesEnabled,
  zcodeInteractionBehavior,
  askUserQuestionAutoResolutionEnabled = true,
  modelIoFullRetentionEnabled = false,
  onDataBaseDirChange,
  onSelectDataBaseDir,
  onTerminalInheritSystemProfileChange = async () => {},
  onTerminalFontFamilyChange = async () => {},
  onIntegratedTerminalShellChange = async () => {},
  onNativeSearchEnhancementsEnabledChange,
  onHttpProxyChange = async () => {},
  onHttpProxyNoProxyChange = async () => {},
  onHttpProxyCaCertPathChange = async () => {},
  onCloseToTrayOnWindowsChange,
  onKeepAwakeWhileRunningChange = async () => {},
  onDesktopChromiumHardwareAccelerationChange = async () => {},
  onReceivePreviewUpdatesChange,
  onAutoDownloadAndInstallUpdatesChange,
  onMessageStreamShowReasoningChange,
  onMessageStreamShowTodosChange,
  onToolGroupingExploreEnabledChange,
  onToolGroupingTerminalEnabledChange,
  onToolGroupingChangesEnabledChange,
  onZCodeInteractionBehaviorChange,
  onAskUserQuestionAutoResolutionEnabledChange = async () => {},
  onModelIoFullRetentionEnabledChange = async () => {},
  onOpenOnboardingDialog,
}: {
  localePreference: LocalePreference;
  interfaceMode?: InterfaceMode;
  setInterfaceMode?: (mode: InterfaceMode) => void;
  notificationEnabled: boolean;
  notificationSoundEnabled: boolean;
  closeToTrayOnWindows: boolean;
  keepAwakeWhileRunning?: boolean;
  desktopChromiumHardwareAccelerationEnabled?: boolean;
  receivePreviewUpdates: boolean;
  autoDownloadAndInstallUpdates: boolean;
  dataBaseDir: string;
  terminalInheritSystemProfile: boolean;
  terminalFontFamily: string;
  integratedTerminalShell?: IntegratedTerminalShellSelection;
  integratedTerminalShellOptions?: IntegratedTerminalShellOption[];
  toolSearchMode?: AppToolSearchMode;
  onToolSearchModeChange: (mode: AppToolSearchMode) => Promise<void>;
  nativeSearchEnhancementsEnabled: boolean;
  httpProxy?: string;
  httpProxyNoProxy?: string;
  httpProxyCaCertPath?: string;
  defaultHomeDir: string;
  isDesktop?: boolean;
  isWindowsDesktop?: boolean;
  /** Linux 桌面端（isDesktop 且非 win/mac）；关闭驻留托盘设置在 Linux 上按能力自适应展示 */
  isLinuxDesktop?: boolean;
  /** Linux 关闭驻留托盘能力状态（spec：docs/desktop/linux-close-to-tray.md）；Windows 不传 */
  linuxCloseToTray?: {
    /** 能力探测中或确认不可用，开关锁定 */
    disabled: boolean;
    /** 确认不可用（描述文案切换为"未提供系统托盘"） */
    unavailable: boolean;
    /** GNOME 系桌面且无托盘（追加 AppIndicator 扩展安装提示） */
    gnomeLikeHint: boolean;
  };
  showIntegratedTerminalShell?: boolean;
  platform?: IPlatformService;
  setLocalePreference: (locale: LocalePreference) => void;
  setNotificationEnabled: (enabled: boolean) => void;
  setNotificationSoundEnabled: (enabled: boolean) => void;
  messageStreamShowReasoning: boolean;
  messageStreamShowTodos: boolean;
  toolGroupingExploreEnabled: boolean;
  toolGroupingTerminalEnabled: boolean;
  toolGroupingChangesEnabled: boolean;
  zcodeInteractionBehavior: ZCodeInteractionBehavior;
  askUserQuestionAutoResolutionEnabled?: boolean;
  modelIoFullRetentionEnabled?: boolean;
  onDataBaseDirChange: (dir: string) => Promise<void>;
  onSelectDataBaseDir: () => Promise<string | null>;
  onTerminalInheritSystemProfileChange: (enabled: boolean) => Promise<void>;
  onTerminalFontFamilyChange: (fontFamily: string) => Promise<void>;
  onIntegratedTerminalShellChange?: (selection: IntegratedTerminalShellSelection) => Promise<void>;
  onNativeSearchEnhancementsEnabledChange: (enabled: boolean) => Promise<void>;
  onHttpProxyChange?: (httpProxy: string) => Promise<void>;
  onHttpProxyNoProxyChange?: (noProxy: string) => Promise<void>;
  onHttpProxyCaCertPathChange?: (caCertPath: string) => Promise<void>;
  onCloseToTrayOnWindowsChange: (enabled: boolean) => Promise<void>;
  onKeepAwakeWhileRunningChange?: (enabled: boolean) => Promise<void>;
  onDesktopChromiumHardwareAccelerationChange?: (enabled: boolean) => Promise<void>;
  onReceivePreviewUpdatesChange: (enabled: boolean) => Promise<void>;
  onAutoDownloadAndInstallUpdatesChange: (enabled: boolean) => Promise<void>;
  onMessageStreamShowReasoningChange: (enabled: boolean) => Promise<void>;
  onMessageStreamShowTodosChange: (enabled: boolean) => Promise<void>;
  onToolGroupingExploreEnabledChange: (enabled: boolean) => Promise<void>;
  onToolGroupingTerminalEnabledChange: (enabled: boolean) => Promise<void>;
  onToolGroupingChangesEnabledChange: (enabled: boolean) => Promise<void>;
  onZCodeInteractionBehaviorChange: (behavior: ZCodeInteractionBehavior) => Promise<void>;
  onAskUserQuestionAutoResolutionEnabledChange?: (enabled: boolean) => Promise<void>;
  onModelIoFullRetentionEnabledChange?: (enabled: boolean) => Promise<void>;
  onOpenOnboardingDialog: () => void;
}) {
  // 文案键统一 settings.* 前缀，键缺失时界面显示键名本身，便于暴露漏配。
  // 组件内不缓存 intl 结果，语言切换依赖 Provider 触发整树重渲染。
  // 这里取 intl 只用于展示，不参与任何脏判定或提交内容。
  // 键名调整只改文案不改代码，避免在渲染期拼接条件片段。
  const { intl } = useZCodeIntl();
  // [契约] 使用可选版本而不是强依赖版本，允许无 Provider 的单测与极简宿主渲染。
  // hasServices 决定 ProactiveSuggestionsSetting 与 DynamicWorkflowModeSetting 是否出现。
  // [失败路径] 缺服务时应整行不渲染，改成渲染后判空会在无服务环境下抛错并让整页白屏。
  // 该布尔只喂给展示分支，设置值的计算与持久化都不读 hasServices。
  const hasServices = Boolean(useOptionalServices());
  // 终端字体族用本地草稿态，输入过程不直接写配置，避免每敲一个字符触发一次保存。
  // 初值取自 props，外部更新后由下方 effect 覆盖，草稿绝不反向同步给父组件。
  // [权衡] 只有显式保存或回车才提交，牺牲即时生效换取可撤销。
  // 判脏与保存都用 trim 后的值，前后空格不算有效修改。
  // 部分 SSR 单测会用精简 props 直接渲染本组件，新增终端设置项后旧 helper 未必同步传值。
  // 这里把运行时缺省值兜到“继承系统 profile”，避免 undefined.trim() 把无关测试打断。
  const [localTerminalFontFamily, setLocalTerminalFontFamily] = useState(terminalFontFamily);

  // [契约] 依赖数组只有 terminalFontFamily：外部值变化时必须强行覆盖草稿，否则用户放弃编辑后仍看到旧输入。
  // [失败路径] 去掉这个 effect 会出现保存成功但界面回弹，或切换分区回来看到未保存的旧文本。
  // 该 effect 不回写父级，避免渲染期回写形成循环。
  useEffect(() => {
    setLocalTerminalFontFamily(terminalFontFamily);
  }, [terminalFontFamily]);

  // 脏判定只比较 trim 后草稿与 props 原值，原值本身不 trim，保持与持久化内容一致。
  // isTerminalFontFamilyDirty 为假时保存按钮禁用且回车不提交，避免写入与 props 相同的值。
  // 比较前不做 toLowerCase 归一，因为字体族名在部分平台上大小写不等价。
  const normalizedTerminalFontFamily = localTerminalFontFamily.trim();
  const isTerminalFontFamilyDirty = normalizedTerminalFontFamily !== terminalFontFamily;
  // [契约] 下拉的受控值只能是 auto 或 shell.id 两种形态，不能把整个选项对象塞进 value。
  // mode 为 shell 时取 id，其余一律回落 auto，保证外部配置异常时仍可选。
  // [失败路径] 若把对象序列化当值，切回自动时匹配不到选项，下拉会停在错误项。
  // auto 是保留字面量，不能被某个 shell 的实际 id 占用。
  const integratedTerminalShellValue =
    integratedTerminalShell.mode === "shell" ? integratedTerminalShell.id : "auto";
  // [契约] 当前选中项可能不在探测列表里（外部配置或探测结果刷新），必须合成兜底项。
  // 兜底项字段直接取自 props 的 dialect/id/label/path，不虚构路径也不改写来源。
  // [失败路径] 直接丢弃未知项会让下拉显示空白，用户无法得知当前启用的 shell。
  // 只在 mode 为 shell 时构造，auto 下保持 undefined，避免误显示一个默认 shell。
  const selectedIntegratedTerminalShellOption =
    integratedTerminalShell.mode === "shell"
      ? (integratedTerminalShellOptions.find(
          (option) => option.id === integratedTerminalShell.id,
        ) ?? {
          dialect: integratedTerminalShell.dialect,
          id: integratedTerminalShell.id,
          label: integratedTerminalShell.label,
          path: integratedTerminalShell.path,
          source: "system" as const,
        })
      : undefined;
  // [契约] 兜底项排首位，其余按 id 过滤去重，保证 React key 唯一且选中态稳定。
  // [失败路径] 不去重时同一 shell 出现两条，选中态会在同 id 的两项之间跳动。
  // auto 选项由 SelectContent 静态渲染，不进入这个列表，避免重复项。
  const visibleIntegratedTerminalShellOptions = selectedIntegratedTerminalShellOption
    ? [
        selectedIntegratedTerminalShellOption,
        ...integratedTerminalShellOptions.filter(
          (option) => option.id !== selectedIntegratedTerminalShellOption.id,
        ),
      ]
    : integratedTerminalShellOptions;

  // [契约] 保存只提交 trim 后的字符串，空串表示恢复默认字体，不代表未修改。
  // 依赖只含规范化值与回调，避免每次渲染生成新函数拖累下游。
  // 保存失败由上层提示，这里不吞异常也不回滚草稿。
  // 回车与按钮调用同一个函数，保证两条入口行为完全一致。
  const handleTerminalFontFamilySave = useCallback(async () => {
    await onTerminalFontFamilyChange(normalizedTerminalFontFamily);
  }, [normalizedTerminalFontFamily, onTerminalFontFamilyChange]);

  // [契约] 选到 auto 时提交自动模式，其余必须带 dialect/id/label/path 四段完整选择。
  // [失败路径] 查不到选项时静默返回：说明点到的是刚被刷新的陈旧值，不能误回落成 auto。
  // 依赖里必须带可见选项列表，否则闭包拿到旧列表导致选择错位。
  // 提交内容与下拉字面量解耦，避免把 UI 值直接持久化。
  const handleIntegratedTerminalShellChange = useCallback(
    async (value: string) => {
      if (value === "auto") {
        await onIntegratedTerminalShellChange({ mode: "auto" });
        return;
      }
      const option = visibleIntegratedTerminalShellOptions.find(
        (candidate) => candidate.id === value,
      );
      if (!option) {
        return;
      }
      await onIntegratedTerminalShellChange({
        mode: "shell",
        dialect: option.dialect,
        id: option.id,
        label: option.label,
        path: option.path,
      });
    },
    [onIntegratedTerminalShellChange, visibleIntegratedTerminalShellOptions],
  );

  // 代理地址同样是草稿态：输入期不落盘，只有保存或回车才写。
  // [契约] 初值取自 props，可能与草稿不同，因此下方 effect 必须无条件覆盖。
  // 空串代表不使用代理，与未配置在展示上等价，不要额外造 undefined 分支。
  // localHttpProxy 影响所有出站请求，所以只在保存或回车时才写配置。
  const [localHttpProxy, setLocalHttpProxy] = useState(httpProxy);

  useEffect(() => {
    setLocalHttpProxy(httpProxy);
  }, [httpProxy]);

  // 规范化只做 trim，不补协议头也不校验 URL 形态，协议判定留给网络层。
  // 脏判定基于规范化值，纯空格输入不会被当成一次修改。
  // 不要在 UI 层强行补 http 前缀，会把 socks 与自定义协议写坏。
  const normalizedHttpProxy = localHttpProxy.trim();
  const isHttpProxyDirty = normalizedHttpProxy !== httpProxy;

  // 保存提交 trim 后的地址，空串即清空代理配置。
  // [契约] 依赖里放规范化值与回调，避免闭包捕获旧地址。
  // 失败时不回滚本地草稿，保留用户输入以便直接重试。
  const handleHttpProxySave = useCallback(async () => {
    await onHttpProxyChange(normalizedHttpProxy);
  }, [normalizedHttpProxy, onHttpProxyChange]);

  // No Proxy 列表独立草稿，与代理地址分开保存，两者互不覆盖。
  // [契约] 该行必须紧贴代理地址渲染，两者共同决定同一出口策略。
  // 初值来自 props，覆盖逻辑与代理地址保持一致。
  const [localHttpProxyNoProxy, setLocalHttpProxyNoProxy] = useState(httpProxyNoProxy);

  useEffect(() => {
    setLocalHttpProxyNoProxy(httpProxyNoProxy);
  }, [httpProxyNoProxy]);

  // [契约] 先按英文逗号拆分、逐项 trim、丢弃空项，再用逗号拼回，保证持久化格式干净。
  // [失败路径] 保留空项会让下游把空串当成匹配规则，反而绕过代理直连。
  // 只处理英文逗号，中文逗号属用户输入错误，不在 UI 侧悄悄替换。
  // 归一化后再与原值比较，只有真正变化才视为脏。
  const normalizedHttpProxyNoProxy = localHttpProxyNoProxy
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean)
    .join(",");
  const isHttpProxyNoProxyDirty = normalizedHttpProxyNoProxy !== httpProxyNoProxy;

  // handleHttpProxyNoProxySave 提交 normalizedHttpProxyNoProxy，空串表示不使用例外列表。
  // [并发] 与代理地址分开提交，二者不是一次原子写入，上层需按顺序处理。
  // 失败时同样保留草稿，避免用户重敲长列表。
  const handleHttpProxyNoProxySave = useCallback(async () => {
    await onHttpProxyNoProxyChange(normalizedHttpProxyNoProxy);
  }, [normalizedHttpProxyNoProxy, onHttpProxyNoProxyChange]);

  // 自定义 CA 路径也是草稿态，输入期不读文件也不校验存在性。
  // [契约] 该行与代理地址、No Proxy 同卡片，属同一网络出口配置。
  // 初值来自 props，文件被移动后由网络层报错，UI 不静默清空。
  const [localHttpProxyCaCertPath, setLocalHttpProxyCaCertPath] = useState(httpProxyCaCertPath);

  useEffect(() => {
    setLocalHttpProxyCaCertPath(httpProxyCaCertPath);
  }, [httpProxyCaCertPath]);

  // 路径只 trim，不做路径归一化，Windows 反斜杠与 POSIX 路径都要原样保留。
  // 脏判定基于 trim 后字符串，尾随空格不触发保存。
  // 不清除引号与转义，粘贴带引号的路径交由用户自行修正。
  const normalizedHttpProxyCaCertPath = localHttpProxyCaCertPath.trim();
  const isHttpProxyCaCertPathDirty = normalizedHttpProxyCaCertPath !== httpProxyCaCertPath;

  // 保存提交 trim 后的路径，空串表示不使用自定义 CA。
  // [契约] 回调在 props 上有默认值兜底，调用处无需再判空。
  // 失败时不改动草稿，CA 无效导致的连接错误由网络层提示。
  const handleHttpProxyCaCertPathSave = useCallback(async () => {
    await onHttpProxyCaCertPathChange(normalizedHttpProxyCaCertPath);
  }, [normalizedHttpProxyCaCertPath, onHttpProxyCaCertPathChange]);

  // 渲染顺序即视觉与读屏顺序：语言、界面模式、终端、搜索、代理、桌面与通知、交互与消息流、数据目录、引导。
  // [契约] 卡片内的行不可随意跨卡片搬动，代理三件套与托盘开关尤其不能拆开。
  // 平台相关行用 isDesktop/isWindowsDesktop/isLinuxDesktop 判定，缺省不渲染而不是渲染成禁用态。
  // [失败路径] 把条件三元改成 disabled，用户会看到本机不支持的能力并且能点击。
  // 新增行必须自带 data-testid 或 aria-label，否则设置页 E2E 与读屏都会漏掉它。
  return (
    <div className="space-y-4">
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.locale" })}
          description={intl.formatMessage({ id: "settings.localeDescription" })}
          control={
            <Select
              value={localePreference}
              onValueChange={(value) => setLocalePreference(value as LocalePreference)}
            >
              <SelectTrigger
                size="lg"
                className="w-[260px] min-w-0 justify-between"
                data-testid={TID_SETTINGS_LOCALE_SELECT_TRIGGER}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  value="system"
                  data-testid={testId(TID_SETTINGS_LOCALE_SELECT_ITEM, "system")}
                >
                  {intl.formatMessage({ id: "settings.locale.system" })}
                </SelectItem>
                <SelectItem
                  value="zh-CN"
                  data-testid={testId(TID_SETTINGS_LOCALE_SELECT_ITEM, "zh-CN")}
                >
                  {intl.formatMessage({ id: "settings.locale.zh-CN" })}
                </SelectItem>
                <SelectItem
                  value="en-US"
                  data-testid={testId(TID_SETTINGS_LOCALE_SELECT_ITEM, "en-US")}
                >
                  {intl.formatMessage({ id: "settings.locale.en-US" })}
                </SelectItem>
              </SelectContent>
            </Select>
          }
        />
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow
          controlLayout="wide"
          label={intl.formatMessage({ id: "settings.interfaceMode" })}
          description={intl.formatMessage({ id: "settings.interfaceMode.description" })}
          control={
            <Select
              value={interfaceMode}
              onValueChange={(value) => setInterfaceMode(normalizeInterfaceMode(value))}
            >
              <SelectTrigger
                size="lg"
                className="w-full min-w-0 sm:w-64"
                aria-label={intl.formatMessage({ id: "settings.interfaceMode" })}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="coding">
                  {intl.formatMessage({ id: "settings.interfaceMode.coding" })}
                </SelectItem>
                <SelectItem value="office">
                  {intl.formatMessage({ id: "settings.interfaceMode.office" })}
                </SelectItem>
              </SelectContent>
            </Select>
          }
        />
        {hasServices ? <ProactiveSuggestionsSetting /> : null}
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.terminalProfile" })}
          description={intl.formatMessage({ id: "settings.terminalProfileDescription" })}
          control={
            <Switch
              checked={terminalInheritSystemProfile}
              onCheckedChange={(checked) => {
                void onTerminalInheritSystemProfileChange(checked);
              }}
            />
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.terminalFontFamily" })}
          description={intl.formatMessage({ id: "settings.terminalFontFamilyDescription" })}
          control={
            <Button
              type="button"
              size="lg"
              disabled={!isTerminalFontFamilyDirty}
              onClick={() => void handleTerminalFontFamilySave()}
            >
              {intl.formatMessage({ id: "settings.dataBaseDirSave" })}
            </Button>
          }
          detail={
            <Input
              size="lg"
              value={localTerminalFontFamily}
              placeholder={intl.formatMessage({
                id: "settings.terminalFontFamilyPlaceholder",
              })}
              onChange={(event) => {
                setLocalTerminalFontFamily(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && isTerminalFontFamilyDirty) {
                  void handleTerminalFontFamilySave();
                }
              }}
              className="max-w-[520px] font-mono"
            />
          }
        />
      </SettingsGroupCard>

      <SettingsGroupCard>
        {showIntegratedTerminalShell ? (
          <SettingsRow
            label={intl.formatMessage({ id: "settings.integratedTerminalShell" })}
            description={intl.formatMessage({
              id: "settings.integratedTerminalShellDescription",
            })}
            control={
              <Select
                value={integratedTerminalShellValue}
                onValueChange={(value) => {
                  void handleIntegratedTerminalShellChange(value);
                }}
              >
                <SelectTrigger size="lg" className="w-[260px] min-w-0 justify-between">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">
                    {intl.formatMessage({ id: "settings.integratedTerminalShell.auto" })}
                  </SelectItem>
                  {visibleIntegratedTerminalShellOptions.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
        ) : null}
        <SettingsRow
          label={intl.formatMessage({ id: "settings.toolSearch" })}
          description={intl.formatMessage({ id: "settings.toolSearchDescription" })}
          detail={
            <p className="text-ui-sm leading-5 text-foreground-subtle">
              {intl.formatMessage({ id: "settings.toolSearchExperimentalNotice" })}
            </p>
          }
          control={
            <Select
              value={toolSearchMode}
              onValueChange={(value) => {
                void onToolSearchModeChange(appToolSearchModeSchema.parse(value));
              }}
            >
              <SelectTrigger
                size="lg"
                className="w-[260px] min-w-0 justify-between"
                data-testid={TID_SETTINGS_TOOL_SEARCH_SELECT}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {appToolSearchModeSchema.options.map((mode) => (
                  <SelectItem
                    key={mode}
                    value={mode}
                    data-testid={testId(TID_SETTINGS_TOOL_SEARCH_OPTION, mode)}
                  >
                    {intl.formatMessage({ id: `settings.toolSearch.${mode}` })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <SettingsRow
          label={intl.formatMessage({
            id: "settings.nativeSearchEnhancements",
          })}
          description={intl.formatMessage({
            id: "settings.nativeSearchEnhancementsDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({
                id: "settings.nativeSearchEnhancements",
              })}
              checked={nativeSearchEnhancementsEnabled}
              data-testid={TID_SETTINGS_NATIVE_SEARCH_SWITCH}
              onCheckedChange={(checked) => {
                void onNativeSearchEnhancementsEnabledChange(checked);
              }}
            />
          }
        />
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.httpProxy" })}
          description={intl.formatMessage({ id: "settings.httpProxyDescription" })}
          control={
            <Button
              type="button"
              size="lg"
              disabled={!isHttpProxyDirty}
              onClick={() => void handleHttpProxySave()}
            >
              {intl.formatMessage({ id: "settings.dataBaseDirSave" })}
            </Button>
          }
          detail={
            <Input
              size="lg"
              value={localHttpProxy}
              placeholder={intl.formatMessage({
                id: "settings.httpProxyPlaceholder",
              })}
              onChange={(event) => {
                setLocalHttpProxy(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && isHttpProxyDirty) {
                  void handleHttpProxySave();
                }
              }}
              className="max-w-[520px] font-mono"
            />
          }
        />
        {/* No Proxy 与 HTTP 代理共同决定同一出口策略，必须贴在代理地址下面。*/}
        <SettingsRow
          label={intl.formatMessage({ id: "settings.httpProxyNoProxy" })}
          description={intl.formatMessage({
            id: "settings.httpProxyNoProxyDescription",
          })}
          control={
            <Button
              type="button"
              size="lg"
              disabled={!isHttpProxyNoProxyDirty}
              onClick={() => void handleHttpProxyNoProxySave()}
            >
              {intl.formatMessage({ id: "settings.dataBaseDirSave" })}
            </Button>
          }
          detail={
            <Input
              size="lg"
              value={localHttpProxyNoProxy}
              placeholder={intl.formatMessage({
                id: "settings.httpProxyNoProxyPlaceholder",
              })}
              onChange={(event) => {
                setLocalHttpProxyNoProxy(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && isHttpProxyNoProxyDirty) {
                  void handleHttpProxyNoProxySave();
                }
              }}
              className="max-w-[520px] font-mono"
            />
          }
        />
        {/* 自定义 CA 属于 HTTP 代理的同一网络出口策略，必须跟代理输入放在同一卡片里。*/}
        <SettingsRow
          label={intl.formatMessage({ id: "settings.httpProxyCaCertPath" })}
          description={intl.formatMessage({
            id: "settings.httpProxyCaCertPathDescription",
          })}
          control={
            <Button
              type="button"
              size="lg"
              disabled={!isHttpProxyCaCertPathDirty}
              onClick={() => void handleHttpProxyCaCertPathSave()}
            >
              {intl.formatMessage({ id: "settings.dataBaseDirSave" })}
            </Button>
          }
          detail={
            <Input
              size="lg"
              value={localHttpProxyCaCertPath}
              placeholder={intl.formatMessage({
                id: "settings.httpProxyCaCertPathPlaceholder",
              })}
              onChange={(event) => {
                setLocalHttpProxyCaCertPath(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && isHttpProxyCaCertPathDirty) {
                  void handleHttpProxyCaCertPathSave();
                }
              }}
              className="max-w-[520px] font-mono"
            />
          }
        />
      </SettingsGroupCard>

      <SettingsGroupCard>
        {isDesktop ? (
          <>
            <SettingsRow
              label={intl.formatMessage({
                id: "settings.desktopChromiumHardwareAcceleration",
              })}
              description={intl.formatMessage({
                id: "settings.desktopChromiumHardwareAccelerationDescription",
              })}
              control={
                <Switch
                  aria-label={intl.formatMessage({
                    id: "settings.desktopChromiumHardwareAcceleration",
                  })}
                  checked={desktopChromiumHardwareAccelerationEnabled}
                  onCheckedChange={(checked) => {
                    void onDesktopChromiumHardwareAccelerationChange(checked);
                  }}
                />
              }
            />
            <SettingsRow
              label={intl.formatMessage({ id: "settings.receivePreviewUpdates" })}
              description={intl.formatMessage({
                id: "settings.receivePreviewUpdatesDescription",
              })}
              control={
                <Switch
                  aria-label={intl.formatMessage({ id: "settings.receivePreviewUpdates" })}
                  checked={receivePreviewUpdates}
                  onCheckedChange={(checked) => {
                    void onReceivePreviewUpdatesChange(checked);
                  }}
                />
              }
            />
            <SettingsRow
              label={intl.formatMessage({
                id: "settings.autoDownloadAndInstallUpdates",
              })}
              description={intl.formatMessage({
                id: "settings.autoDownloadAndInstallUpdatesDescription",
              })}
              control={
                <Switch
                  aria-label={intl.formatMessage({
                    id: "settings.autoDownloadAndInstallUpdates",
                  })}
                  checked={autoDownloadAndInstallUpdates}
                  onCheckedChange={(checked) => {
                    void onAutoDownloadAndInstallUpdatesChange(checked);
                  }}
                />
              }
            />
          </>
        ) : null}
        <SettingsRow
          label={intl.formatMessage({ id: "settings.notification" })}
          description={intl.formatMessage({
            id: "settings.notificationDescription",
          })}
          control={
            <Switch checked={notificationEnabled} onCheckedChange={setNotificationEnabled} />
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.notificationSound" })}
          description={intl.formatMessage({
            id: "settings.notificationSoundDescription",
          })}
          control={
            <Switch
              checked={notificationSoundEnabled}
              disabled={!notificationEnabled}
              onCheckedChange={setNotificationSoundEnabled}
            />
          }
        />
        {isWindowsDesktop || isLinuxDesktop ? (
          <SettingsRow
            label={intl.formatMessage({ id: "settings.closeToTrayOnWindows" })}
            description={
              linuxCloseToTray?.unavailable
                ? linuxCloseToTray.gnomeLikeHint
                  ? `${intl.formatMessage({ id: "settings.closeToTrayUnavailable" })} ${intl.formatMessage({ id: "settings.closeToTrayGnomeHint" })}`
                  : intl.formatMessage({ id: "settings.closeToTrayUnavailable" })
                : intl.formatMessage({
                    id: "settings.closeToTrayOnWindowsDescription",
                  })
            }
            control={
              <Switch
                checked={closeToTrayOnWindows}
                // Linux 上托盘能力未知（探测中）或确认不可用时都锁定，防止误开导致关窗失联
                //（spec：docs/desktop/linux-close-to-tray.md）。
                disabled={Boolean(linuxCloseToTray?.disabled)}
                onCheckedChange={(checked) => {
                  void onCloseToTrayOnWindowsChange(checked);
                }}
              />
            }
          />
        ) : null}
        {isDesktop ? (
          <SettingsRow
            label={intl.formatMessage({ id: "settings.keepAwakeWhileRunning" })}
            description={intl.formatMessage({
              id: "settings.keepAwakeWhileRunningDescription",
            })}
            control={
              <Switch
                aria-label={intl.formatMessage({
                  id: "settings.keepAwakeWhileRunning",
                })}
                checked={keepAwakeWhileRunning}
                onCheckedChange={(checked) => {
                  void onKeepAwakeWhileRunningChange(checked);
                }}
              />
            }
          />
        ) : null}
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.zcodeInteractionBehavior" })}
          description={intl.formatMessage({
            id: "settings.zcodeInteractionBehaviorDescription",
          })}
          control={
            <Select
              value={zcodeInteractionBehavior}
              onValueChange={(value) => {
                void onZCodeInteractionBehaviorChange(value as ZCodeInteractionBehavior);
              }}
            >
              <SelectTrigger size="lg" className="w-[260px] min-w-0 justify-between">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ZCODE_INTERACTION_BEHAVIOR_OPTIONS.map((behavior) => (
                  <SelectItem key={behavior} value={behavior}>
                    {intl.formatMessage({
                      id: `settings.zcodeInteractionBehavior.option.${behavior}`,
                    })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <SettingsRow
          label={intl.formatMessage({
            id: "settings.askUserQuestionAutoResolution",
          })}
          description={intl.formatMessage({
            id: "settings.askUserQuestionAutoResolutionDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({
                id: "settings.askUserQuestionAutoResolution",
              })}
              checked={askUserQuestionAutoResolutionEnabled}
              data-testid={TID_SETTINGS_ASK_USER_QUESTION_AUTO_RESOLUTION_SWITCH}
              onCheckedChange={(checked) => {
                void onAskUserQuestionAutoResolutionEnabledChange(checked);
              }}
            />
          }
        />
        {/* docs/dynamic-workflow/launch.md「The user's choice」：服务端未提供时整行不渲染。 */}
        {hasServices ? <DynamicWorkflowModeSetting /> : null}
        <SettingsRow
          label={intl.formatMessage({ id: "settings.modelIoFullRetention" })}
          description={intl.formatMessage({
            id: "settings.modelIoFullRetentionDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({ id: "settings.modelIoFullRetention" })}
              checked={modelIoFullRetentionEnabled}
              onCheckedChange={(checked) => {
                void onModelIoFullRetentionEnabledChange(checked);
              }}
            />
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.messageStreamShowReasoning" })}
          description={intl.formatMessage({
            id: "settings.messageStreamShowReasoningDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({ id: "settings.messageStreamShowReasoning" })}
              checked={messageStreamShowReasoning}
              onCheckedChange={(checked) => {
                void onMessageStreamShowReasoningChange(checked);
              }}
            />
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.messageStreamShowTodos" })}
          description={intl.formatMessage({
            id: "settings.messageStreamShowTodosDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({ id: "settings.messageStreamShowTodos" })}
              checked={messageStreamShowTodos}
              onCheckedChange={(checked) => {
                void onMessageStreamShowTodosChange(checked);
              }}
            />
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.toolGroupingExplore" })}
          description={intl.formatMessage({
            id: "settings.toolGroupingExploreDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({ id: "settings.toolGroupingExplore" })}
              checked={toolGroupingExploreEnabled}
              onCheckedChange={(checked) => {
                void onToolGroupingExploreEnabledChange(checked);
              }}
            />
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.toolGroupingTerminal" })}
          description={intl.formatMessage({
            id: "settings.toolGroupingTerminalDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({ id: "settings.toolGroupingTerminal" })}
              checked={toolGroupingTerminalEnabled}
              onCheckedChange={(checked) => {
                void onToolGroupingTerminalEnabledChange(checked);
              }}
            />
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.toolGroupingChanges" })}
          description={intl.formatMessage({
            id: "settings.toolGroupingChangesDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({ id: "settings.toolGroupingChanges" })}
              checked={toolGroupingChangesEnabled}
              onCheckedChange={(checked) => {
                void onToolGroupingChangesEnabledChange(checked);
              }}
            />
          }
        />
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.dataBaseDir" })}
          description={intl.formatMessage({
            id: "settings.dataBaseDirDescription",
          })}
          control={
            <DataBaseDirControl
              dataBaseDir={dataBaseDir}
              defaultHomeDir={defaultHomeDir}
              onDataBaseDirChange={onDataBaseDirChange}
              onSelectDataBaseDir={onSelectDataBaseDir}
            />
          }
        />
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.onboarding" })}
          description={intl.formatMessage({
            id: "settings.onboardingDescription",
          })}
          control={
            <Button type="button" size="lg" variant="outline" onClick={onOpenOnboardingDialog}>
              {intl.formatMessage({ id: "settings.onboardingOpen" })}
            </Button>
          }
        />
      </SettingsGroupCard>
    </div>
  );
}

export function GeneralSectionHeader({ localePreference }: { localePreference: LocalePreference }) {
  const { intl } = useZCodeIntl();

  return (
    <div className="mt-4 flex flex-wrap gap-2">
      <SettingsBadge>
        {intl.formatMessage({ id: `settings.locale.${localePreference}` })}
      </SettingsBadge>
    </div>
  );
}
