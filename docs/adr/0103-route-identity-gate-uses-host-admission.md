# `/novel-api` 的身份门用宿主准入面判 owner，来源判据仍归同源 fence

Status: accepted

宿主给路由的身份面在两条宿主线上形状不同：新线把 `auth` 与 handler Peer 做进路由声明，本仓编译所依的宿主线两样都没有。决定：**身份判据不挂在路由声明上，改用两条线都有的 `ctx.connection.admit` 判凭据身份；来源判据继续住同源 fence**。

## 背景

插件 API 的产品边界是「只服务本机」：loopback、Host 名单、Origin / Referer 同源四步不放宽，无 Origin / Referer 的本机调用放行——curl 与健康检查是写在 README 里的承诺。

新宿主线把路由鉴权收进载体：`WebRoute.auth` 默认 required，handler 收 Peer。把 owner 门写成 `auth: 'required'` 会带来两件事：无凭据的本机调用按宿主线分裂成 200 / 401，承诺随版本漂移；而编译所依的宿主线上根本没有这层，门等于没关——同机的非 owner 会话（他人共享的查看会话）照进。相比之下，`ctx.connection.admit` 两条线都在，职责原文就是「把宿主的主机 / 来源检查与浏览器认证 / API 凭据应用到另一个 Web 路由」。

## 决定

1. 路由显式声明 `auth: 'anonymous'`：插件自己准入，宿主的默认 required 不得替我们挡匿名本机调用（否则 README 的 curl / 健康检查承诺在部分宿主线上作废）。
2. 判据住 `src/index.ts` 的 `identityVerdict`：`admit` 给出 Peer 且 `principal.kind` 不是 owner → 403；`admit` 给出 rejection（无凭据 / 凭据无效）→ 放行，来源判据交给同源 fence；准入面缺席 → 只留 fence，不猜身份。
3. 准入面在却判不出来（`admit` 抛错、返回值不是那两态）→ 503 并留痕，不把故障降级成放行。
4. 准入面按用时重查 `ctx.get('connection')`：服务可能晚于本插件挂载，也可能中途卸装。

## 边界

- 这道门拦的是「带身份的非 owner 会话」，不是本机进程；同一台机器上的进程本来就能直接读写数据目录，本机调用扔掉凭据按匿名走是设计内的。
- 若用户配置了 `apiAllowHosts` 自定义本机别名，且宿主 `admit` 因自定义 `Host` 直接返回 rejection（未继续解析凭据），本门会将其交由同源 fence 放行；这意味着 `apiAllowHosts` 在该别名上同步放宽了宿主侧 Host 与凭据检查（与 `api/wire.ts` 对该选项的定位一致）。
- 来源判据、403 措辞与 Host 名单归属不变，仍住 `api/wire.ts` 与 `api/dispatch.ts`。
- 宿主版本与实测名单的事实源仍是 `package.json` 与 `tests/packaging.test.ts`；本篇不记录读数。

## 被否方案

- **`auth: 'required'` + handler Peer**：契约随宿主线漂移（同一条 curl 一半 200 一半 401），且在无该面的宿主上关不上门。
- **在 handler 里读 `ctx.connection.requestRejection`**：只有旧宿主线有这扇门，新线已删；选它等于把插件绑死在一条宿主线上。
- **只靠同源 fence，不判身份**：fence 判的是「请求从哪儿来」，判不了「调用者是谁」；同机非 owner 会话借 loopback 直接绕开。

## 后果

- 两条宿主线上 `/novel-api` 的匿名行为一致：curl 与健康检查照旧 200，来源不符仍由 fence 给 403。
- 非 owner 会话在两条线上都拿到 403，且看不到数据面；缺凭据的页面与其他本机工具不受影响。

锚点：`src/index.ts` 的 `identityVerdict` / `connectionOf`；`tests/index.test.ts` 的身份门用例（无凭据 / owner / 非 owner / 对端无身份 / 准入面故障）；
来源判据 `src/api/wire.ts` 的 `fenceDenialOf`；`docs/architecture.md` §4 的「调用者身份」行；类型镜像口径 `ADR-0020`。
