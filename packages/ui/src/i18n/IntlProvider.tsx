// ==========================================================================
// ZCodeIntlProvider —— 语言偏好、intl 实例与跨窗口语言同步的唯一 Provider
//
// 做：维护 localePreference 与解析后的 locale，向整棵 UI 树提供 intl 与切换入口。
// 做：从 settingService 读初始偏好，切换时写本地存储、跨窗口广播并尽力持久化。
// 不做：不承载翻译内容，语言表在 ./locales，本文件只查表与替换占位符。
// 边界：system 语义以宿主系统语言为准，浏览器 navigator 只是无宿主时的后备。
// INV 不变量（格式：断言 / 守住位置 / 改错故障）
// INV-01 缺失键必须回退到键名本身而不是空串；守住位置：createIntl 的 messages[id] ?? id；改错故障：未翻译文案整块消失，界面出现空白按钮。
// INV-02 语言表缺失时必须回退到 DEFAULT_LOCALE 表；守住位置：createIntl 的 ?? MESSAGES[DEFAULT_LOCALE]；改错故障：新增语言未注册时中文用户看到英文裸键。
// INV-03 占位符替换必须遍历全部 values 且同名占位符全部覆盖；守住位置：formatMessage 的遍历循环；改错故障：多参数文案只替换首个占位符，界面露出 {count} 原文。
// INV-04 消息对象一经载入不得原地修改；守住位置：createIntl 只读查表、不写 messages；改错故障：某次格式化污染共享表，其他窗口文案错乱。
// INV-05 intl 实例必须按 locale 记忆化，同一 locale 不重建；守住位置：intl 的 useMemo 依赖 [locale]；改错故障：每次渲染都生成新实例，全树消费者被迫重渲染。
// INV-06 context value 必须按五元组依赖记忆化；守住位置：value 的 useMemo 依赖列表；改错故障：父组件任意重渲染都击穿所有 useZCodeIntl 消费者。
// INV-07 locale 必须是 preference 与 systemLocale 的纯派生；守住位置：locale 的 useMemo；改错故障：切换 system 后仍停在旧语言，或出现两份互相矛盾的语言状态。
// INV-08 setLocalePreference 必须先自增序号再改状态；守住位置：setLocalePreference 开头两行；改错故障：旧异步结果覆盖新选择，语言来回跳。
// INV-09 每个异步回调复活前必须校验序号一致；守住位置：setLocalePreference 与初始化 effect 的序号比较；改错故障：连续快速切换后最终语言不是用户最后一次选择。
// INV-10 广播回放必须跳过自己刚发出的 payload；守住位置：ignoredLocalLocaleBroadcastPayloadRef 与 applyingBroadcastRef；改错故障：跨窗口语言同步形成回环，两个窗口反复重设。
// INV-11 广播 payload 必须同时携带 preference 与 resolvedLocale；守住位置：LocaleBroadcastPayload 的构造处；改错故障：system 偏好传到其他窗口被降级成固定语言。
// INV-12 收到广播时必须 bump 序号使在途操作失效；守住位置：onMessage 回调中的自增；改错故障：本地正在等待的解析结果回写，覆盖远端刚同步的语言。
// INV-13 持久化失败不得阻断 UI 状态与广播；守住位置：enqueueLocalePreferenceUpdate 的 catch；改错故障：setting.json 只读时切换语言无任何视觉反馈。
// INV-14 持久化调用不得串成无界等待链；守住位置：void 化的 update 调用；改错故障：一次 RPC 永久 pending 后，后续语言选择全部无法落盘。
// INV-15 preferSettingServiceLocale 时必须以设置服务为准；守住位置：resolveLocalePreferenceFromSettings 的首个分支；改错故障：手机远控残留本地偏好，桌面中文手机英文。
// INV-16 system 模式回写 locale 必须使用宿主解析结果；守住位置：初始化 effect 中 settings.locale 比较处；改错故障：中文系统被错误持久化成英文。
// INV-17 effect 清理必须置 disposed 防止卸载后写状态；守住位置：get 链上的 disposed 判断与 cleanup；改错故障：卸载后仍在写状态，或关窗后继续回写设置。
// INV-18 超出 Provider 使用 useZCodeIntl 必须立刻抛错；守住位置：useZCodeIntl 的 ctx 判空；改错故障：取到空值后再解引用，报错点远离真正的挂载错误。
//
// 全文件只有一份语言偏好与一份解析结果，其他模块通过 context 读取，不得另建副本。
// 广播、持久化、UI 状态三者的顺序是：先本地状态，再广播，最后尽力持久化。
// 读代码时先看 createIntl 的回退链，再看本 Provider 的序号与回环抑制。
import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import type { Locale, LocalePreference } from "@zcode/shared";
import { DEFAULT_LOCALE } from "@zcode/shared";
import type { BroadcastMessage, IBroadcastService, ISettingService } from "@zcode/services";
import { readNavigatorLanguage, readSafeLocalStorage, writeSafeLocalStorage } from "@/lib/browserEnvironment.js";
import zhCN from "./locales/zh-CN.js";
import enUS from "./locales/en-US.js";

