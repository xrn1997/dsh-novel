/**
 * AllInOne 行 → 字段规则文本的 `$n` 绑定（矩阵行 `a-allinone-group-zero` 的核心；对面
 * 「行组取值拼回字段规则」那支的等价物，对读记录住该矩阵行）。
 *
 * 书源在 AllInOne（整页正则）模式下列出条目后，**同一条目的字段规则是行模板**：
 * 目录规则 `chapterName = $2$3`、`chapterUrl = https://…/$1` 里的 `$n` 取当前行的第 n 组，
 * `$0` 取整段匹配（行的第 0 位即整段，见 `allinone.ts`）。喂进来的已经只是**支文本**
 * （`parseTails` 先剥掉 `##` 尾、`parseBranch` 再判模板），故这里不做尾部分区。
 *
 * 越界组落空串：行短于引用组号时给 `''`（对面越界组同样拿不到内容，
 * 按空串拼接不炸整条链）。
 */

/** 组号 token：`$\d{1,2}`（对面记的组号也是 1..2 位；对读见矩阵行 `a-allinone-group-zero`）——
 *  「支文本是不是行模板」的判定（parse.ts 的 parseBranch）与这里的绑定是同一份文法的两面，
 *  宽窄必须一致：只改一面会让 `$n` 要么没被当模板、要么绑不上，故形态只住这里。 */
export const GROUP_TOKEN = /\$(\d{1,2})/

/** 绑定用的全局版（`String.replace` 要 `g`；从 GROUP_TOKEN 派生，不另写一份形态） */
const GROUP_TOKEN_GLOBAL = new RegExp(GROUP_TOKEN.source, 'g')

export function bindRegexRow(rule: string, row: readonly string[]): string {
  if (!rule.includes('$')) return rule
  // 用函数式替换：避免 `$&`/`$1` 在 replacement 串里的特殊含义把行值再解释一遍
  return rule.replace(GROUP_TOKEN_GLOBAL, (_token, digits: string) => row[Number(digits)] ?? '')
}
