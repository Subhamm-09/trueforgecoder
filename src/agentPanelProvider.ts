import * as vscode from 'vscode';
import { TrueForgeClient, TrueForgeModelInfo, ParsedToolCall } from './trueforgeClient.js';
import { DiffReviewManager } from './diffReviewManager.js';
import {
  ContextSelectionReport,
  indexWorkspaceSymbols,
  listWorkspaceFiles,
  parseMentions,
  assembleWorkspaceContext,
} from './contextAssembler.js';

interface PendingCommandApproval {
  id: string;
  command: string;
  resolve: (decision: { status: 'allow' } | { status: 'deny'; reason?: string }) => void;
}

export class AgentPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'trueforge.agentPanel';

  private view?: vscode.WebviewView;
  private currentSessionId: string | null = null;
  private lastTurnId: string | undefined;
  private isRunning = false;
  private pendingCommandApprovals = new Map<string, PendingCommandApproval>();
  private lastContextReport: ContextSelectionReport | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly extensionRoot: string,
    private readonly client: TrueForgeClient,
    private readonly diffReviewManager: DiffReviewManager,
    private readonly getWorkspaceRoot: () => string | undefined
  ) {
    this.diffReviewManager.onStateChange(() => {
      this.pushDiffAndUndoState();
    });
  }

  public getCurrentSessionId(): string | null {
    return this.currentSessionId || this.client.getActiveSessionId();
  }

  public postContextReport(report: ContextSelectionReport) {
    this.lastContextReport = report;
    this.postMessage({ type: 'contextReport', report });
  }

  public postExternalEvent(event: Record<string, any>) {
    this.postMessage(event);
  }

  private postMessage(msg: any) {
    this.view?.webview.postMessage(msg);
  }

  public async refreshModelsAndStatus() {
    const connected = await this.client.checkHealth();
    let models: TrueForgeModelInfo[] = [];
    if (connected) {
      try {
        models = await this.client.listModels();
      } catch {
        models = [];
      }
    }
    const cfg = vscode.workspace.getConfiguration('trueforge');
    this.postMessage({
      type: 'initState',
      connected,
      serverUrl: cfg.get<string>('serverUrl', 'http://localhost:8790'),
      primaryModel: cfg.get<string>('primaryModel', 'google-gemini/gemini-3-5-flash-lite'),
      fallbackModel: cfg.get<string>('fallbackModel', 'google-gemini/gemini-3-1-flash-lite'),
      autoFallback: cfg.get<boolean>('autoFallback', true),
      tokenBudget: cfg.get<number>('contextTokenBudget', 4500),
      models: models.map((m) => m.name),
      sessionId: this.currentSessionId,
      undoCount: this.diffReviewManager.getUndoStack().length,
      lastUndoFile: this.diffReviewManager.getUndoStack().slice(-1)[0]?.relativePath || null,
    });
    this.pushDiffAndUndoState();
  }

  private pushDiffAndUndoState() {
    const reviews = this.diffReviewManager.getPendingReviews().map((r) => ({
      reviewId: r.reviewId,
      relativePath: r.relativePath,
      rationale: r.rationale,
      hunks: r.hunks.map((h) => ({
        index: h.index,
        oldStart: h.oldStart,
        oldLines: h.oldLines,
        newStart: h.newStart,
        newLines: h.newLines,
        status: h.status,
        lines: h.lines,
      })),
    }));
    const undoStack = this.diffReviewManager.getUndoStack();
    this.postMessage({
      type: 'diffState',
      reviews,
      undoCount: undoStack.length,
      lastUndoFile: undoStack.length > 0 ? undoStack[undoStack.length - 1].relativePath : null,
    });
  }

  public resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready': {
          await this.refreshModelsAndStatus();
          if (this.lastContextReport) {
            this.postMessage({ type: 'contextReport', report: this.lastContextReport });
          }
          break;
        }
        case 'refreshModels': {
          await this.refreshModelsAndStatus();
          break;
        }
        case 'setModels': {
          const cfg = vscode.workspace.getConfiguration('trueforge');
          if (typeof msg.primaryModel === 'string') {
            await cfg.update('primaryModel', msg.primaryModel, vscode.ConfigurationTarget.Global);
          }
          if (typeof msg.fallbackModel === 'string') {
            await cfg.update('fallbackModel', msg.fallbackModel, vscode.ConfigurationTarget.Global);
          }
          if (typeof msg.autoFallback === 'boolean') {
            await cfg.update('autoFallback', msg.autoFallback, vscode.ConfigurationTarget.Global);
          }
          // Start a fresh session when model changes so TrueForge uses the new model
          this.currentSessionId = null;
          this.lastTurnId = undefined;
          break;
        }
        case 'newSession': {
          this.currentSessionId = null;
          this.lastTurnId = undefined;
          this.lastContextReport = null;
          this.postMessage({ type: 'sessionReset' });
          break;
        }
        case 'openTrueForgeSession': {
          const sid = this.getCurrentSessionId();
          const url = sid
            ? this.client.getSessionUrl(sid)
            : vscode.workspace.getConfiguration('trueforge').get<string>('serverUrl', 'http://localhost:8790');
          vscode.env.openExternal(vscode.Uri.parse(url));
          break;
        }
        case 'queryMentions': {
          const root = this.getWorkspaceRoot();
          if (!root) {
            this.postMessage({ type: 'mentionResults', items: [] });
            return;
          }
          const q = String(msg.query || '').toLowerCase();
          const files = listWorkspaceFiles(root, 400)
            .filter((f) => !q || f.toLowerCase().includes(q))
            .slice(0, 12)
            .map((f) => ({ kind: 'file', label: f, insert: `@${f}` }));
          const symbols = indexWorkspaceSymbols(root, 150)
            .filter((s) => !q || s.name.toLowerCase().includes(q))
            .slice(0, 10)
            .map((s) => ({
              kind: 'symbol',
              label: `${s.name} (${s.relativePath}:${s.line})`,
              insert: `@symbol:${s.name}`,
            }));
          this.postMessage({ type: 'mentionResults', items: [...files, ...symbols].slice(0, 16) });
          break;
        }
        case 'sendPrompt': {
          await this.handleUserPrompt(String(msg.prompt || ''));
          break;
        }
        case 'cancel': {
          await this.cancelCurrentRun();
          break;
        }
        case 'undoLastEdit': {
          await this.diffReviewManager.undoLastEdit();
          break;
        }
        case 'acceptHunk': {
          await this.diffReviewManager.setHunkDecision(msg.reviewId, msg.hunkIndex, 'accepted');
          break;
        }
        case 'rejectHunk': {
          await this.diffReviewManager.setHunkDecision(msg.reviewId, msg.hunkIndex, 'rejected');
          break;
        }
        case 'acceptAllHunks': {
          await this.diffReviewManager.acceptAllHunks(msg.reviewId);
          break;
        }
        case 'rejectAllHunks': {
          await this.diffReviewManager.rejectAllHunks(msg.reviewId);
          break;
        }
        case 'commandApprovalDecision': {
          const pending = this.pendingCommandApprovals.get(msg.id);
          if (pending) {
            this.pendingCommandApprovals.delete(msg.id);
            pending.resolve(
              msg.allow
                ? { status: 'allow' }
                : { status: 'deny', reason: 'User denied terminal command in VS Code.' }
            );
            this.postMessage({ type: 'commandApprovalResolved', id: msg.id, allowed: Boolean(msg.allow) });
          }
          break;
        }
      }
    });
  }

  public async cancelCurrentRun() {
    this.diffReviewManager.cancelAllPendingReviews('Cancelled by user');
    for (const [id, pending] of this.pendingCommandApprovals.entries()) {
      pending.resolve({ status: 'deny', reason: 'Cancelled by user' });
      this.postMessage({ type: 'commandApprovalResolved', id, allowed: false });
    }
    this.pendingCommandApprovals.clear();
    await this.client.cancelActiveTurn();
    this.isRunning = false;
    this.postMessage({
      type: 'runFinished',
      status: 'cancelled',
      message: 'Generation cancelled immediately. Workspace is clean and consistent.',
    });
  }

  private async handleUserPrompt(rawPrompt: string) {
    const prompt = rawPrompt.trim();
    if (!prompt || this.isRunning) {
      return;
    }

    const root = this.getWorkspaceRoot();
    if (!root) {
      this.postMessage({
        type: 'errorBanner',
        message: 'No workspace folder is open in VS Code. Open a repository (e.g. Flask 3.1.3) first.',
      });
      return;
    }

    const cfg = vscode.workspace.getConfiguration('trueforge');
    const primaryModel = cfg.get<string>('primaryModel', 'google-gemini/gemini-3-5-flash-lite');
    const fallbackModel = cfg.get<string>('fallbackModel', 'google-gemini/gemini-3-1-flash-lite');
    const autoFallback = cfg.get<boolean>('autoFallback', true);
    const tokenBudget = cfg.get<number>('contextTokenBudget', 4500);

    this.isRunning = true;
    this.postMessage({ type: 'runStarted', prompt, model: primaryModel });

    // Resolve any explicit @file / @symbol mentions upfront and include them cleanly
    const mentions = parseMentions(prompt);
    let augmentedPrompt = prompt;
    if (mentions.fileMentions.length > 0 || mentions.symbolMentions.length > 0) {
      const explicitReport = assembleWorkspaceContext(
        root,
        prompt,
        tokenBudget,
        mentions.fileMentions,
        mentions.symbolMentions
      );
      this.postContextReport(explicitReport);
      const explicitContextText = explicitReport.selected
        .filter((s) => s.explicit)
        .map((s) => `### Explicit Mention: ${s.relativePath}\n\`\`\`\n${s.excerpt}\n\`\`\``)
        .join('\n\n');
      if (explicitContextText) {
        augmentedPrompt = `${prompt}\n\n[Attached @mentions within ${tokenBudget}-token budget]\n${explicitContextText}`;
      }
    }

    const outcome = await this.client.runTurnWithResilience({
      primaryModel,
      fallbackModel,
      autoFallback,
      prompt: augmentedPrompt,
      existingSessionId: this.currentSessionId ?? undefined,
      previousTurnId: this.lastTurnId,
      extensionRoot: this.extensionRoot,
      callbacks: {
        onSessionReady: (sessionId, modelName) => {
          this.currentSessionId = sessionId;
          this.postMessage({
            type: 'sessionReady',
            sessionId,
            modelName,
            sessionUrl: this.client.getSessionUrl(sessionId),
          });
        },
        onTextDelta: (delta) => {
          this.postMessage({ type: 'textDelta', delta });
        },
        onReasoningDelta: (delta) => {
          this.postMessage({ type: 'reasoningDelta', delta });
        },
        onToolCall: (toolCall: ParsedToolCall, threadId: string) => {
          this.postMessage({
            type: 'toolCall',
            id: toolCall.id,
            name: toolCall.name,
            args: toolCall.arguments,
            threadId,
          });
        },
        onToolResponse: (toolCallId, name, output, isError) => {
          this.postMessage({
            type: 'toolResponse',
            toolCallId,
            name,
            output: output.slice(0, 1200),
            isError,
          });
        },
        onSubAgentEvent: (threadId, status, detail) => {
          this.postMessage({ type: 'subAgent', threadId, status, detail });
        },
        onCompactionEvent: (status) => {
          this.postMessage({ type: 'compaction', status });
        },
        onFallback: (info) => {
          this.postMessage({ type: 'fallbackNotice', ...info });
          vscode.window.showWarningMessage(
            `TrueForge Auto-Fallback: Primary (${info.primaryModel}) failed. Switched automatically to ${info.fallbackModel}.`
          );
        },
        onRetry: (info) => {
          this.postMessage({ type: 'retryNotice', ...info });
        },
        onApprovalRequired: async (sessionId, turnId, threadId, toolCall: ParsedToolCall) => {
          if (toolCall.name === 'propose_edit') {
            this.postMessage({
              type: 'statusBanner',
              message: `TrueForge paused for human diff review: ${toolCall.arguments.path || '(file)'}`,
            });

            const decision = await this.diffReviewManager.openHunkReview({
              toolCallId: toolCall.id,
              sessionId,
              turnId,
              threadId,
              workspaceRoot: root,
              relativePath: toolCall.arguments.path || '',
              rationale: toolCall.arguments.rationale || 'Proposed change by TrueForge agent',
              edits: toolCall.arguments.edits,
              newContent: toolCall.arguments.new_content,
            });

            if (decision.approved) {
              return { status: 'allow' as const };
            }
            return {
              status: 'deny' as const,
              reason: decision.reason || 'User rejected diff hunks in VS Code.',
            };
          }

          if (toolCall.name === 'run_command') {
            const cmd = String(toolCall.arguments.command || '');
            return new Promise((resolve) => {
              this.pendingCommandApprovals.set(toolCall.id, {
                id: toolCall.id,
                command: cmd,
                resolve,
              });
              this.postMessage({
                type: 'commandApprovalRequired',
                id: toolCall.id,
                command: cmd,
              });
            });
          }

          // Any other unknown gated tool: ask user explicitly via quick modal
          const choice = await vscode.window.showInformationMessage(
            `TrueForge requests approval to run tool "${toolCall.name}"`,
            { modal: false },
            'Allow',
            'Deny'
          );
          return choice === 'Allow'
            ? { status: 'allow' as const }
            : { status: 'deny' as const, reason: 'User denied tool call.' };
        },
      },
    });

    this.isRunning = false;
    if (outcome.sessionId) {
      this.currentSessionId = outcome.sessionId;
    }
    if (outcome.turnId && outcome.status === 'done') {
      this.lastTurnId = outcome.turnId;
    }

    this.postMessage({
      type: 'runFinished',
      status: outcome.status,
      modelUsed: outcome.modelUsed,
      fallbackTriggered: outcome.fallbackTriggered,
      errorMessage: outcome.errorMessage,
      sessionId: outcome.sessionId,
    });
  }

  private getHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root {
    --bg: var(--vscode-sideBar-background, #18181b);
    --fg: var(--vscode-foreground, #e4e4e7);
    --muted: var(--vscode-descriptionForeground, #a1a1aa);
    --border: var(--vscode-panel-border, rgba(255, 255, 255, 0.08));
    --card: var(--vscode-editor-background, #1e1e20);
    --card-hover: rgba(255, 255, 255, 0.04);
    --accent: var(--vscode-button-background, #2563eb);
    --accent-hover: var(--vscode-button-hoverBackground, #1d4ed8);
    --accent-fg: var(--vscode-button-foreground, #ffffff);
    --green: #22c55e;
    --green-bg: rgba(34, 197, 94, 0.14);
    --green-border: rgba(34, 197, 94, 0.35);
    --red: #ef4444;
    --red-bg: rgba(239, 68, 68, 0.14);
    --red-border: rgba(239, 68, 68, 0.35);
    --amber: #f59e0b;
    --amber-bg: rgba(245, 158, 11, 0.14);
    --purple: #a855f7;
    --font-code: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0;
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
    font-size: 12.5px;
    color: var(--fg);
    background: var(--bg);
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }
  /* Header & Model Bar */
  .header {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--card);
    backdrop-filter: blur(10px);
  }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 6px; flex-wrap: wrap; }
  .badge {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 11px; font-weight: 500; padding: 3px 8px; border-radius: 99px;
    background: rgba(255, 255, 255, 0.05); border: 1px solid var(--border);
  }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--red); box-shadow: 0 0 6px var(--red); }
  .dot.ok { background: var(--green); box-shadow: 0 0 6px var(--green); }
  .btn {
    border: 1px solid var(--border);
    background: rgba(255, 255, 255, 0.06);
    color: var(--fg);
    padding: 3px 9px;
    border-radius: 5px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
    display: inline-flex; align-items: center; gap: 4px;
  }
  .btn:hover { background: rgba(255, 255, 255, 0.12); }
  .btn.primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; }
  .btn.primary:hover { background: var(--accent-hover); }
  .btn.danger { background: var(--red-bg); border-color: var(--red-border); color: #fca5a5; }
  .btn.danger:hover { background: rgba(239, 68, 68, 0.25); }
  .btn.success { background: var(--green-bg); border-color: var(--green-border); color: #86efac; }
  .btn.success:hover { background: rgba(34, 197, 94, 0.25); }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .model-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }
  .field label { display: block; font-size: 10px; font-weight: 500; color: var(--muted); margin-bottom: 3px; text-transform: uppercase; letter-spacing: 0.4px; }
  select {
    width: 100%;
    background: rgba(0, 0, 0, 0.25);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 4px 6px;
    font-size: 11px;
    outline: none;
    cursor: pointer;
  }
  select:focus { border-color: var(--accent); }
  /* Feed & Chat Bubbles */
  .feed {
    flex: 1;
    overflow-y: auto;
    padding: 12px 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .feed::-webkit-scrollbar { width: 6px; }
  .feed::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.15); border-radius: 4px; }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  }
  .card.user {
    border-left: 3px solid var(--accent);
    background: rgba(37, 99, 235, 0.08);
  }
  .card.assistant {
    border-left: 3px solid var(--green);
  }
  .card.context {
    border-left: 3px solid var(--purple);
    background: rgba(168, 85, 247, 0.06);
  }
  .card.fallback {
    border-left: 3px solid var(--amber);
    background: var(--amber-bg);
  }
  .card.error {
    border-left: 3px solid var(--red);
    background: var(--red-bg);
  }
  .card.approval {
    border: 1px solid var(--amber-border, rgba(245, 158, 11, 0.4));
    background: rgba(245, 158, 11, 0.08);
  }
  .card-title {
    font-weight: 600; font-size: 11.5px; margin-bottom: 6px;
    display: flex; justify-content: space-between; align-items: center;
  }
  .model-pill {
    font-size: 10px; font-weight: 400; padding: 1px 6px; border-radius: 4px;
    background: rgba(255, 255, 255, 0.07); color: var(--muted); font-family: var(--font-code);
  }
  /* Context Assembly Meter */
  .budget-bar {
    height: 6px; background: rgba(255, 255, 255, 0.08); border-radius: 99px; overflow: hidden; margin: 4px 0 8px;
  }
  .budget-fill { height: 100%; background: linear-gradient(90deg, #a855f7, #3b82f6); border-radius: 99px; }
  .ctx-item {
    padding: 6px 8px; border-radius: 6px; background: rgba(255, 255, 255, 0.04);
    margin-bottom: 5px; font-size: 11px; border: 1px solid rgba(255, 255, 255, 0.05);
  }
  .ctx-path { font-family: var(--font-code); font-weight: 600; color: #93c5fd; }
  .ctx-why { color: var(--muted); font-size: 10.5px; margin-top: 3px; line-height: 1.35; }
  /* Collapsible Tool Step Timeline */
  .tools-area {
    display: flex; flex-direction: column; gap: 4px; margin-bottom: 6px;
  }
  .tool-chip {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 11px; padding: 3px 8px; border-radius: 5px;
    background: rgba(255, 255, 255, 0.06); font-family: var(--font-code);
    border: 1px solid var(--border); color: #cbd5e1;
    width: fit-content; max-width: 100%;
  }
  .reasoning-box {
    font-size: 11px; color: var(--muted); white-space: pre-wrap; font-family: var(--font-code);
    background: rgba(0, 0, 0, 0.35); padding: 7px 10px; border-radius: 6px; margin-bottom: 8px;
    max-height: 140px; overflow-y: auto; border: 1px solid var(--border); line-height: 1.4;
  }
  /* Rendered Markdown Styling */
  .markdown-body {
    font-size: 12.5px; line-height: 1.55; word-break: break-word; color: #f4f4f5;
  }
  .markdown-body p { margin: 0 0 8px 0; }
  .markdown-body p:last-child { margin-bottom: 0; }
  .markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4 {
    margin: 10px 0 4px 0; font-weight: 600; color: #ffffff;
  }
  .markdown-body h1 { font-size: 14px; }
  .markdown-body h2 { font-size: 13.5px; }
  .markdown-body h3 { font-size: 13px; }
  .markdown-body h4 { font-size: 12.5px; }
  .markdown-body ul, .markdown-body ol { margin: 4px 0 8px 18px; padding: 0; }
  .markdown-body li { margin-bottom: 3px; }
  .markdown-body strong { font-weight: 600; color: #ffffff; }
  .inline-code {
    font-family: var(--font-code); font-size: 11.5px; padding: 2px 5px; border-radius: 4px;
    background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.1);
    color: #fca5a5;
  }
  .code-container {
    margin: 8px 0; border-radius: 6px; overflow: hidden;
    border: 1px solid var(--border); background: #0f0f11;
  }
  .code-head {
    display: flex; justify-content: space-between; align-items: center;
    background: rgba(255, 255, 255, 0.05); padding: 4px 8px;
    font-size: 10.5px; font-family: var(--font-code); color: var(--muted);
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  }
  .copy-code-btn {
    background: transparent; border: none; color: var(--muted); cursor: pointer;
    font-size: 10.5px; padding: 2px 5px; border-radius: 3px;
  }
  .copy-code-btn:hover { background: rgba(255, 255, 255, 0.1); color: var(--fg); }
  .code-pre {
    margin: 0; padding: 8px 10px; font-family: var(--font-code); font-size: 11.5px;
    overflow-x: auto; line-height: 1.45; color: #e2e8f0;
  }
  .blinking-cursor {
    display: inline-block; width: 6px; height: 13px; background: var(--accent);
    margin-left: 2px; vertical-align: middle; animation: blink 0.9s infinite;
  }
  @keyframes blink { 0%, 50% { opacity: 1; } 50.1%, 100% { opacity: 0; } }
  /* Diff Hunks & Reviews */
  .hunk-box {
    border: 1px solid var(--border); border-radius: 6px; margin-top: 6px; overflow: hidden; background: #0c0c0e;
  }
  .hunk-head {
    background: rgba(255, 255, 255, 0.05); padding: 5px 8px;
    display: flex; justify-content: space-between; align-items: center; font-size: 11px;
    border-bottom: 1px solid var(--border);
  }
  .diff-pre {
    margin: 0; padding: 6px 8px; font-family: var(--font-code); font-size: 11px;
    overflow-x: auto; max-height: 200px; overflow-y: auto; line-height: 1.4;
  }
  .d-add { background: rgba(34, 197, 94, 0.22); color: #86efac; display: block; }
  .d-del { background: rgba(239, 68, 68, 0.22); color: #fca5a5; display: block; }
  .d-ctx { opacity: 0.75; display: block; }
  /* Floating Composer */
  .composer {
    border-top: 1px solid var(--border);
    padding: 10px 12px;
    background: var(--card);
    position: relative;
    box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.25);
  }
  .mentions-popup {
    position: absolute; bottom: 100%; left: 12px; right: 12px;
    background: #18181b; border: 1px solid var(--border);
    border-radius: 7px; max-height: 180px; overflow-y: auto;
    display: none; z-index: 20; box-shadow: 0 -6px 20px rgba(0, 0, 0, 0.4);
  }
  .mention-row {
    padding: 6px 9px; cursor: pointer; font-size: 11.5px; display: flex; align-items: center; gap: 7px;
  }
  .mention-row:hover { background: rgba(37, 99, 235, 0.25); }
  .mention-tag { font-size: 9px; text-transform: uppercase; font-weight: 600; padding: 2px 5px; border-radius: 4px; background: rgba(255, 255, 255, 0.1); }
  .input-wrapper {
    position: relative; border: 1px solid var(--border); border-radius: 7px;
    background: rgba(0, 0, 0, 0.3); transition: border-color 0.15s ease;
  }
  .input-wrapper:focus-within { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  textarea {
    width: 100%; min-height: 64px; max-height: 150px; resize: none;
    background: transparent; color: var(--fg);
    border: none; outline: none; padding: 8px 10px; font-family: var(--vscode-font-family); font-size: 12px;
    line-height: 1.45;
  }
  .composer-footer {
    display: flex; justify-content: space-between; align-items: center; padding: 4px 8px 6px;
  }
  .hint { font-size: 10.5px; color: var(--muted); }
</style>
</head>
<body>
  <div class="header">
    <div class="row">
      <span class="badge"><span id="statusDot" class="dot"></span><span id="statusText">Connecting...</span></span>
      <div class="row">
        <button id="undoBtn" class="btn" disabled title="Undo last applied edit (Ctrl+Alt+Z)">↺ Undo (0)</button>
        <button id="sessionBtn" class="btn" title="Open live session in TrueForge UI">Session ↗</button>
        <button id="newBtn" class="btn" title="Start new TrueForge session">+ New</button>
      </div>
    </div>
    <div class="model-grid">
      <div class="field">
        <label>Primary Model</label>
        <select id="primarySelect"></select>
      </div>
      <div class="field">
        <label>Auto-Fallback Model</label>
        <select id="fallbackSelect"></select>
      </div>
    </div>
  </div>

  <div id="feed" class="feed">
    <div class="card">
      <div class="card-title">✦ TrueForge Coder Ready</div>
      <div class="markdown-body" style="color:var(--muted)">
        <p>• Type any multi-file instruction below (Agent Mode) — <strong>no file names needed</strong>.</p>
        <p>• Type <code>@</code> to search &amp; attach specific <strong>@file</strong> or <strong>@symbol</strong> targets.</p>
        <p>• Highlight code and press <strong>Ctrl+Shift+K</strong> for Inline Edit.</p>
        <p>• Every edit pauses for <strong>per-hunk diff review</strong> before touching disk.</p>
      </div>
    </div>
  </div>

  <div id="pendingContainer" style="padding: 0 12px 6px; display:none; max-height: 38vh; overflow-y:auto;"></div>

  <div class="composer">
    <div id="mentionsPopup" class="mentions-popup"></div>
    <div class="input-wrapper">
      <textarea id="promptInput" placeholder="Ask TrueForge Coder to add a feature, refactor, or type @file / @symbol..."></textarea>
      <div class="composer-footer">
        <span class="hint">↵ send · Shift+↵ newline</span>
        <div class="row">
          <button id="cancelBtn" class="btn danger" style="display:none">■ Cancel</button>
          <button id="sendBtn" class="btn primary">Run Agent ↵</button>
        </div>
      </div>
    </div>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  const feed = document.getElementById('feed');
  const pendingContainer = document.getElementById('pendingContainer');
  const promptInput = document.getElementById('promptInput');
  const sendBtn = document.getElementById('sendBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const undoBtn = document.getElementById('undoBtn');
  const sessionBtn = document.getElementById('sessionBtn');
  const newBtn = document.getElementById('newBtn');
  const primarySelect = document.getElementById('primarySelect');
  const fallbackSelect = document.getElementById('fallbackSelect');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const mentionsPopup = document.getElementById('mentionsPopup');

  let currentAssistantCard = null;
  let currentAssistantRawText = '';
  let currentTextEl = null;
  let currentReasoningEl = null;
  let currentToolsEl = null;
  let isRunning = false;
  let activeMentionStart = -1;

  function esc(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  /* Client-side Markdown Renderer */
  function renderMarkdown(md) {
    if (!md) return '';
    let text = esc(md);

    // Code blocks with syntax container & copy button
    text = text.replace(/\`\`\`([a-zA-Z0-9_-]+)?\\r?\\n([\\s\\S]*?)\`\`\`/g, (match, lang, code) => {
      const language = lang || 'text';
      const cleanCode = code.replace(/\\n$/, '');
      const rawAttr = cleanCode.replace(/"/g, '&quot;');
      return '<div class="code-container">' +
        '<div class="code-head"><span>' + language + '</span><button class="copy-code-btn" data-code="' + rawAttr + '">Copy</button></div>' +
        '<pre class="code-pre"><code>' + cleanCode + '</code></pre>' +
      '</div>';
    });

    // Inline code
    text = text.replace(/\`([^\`]+)\`/g, '<code class="inline-code">$1</code>');

    // Bold & italic
    text = text.replace(/\\*\\*([^\\*]+)\\*\\*/g, '<strong>$1</strong>');
    text = text.replace(/\\*([^\\*]+)\\*/g, '<em>$1</em>');

    // Headings
    text = text.replace(/^####\\s+(.*)$/gm, '<h4>$1</h4>');
    text = text.replace(/^###\\s+(.*)$/gm, '<h3>$1</h3>');
    text = text.replace(/^##\\s+(.*)$/gm, '<h2>$1</h2>');
    text = text.replace(/^#\\s+(.*)$/gm, '<h2>$1</h2>');

    // Bullet lists
    text = text.replace(/^[-*]\\s+(.*)$/gm, '<li>$1</li>');
    text = text.replace(/(<li>[\\s\\S]*?<\\/li>)/g, '<ul>$1</ul>');
    text = text.replace(/<\\/ul>\\s*<ul>/g, '');

    // Paragraph breaks
    text = text.replace(/\\n\\n+/g, '</p><p>');
    text = text.replace(/\\n/g, '<br/>');

    return '<p>' + text + '</p>';
  }

  function scrollBottom() {
    feed.scrollTop = feed.scrollHeight;
  }

  function setRunning(running) {
    isRunning = running;
    sendBtn.disabled = running;
    cancelBtn.style.display = running ? 'inline-block' : 'none';
    if (!running && currentTextEl) {
      // Remove cursor
      const cursor = currentTextEl.querySelector('.blinking-cursor');
      if (cursor) cursor.remove();
    }
  }

  function ensureAssistantCard(modelLabel) {
    if (!currentAssistantCard) {
      currentAssistantRawText = '';
      currentAssistantCard = document.createElement('div');
      currentAssistantCard.className = 'card assistant';
      currentAssistantCard.innerHTML =
        '<div class="card-title"><span>✦ TrueForge Agent</span><span class="model-pill">' + esc(modelLabel || '') + '</span></div>' +
        '<div class="tools-area"></div>' +
        '<details style="display:none;margin-bottom:6px"><summary style="cursor:pointer;font-size:11px;color:var(--muted);font-weight:500">▾ Reasoning Stream</summary><div class="reasoning-box"></div></details>' +
        '<div class="markdown-body"></div>';
      feed.appendChild(currentAssistantCard);
      currentToolsEl = currentAssistantCard.querySelector('.tools-area');
      currentReasoningEl = currentAssistantCard.querySelector('.reasoning-box');
      currentTextEl = currentAssistantCard.querySelector('.markdown-body');
    }
    return currentAssistantCard;
  }

  function updateAssistantText(delta) {
    ensureAssistantCard();
    currentAssistantRawText += delta;
    currentTextEl.innerHTML = renderMarkdown(currentAssistantRawText) + (isRunning ? '<span class="blinking-cursor"></span>' : '');
    scrollBottom();
  }

  function renderContextReport(report) {
    const pct = Math.min(100, Math.round((report.tokensUsed / Math.max(1, report.tokenBudget)) * 100));
    const card = document.createElement('div');
    card.className = 'card context';
    let html = '<div class="card-title"><span>Context Assembly (Budget-Capped)</span><span class="model-pill">' +
      report.tokensUsed + ' / ' + report.tokenBudget + ' tok (' + pct + '%)</span></div>';
    html += '<div class="budget-bar"><div class="budget-fill" style="width:' + pct + '%"></div></div>';
    html += '<div style="font-size:10.5px;color:var(--muted);margin-bottom:6px">Scanned ' + report.totalFilesScanned + ' files · Selected ' + report.selected.length + ' targets:</div>';
    for (const item of report.selected) {
      html += '<div class="ctx-item">' +
        '<div><span class="ctx-path">📄 ' + esc(item.relativePath) + '</span> <span class="model-pill">score ' + item.score + ' · ~' + item.estimatedTokens + ' tok</span></div>' +
        '<div class="ctx-why"><b>Why:</b> ' + esc(item.reason) + '</div>' +
      '</div>';
    }
    if (report.excludedByBudget && report.excludedByBudget.length > 0) {
      html += '<div style="font-size:10px;color:var(--muted);margin-top:5px">Excluded by budget (' + report.excludedByBudget.length + '): ' +
        report.excludedByBudget.map(e => esc(e.relativePath)).join(', ') + '</div>';
    }
    card.innerHTML = html;
    feed.appendChild(card);
    scrollBottom();
  }

  function renderPendingReviews(reviews) {
    if (!reviews || reviews.length === 0) {
      pendingContainer.style.display = 'none';
      pendingContainer.innerHTML = '';
      return;
    }
    pendingContainer.style.display = 'block';
    let html = '';
    for (const rev of reviews) {
      const totalHunks = rev.hunks.length;
      html += '<div class="card approval" style="margin-bottom:8px">' +
        '<div class="card-title"><span>📄 Diff Review: ' + esc(rev.relativePath) + '</span>' +
        '<div class="row">' +
          '<button class="btn success" data-action="acceptAll" data-review-id="' + esc(rev.reviewId) + '">✓ Accept All (' + totalHunks + ')</button>' +
          '<button class="btn danger" data-action="rejectAll" data-review-id="' + esc(rev.reviewId) + '">✕ Reject All</button>' +
        '</div></div>' +
        '<div style="font-size:11px;color:var(--muted);margin-bottom:6px">' + esc(rev.rationale) + '</div>';
      for (const h of rev.hunks) {
        const badge = h.status === 'accepted' ? '✓ Accepted' : h.status === 'rejected' ? '✕ Rejected' : 'Pending';
        html += '<div class="hunk-box">' +
          '<div class="hunk-head"><span>Hunk ' + (h.index + 1) + ' of ' + totalHunks + ' (L' + h.oldStart + ') · <b>' + badge + '</b></span>' +
          '<div class="row">' +
            '<button class="btn success" data-action="acceptHunk" data-review-id="' + esc(rev.reviewId) + '" data-hunk="' + h.index + '">✓ Accept</button>' +
            '<button class="btn danger" data-action="rejectHunk" data-review-id="' + esc(rev.reviewId) + '" data-hunk="' + h.index + '">✕ Reject</button>' +
          '</div></div>' +
          '<pre class="diff-pre">' + h.lines.map(l => {
            const cls = l.startsWith('+') ? 'd-add' : l.startsWith('-') ? 'd-del' : 'd-ctx';
            return '<span class="' + cls + '">' + esc(l) + '</span>';
          }).join('') + '</pre></div>';
      }
      html += '</div>';
    }
    pendingContainer.innerHTML = html;
  }

  /* Delegated clicks for diff buttons, command approvals, and code copy */
  document.addEventListener('click', (e) => {
    // Copy code button
    const copyBtn = e.target.closest ? e.target.closest('.copy-code-btn') : null;
    if (copyBtn) {
      const code = copyBtn.getAttribute('data-code') || '';
      navigator.clipboard.writeText(code).then(() => {
        const old = copyBtn.textContent;
        copyBtn.textContent = '✓ Copied!';
        setTimeout(() => { copyBtn.textContent = old; }, 1500);
      });
      return;
    }

    const btn = e.target.closest ? e.target.closest('button[data-action]') : null;
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    const reviewId = btn.getAttribute('data-review-id');
    const hunk = Number(btn.getAttribute('data-hunk'));
    const cmdId = btn.getAttribute('data-cmd-id');
    if (action === 'acceptHunk') vscode.postMessage({ type: 'acceptHunk', reviewId, hunkIndex: hunk });
    else if (action === 'rejectHunk') vscode.postMessage({ type: 'rejectHunk', reviewId, hunkIndex: hunk });
    else if (action === 'acceptAll') vscode.postMessage({ type: 'acceptAllHunks', reviewId });
    else if (action === 'rejectAll') vscode.postMessage({ type: 'rejectAllHunks', reviewId });
    else if (action === 'allowCmd') vscode.postMessage({ type: 'commandApprovalDecision', id: cmdId, allow: true });
    else if (action === 'denyCmd') vscode.postMessage({ type: 'commandApprovalDecision', id: cmdId, allow: false });
  });

  function populateSelect(el, models, currentValue, allowEmpty) {
    el.innerHTML = '';
    if (allowEmpty) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '(Disabled)';
      el.appendChild(opt);
    }
    const list = [...models];
    if (currentValue && !list.includes(currentValue)) {
      list.unshift(currentValue);
    }
    for (const m of list) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      if (m === currentValue) opt.selected = true;
      el.appendChild(opt);
    }
  }

  primarySelect.addEventListener('change', () => {
    vscode.postMessage({ type: 'setModels', primaryModel: primarySelect.value });
  });
  fallbackSelect.addEventListener('change', () => {
    vscode.postMessage({
      type: 'setModels',
      fallbackModel: fallbackSelect.value,
      autoFallback: fallbackSelect.value !== '',
    });
  });

  sendBtn.addEventListener('click', () => {
    const text = promptInput.value.trim();
    if (!text || isRunning) return;
    promptInput.value = '';
    mentionsPopup.style.display = 'none';
    vscode.postMessage({ type: 'sendPrompt', prompt: text });
  });

  cancelBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'cancel' });
  });

  undoBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'undoLastEdit' });
  });

  sessionBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'openTrueForgeSession' });
  });

  newBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'newSession' });
  });

  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendBtn.click();
    } else if (e.key === 'Escape') {
      mentionsPopup.style.display = 'none';
    }
  });

  promptInput.addEventListener('input', () => {
    const pos = promptInput.selectionStart;
    const before = promptInput.value.slice(0, pos);
    const match = before.match(/@([A-Za-z0-9_./:-]*)$/);
    if (match) {
      activeMentionStart = pos - match[0].length;
      vscode.postMessage({ type: 'queryMentions', query: match[1] });
    } else {
      activeMentionStart = -1;
      mentionsPopup.style.display = 'none';
    }
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'initState': {
        statusDot.className = 'dot' + (msg.connected ? ' ok' : '');
        statusText.textContent = msg.connected ? 'TrueForge Online' : 'TrueForge Offline';
        populateSelect(primarySelect, msg.models || [], msg.primaryModel, false);
        populateSelect(fallbackSelect, msg.models || [], msg.autoFallback ? msg.fallbackModel : '', true);
        undoBtn.textContent = '↺ Undo (' + (msg.undoCount || 0) + ')';
        undoBtn.disabled = !(msg.undoCount > 0);
        if (msg.lastUndoFile) undoBtn.title = 'Undo last applied edit: ' + msg.lastUndoFile;
        break;
      }
      case 'diffState': {
        renderPendingReviews(msg.reviews);
        undoBtn.textContent = '↺ Undo (' + (msg.undoCount || 0) + ')';
        undoBtn.disabled = !(msg.undoCount > 0);
        if (msg.lastUndoFile) undoBtn.title = 'Undo last applied edit: ' + msg.lastUndoFile;
        break;
      }
      case 'sessionReset': {
        feed.innerHTML = '<div class="card"><div class="card-title">✦ New TrueForge Session</div><div style="color:var(--muted)">Ready for your next instruction.</div></div>';
        currentAssistantCard = null;
        currentAssistantRawText = '';
        break;
      }
      case 'mentionResults': {
        if (!msg.items || msg.items.length === 0 || activeMentionStart < 0) {
          mentionsPopup.style.display = 'none';
          return;
        }
        mentionsPopup.innerHTML = msg.items.map((it, idx) =>
          '<div class="mention-row" data-insert="' + esc(it.insert) + '"><span class="mention-tag">' + esc(it.kind) + '</span><span>' + esc(it.label) + '</span></div>'
        ).join('');
        mentionsPopup.querySelectorAll('.mention-row').forEach(row => {
          row.addEventListener('click', () => {
            const ins = row.getAttribute('data-insert') + ' ';
            const pos = promptInput.selectionStart;
            const val = promptInput.value;
            promptInput.value = val.slice(0, activeMentionStart) + ins + val.slice(pos);
            mentionsPopup.style.display = 'none';
            promptInput.focus();
          });
        });
        mentionsPopup.style.display = 'block';
        break;
      }
      case 'runStarted': {
        setRunning(true);
        currentAssistantCard = null;
        currentAssistantRawText = '';
        const userCard = document.createElement('div');
        userCard.className = 'card user';
        userCard.innerHTML = '<div class="card-title"><span>👤 You</span><span class="model-pill">' + esc(msg.model) + '</span></div><div class="markdown-body">' + renderMarkdown(msg.prompt) + '</div>';
        feed.appendChild(userCard);
        ensureAssistantCard(msg.model);
        scrollBottom();
        break;
      }
      case 'sessionReady': {
        sessionBtn.title = 'Open TrueForge Session: ' + msg.sessionId;
        break;
      }
      case 'contextReport': {
        renderContextReport(msg.report);
        break;
      }
      case 'textDelta': {
        updateAssistantText(msg.delta);
        break;
      }
      case 'reasoningDelta': {
        ensureAssistantCard();
        const det = currentAssistantCard.querySelector('details');
        if (det) det.style.display = 'block';
        currentReasoningEl.textContent += msg.delta;
        scrollBottom();
        break;
      }
      case 'toolCall': {
        ensureAssistantCard();
        const chip = document.createElement('div');
        chip.className = 'tool-chip';
        const argSummary = msg.args?.path || msg.args?.query || msg.args?.command || '';
        chip.textContent = '⚙ ' + msg.name + (argSummary ? '(' + String(argSummary).slice(0, 50) + ')' : '');
        currentToolsEl.appendChild(chip);
        scrollBottom();
        break;
      }
      case 'subAgent': {
        ensureAssistantCard();
        const chip = document.createElement('div');
        chip.className = 'tool-chip';
        chip.style.borderLeft = '2px solid #a855f7';
        chip.textContent = '🔀 Subagent [' + msg.threadId + '] ' + msg.status;
        currentToolsEl.appendChild(chip);
        scrollBottom();
        break;
      }
      case 'compaction': {
        ensureAssistantCard();
        const chip = document.createElement('div');
        chip.className = 'tool-chip';
        chip.textContent = '🗜 TrueForge Compaction: ' + msg.status;
        currentToolsEl.appendChild(chip);
        scrollBottom();
        break;
      }
      case 'fallbackNotice': {
        const card = document.createElement('div');
        card.className = 'card fallback';
        card.innerHTML = '<div class="card-title">⚡ Automatic Resilience Fallback</div>' +
          '<div class="markdown-body">Primary model <b>' + esc(msg.primaryModel) + '</b> failed:<br/>' +
          '<code class="inline-code" style="font-size:10px">' + esc(msg.errorMessage) + '</code><br/><br/>' +
          'Automatically switched to fallback model <b>' + esc(msg.fallbackModel) + '</b> with zero user action. Workspace unchanged.</div>';
        feed.appendChild(card);
        currentAssistantCard = null;
        currentAssistantRawText = '';
        ensureAssistantCard(msg.fallbackModel + ' (fallback)');
        scrollBottom();
        break;
      }
      case 'retryNotice': {
        const card = document.createElement('div');
        card.className = 'card fallback';
        card.innerHTML = '<div class="card-title">↻ Retrying with backoff (' + msg.delayMs + 'ms)</div><div class="markdown-body">' + esc(msg.errorMessage) + '</div>';
        feed.appendChild(card);
        scrollBottom();
        break;
      }
      case 'commandApprovalRequired': {
        pendingContainer.style.display = 'block';
        const card = document.createElement('div');
        card.className = 'card approval';
        card.id = 'cmd-' + msg.id;
        card.style.marginBottom = '6px';
        card.innerHTML = '<div class="card-title"><span>Terminal Approval Required</span></div>' +
          '<pre class="diff-pre" style="background:#09090b;border-radius:5px;margin-bottom:6px;color:#38bdf8">$ ' + esc(msg.command) + '</pre>' +
          '<div class="row">' +
            '<button class="btn success" data-action="allowCmd" data-cmd-id="' + esc(msg.id) + '">✓ Run Command</button>' +
            '<button class="btn danger" data-action="denyCmd" data-cmd-id="' + esc(msg.id) + '">✕ Deny</button>' +
          '</div>';
        pendingContainer.appendChild(card);
        break;
      }
      case 'commandApprovalResolved': {
        const card = document.getElementById('cmd-' + msg.id);
        if (card) {
          card.remove();
          if (pendingContainer.children.length === 0) {
            pendingContainer.style.display = 'none';
          }
        }
        const logCard = document.createElement('div');
        logCard.className = 'card';
        logCard.innerHTML = '<div class="card-title" style="margin:0">Terminal Command ' + (msg.allowed ? '✓ Approved' : '✕ Denied') + '</div>';
        feed.appendChild(logCard);
        scrollBottom();
        break;
      }
      case 'errorBanner': {
        const card = document.createElement('div');
        card.className = 'card error';
        card.innerHTML = '<div class="card-title">Error</div><div class="markdown-body">' + esc(msg.message) + '</div>';
        feed.appendChild(card);
        scrollBottom();
        break;
      }
      case 'runFinished': {
        setRunning(false);
        if (msg.status === 'cancelled') {
          const card = document.createElement('div');
          card.className = 'card fallback';
          card.innerHTML = '<div class="card-title">■ Run Cancelled</div><div class="markdown-body">' + esc(msg.message || 'Cancelled immediately. Workspace consistent.') + '</div>';
          feed.appendChild(card);
        } else if (msg.status === 'error') {
          const card = document.createElement('div');
          card.className = 'card error';
          card.innerHTML = '<div class="card-title">Run Failed (Workspace Unchanged)</div><div class="markdown-body">' + esc(msg.errorMessage || 'Unknown error') + '</div>';
          feed.appendChild(card);
        }
        currentAssistantCard = null;
        currentAssistantRawText = '';
        scrollBottom();
        break;
      }
      case 'inlineEditLog': {
        const card = document.createElement('div');
        card.className = 'card ' + (msg.kind || 'assistant');
        card.innerHTML = '<div class="card-title">Inline Edit</div><div class="markdown-body">' + esc(msg.message) + '</div>';
        feed.appendChild(card);
        scrollBottom();
        break;
      }
    }
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
