import * as vscode from 'vscode';
import { TrueForgeClient } from './trueforgeClient.js';
import { DiffReviewManager } from './diffReviewManager.js';
import { EditorMcpServer } from './mcpServer.js';
import { AgentPanelProvider } from './agentPanelProvider.js';
import { InlineEditController } from './inlineEditController.js';

export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('TrueForge Coder');
  context.subscriptions.push(output);

  const getWorkspaceRoot = (): string | undefined => {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
  };

  const getServerUrl = (): string =>
    vscode.workspace.getConfiguration('trueforge').get<string>('serverUrl', 'http://localhost:8790');

  const getTokenBudget = (): number =>
    vscode.workspace.getConfiguration('trueforge').get<number>('contextTokenBudget', 4500);

  const mcpPort = vscode.workspace.getConfiguration('trueforge').get<number>('mcpPort', 8791);

  const diffReviewManager = new DiffReviewManager();
  context.subscriptions.push(diffReviewManager);

  const client = new TrueForgeClient(getServerUrl);

  const mcpServer = new EditorMcpServer(
    getWorkspaceRoot,
    diffReviewManager,
    getTokenBudget,
    mcpPort
  );
  context.subscriptions.push(mcpServer);

  const agentPanelProvider = new AgentPanelProvider(
    context.extensionUri,
    context.extensionPath,
    client,
    diffReviewManager,
    getWorkspaceRoot
  );

  // Wire MCP context assembly reports directly into the Agent Panel UI
  context.subscriptions.push(
    mcpServer.onContextReport((report) => {
      output.appendLine(
        `[Context] Selected ${report.selected.length} files (${report.tokensUsed}/${report.tokenBudget} tokens)`
      );
      agentPanelProvider.postContextReport(report);
    }),
    mcpServer.onToolActivity((act) => {
      output.appendLine(`[MCP Tool] ${act.tool}: ${act.summary}`);
      if (act.tool === 'command_result') {
        try {
          const parsed = JSON.parse(act.summary);
          agentPanelProvider.postExternalEvent({
            type: 'terminalOutput',
            command: parsed.command,
            exitCode: parsed.exitCode,
            output: parsed.output,
          });
        } catch {}
      }
    })
  );

  const inlineEditController = new InlineEditController(
    client,
    diffReviewManager,
    getWorkspaceRoot,
    context.extensionPath,
    {
      onStatusUpdate: (status) => {
        output.appendLine(`[InlineEdit] ${status}`);
      },
      onFallback: (info) => {
        agentPanelProvider.postExternalEvent({ type: 'fallbackNotice', ...info });
      },
      onInlineEditFinished: (summary) => {
        output.appendLine(`[InlineEdit] ${summary}`);
        agentPanelProvider.postExternalEvent({ type: 'inlineEditLog', message: summary });
      },
    }
  );

  // Status bar indicator
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'trueforge.openPanel';
  statusBar.text = '$(sparkle) TrueForge: Starting...';
  statusBar.show();
  context.subscriptions.push(statusBar);

  // Register Webview Sidebar
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AgentPanelProvider.viewType, agentPanelProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Register Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('trueforge.inlineEdit', async () => {
      await inlineEditController.triggerInlineEdit();
    }),
    vscode.commands.registerCommand('trueforge.openPanel', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.trueforge-coder');
    }),
    vscode.commands.registerCommand('trueforge.cancelRun', async () => {
      await agentPanelProvider.cancelCurrentRun();
    }),
    vscode.commands.registerCommand('trueforge.undoLastEdit', async () => {
      await diffReviewManager.undoLastEdit();
    }),
    vscode.commands.registerCommand(
      'trueforge.acceptHunk',
      async (reviewId: string, hunkIndex: number) => {
        await diffReviewManager.setHunkDecision(reviewId, hunkIndex, 'accepted');
      }
    ),
    vscode.commands.registerCommand(
      'trueforge.rejectHunk',
      async (reviewId: string, hunkIndex: number) => {
        await diffReviewManager.setHunkDecision(reviewId, hunkIndex, 'rejected');
      }
    ),
    vscode.commands.registerCommand('trueforge.acceptAllHunks', async (reviewId: string) => {
      await diffReviewManager.acceptAllHunks(reviewId);
    }),
    vscode.commands.registerCommand('trueforge.rejectAllHunks', async (reviewId: string) => {
      await diffReviewManager.rejectAllHunks(reviewId);
    }),
    vscode.commands.registerCommand('trueforge.submitReview', async (reviewId: string) => {
      await diffReviewManager.finalizeReview(reviewId);
    }),
    vscode.commands.registerCommand('trueforge.openTrueForgeSession', async () => {
      const sid = agentPanelProvider.getCurrentSessionId();
      const url = sid ? client.getSessionUrl(sid) : getServerUrl();
      vscode.env.openExternal(vscode.Uri.parse(url));
    })
  );

  // Start embedded MCP server & register with local TrueForge harness
  try {
    const mcpUrl = await mcpServer.start();
    output.appendLine(`[MCP] Embedded VS Code MCP server listening at ${mcpUrl}`);

    const healthy = await client.checkHealth();
    if (healthy) {
      try {
        await client.registerMcpServer(mcpUrl, 'vscode-editor');
        output.appendLine(`[TrueForge] Registered MCP server 'vscode-editor' -> ${mcpUrl}`);
      } catch (mcpErr: any) {
        const errText = mcpErr?.message || String(mcpErr);
        output.appendLine(`[TrueForge MCP Error] ${errText}`);
        if (errText.includes('Outbound URL blocked')) {
          vscode.window.showWarningMessage(
            'TrueForge blocked localhost MCP registration. Restart TrueForge with: OUTBOUND_URL_ALLOWED_HOSTS=\'["localhost","127.0.0.1"]\' npx @truefoundry/trueforge'
          );
        } else {
          vscode.window.showWarningMessage(`TrueForge MCP registration warning: ${errText}`);
        }
      }

      const primaryModel = vscode.workspace
        .getConfiguration('trueforge')
        .get<string>('primaryModel', 'google-gemini/gemini-3-5-flash-lite');

      try {
        await client.syncSavedAgent(primaryModel, context.extensionPath);
        output.appendLine(`[TrueForge] Synced saved agent definition 'trueforge-coder'`);
      } catch (agentErr: any) {
        output.appendLine(`[TrueForge] Saved agent sync note: ${agentErr?.message || agentErr}`);
      }

      statusBar.text = '$(sparkle) Blueprint: Connected';
      statusBar.tooltip = `Blueprint | TrueForge Harness: ${getServerUrl()} | MCP: ${mcpUrl}`;
      await agentPanelProvider.refreshModelsAndStatus();
    } else {
      statusBar.text = '$(warning) Blueprint: TrueForge Offline';
      statusBar.tooltip = `Start TrueForge locally with: npx @truefoundry/trueforge`;
      vscode.window.showWarningMessage(
        `TrueForge server not reachable at ${getServerUrl()}. Start it with: npx @truefoundry/trueforge`
      );
    }
  } catch (err: any) {
    output.appendLine(`[Startup Error] ${err?.message || err}`);
    statusBar.text = '$(error) TrueForge: Error';
  }
}

export function deactivate() {
  // Disposables cleaned up automatically by VS Code
}
