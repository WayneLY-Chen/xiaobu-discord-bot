import OpenCC from 'opencc-js';

/**
 * 比對用的正規化。
 *
 * 兩邊（設定的觸發詞、收到的訊息）都要過這一層，否則會靜默對不上：
 * - **簡繁**：管理員用繁體設「窗外的天氣」，簡體使用者打「窗外的天气」永遠不會命中。
 *   用的轉換器與語音辨識同一組（cn → twp），這樣文字與逐字稿的行為才一致。
 * - **全形/半形**：ＷＩＮＤＯＷ 與 WINDOW 是不同字元，NFKC 會把它們攤平。
 * - **大小寫**：英文觸發詞不該分大小寫。
 * - **空白**：Discord 上同一句話的空白數量常常不同。
 */
const toTraditional = OpenCC.Converter({ from: 'cn', to: 'twp' });

export function normalizeForMatch(text: string): string {
  return toTraditional(text.normalize('NFKC').toLowerCase()).replace(/\s+/g, '');
}

/** 只有標點、空白或控制字元 —— 這種觸發詞會命中幾乎所有訊息。 */
const PUNCTUATION_ONLY = /^[\p{P}\p{S}\p{Z}\p{C}]+$/u;

export function isUsableTriggerPhrase(normalized: string): boolean {
  return normalized.length >= 2 && !PUNCTUATION_ONLY.test(normalized);
}
