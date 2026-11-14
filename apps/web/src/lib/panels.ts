// Collapsible panels: each maps to a data attribute on <html> and a localStorage key (see <PanelToggle>).
// ind / pat: the chart's indicator row and its pattern-recognition row (chips under the toolbar).
export type Panel = "nav" | "wl" | "ind" | "pat";
export const PANEL_KEY: Record<Panel, string> = { nav: "qt-nav", wl: "qt-wl", ind: "qt-ind", pat: "qt-pat" };

/**
 * Restores collapsed panels before first paint (so a collapsed sidebar never flashes open). Runs as an inline
 * script in <head>; storage may be blocked, in which case everything simply starts expanded.
 */
export const PANEL_RESTORE_SCRIPT = `try{var d=document.documentElement,s=window.localStorage;${(Object.keys(PANEL_KEY) as Panel[])
  .map((p) => `if(s.getItem("${PANEL_KEY[p]}")==="collapsed")d.setAttribute("data-${p}","collapsed");`).join("")}}catch(e){}`;
