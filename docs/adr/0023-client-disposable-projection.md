# 浏览器半只留可丢弃投影；反馈的位置就是点击的位置

Status: superseded by 0046

业务真相在服务端，浏览器半每次挂载经 `/novel-api` 拉取，组件内 state 持有；模块级 store 只承担**跨卸载要活下来**的现场（视图内路由、偏好、列表筛选与勾选、任务面镜像、瞬态队列）。在途工作与整轮结果不在浏览器半：卸载只是停止看，重挂载从 `since=0` 重读就全回来。轮次身份与游标不可分开：每个回包先验 `job.id` 与观察中的轮次一致，不一致即丢掉旧累积、`since=0` 重读新轮基线、旧连接 abort、按新轮重建；关键词不是身份。反馈位置 = 点击位置：秒级乐观操作不进全局泳道，失败即刻回滚并带行锚点进 error 泳道，成功与失败都重读一次让服务端结果二次校准。色值与尺寸只准住 token 层，视图与逻辑层不许内联颜色字面量。

锚点：`src/client/search-job.ts`；`src/client/store.ts`；`src/client/transient.ts`；`src/client/views/SettingsSourceList.tsx`；`src/client/views/SearchView.tsx`；`src/client/views/CityBookSheet.tsx`；`tests/client/theme-tokens.test.ts`；`tests/client/settings-toggle.test.tsx`；`tests/client/city-view.test.tsx`。
