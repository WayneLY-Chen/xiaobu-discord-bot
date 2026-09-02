/** 一次生圖請求。尺寸刻意用固定選項而不是任意數字，見 IMAGE_SIZES。 */
export interface ImageRequest {
  prompt: string;
  size: ImageSize;
  timeoutMs: number;
}

// 註：這裡刻意沒有「安全過濾」的開關。公開邀請的 Bot 一定會收到成人向的
// prompt，過濾是各 provider 內部寫死的，不開放呼叫端關閉。

/**
 * 只提供這幾種尺寸。
 *
 * 讓模型自由填寬高會得到各種奇怪的數字（3px、8000px），還要另外驗證；
 * 而且生圖服務對非標準尺寸的品質本來就比較差。
 */
export const IMAGE_SIZES = {
  square: { width: 1024, height: 1024 },
  landscape: { width: 1280, height: 768 },
  portrait: { width: 768, height: 1280 },
} as const;

export type ImageSize = keyof typeof IMAGE_SIZES;

export const IMAGE_SIZE_IDS = Object.keys(IMAGE_SIZES) as [ImageSize, ...ImageSize[]];

export interface GeneratedImage {
  /** 圖片位元組，直接當成 Discord 附件送出。 */
  data: Buffer;
  /** 送出時用的檔名（含副檔名）。 */
  filename: string;
  /** 實際產生這張圖的服務與模型，記帳與除錯用。 */
  provider: string;
  model: string;
}

export interface ImageProvider {
  readonly id: string;
  /**
   * 硬性規定（Planning §13）：額度用完不得自動切到付費服務。
   * 這個欄位讓 Router 能把付費來源排除在候選之外。
   */
  readonly tier: 'free' | 'paid';
  readonly label: string;
  generate(request: ImageRequest): Promise<GeneratedImage>;
}