/** 语言 → 翻译消息映射 */
// [资源] 语言到消息表的静态映射，模块加载期构建一次，运行期只读。
// Record 的键是 Locale 联合类型，新增语言必须先扩 Locale 再补表，否则类型检查报缺键。
// 不要在运行时向该对象写入，任何增删都改 locales 目录里的源文件。
const MESSAGES: Record<Locale, Record<string, string>> = {
  "zh-CN": zhCN,
  "en-US": enUS,
};

/** 简易 intl 工具：根据 id 查找翻译，支持 {key} 占位符替换 */
export interface IntlInstance {
  formatMessage(descriptor: { id: string }, values?: Record<string, string | number>): string;
}

// [事务] 本地存储只保存用户偏好，不保存解析后的语言，避免两处事实冲突。
// 键名一旦发布就不能改，改了等于让所有存量用户丢失已选语言。
// 频道名 state:locale 与广播服务约定一致，改名会让新旧窗口互相收不到同步。
const LOCALE_PREFERENCE_KEY = "zcode-locale-preference";
const STATE_LOCALE_CHANNEL = "state:locale";

interface LocaleBroadcastPayload {
  preference: LocalePreference;
  resolvedLocale: Locale;
}

function isLocale(value: unknown): value is Locale {
  return value === "zh-CN" || value === "en-US";
}

function isLocalePreference(value: unknown): value is LocalePreference {
  return value === "system" || isLocale(value);
}

// [失败路径] 兼容两种历史 payload：裸 Locale 字符串与结构化对象。
// 任一段校验不过都返回空值，调用方据此丢弃整条消息，不做部分应用。
// 结构化形态必须同时具备 preference 与 resolvedLocale，缺一视为非法。
function resolveLocaleBroadcastPayload(payload: unknown): LocaleBroadcastPayload | null {
  if (isLocale(payload)) {
    return {
      preference: payload,
      resolvedLocale: payload,
    };
  }

  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidate = payload as Partial<LocaleBroadcastPayload>;
  if (
    isLocalePreference(candidate.preference) &&
    isLocale(candidate.resolvedLocale)
  ) {
    return {
      preference: candidate.preference,
      resolvedLocale: candidate.resolvedLocale,
    };
  }

  return null;
}

// `resolveLocalePreferenceFromSettings` 中远控入口以设置服务为准，其余入口按「本地存储 > 设置偏好 > 设置语言」回落。
// 首分支两个分支当前同值，保留结构是为了将来区分 system 偏好与具体语言的落盘策略。
// 空值表示没有任何可用来源，调用方必须保持原状态而不是猜一个语言。
export function resolveLocalePreferenceFromSettings({
  storedPreference,
  settingsLocale,
  settingsLocalePreference,
  preferSettingServiceLocale,
}: {
  storedPreference: LocalePreference | null;
  settingsLocale: Locale | undefined;
  settingsLocalePreference: LocalePreference | undefined;
  preferSettingServiceLocale: boolean;
}): LocalePreference | null {
  if (preferSettingServiceLocale && settingsLocale) {
    if (settingsLocalePreference === "system") {
      return settingsLocale;
    }
    return settingsLocale;
  }

  return storedPreference ?? settingsLocalePreference ?? settingsLocale ?? null;
}

