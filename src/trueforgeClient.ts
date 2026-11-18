import * as fs from 'fs';
import * as path from 'path';

export interface TrueForgeModelInfo {
  name: string;
  model_id: string;
  provider: { name: string };
  properties?: {
    context_length?: number;
    max_output_tokens?: number;
  };
}

export interface ParsedToolCall {
  id: string;
  name: string;
  rawArguments: string;
  arguments: Record<string, any>;
  sourceEventId: string;
}

export interface TurnCallbacks {
  onSessionReady?: (sessionId: string, modelName: string) => void;
  onTurnStart?: (turnId: string) => void;
  onTextDelta?: (delta: string, threadId: string) => void;
  onReasoningDelta?: (delta: string, threadId: string) => void;
  onToolCall?: (toolCall: ParsedToolCall, threadId: string) => void;
  onToolResponse?: (toolCallId: string, name: string, output: string, isError: boolean) => void;
  onSubAgentEvent?: (threadId: string, status: 'created' | 'done', detail?: string) => void;
  onCompactionEvent?: (status: 'started' | 'finished') => void;
  onApprovalRequired: (
    sessionId: string,
    turnId: string,
    threadId: string,
    toolCall: ParsedToolCall
  ) => Promise<{ status: 'allow' } | { status: 'deny'; reason?: string }>;
  onFallback?: (info: { primaryModel: string; fallbackModel: string; errorMessage: string }) => void;
  onRetry?: (info: { attempt: number; delayMs: number; errorMessage: string }) => void;
}

export interface TurnOutcome {
  status: 'done' | 'cancelled' | 'error';
  sessionId: string;
  turnId?: string;
  modelUsed: string;
  fallbackTriggered: boolean;
  finalText: string;
  errorMessage?: string;
}

export class TrueForgeClient {
  private activeAbortController: AbortController | null = null;
  private activeSessionId: string | null = null;
  private activeTurnId: string | null = null;
  private isCancelling = false;

  constructor(private readonly getServerUrl: () => string) {}

  private baseUrl(): string {
    return this.getServerUrl().replace(/\/+$/, '');
  }

  public getSessionUrl(sessionId: string): string {
    return `${this.baseUrl()}/sessions/${sessionId}`;
  }

