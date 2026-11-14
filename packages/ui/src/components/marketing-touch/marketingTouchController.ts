// [文件] marketing-touch 控制器：把服务端营销投放（banner / popup）落位到左下角槽位与云弹窗，
//         并串起「查询 → 资源准备 → 动作执行 → 结果上报 → 资源释放」的完整状态机。
// [结构] 纯 zustand/vanilla store 加闭包级可变状态，不依赖 React，渲染层只订阅快照。
// [并发] 无锁设计：disposed 与 generation 双版本号在单线程事件循环里承担乐观并发控制。
// [实体] Candidate 等于已准备资源加 scope，同一 Campaign 在不同凭据作用域下互不复用。
// [资源] 每个 Candidate 自带 release，任何被替换、丢弃、过期的候选都必须显式归还。
// INV-01 disposed 一旦置真永不回退，唯一写点是 dispose()，所有异步续点先查它，放宽会让已销毁实例的 setState 覆盖新实例。
// INV-02 generation 只增不减，入口在 refresh() 与失效动作处自增，改成可退会让旧快照覆盖新投放。
// INV-03 迟到快照必被丢弃，守卫在 refresh() 的 await 之后（current 不等于 generation 即返回），删除会出现双份资源与重复上报。
// INV-04 替换横幅前先 release，守卫在 refresh() 的空投放与内容不等分支，漏释放会泄漏 blob 图片与视频句柄。
// INV-05 pending 期间不改 banner，守卫在 refresh() 落位分支写 deferredBanner，直写会让执行中的按钮失去宿主。
// INV-06 deferredBanner 三态不可混淆，语义澄清点在 finally 的重算处，把 null 当 undefined 会误清正在展示的横幅。
// INV-07 同一弹窗不重复排队，守卫在 popupWire 的 key 比较（位置加 Campaign），去掉会堆叠多个同源弹窗。
// INV-08 scope 变更即失效等待中的弹窗，守卫在 refresh() 比较 snapshotScope，忽略会把旧凭据的弹窗弹给新用户。
// INV-09 出队单飞，守卫在 showPending 入口的 pending、dialog、错误动作与 canOpen 四项检查，缺一即弹窗叠加。
// INV-10 waitingResult 优先于 waitingPopup，顺序固定写死在 showPending，反转会让结果页被普通投放挤掉。
// INV-11 completed 仅在非 copy_text 成功或终局失败时置真，守卫在 run 的两处赋值，扩大范围会让横幅提前消失。
// INV-12 复制不清理横幅，守卫在 run 的 copy_text 提前返回，沿用领取清理会使首次复制即移除入口。
// INV-13 成功弹窗需二次准备并回退原 hero，守卫在 success_popup 分支的空值合并，丢弃回退会让视频未就绪时弹窗空白。
// INV-14 finally 必复位 pending 与 phase，守卫在 run 的 finally 块，缺失会让 UI 永久停在验证中。
// INV-15 资源归属用 release 引用相等判定，守卫在 finally 的三处比较，换成结构比较会误放共享资源。
// INV-16 仅在领取成功后刷新，守卫在 finally 末尾的 claim_zcode_plan 限定，放开会让已关闭旧弹窗被异步 confirm 拉回。
// INV-17 上报失败不影响主流程，守卫在 report 的内部 catch，改成抛出会中断释放链路。
// INV-18 释放可空且容忍失败，守卫在 release 的判空与 catch，非幂等实现会导致重复释放。
// INV-19 dispose 释放全部五类持有，守卫在 dispose 的连续 release 调用，漏一类即长会话内存泄漏。
// INV-20 AbortSignal 与控制器同生命周期，守卫在 lifetime 仅在 dispose abort，提前 abort 会把进行中的领取判为取消。
import { createStore } from "zustand/vanilla";
import type { IMarketingTouchService } from "@zcode/services";
import type { MarketingAction, MarketingDelivery } from "@zcode/shared";
import type { CloudDialogHero } from "@/components/cloud-content-dialog/cloudContentDialogTypes.js";
import type { PreparedMarketingHero } from "@/components/marketing-touch/marketingResources.js";
import { logger } from "@/logger.js";

