"use client";
import { usePointerTranslations } from "@/lib/i18n";


import { useEffect, useState } from "react";
import { RecordedComparison } from "@/components/RecordedComparison";
import { FormSkeleton, TableSkeleton } from "@/components/LoadingSkeleton";
import { RecentActivity } from "@/components/RecentActivity";
import { TestTargetPicker } from "@/components/TestTargetPicker";
import { api, ApiError, streamModelTest } from "@/lib/api";
import type { StatsResponse } from "@/lib/stats";
import {
  defaultComparisonSelection,
  defaultTestSelection,
  resolveTestSelection,
  type TestModelSelection,
  type TestModelTargetsResponse,
} from "@/lib/test-model";

interface RunResult {
  label: string;
  route: string;
  output: string;
  reasoning: string;
  status: "Ready" | "Connecting" | "Streaming" | "Complete" | "Truncated" | "Failed";
  latency: number | null;
  ttfb: number | null;
  error: string | null;
  notice: string | null;
}

const EMPTY_SELECTION: TestModelSelection = { modelId: "", targetId: "" };
const EMPTY_RESULT: RunResult = {
  label: "",
  route: "",
  output: "",
  reasoning: "",
  status: "Ready",
  latency: null,
  ttfb: null,
  error: null,
  notice: null,
};

