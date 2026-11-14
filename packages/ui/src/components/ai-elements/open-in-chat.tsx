"use client";

// OpenInChat：把一段用户查询文本一键外链到 ChatGPT、Claude、Cursor、GitHub、Scira、T3 与 v0 的菜单组件族
// 职责边界：只负责外链 URL 拼装与下拉菜单外观封装，不发起网络请求、不持久化、不感知会话与鉴权状态
// 不负责：query 的来源与长度裁剪（由调用方传入）、菜单开关状态机、外链页面可达性；GitHub 项要求调用方直接传入完整 URL
//
// INV-01 断言：providers 表每个条目都自带 createUrl 与 icon、title 三件套，缺一即类型检查失败 —— 守住它的位置：providers 对象字面量 —— 改错故障：菜单项渲染时读到 undefined 的 title 直接抛错，整块菜单白屏
// INV-02 断言：createUrl 一律返回可直接跳转的完整外链而非裸参数串 —— 守住它的位置：各 provider 的 createUrl 实现 —— 改错故障：href 丢掉域名，点击后跳到本应用内的相对路径 404
// INV-03 断言：查询文本必须经 URLSearchParams 编码后才进入 URL —— 守住它的位置：chatgpt、claude、scira、t3、v0 的 createUrl —— 改错故障：文本含与号或井号时链接被截断，落到对端首页或错误参数
// INV-04 断言：github 的 createUrl 是恒等映射，query 本身已是 URL —— 守住它的位置：github.createUrl —— 改错故障：对完整地址再编码一次，跳转变成本站非法路径
// INV-05 断言：chatgpt 链接固定携带 hints=search —— 守住它的位置：chatgpt.createUrl 内的 URLSearchParams —— 改错故障：对端退化为普通对话，搜索类查询拿不到网页结果
// INV-06 断言：图标是模块级常量元素而非组件引用，全表复用同一批 React 元素 —— 守住它的位置：providers 各项的 icon 字段 —— 改错故障：误当组件渲染或就地补 props，跨实例出现状态串味
// INV-07 断言：上下文默认值为 undefined，判空即可覆盖未挂载与显式空值两种情形 —— 守住它的位置：OpenInContext 的 createContext 入参 —— 改错故障：改用空对象作默认值后判空失效，消费方读到不存在的 query
// INV-08 断言：脱离 OpenIn 使用查询类菜单项必须立即抛错而非降级 —— 守住它的位置：useOpenInContext 的 !context 分支 —— 改错故障：静默退化成空查询，用户点到菜单只打开对端空白会话
// INV-09 断言：contextValue 仅在 query 变化时更换引用 —— 守住它的位置：OpenIn 内的 useMemo 依赖数组 —— 改错故障：每次渲染新建对象，整棵菜单子树跟着无谓重渲染
// INV-10 断言：query 只进上下文，绝不随属性展开落到外层节点 —— 守住它的位置：OpenIn 对 DropdownMenu 的 {...props} 展开 —— 改错故障：query 被当作非法属性写入 DOM，控制台告警且可能泄漏到快照
// INV-11 断言：OpenInContent 的对齐默认 start 但允许调用方覆盖 —— 守住它的位置：DropdownMenuContent 上 align 与 {...props} 的先后次序 —— 改错故障：把展开挪到 align 前面，外部设置的对齐方式全部失效
// INV-12 断言：Item、Label、Separator 只做透传，不读取上下文 —— 守住它的位置：三个纯转发组件的函数体 —— 改错故障：在这类基础件里加入上下文读取，任何未包 Provider 的菜单在渲染期直接抛错
// INV-13 断言：触发器兜底为按钮且必须带 type="button" —— 守住它的位置：OpenInTrigger 的默认 Button —— 改错故障：菜单嵌在表单内时点击顺带提交表单
// INV-14 断言：仅当 children 为 null 或 undefined 才回落默认触发器 —— 守住它的位置：OpenInTrigger 的空值合并回退 —— 改错故障：换成逻辑或后空字符串也被替换，调用方传空节点时出现两个触发器
// INV-15 断言：所有外链同时具备新窗口打开与 rel="noopener" —— 守住它的位置：每个平台项的 a 标签属性 —— 改错故障：被打开页面可经 window.opener 反向改写本应用窗口
// INV-16 断言：外链 href 在渲染期按当前 query 同步计算，不做模块级缓存 —— 守住它的位置：各 OpenIn 平台项的 href 表达式 —— 改错故障：缓存后切换会话仍指向旧查询，用户把错误内容带入对端
// INV-17 断言：菜单行内三段伸缩固定为图标收缩、标题伸展、尾标收缩 —— 守住它的位置：a 内三个 span 与图标的 shrink-0、flex-1 —— 改错故障：长标题把外链图标挤出可视区，菜单宽度抖动
// INV-18 断言：对外导出的组件名与类型名一旦变更即为破坏性改动 —— 守住它的位置：各 export const 与 export type 声明 —— 改错故障：下游按旧名引用编译失败，必须走主版本号才能发布
import { Button } from "../ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.js";
import { cn } from "../lib/utils.js";
import {
  ChevronDownIcon,
  ExternalLinkIcon,
  MessageCircleIcon,
} from "lucide-react";
import type { ComponentProps } from "react";
import { createContext, useContext, useMemo } from "react";

