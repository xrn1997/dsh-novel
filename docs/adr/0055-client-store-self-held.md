# 客户端本地状态自持三原语 store，不接宿主的 store 引擎

Status: accepted

浏览器半要守的现场只有「跨卸载活下来」那一类（视图内路由、偏好、筛选与勾选、任务面镜像、瞬态队列），需要的原语就三件：读、打补丁写、订阅。决定：`client/store.ts` 自持这张表，由 `useSyncExternalStore` 驱动；不接宿主侧的 store 引擎（平台模块 `@deepseek-ai/dsh-client-store` 在 `tsdown.config.ts` 的平台模块表里，本仓不 import 它）。业务真相仍在服务端，每次挂载经 `/novel-api` 拉；唯一例外是书架的读取面与落架账，那是面板期投影（`ADR-0046`）。

**为什么不接**：通知时机是本仓行为网的钉——`tests/client/logic.test.ts` 的「get/set/subscribe 语义 + patch 合并」钉的就是「谁在什么时候被通知」。把引擎换进来，通知时机、写入合并与持久化归属都改由别人定，那是**语义搬家而不是删一份抄本**：整张行为网要重验一遍，而换来的能力当前没有消费点。三原语自持的成本是三十行表，加上一条边界——它不承担跨页与跨会话状态。

**边界**：本篇不裁「要不要把这层投影升格为官意义上的 Client model」，那条至今没有裁决；也不裁宿主的 store 引擎怎么实现——本仓只问自己有没有 import 它。

**被否方案**：接宿主 store 引擎（通知时机与持久化交出去，行为网整体重验）；把现场全塞进组件 `useState`（中央座位切走即卸载，结果清零、站点白挨剩余请求）。

锚点：`src/client/store.ts` 的 `createStore` / `useStore` / `Store`；`tests/client/logic.test.ts` 的「get/set/subscribe 语义 + patch 合并」；`tsdown.config.ts` 的 `PLATFORM_MODULES`；`ADR-0046`（面板期投影，唯一例外）。
