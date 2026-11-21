# 客户端本地状态自持三原语 store，不接宿主的 store 引擎

Status: accepted

浏览器半要守的现场只有「跨卸载活下来」那一类（视图内路由、偏好、筛选与勾选、任务面镜像、瞬态队列），需要的原语就三件：读、打补丁写、订阅。决定：`client/store.ts` 自持这张表，由 `useSyncExternalStore` 驱动；不接宿主侧的 store 引擎（平台模块表里有它，本仓不 import）。业务真相仍在服务端，每次挂载经 `/novel-api` 拉；唯一例外是书架的读取面与落架账（面板期投影）。**为什么不接**：通知时机是本仓行为网的钉，换引擎等于语义搬家而不是删一份抄本，整张行为网要重验，而换来的能力当前没有消费点。**边界**：不裁「要不要把这层投影升格为 Client model」；`useStoreValue` 在同一份 `subscribe` 上加一层原语选择器，不加第四件原语。被否决：接宿主 store 引擎；把现场全塞进组件 `useState`。

锚点：`src/client/store.ts` 的 `createStore` / `useStore` / `useStoreValue` / `Store`；`tests/client/logic.test.ts`；`tests/client/store-selector.test.tsx`；`tsdown.config.ts` 的 `PLATFORM_MODULES`；`ADR-0046`。
