/**
 * txt2img example — generate an image with prompt enhancement.
 *
 * Prereqs:
 *   - AUTOMATIC1111 running with `--api` flag (default port 7860)
 *   - LM Studio running with a model loaded (default port 1234)
 *
 * Run with:
 *   npx tsx examples/txt2img.ts
 *
 * Output:
 *   - The enhanced prompt (printed to stderr)
 *   - The image written to ./out.png
 *   - A1111's info JSON printed to stdout
 */

import * as fs from "node:fs";
import { A1111LMSAdapter } from "../src/index.ts";

async function main(): Promise<void> {
  const adapter = new A1111LMSAdapter({
    a1111BaseUrl: process.env.A1111_URL ?? "http://127.0.0.1:7860",
    lmStudioBaseUrl: process.env.LMSTUDIO_URL ?? "http://127.0.0.1:1234",
    log: (event, fields) => {
      process.stderr.write("[" + event + "] " + JSON.stringify(fields) + "\n");
    },
  });

  const userPrompt = process.argv[2] ?? "a cat sitting on a windowsill";
  process.stderr.write("user prompt: " + userPrompt + "\n");

  // Preview the enhancement separately so the user can see it.
  const enhanced = await adapter.enhancePrompt(userPrompt);
  process.stderr.write("enhanced:    " + enhanced + "\n\n");

  // Generate. We pass bypass:true to avoid double-enhancing — we already
  // ran enhancement above and want to use that exact text.
  const result = await adapter.txt2img(
    {
      prompt: enhanced,
      negative_prompt: "blurry, low-quality, watermark",
      steps: 25,
      width: 768,
      height: 768,
      cfg_scale: 7,
      sampler_name: "DPM++ 2M Karras",
    },
    { bypass: true },
  );

  if (result.images.length === 0) {
    process.stderr.write("no images returned\n");
    process.exit(1);
  }

  const outPath = "./out.png";
  fs.writeFileSync(outPath, Buffer.from(result.images[0], "base64"));
  process.stderr.write("wrote " + outPath + "\n");

  process.stdout.write(result.info + "\n");
}

main().catch((err: Error) => {
  process.stderr.write("FAIL: " + err.message + "\n");
  process.exit(1);
});
