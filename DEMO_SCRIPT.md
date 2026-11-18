# TrueForge Coder — Demo Video Recording Script
**Competition:** Techfest 2026–27 (IIT Bombay) · TrueFoundry Forge-a-thon  
**Team:** Blue.io (Bandita Priyadarshini & Subham Srinibas Panda)  
**Maximum Duration Ceiling:** 4 minutes (Target Runtime: 3 minutes 45 seconds)  
**Deliverable Format:** Public link (YouTube Unlisted or Google Drive "anyone with the link can view")  

---

## Recording Rules & Guidelines from Problem Statement
1. **Screen Layout:** Keep VS Code visible with the integrated terminal open at the bottom and the TrueForge Coder sidebar panel open on the left.
2. **Order of Tasks:** Tasks **A**, **B**, and **C** in exact chronological order, each followed immediately by on-screen terminal verification.
3. **TrueForge Session UI:** Must be shown briefly during Task B (switch to browser `http://localhost:8790`).
4. **Cutting Rule:** You **may** cut out or fast-forward model waiting time; you **MUST NOT** cut between giving an instruction and the diff appearing.
5. **Resolution:** 1080p (1920x1080) at 30 or 60 fps. Ensure editor text and terminal output are crisp and legible.

---

## Detailed Second-by-Second Timeline

### 0:00 – 0:15 | Intro & Baseline Setup
* **Screen:** VS Code open on `d:\Trueforge\flask` (Flask 3.1.3 tag). Left panel: TrueForge Coder. Bottom panel: PowerShell terminal.
* **Action:**
  1. In terminal, run:
     ```powershell
     git status
     ```
     *(Shows: `HEAD detached at 3.1.3`, `nothing to commit, working tree clean`)*
  2. Point cursor to TrueForge Coder sidebar showing status: `● TrueForge Online (localhost:8790)`.

---

### 0:15 – 0:52 | Task A: Inline Edit (`src/flask/helpers.py`)
* **Screen:** Open `src/flask/helpers.py` in editor.
* **Action:**
  1. Highlight lines 28–34 (`def get_debug_flag() -> bool:` and its body).
  2. Press `Ctrl+Shift+K` to open the TrueForge Inline Edit quickpick.
  3. Paste the exact prompt:
     ```text
     Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.
     ```
  4. Press **Enter**.
  5. *(DO NOT CUT)* The inline diff review appears in the editor showing:
     * CodeLens actions: `Accept Hunk 1 of 1` | `Reject Hunk 1 of 1`
     * Green additions showing `'off'`, `'n'` added to the falsy set, and updated docstring.
  6. Click `Accept Hunk 1 of 1`. The file updates on disk.
* **On-Screen Terminal Verification (Mandatory):**
  ```powershell
  $env:FLASK_DEBUG="off"; python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
  ```
  *Output displayed:* `False` *(Passes Task A verification!)*

---

### 0:53 – 1:14 | Diff Safety & Working Undo Demonstration (Rubric Anchor B2)
* **Screen:** `src/flask/helpers.py` still open with the newly accepted changes.
* **Action:**
  1. Click the **Undo (1)** button in the TrueForge Coder sidebar toolbar (or press `Ctrl+Alt+Z`).
  2. Notice `src/flask/helpers.py` instantly reverts back to its original 3.1.3 state on screen.
  3. In terminal, run the exact same verification command:
     ```powershell
     $env:FLASK_DEBUG="off"; python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
     ```
     *Output displayed:* `True` *(Proves working undo of an applied change; full diff safety verified!)*
  4. Clean the workspace for Task B:
     ```powershell
     git checkout -- .
     ```

---

### 1:15 – 2:38 | Task B: Agent Mode (Multi-File Discovery + TrueForge Session)
* **Screen:** TrueForge Coder Agent Panel in sidebar. No files mentioned in prompt.
* **Action:**
  1. Paste the exact Task B prompt into the agent input box:
     ```text
     Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.
     ```
  2. Click **Run Agent**.
  3. *(DO NOT CUT)* Watch the **Context Assembly Card** illuminate:
     * Shows progress bar: `4440 / 4500 tok Capped (99%)`
     * Autonomously ranks and selects:
       * `#1 src/flask/cli.py` (Score 125.4 — core Click command implementation)
       * `#2 docs/cli.rst` (Score 114.8 — official CLI documentation)
       * `#3 tests/test_cli.py` (Score 110.6 — dedicated CLI test suite)
       * `#4 tests/test_json.py` (Score 71.1)
     * Lists files excluded by token budget.
  4. The tool execution loop streams live:
     * `assemble_context`
     * `read_file`
     * `call_tool: propose_edit (vscode-editor)`
  5. The interactive diff review cards appear for approval:
     * Click **Accept** on `src/flask/cli.py` diff
     * Click **Accept** on `tests/test_cli.py` diff
     * Click **Accept** on `docs/cli.rst` diff