// [契约] 这张表是菜单项的唯一事实来源：新增平台必须同时补齐 createUrl、icon、title，任一缺失都会在类型层暴露
// 各条目的 createUrl 入参都是同一份 query，但语义不同：多数平台视为查询词，github 视为完整地址，cursor 用参数写入
// 不要把这张表改成按需构造的数组或工厂函数：模块级字面量保证图标元素只创建一次，避免每次渲染重建大段 SVG
// icon 字段存的是 React 元素实例而非组件引用，因此不需要也不能在这里给它传属性
// 需要条件性隐藏某个平台时请在消费方过滤，不要在此处增删字段——组件的静态结构依赖键名存在
const providers = {
  // [契约] hints=search 是对端约定的强制搜索开关，去掉后同样的 query 会退化为普通对话并丢失联网结果
  // prompt 交给 URLSearchParams 编码：空格变加号、中文变百分号转义，任何手写字符串拼接都会在对端解析失败
  // 这里刻意保留字面量写法而非抽变量，便于构建期做静态检查与体积裁剪
  // title 同时充当菜单文案与链接的可访问名称，改文案时需一并考虑多语言回退
  // [权衡] 该链接不携带任何账户或来源标记，因此无法从对端回查调用方，这是有意的隐私取舍
  chatgpt: {
    createUrl: (prompt: string) =>
      `https://chatgpt.com/?${new URLSearchParams({
        hints: "search",
        prompt,
      })}`,
    icon: (
      <svg
        fill="currentColor"
        role="img"
        viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg"
      >
        <title>OpenAI</title>
        <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
      </svg>
    ),
    title: "Open in ChatGPT",
  },
  // [契约] 参数名是 q 而非 prompt，对端只认 q；复用聊天类的键名会得到一个空会话
  // 入口固定在新建对话路径上，不要换成已有会话地址，否则用户的查询会追加进别人的历史
  // [失败路径] 对端会静默截断超长文本，前端不做预裁剪是刻意的——裁剪口径属于业务方
  claude: {
    createUrl: (q: string) =>
      `https://claude.ai/new?${new URLSearchParams({
        q,
      })}`,
    icon: (
      <svg
        fill="currentColor"
        role="img"
        viewBox="0 0 12 12"
        xmlns="http://www.w3.org/2000/svg"
      >
        <title>Claude</title>
        <path
          clipRule="evenodd"
          d="M2.3545 7.9775L4.7145 6.654L4.7545 6.539L4.7145 6.475H4.6L4.205 6.451L2.856 6.4145L1.6865 6.366L0.5535 6.305L0.268 6.2445L0 5.892L0.0275 5.716L0.2675 5.5555L0.6105 5.5855L1.3705 5.637L2.5095 5.716L3.3355 5.7645L4.56 5.892H4.7545L4.782 5.8135L4.715 5.7645L4.6635 5.716L3.4845 4.918L2.2085 4.074L1.5405 3.588L1.1785 3.3425L0.9965 3.1115L0.9175 2.6075L1.2455 2.2465L1.686 2.2765L1.7985 2.307L2.245 2.65L3.199 3.388L4.4445 4.3045L4.627 4.4565L4.6995 4.405L4.709 4.3685L4.627 4.2315L3.9495 3.0085L3.2265 1.7635L2.9045 1.2475L2.8195 0.938C2.78711 0.819128 2.76965 0.696687 2.7675 0.5735L3.1415 0.067L3.348 0L3.846 0.067L4.056 0.249L4.366 0.956L4.867 2.0705L5.6445 3.5855L5.8725 4.0345L5.994 4.4505L6.0395 4.578H6.1185V4.505L6.1825 3.652L6.301 2.6045L6.416 1.257L6.456 0.877L6.644 0.422L7.0175 0.176L7.3095 0.316L7.5495 0.6585L7.516 0.8805L7.373 1.806L7.0935 3.2575L6.9115 4.2285H7.0175L7.139 4.1075L7.6315 3.4545L8.4575 2.4225L8.8225 2.0125L9.2475 1.5605L9.521 1.345H10.0375L10.4175 1.9095L10.2475 2.4925L9.7155 3.166L9.275 3.737L8.643 4.587L8.248 5.267L8.2845 5.322L8.3785 5.312L9.8065 5.009L10.578 4.869L11.4985 4.7115L11.915 4.9055L11.9605 5.103L11.7965 5.5065L10.812 5.7495L9.6575 5.9805L7.938 6.387L7.917 6.402L7.9415 6.4325L8.716 6.5055L9.047 6.5235H9.858L11.368 6.636L11.763 6.897L12 7.216L11.9605 7.4585L11.353 7.7685L10.533 7.574L8.6185 7.119L7.9625 6.9545H7.8715V7.0095L8.418 7.5435L9.421 8.4485L10.6755 9.6135L10.739 9.9025L10.578 10.13L10.408 10.1055L9.3055 9.277L8.88 8.9035L7.917 8.0935H7.853V8.1785L8.075 8.503L9.2475 10.2635L9.3085 10.8035L9.2235 10.98L8.9195 11.0865L8.5855 11.0255L7.8985 10.063L7.191 8.9795L6.6195 8.008L6.5495 8.048L6.2125 11.675L6.0545 11.86L5.69 12L5.3865 11.7695L5.2255 11.396L5.3865 10.658L5.581 9.696L5.7385 8.931L5.8815 7.981L5.9665 7.665L5.9605 7.644L5.8905 7.653L5.1735 8.6365L4.0835 10.109L3.2205 11.0315L3.0135 11.1135L2.655 10.9285L2.6885 10.5975L2.889 10.303L4.083 8.785L4.803 7.844L5.268 7.301L5.265 7.222H5.2375L2.066 9.28L1.501 9.353L1.2575 9.125L1.288 8.752L1.4035 8.6305L2.3575 7.9745L2.3545 7.9775Z"
          fillRule="evenodd"
        />
      </svg>
    ),
    title: "Open in Claude",
  },
  // 这是全表唯一用 URL 对象构造地址的条目，写法与其他条目不同但结果等价
  // [权衡] 用对象可避免手工拼接问号与等号，代价是多一次序列化；query 很短，这点开销可忽略
  // 保持与其他条目同名的 createUrl 签名，调用方无需感知实现差异
  cursor: {
    createUrl: (text: string) => {
      // [契约] 这里必须用 searchParams 的 set 写入：同名键会被覆盖，重复参数不会累积到对端
      // 序列化由 URL 对象负责，空格会被编码为百分号形式；绕开该对象直接赋值会丢掉转义
      // [失败路径] text 为空串时仍会生成带空参数的链接，是否拦截由调用方决定，此处不做业务判断
      // 刻意不在模块顶层复用该 URL 实例：URL 可变，复用会让不同渲染互相覆写参数
      const url = new URL("https://cursor.com/link/prompt");
      url.searchParams.set("text", text);
      return url.toString();
    },
    icon: (
      <svg
        version="1.1"
        viewBox="0 0 466.73 532.09"
        xmlns="http://www.w3.org/2000/svg"
      >
        <title>Cursor</title>
        <path
          d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z"
          fill="currentColor"
        />
      </svg>
    ),
    title: "Open in Cursor",
  },
  // [契约] 恒等映射：调用方传入的 query 必须已是完整可跳转地址，这里不做任何拼接
  // [失败路径] 若误把普通文本传进来，浏览器会按相对路径解析，跳到本站 404 而非仓库页
  // 保留 createUrl 形状是为让上层可无差别遍历，不要因为实现简单就省略该字段
  github: {
    createUrl: (url: string) => url,
    icon: (
      <svg fill="currentColor" role="img" viewBox="0 0 24 24">
        <title>GitHub</title>
        <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
      </svg>
    ),
    title: "Open in GitHub",
  },
  // 参数键为 q，与聊天类平台同形；对端不接受 prompt 键，混用只会打开空查询页
  // 图标是多段路径的 SVG，模块级只创建一次，不要按渲染次数复制
  scira: {
    createUrl: (q: string) =>
      `https://scira.ai/?${new URLSearchParams({
        q,
      })}`,
    icon: (
      <svg
        fill="none"
        height="934"
        viewBox="0 0 910 934"
        width="910"
        xmlns="http://www.w3.org/2000/svg"
      >
        <title>Scira AI</title>
        <path
          d="M647.664 197.775C569.13 189.049 525.5 145.419 516.774 66.8849C508.048 145.419 464.418 189.049 385.884 197.775C464.418 206.501 508.048 250.131 516.774 328.665C525.5 250.131 569.13 206.501 647.664 197.775Z"
          fill="currentColor"
          stroke="currentColor"
          strokeLinejoin="round"
          strokeWidth="8"
        />
        <path
          d="M516.774 304.217C510.299 275.491 498.208 252.087 480.335 234.214C462.462 216.341 439.058 204.251 410.333 197.775C439.059 191.3 462.462 179.209 480.335 161.336C498.208 143.463 510.299 120.06 516.774 91.334C523.25 120.059 535.34 143.463 553.213 161.336C571.086 179.209 594.49 191.3 623.216 197.775C594.49 204.251 571.086 216.341 553.213 234.214C535.34 252.087 523.25 275.491 516.774 304.217Z"
          fill="currentColor"
          stroke="currentColor"
          strokeLinejoin="round"
          strokeWidth="8"
        />
        <path
          d="M857.5 508.116C763.259 497.644 710.903 445.288 700.432 351.047C689.961 445.288 637.605 497.644 543.364 508.116C637.605 518.587 689.961 570.943 700.432 665.184C710.903 570.943 763.259 518.587 857.5 508.116Z"
          stroke="currentColor"
          strokeLinejoin="round"
          strokeWidth="20"
        />
        <path
          d="M700.432 615.957C691.848 589.05 678.575 566.357 660.383 548.165C642.191 529.973 619.499 516.7 592.593 508.116C619.499 499.533 642.191 486.258 660.383 468.066C678.575 449.874 691.848 427.181 700.432 400.274C709.015 427.181 722.289 449.874 740.481 468.066C758.673 486.258 781.365 499.533 808.271 508.116C781.365 516.7 758.673 529.973 740.481 548.165C722.289 566.357 709.015 589.05 700.432 615.957Z"
          stroke="currentColor"
          strokeLinejoin="round"
          strokeWidth="20"
        />
        <path
          d="M889.949 121.237C831.049 114.692 798.326 81.9698 791.782 23.0692C785.237 81.9698 752.515 114.692 693.614 121.237C752.515 127.781 785.237 160.504 791.782 219.404C798.326 160.504 831.049 127.781 889.949 121.237Z"
          fill="currentColor"
          stroke="currentColor"
          strokeLinejoin="round"
          strokeWidth="8"
        />
        <path
          d="M791.782 196.795C786.697 176.937 777.869 160.567 765.16 147.858C752.452 135.15 736.082 126.322 716.226 121.237C736.082 116.152 752.452 107.324 765.16 94.6152C777.869 81.9065 786.697 65.5368 791.782 45.6797C796.867 65.5367 805.695 81.9066 818.403 94.6152C831.112 107.324 847.481 116.152 867.338 121.237C847.481 126.322 831.112 135.15 818.403 147.858C805.694 160.567 796.867 176.937 791.782 196.795Z"
          fill="currentColor"
          stroke="currentColor"
          strokeLinejoin="round"
          strokeWidth="8"
        />
        <path
          d="M760.632 764.337C720.719 814.616 669.835 855.1 611.872 882.692C553.91 910.285 490.404 924.255 426.213 923.533C362.022 922.812 298.846 907.419 241.518 878.531C184.19 849.643 134.228 808.026 95.4548 756.863C56.6815 705.7 30.1238 646.346 17.8129 583.343C5.50207 520.339 7.76433 455.354 24.4266 393.359C41.089 331.364 71.7099 274.001 113.947 225.658C156.184 177.315 208.919 139.273 268.117 114.442"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="30"
        />
      </svg>
    ),
    title: "Open in Scira",
  },
  // 这是唯一复用通用图标组件的条目，说明 icon 只要求可渲染节点，不要求自带品牌 SVG
  // 参数键同样为 q，与其他聊天类平台保持一致
  t3: {
    createUrl: (q: string) =>
      `https://t3.chat/new?${new URLSearchParams({
        q,
      })}`,
    icon: <MessageCircleIcon />,
    title: "Open in T3 Chat",
  },
  // 参数键为 q；对端把查询当作生成代码的提示词，不进入搜索模式
  // [契约] 该条图标走 147x70 的异形比例，改动尺寸时请保留原始 viewBox，否则图形被拉伸
  v0: {
    createUrl: (q: string) =>
      `https://v0.app?${new URLSearchParams({
        q,
      })}`,
    icon: (
      <svg
        fill="currentColor"
        viewBox="0 0 147 70"
        xmlns="http://www.w3.org/2000/svg"
      >
        <title>v0</title>
        <path d="M56 50.2031V14H70V60.1562C70 65.5928 65.5928 70 60.1562 70C57.5605 70 54.9982 68.9992 53.1562 67.1573L0 14H19.7969L56 50.2031Z" />
        <path d="M147 56H133V23.9531L100.953 56H133V70H96.6875C85.8144 70 77 61.1856 77 50.3125V14H91V46.1562L123.156 14H91V0H127.312C138.186 0 147 8.81439 147 19.6875V56Z" />
      </svg>
    ),
    title: "Open in v0",
  },
};

