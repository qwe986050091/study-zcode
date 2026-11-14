// INV-01 site 与 base 固定：守住位置 顶层配置；改错故障 生成的绝对链接指向错误域名。
// INV-02 trailingSlash 恒为 never：守住位置 顶层配置；改错故障 同一页面出现两种 URL，链接检查翻倍。
// INV-03 旧路径靠 redirects 兜住：守住位置 redirects 表；改错故障 历史外链直接 404。
// INV-04 remark 插件顺序固定：守住位置 remarkPlugins 数组；改错故障 指令转换早于链接修复，改写后的地址漏修。
// INV-05 setForeground 只改命中的第一条规则：守住位置 find；改错故障 主题色被后续定义覆盖。
// INV-06 未命中 scope 时静默跳过：守住位置 条件判断；改错故障 主题升级改名后构建直接崩。
// INV-07 侧边栏按目录自动生成：守住位置 sidebar 配置；改错故障 新增文档不进导航。
// INV-08 样式覆盖只写 CSS 变量：守住位置 styleOverrides；改错故障 深色主题下对比度失效。
// INV-09 高亮样式表单独产出：守住位置 emitExternalStylesheet；改错故障 首屏内联体积膨胀。
// INV-10 自定义主题必须返回同一对象：守住位置 customizeTheme 返回值；改错故障 高亮主题链断裂。
//
// 模块职责：knip 文档站（Astro 加 Starlight）的构建配置。
// 阅读顺序：先看站点与重定向，再看 markdown 插件，最后看 Starlight 集成与代码高亮主题。
import starlight from '@astrojs/starlight';
import type { ExpressiveCodeTheme } from '@astrojs/starlight/expressive-code';
import { defineConfig } from 'astro/config';
import remarkDirective from 'remark-directive';
import { fixInternalLinks } from './remark/fixInternalLinks.ts';
import { transformDirectives } from './remark/transformDirectives.ts';

// 按 scope 片段匹配主题规则，而不是全等比较。
// 只改第一条命中的规则：同名作用域后面的定义保持原样。
// 找不到就静默返回，主题升级改名不应让构建失败。
// 原地修改并返回同一个对象，避免复制出第二份主题。
const setForeground = (theme: ExpressiveCodeTheme, scope: string, value: string) => {
  const settings = theme.settings.find(setting => setting.scope?.includes(scope));
  if (settings) settings.settings.foreground = value;
};

// site 与 base 决定绝对链接的生成基准。
// trailingSlash 固定为 never，保证同一页面只有一种 URL。
// redirects 兜住历史外链，文档改名不能只靠 404 通知。
// sitemap 显式关闭：文档站不需要额外索引产物。
// 该对象只做装配，不在这里读取文件或环境变量。
export default defineConfig({
  site: 'https://knip.dev',
  base: '/',
  // @ts-expect-error
  sitemap: false,
  trailingSlash: 'never',
  redirects: {
    '/guides/commonjs': '/guides/working-with-commonjs',
    '/guides/writing-a-plugin': '/writing-a-plugin',
  },
  // 三个插件顺序固定：先修内部链接，再做指令转换，最后交给指令解析。
  // 顺序对调会让自定义指令在解析前就被当成普通文本。
  // 数组顺序即执行顺序，不要按字母序整理。
  markdown: {
    remarkPlugins: [fixInternalLinks, transformDirectives, remarkDirective],
  },
  integrations: [
    starlight({
      title: 'Knip',
      logo: {
        light: './src/assets/title-light.svg',
        dark: './src/assets/title-dark.svg',
        replacesTitle: true,
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/webpro-nl/knip' },
        { icon: 'blueSky', label: 'Bluesky', href: 'https://bsky.app/profile/webpro.nl' },
        { icon: 'npm', label: 'npm', href: 'https://www.npmjs.com/package/knip' },
      ],
      components: {
        Head: './src/components/Head.astro',
        Footer: './src/components/Footer.astro',
      },
      customCss: ['./src/styles/custom.css', './src/fonts/font-face.css'],
      editLink: {
        baseUrl: 'https://github.com/webpro-nl/knip/edit/main/packages/docs/',
      },
      sidebar: [
        {
          label: 'Overview',
          autogenerate: { directory: 'overview' },
        },
        {
          label: 'Understanding Knip',
          autogenerate: { directory: 'explanations' },
        },
        {
          label: 'Features',
          autogenerate: { directory: 'features' },
        },
        {
          label: 'Guides',
          autogenerate: { directory: 'guides' },
        },
        {
          label: 'Writing a Plugin',
          autogenerate: { directory: 'writing-a-plugin' },
        },
        {
          label: 'Reference',
          autogenerate: { directory: 'reference' },
        },
        {
          label: 'Blog',
          autogenerate: { directory: 'blog' },
        },
        {
          label: 'Read more',
          collapsed: true,
          autogenerate: { directory: 'typescript' },
        },
      ],
      // 外部样式表单独产出，避免首屏内联整份高亮 CSS。
      // styleOverrides 只覆盖 CSS 变量，不写死颜色值。
      // frames 保留复制按钮，文档示例需要可复制。
      // 基础主题在 customizeTheme 里二次调色，不整体替换。
      expressiveCode: {
        emitExternalStylesheet: true,
        styleOverrides: {
          // @ts-expect-error deal with it
          'frm-tooltipSuccessBg': 'var(--sl-color-orange)',
          'frm-tooltipSuccessFg': 'var(--sl-color-white)',
          'frm-edBg': 'var(--sl-color-black)',
          'frm-edActTabBg': 'var(--sl-color-black)',
          'frm-edActTabBrdCol': 'var(--sl-color-black)',
          'frm-edTabBarBg': 'none',
          'frm-edTabBarBrdBtmCol': 'none',
          'frm-frameBoxShdCssVal': 'none',
        },
        frames: {
          showCopyToClipboardButton: true,
        },
        themes: ['min-dark'],
        // 按作用域改前景色：标签、类型与字符串三种。
        // 必须返回同一 theme，否则高亮链路拿不到主题。
        customizeTheme: theme => {
          setForeground(theme, 'entity.name.tag', '#f68a22');
          setForeground(theme, 'entity.name.type', '#ededed');
          setForeground(theme, 'string', '#ededed');
          return theme;
        },
      },
    }),
  ],
});