export default function TestModelPage() {
  const translateInterface = usePointerTranslations();

  const [targets, setTargets] = useState<TestModelTargetsResponse>({ models: [], providers: [] });
  const [primary, setPrimary] = useState<TestModelSelection>(EMPTY_SELECTION);
  const [secondary, setSecondary] = useState<TestModelSelection>(EMPTY_SELECTION);
  const [compare, setCompare] = useState(false);
  const [prompt, setPrompt] = useState("Reply with a short confirmation that the route works.");
  const [maxTokens, setMaxTokens] = useState(512);
  const [results, setResults] = useState<RunResult[]>([EMPTY_RESULT, EMPTY_RESULT]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [history, setHistory] = useState<StatsResponse["recent"]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  const refreshHistory = () => api.get<StatsResponse>("/api/stats/summary?days=30")
    .then((data) => setHistory(data.recent.filter((row) => row.source === "test")))
    .catch(() => {})
    .finally(() => setHistoryLoading(false));

  useEffect(() => {
    api.get<TestModelTargetsResponse>("/api/test-model/targets").then((data) => {
      const initial = defaultTestSelection(data.models);
      setTargets(data);
      setPrimary(initial);
      setSecondary(defaultComparisonSelection(data.models, initial));
    }).catch((reason) => setError(translateInterface("Failed to load testable models")))
      .finally(() => setLoading(false));
    refreshHistory();
  }, []);

  function updateResult(index: number, update: (result: RunResult) => RunResult) {
    setResults((current) => current.map((result, resultIndex) => resultIndex === index ? update(result) : result));
  }

  async function executeTarget(
    index: number,
    resolved: NonNullable<ReturnType<typeof resolveTestSelection>>,
  ) {
    const started = performance.now();
    let firstToken: number | null = null;
    try {
      await streamModelTest({
        providerId: resolved.target.providerId,
        providerAccountId: resolved.target.providerAccountId,
        modelId: resolved.target.rawModelId,
        prompt,
        maxTokens,
      }, {
        onReasoningDelta(delta) {
          if (firstToken === null) firstToken = performance.now();
          updateResult(index, (result) => ({
            ...result,
            reasoning: result.reasoning + delta,
            status: "Streaming",
          }));
        },
        onDelta(delta) {
          if (firstToken === null) firstToken = performance.now();
          updateResult(index, (result) => ({ ...result, output: result.output + delta, status: "Streaming" }));
        },
        onDone(finishReason) {
          const truncated = finishReason === "length";
          updateResult(index, (result) => ({
            ...result,
            status: truncated ? "Truncated" : "Complete",
            latency: Math.round(performance.now() - started),
            ttfb: firstToken === null ? null : Math.round(firstToken - started),
            notice: truncated
              ? "The provider reached the output limit before completing. Increase max output tokens and retry."
              : null,
          }));
        },
        onError(message) {
          updateResult(index, (result) => ({
            ...result,
            status: "Failed",
            error: message,
            latency: Math.round(performance.now() - started),
            ttfb: firstToken === null ? null : Math.round(firstToken - started),
          }));
        },
      });
    } catch (reason) {
      updateResult(index, (result) => ({
        ...result,
        status: "Failed",
        error: reason instanceof Error ? reason.message : "Model test failed",
      }));
    }
  }

  async function run() {
    const selected = [resolveTestSelection(targets.models, primary)];
    if (compare) selected.push(resolveTestSelection(targets.models, secondary));
    if (!prompt.trim()) return setError(translateInterface("Enter a prompt before running the test."));
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) return setError(translateInterface("Max output tokens must be between 1 and 4096."));
    if (selected.some((item) => !item)) return setError(translateInterface("Select a model and provider for every target."));
    if (compare && primary.modelId === secondary.modelId && primary.targetId === secondary.targetId) {
      return setError(translateInterface("Choose a different model or provider for the second target."));
    }

    const resolved = selected as Array<NonNullable<(typeof selected)[number]>>;
    setError("");
    setRunning(true);
    setResults([0, 1].map((index) => {
      const item = resolved[index];
      return item ? {
        label: item.model.name,
        route: `${item.target.providerName}${item.target.providerAccountNickname ? ` · ${item.target.providerAccountNickname}` : ""} / ${item.target.rawModelId}`,
        output: "",
        reasoning: "",
        status: "Connecting" as const,
        latency: null,
        ttfb: null,
        error: null,
        notice: null,
      } : EMPTY_RESULT;
    }));
    await Promise.all(resolved.map((item, index) => executeTarget(index, item)));
    setRunning(false);
    refreshHistory();
  }

  function toggleCompare(enabled: boolean) {
    setCompare(enabled);
    if (enabled) setSecondary(defaultComparisonSelection(targets.models, primary));
  }

  const visibleResults = results.slice(0, compare ? 2 : 1);
  const canRun = !loading && !running && Boolean(resolveTestSelection(targets.models, primary))
    && (!compare || Boolean(resolveTestSelection(targets.models, secondary)));

  return <div>
    <div className="page-head">
      <p className="eyebrow">{translateInterface("Direct configured-provider verification")}</p>
      <h1>{translateInterface("Test model")}</h1>
      <p className="muted">{translateInterface("Basic inference test: verifies one prompt on the selected account and model. Success does not establish worker compatibility with tools, history, reasoning replay or streaming tool calls. Worker conformance requires a separate protocol test.")}</p>
      <p className="muted">{translateInterface("Search every model you can test, choose its exact provider route, or send the same prompt to two targets side by side.")}</p>
    </div>

    {error && <div className="notice danger" role="alert">{error}</div>}
    {loading ? <FormSkeleton label={translateInterface("Loading test targets")} fields={4} />
      : targets.models.length === 0 ? <section className="card empty-state"><h2>{translateInterface("No testable models")}</h2><p className="muted">{translateInterface("Add a credential to an active provider and sync its models first.")}</p></section>
      : <section className="card test-workbench">
        <div className="spread test-mode-row">
          <div><h2>{translateInterface("Targets")}</h2><p className="muted">{translateInterface("The provider filter is optional. Provider choices always come from Pointer.")}</p></div>
          <label className="compare-toggle"><input type="checkbox" checked={compare} disabled={running} onChange={(event) => toggleCompare(event.target.checked)} /> {translateInterface("Compare two targets")}</label>
        </div>
        <div className={`test-target-grid ${compare ? "compare" : ""}`}>
          <TestTargetPicker label={compare ? translateInterface("Target A") : translateInterface("Target")} targets={targets} value={primary} onChange={setPrimary} disabled={running} />
          {compare && <TestTargetPicker label={translateInterface("Target B")} targets={targets} value={secondary} onChange={setSecondary} disabled={running} />}
        </div>
        <div className="field test-prompt-field"><label htmlFor="test-prompt">{translateInterface(compare ? "Prompt sent to both targets" : "Prompt sent to the target")}</label><textarea id="test-prompt" rows={6} value={prompt} disabled={running} onChange={(event) => setPrompt(event.target.value)} /></div>
        <div className="test-run-row"><div className="field"><label htmlFor="test-tokens">{translateInterface("Max output tokens")}</label><input id="test-tokens" type="number" min={1} max={4096} value={maxTokens} disabled={running} onChange={(event) => setMaxTokens(Number(event.target.value))} /></div><button className="btn-primary" disabled={!canRun} onClick={run}>{running ? translateInterface("Running...") : compare ? translateInterface("Run comparison") : translateInterface("Run test")}</button></div>
      </section>}

    {!loading && targets.models.length > 0 && <div className={`test-results-grid ${compare ? "compare" : ""}`}>
      {visibleResults.map((result, index) => <section className="card test-result-card" key={index} aria-live="polite">
        <div className="spread"><div><h2>{result.label || (compare ? translateInterface(index === 0 ? "Target A" : "Target B") : translateInterface("Output"))}</h2>{result.route && <p className="muted mono test-result-route">{result.route}</p>}</div><span className={`badge ${result.status === "Complete" ? "enabled" : ""}`}>{translateInterface(result.status)}</span></div>
        {result.error && <div className="notice danger test-result-notice" role="alert">{result.error}</div>}
        {result.notice && <div className="notice warning test-result-notice" role="status">{result.notice}</div>}
        {result.reasoning && <details className="test-reasoning">
          <summary>{translateInterface("Reasoning received ({count} characters)", {count: result.reasoning.length.toLocaleString(translateInterface.locale)})}</summary>
          <pre data-testid="test-reasoning-output">{result.reasoning}</pre>
        </details>}
        <h3 className="test-output-heading">{translateInterface("Final answer")}</h3>
        <pre className="test-output">{result.output || (
          result.status === "Failed" || result.reasoning
            ? translateInterface("No final answer was returned.")
            : translateInterface("Output will stream here.")
        )}</pre>
        <div className="test-metrics"><div><small>{translateInterface("Latency")}</small><strong>{result.latency == null ? translateInterface("Unknown") : translateInterface("{value} ms", {value: result.latency.toLocaleString(translateInterface.locale)})}</strong></div><div><small>{translateInterface("TTFB")}</small><strong>{result.ttfb == null ? translateInterface("Unknown") : translateInterface("{value} ms", {value: result.ttfb.toLocaleString(translateInterface.locale)})}</strong></div></div>
      </section>)}
    </div>}

    <h2 style={{ marginTop: 24 }}>{translateInterface("Recent model tests")}</h2>
    {historyLoading ? <TableSkeleton label={translateInterface("Loading recent model tests")} columns={[translateInterface("Time"), translateInterface("Model"), translateInterface("Provider"), translateInterface("Source"), translateInterface("Tokens"), translateInterface("Cost"), translateInterface("Latency / TTFB"), translateInterface("Throughput"), translateInterface("Outcome")]} /> : <RecentActivity rows={history} />}
    <section style={{ marginTop: 32 }}><RecordedComparison /></section>
  </div>;
}
