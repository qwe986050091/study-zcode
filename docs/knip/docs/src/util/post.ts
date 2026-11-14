// INV-01 只处理带 URL 实体的帖子：守住位置 entities.urls 判断；改错故障 对空实体排序崩溃。
// INV-02 从大到小替换：守住位置 排序；改错故障 短链接先被替换破坏长链接。
// INV-03 媒体实体替换为图片标签：守住位置 media_key 分支；改错故障 图片链接残留。
// INV-04 推文链接清空：守住位置 includes 判断；改错故障 正文出现裸链接。
// INV-05 外链替换为锚点：守住位置 默认分支；改错故障 外链不可点击。
// INV-06 长文媒体追加尾部：守住位置 note_tweet 判断；改错故障 媒体图片丢失。
// INV-07 原地改写 text：守住位置 post.text 赋值；改错故障 调用方读不到结果。
// INV-08 时间格式固定 UTC：守住位置 timeZone；改错故障 本地时区导致时间漂移。
// INV-09 时间与日期两段拼接：守住位置 模板；改错故障 只显示其一。
// INV-10 帖子类型集中声明：守住位置 interface Post；改错故障 字段散落。
// INV-11 URL 实体字段可选：守住位置 interface UrlEntity；改错故障 缺字段即崩。
// INV-12 注解实体独立：守住位置 interface AnnotationEntity；改错故障 类型混用。
// INV-13 媒体仅支持图片：守住位置 type literal；改错故障 视频被当图片。
// INV-14 带用户扩展：守住位置 PostWithUser；改错故障 用户信息缺失。
// INV-15 响应结构固定：守住位置 PostResponse；改错故障 includes 缺失。
// INV-16 用户提及类型独立：守住位置 interface MentionEntity；改错故障 与注解混淆。
// INV-17 图片尺寸必填：守住位置 interface ImageEntity；改错故障 渲染拿不到宽高。
// INV-18 用户字段完整：守住位置 interface User；改错故障 头像或名称缺失。
//
// 模块职责：把推文正文中的短链、媒体与外链改写成可展示的 HTML 片段。
// 状态所有权：输入帖子对象会被原地改写 text。
// 阅读顺序：先看正文改写，再看时间格式，最后看类型声明。
export const replaceShortenedUrls = (post: PostWithUser) => {
  let text = (post.note_tweet?.text ?? post.text).replace(/^(@[^ ]+ )*/, '');
  if (!post.entities.urls) return { ...post, text };
  post.entities.urls.sort((a, b) => b.start - a.start);
  for (const urlEntity of post.entities.urls) {
    if (urlEntity.media_key) {
      const media = (post.media ?? []).find(media => media.media_key === urlEntity.media_key);
      if (media && media.type === 'photo') {
        text = text.replace(urlEntity.url, `<img src="${media.url}" alt="${media.alt_text}" />`);
      }
    } else if (urlEntity.expanded_url.includes('twitter.com')) {
      text = text.replace(urlEntity.url, '');
    } else {
      text = text.replace(urlEntity.url, `<a href="${urlEntity.expanded_url}">${urlEntity.expanded_url}</a>`);
    }
  }
  if (post.media && post.note_tweet?.text) {
    text = text + post.media.map(media => `<img src="${media.url}" alt="${media.alt_text}" />`).join('');
  }
  post.text = text;
  return post;
};

// 时间固定 UTC。
// 使用 12 小时制。
// timeFormatter 只输出时分，日期交给 dateFormatter。
const timeFormatter = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: 'numeric',
  hour12: true,
  timeZone: 'UTC',
});

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour12: true,
  timeZone: 'UTC',
});

// 解析 ISO 时间。
// formatTimestamp() 把时间与日期两段格式化结果拼接。
// 两段之间用 · 分隔，保证 timestamp 单行展示。
export const formatTimestamp = (date: string) => {
  const d = new Date(date);
  return `${timeFormatter.format(d)} · ${dateFormatter.format(d)}`;
};

// Post.public_metrics 把 retweet_count 等六项全部声明为 number。
// Post.author_id 与 entities 在实体上是必填字段。
// Post.note_tweet.text 单独存放长文正文。
interface Post {
  public_metrics: {
    retweet_count: number;
    reply_count: number;
    like_count: number;
    quote_count: number;
    bookmark_count: number;
    impression_count: number;
  };
  author_id: string;
  entities: {
    urls: UrlEntity[];
    mentions?: MentionEntity[];
    annotations?: AnnotationEntity[];
  };
  text: string;
  note_tweet: {
    text: string;
  };
  id: string;
  url?: string;
  edit_history_tweet_ids: string[];
  created_at: string;
}

// UrlEntity 的 start 与 end 偏移必填。
// UrlEntity.expanded_url 必填，展示用 display_url 另有其值。
// images 与 status 是可选字段，媒体预览信息可以缺席。
interface UrlEntity {
  start: number;
  end: number;
  url: string;
  expanded_url: string;
  display_url: string;
  images?: ImageEntity[];
  status?: number;
  title?: string;
  description?: string;
  unwound_url?: string;
  media_key?: string;
}

interface MentionEntity {
  start: number;
  end: number;
  username: string;
  id: string;
}

interface AnnotationEntity {
  start: number;
  end: number;
  probability: number;
  type: string;
  normalized_text: string;
}

interface ImageEntity {
  url: string;
  width: number;
  height: number;
}

interface User {
  username: string;
  profile_image_url: string;
  name: string;
  id: string;
}

interface Media {
  url: string;
  type: 'photo';
  alt_text: string;
  media_key: string;
}

// PostWithUser 继承 Post 的全部字段。
// media?: Media[] 用可选属性表达可能没有附件。
// user: User 必填，帖子必须能追溯到作者。
export interface PostWithUser extends Post {
  media?: Media[];
  user: User;
}

export interface PostResponse {
  data: Post[];
  includes: {
    users: User[];
    media: Media[];
  };
}
