// EditConnectionProfileDialog.tsx —— 编辑已保存远程连接的对话框：编辑态初始化、字段校验、提交与关闭闸门
//
// INV-01 编辑态字段只在挂载时从 profile 初始化一次，之后 props 变化不再回灌；守住位置：EditConnectionProfileForm 的初始化 effect 与 key 重挂载；改错故障：用户正在输入时父层 profile 刷新，已填的主机与端口被旧值覆盖，未保存的修改静默丢失
// INV-02 子表单以 profile.profileId 作为 key 重挂载，切换编辑目标等价于一张全新表单；守住位置：EditConnectionProfileDialog 返回处的 key 属性；改错故障：从连接 A 直接切到连接 B 时复用 A 的草稿，保存后把 B 改成 A 的主机
// INV-03 只有 open 与 profile 同时为真才渲染表单，关闭即整体卸载；守住位置：EditConnectionProfileDialog 的三元返回；改错故障：关闭后表单仍挂载，残留的校验错误与错误条在下一次打开时闪现
// INV-04 展示名与设备名是本地 state，只在挂载时取初值，绝不从 profile 反向派生；守住位置：name 与 deviceName 的 useState 初值；改错故障：把用户起的名字回写成线路标识，保存后列表显示的名字变了样
// INV-05 防重入必须同时依赖 savingRef 与 saving 两条闸门，任何提交入口都不得绕过；守住位置：handleSave 入口守卫与 fieldset 的 disabled；改错故障：请求在飞时再次提交，同一连接被写两次，后一次覆盖前一次
// INV-06 保存进行中禁止关闭对话框，onOpenChange 必须先查 savingRef；守住位置：Dialog 的 onOpenChange 包装；改错故障：提交尚未落地就被关闭，用户以为已保存，列表里仍是旧值
// INV-07 保存成功后先触发 onSaved 再关闭对话框，顺序不可交换；守住位置：handleSave 的 try 尾段；改错故障：列表刷新时对话框仍持旧 profile，或提前卸载导致回调丢失、界面停在过期数据上
// INV-08 错误只保留最近一条，进入字段校验、开始提交与提交成功都必须清空它；守住位置：setError 在各分支的取值；改错故障：上一次网络错误残留在新一次提交里，用户按旧错误反复排查
// INV-09 字段级错误只显示在字段下方，顶部错误条只留给名称缺失与保存失败；守住位置：fieldErrors 非空分支与 error 的条件渲染；改错故障：同一个错误出现两处，或在字段下方留空导致用户找不到问题字段
// INV-10 字段校验失败通过递增 validationAttempt 触发聚焦，而不是在提交分支里直接调 focus；守住位置：setValidationAttempt 与聚焦 effect；改错故障：错误文案尚未渲染就抢焦点，聚焦落到旧节点或不存在的元素上
// INV-11 聚焦只认同时带 aria-invalid 与 aria-describedby 的节点；守住位置：querySelector 的选择器；改错故障：从修改主机入口打开时焦点被提示态字段抢走，跳过真正出错的字段
// INV-12 SSH 密码留空表示沿用已保存凭据，该语义仅在 passwordCredentialKey 存在时成立；守住位置：passwordOptional 入参与 target 构造；改错故障：编辑无关字段被迫重输密码，或空密码覆盖掉原本可用的凭据
// INV-13 端口为空按 22 提交，非空必须先通过 1 到 65535 的整数校验，且两处读同一个 trim 值；守住位置：collectRemoteFormFieldErrors 与 normalizedPort；改错故障：纯空格被数值化成 0，请求被服务端拒绝且提示与界面不符
// INV-14 目标构造按 profile.transport 分支，编辑不改变已保存连接的类型；守住位置：handleSave 的三段 target 构造；改错故障：WSL 连接被当作 SSH 提交，主机与端口字段串到另一条线路
// INV-15 resourcePackages 只能从原 profile 透传，表单不提供编辑入口；守住位置：SSH target 的展开处；改错故障：保存一次就把资源包选择清空，下次连接缺依赖且无从恢复
// INV-16 SSH 别名只在用户显式选中时写回，未选中不得凭空生成 sshConfigAlias；守住位置：target 中 selectedSshConfigAlias 的条件展开；改错故障：手动填写的地址被拼成不存在的主机别名，连接直接失败
// INV-17 deviceName 只在编辑来源服务器且值确实变化时才提交；守住位置：sourceDisplayName 的条件展开；改错故障：每次保存都写回展示名，产生无意义的远端写入与审计噪音
// INV-18 密码与私钥口令只以明文停留在表单内存，提交后不再回填到输入框；守住位置：useRemoteConnectionForm 的凭据 state 与占位文案；改错故障：保存后密码重新出现在输入框，旁观者可读屏获取凭据
// INV-19 取消是纯关闭动作，不提交也不重置，草稿由 preserveDraftOnOpen 与 hook 的关闭分支保留；守住位置：取消按钮的 onClick 与 hook 入参；改错故障：用户误点取消后重新打开，全部修改消失且无法恢复
// INV-20 失败信息原样透出管理服务返回的文本，不做二次包装与截断；守住位置：catch 分支的 setError；改错故障：真实失败原因被通用文案掩盖，用户与支持人员都无法定位
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { ConnectionProfile, SourceServerRecord } from "@zcode/shared";
import { DEFAULT_REMOTE_ASSET_INSTALL_MODE } from "@zcode/shared";
import type { ISourceServerManagementService } from "@zcode/services";
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
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useRemoteConnectionForm } from "@/hooks/useRemoteConnectionForm.js";
import { RemoteConnectionFields } from "@/RemoteConnectionFields.js";
import { collectRemoteFormFieldErrors } from "@/lib/remoteConnectionWizard.js";
import { RemoteConnectionKindTag } from "@/remote-connection/RemoteConnectionTags.js";