* **Show TrueForge Session in Browser (Mandatory):**
  1. Switch to Google Chrome window at `http://localhost:8790/sessions/<session-id>`.
  2. Show the active session with the turn sequence, preloaded and deferred tool calls (`call_tool: propose_edit (vscode-editor)`), and SSE event log. *(Matches Screenshot 1)*.
  3. Switch back to VS Code.
* **On-Screen Terminal Verification (Mandatory):**
  1. Run the test suite:
     ```powershell
     pytest tests/test_cli.py -q
     ```
     *Output:* `56 passed, 3 skipped in 0.39s` *(All tests pass!)*
  2. Verify command in `flask --help`:
     ```powershell
     flask --help
     ```
     *Output shows:* `config  Show the loaded application's configuration as JSON.`
  3. Run the new command against test app to verify masked JSON:
     ```powershell
     flask --app tests/test_apps/cliapp/app.py config
     ```
     *Output shows:* Valid JSON with masked keys, e.g. `"SECRET_KEY": "***"`.
  4. Verify multi-file span:
     ```powershell
     git status --short
     ```
     *Output:* 3 files modified unprompted:
     ```text
      M docs/cli.rst
      M src/flask/cli.py
      M tests/test_cli.py
     ```
  5. Reset workspace:
     ```powershell
     git checkout -- .
     ```

---

### 2:39 – 3:19 | Task C: Resilience & Zero-Action Model Fallback (Rubric Anchor B3)
* **Screen:** VS Code editor with TrueForge Coder sidebar.
* **Action:**
  1. In the sidebar header, change the **Primary Model** dropdown to:
     `invalid-primary/invalid-key-model`
     *(Auto-Fallback Model is configured to `google-gemini/gemini-3-5-flash-lite`)*
  2. Select `get_debug_flag` in `src/flask/helpers.py`.
  3. Press `Ctrl+Shift+K` and enter the Task A instruction:
     ```text
     Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.
     ```
  4. Press **Enter**.
  5. The primary model triggers an immediate 401 error.
  6. The sidebar immediately renders the amber banner:
     ```text
     ⚡ Automatic Resilience Fallback
     Primary model invalid-primary/invalid-key-model failed:
     [Model Error] Request failed (401): Incorrect API key provided.

     Automatically switched to fallback model google-gemini/gemini-3-5-flash-lite with zero user action. Workspace unchanged.
     ```
  7. The editor remains completely responsive and smooth.
  8. The fallback model streams the proposed diff with zero user clicks.
* **On-Screen Verification (Mandatory):**
  1. In terminal, verify workspace remained untouched while model failed:
     ```powershell
     git status
     ```
     *Output:* `nothing to commit, working tree clean` *(Zero files changed during failure!)*

---

### 3:20 – 3:45 | Streaming & Instant Cancellation (Rubric Anchor A3)
* **Screen:** TrueForge Coder Agent Panel.
* **Action:**
  1. Type a general query in the prompt box: `Refactor all request context teardown hooks across the entire repository`.
  2. Click **Run Agent**.
  3. Tokens begin streaming live via Server-Sent Events into the webview.
  4. Click the red **■ Cancel** button in the sidebar (or press `Ctrl+Shift+Esc`).
  5. Cancellation is instantaneous:
     * Streaming stops immediately.
     * TrueForge issues `POST /api/v1/sessions/{id}/cancel`.
     * The input box and editor remain fully responsive with zero freeze.
* **On-Screen Verification:**
  ```powershell
  git status
  ```
  *Output:* `nothing to commit, working tree clean` *(No half-applied edits, zero workspace corruption!)*

---

### 3:45 – 3:55 | Conclusion & Submission Sign-Off
* **Action:**
  * Bring up the TrueForge Coder status: all criteria A1–A3, B1–B4 verified live.
  * Concluding caption: **Team Blue.io · IIT Bombay Techfest 2026–27 · 100/100 Points Anchor Coverage**.

---

## Pre-Recording Checklist
- [ ] TrueForge running in PowerShell window 1: `start-trueforge.bat`
- [ ] Pinned `pallets/flask` repository at tag `3.1.3` in clean state (`git checkout -- .`)
- [ ] Virtual environment activated with `pytest==8.3.5` and `flask` installed editable
- [ ] Screen recording software (OBS Studio / GeForce Experience) configured to 1080p 60fps
- [ ] Browser window open in background to `http://localhost:8790`
- [ ] Extension launched in Extension Development Host (`F5` or `code --extensionDevelopmentPath=...`)
