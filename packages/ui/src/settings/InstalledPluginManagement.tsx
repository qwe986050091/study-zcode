/* eslint-disable max-lines -- 已安装插件列表与详情弹窗共享组件分组/Hook 明细渲染，集中维护更利于与参考图保持一致。 */
// 文件职责：已安装插件详情（Dialog + Panel + 组件/诊断/hook 明细）的纯展示层，只做展示投影与用户意图上抛，不持有插件事实。
// 事实来源：plugin / diagnostics / activeOperations / updateStatus / installedAt 全部由外部传入，本文件不发起 IPC、不读 store、不写缓存。
// 交互边界：更新、卸载、保存配置一律以 onRequest* 上抛；确认弹窗、权限校验、串行化与失败提示属于调用方和会话层。
//
// INV 不变量表（每一条都由「本文件只读入参」这一设计维持，改动前先确认破坏面）：
// INV-01 断言：plugin 为 null 时只渲染空态、不访问 plugin 任何字段 —— 守住它的位置：InstalledPluginDetailPanel 的 if (!plugin) 早返回 —— 改错故障：关闭弹窗或切换插件瞬间读 undefined，整块设置页白屏。
// INV-02 断言：空态仅表示「已选中插件为空」，列表加载中不得显示空态 —— 守住它的位置：调用方按 loading 决定是否传 plugin=null，本面板不自行推断 —— 改错故障：加载中被误判为空，用户看到假空态并重复安装。
// INV-03 断言：组件分组只由 buildInstalledPluginDisplayGroups(plugin) 派生，不留第二份副本 —— 守住它的位置：componentGroups 的 const 声明 —— 改错故障：插件启停后详情仍展示旧组件，与列表计数不一致。
// INV-04 断言：warning 区只收当前插件且 severity 为 warning 的诊断 —— 守住它的位置：pluginWarnings 的 filter 条件 —— 改错故障：混入其他插件或 error 级诊断，用户误判当前插件损坏。
// INV-05 断言：配置与 hook 折叠区仅在 hasAdvanced 为真时挂载 —— 守住它的位置：hasAdvanced 推导与 details 条件渲染 —— 改错故障：空折叠区常驻，或有配置的插件反而看不到配置入口。
// INV-06 断言：更新按钮是否禁用只取决于 plugin:update:<id> 是否在 activeOperations —— 守住它的位置：更新按钮的 disabled 表达式 —— 改错故障：进行中可重复点击，触发并发更新与版本回跳。
// INV-07 断言：卸载按钮是否禁用只取决于 plugin:uninstall:<id> —— 守住它的位置：卸载按钮的 disabled 表达式 —— 改错故障：卸载进行中重复提交，第二次在插件已删除后报错并污染列表。
// INV-08 断言：点击卸载只上抛 onRequestUninstall(plugin.id)，不直接调用服务 —— 守住它的位置：卸载按钮的 onClick —— 改错故障：绕过二次确认直接删除，用户失去反悔机会。
// INV-09 断言：卸载区要求 uninstallable 与 onRequestUninstall 同时成立 —— 守住它的位置：卸载区的条件渲染 —— 改错故障：内置或无权限插件也出现卸载入口，点击后静默无响应。
// INV-10 断言：任何操作失败都不得清空或替换已展示的 plugin —— 守住它的位置：本文件全程只读入参、不回写 store —— 改错故障：卸载失败后详情变空态，用户既无法重试也不知剩余状态。
// INV-11 断言：全部文案走 intl.formatMessage 且 id 稳定 —— 守住它的位置：每处 intl.formatMessage 调用 —— 改错故障：硬编码文案混入，其他语言环境出现中英混排。
// INV-12 断言：hookDetails 为空时展示 none 空态而不是隐藏整块 —— 守住它的位置：PluginHookDetails 的三元分支 —— 改错故障：解析失败被静默成「没有 hook」，用户失去排查线索。
//
// 渲染契约：详情面板是受控展示组件，open 与 plugin 由父级同时决定；本文件不做「先渲染后校验」的兜底。
// 空态契约：detail.empty 只对应 plugin 为空，不承担「加载中」「加载失败」两种语义。
// 诊断契约：diagnostics 是 store 聚合结果，面板只过滤不修改，展示顺序保持 CLI 下发顺序。
//
// 布局：外层限高 calc(100vh-3rem) 并内部滚动，标题区固定视觉锚点，长列表不撑破 DialogContent。
// 国际化：日期与版本号由调用方格式化后传入，本文件只做字符串拼接，避免二次本地化。
// 可访问性：状态徽标用文字而非纯色表达，图标统一 aria-hidden，折叠区用原生 details 保留键盘语义。
//
// 阅读顺序：先看 PluginOptionValueGetter 契约，再看 Dialog 与 Panel 的透传，最后看诊断与 hook 明细。
// 修改提示：新增展示项优先复用 DetailSection 与 PluginDetailRow，避免再引入一套间距与字号。
// 已知权衡：把明细与配置折叠进 details，牺牲首屏信息量换取长弹窗可控高度。
//
import type { ReactNode } from "react";
import { AlertTriangle, Cable, ChevronRight, Trash2 } from "lucide-react";
import type {
  ZCodePluginDiagnostic,
  ZCodePluginInfo,
  ZCodePluginScope,
  ZCodePluginUserConfigOption,
} from "@zcode/shared";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PluginConfigControls } from "@/settings/PluginConfigControls.js";
import { PluginComponentGroups } from "@/settings/PluginComponentGroups.js";
import { buildInstalledPluginDisplayGroups } from "@/settings/pluginManagedResourceGroups.js";
import { isPluginUpdatePending } from "@/settings/pluginStoreListing.js";

