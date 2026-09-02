import { logger } from '../../utils/logger.js';
import type { Tool, ToolResult } from './types.js';
import { requireString, validateArgs } from './types.js';

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

interface GeocodingResponse {
  results?: {
    name?: string;
    latitude?: number;
    longitude?: number;
    country?: string;
    admin1?: string;
  }[];
}

interface ForecastResponse {
  current?: {
    temperature_2m?: number;
    relative_humidity_2m?: number;
    apparent_temperature?: number;
    precipitation?: number;
    weather_code?: number;
    wind_speed_10m?: number;
  };
  daily?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: number[];
  };
}

/** WMO 天氣代碼對照。Open-Meteo 只回數字，文字要自己對。 */
const WEATHER_CODES: Record<number, string> = {
  0: '晴朗',
  1: '大致晴朗',
  2: '局部多雲',
  3: '陰天',
  45: '有霧',
  48: '霧淞',
  51: '毛毛雨',
  53: '毛毛雨',
  55: '毛毛雨（較大）',
  56: '凍毛毛雨',
  57: '凍毛毛雨（較大）',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '凍雨',
  67: '凍雨（較大）',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '陣雨',
  81: '陣雨（較大）',
  82: '強陣雨',
  85: '陣雪',
  86: '強陣雪',
  95: '雷雨',
  96: '雷雨伴冰雹',
  99: '雷雨伴強冰雹',
};

function describeCode(code: number | undefined): string {
  if (code === undefined) return '不明';
  return WEATHER_CODES[code] ?? `天氣代碼 ${code}`;
}

/**
 * 天氣查詢，資料來自 Open-Meteo（2026-09 查證）。
 *
 * 免費、不需要 API Key，每天 10,000 次、每分鐘 600 次。
 * 條款寫的是 non-commercial use —— 小步不營利，符合。
 *
 * ⚠️ 實測發現它的地理編碼**只認英文或羅馬拼音**：查「台北」回空結果，
 * 查「Taipei」才會回台北市。所以工具描述明確要求模型用英文城市名，
 * 查不到時也回傳可行動的訊息讓模型改寫重試。
 */
export const weatherTool: Tool = {
  definition: {
    name: 'get_weather',
    description:
      '查詢某個城市目前的天氣與未來三天預報。需要知道實際天氣時使用，不要憑印象回答。',
    parameters: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description:
            '城市名稱，**必須使用英文或羅馬拼音**（例如 Taipei、Kaohsiung、Tokyo、New York）。' +
            '這個資料來源不接受中文城市名，使用者說「台北」時請自行轉成 Taipei。',
        },
      },
      required: ['location'],
    },
  },

  async execute(args, context): Promise<ToolResult> {
    const validated = validateArgs(weatherTool.definition.parameters, args);
    if (!validated.ok) return { text: `參數有問題：${validated.message}` };

    const location = requireString(validated.value, 'location').trim();
    if (location.length === 0) return { text: '請提供城市名稱。' };

    try {
      const place = await geocode(location, context.timeoutMs);

      if (!place) {
        return {
          text:
            `找不到「${location}」這個地點。` +
            '請改用英文或羅馬拼音的城市名稱再試一次（例如 Taipei、Tokyo、New York）。',
        };
      }

      const forecast = await fetchForecast(place.latitude, place.longitude, context.timeoutMs);
      return { text: formatForecast(place, forecast) };
    } catch (error) {
      logger.warn(`天氣查詢失敗（${location}）`, error);
      return { text: '天氣服務暫時無法使用，請稍後再試。' };
    }
  },
};

interface Place {
  label: string;
  latitude: number;
  longitude: number;
}

async function geocode(name: string, timeoutMs: number): Promise<Place | null> {
  const url = new URL(GEOCODING_URL);
  url.searchParams.set('name', name);
  url.searchParams.set('count', '1');
  url.searchParams.set('language', 'zh');
  url.searchParams.set('format', 'json');

  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`geocoding HTTP ${response.status}`);

  const payload = (await response.json()) as GeocodingResponse;
  const first = payload.results?.[0];

  if (!first || first.latitude === undefined || first.longitude === undefined) return null;

  const parts = [first.name, first.admin1, first.country].filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  );

  return {
    // admin1 常常跟 name 重複（例如「高雄市 / 高雄市」），去掉重複的比較好讀
    label: [...new Set(parts)].join('、'),
    latitude: first.latitude,
    longitude: first.longitude,
  };
}

async function fetchForecast(
  latitude: number,
  longitude: number,
  timeoutMs: number,
): Promise<ForecastResponse> {
  const url = new URL(FORECAST_URL);
  url.searchParams.set('latitude', String(latitude));
  url.searchParams.set('longitude', String(longitude));
  url.searchParams.set(
    'current',
    'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m',
  );
  url.searchParams.set(
    'daily',
    'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
  );
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', '3');

  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`forecast HTTP ${response.status}`);

  return (await response.json()) as ForecastResponse;
}

function formatForecast(place: Place, forecast: ForecastResponse): string {
  const current = forecast.current;
  const lines = [`${place.label} 目前天氣`];

  if (current) {
    lines.push(
      `- 天氣：${describeCode(current.weather_code)}`,
      `- 氣溫：${current.temperature_2m ?? '?'}°C（體感 ${current.apparent_temperature ?? '?'}°C）`,
      `- 濕度：${current.relative_humidity_2m ?? '?'}%`,
      `- 風速：${current.wind_speed_10m ?? '?'} km/h`,
      `- 降雨量：${current.precipitation ?? 0} mm`,
    );
  }

  const daily = forecast.daily;
  const days = daily?.time ?? [];

  if (days.length > 0) {
    lines.push('', '未來預報');

    for (const [index, date] of days.entries()) {
      const high = daily?.temperature_2m_max?.[index];
      const low = daily?.temperature_2m_min?.[index];
      const rain = daily?.precipitation_probability_max?.[index];

      lines.push(
        `- ${date}：${describeCode(daily?.weather_code?.[index])}，` +
          `${low ?? '?'}～${high ?? '?'}°C，降雨機率 ${rain ?? '?'}%`,
      );
    }
  }

  return lines.join('\n');
}