type EditConnectionProfileDialogProps = {
  open: boolean;
  profile: ConnectionProfile | null;
  source?: SourceServerRecord;
  management: ISourceServerManagementService;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
  focusField?: "host" | "auth";
};

export function EditConnectionProfileDialog(props: EditConnectionProfileDialogProps) {
  // 外层只做两件事：按 open 与 profile 判定是否渲染，并把 profileId 钉成 key
  // [权衡] 用 key 强制重挂载，而不是在子组件里监听 profile 变化后手工重置，代价是多一次挂载，换来不可能出现跨连接的脏 state
  // key 只取 profileId，不取整个 profile 对象：同一条连接的展示名变化不该清掉用户正在输入的内容
  // [失败路径] 若父层在打开状态下把 profile 置空，这里立刻卸载表单，进行中的编辑随之作废，因此保存期间不得清空 profile
  // 写成条件表达式而非提前返回，保证它仍是纯组件且不涉及 hooks 顺序问题
  // 真正的表单状态全部在子组件，外层不持有任何 state，因此父层重渲染不会复制一份草稿
  return props.open && props.profile ? (
    <EditConnectionProfileForm key={props.profile.profileId} {...props} profile={props.profile} />
  ) : null;
}

function EditConnectionProfileForm({
  open,
  profile,
  source,
  management,
  onOpenChange,
  onSaved,
  focusField,
}: EditConnectionProfileDialogProps & { profile: ConnectionProfile }) {
  const { intl } = useZCodeIntl();
  // 编辑态复用新建向导的表单状态所有者，线路类型直接取已保存连接的 transport，用户不能在这里改线路
  // isWindowsDesktop 只在 transport 为 wsl 时为真：其他线路必须整条跳过 WSL 发现，否则会在非 Windows 环境发起无用探测
  // preserveDraftOnOpen 恒为 true，打开时不重置草稿；真正的字段回填由下面的 initializeFields 负责
  // [权衡] hook 打开与回填 effect 都会写 host 与 port，必须让 hook 先落默认值、回填后覆盖；顺序反了会被默认值抹掉
  // savedSshConfigAlias 从 profile 取出，用于让已保存但不在当前列表里的别名继续保持选中
  // 只在 SSH 线路下传 savedSshConfigAlias，其余线路传 undefined，避免把别名语义泄漏到 WSL 与 Docker
  const form = useRemoteConnectionForm({
    open,
    isWindowsDesktop: profile.transport === "wsl",
    preferredKind: profile.transport,
    preserveDraftOnOpen: true,
    savedSshConfigAlias: profile.target.kind === "ssh" ? profile.target.sshConfigAlias : undefined,
  });
  const {
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
  } = form;
  // 展示名与设备名是仅有的两个不归 hook 管的字段，因为它们是连接元数据而不是连接目标
  // displayName 缺失时回退成线路标识，保证输入框永远不空、保存时不需要额外兜底
  // [权衡] 初值只在挂载时读一次 profile；父层刷新同一条连接不会回写，避免覆盖用户正在编辑的名称
  // deviceName 只对来源服务器场景有意义，无 source 时置空且渲染阶段整块省略
  // 两者都用受控输入加 trim 后提交，state 保留用户原始输入以维持光标位置稳定
  // 名称必填校验放在 handleSave 里而不是这里，保证只在提交时打扰用户
  // 这里刻意不引入脏标记：是否修改由提交值与 profile 的差异隐式决定
  const [name, setName] = useState(profile.displayName ?? profile.transport);
  const [deviceName, setDeviceName] = useState(source?.displayName ?? "");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState("");
  // 0 表示尚未保存；每次字段校验失败递增，用于显示内联错误并聚焦第一个出错字段。
  const [validationAttempt, setValidationAttempt] = useState(0);
  const formRef = useRef<HTMLFormElement | null>(null);
  // 与新建向导共用校验规则；已保存密码的 SSH 连接允许密码留空沿用原凭据。
  const fieldErrors = collectRemoteFormFieldErrors(
    intl,
    {
      kind: profile.transport,
      host,
      port,
      username,
      sshAuthMethod,
      password: password.trim(),
      privateKeyPath,
      privateKeyPassphrase,
      wslDistro,
      wslUser,
      dockerContainer,
      manualDockerContainer,
    },
    {
      passwordOptional:
        profile.target.kind === "ssh" && Boolean(profile.target.passwordCredentialKey),
    },
  );
  useEffect(() => {
    if (validationAttempt === 0) return;
    // Bugfix: 从「修改主机/认证」入口打开时，focusField 会让主机或密码一直带 aria-invalid 作为提示，
    // 只按 aria-invalid 查找会把焦点给被提示的字段而不是真正出错的字段。
    // 只有存在校验错误的字段才会关联 aria-describedby，因此用两者同时成立来定位第一个出错字段。
    // validationAttempt 为 0 表示从未校验，直接跳过，避免首次挂载就抢焦点
    // 每次校验失败递增计数，effect 因此重跑；这是命令式聚焦与声明式状态之间的桥
    // 选择器同时要求 aria-invalid 与 aria-describedby：前者表示字段有错，后者表示错误文案已经挂到该字段
    // [权衡] 只按 aria-invalid 会把焦点送给从修改入口带进来的提示字段，用户按回车后仍停在提示项上
    // 只取第一个匹配节点，字段顺序与 collectRemoteFormFieldErrors 的必填顺序一致
    // 找不到匹配节点时静默不聚焦，不抛错：顶部错误条已经足以说明问题
    // 弹窗本身是滚动容器，focus 后浏览器会自行把目标滚入视野，这里不需要额外滚动
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"][aria-describedby]')?.focus();
  }, [validationAttempt]);
  // 回填只在 profileId 变化时执行一次，字段来源是已保存的 profile，而不是当前表单
  // 用 useEffectEvent 读取最新的 form 与 profile，避免把整个 form 对象塞进依赖导致每次输入都重跑回填
  // SSH 分支先写 host、port、username，再让 sshConfigAlias 走 applySshConfigAlias 统一重建别名关联字段
  // [事务] 别名应用必须排在基础字段之后：applySshConfigAlias 会整组覆盖主机与端口，顺序颠倒会让用户看到别名生效前的值
  // 认证方式由 privateKeyPath 是否存在推导，不额外保存一个认证方式字段，避免两处状态互相矛盾
  // assetInstallMode 缺失时回落到默认安装方式，保证老 profile 不会提交空值
  // WSL 与 Docker 分支各自只写本线路字段，其他线路字段保持 hook 默认值，不会串线
  const initializeFields = useEffectEvent(() => {
    if (profile.target.kind === "ssh") {
      form.setHost(profile.target.host);
      form.setPort(String(profile.target.port ?? 22));
      form.setUsername(profile.target.username);
      form.setSshAuthMethod(profile.target.privateKeyPath ? "privateKey" : "password");
      form.setPrivateKeyPath(profile.target.privateKeyPath ?? "");
      if (profile.target.sshConfigAlias)
        form.applySshConfigAlias({
          alias: profile.target.sshConfigAlias,
          host: profile.target.host,
          port: profile.target.port ?? 22,
          username: profile.target.username,
          privateKeyPath: profile.target.privateKeyPath,
        });
      form.setAssetInstallMode(
        profile.target.assetInstallMode ?? DEFAULT_REMOTE_ASSET_INSTALL_MODE,
      );
    } else if (profile.target.kind === "wsl") {
      form.setWslDistro(profile.target.distro ?? "");
      form.setWslUser(profile.target.user ?? "");
    } else {
      form.setManualDockerContainer(profile.target.container);
    }
  });
  useEffect(() => {
    initializeFields();
  }, [profile.profileId]);
  const handleSave = async () => {
    if (savingRef.current) return;
    const normalizedName = name.trim();
    if (!normalizedName) {
      setError(intl.formatMessage({ id: "settings.source.connectionNameRequired" }));
      return;
    }
    if (source && !deviceName.trim()) {
      setError(intl.formatMessage({ id: "settings.source.deviceNameRequired" }));
      return;
    }

    // 字段级校验先于提交执行，任何一条不过就直接返回，不发出请求
    // 进入该分支时清空顶部错误条：细节已经渲染到各字段下方，顶部再写一遍会让同一问题出现两次
    // 递增 validationAttempt 而不是立刻聚焦，等错误文案真正渲染完成后由 effect 定位
    // [权衡] 校验结果在渲染期算出而非提交时现算，因此提交读到的就是用户当前看到的同一份错误集合
    // 空端口与沿用已保存密码的场景已由端口规则和 passwordOptional 放行，不会误判成必填缺失
    // 该分支不设置 saving，也不进入 finally，表单保持可编辑供用户直接修正
    // 错误集合的顺序决定聚焦落点，改动 collectRemoteFormFieldErrors 的追加顺序会直接改变焦点位置
    if (fieldErrors.length > 0) {
      // 字段错误显示在字段下方（RDUX-27），顶部错误条只留给名称和保存失败。
      setError("");
      setValidationAttempt((attempt) => attempt + 1);
      return;
    }

    let target;
    if (profile.target.kind === "ssh") {
      // 端口在这里再做一次与校验同源的归一：空串按 22，非空直接转数值
      // [失败路径] 能走到这里说明端口规则已经放行，Number 不会得到 NaN 或越界值；若校验被放宽，这里会静默提交 0
      // 校验阶段按 trim 后的值判断，这里也必须 trim，两处读的必须是同一个字符串
      // 提交的是数字而不是字符串，与 RemoteTarget 的端口类型对齐，省掉服务端的一次转换
      // resourcePackages 原样透传，表单不提供编辑入口，保存时不能把它丢掉
      // 只有密码认证且确实填了密码才带 password 字段，其余情况交给服务端沿用原凭据
      const normalizedPort = Number(port.trim() || "22");
      target = {
        kind: "ssh" as const,
        host: host.trim(),
        port: normalizedPort,
        username: username.trim(),
        assetInstallMode,
        ...(form.selectedSshConfigAlias ? { sshConfigAlias: form.selectedSshConfigAlias } : {}),
        ...(profile.target.resourcePackages
          ? { resourcePackages: profile.target.resourcePackages }
          : {}),
        ...(sshAuthMethod === "password" && password.trim() ? { password: password.trim() } : {}),
        ...(sshAuthMethod === "privateKey"
          ? {
              privateKeyPath: privateKeyPath.trim(),
              ...(privateKeyPassphrase.trim()
                ? { privateKeyPassphrase: privateKeyPassphrase.trim() }
                : {}),
            }
          : {}),
      };
    } else if (profile.target.kind === "wsl") {
      target = {
        kind: "wsl" as const,
        ...(wslDistro.trim() ? { distro: wslDistro.trim() } : {}),
        ...(wslUser.trim() ? { user: wslUser.trim() } : {}),
      };
    } else {
      target = {
        kind: "docker" as const,
        container: (manualDockerContainer || dockerContainer).trim(),
      };
    }

    // [并发] ref 先行、state 后置：同一事件循环内的第二次点击会在守卫处被 ref 拦住，而 setSaving 尚未生效
    // 只依赖 saving state 不够，React 的批处理会让两次点击都读到 false
    // 发请求前清空错误，保证失败信息只属于本次提交
    // [资源] finally 必须同时复位 ref 与 state，否则一次异常会让对话框永久停在保存中
    // 提交期间 fieldset 与两个按钮同时 disabled，键盘回车也无法再次触发 onSubmit
    // 关闭动作另由 savingRef 拦截，这里不复用 saving state，因为关闭回调在渲染之外执行
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      await management.updateProfile({
        profileId: profile.profileId,
        profileDisplayName: normalizedName,
        ...(source && deviceName.trim() !== source.displayName
          ? { sourceDisplayName: deviceName.trim() }
          : {}),
        ...(profile.target.kind === "ssh" ? { sshAuthMethod } : {}),
        target,
      });
      onSaved?.();
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      // [失败路径] 保存进行中一律拒绝关闭，点遮罩或按 Esc 都不会让请求与界面脱节
      // 该守卫只拦关闭，不拦打开：父层把 open 从 false 改成 true 仍能正常进入
      // 用 ref 而不是 saving state，避免把渲染期的值闭包进回调导致判断滞后一帧
      // 取消按钮走同一条 onOpenChange，因此保存中点取消同样被拦截，不会留下半提交状态
      // [权衡] 这里没有未保存修改的二次确认：草稿由 preserveDraftOnOpen 保留，重开后可以继续，加确认框反而多一次打断
      // 若产品后续要求放弃确认，必须同时覆盖 Esc、遮罩与取消按钮三条入口，只改一处会留下可绕过的路径
      onOpenChange={(next) => {
        if (!savingRef.current) onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-lg gap-0 overflow-y-auto p-0">
        <form
          ref={formRef}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void handleSave();
          }}
        >
          <DialogHeader className="border-b border-border px-5 py-4 pr-14">
            <div className="flex items-center gap-2">
              <DialogTitle className="text-ui-lg font-semibold">
                {intl.formatMessage({ id: "settings.source.editConnectionTitle" })}
              </DialogTitle>
              <RemoteConnectionKindTag kind={profile.transport} />
            </div>
            <DialogDescription className="text-ui-sm">
              {intl.formatMessage({ id: "settings.source.editConnectionDescription" })}
            </DialogDescription>
          </DialogHeader>
          <fieldset disabled={saving} className="min-w-0 space-y-4 px-5 py-4">
            <div className="space-y-1.5">
              <label htmlFor="edit-connection-name" className="text-ui-sm font-medium">
                {intl.formatMessage({ id: "settings.source.connectionName" })}
              </label>
              <Input
                id="edit-connection-name"
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </div>
            {source ? (
              <div className="space-y-1.5">
                <label htmlFor="edit-device-name" className="text-ui-sm font-medium">
                  {intl.formatMessage({ id: "settings.source.deviceName" })}
                </label>
                <Input
                  id="edit-device-name"
                  value={deviceName}
                  onChange={(event) => setDeviceName(event.currentTarget.value)}
                />
              </div>
            ) : null}
            <RemoteConnectionFields
              {...form}
              kind={profile.transport}
              runtimeOptionsLoading={form.currentRuntimeOptionsLoading}
              focusField={focusField}
              fieldErrors={validationAttempt > 0 ? fieldErrors : []}
              passwordPlaceholder={
                profile.target.kind === "ssh" && profile.target.passwordCredentialKey
                  ? intl.formatMessage({ id: "settings.source.keepSavedSecret" })
                  : undefined
              }
              privateKeyPassphrasePlaceholder={
                profile.target.kind === "ssh" && profile.target.privateKeyPassphraseCredentialKey
                  ? intl.formatMessage({ id: "settings.source.keepSavedSecret" })
                  : undefined
              }
            />
            {error ? (
              <p
                role="alert"
                className="rounded-md bg-destructive-surface px-3 py-2 text-ui-sm text-destructive-surface-foreground"
              >
                {error}
              </p>
            ) : null}
          </fieldset>
          <DialogFooter className="border-t border-border px-5 py-3">
            <Button
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button type="submit" disabled={saving} aria-busy={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              {intl.formatMessage({ id: saving ? "common.saving" : "common.saveChanges" })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
