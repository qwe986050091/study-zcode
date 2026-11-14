// useRemoteConnectionForm —— 远程连接表单的草稿状态所有者（SSH / WSL / Docker / Server 四条线路）。
//
// 职责：持有草稿字段、凭据、各路发现结果（SSH 别名 / WSL 发行版 / Docker 容器）与加载态，
// 并收敛「发现何时触发、迟到响应如何丢弃、alias 切换如何重建字段」这些时序规则。
// 不负责：不做连接探测、不做字段合法性校验、不持久化草稿、不决定连接成功后的会话归属。
// 校验与提交由调用方完成，本 hook 只保证返回的状态自洽，且不把旧目标的数据带进新目标。
//
// 入口参数语义：open 控制重置与发现；preserveDraftOnOpen 区分「新建流程」与「收起后恢复」。
//
// 不变量：
// INV-01 断言：availableKinds 至少含 ssh，且 kind 永远落在 availableKinds 内 —— 守住它的位置：buildAvailableKinds 与 kind 回退 effect —— 改错故障：平台裁掉某线路后 Tab 悬空，提交到不存在的连接类型。
// INV-02 断言：Docker 入口无条件展示 —— 守住它的位置：buildAvailableKinds 末尾的 push —— 改错故障：探测失败时用户看不到 Docker 入口，误判产品不支持。
// INV-03 断言：Server 只在本地开发运行时出现 —— 守住它的位置：isLocalDevelopmentRuntime 计算 —— 改错故障：production 包露出未对外开放的远程入口。
// INV-04 断言：open 为 false 时不重置任何草稿 —— 守住它的位置：打开重置 effect 的 !open 分支 —— 改错故障：收起动画期间字段与列表被清空，用户看到闪屏并丢数据。
// INV-05 断言：preserveDraftOnOpen 为 true 时保留草稿、选中 alias 与资源下载方式 —— 守住它的位置：各处 !preserveDraftOnOpen 判断 —— 改错故障：编辑已有连接时字段被回退成默认值。
// INV-06 断言：资源下载方式不跨流程复用 —— 守住它的位置：resetAssetInstallModeForNewFlow —— 改错故障：新建连接沿用上一次的安装方式，且 UI 上看不到来源。
// INV-07 断言：同代号 Docker 请求在飞时不再重复发起 —— 守住它的位置：refreshDockerContainers 开头的守卫 —— 改错故障：下拉连续展开导致请求积压、结果乱序。
// INV-08 断言：代号失配的 Docker 结果一律丢弃 —— 守住它的位置：await 之后的 loadId 比较 —— 改错故障：旧响应覆盖新一次探测，列表与 dockerAvailable 自相矛盾。
// INV-09 断言：只有最新代号能复位 loading 与 inFlight —— 守住它的位置：finally 块 —— 改错故障：迟到请求提前熄掉 loading，转圈闪断、按钮提前可点。
// INV-10 断言：Docker 刷新成功后选中容器必须受最新运行中列表约束 —— 守住它的位置：resolveDockerContainerSelectionAfterRefresh 调用 —— 改错故障：触发器显示已停止的容器，提交到不存在的容器。
// INV-11 断言：手动刷新失败不清空容器列表 —— 守住它的位置：clearContainersOnError 的两种取值 —— 改错故障：一次网络抖动把用户可选的容器列表清空。
// INV-12 断言：发现失败也要把 loaded 置 true —— 守住它的位置：三处 catch 分支 —— 改错故障：effect 反复重跑，进入无限重试。
// INV-13 断言：切换 alias 时全部 SSH 字段按 alias 重建、缺失值置空 —— 守住它的位置：applySshConfigAlias —— 改错故障：上一个 alias 的用户名与端口残留，连到错误主机。
// INV-14 断言：目标字段变化后不得沿用旧密码与私钥口令 —— 守住它的位置：clearCredentials 与各字段 setter —— 改错故障：凭据被带到另一台主机，认证失败或产生安全事故。
// INV-15 断言：applyingSshAliasRef 只在 alias 应用期间为 true 且必被复位 —— 守住它的位置：applySshConfigAlias 的 try/finally —— 改错故障：ref 卡在 true 后手动输入再也解不掉 alias，提交的是旧别名。
// INV-16 断言：savedSshConfigAlias 不在列表时仍保留选中，其余失效 alias 必须清空 —— 守住它的位置：别名失效 effect —— 改错故障：编辑态选中值被误清，或提交一个不存在的主机别名。
//
// 阅读顺序：buildAvailableKinds → 打开重置 effect → Docker 刷新与失效 effect → 字段 setter → resetDraft 与返回值。
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type {
  DockerContainerInfo,
  RemoteAssetInstallMode,
  RemoteTarget,
  SSHConfigAliasOption,
  WSLDistro,
} from "@zcode/shared";
import { DEFAULT_REMOTE_ASSET_INSTALL_MODE } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import {
  loadRemoteConnectionDockerOptions,
  resolveDockerContainerSelectionAfterRefresh,
} from "@/lib/remoteConnectionDockerOptions.js";

