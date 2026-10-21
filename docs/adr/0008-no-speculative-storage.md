# 不因对面有就预造存储与作用域层

对面有真实 CookieStore、按书/章分级的变量持久化表、磁盘缓存层级、`JavaImporter` 作用域。本仓的判据是**没有需求方或明确裁决就不先造**：

- 变量表 `ctx.vars` 是单次门面调用内的进程内表（引擎零内部状态，表由调用方持有并跨规则共享）；对面按四级作用域链读变量，本仓**只接两级**（本次调用 + source 层的 peek 访问器），chapter / book 两个持久化层等真源出现再定形状——预先造层是给没有需求方的形态发明行为。
- cookie 由一张跨源、域/路径感知的 `CookieJar` 承担（`docs/adr/0039`），不并入源级表；source 键值表 / 单串槽 / cache 按源建档（`SourceSession`），四张脚本表落盘到数据根 `source-state.json`，删源时按 `baseUrl` 经 `SourceSession.forget` 清掉（HTTP cookie jar 是跨源域表，不清）。
- `JavaImporter` 只暴露已挂载的 `Packages` 路径，不做对面的完整宿主作用域；网络出口不分散：桥的所有请求走 `EvalContext` 上注入的那一个守门 fetcher，桥内不 fetch。
- 缓存 TTL 与多级磁盘层级仍未接：源级 cache 只是 `SourceSession` 里的一张垫片表，过期与分层没有需求方；文件缓存另有其人（代际 + LRU）。

被否决的方案：① 三处存储塞进同一张 Map（曾 `setVariable` 先 parse 再 `clear()` 整表，把 source 层写过的键全清、cache 借前缀互相看得见）；② 真文件系统 / `JavaImporter` 空壳（空壳只让脚本多活几行，真阻塞点在 URL 客户端那一族）；③ 把 HTTP cookie 并进源级键值表（同站两个源会各登录一次，脚本读到的与请求发出去的不是一份，见 `docs/adr/0039`）。

一条应用：`@put` 的语义就是 `put(key, getString(value))`——值是规则串就走子规则求值；「整条规则只设变量」的判据必须是**结构判据**并由引擎导出（`isPutOnlyRule`），不许服务层拿 `miss.detail` 那种给人看的文案判——结构语义依赖文案就是下一次「顺手改措辞」的静默回归。

锚点：`src/engine/session.ts` 的 `SourceSession`（契约面，零 import）；`src/engine/js-sandbox.ts` 的 `processSession` / `createSourceSession`（进程内两个 adapter）；`src/services/source-session.ts`（四张表落盘与 `forget`）；`src/services/cookies.ts`（HTTP `CookieJar`）；`src/engine/variables.ts`；`src/engine/types.ts` 的 `EvalContext.sourceVar`；`src/engine/parse.ts` 的 `isPutOnlyRule`；`tests/services/source-session.test.ts`；`tests/services/cookies.test.ts`；矩阵行 `a-var-scope-chain`、`a-var-source-tier`、`b-cookie-jar`、`h-cache-ttl`、`h-source-variable-persistence`、`h-rhino-javaimporter-scope`、`a-put-only-rule`。
