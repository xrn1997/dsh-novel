# 收口只抽机械，不抽转发壳

Status: accepted

这一轮把四处重复各归了一家（逐条目取值装配 → `bridge.hitFieldsOf`、写路由 body 形状 → `shared/wire.ts` 的 `bodies`/`readBodies`、分类条目可用尺 → `explore-url.usableKind`、宿主登记与「变了」信号 → `job-holder.ts` 的 `HostTie`/`ChangeSignal`）。同一轮里被**否决**的是两件顺手的泛型：

- **「route 注册壳」**（把 `dispatch.ts` 里成片的 `guard` / `writeOk` / `new ApiError` 调用包成一条 `route(method, path, handler)`）。被否的理由：这三样**已经各有主人**（`guard` / `api/wire.ts` 的信封与分类表），臂里那两行只是调用，不是判据的副本——套一层壳后壳内只剩转发，deletion test 直接判它出局。真正在重复的是 body 的**形状**（键名两半各写一遍），那个归了 wire，壳的动机随之一并消失。留下的三处重复措辞各有了一次收口：「未知路由」404 与「方法不允许」405 各成一个 `unknownRoute` / `methodNotAllowed`，因为 `routes.test.ts` 的落点判据就是那句前缀，漏改一处会让测试找不到证据。
- **「任务运行器泛型」**（`JobHolder<S>` 一个模子，三个 kind 只交快照与判据）。被否的理由：三个持有者真正相同的是**宿主接线**（`ctx.jobs` 登记、协作式取消记账、终态结算、过程行拉取、`subscribe`/`notify`），不同的是状态形状、槽政策与业务判据——后者才是各自存在的理由。把它们塞进一个泛型壳，壳就会长出「只有 explore 用的注入位」（代际点穴、`advance`、跨页去重），那与客户端观察通道曾就同一件事记过账（`client/explore-job.ts` 的头注：收手语义不是一种参数的两个值，塞进只有它用的注入位，壳就只剩转发）。所以只抽了挂点与信号两件机械，`SourceJobs`/`SearchJobs`/`ExploreJobs` 各自继续持有自己的状态。

同一条判据也管住了另外两处「看起来该搬」的东西：`shelfPut` 与 `authRoute` 按 body 形状分派到哪个门面动词，是**传输层的分派**而不是业务判据（值域门全在门面，见 `docs/adr/0019`）；导出区间的裁剪与那两条 422 的主人仍是路由层，`services/export.ts` 的头注就是这条分工的记录。三处的理由就地写在 `api/dispatch.ts` 末尾。

锚点：`src/services/bridge.ts` 的 `hitFieldsOf`；`src/shared/wire.ts` 的 `bodies` / `readBodies` / `BODY`；`src/services/explore-url.ts` 的 `usableKind` / `usableText`；`src/services/job-holder.ts`；`src/api/dispatch.ts` 的 `unknownRoute` / `methodNotAllowed`；`tests/services/job-holder.test.ts`；`tests/shared/wire-builders.test.ts`（body round-trip 与键名单点）；`tests/engine/js-protocol.test.ts`（async 行的能力位闸）。
