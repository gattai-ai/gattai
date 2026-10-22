import type { ChatMessage, InvokeInput } from "./types";

/**
 * Payload pesan untuk provider berkonvensi OpenAI.
 *
 * Berbeda dari Anthropic yang punya field `system` terpisah, provider OpenAI
 * (termasuk MIMO dan Perplexity) mengharapkan instruksi sistem sebagai pesan
 * pertama. Tanpa konversi ini `system` — `GATTAI_SYSTEM`, role instruction, dan
 * ringkasan percakapan — diam-diam tidak pernah sampai ke model.
 */
export function messagesWithSystem(input: InvokeInput): ChatMessage[] {
  const messages = input.messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  if (!input.system) return messages;
  return [{ role: "system", content: input.system }, ...messages];
}
