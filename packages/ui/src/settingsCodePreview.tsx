// settingsCodePreview.tsx —— 设置页「外观」分区：主题模式、UI 字号、代码预览主题与两侧预览卡
// INV-01 双轨主题不交叉：浅色卡只取 lightTheme、深色卡只取 darkTheme，卡片 mode 与 getCodePreviewTheme 的 mode 实参必须同值；守住位置：两处 ThemePreviewCard 的 theme 属性；改错故障：浅色卡渲染深色高亮，用户误判浅色主题未生效
// INV-02 高亮主题一律经 getCodePreviewTheme 按 mode 派生，不允许在卡片处直接读 codePreviewSettings 的任一字段；守住位置：两处 theme 与 themeName 属性；改错故障：将来新增主题维度时其中一张卡静默沿用旧值
// INV-03 active 徽标只由 resolveTheme 的返回值判定，不得写成 theme 是否等于 dark；守住位置：activePreviewMode 与两处 isActive；改错故障：zai-dark 或 system 下两张卡都不显示 active，用户看不到当前生效的是哪一侧
// INV-04 两张预览卡必须同时渲染，不得按当前生效主题条件挂载；守住位置：sm:grid-cols-2 的网格；改错故障：只剩一张卡，用户无法对照浅深配色做选择
// INV-05 两张卡共用同一份 showLineNumbers、wrapLongLines、fontSizePx，禁止在某一侧写死默认值；守住位置：两处卡片属性；改错故障：行号开关只对一侧生效，预览与实际对话代码块不一致
// INV-06 预览字号传入前不得再次取整或钳制，钳制只发生在 commit；守住位置：fontSizePx 属性与 commit 的 nextValue；改错故障：双层钳制边界不同，边界值出现一像素偏差并直接反映到预览
// INV-07 FontSizeInput 只在失焦与回车时提交，输入过程中绝不写回设置；守住位置：onBlur 与 onKeyDown；改错故障：每敲一个字符就写一次设置，持久化与预览重渲染风暴，输入中途被打断
// INV-08 draft 必须允许空串与不完整数字作为中间态，提交时解析失败要回落到当前 value；守住位置：commit 的 Number.isFinite 分支；改错故障：NaN 被写进设置，预览字号变成非法值后整块回退默认样式
// INV-09 数值钳制必须先把 Infinity 与非数分流再取整，不能直接交给 Math.min 与 Math.max；守住位置：commit 的三元表达式；改错故障：NaN 穿过钳制后 setDraft 显示 NaN，输入框永久停在非法文本
// INV-10 每次 setCodePreviewSettings 只携带本次改动的那一个 key，禁止传整份 settings 快照；守住位置：五处 onValueChange 与 onCheckedChange；改错故障：旧闭包覆盖兄弟字段，刚改的浅色主题被行号开关的旧值打回
// INV-11 FontSizeInput 的 key 必须绑定已提交的数值，不能绑定 draft 或省略；守住位置：两处 key 属性；改错故障：外部同步或 storage 事件改了字号后输入框仍显示旧值，用户再提交时用旧值覆盖新值
// INV-12 Escape 只把 draft 还原成当前 value，不触发提交；Enter 只让输入框失焦，由失焦统一提交；守住位置：onKeyDown 的两条分支；改错故障：同一次编辑提交两遍，或取消编辑反而把半截数字写进设置
// INV-13 代码预览字号上下界必须与 MIN_UI_FONT_SIZE_PX、MAX_UI_FONT_SIZE_PX 保持同值；守住位置：代码预览字号控件的 min 与 max；改错故障：两处口径漂移，同一界面里 UI 字号能调到 12 而预览最小 14，用户误以为控件坏了
// INV-14 主题模式下拉的选项来自 THEME_MODES，文案 key 由 settings.themeMode 前缀拼接，两者必须逐项配套；守住位置：SelectContent 的 map；改错故障：新增模式缺词条时下拉直接显示 i18n key，用户看不懂选项
// INV-15 theme 的取值只能来自 Theme 联合类型，onValueChange 的类型断言依赖下拉项与类型同步；守住位置：主题模式 Select 的 value 与 onValueChange；改错故障：出现联合类型外的字符串，resolveTheme 落进 light 兜底，选择深色却显示浅色
// INV-16 预览只吃配置与常量示例，转义、空内容占位、复制失败的提示都不在本文件实现；守住位置：两处卡片只传 theme 与显示参数；改错故障：把用户文本接进预览会同时丢掉转义与占位兜底，出现注入或空白卡片
// INV-17 语言固定为预览组件内建的 typescript，本文件不做语言推断；守住位置：卡片不暴露 language 覆盖点；改错故障：示例代码换成其他语法后高亮错乱却无人察觉，因为调用点没有语言参数
// INV-18 换行与截断由 wrapLongLines 原样透传，本文件不得按容器宽度自行截断或省略；守住位置：两处 wrapLongLines 属性；改错故障：长行被静默截掉，用户以为主题把代码吃掉了
// INV-19 行号与滚动同步由预览组件内部维护，本文件只透传开关，不得在外层新增 overflow 容器；守住位置：两处 showLineNumbers 与卡片外层布局；改错故障：外层滚动容器抢走滚动权，行号列与代码正文在滚动时错位
import type { Theme } from "@/useTheme.js";
import { useState } from "react";
import { resolveTheme } from "@/useTheme.js";
import { Card, CardContent } from "@/components/ui/card.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import {
  getThemeOptionLabel,
  SettingsRow,
  ThemePreviewCard,
  ThemeSelect,
} from "@/settings/SettingsPageParts.js";
import { getCodePreviewTheme } from "@/lib/codePreviewPreferences.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodePreviewSettings } from "@/store/index.js";
import { THEME_MODES } from "@/settings/settingsPageConfig.js";
import { MAX_UI_FONT_SIZE_PX, MIN_UI_FONT_SIZE_PX } from "@/lib/uiFontSize.js";

