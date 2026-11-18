import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as Diff from 'diff';

export type HunkStatus = 'pending' | 'accepted' | 'rejected';

export interface DiffHunk {
  index: number;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[]; // lines prefixed with ' ', '-', '+'
  status: HunkStatus;
  previewHeaderLine: number; // 0-based line index in virtual preview document
}

export interface PendingFileReview {
  reviewId: string;
  toolCallId: string;
  sessionId: string;
  turnId: string;
  threadId: string;
  filePath: string; // absolute path
  relativePath: string;
  rationale: string;
  existedBefore: boolean;
  originalContent: string;
  proposedContent: string;
  hunks: DiffHunk[];
  previewUri: vscode.Uri;
  previewContent: string;
  removedLineIndices: number[];
  addedLineIndices: number[];
  acceptedLineIndices: number[];
  rejectedLineIndices: number[];
  resolveDecision: (decision: ReviewDecision) => void;
}

export interface ReviewDecision {
  approved: boolean;
  acceptedCount: number;
  rejectedCount: number;
  finalContent: string;
  reason?: string;
}

export interface UndoEntry {
  id: string;
  filePath: string;
  relativePath: string;
  existedBefore: boolean;
  previousContent: string;
  appliedContent: string;
  rationale: string;
  timestamp: string;
}

export interface EditOperation {
  old_text: string;
  new_text: string;
}

export function applyEditOperations(
  originalContent: string,
  edits?: EditOperation[],
  newContent?: string
): { content: string; error?: string } {
  if (typeof newContent === 'string' && (!edits || edits.length === 0)) {
    return { content: newContent };
  }
  if (!edits || edits.length === 0) {
    return { content: originalContent, error: 'Neither edits nor new_content provided.' };
  }

  // Normalize CRLF -> LF internally while remembering original EOL
  const hasCrlf = originalContent.includes('\r\n');
  let working = originalContent.replace(/\r\n/g, '\n');

  for (let i = 0; i < edits.length; i++) {
    const oldNorm = edits[i].old_text.replace(/\r\n/g, '\n');
    const newNorm = edits[i].new_text.replace(/\r\n/g, '\n');

    if (oldNorm === '') {
      working = working + (working.endsWith('\n') || working === '' ? '' : '\n') + newNorm;
      continue;
    }

    const idx = working.indexOf(oldNorm);
    if (idx !== -1) {
      working = working.slice(0, idx) + newNorm + working.slice(idx + oldNorm.length);
      continue;
    }

    // Fallback: line-trimmed fuzzy match so minor trailing whitespace doesn't break edits
    const workingLines = working.split('\n');
    const oldLines = oldNorm.split('\n');
    let matchStart = -1;
    for (let lineIdx = 0; lineIdx <= workingLines.length - oldLines.length; lineIdx++) {
      let ok = true;
      for (let j = 0; j < oldLines.length; j++) {
        if (workingLines[lineIdx + j].trimEnd() !== oldLines[j].trimEnd()) {
          ok = false;
          break;
        }
      }
      if (ok) {
        matchStart = lineIdx;
        break;
      }
    }

    if (matchStart !== -1) {
      const replacementLines = newNorm.split('\n');
      workingLines.splice(matchStart, oldLines.length, ...replacementLines);
      working = workingLines.join('\n');
      continue;
    }

    return {
      content: originalContent,
      error: `Edit #${i + 1} failed: could not locate old_text snippet in file. Call read_file first to copy exact lines.`,
    };
  }

  const finalText = hasCrlf ? working.replace(/\n/g, '\r\n') : working;
  return { content: finalText };
}

