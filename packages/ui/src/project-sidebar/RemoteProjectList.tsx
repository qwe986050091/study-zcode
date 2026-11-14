// INV-01 组件身份以 device 优先、host 兜底；守住位置：首行 hostId 的 device?.id ?? host!.id；改错故障：两者都给时按 host 取 id，列表与选择写到不同 Host。
// INV-02 scope 由 hostId 与 membershipId 共同构成；守住位置：scope 模板串中的空值占位；改错故障：成员换代后仍视为同一作用域，旧回调继续登记入口。
// INV-03 过期判定必须同时校验存活与作用域；守住位置：current 闭包的 active 与 scopeRef 双条件；改错故障：卸载或换成员后仍写状态，出现跨面板串台。
// INV-04 存活标记由挂载副作用接管；守住位置：首个 useEffect 的清理函数把 active 置否；改错故障：切 Host 后旧请求仍生效，loading 与错误状态被迟到结果覆盖。
// INV-05 作用域快照每次渲染同步；守住位置：scopeRef.current 的直接赋值行；改错故障：异步回调读到挂载时的旧 scope，换代后仍判定为当前流程。
// INV-06 能力回调走 ref 间接调用；守住位置：capabilityCallback 的初始化与更新赋值；改错故障：上层内联回调每次渲染换引用，触发重复读树或丢失最新回调。
// INV-07 读取前先复位三态；守住位置：读树副作用开头的 loading、error、projects 三条设置；改错故障：上一 Host 的项目短暂残留，用户可能选中错误条目。
// INV-08 结果必须按 hostId 过滤；守住位置：读树成功分支对 tree.projects 的 filter 条件；改错故障：服务返回混合目录时把他人项目渲染进来，选择写入错误 Host。
// INV-09 legacySingleRoot 只从读树结果推导一次；守住位置：setLegacySingleRoot 与 capabilityCallback 的同源两行；改错故障：两处各自推导，出现提示与按钮禁用状态不一致。
// INV-10 读取失败统一翻译后再落地；守住位置：catch 中的 formatProjectError 映射；改错故障：原始错误码直接展示给用户，或错误被吞导致空白列表无提示。
// INV-11 收尾只在本次请求有效时执行；守住位置：finally 的 active 判定与清理函数的置否；改错故障：旧请求提前结束新一轮加载，列表在加载中闪现空态。
// INV-12 依赖数组覆盖所有身份输入；守住位置：读树副作用末尾的 service、hostId、scope、retry；改错故障：漏掉 scope 时换代不重读，展示旧成员的项目。
// INV-13 登记流程至少两次过期检查；守住位置：add 入口与 onBeforeAdd 之后的 current 判定；改错故障：草稿返回或成员换代后仍登记入口，污染新流程。
// INV-14 写入前必须复核 Host 仍在目录中；守住位置：add 内 readDirectory 结果对 hostId 与 membershipId 的 some 判定；改错故障：向已移除的 Host 写入入口，远端出现孤儿项目。
// INV-15 登记入参三元组缺一不可；守住位置：addEntry 的 hostId、expectedMembershipId、project 字段；改错故障：漏传 expectedMembershipId 时把项目写到重新添加的同 id 新成员上。
// INV-16 成功后的副作用顺序固定；守住位置：add 尾部的偏好前插、onSaved、onClose 三步；改错故障：先关闭再刷新，用户看不到新项目或刷新落在已关闭面板。
// INV-17 创建分支由七条件门禁；守住位置：return renderCreate 前的组合判断；改错故障：加载中或报错时进入创建，基于不可信目录写出非法项目。
// INV-18 四个可见状态各有守卫且新建按钮同步禁用；守住位置：loading、error、empty、legacySingleRoot 的条件渲染与新建按钮 disabled 表达式；改错故障：空态与错误同屏，或报错时仍可点新建。
//
// 模块职责：远程 Host 的项目选择与新建入口，读取目录、呈现加载/空/错误/旧单 root 四类状态，并把一次选择登记为远端入口。
// 状态所有权：projects、loading、error、saving、creating、legacySingleRoot 均为本地瞬时投影；项目事实属于远端目录，侧栏偏好仅做顺序投影。
// 阅读顺序：先看 props 契约与 hostId/scope，再看读树副作用，最后看 add 登记事务与创建/列表渲染门禁。
import { formatProjectError } from "@/project-sidebar/view.js";
import { useOptionalProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import type {
  IProjectService,
  IRemoteProjectService,
  RemoteProjectHost,
  VirtualProject,
  ProjectDevice,
} from "@/project-sidebar/contract.js";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { remoteHostLabel } from "@/project-sidebar/RemoteHostSection.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

// [契约] 组件只读展示远程项目并转发一次选择，不持有项目事实；列表来自 readTree 的 hostId 过滤投影，本地仅保留渲染快照。
// [边界] host 与 device 至少给一个：hostId 由 device 优先，缺省时直接断言 host；两者都缺会在首行崩溃，而不是静默取空串继续。
// [契约] renderCreate 是唯一的外置新建表单入口，签名为 projects、add、close；列表不自己造草稿，避免出现两个草稿 owner。
// [权衡] embedded 只切换外壳（内嵌片段或 Dialog），不改变加载、选择与新建语义，两种形态共用同一份状态。
export function RemoteProjectList({
  host,
  service,
  remoteService,
  onClose,
  onSaved,
  initialRoots,
  device,
  embedded = false,
  onBeforeAdd,
  onLegacyCapability,
  renderCreate,
}: {
  host?: RemoteProjectHost;
  device?: ProjectDevice;
  embedded?: boolean;
  onBeforeAdd?(isCurrent: () => boolean): Promise<RemoteProjectHost>;
  onLegacyCapability?(legacy: boolean): void;
  renderCreate?(
    projects: VirtualProject[],
    add: (project: VirtualProject) => Promise<void>,
    close: () => void,
  ): ReactNode;
  service: IProjectService;
  remoteService: IRemoteProjectService;
  onClose(): void;
  onSaved(isCurrent?: () => boolean): Promise<void>;
  initialRoots?: string[];
}) {
  // [身份] hostId 固定取 device 优先：设备视图与 host 视图可能同时存在，混用会让列表与写入落在不同 Host。
  // [身份] scope 拼接 hostId 与 membershipId，空字符串占位保证缺省 host 时仍可比对；只按 hostId 比对会漏掉成员换代。
  // [并发] scopeRef 在每次渲染同步当前 scope，供异步回调读取最新值，避免闭包读到挂载时的旧身份。
  // [并发] current 同时要求 active 与 scope 相等：卸载后或成员换代后的旧异步结果一律视为过期。
  // [资源] capabilityCallback 用 ref 保存最新回调，注册副作用只依赖 service、hostId、scope、retry，避免回调换引用触发重读。
  // [失败路径] active 由独立副作用在卸载时置否；current 先查 active 再比 scope，顺序反了会让卸载后的回调仍写状态。
  // [权衡] 组件不缓存远端目录，scope 只用于过期判定，不用于重新查询；重新查询统一由 retry 计数驱动。
  const hostId = device?.id ?? host!.id;
  const scope = `${hostId}:${host?.membershipId ?? ""}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const current = () => active.current && scopeRef.current === scope;
  const capabilityCallback = useRef(onLegacyCapability);
  capabilityCallback.current = onLegacyCapability;
  const sidebar = useOptionalProjectDirectory();
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const { intl } = useZCodeIntl();
  const msg = (id: string) => intl.formatMessage({ id: `project.${id}` });
  const [projects, setProjects] = useState<VirtualProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(initialRoots !== undefined);
  const [legacySingleRoot, setLegacySingleRoot] = useState(false);
  const [saving, setSaving] = useState(false);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // [顺序] 副作用开头先复位 loading、error 与 projects 三态；保留旧列表会让他人 Host 的项目短暂可见。
    // [契约] readTree 固定 includeDeleted 为 true，删除标记交给渲染层过滤；改成 false 会丢掉恢复入口所需的数据。
    // [身份] 结果按 project.hostId 严格过滤，防止服务返回跨 Host 混合列表，导致选择写到错误 Host。
    // [状态] legacySingleRoot 与能力回调同源，均来自同一次 readTree 结果，不得由两处独立推导。
    // [并发] 闭包内的 active 与 retry 变更一一对应：旧请求晚到时只丢弃自己的写入，不覆盖新一轮结果。
    // [失败路径] 异常统一经 formatProjectError 映射为本地化文案，原始错误码不外泄给用户。
    // [失败路径] finally 只在本次请求仍有效时收尾 loading；旧请求的 finally 不得提前结束新一轮加载。
    // [资源] 清理函数把 active 置否，等价于取消订阅；缺它会在切 Host 后仍写状态并触发无谓重渲染。
    // [事务] 依赖数组含 service、hostId、scope、retry：scope 变化必须重读，membershipId 更新后旧列表不再可信。
    let active = true;
    setLoading(true);
    setError(null);
    setProjects([]);
    void service
      .readTree({ hostId, includeDeleted: true })
      .then((tree) => {
        if (active) {
          setProjects(tree.projects.filter((project) => project.hostId === hostId));
          setLegacySingleRoot(Boolean(tree.legacySingleRoot));
          capabilityCallback.current?.(Boolean(tree.legacySingleRoot));
        }
      })
      .catch((cause) => {
        if (active) setError(formatProjectError(cause, intl.formatMessage));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [service, hostId, scope, retry]);
  // [并发] 入口先查 current，onBeforeAdd 返回后再查一次；成员换代时既不登记入口也不关闭新流程。
  // [失败路径] 取消时抛 creation-cancelled 而不是静默返回，让调用方区分主动取消与成功。
  // [事务] 登记前重读 readDirectory，确认 hostId 与 expectedMembershipId 仍匹配；缺失即抛 host-removed 终止写入。
  // [事务] addEntry 同时携带 hostId、expectedMembershipId 与 project 三元组（projectId、name、roots），缺一不可。
  // [顺序] 写入成功后再次查 current，再执行侧栏偏好前插、onSaved 与 onClose，保证副作用只落在有效作用域。
  // [资源] 侧栏前插是可空的本地偏好投影，不是持久化事实；失败重试不应重复插入同一条目。
  // [顺序] onSaved 在偏好前插之后调用，且把 current 透传下去，让上层刷新共享同一过期判定。
  // [失败路径] onClose 只在 current 成立时执行；成员已换代时关闭会误关用户新打开的面板。
  // [权衡] add 作为 renderCreate 的第二个实参暴露给新建表单，表单保存即选择：这是两条路径共用同一登记事务的契约。
  const add = async (project: VirtualProject) => {
    if (!current()) throw new Error("project.creation-cancelled");
    // 原因：返回草稿或成员换代后，旧选择不得再登记入口或关闭新的流程。
    const selectedHost = onBeforeAdd ? await onBeforeAdd(current) : host;
    if (!current()) return;
    const directory = await remoteService.readDirectory();
    if (!current()) throw new Error("project.creation-cancelled");
    if (
      !directory.hosts.some(
        (item) => item.id === hostId && item.membershipId === selectedHost?.membershipId,
      )
    )
      throw new Error("remote-project.host-removed");
    await remoteService.addEntry({
      hostId,
      expectedMembershipId: selectedHost?.membershipId,
      project: { projectId: project.id, name: project.name, roots: project.roots },
    });
    if (!current()) return;
    sidebar?.preferences.prepend(project);
    await onSaved(current);
    if (current()) onClose();
  };
  // [门禁] 七个条件全真才渲染新建表单：缺 host、内嵌形态、非创建态、加载中、旧单 root、有错误或未提供 renderCreate 都退回列表。
  // [权衡] embedded 不复用该分支：内嵌编辑器的创建入口由外层 Dialog 控制，避免嵌套 Dialog 与两套关闭逻辑。
  // [失败路径] error 非空时禁止进入创建，防止在目录读取失败、Host 可能已移除的情况下写出新入口。
  // [契约] 传出的 close 只把 creating 置否，不回写远端；取消创建不需要事务回滚。
  // [顺序] 该分支位于列表内容构造之前并直接返回，创建表单因此不会与列表并行挂载。
  if (host && !embedded && creating && !loading && !legacySingleRoot && !error && renderCreate)
    return renderCreate(projects, add, () => setCreating(false));
  // [渲染] 内容片段按 embedded 分叉：内嵌时把返回按钮放到标题左侧，避免列表变长后底部返回入口被挤出视口。
  // [契约] 标题与描述来自 i18n 与设备标签；描述回落顺序为 device.label、remoteHostLabel、hostId，三者不可省略兜底。
  // [渲染] 列表容器用 auto-rows-max 加 max-h-72 与 overflow-y-auto，多行名称按内容定高再滚动，避免上下裁切。
  // [渲染] 列表先按 deleted 过滤再映射，已删除项目不出现在选择区，但仍保留在 readTree 结果里供其他视图使用。
  // [并发] saving 为真时所有项目按钮禁用，避免同时发起两次登记；它只挡 UI，不替代 add 内部的 current 判定。
  // [失败路径] 点击后先清空 error 再发起保存；每次 add 的 catch 与 finally 都先查 current，过期失败不污染新面板。
  // [空态] 空态渲染要求非 loading 非 error；错误时在列表下方额外给出重试按钮，重试靠 retry 计数触发重读。
  const content = (
    <>
      {/* 内嵌页的返回入口原在列表底部，列表变长后会被挤到下方；放到标题左侧与目录浏览器的返回习惯一致。 */}
      {embedded ? (
        <div className="flex min-w-0 items-center gap-1.5 pr-8">
          <Button
            variant="ghost"
            size="icon-sm"
            className="-ml-1 text-foreground-subtle"
            data-testid="remote-project-back"
            aria-label={msg("backToCreate")}
            title={msg("backToCreate")}
            onClick={onClose}
          >
            <ArrowLeft className="size-4" />
          </Button>
          <DialogTitle>{msg("addRemoteProject")}</DialogTitle>
        </div>
      ) : (
        <DialogTitle>{msg("addRemoteProject")}</DialogTitle>
      )}
      <DialogDescription>
        {device?.label ?? (host ? remoteHostLabel(host) : hostId)}
      </DialogDescription>
      {/* 多行名称曾被 max-height 下的 auto 轨道压到最小行高；按内容定高再滚动，避免上下裁切。 */}
      <div className="grid auto-rows-max max-h-72 gap-1 overflow-y-auto">
        {projects
          .filter((project) => !project.deleted)
          .map((project) => (
            <Button
              key={project.id}
              variant="ghost"
              className="h-auto min-h-12 justify-start whitespace-normal text-left"
              data-project-id={project.id}
              disabled={saving}
              data-testid="remote-project-pick"
              onClick={() => {
                setSaving(true);
                setError(null);
                void add(project)
                  .catch((cause) => {
                    if (current()) setError(formatProjectError(cause, intl.formatMessage));
                  })
                  .finally(() => {
                    if (current()) setSaving(false);
                  });
              }}
            >
              <span className="min-w-0 flex-1">
                <span className="block break-words">{project.name}</span>
                <span className="block break-all font-mono text-ui-sm text-foreground-subtle">
                  {project.roots.map((root) => root.rootPath).join(", ")}
                </span>
              </span>
            </Button>
          ))}
      </div>
      {loading ? <p>{intl.formatMessage({ id: "common.loading" })}</p> : null}
      {error ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {error}
        </p>
      ) : null}
      {!loading && !error && !projects.some((project) => !project.deleted) ? (
        <p className="text-ui-sm text-foreground-subtle">{msg("noExistingProjects")}</p>
      ) : null}
      {error ? (
        <Button variant="secondary" onClick={() => setRetry((value) => value + 1)}>
          {intl.formatMessage({ id: "common.retry" })}
        </Button>
      ) : null}
      {embedded ? null : (
        <Button
          disabled={loading || saving || Boolean(error) || legacySingleRoot}
          data-testid="remote-project-new"
          onClick={() => setCreating(true)}
        >
          {msg("new")}
        </Button>
      )}
      {legacySingleRoot ? (
        <p className="text-ui-sm text-foreground-subtle">{msg("legacyUpgradeRequired")}</p>
      ) : null}
    </>
  );
  // [外壳] 内嵌形态直接返回内容片段，外层 Dialog 由调用方提供；这里再包一层会产生嵌套弹窗。
  // [契约] 非内嵌时 open 恒真，关闭统一走 onOpenChange 的 onClose，不提供第二条关闭路径。
  // [权衡] 新建按钮在内嵌形态隐藏、在旧单 root 时禁用并另给升级提示；两处门禁必须一致，否则会出现无法完成的创建入口。
  return embedded ? (
    content
  ) : (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-lg">{content}</DialogContent>
    </Dialog>
  );
}
