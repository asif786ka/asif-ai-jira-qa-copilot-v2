# JiraQA MCP Server

Exposes the project's two multi-agent LangGraph pipelines as Model Context
Protocol tools, callable from any MCP-compatible client (Claude Code,
Cursor, Windsurf, Claude Desktop, custom Anthropic Agent SDK builds).

## Tools

| Tool | What it does |
|---|---|
| `validate_jira_ticket` | Deterministic readiness rules + optional LLM rubric. |
| `generate_test_cases` | 5-agent pipeline: readiness → requirements → generator → reviewer (repair) → scorer. |
| `codegen_e2e_tests` | 4-agent pipeline: scanner → generator → static reviewer (repair) → narrator. Maestro / XCUITest / Espresso / Playwright. |
| `list_supported_frameworks` | Discoverable enumeration of frameworks + platforms. |

## Install (one-time)

Whichever client you use, the JiraQA MCP server runs as a stdio subprocess
the client launches. Make sure the venv exists first:

```bash
cd <repo root>
./run-dev.sh            # creates apps/api-python/.venv and installs deps
```

You only need `apps/api-python/.venv` populated; `run-dev.sh` does that on
its first invocation. After that, register the server with your client:

### Claude Code

Add to your project's `.mcp.json` (or `~/.config/claude/mcp.json` for global):

```json
{
  "mcpServers": {
    "jiraqa": {
      "command": "/Users/sanasif786ka/Desktop/mobile-jira-copilot/apps/api-python/.venv/bin/python",
      "args": ["/Users/sanasif786ka/Desktop/mobile-jira-copilot/apps/api-python/mcp_server.py"]
    }
  }
}
```

Restart Claude Code. Run `/mcp` to confirm `jiraqa` is connected; you
should see four tools listed.

### Cursor

`~/.cursor/mcp.json` (or per-project `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "jiraqa": {
      "command": "/Users/sanasif786ka/Desktop/mobile-jira-copilot/apps/api-python/.venv/bin/python",
      "args": ["/Users/sanasif786ka/Desktop/mobile-jira-copilot/apps/api-python/mcp_server.py"]
    }
  }
}
```

Restart Cursor. Open the MCP panel; `jiraqa` should appear green.

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS:

```json
{
  "mcpServers": {
    "jiraqa": {
      "command": "/Users/sanasif786ka/Desktop/mobile-jira-copilot/apps/api-python/.venv/bin/python",
      "args": ["/Users/sanasif786ka/Desktop/mobile-jira-copilot/apps/api-python/mcp_server.py"]
    }
  }
}
```

Restart Claude Desktop. You'll see the hammer-and-screwdriver icon in any
new conversation — click it to confirm the tools are available.

### Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "jiraqa": {
      "command": "/Users/sanasif786ka/Desktop/mobile-jira-copilot/apps/api-python/.venv/bin/python",
      "args": ["/Users/sanasif786ka/Desktop/mobile-jira-copilot/apps/api-python/mcp_server.py"]
    }
  }
}
```

## Try it

From any of those clients, prompt:

> Use `validate_jira_ticket` to check a story with summary
> "Login screen rejects empty password with inline error" and two
> Given/When/Then acceptance criteria, then call `generate_test_cases`
> with platform="android" and show me the result.

The IDE's LLM picks the right tool, fills the JSON Schema arguments,
calls the JiraQA server, and the agentic pipeline returns a structured
test plan. No browser, no FastAPI HTTP layer, no UI required.

## Debugging

Anthropic ships a built-in inspector:

```bash
apps/api-python/.venv/bin/mcp dev apps/api-python/mcp_server.py
```

Opens a web UI at `http://localhost:6274` where you can call each tool
with handcrafted JSON, see schemas, and watch the JSON-RPC frames live.

## Environment

The server loads the same `.env` files `apps/api-python/api/main.py`
loads — first hit wins:

1. `apps/api-python/.env`
2. repo-root `.env.local`
3. `apps/web/.env.local`

Make sure `OPENAI_API_KEY` (or `GEMINI_API_KEY` / `ANTHROPIC_API_KEY`)
is set in one of these. The MCP server does **not** require any
Jira / GitHub credentials — those data fetches are the client's job.
This server is pure agentic intelligence on top.

## Why this design

* **Provider registry pays off here.** Claude Code drives Anthropic
  Sonnet on the developer's machine; the JiraQA server may be configured
  to call Gemini Flash, OpenAI gpt-4o-mini, or a private Ollama for its
  agentic work. Different LLM families on each side, zero coupling.
* **No new auth surface.** Stdio transport runs as a subprocess of the
  MCP client. There's no port, no token, no CORS, no auth layer to
  maintain.
* **Reuses the existing LangGraph code.** Every MCP tool wraps a function
  that's already battle-tested by the FastAPI side + the pytest suite
  (52 tests). One source of truth.
