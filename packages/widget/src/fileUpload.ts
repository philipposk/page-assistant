/** Client-side file ingestion for chat attachments (text + optional images). */

export interface FileAttachment {
  name: string;
  mime: string;
  /** Text content or base64 data URL for images. */
  content: string;
  kind: "text" | "image";
}

const MAX_TEXT_BYTES = 100_000;
const MAX_IMAGE_BYTES = 2_000_000;
const TEXT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/javascript",
  "text/html",
  "text/css",
]);
const TEXT_EXT = /\.(txt|md|csv|json|js|ts|tsx|jsx|html|css|yaml|yml|xml|log)$/i;

/**
 * Read a file for attachment.
 *
 * Images are OFF by default: the assistant backend/core has no vision plumbing, so
 * accepting an image and only telling the model "[Attached image: x]" would be a
 * placebo (the model never sees the picture). We refuse honestly unless the host
 * explicitly opts in via `imagesEnabled` (i.e. it wired up a vision-capable backend).
 */
export async function readFileAttachment(
  file: File,
  opts: { imagesEnabled?: boolean } = {}
): Promise<FileAttachment | { error: string }> {
  if (file.type.startsWith("image/")) {
    if (!opts.imagesEnabled) {
      return { error: "Images aren't supported yet — I can't see attached pictures. Try describing it or attach a text file." };
    }
    if (file.size > MAX_IMAGE_BYTES) return { error: "Image too large (max 2MB)" };
    const b64 = await fileToDataUrl(file);
    return { name: file.name, mime: file.type, content: b64, kind: "image" };
  }
  if (TEXT_TYPES.has(file.type) || TEXT_EXT.test(file.name)) {
    if (file.size > MAX_TEXT_BYTES) return { error: "File too large (max 100KB text)" };
    const text = await file.text();
    return { name: file.name, mime: file.type || "text/plain", content: text, kind: "text" };
  }
  return { error: `Unsupported file type: ${file.type || file.name}` };
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Failed to read file"));
    r.readAsDataURL(file);
  });
}

/** Format attachments for inclusion in the user message sent to the assistant. */
export function formatAttachmentsForPrompt(text: string, attachments: FileAttachment[]): string {
  if (!attachments.length) return text;
  const parts = [text];
  for (const a of attachments) {
    if (a.kind === "text") {
      parts.push(`\n\n--- File: ${a.name} ---\n${a.content.slice(0, 8000)}`);
    } else {
      // Only reached when imagesEnabled — be explicit that the base64 is passed through.
      parts.push(`\n\n[Attached image "${a.name}" (${a.mime}). Data URL follows]\n${a.content}`);
    }
  }
  return parts.join("");
}