// 线路类型直接复用 RemoteTarget 的 kind，不在本文件另起一套字面量联合，
// 否则 shared 包新增线路时这里会静默漏掉，availableKinds 与提交处的类型对不上。
// [契约] SSHAuthMethod 是表单侧概念，只暴露给 UI，不写回 RemoteTarget。
type RemoteKind = RemoteTarget["kind"];
export type SSHAuthMethod = "password" | "privateKey";

export function buildAvailableKinds(options: {
  isWindowsDesktop: boolean;
  isLocalDevelopmentRuntime: boolean;
}): RemoteKind[] {
  // SSH 是所有平台固定存在的线路，永远排第一，同时充当 kind 的兜底值。
  // 顺序在这里就决定了选择页的顺序，后面只是追加，不再排序。
  // [契约] Web 端没有 WSL/Docker 能力时，可用列表只剩 ssh 与 docker 两项。
  const kinds: RemoteKind[] = ["ssh"];
  // Bugfix: Server remote 目前只是本地开发能力。之前无条件放入可选列表，
  // 导致 production-mode 打包也会露出未对外开放的入口。
  if (options.isLocalDevelopmentRuntime) {
    kinds.push("server");
  }
  // Bugfix: 远程连接入口里 WSL 和 SSH 同属主机类连接。
  // Windows 下先放 WSL 再放 Docker，避免 WSL 被 Docker 隔开后在选择页显得离 SSH 很远。
  if (options.isWindowsDesktop) {
    kinds.push("wsl");
  }
  // Docker入口之前完全依赖预探测结果决定是否展示。
  // 当探测能力暂时不可用、或用户还没切到 Docker 时，入口会直接消失，
  // 用户甚至不知道这里支持 Docker 连接。改为始终展示入口，切换后再懒加载探测结果。
  // [权衡] Docker 入口无条件展示，把「能不能用」推迟到切换后的探测结果。
  // 旧写法按预探测结果决定入口是否存在，探测失败时入口直接消失，
  // 用户会以为产品不支持 Docker，而不是看到一条可解释的错误。
  kinds.push("docker");
  return kinds;
}

