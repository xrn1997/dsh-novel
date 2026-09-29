# 不预先造对面有、本仓没有的存储与作用域层

对面有真实 CookieStore、按书/章分级的变量持久化表、磁盘缓存层级、`JavaImporter` 作用域。我们决定**没有需求方就不先造**：

- 变量表 `ctx.vars` 是单次门面调用内的进程内表（引擎零内部状态，表由调用方持有并跨规则共享）；对面按四级作用域链读变量，本仓**只接两级**（本次调用 + source 层的 peek 访问器），chapter / book 两个持久化层等真源出现再定形状——预先造层是给没有需求方的形态发明行为。
- cookie / source 键值表 / source 单串槽 / cache 四张表**按源建档**（`SourceSession`），不做真实 CookieJar 与域匹配，也不落盘：落盘要给数据根添一张源级状态表，并连带「删源 / 换规则时清不清」的口径，那不在形状修复里顺手拍板。
- 网络出口不分散：桥的所有请求走 `EvalContext` 上注入的那一个守门 fetcher，桥内不 fetch。
- 缓存 TTL 与多级磁盘层级不接：文件缓存另有其人（代际 + LRU）。

被否决的方案：① 三处存储塞进同一张 Map（曾 `setVariable` 先 parse 再 `clear()` 整表，把 source 层写过的键全清、cache 借前缀互相看得见）；② 真实 CookieJar / 真文件系统 / `JavaImporter` 空壳（空壳只让脚本多活几行，真阻塞点在 URL 客户端那一族）。

一条应用：`@put` 的语义就是 `put(key, getString(value))`——值是规则串就走子规则求值；「整条规则只设变量」的判据必须是**结构判据**并由引擎导出（`isPutOnlyRule`），不许服务层拿 `miss.detail` 那种给人看的文案判——结构语义依赖文案就是下一次「顺手改措辞」的静默回归。

锚点：`src/engine/js-sandbox.ts` 的 `SourceSession` / `processSession`；`src/engine/variables.ts`；`src/engine/types.ts` 的 `EvalContext.sourceVar`；`src/engine/parse.ts` 的 `isPutOnlyRule`；矩阵行 `a-var-scope-chain`、`a-var-source-tier`、`h-cookie-shim`、`h-cache-ttl`、`h-source-variable-persistence`、`a-put-only-rule`。
