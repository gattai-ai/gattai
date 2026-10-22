import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { statusLabel } from "@/lib/error-message";
import { displayStepLabel, displayStepRole } from "@/lib/provider-label";
import { showToast } from "@/site/siteFx";
import { useRecipes } from "@/features/chat/useRecipes";
import { formatShortDateTime } from "@/lib/format";
import { NeedLogin } from "./AppShell";
import { useSession } from "@/lib/use-session";
import type { RunInfo, UsageResponse } from "@/lib/types";

/**
 * Usage dengan tampilan situs statis: tile ringkasan, spend by formation,
 * dan ledger per run yang bisa dibuka untuk melihat step. Data nyata dari
 * ledger + detail run (`GET /v1/runs/{id}`).
 */

function shortRun(id: string | null): string {
  if (!id) return "-";
  return id.length > 20 ? `${id.slice(0, 12)}…${id.slice(-4)}` : id;
}

interface RunGroup {
  runId: string;
  time: string;
  charged: number;
}

export function UsageView() {
  const { session } = useSession();
  const [openRun, setOpenRun] = useState<string | null>(null);

  const { data: usage } = useQuery({
    queryKey: ["usage", "page", session?.projectId],
    queryFn: () => api<UsageResponse>("/v1/usage?limit=200"),
    enabled: Boolean(session),
  });
  const { data: recipesData } = useRecipes(Boolean(session));

  const groups: RunGroup[] = useMemo(() => {
    const byRun = new Map<string, { time: string; charged: number }>();
    for (const entry of usage?.entries ?? []) {
      if (!entry.run_id) continue;
      if (entry.type !== "SETTLE") continue;
      const current = byRun.get(entry.run_id) ?? { time: entry.created_at, charged: 0 };
      if (entry.created_at < current.time) current.time = entry.created_at;
      current.charged += Math.abs(entry.amount_credits);
      byRun.set(entry.run_id, current);
    }
    return [...byRun.entries()]
      .map(([runId, value]) => ({ runId, time: value.time, charged: value.charged }))
      .sort((a, b) => b.time.localeCompare(a.time))
      .slice(0, 30);
  }, [usage]);

  const runQueries = useQueries({
    queries: (session ? groups : []).map((group) => ({
      queryKey: ["run", session?.projectId, group.runId],
      queryFn: () => api<RunInfo>(`/v1/runs/${group.runId}`),
      staleTime: 60_000,
    })),
    combine: (results) => results,
  });

  const details = useMemo(() => {
    const map = new Map<string, RunInfo>();
    runQueries.forEach((result, index) => {
      if (result.data) map.set(groups[index].runId, result.data);
    });
    return map;
  }, [runQueries, groups]);

  const recipeName = (id: string): string =>
    recipesData?.recipes.find((recipe) => recipe.id === id)?.name ?? id;

  if (!session) return <NeedLogin action="Usage" />;

  const settled = groups.filter((group) => details.get(group.runId)?.status === "SETTLED");
  const spent = groups.reduce((sum, group) => sum + group.charged, 0);
  const byFormation = new Map<string, { count: number; credits: number }>();
  for (const group of groups) {
    const recipe = details.get(group.runId)?.recipe ?? "unknown";
    const current = byFormation.get(recipe) ?? { count: 0, credits: 0 };
    current.count += 1;
    current.credits += group.charged;
    byFormation.set(recipe, current);
  }
  const top = [...byFormation.entries()].sort((a, b) => b[1].count - a[1].count)[0];
  const maxCredits = Math.max(1, ...[...byFormation.values()].map((value) => value.credits));

  function exportCsv() {
    const rows: string[][] = [
      ["time", "run_id", "formation", "prompt", "step", "model", "role", "status", "charged_credits"],
    ];
    for (const group of groups) {
      const run = details.get(group.runId);
      const steps = run?.steps ?? [];
      if (steps.length === 0) {
        rows.push([new Date(group.time).toISOString(), group.runId, run?.recipe ?? "", "", "", "", "", run?.status ?? "", group.charged.toFixed(2)]);
      }
      steps.forEach((step, index) => {
        rows.push([
          new Date(group.time).toISOString(),
          group.runId,
          run?.recipe ?? "",
          "",
          String(index + 1),
          displayStepLabel(step),
          displayStepRole(step),
          step.status,
          step.provider_cost_usd.toFixed(4),
        ]);
      });
    }
    const csv = rows.map((row) => row.map((value) => `"${value.replace(/"/g, '""')}"`).join(",")).join("\n");
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    anchor.download = "gattai-usage.csv";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
    showToast("CSV exported");
  }

  return (
    <section className="view on" id="v-usage">
      <div className="tiles">
        <div className="tile">
          <small>Runs</small>
          <b id="uRuns">{settled.length}</b>
          <span>settled</span>
        </div>
        <div className="tile">
          <small>Credits spent</small>
          <b id="uSpent">{spent.toFixed(2)}</b>
          <span id="uSpentUsd">${(spent / 100).toFixed(2)}</span>
        </div>
        <div className="tile">
          <small>Avg per run</small>
          <b id="uAvg">{settled.length ? (spent / settled.length).toFixed(2) : "0"}</b>
          <span>credits</span>
        </div>
        <div className="tile">
          <small>Top formation</small>
          <b id="uTop" style={{ fontSize: 24 }}>
            {top ? recipeName(top[0]) : "-"}
          </b>
          <span id="uTopN">{top ? `${top[1].count} runs` : "0 runs"}</span>
        </div>
      </div>

      <div className="grid2" style={{ marginTop: 14 }}>
        <div className="box" style={{ gridColumn: "1/-1" }}>
          <h4>Spend by formation</h4>
          <div className="byf" id="byf">
            {[...byFormation.entries()].map(([recipe, value]) => (
              <div className="r" key={recipe}>
                <span>{recipeName(recipe)}</span>
                <span className="t">
                  <b style={{ width: `${((value.credits / maxCredits) * 100).toFixed(1)}%` }}></b>
                </span>
                <span>{value.credits.toFixed(2)} cr</span>
              </div>
            ))}
            {byFormation.size === 0 && <span className="muted">No settled runs yet.</span>}
          </div>
        </div>
      </div>

      <div className="box" style={{ marginTop: 14, paddingBottom: 6 }}>
        <div className="uhead">
          <h4>Ledger · per run</h4>
          <button className="btn btn-dark btn-sm" id="csvBtn" onClick={exportCsv}>
            Export CSV
          </button>
        </div>
        <div className="tscroll" style={{ marginTop: 12 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Time</th>
                <th>Run</th>
                <th>Formation</th>
                <th>Steps</th>
                <th className="num">Charged</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody id="ledRows">
              {groups.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    No runs yet.
                  </td>
                </tr>
              )}
              {groups.map((group) => {
                const run = details.get(group.runId);
                const status = run?.status ?? "…";
                return [
                  <tr
                    key={group.runId}
                    className="exp"
                    onClick={() => setOpenRun((current) => (current === group.runId ? null : group.runId))}
                  >
                    <td className="m">{formatShortDateTime(group.time)}</td>
                    <td className="m">{shortRun(group.runId)}</td>
                    <td>{run ? recipeName(run.recipe) : "…"}</td>
                    <td className="m">{run?.steps?.length ?? "…"}</td>
                    <td className="num m">{group.charged.toFixed(2)}</td>
                    <td>
                      <span className={`st ${status === "SETTLED" ? "ok" : status === "…" ? "dim" : "bad"}`}>
                        {statusLabel(status)}
                      </span>
                    </td>
                  </tr>,
                  openRun === group.runId && (
                    <tr key={`${group.runId}-det`} className="det">
                      <td colSpan={6}>
                        <div className="in">
                          {(run?.steps ?? []).map((step, index) => (
                            <div key={step.id}>
                              <span>step {index + 1}</span>
                              <span>
                                {displayStepLabel(step)} · {displayStepRole(step)}
                              </span>
                              <span>{step.status}</span>
                              <span>${step.provider_cost_usd.toFixed(4)}</span>
                            </div>
                          ))}
                          {(run?.steps ?? []).length === 0 && <div>Loading steps…</div>}
                        </div>
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
