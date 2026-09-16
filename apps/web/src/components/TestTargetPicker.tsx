"use client";

import { useDeferredValue, useEffect, useId, useState } from "react";
import type { TestModelSelection, TestModelTargetsResponse } from "@/lib/test-model";

interface Props {
  label: string;
  targets: TestModelTargetsResponse;
  value: TestModelSelection;
  onChange: (value: TestModelSelection) => void;
  disabled?: boolean;
}

const EMPTY_SELECTION = { modelId: "", targetId: "" };

export function TestTargetPicker({ label, targets, value, onChange, disabled = false }: Props) {
  const inputId = useId();
  const listId = `${inputId}-list`;
  const [providerFilter, setProviderFilter] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const deferredQuery = useDeferredValue(query);
  const selectedModel = targets.models.find((model) => model.id === value.modelId);
  const selectedTarget = selectedModel?.providers.find((provider) => provider.id === value.targetId);

  useEffect(() => {
    if (selectedModel) setQuery(selectedModel.name);
  }, [selectedModel?.id, selectedModel?.name]);

  const providerModels = providerFilter
    ? targets.models.filter((model) => model.providers.some((provider) => provider.providerId === providerFilter))
    : targets.models;
  const normalizedQuery = deferredQuery.trim().toLowerCase();
  const matchingModels = providerModels.filter((model) => {
    if (!normalizedQuery) return true;
    return [
      model.name,
      model.id,
      model.canonicalModelId ?? "",
      ...model.providers.flatMap((provider) => [provider.providerName, provider.rawModelId]),
    ].some((candidate) => candidate.toLowerCase().includes(normalizedQuery));
  });
  const visibleModels = matchingModels.slice(0, 75);
  const providerOptions = selectedModel?.providers.filter((provider) =>
    !providerFilter || provider.providerId === providerFilter) ?? [];

  function selectModel(model: TestModelTargetsResponse["models"][number]) {
    const providers = providerFilter
      ? model.providers.filter((provider) => provider.providerId === providerFilter)
      : model.providers;
    const nextTarget = providers.find((provider) => provider.id === value.targetId) ?? providers[0];
    if (!nextTarget) return;
    onChange({ modelId: model.id, targetId: nextTarget.id });
    setQuery(model.name);
    setOpen(false);
    setActiveIndex(0);
  }

  function changeProviderFilter(nextProviderId: string) {
    setProviderFilter(nextProviderId);
    if (!selectedModel) {
      onChange(EMPTY_SELECTION);
      setQuery("");
      return;
    }
    const matchingTarget = nextProviderId
      ? selectedModel.providers.find((provider) => provider.providerId === nextProviderId)
      : selectedTarget ?? selectedModel.providers[0];
    if (matchingTarget) onChange({ modelId: selectedModel.id, targetId: matchingTarget.id });
    else {
      onChange(EMPTY_SELECTION);
      setQuery("");
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => Math.min(index + 1, Math.max(visibleModels.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter" && open && visibleModels[activeIndex]) {
      event.preventDefault();
      selectModel(visibleModels[activeIndex]);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  return <section className="test-target-card" aria-label={label}>
    <div className="spread test-target-title"><strong>{label}</strong>{selectedModel && <span className="badge">{selectedModel.providers.length} provider{selectedModel.providers.length === 1 ? "" : "s"}</span>}</div>
    <div className="field">
      <label htmlFor={`${inputId}-filter`}>Provider filter</label>
      <select id={`${inputId}-filter`} value={providerFilter} disabled={disabled} onChange={(event) => changeProviderFilter(event.target.value)}>
        <option value="">All providers ({targets.models.length} models)</option>
        {targets.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} ({provider.modelCount})</option>)}
      </select>
      <small className="field-hint">Leave blank to search every testable model.</small>
    </div>
    <div className="field model-combobox" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
    }}>
      <label htmlFor={inputId}>Model</label>
      <input
        id={inputId}
        type="search"
        role="combobox"
        autoComplete="off"
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={open}
        aria-activedescendant={open && visibleModels[activeIndex] ? `${listId}-${activeIndex}` : undefined}
        placeholder="Search model name or ID..."
        value={query}
        disabled={disabled}
        onFocus={() => { setOpen(true); setActiveIndex(0); }}
        onKeyDown={handleKeyDown}
        onChange={(event) => {
          setQuery(event.target.value);
          onChange(EMPTY_SELECTION);
          setActiveIndex(0);
          setOpen(true);
        }}
      />
      {open && <div id={listId} className="model-combobox-menu" role="listbox">
        {visibleModels.map((model, index) => <button
          id={`${listId}-${index}`}
          key={model.id}
          type="button"
          role="option"
          aria-selected={model.id === value.modelId}
          className={index === activeIndex ? "active" : ""}
          onMouseEnter={() => setActiveIndex(index)}
          onClick={() => selectModel(model)}
        >
          <span><strong>{model.name}</strong><small className="mono">{model.canonicalModelId ?? model.providers[0]?.rawModelId}</small></span>
          <span className="badge">{model.providers.length}</span>
        </button>)}
        {visibleModels.length === 0 && <p>No models match this search.</p>}
        {matchingModels.length > visibleModels.length && <p>{matchingModels.length - visibleModels.length} more models. Keep typing to narrow the list.</p>}
      </div>}
    </div>
    <div className="field">
      <label htmlFor={`${inputId}-provider`}>Run through</label>
      <select
        id={`${inputId}-provider`}
        value={selectedTarget?.id ?? ""}
        disabled={disabled || !selectedModel}
        onChange={(event) => onChange({ modelId: selectedModel!.id, targetId: event.target.value })}
      >
        {!selectedModel && <option value="">Select a model first</option>}
        {providerOptions.map((provider) => <option key={provider.id} value={provider.id}>{provider.providerName}{provider.providerAccountNickname ? ` · ${provider.providerAccountNickname}` : ""} ({provider.rawModelId})</option>)}
      </select>
      {selectedTarget && <small className="field-hint mono">Upstream ID: {selectedTarget.rawModelId}</small>}
    </div>
  </section>;
}
