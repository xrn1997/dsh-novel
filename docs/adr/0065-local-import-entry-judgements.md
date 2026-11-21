# 本地导入入口的判据：具名容器头收 UMD，声明 EPUB 而内容非 ZIP 的字节拒收并指路改回 .txt

Status: accepted

分流仍只看 ZIP 本地头签名，入口另加两道判据：认得出的具名容器头（PDF / MOBI / UMD）点名拒收，文件名词尾声明了 EPUB 而内容没有 ZIP 本地头的字节也拒收并指路改回 `.txt`——两道都只把「按 TXT 硬解成一本单章书」这条假成功挡掉，其余字节的去路一个不放宽。

## 决定

1. **具名容器头收 UMD**：`namedContainerMagicOf` 在 PDF（`%PDF-`，偏移 0）与 MOBI（`BOOKMOBI`，偏移 60）之外再认偏移 0 起的 `89 9B 9A DE`（UMD 容器头）。认出即 `LocalImportError`（400），消息点名是哪一种容器。**依据与残余风险**：UMD 没有公开官方规范，这条签名由多份独立逆向资料一致给出，测试钉住；它仍是白名单式的，认不出的字节照旧走解码链；以这四字节开头的文本 TXT 会被误拒，出现即按误拒复审本条。
2. **解码终点的断言仍是两条**：`assertReadableDecodedText` 只拒含 U+0000 的文本与整本只有空白这两类；带 ESC / BEL 一类控制字符的 GBK 文本照旧导入成功。把判据扩到全量 C0 控制字符、或按不可读字节比例估算仍在被否之列。
3. **声明名与内容不符在入口拒**：文件名词尾是 `.epub`（大小写不敏感）而内容没有 ZIP 本地头签名，抛 `LocalImportError` 并指路改回 `.txt`。判定只看**末级后缀**；名字只决定「验哪一种容器、验不过说哪种话」，从不改道——`.txt` 命名的 ZIP 照旧按 EPUB 入架，内容赢。顺序上具名容器头先判。

## 被否方案

- 拿声明名当可信输入或唯一判据：`?name=` 是客户端可写的查询参数；本篇只让名字**多拒**（声明 EPUB 而内容不是 ZIP），从不**静默收**（声明 TXT 而内容是 ZIP 仍走 EPUB 路径）。
- 「看起来像二进制就拒」的比例启发式，以及把终点断言扩到全量 C0 控制字符：会误伤现网真能读的 GBK 短篇与含控制字符的导出 TXT。
- 在 `hasZipMagic` 之前先试开归档：把归档层明令的安全拒绝吞成「不是 EPUB」。

## 边界

- **残留面**：既没有具名签名、也不含 NUL、又不全空白的非文本字节，仍会走完 TXT 链并以一本书入架；入口判据是白名单式的，这是明确取舍。
- 声明名规则只管末级后缀（`book.epub.bak` 不在射程内），也不参与书名兜底。
- 只加拒收，不动既有成功路径。

锚点：`src/services/localbooks.ts` 的 `namedContainerMagicOf` / `assertReadableDecodedText` / `LocalBooks.import` / `hasZipMagic`；`tests/services/localbooks.test.ts`（UMD 具名头、声明名与内容不符、真 EPUB 命名成 `.txt` 三条，与 GBK 控制字符那条防回归钉）；`tests/api/dispatch-local.test.ts`；`README.md` 的「本地书格式」；矩阵行 `j-local-book`、`j-local-book-other-formats`；`ADR-0014`、`ADR-0062`。
