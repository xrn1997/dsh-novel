# 跨半契约只有一个主人，抄本由测试与构建期门删掉

`/novel-api` 的路由名、值形状、query 参数名、body 构造器、书目字段集，全部只住 `src/shared/wire.ts`；Node 半与浏览器半 import 同一份。`src/client/views/types.ts` 只是再导出桶。

动机：参数名曾散在路由与四个 client 文件里各写一份，改名无处编译报错；视图曾手拼 `shelf/${…}` 绕过 `paramRoutes`——那是**活漂移**，不是理论风险。文档化的路由表同样是契约的第二份抄本，所以「API 文档」这条路被排除在真相链之外（`CONTEXT.md` 把「API 文档」列为禁词）。

一并定的三条边界：
- **书目字段集**只住 `SHELF_META` + `pickShelfMeta`：加字段 = 只改这张表，`Shelf.applyPatch` / `shelfBody` / `dispatch.shelfPut` 三个消费方全从它派生；逐字段 `typeof` 筛键的抄本是禁词。
- **来源投影 `sourceName` 刻意不进那张表**：它是读取面 join 出来的投影，不可 patch、不落盘；进表 = 它变成能被 `PUT` 写进 `shelf.json` 的假元数据。被否决的替代是「加书那刻把源名快照进 shelf.json」——同址去重会复用旧 id，快照会**静默陈旧**。代价如实：源被删后书架只剩「来源已删除」，看不出当初是哪一家。
- **两个「不装」**：整轮搜索结果不上 wire（那是 Node 半持有物，wire 只出带游标的快照）；宿主侧的取消/结算不为 wire 加字段（`HostTie` 是服务层私有挂点）。

一处已知落差：`ROUTES.*.segs` 的**生产消费者为零**（只有 `tests/api/routes.test.ts` 拿它做命名空间自洽校验，段匹配读的是运行时 URL 切分）——写新路由时别以为存在第二份权威。

锚点：`src/shared/wire.ts`；`tests/shared/wire-builders.test.ts`（路由计数与「手拼路径」漂移守卫）；`tests/api/routes.test.ts`；`tsdown.config.ts` 的 `dsh-novel-bundle-purity`；`CONTEXT.md`「wire 契约」「书目字段集」「来源投影」。
