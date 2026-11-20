import * as vscode from 'vscode';
import * as path from 'path';
import { TrueForgeClient, ParsedToolCall } from './trueforgeClient.js';
import { DiffReviewManager } from './diffReviewManager.js';

export interface InlineEditHooks {
  onStatusUpdate?: (status: string) => void;
  onStreamDelta?: (text: string) => void;
  onFallback?: (info: { primaryModel: string; fallbackModel: string; errorMessage: string }) => void;
  onSessionStarted?: (sessionId: string, modelName: string) => void;
  onInlineEditFinished?: (summary: string) => void;
}

export class InlineEditController {
  constructor(
    private readonly client: TrueForgeClient,
    private readonly diffReviewManager: DiffReviewManager,
    private readonly getWorkspaceRoot: () => string | undefined,
    private readonly extensionRoot: string,
    private readonly hooks: InlineEditHooks = {}
  ) {}

  public async triggerInlineEdit(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('TrueForge: Open a file and select code to use Inline Edit.');
      return;
    }

    const root = this.getWorkspaceRoot();
    if (!root) {
      vscode.window.showWarningMessage('TrueForge: Open a workspace folder first.');
      return;
    }

    const selection = editor.selection;
    const document = editor.document;
    const relativePath = path.relative(root, document.uri.fsPath).replace(/\\/g, '/');

    // If user didn't drag a selection, default to current line or enclosing block
    const effectiveRange = selection.isEmpty
      ? document.lineAt(selection.active.line).range
      : new vscode.Range(selection.start, selection.end);

    const startLine = effectiveRange.start.line + 1;
    const endLine = effectiveRange.end.line + 1;
    const selectedCode = document.getText(effectiveRange);

    const instruction = await vscode.window.showInputBox({
      title: `Blueprint Inline Edit — ${relativePath} (L${startLine}–L${endLine})`,
      prompt: 'Enter your edit instruction in plain language (runs through TrueForge agent harness)',
      placeHolder: `e.g. Treat 'off' and 'n' as false as well, case-insensitively, and update the docstring`,
      ignoreFocusOut: true,
    });

    if (!instruction || !instruction.trim()) {
      return;
    }

    const cfg = vscode.workspace.getConfiguration('trueforge');
    const primaryModel = cfg.get<string>('primaryModel', 'google-gemini/gemini-3-5-flash-lite');
    const fallbackModel = cfg.get<string>('fallbackModel', 'google-gemini/gemini-3-1-flash-lite');
    const autoFallback = cfg.get<boolean>('autoFallback', true);

    // Grab a bit of surrounding context (15 lines before & after) so the diff snippet is unique and exact
    const ctxStart = Math.max(0, effectiveRange.start.line - 15);
    const ctxEnd = Math.min(document.lineCount - 1, effectiveRange.end.line + 15);
    const surroundingLines: string[] = [];
    for (let i = ctxStart; i <= ctxEnd; i++) {
      surroundingLines.push(`${i + 1}: ${document.lineAt(i).text}`);
    }

    const prompt = [
      `[INLINE EDIT]`,
      `Target file: ${relativePath}`,
      `Selected line range: ${startLine}-${endLine}`,
      `User instruction: ${instruction.trim()}`,
      ``,
      `Selected code verbatim:`,
      '```',
      selectedCode,
      '```',
      ``,
      `Surrounding lines for exact context:`,
      '```',
      surroundingLines.join('\n'),
      '```',
      ``,
      `Instructions: Apply ONLY the requested change to ${relativePath} using a single \`propose_edit\` call with exact \`edits\` (\`old_text\` copied verbatim from the selected code -> \`new_text\`). Do not modify unrelated functions. Do not run commands.`,
    ].join('\n');

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Blueprint Inline Edit (${primaryModel})`,
        cancellable: true,
      },
      async (progress, cancelToken) => {
        cancelToken.onCancellationRequested(async () => {
          this.diffReviewManager.cancelAllPendingReviews('Cancelled from progress notification');
          await this.client.cancelActiveTurn();
          vscode.window.showInformationMessage('Blueprint: Inline edit cancelled. Workspace unchanged.');
        });

        progress.report({ message: 'Streaming from TrueForge...' });
        this.hooks.onStatusUpdate?.(`Inline edit on ${relativePath} via ${primaryModel}...`);

        const outcome = await this.client.runTurnWithResilience({
          primaryModel,
          fallbackModel,
          autoFallback,
          prompt,
          extensionRoot: this.extensionRoot,
          callbacks: {
            onSessionReady: (sessionId, modelName) => {
              this.hooks.onSessionStarted?.(sessionId, modelName);
            },
            onTextDelta: (delta) => {
              this.hooks.onStreamDelta?.(delta);
            },
            onToolCall: (tc) => {
              progress.report({ message: `Agent calling ${tc.name}...` });
            },
            onFallback: (info) => {
              progress.report({
                message: `Primary failed — auto-falling back to ${info.fallbackModel}...`,
              });
              vscode.window.showWarningMessage(
                `TrueForge Resilience: Primary model (${info.primaryModel}) failed (${info.errorMessage.slice(
                  0,
                  100
                )}). Automatically switched to fallback model: ${info.fallbackModel}. Workspace unchanged.`
              );
              this.hooks.onFallback?.(info);
            },
            onRetry: (info) => {
              progress.report({ message: `Retrying after ${info.delayMs}ms...` });
            },
            onApprovalRequired: async (sessionId, turnId, threadId, toolCall: ParsedToolCall) => {
              if (toolCall.name === 'propose_edit') {
                progress.report({ message: 'Diff ready — review hunks in editor...' });
                const decision = await this.diffReviewManager.openHunkReview({
                  toolCallId: toolCall.id,
                  sessionId,
                  turnId,
                  threadId,
                  workspaceRoot: root,
                  relativePath: toolCall.arguments.path || relativePath,
                  rationale: toolCall.arguments.rationale || instruction,
                  edits: toolCall.arguments.edits,
                  newContent: toolCall.arguments.new_content,
                });

                if (decision.approved) {
                  return { status: 'allow' as const };
                }
                return {
                  status: 'deny' as const,
                  reason: decision.reason || 'User rejected diff in VS Code.',
                };
              }

              // Inline edit should never silently run terminal commands
              return { status: 'deny' as const, reason: 'Command execution is disabled during inline edit.' };
            },
          },
        });

        if (outcome.status === 'cancelled') {
          this.hooks.onInlineEditFinished?.('Inline edit cancelled (workspace clean).');
        } else if (outcome.status === 'error') {
          vscode.window.showErrorMessage(
            `TrueForge Inline Edit failed (workspace unchanged): ${outcome.errorMessage}`
          );
          this.hooks.onInlineEditFinished?.(`Error: ${outcome.errorMessage}`);
        } else {
          const fallbackNote = outcome.fallbackTriggered
            ? ` (auto-fallback to ${outcome.modelUsed})`
            : '';
          this.hooks.onInlineEditFinished?.(
            `Inline edit completed via ${outcome.modelUsed}${fallbackNote}.`
          );
        }
      }
    );
  }
}