export function useRemoteConnectionForm({
  open,
  isWindowsDesktop,
  preferredKind,
  preferredWslDistro,
  savedSshConfigAlias,
  preserveDraftOnOpen = false,
  discoverAll = false,
}: {
  open: boolean;
  isWindowsDesktop: boolean;
  preferredKind?: RemoteKind;
  preferredWslDistro?: string;
  /** 编辑已有连接时，保留历史别名，允许用户显式清除。 */
  savedSshConfigAlias?: string;
  preserveDraftOnOpen?: boolean;
  discoverAll?: boolean;
}) {
  // 平台能力一律走注入的 platform，不直接读 window 上的桥接对象，
  // 这样 Web、桌面与测试替身共用同一套发现逻辑。
  const platform = usePlatform();
  const [kind, setKind] = useState<RemoteKind>("ssh");
  const [host, setHostState] = useState("");
  const [port, setPortState] = useState("22");
  const [username, setUsernameState] = useState("");
  const [sshAuthMethod, setSshAuthMethod] = useState<SSHAuthMethod>("password");
  const [assetInstallMode, setAssetInstallMode] = useState<RemoteAssetInstallMode>(
    DEFAULT_REMOTE_ASSET_INSTALL_MODE,
  );
  const [password, setPassword] = useState("");
  const [privateKeyPath, setPrivateKeyPathState] = useState("");
  const [privateKeyPassphrase, setPrivateKeyPassphrase] = useState("");
  const [wslDistro, setWslDistro] = useState("");
  const [wslUser, setWslUser] = useState("");
  const [dockerContainer, setDockerContainer] = useState("");
  const [manualDockerContainer, setManualDockerContainer] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [serverName, setServerName] = useState("");
  const [serverToken, setServerToken] = useState("");
  const [serverWorkspacePath, setServerWorkspacePath] = useState("");
  const [sshConfigAliases, setSshConfigAliases] = useState<SSHConfigAliasOption[]>([]);
  const [sshConfigAliasesLoading, setSshConfigAliasesLoading] = useState(false);
  const [sshConfigAliasesLoaded, setSshConfigAliasesLoaded] = useState(false);
  const [sshConfigAliasesError, setSshConfigAliasesError] = useState("");
  const [selectedSshConfigAlias, setSelectedSshConfigAlias] = useState<string | null>(null);
  const [dockerAvailable, setDockerAvailable] = useState<boolean | null>(null);
  const [wslDistros, setWslDistros] = useState<WSLDistro[]>([]);
  const [dockerContainers, setDockerContainers] = useState<DockerContainerInfo[]>([]);
  const [wslOptionsLoading, setWslOptionsLoading] = useState(false);
  const [wslOptionsLoaded, setWslOptionsLoaded] = useState(false);
  const [wslOptionsError, setWslOptionsError] = useState("");
  const [dockerOptionsLoading, setDockerOptionsLoading] = useState(false);
  const [dockerOptionsLoaded, setDockerOptionsLoaded] = useState(false);
  const [dockerOptionsError, setDockerOptionsError] = useState("");
  // [并发] 这个 ref 是 alias 批量写字段期间的重入闸门：
  // 它为 true 时，setHost/setPort/setUsername 不得清掉刚选中的 alias。
  // 必须用 ref 而非 state，否则写字段那一轮读到的还是旧值。
  const applyingSshAliasRef = useRef(false);
  // [并发] 两个 ref 共同实现「最新一次加载获胜」：active 是当前有效代号，
  // inFlight 记录该代号是否仍在飞，二者不参与渲染，所以只能放 ref。
  // 改成 state 会多一轮重渲染，并可能在渲染间隙读到不一致的代号。
  const dockerOptionsActiveLoadIdRef = useRef(0);
  const dockerOptionsInFlightLoadIdRef = useRef<number | null>(null);
  // Server 线路只对本地开发运行时开放，这里额外并入 import.meta.env.DEV，
  // 因为平台层偶尔拿不到运行时标记，只信 platform 会把开发入口在 dev 构建里藏掉。
  // [权衡] 宁可多露，代价是 dev 构建下的 Web 也会看到 Server 选项。
  const isLocalDevelopmentRuntime =
    platform.isLocalDevelopmentRuntime === true || import.meta.env.DEV === true;

  // 可用线路只在平台标记变化时重算，避免每次渲染都生成新数组，
  // 否则依赖它的 effect 每轮都会重跑，反复把 kind 重置回第一项。
  const availableKinds = useMemo(
    () => buildAvailableKinds({ isWindowsDesktop, isLocalDevelopmentRuntime }),
    [isLocalDevelopmentRuntime, isWindowsDesktop],
  );

  // [契约] 用 useEffectEvent 读取最新的 preserveDraftOnOpen，而不是塞进 effect 依赖，
  // 防止调用方每轮传入新的回调或对象就触发一次「打开即重置」。
  // 事件函数只在下游调用时读取最新值，因此这里的写法必须保持。
  const resetAssetInstallModeForNewFlow = useEffectEvent(() => {
    // 打开不一定代表新建：收起恢复必须保留当前线路的下载选择。
    if (!preserveDraftOnOpen) setAssetInstallMode(DEFAULT_REMOTE_ASSET_INSTALL_MODE);
  });

  useEffect(() => {
    // 当前线路被平台裁掉时立刻回退到第一项，不能让 UI 停在不可用的 Tab 上。
    // [失败路径] 回退值再兜一层 ssh，保证可用列表为空时仍有合法 kind。
    if (availableKinds.includes(kind)) {
      return;
    }

    setKind(availableKinds[0] ?? "ssh");
  }, [availableKinds, kind]);

  useEffect(() => {
    // 每次打开或关闭都推进代号：更早发出的 Docker 请求回来时必然失配并被丢弃，
    // 这是「打开瞬间先作废旧请求」的唯一手段，比在响应里比对 open 更可靠。
    // 同时把 inFlight 清空，让新一轮加载不必等旧请求结束。
    dockerOptionsActiveLoadIdRef.current += 1;
    dockerOptionsInFlightLoadIdRef.current = null;

    // 关闭状态只作废请求，不做重置：弹窗常驻挂载，收起期间保留的草稿要原样还回。
    // 所有重置都放在打开分支之后，避免收起动画期间列表与字段闪空。
    // [契约] 这里提前返回，不能顺手 setState，否则关闭也会触发重渲染。
    if (!open) {
      return;
    }

    // 产品决策：资源下载方式只属于当前 SSH 线路，不再形成全局或“上次选择”偏好。
    // 弹窗常驻挂载，只有新流程恢复默认值；收起后的同一线路继续使用当前选择。
    // [契约] 这一步要在打开分支之后、preferredKind 覆盖之前执行：
    // 它给随后整串发现重置定下安装方式基线，顺序颠倒会让草稿恢复与默认值互相覆盖。
    // 经事件函数调用而不是直接读参数，保证拿到的是本次渲染最新的 preserveDraftOnOpen。
    resetAssetInstallModeForNewFlow();
    setSshConfigAliasesLoading(false);
    setSshConfigAliasesLoaded(false);
    setSshConfigAliasesError("");
    if (!preserveDraftOnOpen) setSelectedSshConfigAlias(null);
    setWslOptionsLoaded(false);
    setWslOptionsLoading(false);
    setWslOptionsError("");
    setWslDistros([]);
    setDockerAvailable(null);
    setDockerOptionsLoaded(false);
    setDockerOptionsLoading(false);
    setDockerOptionsError("");
    setDockerContainers([]);
    // preferredKind 必须先过 availableKinds 过滤：外部入口可能传 wsl 或 server，
    // 在非 Windows 或非开发运行时下这两个值不展示，直接写入会让当前 Tab 悬空。
    // preferredWslDistro 同理，只在非保留草稿的流程里覆盖。
    if (!preserveDraftOnOpen && preferredKind && availableKinds.includes(preferredKind)) {
      setKind(preferredKind);
    }
    if (!preserveDraftOnOpen && preferredWslDistro !== undefined) {
      setWslDistro(preferredWslDistro);
    }
  }, [availableKinds, open, preferredKind, preferredWslDistro]);

  // [并发] 同代号的请求仍在飞时直接返回，避免下拉连续展开把 RPC 打成积压。
  // 但代号不同就必须继续，因为期间可能刚发生过一次打开或关闭导致失效。
  // 依赖只有 platform，其余走 ref 与函数式更新，保证回调引用稳定。
  const refreshDockerContainers = useCallback(
    ({ clearContainersOnError = true }: { clearContainersOnError?: boolean } = {}) => {
      if (
        dockerOptionsInFlightLoadIdRef.current != null &&
        dockerOptionsInFlightLoadIdRef.current === dockerOptionsActiveLoadIdRef.current
      ) {
        return;
      }

      const loadId = dockerOptionsActiveLoadIdRef.current + 1;
      dockerOptionsActiveLoadIdRef.current = loadId;
      dockerOptionsInFlightLoadIdRef.current = loadId;
      setDockerOptionsLoading(true);
      setDockerOptionsError("");

      void (async () => {
        const result = await loadRemoteConnectionDockerOptions(platform);
        // [失败路径] 代号失配说明期间已打开关闭或又发起了新请求，本次结果一律不落地。
        // 尤其不能写 dockerAvailable 与错误态，否则旧结论会覆盖新一次探测。
        // 判断必须早于所有 setState，不能先写一半再回滚。
        if (dockerOptionsActiveLoadIdRef.current !== loadId) {
          return;
        }

        setDockerAvailable(result.dockerAvailable);
        setDockerOptionsLoaded(true);
        setDockerOptionsError(result.error);

        if (!result.error) {
          setDockerContainers(result.dockerContainers);
          // 下拉刷新后旧容器可能已经停止。之前只更新列表不清空选中值，
          // 触发器仍会显示已不存在的容器；成功刷新后必须让选中值受最新运行中列表约束。
          setDockerContainer((currentContainer) =>
            resolveDockerContainerSelectionAfterRefresh({
              currentContainer,
              dockerContainers: result.dockerContainers,
            }),
          );
          return;
        }

        if (clearContainersOnError) {
          setDockerContainers(result.dockerContainers);
        }
      // [资源] 只有仍是最新代号时才清 inFlight 与 loading。
      // 迟到请求若在这里无条件复位，会把新一轮请求的 loading 提前熄掉，
      // UI 表现为转圈闪断、按钮提前变为可点。
      })().finally(() => {
        if (dockerOptionsInFlightLoadIdRef.current === loadId) {
          dockerOptionsInFlightLoadIdRef.current = null;
        }
        if (dockerOptionsActiveLoadIdRef.current === loadId) {
          setDockerOptionsLoading(false);
        }
      });
    },
    [platform],
  );

  useEffect(() => {
    if (!open || (!discoverAll && kind !== "ssh") || sshConfigAliasesLoaded) {
      return;
    }

    let cancelled = false;
    // 别名发现自带 cancelled 标记，组件卸载或依赖变化后一律不再写 state，
    // 只有 loading 的复位放在 finally 里，且同样受该标记约束。
    setSshConfigAliasesLoading(true);
    setSshConfigAliasesError("");

    void (async () => {
      try {
        const aliases = await platform.listSSHConfigAliases();
        if (cancelled) {
          return;
        }

        setSshConfigAliases(aliases);
        setSshConfigAliasesLoaded(true);
      } catch (runtimeError) {
        if (cancelled) {
          return;
        }

        setSshConfigAliases([]);
        setSshConfigAliasesLoaded(true);
        // [失败路径] 出错也要把 loaded 置 true，否则 effect 会因依赖 loaded 持续重跑。
        // 失败后无限重试的症状是控制台反复刷新同一条错误，列表一直为空。
        // 错误文本原样转成字符串，交给上层判断是否展示可重试入口。
        setSshConfigAliasesError(String(runtimeError));
      } finally {
        if (!cancelled) {
          setSshConfigAliasesLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [discoverAll, kind, open, platform, sshConfigAliasesLoaded]);

  useEffect(() => {
    if (
      !sshConfigAliasesLoaded ||
      Boolean(sshConfigAliasesError) ||
      !selectedSshConfigAlias ||
      selectedSshConfigAlias === savedSshConfigAlias
    ) {
      return;
    }

    // savedSshConfigAlias 即使不在列表里也保留选中，它代表正在编辑的那条连接。
    // 其余失去对应项的选中值必须清空，否则提交时按不存在的主机别名拼配置。
    // 错误态与未加载完成时跳过，避免把暂无数据当成已被删除。
    if (sshConfigAliases.some((option) => option.alias === selectedSshConfigAlias)) {
      return;
    }

    setSelectedSshConfigAlias(null);
  }, [
    selectedSshConfigAlias,
    sshConfigAliases,
    savedSshConfigAlias,
    sshConfigAliasesLoaded,
    sshConfigAliasesError,
  ]);

  useEffect(() => {
    if (!open || (!discoverAll && kind !== "wsl") || !isWindowsDesktop || wslOptionsLoaded) {
      return;
    }

    let cancelled = false;
    setWslOptionsLoading(true);
    setWslOptionsError("");

    void (async () => {
      try {
        const nextWslDistros = await platform.listWSLDistros();
        if (cancelled) {
          return;
        }

        setWslDistros(nextWslDistros);
        setWslOptionsLoaded(true);
      } catch (runtimeError) {
        if (cancelled) {
          return;
        }

        setWslDistros([]);
        setWslOptionsLoaded(true);
        setWslOptionsError(String(runtimeError));
      } finally {
        if (!cancelled) {
          setWslOptionsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [discoverAll, isWindowsDesktop, kind, open, platform, wslOptionsLoaded]);

  useEffect(() => {
    if (!open || (!discoverAll && kind !== "docker") || dockerOptionsLoaded) {
      return;
    }

    // 首次进入 Docker 线路时清空列表再拉取，避免上一次流程的容器残留。
    // 手动刷新则传 false，失败时保留旧列表，用户至少还能看到上一次的结果。
    // [权衡] 首次失败不留旧数据，是为了不让人对着过期列表做选择。
    refreshDockerContainers({ clearContainersOnError: true });
  }, [discoverAll, dockerOptionsLoaded, kind, open, refreshDockerContainers]);

  useEffect(() => {
    return () => {
      if (!discoverAll) {
        // 刷新列表可能发生在首次发现完成后；失效边界必须跟随类型，不能跟随 loaded。
        // 否则手动刷新的迟到响应仍会清除用户在下一次表单中选定的容器。
        // [并发] Docker 走代号失效，SSH 与 WSL 走各自的 cancelled 标记，两套机制不可互换：
        // Docker 可被反复刷新，只有代号能区分是哪一次；一次性发现只需区分是否仍然有效。
        dockerOptionsActiveLoadIdRef.current += 1;
        dockerOptionsInFlightLoadIdRef.current = null;
        setDockerOptionsLoading(false);
      }
    };
  }, [discoverAll, kind, open]);

  // 密码与私钥口令都属于当前目标的临时秘密，目标字段一变就必须一起清掉。
  // 只清密码不清口令，会让旧口令在下一次连接里被静默沿用。
  // 这里不处理 alias 选中值，那是各字段 setter 自己的职责。
  const clearCredentials = () => {
    setPassword("");
    setPrivateKeyPassphrase("");
  };
  // [契约] 用 trim 后比较，光标后多打一个空格不算换目标，既不清凭据也不清 alias。
  // alias 只在用户真的改了值时解除，程序化回填由 applyingSshAliasRef 豁免。
  // 顺序上先清凭据、再判 alias，最后才写 state。
  const setHost = (value: string) => {
    // 凭据属于当前目标；更换地址、用户或端口不能把旧目标的秘密带入新连接。
    if (value.trim() !== host.trim()) clearCredentials();
    if (!applyingSshAliasRef.current && selectedSshConfigAlias && value !== host) {
      setSelectedSshConfigAlias(null);
    }
    setHostState(value);
  };

  const setPort = (value: string) => {
    if (value !== port) clearCredentials();
    if (!applyingSshAliasRef.current && selectedSshConfigAlias && value !== port) {
      setSelectedSshConfigAlias(null);
    }
    setPortState(value);
  };

  const setUsername = (value: string) => {
    if (value.trim() !== username.trim()) clearCredentials();
    if (!applyingSshAliasRef.current && selectedSshConfigAlias && value !== username) {
      setSelectedSshConfigAlias(null);
    }
    setUsernameState(value);
  };

  const setPrivateKeyPath = (value: string) => {
    if (value !== privateKeyPath) setPrivateKeyPassphrase("");
    if (!applyingSshAliasRef.current && selectedSshConfigAlias && value !== privateKeyPath) {
      setSelectedSshConfigAlias(null);
    }
    setPrivateKeyPathState(value);
  };

  const applySshConfigAlias = (aliasOption: SSHConfigAliasOption) => {
    // [事务] 下面这一串 setState 是一次整体的 alias 应用，期间不能被 setter 里的
    // 「值变化即清 alias」逻辑打断。finally 必须复位，否则之后手动输入再也解不掉 alias。
    // authMethod 由是否带私钥路径推导，不要在这里单独猜。
    applyingSshAliasRef.current = true;
    try {
      setSelectedSshConfigAlias(aliasOption.alias);
      const nextHost = aliasOption.host?.trim() || aliasOption.alias;
      const nextPort =
        aliasOption.port != null && Number.isFinite(aliasOption.port)
          ? String(aliasOption.port)
          : "";
      const nextUsername = aliasOption.username?.trim() ?? "";
      const nextPrivateKeyPath = aliasOption.privateKeyPath?.trim() ?? "";

      // 切换 alias 时之前只覆盖“有值字段”，缺失字段会残留上一个 alias/手动输入值。
      // 这里改为全量覆盖：所有 SSH 字段都按当前 alias 重建，缺失值统一置空，避免状态串用。
      setHostState(nextHost);
      setPortState(nextPort);
      setUsernameState(nextUsername);
      setPassword("");
      setPrivateKeyPathState(nextPrivateKeyPath);
      setPrivateKeyPassphrase("");
      setSshAuthMethod(nextPrivateKeyPath ? "privateKey" : "password");
    } finally {
      applyingSshAliasRef.current = false;
    }
  };

  const clearSelectedSshConfigAlias = () => {
    setSelectedSshConfigAlias(null);
  };

  // resetDraft 是「新建连接」语义：线路回到 ssh、端口回到 22、凭据与选中容器清空。
  // 它刻意不碰发现结果（别名、发行版、容器列表）与 loaded 标记，
  // 这些由打开时的重置 effect 统一重建，避免两处清理逻辑走样。
  const resetDraft = () => {
    setKind("ssh");
    setHostState("");
    setPortState("22");
    setUsernameState("");
    setSshAuthMethod("password");
    setAssetInstallMode(DEFAULT_REMOTE_ASSET_INSTALL_MODE);
    setPassword("");
    setPrivateKeyPathState("");
    setPrivateKeyPassphrase("");
    setSelectedSshConfigAlias(null);
    setWslDistro("");
    setWslUser("");
    setDockerContainer("");
    setManualDockerContainer("");
    setServerUrl("");
    setServerName("");
    setServerToken("");
    setServerWorkspacePath("");
  };

  return {
    resetDraft,
    discoveryLoading: sshConfigAliasesLoading || wslOptionsLoading || dockerOptionsLoading,
    discoveryError: sshConfigAliasesError || wslOptionsError || dockerOptionsError,
    kind,
    host,
    port,
    username,
    sshAuthMethod,
    assetInstallMode,
    password,
    privateKeyPath,
    privateKeyPassphrase,
    wslDistro,
    wslUser,
    dockerContainer,
    manualDockerContainer,
    serverUrl,
    serverName,
    serverToken,
    serverWorkspacePath,
    sshConfigAliases,
    sshConfigAliasesLoading,
    sshConfigAliasesError,
    selectedSshConfigAlias,
    dockerAvailable,
    wslDistros,
    dockerContainers,
    availableKinds,
    setKind,
    setHost,
    setPort,
    setUsername,
    setSshAuthMethod,
    setAssetInstallMode,
    setPassword,
    setPrivateKeyPath,
    setPrivateKeyPassphrase,
    setWslDistro,
    setWslUser,
    setDockerContainer,
    setManualDockerContainer,
    setServerUrl,
    setServerName,
    setServerToken,
    setServerWorkspacePath,
    // Bugfix: Docker 容器列表是运行态数据，之前只在进入 Docker 页时拉一次。
    // 下拉每次打开都通过这个回调按需刷新，避免用户看到已过期的容器列表。
    // [契约] 对外只暴露「不清空」的刷新：下拉刷新失败时保留旧列表。
    // 内部首次加载才走 clearContainersOnError=true，这个差别不要在包装层抹平。
    // 包装层刻意不把该参数透出，调用方无法用一次误刷新把已选中的容器列表清空。
    refreshDockerContainers: () => refreshDockerContainers({ clearContainersOnError: false }),
    applySshConfigAlias,
    clearSelectedSshConfigAlias,
    // 加载态与错误态按当前线路投影，调用方不必自己判断该读哪一路字段。
    // [权衡] ssh 线路的加载恒为 false，因为别名发现只是可选增强，不阻塞表单。
    currentRuntimeOptionsLoading:
      kind === "wsl" ? wslOptionsLoading : kind === "docker" ? dockerOptionsLoading : false,
    currentRuntimeOptionsError:
      kind === "wsl" ? wslOptionsError : kind === "docker" ? dockerOptionsError : "",
  };
}
