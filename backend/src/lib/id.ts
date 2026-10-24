import { randomBytes, randomUUID } from "node:crypto";

/** ID dengan prefix, mis. `run_1a2b…`. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

/**
 * Slug share 128-bit (32 karakter hex). Sengaja tanpa prefix dan tanpa kaitan
 * dengan run/project: satu-satunya cara menemukan halaman adalah tautan itu
 * sendiri, bukan menebak id internal.
 */
export function newShareSlug(): string {
  return randomBytes(16).toString("hex");
}

/** Bentuk slug yang sah — cermin `newShareSlug()`. */
export const SHARE_SLUG_PATTERN = /^[0-9a-f]{32}$/;
