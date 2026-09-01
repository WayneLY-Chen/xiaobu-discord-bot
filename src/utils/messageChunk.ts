import { DISCORD_MESSAGE_LIMIT } from '../config/constants.js';

/** 在 code block 中間斷開時，補在段尾的收尾標記。 */
const FENCE_CLOSE = '\n```';

/**
 * 把長回覆切成多則 Discord 訊息。
 *
 * 優先在段落 / 換行處斷開，並且會追蹤 ``` code fence：
 * 如果一段在 code block 中間被切斷，會自動補上收尾與下一段的開頭，
 * 否則 Discord 會把後半段整個當成純文字顯示。
 *
 * 每一段（含補上的 fence）都保證不超過 limit。
 */
export function chunkMessage(text: string, limit: number = DISCORD_MESSAGE_LIMIT): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= limit) return [trimmed];

  const chunks: string[] = [];
  let rest = trimmed;
  let openFence: string | null = null;

  while (rest.length > 0) {
    const prefix = openFence ? `${openFence}\n` : '';

    // 剩下的放得進最後一段就結束，不需要再預留收尾空間
    if (prefix.length + rest.length <= limit) {
      chunks.push(prefix + rest);
      break;
    }

    // 這一段有可能停在 code block 中間，所以先把收尾標記的空間留出來
    const budget = Math.max(1, limit - prefix.length - FENCE_CLOSE.length);
    const cut = Math.max(1, findCutPoint(rest, budget));
    const piece = rest.slice(0, cut).trimEnd();
    rest = rest.slice(cut).trimStart();

    openFence = trackFence(openFence, piece);
    chunks.push(openFence ? prefix + piece + FENCE_CLOSE : prefix + piece);
  }

  return chunks;
}

/** 在 budget 內找最好的斷點：段落 > 換行 > 空白 > 硬切。 */
function findCutPoint(text: string, budget: number): number {
  const window = text.slice(0, budget);

  for (const separator of ['\n\n', '\n', ' ']) {
    const index = window.lastIndexOf(separator);
    // 太靠前的斷點會產生一堆碎片，不如硬切
    if (index > budget * 0.5) return index + separator.length;
  }

  return budget;
}

/** 回傳這段文字結束後仍未關閉的 fence（例如 "```ts"），沒有則為 null。 */
function trackFence(current: string | null, piece: string): string | null {
  let fence = current;

  for (const line of piece.split('\n')) {
    if (!line.trimStart().startsWith('```')) continue;
    fence = fence ? null : line.trim();
  }

  return fence;
}
