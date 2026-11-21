# 本地书按内容分流、两条路径互不兜底；发布与入架之间不建事务

Status: accepted

「书架 → 导入本地书籍」收 `.txt` 与 `.epub`。唯一判据是**文件头 4 字节**：是 ZIP 本地头签名就走 EPUB 路径，此后归档层与包层的**任何**失败都照原样上抛（加密条目、符号链接、非 store/deflate、重名、zip-slip、条目与解压超限、缺 `mimetype`、坏 XML），**不做 TXT 兜底**；不是 ZIP 的字节才走既有 TXT 解码链（BOM → UTF-8 严格探测 → GBK 回退）。为什么互不兜底：「先试着开归档、失败就当 TXT」正是把归档层明令的**安全拒绝**吞成「不是 EPUB」，再让 GBK 兜底与「无标题单章」把一份加密 ZIP 落成整本乱码。第二处裁决：本地发布与书架落盘之间**没有跨文件事务**，不建启动扫描器、不用自动删除掩盖；强杀在「元数据写完、书架落盘前」会留一份完整但未入架的副本，这是**已接受的窗口**——「扫 `local/` 里没有对应书架条目的 uuid 就删」会把「用户手动清过书架但想留文件」「多进程同时写同一数据根」一起误杀；要清就人工清 `local/`。被否决：试开归档失败回落 TXT；「二进制即拒收」的全量启发式；按文件后缀分流；复用远端解码链读本地文件；为 EPUB 改写旧 TXT 的偏移与进度。

锚点：`src/services/localbooks.ts`（`hasZipMagic` / `decodeLocalText` / `BOOK_KEY_RE`）；`src/services/epub/errors.ts`；`tests/services/localbooks.test.ts`；矩阵行 `j-local-book`、`j-local-book-epub`、`j-local-book-other-formats`；`ADR-0065`（具名容器头的最小拒收）。
