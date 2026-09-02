import { describe, expect, it, vi } from 'vitest';
import { CloudflareImageProvider } from '../src/ai/image/cloudflare.js';
import { PollinationsProvider } from '../src/ai/image/pollinations.js';
import { ImageRouter } from '../src/ai/image/router.js';
import { IMAGE_SIZES, type GeneratedImage, type ImageProvider } from '../src/ai/image/types.js';
import { imageTool } from '../src/ai/tools/image.js';
import type { ToolContext } from '../src/ai/tools/types.js';
import { SearchRouter } from '../src/ai/search/router.js';
import {
  ImageQuotaExceededError,
  ProviderAuthError,
  QuotaExceededError,
  UserFacingError,
} from '../src/utils/errors.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function imageResponse(body: Buffer, contentType = 'image/jpeg'): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': contentType }),
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  } as unknown as Response;
}

function fakeProvider(overrides: Partial<ImageProvider> = {}): ImageProvider {
  return {
    id: 'fake',
    tier: 'free',
    label: 'Fake',
    generate: async () => ({
      data: PNG,
      filename: 'a.png',
      provider: 'fake',
      model: 'fake-1',
    }),
    ...overrides,
  };
}

const request = { prompt: 'a red fox', size: 'square' as const, timeoutMs: 5000 };

describe('Pollinations', () => {
  it('把描述與尺寸放進網址，而且一定帶 safe=true', async () => {
    let called = '';
    const fetchImpl = vi.fn(async (url: URL) => {
      called = url.toString();
      return imageResponse(PNG);
    }) as unknown as typeof fetch;

    await new PollinationsProvider(fetchImpl).generate({ ...request, size: 'portrait' });

    expect(called).toContain(encodeURIComponent('a red fox'));
    expect(called).toContain(`width=${IMAGE_SIZES.portrait.width}`);
    expect(called).toContain(`height=${IMAGE_SIZES.portrait.height}`);
    // 公開 Bot 一定會收到成人向 prompt，這個開關不給呼叫端關掉
    expect(called).toContain('safe=true');
  });

  it('429 視為額度問題，讓 Router 有機會換手', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 429 })) as unknown as typeof fetch;

    await expect(new PollinationsProvider(fetchImpl).generate(request)).rejects.toThrow(
      QuotaExceededError,
    );
  });

  it('回傳 HTML 錯誤頁時不會當成圖片送出去', async () => {
    const fetchImpl = (async () =>
      imageResponse(Buffer.from('<html>500</html>'), 'text/html')) as unknown as typeof fetch;

    await expect(new PollinationsProvider(fetchImpl).generate(request)).rejects.toThrow(
      UserFacingError,
    );
  });

  it('空回應不會變成一個 0 byte 的附件', async () => {
    const fetchImpl = (async () => imageResponse(Buffer.alloc(0))) as unknown as typeof fetch;

    await expect(new PollinationsProvider(fetchImpl).generate(request)).rejects.toThrow(
      UserFacingError,
    );
  });
});

describe('Cloudflare Workers AI', () => {
  it('把 base64 解回圖片位元組，而且不送 width/height（送了會 400）', async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'cf-ai-neurons': '172.80' }),
        json: async () => ({ success: true, result: { image: PNG.toString('base64') } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const image = await new CloudflareImageProvider({
      accountId: 'acc',
      apiToken: 'tok',
      fetchImpl,
    }).generate({ ...request, size: 'landscape' });

    expect(image.data).toEqual(PNG);
    expect(body).not.toHaveProperty('width');
    expect(body).not.toHaveProperty('height');
  });

  it('401 是設定錯誤，回報成認證失敗而不是額度用完', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 401,
      headers: new Headers(),
      json: async () => ({ success: false, errors: [{ message: 'bad token' }] }),
    })) as unknown as typeof fetch;

    await expect(
      new CloudflareImageProvider({ accountId: 'a', apiToken: 'b', fetchImpl }).generate(request),
    ).rejects.toThrow(ProviderAuthError);
  });
});

