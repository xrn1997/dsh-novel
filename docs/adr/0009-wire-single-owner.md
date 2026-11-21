# 跨半契约只有一个主人，抄本由测试与构建期门删掉

Status: accepted

`/novel-api` 的路由身份（method + path）、值形状、query 参数名、body 构造器、书目字段集，全部只住 `src/shared/wire.ts`；Node 半与浏览器半 import 同一份，`src/client/views/types.ts` 只是再导出桶。动机：参数名曾散在路由与四个 client 文件里各写一份，改名无处编译报错；视图曾手拼 `shelf/${…}` 绕过 `paramOps`。现在静态 `Route` 与参数 `paramOps` 都自带 method，写口只接受 `WriteMethod`，`matchRoute` 从同一个目标取方法与路径；例外只有原始字节上传 `apiUpload` 与根健康检查的 path。文档化的路由表同样是第二份抄本，所以「API 文档」被排除在真相链之外。三条边界：书目字段集只住 `SHELF_META` + `pickShelfMeta`（`Shelf.applyPatch` 与 `bodies` / `readBodies` 三个消费方全从它派生）；来源投影 `sourceName` 刻意不进表（读取面 join 的投影，不可 patch、不落盘；同址去重会复用旧 id，「加书那刻快照源名」会静默陈旧——代价是源被删后书架只剩「来源已删除」）；整轮搜索结果不上 wire，宿主侧取消/结算不为 wire 加字段。`ROUTES.*.segs` 不是第二份权威：`matchRoute` 收请求切出的段与 `path` 等值比对，`segs` 只供结构自洽校验。

锚点：`src/shared/wire.ts`；`tests/shared/wire-builders.test.ts`；`tests/api/routes.test.ts`；`tsdown.config.ts` 的 `dsh-novel-bundle-purity`；`CONTEXT.md`「wire 契约」「书目字段集」「来源投影」。
