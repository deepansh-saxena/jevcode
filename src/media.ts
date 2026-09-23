import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Workspace } from "./workspace.js";
import type { CodingModel, Message } from "./llm.js";

export const MAX_IMAGE_BYTES = 2_000_000;
export const MAX_IMAGES = 4;
export const imageSchema = z.object({
  mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  data: z.string().min(4).max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4),
}).strict().superRefine((image, ctx) => {
  const bytes = Buffer.from(image.data, "base64");
  if (bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== image.data || imageMime(bytes) !== image.mimeType) {
    ctx.addIssue({ code: "custom", message: "Invalid image data or MIME signature" });
  }
});
export type ImageAttachment = z.infer<typeof imageSchema>;

export function imageMime(data: Buffer): ImageAttachment["mimeType"] | undefined {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    data.toString("ascii", 12, 16) === "IHDR" && data.readUInt32BE(16) > 0 && data.readUInt32BE(20) > 0) return "image/png";
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 13 && /^GIF8[79]a$/.test(data.toString("ascii", 0, 6))) return "image/gif";
  if (data.length >= 20 && data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP" && ["VP8 ", "VP8L", "VP8X"].includes(data.toString("ascii", 12, 16))) return "image/webp";
  return undefined;
}

export async function readImage(workspace: Workspace, relative: string): Promise<ImageAttachment> {
  const filename = await workspace.path(relative);
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Images must be regular, non-linked workspace files");
    if (stat.size > MAX_IMAGE_BYTES) throw new Error(`Image exceeds ${MAX_IMAGE_BYTES} bytes`);
    const data = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    let bytes = 0;
    while (bytes < data.length) {
      const result = await file.read(data, bytes, data.length - bytes, null);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
    }
    if (bytes > MAX_IMAGE_BYTES) throw new Error(`Image exceeds ${MAX_IMAGE_BYTES} bytes`);
    const content = data.subarray(0, bytes);
    const mimeType = imageMime(content);
    const extensions: Record<string, string[]> = {
      "image/png": [".png"], "image/jpeg": [".jpg", ".jpeg"], "image/gif": [".gif"], "image/webp": [".webp"],
    };
    if (!mimeType || !extensions[mimeType]!.includes(path.extname(relative).toLowerCase())) {
      throw new Error("Image extension and file signature must match PNG, JPEG, GIF, or WebP");
    }
    return imageSchema.parse({ mimeType, data: content.toString("base64") });
  } finally { await file.close(); }
}

export function requireImageSupport(model: CodingModel, modelId: string, images: ImageAttachment[]): void {
  if (!images.length) return;
  z.array(imageSchema).max(MAX_IMAGES).parse(images);
  if (!model.supportsImages?.(modelId)) throw new Error("This model has no verified image-input capability; choose a supported vision model");
}

// Image token costs depend on provider resizing; reserve 4096 estimated tokens per image instead of counting base64.
export function contextMessages(messages: Message[]): unknown[] {
  return messages.map(({ images, ...message }) => images?.length ?
    { ...message, images: images.map((image) => ({ mimeType: image.mimeType, estimatedImageBudget: " ".repeat(16_384) })) } : message);
}
