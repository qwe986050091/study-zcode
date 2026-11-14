// ===== 文件级深注（仅新增整行注释，未改动任何代码）=====
// 读法：每条 INV 给出「不变量 / 守卫位置 / 被破坏后的具体故障」，改代码前逐条对号。
// INV-01 键空间隔离：v4 草稿只写 zcode-v4-composer-drafts:v1: 与 project-drafts 前缀（守卫：STORAGE_KEY_PREFIX 与 draftStorageKey；混写旧键会被旧 janitor 清掉正文）
// INV-02 只有非空白 text 才落盘，删空即整 scope 移除（守卫：readDraft 首行与 persist 的 trim 分支；否则刷新后出现无法提交的空草稿）
// INV-03 scope 键是 clientNamespace/hostId/projectId 三段 JSON 数组（守卫：composerScopeKey；改成字符串拼接会在含冒号的项目 id 上撞键）
// INV-04 草稿态固定为 __draft__，正式会话用 sessionId（守卫：V4_DRAFT_SCOPE_ROOT 与 draftStorageKey；混用会让未提交草稿被会话草稿覆盖）
// INV-05 新建草稿按 project 归属隔离，正式会话仍按工作区隔离（守卫：draftStorageKey 的三元分支；同目录多项目会互相串正文）
// INV-06 hostId 解析不出时回落身份原文，完全没有身份才用 local（守卫：resolveComposerScope；回落成 local 会让远端草稿挂到本机）
// INV-07 读取阶段只做过滤不做物理清理（守卫：readDraftFile 末尾注释与 writeDraftFile；在 render 里写盘会触发 React 更新循环）
// INV-08 无法解析或版本不符必须返回空文件而非抛错（守卫：readDraftFile 的 try 与 version 判断；抛错会让整个 Composer 白屏）
// INV-09 legacyClaimed 置真后不再回读旧目录草稿（守卫：readV4ComposerDraft 的取反判断与两处置位；否则换目录后旧正文复活）
// INV-10 旧目录认领必须 projectId 严格相等（守卫：readV4ComposerDraft 的 legacy 比较；仅按目录猜项目会认领到别的项目）
// INV-11 pending task 草稿的 draftId 必须是 UUID（守卫：readPendingTaskDraft 的正则；脏 id 会让 Host 侧建任务永久失败）
// INV-12 存储不可用时写 pending 草稿直接抛错，不静默降级（守卫：writePendingTaskDraft 的判空；静默会先配目录再丢草稿入口）
// INV-13 同一 draft 已有 commandId 时不允许换 command（守卫：markPendingTaskDraftCommand 的 throw；覆盖会让上一笔提交无法回收）
// INV-14 撤销 command 只清 commandId/sessionId，保留 workspacePath（守卫：releasePendingTaskDraftCommand 的重建对象；清掉路径后重试找不到目录）
// INV-15 正文或模型单独更新时不得抹掉 projectId/taskGroupId（守卫：persist 的 savedGroupId/savedProjectId 合并；否则切模型丢项目归属）
// INV-16 非草稿态的会话草稿不保留组织态副本（守卫：persist 的 delete next.projectId/taskGroupId；promotion 后以 Host 为准，避免双写漂移）
// INV-17 mode 合法但值为 plan 时归一成 build 并回填 planEnabled（守卫：readDraft 的 mode 展开；旧 plan 值会让新面板状态错位）
// INV-18 modelSelection 校验失败时退回 providerId/modelId 最小身份（守卫：readDraft 的 identity 分支；整条丢弃会静默退回默认模型）
// INV-19 mention 只接受白名单 category 且五个文本字段齐备（守卫：readDraft 的 hasMention；脏 mention 会让 Lexical 预填抛异常）
// INV-20 写盘前比对序列化结果，相同即跳过；空文件用 removeItem（守卫：writeDraftFile；无变更写盘会放大配额占用与跨标签页事件）
// composer parity：v4 composer 的 per-session 草稿持久化（新做，轻量 localStorage）。
//
// 旧草稿面（zcodeSessionStore composerDraftByScopeId + chatComposerDraftStorage 写路径）
// 已随 store 收尾删除；本模块是 v4 侧替代——键空间独立（v4 前缀），不与旧键互写，
// 旧键清理仍归 chatComposerDraftStorage 的 janitor。
// 语义：scope = sessionId（draft 态 = "__draft__"）；保存 text + editorStateJson，外部预填在
// Lexical 尚未挂载时额外保存 mention（保证重挂载不降级为纯文本）。
// 仅有非空白正文才持久化；mode/modelSelection 随正文保存，删空后删除整个 scope。
// 附件不入草稿（objectUrl/File 不可序列化，localPath 附件重启后归属难校验——
// 与「v4 composer 不做附件草稿持久化」的裁决一致）。
import { logger } from "@/logger.js";
import {
  modelSelectionSchema,
  remoteHostIdFromWorkspaceIdentity,
  type ModelSelection,
} from "@zcode/shared";
import { submissionModeSchema, type SubmissionMode } from "@zcode/shared/zcode-protocol-v4";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";

