// 职责边界：本文件只做「项目编辑器弹层」的表单状态、异步编排与 JSX 呈现；
// 不负责 Host/设备连接实现、不直接读写磁盘、不持有远端会话事实——那些由 service 与 hooks 提供。
// 所有落盘动作都经 service.saveProject / deleteProject，本组件不缓存已保存项目。
//
// 不变量（INV）表：
// | 编号 | 断言 | 守住它的位置 | 改错后的故障 |
// | INV-01 | 异步结果必须过 current(request) 才落 state | current() 与各 finally | 卸载或切设备后旧响应污染草稿 |
// | INV-02 | 设备切换与浏览取消都会自增 epoch | changeDevice、onCancel 回调 | 迟到的旧目录被写进新设备 |
// | INV-03 | 卸载时 alive 置 false 并自增 epoch | useEffect cleanup | 卸载后 setState 与泄漏的恢复查询 |
// | INV-04 | suspended 期间不提交任何保存 | suspendedRef 与 canCommit | 后台表单恢复后弹出旧确认 |
// | INV-05 | 同一时刻只允许一次 save flight | saveFlight.current 守卫 | 重复提交创建出两个项目 |
// | INV-06 | 创建成功后保留 created 不再重建 | setCreated(saved) 与 created 分支 | 登记失败重试生成新 ID |
// | INV-07 | 远端项目必须恰好一个 root | roots.length 校验抛错 | 远端多目录无法映射，保存被拒 |
// | INV-08 | fixedFolder 不可改 Host 与 root | fixedFolder 判定与按钮禁用 | 聊天已确认的目录被改写 |
// | INV-09 | 切设备前必须经用户确认 | changeDevice 的 confirm | 未确认就丢弃已选目录 |
// | INV-10 | 切设备要同时清空 roots/primary/browsing/error | changeDevice 的四次 set | 旧设备目录残留在新设备上 |
// | INV-11 | 本机添加目录按路径去重 | addRoots 的 Set 合并 | 同一目录出现多行 |
// | INV-12 | 远端只接受第一个目录 | addRoots 的 slice(0, 1) | 远端多 root 触发保存校验失败 |
// | INV-13 | primary 必须属于 roots | addRoots 与删除行的 setPrimary | 主目录指向已删除路径 |
// | INV-14 | 恢复候选取自所属 Host 的树 | tree?.projects ?? projects | 跨 Host 误恢复别的项目 |
// | INV-15 | legacySingleRoot 时禁止写入 | tree?.legacySingleRoot 分支 | 旧数据结构被按新格式覆盖 |
// | INV-16 | 信任确认只能 resolve 一次 | finish 中清空 cancelTrust | 流程重入并重复保存 |
// | INV-17 | 错误只写本地 error 状态 | catch 中的 formatProjectError | 未捕获异常导致弹窗空白 |
// | INV-18 | 诊断日志统一走 logger | logger.debug / logger.warn | 生产环境丢失关键证据 |
// | INV-19 | 注释不得落在 JSX 子节点 | 本文件的注释插入位置 | 注释文本被当成界面文字渲染
import { formatProjectError } from "@/project-sidebar/view.js";
import { useOptionalProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  Folder,
  FolderPlus,
  LoaderCircle,
  Monitor,
  Plus,
  Server,
  X,
} from "lucide-react";
import type {
  IProjectService,
  VirtualProject,
  RemoteProjectHost,
  ProjectDevice,
} from "@/project-sidebar/contract.js";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Input } from "@/components/ui/input.js";
import { DirectoryBrowser } from "@/DirectoryBrowser.js";
import { useRemoteBoundaryAcknowledgement } from "@/RemoteConnectionDialogContent.js";
import { useProjectDirectoryServices } from "@/project-sidebar/useProjectDirectoryServices.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getPathLeaf } from "@/lib/path.js";
import { RemoteProjectList } from "@/project-sidebar/RemoteProjectList.js";
import type { IRemoteProjectService } from "@/project-sidebar/contract.js";
import { logger } from "@/logger.js";
import { remoteHostLabel } from "@/project-sidebar/RemoteHostSection.js";
import {
  resolveRemoteConnectionPresentation,
  type RemoteConnectionStatus,
} from "@/lib/remoteConnectionPresentation.js";
import {
  ProjectFolderTrustDialog,
  type ProjectFolderTrustRequest,
} from "@/project-sidebar/ProjectFolderTrustDialog.js";

// [契约] 字段标签样式集中一份，避免每个 label 复制类名后漂移。
// 该常量只描述排版，不承载主题色；主题色由 text-foreground 语义变量提供。
// 改错故障：就地写类名会让深浅主题下的对比度不一致。
const FIELD_LABEL = "text-ui-sm font-medium text-foreground";
// SelectItem 的 ItemText 默认按内容收缩；撑满整行后状态才能靠右，长名称截断时不挤掉状态。
// [契约] 撑满整行后状态才能靠右，长名称截断时不会挤掉状态。
// 这两个选择器依赖 DeviceOption 的 DOM 结构，改结构必须同步改这里。
// 改错故障：去掉 flex-1 会让长设备名把状态圆点推出可视区。
const DEVICE_ITEM = "pr-8 *:[span]:last:min-w-0 *:[span]:last:flex-1";

