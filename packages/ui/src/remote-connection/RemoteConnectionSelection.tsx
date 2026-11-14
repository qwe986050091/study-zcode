// 远端连接选择面板：把已保存设备、SSH 别名、WSL 发行版与 Docker 容器收敛成
// 一个可按关键字过滤、可用方向键遍历的统一列表，并把用户的选择回传给上层向导。
// 不负责连接建立、凭据输入、档案增删与连通性探测；这里读到的都是上层传入的
// 快照，面板自身不发起远端请求，也不缓存筛选结果或最近目录。
//
// 布局固定为四段（已保存设备 / SSH 别名 / WSL / Docker），段与段共享同一个过滤
// 关键字与同一套行组件；新增来源应复用 SelectionRow，而不是另写一套按钮，
// 否则方向键遍历与禁用态会各自分叉。段标题的 aria-label 与可见标题刻意共用
// 同一个文案 id，不要为无障碍再拆一份键。
//
// 过滤是纯前端内存筛选，关键字每次变化重算四个数组；数据量是设备量级，不加防抖，也不在这里重复请求快照。
//
// INV-01 断言：筛选只读取快照，不回写也不缓存任何结果 —— 守住它的位置：matches 与四个过滤数组 —— 改错故障：筛选结果被当作快照事实，设备凭空消失
// INV-02 断言：快照缺失时设备列表为空且不抛错 —— 守住它的位置：servers 空合并与回调内非空断言 —— 改错故障：首次打开面板白屏
// INV-03 断言：找不到可用档案的设备行必须禁用 —— 守住它的位置：SelectionRow 的 disabled 与点击前判空 —— 改错故障：点击后握手失败且无任何提示
// INV-04 断言：设备行图标种类取自可用档案的传输方式 —— 守住它的位置：kind 取档案传输并回退 ssh —— 改错故障：图标与真实协议不符
// INV-05 断言：已退役档案不得成为最近目录的跳转目标 —— 守住它的位置：historyProfile 的生命周期过滤 —— 改错故障：点进去立即断线
// INV-06 断言：最近目录最多三条且顺序由公共函数裁定 —— 守住它的位置：历史函数返回值后截取三条 —— 改错故障：展示最旧目录或内部隐藏目录
// INV-07 断言：WSL 段只在协议可用时出现 —— 守住它的位置：可用协议列表包含 wsl 的判断 —— 改错故障：列出当前环境无法连接的发行版
// INV-08 断言：Docker 段只在确认可用时出现 —— 守住它的位置：dockerAvailable 真值门控 —— 改错故障：Docker 未启动仍展示陈旧容器
// INV-09 断言：加载中不得同时展示空态 —— 守住它的位置：loading 优先的互斥分支 —— 改错故障：发现过程中闪出没有连接
// INV-10 断言：方向键只在可用的行按钮之间循环 —— 守住它的位置：排除禁用按钮的查询选择器 —— 改错故障：焦点停在禁用行无法继续
// INV-11 断言：取模前必须先补按钮总数 —— 守住它的位置：键盘处理里加列表长度再取余 —— 改错故障：焦点不在列表时按上键丢失焦点
// INV-12 断言：最近目录按钮不得嵌进设备行按钮 —— 守住它的位置：行组件与历史容器互为兄弟节点 —— 改错故障：出现非法嵌套按钮并触发错误选择
// INV-13 断言：同一设备下历史路径唯一充当列表键 —— 守住它的位置：历史按钮的 key 取工作区路径 —— 改错故障：复用错误节点导致点开别的目录
// INV-14 断言：可搜索字段必须覆盖行上展示的文案 —— 守住它的位置：设备与别名过滤的入参集合 —— 改错故障：界面上看得到却搜不到
// INV-15 断言：加载失败提示与空态可以并存 —— 守住它的位置：发现错误独立于空态的分支 —— 改错故障：拉取失败被伪装成没有设备
// INV-16 断言：新建入口逐项来自可用协议列表 —— 守住它的位置：底部按钮对该列表的遍历 —— 改错故障：出现当前环境不支持的新建入口
// INV-17 断言：关键字只保存在面板本地状态 —— 守住它的位置：搜索词的组件内状态 —— 改错故障：切换面板后残留旧关键字或污染全局
// INV-18 断言：所有选择回调都由上层注入 —— 守住它的位置：四个选择与新建回调的调用点 —— 改错故障：面板自行建立连接或绕过上层校验
import { useState, type ReactNode } from "react";
import type {
  ConnectionProfile,
  DockerContainerInfo,
  RemoteTarget,
  SourceServerManagementSnapshot,
  SSHConfigAliasOption,
  WSLDistro,
} from "@zcode/shared";
import {
  BoxIcon,
  CloudIcon,
  FolderIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  TerminalIcon,
} from "lucide-react";
import { Input } from "@/components/ui/input.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { findPreferredSourceConnectionProfile } from "@/lib/remoteConnectionWizard.js";
import {
  getRemoteDevicePresentationInput,
  resolveRemoteConnectionPresentation,
} from "@/lib/remoteConnectionPresentation.js";
import {
  formatConnectionProfileTarget,
  RemoteConnectionStatusTag,
} from "@/remote-connection/RemoteConnectionTags.js";
import { getRecentRemoteWorkspaceHistory } from "@/RemoteConnectionDialogContent.js";
import type { AppSettingsConversationWorkspaceMap } from "@/remote/remoteWorkspaceProjection.js";

