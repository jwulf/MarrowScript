// adapter.ts – Exports A1111LMSAdapter that wraps A1111 API with LM Studio prompt enhancement
interface A1111Txt2ImgRequest {
  prompt: string;
  negative_prompt?: string;
  steps?: number;
  width?: number;
  height?: number;
  batch_size?: number;
  cfg_scale?: number;
  seed?: number;
  sampler_name?: string;
  [key: string]: unknown;
}

interface A1111Txt2ImgResponse {
  images: string[]; // base64-encoded PNGs
  parameters: Record<string, unknown>;
  info: string;
}

interface A1111Img2ImgRequest {
  prompt: string;
  negative_prompt?: string;
  init_images: string[]; // base64-encoded input images
  denoising_strength?: number;
  steps?: number;
  width?: number;
  height?: number;
  cfg_scale?: number;
  seed?: number;
  sampler_name?: string;
  resize_mode?: number;
  [key: string]: unknown;
}

interface A1111Img2ImgResponse {
  images: string[];
  parameters: Record<string, unknown>;
  info: string;
}

interface LMStudioChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface LMStudioChatRequest {
  model?: string;
  messages: LMStudioChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

interface LMStudioChatChoice {
  index: number;
  message: LMStudioChatMessage;
  finish_reason: string;
}

interface LMStudioChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: LMStudioChatChoice[];
  usage?: Record<string, number>;
}

export interface A1111LMSAdapterConfig {
  /** Base URL for A1111 API (e.g., 'http://127.0.0.1:7860') */
  a1111BaseUrl: string;
  /** Base URL for LM Studio API (e.g., 'http://127.0.0.1:1234') */
  lmStudioBaseUrl: string;
}

/**
 * Adapter that provides A1111-compatible endpoints (txt2img and img2img),
 * but sends the prompt through LM Studio's chat completions first to enhance it.
 * Assumes LM Studio is running and exposes /v1/chat/completions, and that
 * A1111 is running with `--api` flag.
 */
export class A1111LMSAdapter {
  private a1111BaseUrl: string;
  private lmStudioBaseUrl: string;

  constructor(config: A1111LMSAdapterConfig) {
    this.a1111BaseUrl = config.a1111BaseUrl.replace(/\/+$/, '');
    this.lmStudioBaseUrl = config.lmStudioBaseUrl.replace(/\/+$/, '');
  }

  /**
   * Enhances a prompt using LM Studio's chat completion model.
   * Sends a system message instructing the model to improve/expand the prompt
   * and returns the enhanced text.
   */
  private async enhancePrompt(prompt: string): Promise<string> {
    const systemMessage: LMStudioChatMessage = {
      role: 'system',
      content: 'You are a prompt engineer for Stable Diffusion. '
        + 'Given a user prompt, refine and expand it into a detailed, '
        + 'high-quality prompt that produces better images. '
        + 'Output only the refined prompt, no additional explanation.'
    };
    const userMessage: LMStudioChatMessage = {
      role: 'user',
      content: prompt
    };
    const requestBody: LMStudioChatRequest = {
      messages: [systemMessage, userMessage],
      temperature: 0.7,
      max_tokens: 300
    };
    const url = this.lmStudioBaseUrl + '/v1/chat/completions';
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error('LM Studio request failed with status '
        + response.status
        + ': '
        + errorText);
    }
    const data = (await response.json()) as LMStudioChatResponse;
    if (!data.choices || data.choices.length === 0) {
      throw new Error('LM Studio returned no choices');
    }
    const enhancedPrompt = data.choices[0].message.content.trim();
    return enhancedPrompt;
  }

  /**
   * Calls A1111's txt2img endpoint after enhancing the prompt via LM Studio.
   */
  async txt2img(req: A1111Txt2ImgRequest): Promise<A1111Txt2ImgResponse> {
    const enhancedPrompt = await this.enhancePrompt(req.prompt);
    const modifiedReq = { ...req, prompt: enhancedPrompt };
    const url = this.a1111BaseUrl + '/sdapi/v1/txt2img';
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(modifiedReq)
    });
    if (!response.ok) {
      throw new Error('A1111 txt2img request failed with status '
        + response.status
        + ': '
        + await response.text());
    }
    return (await response.json()) as A1111Txt2ImgResponse;
  }

  /**
   * Calls A1111's img2img endpoint after enhancing the prompt via LM Studio.
   */
  async img2img(req: A1111Img2ImgRequest): Promise<A1111Img2ImgResponse> {
    const enhancedPrompt = await this.enhancePrompt(req.prompt);
    const modifiedReq = { ...req, prompt: enhancedPrompt };
    const url = this.a1111BaseUrl + '/sdapi/v1/img2img';
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(modifiedReq)
    });
    if (!response.ok) {
      throw new Error('A1111 img2img request failed with status '
        + response.status
        + ': '
        + await response.text());
    }
    return (await response.json()) as A1111Img2ImgResponse;
  }
}
