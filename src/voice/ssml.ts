/**
 * SSML 的跳脫。
 *
 * 兩家雲端 TTS（Microsoft Edge 與 Azure Speech）都是把文字內插進 SSML 樣板，
 * 且都不做跳脫。送進去的是語言模型的輸出，而小步是公開邀請的 Bot ——
 * 有人有辦法誘導模型吐出 `</prosody><voice name="...">` 之類的東西，
 * 就能換掉聲線甚至改寫整段 SSML。所以這一層是安全邊界，不是防呆。
 */
const XML_ESCAPES = new Map([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
  ["'", '&apos;'],
]);

export function escapeForSsml(text: string): string {
  return Array.from(text)
    .map((char) => XML_ESCAPES.get(char) ?? char)
    .join('');
}

