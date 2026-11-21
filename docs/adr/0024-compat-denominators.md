# 兼容判据的三个分母：书源规则怎么读、仓内冻结快照、离线 fixture

Status: superseded by 0054

「彻底兼容 legado 书源格式」要有可复算的读数，三条分母各管一件事：① **做不做的判据 = 书源规则认不认**，不是「本库有没有源在用」——现库需求量只用来排实现顺序（运行时机制而不是格式的，按机制有没有需求方单独裁）。② **判据的分母必须架在仓内冻结快照上**：规则实体字段表 / java 宿主方法名集冻结入库，日常跑门只读它；**快照不在场即红，不许改成 skip-if-missing**。③ **离线回放的分母是 fixture，不是站点可用率**：它不覆盖真实 HTTP / 重定向 / GBK / 超时 / 反爬 / `@js` 真实宿主；站点可用率另有 `DSH_REPROBE`（搜索面）与 `DSH_CONTENT_AUDIT`（正文面审计报告，不设通过率断言）。同族的采集纪律：采集与回放断同一批；manifest 的键是**请求 URL**而非重定向后的落地地址；落盘的是生产解码链读到的文本。

锚点：`tests/legado-coverage/status-evidence.test.ts`；`tests/replay/{harness,record}.ts`；`docs/development.md`「门（自动）」；`AGENTS.md`「必须过的门」；`ADR-0054`。
