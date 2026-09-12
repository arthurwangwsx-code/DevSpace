import { open } from "node:fs/promises";
import { constants } from "node:fs";

export const READ_PAGE_BYTES = 1024 * 1024;
export interface ReadPageInput { offset?: number; limit?: number; byteOffset?: number }

// Read at most one page into memory, even when the file or one line is huge.
export async function readTextPage(path: string, input: ReadPageInput) {
  if (input.byteOffset !== undefined && input.offset !== undefined) {
    throw new Error("Use offset (lines) OR byteOffset, not both.");
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stats = await file.stat();
    if (!stats.isFile()) throw new Error("Only regular files are readable.");
    const chunk = Buffer.alloc(64 * 1024);
    let position = input.byteOffset ?? 0;
    let remainingLines = (input.offset ?? 1) - 1;
    const deadline = performance.now() + 10_000;
    while (remainingLines > 0) {
      if (performance.now() > deadline) throw new Error("Line-offset scan exceeded 10 seconds; use byteOffset for direct access.");
      const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
      if (!bytesRead) throw new Error("Line offset is beyond end of file.");
      let consumed = bytesRead;
      for (let i = 0; i < bytesRead; i++) {
        if (chunk[i] === 10 && --remainingLines === 0) { consumed = i + 1; break; }
      }
      position += consumed;
    }
    if (position > stats.size) throw new Error("Byte offset is beyond end of file.");
    const page = Buffer.alloc(READ_PAGE_BYTES);
    let length = 0;
    let lineCount = 0;
    const lineLimit = Math.min(input.limit ?? 20_000, 100_000);
    let lineLimited = false;
    while (length < page.length && !lineLimited) {
      const { bytesRead } = await file.read(page, length, Math.min(chunk.length, page.length - length), position + length);
      if (!bytesRead) break;
      const end = length + bytesRead;
      while (length < end) {
        const byte = page[length++];
        if (byte === 0) throw new Error("Binary file: use an appropriate decoder via exec_command; text reading is UTF-8 only.");
        if (byte === 10 && ++lineCount >= lineLimit) { lineLimited = true; break; }
      }
    }
    const more = position + length < stats.size;
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(page.subarray(0, length), { stream: more });
    // Streaming decode leaves an incomplete trailing UTF-8 codepoint for the next page.
    const consumed = Buffer.byteLength(text);
    const nextByteOffset = position + consumed;
    const truncated = nextByteOffset < stats.size;
    return {
      text: text + (truncated ? `\n[More content: continue with byteOffset=${nextByteOffset}; omit offset. File size=${stats.size} bytes.]` : ""),
      details: { bytesRead: consumed, fileBytes: stats.size, truncated, nextByteOffset: truncated ? nextByteOffset : undefined },
    };
  } finally { await file.close(); }
}