export function buildContentFromApprovedHunks(originalContent: string, hunks: DiffHunk[]): string {
  const hasCrlf = originalContent.includes('\r\n');
  const origLines = originalContent.replace(/\r\n/g, '\n').split('\n');
  // Apply accepted hunks from bottom to top so earlier line numbers remain exact
  const acceptedHunks = [...hunks]
    .filter((h) => h.status === 'accepted')
    .sort((a, b) => b.oldStart - a.oldStart);

  for (const hunk of acceptedHunks) {
    // Reconstruct the exact replacement lines for this hunk
    const replacement: string[] = [];
    for (const rawLine of hunk.lines) {
      if (rawLine.startsWith('+')) {
        replacement.push(rawLine.slice(1));
      } else if (rawLine.startsWith(' ')) {
        replacement.push(rawLine.slice(1));
      }
      // '-' lines are removed
    }
    const startIdx = Math.max(0, hunk.oldStart - 1);
    const deleteCount = hunk.oldLines;
    if (hunk.oldStart === 0 && origLines.length === 1 && origLines[0] === '') {
      origLines.splice(0, 1, ...replacement);
    } else {
      origLines.splice(startIdx, deleteCount, ...replacement);
    }
  }

  const joined = origLines.join('\n');
  return hasCrlf ? joined.replace(/\n/g, '\r\n') : joined;
}

