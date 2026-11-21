# 兼容分母不冻结外部快照：默认门只留两门，格式覆盖走实时普查

Status: accepted

本篇取代 `ADR-0054`：兼容分母不冻结外部快照的结论不变，legado 兼容默认门由四门收成两门。兼容判据曾把外部实现的规则实体字段表与 Java 宿主方法名集冻结成一份仓内快照，作为两门默认测试的分母；该快照只覆盖七个规则实体类，不是一份独立的书源格式规范，继续保留等于继续把外部实现当兼容权威。决定：**退役该快照与 `upstream-fields` / `host-methods` 两门**；默认门只保留矩阵自证——`status-evidence` 验每行证据可回查，`bridge-surface` 只问本仓沙箱与矩阵绑定。`inventory-coverage`（每个能力单元各挂 ≥2 条矩阵行）与 `demand-keys`（矩阵行需求读数键绑定与日期锚）同批退役：两者审的是证据登记册的配额与键表形状，不是代码事实——配额逼着为每格补行，却拦不住任何真实缺陷；键表绑定与解析面普查的键表自洽重复。键表 `demand-keys.ts`、矩阵登记册与普查报告仍在，需求读数改由普查读取。被否决：保留四门；把两门并入 `status-evidence`（一行一条证据与一格一配额是两种判据）。格式字段与宿主方法的现量覆盖改由解析面普查（`DSH_PARSE_CENSUS`）读取现库后报告；`KNOWN_BRIDGE_GAPS` 是「源在调、本仓没挂」的唯一名册，新名字在普查里判红；离线回放仍以 fixture 为分母。**承接 `ADR-0024` 两条**：判「做不做」的是规则文本认不认这种写法（现库需求量只排队）；偏离逐条登记，分叉读数与理由只住矩阵行 `note`，缺项即红。**代价**：不再有机器承诺「外部实现的每个字段/方法都有归属」，也不再有用例配额承诺「每个能力单元至少两条矩阵行」，需求读数也不再有「每条必带日期锚」的机器检查（`demand[].asOf` 照写，时效由普查漂移打印与人工复核兜着）；要补完备性只能基于本仓自己的表或现查宿主发布物。

锚点：`tests/legado-coverage/{status-evidence,bridge-surface}.test.ts`；`tests/legado-coverage/{bridge-gaps,demand-keys,matrix-source}.ts`；`tests/engine/parse-census.test.ts`；`tests/legado-coverage/matrix.ts`；`src/services/rule-fields.ts`；`src/engine/js-protocol.ts`；`tests/replay/{harness,record}.ts`；`docs/development.md`「门（自动）」；`AGENTS.md`「必须过的门」；`ADR-0054`；`ADR-0024`。
