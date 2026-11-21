# 收口只抽机械，不抽转发壳

Status: accepted

四处重复各归了一家（逐条目取值装配 → `bridge.hitFieldsOf`、写路由 body 形状 → `shared/wire.ts` 的 `bodies`/`readBodies`、分类条目可用尺 → `explore-url.usableKind`、宿主登记与「变了」信号 → `job-holder.ts` 的 `HostTie`/`ChangeSignal`）。本篇**否决**两件顺手的泛型：「route 注册壳」（把 `writeOk` / `new ApiError` 包成 `route(method, path, handler)`）——这几样已各有主人，臂里那两行只是调用、不是判据副本，套壳后壳内只剩转发，deletion test 直接判它出局；真正在重复的是 body 的形状，那个归了 wire。留下的三处重复措辞各归一个单点（`unknownRoute` / `methodMismatchError`）。「任务运行器泛型」——三个持有者真正相同的是**宿主接线**，不同的是状态形状、槽政策与业务判据；塞进一个泛型壳，壳就会长出「只有 explore 用的注入位」，壳就只剩转发。`shelfPut` / `authRoute` 按 body 形状分派到哪个门面动词是**传输层分派**不是业务判据（值域门全在门面，见 `ADR-0019`，理由就地写在 `api/dispatch.ts` 末尾）。同一条判据也定了**存在性与 body 形状的先后**：id 在不在是门面读一次注册表才知道的事，路由不预检存在性——未知源配垃圾 body 得 400、配超限 body 得 413，形状与体积都过了才轮到门内那一声 404（被否：让路由先确认一次存在——每个写臂各养一份「先查在不在」的抄本，判据的家本来就在门面）。导出区间判据不在这条判据之下，主人是 `services/reading.ts` 的 `exportRange`（`ADR-0052`）。

锚点：`src/services/bridge.ts` 的 `hitFieldsOf`；`src/shared/wire.ts` 的 `bodies` / `readBodies` / `BODY`；`src/services/explore-url.ts` 的 `usableKind` / `usableText`；`src/services/job-holder.ts`；`src/api/dispatch.ts` 的 `unknownRoute` / `methodMismatchError`；`src/services/reading.ts` 的 `requireSource`；`tests/services/job-holder.test.ts`；`tests/shared/wire-builders.test.ts`；`tests/engine/js-protocol.test.ts`；`tests/api/routes.test.ts`；`ADR-0052`。