export interface V4ComposerDraft {
  text: string;
  /** 未提交草稿的组织意图；真实任务归属始终由 Host 管理。 */
  projectId?: string | null;
  taskGroupId?: string | null;
  editorStateJson?: string;
  mention?: ComposerMentionPrefill;
  /** 有合法 mode 表示已经初始化；没有模型仍是明确空态，不能按旧文本草稿补默认。 */
  mode?: SubmissionMode;
  planEnabled?: boolean;
  modelSelection?: ModelSelection;
  updatedAt: number;
}

interface V4DraftFile {
  version: 1;
  legacyClaimed?: boolean;
  scopes: Record<string, V4ComposerDraft>;
}

// [资源] 单一前缀承载所有工作区的草稿文件，键数量随打开过的工作区线性增长
// 前缀内嵌 :v1: 版本段，结构升级时换段而不是原地迁移，避免读到旧形状
// 该常量只被 getV4ComposerDraftStorageKey 消费；改动必须同步 project-drafts 前缀
// 失败模式：两处前缀不一致会把同一草稿写成两份，而读路径只认其中一份
const STORAGE_KEY_PREFIX = "zcode-v4-composer-drafts:v1:";
export interface ComposerScope {
  clientNamespace: string;
  hostId: string;
  projectId: string | null;
}

// [并发] 纯函数、不读存储，可在 render 期安全重复调用，不会引入额外副作用
// 用 JSON 数组序列化而不是拼接，id 里出现逗号或冒号也不会产生歧义
// 改动分隔方式会让历史项目草稿全部失配，表现为新建草稿刷新后消失
export function composerScopeKey(scope: ComposerScope): string {
  return JSON.stringify([scope.clientNamespace, scope.hostId, scope.projectId]);
}

export interface PendingTaskDraft {
  draftId: string;
  workspacePath?: string;
  commandId?: string;
  sessionId?: string | null;
}