// [契约] 上下文只承载 query 一个字段：菜单开关、选中项等状态归下拉组件自己管理，不进入这里
// 默认值取 undefined 而非空对象，让未挂载 Provider 与挂载了但查询为空在类型和运行时都能区分
// 不要在这里塞回调或服务引用：一旦加入，整个菜单子树会随父级重渲染被动刷新
// 该上下文不跨窗口、不持久化，纯渲染期传递
// [权衡] 用上下文而非逐层透传属性，是为了让调用方可以自由组合菜单项顺序
const OpenInContext = createContext<{ query: string } | undefined>(undefined);

// [契约] 这是所有查询类菜单项读取 query 的唯一入口，不要在组件内直接调用 useContext
// 自定义 hook 返回非空对象，调用方无需再判空，这也是它存在的意义
// [失败路径] 抛错位置刻意放在 hook 内，让错误栈直接指向误用组件而不是更深的 Provider
// 错误信息面向开发者，不要改成用户可见文案；正常交互中不会触发
const useOpenInContext = () => {
  const context = useContext(OpenInContext);
  if (!context) {
    // [失败路径] 这里必须硬失败：降级成空查询只会让用户点到菜单后打开对端空白页，排查成本远高于直接报错
    // 错误文案属于开发者契约的一部分，测试与文档可能按该字符串断言，改写需同步检索
    // 不要改成仅告警后返回空对象，那会把配置错误变成线上静默异常
    throw new Error("OpenIn components must be used within an OpenIn provider");
  }
  return context;
};

