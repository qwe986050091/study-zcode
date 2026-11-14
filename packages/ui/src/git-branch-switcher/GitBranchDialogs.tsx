// GitBranchDialogs.tsx —— 分支创建 / 切换受阻 / 提交后切换 三个对话框的受控展示层。
// 职责边界：只把 props 投影成 JSX 并向上回报用户意图；不读服务、不调 Git、不持有表单状态与异步状态。
// 状态归属：open / step / state / mutationPending / commitMessage / commitError 全由父组件持有，本文件零 useState。
// 副作用出口：创建走 onSubmit，受阻推进走 onOpenCommit，退出走 onCancel（创建）与 onClose（助手）。
//
// INV 表（断言 → 守住它的位置 → 改错故障）：
// INV-01 断言：创建框的 open 只来自 props.open，本组件不持有开关状态 —— 守住它的位置：创建框的 Dialog open 属性 —— 改错故障：父级的关闭请求失效，出现关不掉的浮层。
// INV-02 断言：助手框只有在 step 与 state 同时非空时才打开 —— 守住它的位置：外层 Dialog 的 open 表达式 —— 改错故障：step 有值而 state 为空时解引用崩溃。
// INV-03 断言：两个阶段互斥，同一时刻只渲染一个 DialogContent —— 守住它的位置：step 等于常量的两个条件分支 —— 改错故障：两套内容同时挂载，遮罩叠层并抢焦点。
// INV-04 断言：mutationPending 为真时输入框与全部按钮禁用 —— 守住它的位置：Input / Textarea / 取消 / 确认的 disabled —— 改错故障：提交中可再次点击，产生重复创建或重复提交。
// INV-05 断言：创建按钮在 branchName 去空格后为空时禁用，去空格只判空不改值 —— 守住它的位置：submit 按钮的 disabled 表达式 —— 改错故障：空分支名被提交，或用户输入被静默裁剪。
// INV-06 断言：表单提交先 preventDefault 再调 onSubmit，两条表单一致 —— 守住它的位置：两个 onSubmit 处理器的首行 —— 改错故障：浏览器原生提交刷新页面，草稿丢失。
// INV-07 断言：取消只调用 onCancel / onClose，不清写仓库 —— 守住它的位置：取消按钮的 onClick 与 onOpenChange 的关闭分支 —— 改错故障：取消被当作撤销，用户以为操作已回滚。
// INV-08 断言：提交错误只经 commitError 就近展示在确认按钮上方 —— 守住它的位置：提交分支的 commitError 段落 —— 改错故障：失败原因被吞掉或抛到全局，用户无从重试。
// INV-09 断言：身份缺失只在 hasIdentity 为假时告警，禁用提交还需确认身份为空 —— 守住它的位置：identityMissing 区块与 disabled 中的 state.identity 判断 —— 改错故障：未探测即锁死按钮，或真缺失时仍放行。
// INV-10 断言：受阻描述只按 issue.code 在两条 i18n key 间二选一 —— 守住它的位置：descriptionId 的三元表达式 —— 改错故障：文案与实际覆盖风险不符，用户按错误提示操作。
// INV-11 断言：文件列表以 repoRelativePath 作 key，展示用 workspaceRelativePath —— 守住它的位置：affectedFiles 的 map key 与 FileDisplayInline —— 改错故障：跨仓库同名文件撞 key 导致行复用错乱或暴露绝对路径。
// INV-12 断言：所有数字经 Intl.NumberFormat(locale) 格式化 —— 守住它的位置：numberFormatter 及其三个调用点 —— 改错故障：同一界面出现两套数字分组，与其他区域不一致。
// INV-13 断言：所有可见文案来自 intl.formatMessage，文件内无硬编码文案字面量 —— 守住它的位置：每个 DialogTitle / DialogDescription / Button —— 改错故障：切换语言后残留单一语言文案。
// INV-14 断言：外层 Dialog 的 onOpenChange 只在关闭方向回调 onClose —— 守住它的位置：onOpenChange 的 nextOpen 取反判断 —— 改错故障：打开动作也触发关闭，对话框开关抖动。
// INV-15 断言：本文件不引入 git 服务或 runtime，只依赖 UI 基元与类型 —— 守住它的位置：顶部 import 列表 —— 改错故障：展示层直接读写仓库，破坏 UI 与服务分层。
// INV-16 断言：组件保持无状态、无 effect，渲染结果完全由 props 决定 —— 守住它的位置：两个导出函数体 —— 改错故障：局部状态与父级分叉，界面与真实仓库不一致。
import { type FormEvent } from "react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import {
  hasGitCommitIdentity,
  type GitBranchSwitchAssistDialogStep,
  type GitBranchSwitchAssistState,
} from "@/git-branch-switcher/switchAssist.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { FileDisplayInline } from "@/lib/fileDisplay.js";
import { AlertCircleIcon, GitBranchIcon, LoaderIcon } from "lucide-react";

