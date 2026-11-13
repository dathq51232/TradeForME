import type { ReactNode } from "react";
import type { Tone } from "@/lib/format";

const TONE: Record<Tone, string> = {
  up: "text-up border-up/40 bg-up/10",
  down: "text-down border-down/40 bg-down/10",
  warn: "text-warn border-warn/40 bg-warn/10",
  muted: "text-muted border-border bg-panel-2",
  accent: "text-accent border-accent/40 bg-accent/10",
};
const DOT: Record<Tone, string> = { up: "●", down: "■", warn: "▲", muted: "○", accent: "◆" };

/** Status with a shape and a word, never colour alone (design §3.2). */
export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-xs ${TONE[tone]}`}>
      <span aria-hidden className="text-[0.6rem]">{DOT[tone]}</span>
      {children}
    </span>
  );
}

export function Panel({ title, action, children, className = "" }: {
  title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={`rounded-lg border border-border bg-panel ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          <h2 className="text-sm font-medium">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Kpi({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone }) {
  const color = tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "warn" ? "text-warn" : "";
  return (
    <div className="rounded-lg border border-border bg-panel px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={`mt-1 font-mono text-lg ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted">{children}</p>;
}

export function PageHeader({ title, sub, action }: { title: string; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {sub && <p className="mt-1 text-sm text-muted">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

export function Notice({ tone = "accent", children }: { tone?: Tone; children: ReactNode }) {
  return <div className={`mb-4 rounded-md border px-3 py-2 text-sm ${TONE[tone]}`}>{children}</div>;
}

export const btn = {
  primary: "rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50",
  ghost: "rounded-md border border-border px-3 py-1.5 text-sm hover:bg-panel-2 disabled:opacity-50",
  warn: "rounded-md border border-warn/50 px-3 py-1.5 text-sm text-warn hover:bg-warn/10",
  danger: "rounded-md bg-down px-3 py-1.5 text-sm font-medium text-white hover:brightness-110",
};

export const th = "px-3 py-2 text-left text-xs font-normal text-muted";
export const td = "px-3 py-2";