export type OpenInProps = ComponentProps<typeof DropdownMenu> & {
  query: string;
};

// [契约] Provider 只注入 query；其余下拉菜单属性全部原样下传，不在此处增删
// query 已被解构出来，因此不会随属性展开落到 DOM 上
// [权衡] 菜单的受控与非受控状态完全交给调用方，本组件不做状态提升
// 调用方若把 query 换成异步取得的值，菜单内容会随之重算，但已打开的菜单不会自动关闭
// 不要在 Provider 外再包一层同值 Provider：嵌套会导致内层覆盖外层且难以排查
export const OpenIn = ({ query, ...props }: OpenInProps) => {
  // [并发] 依赖数组只放 query：任何新增字段都必须同步加入依赖，否则消费方拿到旧快照
  // query 变化即产生新对象并更新整棵菜单子树，这是可接受的，因为查询本身是低频输入
  // 不要为省一次渲染把它提到模块级，那会让所有实例共享同一份查询
  const contextValue = useMemo(() => ({ query }), [query]);

  return (
    <OpenInContext.Provider value={contextValue}>
      <DropdownMenu {...props} />
    </OpenInContext.Provider>
  );
};

export type OpenInContentProps = ComponentProps<typeof DropdownMenuContent>;

// [契约] align 先写、属性展开在后，等于把对齐方式开放给调用方覆盖；顺序颠倒会让默认值反向压过外部设置
// className 已从属性中解构，外部样式通过合并函数与内置宽度叠加，不会互相覆盖
// 内置 240px 宽度是为容纳较长平台名的单行菜单；改动前请同时检查窄屏表现
// [权衡] 用固定宽度而非自适应，避免不同平台标题长度导致菜单宽度跳动
// 不在这一层读取上下文：内容容器与查询无关，保持纯净便于在任意菜单中复用
export const OpenInContent = ({ className, ...props }: OpenInContentProps) => (
  <DropdownMenuContent
    align="start"
    className={cn("w-[240px]", className)}
    {...props}
  />
);

