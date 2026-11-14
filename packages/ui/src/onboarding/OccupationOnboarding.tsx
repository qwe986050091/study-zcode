// 首次引导三步向导（职业 → 界面模式 → 偏好）的全屏容器与流程编排点。
// 负责：可见性判定、三步状态机、界面模式写回、本地引导记录追加、遥测结束上报。
// 不负责：三步选项 UI 的渲染（交给 OnboardingOccupationGrid 与 OnboardingModeSelector）、
// 记录存储与上传实现、设置字段的持久化语义（由 useSettings 与 host 承担）。
//
// INV-01 断言：可见性等于手动请求，或自动判定为真且本次会话未关闭 —— 守住它的位置：onboardingVisible 计算与 dismissed 状态 —— 改错故障：按 Esc 关掉后引导反复弹出，或手动打开的引导被 dismissed 吞掉
// INV-02 断言：savingRef 为真时所有写库入口必须直接返回 —— 守住它的位置：closeOnboarding 与 save 的首行判定 —— 改错故障：连点导致两条设置与两条记录的并发写入
// INV-03 断言：occupation 为 null 只表示第 1 步被跳过，落库时才折成 other —— 守住它的位置：跳过分支与 update 的 onboardingOccupation —— 改错故障：记录里出现默认职业，跳过与选择 developer 无法区分
// INV-04 断言：mode 为 null 表示模式页被跳过，保存时不得调用 setInterfaceMode —— 守住它的位置：save 中 if (mode) 守卫 —— 改错故障：跳过模式的用户界面模式被强行改写
// INV-05 断言：记录里的 null 字段在读回时按未作答处理，回退到当前设置而不是报错 —— 守住它的位置：applyLatestEntry 的 ?? 回退 —— 改错故障：老记录让引导直接打不开
// INV-06 断言：设置保存成功即视为本轮结束，本地记录失败不得让页面停留 —— 守住它的位置：save 中 update 之后先复位步骤与可见性 —— 改错故障：记录服务故障时用户被困在引导页反复上报
// INV-07 断言：markOnboarded 只在记录写入成功后调用 —— 守住它的位置：appendOnboardingRecord 之后的语句 —— 改错故障：记录没写成却标记已完成，下次启动不再引导
// INV-08 断言：记录写入失败只 warn，不回滚已保存的偏好 —— 守住它的位置：内层 catch —— 改错故障：记录抖动导致用户看到保存失败提示并重填
// INV-09 断言：appendRecord 必须带 5 秒超时兜底 —— 守住它的位置：appendOnboardingRecord 的 Promise.race —— 改错故障：channel 缺失时保存按钮永久转圈
// INV-10 断言：设置保存失败时停留在当前步骤并显示错误，不清空答案 —— 守住它的位置：外层 catch 与 error 状态 —— 改错故障：失败后用户答案被清空需重填
// INV-11 断言：晚到的异步预填不得覆盖用户已做的选择 —— 守住它的位置：userEditedRef 与 latestEntry 的 effect —— 改错故障：用户选完又被旧记录改回
// INV-12 断言：从记录预填的职业值必须命中 occupations 白名单 —— 守住它的位置：applyLatestEntry 的 includes 判定 —— 改错故障：历史脏数据使网格选中态与提交值错位
// INV-13 断言：Escape、模式切换与打开引导的按键必须在捕获阶段拦截 —— 守住它的位置：onKeyDown 三个分支 —— 改错故障：同一次按键同时触发编辑器与面板的快捷键
// INV-14 断言：keydown 的移除必须与注册使用相同的 capture 参数 —— 守住它的位置：effect 的 cleanup —— 改错故障：卸载后监听泄漏，关闭的引导仍会改界面模式
// INV-15 断言：快捷键切换模式时 store 与本地 mode 必须同步写入 —— 守住它的位置：onKeyDown 的模式分支 —— 改错故障：界面已切换但引导页高亮仍是旧模式
//
// 数据流：requested 与 needsOnboarding 合成 onboardingVisible，step 0/1/2 依次收集答案，
// 保存时先写 settings，再追加 onboarding-record 并标记已完成；关闭只写 dismissed 决策。
// 设置写入与记录写入是两条通道，后者失败不回滚前者，只留日志并允许下次重触发。
// 步骤顺序固定为 0 职业、1 模式、2 偏好，preferences 只是 step === 2 的派生值。
// 所有可见性、可点击态与文案都从状态派生，不额外存一份副本，避免两处真值。
import { useOnboardingTelemetry } from "@/onboarding/useOnboardingTelemetry.js";
import { OnboardingHeader } from "@/onboarding/OnboardingHeader.js";
import { OccupationOnboardingVisual } from "@/onboarding/OccupationOnboardingVisual.js";
import { occupations, type OccupationValue } from "@/onboarding/occupationOptions.js";
import { OnboardingModeSelector } from "@/onboarding/OnboardingModeSelector.js";
import { OnboardingOccupationGrid } from "@/onboarding/OnboardingOccupationGrid.js";
import { useOnboardingTrigger } from "@/onboarding/useOnboardingTrigger.js";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useSettings } from "@/hooks/useSettingService.js";
import { useOnboardingRecordService } from "@/hooks/useOnboardingRecordService.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useEffectiveShortcutBindings } from "@/shortcuts/useShortcutBindings.js";
import { matchesShortcutBinding } from "@/shortcuts/bindings.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import type { InterfaceMode } from "@/lib/interfaceMode.js";
import { logger } from "@/logger.js";
import { DesktopWindowControls } from "@/DesktopWindowControls.js";
import type { OnboardingRecordEntry } from "@zcode/shared";