/** 设备行：图标 + 名称 + 状态；状态颜色只取远程连接展示模型，在线只留圆点。 */
// [契约] 设备行只消费 status 字符串，图标与颜色全部由展示模型推导。
// status 缺省表示本机，此时不渲染状态区，也不请求连接展示模型。
// 改错故障：在组件内自造状态色会让同一状态在不同入口显示不一致。
function DeviceOption({ label, status }: { label: string; status?: string }) {
  const { intl } = useZCodeIntl();
  // [契约] 状态到图标/颜色的映射只走 resolveRemoteConnectionPresentation。
  // 传 state 前做类型断言是历史字符串边界，不要在此新增第三种状态。
  // 改错故障：自写 switch 会与远端连接弹层显示同一状态的不同文案。
  const presentation = status
    ? resolveRemoteConnectionPresentation({ state: status as RemoteConnectionStatus })
    : undefined;
  // [契约] 有 status 即视为远端设备（Server 图标），无 status 为本机（Monitor）。
  // 判定依据是字段存在性而不是值，因为离线远端同样要显示 Server。
  // 改错故障：按 status === online 判定会让离线设备错误显示为本机。
  const Icon = status ? Server : Monitor;
  return (
    <span className="flex w-full min-w-0 items-center gap-2">
      <Icon className="size-4 text-foreground-subtle" />
      <span className="min-w-0 truncate">{label}</span>
      {presentation ? (
        <span
          data-testid="virtual-project-device-status"
          data-status={status}
          className="ml-auto flex shrink-0 items-center gap-1.5 text-ui-sm text-foreground-subtle"
        >
          {presentation.icon === "spinner" ? (
            <LoaderCircle className={`size-3 animate-spin ${presentation.foreground}`} />
          ) : (
            <span className={`size-2 rounded-full ${presentation.dot}`} />
          )}
          <span className={status === "online" ? "sr-only" : undefined}>
            {intl.formatMessage({ id: `project.deviceStatus.${status}` })}
          </span>
        </span>
      ) : null}
    </span>
  );
}

