# TypeScript 严格档位一次开齐，any 的归属改由 ESLint 承担

Status: accepted

本仓的 tsconfig 原先只有 `strict` 与其子集，lint 只有 `react-hooks`——那份配置的注释主张「格式与风格主张由 tsc 档位与其它门各管一部分」。这个分工对格式成立，对 `any` 不成立：**`tsc` 从不拒绝显式 `any`**，于是 `any` 在测试面长到三百多处而没有任何一道门看得见。本决策把编译器档位一次补满，并把「tsc 看不见的那一类」正式划给 ESLint。

## 决定

**编译器档位**在 `strict` 之上补齐下列标志，全部一次开齐：

- `noUncheckedIndexedAccess`：`arr[i]` / `record[key]` 返回 `T | undefined`。本仓是规则引擎与抓取器，索引取值最密，这一条命中的正是空数组解引用这一类缺陷。
- `exactOptionalPropertyTypes`：区分「键缺席」与「键值为 `undefined`」。wire 载荷（`src/shared/wire.ts` 的形状）按需建键，不补 `| undefined`——那等于把这个标志在载荷面上关掉。
- `erasableSyntaxOnly`：构造器参数属性、`enum`、有运行时的 `namespace` 一律不认。判据是运行环境：`engines.node >= 24` 的原生 type-stripping 与 `tsdown` 的逐文件转译都只认可擦除语法。
- `noFallthroughCasesInSwitch` 与 `noImplicitOverride`：实测零改动量。

**明确不开 `noPropertyAccessFromIndexSignature`**：它只把 `env.FOO` 改写成 `env["FOO"]`，挡住零类缺陷。判据是「能挡住真实运行期缺陷类的标志才有资格进基线」。

**lint 归属**：ESLint 以 `js.configs.recommended` 与类型感知的 `strictTypeChecked` 为基线，并点名 `no-explicit-any` 与 `no-non-null-assertion` 为 error。分工写进配置注释——`tsc` 管类型形状与可赋值性；ESLint 管显式 `any`、`any` 扩散（`no-unsafe-*`）、悬浮 Promise、非空断言。核心规则带来的运行时迁移一并收下：沙箱超时哨兵从 `Symbol` 改为 `Error`（`prefer-promise-reject-errors`；两处判定仍按对象同一性），确有控制字符匹配的正则就地豁免并写明理由。

**按「不挡缺陷类」关掉两条**：`no-confusing-void-expression` 与 `no-meaningless-void-operator` 只要求给箭头简写加大括号，改法不改变任何缺陷类。`require-await` 在 `tests/**` 关闭——替身里的 `async` 就是为了回一个 Promise。

## 被否的方案

- **棘轮 / 分目录推进**：先在 `src/` 开、测试面登记基线与「只减不增」。否掉的理由是同一仓里新旧两种取值形态并存，读代码的人必须先判断「这个文件属于哪一档」；一次改完让门只有一种口径。
- **给 wire 载荷的可选键补 `| undefined`**：能让报错消失，但会让「缺席」与「显式 undefined」在载荷面上重新折叠——正是这个标志要买回来的东西。
- **用 `?.` 消非空断言**：在测试里会让 `expect(x?.y).toBeUndefined()` 这类断言在空夹具上蒙对，比原缺陷更难查。

## 后果

- 夹具的位置取位统一走 `tests/support/fixture.ts` 的 `pick` / `last`，需要断言存在性的查找走 `must`：越界即抛「夹具缺第几项、共几项」，不折叠成 `undefined`，也不让断言蒙对。
- `no-unnecessary-condition` 的处置分两类：真死代码删；「本地窄镜像钉死 ≠ 运行时必有」与「TS 看不见闭包写入」的判空**保留**。保留的多数是把类型面改诚实——例如 `lib.dom` 把 `localStorage` 钉成非空，本仓按本地窄镜像取一格并留注释（`src/client/util.ts`），让判据重新有意义，而不是靠关规则。
- 引擎的取值规约不变：取位失败仍是 Miss、解析到空集合仍是空 List，两者不因收窄而折叠。
- 门的唯一入口是 `pnpm gates`（typecheck / lint / test / test:pack / test:compat；build 在 `test:pack` 内），CI 与发版跑同一条。

锚点：`tsconfig.json`；`eslint.config.js`；`tests/support/fixture.ts` 的 `must` / `pick`；`src/shared/wire.ts`；`src/engine/select.ts` 的 `reducePicked`；`src/engine/jsonpath.ts`；`tests/comment-altitude.test.ts`；`package.json` 的 `gates`。
