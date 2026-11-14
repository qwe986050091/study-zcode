// ChatRemoteFolderSelection：聊天侧栏空会话切换到远端设备目录时的唯一解析入口。
// 职责：把用户显式确认的目录解析成可发送消息的项目入口，只做校验、登记与导航。
// 阅读顺序：先看下面 INV-01..INV-20 的不可破坏约束，再看各分支上的标记注释。
//
// INV-01 目录先行：必须先经用户显式确认目录才解析项目；守卫在 confirm 与 enterProject 头部；若改为隐式推断，任意路径都会被当成项目根。
// INV-02 Host 派生：hostId 只由 sourceServerId 经身份构造函数派生；守卫在组件顶层；若换成其它拼接，会与本机 Host 撞 id。
// INV-03 存活判断：alive 在卸载清理与 close 中置 false；守卫在 current；若删除，异步续体会对已卸载组件写入状态。
// INV-04 会话校验：current 同时要求 alive 与 request.isCurrent；守卫在 current 与 assertCurrent；若只信 alive，过期导航仍会提交。
// INV-05 同步互斥：flight 在 await 前同步置位；守卫在 chooseProject 与 confirm 入口；若依赖 disabled，双击会重复登记。
// INV-06 成员基准：admittedHost 保存首次准入的 membershipId；守卫在 readHost；若省略比较，被移出设备后仍能以旧身份发送。
// INV-07 回读复核：写操作前后必须 readHost 复核；守卫在 enterProject 与 onBeforeSave；若跳过，权限撤销后的写入无感知。
// INV-08 单根匹配：matches 要求 roots 长度为 1；守卫在 matches；若放宽多根，同一路径会匹配多个项目。
// INV-09 删除过滤：matches 排除 deleted 项目；守卫在 matches；若包含已删除项目，用户会进入远端不存在的目录。
// INV-10 比较来源：路径比较优先 directoryMatchPath，回退根路径；守卫在 matches；若在 UI 自行规范化，旧端历史写法会失配。
// INV-11 选择快照：selected 保存路径与整棵树；守卫在 enterProject 的引用相等比较；若只比路径，重读后的树会被串用。
// INV-12 候选不顶替：重读后即使只剩一项也不替换先前选择；守卫在 confirm 分支；若自动顶替，会把另一个项目登记为入口。
// INV-13 登记并发：addEntry 必须带 expectedMembershipId；守卫在 enterProject；若去掉，成员变更期间入口写入会竞态成功。
// INV-14 刷新顺序：先 prepend 偏好再 refresh 再 readHost；守卫在 enterProject 顺序；若颠倒，侧边栏会短暂缺少新入口。
// INV-15 导航等待：任务创建包装为 Promise 等 onComplete 与 onError；守卫在 enterProject 尾部；若不等待，对话框会在导航未完成时关闭。
// INV-16 取消语义：assertCurrent 抛 navigation-cancelled 而非静默返回；守卫在 assertCurrent；若静默返回，上层无法区分取消与完成。
// INV-17 空选择短路：enterProject 在 choice 为空时直接返回；守卫在函数头部；若继续执行，会用空路径读取目录。
// INV-18 旧端提示：legacySingleRoot 时给升级提示而非建项目；守卫在 confirm 与渲染分支；若强行创建，会写出双根项目。
// INV-19 保存复核：onBeforeSave 内重新读 Host、读目录并准备 Host；守卫在 ProjectEditor 回调；若信任旧快照，零匹配结果会被写入。
// INV-20 错误本地化：所有用户可见错误经 formatProjectError 与 intl；守卫在 catch 分支；若直接展示原始 message，会泄漏内部错误码。
//
// 与上游边界：本组件不复制目录浏览器与项目编辑器逻辑，二者通过 props 与回调注入。
import { useEffect, useRef, useState } from "react";
import { DirectoryBrowser } from "@/DirectoryBrowser.js";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  buildServerRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
  type IProjectService,
  type IRemoteProjectService,
  type ProjectSidebarProps,
  type ProjectTree,
  type RemoteProjectHost,
  type VirtualProject,
} from "@/project-sidebar/contract.js";
import { useProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { useProjectDirectoryServices } from "@/project-sidebar/useProjectDirectoryServices.js";
import { ProjectEditor } from "@/project-sidebar/ProjectEditor.js";
import { formatProjectError } from "@/project-sidebar/view.js";

/** 聊天切换只在显式目录确认后解析项目；其他创建/设备管理入口不使用此流程。 */
export function ChatRemoteFolderSelection({
  request,
  service,
  remoteService,
  onCreateTask,
  onClose,
}: {
  request: { sourceServerId: string; host?: RemoteProjectHost; isCurrent(): boolean };
  service: IProjectService;
  remoteService: IRemoteProjectService;
  onCreateTask: ProjectSidebarProps["onCreateTask"];
  onClose(): void;
}) {
  const { intl } = useZCodeIntl();
  // [权衡] 该服务是可选的：宿主未挂载 Base 工作区能力时 management 为 undefined。
  // 只在 prepareHost 的 Host 不存在需补建路径使用；缺失时走 connection-unavailable，而不是崩溃。
  // 若改为必填依赖，任何未启用该能力的宿主都会在渲染期直接抛错，连目录浏览都不可用。
  const management = useOptionalBaseWorkspaceServices()?.sourceServerManagementService;
  const sidebar = useProjectDirectory();
  // hostId 只能由 sourceServerId 经 buildServerRemoteWorkspaceIdentity 派生，且 workspacePath 固定为根。
  // [不变式] 远端 Host 的身份在这里唯一确定；后续 readHost、matches、addEntry 全部以它为键。
  // [失败路径] 若改用本机路径语义或其它拼接方式，会与本机 Host 撞 id，登记到错误的项目目录。
  const hostId = remoteHostIdFromWorkspaceIdentity(
    buildServerRemoteWorkspaceIdentity({ serverId: request.sourceServerId, workspacePath: "/" }),
  )!;
  const directory = useProjectDirectoryServices(service, hostId);
  // [资源] alive 标记组件是否仍挂载；卸载清理里置 false，close 也会提前置 false。
  // 它是所有异步续体的第一道闸门，缺失会让 await 之后的 setState 落到已卸载组件上。
  const alive = useRef(true);
  // [并发] flight 是同步在途锁：在任何 await 之前就置 true，避免 disabled 尚未提交时的第二次点击。
  // [权衡] 用 ref 而非 state，是因为 state 更新要等一次提交，来不及挡住同一帧内的重复触发。
  const flight = useRef(false);
  // [事务] admittedHost 保存本会话首次准入的 Host 快照，作为成员身份的比较基准。
  // 初始化优先用调用方传入的 host，其次从侧边栏目录缓存中按 hostId 取；两者都没有时留空。
  const admittedHost = useRef(
    request.host ?? sidebar.directory.hosts.find((host) => host.id === hostId),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ path: string; tree: ProjectTree } | null>(null);
  // [并发] selected 与 selection 成对存在：state 驱动渲染，ref 供异步流程读取最新值。
  // 异步回调只信 ref，因为闭包里的 state 可能停留在上一次渲染，会把旧树当成新选择。
  const selected = useRef(selection);
  const [choosingProject, setChoosingProject] = useState(false);
  const projectList = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (choosingProject && !busy) projectList.current?.querySelector("button")?.focus();
  }, [choosingProject, busy, selection]);
  // [并发] current 同时要求组件存活与请求仍是当前会话，二者缺一不可。
  // request.isCurrent 由调用方实现，用于识别导航被新的聊天上下文取代。
  // [失败路径] 只判断 alive 时，过期请求仍会继续登记入口，把用户带到已被替换的会话。
  const current = () => alive.current && request.isCurrent();
  const assertCurrent = () => {
    // [失败路径] 断言失败抛 navigation-cancelled，而不是静默 return。
    // 静默返回会让 finally 正常收尾，上层无法区分已完成和已取消。
    // 异常统一落到 chooseProject 与 confirm 的 catch，仅当仍 current 时才写日志与错误提示。
    if (!current()) throw new Error("project.navigation-cancelled");
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const close = () => {
    alive.current = false;
    onClose();
  };
  // [事务] readHost 是唯一的 Host 读入口：先拉远端目录，再断言会话仍有效。
  // 每次写操作前后都调用它，确保成员关系没有被并发撤销。
  // [失败路径] readDirectory 抛错时直接向上冒泡，由调用方统一转成用户可读错误。
  const readHost = async (): Promise<RemoteProjectHost | undefined> => {
    const hosts = (await remoteService.readDirectory()).hosts;
    assertCurrent();
    const host = hosts.find((item) => item.id === hostId);
    // [事务] 成员身份只比较 membershipId：同一 Host 重新加入会得到新 id，视为已被移除。
    // [失败路径] 不相等即抛 host-removed，阻断后续 addEntry 与导航。
    // [权衡] 只比 id 而不比整个 Host，是为了忽略名称、在线状态等无关字段的抖动。
    if (admittedHost.current && host?.membershipId !== admittedHost.current.membershipId)
      throw new Error("remote-project.host-removed");
    if (host) admittedHost.current = host;
    return host;
  };
  // [事务] prepareHost 保证返回一个可用且已准入的 Host：存在则直接复用。
  // 不存在时才尝试用 Base 工作区的 server profile 补建，属于唯一的写 Host 路径。
  // 补建后再次断言并更新 admittedHost，后续调用都以新快照为基准。
  const prepareHost = async () => {
    const existing = await readHost();
    if (existing) return existing;
    const snapshot = await management?.getSnapshot();
    assertCurrent();
    const profile = snapshot?.servers.some(
      (source) => source.sourceServerId === request.sourceServerId,
    )
      ? snapshot.profiles.find(
          (profile) =>
            profile.sourceServerId === request.sourceServerId &&
            profile.lifecycleState !== "retired",
        )
      : undefined;
    if (!profile) throw new Error("project.connection-unavailable");
    const host = await remoteService.saveHost({ id: hostId, target: profile.target });
    assertCurrent();
    admittedHost.current = host;
    return host;
  };
  // [不变式] matches 是路径到项目的唯一判定：必须同 Host、未删除、且仅有一个根。
  // [权衡] 限制单根是有意的：多根项目无法用单一目录表达入口，交给项目编辑器处理。
  // 已删除项目必须排除，否则用户会进入一个远端已不存在的目录。
  // 比较值优先用 directoryMatchPath，回退到 roots 首项，兼容旧端保留的历史写法。
  const matches = (project: VirtualProject, path: string) =>
    project.hostId === hostId &&
    !project.deleted &&
    project.roots.length === 1 &&
    // 旧端 root 保留历史身份写法；比较值由所属 Host 派生，不能在 UI 使用本机路径规则。
    (project.directoryMatchPath ?? project.roots[0]?.rootPath) === path;
  // [事务] enterProject 是提交阶段：按准备 Host、重读树、校验身份、读目录、登记、刷新、导航的顺序执行。
  // 每一步之间都有 assertCurrent，任一步发现会话已切换就整体放弃，不留半成品入口。
  // project 参数可能来自项目列表，也可能来自编辑器保存回调，因此必须用树重新取 actual。
  // [并发] choice 默认取 selected.current，保证导航使用的路径与用户确认时看到的一致。
  const enterProject = async (project: VirtualProject, choice = selected.current) => {
    assertCurrent();
    if (!choice) return;
    const host = await prepareHost();
    const tree = await service.readTree({ hostId, includeDeleted: true });
    assertCurrent();
    const actual = tree.projects.find(
      (item) => item.id === project.id && matches(item, choice.path),
    );
    // [事务] 双重校验缺一不可：项目必须仍存在于树中，且选择快照未被后续操作替换。
    // [失败路径] 任一不满足抛 not-found，避免用旧 id 或旧路径继续登记。
    // [并发] 比较 selected.current 与 choice 是引用相等，能识别重读后产生的新对象。
    if (!actual || selected.current !== choice) throw new Error("project.not-found");
    await service.readDirectory({ hostId, path: choice.path });
    await readHost();
    assertCurrent();
    await remoteService.addEntry({
      hostId,
      // [事务] addEntry 携带 expectedMembershipId，服务端据此做乐观并发校验。
      // [失败路径] 成员在读取与写入之间被移除时，登记会被拒绝而不是静默成功。
      // 项目字段只取 id、名称与根，不把整棵树写进入口，避免缓存过期数据。
      expectedMembershipId: host.membershipId,
      project: { projectId: actual.id, name: actual.name, roots: actual.roots },
    });
    assertCurrent();
    sidebar.preferences?.prepend(actual);
    await sidebar.refresh();
    assertCurrent();
    await readHost();
    // 旧接线仅登记入口并解除禁发，消息因此落到原本地草稿；必须等待 Root 的准备和导航完成。
    await new Promise<void>((resolve, reject) => {
      // [事务] 任务创建被包成 Promise：onComplete 才 resolve，onError 才 reject，确保导航真正完成。
      // [失败路径] 若去掉等待，对话框会在 Root 尚未就绪时关闭，消息可能落到错误草稿。
      // isCurrent 同时校验会话与选择快照，回调期间的任何切换都会让本次创建作废。
      onCreateTask({
        projectId: actual.id,
        hostId,
        remoteProjectMembershipId: host.membershipId,
        isCurrent: () => current() && selected.current === choice,
        onComplete: resolve,
        onError: reject,
      });
    });
    if (current()) close();
  };
  const chooseProject = async (project: VirtualProject) => {
    // React 的 disabled 尚未提交时也可能收到第二次点击；同步在途锁保证一次选择只登记、导航一次。
    // [并发] 选择项目入口的同步互斥：flight 已置位或会话失效时直接返回，不做任何状态写入。
    // [权衡] 这里不提示正在处理，因为按钮已 disabled，重复点击本就不该产生额外反馈。
    if (flight.current || !current()) return;
    flight.current = true;
    setBusy(true);
    setError(null);
    try {
      await enterProject(project);
    } catch (cause) {
      if (current()) {
        logger.warn("[ChatRemoteFolderSelection] 所选项目准备失败", {
          hostId,
          projectId: project.id,
          cause,
        });
        setError(formatProjectError(cause, intl.formatMessage));
      }
    } finally {
      flight.current = false;
      if (current()) setBusy(false);
    }
  };
  const confirm = async (path: string) => {
    // [并发] 目录确认与项目选择共用同一把 flight 锁，两条路径不会交叉登记。
    // 重试按钮也走 confirm，因此同样受这把锁保护，不会叠加多次目录校验。
    if (flight.current || !current()) return;
    flight.current = true;
    setBusy(true);
    setError(null);
    try {
      await readHost();
      const validated = await service.readDirectory({ hostId, path });
      assertCurrent();
      const tree = await service.readTree({ hostId, includeDeleted: true });
      assertCurrent();
      const choice = { path: validated.path, tree };
      selected.current = choice;
      setSelection(choice);
      // [事务] 候选集由重读后的树按同一路径重新计算，不复用确认前的匹配结果。
      // [不变式] 多于一个候选必须让用户再选，不能按名称或顺序猜一个。
      // [并发] 重读后只剩一个候选时也不立即自动进入：需要结合处于选择态与 legacy 状态判断。
      // [失败路径] 零候选且非 legacy 时给出 unresolved，提示用户换一个目录而不是创建错项目。
      const candidates = tree.projects.filter((project) => matches(project, choice.path));
      // 多项列表重读后即使只剩一项，也不能用剩余项目替代用户先前选择的身份。
      if (candidates.length > 1 || (choosingProject && candidates.length === 1))
        setChoosingProject(true);
      else if (candidates.length === 1) await enterProject(candidates[0]!, choice);
      else if (choosingProject)
        setError(intl.formatMessage({ id: "chat.remoteFolder.unresolved" }));
      else if (tree.legacySingleRoot)
        setError(intl.formatMessage({ id: "project.legacyUpgradeRequired" }));
    } catch (cause) {
      if (current()) {
        logger.warn("[ChatRemoteFolderSelection] 目录或项目准备失败", { hostId, cause });
        setError(formatProjectError(cause, intl.formatMessage));
      }
    } finally {
      flight.current = false;
      if (current()) setBusy(false);
    }
  };
  if (
    selection &&
    !choosingProject &&
    !selection.tree.legacySingleRoot &&
    !selection.tree.projects.some((project) => matches(project, selection.path))
  ) {
    return (
      // [权衡] 目录有效但没有任何项目匹配时，转入项目编辑器并以 fixedFolder 固定 Host 与路径。
      // legacySingleRoot 不进入该分支，交给目录浏览器给出升级提示，避免写出双根项目。
      // [并发] 分支条件含非选择态判断，保证多候选选择期间不会被编辑器界面顶替。
      <ProjectEditor
        project={null}
        isCurrent={current}
        fixedFolder={{
          hostId,
          path: selection.path,
          deviceLabel: sidebar.deviceNames?.get(request.sourceServerId) ?? request.sourceServerId,
        }}
        projects={selection.tree.projects}
        service={service}
        onClose={close}
        // [事务] 保存前复核是最后一道闸门：重新断言会话、读 Host、读目录，再确保 Host 可用。
        // [并发] 信任弹窗停留期间成员可能被移除、目录可能被删除，旧快照不能作为写入依据。
        // [失败路径] 任一复核失败都会抛错，编辑器保持打开并展示本地化错误。
        // [权衡] 复核顺序固定为轻量读取在前、可能写 Host 的 prepareHost 在最后，减少无谓写入。
        onBeforeSave={async () => {
          // 信任弹窗期间可能失去成员或目录；保存前重新核验，不能用旧的零匹配结果写入。
          assertCurrent();
          await readHost();
          await service.readDirectory({ hostId, path: selection.path });
          assertCurrent();
          await prepareHost();
        }}
        onSaved={(project) => enterProject(project, selection)}
      />
    );
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        data-testid="chat-remote-folder"
        className="max-w-xl"
        onKeyDown={(event) => event.stopPropagation()}
      >
        <DialogTitle>
          {intl.formatMessage({
            id: choosingProject ? "chat.empty.selectProject" : "directoryBrowser.title",
          })}
        </DialogTitle>
        <DialogDescription className="break-all">
          {sidebar.deviceNames?.get(request.sourceServerId) ?? request.sourceServerId}
        </DialogDescription>
        {choosingProject && selection ? (
          <>
            <p className="break-all font-mono text-ui-sm text-foreground-subtle">
              {selection.path}
            </p>
            <div ref={projectList} className="grid auto-rows-max max-h-72 gap-1 overflow-y-auto">
              {selection.tree.projects
                .filter((project) => matches(project, selection.path))
                .map((project) => (
                  <Button
                    key={project.id}
                    variant="ghost"
                    className="h-auto min-h-12 justify-start whitespace-normal text-left"
                    // [并发] 项目按钮在 busy 时 disabled，但真正的防重仍在 chooseProject 的 flight 锁。
                    // data-project-id 暴露稳定 id 供测试与日志定位，不参与业务匹配。
                    // 名称可能含空格或中文，样式上允许换行并强制左对齐，避免长名称撑破弹窗。
                    data-testid="chat-remote-project-pick"
                    data-project-id={project.id}
                    disabled={busy}
                    onClick={() => void chooseProject(project)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block break-words">{project.name}</span>
                      <span className="block break-all font-mono text-ui-sm text-foreground-subtle">
                        {project.id}
                      </span>
                    </span>
                  </Button>
                ))}
            </div>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                selected.current = null;
                setSelection(null);
                setChoosingProject(false);
                setError(null);
              }}
            >
              {intl.formatMessage({ id: "chat.remoteFolder.confirm" })}
            </Button>
            <Button variant="ghost" onClick={close}>
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
          </>
        ) : (
          <fieldset disabled={busy} className="flex min-h-0 flex-col border-0 p-0">
            <DirectoryBrowser
              embedded
              showSelectionActions
              selecting={busy}
              selectLabel={intl.formatMessage({ id: "chat.remoteFolder.confirm" })}
              services={directory.services}
              onSelect={(path) => void confirm(path)}
              onCancel={close}
              formatError={(cause) => formatProjectError(cause, intl.formatMessage)}
            />
          </fieldset>
        )}
        {busy && choosingProject ? (
          <p role="status">{intl.formatMessage({ id: "common.loading" })}</p>
        ) : null}
        {error ? (
          <p role="alert" className="break-all text-ui-sm text-destructive">
            {error}
          </p>
        ) : null}
        {error && selection ? (
          <Button variant="secondary" disabled={busy} onClick={() => void confirm(selection.path)}>
            {intl.formatMessage({ id: "common.retry" })}
          </Button>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
