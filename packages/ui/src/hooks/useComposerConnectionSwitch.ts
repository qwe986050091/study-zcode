// INV-01 守住位置：第1行导入 completeNewModelSelection，保证模型与档位补全只来自 provider 包；改错故障：换成本地拼装会让团队模型缺失 reasoningLevel，选中后静默降智。
// INV-02 守住位置：第16行导出签名，入参必须显式声明 presentationStatus 与 workspaceIdentity；改错故障：漏传身份会让不同团队共用同一 workspaceKey，切换后读到别人的目录。
// INV-03 守住位置：第39至46行解析 base 与 target 两套服务；改错故障：把 target 指回 base 会让远端团队连接永远显示同步完成，实际仍读本地配置。
// INV-04 守住位置：第47行 workspaceKey 归一，identity 为空才退回路径；改错故障：顺序颠倒会让匿名工作区与具名工作区互相顶掉缓存，出现跨项目串态。
// INV-05 守住位置：第48至50行生成 token 并写入 owner；改错故障：token 跟着渲染重建会让每次暂停点都判定自己过期，切换永远停在 pending。
// INV-06 守住位置：第51行 inFlight 同步闸门；改错故障：改成 state 会让连点两次都通过守卫，发出两条互斥的持久化事务。
// INV-07 守住位置：第52至61行五项状态的初值；改错故障：初值带 expectedRevision 会让首帧就被误判为等待中，工具条空转。
// INV-08 守住位置：第62至68行重置作用域；改错故障：漏清 inFlight 会让换工作区后的第一次点击被上一代标记吞掉。
// INV-09 守住位置：第69至78行错误终态判定；改错故障：去掉 revision 比较会把上一轮失败回执嫁祸给本轮切换，成功也报失败。
// INV-10 守住位置：第84至91行 ready 的 revision 下界；改错故障：删掉提前返回会让旧目录版本提前结束等待，界面闪出新旧混合帧。
// INV-11 守住位置：第95至104行匹配判定；改错故障：不比对 normalizedValue 会让被过滤的选择永久挂起，工具条卡死 loading。
// INV-12 守住位置：第115至122行 select 入口；改错故障：先写 pending 再判定守卫会让禁用连接也显示等待中，用户无从重试。
// INV-13 守住位置：第125至147行 readModels 的双读顺序；改错故障：先读 target 再读 base 会让 connectionKey 来自两轮快照，误判同步完成。
// INV-14 守住位置：第133至139行 connectionKey 身份核对；改错故障：只看目录非空会在换团队后直接选到旧团队同名模型。
// INV-15 守住位置：第148至156行持久化分支；改错故障：无 selection 也走持久化会重复写配置，触发不必要的账号连接迁移。
// INV-16 守住位置：第171至191行 sameAccountModel 去重；改错故障：漏判会让个人与团队同名模型再走一次普通选模，菜单闪烁并丢失档位。
// INV-17 守住位置：第192至204行展示等待的写入点；改错故障：不先刷新就置 recall 期望版本，会拿旧 revision 等一个永不到来的事件。
// INV-18 守住位置：第205至226行失败与释放；改错故障：失败分支不判 stillCurrent 会让旧一代覆盖新一代的 pending，形成幽灵失败。
//
// 模块职责：把「切换连接」这一用户动作收敛成一次可观测的状态迁移，涵盖目录重读、账号家族持久化、模型与档位补全、展示回执等待。
// 状态所有权：pending、error 与本次期望凭据归本 hook；目录与配置归 Host 服务；owner 票据归每次渲染代际；inFlight 归调用链同步互斥。
// 阅读顺序：先看 owner 与 inFlight 的所有权，再看两个 effect 的终态判定，最后读 select 的双读与失败释放。
import { completeNewModelSelection } from "@zcode/provider";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useBaseWorkspaceServices,
  useWorkspaceServicesResolution,
} from "@/hooks/useWorkspaceServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { persistProviderFamilyConnection } from "@/lib/providerFamilyConnectionTransition.js";
import { chooseConnectionModel, type ComposerConnection } from "@/lib/composerPlanGroups.js";
import { buildRegistryModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import { decodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { logger } from "@/logger.js";
import { resolveModelProviderFamilySpecByProviderId, type ZCodeProvider } from "@zcode/shared";

// 入口契约：调用方必须给出稳定的 workspacePath 与 agentProvider，切换语义完全由这两者加上 target 解析结果决定。
// presentationStatus 是可观测的展示态，不是本 hook 的私有状态；hook 只读取它来结束等待，绝不反向写入。
// waitForPresentation 为真时 select 的 Promise 要等目录回执到达才落定，调用方不能假设它立即返回。
export function useComposerConnectionSwitch({
  workspacePath,
  workspaceIdentity,
  agentProvider,
  normalizedValue,
  onSelectModel,
  waitForPresentation = false,
  presentationStatus = "ready",
  presentationRevision,
  presentationErrorRevision,
  refreshPresentation,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  agentProvider: ZCodeProvider;
  normalizedValue: string;
  onSelectModel: (value: string, reasoningLevel?: string) => void;
  waitForPresentation?: boolean;
  presentationStatus?: "ready" | "loading" | "error" | "unavailable";
  presentationRevision?: number;
  presentationErrorRevision?: number;
  refreshPresentation?: () => Promise<unknown>;
}) {
  const base = useBaseWorkspaceServices();
  const { services: target, rpcReady } = useWorkspaceServicesResolution(
    workspacePath,
    undefined,
    workspaceIdentity,
  );
  const { update } = useSettings({ services: base });
  const { intl } = useZCodeIntl();
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  // 身份票据：token 在 target、base 或 workspaceKey 变化时换新对象，代表一代异步任务的所有权。
  // owner 用可变的 current 持有最新票据，异步链只在入口抓一次快照，之后靠票据相等判断自己是否过期。
  // 为什么不用布尔开关：布尔只能表达有无，无法区分「同一工作区的第二次切换」与「旧任务仍在飞行」。
  // owner 里的 mounted 标记让卸载后的回写被跳过，避免卸载告警与幽灵状态覆盖新挂载实例。
  const token = useMemo(() => ({}), [target, base, workspaceKey]);
  const owner = useRef({ token, mounted: true });
  owner.current = { token, mounted: true };
  // 互斥闸门：inFlight 是同步可读的锁，放在 ref 而不是 state，避免并发点击时读到上一帧的旧值。
  // 它只拦重复点击，不承担失败重试；失败态由 pending 与 error 表达，两者职责不能互换。
  // 释放点只有 finally 与展示等待分支两处，任何一处遗漏都会让工具条永久不可点。
  const inFlight = useRef(false);
  // 五字段状态：pending 是等待外观，error 是终态文案，previousKey 供上层回滚旧连接。
  // expectedValue 与 expectedRevision 是本次切换的目标凭据，必须成对写入，只有一半就无法判定回执归属。
  // 清理逻辑会把整套字段重置为初始值，任何新增字段都要同步加入重置，否则跨工作区会串味。
  const [state, setState] = useState<{
    pending: boolean;
    error: string | null;
    previousKey?: string;
    expectedValue?: string;
    expectedRevision?: number;
  }>({
    pending: false,
    error: null,
  });
  // 重置时机：target、base 或 workspaceKey 任一变化都意味着旧异步链失效，必须同步清空 pending 与 error。
  // 同时把 inFlight 置回假值，否则旧的飞行标记会一直卡住新工作区的第一次点击。
  // 返回的清理函数只把 mounted 置假；这里不取消底层 RPC，属于有意的资源取舍，宁可丢弃结果也不引入取消协议。
  useEffect(() => {
    setState({ pending: false, error: null });
    inFlight.current = false;
    return () => {
      owner.current.mounted = false;
    };
  }, [target, base, workspaceKey]);
  // 展示回执：只有存在 expectedValue 时才进入等待，普通渲染不会误触发状态写入。
  // 错误分支要求 errorRevision 不早于本次 expectedRevision，防止上一轮失败回执把本轮成功提前判死。
  // 依赖数组必须列出全部判据，漏写 normalizedValue 会让同名模型重选后拿不到匹配结果。
  useEffect(() => {
    if (!state.expectedValue) return;
    if (
      presentationStatus === "error" ||
      presentationStatus === "unavailable" ||
      // 原因：旧 ready 可保留目录，但目标刷新失败必须是本次切换的终态。
      (presentationErrorRevision !== undefined &&
        state.expectedRevision !== undefined &&
        presentationErrorRevision >= state.expectedRevision)
    ) {
      inFlight.current = false;
      setState({
        pending: false,
        error: intl.formatMessage({ id: "chat.toolbar.connection.switchFailed" }),
      });
    // 顺序闸门：ready 也可能属于旧目录，revision 小于本次期望时直接返回，等待下一次事件。
    // 这里先释放 inFlight 再比对选择，是为了匹配失败时也能结束等待，避免工具条锁死在 loading。
    // 不匹配只降级为一次告警和失败文案，不抛异常，因为有效选择可能被过滤或被另一草稿改写，属于正常竞争。
    } else if (presentationStatus === "ready") {
      // 原因：选择 owner 在重读时保留旧 ready；只有目标目录版本到达才是本次展示回执。
      if (
        presentationRevision !== undefined &&
        state.expectedRevision !== undefined &&
        presentationRevision < state.expectedRevision
      )
        return;
      // 原因：RPC 完成早于 Renderer 的选择重解析；提前结束 loading 会暴露新旧目录混合帧。
      inFlight.current = false;
      // 原因：有效选择可能被过滤或被另一草稿改写；ready 不匹配也必须结束等待，不能永久锁住工具条。
      const matched = normalizedValue === state.expectedValue;
      if (!matched)
        logger.lifecycle.warn("[composer-connection] 展示选择与目标不匹配", {
          expectedValue: state.expectedValue,
          normalizedValue,
        });
      setState({
        pending: false,
        error: matched ? null : intl.formatMessage({ id: "chat.toolbar.connection.switchFailed" }),
      });
    }
  }, [
    state.expectedValue,
    state.expectedRevision,
    presentationStatus,
    presentationRevision,
    presentationErrorRevision,
    normalizedValue,
    intl,
  ]);
  const select = useCallback(
    async (connection: ComposerConnection, previousKey?: string) => {
      // 入口守卫顺序有意为之：先看飞行中，再看 RPC 就绪，最后看连接是否禁用，三者都不产生用户可见错误。
      // 静默返回会让按钮没有反馈，所以禁用态由按钮自身表达，本 hook 不重复渲染提示。
      // stillCurrent 闭包抓住进入时的 owner 快照，后续每个等待点之后都要复检，才能识别被新一代切换顶替的情形。
      if (inFlight.current || !rpcReady || connection.disabled) return;
      const currentOwner = owner.current;
      const stillCurrent = () =>
        owner.current.mounted && owner.current.token === currentOwner.token;
      inFlight.current = true;
      setState({ pending: true, error: null, previousKey });
      let awaitingPresentation = false;
      try {
        // 双读策略：执行候选始终从目标 Host 读取，配置写入留在根 Host，避免向远端伪造本地目录。
        // restoring 为真时跳过存活与同步校验，因为回滚路径本身就在旧 owner 上收尾，不能拿新凭据卡住它。
        // 两次刷新刻意串行，先基线后目标，保证 connectionKey 比对拿到的是同一轮配置快照。
        const readModels = async (restoring = false) => {
          if (!restoring && !stillCurrent()) throw new Error("Composer connection owner changed");
          // 配置写入由根 Host 管理；执行候选始终从目标 Host 读取，不向远端伪造本地目录。
          const baseView = await base.providerSettingsService.refresh("composer-connection");
          if (target !== base && stillCurrent()) {
            const targetView = await target.providerSettingsService.refresh("composer-connection");
            // 远端配置交付由既有 provisioning owner 管理；旧团队也可能有同名模型，
            // 必须核对账号连接身份，不能把目录非空误判成新团队已同步。
            const expected = baseView.providers.find((p) => p.providerId === connection.providerId)
              ?.accountState?.connectionKey;
            const actual = targetView.providers.find((p) => p.providerId === connection.providerId)
              ?.accountState?.connectionKey;
            if (!restoring && (!expected || actual !== expected))
              throw new Error("Target connection has not synchronized");
          }
          const view = await (stillCurrent() ? target : base).modelSelectionService.getView();
          const candidate = buildRegistryModelSelectGroups(agentProvider, view).find(
            (g) => g.key === `registry-provider:${connection.providerId}`,
          );
          if (!restoring && !candidate?.items.length)
            throw new Error("Selected connection has no available models");
          return view;
        };
        // 分支语义：带 selection 说明要真正切换账号家族，走持久化事务；不带则只是重读当前 Host 视图。
        // 持久化事务内部按 read、update、synchronize 三段推进，任一段抛错都会让整次切换进入失败路径。
        // 这里不做本地缓存复用，每次切换都重新读目录，用一次额外 RPC 换掉目录陈旧导致的错选。
        const view = connection.selection
          ? await persistProviderFamilyConnection({
              family: connection.family,
              selection: connection.selection,
              read: () => base.settingService.get(),
              update,
              synchronize: readModels,
            })
          : await target.modelSelectionService.getView();
        if (!stillCurrent()) return;
        const group = buildRegistryModelSelectGroups(agentProvider, view).find(
          (g) => g.key === `registry-provider:${connection.providerId}`,
        );
        const model = chooseConnectionModel(
          group?.items ?? [],
          decodeCustomModelValue(normalizedValue)?.modelName,
        );
        if (!model) throw new Error("Selected connection has no available models");
        logger.debug("[composer-connection] 连接同步完成", {
          providerId: connection.providerId,
          connectionKey: connection.key,
          workspaceKey,
        });
        const source = decodeCustomModelValue(normalizedValue);
        const family = resolveModelProviderFamilySpecByProviderId(source?.providerId ?? "");
        // 原因：个人/团队的同名模型已经由账号 Selection resolver 自动映射并校验 options。
        // 再走普通选模会重建无 reasoning 的意图，同时触发第二轮目录重读和菜单闪烁。
        const sameAccountModel =
          connection.selection &&
          family?.id === connection.family &&
          (source?.providerId === family.individualCodingPlanProviderId ||
            source?.providerId === family.teamCodingPlanProviderId) &&
          source?.modelName === model.name;
        if (!sameAccountModel) {
          // 原因：API → 团队时 Renderer 仍持有切换前目录，不能让旧闭包补齐目标档位。
          // 直接使用同步完成的目标 Host 目录，将模型与档位一次交给草稿 owner。
          const selection = completeNewModelSelection(view, {
            providerId: connection.providerId,
            modelId: model.name,
          });
          const reasoningLevel = selection?.options?.reasoningLevel;
          if (reasoningLevel) onSelectModel(model.value, reasoningLevel);
          else onSelectModel(model.value);
        }
        if (waitForPresentation) {
          // 原因：重选同连接可能没有目录事件；每次显式读取当前展示 owner，不消费旧失败回执。
          await refreshPresentation?.();
          if (!stillCurrent()) return;
          awaitingPresentation = true;
          setState({
            pending: true,
            error: null,
            previousKey,
            expectedValue: model.value,
            expectedRevision: view.revision,
          });
        }
      // 失败路径保留 error 的 name 与 message，并把 AggregateError 的 causes 摊开，生产回放才能定位是哪一步先崩。
      // 只有 stillCurrent 为真才写失败态，否则旧一代的失败会把新一代的 pending 覆盖成错误。
      // causes 按原顺序字符串化且不递归展开，避免并发失败时日志体积失控。
      } catch (error) {
        // 连接切换失败属于低频生命周期诊断，生产回放也需要保留明确失败原因。
        logger.lifecycle.warn("[composer-connection] 切换连接失败", {
          providerId: connection.providerId,
          workspaceKey,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          causes:
            error instanceof AggregateError
              ? error.errors.map((cause) => String(cause))
              : undefined,
        });
        if (stillCurrent())
          setState({
            pending: false,
            error: intl.formatMessage({ id: "chat.toolbar.connection.switchFailed" }),
          });
      // 释放契约：只有存活且没有进入展示等待时才在这里清 inFlight，并保留其余字段。
      // 用函数式更新合并旧字段，避免覆盖回执 effect 刚写入的 expectedValue 等凭据。
      // 此处不再写 error，失败语义已在失败分支落定，双重写入会让上层看到先成功后失败的抖动。
      } finally {
        if (stillCurrent() && !awaitingPresentation) {
          inFlight.current = false;
          setState((previous) => ({ ...previous, pending: false }));
        }
      }
    },
    [
      agentProvider,
      base,
      intl,
      normalizedValue,
      onSelectModel,
      rpcReady,
      target,
      update,
      workspaceKey,
      waitForPresentation,
      refreshPresentation,
    ],
  );
  return { ...state, select };
}
