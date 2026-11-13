// Liveness check for the Edge runtime; also used by the deploy workflow as a smoke test.
// The copy-trade (ct-*) and news (news-*) functions arrive in Phases 2–3.
Deno.serve(() =>
  new Response(JSON.stringify({ ok: true, service: "edge", time: new Date().toISOString() }), {
    headers: { "content-type": "application/json" },
  })
);
