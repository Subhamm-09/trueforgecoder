import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  assembleWorkspaceContext,
  ContextSelectionReport,
  extractSymbolsFromContent,
  listWorkspaceFiles,
} from './contextAssembler.js';
import { DiffReviewManager } from './diffReviewManager.js';

const execAsync = promisify(exec);

export class EditorMcpServer implements vscode.Disposable {
  private httpServer: http.Server | null = null;
  private port: number;
  private readonly _onContextReport = new vscode.EventEmitter<ContextSelectionReport>();
  public readonly onContextReport = this._onContextReport.event;

  private readonly _onToolActivity = new vscode.EventEmitter<{ tool: string; summary: string }>();
  public readonly onToolActivity = this._onToolActivity.event;

  constructor(
    private readonly getWorkspaceRoot: () => string | undefined,
    private readonly diffReviewManager: DiffReviewManager,
    private readonly getDefaultTokenBudget: () => number,
    port = 8791
  ) {
    this.port = port;
  }

  public getUrl(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  private createMcpInstance(): McpServer {
    const server = new McpServer({
      name: 'vscode-editor',
      version: '1.0.0',
    });

    // 1. assemble_context (preloaded, read-only)
    server.tool(
      'assemble_context',
      'Automatically discover and rank the most relevant workspace files within a strict token budget. Always call this first for repository tasks where file names are not specified. Returns selected files, token usage, relevance scores, why each file was chosen, and code excerpts.',
      {
        query: z.string().describe('Natural-language description of the coding task or question.'),
        token_budget: z
          .number()
          .int()
          .min(1000)
          .max(60000)
          .optional()
          .describe('Optional max token budget (defaults to user configured budget, e.g. 12000).'),
        explicit_files: z.array(z.string()).optional().describe('Explicit file paths to prioritize.'),
        explicit_symbols: z.array(z.string()).optional().describe('Explicit symbol names to prioritize.'),
      },
      { readOnlyHint: true, destructiveHint: false },
      async ({ query, token_budget, explicit_files, explicit_symbols }) => {
        const root = this.getWorkspaceRoot();
        if (!root) {
          return { content: [{ type: 'text', text: 'Error: No workspace folder is open in VS Code.' }], isError: true };
        }
        const budget = token_budget ?? this.getDefaultTokenBudget();
        const report = assembleWorkspaceContext(
          root,
          query,
          budget,
          explicit_files ?? [],
          explicit_symbols ?? []
        );

        this._onContextReport.fire(report);
        this._onToolActivity.fire({
          tool: 'assemble_context',
          summary: `Selected ${report.selected.length} files (${report.tokensUsed}/${report.tokenBudget} tokens)`,
        });

        const lines: string[] = [];
        lines.push(`# Context Assembly Report`);
        lines.push(`- Query: ${report.query}`);
        lines.push(`- Token Budget: ${report.tokensUsed} / ${report.tokenBudget} tokens (${Math.round((report.tokensUsed / report.tokenBudget) * 100)}%)`);
        lines.push(`- Files Scanned: ${report.totalFilesScanned}`);
        lines.push(`- Selected Files (${report.selected.length}):`);
        for (const item of report.selected) {
          lines.push(`  * ${item.relativePath} [score=${item.score}, ~${item.estimatedTokens} tokens] — WHY: ${item.reason}`);
        }
        if (report.excludedByBudget.length > 0) {
          lines.push(`- Excluded due to budget (${report.excludedByBudget.length}):`);
          for (const ex of report.excludedByBudget) {
            lines.push(`  * ${ex.relativePath} [score=${ex.score}, ~${ex.estimatedTokens} tokens] — ${ex.reason}`);
          }
        }
        lines.push('\n## File Excerpts');
        for (const item of report.selected) {
          const rangeLabel = item.lineRange ? ` (lines ${item.lineRange.start}-${item.lineRange.end})` : '';
          lines.push(`\n### ${item.relativePath}${rangeLabel}\n\`\`\`\n${item.excerpt}\n\`\`\``);
        }

        let payload = lines.join('\n');
        if (payload.length > 20000) {
          payload = payload.slice(0, 19950) + '\n... [truncated to stay within 20k tool response budget]';
        }

        return { content: [{ type: 'text', text: payload }] };
      }
    );

    // 2. search_workspace (preloaded, read-only)
    server.tool(
      'search_workspace',
      'Search across workspace files for a literal string or regular expression. Returns matching relative paths, line numbers, and line text.',
      {
        query: z.string().describe('Text or regex pattern to search for.'),
        is_regex: z.boolean().optional().describe('Treat query as regex if true.'),
        file_pattern: z.string().optional().describe('Optional substring filter on file paths (e.g. ".py", "tests/", "docs/").'),
        max_results: z.number().int().min(1).max(200).optional().describe('Maximum matching lines to return (default 50).'),
      },
      { readOnlyHint: true, destructiveHint: false },
      async ({ query, is_regex, file_pattern, max_results }) => {
        const root = this.getWorkspaceRoot();
        if (!root) {
          return { content: [{ type: 'text', text: 'Error: No workspace folder open.' }], isError: true };
        }
        const limit = max_results ?? 20;
        const files = listWorkspaceFiles(root);
        let regex: RegExp;
        try {
          regex = is_regex ? new RegExp(query, 'i') : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Invalid regex: ${err.message}` }], isError: true };
        }

        const matches: string[] = [];
        // First include matching workspace file paths so filename queries succeed immediately
        for (const rel of files) {
          if (matches.length >= limit) {
            break;
          }
          if (file_pattern && !rel.toLowerCase().includes(file_pattern.toLowerCase())) {
            continue;
          }
          if (regex.test(rel)) {
            matches.push(`[FILE PATH MATCH] ${rel}`);
          }
        }
        for (const rel of files) {
          if (matches.length >= limit) {
            break;
          }
          if (file_pattern && !rel.toLowerCase().includes(file_pattern.toLowerCase())) {
            continue;
          }
          try {
            const fullPath = path.join(root, rel);
            if (fs.statSync(fullPath).size > 500_000) {
              continue;
            }
            const content = fs.readFileSync(fullPath, 'utf8');
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                matches.push(`${rel}:${i + 1}: ${lines[i].trimEnd().slice(0, 220)}`);
                if (matches.length >= limit) {
                  break;
                }
              }
            }
          } catch {
            // skip unreadable
          }
        }

        this._onToolActivity.fire({
          tool: 'search_workspace',
          summary: `"${query}" -> ${matches.length} matches`,
        });

        return {
          content: [
            {
              type: 'text',
              text: matches.length > 0 ? matches.join('\n') : `No matches found for "${query}".`,
            },
          ],
        };
      }
    );

    // 3. read_file (preloaded, read-only)
    server.tool(
      'read_file',
      'Read a file from the VS Code workspace with line numbers. Supports optional 1-based start_line and end_line.',
      {
        path: z.string().describe('Workspace-relative path to the file (e.g. src/flask/helpers.py).'),
        start_line: z.number().int().min(1).optional().describe('1-based starting line number.'),
        end_line: z.number().int().min(1).optional().describe('1-based ending line number (inclusive).'),
      },
      { readOnlyHint: true, destructiveHint: false },
      async ({ path: relPath, start_line, end_line }) => {
        const root = this.getWorkspaceRoot();
        if (!root) {
          return { content: [{ type: 'text', text: 'Error: No workspace folder open.' }], isError: true };
        }
        const absPath = path.resolve(root, relPath);
        if (!absPath.toLowerCase().startsWith(path.resolve(root).toLowerCase())) {
          return { content: [{ type: 'text', text: 'Error: Path escapes workspace root.' }], isError: true };
        }
        if (!fs.existsSync(absPath)) {
          return { content: [{ type: 'text', text: `Error: File not found: ${relPath}` }], isError: true };
        }

        const raw = fs.readFileSync(absPath, 'utf8');
        const allLines = raw.split(/\r?\n/);
        const start = Math.max(1, start_line ?? 1);
        const end = Math.min(allLines.length, end_line ?? Math.min(allLines.length, start + 149));
        const slice = allLines.slice(start - 1, end);
        let numbered = slice.map((l, idx) => `${start + idx}: ${l}`).join('\n');
        if (numbered.length > 16000) {
          numbered = numbered.slice(0, 15950) + '\n... [truncated; pass narrower start_line/end_line]';
        }

        this._onToolActivity.fire({
          tool: 'read_file',
          summary: `${relPath} (lines ${start}-${end} of ${allLines.length})`,
        });

        return {
          content: [
            {
              type: 'text',
              text: `File: ${relPath} (showing lines ${start}-${end} of ${allLines.length})\n\n${numbered}`,
            },
          ],
        };
      }
    );

    // 4. list_files (deferred, read-only)
    server.tool(
      'list_files',
      'List files in the workspace or a specific subdirectory.',
      {
        directory: z.string().optional().describe('Optional relative subdirectory (e.g. "src/flask" or "docs").'),
        max_files: z.number().int().min(1).max(500).optional().describe('Max files to return (default 150).'),
      },
      { readOnlyHint: true, destructiveHint: false },
      async ({ directory, max_files }) => {
        const root = this.getWorkspaceRoot();
        if (!root) {
          return { content: [{ type: 'text', text: 'Error: No workspace folder open.' }], isError: true };
        }
        const baseDir = directory ? path.resolve(root, directory) : root;
        if (!fs.existsSync(baseDir)) {
          return { content: [{ type: 'text', text: `Directory not found: ${directory}` }], isError: true };
        }
        const files = listWorkspaceFiles(baseDir, max_files ?? 150);
        const prefix = directory ? directory.replace(/\\/g, '/').replace(/\/$/, '') + '/' : '';
        return {
          content: [{ type: 'text', text: files.map((f) => prefix + f).join('\n') || '(empty)' }],
        };
      }
    );

    // 5. get_symbols (deferred, read-only)
    server.tool(
      'get_symbols',
      'Extract functions, classes, methods, and CLI commands defined in a file with line numbers.',
      {
        path: z.string().describe('Workspace-relative path to the file.'),
      },
      { readOnlyHint: true, destructiveHint: false },
      async ({ path: relPath }) => {
        const root = this.getWorkspaceRoot();
        if (!root) {
          return { content: [{ type: 'text', text: 'Error: No workspace folder open.' }], isError: true };
        }
        const absPath = path.resolve(root, relPath);
        if (!fs.existsSync(absPath)) {
          return { content: [{ type: 'text', text: `File not found: ${relPath}` }], isError: true };
        }
        const content = fs.readFileSync(absPath, 'utf8');
        const symbols = extractSymbolsFromContent(relPath, content);
        const formatted = symbols.map((s) => `L${s.line} [${s.kind}] ${s.name}`).join('\n');
        return {
          content: [{ type: 'text', text: formatted || `No symbols extracted from ${relPath}.` }],
        };
      }
    );

    // 6. propose_edit (deferred, write — requires TrueForge human-in-the-loop approval!)
    server.tool(
      'propose_edit',
      'Propose a code edit to a workspace file. TrueForge pauses before executing this tool so the user can review every diff hunk inside VS Code and accept or reject each hunk before anything touches disk. Prefer minimal `edits` (old_text -> new_text) over full-file `new_content`.',
      {
        path: z.string().describe('Workspace-relative path to the file to edit or create.'),
        rationale: z.string().describe('Short explanation of why this file is being edited.'),
        edits: z
          .array(
            z.object({
              old_text: z.string().describe('Exact existing text snippet to replace (empty string appends to end).'),
              new_text: z.string().describe('Replacement text snippet.'),
            })
          )
          .optional()
          .describe('Ordered list of targeted search-and-replace edits.'),
        new_content: z
          .string()
          .optional()
          .describe('Full replacement file content (use only for new files or small files when edits is omitted).'),
      },
      { readOnlyHint: false, destructiveHint: true },
      async ({ path: relPath, rationale, edits, new_content }) => {
        const root = this.getWorkspaceRoot();
        if (!root) {
          return { content: [{ type: 'text', text: 'Error: No workspace folder open.' }], isError: true };
        }
        const absPath = path.resolve(root, relPath);
        if (!absPath.toLowerCase().startsWith(path.resolve(root).toLowerCase())) {
          return { content: [{ type: 'text', text: 'Error: Path escapes workspace root.' }], isError: true };
        }

        const result = await this.diffReviewManager.applyApprovedEditToDisk(
          root,
          relPath,
          edits,
          new_content,
          rationale
        );

        this._onToolActivity.fire({
          tool: 'propose_edit',
          summary: result.message,
        });

        return {
          content: [{ type: 'text', text: result.message }],
          isError: !result.applied,
        };
      }
    );

    // 7. run_command (deferred, destructive — requires TrueForge approval)
    server.tool(
      'run_command',
      'Run a terminal command inside the workspace root (e.g. pytest tests/test_cli.py -q or flask --help). Requires user approval. For verification, run targeted tests like pytest tests/test_cli.py -q rather than bare pytest.',
      {
        command: z.string().describe('Shell command to execute.'),
        timeout_ms: z.number().int().min(1000).max(120000).optional().describe('Timeout in ms (default 30000).'),
      },
      { readOnlyHint: false, destructiveHint: true },
      async ({ command, timeout_ms }) => {
        const rawRoot = this.getWorkspaceRoot();
        if (!rawRoot) {
          return { content: [{ type: 'text', text: 'Error: No workspace folder open.' }], isError: true };
        }
        // Normalize drive letter to uppercase so Windows Python sys.path string comparisons match exactly
        const root =
          process.platform === 'win32' && /^[a-z]:/i.test(rawRoot)
            ? rawRoot[0].toUpperCase() + rawRoot.slice(1)
            : rawRoot;
        this._onToolActivity.fire({
          tool: 'run_command',
          summary: command,
        });
        try {
          // Prepend any workspace or sibling Python virtualenv Scripts/bin onto PATH so pytest/flask work immediately
          const candidateVenvs = [
            path.join(root, '.venv', 'Scripts'),
            path.join(root, '.venv', 'bin'),
            path.join(root, 'venv', 'Scripts'),
            path.join(root, 'venv', 'bin'),
            path.join(path.dirname(root), 'flask-venv', 'Scripts'),
            path.join(path.dirname(root), 'flask-venv', 'bin'),
          ].filter((p) => fs.existsSync(p));
          const sep = process.platform === 'win32' ? ';' : ':';
          const envPath = [...candidateVenvs, process.env.PATH || ''].filter(Boolean).join(sep);

          const { stdout, stderr } = await execAsync(command, {
            cwd: root,
            env: { ...process.env, PATH: envPath },
            timeout: timeout_ms ?? 30000,
            maxBuffer: 2 * 1024 * 1024,
          });
          let out = [stdout?.trim(), stderr?.trim()].filter(Boolean).join('\n--- STDERR ---\n');
          if (out.length > 2500) {
            out = '... [truncated earlier output to preserve token quota]\n' + out.slice(-2500);
          }
          this._onToolActivity.fire({
            tool: 'command_result',
            summary: JSON.stringify({ command, exitCode: 0, output: out || '(no output)' }),
          });
          return {
            content: [{ type: 'text', text: `Exit code: 0\n${out || '(no output)'}` }],
          };
        } catch (err: any) {
          let out = [err.stdout?.trim(), err.stderr?.trim(), err.message].filter(Boolean).join('\n');
          if (out.length > 2500) {
            out = '... [truncated earlier output to preserve token quota]\n' + out.slice(-2500);
          }
          this._onToolActivity.fire({
            tool: 'command_result',
            summary: JSON.stringify({ command, exitCode: err.code ?? 1, output: out }),
          });
          return {
            content: [{ type: 'text', text: `Exit code: ${err.code ?? 1}\n${out}` }],
            isError: true,
          };
        }
      }
    );

    // 8. git_status (deferred, read-only)
    server.tool(
      'git_status',
      'Show git status and diff stat for the current workspace.',
      {},
      { readOnlyHint: true, destructiveHint: false },
      async () => {
        const root = this.getWorkspaceRoot();
        if (!root) {
          return { content: [{ type: 'text', text: 'Error: No workspace folder open.' }], isError: true };
        }
        try {
          const { stdout: status } = await execAsync('git status --short', { cwd: root });
          const { stdout: stat } = await execAsync('git diff --stat', { cwd: root });
          return {
            content: [
              {
                type: 'text',
                text: `git status --short:\n${status.trim() || '(clean)'}\n\ngit diff --stat:\n${stat.trim() || '(no unstaged changes)'}`,
              },
            ],
          };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `git error: ${err.message}` }], isError: true };
        }
      }
    );

    return server;
  }

  public async start(): Promise<string> {
    if (this.httpServer) {
      return this.getUrl();
    }

    this.httpServer = http.createServer(async (req, res) => {
      // CORS headers for local TrueForge
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const urlPath = (req.url || '/').split('?')[0];
      if (urlPath === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, workspace: this.getWorkspaceRoot() ?? null }));
        return;
      }

      if (urlPath !== '/mcp') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      if (req.method === 'GET' || req.method === 'DELETE') {
        // Stateless Streamable HTTP server returns 405 for standalone SSE GET / DELETE
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed in stateless mode.' }, id: null }));
        return;
      }

      if (req.method === 'POST') {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const bodyStr = Buffer.concat(chunks).toString('utf8');
          const parsedBody = bodyStr ? JSON.parse(bodyStr) : undefined;

          const mcp = this.createMcpInstance();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined, // Stateless mode: every request cleanly handled
          });

          res.on('close', () => {
            transport.close().catch(() => {});
            mcp.close().catch(() => {});
          });

          await mcp.connect(transport);
          await transport.handleRequest(req, res, parsedBody);
        } catch (err: any) {
          console.error('[TrueForge MCP] Request error:', err);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32603, message: err?.message || 'Internal MCP server error' },
                id: null,
              })
            );
          }
        }
        return;
      }

      res.writeHead(405);
      res.end();
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          // Pick an ephemeral free port automatically if 8791 is taken
          this.httpServer!.listen(0, '127.0.0.1', () => {
            const addr = this.httpServer!.address();
            if (addr && typeof addr === 'object') {
              this.port = addr.port;
            }
            resolve();
          });
        } else {
          reject(err);
        }
      });
      this.httpServer!.listen(this.port, '127.0.0.1', () => resolve());
    });

    return this.getUrl();
  }

  public dispose() {
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }
    this._onContextReport.dispose();
    this._onToolActivity.dispose();
  }
}
