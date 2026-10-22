/** Event progres run untuk SSE dan sinkronisasi status. */
export type RunEvent =
  | { type: "status"; status: string }
  | { type: "step_pending"; stepId: string }
  | { type: "step_complete"; stepId: string; providerCostUsd: number }
  | { type: "step_failed"; stepId: string; error: string }
  | { type: "delta"; text: string }
  | { type: "done"; status: string };

type Listener = (event: RunEvent) => void;

const HISTORY_CAP = 500;

/**
 * Bus event in-memory per run. Menyimpan riwayat singkat agar klien yang
 * terlambat connect tetap menerima progres, lalu berlangganan untuk event baru.
 */
class RunEventBus {
  private history = new Map<string, RunEvent[]>();
  private listeners = new Map<string, Set<Listener>>();

  emit(runId: string, event: RunEvent): void {
    const log = this.history.get(runId) ?? [];
    log.push(event);
    if (log.length > HISTORY_CAP) log.splice(0, log.length - HISTORY_CAP);
    this.history.set(runId, log);

    for (const listener of this.listeners.get(runId) ?? []) {
      listener(event);
    }

    if (event.type === "done") {
      // Beri kesempatan listener terakhir menerima, lalu bersihkan.
      setTimeout(() => {
        this.history.delete(runId);
        this.listeners.delete(runId);
      }, 30_000);
    }
  }

  subscribe(runId: string, listener: Listener): () => void {
    const set = this.listeners.get(runId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(runId, set);
    return () => set.delete(listener);
  }

  past(runId: string): RunEvent[] {
    return this.history.get(runId) ?? [];
  }
}

export const runEvents = new RunEventBus();
