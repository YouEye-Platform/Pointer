
import { usePointerTranslations, usePointerFormats } from "@/lib/i18n";
import type { StatsResponse } from "@/lib/stats";

export function RecentActivity({ rows }: { rows: StatsResponse["recent"] }) {
  const translateInterface = usePointerTranslations();
  const format = usePointerFormats();
  const { metric } = format;

  return <div className="card table-scroll"><table><thead><tr><th>{translateInterface("Time")}</th><th>{translateInterface("Model")}</th><th>{translateInterface("Provider")}</th><th>{translateInterface("Source")}</th><th>{translateInterface("Tokens")}</th><th>{translateInterface("Cost")}</th><th>{translateInterface("Latency / TTFB")}</th><th>{translateInterface("Throughput")}</th><th>{translateInterface("Outcome")}</th></tr></thead><tbody>{rows.length ? rows.map((row) => <tr key={row.id}><td>{new Date(row.createdAt).toLocaleString(translateInterface.locale)}</td><td className="mono">{row.modelId}</td><td>{row.providerId}</td><td><span className="badge">{row.source}</span></td><td>{row.inputTokens == null ? "-" : format.number(row.inputTokens)} / {row.outputTokens == null ? "-" : format.number(row.outputTokens)}</td><td>{format.price(row.costUsd, 5)}</td><td>{row.latencyMs ?? "-"} / {row.ttfbMs ?? "-"} ms</td><td>{metric(row.tokensPerSecond, " t/s")}</td><td className={row.outcome === "success" ? "success" : "danger"}>{row.outcome}</td></tr>) : <tr><td colSpan={9} className="muted">{translateInterface("No traffic in this range.")}</td></tr>}</tbody></table></div>;
}
