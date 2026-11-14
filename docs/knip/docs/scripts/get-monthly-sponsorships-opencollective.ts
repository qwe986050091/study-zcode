// INV-01 令牌只从环境读取：守住位置 模块常量；改错故障 令牌出现在源码里。
// INV-02 月度键统一为年月：守住位置 切片格式；改错故障 跨时区落到相邻月。
// INV-03 起点到当前逐月建零：守住位置 循环步进；改错故障 早期月份缺失。
// INV-04 循环步进用月构造：守住位置 新建日期；改错故障 月末溢出跳月。
// INV-05 交易只取贷方：守住位置 查询参数；改错故障 支出被重复计入。
// INV-06 周期口径只认贡献类型：守住位置 种类比较；改错故障 一次性赞助混入周期统计。
// INV-07 金额按整数累积：守住位置 取整函数；改错故障 浮点误差累积。
// INV-08 缺失月份从零起算：守住位置 空值兜底；改错故障 累加得到非数字。
// INV-09 支出仅非周期模式计入：守住位置 布尔判断；改错故障 周期统计混入支出。
// INV-10 欧元支出按固定汇率折算：守住位置 币种判断；改错故障 币种混算。
// INV-11 支出金额由分转元：守住位置 除法；改错故障 支出被放大一百倍。
// INV-12 汇率是常量而非实时：守住位置 常量定义；改错故障 每次运行结果漂移。
// INV-13 缺令牌立即失败：守住位置 入口抛错；改错故障 携带空令牌请求。
// INV-14 生成器接收显式令牌：守住位置 参数合并；改错故障 内部再读环境绕过测试。
// INV-15 输出按闭区间裁剪：守住位置 起止月份比较；改错故障 边界外的月份留在结果里。
// INV-16 未给结束月份则开放右端：守住位置 可选判断；改错故障 只保留起始月。
// INV-17 输出保持插入顺序：守住位置 映射迭代；改错故障 表格月份乱序。
// INV-18 查询字段与接口一一对应：守住位置 查询文本；改错故障 解析出未定义字段。
//
// 模块职责：从 Open Collective 拉取赞助与支出，汇总为每月的净额。
// 状态所有权：无状态；数据只在调用期间存在于内存映射。
// 阅读顺序：先看选项与响应类型，再看月度汇总，最后看对外裁剪入口。
import { graphql } from '@octokit/graphql';

const token = process.env.OPENCOLLECTIVE_TOKEN;
const RATE_EUR_TO_USD = 1.08;

type Options = {
  token?: string;
  startDate: Date;
  endDate?: Date;
  recurringOnly: boolean;
};

interface Transaction {
  id: string;
  type: string;
  kind: string;
  amount: {
    value: number;
    currency: string;
  };
  createdAt: string;
  fromAccount: {
    name: string;
  };
}

interface Expense {
  id: string;
  amount: number;
  currency: string;
  createdAt: string;
  type: string;
  status: string;
}

interface GraphQLResponse {
  account: {
    transactions: {
      nodes: Transaction[];
    };
  };
  expenses: {
    nodes: Expense[];
  };
}

// Options.token 显式传入，便于测试注入。
// startDate 为闭区间起点，endDate 可选。
// recurringOnly 为真时只看 kind === CONTRIBUTION。
// 返回值是以 YYYY-MM 为键的 Map。
const getMonthlyTotals = async (options: Options): Promise<Map<string, number>> => {
  const { token, startDate, recurringOnly } = options;

  const { account, expenses } = await graphql<GraphQLResponse>({
    query: `
      query {
        account(slug: "knip") {
          transactions(type: CREDIT) {
            nodes {
              id
              type
              kind
              amount {
                value
                currency
              }
              createdAt
              fromAccount {
                name
              }
            }
          }
        }
        expenses(fromAccount: { slug: "webpro" }) {
          nodes {
            id
            amount
            currency
            createdAt
            type
            status
          }
        }
      }
    `,
    url: 'https://api.opencollective.com/graphql/v2',
    headers: {
      'Api-Key': token,
      Accept: 'application/json',
    },
  });

  const monthlyTotals = new Map<string, number>();
  const now = new Date();

  // 从 startDate 起逐月推进到 now。
  // 每轮用 getFullYear()/getMonth() 重建日期，避免月末溢出。
  // 先按月份键在 monthlyTotals 建零值占位。
  for (let d = new Date(startDate); d <= now; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    monthlyTotals.set(d.toISOString().substring(0, 7), 0);
  }

  for (const transaction of account.transactions.nodes) {
    if (recurringOnly && transaction.kind !== 'CONTRIBUTION') continue;

    const month = new Date(transaction.createdAt).toISOString().substring(0, 7);
    const amount = Math.round(transaction.amount.value);
    monthlyTotals.set(month, (monthlyTotals.get(month) || 0) + amount);
  }

  // !recurringOnly 时才把 expenses 计入。
  // EUR 金额按 RATE_EUR_TO_USD 固定汇率折算。
  // 金额以分为单位，先除以 100 再 Math.round()。
  if (!recurringOnly) {
    for (const expense of expenses.nodes) {
      const month = new Date(expense.createdAt).toISOString().substring(0, 7);
      const amount =
        expense.currency === 'EUR'
          ? Math.round((expense.amount / 100) * RATE_EUR_TO_USD)
          : Math.round(expense.amount / 100);
      monthlyTotals.set(month, (monthlyTotals.get(month) || 0) + amount);
    }
  }

  return monthlyTotals;
};

// token 为空时抛出 OPENCOLLECTIVE_TOKEN is not set。
// 向 getMonthlyTotals() 传入显式 token。
// 用 startMonth/endMonth 裁剪 monthlyData。
export const getOpenCollectiveTotals = async (options: Options) => {
  if (!token) throw new Error('OPENCOLLECTIVE_TOKEN is not set');
  const monthlyData = await getMonthlyTotals({ ...options, token });
  const startMonth = options.startDate.toISOString().substring(0, 7);
  const endMonth = options.endDate?.toISOString().substring(0, 7);
  for (const month of monthlyData.keys()) {
    if (month < startMonth || (endMonth && month > endMonth)) monthlyData.delete(month);
  }
  return monthlyData;
};
