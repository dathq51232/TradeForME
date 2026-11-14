"use client";
import type { ReactNode } from "react";
import { PANEL_KEY, type Panel } from "@/lib/panels";

/**
 * Toggles a panel. State lives on <html> (not in React), so server and client markup always match and the
 * Tailwind variants nav-collapsed / wl-collapsed (globals.css) do the showing and hiding.
 */
export function PanelToggle({ panel, className, title, children }: { panel: Panel; className?: string; title: string; children: ReactNode }) {
  const toggle = () => {
    const html = document.documentElement;
    const collapsed = html.getAttribute(`data-${panel}`) !== "collapsed";
    if (collapsed) html.setAttribute(`data-${panel}`, "collapsed");
    else html.removeAttribute(`data-${panel}`);
    try { window.localStorage.setItem(PANEL_KEY[panel], collapsed ? "collapsed" : "expanded"); } catch { /* storage blocked: fine for this visit */ }
  };
  return (
    <button type="button" onClick={toggle} title={title} aria-label={title} className={className}>
      {children}
    </button>
  );
}
