import { OpenAiCompatibleProvider } from './openaiCompatible.js';
import type { ChatProvider } from './types.js';

/**
 * Groq 的 OpenAI 相容端點（2026-09 查證）。
 *
 * 免費層：每個模型 30 RPM / 1,000 RPD / 8K TPM / 200K TPD。
 * Services Agreement §3.1 明文允許把服務透過自己的應用程式提供給 End User，
 * 所以拿來做公開邀請的 Discord Bot 沒有條款問題
 * （這點與 NVIDIA NIM 相反 —— NIM 的免費層明文排除 serving real end-users，
 * 因此本專案不接 NVIDIA，詳見 README）。
 */
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

export function createGroqProvider(apiKey: string, fetchImpl?: typeof fetch): ChatProvider {
  return new OpenAiCompatibleProvider({
    id: 'groq',
    tier: 'free',
    label: 'Groq',
    baseUrl: GROQ_BASE_URL,
    apiKey,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}