export type OpenInItemProps = ComponentProps<typeof DropdownMenuItem>;

// 这类纯转发组件只改善可读性，不改变行为；不要在这里补默认值或拦截事件
// [契约] 一旦读取上下文，任何未挂载 Provider 的菜单都会在渲染期抛错，破坏基础件通用性
// 属性类型直接取底层组件，保证底层新增属性时自动同步
export const OpenInItem = (props: OpenInItemProps) => (
  <DropdownMenuItem {...props} />
);

export type OpenInLabelProps = ComponentProps<typeof DropdownMenuLabel>;

export const OpenInLabel = (props: OpenInLabelProps) => (
  <DropdownMenuLabel {...props} />
);

export type OpenInSeparatorProps = ComponentProps<typeof DropdownMenuSeparator>;

export const OpenInSeparator = (props: OpenInSeparatorProps) => (
  <DropdownMenuSeparator {...props} />
);

export type OpenInTriggerProps = ComponentProps<typeof DropdownMenuTrigger>;

// [契约] asChild 表示由子元素充当触发器，下拉组件会把交互与无障碍属性合并到该子元素上
// 默认按钮显式写 type="button"，防止菜单嵌在表单内时点击顺带提交
// [失败路径] 回退使用空值合并：只有 null 与 undefined 会落到默认按钮，传入空字符串属于调用方显式意图
// 默认按钮的文案与箭头图标属于对外可见结构，改动需同步设计稿与多语言资源
// 不要在触发器上提前读取上下文：它不需要 query，读取只会扩大误用面
export const OpenInTrigger = ({ children, ...props }: OpenInTriggerProps) => (
  <DropdownMenuTrigger {...props} asChild>
    {children ?? (
      <Button type="button" variant="outline">
        Open in chat
        <ChevronDownIcon className="size-4" />
      </Button>
    )}
  </DropdownMenuTrigger>
);