// [契约] 创建框的全部输入：open 决定可见性；branchName 是受控值，唯一写入口是 onBranchNameChange。
// [契约] mutationPending 贯穿 Input、取消、确认三处，少接一处就会在提交中出现可交互控件。
// [权衡] onCancel 与 onOpenChange 分工：取消按钮走 onCancel 以便父级清空草稿，遮罩与 ESC 只关闭不改草稿。
// [失败路径] 本层不做名称校验；空名由按钮 disabled 拦截，重名与非法字符的错误由父级在框外回写。
// [并发] 提交中父级维持 mutationPending，本组件不自建第二道锁，避免两层锁的释放顺序互相打架。
interface GitBranchCreateDialogProps {
  open: boolean;
  branchName: string;
  mutationPending: boolean;
  onOpenChange: (nextOpen: boolean) => void;
  onBranchNameChange: (nextValue: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

// [契约] 解构后原样透传，不派生、不缓存任何字段，保证父组件每次渲染都是唯一事实来源。
// [契约] 组件没有内部状态与副作用，重复渲染结果完全一致，可被父级安全地反复挂载。
// [资源] 名称框的 autoFocus 只在挂载时生效；对话框关闭即卸载，再次打开会重新挂载并重新聚焦。
// [失败路径] 首帧 branchName 可能为空串，确认按钮此时禁用，用户不会在无输入时误提交。
// [权衡] 不接收默认分支名做占位：默认值属于业务策略，写进展示层会让两个调用方难以区分。
export function GitBranchCreateDialog({
  open,
  branchName,
  mutationPending,
  onOpenChange,
  onBranchNameChange,
  onCancel,
  onSubmit,
}: GitBranchCreateDialogProps) {
  // [契约] 文案统一走 intl.formatMessage，id 前缀 git.branchSwitcher.createDialog 与其他两个对话框隔离。
  // [契约] 本框没有数字展示，因此只取 intl 不取 locale，避免引入用不到的格式化依赖。
  // [失败路径] 缺失的 i18n key 会退化为 id 字面量而非崩溃，便于在界面上直接发现漏配文案。
  // [资源] hook 在每次渲染调用一次，不额外缓存 intl 对象，保证语言切换后立即取到新实例。
  const { intl } = useZCodeIntl();

  // [契约] 函数体只有这一个 return，不存在第二条渲染路径，条件分支全部收在 JSX 内部。
  // [契约] 返回的根节点是受控 Dialog，可见性完全由 props.open 决定，本组件不持有开关状态。
  // [失败路径] open 为 false 时组件仍会挂载但不展示内容，因此这里对空 branchName 必须安全。
  // [权衡] 表单结构与提交回调留在 JSX 属性里，不抽成局部函数，减少间接层便于逐行核对契约。
  return (
    // [契约] 完全受控：open 来自 props，关闭请求必须经 onOpenChange 回到父级，本层无权自行改值。
    // [失败路径] 若父级忽略 onOpenChange，遮罩点击与 ESC 都关不掉，表现为弹窗卡死，根因在父级。
    // [权衡] 不用 DialogTrigger：入口是分支下拉菜单，再造一个触发器会出现两条打开路径。
    // [并发] 打开与关闭都是同步的状态翻转，不等待任何 promise，避免遮罩先到、内容后到的闪烁。
    // [契约] DialogContent 的 max-w-lg 与 p-0 交给内部各区块自行控制内边距，保证标题与表单对齐。
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-0 rounded-2xl p-0 overflow-hidden">
        <DialogHeader className="gap-2 px-6 py-5 pb-0">
          <DialogTitle className="text-lg font-medium text-foreground">
            {intl.formatMessage({
              id: "git.branchSwitcher.createDialog.title",
            })}
          </DialogTitle>
          <DialogDescription className="text-ui-base leading-6 text-foreground-subtle">
            {intl.formatMessage({
              id: "git.branchSwitcher.createDialog.description",
            })}
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-5 px-6 py-6"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            // [契约] 原生 form 仅用于承接 Enter 键，提交路径统一收敛到 onSubmit，不直接调用任何服务或 Git。
            // [失败路径] preventDefault 必须保留在第一行：缺失时浏览器走原生 GET 提交并刷新页面，草稿全丢。
            // [并发] 按钮已 disabled 时表单仍可能被 Enter 触发一次，重复提交的兜底由父级的 mutationPending 承担。
            // [权衡] 不用按钮 onClick 代替 submit：那会让 Enter 键失效，两种输入方式必须共用同一路径。
            event.preventDefault();
            // [契约] 这里只发起提交意图，不 await、不关心结果；成功与失败都体现为父级回传的新 props。
            // [契约] 提交前的数据仍来自受控 props，本层不读取 DOM 值，保证所见即所提交。
            // [失败路径] 父级若在 onSubmit 内同步抛错，异常会冒泡出事件处理器，本层不捕获也不改写。
            // [并发] 连续两次触发时本层不拦截，去重责任在父级的 mutationPending，避免两处判断不一致。
            // [权衡] 不在提交前清空 branchName：父级可能需要在失败后保留用户输入以便重试。
            onSubmit();
          }}
        >
          <div className="space-y-2">
            <label
              htmlFor="git-branch-switcher-create-input"
              className="inline-flex text-ui-base font-medium text-foreground-subtle"
            >
              {intl.formatMessage({
                id: "git.branchSwitcher.createDialog.nameLabel",
              })}
            </label>
            <Input
              id="git-branch-switcher-create-input"
              size="lg"
              autoFocus
              value={branchName}
              disabled={mutationPending}
              placeholder={intl.formatMessage({
                id: "git.branchSwitcher.createDialog.placeholder",
              })}
              className="h-10 rounded-lg bg-background/50"
              onChange={(event) => {
                // [契约] 输入变更只上报原始字符串，不 trim、不改大小写、不做任何归一化。
                // [契约] value 与 onChange 成对出现，缺任一都会让输入退化为非受控并丢失外部设置的值。
                // [失败路径] 父级若把值裁剪后再回传，光标可能跳到末尾；本层不干预，保持父级行为可见。
                // [并发] 提交期间输入框禁用，onChange 不会被触发，不存在提交中改名的竞态。
                // [权衡] 不做输入时即时校验：校验文案会与 helper 争同一行空间，错误统一留到提交后由父级给出。
                onBranchNameChange(event.target.value);
              }}
            />
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({
                id: "git.branchSwitcher.createDialog.helper",
              })}
            </p>
          </div>

