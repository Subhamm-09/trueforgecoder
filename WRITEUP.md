# TrueForge Coder — Technical Write-up
**Competition:** Techfest 2026–27 (IIT Bombay) · TrueFoundry Forge-a-thon  
**Submission Category:** Round 1 Track Deliverable  
**Date:** November 2026  

---

## 1. Team

* **Team Name:** Blue.io
* **Team Members:**
  * **Bandita Priyadarshini** (GitHub: `@bandita-priyadarshini` | Institution: National Institute of Technology)
  * **Subham Srinibas Panda** (GitHub: `@Subhamm-09` | Email: `subhamsrinivaspanda@gmail.com` | Institution: National Institute of Technology)

---

## 2. Starting Point

* **Declaration:** Built **from scratch** specifically for the TrueFoundry Forge-a-thon using the official VS Code Extension API (`vscode`), the official Model Context Protocol TypeScript SDK (`@modelcontextprotocol/sdk`), and `diff`.
* **Zero Upstream Agent Loops:** We did **not** fork an existing coding agent harness (such as Cline, Roo Code, or Continue's backend). **100% of the agent loop runs entirely on TrueForge** (`http://localhost:8790`). The extension operates purely as an editor-native client, UI shell, and MCP tool provider.
* **UI/UX Design Language:** The visual design and panel layout draw inspiration from the clean, ergonomic interface conventions of Continue (collapsible tool execution cards, streaming chat bubbles, syntax-highlighted diffs, and 1-click model switching), fully custom-implemented to bind directly to TrueForge's SSE stream and approval events.

---

## 3. Architecture on TrueForge

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

### Communication Flow
1. **TrueForge Agent Loop**: The extension communicates with TrueForge strictly over its public HTTP REST and Server-Sent Events (SSE) streaming API:
   * `POST /api/v1/sessions` initializes a dedicated session tagged with the workspace root.
   * `POST /api/v1/sessions/{id}/turns` initiates an execution turn. Streamed events (`agent.turn.start`, `token`, `tool.call.start`, `tool.approval_required`, `agent.turn.complete`) are parsed in real time.
   * `POST /api/v1/sessions/{id}/cancel` triggers instant server-side cancellation.
2. **Embedded Streamable HTTP MCP Server (`vscode-editor`)**:
   * Runs inside the extension host listening on `http://127.0.0.1:8791/mcp`.
   * Automatically registered with TrueForge upon extension activation via `PUT /api/v1/settings/mcp-servers`.
   * TrueForge is launched with `OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]'` to allow loopback tool calls through TrueForge's SSRF protection layer.
3. **Exposed MCP Tools**:
   * **Preloaded (Eager) Tools**:
     * `assemble_context`: Intelligent lexical/AST ranker returning relevance-ranked files within a strict token budget.
     * `search_workspace`: Fast regex/substring search over the repository.
     * `read_file`: Line-bounded file content retrieval.
   * **Deferred Tools** (`preload: false`):
     * `list_files`: Workspace tree discovery.
     * `get_symbols`: Symbol outline extractor.
     * `propose_edit`: Proposes unified diff modifications requiring explicit user approval.
     * `run_command`: Subprocess execution with auto-injected virtual environment PATH (`flask-venv`), requiring user approval.
     * `git_status`: Inspects repository dirty state.
4. **Harness Context-Engineering Features Used**:
   * **Deferred Tool Loading**: Tool schemas for mutating/heavy tools (`propose_edit`, `run_command`, `git_status`) are marked `preload: false`. They are only loaded on demand via TrueForge's `call_tool` meta-envelope when the agent decides to act, saving ~1,500 prompt tokens per turn.
   * **TrueForge Tool Approvals**: Configured with `require_approval_for_tools: ["propose_edit", "run_command"]`. When TrueForge issues `tool.approval_required`, generation pauses. The extension renders a colorized per-hunk diff review in the editor. Upon user action (Accept/Reject), the decision is returned to TrueForge via `{ approved: true/false }`.
   * **Context Compaction & Large Tool Response Safeguard**: Enabled in `agent-definition.json` (`threshold: 0.85`). Furthermore, our `assemble_context` tool caps its response to 4,500 tokens (~16,500 characters), safely under TrueForge's 24,000-character ceiling for `large_tool_response`.

---

## 4. How Context Is Selected

Context selection is the intellectual core of TrueForge Coder. When operating on large repositories like `pallets/flask` (17,000+ LOC), concatenating files blindly fills the context window with irrelevant tokens.

```
Workspace Files (217 files)
           │
           ▼
[ AST Symbol Parsing & Path Analysis ]
           │
           ▼
[ Multi-Signal Relevance Scoring ]
  Score = 40.0 * ExactSegmentMatch
        + 15.0 * StemmedSegmentMatch
        + 25.0 * ASTSymbolMatch
        + 30.0 * ArchitecturalRoleMatch (CLI / Docs / Tests)
        + 10.0 * BM25/IDF Lexical Frequency
        + 1000.0 * Explicit @mentions
           │
           ▼
[ Priority Ranker & Token Knapsack ]
  Budget: Strictly capped at 4,500 tokens (16,500 chars)
           │
           ├─► Selected: src/flask/cli.py (1,147 tok, Score: 125.4)
           ├─► Selected: docs/cli.rst     (1,268 tok, Score: 114.8)
           ├─► Selected: tests/test_cli.py(1,017 tok, Score: 110.6)
           ├─► Selected: tests/test_json.py(1,008 tok, Score: 71.1)
           │
           └─► Excluded by Budget: src/flask/json/tag.py, tests/test_config.py...
```

### Retrieval Strategy
1. **Explicit Mentions**: Direct `@file` and `@symbol` mentions typed in the input box receive an immediate $+1,000.0$ boost, guaranteeing inclusion in the top rank.
2. **Multi-Signal Relevance Scoring**: For unprompted agent tasks (Task B), the context assembler parses the instruction and scores repository files against:
   * **Exact & Stemmed Path Segments** ($40\times / 15\times$ weight): Matching core concepts like `cli`, `config`, `helpers`.
   * **AST Symbol Relevance** ($25\times$ weight): Extracted classes, functions, and Click command decorators (`@cli.command`).
   * **Architectural Role Weighting** ($30\times$ weight): Prioritizes tripartite architecture (implementation in `src/flask/cli.py`, documentation in `docs/cli.rst`, test fixtures in `tests/test_cli.py`).
   * **Lexical TF-IDF** ($10\times$ weight): Inverse document frequency weighting across identifiers.
3. **Strict Size Budget (4,500 Tokens)**:
   * Files are accumulated into a greedy knapsack until the 4,500-token cap is reached.
   * Excluded files are summarized in an `Excluded by budget` section to give the agent awareness of omitted paths without consuming tokens.
4. **Transparent Visual Feedback**:
   * The sidebar renders a dedicated **Context Assembly Card** with a progress bar (`4440 / 4500 tok Capped (99%)`), listing every selected file with its exact score and rationale (e.g., *“Exact path segment match: cli; Defines relevant symbols: _validate_key, cligroup”*), followed by excluded files.

---

## 5. Model Setup

### Models Used & Operating Environment
* **Primary Model:** `google-gemini/gemini-3-5-flash-lite` (run via Google AI Studio API configured through TrueForge model provider catalog).
* **Fallback Model:** `google-gemini/gemini-3-1-flash-lite` (run via Google AI Studio API configured through TrueForge model provider catalog).
* **Resilience Test Model:** `invalid-primary/invalid-key-model` (configured in TrueForge with an invalid API key to trigger immediate 401/404/503 errors).

### Approximate Cost
* Both Gemini 3.5 Flash Lite and 3.1 Flash Lite operate comfortably within Google AI Studio's free tier (15 RPM / 1,500 RPD).
* Paid rate: $\$0.075$ per 1M input tokens, $\$0.30$ per 1M output tokens.
* Total cost incurred across all benchmarking, Task A/B/C verification runs, and rehearsals: **$\approx \$0.04$ USD**.

### How a User Switches Models
1. **UI Dropdowns:** The extension header provides two synchronized dropdowns populated via `GET /api/v1/models` from TrueForge: **Primary Model** and **Auto-Fallback Model**.
2. **Zero-Action Resilience Switch (Task C):** If the primary model fails (401 invalid key, 404 missing model, or 503 service outage), `trueforgeClient.ts` captures the failure, preserves the editor state, displays an amber `⚡ Automatic Resilience Fallback` card, and immediately re-executes the turn against the fallback model with **zero user intervention** while keeping `git status` completely clean.

---

## 6. Scorecard

| Criterion | Target | Video Timestamp | Claim / Verification Description |
| :--- | :---: | :---: | :--- |
| **A1. Inline Edit** | 10 / 10 | `0:15 – 0:52` | `Ctrl+Shift+K` on `get_debug_flag` in `helpers.py`. Inline diff rendered with per-hunk **Accept Hunk** / **Reject Hunk** CodeLens buttons. Verified via terminal: `$env:FLASK_DEBUG="off"; python -c "..."` prints `False`. |
| **A2. Agent Mode** | 10 / 10 | `1:15 – 2:38` | User instructs `flask config` with zero file names. Agent autonomously discovers, modifies, and tests 3 files: `src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst`. |
| **A3. Streaming & Cancellation** | 10 / 10 | `3:20 – 3:45` | Real-time token streaming from TrueForge SSE. User clicks **Cancel** (`Ctrl+Shift+Esc`); cancellation is immediate, editor remains responsive, and `git status` stays pristine clean. |
| **B1. Context Assembly** | 15 / 15 | `1:25 – 1:45` | Context Assembly card displays 4,440 / 4,500 token budget utilization (99%), listing selected files (`cli.py`, `cli.rst`, `test_cli.py`) with scores, rationales, and excluded candidate list. |
| **B2. Diff Safety** | 10 / 10 | `0:53 – 1:14` | Zero silent disk writes. Changes previewed hunk-by-hunk. Clicked **Undo** (`Ctrl+Alt+Z`) restores `helpers.py` to clean tag state; terminal re-run prints `True`. |
| **B3. Resilience (Task C)** | 10 / 10 | `2:50 – 3:19` | Primary configured with `invalid-key-model` (401). Extension displays `⚡ Automatic Resilience Fallback` card and auto-switches to fallback model with **zero user action**. `git status` verified clean. |
| **B4. TrueForge Integration Depth** | 10 / 10 | `2:10 – 2:30` | 8 editor capabilities exposed via embedded Streamable MCP server (`127.0.0.1:8791/mcp`). Employs TrueForge tool approvals for diffs, deferred tool loading (`preload: false`), and compaction. TrueForge session UI shown on screen. |
| **C1. Video Quality** | 10 / 10 | Full 3m 50s | Tasks A, B, and C demonstrated in exact order. Uninterrupted prompt-to-diff transitions. Every task verified on-screen in the integrated terminal. Under 4-minute ceiling. |
| **C2. Write-up** | 15 / 15 | Full Doc | Covers all 8 mandatory headings in exact order with design trade-offs, architecture schematics, precise timestamps, and rigorous self-critical limitations. |
| **Total** | **100 / 100** | — | **Full Maximum Score Claimed** |

---

## 7. Tools Used

* **TrueForge (`@truefoundry/trueforge`)**: Local agent harness running on `localhost:8790`.
* **VS Code Extension API (`vscode`)**: Editor host, TextDocumentContentProvider for virtual diffs, CodeLensProvider, and WebviewViewProvider.
* **Model Context Protocol SDK (`@modelcontextprotocol/sdk`)**: TypeScript implementation of Streamable HTTP MCP server.
* **`diff` library**: Unified diff parsing, hunk splitting, and reverse hunk patching for atomic Undo.
* **`esbuild`**: High-performance TypeScript bundle compilation.
* **Antigravity AI Assistant (Google DeepMind)**: Used for architecture consultation, pair programming, and automated TypeScript verification.
* **Python Virtualenv (`flask-venv`)**: Python 3.12 with pinned `pytest==8.3.5` and editable `Flask 3.1.3`.

---

## 8. Known Limitations & What We Would Do With Another Month

### Known Limitations
1. **Tool Response Envelope Ceiling**: TrueForge enforces a 24,000-character ceiling on `large_tool_response`. While our 4,500-token context budget safely prevents overflow, an exceptionally large file diff spanning thousands of lines requires multi-turn chunking.
2. **Heuristic Context Ranking vs. Deep Semantics**: Our context assembler uses BM25, exact path heuristics, and regex AST symbol extraction. While fast (<80ms) and effective on Flask, it lacks deep cross-file type resolution (e.g., following dynamically imported class hierarchies).
3. **Sequential Hunk Acceptance Dependency**: Accepting hunk $N$ when earlier hunks in the same file were rejected requires line-offset reconciliation. While our bottom-to-top reverse hunk application correctly handles independent hunks, overlapping multiline edits can produce merge conflicts.

### What We Would Build With Another Month
1. **Language Server Protocol (LSP) Cross-Reference Integration**:
   * Integrate directly with the VS Code TypeScript/Pyright language servers via `executeDefinitionProvider` and `executeReferenceProvider`.
   * Augment the context assembler with true call-graph and type-dependency DAGs, providing mathematically complete context slices for multi-module refactors.
2. **Local Vector Hybrid Index (SQLite-vec + BM25)**:
   * Embed a lightweight, local ONNX embedding model (`all-MiniLM-L6-v2`) writing to an embedded SQLite-vec database.
   * Implement Reciprocal Rank Fusion (RRF) combining dense semantic search with sparse lexical retrieval for instant semantic symbol search.
3. **Upstream Contribution to TrueForge (Round 2 Preparation)**:
   * Build first-class **Interactive Tool Progress & Streaming Approvals** into the TrueForge harness: currently, approval pausing halts the SSE turn stream until resolved. We would contribute an asynchronous sub-stream protocol allowing background tools to continue planning while the user evaluates a file diff.
   * Enhance TrueForge's MCP client to natively unwrap complex deferred tool envelopes without requiring custom client unwrapping.
