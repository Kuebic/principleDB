// Connect-your-AI page renderer — Slice W5 (#50).
// Static content: copy-paste connect steps against the deployed /mcp URL for
// claude.ai/Desktop custom connectors, Claude Code, ChatGPT dev mode, Cursor.
// The endpoint is anonymous + read-only; no OpenAI search/fetch alias tools
// (deferred, #41). This module is a pure renderer.

import { describe, expect, it } from 'vitest';
import { renderConnectPage } from './render-connect-page';

const MCP_URL = 'https://principledb.example.com/mcp';

describe('renderConnectPage', () => {
  it('sets meta robots=noindex (public site, unlisted)', () => {
    const html = renderConnectPage({ mcpUrl: MCP_URL });
    expect(html).toMatch(/<meta[^>]+name=["']robots["'][^>]+content=["']noindex["']/i);
  });

  it('shows the deployed /mcp URL prominently', () => {
    const html = renderConnectPage({ mcpUrl: MCP_URL });
    expect(html).toContain(MCP_URL);
  });

  it('states the endpoint is anonymous + read-only', () => {
    const html = renderConnectPage({ mcpUrl: MCP_URL }).toLowerCase();
    expect(html).toContain('anonymous');
    expect(html).toContain('read-only');
  });

  it('names each connect step: claude.ai / Desktop, Claude Code, ChatGPT dev mode, Cursor', () => {
    const html = renderConnectPage({ mcpUrl: MCP_URL });
    expect(html).toMatch(/claude\.ai/i);
    expect(html).toMatch(/claude desktop/i);
    expect(html).toMatch(/claude code/i);
    expect(html).toMatch(/chatgpt/i);
    expect(html).toMatch(/developer mode|dev mode/i);
    expect(html).toMatch(/cursor/i);
  });

  it('includes the Claude Code CLI command with --transport http and the /mcp URL', () => {
    const html = renderConnectPage({ mcpUrl: MCP_URL });
    // The canonical shape from the research doc §3: `claude mcp add --transport http … /mcp`
    expect(html).toContain('claude mcp add');
    expect(html).toContain('--transport http');
    expect(html).toContain(MCP_URL);
  });

  it('includes the Cursor mcp.json snippet with the /mcp URL', () => {
    const html = renderConnectPage({ mcpUrl: MCP_URL });
    // Cursor config is JSON — its snippet must contain the URL as a string field.
    expect(html).toMatch(/mcpServers/);
    expect(html).toContain(MCP_URL);
  });

  it('draws the shallow-public-face vs AI-client-depth distinction (CONTEXT.md carve-out)', () => {
    // The page is where owners point their AI at the full-depth surface; the
    // search page is the shallow public face. The distinction is CONTEXT.md's
    // non-goals carve-out and should be visible here so a first-time visitor
    // understands what "connect your AI" is actually for.
    const html = renderConnectPage({ mcpUrl: MCP_URL }).toLowerCase();
    expect(html).toMatch(/stack|connect|depth|principle/);
  });

  it('does NOT advertise OpenAI-compatible search/fetch alias tools (deferred, #41)', () => {
    // Per ADR-0015 the public surface is exactly the three read tools; alias
    // tools for ChatGPT deep-research / company knowledge are a future
    // extension (#41), not part of this slice.
    const html = renderConnectPage({ mcpUrl: MCP_URL });
    expect(html).not.toMatch(/deep research/i);
  });

  it('escapes HTML in the passed mcpUrl (no XSS via a malformed base URL)', () => {
    const html = renderConnectPage({ mcpUrl: 'https://ex.example/"><script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