// [契约] 取值器的唯一职责：把 (plugin, key, option) 映射为受控输入可显示的原值，不做默认值填充。
// 返回值限定 string | number | boolean，布尔与数字在 UI 层按原类型渲染，避免字符串化后保存回写漂移。
// 调用方保证 key 属于 plugin.userConfig，取值器不再做存在性兜底。
// 若未来支持数组或对象配置，必须同时扩展该联合类型，禁止在此处用 JSON 字符串绕过类型。
export type PluginOptionValueGetter = (
  plugin: ZCodePluginInfo,
  key: string,
  option: ZCodePluginUserConfigOption,
) => string | number | boolean;

// [契约] Dialog 只负责「开合」与把入参原样透传给 Panel，不在这里做数据裁剪或权限判断。
// 因此在 Dialog 层新增逻辑会同时影响桌面与 Web 两端的详情行为，改动需回到 Panel 统一处理。
// onOpenChange 直接交给 Radix 语义处理，外部若需拦截关闭（例如操作进行中）应在父级包装。
export function InstalledPluginDetailDialog({
  diagnostics,
  getPluginOptionValue,
  configScope,
  installedAt,
  latestVersion,
  onOpenChange,
  onRequestUninstall,
  onRequestUpdate,
  onSavePluginOptions,
  open,
  activeOperations,
  plugin,
  renderPluginSource,
  setPluginOptionDraft,
  uninstallable,
  updateStatus,
}: {
  // [资源] diagnostics 是整份插件列表的聚合数组，可能随列表规模增长，这里只透传引用、不做拷贝。
  // 真正的过滤下沉到 Panel 内的 pluginWarnings，避免 Dialog 每次重渲染都全量遍历。
  // 若后续改为按插件预分组，应保持入参语义不变，防止调用方同步修改。
  /** 插件管理 store 聚合的 list/overview 诊断；透传给面板展示当前插件自身的 warning。 */
  diagnostics?: ZCodePluginDiagnostic[];
  getPluginOptionValue: PluginOptionValueGetter;
  configScope: ZCodePluginScope;
  installedAt?: string;
  latestVersion?: string;
  onOpenChange: (open: boolean) => void;
  // [契约] onRequestUninstall 是「请求」而非「执行」：只传 pluginId，由父级弹出确认并调用服务。
  // 可选的原因是无权限或内置插件不应出现卸载入口，缺省即表示当前上下文不允许卸载。
  // 不要在实现里把 undefined 当成「直接执行」的隐式开关。
  onRequestUninstall?: (pluginId: string) => void;
  onRequestUpdate?: (pluginId: string) => void;
  onSavePluginOptions: (plugin: ZCodePluginInfo) => void;
  open: boolean;
  // [并发] activeOperations 是全局操作快照，用只读数组传入，本文件只做 some 查询、不修改。
  // 操作 id 采用 plugin:<action>:<pluginId> 的命名约定，按钮禁用判断依赖该约定保持一致。
  // 若命名变更而未同步本文件，按钮会失去禁用保护，因此约定需与 store 侧同批修改。
  activeOperations: ReadonlyArray<{ id: string }>;
  plugin: ZCodePluginInfo | null;
  renderPluginSource: (plugin: ZCodePluginInfo) => string;
  setPluginOptionDraft: (pluginId: string, key: string, value: string | number | boolean) => void;
  uninstallable?: boolean;
  // [事务] updateStatus 表达「相对已安装版本的差异」，不是持久化状态，刷新后由 store 重新推导。
  // "none" 与缺省都视为无需更新，仅 update-available 与 version-changed 会渲染更新区。
  // 本文件不缓存上一次的 updateStatus，避免版本回跳后仍展示过期的更新提示。
  updateStatus?: "none" | "update-available" | "version-changed";
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100vh-3rem)] w-[min(600px,calc(100vw-2rem))] max-w-none gap-0 overflow-hidden p-0"
        data-testid="plugin-settings-detail-dialog"
        data-plugin-id={plugin?.id}
      >
        <DialogTitle className="sr-only">{plugin?.name ?? ""}</DialogTitle>
        <InstalledPluginDetailPanel
          diagnostics={diagnostics}
          getPluginOptionValue={getPluginOptionValue}
          configScope={configScope}
          installedAt={installedAt}
          latestVersion={latestVersion}
          activeOperations={activeOperations}
          plugin={plugin}
          renderPluginSource={renderPluginSource}
          setPluginOptionDraft={setPluginOptionDraft}
          uninstallable={uninstallable}
          updateStatus={updateStatus}
          onRequestUninstall={onRequestUninstall}
          onRequestUpdate={onRequestUpdate}
          onSavePluginOptions={onSavePluginOptions}
        />
      </DialogContent>
    </Dialog>
  );
}

