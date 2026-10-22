import { randomUUID } from "node:crypto";

/** ID dengan prefix, mis. `run_1a2b…`. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}
