// Connect-your-AI page — Slice W5 (#50).
// Copy-paste steps for pointing an AI client at the public `/mcp` endpoint.
// Purpose (CONTEXT.md carve-out): the public search page is the *shallow*
// face — a thought returns connected Quotes, no LLM. Depth — stacking
// Principles into a coherent argument — stays in the owner's own AI client,
// which is what this page exists to enable. Endpoint is anonymous + read-only
// (four tools: search_principles, get_quote_in_context, list_works,
// related_principles); write tools stay off the public surface (ADR-0015 +
// ADR-0017: 3 → 4 public tools with `list_works`). No OpenAI search/fetch
// alias tools — that citability path is deferred to #41.
//
// Pure renderer: takes the deployed /mcp URL and returns HTML. The route
// handler (app.ts) derives the URL from the request so the same page works
// against localhost, Fly, or any Cloudflare-fronted hostname.

export interface RenderConnectPageOptions {
  mcpUrl: string;
}

export function renderConnectPage(options: RenderConnectPageOptions): string {
  const mcpUrl = escapeHtml(options.mcpUrl);
  const cursorSnippet = JSON.stringify(
    { mcpServers: { principledb: { url: options.mcpUrl } } },
    null,
    2,
  );
  // Gemini CLI keys the remote transport off `httpUrl` (not `url`) in
  // ~/.gemini/settings.json — a bare `url` is read as an SSE endpoint.
  const geminiSnippet = JSON.stringify(
    { mcpServers: { principledb: { httpUrl: options.mcpUrl } } },
    null,
    2,
  );

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>principleDB — connect your AI</title>
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
  <header class="topbar">
    <div class="brand">principleDB <small>· connect your AI</small></div>
    <nav class="nav"><a href="/">&larr; search the Canon</a></nav>
  </header>

  <section class="intro">
    <p class="lead">The public search is the <b>shallow</b> face — a thought returns
      connected Quotes, no LLM. The <b>depth</b> — stacking Principles into a
      coherent argument in dialogue with you — stays in your own AI client. Point
      it at the endpoint below and it can search the Canon, open Quotes in
      context, and traverse related Principles.</p>
    <div class="endpoint">
      <label>Public MCP endpoint</label>
      <code class="url">${mcpUrl}</code>
      <p class="sub">Anonymous · read-only · four tools:
        <code>search_principles</code>, <code>get_quote_in_context</code>,
        <code>list_works</code>, <code>related_principles</code>. Write tools
        stay off the public surface.</p>
    </div>
  </section>

  <section class="clients">
    <article class="client">
      <h2>claude.ai (web) · Claude Desktop</h2>
      <ol>
        <li>Open <b>Settings → Connectors</b>.</li>
        <li>Click <b>Add custom connector</b>.</li>
        <li>Paste the URL: <code>${mcpUrl}</code></li>
        <li>Click <b>Add</b>. Leave OAuth fields blank — the endpoint is no-auth.</li>
      </ol>
      <p class="note">Available on Free, Pro, Max, Team, and Enterprise. Free is
        limited to one custom connector; the feature is labelled beta.</p>
    </article>

    <article class="client">
      <h2>Claude Code</h2>
      <p>Add it once from the terminal:</p>
      <pre><code>claude mcp add --transport http --scope user principledb ${mcpUrl}</code></pre>
      <p class="note"><code>--scope user</code> makes it available in every project.
        Drop the flag to add it to the current project only. Inside Claude Code,
        <code>/mcp</code> lists connected servers.</p>
    </article>

    <article class="client">
      <h2>ChatGPT (Developer mode)</h2>
      <ol>
        <li>Open <b>Settings</b> and toggle <b>Developer mode</b> on (Plus, Pro,
          Business, Enterprise, or Edu; web only).</li>
        <li>Add a new app pointing at: <code>${mcpUrl}</code></li>
        <li>Set authentication to <b>None</b>.</li>
      </ol>
      <p class="note">Streamable HTTP is supported; the endpoint is anonymous.</p>
    </article>

    <article class="client">
      <h2>Grok (grok.com)</h2>
      <ol>
        <li>Open <b>grok.com/connectors</b> and click <b>New Connector</b>.</li>
        <li>Select <b>Custom</b>.</li>
        <li>Enter the server URL: <code>${mcpUrl}</code></li>
        <li>Leave authentication blank — the endpoint is no-auth. Grok discovers
          the tools and offers them in conversations.</li>
      </ol>
      <p class="note">Grok 4.3 and later. Streamable HTTP transport (stdio is not
        accepted), so the endpoint must be reachable on the public internet. Team
        setups add it under <code>console.x.ai</code> → Grok Business → Connectors.</p>
    </article>

    <article class="client">
      <h2>Gemini CLI</h2>
      <p>Add it once from the terminal:</p>
      <pre><code>gemini mcp add --transport http principledb ${mcpUrl}</code></pre>
      <p>Or add the entry to <code>~/.gemini/settings.json</code> by hand:</p>
      <pre><code>${escapeHtml(geminiSnippet)}</code></pre>
      <p class="note"><code>--transport http</code> selects the streamable-HTTP
        transport (the endpoint is remote, not stdio). No auth headers — the
        endpoint is no-auth. Inside a session, <code>/mcp</code> lists connected
        servers and their tools.</p>
    </article>

    <article class="client">
      <h2>Cursor</h2>
      <p>Add the entry to <code>~/.cursor/mcp.json</code> (create the file if it
        doesn't exist):</p>
      <pre><code>${escapeHtml(cursorSnippet)}</code></pre>
      <p class="note">Restart Cursor after saving. The tools show up in the MCP
        panel.</p>
    </article>
  </section>

  <section class="clients">
    <article class="client">
      <h2>Core vs. supplementary sources</h2>
      <p>By default, searches cover the <b>core</b> Canon — the foundational
        scripture. Supplementary material (sermons, transcripts, later
        commentary) is marked <b>extra</b> and stays <b>out of results unless you
        ask for it</b>, so a plain question isn't answered from a one-off talk.</p>
      <p>To pull the supplementary sources in, tell your AI client to
        <b>include the extra sources</b> — it sets <code>includeExtras: true</code>
        on <code>search_principles</code> (and <code>related_principles</code>),
        which searches the core Canon <i>plus</i> every extra source at once:</p>
      <pre><code>search_principles(query: "the meaning of special grace", includeExtras: true)</code></pre>
      <p class="note">To narrow to one speaker or book instead, name it — e.g.
        &ldquo;only look through <b>Damien Dunkley</b>&rdquo; sets
        <code>figures: ["damien-dunkley"]</code>. Call <code>list_works</code> to
        see every Work and whether it's core or extra.</p>
    </article>
  </section>

  <footer class="foot">
    <p>The endpoint returns exactly what an owner's own AI client would see over
      stdio — the same three read tools, the same JSON. Nothing you send is
      logged beyond IP + user-agent for abuse control.</p>
    <p>This page is unlisted and not indexed. To request removal of any material,
      contact <a href="mailto:removals@principledb.example">removals@principledb.example</a>.</p>
  </footer>
</div>
</body>
</html>`;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLES = `
:root {
  --ink: #23201c; --ink-soft: #5b544a; --ink-faint: #8a8073;
  --paper: #faf7f1; --paper-2: #f2ece1;
  --card: #ffffff; --line: #e4dccd;
  --accent: #9a6a2f; --accent-soft: #f3e3c9;
  --serif: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", monospace;
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--paper); color: var(--ink); font-family: var(--sans); line-height: 1.5; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code { font-family: var(--mono); font-size: 13px; background: var(--paper-2);
  padding: 1px 6px; border-radius: 4px; color: var(--ink); }
pre { background: #1f1c18; color: #f6ecd8; border-radius: 10px;
  padding: 14px 16px; overflow-x: auto; font-size: 13px; line-height: 1.55; }
pre code { background: transparent; color: inherit; padding: 0; font-size: 13px; }
.wrap { max-width: 880px; margin: 0 auto; padding: 24px 20px 80px; }
.topbar { display: flex; align-items: center; gap: 14px; padding: 8px 2px 20px; }
.brand { font-weight: 700; font-size: 18px; }
.brand small { color: var(--ink-faint); font-weight: 500; }
.nav { margin-left: auto; font-size: 14px; }
.intro { margin-bottom: 26px; }
.lead { font-family: var(--serif); font-size: 19px; color: var(--ink-soft); margin: 6px 2px 22px; }
.lead b { color: var(--ink); font-weight: 600; }
.endpoint { background: var(--card); border: 1px solid var(--line); border-radius: 12px;
  padding: 14px 18px 16px; }
.endpoint label { text-transform: uppercase; letter-spacing: .06em; font-size: 11px;
  color: var(--ink-faint); font-weight: 600; }
.endpoint .url { display: block; margin: 6px 0 10px; padding: 8px 12px; font-size: 14px;
  background: var(--paper-2); border-radius: 6px; word-break: break-all; }
.endpoint .sub { margin: 0; color: var(--ink-soft); font-size: 13.5px; }
.clients { display: flex; flex-direction: column; gap: 18px; }
.client { background: var(--card); border: 1px solid var(--line); border-radius: 14px;
  padding: 18px 22px; }
.client h2 { margin: 0 0 10px; font-size: 17px; }
.client ol, .client p { margin: 6px 0 10px; }
.client ol { padding-left: 22px; }
.client li { margin-bottom: 4px; }
.client .note { font-size: 13px; color: var(--ink-faint); margin-top: 8px; }
.foot { margin-top: 40px; padding-top: 18px; border-top: 1px solid var(--line);
  font-size: 12.5px; color: var(--ink-faint); line-height: 1.6; }
.foot p { margin: 4px 0; }
`;