// [契约] Panel 是详情内容的唯一渲染入口，Dialog 与可能的嵌入式场景共用同一份实现。
// 入参 diagnostics 默认空数组，保证调用方漏传时仍能渲染而不是抛错。
// 所有写操作都以回调形式向上传递，Panel 自身保持无副作用，便于在多个宿主中复用。
// 若需要新增能力（例如启用切换），应新增回调而不是直接引入服务调用。
export function InstalledPluginDetailPanel({
  diagnostics = [],
  getPluginOptionValue,
  configScope,
  installedAt,
  latestVersion,
  onRequestUninstall,
  onRequestUpdate,
  onSavePluginOptions,
  activeOperations,
  plugin,
  renderPluginSource,
  setPluginOptionDraft,
  uninstallable,
  updateStatus,
}: {
  // [失败路径] 诊断是「安装成功但能力缺失」的唯一可见线索，过滤条件写错会让问题重新变成静默失败。
  // 只取 severity 为 warning 的项：error 级已由列表层拦截，重复展示会放大焦虑。
  // 展示顺序沿用 CLI 下发顺序，保证同一份诊断在不同端上读起来一致。
  /** 插件管理 store 聚合的 list/overview 诊断；面板只展示当前插件自身的 warning。 */
  diagnostics?: ZCodePluginDiagnostic[];
  getPluginOptionValue: PluginOptionValueGetter;
  configScope: ZCodePluginScope;
  installedAt?: string;
  latestVersion?: string;
  // [契约] 面板层的卸载回调与 Dialog 层同源，签名必须保持一致，否则二次确认会拿到错误 id。
  // `InstalledPluginManagement` 只把卸载回调绑到按钮，不判断插件是否可卸载。
  // 可卸载性由 uninstallable 独立表达，两者分离便于权限不足时单独降级。
  onRequestUninstall?: (pluginId: string) => void;
  onRequestUpdate?: (pluginId: string) => void;
  onSavePluginOptions: (plugin: ZCodePluginInfo) => void;
  // [并发] 面板同时依赖 activeOperations 判断更新与卸载两条链路，二者互不阻塞。
  // 更新进行中仍允许卸载属于既有产品行为，若需互斥应在 store 侧串行化，而不是在 UI 里叠加条件。
  // 任何新增操作的禁用判断都必须复用同一份快照，避免出现两套进行中状态。
  activeOperations: ReadonlyArray<{ id: string }>;
  plugin: ZCodePluginInfo | null;
  renderPluginSource: (plugin: ZCodePluginInfo) => string;
  setPluginOptionDraft: (pluginId: string, key: string, value: string | number | boolean) => void;
  uninstallable?: boolean;
  // [权衡] 更新提示放在面板底部而非顶部，避免长内容把「立即更新」挤出可视区。
  // 代价是用户需要滚动才能看到更新入口，因此列表层仍需保留更新角标。
  // 若后续把更新改成强提醒，应调整信息层级而不是复制一份状态。
  updateStatus?: "none" | "update-available" | "version-changed";
}) {
  // [契约] 国际化实例在组件顶层获取，保证条件早返回与正文渲染使用同一份 locale。
  // 不在分支内再次调用 hook，避免条件调用破坏 hooks 顺序。
  // 文案 id 统一以 settings.plugins.detail 为前缀，便于翻译资源集中维护。
  const { intl } = useZCodeIntl();
  // [失败路径] plugin 为空只覆盖「未选中/已关闭」这一种情况，加载中不得走到这里。
  // 该早返回必须位于所有字段访问之前，否则关闭弹窗的动画帧里会读到 undefined。
  // 空态文案刻意保持中性，不写「加载失败」，以免把调用方的加载态误解为错误。
  // 调用方应以 loading 为准：加载中不渲染面板，避免假空态与重复操作。
  if (!plugin) {
    return (
      <div className="px-5 py-4 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.plugins.detail.empty" })}
      </div>
    );
  }

  // [契约] 组件分组全部由插件根目录的权威枚举结果派生，与启用状态无关。
  // 停用态 `status === "disabled"` 也渲染真实组件：让用户看到停用不等于卸载。
  // 空分组代表插件确实没有声明组件，而不是解析失败；解析失败会以 warning 诊断出现。
  // 因此这里不提供兜底分组，任何补数据都会掩盖 CLI 的权威结果。
  const componentGroups = buildInstalledPluginDisplayGroups(plugin);
  // [资源] hookDetails 在旧协议里可能缺省，这里统一折叠成空数组，后续渲染不再重复判空。
  // 该默认值只影响展示，不回写 plugin，避免把空数组当成真实配置持久化。
  // 若协议升级为必填，可删除这层折叠，但要同步检查 PluginHookDetails 的入参约束。
  const hookDetails = plugin.hookDetails ?? [];
  // Bugfix（静默失败）：插件 warning 诊断（如声明的技能路径扫描为空）此前在 UI 无任何
  // 渲染位置，用户看到「安装成功、启用生效、技能数 0」却无从排查。这里在详情面板
  // 直接列出该插件自身的 warning；正文直出 CLI 下发的 message（含具体路径）。
  // [失败路径] 只挑当前插件、且严重级别为 warning 的诊断，用于解释「装上了却没生效」。
  // 过滤条件同时校验 pluginId 与 severity，缺一项都会把无关噪音带进详情。
  // 诊断 message 由 CLI 生成并包含具体路径，UI 原样展示，不再二次拼接说明。
  // 空结果时不渲染 warning 区块，保持详情结构稳定。
  const pluginWarnings = diagnostics.filter(
    (diagnostic) => diagnostic.pluginId === plugin.id && diagnostic.severity === "warning",
  );
  // [权衡] hook 明细与用户配置共用「更多详情」折叠区，减少首屏层级。
  // 只要二者之一存在就展示折叠入口，避免分别判断造成入口闪烁。
  // 代价是配置入口不在首屏，新增高频配置时应考虑前移到主区块。
  const hasAdvanced = hookDetails.length > 0 || Object.keys(plugin.userConfig ?? {}).length > 0;
  // [契约] 来源标签由外部渲染函数给出，本文件不感知 marketplace 与本地路径的差异。
  // 先计算再渲染，保证同一帧内多次使用时结果一致，也不会因 locale 切换产生抖动。
  // 若来源需要可点击跳转，应扩展回调而不是在这里拼链接。
  const sourceLabel = renderPluginSource(plugin);

  // [契约] 正文根节点承担限高与滚动，Dialog 容器不再设置 overflow，避免双层滚动条。
  // 标题区、正文区、底部操作区共享同一滚动容器，长内容下操作按钮会随内容滚走。
  // 刻意取舍：详情页只读，`onUninstall` 需用户看完内容后手动触发。
  // 若改为吸底操作，需要同步修改 DialogContent 的高度计算。
  return (
    <div className="max-h-[calc(100vh-3rem)] overflow-y-auto text-ui-base text-foreground">
      <div className="border-b border-border px-5 pb-4 pt-5 pr-12">
        <div className="flex min-w-0 items-start gap-3">
          <div
            className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border text-foreground-subtle"
            aria-hidden="true"
          >
            <Cable className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="flex min-w-0 flex-wrap items-baseline gap-2 text-ui-base font-semibold text-foreground">
              <span className="min-w-0 truncate">{plugin.name}</span>
              {plugin.version ? (
                <span className="text-ui-xs font-normal text-foreground-subtle">
                  v{plugin.version}
                </span>
              ) : null}
            </h2>
            <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
              <Badge variant={plugin.enabled ? "secondary" : "outline"} className="rounded-md">
                {plugin.enabled
                  ? intl.formatMessage({
                      id: "settings.plugins.detail.enabled",
                    })
                  : intl.formatMessage({
                      id: "settings.plugins.detail.disabled",
                    })}
              </Badge>
              <Badge variant="outline" className="min-w-0 rounded-md">
                <span className="truncate">{sourceLabel}</span>
              </Badge>
            </div>
          </div>
        </div>
        {plugin.description ? (
          <p className="mt-3 leading-relaxed text-foreground-subtle">{plugin.description}</p>
        ) : null}
      </div>

      <div className="space-y-5 px-5 py-4">
        <DetailSection title={intl.formatMessage({ id: "settings.plugins.detail.details" })}>
          {componentGroups.length > 0 ? (
            <PluginComponentGroups groups={componentGroups} />
          ) : (
            // components 由 CLI 对插件根目录权威枚举得出（与启用态无关），停用插件也能展示真实组件。
            // 走到这里说明该插件确实未声明任何组件，给出诚实空态即可。
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({
                id: "settings.plugins.detail.componentsEmpty",
              })}
            </p>
          )}
        </DetailSection>

        {pluginWarnings.length > 0 ? (
          <DetailSection title={intl.formatMessage({ id: "settings.plugins.detail.warnings" })}>
            <PluginWarningList warnings={pluginWarnings} />
          </DetailSection>
        ) : null}

        {installedAt ? (
          <div className="border-t border-border pt-4">
            <div className="text-ui-xs font-medium text-foreground-subtle">
              {intl.formatMessage({
                id: "settings.plugins.detail.installedAt",
              })}
            </div>
            <div className="mt-1 break-all text-ui-base text-foreground">{installedAt}</div>
          </div>
        ) : null}

        {hasAdvanced ? (
          <details className="group/advanced border-t border-border pt-4">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-ui-xs font-medium text-foreground-subtle transition-colors hover:text-foreground">
              <ChevronRight className="size-3.5 transition-transform group-open/advanced:rotate-90" />
              {intl.formatMessage({
                id: "settings.plugins.detail.moreDetails",
              })}
            </summary>
            <div className="mt-3 space-y-3">
              <PluginDetailRow
                label={intl.formatMessage({
                  id: "settings.plugins.detail.rootPath",
                })}
                value={plugin.rootPath}
              />
              <PluginHookDetails hooks={hookDetails} />
              <PluginConfigControls
                getValue={getPluginOptionValue}
                onSave={onSavePluginOptions}
                onSetDraft={setPluginOptionDraft}
                activeOperations={activeOperations}
                plugin={plugin}
                scope={configScope}
              />
            </div>
          </details>
        ) : null}

        {isPluginUpdatePending(updateStatus) ? (
          <div className="flex items-center justify-between gap-2 border-t border-border pt-4">
            <div className="min-w-0">
              <p className="text-ui-base font-medium text-foreground">
                {updateStatus === "update-available"
                  ? intl.formatMessage(
                      { id: "settings.plugins.detail.updateAvailable" },
                      { version: latestVersion ?? "" },
                    )
                  : intl.formatMessage({
                      id: "settings.plugins.detail.versionChanged",
                    })}
              </p>
              <p className="text-ui-xs text-foreground-subtle">
                {intl.formatMessage({
                  id: "settings.plugins.detail.updateNewSessionsNote",
                })}
              </p>
            </div>
            {onRequestUpdate ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={activeOperations.some(
                  (operation) => operation.id === `plugin:update:${plugin.id}`,
                )}
                onClick={() => onRequestUpdate(plugin.id)}
              >
                {intl.formatMessage({ id: "settings.plugins.detail.update" })}
              </Button>
            ) : null}
          </div>
        ) : null}

        {uninstallable && onRequestUninstall ? (
          <div className="flex justify-end border-t border-border pt-4">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={activeOperations.some(
                (operation) => operation.id === `plugin:uninstall:${plugin.id}`,
              )}
              onClick={() => onRequestUninstall(plugin.id)}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.plugins.detail.uninstall" })}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// [契约] 分组小节统一承担标题层级与间距，避免各调用点自行写 h3 造成字号漂移。
// children 只做透传，小节不感知内容类型，也不提供空态。
// 新增分组时复用它即可自动获得一致的标题语义与屏幕阅读顺序。
function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-ui-base font-semibold text-foreground">{title}</h3>
      {children}
    </section>
  );
}