// [契约] 组件同时承担「新建」与「编辑」，由 project 是否为 null 区分。
// 所有 props 都是受控输入，组件内部不写回上层 store，只通过回调上报。
// 改错故障：在组件内直接改项目列表会绕过上层持久化与导航。
export function ProjectEditor({
  project,
  host,
  initialRoots = [],
  fixedFolder,
  isCurrent = () => true,
  projects,
  service,
  onClose,
  onSaved,
  onDeleted,
  devices,
  defaultDeviceId,
  suspended = false,
  onBeforeSave,
  onConnectDevice,
  onAddDevice,
  remoteService,
  onBrowseExisting,
  onPrepareExisting,
  onSavedExisting = async () => undefined,
}: {
  project: VirtualProject | null;
  remoteService?: IRemoteProjectService;
  onSavedExisting?(isCurrent?: () => boolean): Promise<void>;
  onBrowseExisting?(device: ProjectDevice): Promise<boolean>;
  onPrepareExisting?(hostId: string, isCurrent: () => boolean): Promise<RemoteProjectHost>;
  devices?: ProjectDevice[];
  defaultDeviceId?: string;
  suspended?: boolean;
  onBeforeSave?(hostId: string): Promise<void>;
  onConnectDevice?(device: ProjectDevice): Promise<boolean>;
  onAddDevice?(selectDevice: (id: string) => Promise<void>): void;
  host?: RemoteProjectHost;
  initialRoots?: string[];
  /** 聊天已确认的远程目录；表单不能改成另一个 Host 或 root。 */
  fixedFolder?: { hostId: string; path: string; deviceLabel: string };
  isCurrent?(): boolean;
  projects: VirtualProject[];
  service: IProjectService;
  onClose(): void;
  onSaved(project: VirtualProject): Promise<void>;
  onDeleted?(): Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  // [契约] 用 optional 版本：编辑器可能被独立挂载，缺少 Provider 时不应崩溃。
  // sidebar 只用于本机新建成功后把项目插到列表头，不属于持久化路径。
  // 改错故障：改用具名 hook 会让无 Provider 的测试与独立弹层直接抛错。
  const sidebar = useOptionalProjectDirectory();
  // [契约] 平台能力可选：无原生选择器时退回内置目录浏览器。
  // 组件不直接访问 window.zcode，平台差异全部收在 IPlatformService 后面。
  // 改错故障：直接调原生 API 会让 Web 版在浏览器里报未定义。
  const platform = useOptionalPlatform();
  // [契约] 初值只在挂载时取一次，之后作为草稿状态由用户操作驱动。
  // 缺省回落 local，保证没有设备列表时表单仍可用。
  // 改错故障：把 defaultDeviceId 当受控值会让父层重渲染重置用户选择。
  const [selectedDeviceId, setSelectedDeviceId] = useState(defaultDeviceId ?? "local");
  // [契约] hostId 优先级：项目既有 Host → 聊天固定目录 → 传入 Host → 设备草稿。
  // 该值决定 service 作用域，必须与 roots 的来源保持同一 Host。
  // 改错故障：优先级颠倒会让编辑已有项目时误用当前设备上下文。
  const hostId =
    project?.hostId ?? fixedFolder?.hostId ?? host?.id ?? (devices ? selectedDeviceId : undefined);
  // [契约] 只有非 local 的 hostId 才算远端，local 一律按本机项目处理。
  // remote 会同时影响目录数量上限、凭据确认与保存按钮禁用条件。
  // 改错故障：把 remote 判断成分支写在多处会让某条路径漏掉单目录校验。
  const remote = Boolean(hostId && hostId !== "local");
  // [契约] 所有文案走 intl，前缀 project. 统一在此拼接，避免散落硬编码。
  // 返回函数每次渲染新建，属于可接受的闭包开销，不要提升为模块常量。
  // 改错故障：提升到模块级会丢失语言切换后的重新渲染。
  const msg = (id: string) => intl.formatMessage({ id: `project.${id}` });
  // [契约] 新建时默认取固定目录的最后一段，编辑时取既有名称。
  // 该初值不标记为「用户编辑」，因此未改名时提交不发送 name 字段。
  // 改错故障：初值也置 nameEdited 会让服务端覆盖用户原有命名。
  const [name, setName] = useState(
    project?.name ?? (fixedFolder ? getPathLeaf(fixedFolder.path) : ""),
  );
  // [契约] 只有真实输入才置 true，用于区分「默认名」与「用户显式命名」。
  // 提交时用 nameEdited 决定是否带 name，服务端据此生成默认名。
  // 改错故障：始终发送 name 会让重命名语义扩散到未改名的保存。
  const [nameEdited, setNameEdited] = useState(false);
  // [契约] 编辑态取项目既有 roots；新建态取固定目录或 initialRoots。
  // 这里只保存路径字符串，不保存 root 元数据（如 isPrimary）以免双份事实。
  // 改错故障：把整个 root 对象存进 state 会在保存时传出过期的 isPrimary。
  const [roots, setRoots] = useState(
    project?.roots.map((root) => root.rootPath) ??
      (fixedFolder ? [fixedFolder.path] : initialRoots),
  );
  // [契约] 主目录优先取既有 isPrimary，其次固定目录，最后第一个 root。
  // primary 是独立 state，因为用户可在保存前改变主目录而不改 roots 顺序。
  // 改错故障：用 roots[0] 代替 primary 会静默改变用户设定的主目录。
  const [primary, setPrimary] = useState(
    project?.roots.find((root) => root.isPrimary)?.rootPath ??
      fixedFolder?.path ??
      initialRoots[0] ??
      "",
  );
  // [契约] existing 为 true 时整个表单被远程项目列表替换，草稿状态保留。
  // 返回表单只重置该标志并聚焦入口，不清空已填名称与目录。
  // 改错故障：切到列表时卸载表单会让用户输入丢失。
  const [existing, setExisting] = useState(false);
  // [契约] 记录「需要升级的旧设备」，与当前 hostId 相等时才展示提示并禁用保存。
  // 它同时被保存按钮的 disabled 条件引用，是阻止写入旧格式的闸门。
  // 改错故障：只用提示不参与禁用会让用户绕过升级直接覆盖数据。
  const [legacyDeviceId, setLegacyDeviceId] = useState<string | null>(null);
  // [契约] 从远程列表返回后聚焦该按钮，保持键盘与读屏焦点连续。
  // ref 不参与渲染逻辑，仅用于命令式聚焦。
  // 改错故障：改用 state 驱动聚焦会触发额外渲染且时机不可控。
  const existingButton = useRef<HTMLButtonElement>(null);
  const [browsing, setBrowsing] = useState(false);
  // [契约] 目录服务随 hostId 切换重建，保证浏览的是当前 Host 的文件系统。
  // 该 hook 的返回被原样传给 DirectoryBrowser，本组件不缓存其服务实例。
  // 改错故障：跨 host 复用 services 会让浏览器列出上一个设备目录。
  const directory = useProjectDirectoryServices(service, hostId);
  // [契约] error 只存放已格式化的用户可读文案，不放异常对象。
  // 所有 catch 都通过 formatProjectError 统一映射，未知错误也有兜底文案。
  // 改错故障：直接存 cause 会在渲染时报对象无法作为子节点。
  const [error, setError] = useState<string | null>(null);
  // [契约] busy 是唯一提交锁的 UI 投影，真实互斥仍由 saveFlight 保证。
  // 只依赖 busy 禁用按钮不足以挡住并发，因为 setState 是异步的。
  // 改错故障：把 busy 当锁会让同一帧内的两次点击都进入 save。
  const [busy, setBusy] = useState(false);
  // [契约] 创建成功后记住结果：后续登记失败重试必须复用同一项目。
  // created 非空时禁用表单与删除，防止用户改出与已建项目不一致的草稿。
  // 改错故障：重试时重新走 saveProject 会生成第二个项目 ID。
  const [created, setCreated] = useState<VirtualProject | null>(null);
  // [契约] 信任确认用 state 承载，而不是命令式弹窗，保证卸载时能被清理。
  // 非空即渲染确认框，且确认框必须留在父弹层的 React 树内。
  // 改错故障：改为独立 Portal 会让外部点击判定关闭整个草稿弹层。
  const [folderTrust, setFolderTrust] = useState<ProjectFolderTrustRequest | null>(null);
  // [并发] saveFlight 是真正的互斥锁：非空即表示已有一次保存在飞。
  // 它同时暴露 cancelTrust，用于退出、切后台时中断等待中的确认。
  // 改错故障：只用 state 做锁会让并发点击各自创建一次保存。
  const saveFlight = useRef<{ cancelTrust?: () => void } | null>(null);
  // [契约] 信任确认关闭后把焦点还给保存按钮，避免焦点落到 body。
  // 仅在组件仍存活且未挂起时聚焦，否则会抢走其他弹层的焦点。
  // 改错故障：无条件 focus 会在切到后台表单后强行抢焦点。
  const saveButton = useRef<HTMLButtonElement>(null);
  // [并发] 用 ref 镜像 suspended，使异步回调读到最新值而非闭包快照。
  // 每次渲染同步赋值，是刻意在渲染期写 ref，不要改成 effect 延迟同步。
  // 改错故障：异步里读 props.suspended 会拿到旧值，后台仍提交保存。
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const confirm = useConfirmDialog();
  const acknowledgeBoundary = useRemoteBoundaryAcknowledgement();
  // [并发] epoch 是「当前请求代」的单调计数，异步结果必须与它比对。
  // 设备切换、浏览取消、卸载都会自增，从而一次性作废所有在飞请求。
  // 改错故障：比对字符串或时间戳会让同一毫秒内的两次操作无法区分。
  const epoch = useRef(0);
  // [资源] alive 标记组件是否仍挂载，所有 setState 前都应先判它。
  // 初始化的 useEffect 会在挂载后置 true，卸载时置 false 并自增 epoch。
  // 改错故障：卸载后仍 setState 会触发 React 警告并可能泄漏恢复查询。
  const alive = useRef(true);
  // [资源] 空依赖 effect 只负责挂载标记与卸载清理，不参与数据获取。
  // 清理顺序有语义：先置 alive=false，再自增 epoch，最后取消信任等待。
  // 改错故障：漏掉 cancelTrust 会让已卸载组件的 Promise 永不 resolve。
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      epoch.current++;
      saveFlight.current?.cancelTrust?.();
    };
  }, []);
  useEffect(() => {
    // 父表单切到后台后，连同尚未完成的恢复查询一起失效，避免返回前台后旧查询重新弹出确认。
    if (suspended && saveFlight.current) {
      epoch.current++;
      saveFlight.current.cancelTrust?.();
    }
  }, [suspended]);
  // [并发] 这是所有异步回调的统一守门函数，判断挂载与请求代双重有效。
  // 只判 epoch 不判 alive 会在卸载后继续写入已释放的 state。
  // 改错故障：在回调里直接比较局部变量会让过期请求通过检查。
  const current = (request: number) => alive.current && epoch.current === request;
  // [契约] 由 id 反查设备对象，找不到表示列表已变更或数据未就绪。
  // 下游多处依赖它为 undefined 表示「本机或无匹配」，不要改成兜底对象。
  // 改错故障：兜底成假设备会让远端分支对 local 设备发起连接。
  const selectedDevice = devices?.find((device) => device.id === selectedDeviceId);
  // [并发] 切换设备前先自增 epoch，使旧设备的目录响应立即失效。
  // 确认框返回 false 时直接放弃，不能只清空 error 继续切换。
  // 改错故障：先切换再确认会让用户在取消后仍看到新设备被选中。
  const changeDevice = async (next: string) => {
    if (next === selectedDeviceId) return;
    const request = ++epoch.current;
    // 确认前不提交任何字段；旧目录响应也随此次设备选择失效，避免跨设备污染草稿。
    if (
      roots.length &&
      !(await confirm({ title: msg("switchDevice"), description: msg("switchDeviceDescription") }))
    )
      return;
    if (!current(request)) return;
    setRoots([]);
    setPrimary("");
    setBrowsing(false);
    setError(null);
    setSelectedDeviceId(next);
  };
  // [契约] 本机合并去重，远端只取第一个并拒绝追加，两套规则必须分开写。
  // 新增后仅在远端或无既有 root 时重设 primary，避免覆盖用户选择。
  // 改错故障：本机不去重会让同一路径出现两行并重复提交。
  const addRoots = (values: string[]) => {
    // [契约] 已存在的远端项目不可追加目录，静默忽略而不是报错。
    // 该守卫与保存侧的 roots.length 校验互为兜底。
    // 改错故障：去掉守卫会让 UI 显示出保存必然失败的多目录状态。
    if (remote && project) return;
    const next = remote
      ? values.filter(Boolean).slice(0, 1)
      : [...new Set([...roots, ...values.filter(Boolean)])];
    setRoots(next);
    if (remote || !roots.length) setPrimary(next[0] ?? "");
    setBrowsing(false);
  };
  // [并发] 浏览入口先自增 epoch，取消与选择都以此代为准。
  // 远端未连接时先尝试连接再浏览，本地则直接走系统或内置选择器。
  // 改错故障：不取 epoch 会让连续两次点击的旧结果覆盖新结果。
  const browse = async () => {
    const request = ++epoch.current;
    // [失败路径] 远端设备离线时先连接；连接成功才打开浏览器。
    // 缺少设备对象或连接回调时直接给错误文案，不发送任何网络请求。
    // 改错故障：离线也打开浏览器会让 DirectoryBrowser 对空连接发起查询。
    if (remote && devices && selectedDevice?.status !== "online") {
      // [失败路径] 无设备或无连接能力属于不可恢复的入口缺失，用错误文案终止。
      // 不抛异常是刻意的：这是用户可见的界面状态，不是程序错误。
      // 改错故障：抛错会被上层当成崩溃日志，掩盖真实的产品缺口。
      if (!selectedDevice || !onConnectDevice) {
        setError(msg("connectionUnavailable"));
        return;
      }
      setBusy(true);
      try {
        // [并发] 连接结果必须过 current(request) 才可用于打开浏览器。
        // ready 为 false 表示用户取消或连接失败，此时不进入浏览态。
        // 改错故障：不看 ready 直接 setBrowsing 会让用户看到空目录。
        const ready = await onConnectDevice(selectedDevice);
        if (current(request) && ready) setBrowsing(true);
      } catch (cause) {
        if (current(request)) setError(formatProjectError(cause, intl.formatMessage));
      } finally {
        if (current(request)) setBusy(false);
      }
      return;
    }
    // 本地曾统一走 Host 文件列表，绕过系统多选；按项目 Host 与平台能力选入口，不能借当前 tab 判定。
    // [契约] 入口选择按所属 Host 与平台能力判定，不能借用当前 tab 判断。
    // [契约] `hostId` 非 local 时走内置浏览器：原生选择器只服务本机路径。
    // 改错故障：统一走原生选择器会让远端项目拿到本机路径。
    if ((hostId && hostId !== "local") || !platform?.selectDirectories) {
      if (remote) {
        setBusy(true);
        try {
          // 已连接设备可直接浏览目录，仍须经过与主动连接相同的首次介绍；失效表单不记已读。
          if (!(await acknowledgeBoundary(() => current(request) && !suspendedRef.current))) return;
        } finally {
          if (current(request)) setBusy(false);
        }
      }
      if (current(request) && !suspendedRef.current) setBrowsing(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // [资源] 原生选择返回的路径数组可能为空，空数组时不得清空既有 roots。
      // 结果需要 current(request) 校验，因为系统选择器是长时间异步操作。
      // 改错故障：直接把空数组交给 addRoots 会把用户已有目录清空。
      const selected = await platform.selectDirectories();
      logger.debug("[ProjectEditor] native directory selection", { count: selected.length });
      if (current(request) && selected.length) addRoots(selected);
    } catch (cause) {
      // [失败路径] 选择失败记 warn 而不是 error：用户取消与权限拒绝都走这里。
      // 同时写用户可见错误，日志与界面必须成对出现，便于事后对齐。
      // 改错故障：只打日志会让用户看到无反应的点击。
      logger.warn("[ProjectEditor] native directory selection failed", cause);
      if (current(request)) setError(formatProjectError(cause, intl.formatMessage));
    } finally {
      if (current(request)) setBusy(false);
    }
  };
  // [并发] 保存是全流程唯一提交点，进入即抢占 saveFlight 并锁定 epoch。
  // 所有中断检查统一走 canCommit，避免每个 await 后各写一份条件。
  // 改错故障：漏掉任意一处 canCommit 都会让过期流程继续写盘。
  const save = async () => {
    // [并发] 三重守卫分别拦截：重复提交、后台表单、已被替换的表单实例。
    // isCurrent 由父层注入，用于判断聊天会话是否已换代。
    // 改错故障：只判 busy 会让同一帧内的双击都进入保存。
    if (saveFlight.current || suspendedRef.current || !isCurrent()) return;
    // [资源] flight 是本次保存的句柄，比 saveFlight 的引用相等用于判断归属。
    // finally 中用引用相等清理，避免把后来者的 flight 一并置空。
    // 改错故障：无条件置 null 会让下一次保存的锁被前一次 finally 清掉。
    const flight: { cancelTrust?: () => void } = {};
    saveFlight.current = flight;
    const request = epoch.current;
    // [并发] 判定「本次保存仍可写状态」的唯一函数，request 取自进入时的 epoch。
    // 注意它不检查 busy：同一流程内可反复调用，用于 await 之后续跑。
    // 改错故障：把 busy 纳入判定会让流程在自身 busy 期间永远无法提交。
    const canCommit = () => current(request) && !suspendedRef.current && isCurrent();
    setBusy(true);
    setError(null);
    try {
      // [事务] `created` 已存在时只补外层登记与关闭，不再走保存分支。
      // 该分支是「登记失败重试」的入口，必须复用 created 的 id。
      // 改错故障：重试时重新保存会让用户看到两个同名项目。
      if (created) {
        await onSaved(created);
        if (canCommit()) onClose();
        return;
      }
      // [契约] 远端项目必须恰好一个 root，且编辑时不允许改 root。
      // 抛出的 message 是 i18n key，由 formatProjectError 负责翻译。
      // 改错故障：只校验数量不校验一致性会让用户悄悄改掉远端根目录。
      if (remote && (roots.length !== 1 || (project && project.roots[0]?.rootPath !== roots[0]))) {
        throw new Error("project.remote-single-root-required");
      }
      // [事务] restoreProject 只在确认恢复软删除项目时赋值，随后作为保存参数。
      // 它必须是本次保存的局部变量，不能提到 state 里以免跨次保存串味。
      // 改错故障：放进 state 会让上一次确认的恢复目标被下一次保存复用。
      let restoreProject: VirtualProject | undefined;
      if (!project) {
        // 设备全集不等于本机项目入口全集；远端恢复候选必须读取所属 Host，不能只看 open set。
        // [契约] 远端新建时必须读所属 Host 的树（含已删除），而不是当前打开集合。
        // 本机新建不读树，直接用 projects，避免无谓的文件系统查询。
        // 改错故障：只查 open set 会让已删除项目无法被识别并恢复。
        const tree =
          remote && (devices || fixedFolder)
            ? await service.readTree({ hostId, includeDeleted: true })
            : undefined;
        if (tree?.legacySingleRoot) {
          setLegacyDeviceId(hostId!);
          throw new Error(msg("legacyUpgradeRequired"));
        }
        // [契约] 读树失败时退回当前 projects，保证恢复检测不因 I/O 失败而中断。
        // 两条来源的字段形态一致，才能共享后面的 deleted 匹配逻辑。
        // 改错故障：退回空数组会让已删除项目的恢复入口消失。
        const candidates = tree?.projects ?? projects;
        if (!canCommit()) return;
        // [契约] 恢复候选必须同时满足：已删除、同 Host、root 集合完全相同。
        // 用 roots.every 与长度比较做集合相等，不比较顺序。
        // 改错故障：只比路径包含关系会让子目录项目被误判为同一项目。
        const deleted = candidates.find(
          (candidate) =>
            candidate.deleted &&
            (!hostId || candidate.hostId === hostId) &&
            candidate.roots.length === roots.length &&
            candidate.roots.every((root) => roots.includes(root.rootPath)),
        );
        if (
          deleted &&
          (await confirm({
            title: msg("restore"),
            description: intl.formatMessage(
              { id: "project.restoreDescription" },
              { name: deleted.name },
            ),
          }))
        )
          restoreProject = deleted;
      }
      if (!canCommit()) return;
      if (!project && roots.length) {
        // [事务] 用 Promise 承载确认框结果，使保存流程可以顺序等待用户决定。
        // setFolderTrust 之后必须保留 resolve，供对话框的关闭回调调用。
        // 改错故障：改用回调链会让后续 canCommit 检查散落在多处。
        const accepted = await new Promise<boolean>((resolve) => {
          // [事务] finish 是幂等出口：cancelTrust 置空后再次调用直接返回。
          // 清空文件夹信任 state 也要在 alive 校验内，避免卸载后 setState。
          // 改错故障：不置空 cancelTrust 会让取消与确认各 resolve 一次。
          const finish = (value: boolean) => {
            if (!flight.cancelTrust) return;
            flight.cancelTrust = undefined;
            if (alive.current) setFolderTrust(null);
            resolve(value);
          };
          flight.cancelTrust = () => finish(false);
          setFolderTrust({
            roots: [...roots],
            deviceLabel: remote
              ? (fixedFolder?.deviceLabel ??
                selectedDevice?.label ??
                (host ? remoteHostLabel(host) : hostId!))
              : undefined,
            restoring: Boolean(restoreProject),
            projectName: fixedFolder
              ? (nameEdited ? name.trim() : restoreProject?.name) || getPathLeaf(fixedFolder.path)
              : undefined,
            resolve: finish,
          });
        });
        logger.debug("[ProjectEditor] folder confirmation", {
          accepted,
          remote,
          count: roots.length,
        });
        if (!accepted || !canCommit()) return;
      }
      // [契约] 父层钩子先于保存执行（例如预建 Host），失败即中断保存。
      // hostId 缺省回落 local，保证本机新建也有确定的 Host 作用域。
      // 改错故障：放在保存之后会让项目写入一个尚未就绪的 Host。
      await onBeforeSave?.(hostId ?? "local");
      if (!canCommit()) return;
      // [事务] 只有用户显式命名时才发送 name，否则交给服务端生成默认名。
      // id、restoreProjectId、primaryRoot 都是可选展开，缺省即不覆盖。
      // 改错故障：无条件带 id 会让新建请求被当成对空项目的更新。
      const saved = await service.saveProject({
        ...(hostId ? { hostId } : {}),
        ...(project ? { id: project.id } : {}),
        ...(restoreProject ? { restoreProjectId: restoreProject.id } : {}),
        ...(nameEdited ? { name: name.trim() } : {}),
        defaultName: msg("new"),
        roots,
        ...(primary ? { primaryRoot: primary } : {}),
      });
      if (!alive.current) return;
      // 远端创建与本机入口登记分两步；登记失败重试必须复用已创建的项目，不能再生成一个 ID。
      // [事务] 仅新建流程记录 created；编辑流程失败重试直接重放保存即可。
      // 远端新建后还要做入口登记，登记失败会落入 catch 并保留 created。
      // 改错故障：编辑流程也记录 created 会让下次保存跳过实际写入。
      if (!project) setCreated(saved);
      // 外层聊天可能已换代；保留已保存结果，但不继续登记、导航或关闭新流程。
      if (!canCommit()) return;
      // [契约] 只为本机新建项目插入侧栏列表头，远端项目由会话链路投影。
      // prepend 是本地偏好投影，不替代持久化，失败重试不会重复插入。
      // 改错故障：远端也 prepend 会出现与历史列表重复的条目。
      if (!project && !remote) sidebar?.preferences.prepend(saved);
      await onSaved(saved);
      // 草稿可能已被关闭或替换；旧登记结果不能关闭后来创建的表单。
      if (canCommit()) onClose();
    } catch (cause) {
      if (canCommit()) setError(formatProjectError(cause, intl.formatMessage));
    } finally {
      if (saveFlight.current === flight) saveFlight.current = null;
      if (alive.current) setBusy(false);
    }
  };
  // [事务] 删除是软删除，只改项目记录，不触碰文件与任务。
  // 删除后先回调 onDeleted 再关闭，让父层有机会刷新列表。
  // 改错故障：先关闭再回调会让用户看到未刷新的列表。
  const remove = async () => {
    if (!project) return;
    setBusy(true);
    setError(null);
    try {
      // 编辑器曾漏掉删除入口；复用所属 Host 的软删除，不触碰文件或任务。
      // [契约] 必须同时传项目 id 与所属 hostId，删除作用域不能靠当前连接推断。
      // project.hostId 可能为空，此时由 service 按本机处理，不要在此兜底成 local。
      // 改错故障：只用 id 删除会在多 Host 环境下删到同名项目。
      await service.deleteProject(project.id, project.hostId);
      await onDeleted?.();
      onClose();
    } catch (cause) {
      setError(formatProjectError(cause, intl.formatMessage));
    } finally {
      setBusy(false);
    }
  };
  // [并发] 打开已有项目列表同样需要 epoch 守卫，因为可能弹出连接流程。
  // 成功后置 existing，使表单被远程列表替换而保留草稿。
  // 改错故障：不校验 current 会让切换设备后仍跳到上一个设备的列表。
  const browseExisting = async () => {
    if (!selectedDevice || !onBrowseExisting) return;
    const request = ++epoch.current;
    setBusy(true);
    setError(null);
    try {
      // [契约] 先看钩子返回值再看 epoch：两者都满足才切换视图。
      // 短路顺序保证即使 epoch 失效也仍完成了必要的资源准备。
      // 改错故障：先查 epoch 再调用钩子会让过期请求完全不执行连接。
      if ((await onBrowseExisting(selectedDevice)) && current(request)) setExisting(true);
    } catch (cause) {
      if (current(request)) setError(formatProjectError(cause, intl.formatMessage));
    } finally {
      if (current(request)) setBusy(false);
    }
  };
  // [并发] 渲染期快照 epoch，供 JSX 内的选择回调判定来源是否仍有效。
  // 每次渲染重新取值，因此切换设备后旧回调自动比对失败。
  // 改错故障：在回调里实时读 epoch.current 会让所有选择都被当成有效。
  const browserEpoch = epoch.current;
  // [契约] 该布尔只用于入口文案与图标，不参与是否发起连接的决策。
  // decision 仍由 browse 内部的设备状态判断，二者不能互相替代。
  // 改错故障：把文案布尔当连接条件会让无设备列表的远端入口失效。
  const needsConnection = remote && Boolean(devices) && selectedDevice?.status !== "online";
  return (
    <Dialog
      open={!suspended}
      onOpenChange={(open) => {
        if (!open)
          logger.debug("[ProjectEditor] close requested", {
            busy,
            confirming: Boolean(folderTrust),
          });
        if (!open && (!busy || fixedFolder)) onClose();
      }}
    >
      <DialogContent
        className="max-w-lg gap-5"
        onKeyDown={fixedFolder ? (event) => event.stopPropagation() : undefined}
      >
        {existing && selectedDevice && remoteService ? (
          <RemoteProjectList
            key={selectedDevice.id}
            embedded
            device={selectedDevice}
            service={service}
            remoteService={remoteService}
            onBeforeAdd={(isCurrent) => onPrepareExisting!(selectedDevice.id, isCurrent)}
            onLegacyCapability={(legacy) => setLegacyDeviceId(legacy ? selectedDevice.id : null)}
            onSaved={async (isCurrent) => {
              await onSavedExisting(isCurrent);
            }}
            onClose={() => {
              epoch.current++;
              setExisting(false);
              requestAnimationFrame(() => existingButton.current?.focus());
            }}
          />
        ) : (
          <>
            <DialogTitle>
              {browsing ? msg("browse") : project ? msg("edit") : msg("create")}
            </DialogTitle>
            <DialogDescription className="sr-only">{msg("description")}</DialogDescription>
            {browsing ? (
              <div
                className="flex h-96 min-h-0 flex-col gap-2"
                data-testid="virtual-project-directory-browser"
              >
                <DirectoryBrowser
                  embedded
                  showSelectionActions
                  selectLabel={msg("browse")}
                  services={directory.services}
                  onSelect={(path) => {
                    if (current(browserEpoch)) addRoots([path]);
                  }}
                  onCancel={() => {
                    epoch.current++;
                    setBrowsing(false);
                  }}
                />
              </div>
            ) : (
              <>
                <div className="grid min-w-0 gap-1.5">
                  <label htmlFor="project-name" className={FIELD_LABEL}>
                    {msg("name")}
                  </label>
                  <Input
                    id="project-name"
                    aria-label={msg("name")}
                    placeholder={msg("new")}
                    autoFocus
                    disabled={busy || Boolean(created)}
                    data-testid="virtual-project-name"
                    value={name}
                    onChange={(event) => {
                      setName(event.target.value);
                      setNameEdited(true);
                    }}
                    className="h-9 rounded-lg max-md:text-mobile-input-safe"
                  />
                  {fixedFolder ? (
                    <p className="break-all text-ui-sm text-foreground-subtle">
                      {fixedFolder.deviceLabel}
                    </p>
                  ) : null}
                </div>
                {devices ? (
                  <div className="grid min-w-0 gap-1.5">
                    <label htmlFor="project-device" className={FIELD_LABEL}>
                      {msg("device")}
                    </label>
                    <Select
                      value={selectedDeviceId}
                      onValueChange={(value) => {
                        if (value === "add-device") onAddDevice?.(changeDevice);
                        else void changeDevice(value);
                      }}
                      disabled={busy || Boolean(created)}
                    >
                      <SelectTrigger
                        id="project-device"
                        data-testid="virtual-project-device"
                        className="h-9 w-full min-w-0 rounded-lg *:data-[slot=select-value]:w-full *:data-[slot=select-value]:min-w-0"
                      >
                        <SelectValue>
                          <DeviceOption
                            label={
                              selectedDeviceId === "local"
                                ? msg("thisComputer")
                                : (selectedDevice?.label ?? selectedDeviceId)
                            }
                            status={
                              selectedDeviceId === "local"
                                ? undefined
                                : (selectedDevice?.status ?? "offline")
                            }
                          />
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent position="popper" className="w-(--radix-select-trigger-width)">
                        <SelectItem value="local" data-device-id="local" className={DEVICE_ITEM}>
                          <DeviceOption label={msg("thisComputer")} />
                        </SelectItem>
                        {devices.map((device) => (
                          <SelectItem
                            key={device.id}
                            value={device.id}
                            data-device-id={device.id}
                            className={DEVICE_ITEM}
                          >
                            <DeviceOption label={device.label} status={device.status} />
                          </SelectItem>
                        ))}
                        {onAddDevice ? (
                          <>
                            <SelectSeparator />
                            <SelectItem value="add-device">
                              <Plus className="text-foreground-subtle" />
                              {msg("addRemoteDevice")}
                            </SelectItem>
                          </>
                        ) : null}
                      </SelectContent>
                    </Select>
                    {/* 旧入口是一行 ghost 文字，用户看不出可点也不知用途；改为挨着设备的问句 + 下划线链接。 */}
                    {remote && selectedDevice && onBrowseExisting ? (
                      <p className="flex flex-wrap items-center gap-x-1 text-ui-sm text-foreground-subtle">
                        {msg("existingOnDeviceHint")}
                        <button
                          ref={existingButton}
                          type="button"
                          disabled={busy || Boolean(created)}
                          data-testid="virtual-project-existing"
                          className="inline-flex items-center gap-0.5 rounded-sm text-brand underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50"
                          onClick={() => void browseExisting()}
                        >
                          {msg("existingOnDeviceAction")}
                          <ChevronRight className="size-3.5" />
                        </button>
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <fieldset disabled={busy || Boolean(created)} className="min-w-0">
                  <legend className={`mb-1.5 ${FIELD_LABEL}`}>{msg("folders")}</legend>
                  {/* 有目录时使用同一列表的末行添加，只有零目录才展示空态大卡片。 */}
                  <div
                    data-testid={roots.length ? "virtual-project-roots" : undefined}
                    className={
                      roots.length
                        ? "min-w-0 overflow-hidden rounded-lg border border-border divide-y divide-border"
                        : undefined
                    }
                  >
                    {roots.map((root) => (
                      <div
                        className="flex min-h-12 min-w-0 items-center gap-2 px-3 py-2"
                        key={root}
                        data-testid="virtual-project-root-row"
                      >
                        <Folder className="size-4 shrink-0 text-foreground-subtle" />
                        <span
                          className={
                            fixedFolder
                              ? "min-w-0 flex-1 break-all text-ui-base"
                              : "min-w-0 flex-1 truncate text-ui-base"
                          }
                          title={root}
                          data-testid="virtual-project-root-name"
                        >
                          {fixedFolder ? root : getPathLeaf(root)}
                        </span>
                        {root === primary ? (
                          <span
                            data-testid="virtual-project-primary"
                            className="inline-flex h-7 shrink-0 items-center rounded-md border border-border px-2 text-ui-base text-foreground-subtle"
                          >
                            {msg("primaryBadge")}
                          </span>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-foreground-subtle"
                            data-testid="virtual-project-set-primary"
                            onClick={() => setPrimary(root)}
                          >
                            {msg("setPrimary")}
                          </Button>
                        )}
                        {!fixedFolder && (!remote || !project) ? (
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            className="text-foreground-subtle"
                            data-testid="virtual-project-remove-folder"
                            aria-label={msg("removeFolder")}
                            onClick={() => {
                              const next = roots.filter((item) => item !== root);
                              setRoots(next);
                              if (primary === root) setPrimary(next[0] ?? "");
                            }}
                          >
                            <X className="size-4" />
                          </Button>
                        ) : null}
                      </div>
                    ))}
                    {!fixedFolder && (!remote || !project) ? (
                      <button
                        type="button"
                        data-testid="virtual-project-browse"
                        aria-label={msg(needsConnection ? "connectAndBrowse" : "browse")}
                        className={`group flex w-full items-center gap-2 text-ui-base transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30 ${roots.length ? "min-h-12 px-3 py-2 text-left" : "min-h-32 flex-col justify-center rounded-lg border border-dashed border-border px-4 py-5 text-center hover:border-border-hover"}`}
                        onClick={() => {
                          void browse();
                        }}
                      >
                        {roots.length ? (
                          <>
                            <FolderPlus className="size-4 shrink-0 text-foreground-subtle" />
                            <span>
                              {msg(needsConnection ? "connectAndBrowse" : "addSourceFolder")}
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="flex size-9 items-center justify-center rounded-full bg-surface text-foreground-subtle group-hover:text-foreground">
                              <FolderPlus className="size-4" />
                            </span>
                            <span className="font-medium">
                              {msg(needsConnection ? "connectAndBrowse" : "browse")}
                            </span>
                            <span className="text-ui-sm text-foreground-subtle">
                              {needsConnection
                                ? intl.formatMessage(
                                    { id: "project.connectAndBrowseHint" },
                                    {
                                      status: msg(
                                        `deviceStatus.${selectedDevice?.status ?? "offline"}`,
                                      ),
                                    },
                                  )
                                : msg("browseHint")}
                            </span>
                          </>
                        )}
                      </button>
                    ) : null}
                  </div>
                </fieldset>
                {legacyDeviceId === hostId ? (
                  <p className="text-ui-sm text-foreground-subtle">
                    {msg("legacyUpgradeRequired")}
                  </p>
                ) : null}
                {error ? (
                  <p role="alert" className="text-ui-sm text-destructive">
                    {error}
                  </p>
                ) : null}
                <DialogFooter className="flex-row flex-wrap items-center justify-end">
                  {project ? (
                    <Button
                      variant="ghost"
                      data-testid="virtual-project-editor-delete"
                      disabled={busy || Boolean(created)}
                      onClick={() => {
                        void remove();
                      }}
                      className="mr-auto bg-destructive-surface text-destructive-surface-foreground hover:bg-destructive-surface hover:text-destructive-surface-foreground"
                    >
                      {msg("delete")}
                    </Button>
                  ) : null}
                  <Button variant="ghost" onClick={onClose} disabled={busy && !fixedFolder}>
                    {msg("cancel")}
                  </Button>
                  <Button
                    ref={saveButton}
                    data-testid="virtual-project-save"
                    onClick={() => {
                      void save();
                    }}
                    disabled={busy || (remote && (roots.length !== 1 || legacyDeviceId === hostId))}
                  >
                    {project ? msg("save") : msg("create")}
                  </Button>
                </DialogFooter>
              </>
            )}
          </>
        )}
        {/* 确认框须留在父弹层的 React 树内；兄弟节点的触摸取消会被延迟判为外部点击，连带关闭草稿。 */}
        {folderTrust && !suspended ? (
          <ProjectFolderTrustDialog
            request={folderTrust}
            onClosed={() => {
              if (alive.current && !suspendedRef.current) saveButton.current?.focus();
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