// [契约] 种类到图标是全覆盖映射，类型里的每个 kind 都必须在这里有值。
// 新增协议时漏配会让 Icon 变成 undefined，React 在渲染阶段直接抛错，整块选择面板消失。
// 不要为了容错改成按需判断再回退默认图标，那会把漏配藏成线上显示错图标。
const icons = { ssh: ServerIcon, docker: BoxIcon, wsl: TerminalIcon, server: CloudIcon };

// [契约] 行必须是原生 button：键盘处理按按钮选择器收集可聚焦项，替换成带点击的 div 会让方向键遍历整段失效。
// disabled 与 onClick 内的判空是两道独立保险，前者挡住指针与键盘，后者挡住程序化调用。
// status 是唯一的自定义槽位，状态标签由调用方注入，行组件不感知连接状态语义。
// [权衡] 样式只做裁剪与悬停，不在这里加选中态；选中高亮属于外层列表的职责，重复实现会出现两套高亮。
function SelectionRow({
  name,
  description,
  kind,
  status,
  onClick,
  disabled,
}: {
  name: string;
  description: string;
  kind: RemoteTarget["kind"];
  status?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  // [契约] 这里不查表兜底：缺图标属于映射表漏配，应在开发期暴露而不是运行期静默降级到通用图标。
  // Icon 只是引用赋值，不能在此处按条件渲染不同组件，否则同一行的图标会在重渲染之间跳动。
  const Icon = icons[kind];
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-hover focus-visible:bg-hover disabled:opacity-50"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface text-remote-foreground-muted">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui-base font-medium">{name}</span>
        <span className="block break-all font-mono text-ui-sm text-remote-foreground-muted">
          {description}
        </span>
      </span>
      {status}
    </button>
  );
}

