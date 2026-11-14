// packages/ui/src/Terminal.tsx —— 终端面板容器层：维护 tab 清单、workspace 隔离、会话生命周期编排与可见性。
// 真正的 PTY 与 xterm 实例在 TerminalSession 内部；session 增删的纯函数在 terminalPanelState。
// 不负责：shell 进程创建/销毁、xterm 渲染与尺寸测量、tab 拖拽排序、面板容器尺寸与折叠动画。
//
// INV-01 断言：workspaceKey 取 identity.trim()、其次 cwd、最后 __default__ —— 守住它的位置：workspaceKey 派生 —— 改错故障：同路径的本地与远程 workspace 共用一份终端，tab 互相串台。
// INV-02 断言：panelState 只有 setPanelState 一个写入入口，且全部走函数式更新 —— 守住它的位置：所有 updater 分支 —— 改错故障：并发创建与关闭丢更新，sessions 与 sessionIds 指向不一致。
// INV-03 断言：手动关闭 tab 永不杀死 PTY，最后一个 tab 的关闭等价于收起面板 —— 守住它的位置：getTerminalSessionCloseAction 的两个分支 —— 改错故障：收起面板就中断正在跑的长任务。
// INV-04 断言：PTY 退出必须同步删除 descriptor，不能只在 xterm 里写提示 —— 守住它的位置：handleSessionExit —— 改错故障：残留僵尸 tab，重新展开仍显示已退出的会话。
// INV-05 断言：退出导致的面板收起不能在 updater 内同步执行 —— 守住它的位置：closePanelAfterExitWorkspaceRef 与第二个 effect —— 改错故障：父级在提交前卸载，出现状态更新竞态并丢失退出结果。
// INV-06 断言：跨 workspace 切换只改可见性，不卸载 TerminalSession —— 守住它的位置：TerminalSession 的 isVisible 计算 —— 改错故障：切 workspace 时旧终端被卸载，命令随之被杀。
// INV-07 断言：回收集合必须同时包含 openWorkspaceKeys 与当前 workspaceKey —— 守住它的位置：第三个 effect 的 retainedWorkspaceKeys —— 改错故障：切换瞬间回收正在展示的 workspace，面板变空。
// INV-08 断言：每个 TabsContent 都 forceMount，隐藏只靠样式 —— 守住它的位置：allSessions 的渲染循环 —— 改错故障：切 tab 重新挂载 xterm，滚动缓冲与选中态丢失。
// INV-09 断言：activeSession 在 registry 值失效时回退到 currentSessions[0] —— 守住它的位置：activeSession 派生 —— 改错故障：关闭活动 tab 后 Tabs 值为空，面板无内容。
// INV-10 断言：exitTerminalSession 的第三参用当前 workspaceKey，不用 session 所属 key —— 守住它的位置：handleSessionExit —— 改错故障：后台 workspace 退出时误关用户正在看的面板。
// INV-11 断言：shellLabel 与现有值相同时不写回 —— 守住它的位置：handleShellLabelChange 的相等分支 —— 改错故障：提示符刷新导致每个字符都重建一次 tab 列表。
// INV-12 断言：新 tab 编号取现存 descriptor 的最小空位，不额外保存 nextIndex —— 守住它的位置：getNextTerminalSessionIndex 调用点 —— 改错故障：关闭编号 2 再新建，出现重复编号或跳号。
// INV-13 断言：isVisible 同时要求面板可见、同 workspace、是活动 tab —— 守住它的位置：TerminalSession 的 isVisible 表达式 —— 改错故障：后台会话抢焦点，或隐藏时测量为 0 导致 xterm 错行。
//
// 状态归属：sessions 与 workspaces 两份映射同属一个 TerminalPanelState，任何删除都必须成对清理，
// 否则 sessionIds 会指向不存在的 descriptor，渲染时被 filter 静默丢弃，表现为 tab 消失但进程还在。
// 三个 effect 的顺序即语义：先按 workspaceKey 兜底补建，再消费上一次 PTY 退出遗留的收起请求，
// 最后按仍打开的 workspace 列表做差集回收；调换顺序会让刚补建的 session 立刻被当成孤儿回收。
// 所有 setPanelState 都使用函数式更新，无变化时返回原引用，让 React 跳过重渲染；
// 这不是性能优化，而是保持 effect 依赖里 panelState 的身份稳定，避免自触发的更新循环。
// TSX 约束：本文件的整行注释只能落在语句或声明之间，不得进入 JSX 子节点文本区与开标签属性之间。
//
import { Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { TID_TERMINAL, TID_TERMINAL_CLOSE_BUTTON } from "@zcode/shared/test-ids";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { logger } from "@/logger.js";
import { Button } from "@/components/ui/button.js";
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs.js";
import { getPathLeaf } from "@/lib/path.js";
import { TerminalTabTrigger } from "@/terminal/TerminalTabTrigger.js";
import { TerminalSession } from "@/terminal/TerminalSession.js";
import {
  closeTerminalSession,
  createTerminalSession,
  createWorkspaceTerminalState,
  ensureWorkspaceTerminalState,
  exitTerminalSession,
  formatTerminalTabTitle,
  getNextTerminalSessionIndex,
  getTerminalSessionCloseAction,
  type TerminalPanelState,
  type TerminalSessionDescriptor,
} from "@/terminal/terminalPanelState.js";

export function Terminal({
  services,
  cwd,
  workspaceIdentity,
  openWorkspaceKeys,
  isVisible,
  isPanelResizing = false,
  isWindowsDesktop = false,
  onClose,
  onOpenBrowserUrl,
}: {
  services: IServiceAccessor;
  cwd?: string;
  workspaceIdentity?: string;
  openWorkspaceKeys?: string[];
  isVisible: boolean;
  isPanelResizing?: boolean;
  isWindowsDesktop?: boolean;
  onClose: () => void;
  onOpenBrowserUrl: (url: string) => void;
}) {
  // [契约] intl 只用于标题、按钮 aria 与新建/关闭提示文案，组件不缓存任何格式化结果。
  // 原因是语言切换由 IntlProvider 广播驱动整棵树重渲染，缓存字符串会停在上一种语言。
  // isOfficeMode 同理：它只决定“新建终端”按钮是否渲染，不影响会话创建与 PTY 生命周期。
  const { intl } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  // [契约] 身份 key 统一为 identity 优先、其次 cwd、最后占位值，远程 workspace 必须与本地同路径区分。
  // 不能只用 cwd 兜底：同一目录可能同时挂着本地与远程 workspace，混用会让两边的 tab 串台。
  // __default__ 只在前两者都缺失时出现，用于首次挂载的首帧，随后 effect 会用真实 key 补建。
  const workspaceKey = workspaceIdentity?.trim() || cwd || "__default__";
  // [事务] 初始值用惰性初始化一次性建好首个 workspace 与 session，保证首帧就有可挂载的 TabsContent。
  // 这里刻意只建当前 workspace：其余 workspace 等到第一次可见时由 ensure 懒补建，避免启动时拉起多个 PTY。
  const [panelState, setPanelState] = useState<TerminalPanelState>(() => {
    const { session, workspace } = createWorkspaceTerminalState({
      workspaceKey,
      services,
      cwd,
    });
    return {
      sessions: {
        [session.id]: session,
      },
      workspaces: {
        [workspaceKey]: workspace,
      },
    };
  });
  // [并发] 该 ref 是“PTY 退出后需要收起面板”的跨 effect 信箱，只能写 ref 而不能退化成 state。
  // 退出结果发生在 setPanelState 的 updater 内，此时同步调用 onClose 会让父级在 React 提交前卸载。
  // 所以先记录触发退出的 workspace，再由依赖 panelState 的 effect 在提交后消费并清空。
  const closePanelAfterExitWorkspaceRef = useRef<string | null>(null);

  // [契约] 可见即保活：只要 isVisible 为真就确保当前 workspace 有 session，PTY 退出后重新展开面板也走这里补建。
  // 不要加“已有活动 session 就跳过”的提前返回：ensure 内部已按 descriptor 是否存在判重，重复判断会漏掉空 workspace。
  // 依赖里刻意没有 panelState，否则每次会话变更都会再跑一次 ensure，虽幂等但会放大渲染开销。
  useEffect(() => {
    if (!isVisible) {
      return;
    }

    // 业务逻辑：终端会话按 workspace identity 隔离保存，切换 workspace 时只切换可见 tab，
    // 不卸载旧 workspace 的 xterm/PTY，避免长时间运行的命令因为 React 生命周期变化被杀掉。
    // PTY exit 会删除最后一个 session；面板下次重新打开时也通过这里懒创建新终端。
    setPanelState((current) =>
      ensureWorkspaceTerminalState(current, {
        workspaceKey,
        services,
        cwd,
      }),
    );
  // [权衡] cwd 变化会重新 ensure，但不会重建已有 session：终端工作目录在创建那一刻就固定了。
  // 若期望“切目录后终端跟着 cd”，需要显式向 PTY 写入命令，而不是在这里重建 session。
  }, [cwd, isVisible, services, workspaceKey]);

  // [失败路径] 该 effect 专门消费 PTY 退出留下的收起请求；ref 为空时无条件返回，不产生额外渲染。
  // 依赖 panelState 而非仅在挂载时执行，是因为退出结果要等 setState 提交后才可安全触发父级 onClose。
  useEffect(() => {
    const exitedWorkspaceKey = closePanelAfterExitWorkspaceRef.current;
    if (!exitedWorkspaceKey) {
      return;
    }

    // 先清空再判断 workspace：清空保证一次退出只触发一次收起，即使 onClose 引发重渲染也不会重复执行。
    // 只有“退出的正是当前 workspace”才收起面板；后台 workspace 的最后一个 tab 退出只静默移除自身。
    // 若把判断放到清空之前并提前返回，ref 会被残留，下次切回该 workspace 时误关面板。
    closePanelAfterExitWorkspaceRef.current = null;
    if (exitedWorkspaceKey === workspaceKey) {
      onClose();
    }
  }, [onClose, panelState, workspaceKey]);

  // [资源] 终端跨 workspace 切换保活，但 workspace tab 真正关闭后必须回收其 PTY，否则进程与 xterm 常驻内存。
  // openWorkspaceKeys 缺失时直接返回：调用方尚未提供列表的早期渲染阶段不做任何回收。
  useEffect(() => {
    if (!openWorkspaceKeys) {
      return;
    }

    // 终端现在会跨 workspace 切换保活，但 workspace tab 被真正关闭后，
    // 对应的隐藏终端不能继续占着 PTY 进程；这里按仍打开的 workspace key 做回收。
    // 当前 workspaceKey 强制加入保留集合：它可能在 openWorkspaceKeys 更新前的那一帧里尚未出现。
    // 少这一次 add 会在切换瞬间把正在展示的 workspace 连同活动 session 一起回收，画面变成空白面板。
    // 差集在 updater 内实时计算，避免把 openWorkspaceKeys 的旧快照固化进闭包。
    const retainedWorkspaceKeys = new Set(openWorkspaceKeys);
    retainedWorkspaceKeys.add(workspaceKey);
    setPanelState((current) => {
      const removedWorkspaceKeys = Object.keys(current.workspaces).filter(
        (key) => !retainedWorkspaceKeys.has(key),
      );
      if (removedWorkspaceKeys.length === 0) {
        return current;
      }

      // [事务] 先复制再删除，保证每次更新都返回新对象；无删除的分支已在上方提前返回原引用。
      // 删除 workspace 必须同步删除其 sessionIds 指向的 descriptor，两份映射不能只删一侧。
      const nextWorkspaces = { ...current.workspaces };
      const nextSessions = { ...current.sessions };
      for (const removedWorkspaceKey of removedWorkspaceKeys) {
        const workspace = nextWorkspaces[removedWorkspaceKey];
        delete nextWorkspaces[removedWorkspaceKey];
        for (const sessionId of workspace?.sessionIds ?? []) {
          delete nextSessions[sessionId];
        }
      }

      return {
        sessions: nextSessions,
        workspaces: nextWorkspaces,
      };
    });
  // 依赖只含输入而不含 panelState：回收结果由 updater 基于最新状态计算，不会重复回收。
  // services 变化不触发回收：已有 session 持有旧 accessor，重建应由 workspace 关闭路径负责。
  }, [openWorkspaceKeys, workspaceKey]);

  // [契约] shellLabel 由 PTY 侧读出当前 shell 名称后回填，只影响标题栏展示，不参与 tab 身份。
  // 相等判断不是微优化：提示符刷新会让该回调高频触发，无变化时返回原引用才能让 React 跳过渲染。
  // 这个 callback 不依赖外部值，必须保持空依赖数组，否则 TerminalSession 收到的回调身份会不断变化。
  const handleShellLabelChange = useCallback((sessionId: string, shellLabel: string | null) => {
    setPanelState((current) => {
      const session = current.sessions[sessionId];
      if (!session || session.shellLabel === shellLabel) {
        return current;
      }

      return {
        ...current,
        sessions: {
          ...current.sessions,
          [sessionId]: {
            ...session,
            shellLabel,
          },
        },
      };
    });
  }, []);

  // [事务] 新建先 ensure 再追加：兼容当前 workspace 尚未初始化的极端时序（可见 effect 还没执行）。
  // index 由现存 descriptor 推导最小空位，不能自增计数，否则关闭中间 tab 后编号出现空洞。
  // 新 session 立即成为活动 tab；这里不调用 onClose、也不切换可见性，面板状态由父级决定。
  const handleCreateSession = useCallback(() => {
    setPanelState((current) => {
      const ensured = ensureWorkspaceTerminalState(current, {
        workspaceKey,
        services,
        cwd,
      });
      const workspace = ensured.workspaces[workspaceKey];
      if (!workspace) {
        return ensured;
      }

      // descriptor 只保存描述信息与 services 引用，真正的 PTY 在 TerminalSession 挂载时才创建。
      // 因此这里可以同步、无副作用地构造 session；任何 await 或进程启动都不应放进 updater。
      // 日志写在 updater 内部，与状态变更同一次提交，便于对照“有日志却没有 tab”的异常。
      const session = createTerminalSession({
        workspaceKey,
        services,
        cwd,
        index: getNextTerminalSessionIndex(ensured, workspaceKey),
      });
      logger.info("[Terminal] create terminal tab", {
        cwd,
        terminalTabId: session.id,
        workspaceKey,
      });

      return {
        sessions: {
          ...ensured.sessions,
          [session.id]: session,
        },
        workspaces: {
          ...ensured.workspaces,
          [workspaceKey]: {
            sessionIds: [...workspace.sessionIds, session.id],
            activeSessionId: session.id,
          },
        },
      };
    });
  }, [cwd, services, workspaceKey]);

  // [契约] 关闭语义由 getTerminalSessionCloseAction 统一裁决，组件不重复判断 session 数量。
  // 该函数吃的是 panelState 快照，所以 callback 依赖里必须带 panelState，否则会按过期的 tab 数量决策。
  // 返回值做穷举分支：close-panel 收起面板，close-session 删单个 tab，其余一律静默忽略。
  const handleCloseSession = useCallback(
    (sessionId: string) => {
      // [权衡] 最后一个 tab 的“关闭”不做隐藏按钮，而是等价于关闭整个面板并保活 session。
      // 原因是禁用关闭按钮会让用户失去唯一退出入口，也让键盘可达性变差。
      // 真正的 PTY 终止只由进程退出或 workspace 关闭触发，手动关闭 tab 永远不杀进程。
      const closeAction = getTerminalSessionCloseAction(panelState, sessionId);
      if (closeAction === "close-panel") {
        // 旧 UI 在只剩一个 tab 时直接隐藏关闭按钮，用户无法从 tab 完成关闭。
        // 最后一个 tab 的关闭语义是收起整个面板并保活 session，与右上角关闭面板按钮保持一致。
        logger.info("[Terminal] close terminal panel from last tab", {
          terminalTabId: sessionId,
          workspaceKey,
        });
        onClose();
        return;
      }

      // [失败路径] 未知 sessionId 或已不在 registry 里的 tab 返回 none，这里必须直接返回而不是兜底删除。
      // 兜底删除会误删并发路径刚创建的 session：双击关闭时第二次调用看到的是过期快照。
      if (closeAction !== "close-session") {
        return;
      }

      setPanelState((current) => {
        const session = current.sessions[sessionId];
        const next = closeTerminalSession(current, sessionId);
        if (!session || next === current) {
          return current;
        }

        logger.info("[Terminal] close terminal tab", {
          terminalTabId: sessionId,
          workspaceKey: session.workspaceKey,
        });
        return next;
      });
    },
    [onClose, panelState, workspaceKey],
  );

  // [并发] PTY 退出事件可能晚于用户手动关闭到达，此时 descriptor 已不存在，exit 函数返回 none。
  // 必须用函数式更新读取最新 sessions；闭包里的 panelState 只服务关闭按钮分支，不能用于此处判断。
  // 退出处理除了日志不写其他副作用；收起面板通过 ref 延迟到 effect，避免在 updater 中触发父级卸载。
  const handleSessionExit = useCallback(
    (sessionId: string, exitCode: number) => {
      setPanelState((current) => {
        const exitedWorkspaceKey = current.sessions[sessionId]?.workspaceKey;
        // [契约] 第三参传当前 workspaceKey 而不是 session 所属 key：它决定退出后是否需要收起面板。
        // 传 session.workspaceKey 会让后台 workspace 的最后一个 tab 退出时误关用户正在看的面板。
        // exitedWorkspaceKey 在删除之前取出，用于日志与 ref 记录；删除后就无从查询了。
        const result = exitTerminalSession(current, sessionId, workspaceKey);
        if (result.action === "none") {
          return current;
        }

        // 不能只在 xterm 中写“进程已退出”、让 descriptor 留在 tab registry。
        // PTY exit 是 session 生命周期终点，必须同步删除 tab；只有当前 workspace 的最后一个 tab 才关闭面板。
        logger.info("[Terminal] auto close exited terminal tab", {
          action: result.action,
          exitCode,
          terminalTabId: sessionId,
          workspaceKey: exitedWorkspaceKey,
        });
        // [事务] 只记录不执行：把 onClose 留到 effect 中做，保证 setState 已提交、子组件已卸载。
        // exitedWorkspaceKey 可能为空（session 已不存在），此时置 null，effect 会跳过收起。
        // result.state 必须原样返回：额外拷贝会丢掉 closeTerminalSession 已经做好的引用复用。
        if (result.action === "close-panel") {
          closePanelAfterExitWorkspaceRef.current = exitedWorkspaceKey ?? null;
        }
        return result.state;
      });
    },
    [workspaceKey],
  );

  // [契约] Tabs 的值就是 session id，切换只更新所属 workspace 的 activeSessionId，不动其他 workspace。
  // 不存在的 session 或已关闭的 tab 直接返回原引用，避免把空值写进 registry。
  // 这里不调用 PTY 的 focus 或 resize：可见性变化由 TerminalSession 的 isVisible 驱动，职责分离。
  const handleActivateSession = useCallback((sessionId: string) => {
    setPanelState((current) => {
      const session = current.sessions[sessionId];
      if (!session) {
        return current;
      }

      const workspace = current.workspaces[session.workspaceKey];
      if (!workspace || workspace.activeSessionId === sessionId) {
        return current;
      }

      return {
        ...current,
        workspaces: {
          ...current.workspaces,
          [session.workspaceKey]: {
            ...workspace,
            activeSessionId: sessionId,
          },
        },
      };
    });
  }, []);

  // [契约] 派生数据全部在渲染期计算，不放进 state：sessionIds 才是顺序事实，映射只用于查找。
  // workspace 可能短暂缺失（首次可见 effect 尚未跑完），下面必须容忍 undefined 而不是断言非空。
  // currentSessions 用 filter 剔除悬空 id，保证渲染层永远拿不到不存在的 descriptor。
  const workspace = panelState.workspaces[workspaceKey];
  const currentSessions =
    workspace?.sessionIds
      .map((sessionId) => panelState.sessions[sessionId])
      .filter((session): session is TerminalSessionDescriptor => Boolean(session)) ?? [];
  const activeSession =
    currentSessions.find((session) => session.id === workspace?.activeSessionId) ??
    currentSessions[0] ??
    null;
  // [资源] 必须渲染全部 workspace 的 session 而不仅是当前 workspace，forceMount 才能让 PTY 保活。
  // 只渲染 currentSessions 会导致切换 workspace 时旧 xterm 卸载，正在运行的命令随之被杀。
  // 显隐交给每个 TabsContent 的 hidden 状态，与 Tabs 的 value 绑定，不要在这里过滤。
  const allSessions = Object.values(panelState.sessions);

  // [权衡] 面板收起与终端关闭是两条独立语义：收起只影响可见性，关闭才回收资源。
  // 把两者混为一谈会让“临时收起面板去看别的页面”变成杀掉长任务，这是用户最不可接受的回归。
  // 对应地，PTY 自行退出时反过来必须删 tab，否则下一次展开会看到已死的会话。
  // 修复说明：关闭面板只收起 UI，不 dispose tab。真正关闭某个终端由 tab 上的关闭按钮负责，
  // 这样 workspace/task 切换或面板收起都不会中断正在运行的命令。
  // [契约] 渲染层的按钮可见性与业务无关：office 模式隐藏“新建”，关闭按钮始终保留。
  // “新建”直接复用 handleCreateSession，不做二次确认，因为创建成本只是一次懒挂载。
  // Tabs 受控于 activeSession?.id，空字符串表示无活动 tab，此时面板保持空壳而不是崩溃。
  // TerminalSession 的 services 与 cwd 来自 descriptor 而非组件 props，保证旧 workspace 的会话仍用创建时的 accessor。
  return (
    <section
      data-testid={TID_TERMINAL}
      className="flex h-full min-h-0 flex-col gap-2 overflow-hidden bg-background p-3 pb-2"
    >
      <Tabs
        value={activeSession?.id ?? ""}
        onValueChange={handleActivateSession}
        className="h-full min-h-0 gap-2"
      >
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex min-w-0 shrink-0 items-center gap-2">
            <div className="truncate text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "terminal.title" })}
            </div>
            {activeSession?.shellLabel ? (
              <div className="shrink-0 text-ui-base text-foreground-subtle">
                {activeSession.shellLabel}
              </div>
            ) : null}
          </div>

          <div className="min-w-0 flex-1 overflow-x-auto !scrollbar-hide">
            <TabsList className="flex !h-7 w-max justify-start gap-1 rounded-none bg-transparent p-0">
              {currentSessions.map((session) => {
                const projectName =
                  getPathLeaf(session.cwd ?? "") || intl.formatMessage({ id: "terminal.title" });
                const title = formatTerminalTabTitle(projectName, session.index);
                return (
                  <TerminalTabTrigger
                    key={session.id}
                    session={session}
                    title={title}
                    closeLabel={intl.formatMessage({ id: "terminal.closeTab" }, { title })}
                    isActive={session.id === activeSession?.id}
                    onClose={handleCloseSession}
                  />
                );
              })}
            </TabsList>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {!isOfficeMode && (
              <Button
                type="button"
                size="icon-md"
                variant="ghost"
                onClick={handleCreateSession}
                title={intl.formatMessage({ id: "terminal.new" })}
                aria-label={intl.formatMessage({ id: "terminal.new" })}
              >
                <Plus className="h-4 w-4" />
              </Button>
            )}
            <Button
              type="button"
              size="icon-md"
              variant="ghost"
              onClick={onClose}
              data-testid={TID_TERMINAL_CLOSE_BUTTON}
              title={intl.formatMessage({ id: "terminal.close" })}
              aria-label={intl.formatMessage({ id: "terminal.close" })}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {allSessions.map((session) => (
            <TabsContent
              key={session.id}
              value={session.id}
              forceMount
              className="h-full min-h-0 flex-1 data-[state=inactive]:hidden"
            >
              <TerminalSession
                sessionId={session.id}
                services={session.services}
                cwd={session.cwd}
                isVisible={
                  isVisible &&
                  session.workspaceKey === workspaceKey &&
                  session.id === activeSession?.id
                }
                isPanelResizing={isPanelResizing}
                isWindowsDesktop={isWindowsDesktop}
                onShellLabelChange={handleShellLabelChange}
                onExit={handleSessionExit}
                onOpenBrowserUrl={onOpenBrowserUrl}
              />
            </TabsContent>
          ))}
        </div>
      </Tabs>
    </section>
  );
}