          <DialogFooter className="gap-2 pt-4">
            <Button
              type="button"
              variant="secondary"
              size="lg"
              onClick={onCancel}
              disabled={mutationPending}
              className="h-10 min-w-0 px-5"
            >
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button
              type="submit"
              size="lg"
              disabled={mutationPending || branchName.trim().length === 0}
              className="h-10 min-w-0 px-5"
            >
              {mutationPending ? <LoaderIcon className="size-4 animate-spin" /> : null}
              {intl.formatMessage({
                id: "git.branchSwitcher.createDialog.confirm",
              })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// [契约] step 与 state 成对描述当前阶段：step 选择渲染哪一块，state 提供该块需要的全部数据。
// [契约] commitMessage 与 commitError 受控，提交中的禁用与错误展示全由 props 驱动，本层不缓存错误。
// [契约] 全部字段都是标量或只读快照，父级替换对象即触发重渲染，无需本层做浅比较。
// [权衡] currentBranchLabel 单独传入而非从 state 推导，受阻与提交两个阶段都能直接复用同一标签。
// [失败路径] 两者只在同时非空时渲染内容；任一为空即关闭对话框，不允许出现半渲染的中间态。
interface GitBranchSwitchAssistDialogProps {
  step: GitBranchSwitchAssistDialogStep | null;
  state: GitBranchSwitchAssistState | null;
  currentBranchLabel: string;
  commitMessage: string;
  commitError: string | null;
  mutationPending: boolean;
  onClose: () => void;
  onOpenCommit: () => void;
  onCommitMessageChange: (nextValue: string) => void;
  onSubmit: () => void;
}

// [契约] 两个阶段共用一个 Dialog 实例，同一时刻只会渲染其中一个 DialogContent，不会叠出两层遮罩。
// [契约] 组件无内部状态，阶段切换完全由父级改 step 驱动，因此回退到受阻阶段也是父级的决定。
// [并发] onClose 由取消按钮与 onOpenChange 的关闭分支两条路径共用，父级必须实现幂等关闭。
// [资源] 阶段切换会卸载旧 DialogContent 并挂载新的，输入框的焦点因此不会跨阶段残留。
export function GitBranchSwitchAssistDialog({
  step,
  state,
  currentBranchLabel,
  commitMessage,
  commitError,
  mutationPending,
  onClose,
  onOpenCommit,
  onCommitMessageChange,
  onSubmit,
}: GitBranchSwitchAssistDialogProps) {
  // [契约] 本框既要文案也要 locale：文件计数与增删行数都需要按当前语言格式化。
  // [契约] locale 只用于数字，不参与文案选择，文案仍由 intl 按自身语言包解析。
  // [失败路径] locale 为空串时格式化会退回运行时默认语言，与界面语言可能不一致，需父级保证非空。
  // [资源] 每次渲染取一次 hook 值，不做手工缓存，语言切换时自然重建下游格式化器。
  const { intl, locale } = useZCodeIntl();
  // [契约] 数字格式化的唯一入口，所有计数与增删行数都必须经过它，禁止在 JSX 里另写格式化。
  // [契约] 每次渲染重建实例，代价可忽略，换来切换语言后数字立即跟随而非沿用旧 locale。
  // [失败路径] 不用 toLocaleString 隐式取环境语言，避免同一界面出现两套分组规则。
  // [权衡] 不把格式化器提到模块顶层：顶层无法感知 hook 返回的当前 locale。
  // [资源] Intl 实例创建有固定成本，但本框渲染频率低（打开与状态变更），无需额外记忆化。
  const numberFormatter = new Intl.NumberFormat(locale);
  // [契约] 受阻描述只在两条 key 间二选一，判据是 issue.code 的精确相等，不做前缀或模糊匹配。
  // [契约] 未跟踪分支强调有未跟踪文件会被覆盖，已跟踪分支强调已跟踪改动会被覆盖。
  // [失败路径] 未知 code 落到已跟踪文案：宁可措辞偏宽，也不要渲染空描述让用户无从判断。
  // [权衡] 用字符串 key 而非在 JSX 里内联条件，保证 DialogDescription 只有一处，便于排查文案。
  // [并发] 判定发生在渲染期，与同一帧读取的 fileCount、affectedFiles 必定来自同一个 state。
  const descriptionId =
    state?.issue.code === "untracked-changes-would-be-overwritten"
      ? "git.branchSwitcher.blockedDialog.description.untracked"
      : "git.branchSwitcher.blockedDialog.description.tracked";
  // [契约] 身份有三种状态：未探测（state 或 identity 为 null）、有效、确认缺失（非 null 但不完整）。
  // [契约] 判定收敛在这一个布尔值上，JSX 只消费 hasIdentity，禁止在按钮处重复推导。
  // [失败路径] 只有确认缺失才禁用提交；未探测时不拦，避免刚打开对话框就把按钮锁死。
  // [并发] 判定与 props 同帧读取，提交中父级不会中途替换 identity 而让按钮状态抖动。
  // `hasIdentity` 不复用告警条件：告警只管展示，禁用还要求身份已被 `hasGitCommitIdentity` 真正探测过。
  const hasIdentity = hasGitCommitIdentity(state?.identity ?? null);

  // [契约] 单 return 结构，两个阶段是同一父节点下的两个条件子节点，互斥由 step 保证。
  // [契约] 外层 Dialog 的可见性只由 step 与 state 共同推导，没有任何本地开关参与。
  // [失败路径] step 有值而 state 为空时两个分支都不渲染，Dialog 保持关闭而非崩溃。
  // [权衡] 不用 early return 分阶段渲染：共用外层 Dialog 才能保证阶段切换时遮罩不重建。
  return (
    // [契约] 打开条件是最关键的守卫：step 与 state 同时存在才显示，二者缺一即关闭。
    // [失败路径] onOpenChange 只处理关闭方向；打开方向必须忽略，否则父级传入的 step 会被本层改写。
    // [并发] 关闭时不清空 state，重新打开由父级决定是否复用上一次的文件列表与错误信息。
    // [契约] 关闭请求只有一个出口 onClose，遮罩、ESC 与取消按钮最终都汇聚到这里。
    // [权衡] 不在关闭时自动提交或回滚：本层只负责界面，仓库状态的收尾属于父级。
    <Dialog
      open={Boolean(step && state)}
      onOpenChange={(nextOpen) => {
        // [契约] 受控 Dialog 的回调里只对关闭做出反应，打开方向一律忽略。
        // [失败路径] 去掉这层判断会让每次打开也触发 onClose，父级刚设的 step 立即被清空，表现为开不了框。
        // [并发] 关闭回调可能被连续触发（ESC 与遮罩双击），父级需保证 onClose 幂等。
        // [契约] 这里不区分关闭来源：无论是取消还是点击遮罩，对仓库的影响都必须是零。
        // [权衡] 不在此处做 pending 判断，阻断关闭会让用户困在对话框里；提交中禁用取消由按钮承担。
        if (!nextOpen) {
          // [契约] 关闭的唯一实际动作：清空父级的 step，界面随之消失，不触碰任何仓库状态。
          // [失败路径] 此处不检查 mutationPending，因此遮罩与 ESC 在提交中仍可关闭界面；按钮层的禁用负责劝阻。
          // [并发] 关闭后到达的提交结果仍由父级处理，本层已卸载，不会出现更新已卸载组件的告警。
          // [权衡] 关闭不清空 commitMessage：再次进入提交阶段时父级可决定保留还是重置。
          onClose();
        }
      }}
    >
      {step === "blocked" && state ? (
        <DialogContent className="max-w-lg gap-0 rounded-2xl p-0 overflow-hidden">
          <DialogHeader className="gap-2 px-6 py-5 pb-0">
            <DialogTitle className="text-lg font-medium text-foreground">
              {intl.formatMessage({
                id: "git.branchSwitcher.blockedDialog.title",
              })}
            </DialogTitle>
            <DialogDescription className="text-ui-base leading-6 text-foreground-subtle">
              {intl.formatMessage({ id: descriptionId })}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 px-6 py-6">
            <div className="flex items-start gap-3 rounded-xl bg-warning/10 px-4 py-3 text-ui-base text-warning">
              <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
              <p>
                {intl.formatMessage({
                  id: "git.branchSwitcher.blockedDialog.helper",
                })}
              </p>
            </div>

            <div className="rounded-xl bg-background/30">
              <div className="flex items-center justify-between px-4 py-3">
                <div className="text-ui-base font-medium text-foreground">
                  {intl.formatMessage({
                    id: "git.branchSwitcher.blockedDialog.filesLabel",
                  })}
                </div>
                <div className="text-ui-base text-foreground-subtle">
                  {intl.formatMessage(
                    {
                      id: "git.branchSwitcher.commitDialog.changesValue",
                    },
                    {
                      count: numberFormatter.format(state.fileCount),
                    },
                  )}
                </div>
              </div>

              <div className="space-y-1 overflow-y-auto p-1 max-h-56 overflow-y-auto">
                {state.affectedFiles.map((file) => (
                  <div
                    key={file.repoRelativePath}
                    className="flex items-start justify-between gap-4 h-10 rounded-lg bg-background/50 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <FileDisplayInline
                        path={file.workspaceRelativePath}
                        options={{
                          className: "inline-flex min-w-0 max-w-full items-center gap-1.5",
                          fileNameClassName: "truncate text-ui-base font-medium text-foreground",
                        }}
                      />
                    </div>
                    <div className="flex shrink-0 items-center gap-2 font-mono text-ui-base">
                      <span className="text-diff-added">+{file.added}</span>
                      <span className="text-diff-removed">-{file.removed}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <DialogFooter className="gap-2 pt-4">
              <Button
                type="button"
                variant="secondary"
                size="lg"
                onClick={onClose}
                disabled={mutationPending}
                className="h-10 min-w-0 px-5"
              >
                {intl.formatMessage({ id: "common.cancel" })}
              </Button>
              <Button
                type="button"
                size="lg"
                onClick={onOpenCommit}
                disabled={mutationPending}
                className="h-10 min-w-0 px-5"
              >
                {intl.formatMessage({
                  id: "git.branchSwitcher.blockedDialog.submitAction",
                })}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      ) : null}

      {step === "commit" && state ? (
        <DialogContent className="max-w-lg gap-0 rounded-2xl p-0 overflow-hidden">
          <DialogHeader className="gap-2 px-6 py-5 pb-0">
            <DialogTitle className="text-lg font-medium text-foreground">
              {intl.formatMessage({
                id: "git.branchSwitcher.commitDialog.title",
              })}
            </DialogTitle>
            <DialogDescription className="text-ui-base leading-6 text-foreground-subtle">
              {intl.formatMessage(
                {
                  id: "git.branchSwitcher.commitDialog.description",
                },
                {
                  branchName: state.targetBranchName,
                },
              )}
            </DialogDescription>
          </DialogHeader>

          <form
            className="space-y-5 px-6 py-6"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              // [契约] 提交表单同样只走 onSubmit，Enter 与点击确认共用一条路径，不额外注册点击处理器。
              // [失败路径] 缺少 preventDefault 会触发浏览器原生提交并刷新页面，正在填写的提交信息全部丢失。
              // [契约] 表单内没有 name 属性，即使走到原生提交也不会把提交信息拼进 URL，减少误泄漏风险。
              // [并发] 提交中按钮与文本域同时禁用，但 Enter 仍可能触发一次，去重由父级的 mutationPending 负责。
              // [权衡] 不使用受控的提交按钮 onClick：两条路径并存会让是否已提交难以追踪。
              event.preventDefault();
              // [契约] 只发出提交意图；成功切换分支、失败回写 commitError 都由父级完成。
              // [失败路径] 提交失败后本框保持打开，commitMessage 不被本层清空，用户可修改后重试。
              // [并发] 重复触发的兜底同样在父级：mutationPending 为真时不再发起第二次提交。
              // [权衡] 不在提交前校验提交信息是否为空，空消息的判定交给父级与 Git，避免两套规则冲突。
              onSubmit();
            }}
          >
            <div className="rounded-xl bg-background/30">
              <div className="flex items-start justify-between p-4">
                <div className="text-ui-base font-medium text-foreground">
                  {intl.formatMessage({
                    id: "git.branchSwitcher.commitDialog.currentBranchLabel",
                  })}
                </div>
                <div className="flex items-center gap-2 text-ui-base font-medium text-foreground">
                  <GitBranchIcon className="size-4 text-foreground-subtle" />
                  <span>{currentBranchLabel}</span>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3 border-t border-border/50 p-4 text-ui-base">
                <div className="text-ui-base font-medium text-foreground">
                  {intl.formatMessage({
                    id: "git.branchSwitcher.commitDialog.changesLabel",
                  })}
                </div>
                <div className="flex gap-2">
                  <span className="text-foreground-subtle">
                    {intl.formatMessage(
                      {
                        id: "git.branchSwitcher.commitDialog.changesValue",
                      },
                      {
                        count: numberFormatter.format(state.fileCount),
                      },
                    )}
                  </span>
                  <span className="text-diff-added font-mono">
                    +{numberFormatter.format(state.totalAdded)}
                  </span>
                  <span className="text-diff-removed font-mono">
                    -{numberFormatter.format(state.totalRemoved)}
                  </span>
                </div>
              </div>
            </div>

            {!hasIdentity ? (
              <div className="flex items-start gap-3 rounded-xl bg-warning/10 px-4 py-3 text-ui-base text-warning">
                <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
                <p>
                  {intl.formatMessage({
                    id: "git.branchSwitcher.commitDialog.identityMissing",
                  })}
                </p>
              </div>
            ) : null}

            <div>
              <div className="space-y-2">
                <label
                  htmlFor="git-branch-switcher-commit-message"
                  className="inline-flex text-ui-base font-medium text-foreground-subtle"
                >
                  {intl.formatMessage({
                    id: "git.branchSwitcher.commitDialog.messageLabel",
                  })}
                </label>
                <Textarea
                  id="git-branch-switcher-commit-message"
                  value={commitMessage}
                  disabled={mutationPending}
                  placeholder={intl.formatMessage({
                    id: "git.branchSwitcher.commitDialog.messagePlaceholder",
                  })}
                  className="min-h-32 rounded-lg border-input-border bg-background/50 px-3 py-3 text-ui-base text-foreground placeholder:text-foreground-subtlest focus-visible:border-input-border-focused focus-visible:bg-input-focused focus-visible:ring-0 md:text-ui-base"
                  onChange={(event) => {
                    // [契约] 文本域受控，唯一写入口是 onCommitMessageChange，本层不裁剪也不补默认文案。
                    // [契约] value 与 onChange 成对出现，缺任一都会让文本域退化为非受控并丢失父级设置的值。
                    // [失败路径] 提交期间文本域禁用，onChange 不会触发，保证被提交的内容与界面所见一致。
                    // [并发] 每次按键立即上抛，父级若做节流或延迟回写，光标位置的变化由父级自行承担。
                    // [权衡] 不做输入长度限制：提交信息的长度约束属于 Git 侧规则，展示层不预判。
                    onCommitMessageChange(event.target.value);
                  }}
                />
                <p className="text-ui-base text-foreground-subtle">
                  {intl.formatMessage({
                    id: "git.branchSwitcher.commitDialog.messageHelper",
                  })}
                </p>
              </div>
            </div>

            {commitError ? <p className="text-ui-base text-destructive">{commitError}</p> : null}

            <DialogFooter className="gap-2 pt-4">
              <Button
                type="button"
                variant="secondary"
                size="lg"
                onClick={onClose}
                disabled={mutationPending}
                className="h-10 min-w-0 px-5"
              >
                {intl.formatMessage({ id: "common.cancel" })}
              </Button>
              <Button
                type="submit"
                size="lg"
                disabled={mutationPending || (!hasIdentity && state.identity !== null)}
                className="h-10 min-w-0 px-5"
              >
                {mutationPending ? <LoaderIcon className="size-4 animate-spin" /> : null}
                {intl.formatMessage({
                  id: "git.branchSwitcher.commitDialog.confirm",
                })}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