// [资源] pending task 键与正文草稿键分属不同前缀，互不覆盖、可独立清理
// 键内嵌 scope 键，因此同一 host 下不同项目的未提交任务天然隔离
function pendingTaskKey(scope: ComposerScope): string {
  return `zcode-pending-task-draft:v1:${composerScopeKey(scope)}`;
}
// [失败路径] 解析异常或任一字段类型不符都降级成 null，绝不向上抛错
// draftId 用 UUID 正则校验，防止被手改成时间戳后 Host 侧无法建任务
// workspacePath/commandId/sessionId 允许缺省，但一旦存在必须是字符串
// 返回的是解析后的新对象，调用方按只读使用，写回统一走 writePendingTaskDraft
export function readPendingTaskDraft(scope: ComposerScope): PendingTaskDraft | null {
  try {
    const raw = getStorage()?.getItem(pendingTaskKey(scope));
    const value = raw ? JSON.parse(raw) : null;
    return value &&
      typeof value.draftId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.draftId) &&
      (value.workspacePath === undefined || typeof value.workspacePath === "string") &&
      (value.commandId === undefined || typeof value.commandId === "string") &&
      (value.sessionId == null || typeof value.sessionId === "string")
      ? value
      : null;
  } catch {
    return null;
  }
}
// [资源] 存储不可用时直接抛错：此刻分配 draftId 却存不下，刷新就丢草稿入口
// 值为 null 时走 removeItem，避免留下字面 null 字符串被后续解析读成空值
// 与正文草稿不同，这里不做配额降级，因为 pending id 丢失会导致重复建任务
// 失败模式：抛错未被上层捕获时，表现为新建按钮点击后无任何反应
function writePendingTaskDraft(scope: ComposerScope, value: PendingTaskDraft | null): void {
  const storage = getStorage();
  // 未保存身份时不得先分配目录，否则刷新又会失去草稿入口。
  if (!storage) throw new Error("composer.draft-storage-unavailable");
  if (value) storage.setItem(pendingTaskKey(scope), JSON.stringify(value));
  else storage.removeItem(pendingTaskKey(scope));
}
// [并发] 读后写不是原子操作，两个标签页同时初始化可能各生成一个 draftId
// 冲突窗口靠「新建按钮单次点击」这一交互约束兜底，未引入额外的锁或版本号
// 已有草稿直接复用，保证刷新前后 draftId 稳定、Host 侧任务可以续接
export function ensurePendingTaskDraft(scope: ComposerScope): PendingTaskDraft {
  const current = readPendingTaskDraft(scope);
  if (current) return current;
  const next = { draftId: crypto.randomUUID() };
  writePendingTaskDraft(scope, next);
  return next;
}
export function bindPendingTaskDraft(
  scope: ComposerScope,
  draftId: string,
  workspacePath: string,
): void {
  const current = readPendingTaskDraft(scope);
  if (current?.draftId === draftId && current.workspacePath !== workspacePath)
    writePendingTaskDraft(scope, { ...current, workspacePath });
}
export function completePendingTaskDraft(scope: ComposerScope, draftId: string): void {
  if (readPendingTaskDraft(scope)?.draftId === draftId) writePendingTaskDraft(scope, null);
}
// [事务] 本段承载 pending 草稿状态机：生成 -> 绑定目录 -> 标记 command -> 撤销或完成
// 标记 command 是提交意图的落点，先写 commandId 再发请求，失败由 release 回滚
// 冲突时抛 draft-submission-pending，由上层转成「上一笔提交未完成」的提示
// 完成态直接删键；撤销态重建对象只保留 workspacePath，避免残留旧 command
export function markPendingTaskDraftCommand(
  scope: ComposerScope,
  draftId: string,
  commandId: string,
  sessionId: string | null,
): void {
  const current = readPendingTaskDraft(scope);
  if (current?.draftId !== draftId) return;
  if (current.commandId && current.commandId !== commandId)
    throw new Error("composer.draft-submission-pending");
  writePendingTaskDraft(scope, { ...current, commandId, sessionId });
}
export function releasePendingTaskDraftCommand(
  scope: ComposerScope,
  draftId: string,
  commandId: string,
): void {
  const current = readPendingTaskDraft(scope);
  if (current?.draftId !== draftId || current.commandId !== commandId) return;
  writePendingTaskDraft(scope, { draftId, workspacePath: current.workspacePath });
}

// [权衡] projectId 允许为空表示「未归类」，空态与具体项目在键空间里必须可区分
// hostId 优先取远端身份里的主机段，解析不出才用身份原文，最后才回落 local
// 改动 hostId 判定会让同一工作区的草稿在本地与远端之间整体漂移
export function resolveComposerScope(
  projectId: string | null | undefined,
  workspaceIdentity?: string,
  clientNamespace = "desktop",
): ComposerScope {
  return {
    clientNamespace,
    hostId: workspaceIdentity
      ? (remoteHostIdFromWorkspaceIdentity(workspaceIdentity) ?? workspaceIdentity)
      : "local",
    projectId: projectId ?? null,
  };
}

function workspaceScopeKey(
  path: string,
  identity: string | undefined,
  clientNamespace: string,
): string {
  return `zcode-composer-workspace-scope:v1:${JSON.stringify([clientNamespace, identity?.trim() || path])}`;
}
// [失败路径] 记忆失败只告警不抛错：导航身份是加速信息，不是正确性前提
// 键优先用去空白的 identity，其次才用目录，避免同一路径在不同主机间共用
// 写入的是整个 scope 快照，读取端会逐字段校验，因此这里不必预校验
export function rememberComposerWorkspaceScope(
  path: string,
  identity: string | undefined,
  scope: ComposerScope,
): void {
  try {
    getStorage()?.setItem(
      workspaceScopeKey(path, identity, scope.clientNamespace),
      JSON.stringify(scope),
    );
  } catch (error) {
    warnStorageFailure(workspaceScopeKey(path, identity, scope.clientNamespace), error);
  }
}
// [失败路径] 旧记录可能缺 clientNamespace 或 hostId，校验不过就返回 undefined
// hostId 用同一解析函数比对，保证写入与读取对「远端身份」的理解一致
// projectId 只接受 null 或字符串，其他形状视为损坏，让上层回落默认项目
export function readComposerWorkspaceScope(
  path: string,
  identity: string | undefined,
  clientNamespace = "desktop",
): ComposerScope | undefined {
  try {
    const raw = getStorage()?.getItem(workspaceScopeKey(path, identity, clientNamespace));
    const value = raw ? JSON.parse(raw) : null;
    if (
      value?.clientNamespace === clientNamespace &&
      value.hostId === resolveComposerScope(null, identity, clientNamespace).hostId &&
      (value.projectId === null || typeof value.projectId === "string")
    )
      return value;
  } catch {
    /* 旧版没有导航身份，不能从目录猜项目。 */
  }
  return undefined;
}

