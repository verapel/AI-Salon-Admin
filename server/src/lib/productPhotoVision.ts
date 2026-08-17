import { draftsFromPhotoPayload, parseJsonFromModelText, type ProductDraft } from './productImport.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const VISION_MODEL = 'openai/gpt-4o-mini';

const PHOTO_PROMPT = `You extract salon hair-color and cosmetics product labels from ONE photo that may contain MULTIPLE products.

Return ONLY JSON:
{"products":[{"name":"","brand":"","line":"","codeShade":"","category":"","quantity":1,"unit":"","price":0,"supplier":""}]}

Rules:
- Each visible distinct product/label is its own array item.
- codeShade is the tone/code printed on the tube (examples: 5.01, 5.18, 8.11, SL12.0, 6.1).
- brand examples: Kaaral, Loreal. line examples: BACO, Majirel.
- If quantity is not printed, use 1.
- Do not invent supplier or price; use "" / 0 when unknown.
- Never include commentary.`;

export function productPhotoVisionModel(): string {
  return VISION_MODEL;
}

export async function extractProductDraftsFromImage(params: {
  mimeType: string;
  contentBase64: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<ProductDraft[]> {
  const apiKey = params.apiKey ?? process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw Object.assign(new Error('OpenRouter API key not configured'), { code: 'AI_NOT_CONFIGURED' });
  }

  const mime = params.mimeType.startsWith('image/') ? params.mimeType : 'image/jpeg';
  const fetchImpl = params.fetchImpl ?? fetch;
  const response = await fetchImpl(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.APP_URL ?? 'http://localhost:3001',
      'X-Title': 'AI Salon Admin',
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PHOTO_PROMPT },
            {
              type: 'image_url',
              image_url: { url: `data:${mime};base64,${params.contentBase64}` },
            },
          ],
        },
      ],
    }),
  });

  const data = (await response.json()) as {
    error?: { message?: string };
    choices?: { message?: { content?: string } }[];
  };
  if (!response.ok) {
    throw new Error(data.error?.message || 'Photo analysis failed');
  }
  const text = data.choices?.[0]?.message?.content ?? '';
  const parsed = parseJsonFromModelText(text);
  return draftsFromPhotoPayload(parsed);
}
