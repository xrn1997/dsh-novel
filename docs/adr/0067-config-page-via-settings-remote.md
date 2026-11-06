# 配置页走宿主设置面（`remote.settings`），不引宿主 client 包

Status: accepted

插件页的「运行参数」保留，但读写改走宿主编目的设置服务（`settingsController` 的 `describe` / `mutate`，客户端面是 `ctx.remote.settings`）；页面自己持有草稿与保存态，不再 import 任何宿主 client 包——页面/面板的校验清单明确禁止后者。

## 背景

页面校验清单要求「插件不 import `@deepseek-ai/dsh-client-ui-primitives` 这类 Harness Client 包」。配置页原先靠这份原语的 `SettingsForm` / `SettingsFormModel` 与两个字段工厂，整个浏览器半因此在 factory 求值期就 require 了它：模块一旦缺席或改名，侧栏、主面板、常驻状态层会一起装不上，而不只是少一页。原语本身只是宿主设置服务之上的表单模型；写协议与值域从来不在它手里。

## 决定

- **读写只经 `ctx.remote.settings`**：`describe()` 读 `{ writable, namespaces[{ ns, value, user, revision }] }`，`mutate(ns, ops, revision)` 一次原子写；恢复默认 = 单字段 `unset`（撤用户层覆盖，不把出厂值抄回去）。
- **页面拥有呈现与草稿**：字段清单、单位、人话回读、预设档、分区、脏标记与保存态仍在 `config-page.tsx` 自绘；`NovelConfigPageView` 保持纯呈现，几何门静态渲染同一份组件。
- **值域仍归 schema**：本页只判类型错（数字位非负整数；文本位首尾空白归一后不含内部空白）；上下界、代理形状由宿主在 `mutate` 时裁决，拒绝时原样显示宿主给的理由并保留草稿。
- **冲突不让页面进死路**：`mutate` 回 `settings/conflict` 时保留草稿并重读修订号，下一次保存继续；不订阅外部变更，展示值仍要重开页面才刷新。
- **能力缺席即退让**：`ctx.inject(['remote', 'remote.settings'], …)` 可选注册；宿主没有设置面时这一页不出现，其余座位照常。
- **平台模块表回到两条**：`react` / `react/jsx-runtime`；产物自检的独立抄本同步成两条。

## 被否方案

- **继续用宿主表单原语**：直接违反页面校验清单；且静态 import 在 CJS 闭合工厂里无法懒加载，整个浏览器半随它一起承险。
- **删掉配置页**：活配置（代理、并发、预算、缓存上限）就没有编辑面，只能改 patch 重启，热更通路失去主要消费者。
- **直接用 `configForms` 服务**：写协议确实够用，但该服务不在检查器的 Service 目录里，无法按「先确认再依赖」的规矩落字；`remote.settings` 背后的 `settingsController` 是编目服务，契约可查（`describe` / `mutate` / 修订号与冲突分类）。

## 代价

- 每次打开/保存多一次远程往返；页面不订阅宿主文档变更，外部改配置后要重开页面才刷新（原先的共享镜像替身本来只在测试里）。
- 宿主拒绝只回一条理由，不再有逐字段的 schema 级提示；本页只兜类型错。取舍是「不抄第二份值域」。

锚点：`src/client/config-page.tsx` 的 `registerConfigPage` / `NovelConfigCard` / `NovelConfigPageView`；`src/client/index.tsx` 的可选 `ctx.inject(['remote', 'remote.settings'], …)`；`tsdown.config.ts` 的 `PLATFORM_MODULES`；`tests/packaging-build.test.ts` 的「client 半纯度：require 集合恰为约定两条」；`tests/client/config-page.test.tsx`；`tests/browser/config-page-layout.test.tsx`；`ADR-0035`、`ADR-0066`。