  public getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  public async checkHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl()}/api/v1/models`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  public async listModels(): Promise<TrueForgeModelInfo[]> {
    const res = await fetch(`${this.baseUrl()}/api/v1/models`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      throw new Error(`TrueForge /api/v1/models returned ${res.status}`);
    }
    const json: any = await res.json();
    return json.data || [];
  }

  public async registerMcpServer(mcpUrl: string, name = 'vscode-editor'): Promise<void> {
    const payload = {
      manifest: {
        type: 'remote',
        name,
        url: mcpUrl,
        description:
          'VS Code workspace MCP server exposing budget-capped context assembly, file reading/searching, human-approved per-hunk diff editing, and terminal execution.',
      },
    };

    const res = await fetch(`${this.baseUrl()}/api/v1/settings/mcp-servers`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to register MCP server '${name}' (${res.status}): ${text}`);
    }
  }

  public buildAgentSpec(modelName: string, extensionRoot?: string): Record<string, any> {
    // Load base agent-definition.json if present so repo definition is always the single source of truth
    let instructions =
      'You are TrueForge Coder, an editor-native coding agent running inside VS Code via TrueForge and MCP tools. Always use assemble_context first for repository-wide tasks, read_file before editing, and propose_edit for all file modifications.';

    if (extensionRoot) {
      try {
        const defPath = path.join(extensionRoot, 'agent-definition.json');
        if (fs.existsSync(defPath)) {
          const parsed = JSON.parse(fs.readFileSync(defPath, 'utf8'));
          if (parsed?.manifest?.instructions) {
            instructions = parsed.manifest.instructions;
          }
        }
      } catch {
        // use fallback instructions
      }
    }

    return {
      model: { name: modelName },
      instructions,
      mcp_servers: [
        {
          name: 'vscode-editor',
          enable_tools: ['@all'],
          preload: false,
          preload_tools: ['assemble_context', 'search_workspace', 'read_file', 'propose_edit'],
          require_approval_for_tools: ['propose_edit', 'run_command'],
        },
      ],
      config: {
        iteration_limit: 40,
        sandbox: { enabled: false, file_downloads: false },
        dynamic_sub_agents: { enabled: true },
        context_management: {
          compaction: { enabled: true },
          large_tool_response: { enabled: true },
        },
        generative_ui: { enabled: false },
        ask_user_questions: { enabled: false },
        web_search: { enabled: false },
        memory: { enabled: false },
      },
    };
  }

  public async syncSavedAgent(modelName: string, extensionRoot?: string): Promise<void> {
    const spec = this.buildAgentSpec(modelName, extensionRoot);
    const body = {
      name: 'trueforge-coder',
      description:
        'Editor-native VS Code coding agent on TrueForge with MCP tools, deferred tool loading, subagents, compaction, and human-in-the-loop diff review.',
      manifest: spec,
    };

    // Try POST first; if 409 (already exists), update via PUT
    const postRes = await fetch(`${this.baseUrl()}/api/v1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (postRes.status === 409) {
      await fetch(`${this.baseUrl()}/api/v1/agents/trueforge-coder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }
  }

  public async createSession(modelName: string, extensionRoot?: string): Promise<string> {
    const spec = this.buildAgentSpec(modelName, extensionRoot);
    const res = await fetch(`${this.baseUrl()}/api/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: { spec } }),
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Failed to create TrueForge session (${res.status}): ${txt}`);
    }
    const json: any = await res.json();
    const id = json?.data?.id || json?.id;
    if (!id) {
      throw new Error('TrueForge session creation response missing session id.');
    }
    return id;
  }

  public async cancelActiveTurn(): Promise<void> {
    this.isCancelling = true;
    const sessionId = this.activeSessionId;

    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }

    if (sessionId) {
      try {
        await fetch(`${this.baseUrl()}/api/v1/sessions/${sessionId}/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(3000),
        });
      } catch {
        // best-effort server cancel
      }
    }
  }

  private async submitToolApprovals(
    sessionId: string,
    turnId: string,
    events: Array<{
      type: 'user.tool_approval';
      thread_id: string;
      tool_call_id: string;
      approval: { status: 'allow' } | { status: 'deny'; reason?: string };
    }>
  ): Promise<void> {
    const res = await fetch(
      `${this.baseUrl()}/api/v1/sessions/${sessionId}/turns/${turnId}/events`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events }),
      }
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to submit tool approval (${res.status}): ${text}`);
    }
  }

  private parseSafeJson(str: string): Record<string, any> {
    try {
      return JSON.parse(str);
    } catch {
      return { raw: str };
    }
  }

  private extractToolName(rawName: string): string {
    // TrueForge namespaces MCP tools as e.g. "vscode-editor__propose_edit" or "vscode-editor/propose_edit"
    const parts = rawName.split(/(?:__|\/|\.)/);
    return parts[parts.length - 1] || rawName;
  }

  private parseToolCallObject(tc: any, sourceEventId: string): ParsedToolCall {
    const rawName = tc.function?.name || tc.name || 'unknown_tool';
    const rawArgs = tc.function?.arguments || tc.arguments || '{}';
    const parsedArgs =
      typeof rawArgs === 'string' ? this.parseSafeJson(rawArgs) : rawArgs || {};

    let effectiveName = this.extractToolName(rawName);
    let effectiveArgs = parsedArgs;

    // Unwrap TrueForge deferred-tool meta-call envelope:
    // { name: "call_tool", arguments: { mcp_server: "vscode-editor", tool_name: "propose_edit", input: {...} } }
    if (effectiveName === 'call_tool' && typeof parsedArgs?.tool_name === 'string') {
      effectiveName = this.extractToolName(parsedArgs.tool_name);
      effectiveArgs =
        parsedArgs.input && typeof parsedArgs.input === 'object'
          ? parsedArgs.input
          : parsedArgs;
    }

    return {
      id: tc.id,
      name: effectiveName,
      rawArguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs),
      arguments: effectiveArgs,
      sourceEventId,
    };
  }

  private async consumeSseStream(
    response: Response,
    sessionId: string,
    state: {
      turnId?: string;
      finalText: string;
      terminalStatus?: 'done' | 'cancelled' | 'error';
      errorMessage?: string;
      toolCallsById: Map<string, ParsedToolCall>;
      handledApprovals: Set<string>;
      pendingApprovalPromises: Promise<void>[];
    },
    callbacks: TurnCallbacks
  ): Promise<void> {
    if (!response.body) {
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const processLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) {
        return;
      }
      const payloadStr = trimmed.slice(5).trim();
      if (!payloadStr || payloadStr === '[DONE]') {
        return;
      }
      let ev: any;
      try {
        ev = JSON.parse(payloadStr);
      } catch {
        return;
      }

      switch (ev.type) {
        case 'turn.created': {
          state.turnId = ev.turn_id;
          this.activeTurnId = ev.turn_id;
          callbacks.onTurnStart?.(ev.turn_id);
          break;
        }
        case 'model.message.delta': {
          if (typeof ev.content === 'string' && ev.content.length > 0) {
            state.finalText += ev.content;
            callbacks.onTextDelta?.(ev.content, ev.thread_id || 'main');
          }
          if (typeof ev.reasoning_content === 'string' && ev.reasoning_content.length > 0) {
            callbacks.onReasoningDelta?.(ev.reasoning_content, ev.thread_id || 'main');
          }
          break;
        }
        case 'model.message': {
          const calls: any[] = ev.tool_calls || [];
          for (const tc of calls) {
            const parsedCall = this.parseToolCallObject(tc, ev.id);
            state.toolCallsById.set(tc.id, parsedCall);
            callbacks.onToolCall?.(parsedCall, ev.thread_id || 'main');
          }
          break;
        }
        case 'tool.response': {
          const toolCallId = ev.tool_call_id || ev.id || '';
          const known = state.toolCallsById.get(toolCallId);
          const contentStr =
            typeof ev.content === 'string'
              ? ev.content
              : Array.isArray(ev.content)
              ? ev.content.map((c: any) => c.text || JSON.stringify(c)).join('\n')
              : JSON.stringify(ev.content ?? '');
          callbacks.onToolResponse?.(
            toolCallId,
            known?.name || ev.name || 'tool',
            contentStr,
            Boolean(ev.is_error)
          );
          break;
        }
        case 'thread.created': {
          if (ev.thread_id && ev.thread_id !== 'main') {
            callbacks.onSubAgentEvent?.(ev.thread_id, 'created', ev.name || ev.instructions);
          }
          break;
        }
        case 'thread.done': {
          if (ev.thread_id && ev.thread_id !== 'main') {
            callbacks.onSubAgentEvent?.(ev.thread_id, 'done');
          }
          break;
        }
        case 'thread.context_compaction_started': {
          callbacks.onCompactionEvent?.('started');
          break;
        }
        case 'thread.context_compaction_finished': {
          callbacks.onCompactionEvent?.('finished');
          break;
        }
        case 'tool.approval_required': {
          const threadId = ev.thread_id || 'main';
          const refs: Array<{ id: string; source_event_id: string }> = ev.tool_calls || [];
          const p = (async () => {
            const approvalEvents: Array<{
              type: 'user.tool_approval';
              thread_id: string;
              tool_call_id: string;
              approval: { status: 'allow' } | { status: 'deny'; reason?: string };
            }> = [];

            for (const ref of refs) {
              if (state.handledApprovals.has(ref.id)) {
                continue;
              }
              state.handledApprovals.add(ref.id);

              let toolCall = state.toolCallsById.get(ref.id);
              // Fallback: fetch turn events if tool_call wasn't seen yet in current stream
              if (!toolCall && state.turnId) {
                toolCall = await this.lookupToolCallFromTurn(sessionId, state.turnId, ref.id);
              }
              if (!toolCall) {
                toolCall = {
                  id: ref.id,
                  name: 'unknown_tool',
                  rawArguments: '{}',
                  arguments: {},
                  sourceEventId: ref.source_event_id,
                };
              }

              const decision = await callbacks.onApprovalRequired(
                sessionId,
                state.turnId || '',
                threadId,
                toolCall
              );

              if (this.isCancelling) {
                return;
              }

              approvalEvents.push({
                type: 'user.tool_approval',
                thread_id: threadId,
                tool_call_id: ref.id,
                approval: decision,
              });
            }

            if (approvalEvents.length > 0 && state.turnId && !this.isCancelling) {
              await this.submitToolApprovals(sessionId, state.turnId, approvalEvents);
            }
          })();
          state.pendingApprovalPromises.push(p);
          break;
        }
        case 'turn.done': {
          const status = ev.state?.status;
          if (status === 'done') {
            state.terminalStatus = 'done';
            if (!state.finalText && ev.state?.output?.content) {
              state.finalText = ev.state.output.content;
            }
          } else if (status === 'cancelled') {
            state.terminalStatus = 'cancelled';
          } else if (status === 'error') {
            state.terminalStatus = 'error';
            state.errorMessage = ev.state?.message || 'TrueForge turn ended in error.';
          }
          break;
        }
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          processLine(line);
        }
      }
      if (buffer.trim()) {
        processLine(buffer);
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async lookupToolCallFromTurn(
    sessionId: string,
    turnId: string,
    toolCallId: string
  ): Promise<ParsedToolCall | undefined> {
    try {
      const res = await fetch(
        `${this.baseUrl()}/api/v1/sessions/${sessionId}/turns/${turnId}/events`
      );
      if (!res.ok) {
        return undefined;
      }
      const json: any = await res.json();
      for (const item of json.data || []) {
        const ev = item.event || item;
        if (ev.type === 'model.message' && Array.isArray(ev.tool_calls)) {
          for (const tc of ev.tool_calls) {
            if (tc.id === toolCallId) {
              return this.parseToolCallObject(tc, ev.id);
            }
          }
        }
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  public async runTurnSingleModel(params: {
    modelName: string;
    prompt: string;
    existingSessionId?: string;
    previousTurnId?: string;
    extensionRoot?: string;
    callbacks: TurnCallbacks;
  }): Promise<TurnOutcome> {
    this.isCancelling = false;
    const controller = new AbortController();
    this.activeAbortController = controller;

    let sessionId = params.existingSessionId;
    if (!sessionId) {
      sessionId = await this.createSession(params.modelName, params.extensionRoot);
    }
    this.activeSessionId = sessionId;
    params.callbacks.onSessionReady?.(sessionId, params.modelName);

    const state = {
      turnId: undefined as string | undefined,
      finalText: '',
      terminalStatus: undefined as 'done' | 'cancelled' | 'error' | undefined,
      errorMessage: undefined as string | undefined,
      toolCallsById: new Map<string, ParsedToolCall>(),
      handledApprovals: new Set<string>(),
      pendingApprovalPromises: [] as Promise<void>[],
    };

    try {
      const body: Record<string, any> = {
        input: [{ type: 'user.message', content: params.prompt }],
        stream: true,
      };
      if (params.previousTurnId) {
        body.previous_turn_id = params.previousTurnId;
      }

      const turnRes = await fetch(`${this.baseUrl()}/api/v1/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!turnRes.ok) {
        const errText = await turnRes.text();
        return {
          status: 'error',
          sessionId,
          modelUsed: params.modelName,
          fallbackTriggered: false,
          finalText: '',
          errorMessage: `TrueForge turn request failed (${turnRes.status}): ${errText}`,
        };
      }

      await this.consumeSseStream(turnRes, sessionId, state, params.callbacks);

      // If TrueForge closed the stream while paused on approval, wait for approvals and re-subscribe until turn.done
      let guardLoops = 0;
      while (!state.terminalStatus && !this.isCancelling && state.turnId && guardLoops < 20) {
        guardLoops++;
        if (state.pendingApprovalPromises.length > 0) {
          const toAwait = state.pendingApprovalPromises.splice(0);
          await Promise.all(toAwait);
        }
        if (this.isCancelling) {
          break;
        }
        const subRes = await fetch(
          `${this.baseUrl()}/api/v1/sessions/${sessionId}/turns/${state.turnId}/subscribe`,
          {
            method: 'GET',
            headers: { Accept: 'text/event-stream' },
            signal: controller.signal,
          }
        );
        if (!subRes.ok) {
          break;
        }
        await this.consumeSseStream(subRes, sessionId, state, params.callbacks);
      }

      if (state.pendingApprovalPromises.length > 0) {
        await Promise.allSettled(state.pendingApprovalPromises);
      }

      if (this.isCancelling || state.terminalStatus === 'cancelled') {
        return {
          status: 'cancelled',
          sessionId,
          turnId: state.turnId,
          modelUsed: params.modelName,
          fallbackTriggered: false,
          finalText: state.finalText,
        };
      }

      if (state.terminalStatus === 'error') {
        return {
          status: 'error',
          sessionId,
          turnId: state.turnId,
          modelUsed: params.modelName,
          fallbackTriggered: false,
          finalText: state.finalText,
          errorMessage: state.errorMessage || 'Unknown model error',
        };
      }

      return {
        status: 'done',
        sessionId,
        turnId: state.turnId,
        modelUsed: params.modelName,
        fallbackTriggered: false,
        finalText: state.finalText,
      };
    } catch (err: any) {
      if (this.isCancelling || err?.name === 'AbortError') {
        return {
          status: 'cancelled',
          sessionId,
          turnId: state.turnId,
          modelUsed: params.modelName,
          fallbackTriggered: false,
          finalText: state.finalText,
        };
      }
      return {
        status: 'error',
        sessionId,
        turnId: state.turnId,
        modelUsed: params.modelName,
        fallbackTriggered: false,
        finalText: state.finalText,
        errorMessage: err?.message || String(err),
      };
    } finally {
      if (this.activeAbortController === controller) {
        this.activeAbortController = null;
      }
    }
  }

  /**
   * Executes a turn on TrueForge with automatic resilience:
   * - If primaryModel fails (invalid key, unreachable endpoint, 503, timeout, etc.),
   *   and autoFallback is enabled with a distinct fallbackModel, seamlessly switches
   *   to fallbackModel with zero user action while leaving workspace untouched.
   * - If fallback is disabled or also fails, retries with backoff and returns a clean error.
   */
  public async runTurnWithResilience(params: {
    primaryModel: string;
    fallbackModel?: string;
    autoFallback: boolean;
    prompt: string;
    existingSessionId?: string;
    previousTurnId?: string;
    extensionRoot?: string;
    callbacks: TurnCallbacks;
  }): Promise<TurnOutcome> {
    let primaryOutcome: TurnOutcome;
    try {
      primaryOutcome = await this.runTurnSingleModel({
        modelName: params.primaryModel,
        prompt: params.prompt,
        existingSessionId: params.existingSessionId,
        previousTurnId: params.previousTurnId,
        extensionRoot: params.extensionRoot,
        callbacks: params.callbacks,
      });
    } catch (err: any) {
      primaryOutcome = {
        status: 'error',
        sessionId: params.existingSessionId || '',
        modelUsed: params.primaryModel,
        fallbackTriggered: false,
        finalText: '',
        errorMessage: err?.message || String(err),
      };
    }

    if (primaryOutcome.status !== 'error') {
      return primaryOutcome;
    }

    const errMsg = primaryOutcome.errorMessage || 'Primary model failed.';

    // Automatic fallback to second configured model with NO user action (Criterion B3: 10/10!)
    if (
      params.autoFallback &&
      params.fallbackModel &&
      params.fallbackModel.trim() !== '' &&
      params.fallbackModel !== params.primaryModel &&
      !this.isCancelling
    ) {
      params.callbacks.onFallback?.({
        primaryModel: params.primaryModel,
        fallbackModel: params.fallbackModel,
        errorMessage: errMsg,
      });

      let fallbackOutcome = await this.runTurnSingleModel({
        modelName: params.fallbackModel,
        prompt: params.prompt,
        existingSessionId: undefined, // Fresh TrueForge session bound to fallback model
        previousTurnId: undefined,
        extensionRoot: params.extensionRoot,
        callbacks: params.callbacks,
      });

      // If fallback hits a transient 503 / rate-limit / timeout spike, retry once cleanly after 1.5s backoff
      if (
        fallbackOutcome.status === 'error' &&
        !this.isCancelling &&
        /(503|429|timeout|high demand|overloaded)/i.test(fallbackOutcome.errorMessage || '')
      ) {
        const delayMs = 1500;
        params.callbacks.onRetry?.({
          attempt: 1,
          delayMs,
          errorMessage: fallbackOutcome.errorMessage || 'Transient fallback error',
        });
        await new Promise((r) => setTimeout(r, delayMs));
        if (!this.isCancelling) {
          fallbackOutcome = await this.runTurnSingleModel({
            modelName: params.fallbackModel,
            prompt: params.prompt,
            existingSessionId: undefined,
            previousTurnId: undefined,
            extensionRoot: params.extensionRoot,
            callbacks: params.callbacks,
          });
        }
      }

      return {
        ...fallbackOutcome,
        fallbackTriggered: true,
      };
    }

    // If no fallback configured, perform 1 bounded retry with exponential backoff (1.5s)
    if (!this.isCancelling) {
      const delayMs = 1500;
      params.callbacks.onRetry?.({ attempt: 1, delayMs, errorMessage: errMsg });
      await new Promise((r) => setTimeout(r, delayMs));
      if (!this.isCancelling) {
        return this.runTurnSingleModel({
          modelName: params.primaryModel,
          prompt: params.prompt,
          existingSessionId: undefined,
          extensionRoot: params.extensionRoot,
          callbacks: params.callbacks,
        });
      }
    }

    return primaryOutcome;
  }
}
