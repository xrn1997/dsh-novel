# 收口只抽机械，不抽转发壳

Status: accepted

四处重复各归了一家（逐条目取值装配 → `bridge.hitFieldsOf`、写路由 body 形状 → `shared/wire.ts` 的 `bodies`/`readBodies`、分类条目可用尺 → `explore-url.usableKind`、宿主登记与「变了」信号 → `job-holder.ts` 的 `HostTie`/`ChangeSignal`）。本篇**否决**的是两件顺手的泛型：

- **「route 注册壳」**（把 `dispatch.ts` 里成片的 `writeOk` / `new ApiError` 调用包成一条 `route(method, path, handler)`）。被否的理由：这几样**已经各有主人**（`api/wire.ts` 的信封与分类表；路径与方法的匹配在 `api/routes.ts` 的匹配器，方法不符的 405 文案由 `api/dispatch.ts` 的 `methodMismatchError` 单点承接），臂里那两行只是调用，不是判据的副本——套一层壳后壳内只剩转发，deletion test 直接判它出局。真正在重复的是 body 的**形状**（键名两半各写一遍），那个归了 wire，壳的动机随之一并消失。留下的三处重复措辞各归一个单点：「未知路由」404 与「方法不允许」405 分别是 `unknownRoute` / `methodMismatchError`，因为 `routes.test.ts` 的落点判据就是那句前缀，漏改一处会让测试找不到证据。
- **「任务运行器泛型」**（`JobHolder<S>` 一个模子，三个 kind 只交快照与判据）。被否的理由：三个持有者真正相同的是**宿主接线**（`ctx.jobs` 登记、协作式取消记账、终态结算、过程行拉取、`subscribe`/`notify`），不同的是状态形状、槽政策与业务判据——后者才是各自存在的理由。把它们塞进一个泛型壳，壳就会长出「只有 explore 用的注入位」（代际点穴、`advance`、跨页去重），那与 `client/explore-job.ts` 头注记的是同一件事：收手语义不是一种参数的两个值，塞进只有它用的注入位，壳就只剩转发。所以只抽了挂点与信号两件机械，`SourceJobs`/`SearchJobs`/`ExploreJobs` 各自继续持有自己的状态。

同一条判据也管住了另一处「看起来该搬」的东西：`shelfPut` 与 `authRoute` 按 body 形状分派到哪个门面动词，是**传输层的分派**而不是业务判据（值域门全在门面，见 `ADR-0019`），理由就地写在 `api/dispatch.ts` 末尾。同一条判据也定了**存在性与 body 形状的先后**：这个 id 在不在是门面读一次注册表才知道的事（`services/reading.ts` 的 `requireSource` 抛 `SourceNotFoundError`，由分类表投影成 404），不是传输层的判据——故路由不预检存在性，未知源配垃圾 body 得 400、配超限 body 得 413，形状与体积都过了才轮到门内那一声 404。被否的写法是让路由先确认一次存在：每个写臂因此各养一份「先查在不在」的抄本，而这条判据的家本来就在门面。导出区间的裁剪与那两条 422 不在这条判据之下：它们是导出动作自己的区间判据（缺省全本、越界裁剪、裁剪后倒置），主人是 `services/reading.ts` 的 `exportRange`，路由只留参数形态校验（parseEdge 的 400）、写头与流式机械——裁案与理由见 `ADR-0052`。

锚点：`src/services/bridge.ts` 的 `hitFieldsOf`；`src/shared/wire.ts` 的 `bodies` / `readBodies` / `BODY`；`src/services/explore-url.ts` 的 `usableKind` / `usableText`；`src/services/job-holder.ts`；`src/api/dispatch.ts` 的 `unknownRoute` / `methodMismatchError`；`tests/services/job-holder.test.ts`；`tests/shared/wire-builders.test.ts`（body round-trip 与键名单点）；`tests/engine/js-protocol.test.ts`（async 行的能力位闸）；`src/services/reading.ts` 的 `requireSource` 与 `tests/api/routes.test.ts`（存在性归门面、形状先于 404 的钉）；`ADR-0052`。
