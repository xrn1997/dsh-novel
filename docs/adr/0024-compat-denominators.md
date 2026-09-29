# 兼容判据的三个分母：对面解析器、仓内冻结快照、离线 fixture

「彻底兼容 legado 书源格式」这条目标要有可复算的读数，三条分母各管一件事，混了就得到骗人的数字：

1. **做不做的判据 = 对面的解析器认不认**，不是「本库有没有源在用」。兼容目标是对面**格式**在本仓可用，本机源集不是全集——「现库数不出这种写法」只证明这批源没踩到，不证明适配完了。所以现库需求量从「不做」的理由**降级为「排到队尾」**（用来排实现顺序，不用来判做不做）。例外：CookieStore、限速器、登录面这类**运行时机制而不是格式**的，按机制有没有需求方单独裁。
2. **判据的分母必须架在仓内冻结快照上**。对面源码的三张清单（源根路径集 / 规则实体字段表 / java 宿主方法名集）在开发阶段抽一次入库成 `compat/upstream/snapshot.json`，日常跑门只读它，运行时不需要任何外部 checkout。**快照不在场即红，不许改成 skip-if-missing**——上一版的分母是一份不入库的手抄笔记，笔记一消失判据就**静默转 skip、无一物变红**，这扇门专门就是为了删掉那种失效模式而存在的。
3. **`compat` 回放「跑通率」的分母是 fixture，不是站点可用率**。它是规则引擎离线回放的回归基线，不覆盖真实 HTTP / 重定向 / GBK / 超时 / 反爬 / `@js` 真实宿主。站点可用率另有两扇门：搜索面是 `DSH_REPROBE`，正文面是 `DSH_CONTENT_AUDIT`——后者是**审计报告**、不设通过率断言，分桶读数要人判。分母构成由报告按各 case 的采集时刻**自述**真站 / 合成条数：写死在模板里的口径句会在真站 fixture 缺席时继续宣称它们在场。

同族的一条采集纪律：**采集与回放必须断同一批**（两侧共用同一份判据），否则会出现「采集绿、回放红」的 fixture；manifest 的键是**请求 URL**而不是重定向后的落地地址；落盘的是生产解码链读到的文本（非 UTF-8 页存成真中文）。

锚点：`tests/legado-coverage/{status-evidence,inventory-coverage,upstream-fields,host-methods}.test.ts`；`tests/legado-coverage/{upstream-facts,capture-upstream-snapshot}.test.ts`；`tests/compat/{harness,record}.ts`；`compat/upstream/snapshot.json`；`README.md`「测试与真链路门控」；`AGENTS.md`「兼容判据」。