// [权衡] 同一目录可属于多个项目：草稿态按项目隔离，正式会话仍按工作区隔离
// 只有草稿态且带 scope 时才走 project 前缀，其余情况一律落到工作区前缀
// 混用两种键会让「新建草稿」在切换项目后读到别的项目正文，且难以复现
// 这里不做旧键回退，回退与认领逻辑集中在 readV4ComposerDraft 的分支里
function draftStorageKey(
  path: string,
  identity: string | undefined,
  scopeId: string,
  scope?: ComposerScope,
): string {
  // 同目录可以属于多个项目；新建草稿按组织归属隔离，正式 session 仍按工作区隔离。
  return scopeId === V4_DRAFT_SCOPE_ROOT && scope
    ? `zcode-v4-composer-project-drafts:v1:${composerScopeKey(scope)}`
    : getV4ComposerDraftStorageKey(path, identity);
}
export const V4_DRAFT_SCOPE_ROOT = "__draft__";
const warnedStorageKeys = new Set<string>();

// [资源] 同一键只告警一次，避免配额持续失败时把日志刷爆并掩盖其他错误
// 用 Set 做进程内去重，页面刷新后重新计数，这个代价可以接受
// 成功写盘时 delete 该键，使恢复之后再次失败仍然能被观测到
function warnStorageFailure(key: string, error: unknown) {
  if (warnedStorageKeys.has(key)) return;
  warnedStorageKeys.add(key);
  logger.warn("[v4-composer-draft] 草稿持久化访问失败", {
    error: error instanceof Error ? error.message : String(error),
    key,
  });
}