// [并发] 频道不符或 payload 非法直接拒绝，避免其他频道消息误触语言切换。
// sourceWindowId 缺省表示来源未知，此时才用 ignoredLocalPayload 比对自身回显。
// true 只代表结构合法，是否真正应用仍由调用方的序号校验决定。
export function shouldApplyLocaleBroadcastMessage(
  message: Pick<BroadcastMessage, "channel" | "payload" | "sourceWindowId">,
  options: {
    ignoredLocalPayload?: LocaleBroadcastPayload | null;
  } = {},
): message is Pick<BroadcastMessage, "channel"> & { payload: Locale | LocaleBroadcastPayload } {
  const payload = resolveLocaleBroadcastPayload(message.payload);
  if (message.channel !== STATE_LOCALE_CHANNEL || !payload) {
    return false;
  }
  if (
    message.sourceWindowId === undefined &&
    options.ignoredLocalPayload?.preference === payload.preference &&
    options.ignoredLocalPayload.resolvedLocale === payload.resolvedLocale
  ) {
    return false;
  }
  return true;
}

// [契约] 这里是语言回退链的唯一实现：缺失键取默认语言表，再缺失取键名本身。
// 查表用 ?? 而不是 ||，空串是合法翻译，不能被当成缺失吞掉。
// 占位符替换逐项遍历 values，用 replaceAll 支持同名占位符多次出现。
// messages 全程只读，函数不缓存替换结果，避免同一实例内出现脏数据。
// [权衡] 每次调用都重算字符串不做记忆化，文案短且调用分散，缓存收益低于维护成本。
// locale 超出联合类型时由兜底逻辑落到默认表，保证任何调用都有可读输出。
function createIntl(locale: Locale): IntlInstance {
  // noUncheckedIndexedAccess：用 ?? 回退到默认语言的翻译
  const messages = MESSAGES[locale] ?? MESSAGES[DEFAULT_LOCALE]!;
  return {
    formatMessage({ id }, values) {
      let msg = messages[id] ?? id;
      if (values) {
        for (const [key, val] of Object.entries(values)) {
          msg = msg.replaceAll(`{${key}}`, String(val));
        }
      }
      return msg;
    },
  };
}

interface IntlContextValue {
  intl: IntlInstance;
  locale: Locale;
  localePreference: LocalePreference;
  setLocale: (locale: Locale) => void;
  setLocalePreference: (localePreference: LocalePreference) => void;
}

// [契约] 默认值为 null，用于区分未挂载 Provider 与已挂载但语言恰为默认值。
// Context 只传递实例与切换函数，不传递翻译表，避免消费者直接读原始消息。
// 不要在模块级缓存 useContext 结果，换 Provider 后需要重新订阅。
const IntlContext = createContext<IntlContextValue | null>(null);

/**
 * 国际化 Provider —— 管理当前语言和 intl 实例。
 * 如果传入 settingService，会从设置中读取初始语言并在切换时持久化。
 */
