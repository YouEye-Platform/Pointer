"use client";
import { TableSkeleton } from "@/components/LoadingSkeleton";
import { usePointerTranslations } from "@/lib/i18n";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Modal } from "@/components/Modal";
import Link from "next/link";

interface Instance {
  id: string;
  name: string;
  color: string;
  modelGroupId: string | null;
}
interface Group {
  id: string;
  name: string;
}

export default function InstancesPage() {
  const translateInterface = usePointerTranslations();

  const [instances, setInstances] = useState<Instance[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<Instance | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [i, g] = await Promise.all([api.get<Instance[]>("/api/instances"), api.get<Group[]>("/api/groups")]);
      setInstances(i);
      setGroups(g);
    } catch (err) {
      setError(translateInterface("Failed to load"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function remove(id: string) {
    if (deleting) return;
    setDeleting(true);
    try {
      await api.del(`/api/instances/${encodeURIComponent(id)}`);
      setRemoving(null);
      await load();
    } catch (err) {
      setError(translateInterface("Delete failed"));
    } finally { setDeleting(false); }
  }

  const groupName = (id: string | null) => (id ? groups.find((g) => g.id === id)?.name ?? id : "—");

  return (
    <div>
      <div className="spread page-head">
        <div>
          <h1>{translateInterface("Instances/API")}</h1>
          <p className="muted">{translateInterface("Manage each application’s model access and API keys in one place.")}</p>
        </div>
        <button className="btn-primary" onClick={() => setCreating(true)}>
          {translateInterface("New instance")}</button>
      </div>

      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="card table-scroll">
        {loading ? (
          <TableSkeleton label={translateInterface("Loading instances")} bare columns={[translateInterface("Instance"), translateInterface("ID"), translateInterface("Model group"), ""]} />
        ) : instances.length === 0 ? (
          <p className="muted">{translateInterface("No instances yet.")}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{translateInterface("Instance")}</th>
                <th>{translateInterface("ID")}</th>
                <th>{translateInterface("Model group")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {instances.map((i) => (
                <tr key={i.id}>
                  <td><Link href={`/instances/${encodeURIComponent(i.id)}`}><strong>{i.name}</strong></Link><div className="muted">{translateInterface("Manage models and API keys")}</div></td>
                  <td className="mono">{i.id}</td>
                  <td>{groupName(i.modelGroupId)}</td>
                  <td style={{ textAlign: "right" }}>
                    <Link className="btn-sm" href={`/instances/${encodeURIComponent(i.id)}`}>{translateInterface("Details")}</Link>{" "}
                    <button className="btn-sm btn-danger" onClick={() => setRemoving(i)}>
                      {translateInterface("Delete")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {removing && <Modal title={translateInterface("Delete {name}?", {name: removing.name})} onClose={() => { if (!deleting) setRemoving(null); }}>
        <p>{translateInterface("Deleting this instance also removes its API keys. Requests using those keys will stop working.")}</p>
        <div className="row dialog-actions"><button disabled={deleting} onClick={() => setRemoving(null)}>{translateInterface("Cancel")}</button><button className="btn-danger" disabled={deleting} onClick={() => void remove(removing.id)}>{deleting ? translateInterface("Deleting…") : translateInterface("Delete instance and keys")}</button></div>
      </Modal>}
      {creating && (
        <CreateInstanceModal
          groups={groups}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function CreateInstanceModal({
  groups,
  onClose,
  onCreated,
}: {
  groups: Group[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const translateInterface = usePointerTranslations();

  const [name, setName] = useState("");
  const [modelGroupId, setModelGroupId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.post("/api/instances", { name, modelGroupId: modelGroupId || undefined });
      onCreated();
    } catch (err) {
      setError(translateInterface("Failed to create"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={translateInterface("New instance")} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="field">
          <label htmlFor="new-instance-name">{translateInterface("Name")}</label>
          <input id="new-instance-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </div>
        <div className="field">
          <label htmlFor="new-instance-group">{translateInterface("Model group (optional — defaults to your default group)")}</label>
          <select id="new-instance-group" value={modelGroupId} onChange={(e) => setModelGroupId(e.target.value)}>
            <option value="">{translateInterface("Default group")}</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose}>
            {translateInterface("Cancel")}</button>
          <button className="btn-primary" type="submit" disabled={busy}>
            {busy ? translateInterface("Creating…") : translateInterface("Create")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
