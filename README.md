# TrueForge Coder — Editor-Native VS Code Coding Agent

Built for **Techfest 2026–27 (IIT Bombay) · TrueFoundry Forge-a-thon**.

**Starting Point Declaration:** Built **from scratch** specifically for this competition using the official VS Code Extension API, `@modelcontextprotocol/sdk`, and `diff`. Zero upstream coding-agent loops are included; **100% of the agent loop runs on [TrueForge](https://github.com/truefoundry/trueforge)**.

---

## Architecture Highlights

* **TrueForge Agent Loop**: The extension creates sessions, streams SSE turns (`POST /api/v1/sessions/{id}/turns`), handles server-side cancellation (`POST /api/v1/sessions/{id}/cancel`), and never calls any LLM provider directly.
* **Embedded Workspace MCP Server (`vscode-editor`)**: Runs inside the VS Code extension host on Streamable HTTP (`http://127.0.0.1:8791/mcp`) and exposes 8 tools to TrueForge:
  * **Preloaded (eager) tools**: `assemble_context`, `search_workspace`, `read_file`
  * **Deferred tools** (`preload: false`): `list_files`, `get_symbols`, `propose_edit`, `run_command`, `git_status`
* **TrueForge Context Engineering**:
  * **Deferred Tool Loading** (`preload: false` + `preload_tools`)
  * **Dynamic Sub-Agents** (`dynamic_sub_agents.enabled = true`)
  * **Context Compaction & Large Tool Response Handling** (`context_management.compaction.enabled = true`)
* **Budget-Capped Context Assembly (`src/contextAssembler.ts`)**:
  * Supports explicit `@file` and `@symbol` mentions with live autocomplete in the sidebar.
  * Automatic IDF-weighted lexical + symbol + architectural role retrieval strictly capped to a configurable token budget (default `12,000` tokens), visibly rendering **every chosen file, token usage bar, and why it was chosen** in the UI.
* **TrueForge Tool Approval $\rightarrow$ Per-Hunk Diff Review & Undo (`src/diffReviewManager.ts`)**:
  * `propose_edit` and `run_command` are listed in `require_approval_for_tools`.
  * When TrueForge emits `tool.approval_required`, VS Code renders colored per-hunk diffs with CodeLens **Accept Hunk** / **Reject Hunk** buttons (and synced sidebar buttons). Nothing touches disk until accepted.
  * Every applied edit is recorded on an Undo stack (`Ctrl+Alt+Z` or **Undo** button) for instant rollback.
* **Resilience & Zero-Click Model Fallback (`src/trueforgeClient.ts`)**:
  * Model-agnostic dropdown dynamically fetched from TrueForge (`/api/v1/models`).
  * When the primary model fails (invalid key, unreachable endpoint, 503), the extension keeps the editor responsive, leaves the workspace untouched (`git status` clean), displays a clear banner, and **automatically switches to the configured fallback model with zero user action**.

---

## Clean-Clone Setup Instructions

### 1. Start TrueForge Locally
Start TrueForge in standalone local mode with `localhost`/`127.0.0.1` allowlisted for the embedded VS Code MCP server:

**Windows (PowerShell):**
```powershell
$env:OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]'
npx @truefoundry/trueforge@latest
```
*(Or run `./start-trueforge.ps1`)*

**macOS / Linux:**
```bash
OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]' npx @truefoundry/trueforge@latest
```
*(Or run `./start-trueforge.sh`)*

### 2. Configure Models in TrueForge
Open `http://localhost:8790` $\rightarrow$ **Settings $\rightarrow$ Model Providers** and add your preferred model provider(s). See [`config.example.json`](./config.example.json) for an example configuration (never commit API keys).

### 3. Build & Launch the VS Code Extension
```bash
npm install
npm run build
```

Open this folder (`trueforge-vscode`) in VS Code and press **F5** (uses `.vscode/launch.json` to open the Extension Development Host). Or launch directly against the pinned Flask 3.1.3 benchmark repository:
```bash
git clone --branch 3.1.3 https://github.com/pallets/flask.git ../flask
code --extensionDevelopmentPath="$PWD" ../flask
```

On activation, the extension automatically:
1. Starts the embedded `vscode-editor` MCP server (`http://127.0.0.1:8791/mcp`).
2. Registers `vscode-editor` with TrueForge (`PUT /api/v1/settings/mcp-servers`).
3. Loads and syncs [`agent-definition.json`](./agent-definition.json) into TrueForge (`trueforge-coder`).

---

## Keybindings & Commands

| Action | Keybinding | Command |
| :--- | :--- | :--- |
| Inline Edit Selection | `Ctrl+Shift+K` (`Cmd+Shift+K`) | `TrueForge: Inline Edit Selection` |
| Cancel Generation Immediately | `Ctrl+Shift+Esc` (`Cmd+Shift+Esc`) | `TrueForge: Cancel Active Generation` |
| Undo Last Applied Edit | `Ctrl+Alt+Z` (`Cmd+Alt+Z`) | `TrueForge: Undo Last Applied Edit` |
| Open TrueForge Session UI | Toolbar `Session ↗` | `TrueForge: Open Session in TrueForge UI` |

---

## License
MIT License — see [`LICENSE`](./LICENSE).