// [契约] 入参是上层已聚合好的快照与选项，组件不做任何数据获取与订阅。
// 四个回调各管一种选择结果（档案、别名、目标、新建），不要合并成带判别字段的单一回调，上层据此走不同的校验与路由。
// [失败路径] 发现错误通过字符串传入，组件只负责展示，不在这里重试；重试入口属于上层刷新逻辑。
export function RemoteConnectionSelection({
  snapshot,
  aliases,
  distros,
  containers,
  availableKinds,
  dockerAvailable,
  loading,
  discoveryError,
  onSelectProfile,
  onSelectAlias,
  onSelectTarget,
  onNewConnection,
  remoteConversationWorkspaceBySourceServerId,
}: {
  snapshot: SourceServerManagementSnapshot | null;
  aliases: SSHConfigAliasOption[];
  distros: WSLDistro[];
  containers: DockerContainerInfo[];
  availableKinds: RemoteTarget["kind"][];
  dockerAvailable: boolean | null;
  loading: boolean;
  discoveryError: string;
  onSelectProfile: (profile: ConnectionProfile, path?: string) => void;
  onSelectAlias: (alias: SSHConfigAliasOption) => void;
  onSelectTarget: (target: RemoteTarget) => void;
  onNewConnection: (kind: RemoteTarget["kind"]) => void;
  remoteConversationWorkspaceBySourceServerId: AppSettingsConversationWorkspaceMap;
}) {
  // 文案全部走消息 id，不拼接可翻译片段；节标题与无障碍标签共用同一批 id。
  // [契约] 协议相关的新建按钮按 kind 拼消息 id，新增 kind 时同时要补三套语言文案。
  const { intl } = useZCodeIntl();
  // [契约] 关键字是纯展示态，留在组件内即可；提升到全局会让关闭面板后仍残留上一次搜索。
  // 每次输入都同步重算四个过滤数组，列表是设备量级，不加防抖也不加记忆化。
  // 这里刻意不在快照变化时清空关键字：刷新后发现的新设备也应落在当前搜索结果里。
  const [query, setQuery] = useState("");
  // [契约] 用空格拼接多个字段再统一小写比较，等价于跨字段模糊匹配，顺序无关。
  // undefined 拼接后是空串，因此不会误命中，字段缺失也不需要额外判空。
  // 查询串先 trim 再比较：纯空白查询退化为空串，包含判断恒真，列表全部展示。
  // [契约] 参与匹配的字段必须与行上展示的文案一致，否则会出现看得到却搜不到。
  const matches = (...values: Array<string | undefined>) =>
    values.join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  // [契约] 设备的可搜字段是显示名、全部档案地址、历史工作区路径三部分。
  // 回调里对快照用非空断言是安全的：只有 servers 非空时回调才会执行，而 servers 非空即意味着快照存在。
  // 这里的过滤保持快照原有顺序，排序与优先级由上层与展示层决定，不要在筛选里顺手重排。
  // [权衡] 同一个快照被遍历多次（设备、档案、历史各一次），换来的是代码直接可读；数据量在数十条级别，不必预先建索引。
  // 若把非空断言改成可选链，档案与历史会静默变成空数组，搜索字段缺失但界面仍能打开，属于难察觉的降级。
  const devices = (snapshot?.servers ?? []).filter((server) =>
    matches(
      server.displayName,
      ...snapshot!.profiles
        .filter((profile) => profile.sourceServerId === server.sourceServerId)
        .map(formatConnectionProfileTarget),
      ...snapshot!.workspaceHistory
        .filter((entry) => entry.sourceServerId === server.sourceServerId)
        .map((entry) => entry.workspacePath),
    ),
  );
  // `matches` 同时比对 `alias` / `host` / `username`，任一命中即保留。
  // 这里没有协议门控，别名段始终参与筛选，展示与否只取决于是否有别名。
  // [契约] 过滤不改变别名对象本身，点击时把原对象整体回传，调用方据此读取端口与密钥配置。
  const filteredAliases = aliases.filter((alias) =>
    matches(alias.alias, alias.host, alias.username),
  );
  // [契约] 门控条件不是发行版列表非空，而是当前环境声明支持 wsl。
  // 不支持时返回空数组而不是 undefined，后续统一用长度判断渲染，避免多处判空。
  // 若改成按列表长度判断，未安装 WSL 的机器会展示出可点却连不上的发行版。
  // [失败路径] 发行版发现失败与不支持是两种情况，前者由发现错误单独提示，这里只管能力开关。
  const filteredDistros = availableKinds.includes("wsl")
    ? distros.filter((distro) => matches(distro.name))
    : [];
  // [契约] 只有 dockerAvailable 为真才展示容器；null 表示尚未探测出结果，按不可用处理。
  // 容器同时按名称、标识与镜像搜索，但标识只用于列表键与目标构造，不展示给用户。
  // [失败路径] 探测为假时直接返回空数组，避免把上一次快照里的容器当成当前可连接的实例。
  // 这与 WSL 的门控形式不同：布尔值来自真实探测，不能简化成对象是否存在的判断。
  const filteredContainers = dockerAvailable
    ? containers.filter((container) => matches(container.name, container.id, container.image))
    : [];
  // 顶层是纵向弹性容器，只有中间列表区滚动，搜索框与底部说明保持固定。
  // [契约] 面板不设固定高度，随外层对话框拉伸；写死高度会让移动端键盘弹出时底部按钮被挤出视口。
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="relative">
        <SearchIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-remote-foreground-muted" />
        <Input
          autoFocus
          type="search"
          aria-label={intl.formatMessage({ id: "remote.selection.search" })}
          placeholder={intl.formatMessage({ id: "remote.selection.search" })}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-9 pl-9"
        />
      </div>
      <div
        className="min-h-0 space-y-4 overflow-y-auto"
        onKeyDown={(event) => {
          // [契约] 只接管 `ArrowDown` / `ArrowUp`：其余按键保持浏览器默认，回车与空格仍由聚焦按钮原生触发。
          // 提前返回也让 Tab 正常移出列表，不要把左右键或 Home 键卷进来，那会和输入框光标移动冲突。
          // 判断写在取元素之前，避免每次按键都做一次 DOM 查询。
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          // [契约] 每次按键都重新查询当前 DOM，而不是缓存引用：列表内容随关键字变化，缓存会指到已卸载的按钮。
          // 查询范围限定在事件源内部，避免把搜索框或底部新建按钮卷进循环。
          // 排除禁用按钮，否则焦点会落到无法触发点击的行上，视觉上有焦点但按回车没反应。
          // [权衡] 用的是按钮顺序而非可访问性树顺序，依赖行组件一律渲染为原生按钮这一约定。
          const buttons = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
          );
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          buttons[
            (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length
          ]?.focus();
          // [资源] 聚焦之后才阻止默认滚动，否则方向键会连带滚动整个列表容器。
          // 按钮集合为空时索引表达式得到 NaN，可选调用使聚焦成为空操作，这里仍会阻止滚动，属于可接受的空列表边界。
          // [失败路径] 不要在阻止默认行为之前抛错，否则异常会让方向键退化为滚动整页。
          event.preventDefault();
        }}
      >
        {devices.length > 0 && snapshot ? (
          <section aria-label={intl.formatMessage({ id: "remote.selection.saved" })}>
            <p className="text-pretty mb-2 text-ui-sm text-remote-foreground-muted">
              {intl.formatMessage({ id: "remote.selection.saved" })}
            </p>
            {devices.map((server) => {
              // [契约] 首选档案由公共函数裁定：先看设备记录的偏好档案，再回退到该设备第一个未退役档案。
              // 不要在渲染里按数组顺序自己挑档案，退役过滤与偏好优先级只在公共函数里维护一份。
              // 取不到档案时行会被禁用，这是预期结果而不是异常；设备存在但线路被删就是这种状态。
              // [失败路径] 缺少档案时描述为空串而不是占位文案，避免把不可用设备伪装成可用。
              const profile = findPreferredSourceConnectionProfile(snapshot, server.sourceServerId);
              // [契约] 传入的是快照中属于该设备的历史，公共函数负责剔除隐藏目录、剔除当前会话目录并按最近打开时间倒序。
              // 截取 3 条必须由调用方完成，因为 `getRecentRemoteWorkspaceHistory` 不限数量，其他列表可能要不同条数。
              // 历史条目是投影数据，不代表目录仍然存在，点击后的连通性由上层处理。
              // 不要在 map 里再排序或去重，双重口径会让最近目录与其它入口顺序不一致。
              const history = getRecentRemoteWorkspaceHistory(
                snapshot.workspaceHistory.filter(
                  (entry) => entry.sourceServerId === server.sourceServerId,
                ),
                remoteConversationWorkspaceBySourceServerId,
              ).slice(0, 3);
              // [契约] 设备容器带数据属性，供端到端测试定位具体设备；改类名不影响测试，删属性会直接让用例找不到节点。
              // 键取设备标识而非显示名，显示名允许重名，用名当键会让两台同名设备共用 React 节点。
              // 每台设备下面挂最近目录，目录按钮与设备行是兄弟关系，不能嵌套进设备行按钮内部。
              return (
                <div
                  key={server.sourceServerId}
                  data-remote-source-server-id={server.sourceServerId}
                  className="mb-2"
                >
                  <SelectionRow
                    name={server.displayName}
                    description={profile ? formatConnectionProfileTarget(profile) : ""}
                    kind={profile?.transport ?? "ssh"}
                    disabled={!profile}
                    onClick={() => profile && onSelectProfile(profile)}
                    status={
                      <RemoteConnectionStatusTag
                        presentation={resolveRemoteConnectionPresentation(
                          getRemoteDevicePresentationInput(snapshot, server.sourceServerId),
                        )}
                      />
                    }
                  />
                  <div className="ml-13 flex flex-wrap gap-1">
                    {history.map((entry) => {
                      // [契约] 历史条目要同时命中档案标识、设备归属且未退役，三者缺一不可。
                      // 只比对档案标识会把别的设备线路当成本机路线，只比对设备归属会拿到已轮换掉的旧档案。
                      // 回退到设备首选档案是有意为之：历史线路被删除后，仍允许用户按同一目录重新建立连接。
                      // [权衡] `historyProfile` 回退而不是禁用：代价是可能连到不同地址，但这是产品接受的行为。
                      // [失败路径] 若把退役过滤删掉，用户点进最近目录会进入一条已下线线路，表现为立即断线且无提示。
                      const historyProfile =
                        snapshot.profiles.find(
                          (candidate) =>
                            candidate.profileId === entry.profileId &&
                            candidate.sourceServerId === server.sourceServerId &&
                            candidate.lifecycleState !== "retired",
                        ) ?? profile;
                      // 无可用档案时整行不渲染，而不是渲染一个禁用按钮：禁用按钮会让用户以为目录本身不可用。
                      // 键取工作区路径，同一设备下的历史目录路径唯一，可直接作为稳定键。
                      // [契约] 点击时把目录路径作为第二个参数传出，上层据此直接打开该工作区，不再让用户二次选择。
                      return historyProfile ? (
                        <button
                          key={entry.workspacePath}
                          type="button"
                          title={entry.workspacePath}
                          onClick={() => onSelectProfile(historyProfile, entry.workspacePath)}
                          className="flex max-w-full items-center gap-1 rounded-md border border-border bg-surface px-2 py-0.5 font-mono text-ui-sm text-remote-foreground-muted hover:bg-hover"
                        >
                          <FolderIcon className="size-3 shrink-0" />
                          <span className="truncate">{entry.workspacePath}</span>
                        </button>
                      ) : null;
                    })}
                  </div>
                </div>
              );
            })}
          </section>
        ) : null}
        {filteredAliases.length ? (
          <section aria-label={intl.formatMessage({ id: "remote.selection.aliases" })}>
            <p className="text-pretty mb-2 text-ui-sm text-remote-foreground-muted">
              {intl.formatMessage({ id: "remote.selection.aliases" })}{" "}
              <span className="ml-2 font-mono text-ui-xs text-remote-foreground-muted">
                ~/.ssh/config
              </span>
            </p>
            {filteredAliases.map((alias) => (
              <SelectionRow
                key={alias.alias}
                name={alias.alias}
                kind="ssh"
                description={[
                  alias.username && `${alias.username}@`,
                  alias.host || alias.alias,
                  alias.port && `:${alias.port}`,
                ]
                  .filter(Boolean)
                  .join("")}
                onClick={() => onSelectAlias(alias)}
              />
            ))}
          </section>
        ) : null}
        {filteredDistros.length ? (
          <section aria-label={intl.formatMessage({ id: "remote.selection.wsl" })}>
            <p className="text-pretty mb-2 text-ui-sm text-remote-foreground-muted">
              {intl.formatMessage({ id: "remote.selection.wsl" })}
            </p>
            {filteredDistros.map((distro) => (
              <SelectionRow
                key={distro.name}
                name={distro.name}
                kind="wsl"
                description="WSL"
                onClick={() => onSelectTarget({ kind: "wsl", distro: distro.name })}
              />
            ))}
          </section>
        ) : null}
        {filteredContainers.length ? (
          <section aria-label={intl.formatMessage({ id: "remote.selection.docker" })}>
            <p className="text-pretty mb-2 text-ui-sm text-remote-foreground-muted">
              {intl.formatMessage({ id: "remote.selection.docker" })}
            </p>
            {filteredContainers.map((container) => (
              <SelectionRow
                key={container.id}
                name={container.name}
                kind="docker"
                description={container.image}
                onClick={() => onSelectTarget({ kind: "docker", container: container.name })}
              />
            ))}
          </section>
        ) : null}
        {loading ? (
          <p role="status" className="text-ui-sm text-remote-foreground-muted">
            {intl.formatMessage({ id: "common.loading" })}
          </p>
        ) : !devices.length &&
          !filteredAliases.length &&
          !filteredDistros.length &&
          !filteredContainers.length ? (
          <p className="text-pretty text-ui-sm text-remote-foreground-muted">
            {intl.formatMessage({ id: "remote.selection.empty" })}
          </p>
        ) : null}
        {discoveryError ? (
          <p role="status" className="text-ui-sm text-warning">
            {intl.formatMessage({ id: "remote.optionsLoadFailed" })}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          {availableKinds.map((kind) => (
            <Button
              key={kind}
              data-testid={`remote-kind-${kind}`}
              type="button"
              variant="outline"
              onClick={() => onNewConnection(kind)}
            >
              <PlusIcon className="size-3.5" />
              {intl.formatMessage({ id: `remote.selection.new.${kind}` })}
            </Button>
          ))}
        </div>
        {availableKinds.includes("server") ? (
          <p className="text-pretty text-ui-xs text-remote-foreground-muted">
            {intl.formatMessage({ id: "remote.kind.server.note" })}
          </p>
        ) : null}
      </div>
      <p className="text-pretty border-t border-border pt-3 text-ui-xs text-remote-foreground-muted">
        {intl.formatMessage({ id: "remote.selection.keyboard" })}
      </p>
    </div>
  );
}