/** 追加本地引导记录（userId 由 host 补全）；channel 缺失挂起时 5 秒超时按写失败处理。 */
// [失败路径] Promise.race 只让调用方先失败，底下的 appendRecord RPC 仍在飞，
// 这里不能加重试，否则超时后重试会写出两条完成时间不同的记录，服务端无法去重。
// 5 秒是给 channel 就绪留的预算，调大只会让保存按钮转圈更久，调小会误伤冷启动首次写入。
// 超时抛出的错误由 save 的内层 catch 吞成 warn，不向上传播。
async function appendOnboardingRecord(
  service: NonNullable<ReturnType<typeof useOnboardingRecordService>>,
  deviceMid: string,
  entry: Parameters<typeof service.appendRecord>[1],
): Promise<void> {
  await Promise.race([
    service.appendRecord(deviceMid, entry),
    new Promise((_, reject) => setTimeout(() => reject(new Error("appendRecord timeout")), 5000)),
  ]);
}

export function OccupationOnboarding({
  children,
  showWindowControls = false,
  showChildrenWhileLoading = false,
  isMacDesktop,
  isWindowsDesktop,
}: {
  children: ReactNode;
  /** Windows/Linux 自绘窗控：引导全屏覆盖主界面（含标题栏），需在此补最小化/最大化/关闭。 */
  showWindowControls?: boolean;
  /** 独立设置页不依赖引导设置加载，避免应用级引导外层遮住设置内容。 */
  showChildrenWhileLoading?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
}) {
  const { settings, update } = useSettings();
  const platform = usePlatform();
  const onboardingRecord = useOnboardingRecordService();
  const shortcutBindings = useEffectiveShortcutBindings();
  // [契约] 可见性有两个独立来源：requested 是快捷键或代码显式请求，needsOnboarding 是记录判定。
  // 两者取或，所以关掉自动判定不能吞掉手动请求，反之亦然。
  // 关闭与保存后都要 setRequested(false)，漏掉会让下次进入主界面仍看到引导。
  // dismissed 只作用于自动判定分支，不参与这里的或运算。
  const requested = useZCodeStore((state) => state.newUserOnboardingOpen);
  const setRequested = useZCodeStore((state) => state.setNewUserOnboardingOpen);
  // 登录态变化（useRootOAuthEffects 登录成功后 setUser）时按 userId 重新判定是否触发引导。
  const userId = useZCodeStore((state) => state.user?.id) ?? null;
  const { intl } = useZCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `occupationOnboarding.${key}` });
  // 默认选中 developer 是产品口径而非兜底：首屏必须有选中项，否则继续按钮一直禁用。
  // null 只在第 1 步点跳过时写入，作为跳过的显式答案传给记录层。
  // 设置侧不能存 null，落库时统一折成 other，语义差异只保留在 onboarding-record 里。
  // 不要把初始值改成 null 求诚实，首次进入的用户将无法一步继续。
  const [occupation, setOccupation] = useState<OccupationValue | null>("developer");
  const savedInterfaceMode = useZCodeStore((state) => state.interfaceMode);
  const setInterfaceMode = useZCodeStore((state) => state.setInterfaceMode);
  // mode 为 null 表示模式页被"跳过"（跳过是显式答案，记录里保留 null 而非兜底值）。
  // 初始值取 store 当前界面模式而不是写死 coding：办公用户重开引导时不应看到模式被改。
  // null 表示模式页被跳过，保存时 if (mode) 会跳过 setInterfaceMode，保留原模式。
  // 快捷键切换必须同时写 store 与本地 mode，只写一边会让引导页高亮与真实界面分叉。
  // 不要改成渲染时用 mode ?? savedInterfaceMode 兜底，那会把跳过的 null 悄悄变成一次选择。
  const [mode, setMode] = useState<InterfaceMode | null>(savedInterfaceMode);
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const preferences = step === 2;
  const requestOnboardingDialog = useZCodeStore((state) => state.requestOnboardingDialog);
  const [migration, setMigration] = useState(false);
  const [memory, setMemory] = useState(savedInterfaceMode === "office");
  const [suggestions, setSuggestions] = useState(savedInterfaceMode === "office");
  const suggestionsEditedRef = useRef(false);
  const [saving, setSaving] = useState(false);
  // [并发] setSaving 生效在下一帧，keydown 闭包里读到的 saving 可能落后一帧。
  // 真正防重复写库的是 savingRef：closeOnboarding 与 save 入口都先看它，命中即整段返回。
  // ref 在 finally 里复位，错误路径也能解锁；写在 try 尾部会让失败后永久卡死。
  // 不要用 savingRef 替代 saving 渲染禁用态，只有 state 变化才会触发重渲染。
  const savingRef = useRef(false);
  const [error, setError] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const loadDeviceMid = useCallback(() => platform.getDeviceId(), [platform]);
  const [needsOnboarding, markOnboarded] = useOnboardingTrigger({
    onboardingRecord,
    userId,
    loadDeviceMid,
    update,
  });
  // [契约] 手动请求优先：requested 为真时即使 dismissed 也展示，用户按快捷键必须能重新打开。
  // 自动触发只在判定为 true 且本次未关闭时成立，null 代表判定中，不算显示。
  // dismissed 是会话级状态，不落库；持久化的不再弹由 closeOnboarding 写记录承担。
  // 不要在这里补 settings 判定，settings 未就绪已由外层提前返回处理。
  const onboardingVisible = requested || (needsOnboarding === true && !dismissed);
  const captureEnd = useOnboardingTelemetry({
    platform,
    visible:
      Boolean(settings) &&
      onboardingVisible &&
      (requested || needsOnboarding !== null || Boolean(settings?.onboardingOccupation)),
    step,
    occupation,
    mode,
    memory,
    suggestions,
    migration,
  });
  // [契约] 关闭不等于保存：这里只写 dismissed 决策，不写职业/模式/偏好，也不调用 markOnboarded。
  // captureEnd 返回的收尾函数在改状态之前调用，保证上报的是关闭前的步骤与勾选。
  // savingRef 为真时直接返回，避免保存过程中按 Esc 造成两次终态上报。
  // dismissOnboarding 失败只 warn：本地关闭已经生效，不让写盘失败把用户困在引导页。
  const closeOnboarding = useCallback(() => {
    if (savingRef.current) return;
    captureEnd("close", intl.formatMessage({ id: "occupationOnboarding.close" }))();
    setStep(0);
    setDismissed(true);
    setRequested(false);
    if (onboardingRecord) {
      void onboardingRecord.dismissOnboarding(platform.getDeviceId()).catch((cause: unknown) => {
        logger.warn("[occupation-onboarding] 写入关闭决策失败", { error: String(cause) });
      });
    }
  }, [captureEnd, intl, onboardingRecord, platform, setRequested]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        shortcutBindings.toggleInterfaceMode.some((binding) =>
          matchesShortcutBinding(event, binding),
        )
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (saving) return;
        const nextMode = savedInterfaceMode === "office" ? "coding" : "office";
        setInterfaceMode(nextMode);
        setMode(nextMode);
        if (nextMode !== mode) {
          setMemory(nextMode === "office");
          if (nextMode === "office" && !suggestionsEditedRef.current) setSuggestions(true);
        }
        return;
      }
      if (event.key === "Escape" && onboardingVisible && !saving) {
        // 直接退出不改偏好；首次引导会持久化 dismissed，避免下次启动重复展示。
        event.preventDefault();
        event.stopImmediatePropagation();
        closeOnboarding();
        return;
      }
      if (
        !shortcutBindings.openOnboarding.some((binding) => matchesShortcutBinding(event, binding))
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (saving) return;
      // 关闭调试引导不保存偏好，也不把首次引导标记为已完成。
      if (onboardingVisible) {
        closeOnboarding();
      } else {
        setRequested(true);
      }
    };
    // [并发] 用捕获阶段注册，才能抢在编辑器等冒泡阶段的全局快捷键之前处理。
    // 三个分支命中后都要 stopImmediatePropagation，否则同一次按键还会触发下层模式切换或面板开关。
    // 清理必须带同样的 true，漏传 capture 会移除不掉监听，热重载后出现重复响应。
    // 依赖数组含 savedInterfaceMode 与 mode，漏掉会让快捷键分支读到旧模式并写回错误值。
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    closeOnboarding,
    shortcutBindings,
    setRequested,
    onboardingVisible,
    saving,
    savedInterfaceMode,
    setInterfaceMode,
    mode,
  ]);
  // 引导再次打开（换账号触发 / 快捷键手动打开）时，用该用户在 record 里的最近作答预填，
  // 而不是每次都从写死的默认选项开始；跳过页记 null 的字段落默认值。
  // [并发] 预填来自异步 RPC，组件可能在响应前卸载或换账号，cancelled 标记阻断过期写入。
  // userId 变化要重新拉取，否则换账号后仍用上一个用户的作答预填。
  // 读取失败只 warn 并保持 null，引导退化为默认值，不能因此阻断打开。
  // 不要把 latestEntry 直接当受控值渲染，它只是预填来源，真值在 occupation、mode 与偏好上。
  const [latestEntry, setLatestEntry] = useState<OnboardingRecordEntry | null>(null);
  // 预填异步后到时不得覆盖用户已经做出的选择。
  // [并发] 记录读取比用户点击慢时，applyLatestEntry 会覆盖刚做的选择，此标记用于吸收晚到的预填。
  // 任何交互（选职业、选模式、勾选、点跳过）都要调用 markUserEdited，包括重复点当前项。
  // 只在 requested 重新打开时复位，自动触发路径不能复位，否则会覆盖用户本轮已改的答案。
  // 不要用 state 承担此标记，改它不需要重渲染，而且要被异步回调同步读到最新值。
  const userEditedRef = useRef(false);
  useEffect(() => {
    if (!onboardingRecord) return;
    let cancelled = false;
    onboardingRecord.getLatestEntry().then(
      (entry) => {
        if (!cancelled) setLatestEntry(entry);
      },
      (cause) => {
        logger.warn("[occupation-onboarding] 读取预填作答失败", { error: String(cause) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [onboardingRecord, userId]);
  const markUserEdited = () => {
    userEditedRef.current = true;
  };

  // [契约] 职业值必须命中 occupations 白名单，历史脏数据或改版后的旧枚举一律回落 developer。
  // 界面模式缺失或为 null 时取当前 store 模式，而不是硬编码 coding。
  // memory 只在办公模式下恢复，记录缺失时默认开启；编程模式始终关闭。
  // 每次预填都重置 migration 为 false，迁移提示不应从上次会话继承。
  const applyLatestEntry = () => {
    const entry = latestEntry;
    setStep(0);
    setOccupation(
      entry?.occupation && (occupations as readonly string[]).includes(entry.occupation)
        ? (entry.occupation as OccupationValue)
        : "developer",
    );
    const initialMode = entry?.interfaceMode ?? savedInterfaceMode;
    setMode(initialMode);
    // 编程模式默认关闭主动工作记忆；办公模式才恢复该用户之前的勾选。
    setMemory(initialMode === "office" && (entry?.memoryEnabled ?? true));
    setSuggestions(entry?.proactiveSuggestionsEnabled ?? initialMode === "office");
    setMigration(false);
    setError(false);
  };
  useEffect(() => {
    // [契约] 只有请求打开这条路径才复位编辑标记并重新预填，自动触发走 needsOnboarding 分支。
    // 这里复位 userEditedRef 与 suggestionsEditedRef，保证新一轮引导从记录重新开始。
    // 依赖只写 requested 并关闭 lint：把 latestEntry 加进来会在预填到达时清空用户已改的答案。
    // 若想让晚到的记录也能预填，交给下面监听 latestEntry 的 effect，不要改动这里。
    if (!requested) return;
    userEditedRef.current = false;
    suggestionsEditedRef.current = false;
    applyLatestEntry();
    // latestEntry 异步到达时若引导已打开，重新预填一次（用户未交互前覆盖默认值）。
  }, [requested]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!onboardingVisible || userEditedRef.current) return;
    applyLatestEntry();
    // eslint-disable-line react-hooks/exhaustive-deps
  }, [latestEntry]);
  // settings 未就绪时退出：引导要写 onboardingOccupation，缺设置就写不进去。
  // showChildrenWhileLoading 为真时放行子内容，供独立设置页等调用点避免被引导遮罩挡住。
  // 默认 false 是全屏引导的口径，改成 true 会让主界面在加载期先闪一下。
  // 返回 children 或 null 而不是空壳容器，避免出现半渲染的骨架。
  if (!settings) return showChildrenWhileLoading ? <>{children}</> : null;
  // 判定进行中先不渲染，避免引导闪现后立即消失（判定为需引导）或先闪引导再进主界面。
  // 只有疑似首跑（settings 里也没有职业）才等待记录判定；存量用户（已有
  // onboardingOccupation）不等 RPC 直接进主界面，杜绝黑屏。
  // `needsOnboarding` 判定中且无历史职业时先不渲染，宁可多等一帧也不闪引导再消失。
  // 存量用户（settings 里已有 onboardingOccupation）不等 RPC 直接进主界面，这是修黑屏的关键。
  // 手动 requested 必须绕过这个等待，否则快捷键打开引导也要等记录判定。
  // 若改成无条件等待，所有老用户每次启动都要多等一次 RPC，表现为白屏。
  if (!requested && needsOnboarding === null && !settings.onboardingOccupation) return null;
  if (!onboardingVisible) return <>{children}</>;
  // [并发] 入口再次用 savingRef 兜底：保存按钮与快捷键可能在同一帧进入。
  // 开始事件在写库前上报，reportEnd 在设置写成功后立刻调用，跳过时以 skip 上报。
  // skip 只改偏好与记录字段，不改变步骤流转；偏好页跳过才是整轮结束。
  // savingRef 与 setSaving 都在 finally 复位，异常路径不会留下半锁状态。
  const save = async (skip = false) => {
    if (savingRef.current) return;
    savingRef.current = true;
    const reportEnd = captureEnd(skip ? "skip" : "start", t(skip ? "skip" : "start"));
    setSaving(true);
    setError(false);
    try {
      // [契约] 模式为 null 表示用户跳过该页，此时不能写 store，否则原界面模式会被覆盖。
      // setInterfaceMode 会同时写 localStorage 与 store，且发生在设置落库之前。
      // 因此设置保存失败时界面模式已经变了，这是可接受的不一致，不要在 catch 里回滚成旧值。
      // 这里写的是用户最终选择，不是 savedInterfaceMode，两者在快捷键切换后已经不同。
      if (mode) setInterfaceMode(mode);
      logger.info("[occupation-onboarding] 保存偏好", { interfaceMode: mode });
      // [事务] settings 侧保持既有语义：跳过时职业折成 other、偏好一律关闭。
      // 跳过与选了默认值的区分只写进 onboarding-record，不污染设置字段。
      // proactiveSuggestionsEnabled 仅在办公模式且未跳过时为真，其余一律 false。
      // update 抛错跳到外层 catch，已写的 store 界面模式不回滚。
      await update({
        // settings 侧保持既有语义：跳过落保守默认值（职业 other / 偏好关），
        // "跳过也算答案"的区分度只体现在 onboarding-record.json 里。
        onboardingOccupation: occupation ?? "other",
        memoryEnabled: skip ? false : memory,
        proactiveSuggestionsEnabled: !skip && mode === "office" && suggestions,
      });
      reportEnd();
      // 保存成功就是本次引导的终点；本地记录失败不应留下可再次上报的引导页面。
      setStep(0);
      setDismissed(true);
      setRequested(false);
      if (!skip && migration) requestOnboardingDialog("migration");
      logger.info("[occupation-onboarding] 偏好保存完成", { interfaceMode: mode });
      if (onboardingRecord) {
        try {
          // 追加本地引导记录（userId 由 host 按登录态补全），后续上传服务器。
          // appendRecord 走 RPC，channel 缺失时会挂起导致保存按钮永远转圈，加超时保护。
          // 跳过是显式答案：该页被跳过时记 null（occupation 在第 1 步跳过时已是 null，
          // mode 在第 2 步跳过时置 null，偏好页整体跳过时两个布尔记 null）。
          await appendOnboardingRecord(onboardingRecord, platform.getDeviceId(), {
            occupation,
            interfaceMode: mode,
            memoryEnabled: skip ? null : memory,
            proactiveSuggestionsEnabled: skip ? null : mode === "office" && suggestions,
            completedAt: new Date().toISOString(),
          });
          // [失败路径] 只有 appendRecord 成功后才标记已完成，记录没写成下次启动会再次触发引导。
          // 标记发生在设置已保存之后，所以重触发时用户看到的是按旧记录预填的内容而非空白。
          // 记录异常被内层 catch 吞掉，这里的语句就不会执行，不要把它挪出 try。
          // markOnboarded 会把判定置 false，下一帧 onboardingVisible 转假并渲染子内容。
          markOnboarded();
        } catch (cause) {
          // 偏好已保存成功，记录写失败只留 warn 日志，不打断用户；下次启动按记录会再次触发引导。
          logger.warn("[occupation-onboarding] 写入引导记录失败", { error: String(cause) });
        }
      }
    } catch (cause) {
      logger.warn("[occupation-onboarding] 保存偏好失败", { error: String(cause) });
      setError(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  return (
    <main
      aria-label={t("title")}
      data-testid="onboarding-page"
      className="relative flex h-dvh w-full min-h-0 flex-col overflow-hidden bg-background text-foreground"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 h-12 [app-region:drag]" />
      {/* 与 Settings 相同，计入 Workspace 的 4px 外层留白、1px 边框和 8px 内边距。 */}
      {showWindowControls ? (
        <div className="absolute right-1 top-1 z-30 mt-px mr-px flex h-12 items-center px-2">
          <DesktopWindowControls />
        </div>
      ) : null}
      <div className="relative grid min-h-0 flex-1 grid-cols-1 gap-0 lg:grid-cols-2 lg:gap-1 lg:p-1">
        <div className="flex min-h-0 flex-col pt-12 [@media(max-height:740px)]:pt-10">
          <OnboardingHeader
            step={step}
            saving={saving}
            t={t}
            onBack={() => setStep(step === 2 ? 1 : 0)}
            onClose={closeOnboarding}
          />
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-4 sm:px-10">
            {/* 自动外边距让短内容居中，长内容从顶部正常滚动，不影响固定导航。 */}
            <div className="mx-auto my-auto w-full max-w-lg shrink-0">
              <section className="flex w-full flex-col">
                <div className="w-full">
                  <h1 className="text-ui-xl font-semibold tracking-tight text-center">
                    {t(preferences ? "preferences" : step === 1 ? "modeTitle" : "title")}
                  </h1>
                  <p className="mx-auto mt-3 max-w-md text-center text-ui-base leading-relaxed text-foreground-subtle">
                    {t(
                      preferences
                        ? "preferencesDescription"
                        : step === 1
                          ? "modeDescription"
                          : "description",
                    )}
                  </p>
                  {step === 1 ? (
                    <OnboardingModeSelector
                      mode={mode}
                      saving={saving}
                      onSelect={(value) => {
                        markUserEdited();
                        // 重选当前编程模式也应清除旧记录带来的默认勾选。
                        setMemory(value === "office");
                        if (value !== mode) {
                          if (value === "office" && !suggestionsEditedRef.current)
                            setSuggestions(true);
                        }
                        setMode(value);
                      }}
                      label={t("modeTitle")}
                      formatLabel={(key) => t(key)}
                    />
                  ) : preferences ? (
                    <div className="mt-8 space-y-3">
                      {(["suggestions", "memory", "migration"] as const)
                        .filter((key) => key !== "suggestions" || mode === "office")
                        .map((key) => (
                          <label
                            key={key}
                            className="grid cursor-pointer grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 rounded-xl border border-card-border bg-card dark:bg-surface/40 p-5 text-ui-base transition-colors hover:bg-surface-hover"
                          >
                            <Checkbox
                              checked={
                                key === "migration"
                                  ? migration
                                  : key === "memory"
                                    ? memory
                                    : suggestions
                              }
                              disabled={saving}
                              onCheckedChange={(checked) => {
                                markUserEdited();
                                if (key === "migration") setMigration(checked === true);
                                else if (key === "memory") setMemory(checked === true);
                                else {
                                  suggestionsEditedRef.current = true;
                                  setSuggestions(checked === true);
                                }
                              }}
                            />
                            <span className="font-medium">{t(key)}</span>
                            <span className="col-start-2 text-ui-sm font-normal text-foreground-subtle">
                              {t(`${key}Description`)}
                            </span>
                          </label>
                        ))}
                    </div>
                  ) : (
                    <OnboardingOccupationGrid
                      occupation={occupation}
                      saving={saving}
                      onSelect={(value) => {
                        markUserEdited();
                        setOccupation(value);
                      }}
                      label={t("title")}
                      formatLabel={(value) => t(value)}
                    />
                  )}
                  {error ? (
                    <p role="alert" className="mt-4 text-ui-sm text-destructive">
                      {t("error")}
                    </p>
                  ) : null}
                </div>
                <footer className="mt-6 flex flex-col gap-3 [@media(max-height:740px)]:mt-4 [@media(max-height:740px)]:gap-1">
                  <Button
                    variant="link"
                    disabled={saving}
                    className="order-2 h-9 self-center rounded-xl px-3 text-ui-base text-foreground-subtle"
                    onClick={() => {
                      markUserEdited();
                      if (preferences) void save(true);
                      else {
                        if (step === 0) setOccupation(null);
                        else setMode(null);
                        setStep(step === 0 ? 1 : 2);
                      }
                    }}
                  >
                    {t("skip")}
                  </Button>
                  <div className="flex w-full gap-3">
                    <Button
                      disabled={saving || (step === 0 && !occupation)}
                      className="h-11 flex-1 rounded-xl px-5 text-ui-base"
                      onClick={() => {
                        if (!preferences) setStep(step === 0 ? 1 : 2);
                        else void save();
                      }}
                    >
                      {t(saving ? "saving" : preferences ? "start" : "continue")}
                    </Button>
                  </div>
                </footer>
              </section>
            </div>
          </div>
        </div>
        <OccupationOnboardingVisual
          isMacDesktop={isMacDesktop}
          isWindowsDesktop={isWindowsDesktop}
        />
      </div>
    </main>
  );
}