function FontSizeInput({
  value,
  min,
  max,
  ariaLabel,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  ariaLabel: string;
  onChange: (value: number) => void;
}) {
  // draft 用字符串而不是 number 承载输入：number 存不下 "1."、"-"、"" 这些合法中间态，受控输入会把用户按的键立刻吞掉
  // value 只作为初始值，之后不再随 prop 自动回写；同步靠外层 key 重挂载，见下方 key 的说明
  // 受控值与真实设置分离，使用户能临时输入超出 12 到 20 的数字，再由 commit 决定是否采纳
  // 空串保留为用户主动清空的表示，不在 onChange 里补 0，否则光标会跳到数字右侧
  // [权衡] 不做输入即校验：每敲一个字符就钳制会让 "1" 变成 12，"20" 打到 "2" 就被抬到 12，无法输入两位数
  // 组件重挂载时 draft 丢弃，未提交的编辑不会写回设置，符合失焦提交的语义
  // 该 state 不参与任何 memo 依赖，避免每次击键都让父级设置页重算
  // 若改成受控 number state，输入 "-" 或 "1e" 时 React 会把非法串还原成旧值，用户看到自己打的字被吃掉
  const [draft, setDraft] = useState(String(value));

  // commit 只在失焦与回车两条路径触发，输入过程中不调用，保证一次编辑最多写一次设置
  // 空串先转成 NaN 而不是交给 Number 得到 0：0 会被钳到下限，用户清空输入反而被设成最小字号
  // Number 解析接受 1e3、0x10 这类写法，最终都由钳制收敛到区间内，不会把 1000 原样写进设置
  // 非有限值回落到当前 value，而不是回落默认值：用户误输入不该悄悄改掉已保存的设置
  // 先 round 再 min 与 max，保证 11.6 归到 12、20.4 归到 20，而不是在边界上留下小数
  // 写回 draft 的是钳制后的规范文本，让输入框在失焦后立刻显示真正生效的值
  // [失败路径] 解析失败不走 onChange，仅重排文本，因此不会产生 NaN 写库或预览崩溃
  // 相等判断必须保留：值没变时跳过 onChange，避免无意义的持久化写入与预览重渲染
  const commit = () => {
    const parsed = draft.trim() === "" ? Number.NaN : Number(draft);
    // 这一分支是 NaN 与 Infinity 的唯一闸门，钳制调用本身不会替调用方挡掉非数
    // Math.min 与 Math.max 收到 NaN 会原样返回 NaN，必须先判有限再比较，顺序不可交换
    // Infinity 由解析溢出产生，例如 1e309，落在非有限分支并回落到当前值而不是上限
    // [失败路径] 如果这里漏判，NaN 会经 setDraft 显示成 "NaN"，用户下一次失焦时又被当作文本解析，形成死循环
    // 钳制顺序是先 max 再 min：先抬到下限再压到上限，对倒置区间也不会越界
    // round 放在钳制之前，避免在区间端点上出现 11.5 与 20.5 的取整方向歧义
    // 结果保证是闭区间内的整数，store 与预览都可以直接当作合法字号使用
    // 若把该判断改成 parsed 大于 0，负数与零会被误当作有效值，钳制却看不出来，问题被推迟到持久化层
    const nextValue = Number.isFinite(parsed)
      ? Math.min(max, Math.max(min, Math.round(parsed)))
      : value;
    setDraft(String(nextValue));
    if (nextValue !== value) {
      onChange(nextValue);
    }
  };

  return (
    <div className="relative w-28">
      <Input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={draft}
        aria-label={ariaLabel}
        // 每次击键只更新本地 draft，绝不在此调用 onChange，设置写入留到失焦
        // 直接取 currentTarget 的字符串值而不是转数字，保留用户正在输入的前导零与小数点
        // 输入期间不钳制、不 trim、不过滤非数字字符，让浏览器原生的 number 交互保持可用
        // 受控值来自 draft，所以输入框内容永远与用户最后一次按键一致，不会出现回跳
        // 该回调每次击键触发一次重渲染，但只影响本组件，父级设置页不会因此重算
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          // Enter 不直接提交，而是让输入框失焦，由 onBlur 的统一路径提交，避免两条路径各写一次
          // 若在 keydown 里直接 commit，浏览器随后仍会触发 blur，同一次编辑会提交两遍
          // Escape 必须 preventDefault 再还原 draft：不拦截会让上层 Dialog 把 Esc 当作关闭，设置页整体消失
          // Escape 只丢弃本次编辑，不写回设置，这正是取消语义，和失焦提交形成互补
          // 还原用的是当前 value 而不是默认值，外部已提交的字号不会被取消操作抹掉
          // 其他按键一律放行，不做 preventDefault，否则数字输入、退格与方向键都会被吞
          // 按键判断只分 Enter 与 Escape 两支，其余键不进入该分支，保持分支最小化
          // 这里不读 event.currentTarget.value：提交以 React 状态为准，避免受控输入与 DOM 值在极端情况下不一致
          if (event.key === "Enter") {
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(String(value));
          }
        }}
        className="pr-8 text-right tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-ui-lg text-foreground-subtle">
        px
      </span>
    </div>
  );
}