export class DiffReviewManager
  implements vscode.TextDocumentContentProvider, vscode.CodeLensProvider, vscode.Disposable
{
  public static readonly SCHEME = 'trueforge-review';

  private readonly _onDidChangeDoc = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this._onDidChangeDoc.event;

  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  private readonly _onStateChange = new vscode.EventEmitter<void>();
  public readonly onStateChange = this._onStateChange.event;

  private reviews = new Map<string, PendingFileReview>();
  private approvedContentByPath = new Map<string, { finalContent: string; rationale: string; acceptedCount: number; rejectedCount: number }>();
  private undoStack: UndoEntry[] = [];
  private reviewCounter = 0;

  private readonly removedDecoration: vscode.TextEditorDecorationType;
  private readonly addedDecoration: vscode.TextEditorDecorationType;
  private readonly acceptedDecoration: vscode.TextEditorDecorationType;
  private readonly rejectedDecoration: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.removedDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(248, 81, 73, 0.22)',
      isWholeLine: true,
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
      borderColor: 'rgba(248, 81, 73, 0.9)',
      overviewRulerColor: 'rgba(248, 81, 73, 0.8)',
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

    this.addedDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(46, 160, 67, 0.24)',
      isWholeLine: true,
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
      borderColor: 'rgba(63, 185, 80, 0.95)',
      overviewRulerColor: 'rgba(46, 160, 67, 0.8)',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });

    this.acceptedDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(35, 134, 54, 0.16)',
      isWholeLine: true,
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
      borderColor: '#3fb950',
    });

    this.rejectedDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(139, 148, 158, 0.12)',
      opacity: '0.55',
      isWholeLine: true,
      textDecoration: 'line-through',
    });

    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(DiffReviewManager.SCHEME, this),
      vscode.languages.registerCodeLensProvider({ scheme: DiffReviewManager.SCHEME }, this),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && editor.document.uri.scheme === DiffReviewManager.SCHEME) {
          this.applyDecorationsToEditor(editor);
        }
      }),
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const editor of editors) {
          if (editor.document.uri.scheme === DiffReviewManager.SCHEME) {
            this.applyDecorationsToEditor(editor);
          }
        }
      })
    );
  }

  public getPendingReviews(): PendingFileReview[] {
    return Array.from(this.reviews.values());
  }

  public getUndoStack(): UndoEntry[] {
    return [...this.undoStack];
  }

  public consumeApprovedEdit(filePath: string) {
    const key = path.resolve(filePath).toLowerCase();
    const entry = this.approvedContentByPath.get(key);
    if (entry) {
      this.approvedContentByPath.delete(key);
    }
    return entry;
  }

  public cancelAllPendingReviews(reason = 'Cancelled by user') {
    for (const review of this.reviews.values()) {
      review.resolveDecision({
        approved: false,
        acceptedCount: 0,
        rejectedCount: review.hunks.length,
        finalContent: review.originalContent,
        reason,
      });
    }
    this.reviews.clear();
    this.approvedContentByPath.clear();
    this._onDidChangeCodeLenses.fire();
    this._onStateChange.fire();
  }

  public async openHunkReview(params: {
    toolCallId: string;
    sessionId: string;
    turnId: string;
    threadId: string;
    workspaceRoot: string;
    relativePath: string;
    rationale: string;
    edits?: EditOperation[];
    newContent?: string;
  }): Promise<ReviewDecision> {
    const absPath = path.resolve(params.workspaceRoot, params.relativePath);
    const existedBefore = fs.existsSync(absPath);
    const originalContent = existedBefore ? fs.readFileSync(absPath, 'utf8') : '';

    const computed = applyEditOperations(originalContent, params.edits, params.newContent);
    if (computed.error) {
      return {
        approved: false,
        acceptedCount: 0,
        rejectedCount: 0,
        finalContent: originalContent,
        reason: computed.error,
      };
    }

    const proposedContent = computed.content;
    const patch = Diff.structuredPatch(
      params.relativePath,
      params.relativePath,
      originalContent.replace(/\r\n/g, '\n'),
      proposedContent.replace(/\r\n/g, '\n'),
      'original',
      'proposed',
      { context: 3 }
    );

    if (patch.hunks.length === 0) {
      return {
        approved: true,
        acceptedCount: 0,
        rejectedCount: 0,
        finalContent: originalContent,
        reason: 'No differences detected.',
      };
    }

    const reviewId = `rev-${++this.reviewCounter}`;
    const hunks: DiffHunk[] = patch.hunks.map((h, idx) => ({
      index: idx,
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      lines: h.lines,
      status: 'pending',
      previewHeaderLine: 0,
    }));

    const previewUri = vscode.Uri.parse(
      `${DiffReviewManager.SCHEME}:/${params.relativePath.replace(/^\/+/, '')}?reviewId=${reviewId}`
    );

    return new Promise<ReviewDecision>(async (resolveDecision) => {
      const review: PendingFileReview = {
        reviewId,
        toolCallId: params.toolCallId,
        sessionId: params.sessionId,
        turnId: params.turnId,
        threadId: params.threadId,
        filePath: absPath,
        relativePath: params.relativePath,
        rationale: params.rationale,
        existedBefore,
        originalContent,
        proposedContent,
        hunks,
        previewUri,
        previewContent: '',
        removedLineIndices: [],
        addedLineIndices: [],
        acceptedLineIndices: [],
        rejectedLineIndices: [],
        resolveDecision,
      };

      this.rebuildPreviewDocument(review);
      this.reviews.set(reviewId, review);
      this._onDidChangeDoc.fire(previewUri);
      this._onDidChangeCodeLenses.fire();
      this._onStateChange.fire();

      try {
        const doc = await vscode.workspace.openTextDocument(previewUri);
        const editor = await vscode.window.showTextDocument(doc, {
          preview: false,
          preserveFocus: false,
          viewColumn: vscode.ViewColumn.Active,
        });
        this.applyDecorationsToEditor(editor);
        // Scroll to the first hunk header
        if (review.hunks.length > 0) {
          const line = review.hunks[0].previewHeaderLine;
          editor.revealRange(new vscode.Range(line, 0, line + 5, 0), vscode.TextEditorRevealType.InCenter);
        }
      } catch (err) {
        console.error('Failed to open diff preview tab:', err);
      }
    });
  }

  private rebuildPreviewDocument(review: PendingFileReview) {
    const outLines: string[] = [];
    const removed: number[] = [];
    const added: number[] = [];
    const accepted: number[] = [];
    const rejected: number[] = [];

    const totalHunks = review.hunks.length;
    const acceptedCount = review.hunks.filter((h) => h.status === 'accepted').length;
    const rejectedCount = review.hunks.filter((h) => h.status === 'rejected').length;

    outLines.push(`# ──────────────────────────────────────────────────────────────────────────────`);
    outLines.push(`# TrueForge Diff Review: ${review.relativePath}`);
    outLines.push(`# Rationale: ${review.rationale}`);
    outLines.push(
      `# Status: ${acceptedCount} accepted, ${rejectedCount} rejected, ${
        totalHunks - acceptedCount - rejectedCount
      } pending of ${totalHunks} hunk(s)  |  NO CHANGES WRITTEN TO DISK YET`
    );
    outLines.push(`# ──────────────────────────────────────────────────────────────────────────────`);
    outLines.push('');

    for (const hunk of review.hunks) {
      hunk.previewHeaderLine = outLines.length;
      const badge =
        hunk.status === 'accepted'
          ? '[✓ ACCEPTED]'
          : hunk.status === 'rejected'
          ? '[✕ REJECTED]'
          : '[PENDING REVIEW]';
      outLines.push(
        `@@ Hunk ${hunk.index + 1} of ${totalHunks} (lines ${hunk.oldStart}-${
          hunk.oldStart + Math.max(0, hunk.oldLines - 1)
        }) ${badge} @@`
      );

      for (const raw of hunk.lines) {
        const lineIdx = outLines.length;
        outLines.push(raw);
        if (hunk.status === 'rejected') {
          rejected.push(lineIdx);
        } else if (hunk.status === 'accepted') {
          if (raw.startsWith('+')) {
            accepted.push(lineIdx);
          } else if (raw.startsWith('-')) {
            rejected.push(lineIdx);
          }
        } else {
          if (raw.startsWith('-')) {
            removed.push(lineIdx);
          } else if (raw.startsWith('+')) {
            added.push(lineIdx);
          }
        }
      }
      outLines.push('');
    }

    review.previewContent = outLines.join('\n');
    review.removedLineIndices = removed;
    review.addedLineIndices = added;
    review.acceptedLineIndices = accepted;
    review.rejectedLineIndices = rejected;
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    const reviewId = new URLSearchParams(uri.query).get('reviewId');
    if (!reviewId) {
      return '';
    }
    const review = this.reviews.get(reviewId);
    return review ? review.previewContent : '// Review completed.';
  }

  public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const reviewId = new URLSearchParams(document.uri.query).get('reviewId');
    if (!reviewId) {
      return [];
    }
    const review = this.reviews.get(reviewId);
    if (!review) {
      return [];
    }

    const lenses: vscode.CodeLens[] = [];

    // Top-of-file global actions
    const topRange = new vscode.Range(0, 0, 0, 0);
    lenses.push(
      new vscode.CodeLens(topRange, {
        title: `$(check-all) Accept All Hunks (${review.hunks.length}) & Apply`,
        command: 'trueforge.acceptAllHunks',
        arguments: [reviewId],
      }),
      new vscode.CodeLens(topRange, {
        title: `$(close-all) Reject All`,
        command: 'trueforge.rejectAllHunks',
        arguments: [reviewId],
      })
    );

    const decidedCount = review.hunks.filter((h) => h.status !== 'pending').length;
    if (decidedCount > 0 && decidedCount < review.hunks.length) {
      lenses.push(
        new vscode.CodeLens(topRange, {
          title: `$(rocket) Apply Accepted Hunks Now`,
          command: 'trueforge.submitReview',
          arguments: [reviewId],
        })
      );
    }

    // Per-hunk accept/reject buttons above EVERY hunk
    for (const hunk of review.hunks) {
      const range = new vscode.Range(hunk.previewHeaderLine, 0, hunk.previewHeaderLine, 0);
      const hunkLabel = `${hunk.index + 1} of ${review.hunks.length}`;
      if (hunk.status === 'pending') {
        lenses.push(
          new vscode.CodeLens(range, {
            title: `$(check) Accept Hunk ${hunkLabel}`,
            command: 'trueforge.acceptHunk',
            arguments: [reviewId, hunk.index],
          }),
          new vscode.CodeLens(range, {
            title: `$(x) Reject Hunk ${hunkLabel}`,
            command: 'trueforge.rejectHunk',
            arguments: [reviewId, hunk.index],
          })
        );
      } else if (hunk.status === 'accepted') {
        lenses.push(
          new vscode.CodeLens(range, {
            title: `$(pass-filled) Hunk ${hunkLabel} Accepted`,
            command: 'trueforge.rejectHunk',
            arguments: [reviewId, hunk.index],
            tooltip: 'Click to change decision to Reject',
          })
        );
      } else {
        lenses.push(
          new vscode.CodeLens(range, {
            title: `$(circle-slash) Hunk ${hunkLabel} Rejected`,
            command: 'trueforge.acceptHunk',
            arguments: [reviewId, hunk.index],
            tooltip: 'Click to change decision to Accept',
          })
        );
      }
    }

    return lenses;
  }

  private applyDecorationsToEditor(editor: vscode.TextEditor) {
    const reviewId = new URLSearchParams(editor.document.uri.query).get('reviewId');
    if (!reviewId) {
      return;
    }
    const review = this.reviews.get(reviewId);
    if (!review) {
      return;
    }
    const toRanges = (indices: number[]) =>
      indices
        .filter((i) => i < editor.document.lineCount)
        .map((i) => new vscode.Range(i, 0, i, editor.document.lineAt(i).text.length));

    editor.setDecorations(this.removedDecoration, toRanges(review.removedLineIndices));
    editor.setDecorations(this.addedDecoration, toRanges(review.addedLineIndices));
    editor.setDecorations(this.acceptedDecoration, toRanges(review.acceptedLineIndices));
    editor.setDecorations(this.rejectedDecoration, toRanges(review.rejectedLineIndices));
  }

  private refreshPreviewEditors(review: PendingFileReview) {
    this.rebuildPreviewDocument(review);
    this._onDidChangeDoc.fire(review.previewUri);
    this._onDidChangeCodeLenses.fire();
    this._onStateChange.fire();

    setTimeout(() => {
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document.uri.toString() === review.previewUri.toString()) {
          this.applyDecorationsToEditor(editor);
        }
      }
    }, 60);
  }

  public async setHunkDecision(reviewId: string, hunkIndex: number, status: 'accepted' | 'rejected') {
    const review = this.reviews.get(reviewId);
    if (!review || !review.hunks[hunkIndex]) {
      return;
    }
    review.hunks[hunkIndex].status = status;
    this.refreshPreviewEditors(review);

    // If all hunks have been decided, finalize automatically!
    if (review.hunks.every((h) => h.status !== 'pending')) {
      await this.finalizeReview(reviewId);
    }
  }

  public async acceptAllHunks(reviewId: string) {
    const review = this.reviews.get(reviewId);
    if (!review) {
      return;
    }
    for (const h of review.hunks) {
      h.status = 'accepted';
    }
    await this.finalizeReview(reviewId);
  }

  public async rejectAllHunks(reviewId: string) {
    const review = this.reviews.get(reviewId);
    if (!review) {
      return;
    }
    for (const h of review.hunks) {
      h.status = 'rejected';
    }
    await this.finalizeReview(reviewId);
  }

  public async finalizeReview(reviewId: string) {
    const review = this.reviews.get(reviewId);
    if (!review) {
      return;
    }

    const acceptedCount = review.hunks.filter((h) => h.status === 'accepted').length;
    const rejectedCount = review.hunks.length - acceptedCount;
    const finalContent =
      acceptedCount > 0 ? buildContentFromApprovedHunks(review.originalContent, review.hunks) : review.originalContent;

    if (acceptedCount > 0) {
      this.approvedContentByPath.set(path.resolve(review.filePath).toLowerCase(), {
        finalContent,
        rationale: review.rationale,
        acceptedCount,
        rejectedCount,
      });
    }

    // Close the virtual preview tab cleanly
    for (const tabGroup of vscode.window.tabGroups.all) {
      for (const tab of tabGroup.tabs) {
        if (
          tab.input instanceof vscode.TabInputText &&
          tab.input.uri.toString() === review.previewUri.toString()
        ) {
          await vscode.window.tabGroups.close(tab);
        }
      }
    }

    this.reviews.delete(reviewId);
    this._onDidChangeCodeLenses.fire();
    this._onStateChange.fire();

    review.resolveDecision({
      approved: acceptedCount > 0,
      acceptedCount,
      rejectedCount,
      finalContent,
      reason:
        acceptedCount === 0
          ? 'User rejected all hunks in VS Code diff review.'
          : undefined,
    });
  }

  /**
   * Called by the MCP `propose_edit` tool ONLY after TrueForge tool approval succeeds.
   * Applies the approved content via VS Code WorkspaceEdit, saves it, and records an Undo entry.
   */
  public async applyApprovedEditToDisk(
    workspaceRoot: string,
    relativePath: string,
    fallbackEdits?: EditOperation[],
    fallbackNewContent?: string,
    rationale = 'TrueForge edit'
  ): Promise<{ applied: boolean; message: string; acceptedCount: number; rejectedCount: number }> {
    const absPath = path.resolve(workspaceRoot, relativePath);
    const key = absPath.toLowerCase();
    const existedBefore = fs.existsSync(absPath);
    const previousContent = existedBefore ? fs.readFileSync(absPath, 'utf8') : '';

    const approved = this.consumeApprovedEdit(absPath);
    let finalContent: string;
    let acceptedCount = 1;
    let rejectedCount = 0;

    if (approved) {
      finalContent = approved.finalContent;
      acceptedCount = approved.acceptedCount;
      rejectedCount = approved.rejectedCount;
      rationale = approved.rationale || rationale;
    } else {
      const computed = applyEditOperations(previousContent, fallbackEdits, fallbackNewContent);
      if (computed.error) {
        return { applied: false, message: computed.error, acceptedCount: 0, rejectedCount: 0 };
      }
      finalContent = computed.content;
    }

    // Ensure parent directory exists for new files
    const dir = path.dirname(absPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const fileUri = vscode.Uri.file(absPath);

    if (!existedBefore) {
      fs.writeFileSync(absPath, finalContent, 'utf8');
      const doc = await vscode.workspace.openTextDocument(fileUri);
      await vscode.window.showTextDocument(doc, { preview: false });
    } else {
      const doc = await vscode.workspace.openTextDocument(fileUri);
      const fullRange = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(doc.getText().length)
      );
      const wsEdit = new vscode.WorkspaceEdit();
      wsEdit.replace(fileUri, fullRange, finalContent);
      await vscode.workspace.applyEdit(wsEdit);
      await doc.save();
      await vscode.window.showTextDocument(doc, { preview: false });
    }

    this.undoStack.push({
      id: `undo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      filePath: absPath,
      relativePath,
      existedBefore,
      previousContent,
      appliedContent: finalContent,
      rationale,
      timestamp: new Date().toISOString(),
    });
    this._onStateChange.fire();

    const summary =
      rejectedCount > 0
        ? `Applied ${acceptedCount} accepted hunk(s) to ${relativePath} (${rejectedCount} hunk(s) rejected by user).`
        : `Applied ${acceptedCount} hunk(s) to ${relativePath}.`;

    return { applied: true, message: summary, acceptedCount, rejectedCount };
  }

  public async undoLastEdit(): Promise<boolean> {
    const last = this.undoStack.pop();
    if (!last) {
      vscode.window.showInformationMessage('TrueForge: No applied edits to undo.');
      return false;
    }

    const fileUri = vscode.Uri.file(last.filePath);

    if (!last.existedBefore) {
      if (fs.existsSync(last.filePath)) {
        fs.unlinkSync(last.filePath);
      }
    } else {
      const doc = await vscode.workspace.openTextDocument(fileUri);
      const fullRange = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(doc.getText().length)
      );
      const wsEdit = new vscode.WorkspaceEdit();
      wsEdit.replace(fileUri, fullRange, last.previousContent);
      await vscode.workspace.applyEdit(wsEdit);
      await doc.save();
      await vscode.window.showTextDocument(doc, { preview: false });
    }

    this._onStateChange.fire();
    vscode.window.showInformationMessage(`TrueForge: Undid applied edit to ${last.relativePath}`);
    return true;
  }

  public dispose() {
    this.removedDecoration.dispose();
    this.addedDecoration.dispose();
    this.acceptedDecoration.dispose();
    this.rejectedDecoration.dispose();
    this._onDidChangeDoc.dispose();
    this._onDidChangeCodeLenses.dispose();
    this._onStateChange.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
