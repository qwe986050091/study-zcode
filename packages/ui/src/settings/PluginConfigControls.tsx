// INV-01 守住位置：entries 长度为 0 时组件函数体在 Hook 之后立即 return null；改错故障：去掉早返回会在设置页留下只有边框的空配置卡片
// INV-02 守住位置：配置项只从 plugin.userConfig 取，缺失时回退空对象；改错故障：直接解构 userConfig 会让未配置过的插件在此处抛错，整块面板白屏
// INV-03 守住位置：所有读值统一走 getValue(plugin, key, option)；改错故障：各分支自行取值会让草稿与已保存值混用，界面显示与实际写入不一致
// INV-04 守住位置：所有写值统一走 onSetDraft，组件内不保存受控输入；改错故障：本地再存一份会让父级草稿落后，保存时丢掉最后一次输入
// INV-05 守住位置：clearButton 只在 canClearOption 为真时生成，为假返回 null；改错故障：改成渲染禁用态会让用户误以为只是暂时不可点
// INV-06 守住位置：canClearOption 同时要求 onClearOption 存在与来源匹配当前 scope 或已在撤销中；改错故障：放宽来源判定会清掉其他作用域的值
// INV-07 守住位置：clearPending 通过可选调用并回退 false；改错故障：父级未提供 isOptionClearPending 时直接调用会抛 TypeError，配置区整体崩掉
// INV-08 守住位置：clearLabel 依据 clearPending 在清理与撤销两套字典 key 之间切换；改错故障：混用会让读屏用户听到与当前按钮功能相反的描述
// INV-09 守住位置：清理按钮回传取反后的 clearPending；改错故障：去掉取反会让第二次点击继续请求清理，撤销路径彻底失效
// INV-10 守住位置：isSaving 只认 activeOperations 中 id 为 plugin:configure 拼接插件 id 的操作；改错故障：拼接方式漂移会让保存按钮永远可用，连点覆盖上一次提交
// INV-11 守住位置：isSaving 同时约束输入框、开关、清理按钮与保存按钮；改错故障：漏禁任一控件会在提交在途时被改动，落盘内容与界面不符
// INV-12 守住位置：渲染分支顺序为 sensitive 优先，其次 boolean，最后 number 与 text；改错故障：调换顺序会让密钥退化成普通文本框，明文直接出现在屏幕上
// INV-13 守住位置：输入框类型由 option.type 决定，number 用 number，其余用 text；改错故障：全部渲染成 text 会让数字项的步进与移动端键盘失效
// INV-14 守住位置：option.required 只渲染提示标签，不参与禁用与提交拦截；改错故障：在客户端强拦会让带默认值或继承值的项永远无法保存
// INV-15 守住位置：SettingsScopeBadge 的来源取 optionSources 对应键并回退 default；改错故障：漏掉回退会让徽章收到 undefined，来源展示出错
// INV-16 守住位置：显示名取 option.title 并回退配置键；改错故障：去掉回退会让无标题项渲染成空白标签，用户不知道在改哪一项
// INV-17 守住位置：entries.map 以配置键作为 React key；改错故障：改用索引会让增删项后输入框与密钥显隐状态串位
// INV-18 守住位置：保存按钮位于 entries 长度再次判空的分支内；改错故障：两处判空不一致时会在空列表下露出保存入口，提交空草稿
//
// 模块职责：把单个插件的 userConfig 声明渲染成一组配置控件，按敏感项、布尔项与文本项分流，并在保存与清理操作在途时统一禁用
// 状态所有权：除 revealedSecrets 这一份纯 UI 的明文可见性记录外，取值、草稿与保存全部由父级通过 props 持有，组件不发起请求也不落盘
// 阅读顺序：先看 props 契约与解构，再看 entries 的空态早返回与 isSaving，然后看 map 内逐项计算、可清理判定与三分支渲染，最后看底部保存按钮
import { Eye, EyeOff, RotateCcw, Save, Trash2 } from "lucide-react";
import { useState } from "react";
import type { ZCodePluginInfo, ZCodePluginScope, ZCodePluginUserConfigOption } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsScopeBadge } from "@/settings/SettingsScopeBadge.js";

