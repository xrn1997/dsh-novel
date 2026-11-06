# 配置页跟宿主表单原语走：唯一一处宿主 client 包值依赖，失败半径钉在导出守卫上

Status: superseded by 0067

插件页的「运行参数」需要「读活配置 → 编辑草稿 → 保存 / 丢弃 / 回字段」这一整套表单语义，宿主把它装在一份 client 侧的设置表单原语里，宿主自己的设置页用的也是同一份；本仓采用它，并把「模块在、导出变」的失败半径压到一页。

## 背景

`plugins.bundle.config` 的 owner props 今天只给 `view`（`summary | page`）——可写表单那一路（`form`）不被传入，所以「用 owner props 自己画表单」这条路还没有面。宿主也没有把配置表单服务收进编目面：它是官方设置类插件 `inject` 里的一等依赖，但它的快照只给状态、可写位、修订号与整份值；字段级编辑、脏标记、保存失败与逐字段复位住在原语里。

## 决定

- **只引这一条宿主 client 包**，且只从 `config-page.tsx` 引；`tsdown.config.ts` 的平台模块表与产物自检的独立抄本都只留它（外加 `react` / `react/jsx-runtime`）。
- **失败半径钉在「一页」**：`SettingsForm` / `SettingsFormModel` / 两个字段工厂逐个查在场，缺任一件就不注册配置页；侧栏、主面板、常驻状态层照常。模块整件缺席由冻结模块表兜住（`ADR-0021` 的交集判据）。
- **每次升宿主代次复核一次**：这条依赖的复核项写进 `docs/development.md` 的宿主兼容流程，与平台模块表同一次重读。

## 边界

不引第二条：本地状态自持（`ADR-0055`），槽位与 cordis 全为 type-only。配置页仍只经宿主写，不改 `cordis.patch.yml`；`dataDir` 等非活值不进表单（`ADR-0035`）。

## 被否方案

- **删掉配置页**：活配置（代理、并发、预算、缓存上限）就没有编辑面，只能改 patch 重启；热更通路也失去主要消费者。
- **自绘表单 + 直接对配置快照写**：快照不是写协议；字段级校验、脏标记、保存失败这些语义要么重造一遍（比原语更易漂），要么悄悄丢掉。
- **懒加载原语**：client 产物是 CJS 闭合工厂，静态 import 在 factory 求值期就 require；没有可用的动态模块解析面，拆不出「用到才取」。

## 代价

宿主换了原语导出而模块仍在时，配置页消失（守卫拦下），其余照常；模块整件缺席则整个浏览器半装不上——这是 `ADR-0021` 已经接受的平台表前提，不是本决定新增的。

锚点：`src/client/config-page.tsx` 的 `registerConfigPage`；`tsdown.config.ts` 的 `PLATFORM_MODULES`；`tests/packaging-build.test.ts` 的「client 半纯度」；`tests/client/config-page.test.tsx`；`docs/development.md`「宿主兼容与实测名单」；`ADR-0021`、`ADR-0035`、`ADR-0055`；本决定已被 `ADR-0067` 取代。
