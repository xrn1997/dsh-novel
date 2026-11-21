# 配置页跟宿主表单原语走：唯一一处宿主 client 包值依赖，失败半径钉在导出守卫上

Status: superseded by 0067

插件页的「运行参数」需要「读活配置 → 编辑草稿 → 保存 / 丢弃 / 回字段」的完整表单语义，宿主把它装在一份 client 侧设置表单原语里。本仓曾只引这一条宿主 client 包、只从 `config-page.tsx` 引，并把「模块在、导出变」的失败半径压到一页（缺任一件就不注册配置页）；模块整件缺席由冻结模块表兜住。被否决：删掉配置页；自绘表单直接对快照写；懒加载原语（CJS 闭合工厂拆不出「用到才取」）。代价：宿主换了原语导出而模块仍在时配置页消失；模块整件缺席则整个浏览器半装不上。本决定已被 `ADR-0067` 取代。

锚点：`src/client/config-page.tsx` 的 `registerConfigPage`；`tsdown.config.ts` 的 `PLATFORM_MODULES`；`tests/packaging-build.test.ts`；`tests/client/config-page.test.tsx`；`ADR-0021`、`ADR-0035`、`ADR-0055`、`ADR-0067`。
