"use client";
import { usePointerTranslations } from "@/lib/i18n";

/** Loading geometry follows the content it replaces; placeholders are decorative. */
export function LoadingSkeleton({ label, children }: { label: string; children: React.ReactNode }) {
  return <div role="status" aria-label={label} aria-busy="true" className="loading-skeleton"><div aria-hidden="true">{children}</div></div>;
}
export function SkeletonLine({ wide = false }: { wide?: boolean }) {
  return <span className={`skeleton line ${wide ? "wide" : ""}`} />;
}
export function TableSkeleton({ columns, rows = 5, label, bare = false }: { columns: string[]; rows?: number; label?: string; bare?: boolean }) {
  const translateInterface = usePointerTranslations();
  return <LoadingSkeleton label={label ?? translateInterface("Loading rows")}><div className={bare ? "table-scroll" : "card table-scroll"}><table><thead><tr>{columns.map((column, index) => <th key={index}>{column}</th>)}</tr></thead><tbody>{Array.from({ length: rows }, (_, row) => <tr key={row}>{columns.map((_, column) => <td key={column}><SkeletonLine wide={column === 0} /></td>)}</tr>)}</tbody></table></div></LoadingSkeleton>;
}
export function CardsSkeleton({ label, count = 3, className = "model-grid" }: { label: string; count?: number; className?: string }) {
  return <LoadingSkeleton label={label}><div className={className}>{Array.from({ length: count }, (_, index) => <div className="card skeleton-card" key={index}><SkeletonLine wide /><SkeletonLine /><span className="skeleton block" /></div>)}</div></LoadingSkeleton>;
}
export function FormSkeleton({ label, fields = 3 }: { label: string; fields?: number }) {
  return <LoadingSkeleton label={label}><section className="card stack"><SkeletonLine wide />{Array.from({ length: fields }, (_, index) => <div className="field" key={index}><SkeletonLine /><span className="skeleton skeleton-input" /></div>)}</section></LoadingSkeleton>;
}
export function DetailSkeleton({ label, kind }: { label: string; kind: "model" | "group" | "instance" | "provider" | "key" }) {
  const translateInterface = usePointerTranslations();
  return <div className="stack"><LoadingSkeleton label={label}><SkeletonLine /><div className="model-hero"><span className="skeleton skeleton-avatar" /><div><SkeletonLine wide /><SkeletonLine /></div></div></LoadingSkeleton>
    {kind === "model" ? <><CardsSkeleton label={translateInterface("Loading specifications")} count={4} className="kpi-grid" /><TableSkeleton columns={[translateInterface("Provider"), translateInterface("Model"), translateInterface("Availability"), translateInterface("Pricing")]} /></>
      : kind === "group" ? <><FormSkeleton label={translateInterface("Loading group routing")} fields={2} /><TableSkeleton columns={[translateInterface("Model"), translateInterface("Provider"), translateInterface("Routing aliases"), translateInterface("Actions")]} /></>
      : <><div className="detail-grid"><FormSkeleton label={translateInterface("Loading settings")} /><FormSkeleton label={translateInterface("Loading details")} /></div>{kind !== "key" && <TableSkeleton columns={kind === "provider" ? [translateInterface("Account"), translateInterface("Status"), ""] : [translateInterface("Model"), translateInterface("Provider"), translateInterface("Alias"), translateInterface("Position")]} />}</>}
  </div>;
}
