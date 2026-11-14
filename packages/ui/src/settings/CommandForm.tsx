// 命令表单：新建或编辑用户自定义斜杠命令，管理名称、描述、参数提示、提示词与作用域。
// 受控字段全部保存在组件本地 state，提交前由 validate 统一校验，再交给 onSave 落盘。
// 编辑态锁定名称与作用域，删除入口只在 initial 与 onDelete 同时存在时渲染。
// 全部可见文案走 intl 消息 id，视觉结构复用设置页既有的标签、文本域与动作区组件。
// INV-01 名称只允许字母数字下划线与连字符；守住位置：NAME_REGEX 常量与 validate 的名称分支；改错故障：带点号或斜杠的命令名被接受并写入配置，运行时找不到对应命令文件。
// INV-02 名称长度落在 1 至 50 之间；守住位置：MIN_NAME_LENGTH 与 MAX_NAME_LENGTH 及长度校验分支；改错故障：超长名称保存后列表项被截断、索引键相互覆盖。
// INV-03 提示词非空是保存的硬门槛；守住位置：canSave 计算与 validate 的 prompt 分支；改错故障：空提示词命令被提交，调用时模型收到空指令。
// INV-04 编辑态名称不可修改；守住位置：名称输入框的 disabled 绑定 initial；改错故障：改名后旧命令文件残留，新旧两份同时生效。
// INV-05 编辑态作用域不可切换；守住位置：CommandScopeMenu 的 disabled 与 initial 布尔化；改错故障：保存落到另一作用域，原作用域命令凭空消失。
// INV-06 名称字段只保存去掉前导斜杠后的裸名；守住位置：initialName 的正则替换与 handleSubmit 的 trim；改错故障：重复斜杠前缀让注册名与文件名不一致。
// INV-07 提交值必须去掉首尾空白；守住位置：handleSubmit 组装 config 时对各字段 trim；改错故障：尾部空格进入配置，命令名匹配失败。
// INV-08 空的可选字段不写入配置而保留 undefined；守住位置：description 与 argumentHint 的空串转 undefined；改错故障：配置文件出现空字符串键，导出对比产生噪声差异。
// INV-09 保存按钮可用性由当前输入即时推导；守住位置：canSave 布尔表达式；改错故障：非法输入仍可点击保存，用户拿到延迟出现的错误。
// INV-10 保存或删除进行中禁用全部动作；守住位置：saving 传入三个按钮的 disabled；改错故障：连点产生两次 onSave，配置被写两遍或删除出现竞态。
// INV-11 校验失败不触发 onSave；守住位置：handleSubmit 中 validate 返回假值的提前返回；改错故障：无效配置落盘，列表刷新后仍显示错误项。
// INV-12 名称错误与提示词错误分别独立存放；守住位置：nameError 与 promptError 两个 state；改错故障：一次提交只显示一条错误，用户反复试错。
// INV-13 编辑态跳过名称合法性校验；守住位置：validate 首个 initial 分支；改错故障：历史遗留的非法名称在只改提示词时被永久拦截。
// INV-14 校验文案随当前语言实时生成；守住位置：validate 内每次 intl 消息格式化；改错故障：切换语言后错误仍是旧语种文本。
// INV-15 取消不写入任何配置；守住位置：取消按钮直连 onCancel；改错故障：用户误以为取消会保存草稿，实际修改丢失且无提示。
// INV-16 删除只对已存在命令开放；守住位置：leadingAction 对 initial 与 onDelete 的联合判断；改错故障：新建态渲染删除按钮，点击后无目标可删。
// INV-17 描述与参数提示的输入不参与必填判定；守住位置：canSave 与 validate 均未引用二者；改错故障：把可选项误当必填，保存按钮永久置灰。
// INV-18 提交依赖事件对象的默认行为拦截；守住位置：handleSubmit 首行；改错故障：表单原生提交刷新页面，未保存内容全部清空。
import { useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";
import { type CommandAgentSource, type CommandConfig, type UserCommand } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { SettingsFormActions } from "@/settings/SettingsFormActions.js";
import { PluginScopeMenu } from "@/settings/PluginScopeMenu.js";
import type { ConfigWorkspaceTarget } from "@/workspace-config-catalog/index.js";

// 【不变量】命令名只允许字母、数字、下划线与连字符，点号与斜杠会破坏文件名映射。
// 【设计权衡】NAME_REGEX 用白名单而非黑名单，新增非法字符时无需逐个补充排除规则。
const NAME_REGEX = /^[a-zA-Z0-9_-]+$/;
const MIN_NAME_LENGTH = 1;
const MAX_NAME_LENGTH = 50;

// 【设计权衡】字段标签抽成局部组件，保证五个字段的行高、字重与下间距完全一致。
function CommandFormFieldLabel({ children }: { children: string }) {
  return (
    <label className="mb-1 block text-ui-base font-medium text-foreground-subtle">{children}</label>
  );
}

// 【不变量】作用域选择器只接收 scopeKey 与变更回调，不持有第二份作用域状态。
// 【资源生命周期】PluginScopeMenu 由父级重渲染驱动，内部不缓存 workspaceTabs 快照。
// 【失败路径】disabled 为真时选择菜单只读，点击不会触发 onChange 回调。
function CommandScopeMenu({
  disabled,
  scopeKey,
  workspaceTabs,
  onChange,
}: {
  disabled: boolean;
  scopeKey: string;
  workspaceTabs: ConfigWorkspaceTarget[];
  onChange: (scopeKey: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const scopeLabel = intl.formatMessage({ id: "settings.scope.label" });

  return (
    <label className="flex min-w-0 flex-wrap items-center justify-end gap-2">
      <span className="shrink-0 text-ui-base text-foreground-subtle">{scopeLabel}</span>
      <PluginScopeMenu
        align="end"
        disabled={disabled}
        selectedScopeKey={scopeKey}
        workspaceTabs={workspaceTabs}
        onScopeKeyChange={onChange}
      />
    </label>
  );
}

// 【不变量】保存回调同时携带 config 与 scopeKey，作用域随一次提交原子传递。
// 【并发/事务】onSave 返回 Promise，调用方负责串行化，表单本身不排队也不重试。
// 【失败路径】onDelete 为可选，缺省时编辑态不提供删除入口。
interface CommandFormProps {
  initial?: UserCommand;
  agentSource?: CommandAgentSource;
  scopeKey: string;
  workspaceTabs: ConfigWorkspaceTarget[];
  onScopeKeyChange: (scopeKey: string) => void;
  onSave: (config: CommandConfig, scopeKey: string) => Promise<void>;
  onCancel: () => void;
  onDelete?: (command: UserCommand) => void;
  saving: boolean;
}

// 【资源生命周期】字段状态在挂载时由 initial 快照初始化，之后不再回读 props。
// 【设计权衡】草稿只存在于 CommandForm 本地，避免与服务端配置形成双写。
// 【不变量】saving 由外部注入，组件不自行推导提交中状态。
// 【失败路径】initial 变化不会重置已输入内容，父级应以 key 重建表单。
export function CommandForm({
  initial,
  scopeKey,
  workspaceTabs,
  onScopeKeyChange,
  onSave,
  onCancel,
  onDelete,
  saving,
}: CommandFormProps) {
  const { intl } = useZCodeIntl();
  const supportsArgumentHint = true;
  // 【不变量】展示名与存储名的差异仅限一个前导斜杠。
  // 【失败路径】名称缺失或为空时回退为空串，新建表单从空白开始。
  // 【设计权衡】去斜杠只在生成 initialName 时做一次，输入过程中不再过滤，否则光标会跳到行尾。
  const initialName = initial?.name?.replace(/^\//, "") ?? "";
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initial?.description ?? "");
  const [argumentHint, setArgumentHint] = useState(initial?.argumentHint ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [nameError, setNameError] = useState<string | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  // 【不变量】canSave 与 handleSubmit 共用同一 trim 规则，判定与实际写入一致。
  // 【失败路径】纯空白名称 trim 后为空，长度校验直接判失败。
  const trimmedName = name.trim();
  // 【不变量】新建态要求名称合法且提示词非空，编辑态只需提示词非空。
  // 【设计权衡】可用性预判只做廉价计算，完整文案校验留给提交时的 validate。
  // 【失败路径】任一条件为假时保存按钮置灰，用户无法触发无效提交。
  const canSave = Boolean(
    prompt.trim() &&
    (initial ||
      (trimmedName.length >= MIN_NAME_LENGTH &&
        trimmedName.length <= MAX_NAME_LENGTH &&
        NAME_REGEX.test(trimmedName))),
  );

  // 【不变量】validate 只写错误状态并返回布尔，不产生任何外部副作用。
  // 【并发/事务】nameError 按提交次序覆盖，旧错误在下次校验中被清空或替换。
  // 【失败路径】返回假值时 handleSubmit 提前退出，配置不进入 onSave。
  // 【设计权衡】validate 同步执行，避免异步校验与保存按钮之间出现时序窗口。
  const validate = (): boolean => {
    let valid = true;
    const trimmedName = name.trim();
    // 【设计权衡】把模块级 NAME_REGEX 复用到局部 nameRegex，防止每次校验重建正则实例。
    const nameRegex = NAME_REGEX;
    // 命令表单字段曾直接硬编码英文，导致中文界面下校验错误仍显示英文。
    if (initial) {
      setNameError(null);
    // 【不变量】长度越界优先于字符集报错，用户先看到可数的长度提示。
    // 【失败路径】提示文案插入 min 与 max 实参，边界值与常量保持同源。
    } else if (trimmedName.length < MIN_NAME_LENGTH || trimmedName.length > MAX_NAME_LENGTH) {
      setNameError(
        intl.formatMessage(
          { id: "settings.commands.form.validation.nameLength" },
          {
            min: String(MIN_NAME_LENGTH),
            max: String(MAX_NAME_LENGTH),
          },
        ),
      );
      valid = false;
    // 【失败路径】字符集不匹配时给出合法字符说明，不暴露正则本身。
    } else if (!nameRegex.test(trimmedName)) {
      setNameError(
        intl.formatMessage({
          id: "settings.commands.form.validation.nameCharacters",
        }),
      );
      valid = false;
    } else {
      setNameError(null);
    }
    // 【失败路径】提示词为空白时置 promptError 并标记整体校验失败。
    if (!prompt.trim()) {
      setPromptError(
        intl.formatMessage({
          id: "settings.commands.form.validation.promptRequired",
        }),
      );
      valid = false;
    } else {
      setPromptError(null);
    }
    return valid;
  };

  // 【不变量】提交路径唯一，全部写入都经过 onSave 这一个出口。
  // 【并发/事务】等待 onSave 期间组件不解锁按钮，重复提交由 saving 拦截。
  // 【失败路径】onSave 抛错由上层捕获，表单保留当前输入不清空。
  // 【资源生命周期】event 只在同步阶段使用，等待之后不再读取。
  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!validate()) {
      return;
    }
    // 【不变量】config 的四个字段都取 trim 后的快照，提交后不再随输入变化。
    // 【设计权衡】可选字段用空串转 undefined，保持配置文件最小化。
    // 【失败路径】argumentHint 受能力开关控制，关闭时不写入任何值。
    const config: CommandConfig = {
      name: name.trim(),
      prompt: prompt.trim(),
      description: description.trim() || undefined,
      argumentHint: supportsArgumentHint ? argumentHint.trim() || undefined : undefined,
    };
    await onSave(config, scopeKey);
  };
  // 【资源生命周期】scopeSelect 在渲染期构造一次，随表单一起重渲染。
  const scopeSelect = (
    <CommandScopeMenu
      disabled={Boolean(initial)}
      scopeKey={scopeKey}
      workspaceTabs={workspaceTabs}
      onChange={onScopeKeyChange}
    />
  );

  return (
    // 【不变量】表单只绑定 onSubmit，回车与点击保存走同一处理函数。
    <form onSubmit={handleSubmit} className="space-y-3 rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="w-full min-w-0 space-y-1.5 md:w-48">
          <CommandFormFieldLabel>
            {intl.formatMessage({ id: "settings.commands.form.name.label" })}
          </CommandFormFieldLabel>
          <Input
            type="text"
            size="lg"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={intl.formatMessage({
              id: "settings.commands.form.name.placeholder",
            })}
            // 【不变量】名称输入框的只读性完全由 initial 是否存在决定。
            // 【失败路径】只读态仍保留 value 展示，用户能看到但不能改动历史名称。
            disabled={!!initial}
          />
        </div>
        <div>{scopeSelect}</div>
      </div>
      {nameError ? <p className="-mt-1 text-ui-base text-destructive">{nameError}</p> : null}

      <div className="space-y-1.5">
        <CommandFormFieldLabel>
          {intl.formatMessage({
            id: "settings.commands.form.description.label",
          })}
        </CommandFormFieldLabel>
        <Input
          type="text"
          size="lg"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={intl.formatMessage({
            id: "settings.commands.form.description.placeholder",
          })}
        />
      </div>

      {supportsArgumentHint ? (
        <div className="space-y-1.5">
          <CommandFormFieldLabel>
            {intl.formatMessage({
              id: "settings.commands.form.argumentHint.label",
            })}
          </CommandFormFieldLabel>
          <Input
            type="text"
            size="lg"
            value={argumentHint}
            onChange={(event) => setArgumentHint(event.target.value)}
            placeholder={intl.formatMessage({
              id: "settings.commands.form.argumentHint.placeholder",
            })}
          />
        </div>
      ) : null}

      <div className="space-y-1.5">
        <CommandFormFieldLabel>
          {intl.formatMessage({ id: "settings.commands.form.prompt.label" })}
        </CommandFormFieldLabel>
        <SettingsFormTextarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={5}
          className="min-h-28 text-ui-base"
          placeholder={intl.formatMessage({
            id: "settings.commands.form.prompt.placeholder",
          })}
        />
        {promptError ? <p className="text-ui-base text-destructive">{promptError}</p> : null}
      </div>

      <SettingsFormActions
        leadingAction={
          // 【不变量】删除入口需要既有待删对象又有删除处理器，二者缺一即不渲染。
          initial && onDelete ? (
            <Button
              type="button"
              variant="link"
              size="lg"
              className="px-0 text-destructive hover:text-destructive"
              onClick={() => onDelete(initial)}
              disabled={saving}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
              {intl.formatMessage({ id: "common.delete" })}
            </Button>
          ) : undefined
        }
      >
        <Button type="submit" variant="default" size="lg" disabled={!canSave || saving}>
          {saving
            ? intl.formatMessage({ id: "common.saving" })
            : intl.formatMessage({ id: "common.save" })}
        </Button>
        <Button type="button" variant="ghost" size="lg" onClick={onCancel} disabled={saving}>
          {intl.formatMessage({ id: "common.cancel" })}
        </Button>
      </SettingsFormActions>
    </form>
  );
}
