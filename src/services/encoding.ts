import iconv from 'iconv-lite'

/** iconv 认得这个编码名吗。独立成函数是因为 iconv 的判据是**类型谓词**：直接写在条件里，
 *  「不认得」那一支会把这个名字收窄成空集，报错文案就念不出用户填的值。 */
export function encodingKnown(name: string): boolean {
  return iconv.encodingExists(name)
}
