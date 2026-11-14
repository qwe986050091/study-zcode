// INV-01 提交前阻止默认跳转：守住位置 提交处理；改错故障 页面整页刷新丢失状态。
// INV-02 提交委托给上层回调：守住位置 事件处理；改错故障 表单自建请求绕过调用方。
// INV-03 表单字段由入参持有：守住位置 受控取值；改错故障 输入回退成非受控。
// INV-04 更新走浅拷贝合入：守住位置 更新函数；改错故障 直接改入参导致状态失真。
// INV-05 更新函数按字段泛型：守住位置 键类型约束；改错故障 写入不存在的字段。
// INV-06 运行中禁用提交按钮：守住位置 禁用属性；改错故障 同一次测速被重复发起。
// INV-07 运行中按钮文案切换：守住位置 条件文案；改错故障 用户不知道是否在跑。
// INV-08 有环境密钥时提示可留空：守住位置 配置判断；改错故障 用户重复粘贴密钥。
// INV-09 密钥输入不明文回显：守住位置 输入类型；改错故障 旁人窥屏即泄露密钥。
// INV-10 密钥输入关闭自动填充：守住位置 自动完成属性；改错故障 浏览器注入历史密码。
// INV-11 数值字段转换为数字：守住位置 事件取值；改错故障 字符串进入请求体。
// INV-12 最大令牌数设下限：守住位置 最小值属性；改错故障 提交零或负值被服务端拒绝。
// INV-13 温度限制在区间内：守住位置 上下限属性；改错故障 越界值导致采样异常。
// INV-14 推理档位限定三档：守住位置 下拉选项；改错故障 非法档位被后端拒绝。
// INV-15 思考开关映射布尔：守住位置 选中值；改错故障 字符串真值被当成开启。
// INV-16 每行输入都有可见标签：守住位置 标签包裹；改错故障 屏幕阅读器读不出字段名。
// INV-17 表单结构保持单一根节点：守住位置 顶层元素；改错故障 提交事件挂不到控件。
// INV-18 组件不持有本地状态：守住位置 纯受控渲染；改错故障 切换测速后残留旧输入。
//
// 模块职责：测速页的新建任务表单，收集模型与采样参数。
// 状态所有权：全部字段由调用方传入，本组件只上抛变更与提交。
// 阅读顺序：先看字段更新与提交，再看头部状态，最后看各输入控件。
import type { FormEvent } from "react";
import type { AppConfig } from "@/shared/types";
import type { RunFormState } from "@/client/api";

// 表单完全受控：字段值只从 props.form 读取，无本地 state。
// 所有字段变更都经 props.onChange() 上抛给调用方。
// submit 先 event.preventDefault()，避免浏览器整页提交。
// props.disabled 为真时按钮禁用并显示「运行中」。
// API key 用 type="password"，且 autoComplete="off"。
export function RunForm(props: {
  config: AppConfig | null;
  disabled: boolean;
  form: RunFormState;
  onChange: (form: RunFormState) => void;
  onSubmit: () => void;
}) {
  // update() 按 key 做浅拷贝合并，写回 props.form。
  // key 受 keyof RunFormState 约束，字段名写错会类型报错。
  // 展开运算符生成新对象，props.form 本身不被修改。
  // 每次 onChange 都换引用，下游 memo 才能感知变化。
  const update = <TKey extends keyof RunFormState>(key: TKey, value: RunFormState[TKey]) => {
    props.onChange({ ...props.form, [key]: value });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    props.onSubmit();
  };

  // 头部按 config.hasEnvApiKey 切换提示语与占位符。
  // number 输入分别设 min=16 与 max=2，temperature 步进 0.1。
  // reasoningEffort 下拉只有 low / medium / high 三档。
  // 每个 input 都嵌在 label 内，点击标题即可聚焦。
  return (
    <form className="panel runForm" onSubmit={submit}>
      <div className="panelHeader">
        <div>
          <h2>新建测速</h2>
          <p>{props.config?.hasEnvApiKey ? "可使用环境变量 API key" : "需要填写 API key"}</p>
        </div>
        <button className="primaryButton" disabled={props.disabled} type="submit">
          {props.disabled ? "运行中" : "开始"}
        </button>
      </div>

      <label>
        <span>API key</span>
        <input
          autoComplete="off"
          placeholder={props.config?.hasEnvApiKey ? "留空使用 DEEPSEEK_API_KEY" : "sk-..."}
          type="password"
          value={props.form.apiKey}
          onChange={(event) => update("apiKey", event.target.value)}
        />
      </label>

      <div className="fieldGrid">
        <label>
          <span>Model</span>
          <input value={props.form.model} onChange={(event) => update("model", event.target.value)} />
        </label>
        <label>
          <span>Base URL</span>
          <input
            value={props.form.baseUrl}
            onChange={(event) => update("baseUrl", event.target.value)}
          />
        </label>
      </div>

      <div className="fieldGrid compact">
        <label>
          <span>Reasoning</span>
          <select
            value={props.form.reasoningEffort}
            onChange={(event) =>
              update("reasoningEffort", event.target.value as RunFormState["reasoningEffort"])
            }
          >
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
        </label>
        <label>
          <span>Max tokens</span>
          <input
            min={16}
            type="number"
            value={props.form.maxTokens}
            onChange={(event) => update("maxTokens", Number(event.target.value))}
          />
        </label>
        <label>
          <span>Temperature</span>
          <input
            max={2}
            min={0}
            step={0.1}
            type="number"
            value={props.form.temperature}
            onChange={(event) => update("temperature", Number(event.target.value))}
          />
        </label>
      </div>

      <label className="checkboxRow">
        <input
          checked={props.form.thinkingEnabled}
          type="checkbox"
          onChange={(event) => update("thinkingEnabled", event.target.checked)}
        />
        <span>thinking enabled</span>
      </label>

      <label>
        <span>System</span>
        <textarea
          rows={2}
          value={props.form.systemPrompt}
          onChange={(event) => update("systemPrompt", event.target.value)}
        />
      </label>
      <label>
        <span>User</span>
        <textarea
          rows={4}
          value={props.form.prompt}
          onChange={(event) => update("prompt", event.target.value)}
        />
      </label>
    </form>
  );
}