describe('ImageRouter', () => {
  it('第一家壞掉就換下一家', async () => {
    const broken = fakeProvider({
      id: 'broken',
      generate: async () => {
        throw new UserFacingError('壞了');
      },
    });
    const good = fakeProvider({ id: 'good' });

    const image = await new ImageRouter([broken, good]).generate(request);

    expect(image.provider).toBe('fake');
  });

  it('全部都沒額度時回規格 §13 指定的那句話', async () => {
    const dry = () =>
      fakeProvider({
        generate: async () => {
          throw new QuotaExceededError('沒了');
        },
      });

    await expect(new ImageRouter([dry(), dry()]).generate(request)).rejects.toThrow(
      '目前免費生圖額度已用完。',
    );
  });

  it('只有一家沒額度、另一家是壞掉時，不會誤報成額度用完', async () => {
    const dry = fakeProvider({
      generate: async () => {
        throw new QuotaExceededError('沒了');
      },
    });
    const broken = fakeProvider({
      generate: async () => {
        throw new UserFacingError('壞了');
      },
    });

    const error = await new ImageRouter([dry, broken]).generate(request).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UserFacingError);
    expect(error).not.toBeInstanceOf(ImageQuotaExceededError);
  });

  it('付費來源永遠不進候選名單（Planning §13：不得自動改用付費）', async () => {
    const paid = fakeProvider({ id: 'paid', tier: 'paid' });
    const router = new ImageRouter([paid]);

    expect(router.enabled).toBe(false);
    await expect(router.generate(request)).rejects.toThrow('沒有可用的生圖服務');
  });
});

describe('generate_image 工具', () => {
  function contextWith(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      db: {} as never,
      guildId: 'g1',
      userId: 'u1',
      locale: 'zh-TW',
      memoryEnabled: true,
      imageEnabled: true,
      search: new SearchRouter([]),
      image: new ImageRouter([fakeProvider()]),
      timeoutMs: 1000,
      imageTimeoutMs: 5000,
      timezone: 'Asia/Taipei',
      checkImageQuota: () => null,
      ...overrides,
    };
  }

  it('成功時把圖片放進 images，而不是塞進給模型看的文字', async () => {
    const result = await imageTool.execute({ prompt: 'a red fox' }, contextWith());

    expect(result.images).toHaveLength(1);
    expect((result.images as GeneratedImage[])[0]?.data).toEqual(PNG);
    expect(result.text).not.toContain('base64');
  });

  it('沒有描述就不呼叫生圖服務', async () => {
    let called = false;
    const context = contextWith({
      image: new ImageRouter([
        fakeProvider({
          generate: async () => {
            called = true;
            throw new Error('不該被呼叫');
          },
        }),
      ]),
    });

    const result = await imageTool.execute({ prompt: '   ' }, context);

    expect(called).toBe(false);
    expect(result.images).toBeUndefined();
  });

  it('生圖配額用完時直接擋下，不會真的去生', async () => {
    let called = false;
    const context = contextWith({
      checkImageQuota: () => ({ retryAfterMs: 30_000 }),
      image: new ImageRouter([
        fakeProvider({
          generate: async () => {
            called = true;
            throw new Error('不該被呼叫');
          },
        }),
      ]),
    });

    const result = await imageTool.execute({ prompt: 'a fox' }, context);

    expect(called).toBe(false);
    expect(result.text).toContain('30 秒');
  });

  it('額度用完時把規格指定的訊息原封不動交給模型轉述', async () => {
    const context = contextWith({
      image: new ImageRouter([
        fakeProvider({
          generate: async () => {
            throw new ImageQuotaExceededError();
          },
        }),
      ]),
    });

    const result = await imageTool.execute({ prompt: 'a fox' }, context);

    expect(result.text).toContain('目前免費生圖額度已用完。');
    expect(result.images).toBeUndefined();
  });

  it('模型給了不存在的尺寸時擋下來並說明可選值，讓它自己重試（§29）', async () => {
    let called = false;
    const context = contextWith({
      image: new ImageRouter([
        fakeProvider({
          generate: async () => {
            called = true;
            throw new Error('不該被呼叫');
          },
        }),
      ]),
    });

    const result = await imageTool.execute({ prompt: 'a fox', size: 'panorama' }, context);

    expect(called).toBe(false);
    expect(result.text).toContain('square');
    expect(result.text).toContain('landscape');
  });

  it('沒指定尺寸時預設 square', async () => {
    let used = '';
    const context = contextWith({
      image: new ImageRouter([
        fakeProvider({
          generate: async (req) => {
            used = req.size;
            return { data: PNG, filename: 'a.png', provider: 'fake', model: 'm' };
          },
        }),
      ]),
    });

    await imageTool.execute({ prompt: 'a fox' }, context);

    expect(used).toBe('square');
  });
});