// [并发] 三个 ref 分别承担回环标记、自身回显过滤与操作序号，三者职责不可合并。
// 所有依赖外部服务的回调都进 useCallback，保证 effect 依赖稳定、不重复订阅。
// [边界] settingService 与 broadcastService 都可缺省，Web 与测试环境只注入其中一部分。
export function ZCodeIntlProvider({
  children,
  settingService,
  broadcastService,
  initialLocale,
  preferSettingServiceLocale = false,
  resolveSystemLocale: resolveHostSystemLocale,
}: {
  children: ReactNode;
  settingService?: ISettingService;
  broadcastService?: Pick<IBroadcastService, "send" | "onMessage">;
  initialLocale?: Locale;
  preferSettingServiceLocale?: boolean;
  resolveSystemLocale?: () => Locale | Promise<Locale>;
}) {
  const applyingBroadcastRef = useRef(false);
  const ignoredLocalLocaleBroadcastPayloadRef = useRef<LocaleBroadcastPayload | null>(null);
  const localePreferenceOperationSeqRef = useRef(0);
  const resolveNavigatorSystemLocale = useCallback((): Locale => {
    const language = readNavigatorLanguage();
    if (!language) {
      return DEFAULT_LOCALE;
    }

    return language.toLowerCase().startsWith("zh")
      ? "zh-CN"
      : "en-US";
  }, []);
  const resolveSystemLocale = useCallback(async (): Promise<Locale> => {
    const resolvedLocale = await resolveHostSystemLocale?.();
    if (isLocale(resolvedLocale)) {
      return resolvedLocale;
    }
    return resolveNavigatorSystemLocale();
  }, [resolveHostSystemLocale, resolveNavigatorSystemLocale]);

  const readStoredPreference = useCallback((): LocalePreference | null => {
    const raw = readSafeLocalStorage(LOCALE_PREFERENCE_KEY);
    if (isLocalePreference(raw)) {
      return raw;
    }
    return null;
  }, []);

  const persistLocalePreference = useCallback((preference: LocalePreference) => {
    writeSafeLocalStorage(LOCALE_PREFERENCE_KEY, preference);
  }, []);

  const [localePreference, setLocalePreferenceState] = useState<LocalePreference>(
    () => initialLocale ?? readStoredPreference() ?? "system",
  );
  const [systemLocale, setSystemLocale] = useState<Locale>(() => resolveNavigatorSystemLocale());
  // [失败路径] 序号过期说明用户已再次切换，本次结果必须静默丢弃，不写盘。
  // 持久化 RPC 不 await、只捕获错误，写入顺序交给底层服务，本层只做最新操作校验。
  const enqueueLocalePreferenceUpdate = useCallback(
    (operationSeq: number, resolvedLocale: Locale, preference: LocalePreference) => {
      if (localePreferenceOperationSeqRef.current !== operationSeq) {
        return;
      }

      // Provider 层不能把持久化 RPC 串成无界等待链。
      // 一次 settingService.update 永久 pending 时，后续语言选择仍要继续尝试落盘；
      // 底层 settingService 负责文件写入顺序，这里只做最新操作校验和错误收口。
      void settingService?.update({
        locale: resolvedLocale,
        localePreference: preference,
      }).catch(() => {
        // 持久化失败不阻断 UI 状态和跨窗口广播，下一次语言操作会再次尝试写入。
      });
    },
    [settingService],
  );

  // [事务] 初始化只在首帧之后执行一次，disposed 与序号双重校验防止过期回写。
  // 依赖列表必须包含全部回调包装过的函数，漏一个就会读到旧闭包。
  // 从 settingService 读取持久化的 locale
  useEffect(() => {
    if (!settingService) return;
    let disposed = false;
    const initialOperationSeq = localePreferenceOperationSeqRef.current;
    settingService.get().then(async (settings) => {
      if (disposed || localePreferenceOperationSeqRef.current !== initialOperationSeq) {
        return;
      }
      const nextPreference = resolveLocalePreferenceFromSettings({
        storedPreference: readStoredPreference(),
        settingsLocale: settings.locale,
        settingsLocalePreference: settings.localePreference,
        preferSettingServiceLocale,
      });
      if (disposed) {
        return;
      }
      if (nextPreference) {
        // 手机远控和桌面连接到同一个 settingService，但手机浏览器本地可能残留
        // en-US/system 偏好。远控入口必须以桌面 setting.json 为准，否则会出现桌面中文、手机英文。
        setLocalePreferenceState(nextPreference);
        if (preferSettingServiceLocale) {
          persistLocalePreference(nextPreference);
        }
        if (nextPreference === "system") {
          const resolvedLocale = await resolveSystemLocale();
          if (
            disposed ||
            localePreferenceOperationSeqRef.current !== initialOperationSeq
          ) {
            return;
          }
          setSystemLocale(resolvedLocale);
          if (settings.locale !== resolvedLocale) {
            // setting.json 里的 locale 是 main 进程菜单、远控等非浏览器上下文的实际语言。
            // system 模式必须使用宿主系统语言；Electron renderer 的 navigator.language 可能和
            // macOS app.getLocale() 不一致，直接写回会把中文系统错误持久化成英文。
            enqueueLocalePreferenceUpdate(initialOperationSeq, resolvedLocale, "system");
          }
        }
      }
    });
    return () => {
      disposed = true;
    };
  }, [
    persistLocalePreference,
    preferSettingServiceLocale,
    readStoredPreference,
    enqueueLocalePreferenceUpdate,
    resolveSystemLocale,
    settingService,
  ]);

  // [契约] locale 是唯一对外的解析结果，preference 只作为切换语义保留。
  // system 时跟随 systemLocale，具体语言时直接等于 preference。
  // 依赖只有两项，新增派生因素必须同时进依赖数组，否则切换不生效。
  const locale = useMemo<Locale>(() => {
    return localePreference === "system" ? systemLocale : localePreference;
  }, [localePreference, systemLocale]);

  // [并发] 先自增序号再置状态，保证同一次点击的异步链能看到自己的序号。
  // 广播先于持久化发出，跨窗口一致性优先于磁盘写入完成。
  const setLocalePreference = useCallback(
    (newPreference: LocalePreference) => {
      const operationSeq = localePreferenceOperationSeqRef.current + 1;
      localePreferenceOperationSeqRef.current = operationSeq;
      setLocalePreferenceState(newPreference);
      persistLocalePreference(newPreference);
      void (async () => {
        const resolvedLocale =
          newPreference === "system" ? await resolveSystemLocale() : newPreference;
        if (localePreferenceOperationSeqRef.current !== operationSeq) {
          return;
        }
        if (newPreference === "system") {
          setSystemLocale(resolvedLocale);
        }
        const broadcastPayload: LocaleBroadcastPayload = {
          preference: newPreference,
          resolvedLocale,
        };
        if (!applyingBroadcastRef.current && broadcastService) {
          // 跨窗口语言同步不能等待 settingService 持久化 RPC。
          // 持久化可能超时或拒绝，但本地 UI 与其他窗口应先按用户最后一次选择同步。
          ignoredLocalLocaleBroadcastPayloadRef.current = broadcastPayload;
          void broadcastService.send({
            channel: STATE_LOCALE_CHANNEL,
            payload: broadcastPayload,
          }).finally(() => {
            if (
              ignoredLocalLocaleBroadcastPayloadRef.current?.preference === broadcastPayload.preference &&
              ignoredLocalLocaleBroadcastPayloadRef.current.resolvedLocale === broadcastPayload.resolvedLocale
            ) {
              ignoredLocalLocaleBroadcastPayloadRef.current = null;
            }
          });
        }
        enqueueLocalePreferenceUpdate(operationSeq, resolvedLocale, newPreference);
      })();
    },
    [broadcastService, enqueueLocalePreferenceUpdate, persistLocalePreference, resolveSystemLocale],
  );

  useEffect(() => {
    if (!broadcastService) {
      return;
    }

    // [资源] 订阅在 cleanup 中释放，防止热更新或卸载后累积多个监听。
    // 应用广播时置 applyingBroadcastRef，阻止本地再发一次广播形成回环。
    const subscription = broadcastService.onMessage((message) => {
      if (
        !shouldApplyLocaleBroadcastMessage(message, {
          ignoredLocalPayload: ignoredLocalLocaleBroadcastPayloadRef.current,
        })
      ) {
        return;
      }

      ignoredLocalLocaleBroadcastPayloadRef.current = null;
      const payload = resolveLocaleBroadcastPayload(message.payload);
      if (!payload) {
        return;
      }
      applyingBroadcastRef.current = true;
      try {
        // 语言切换真实发生在 IntlProvider，不能只依赖 store 里的 locale 字段。
        // 结构化广播需要同时携带用户偏好和解析语言，避免 system 被其他窗口降级成固定语言。
        localePreferenceOperationSeqRef.current += 1;
        setLocalePreferenceState(payload.preference);
        persistLocalePreference(payload.preference);
        setSystemLocale(payload.resolvedLocale);
      } finally {
        applyingBroadcastRef.current = false;
      }
    });

    return () => subscription.dispose();
  }, [broadcastService, persistLocalePreference]);

  const setLocale = useCallback(
    (newLocale: Locale) => {
      setLocalePreference(newLocale);
    },
    [setLocalePreference],
  );

  // [权衡] 按 locale 记忆化实例，跨语言切换才重建，语言内的重渲染复用同一个对象。
  // [并发] 依赖若写成 preference，会让 system 模式在偏好不变时误重建实例。
  // 不要把它降级成 useRef 缓存，ref 变更不会触发消费者更新。
  const intl = useMemo(() => createIntl(locale), [locale]);

  // [权衡] value 只依赖五元组，父组件因其他状态重渲染时消费者不会跟着重渲染。
  // 依赖数组必须与对象字面量字段一一对应，多一个少一个都会破坏引用稳定。
  const value = useMemo<IntlContextValue>(
    () => ({ intl, locale, localePreference, setLocale, setLocalePreference }),
    [intl, locale, localePreference, setLocale, setLocalePreference],
  );

  return <IntlContext value={value}>{children}</IntlContext>;
}

/** 获取 intl 上下文 */
// [失败路径] 缺少 Provider 时同步抛错，把配置错误暴露在最近的调用栈。
// 错误文案本身不使用翻译，避免在 i18n 未就绪时再依赖 i18n。
export function useZCodeIntl(): IntlContextValue {
  const ctx = useContext(IntlContext);
  if (!ctx) {
    throw new Error("useZCodeIntl 必须在 ZCodeIntlProvider 内使用");
  }
  return ctx;
}