// [契约] PreparedMarketingDelivery 是「已备好可渲染」的唯一载体：wire 层决定投放身份，
// image / darkImage / bannerHero / hero 决定渲染输入，两者不可拆成两处状态。
// [资源] release 与 success 同属一次取得，调用方丢弃该对象前必须 release，否则图片与视频句柄泄漏。
export interface PreparedMarketingDelivery {
  delivery: MarketingDelivery;
  image?: string;
  darkImage?: string;
  bannerHero?: Extract<CloudDialogHero, { type: "interactive_bundle" | "video" }>;
  hero: CloudDialogHero | null;
  success?: Promise<PreparedMarketingHero>;
  release: () => Promise<void>;
}
// [实体] Candidate 在准备好的资源上追加 scope，用于区分同一 Campaign 在不同账号凭据下的实例。
// 进行中的动作只认自己那份 Candidate，scope 换掉后旧实例不得再被复用。
type Candidate = PreparedMarketingDelivery & { scope: string };
// 导出以便 controller 类型（经 MarketingTouchContext）可被 .d.ts 命名引用。
// [状态] banner 与 dialog 互斥持有资源，pending 表示有动作在执行，phase 只影响文案不影响资源。
// [不变量] pending 为真的窗口内不得替换 banner（改用 deferredBanner 暂存），否则执行中的按钮会失去宿主。
// error 与 errorAction 成对写入，showPending 依赖 errorAction 判断是否让出弹窗槽位。
export interface MarketingTouchState {
  banner: Candidate | null;
  dialog: (Candidate & { result: boolean }) | null;
  pending: boolean;
  phase: "idle" | "verifying" | "submitting" | "preparing";
  error: string | null;
  errorAction: MarketingAction["type"] | null;
}
// [语义] status 四态：success 已确认、cancelled 用户取消、failure 可重试失败、uncertain 结果未知。
// terminal 表示服务端已终局，run() 据此决定是否丢弃操作前的迟到快照。
export type MarketingActionResult = {
  status: "success" | "cancelled" | "failure" | "uncertain";
  message?: string;
  terminal?: boolean;
};

// 左下角活动槽位的唯一可见性判断：Banner 与 ConnectedBanner 的渲染守卫共用此谓词，
// 避免仲裁层（SidebarBottomActivity）与展示层对「Banner 是否可见」出现两套判断而漂移。
// 领取 pending 期间 banner 仍非空 → 判定可见，Highspeed 分享卡继续让位。
// 用类型谓词收窄 delivery 到 banner 变体，保留调用点原有的 narrowing。
type RenderableBannerCandidate = Candidate & {
  delivery: Extract<MarketingDelivery, { resource_position: "banner" }>;
};
// [可见性] 该谓词是槽位的唯一判定：同时要求位置为 banner 且具备 image 或 bannerHero，两条都满足才可见。
// [并发] pending 期间 banner 保持非空，因此这里持续返回真，Highspeed 分享卡继续让位。
// 这里是类型谓词，返回真时把 delivery 收窄到 banner 变体，调用点无需再断言即可访问 banner 字段。
export function isMarketingBannerRenderable(
  banner: Candidate | null,
): banner is RenderableBannerCandidate {
  return Boolean(
    banner && banner.delivery.resource_position === "banner" && (banner.image || banner.bannerHero),
  );
}

