# 本地导入入口的判据：具名容器头收 UMD，声明 EPUB 而内容非 ZIP 的字节拒收并指路改回 .txt

Status: accepted

分流仍只看 ZIP 本地头签名，入口另加两道判据：认得出的具名容器头（PDF / MOBI / UMD）点名拒收，文件名词尾声明了 EPUB 而内容没有 ZIP 本地头的字节也拒收并指路改回 `.txt`——两道都只把「按 TXT 硬解成一本单章书」这条假成功挡掉，其余字节的去路一个不放宽。

## 决定

1. **具名容器头收 UMD**：`namedContainerMagicOf` 在 PDF（`%PDF-`，偏移 0）与 MOBI（`BOOKMOBI`，偏移 60）之外再认一种：偏移 0 起的四个字节 `89 9B 9A DE`（小端整数 `0xDE9A9B89`）即 UMD 的容器头。认出即 `LocalImportError`（400），消息点名是哪一种容器，并说清本地导入只支持 TXT 与 EPUB。
   **依据与残余风险**：UMD 没有公开的官方规范；这条签名由多份彼此独立的逆向解析资料一致给出，`tests/services/localbooks.test.ts` 的 UMD 用例钉住判据。它仍是白名单式的——只认这一种签名，认不出的字节照旧走解码链；残余风险是以这四字节开头的文本 TXT 会被误拒，出现即按误拒复审本条，不扩大为比例启发式。
2. **解码终点的断言仍是两条**：`assertReadableDecodedText` 只拒含 U+0000 的文本与整本只有空白这两类。带 ESC / BEL 一类控制字符的 GBK 文本照旧导入成功（钉子用例在 `tests/services/localbooks.test.ts`）；把判据扩到全量 C0 控制字符、或按不可读字节的比例估算，仍在被否之列——那会把现网真能读的导出文本换成拒收，比偶尔一本乱码书更坏。
3. **声明名与内容不符在入口拒**：文件名词尾是 `.epub`（大小写不敏感）而内容没有 ZIP 本地头签名，抛 `LocalImportError`：消息说清「文件名声明是 EPUB（.epub），但内容不是 ZIP 容器」并指路改回 `.txt`。判定只看**末级后缀**；名字只是「该按哪种容器去验、验不过报哪种错」的提示，从不改道——`.txt` 命名的 ZIP 照旧按 EPUB 入架，内容赢。顺序上具名容器头先判：命名成 `.epub` 的一份 PDF 得到的是「PDF 容器」那条更精确的原因。

## 被否方案

- **拿声明名当可信输入或唯一判据**：`?name=` 是客户端可写的查询参数，`ADR-0014` 第 ③ 条已为同一理由否过按后缀分流。本篇用的是它的反面——名字只决定「验哪一种容器、验不过说哪种话」，且只**多拒**（名字声明 EPUB 而内容不是 ZIP）从不**静默收**（名字声明 TXT 而内容是 ZIP 仍走 EPUB 路径）。
- **「看起来像二进制就拒」的比例启发式，以及把终点断言扩到全量 C0 控制字符**：维持 `ADR-0014` 第 ② 条的否决——它会误伤现网真能读的 GBK 短篇与含控制字符的导出 TXT。
- **在 `hasZipMagic` 之前先试开归档**：见 `ADR-0014`（把归档层明令的安全拒绝吞成「不是 EPUB」）。
- **只在 TXT 链入口查 NUL（不查全空白）**：全空白文件里没有 NUL，仍会以一本空书入架——同一条罪的另一半。

## 边界

- **残留面**：既没有具名签名、也不含 NUL、又不全空白的非文本字节，仍然会走完 TXT 链并以一本书入架。入口判据是**白名单**式的：只认得出列的这几种容器，认不出的一律交回解码链——这是明确的取舍，不是遗漏。
- **声明名规则只管末级后缀**：`book.epub.bak` 一类不在它的射程内；它也不参与书名兜底（TXT 的书名仍取上传名去扩展名，EPUB 仍优先取包内书名）。
- **只加拒收，不动既有成功路径**：ZIP 签名的分流、GBK 回退、带 BOM 的 UTF-16 文本、`.txt` 命名的 EPUB 一律照旧。

锚点：`src/services/localbooks.ts` 的 `namedContainerMagicOf` / `assertReadableDecodedText` / `LocalBooks.import` / `hasZipMagic`；
`tests/services/localbooks.test.ts`（UMD 具名头、声明名与内容不符、真 EPUB 命名成 `.txt` 三条，与 GBK 控制字符那条防回归钉）；
`tests/api/dispatch-local.test.ts`（声明 `.epub` 而内容非 ZIP 的 400）；`README.md` 的「本地书格式」；
矩阵行 `j-local-book`、`j-local-book-other-formats`；`ADR-0014`（分流判据与在册待裁的落定）、`ADR-0062`（本篇承接的入口与终点判据）。
