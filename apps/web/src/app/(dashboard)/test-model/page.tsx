"use client";

import { useEffect, useState } from "react";
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
  const [targets, setTargets] = useState<TestModelTargetsResponse>({ models: [], providers: [] });
  const [primary, setPrimary] = useState<TestModelSelection>(EMPTY_SELECTION);
  const [secondary, setSecondary] = useState<TestModelSelection>(EMPTY_SELECTION);
  const [compare, setCompare] = useState(false);
  const [prompt, setPrompt] = useState("Reply with a short confirmation that the route works.");
  const [maxTokens, setMaxTokens] = useState(512);
  const [results, setResults] = useState<RunResult[]>([EMPTY_RESULT, EMPTY_RESULT]);
  const [history, setHistory] = useState<StatsResponse["recent"]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  const refreshHistory = () => api.get<StatsResponse>("/api/stats/summary?days=30")
    .then((data) => setHistory(data.recent.filter((row) => row.source === "test")))
    .catch(() => {});

  useEffect(() => {
    api.get<TestModelTargetsResponse>("/api/test-model/targets").then((data) => {
      const initial = defaultTestSelection(data.models);
      setTargets(data);
      setPrimary(initial);
      setSecondary(defaultComparisonSelection(data.models, initial));
    }).catch((reason) => setError(reason instanceof ApiError ? reason.message : "Failed to load testable models"))
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
    if (!prompt.trim()) return setError("Enter a prompt before running the test.");
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) return setError("Max output tokens must be between 1 and 4096.");
    if (selected.some((item) => !item)) return setError("Select a model and provider for every target.");
    if (compare && primary.modelId === secondary.modelId && primary.targetId === secondary.targetId) {
      return setError("Choose a different model or provider for the second target.");
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
      <p className="eyebrow">Direct configured-provider verification</p>
      <h1>Test Model</h1>
      <p className="muted">Search every model you can test, choose its exact provider route, or send the same prompt to two targets side by side.</p>
    </div>

    {error && <div className="notice danger" role="alert">{error}</div>}
    {loading ? <section className="card"><span className="skeleton line wide" /><span className="skeleton block" /></section>
      : targets.models.length === 0 ? <section className="card empty-state"><h2>No testable models</h2><p className="muted">Add a credential to an active provider and sync its models first.</p></section>
      : <section className="card test-workbench">
        <div className="spread test-mode-row">
          <div><h2>Targets</h2><p className="muted">The provider filter is optional. Provider choices always come from Pointer.</p></div>
          <label className="compare-toggle"><input type="checkbox" checked={compare} disabled={running} onChange={(event) => toggleCompare(event.target.checked)} /> Compare two targets</label>
        </div>
        <div className={`test-target-grid ${compare ? "compare" : ""}`}>
          <TestTargetPicker label={compare ? "Target A" : "Target"} targets={targets} value={primary} onChange={setPrimary} disabled={running} />
          {compare && <TestTargetPicker label="Target B" targets={targets} value={secondary} onChange={setSecondary} disabled={running} />}
        </div>
        <div className="field test-prompt-field"><label htmlFor="test-prompt">Prompt sent to {compare ? "both targets" : "the target"}</label><textarea id="test-prompt" rows={6} value={prompt} disabled={running} onChange={(event) => setPrompt(event.target.value)} /></div>
        <div className="test-run-row"><div className="field"><label htmlFor="test-tokens">Max output tokens</label><input id="test-tokens" type="number" min={1} max={4096} value={maxTokens} disabled={running} onChange={(event) => setMaxTokens(Number(event.target.value))} /></div><button className="btn-primary" disabled={!canRun} onClick={run}>{running ? "Running..." : compare ? "Run comparison" : "Run test"}</button></div>
      </section>}

    {!loading && targets.models.length > 0 && <div className={`test-results-grid ${compare ? "compare" : ""}`}>
      {visibleResults.map((result, index) => <section className="card test-result-card" key={index} aria-live="polite">
        <div className="spread"><div><h2>{result.label || (compare ? `Target ${index === 0 ? "A" : "B"}` : "Output")}</h2>{result.route && <p className="muted mono test-result-route">{result.route}</p>}</div><span className={`badge ${result.status === "Complete" ? "enabled" : ""}`}>{result.status}</span></div>
        {result.error && <div className="notice danger test-result-notice" role="alert">{result.error}</div>}
        {result.notice && <div className="notice warning test-result-notice" role="status">{result.notice}</div>}
        {result.reasoning && <details className="test-reasoning">
          <summary>Reasoning received ({result.reasoning.length.toLocaleString()} characters)</summary>
          <pre data-testid="test-reasoning-output">{result.reasoning}</pre>
        </details>}
        <h3 className="test-output-heading">Final answer</h3>
        <pre className="test-output">{result.output || (
          result.status === "Failed" || result.reasoning
            ? "No final answer was returned."
            : "Output will stream here."
        )}</pre>
        <div className="test-metrics"><div><small>Latency</small><strong>{result.latency == null ? "Unknown" : `${result.latency} ms`}</strong></div><div><small>TTFB</small><strong>{result.ttfb == null ? "Unknown" : `${result.ttfb} ms`}</strong></div></div>
      </section>)}
    </div>}

    <h2 style={{ marginTop: 24 }}>Recent model tests</h2>
    <RecentActivity rows={history} />
  </div>;
}