export function AppearanceSectionContent({
  codePreviewSettings,
  setCodePreviewSettings,
  theme,
  setTheme,
  uiFontSizePx,
  setUiFontSizePx,
}: {
  codePreviewSettings: CodePreviewSettings;
  setCodePreviewSettings: (settings: Partial<CodePreviewSettings>) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  uiFontSizePx: number;
  setUiFontSizePx: (fontSizePx: number) => void;
}) {
  const { intl } = useZCodeIntl();
  // 生效侧判定必须走 resolveTheme：zai-light 与 zai-dark 是独立枚举，直接与 dark 比较会把深色判成浅色
  // system 由 resolveTheme 在渲染时读取系统偏好，本组件不订阅该变化，系统主题切换需要上层重渲染才会更新徽标
  // 该值只服务 isActive 徽标，不参与选择哪张卡的 theme，两者职责分离，不能在别处复用为渲染条件
  // 若把 activePreviewMode 直接传给卡片 theme，system 模式会把两侧都染成同一主题，对比失去意义
  // resolveTheme 是纯函数，每次渲染调用一次即可，不需要 memo，依赖只有 theme
  // 徽标语义是当前应用生效侧，不是用户偏好项，因此不能显示 system 本身
  // [权衡] 不在此处监听系统配色变化：多一个常驻订阅对设置页不划算，徽标只需在打开设置时准确
  // 若后续改为在卡片内各自 resolve，两处可能读到不同的系统偏好，同一屏出现两个 active 标记
  const activePreviewMode = resolveTheme(theme);

  return (
    <>
      <div className="min-w-0 space-y-3">
        <div>
          <h3 className="text-ui-lg font-semibold text-foreground">
            {intl.formatMessage({ id: "settings.appearance.interfaceTitle" })}
          </h3>
          <p className="mt-1 text-ui-base leading-6 text-foreground-subtle">
            {intl.formatMessage({
              id: "settings.appearance.interfaceDescription",
            })}
          </p>
        </div>
        <Card className="border border-border bg-card py-0 shadow-none">
          <CardContent className="space-y-0 px-0">
            <SettingsRow
              label={intl.formatMessage({ id: "settings.themeMode" })}
              description={intl.formatMessage({
                id: "settings.themeModeDescription",
              })}
              control={
                <Select value={theme} onValueChange={(value) => setTheme(value as Theme)}>
                  <SelectTrigger size="lg" className="w-[260px] min-w-0 justify-between">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {THEME_MODES.map(({ mode, icon: Icon }) => (
                      <SelectItem key={mode} value={mode}>
                        <div className="flex items-center gap-2">
                          <Icon className="size-4" />
                          {intl.formatMessage({
                            id: `settings.themeMode.${mode}`,
                          })}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }
            />
            <SettingsRow
              label={intl.formatMessage({ id: "settings.uiFontSize" })}
              description={intl.formatMessage({
                id: "settings.uiFontSizeDescription",
              })}
              control={
                <FontSizeInput
                  // key 绑定的是已提交值，父级字号一变组件就重挂载，draft 用新 value 重新初始化
                  // 没有这个 key，draft 会一直停留在上次输入，外部同步来的字号只改 prop 不改显示
                  // key 不能绑 draft，否则每次击键都换实例，输入框在输入过程中丢焦点
                  // storage 事件或其他窗口改字号时，store 更新触发重渲染，重挂载是本文件唯一的同步手段
                  // [权衡] 重挂载会丢失焦点与选区，这里接受该代价，换取显示值恒等于生效值的强保证
                  // 同样写法出现在代码预览字号控件，两处必须一致，否则其中一个控件会残留旧文本
                  // key 变化时未提交的编辑直接丢弃，等价于放弃编辑，不会把半截数字写回设置
                  // 若改用 effect 同步 draft，会多一次渲染且要先判断焦点，容易在输入中把用户正在打的字覆盖
                  key={uiFontSizePx}
                  min={MIN_UI_FONT_SIZE_PX}
                  max={MAX_UI_FONT_SIZE_PX}
                  value={uiFontSizePx}
                  onChange={setUiFontSizePx}
                  ariaLabel={intl.formatMessage({ id: "settings.uiFontSize" })}
                />
              }
            />
          </CardContent>
        </Card>
      </div>

      <div className="space-y-6">
        <div className="min-w-0 space-y-3">
          <div>
            <h3 className="text-ui-lg font-semibold text-foreground">
              {intl.formatMessage({ id: "settings.appearance.codeTitle" })}
            </h3>
            <p className="mt-1 text-ui-base leading-6 text-foreground-subtle">
              {intl.formatMessage({
                id: "settings.appearance.codeDescription",
              })}
            </p>
          </div>
          <Card className="border border-border bg-card py-0 shadow-none [&_[data-slot=select-trigger]]:w-full">
            <CardContent className="space-y-0 px-0">
              <SettingsRow
                label={intl.formatMessage({ id: "settings.lightTheme" })}
                description={intl.formatMessage({
                  id: "settings.lightThemeDescription",
                })}
                control={
                  <ThemeSelect
                    value={codePreviewSettings.lightTheme}
                    onValueChange={(value) => setCodePreviewSettings({ lightTheme: value })}
                  />
                }
              />
              <SettingsRow
                label={intl.formatMessage({ id: "settings.darkTheme" })}
                description={intl.formatMessage({
                  id: "settings.darkThemeDescription",
                })}
                control={
                  <ThemeSelect
                    value={codePreviewSettings.darkTheme}
                    onValueChange={(value) => setCodePreviewSettings({ darkTheme: value })}
                  />
                }
              />
              <SettingsRow
                label={intl.formatMessage({ id: "settings.showLineNumbers" })}
                description={intl.formatMessage({
                  id: "settings.showLineNumbersDescription",
                })}
                control={
                  <Switch
                    checked={codePreviewSettings.showLineNumbers}
                    onCheckedChange={(checked) =>
                      setCodePreviewSettings({ showLineNumbers: checked })
                    }
                  />
                }
              />
              <SettingsRow
                label={intl.formatMessage({ id: "settings.wrapLongLines" })}
                description={intl.formatMessage({
                  id: "settings.wrapLongLinesDescription",
                })}
                control={
                  <Switch
                    checked={codePreviewSettings.wrapLongLines}
                    onCheckedChange={(checked) =>
                      setCodePreviewSettings({ wrapLongLines: checked })
                    }
                  />
                }
              />
              <SettingsRow
                label={intl.formatMessage({ id: "settings.fontSize" })}
                description={intl.formatMessage({
                  id: "settings.fontSizeDescription",
                })}
                control={
                  <FontSizeInput
                    key={codePreviewSettings.fontSizePx}
                    // 这里的 12 与 20 是代码预览字号的独立区间，和 UI 字号共用同一组数值但不是同一个来源
                    // 与 MIN_UI_FONT_SIZE_PX、MAX_UI_FONT_SIZE_PX 当前恰好同值，改动其一必须同步另一处
                    // 上下界同时出现在 Input 的 min 与 max 属性上，浏览器只做提示，真正钳制在 commit
                    // 输入框声明 number 类型时 min 与 max 不阻止键入越界值，也不会自动回写，因此不能替代 commit 校验
                    // 预览字号上限 20 对应约 1.25 倍基准，超过后代码块行高会挤出卡片固定内边距
                    // 下限 12 与 UI 字号下限一致，避免出现预览文字比界面文字还小的错位观感
                    // 若改成从常量导入，需要同时确认预览侧是否有独立产品区间，否则会顺手缩小可调范围
                    // 该控件除 step 之外没有键盘约束，上下键每次走 1 像素，与 step 的声明一致
                    min={12}
                    max={20}
                    value={codePreviewSettings.fontSizePx}
                    onChange={(fontSizePx) => setCodePreviewSettings({ fontSizePx })}
                    ariaLabel={intl.formatMessage({ id: "settings.fontSize" })}
                  />
                }
              />
            </CardContent>
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          <div>
            <h3 className="text-ui-base font-semibold text-foreground">
              {intl.formatMessage({ id: "settings.previewSectionTitle" })}
            </h3>
            <p className="mt-1 text-ui-base leading-6 text-foreground-subtle">
              {intl.formatMessage({ id: "settings.previewDescription" })}
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <ThemePreviewCard
              mode="light"
              title={intl.formatMessage({ id: "settings.previewLight" })}
              themeName={getThemeOptionLabel(codePreviewSettings.lightTheme)}
              // 浅色卡把 mode 显式写成 light，取值与卡片 mode 必须成对，复制卡片时最容易漏改
              // 派生函数只做 mode 到字段的选择，不做合法性校验，非法主题值会原样进到高亮组件
              // themeName 用 getThemeOptionLabel 单独取，查不到时回退原始值，保证卡片标题不会空白
              // [失败路径] 若把两处 mode 写反，浅色卡会用 darkTheme 渲染，用户改浅色主题时看不到任何变化
              // 深色卡同理必须传 dark 并读取 darkTheme，两处修改要成对进行
              theme={getCodePreviewTheme("light", codePreviewSettings)}
              isActive={activePreviewMode === "light"}
              showLineNumbers={codePreviewSettings.showLineNumbers}
              wrapLongLines={codePreviewSettings.wrapLongLines}
              fontSizePx={codePreviewSettings.fontSizePx}
            />
            <ThemePreviewCard
              mode="dark"
              title={intl.formatMessage({ id: "settings.previewDark" })}
              themeName={getThemeOptionLabel(codePreviewSettings.darkTheme)}
              theme={getCodePreviewTheme("dark", codePreviewSettings)}
              isActive={activePreviewMode === "dark"}
              showLineNumbers={codePreviewSettings.showLineNumbers}
              wrapLongLines={codePreviewSettings.wrapLongLines}
              fontSizePx={codePreviewSettings.fontSizePx}
            />
          </div>
        </div>
      </div>
    </>
  );
}