// 契约入口：八个字段全部由调用方注入，组件自身不发请求也不缓存已保存值
// getValue 是唯一读值入口，可能混合默认值、继承值与草稿，本组件不解释业务含义
// onSetDraft 是唯一写值入口，按插件 id 与配置键定位草稿，写入后仍由上层回流
// onSave 以整个插件为参数，保存粒度是插件而不是单个配置项
interface PluginConfigControlsProps {
  getValue: (
    plugin: ZCodePluginInfo,
    key: string,
    option: ZCodePluginUserConfigOption,
  ) => string | number | boolean;
  isOptionClearPending?: (pluginId: string, key: string) => boolean;
  onClearOption?: (pluginId: string, key: string, clear: boolean) => void;
  onSave: (plugin: ZCodePluginInfo) => void;
  onSetDraft: (pluginId: string, key: string, value: string | number | boolean) => void;
  activeOperations: ReadonlyArray<{ id: string }>;
  plugin: ZCodePluginInfo;
  scope: ZCodePluginScope;
}

// 组件是无状态展示层，解构顺序与 props 声明一致，便于逐项对照契约
// getValue 与 onSetDraft 必须成对传入，只给一侧会造成读写路径不闭环
// [权衡] 读写全部外置换来父级统一处理脏标记与批量保存，代价是每个分支都要透传插件 id 与配置键
export function PluginConfigControls({
  getValue,
  isOptionClearPending,
  onClearOption,
  onSave,
  onSetDraft,
  activeOperations,
  plugin,
  scope,
}: PluginConfigControlsProps) {
  // 文案统一走 intl，不在此处拼中文，保证多语言字典是唯一来源
  // [失败路径] 字典缺少对应 key 时只显示兜底文本而不抛错，排查前先确认 key 已登记
  const { intl } = useZCodeIntl();
  // [资源] 明文可见性只存本地 state 并按配置键记录，组件卸载即丢弃，绝不持久化
  // 默认全部隐藏，敏感项首次渲染即为密码类型，避免截图或录屏泄露
  // [并发] 切换使用函数式更新读取最新快照，连点不会用旧快照覆盖其他键的显隐
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, boolean>>({});
  // 配置项来源只有 plugin.userConfig，缺失时回退空对象，保证后续长度判断与遍历安全
  // [失败路径] 直接解构 userConfig 会让从未配置过的插件在此处抛错，整个设置面板随之消失
  // 遍历顺序沿用对象键顺序，不额外排序，避免保存后列表位置跳动
  const entries = Object.entries(plugin.userConfig ?? {});
  // 空配置直接返回 null，不渲染标题与分隔线，插件行保持紧凑
  // 该早返回位于所有 Hook 调用之后，不破坏 Hook 顺序；改错后果是插件卡片底部留下一块空边框
  if (entries.length === 0) return null;

  // 保存中判定只认 plugin:configure 加插件 id 拼出的那一条操作 id
  // [并发] 同一插件的保存与清理共用该状态，任一在途即整体禁用，避免交错提交互相覆盖结果
  const isSaving = activeOperations.some(
    (operation) => operation.id === `plugin:configure:${plugin.id}`,
  );
  return (
    <div
      className="mt-3 border-t border-border pt-3"
      // 容器带固定 testid 与插件 id，测试据此定位到具体插件块
      // [权衡] 用数据属性而不是 ref 暴露标识，测试与样式解耦，代价是属性改名后测试静默失效
      data-testid="plugin-store-config"
      data-plugin-id={plugin.id}
    >
      <div className="mb-2 text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: "settings.plugins.config.title" })}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {entries.map(([key, option]) => {
          const label = option.title ?? key;
          const value = getValue(plugin, key, option);
          // [事务] 清理是两段式：先进入待清理，clearPending 为真时按钮语义转为撤销
          // 可选调用并以 false 兜底，父级未提供该能力时一律按未清理处理；兜底写反会让所有项一进来就显示撤销图标
          const clearPending = isOptionClearPending?.(plugin.id, key) ?? false;
          // 可清理需同时满足：父级提供 onClearOption、该项来源正好是当前作用域或已在撤销中、且为敏感项或工作区作用域
          // [失败路径] 少了作用域判定会允许清理其他层级的取值，用户的全局配置会被工作区操作抹掉
          // [权衡] 把敏感项与工作区作用域并入同一布尔，是为了让清理入口只出现在真正可恢复的位置
          const canClearOption =
            onClearOption !== undefined &&
            (plugin.optionSources?.[key] === scope || clearPending) &&
            (option.sensitive === true || scope === "workspace");
          const clearLabel = option.sensitive
            ? intl.formatMessage({
                id: clearPending
                  ? "settings.plugins.config.undoClearSecret"
                  : "settings.plugins.config.clearSecret",
              })
            : intl.formatMessage({
                id: clearPending
                  ? "settings.plugins.config.undoRestoreOption"
                  : "settings.plugins.config.restoreOption",
              });
          // 按钮整体由 canClearOption 决定，为假时返回 null 而不是禁用态，避免留下无意义的灰按钮
          // 点击回传取反后的 clearPending，同一按钮承担清理与撤销两种语义，去掉取反会让撤销路径失效
          const clearButton = canClearOption ? (
            <Button
              type="button"
              data-testid="plugin-store-config-clear"
              data-plugin-id={plugin.id}
              data-config-key={key}
              variant={clearPending ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label={clearLabel}
              aria-pressed={clearPending}
              title={clearLabel}
              disabled={isSaving}
              onClick={() => onClearOption?.(plugin.id, key, !clearPending)}
            >
              {clearPending ? (
                <RotateCcw className="size-3.5" aria-hidden="true" />
              ) : (
                <Trash2 className="size-3.5" aria-hidden="true" />
              )}
            </Button>
          ) : null;
          return (
            <label key={key} className="min-w-0 text-ui-base text-foreground">
              <span className="mb-1 flex items-center gap-1 text-foreground-subtle">
                <span className="truncate">{label}</span>
                {option.required ? (
                  <span className="text-warning">
                    {intl.formatMessage({
                      id: "settings.plugins.config.required",
                    })}
                  </span>
                ) : null}
                <SettingsScopeBadge scope={plugin.optionSources?.[key] ?? "default"} />
              </span>
              {option.sensitive ? (
                <div className="flex items-center gap-1">
                  <Input
                    type={revealedSecrets[key] ? "text" : "password"}
                    data-testid="plugin-store-config-input"
                    data-config-key={key}
                    size="sm"
                    className="h-8 min-w-0 flex-1 rounded-lg"
                    value={String(value)}
                    disabled={isSaving}
                    onChange={(event) => onSetDraft(plugin.id, key, event.target.value)}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={intl.formatMessage({
                      id: revealedSecrets[key]
                        ? "settings.plugins.config.hideSecret"
                        : "settings.plugins.config.showSecret",
                    })}
                    title={intl.formatMessage({
                      id: revealedSecrets[key]
                        ? "settings.plugins.config.hideSecret"
                        : "settings.plugins.config.showSecret",
                    })}
                    disabled={isSaving}
                    onClick={() =>
                      setRevealedSecrets((current) => ({
                        ...current,
                        [key]: !current[key],
                      }))
                    }
                  >
                    {revealedSecrets[key] ? (
                      <EyeOff className="size-3.5" aria-hidden="true" />
                    ) : (
                      <Eye className="size-3.5" aria-hidden="true" />
                    )}
                  </Button>
                  {clearButton}
                </div>
              ) : option.type === "boolean" ? (
                <div className="flex h-8 items-center">
                  <Switch
                    data-testid="plugin-store-config-input"
                    data-config-key={key}
                    checked={Boolean(value)}
                    disabled={isSaving}
                    onCheckedChange={(checked) => onSetDraft(plugin.id, key, checked)}
                  />
                  {clearButton}
                </div>
              ) : (
                <div className="flex items-center gap-1">
                  <Input
                    type={option.type === "number" ? "number" : "text"}
                    data-testid="plugin-store-config-input"
                    data-config-key={key}
                    size="sm"
                    className="h-8 min-w-0 flex-1 rounded-lg"
                    value={String(value)}
                    disabled={isSaving}
                    onChange={(event) => onSetDraft(plugin.id, key, event.target.value)}
                  />
                  {clearButton}
                </div>
              )}
            </label>
          );
        })}
      </div>
      {entries.length > 0 ? (
        <div className="mt-2 flex justify-end">
          <Button
            type="button"
            data-testid="plugin-store-config-save"
            data-plugin-id={plugin.id}
            variant="outline"
            size="lg"
            disabled={isSaving}
            // 保存按钮是唯一落盘入口，点击把整个插件交给 onSave，界面不做乐观更新
            // [事务] 禁用它等于冻结本轮全部编辑，因此 isSaving 的判定必须准确
            // 改错后果：在此处顺手清空草稿会让保存失败时用户输入无从恢复
            onClick={() => onSave(plugin)}
          >
            <Save className="size-3.5" aria-hidden="true" />
            {intl.formatMessage({ id: "settings.plugins.config.save" })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
