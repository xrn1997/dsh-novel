# TypeScript 严格档位一次开齐，any 的归属改由 ESLint 承担

Status: accepted

`tsc` 从不拒绝显式 `any`，于是 `any` 在测试面一路生长而没有任何一道门看得见。本决策把编译器档位一次补满，并把「tsc 看不见的那一类」正式划给 ESLint。**编译器档位**在 `strict` 之上补齐：`noUncheckedIndexedAccess`（索引取值最密，命中的是空数组解引用）、`exactOptionalPropertyTypes`（区分键缺席与键值为 `undefined`；wire 载荷按需建键，不补 `| undefined`）、`erasableSyntaxOnly`（构造器参数属性、`enum`、有运行时的 `namespace` 一律不认；运行环境只认可擦除语法）、`noFallthroughCasesInSwitch` 与 `noImplicitOverride`。**明确不开** `noPropertyAccessFromIndexSignature`（只改写写法，挡住零类缺陷）。**lint 归属**：ESLint 以 `js.configs.recommended` 与类型感知的 `strictTypeChecked` 为基线，`no-explicit-any` 与 `no-non-null-assertion` 为 error；`tsc` 管类型形状与可赋值性，ESLint 管显式 `any`、`any` 扩散、悬浮 Promise、非空断言。按「不挡缺陷类」关掉 `no-confusing-void-expression` 与 `no-meaningless-void-operator`；`require-await` 在 `tests/**` 关闭。核心规则带来的运行时迁移一并收下：沙箱超时哨兵从 `Symbol` 改为 `Error`（`prefer-promise-reject-errors`；两处判定仍按对象同一性），确有控制字符匹配的正则就地豁免并写明理由。被否决：棘轮 / 分目录推进；给 wire 载荷的可选键补 `| undefined`；用 `?.` 消非空断言。**后果**：夹具取位走 `pick` / `last` / `must`；`no-unnecessary-condition` 的命中分两类处置；门的唯一入口是 `pnpm gates`。

锚点：`tsconfig.json`；`eslint.config.js`；`tests/support/fixture.ts` 的 `must` / `pick`；`src/shared/wire.ts`；`src/engine/select.ts` 的 `reducePicked`；`package.json` 的 `gates`。
