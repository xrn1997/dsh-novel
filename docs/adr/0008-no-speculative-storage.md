# 没有需求方就不预造存储层与作用域链

Status: accepted

cookie 存储、按书/章分级的变量持久化表、磁盘缓存层级、`JavaImporter` 作用域——这些层各自都要有需求方才成立。本仓的判据是**没有需求方或明确裁决就不先造**：变量表 `ctx.vars` 是单次门面调用内的进程内表，作用域链只接两级（本次调用 + source 层 peek 访问器），chapter / book 两个持久化层没有需求方；cookie 由一张跨源、域/路径感知的 `CookieJar` 承担，不并入源级表；source 键值表 / 单串槽 / cache 按源建档（`SourceSession`），四张脚本表落盘到数据根 `source-state.json`，删源时按 `baseUrl` 经 `SourceSession.forget` 清掉；`JavaImporter` 只暴露已挂载的 `Packages` 路径，桥的所有请求走 `EvalContext` 上注入的那一个守门 fetcher；缓存 TTL 与多级磁盘层级仍未接。被否决：三处存储塞进同一张 Map（曾把 source 层写过的键全清、cache 借前缀互相看得见）；真文件系统 / `JavaImporter` 空壳；把 HTTP cookie 并进源级键值表。一条应用：`@put` 的语义是 `put(key, getString(value))`；「整条规则只设变量」必须是**结构判据**并由引擎导出（`isPutOnlyRule`），不许服务层拿 `miss.detail` 的文案判。

锚点：`src/engine/session.ts` 的 `SourceSession`（契约面，零 import）；`src/engine/js-sandbox.ts` 的 `processSession` / `createSourceSession`；`src/services/source-session.ts`；`src/services/cookies.ts`；`src/engine/variables.ts`；`src/engine/types.ts` 的 `EvalContext.sourceVar`；`src/engine/parse.ts` 的 `isPutOnlyRule`；`tests/services/source-session.test.ts`；`tests/services/cookies.test.ts`；矩阵行 `a-var-scope-chain`、`a-var-source-tier`、`b-cookie-jar`、`h-cache-ttl`、`h-source-variable-persistence`、`h-rhino-javaimporter-scope`、`a-put-only-rule`。
