# 兼容分母不再冻结外部快照：默认门自证，格式覆盖走实时普查

Status: accepted

兼容判据曾把外部实现的规则实体字段表与 Java 宿主方法名集冻结成一份仓内快照，作为两门默认测试的分母。该快照的来源、分组与覆盖范围都来自外部实现：它只覆盖七个规则实体类，不是一份独立的 legado 书源格式规范；所有权判据又只要求字段名在矩阵文本里出现。继续保留它，等于在仓内继续把外部实现当兼容权威。决定：**退役该快照与 `upstream-fields` / `host-methods` 两门**。

默认门只保留矩阵自证：`status-evidence` 验每行证据可回查，`inventory-coverage` 验每个能力单元挂到真实矩阵行，`bridge-surface` / `demand-keys` 只问本仓沙箱与矩阵绑定。格式字段与宿主方法的现量覆盖改由解析面普查（`DSH_PARSE_CENSUS`）读取现库后报告；`KNOWN_BRIDGE_GAPS` 是「源在调、本仓没挂」的唯一名册，新名字在普查里判红。离线回放仍以 fixture 为分母，不在此列。

**`ADR-0024` 另两条由本篇承接**（那篇整篇标了取代，但里面两条纪律仍然成立，家挪到这里）：① 判「做不做」的是规则文本认不认这种写法，不是本库此刻有没有源在用——现库需求量只用来排队，不作否决；HTTP cookie jar、限速器、登录面这类**运行时机制而不是格式**的，按有没有需求方单独裁。② 偏离逐条登记：分叉的读数与理由只住矩阵行 `note`，一行一个时效锚；仓内的表（`KNOWN_BRIDGE_GAPS` 与矩阵行）缺项即红，不许 skip-if-missing。

**代价**：不再有机器承诺「外部实现的每个字段/方法都有归属」。现库没有用到的形态可以不在任何分母里；要补完备性，只能基于本仓自己的表（`src/services/rule-fields.ts` / `src/engine/js-protocol.ts`）或现查宿主发布物，不能恢复冻结外部快照。被退役的宿主方法门另有一条**反向**判据——名册里点名的缺席项若其实已挂上桥面即报红；这条由默认门 `tests/legado-coverage/bridge-surface.test.ts` 守（只问本仓沙箱与名册）。矩阵的未挂行仍会随实现过期：默认门能查出名册没删，查不出矩阵 `note` 的措辞过时；接桥面时须同批改名册与那一行 `note`。

**被否方案**：把快照换成另一份手工维护的格式清单——清单一消失又会静默转 skip，且仍是第二份抄本；把两门改成对 `src/services/rule-fields.ts` 的自证——只证明「已知解析面有主」，发现不了格式里还没进视野的键，容易让人误以为门还在守格式完备性。真正的发现走现库普查。

锚点：`tests/legado-coverage/{status-evidence,inventory-coverage,bridge-surface,demand-keys}.test.ts`；`tests/legado-coverage/{bridge-gaps,demand-keys,matrix-source}.ts`；`tests/engine/parse-census.test.ts`；`tests/legado-coverage/matrix.ts`；`src/services/rule-fields.ts`；`src/engine/js-protocol.ts`；`tests/replay/{harness,record}.ts`；`docs/development.md`「门（自动）」；`AGENTS.md`「必须过的门」。
