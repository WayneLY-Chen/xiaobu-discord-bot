/**
 * 模型偶爾會陷入「重複迴圈」：不斷吐出省略號、換行或同一個符號，
 * 中間夾雜幾個字，直到撞到 token 上限或自己恢復。
 *
 * 這種回覆在 API 層面完全正常（HTTP 200、finish_reason=stop），
 * 但對使用者來說就是一大坨垃圾。實際遇過的例子：問「現在幾點？」
 * 回了 2,705 個字元，其中只有 133 個是真正的字。
 *
 * 判定條件刻意保守，寧可漏掉也不要誤判：
 * - 只檢查夠長的回覆。短回覆本來就可能只有表情符號或標點（「……」「🙂」），
 *   那是正常的說話方式，不是壞掉。
 * - 「有意義的字」＝ 中日韓文字、字母、數字。標點、符號、空白都不算。
 * - 有意義的比例低於門檻才算壞掉。正常的中文句子這個比例都在 70% 以上，
 *   就算滿滿的 emoji 或 Markdown 符號也很難掉到 15% 以下。
 */

/** 低於這個長度不檢查 —— 短回覆只有符號是正常的。 */
const MIN_LENGTH_TO_CHECK = 300;

/** 有意義字元佔非空白字元的比例，低於此值視為重複迴圈。 */
const MIN_SUBSTANTIVE_RATIO = 0.15;

const SUBSTANTIVE = /[\p{Letter}\p{Number}]/u;

export function isDegenerate(text: string): boolean {
  if (text.length < MIN_LENGTH_TO_CHECK) return false;

  let total = 0;
  let substantive = 0;

  for (const char of text) {
    if (/\s/u.test(char)) continue;
    total += 1;
    if (SUBSTANTIVE.test(char)) substantive += 1;
  }

  if (total === 0) return false;

  return substantive / total < MIN_SUBSTANTIVE_RATIO;
}
