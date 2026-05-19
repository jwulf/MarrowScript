/**
 * img2img example — restyle an existing image with prompt enhancement.
 *
 * Run with:
 *   npx tsx examples/img2img.ts <path-to-input.png> "<your prompt>"
 *
 * Defaults to ./input.png if no args provided.
 */

import * as fs from "node:fs";
import { A1111LMSAdapter } from "../src/index.ts";

async function main(): Promise<void> {
  const inputPath = process.argv[2] ?? "./input.png";
  const userPrompt = process.argv[3] ?? "in the style of Studio Ghibli";

  if (!fs.existsSync(inputPath)) {
    process.stderr.write("input file not found: " + inputPath + "\n");
    process.exit(1);
  }

  const inputBase64 = fs.readFileSync(inputPath).toString("base64");

  const adapter = new A1111LMSAdapter({
    a1111BaseUrl: process.env.A1111_URL ?? "http://127.0.0.1:7860",
    lmStudioBaseUrl: process.env.LMSTUDIO_URL ?? "http://127.0.0.1:1234",
  });

  process.stderr.write("user prompt: " + userPrompt + "\n");

  const result = await adapter.img2img({
    prompt: userPrompt,
    negative_prompt: "blurry, low-quality",
    init_images: [inputBase64],
    denoising_strength: 0.55,
    steps: 30,
    cfg_scale: 7,
  });

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