// [装配] 控制器以依赖注入方式接收 query / report / prepare / execute，自身不持有任何网络实现。
// 所有副作用都必须经 options 回落到宿主，便于测试替换与多实例复用。
// canOpen 是宿主闸门（例如模态互斥），refresh 由控制器在领取成功后回调，不由调用方轮询。
export function createMarketingTouchController(options: {
  query: () => ReturnType<IMarketingTouchService["query"]>;
  report: IMarketingTouchService["report"];
  prepare: (delivery: MarketingDelivery) => Promise<PreparedMarketingDelivery>;
  execute: (
    action: MarketingAction,
    signal: AbortSignal,
    phase: (phase: MarketingTouchState["phase"]) => void,
  ) => Promise<MarketingActionResult>;
  locale: "zh-CN" | "en-US";
  canOpen: () => boolean;
  refresh: () => void;
}) {
  const store = createStore<MarketingTouchState>(() => ({
    banner: null,
    dialog: null,
    pending: false,
    phase: "idle",
    error: null,
    errorAction: null,
  }));
  // [并发] disposed 是终身开关：dispose() 之外无人可写，所有 await 之后的续点都先查它。
  // [状态] generation 是快照代际，refresh 与失效动作都会自增，用于丢弃迟到返回。
  // 其余闭包变量（scope、lastSuccess、failureLogged、等待队列）都是单实例单线程的隐式锁。
  let disposed = false;
  let generation = 0;
  let snapshotScope = "";
  let lastSuccess = 0;
  let failureLogged = false;
  // [并发] deferredBanner 三态：undefined 无延迟投放、null 服务端撤回、Candidate 待落位。
  // 混淆 undefined 与 null 会让 finally 把正在展示的横幅误清空。
  let deferredBanner: Candidate | null | undefined;
  let waitingPopup: Candidate | null = null;
  let waitingResult: Candidate | null = null;
  // [资源] lifetime 的唯一 abort 点是 dispose()，信号贯穿全部 execute 调用。
  // 提前 abort 会把进行中的领取判成取消，用户看到的是「操作被中断」而非终局结果。
  const lifetime = new AbortController();
  const key = (delivery: MarketingDelivery) =>
    `${delivery.resource_position}:${delivery.campaign_id}`;
  // [资源] release 是统一的归还入口：判空后调用，并吞掉异常只记 warn，避免释放失败打断主流程。
  // [幂等] 上层用 release 的引用相等判断资源归属，同一 Candidate 可能被多处比较但只应释放一次。
  // [权衡] 这里刻意不等待释放结果，释放变慢或失败都不阻塞 UI 状态推进。
  const release = (value: PreparedMarketingDelivery | null | undefined) => {
    if (value)
      void value.release().catch(() => logger.warn("[marketing-touch] resource release failed"));
  };
  // [上报] 上报是旁路：发后即忘，失败只 warn，绝不改变状态机。
  // [不变量] report 入口先查 disposed，已销毁的控制器不再产生任何远端写。
  // [失败路径] 上报丢失只影响运营统计，不影响用户已经看到的成功结果。
  function report(value: Candidate, actionType: "confirm" | "cancel") {
    if (disposed) return;
    void options
      .report({
        scope: value.scope,
        campaignId: value.delivery.campaign_id,
        actionType,
        locale: options.locale,
      })
      .catch(() =>
        logger.warn("[marketing-touch] action report failed", {
          campaignId: value.delivery.campaign_id,
          actionType,
        }),
      );
  }
  // [事务] 失效操作前快照：代际自增使在途 query 的结果注定被丢弃，等价于一次乐观提交。
  // 同时释放 deferredBanner，因为延迟投放绑定的是旧代际，继续保留会覆盖新结果。
  // [权衡] 不记录历史展示，服务端可重新投放同一 Campaign，避免本地黑名单拦住运营改投。
  function invalidatePendingSnapshot() {
    // 原先按 Campaign 记录历史会拦住服务端重新投放；这里只丢弃操作前的迟到快照。
    generation++;
    release(deferredBanner);
    deferredBanner = undefined;
  }
  // [并发] refresh 可重入：每次入口自增 generation 并捕获 current，旧调用在 await 后自行退出。
  // [事务] 全流程无锁，用「快照 → 差量落位」重算状态，不依赖上一次的中间态。
  // [失败路径] 抛出的错误只做超时降级，不清空错误分支之外的状态。
  async function refresh() {
    const current = ++generation;
    try {
      // [事务] await 是唯一可被打断点：此处之后必须同时校验 disposed 与 current。
      // 缺任一判断都会让卸载后或过期的快照写入 store，表现为弹窗闪回与重复上报。
      const snapshot = await options.query();
      if (disposed || current !== generation) return;
      if (snapshotScope && snapshotScope !== snapshot.scope) {
        // 同账号凭据更新也失效旧事件上下文，已打开业务操作不移交给新凭据。
        release(waitingPopup);
        waitingPopup = null;
      }
      snapshotScope = snapshot.scope;
      failureLogged = false;
      lastSuccess = Date.now();
      const state = store.getState();
      const bannerWire = snapshot.deliveries.find((d) => d.resource_position === "banner");
      const popupWire = snapshot.deliveries.find(
        (d) =>
          d.resource_position === "popup" &&
          // 只避免当前已打开弹窗重复排队，不记录历史展示状态。
          (!state.dialog || state.dialog.result || key(state.dialog.delivery) !== key(d)),
      );
      if (!popupWire || JSON.stringify(waitingPopup?.delivery) !== JSON.stringify(popupWire)) {
        release(waitingPopup);
        waitingPopup = null;
      }
      // [失败路径] 服务端撤回横幅：pending 时只清延迟槽，非 pending 时才释放当前横幅并置空。
      // [资源] 先 release 再 setState，避免渲染层拿到已释放资源的中间帧。
      // pending 期间保留展示，是为了不让执行中的按钮因网络抖动而消失。
      if (!bannerWire) {
        if (state.pending) {
          release(deferredBanner);
          deferredBanner = null;
        } else {
          release(state.banner);
          store.setState({ banner: null });
        }
      }
      if (
        bannerWire &&
        state.banner &&
        !state.pending &&
        JSON.stringify(state.banner.delivery) !== JSON.stringify(bannerWire)
      ) {
        release(state.banner);
        store.setState({ banner: null });
      }
      // [并发] 同一快照内的准备并行执行，但落位仍是串行的，避免两路 prepare 互相覆盖横幅。
      // 非目标投放直接跳过，只有 bannerWire 与 popupWire 会消耗准备成本。
      // [资源] 每个提前返回的分支都必须确认不存在未释放的 prepared，否则句柄泄漏。
      await Promise.all(
        snapshot.deliveries.map(async (delivery) => {
          if (delivery !== bannerWire && delivery !== popupWire) return;
          if (
            delivery === bannerWire &&
            JSON.stringify(state.banner?.delivery) === JSON.stringify(delivery)
          ) {
            if (!state.pending && state.banner)
              store.setState({ banner: { ...state.banner, scope: snapshot.scope } });
            return;
          }
          if (delivery === popupWire && waitingPopup) return;
          if (disposed || current !== generation) return;
          let prepared: PreparedMarketingDelivery;
          try {
            prepared = await options.prepare(delivery);
          } catch {
            logger.warn("[marketing-touch] banner resource rejected", {
              campaignId: delivery.campaign_id,
            });
            return;
          }
          if (disposed || current !== generation) {
            release(prepared);
            return;
          }
          const candidate = { ...prepared, scope: snapshot.scope };
          if (delivery.resource_position === "banner") {
            if (store.getState().pending) {
              release(deferredBanner);
              deferredBanner = candidate;
            } else {
              release(store.getState().banner);
              store.setState({ banner: candidate });
            }
          } else {
            release(waitingPopup);
            waitingPopup = candidate;
          }
        }),
      );
    // [失败路径] 查询失败不清空内容：仅首次记录 warn，随后按十分钟新鲜度决定是否降级。
    // [权衡] 保留最近内容优先于正确性，网络抖动时旧横幅仍在，收益是 UI 稳定，代价是可能过期。
    // 错误向上抛出，由宿主决定是否重试，控制器不内建退避以免与外部调度重复。
    } catch (error) {
      if (!disposed && current === generation) {
        if (!failureLogged) logger.warn("[marketing-touch] query failed; keeping recent content");
        failureLogged = true;
        if (Date.now() - lastSuccess > 600_000 && !store.getState().pending) {
          release(store.getState().banner);
          store.setState({ banner: null });
        }
      }
      throw error;
    }
  }
  // [并发] 出队是单飞：pending / dialog / 错误动作 / canOpen 任一成立即让位，保证弹窗不叠加。
  // 错误状态可能早于 React 弹窗挂载，因此这里必须查 store 而不是 DOM。
  // waitingResult 优先于 waitingPopup，顺序反转会让普通投放挤掉领取成功的结果页。
  async function showPending() {
    const state = store.getState();
    // 错误状态先于 React 弹窗挂载；仅检查 DOM 会让等待中的投放抢先出队并叠加。
    if (
      disposed ||
      state.pending ||
      state.dialog ||
      (state.errorAction === "claim_zcode_plan" && state.error) ||
      !options.canOpen()
    )
      return;
    if (waitingResult) {
      const result = waitingResult;
      waitingResult = null;
      store.setState({ dialog: { ...result, result: true } });
      return;
    }
    if (!waitingPopup) return;
    const candidate = waitingPopup;
    waitingPopup = null;
    store.setState({ dialog: { ...candidate, result: false } });
  }
  // [事务] run 是一次串行事务：入口判 pending 防重入，finally 必复位，失败不回滚已上报的副作用。
  // [状态] pending / phase / error 的写入顺序决定 UI 时序，先清 error 再进入 verifying。
  // 成功判定包含 confirm 上报，即使上报失败也视为成功，统计缺失不影响用户结果。
  async function run(candidate: Candidate, action: MarketingAction) {
    if (disposed || store.getState().pending) return;
    store.setState({ pending: true, phase: "verifying", error: null, errorAction: null });
    let completed = false;
    let succeeded = false;
    try {
      const result = await options.execute(action, lifetime.signal, (phase) => {
        if (!disposed) store.setState({ phase });
      });
      if (disposed) return;
      // [失败路径] 失败分支区分终局与可重试：terminal 或 uncertain 才丢弃操作前快照。
      // uncertain 表示结果未知，保留内容会诱导用户重复领取，故与终局同等处理。
      // 错误文案与 errorAction 一并写入，showPending 靠 errorAction 判断是否让出槽位。
      if (result.status !== "success") {
        if (
          (action.type === "claim_zcode_plan" || action.type === "open_url") &&
          (result.terminal || result.status === "uncertain")
        ) {
          completed = true;
          invalidatePendingSnapshot();
        }
        store.setState({ error: result.message ?? null, errorAction: action.type });
        return result;
      }
      completed = action.type !== "copy_text";
      succeeded = true;
      invalidatePendingSnapshot();
      report(candidate, "confirm");
      // 复制是可重复操作；不能沿用领取的完成清理，否则首次复制就会移除内容。
      if (action.type === "copy_text") return result;
      if (
        action.type !== "navigate" &&
        candidate.delivery.resource_position === "banner" &&
        candidate.delivery.banner.success_popup
      ) {
        store.setState({ phase: "preparing" });
        const prepared = await candidate.success;
        if (disposed) return;
        // 业务等待期间也可能打开别的 modal；结果排队到安全展示点，不能直接叠加。
        waitingResult = { ...candidate, hero: prepared?.hero ?? candidate.hero };
      } else {
        if (store.getState().dialog === candidate) {
          store.setState({ dialog: null });
          release(candidate);
        }
      }
      return result;
    // [事务] finally 是唯一复位点：pending 归零、phase 归 idle、横幅按 deferred 三态重算。
    // [资源] 用 release 引用相等判定归属，被替换、已入弹窗、已排队结果的资源都豁免释放。
    // 复位后再出队弹窗，顺序反转会让新弹窗在 pending 为真时被拒绝。
    } finally {
      if (!disposed) {
        const state = store.getState();
        const next =
          deferredBanner === undefined
            ? completed && state.banner?.release === candidate.release
              ? null
              : state.banner
            : deferredBanner;
        deferredBanner = undefined;
        if (
          state.banner &&
          state.banner.release !== next?.release &&
          state.banner.release !== state.dialog?.release &&
          state.banner.release !== waitingResult?.release
        )
          release(state.banner);
        store.setState({ pending: false, phase: "idle", banner: next });
        await showPending();
        // 只有领取会改变资格；外链等动作立即查询会与异步 confirm 竞争，使已关闭的旧弹窗重开。
        if (succeeded && action.type === "claim_zcode_plan" && !disposed) options.refresh();
      }
    }
  }
  return {
    store,
    refresh,
    showPending,
    async clickBanner() {
      const candidate = store.getState().banner;
      if (
        !candidate ||
        candidate.delivery.resource_position !== "banner" ||
        store.getState().dialog
      )
        return;
      const action = candidate.delivery.banner.buttons.find(
        (b) => b.action.type !== "close",
      )?.action;
      if (action) await run(candidate, action);
    },
    async closeBanner() {
      const candidate = store.getState().banner;
      if (!candidate || store.getState().pending) return;
      invalidatePendingSnapshot();
      store.setState({ banner: null });
      report(candidate, "cancel");
      release(candidate);
    },
    // [陷阱] closeDialog 与 closeBanner 同构：先失效代际再置空，最后按 result 决定是否上报取消。
    // result 为真表示这是结果页，关闭属于确认后的收尾，重复上报 cancel 会污染转化率。
    // [资源] 释放放在最后，确保 store 已不再引用该候选，避免释放后仍被渲染。
    async closeDialog() {
      const dialog = store.getState().dialog;
      if (!dialog || store.getState().pending) return;
      invalidatePendingSnapshot();
      store.setState({ dialog: null });
      if (!dialog.result) report(dialog, "cancel");
      release(dialog);
    },
    async dialogAction(action: MarketingAction) {
      const dialog = store.getState().dialog;
      if (dialog) return run(dialog, action);
    },
    clearError() {
      store.setState({ error: null, errorAction: null });
    },
    // [资源] dispose 一次性释放五类持有：banner / dialog / waitingPopup / waitingResult / deferredBanner。
    // 顺序为：先置 disposed 与自增代际（阻断续点），再 abort，最后逐个 release。
    // 漏掉任一类别都会让图片或视频句柄活到页面关闭，长会话下表现为内存与解码器占用持续上涨。
    dispose() {
      disposed = true;
      generation++;
      lifetime.abort();
      release(store.getState().banner);
      release(store.getState().dialog);
      release(waitingPopup);
      release(waitingResult);
      release(deferredBanner);
      store.setState({ banner: null, dialog: null, pending: false });
    },
  };
}
// [导出] `MarketingTouchController` 由 `ReturnType` 反推，新增对外方法无需同步维护两处签名。
// [契约] 外部只依赖该别名，内部实现的闭包变量不进入公共类型面。
export type MarketingTouchController = ReturnType<typeof createMarketingTouchController>;