// [失败路径] warning 列表是诊断的最终落点，渲染缺失会让 CLI 的告警彻底失声。
// 因此这里保持极简结构：不折叠、不截断、不按条数分页，确保问题第一眼可见。
// key 使用 code 与下标的组合，允许同一 code 多条诊断共存。
/**
 * 插件 warning 诊断列表。CLI 对「声明的技能路径扫描为空」等异常
 * 只写 diagnostics 的话 UI 无渲染位置，用户无从排查。message 由 CLI 下发并包含
 * 具体路径（协议 wire 不携带 path 字段），因此正文直出 message 即可。
 */
// [契约] 入参已是过滤后的当前插件 warning，本组件不再二次筛选。
// 保持无状态，标题由外层 DetailSection 提供，便于复用在不同详情容器里。
// message 允许换行与长路径，样式使用 break-all 保证窄屏不横向溢出。
export function PluginWarningList({ warnings }: { warnings: ZCodePluginDiagnostic[] }) {
  return (
    <ul className="space-y-2">
      {warnings.map((diagnostic, index) => (
        <li
          key={`${diagnostic.code}-${index}`}
          className="flex min-w-0 items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />
          <span className="min-w-0 break-all text-ui-sm text-foreground">{diagnostic.message}</span>
        </li>
      ))}
    </ul>
  );
}

