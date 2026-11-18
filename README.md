# TrueForge Coder — Editor-Native VS Code Coding Agent

[![Techfest 2026-27](https://img.shields.io/badge/Techfest%202026--27-IIT%20Bombay-blue)](https://techfest.org)
[![TrueFoundry Forge-a-thon](https://img.shields.io/badge/TrueFoundry-Forge--a--thon-orange)](https://github.com/truefoundry/trueforge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Built for the **Techfest 2026–27 (IIT Bombay) · TrueFoundry Forge-a-thon** (Round 1 Submission).

* **Team Name:** Blue.io
* **Team Members:**
  * **Bandita Priyadarshini** (GitHub: `@bandita-priyadarshini`)
  * **Subham Srinibas Panda** (GitHub: `@Subhamm-09`)

---

## Deliverables & Documentation Links
* 📄 **Technical Write-up (Markdown):** [`WRITEUP.md`](./WRITEUP.md) — Complete 8-section technical report with rubric anchors.
* 🖨️ **Technical Write-up (Print-ready HTML/PDF):** [`WRITEUP.html`](./WRITEUP.html) — Styled for 1-to-3 page PDF export (`Ctrl + P`).
* 🎬 **Demo Video Script:** [`DEMO_SCRIPT.md`](./DEMO_SCRIPT.md) — Second-by-second video recording walkthrough under 4 minutes.
* ⚙️ **Example Configuration:** [`config.example.json`](./config.example.json) — Zero secrets / API keys committed.
* 🤖 **Agent Definition:** [`agent-definition.json`](./agent-definition.json) — TrueForge agent specification with deferred tools & compaction.

---

## Starting Point Declaration

* Built **from scratch** specifically for this competition using the official VS Code Extension API (`vscode`), `@modelcontextprotocol/sdk`, and `diff`.
* **Zero Upstream Coding Loops:** We did **not** retain any upstream agent harness loop. **100% of the agent loop runs entirely on [TrueForge](https://github.com/truefoundry/trueforge)** (`http://localhost:8790`).
* **UI/UX Inspiration:** The extension interface draws stylistic inspiration from the clean, ergonomic layout conventions of Continue (collapsible execution cards, streaming chat bubbles, syntax-highlighted diffs, and inline diff widgets), implemented from the ground up to integrate directly with TrueForge's SSE stream and interactive tool approval events.

---

## Architecture

```
+-----------------------------------------------------------------------------------+
| VS Code Extension Host (Client & Environment)                                    |
|                                                                                   |
|  +------------------------+      HTTP SSE Stream       +-----------------------+  |
|  | Agent Panel Webview   | <========================> | TrueForge Client      |  |
|  | - Continue-style UI    |   (Turns, Tokens, Events)  | - Session Management  |  |
|  | - Context & Hunk Cards |                            | - Tool Approval Interp|  |
|  +------------------------+                            | - Zero-Action Fallback|  |
|               ^                                        +-----------------------+  |
|               | (Approve/Reject Hunks)                             |              |
|  +------------------------+                                        |              |
|  | Diff Review Manager    |                                        | HTTP REST    |
|  | - Virtual Diff Provider|                                        | / SSE        |
|  | - CodeLens & Undo Stack|                                        v              |
|  +------------------------+                            +-----------------------+  |
|               ^                                        | TrueForge Harness     |  |
|               | (propose_edit / run_cmd)               | (localhost:8790)      |  |
|  +-----------------------------------+                 | - Agent Loop          |  |
|  | Embedded Streamable MCP Server     | <============> | - Compaction          |  |
|  | (http://127.0.0.1:8791/mcp)        |   JSON-RPC     | - Deferred Tools      |  |
|  | Tools: assemble_context, read_file,|                | - Model Router        |  |
|  | search_workspace, propose_edit...  |                +-----------------------+  |
+-----------------------------------------------------------------------------------+
```

### Key Engineering Capabilities
1. **Embedded Streamable MCP Server (`vscode-editor`)**: Runs inside the extension on `http://127.0.0.1:8791/mcp`, exposing 8 tools:
   * **Preloaded (Eager):** `assemble_context`, `search_workspace`, `read_file`
   * **Deferred (`preload: false`):** `list_files`, `get_symbols`, `propose_edit`, `run_command`, `git_status`
2. **Context Assembly with Strict Token Budget (`src/contextAssembler.ts`)**:
   * Evaluates exact path tokens, AST symbol definitions, architectural roles, and lexical TF-IDF.
   * Capped strictly to a 4,500-token budget (~16,500 chars), safely preventing TrueForge's 24,000-character tool response truncation.
   * Live UI reporting in the purple Context Assembly Card showing exact token budget, selected files with rationale, and excluded candidates.
3. **TrueForge Tool Approvals & Diff Safety (`src/diffReviewManager.ts`)**:
   * TrueForge tool approval events (`require_approval_for_tools: ["propose_edit", "run_command"]`) drive inline per-hunk diff reviews.
   * CodeLens **Accept Hunk** / **Reject Hunk** buttons allow granular review. Nothing touches disk without confirmation.
   * Full atomic **Undo Stack** (`Ctrl+Alt+Z` or Undo button) enables 1-click rollback of applied changes.
4. **Resilience & Zero-Click Model Fallback (`src/trueforgeClient.ts`)**:
   * Primary model failure (401/404/503) triggers automatic resilience fallback to the secondary configured model with zero user clicks. The workspace remains completely clean.
5. **Real-time SSE Streaming & Instant Cancellation**:
   * Tokens stream live as generated.
   * Pressing `Ctrl+Shift+Esc` or clicking **Cancel** aborts generation immediately without freezing the editor or leaving half-applied edits.

---

## Clean-Clone Setup Instructions

### Prerequisites
* **Node.js** v18+ and **npm**
* **Python** 3.10+
* **Git**

### 1. Start TrueForge Locally
TrueForge must run with `localhost`/`127.0.0.1` allowlisted for the embedded VS Code MCP server:

**Windows:**
```cmd
start-trueforge.bat
```
*(Or PowerShell: `$env:OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]'; npx @truefoundry/trueforge@latest`)*

**macOS / Linux:**
```bash
chmod +x ./start-trueforge.sh
./start-trueforge.sh
```

### 2. Configure Model Providers in TrueForge
Open `http://localhost:8790` $\rightarrow$ **Settings $\rightarrow$ Model Providers** and configure your provider (e.g. Google AI Studio, Groq, or OpenAI). See [`config.example.json`](./config.example.json).

### 3. Setup the Flask 3.1.3 Benchmark Repository & Python Virtualenv
```bash
# Clone the pinned Flask 3.1.3 benchmark repository
git clone --branch 3.1.3 https://github.com/pallets/flask.git ../flask

# Create virtualenv and install editable Flask + pinned pytest
python -m venv ../flask-venv
../flask-venv/Scripts/python -m pip install -e ../flask
../flask-venv/Scripts/python -m pip install "pytest==8.3.5"
```

### 4. Build & Launch the VS Code Extension
```bash
npm install
npm run build
```

Open this directory (`trueforge-vscode`) in VS Code and press **F5** to launch the Extension Development Host against the Flask workspace:
```bash
code --extensionDevelopmentPath="$PWD" ../flask
```

On activation, the extension automatically:
1. Starts the embedded `vscode-editor` MCP server on `http://127.0.0.1:8791/mcp`.
2. Registers the MCP server with TrueForge via `PUT /api/v1/settings/mcp-servers`.
3. Syncs [`agent-definition.json`](./agent-definition.json) into TrueForge.

---

## Keybindings & Shortcuts

| Action | Keybinding | Command |
| :--- | :--- | :--- |
| **Inline Edit Selection** | `Ctrl+Shift+K` (`Cmd+Shift+K`) | `TrueForge: Inline Edit Selection` |
| **Cancel Generation Immediately** | `Ctrl+Shift+Esc` (`Cmd+Shift+Esc`) | `TrueForge: Cancel Active Generation` |
| **Undo Last Applied Edit** | `Ctrl+Alt+Z` (`Cmd+Alt+Z`) | `TrueForge: Undo Last Applied Edit` |
| **Open TrueForge Web Session** | Sidebar Header `Session ↗` | `TrueForge: Open Session in TrueForge UI` |

---

## Verifying Fixed Benchmark Tasks

### Task A: Inline Edit
1. Open `src/flask/helpers.py`, select lines 28–34 (`get_debug_flag`).
2. Press `Ctrl+Shift+K` and enter:
   `"Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false."`
3. Accept the proposed hunk.
4. Verify in terminal:
   ```powershell
   $env:FLASK_DEBUG="off"; python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
   ```
   *Expected output:* `False`
5. Test Undo: Click **Undo** (`Ctrl+Alt+Z`) and rerun above command; output reverts to `True`.

### Task B: Agent Mode (Multi-File Discovery)
1. Open TrueForge Coder panel in sidebar. Without mentioning any file names, instruct:
   `"Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands."`
2. The agent autonomously retrieves and modifies `src/flask/cli.py`, `tests/test_cli.py`, and `docs/cli.rst`.
3. Review and accept hunks.
4. Verify in terminal:
   ```powershell
   pytest tests/test_cli.py -q
   flask --help
   flask --app tests/test_apps/cliapp/app.py config
   ```
   *Expected output:* All tests pass (56 passed), `config` appears in help, and configuration is printed as JSON with masked secrets.

### Task C: Resilience & Auto-Fallback
1. In the sidebar dropdown, select `invalid-primary/invalid-key-model`.
2. Repeat Task A.
3. The extension displays the amber `⚡ Automatic Resilience Fallback` notification and automatically completes the edit via the fallback model (`google-gemini/gemini-3-5-flash-lite`) with zero user clicks.
4. Verify `git status` remains clean during failure.

---

## License
MIT License — see [`LICENSE`](./LICENSE).
