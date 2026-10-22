/** Membaca body HTTP sebagai baris-baris SSE (`data: ...`). */
export async function* sseDataLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        const data = extractData(line);
        if (data !== undefined) yield data;
      }
    }
    const last = extractData(buffer.replace(/\r$/, ""));
    if (last !== undefined) yield last;
  } finally {
    reader.releaseLock();
  }
}

function extractData(line: string): string | undefined {
  if (!line.startsWith("data:")) return undefined;
  return line.slice("data:".length).trim();
}
