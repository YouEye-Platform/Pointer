"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { CatalogModel } from "@/lib/catalog";
import type { GroupDetail, GroupEntry, GroupSummary } from "@/lib/groups";

export function ModelGroupStar({
  model,
  groups,
  defaultGroup,
  onChanged,
}: {
  model: CatalogModel;
  groups: GroupSummary[];
  defaultGroup: GroupDetail | null;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [groupId, setGroupId] = useState("");
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [groupLoading, setGroupLoading] = useState(false);
  const [routeChoice, setRouteChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const availableRoutes = useMemo(
    () => model.providers.flatMap((provider) => provider.accounts.map((account) => ({
      value: `${provider.providerModelKey}\u0000${account.id}`,
      providerModelKey: provider.providerModelKey,
      providerAccountId: account.id,
      label: `${provider.providerName} · ${account.nickname || account.id.slice(-6)}`,
    }))),
    [model.providers],
  );
  const defaultMembership = defaultGroup?.entries.find((entry) => entry.catalogEntityId === model.id) ?? null;
  const membership = group?.entries.find((entry) => entry.catalogEntityId === model.id) ?? null;
  const unavailableMembershipRoute = membership?.providerModelKey
    ? model.providers.find((provider) => provider.providerModelKey === membership.providerModelKey && !provider.available)
    : null;
  const starred = Boolean(defaultMembership);

  function close(returnFocus = true) {
    setOpen(false);
    setError("");
    if (returnFocus) queueMicrotask(() => buttonRef.current?.focus());
  }

  useEffect(() => {
    if (!open) return;
    const selected = groups.find((item) => item.isDefault) ?? groups[0];
    if (!selected) return;
    setGroupId(selected.id);
    setGroup(selected.id === defaultGroup?.id ? defaultGroup : null);
    setGroupLoading(false);
    const existing = selected.id === defaultGroup?.id ? defaultMembership : null;
    setRouteChoice(existing?.providerModelKey && existing.providerAccountId
      ? `${existing.providerModelKey}\u0000${existing.providerAccountId}`
      : (availableRoutes.length === 1 ? availableRoutes[0].value : ""));
    setError("");
  }, [open, groups, defaultGroup, defaultMembership, availableRoutes]);

  useEffect(() => {
    if (!open) return;
    function outside(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) close();
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        close();
      }
    }
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  async function selectGroup(nextId: string) {
    setGroupId(nextId);
    setGroup(null);
    setRouteChoice("");
    setGroupLoading(true);
    setError("");
    try {
      const detail = nextId === defaultGroup?.id
        ? defaultGroup
        : await api.get<GroupDetail>(`/api/groups/${encodeURIComponent(nextId)}`);
      setGroup(detail);
      const existing = detail?.entries.find((entry) => entry.catalogEntityId === model.id);
      setRouteChoice(existing?.providerModelKey && existing.providerAccountId
        ? `${existing.providerModelKey}\u0000${existing.providerAccountId}`
        : (availableRoutes.length === 1 ? availableRoutes[0].value : ""));
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Failed to load group");
    } finally {
      setGroupLoading(false);
    }
  }

  async function save() {
    const selectedRoute = availableRoutes.find((route) => route.value === routeChoice);
    if (!groupId || !selectedRoute) return;
    setBusy(true);
    setError("");
    try {
      if (membership) {
        if (membership.providerModelKey !== selectedRoute.providerModelKey || membership.providerAccountId !== selectedRoute.providerAccountId) {
          await api.put(`/api/groups/${encodeURIComponent(groupId)}/entries/${encodeURIComponent(membership.id)}`, {
            providerModelKey: selectedRoute.providerModelKey,
            providerAccountId: selectedRoute.providerAccountId,
          });
        }
      } else {
        await api.post(`/api/groups/${encodeURIComponent(groupId)}/entries`, {
          catalogEntityId: model.id,
          providerModelKey: selectedRoute.providerModelKey,
          providerAccountId: selectedRoute.providerAccountId,
        });
      }
      await onChanged();
      close();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Failed to update group");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!membership) return;
    setBusy(true);
    setError("");
    try {
      await api.del(`/api/groups/${encodeURIComponent(groupId)}/entries/${encodeURIComponent(membership.id)}`);
      await onChanged();
      close();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Failed to remove model");
    } finally {
      setBusy(false);
    }
  }

  const unavailableAndUnstarred = availableRoutes.length === 0 && !starred;
  return (
    <div className="model-star-wrap" ref={rootRef} onClick={(event) => event.stopPropagation()}>
      <button
        ref={buttonRef}
        type="button"
        className={`model-star ${starred ? "starred" : ""}`}
        aria-pressed={starred}
        aria-label={`${starred ? "Manage" : "Add"} ${model.name} ${starred ? `in ${defaultGroup?.name ?? "default group"}` : "in a model group"}`}
        title={unavailableAndUnstarred ? "Add a provider offering this model first" : starred ? "Manage group membership" : "Add to a model group"}
        disabled={unavailableAndUnstarred || groups.length === 0}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">{starred ? "★" : "☆"}</span>
      </button>
      {open && (
        <div className="model-star-popover" role="dialog" aria-label={`Place ${model.name} in a group`}>
          <div className="spread model-star-popover-head"><strong>Add to model group</strong><button type="button" className="btn-sm" aria-label="Close model group popover" onClick={() => close()}>Close</button></div>
          <div className="field">
            <label htmlFor={`star-group-${model.id}`}>Group</label>
            <select id={`star-group-${model.id}`} value={groupId} disabled={busy || groupLoading} onChange={(event) => selectGroup(event.target.value)}>
              {groups.map((item) => <option key={item.id} value={item.id}>{item.name}{item.isDefault ? " (default)" : ""}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`star-provider-${model.id}`}>Provider</label>
            <select id={`star-provider-${model.id}`} value={routeChoice} disabled={busy || groupLoading} onChange={(event) => setRouteChoice(event.target.value)}>
              <option value="">Choose provider</option>
              {unavailableMembershipRoute && membership?.providerAccountId && <option value={`${unavailableMembershipRoute.providerModelKey}\u0000${membership.providerAccountId}`} disabled>{unavailableMembershipRoute.providerName} · provider no longer added</option>}
              {availableRoutes.map((route) => (
                <option key={route.value} value={route.value}>
                  {route.label}
                </option>
              ))}
            </select>
          </div>
          {groupLoading && <p className="muted" role="status">Loading group…</p>}
          {error && <p className="error" role="alert">{error}</p>}
          <div className="row model-star-actions">
            {membership && <button type="button" className="btn-sm btn-danger" disabled={busy || groupLoading} onClick={remove}>Remove</button>}
            <button
              type="button"
              className="btn-sm btn-primary"
              disabled={busy || groupLoading || !routeChoice || (membership?.providerModelKey && membership.providerAccountId ? `${membership.providerModelKey}\u0000${membership.providerAccountId}` === routeChoice : false)}
              onClick={save}
            >
              {busy ? "Saving…" : "OK"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