export type OpenInChatGPTProps = ComponentProps<typeof DropdownMenuItem>;

// [契约] 每个平台项都是菜单项加新窗口链接的组合，asChild 让链接承载菜单样式而不额外套一层可点击元素
// href 在渲染期按当前 query 重新计算，菜单每次打开都拿到最新查询，不做模块级缓存
// [资源] rel="noopener" 必须保留：缺少它时被打开页面可通过 window.opener 反向操纵本窗口
// 内部三段布局固定为图标收缩、标题伸展、尾标收缩，长平台名只在中间被压缩
// 把这段骨架复制给新平台时只需替换 providers 的键，漏改会让所有平台项显示同一个名字
export const OpenInChatGPT = (props: OpenInChatGPTProps) => {
  const { query } = useOpenInContext();
  return (
    <DropdownMenuItem asChild {...props}>
      <a
        className="flex items-center gap-2"
        href={providers.chatgpt.createUrl(query)}
        rel="noopener"
        target="_blank"
      >
        <span className="shrink-0">{providers.chatgpt.icon}</span>
        <span className="flex-1">{providers.chatgpt.title}</span>
        <ExternalLinkIcon className="size-4 shrink-0" />
      </a>
    </DropdownMenuItem>
  );
};

export type OpenInClaudeProps = ComponentProps<typeof DropdownMenuItem>;

// 与 ChatGPT 项结构完全一致，差异只在 providers 的键与对应 createUrl
// [权衡] 重复骨架而非抽象成配置驱动组件，是为了让每项都能独立加入平台特有能力
// 若后续要抽象，请先确认各平台链接形状差异不会再次分叉，否则抽象只剩一层转发噪音
// 读取上下文的位置固定在组件体内，不要提到模块顶层
export const OpenInClaude = (props: OpenInClaudeProps) => {
  const { query } = useOpenInContext();
  return (
    <DropdownMenuItem asChild {...props}>
      <a
        className="flex items-center gap-2"
        href={providers.claude.createUrl(query)}
        rel="noopener"
        target="_blank"
      >
        <span className="shrink-0">{providers.claude.icon}</span>
        <span className="flex-1">{providers.claude.title}</span>
        <ExternalLinkIcon className="size-4 shrink-0" />
      </a>
    </DropdownMenuItem>
  );
};