// [契约] hook 列表展示事件、匹配器、可执行性与命令，字段缺失时按协议默认值降级。
// runnable 为真才代表该 hook 会真正执行，仅诊断用途的 hook 用描边徽标区分。
// 这里只读 hookDetails，不推断 CLI 是否会加载该 hook。
export function PluginHookDetails({
  hooks,
}: {
  hooks: NonNullable<ZCodePluginInfo["hookDetails"]>;
}) {
  // [资源] 每个 hook 卡片都包含多项可选字段，渲染时按存在性逐个输出，避免占位空行。
  // 命令拼接只做 command 与 args 的简单连接，参数引号由 CLI 保证，UI 不重新转义。
  // 字段较多时保持网格两列，窄屏自动回落单列。
  const { intl } = useZCodeIntl();
  return (
    <div>
      <div className="mb-2 text-ui-xs font-medium text-foreground">
        {intl.formatMessage({ id: "settings.plugins.detail.hooks" })}
      </div>
      {hooks.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.plugins.detail.none" })}
        </div>
      ) : (
        <div className="space-y-2">
          {hooks.map((hook, index) => (
            <div
              key={`${hook.event}-${hook.matcher ?? "default"}-${hook.command}-${index}`}
              className="min-w-0 space-y-2 rounded-lg border border-border bg-surface px-3 py-2"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <Badge variant="outline" className="rounded-md font-mono">
                  {hook.event}
                </Badge>
                <Badge variant="outline" className="rounded-md">
                  {hook.matcher ??
                    intl.formatMessage({
                      id: "settings.plugins.detail.hook.defaultMatcher",
                    })}
                </Badge>
                <Badge variant={hook.runnable ? "secondary" : "outline"} className="rounded-md">
                  {hook.runnable
                    ? intl.formatMessage({
                        id: "settings.plugins.detail.hook.runnable",
                      })
                    : intl.formatMessage({
                        id: "settings.plugins.detail.hook.diagnosticOnly",
                      })}
                </Badge>
              </div>
              <PluginDetailInlineValue
                label={intl.formatMessage({
                  id: "settings.plugins.detail.hook.command",
                })}
                value={formatHookCommand(hook)}
              />
              <div className="grid gap-2 sm:grid-cols-2">
                {hook.timeoutMs !== undefined ? (
                  <PluginDetailInlineValue
                    label={intl.formatMessage({
                      id: "settings.plugins.detail.hook.timeoutMs",
                    })}
                    value={`${hook.timeoutMs}ms`}
                  />
                ) : null}
                {hook.timeout !== undefined ? (
                  <PluginDetailInlineValue
                    label={intl.formatMessage({
                      id: "settings.plugins.detail.hook.timeout",
                    })}
                    value={String(hook.timeout)}
                  />
                ) : null}
                {hook.async !== undefined ? (
                  <PluginDetailInlineValue
                    label={intl.formatMessage({
                      id: "settings.plugins.detail.hook.async",
                    })}
                    value={String(hook.async)}
                  />
                ) : null}
                {hook.shell !== undefined ? (
                  <PluginDetailInlineValue
                    label={intl.formatMessage({
                      id: "settings.plugins.detail.hook.shell",
                    })}
                    value={hook.shell === true ? "true" : hook.shell}
                  />
                ) : null}
                {hook.statusMessage ? (
                  <PluginDetailInlineValue
                    label={intl.formatMessage({
                      id: "settings.plugins.detail.hook.statusMessage",
                    })}
                    value={hook.statusMessage}
                  />
                ) : null}
              </div>
              <PluginDetailInlineValue
                label={intl.formatMessage({
                  id: "settings.plugins.detail.hook.sourcePath",
                })}
                value={hook.sourcePath}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// [契约] 行内键值对用于 hook 与路径明细，label 与 value 都按纯文本渲染，不做富文本解析。
// mono 字体只作用于 value，保证标签仍与正文保持同一阅读节奏。
// value 已由调用方字符串化，本组件不接收数字或布尔。
function PluginDetailInlineValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-ui-xs text-foreground-subtle">{label}</div>
      <div className="mt-0.5 break-all font-mono text-ui-xs text-foreground">{value}</div>
    </div>
  );
}

// [契约] 命令格式化只处理 args 缺省与拼接，不解析 shell 语法，也不对参数做引号包裹。
// 空 args 直接返回 command，避免产生尾随空格影响复制粘贴。
// 若 CLI 未来下发已格式化的字符串，应删除本函数而不是双重拼接。
function formatHookCommand(hook: NonNullable<ZCodePluginInfo["hookDetails"]>[number]): string {
  // [失败路径] 缺少 args 是合法协议形态（无参 hook），这里按空参处理而不是渲染成 undefined。
  // 判空放在拼接之前，保证返回字符串永远不含 "undefined"。
  // 单行返回写法与文件其余短分支保持一致。
  if (!hook.args || hook.args.length === 0) return hook.command;
  return `${hook.command} ${hook.args.join(" ")}`;
}

// [契约] 详情行用于根路径等单值展示，样式与行内键值对区分，整体占满一行。
// 值使用 font-mono 与 break-all，保证 Windows 长路径在窄屏可换行。
// 不提供复制按钮，复制能力由宿主统一提供，避免各处重复实现。
export function PluginDetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface px-3 py-2">
      <div className="text-ui-xs text-foreground-subtle">{label}</div>
      <div className="mt-1 break-all font-mono text-ui-xs text-foreground">{value}</div>
    </div>
  );
}
