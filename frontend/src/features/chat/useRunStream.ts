import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl } from "@/lib/api";
import type { RunEvent } from "@/lib/types";

export interface StreamStep {
  id: string;
  status: "pending" | "complete" | "failed";
  providerCostUsd?: number;
  error?: string;
}

export interface RunStream {
  start: (runId: string) => void;
  reset: () => void;
  text: string;
  steps: StreamStep[];
  status: string | null;
  running: boolean;
  error: string | null;
}

/**
 * Streaming progres run lewat SSE (`GET /v1/runs/{id}/events`).
 * Mengumpulkan delta teks + status step; memanggil `onDone` saat run selesai.
 * Catatan: EventSource mengirim cookie sesi otomatis (same-origin lewat proxy dev).
 */
export function useRunStream(
  onDone?: (runId: string, status: string, text: string) => void,
): RunStream {
  const esRef = useRef<EventSource | null>(null);
  const textRef = useRef("");
  const [text, setText] = useState("");
  const [steps, setSteps] = useState<StreamStep[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
  }, []);

  const reset = useCallback(() => {
    close();
    textRef.current = "";
    setText("");
    setSteps([]);
    setStatus(null);
    setRunning(false);
    setError(null);
  }, [close]);

  const start = useCallback(
    (runId: string) => {
      close();
      textRef.current = "";
      setText("");
      setSteps([]);
      setStatus(null);
      setError(null);
      setRunning(true);

      const source = new EventSource(apiUrl(`/v1/runs/${runId}/events`), {
        withCredentials: true,
      });
      esRef.current = source;

      source.onmessage = (event) => {
        setError(null);
        let parsed: RunEvent;
        try {
          parsed = JSON.parse(event.data) as RunEvent;
        } catch {
          return;
        }

        switch (parsed.type) {
          case "delta":
            textRef.current += parsed.text;
            setText(textRef.current);
            break;
          case "status":
            setStatus(parsed.status);
            break;
          case "step_pending":
            setSteps((prev) =>
              prev.some((step) => step.id === parsed.stepId)
                ? prev
                : [...prev, { id: parsed.stepId, status: "pending" }],
            );
            break;
          case "step_complete":
            setSteps((prev) =>
              prev.map((step) =>
                step.id === parsed.stepId
                  ? { ...step, status: "complete", providerCostUsd: parsed.providerCostUsd }
                  : step,
              ),
            );
            break;
          case "step_failed":
            setSteps((prev) =>
              prev.map((step) =>
                step.id === parsed.stepId
                  ? { ...step, status: "failed", error: parsed.error }
                  : step,
              ),
            );
            break;
          case "done":
            setRunning(false);
            setStatus(parsed.status);
            close();
            onDone?.(runId, parsed.status, textRef.current);
            break;
          case "ping":
            break;
        }
      };

      source.onerror = () => {
        // EventSource mencoba menyambung ulang otomatis; beri tahu pengguna
        // bahwa koneksi terputus (run tetap berjalan di server).
        setError("Stream disconnected, reconnecting…");
      };
    },
    [close, onDone],
  );

  useEffect(() => () => close(), [close]);

  return { start, reset, text, steps, status, running, error };
}
