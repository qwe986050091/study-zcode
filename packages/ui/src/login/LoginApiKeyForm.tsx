// LoginApiKeyForm.tsx —— Welcome 页 API Key 登录的唯一表单：provider 选择、密钥输入、保存与跳过两条提交路径、错误提示与按钮禁用策略
// INV-01 明文密钥只存在于本组件内存，除 createPersonalProvider 交给 provider 服务持久化外不在本文件写任何存储；守住位置：apiKeyValue 这一个 state；改错故障：密钥被写进其它页面可读的本地存储，卸载后仍留在内存快照里
// INV-02 输入框 type 必须为 password 且 autoComplete 必须为 off；守住位置：Input 的这两个属性；改错故障：密钥明文回显在屏幕上，或被浏览器密码管理器收进自动填充列表
// INV-03 提交前必须对输入做一次 trim，去空白后为空直接报 emptyError 并中止；守住位置：saveApiKeyProvider 的前两行；改错故障：从剪贴板带换行粘贴的密钥原样送出，服务端鉴权失败，用户被告知密钥无效
// INV-04 回车提交与主按钮可点必须同源：去空白后非空且在途标志为假；守住位置：输入框的 onKeyDown 条件与继续按钮的 disabled；改错故障：按钮灰着而回车仍发出请求，或反过来回车毫无反应
// INV-05 busy 为 saving、skipping 的或运算，任一在途时必须同时禁用 provider 选择、取消、跳过与获取密钥链接；守住位置：busy 定义与四处 disabled；改错故障：保存未落盘时点了跳过，域设置覆盖刚建好的 provider，登录后凭据与模型列表对不上
// INV-06 saving 与 skipping 必须各自独立复位，且只在各自的 finally 里置假；守住位置：两个提交函数的 finally；改错故障：其中一条失败后按钮永久转圈，用户只能重启应用
// INV-07 保存成功必须先写登录态再 await onSaved；守住位置：saveApiKeyProvider 的连续两条语句；改错故障：界面已切到主界面而 store 仍认为未登录，首轮对话落到默认 provider 上
// INV-08 默认模型偏好取新建 providerId 下的第一个模型，拿不到时允许为空；守住位置：buildLoginApiKeyDefaultModelPreferenceFromSelection 的调用；改错故障：偏好指向别的 provider 的模型，登录后对话发往未配置的端点
// INV-09 保存路径必须重新向服务端读一次模板视图，不得复用渲染期的 providerSettingsView；守住位置：保存函数内的 getView；改错故障：视图尚未 ready 时模板被判缺失，用户被提示 provider 不存在
// INV-10 模板存在但鉴权类型不是 API Key 时归入 providerMissingError，绝不换一种鉴权方式继续提交；守住位置：isApiKeyAccess 判定分支；改错故障：密钥被塞进 OAuth 型模板，建出的 provider 永远无法鉴权且不报原因
// INV-11 创建入参只带 templateId 与 access 的类型、密钥两个字段；守住位置：createPersonalProvider 的 initialConfig；改错故障：界面态被一并写进 provider 配置，下游按未知字段解析失败
// INV-12 失败日志只允许出现 templateId 与错误对象；守住位置：保存与跳过两处 logger.error 的入参；改错故障：明文密钥落进日志文件，随日志导出被一并上传
// INV-13 错误文案统一走 i18n 且必须带具体原因；守住位置：三处 setError；改错故障：用户只看到一句保存失败，分不清是密钥错误、网络错误还是模板缺失
// INV-14 错误提示必须渲染在输入区之后、操作按钮之前，并以 destructive 语义承载；守住位置：错误分支的 Alert；改错故障：错误被按钮区挤到下方看不见，或读屏不播报，用户重复点提交
// INV-15 任何一次输入变更都必须清空旧错误；守住位置：输入框 onChange 内的置空；改错故障：用户改完密钥仍看到上一轮错误，误判新密钥同样无效
// INV-16 跳过必须一次写入域、时间戳、已迁移三项设置，且不得触发 API Key 登录成功；守住位置：skipApiKeyProvider 的设置写入；改错故障：只写域不写已迁移标记，下次启动重跑迁移，把用户刚确认的域覆盖回去
// INV-17 跳过失败不得调用 onSkipped，成功也不得写空密钥；守住位置：跳过函数的 try 分支顺序；改错故障：设置写失败而界面已进入下一步，主界面没有任何可用凭据
// INV-18 获取密钥链接只在有 URL 且输入去空白后为空时出现，在途时必须禁用；守住位置：showApiKeyLink 的取值与该按钮的 disabled；改错故障：链接压在已输入内容上遮住末尾字符，或在提交中把用户带离登录页
// INV-19 可见文案与 provider 名称一律经 i18n 或 helper 解析，组件内不硬编码品牌串；守住位置：各处 formatMessage 与 providerLabel；改错故障：中文环境下仍显示英文品牌，与下拉里的选项对不上
import { useState } from "react";
import { isApiKeyAccess } from "@zcode/provider";
import { Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID } from "@zcode/shared";
import {
  TID_LOGIN_API_KEY_CANCEL_BUTTON,
  TID_LOGIN_API_KEY_CONTINUE_BUTTON,
  TID_LOGIN_API_KEY_ERROR,
  TID_LOGIN_API_KEY_INPUT,
  TID_LOGIN_API_KEY_PROVIDER_ITEM,
  TID_LOGIN_API_KEY_PROVIDER_TRIGGER,
  TID_LOGIN_API_KEY_SKIP_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { renderOAuthProviderIcon } from "@/lib/oauthProviderIcon.js";
import {
  buildLoginApiKeyDefaultModelPreferenceFromSelection,
  buildLoginApiKeySkipSettings,
  resolveLoginApiKeyDefaultProvider,
  resolveLoginApiKeyTemplateId,
  resolveLoginApiKeyProviderLabel,
  shouldShowLoginApiKeyLink,
  type ApiKeyProviderChoice,
} from "@/login/LoginApiKeyForm.helpers.js";
import { useZCodeStore } from "@/store/StoreProvider.js";

interface LoginApiKeyFormProps {
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
  onSkipped: () => void | Promise<void>;
}

export function LoginApiKeyForm({ onCancel, onSaved, onSkipped }: LoginApiKeyFormProps) {
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const { modelSelectionService, providerSettingsService, settingService } = useServices();
  const markApiKeyLoginSuccess = useZCodeStore((state) => state.markApiKeyLoginSuccess);
  const [providerChoice, setProviderChoice] = useState<ApiKeyProviderChoice>(() =>
    resolveLoginApiKeyDefaultProvider(locale),
  );
  // 密钥输入的唯一真源，空串表示尚未输入，按钮可点与链接显隐都从它派生
  // 只放组件 state：本文件不写 localStorage、不写 settings，持久化只发生在创建 provider 那一步
  // 不用 defaultValue 走非受控：受控才能做到输入即清错、按钮随内容实时切换可点
  // [权衡] 不回填已保存的密钥：回填会让屏幕与内存各留一份明文，用户也分不清当前值是新输入还是旧值
  // 切换 provider 时保留已输入内容：多数情况是选错了下拉项，清空会逼用户重新粘贴
  // 校验失败时同样不清空：错误提示紧邻输入框，用户改一个字符就能就地重试
  // [资源] 卸载即随 state 释放，成功路径依赖父层卸载本表单，这里不做额外清理动作
  const [apiKeyValue, setApiKeyValue] = useState("");
  // 保存与跳过各持一个在途标志，busy 由二者或运算得出，不另存一个合并态
  // [并发] 分开持有是为了让两个 finally 只复位自己：合并成一个的话，先结束的那条会把仍在途的那条一起放行
  // 提交中保留输入框可编辑：在途请求用的是进入函数时裁出的快照，之后的输入不改变本次提交内容
  // 但 provider 选择、取消、跳过必须锁死：这三者都会改变即将落盘的 provider 域
  // [失败路径] 失败路径也经 finally 复位，不存在失败后按钮一直转圈的分支
  // 按钮文案不变，只用加载图标表达在途：改文案会让宽度跳动，两个按钮上下错位
  // 复位发生在 onSaved 之后，此时父层多已切页，写已卸载组件的 state 不产生副作用
  const [saving, setSaving] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const providerSettingsRead = useProviderSettingsView();
  const providerSettingsView =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;

  const providerLabel = resolveLoginApiKeyProviderLabel(providerChoice);
  const templateId = resolveLoginApiKeyTemplateId(providerChoice);
  const templateAccess = providerSettingsView?.providerTemplates.find(
    (template) => template.templateId === templateId,
  )?.config.access;
  const apiKeyUrl = isApiKeyAccess(templateAccess) ? templateAccess.apiKeyManagementUrl : undefined;
  // 用户已经输入或回填 API Key 后，右侧获取入口会挤占密码输入区域。
  const showApiKeyLink = shouldShowLoginApiKeyLink(apiKeyValue, apiKeyUrl ?? undefined);

  const saveApiKeyProvider = async () => {
    // 去空白只做一次并放在函数入口：空值判断、创建入参、日志都复用这个局部量
    // 从剪贴板粘贴常带行尾换行或首尾空格，原样提交会让服务端判成无效密钥
    // [失败路径] 纯空白串在这里被折成空串，走空值错误分支并直接返回，不发任何网络请求
    // 裁到局部量而不是回写 state：回写会打断光标位置与用户正在编辑的原文
    // 该局部量不进日志、不进错误文案，日志只记 templateId 与错误对象
    // [权衡] 只裁首尾，不删中间空白：密钥本身可能含空格，擅自压缩会把有效密钥改成无效
    // 校验通过后它原样进入创建入参的密钥字段，中间不再做任何转换
    const apiKey = apiKeyValue.trim();
    if (!apiKey) {
      setError(intl.formatMessage({ id: "login.apiKey.emptyError" }));
      return;
    }

    setSaving(true);
    setError(null);
    try {
      // 这里重新向服务端要一次视图，而不是复用渲染期已取到的 providerSettingsView
      // [并发] 渲染期视图可能尚未 ready，也可能是用户改过设置后的旧快照，落盘前必须以新读到的为准
      // 按 templateId 精确匹配，不用下标或首个元素：模板顺序由服务端决定，换序会静默换掉 provider
      // [失败路径] 找不到模板与模板非 API Key 鉴权合并为同一分支，只提示 provider 不存在，不暴露内部模板细节
      // 该分支的提前返回仍会经过 finally，因此在途标志不会被卡在真值
      // 判定统一走 isApiKeyAccess 而不比较字段字符串，鉴权类型的形状变化只在这一处收口
      const template = (await providerSettingsService.getView()).providerTemplates.find(
        (item) => item.templateId === templateId,
      );
      if (!template || !isApiKeyAccess(template.config.access)) {
        setError(
          intl.formatMessage(
            { id: "login.apiKey.providerMissingError" },
            { provider: providerLabel },
          ),
        );
        return;
      }

      // 本表单唯一的凭据写出口，密钥只出现在入参的 access.apiKey 这一处
      // 鉴权类型取自模板自身，避免把 API Key 型凭据塞进别的鉴权形状
      // [事务] 创建成功即视为凭据可用，后续默认模型偏好与登录态都以返回的 providerId 为准
      // [失败路径] 创建抛错时不写登录态、不调用 onSaved，界面停在表单上并展示错误
      // 成功后不在这里清空 apiKeyValue：明文清空依赖父层卸载本表单
      // [权衡] 若调用方改成保留表单不卸载，输入框与 state 里的明文会继续存在，届时必须补一次显式清空
      const created = await providerSettingsService.createPersonalProvider({
        templateId,
        initialConfig: { access: { type: template.config.access.type, apiKey } },
      });
      const defaultModelPreference = buildLoginApiKeyDefaultModelPreferenceFromSelection(
        await modelSelectionService.getView(),
        created.providerId,
      );
      markApiKeyLoginSuccess(defaultModelPreference);
      await onSaved();
    // [失败路径] 错误对象只用来取 message，绝不能把整个入参对象塞进日志，创建入参里含明文密钥
    // 日志固定带 templateId，同一份日志里能区分是哪个 provider 模板失败
    // 文案经 i18n 包装并附上具体原因，用户能分清是密钥问题、网络问题还是模板缺失
    // 非 Error 的抛出物统一字符串化，避免界面出现 undefined 或对象字面量
    // 设错后不清空输入：改一个字符即可重试，不必重新粘贴整串密钥
    // 该分支不再向上抛：恢复职责由表单自己承担，上抛会让整页落进错误边界
    } catch (saveError) {
      logger.error("[LoginEntry] 保存 API Key provider 失败", {
        templateId,
        error: saveError,
      });
      setError(
        intl.formatMessage(
          { id: "login.apiKey.saveError" },
          {
            error: saveError instanceof Error ? saveError.message : String(saveError),
          },
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  const skipApiKeyProvider = async () => {
    setSkipping(true);
    setError(null);
    try {
      // 跳过只表示用户确认当前 provider family 运行域，不能写入空 API Key
      // 或触发 API Key 登录成功事件，否则后续模型选择会误以为已有可用凭据。
      await settingService.update(buildLoginApiKeySkipSettings(providerChoice, Date.now()));
      await onSkipped();
    } catch (skipError) {
      logger.error("[LoginEntry] 跳过 API Key 登录失败", {
        providerChoice,
        error: skipError,
      });
      setError(
        intl.formatMessage(
          { id: "login.apiKey.skipError" },
          {
            error: skipError instanceof Error ? skipError.message : String(skipError),
          },
        ),
      );
    } finally {
      setSkipping(false);
    }
  };

  const busy = saving || skipping;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h2 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "login.apiKey.title" })}
        </h2>
        <div className="space-y-2">
          <div>
            <Select
              value={providerChoice}
              onValueChange={(value) => setProviderChoice(value as ApiKeyProviderChoice)}
              disabled={busy}
            >
              <SelectTrigger
                id="login-api-key-provider"
                size="lg"
                className="h-10 w-full text-ui-base"
                data-testid={TID_LOGIN_API_KEY_PROVIDER_TRIGGER}
                aria-label={intl.formatMessage({
                  id: "login.apiKey.providerLabel",
                })}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end" className="rounded-lg">
                <SelectItem
                  value="zai"
                  className="rounded-md"
                  data-testid={testId(TID_LOGIN_API_KEY_PROVIDER_ITEM, "zai")}
                >
                  {renderOAuthProviderIcon(ZAI_PROVIDER_ID, "size-4")}
                  {intl.formatMessage({ id: "login.apiKey.provider.zai" })}
                </SelectItem>
                <SelectItem
                  value="bigmodel"
                  className="rounded-md"
                  data-testid={testId(TID_LOGIN_API_KEY_PROVIDER_ITEM, "bigmodel")}
                >
                  {renderOAuthProviderIcon(BIGMODEL_PROVIDER_ID, "size-4")}
                  {intl.formatMessage({
                    id: "login.apiKey.provider.bigmodel",
                  })}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="relative">
            <Input
              id="login-api-key"
              // 密码型输入保证密钥在屏幕上不回显，也不会出现在截图与录屏里
              // autoComplete 关闭：不让浏览器把它当账户密码存进自动填充，也不弹已保存凭据的建议
              // [权衡] 关掉自动填充牺牲了便利：密钥是一次性登录动作，宁可让用户粘贴，也不把凭据托管给浏览器
              // 输入框带 id 与 aria-label，读屏靠它对位字段，不依赖可见的 label 节点
              // 粘贴、全选、剪切走原生输入框行为，本组件不拦截，也不额外提供显示密钥的开关
              // 内容变化只走 onChange，受控值不经任何本地缓存，不会出现两份不同步的密钥
              type="password"
              size="lg"
              className={`h-10 w-full text-ui-base ${showApiKeyLink ? "pr-28" : ""}`}
              data-testid={TID_LOGIN_API_KEY_INPUT}
              aria-label={intl.formatMessage({
                id: "login.apiKey.placeholder",
              })}
              value={apiKeyValue}
              placeholder={intl.formatMessage({
                id: "login.apiKey.placeholder",
              })}
              autoComplete="off"
              onChange={(event) => {
                setApiKeyValue(event.target.value);
                setError(null);
              }}
              // 回车提交是与主按钮等价的一条入口，条件必须与按钮的 disabled 完全一致
              // 条件共两项：去空白后非空、在途标志为假；不满足时回车什么都不做
              // 本表单不在 form 内，回车没有原生提交行为，所以这里不需要 preventDefault
              // [并发] 走的是与点击同一个保存函数，在途标志会挡住连按回车造成的第二次提交
              // [权衡] 没有检查输入法组合态标志：密钥是 ASCII，组合态下按回车属极少数路径，代价是可能提交一次未上屏内容
              // 不给回车单独的错误提示：空值回车等同于按钮灰着，禁用态本身就是反馈
              onKeyDown={(event) => {
                if (event.key === "Enter" && apiKeyValue.trim() && !busy) {
                  void saveApiKeyProvider();
                }
              }}
            />
            {showApiKeyLink ? (
              <button
                type="button"
                className="absolute right-3.5 top-1/2 -translate-y-1/2 text-ui-base font-medium text-brand underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                disabled={busy}
                onClick={() => {
                  if (apiKeyUrl) {
                    platform.openExternal(apiKeyUrl);
                  }
                }}
              >
                {intl.formatMessage({ id: "login.apiKey.getApiKey" })}
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {error ? (
        <Alert variant="destructive" data-testid={TID_LOGIN_API_KEY_ERROR}>
          <TriangleAlertIcon className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-2">
        <Button
          type="button"
          className="h-10 w-full text-ui-base"
          size="lg"
          data-testid={TID_LOGIN_API_KEY_CONTINUE_BUTTON}
          // 主按钮可点的充要条件是去空白后非空且在途标志为假，与回车入口同源
          // [失败路径] 用裁剪后的值判断，纯空格不会被当成有效输入放行
          // 保存中保持文案不变、只显示加载图标，按钮宽度因此不抖动
          // [权衡] 不解释禁用原因：条件只有还没输入这一种，在输入框里打字即可解除
          // 该表达式与输入框 onKeyDown 的条件必须同步改动，任何一边放宽都会让两条入口行为分叉
          disabled={!apiKeyValue.trim() || busy}
          onClick={() => void saveApiKeyProvider()}
        >
          {saving ? <Loader2Icon className="size-4 animate-spin" /> : null}
          {intl.formatMessage({ id: "login.apiKey.continue" })}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-10 w-full text-ui-base"
          size="lg"
          data-testid={TID_LOGIN_API_KEY_CANCEL_BUTTON}
          disabled={busy}
          onClick={onCancel}
        >
          {intl.formatMessage({ id: "login.apiKey.cancel" })}
        </Button>
        <Button
          type="button"
          variant="link"
          className="h-7 w-full text-ui-base text-foreground-subtle hover:text-foreground"
          data-testid={TID_LOGIN_API_KEY_SKIP_BUTTON}
          disabled={busy}
          onClick={() => void skipApiKeyProvider()}
        >
          {skipping ? <Loader2Icon className="size-4 animate-spin" /> : null}
          {intl.formatMessage({ id: "login.skip" })}
        </Button>
      </div>
    </div>
  );
}
