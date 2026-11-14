// INV-01 密钥只从环境读取：守住位置 process.env；改错故障 token 出现在命令行历史里。
// INV-02 一次取全量活动：守住位置 first: 100 与 period: ALL；改错故障 分页缺失导致总额偏低。
// INV-03 活动按时间升序：守住位置 sort；改错故障 先处理后新增，取消被当成无效。
// INV-04 月份先铺零：守住位置 建表循环；改错故障 空月缺键，图表断点。
// INV-05 一次性赞助只计当月：守住位置 isOneTime 分支；改错故障 一次性收入被摊到往后所有月份。
// INV-06 recurringOnly 跳过一次性：守住位置 continue；改错故障 订阅视图混入单次打赏。
// INV-07 取消是移除不是负数：守住位置 delete；改错故障 总额出现负值。
// INV-08 每次变动重算活跃总额：守住位置 reduce；改错故障 后续月份沿用旧总额。
// INV-09 月份键取 ISO 前七位：守住位置 substring(0, 7)；改错故障 跨时区月份错位。
// INV-10 区间裁剪在出口层：守住位置 getGitHubTotals；改错故障 聚合层猜区间，复用时口径不一。
// INV-11 缺 token 立即抛错：守住位置 入口判断；改错故障 发出匿名请求得到空结果。
// INV-12 查询字段与响应类型一致：守住位置 GraphQL 模板；改错故障 运行时字段为 undefined。
// INV-13 缺失档位按零处理：守住位置 两处可选链；改错故障 NaN 污染整月总额。
// INV-14 返回 Map 保留月份顺序：守住位置 建表与遍历顺序；改错故障 输出顺序不稳定。
//
// 模块职责：从 GitHub Sponsors 活动回放每月订阅总额，供文档脚本消费。
// 阅读顺序：先看查询与排序，再看按月回放，最后看区间裁剪与 token 校验。
import { graphql } from '@octokit/graphql';

// token 只读 process.env.GITHUB_TOKEN_SPONSORSHIPS。
const token = process.env.GITHUB_TOKEN_SPONSORSHIPS;

type Options = {
  token?: string;
  startDate: Date;
  endDate?: Date;
  recurringOnly: boolean;
};

interface SponsorActivity {
  action: 'NEW_SPONSORSHIP' | 'CANCELLED_SPONSORSHIP';
  timestamp: string;
  sponsorsTier: {
    monthlyPriceInDollars: number;
    isOneTime: boolean;
  };
  sponsor: {
    login: string;
  };
}

interface GraphQLResponse {
  viewer: {
    sponsorsActivities: {
      nodes: SponsorActivity[];
    };
  };
}

// 内层函数保留 token 参数，便于调用方注入。
const getMonthlyTotals = async (options: Options) => {
  const { token, startDate, recurringOnly } = options;

  // graphql 查询用 first: 100 与 period: ALL 一次取全量。
  const { viewer } = await graphql<GraphQLResponse>({
    query: `
      query {
        viewer {
          sponsorsActivities(first: 100, period: ALL) {
            nodes {
              action
              timestamp
              sponsorsTier {
                monthlyPriceInDollars
                isOneTime
              }
              sponsor {
                ... on User { login }
                ... on Organization { login }
              }
            }
          }
        }
      }
    `,
    headers: {
      authorization: `token ${token}`,
    },
  });

  // 按时间升序回放赞助状态。
  const activities = [...viewer.sponsorsActivities.nodes].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  // activeRecurring 以 sponsor.login 为键去重。
  const activeRecurring = new Map<string, number>();
  const monthlyTotals = new Map<string, number>();
  const now = new Date();

  for (let d = new Date(startDate); d <= now; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    // 先铺零，保证空月也有键。
    monthlyTotals.set(d.toISOString().substring(0, 7), 0);
  }

  for (const activity of activities) {
    const { action, sponsor, sponsorsTier, timestamp } = activity;
    // recurringOnly 为真且 isOneTime 时直接 continue。
    if (recurringOnly && sponsorsTier?.isOneTime) continue;
    const amount = sponsorsTier?.monthlyPriceInDollars || 0;
    const monthYear = new Date(timestamp).toISOString().substring(0, 7);

    if (sponsorsTier?.isOneTime) {
      // isOneTime 的 NEW_SPONSORSHIP 只累加 monthYear 当月。
      if (!recurringOnly && action === 'NEW_SPONSORSHIP') {
        monthlyTotals.set(monthYear, (monthlyTotals.get(monthYear) || 0) + amount);
      }
    } else {
      if (action === 'NEW_SPONSORSHIP') activeRecurring.set(sponsor.login, amount);
      // CANCELLED_SPONSORSHIP 从 activeRecurring 里 delete，不产生负数。
      if (action === 'CANCELLED_SPONSORSHIP') activeRecurring.delete(sponsor.login);
      // 每次变动后用 reduce 重算 activeRecurring 总额。
      const total = Array.from(activeRecurring.values()).reduce((sum, a) => sum + a, 0);
      for (const month of monthlyTotals.keys()) {
        // 只覆盖当前及之后的月份。
        if (month >= monthYear) monthlyTotals.set(month, total);
      }
    }
  }

  return monthlyTotals;
};

export const getGitHubTotals = async (options: Options) => {
  // 缺 token 立即失败，不发匿名请求。
  if (!token) throw new Error('GITHUB_TOKEN_SPONSORSHIPS is not set');
  const monthlyData = await getMonthlyTotals({ ...options, token });
  const startMonth = options.startDate.toISOString().substring(0, 7);
  const endMonth = options.endDate?.toISOString().substring(0, 7);
  for (const month of monthlyData.keys()) {
    // startMonth 与 endMonth 的裁剪留在 getGitHubTotals，聚合层不猜。
    if (month < startMonth || (endMonth && month > endMonth)) monthlyData.delete(month);
  }
  return monthlyData;
};