export type OpenInT3Props = ComponentProps<typeof DropdownMenuItem>;

// 该项复用通用图标组件，因此视觉与其他品牌 SVG 略有差异，属于既有设计选择
// [契约] 参数键与聊天类平台一致，改动只发生在 providers 表内，组件本身不感知
// 不要在组件内判断平台可用性：是否渲染该项由调用方决定
export const OpenInT3 = (props: OpenInT3Props) => {
  const { query } = useOpenInContext();
  return (
    <DropdownMenuItem asChild {...props}>
      <a
        className="flex items-center gap-2"
        href={providers.t3.createUrl(query)}
        rel="noopener"
        target="_blank"
      >
        <span className="shrink-0">{providers.t3.icon}</span>
        <span className="flex-1">{providers.t3.title}</span>
        <ExternalLinkIcon className="size-4 shrink-0" />
      </a>
    </DropdownMenuItem>
  );
};

export type OpenInSciraProps = ComponentProps<typeof DropdownMenuItem>;

// 该平台的品牌图标体量较大，渲染成本高于其他平台项，但仍在可接受范围
// [契约] 链接参数键为 q，组件层不做任何改写，全部语义留在 providers 表
// 需要给该平台追加参数时请改 providers 里的 createUrl，不要在此处拼 href
export const OpenInScira = (props: OpenInSciraProps) => {
  const { query } = useOpenInContext();
  return (
    <DropdownMenuItem asChild {...props}>
      <a
        className="flex items-center gap-2"
        href={providers.scira.createUrl(query)}
        rel="noopener"
        target="_blank"
      >
        <span className="shrink-0">{providers.scira.icon}</span>
        <span className="flex-1">{providers.scira.title}</span>
        <ExternalLinkIcon className="size-4 shrink-0" />
      </a>
    </DropdownMenuItem>
  );
};

export type OpenInv0Props = ComponentProps<typeof DropdownMenuItem>;

// [契约] 导出名中的 v 为小写，与类型名 OpenInv0Props 共用同一拼写；这是对外契约，重命名属于破坏性变更
// 平台名在菜单文案中区分大小写，改文案时不要顺手改成大写 V 开头
// 该平台把 query 当作代码生成提示词而非搜索词，因此不需要额外开关参数
// 结构与其余平台项一致，便于调用方按任意顺序组合
export const OpenInv0 = (props: OpenInv0Props) => {
  const { query } = useOpenInContext();
  return (
    <DropdownMenuItem asChild {...props}>
      <a
        className="flex items-center gap-2"
        href={providers.v0.createUrl(query)}
        rel="noopener"
        target="_blank"
      >
        <span className="shrink-0">{providers.v0.icon}</span>
        <span className="flex-1">{providers.v0.title}</span>
        <ExternalLinkIcon className="size-4 shrink-0" />
      </a>
    </DropdownMenuItem>
  );
};

export type OpenInCursorProps = ComponentProps<typeof DropdownMenuItem>;

// [契约] 该项依赖 providers 里 cursor 的特殊实现，组件层仍只做透传与布局
// [失败路径] 若把 cursor 的 createUrl 改成普通字符串拼接，此文件无需改动但链接编码会悄悄退化，回归需覆盖特殊字符查询
// 读取上下文仍是必要步骤：query 必须来自 Provider，不接受属性覆盖
// 这是文件末尾的最后一个平台项，新增平台请在其后追加并同步类型别名
export const OpenInCursor = (props: OpenInCursorProps) => {
  const { query } = useOpenInContext();
  return (
    <DropdownMenuItem asChild {...props}>
      <a
        className="flex items-center gap-2"
        href={providers.cursor.createUrl(query)}
        rel="noopener"
        target="_blank"
      >
        <span className="shrink-0">{providers.cursor.icon}</span>
        <span className="flex-1">{providers.cursor.title}</span>
        <ExternalLinkIcon className="size-4 shrink-0" />
      </a>
    </DropdownMenuItem>
  );
};