// [资源] SSR 或测试环境没有 window，统一返回 null 由上层按不持久化降级
// 访问 localStorage 属性本身也可能抛错（隐私模式），因此再包一层 try
function getStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// [权衡] 工作区键优先用 identity，其次用路径，两段都做 encodeURIComponent
// 路径含分号等特殊字符时仍能安全进键；不用哈希是为了可读与现场排查
export function getV4ComposerDraftStorageKey(
  workspacePath: string,
  workspaceIdentity?: string,
): string {
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(workspaceKey)}`;
}

// [失败路径] 顶层非对象、version 不为 1、scopes 非对象，任一不满足即返回空文件
// 逐条走 readDraft 过滤坏 scope，单个损坏草稿不会带走同文件里的其他草稿
// legacyClaimed 仅在显式为 true 时保留，其余一律视为尚未认领旧目录
// [资源] 读取路径绝不写盘：render 期调用只做内存过滤，副作用留给显式写入
function readDraftFile(key: string): V4DraftFile {
  const storage = getStorage();
  try {
    const raw = storage?.getItem(key);
    if (!raw) return { version: 1, scopes: {} };
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.scopes)) {
      return { version: 1, scopes: {} };
    }
    const scopes = Object.fromEntries(
      Object.entries(parsed.scopes).flatMap(([scopeId, value]) => {
        const draft = readDraft(value);
        return draft ? [[scopeId, draft]] : [];
      }),
    );
    const file: V4DraftFile = {
      version: 1,
      scopes,
      ...(parsed.legacyClaimed === true ? { legacyClaimed: true } : {}),
    };
    // 读取可发生在 React render；旧空记录只过滤，物理清理由明确写入负责。
    return file;
  } catch (error) {
    warnStorageFailure(key, error);
    return { version: 1, scopes: {} };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// [失败路径] text 非字符串或纯空白直接判废，这是「空草稿不持久化」的读取侧守卫
// mode 走 schema 校验，非法值丢弃而不是猜默认，避免把坏数据洗成合法态
// 模型身份两级回退：完整 selection 优先，其次只取 providerId 与 modelId
// mention 要求五个文本字段加 category 白名单，防止脏预填进入 Lexical
// updatedAt 只接受有限数字，NaN 与 Infinity 归零，保证排序比较稳定
function readDraft(value: unknown): V4ComposerDraft | null {
  if (!isRecord(value) || typeof value.text !== "string" || !value.text.trim()) return null;
  const mode = submissionModeSchema.safeParse(value.mode);
  const selection = modelSelectionSchema.safeParse(value.modelSelection);
  // 坏 options 不应连带丢掉可确定的模型身份；不读取旧 provider/model/thought 别名。
  const identity = isRecord(value.modelSelection)
    ? modelSelectionSchema.safeParse({
        providerId: value.modelSelection.providerId,
        modelId: value.modelSelection.modelId,
      })
    : null;
  const modelSelection = selection.success
    ? selection.data
    : identity?.success
      ? identity.data
      : undefined;
  const mention = value.mention;
  const hasMention =
    isRecord(mention) &&
    ["id", "category", "label", "value", "markdown"].every(
      (key) => typeof mention[key] === "string",
    ) &&
    ["files", "skills", "commands", "subagents", "whiteboards", "sessions", "plugins"].includes(
      String(mention.category),
    );
  return {
    text: value.text,
    ...(value.taskGroupId === null || typeof value.taskGroupId === "string"
      ? { taskGroupId: value.taskGroupId as string | null }
      : {}),
    ...(value.projectId === null || (typeof value.projectId === "string" && value.projectId.trim())
      ? { projectId: value.projectId as string | null }
      : {}),
    ...(typeof value.editorStateJson === "string"
      ? { editorStateJson: value.editorStateJson }
      : {}),
    ...(hasMention ? { mention: mention as unknown as ComposerMentionPrefill } : {}),
    ...(mode.success ? { mode: mode.data === "plan" ? ("build" as const) : mode.data } : {}),
    ...(typeof value.planEnabled === "boolean"
      ? { planEnabled: value.planEnabled }
      : mode.success
        ? { planEnabled: mode.data === "plan" }
        : {}),
    ...(modelSelection ? { modelSelection } : {}),
    updatedAt:
      typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  };
}

// [事务] 序列化结果与磁盘现值相同即返回 true，跳过写盘与跨标签页 storage 事件
// scopes 为空且未认领旧目录时序列化为 null，走 removeItem 清理空壳键
// [失败路径] 配额或隐私模式异常只记一次告警并返回 false，输入流程不受影响
// 写成功清除告警去重标记，使后续故障仍可观测
// 返回布尔值交由调用方决定是否提示；当前调用方选择不阻塞输入
function writeDraftFile(key: string, file: V4DraftFile) {
  const storage = getStorage();
  if (!storage) {
    return false;
  }
  try {
    const serialized =
      Object.keys(file.scopes).length || file.legacyClaimed ? JSON.stringify(file) : null;
    if (storage.getItem(key) === serialized) return true;
    if (serialized === null) storage.removeItem(key);
    else storage.setItem(key, serialized);
    warnedStorageKeys.delete(key);
    return true;
  } catch (error) {
    // 配额/隐私模式失败只降级为不持久化，不影响输入。
    warnStorageFailure(key, error);
    return false;
  }
}

// [事务] 先读当前键；未命中且未认领时才尝试旧工作区键
// 旧键认领要求 projectId 严格相等，未归类历史不会被最近目录猜走
// 命中旧键只返回内容，不迁移不写回，迁移由后续显式写入完成
// [权衡] 这里容忍一次额外解析，换取切换项目时旧正文不丢
export function readV4ComposerDraft(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  scopeId: string,
  scope?: ComposerScope,
): V4ComposerDraft | null {
  const key = draftStorageKey(workspacePath, workspaceIdentity, scopeId, scope);
  const file = readDraftFile(key);
  const draft = file.scopes[scopeId];
  if (!draft || typeof draft.text !== "string") {
    // 旧记录只有显式项目归属才能认领；未归类历史不能靠最近目录猜测。
    if (!file.legacyClaimed && scopeId === V4_DRAFT_SCOPE_ROOT && scope?.projectId) {
      const legacy = readDraftFile(getV4ComposerDraftStorageKey(workspacePath, workspaceIdentity))
        .scopes[scopeId];
      if (legacy?.projectId === scope.projectId) return legacy;
    }
    return null;
  }
  return draft;
}

// [事务] 读-改-写整体在一次 localStorage 往返内完成，中间没有锁
// 合并策略：本次未提供 projectId/taskGroupId 时沿用已存值，显式 null 才清除
// 非草稿态强制剔除组织态字段，promotion 之后归属以 Host 查询为准
// 正文为空白时删除 scope，而不是写入空记录，避免留下无法提交的壳
// 认领条件包含「曾经有草稿、现在有草稿、旧键项目匹配」三种，任一成立即置位
// [失败路径] 写盘失败返回 false，此时内存态已更新，调用方需容忍刷新后回退
export function persistV4ComposerDraft(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  scopeId: string,
  draft: Omit<V4ComposerDraft, "updatedAt">,
  scope?: ComposerScope,
) {
  const key = draftStorageKey(workspacePath, workspaceIdentity, scopeId, scope);
  const file = readDraftFile(key);
  const hadDraft = Boolean(file.scopes[scopeId]);
  // 正文/模型各自更新草稿时不能抹掉项目意图；显式新建传 null 才清除项目归属。
  const savedGroupId = file.scopes[scopeId]?.taskGroupId;
  const savedProjectId = file.scopes[scopeId]?.projectId;
  const next = {
    ...draft,
    ...(draft.taskGroupId === undefined && savedGroupId !== undefined
      ? { taskGroupId: savedGroupId }
      : {}),
    ...(draft.projectId === undefined && savedProjectId !== undefined
      ? { projectId: savedProjectId }
      : {}),
  };
  // promotion 以后任务归属由 Host 查询；浏览器 Session 草稿不保留组织态副本。
  if (scopeId !== V4_DRAFT_SCOPE_ROOT) {
    delete next.projectId;
    delete next.taskGroupId;
  }
  // 空白页配置只留在 Composer 内存；不存在记录时也不执行无意义写盘。
  if (!next.text.trim()) {
    delete file.scopes[scopeId];
  } else {
    file.scopes[scopeId] = { ...next, updatedAt: Date.now() };
  }
  // 新 key 首次写入即结束旧目录认领；保留旧数据，避免删除失败或换目录后复活正文。
  if (
    scopeId === V4_DRAFT_SCOPE_ROOT &&
    scope?.projectId &&
    (hadDraft ||
      Boolean(file.scopes[scopeId]) ||
      readDraftFile(getV4ComposerDraftStorageKey(workspacePath, workspaceIdentity)).scopes[scopeId]
        ?.projectId === scope.projectId)
  )
    file.legacyClaimed = true;
  return writeDraftFile(key, file);
}

/** 旧版关闭分组草稿只撤销 placement；不能连带清空正在编辑的正文和项目。 */
// [事务] 只删 taskGroupId 后按项目键写回，不触碰正文，也不修改同目录其他项目
// 无草稿或无分组时直接返回 true，避免产生无意义的写盘与失败告警
export function clearV4ComposerDraftTaskGroup(
  workspacePath: string,
  workspaceIdentity?: string,
  scope?: ComposerScope,
) {
  const key = draftStorageKey(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT, scope);
  const file = readDraftFile(key);
  const draft = readV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT, scope);
  if (!draft || draft.taskGroupId === undefined) return true;
  // 分组只是草稿的组织意图；关闭时必须沿用项目 key，不能修改同目录的其他项目。
  delete draft.taskGroupId;
  file.scopes[V4_DRAFT_SCOPE_ROOT] = draft;
  if (scope?.projectId) file.legacyClaimed = true;
  return writeDraftFile(key, file);
}

// [事务] 删除 scope 前先记录 hadDraft，用于决定是否需要置 legacyClaimed
// 与 persist 共用认领判定：删除也必须结束旧目录认领，否则刷新后旧正文复活
export function clearV4ComposerDraft(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  scopeId: string,
  scope?: ComposerScope,
) {
  const key = draftStorageKey(workspacePath, workspaceIdentity, scopeId, scope);
  const file = readDraftFile(key);
  const hadDraft = Boolean(file.scopes[scopeId]);
  delete file.scopes[scopeId];
  // 新 key 首次写入即结束旧目录认领；保留旧数据，避免删除失败或换目录后复活正文。
  if (
    scopeId === V4_DRAFT_SCOPE_ROOT &&
    scope?.projectId &&
    (hadDraft ||
      Boolean(file.scopes[scopeId]) ||
      readDraftFile(getV4ComposerDraftStorageKey(workspacePath, workspaceIdentity)).scopes[scopeId]
        ?.projectId === scope.projectId)
  )
    file.legacyClaimed = true;
  return writeDraftFile(key, file);
}
