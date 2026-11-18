import * as fs from 'fs';
import * as path from 'path';

export interface SelectedContextItem {
  relativePath: string;
  score: number;
  estimatedTokens: number;
  reason: string;
  matchedSymbols: string[];
  lineRange?: { start: number; end: number };
  excerpt: string;
  explicit: boolean;
}

export interface ExcludedContextItem {
  relativePath: string;
  score: number;
  estimatedTokens: number;
  reason: string;
}

export interface ContextSelectionReport {
  query: string;
  tokenBudget: number;
  tokensUsed: number;
  totalFilesScanned: number;
  selected: SelectedContextItem[];
  excludedByBudget: ExcludedContextItem[];
  explicitMentions: string[];
  timestamp: string;
}

export interface SymbolMatch {
  name: string;
  kind: 'function' | 'class' | 'method' | 'command' | 'heading';
  relativePath: string;
  line: number;
}

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  '.pytest_cache',
  '.mypy_cache',
  '.tox',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  '.egg-info',
]);

const TEXT_EXTENSIONS = new Set([
  '.py',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.rst',
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.cfg',
  '.ini',
  '.html',
  '.css',
  '.sh',
  '.sql',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.cpp',
  '.h',
]);

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'have',
  'must', 'also', 'well', 'list', 'every', 'value', 'values', 'treated', 'add',
  'new', 'any', 'all', 'are', 'was', 'were', 'been', 'being', 'will', 'would',
  'should', 'could', 'when', 'where', 'what', 'which', 'how', 'not', 'but',
  'its', 'our', 'their', 'they', 'them', 'then', 'than', 'only', 'just', 'like',
  'make', 'update', 'change', 'file', 'files', 'code', 'function', 'other',
  'prints', 'appear', 'covered', 'alongside', 'containing', 'loaded', 'application',
  'documented', 'built', 'commands', 'command', 'test', 'tests',
]);

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function listWorkspaceFiles(workspaceRoot: string, maxFiles = 1500): string[] {
  const results: string[] = [];

  function walk(dir: string) {
    if (results.length >= maxFiles) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) {
        return;
      }
      if (entry.name.startsWith('.') && entry.name !== '.github') {
        if (IGNORED_DIRS.has(entry.name)) {
          continue;
        }
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.endsWith('.egg-info')) {
          continue;
        }
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (TEXT_EXTENSIONS.has(ext)) {
          results.push(path.relative(workspaceRoot, fullPath).replace(/\\/g, '/'));
        }
      }
    }
  }

  walk(workspaceRoot);
  return results.sort();
}

export function extractSymbolsFromContent(relativePath: string, content: string): SymbolMatch[] {
  const symbols: SymbolMatch[] = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Python def / async def
    const pyDef = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (pyDef) {
      symbols.push({
        name: pyDef[1],
        kind: line.startsWith(' ') || line.startsWith('\t') ? 'method' : 'function',
        relativePath,
        line: i + 1,
      });
      continue;
    }

    // Python / TS / JS class
    const cls = line.match(/^\s*(?:export\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (cls) {
      symbols.push({
        name: cls[1],
        kind: 'class',
        relativePath,
        line: i + 1,
      });
      continue;
    }

    // TS / JS function
    const tsFn = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (tsFn) {
      symbols.push({
        name: tsFn[1],
        kind: 'function',
        relativePath,
        line: i + 1,
      });
      continue;
    }

    // Click CLI commands: @click.command("routes") or @cli.command("...")
    const clickCmd = line.match(/@[A-Za-z0-9_.]*command\s*\(\s*["']([^"']+)["']/);
    if (clickCmd) {
      symbols.push({
        name: `cli:${clickCmd[1]}`,
        kind: 'command',
        relativePath,
        line: i + 1,
      });
    }
  }

  return symbols;
}

export function indexWorkspaceSymbols(workspaceRoot: string, maxFiles = 400): SymbolMatch[] {
  const files = listWorkspaceFiles(workspaceRoot, maxFiles);
  const allSymbols: SymbolMatch[] = [];
  for (const rel of files) {
    if (!/\.(py|ts|tsx|js|jsx)$/.test(rel)) {
      continue;
    }
    try {
      const fullPath = path.join(workspaceRoot, rel);
      const stat = fs.statSync(fullPath);
      if (stat.size > 300_000) {
        continue;
      }
      const content = fs.readFileSync(fullPath, 'utf8');
      allSymbols.push(...extractSymbolsFromContent(rel, content));
    } catch {
      // skip unreadable
    }
  }
  return allSymbols;
}

export function parseMentions(prompt: string): { fileMentions: string[]; symbolMentions: string[] } {
  const fileMentions: string[] = [];
  const symbolMentions: string[] = [];

  // Supports @file:src/flask/cli.py, @symbol:get_debug_flag, or shorthand @src/flask/cli.py / @get_debug_flag
  const regex = /@(?:(file|symbol):)?([A-Za-z0-9_./\\-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(prompt)) !== null) {
    const kind = match[1];
    const target = match[2].replace(/\\/g, '/');
    if (kind === 'file' || target.includes('/') || /\.[a-z0-9]{1,5}$/i.test(target)) {
      fileMentions.push(target);
    } else if (kind === 'symbol' || target.length >= 3) {
      symbolMentions.push(target);
    }
  }

  return {
    fileMentions: [...new Set(fileMentions)],
    symbolMentions: [...new Set(symbolMentions)],
  };
}

function tokenizeQuery(query: string): string[] {
  const raw = query
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
  return [...new Set(raw)];
}

function splitPathSegments(relPath: string): string[] {
  return relPath
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, '')
    .split(/[/\\._-]+/)
    .filter(Boolean);
}

function buildSmartExcerpt(
  content: string,
  tokens: string[],
  maxChars: number
): { excerpt: string; lineRange?: { start: number; end: number } } {
  if (content.length <= maxChars) {
    return { excerpt: content };
  }

  const lines = content.split(/\r?\n/);
  // Score every line by keyword hits and pick best contiguous window(s)
  const lineScores = lines.map((line) => {
    const lower = line.toLowerCase();
    let score = 0;
    for (const tok of tokens) {
      if (lower.includes(tok)) {
        score += 2;
      }
    }
    if (/^\s*(def |class |@click\.|@.*command)/.test(line)) {
      score += 1;
    }
    return score;
  });

  // Always include top header (imports/overview) + highest scoring window
  const headerLines = Math.min(45, lines.length);
  let bestStart = headerLines;
  let bestWindowScore = -1;
  const windowSize = 90;

  for (let i = headerLines; i < Math.max(headerLines + 1, lines.length - windowSize); i += 10) {
    let s = 0;
    for (let j = i; j < Math.min(lines.length, i + windowSize); j++) {
      s += lineScores[j];
    }
    if (s > bestWindowScore) {
      bestWindowScore = s;
      bestStart = i;
    }
  }

  const head = lines
    .slice(0, headerLines)
    .map((l, idx) => `${idx + 1}: ${l}`)
    .join('\n');

  const bodyEnd = Math.min(lines.length, bestStart + windowSize);
  const body = lines
    .slice(bestStart, bodyEnd)
    .map((l, idx) => `${bestStart + idx + 1}: ${l}`)
    .join('\n');

  let combined = `${head}\n... [truncated for context budget; call read_file for full range] ...\n${body}`;
  if (combined.length > maxChars) {
    combined = combined.slice(0, maxChars) + '\n... [truncated at budget cap]';
  }

  return {
    excerpt: combined,
    lineRange: { start: bestStart + 1, end: bodyEnd },
  };
}

export function assembleWorkspaceContext(
  workspaceRoot: string,
  query: string,
  tokenBudget = 4500,
  explicitFiles: string[] = [],
  explicitSymbols: string[] = []
): ContextSelectionReport {
  const allFiles = listWorkspaceFiles(workspaceRoot);
  const parsed = parseMentions(query);
  const fileMentions = [...new Set([...explicitFiles, ...parsed.fileMentions])];
  const symbolMentions = [...new Set([...explicitSymbols, ...parsed.symbolMentions])];

  const queryLower = query.toLowerCase();
  const queryTokens = tokenizeQuery(query);
  const wantsTests = /\b(test|tests|pytest|unittest|covered)\b/i.test(query);
  const wantsDocs = /\b(doc|docs|document|documented|documentation|readme|rst)\b/i.test(query);
  const wantsCli = /\b(cli|command|--help|click|subcommand|built-in)\b/i.test(query);

  interface Candidate {
    relativePath: string;
    score: number;
    reasons: string[];
    matchedSymbols: string[];
    content: string;
    explicit: boolean;
  }

  const candidates: Candidate[] = [];

  // Preload readable files & compute document frequency for IDF weighting
  const loadedFiles: Array<{ rel: string; content: string; contentLower: string }> = [];
  const docFreq = new Map<string, number>();

  for (const rel of allFiles) {
    const fullPath = path.join(workspaceRoot, rel);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.size > 400_000) {
        continue;
      }
      const content = fs.readFileSync(fullPath, 'utf8');
      const contentLower = content.toLowerCase();
      loadedFiles.push({ rel, content, contentLower });
      for (const tok of queryTokens) {
        if (contentLower.includes(tok)) {
          docFreq.set(tok, (docFreq.get(tok) || 0) + 1);
        }
      }
    } catch {
      continue;
    }
  }

  const totalDocs = Math.max(1, loadedFiles.length);
  const idf = (tok: string) => Math.log(1 + totalDocs / (1 + (docFreq.get(tok) || 0)));

  for (const { rel, content, contentLower } of loadedFiles) {
    const relLower = rel.toLowerCase();
    const baseName = path.basename(relLower, path.extname(relLower));
    const segments = splitPathSegments(relLower);
    let score = 0;
    const reasons: string[] = [];
    const matchedSymbols: string[] = [];
    let isExplicit = false;

    // 1. Explicit @file mentions get highest priority
    for (const fm of fileMentions) {
      if (relLower === fm.toLowerCase() || relLower.endsWith('/' + fm.toLowerCase()) || relLower.endsWith(fm.toLowerCase())) {
        score += 120;
        isExplicit = true;
        reasons.push(`Explicit @file mention (${fm})`);
      }
    }

    // 2. Explicit @symbol mentions
    for (const sm of symbolMentions) {
      const symRegex = new RegExp(`\\b(?:def|class|function)\\s+${sm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      if (symRegex.test(content)) {
        score += 95;
        isExplicit = true;
        matchedSymbols.push(sm);
        reasons.push(`Defines explicitly mentioned @symbol ${sm}`);
      } else if (content.includes(sm)) {
        score += 20;
        reasons.push(`References @symbol ${sm}`);
      }
    }

    // 3. Exact path-segment match weighted by IDF (no noisy substring matches like "as" in "basic")
    const matchedPathTokens: string[] = [];
    for (const tok of queryTokens) {
      const weight = idf(tok);
      if (baseName === tok || segments.includes(tok)) {
        score += Math.round(14 * weight);
        matchedPathTokens.push(tok);
      }
    }
    if (matchedPathTokens.length > 0) {
      reasons.push(`Exact path segment match: ${[...new Set(matchedPathTokens)].slice(0, 4).join(', ')}`);
    }

    // 4. Symbol definition matching (sublinear cap so giant test files never drown out source/docs)
    const symbols = extractSymbolsFromContent(rel, content);
    let symbolPoints = 0;
    for (const sym of symbols) {
      const symParts = sym.name.toLowerCase().split(/[_\-:]+/);
      for (const tok of queryTokens) {
        if (symParts.includes(tok)) {
          symbolPoints += 4 * idf(tok);
          if (!matchedSymbols.includes(sym.name)) {
            matchedSymbols.push(sym.name);
          }
          break;
        }
      }
    }
    if (matchedSymbols.length > 0) {
      score += Math.min(28, symbolPoints);
      if (!isExplicit) {
        reasons.push(`Defines relevant symbols: ${matchedSymbols.slice(0, 4).join(', ')}`);
      }
    }

    // 5. Architectural role & intent boosts (src + tests + docs)
    if (wantsCli) {
      if (segments.includes('cli') && relLower.includes('src/')) {
        score += 48;
        reasons.push('Core CLI module defining built-in Click commands & FlaskGroup');
      } else if (segments.includes('cli') && relLower.startsWith('tests/')) {
        score += wantsTests ? 46 : 38;
        reasons.push('Dedicated CLI test suite covering built-in commands');
      } else if (segments.includes('cli') && relLower.startsWith('docs/')) {
        score += wantsDocs ? 44 : 36;
        reasons.push('Official CLI documentation listing built-in commands');
      }
    }

    // 6. IDF-weighted content keyword density (capped)
    let idfContentScore = 0;
    let contentHits = 0;
    for (const tok of queryTokens) {
      if (contentLower.includes(tok)) {
        contentHits++;
        idfContentScore += 2.5 * idf(tok);
      }
    }
    if (contentHits > 0) {
      score += Math.min(24, idfContentScore);
      if (reasons.length === 0) {
        reasons.push(`Contains ${contentHits} high-IDF query terms`);
      }
    }

    // De-prioritize changelog/examples unless explicitly asked
    if (relLower.includes('changes.rst') || relLower.startsWith('examples/')) {
      score *= 0.25;
    }

    if (score >= 6 || isExplicit) {
      candidates.push({
        relativePath: rel,
        score: Math.round(score * 10) / 10,
        reasons: [...new Set(reasons)],
        matchedSymbols: matchedSymbols.slice(0, 6),
        content,
        explicit: isExplicit,
      });
    }
  }

  // Sort by explicit first, then descending relevance score
  candidates.sort((a, b) => {
    if (a.explicit !== b.explicit) {
      return a.explicit ? -1 : 1;
    }
    return b.score - a.score;
  });

  const selected: SelectedContextItem[] = [];
  const excludedByBudget: ExcludedContextItem[] = [];
  let tokensUsed = 0;

  // Per-file cap calibrated so top 4-5 files share the budget cleanly without exceeding TrueForge's 24k-char tool limit
  const perFileMaxTokens = Math.max(700, Math.floor(tokenBudget * 0.28));

  for (const cand of candidates) {
    const remaining = tokenBudget - tokensUsed;
    const rawTokens = estimateTokens(cand.content);

    if (remaining < 300 && !cand.explicit) {
      excludedByBudget.push({
        relativePath: cand.relativePath,
        score: cand.score,
        estimatedTokens: rawTokens,
        reason: `Excluded: budget full (${tokensUsed}/${tokenBudget} tokens used)`,
      });
      continue;
    }

    const allowedTokens = Math.min(perFileMaxTokens, Math.max(350, remaining));
    const maxChars = allowedTokens * 4;
    const { excerpt, lineRange } = buildSmartExcerpt(cand.content, queryTokens, maxChars);
    const excerptTokens = estimateTokens(excerpt);

    if (tokensUsed + excerptTokens > tokenBudget && selected.length >= 3 && !cand.explicit) {
      excludedByBudget.push({
        relativePath: cand.relativePath,
        score: cand.score,
        estimatedTokens: rawTokens,
        reason: `Excluded: would exceed ${tokenBudget} token budget`,
      });
      continue;
    }

    tokensUsed += excerptTokens;
    selected.push({
      relativePath: cand.relativePath,
      score: cand.score,
      estimatedTokens: excerptTokens,
      reason: cand.reasons.join('; ') || 'Keyword relevance match',
      matchedSymbols: cand.matchedSymbols,
      lineRange,
      excerpt,
      explicit: cand.explicit,
    });

    // Cap at 5 files max so context stays compact and well inside TrueForge's 24k-char response limit
    if (selected.length >= 5 && !cand.explicit) {
      const restIdx = candidates.indexOf(cand) + 1;
      for (const rest of candidates.slice(restIdx, restIdx + 6)) {
        excludedByBudget.push({
          relativePath: rest.relativePath,
          score: rest.score,
          estimatedTokens: estimateTokens(rest.content),
          reason: `Excluded: top-5 budget cap (${tokensUsed}/${tokenBudget} tokens used)`,
        });
      }
      break;
    }
  }

  return {
    query,
    tokenBudget,
    tokensUsed,
    totalFilesScanned: allFiles.length,
    selected,
    excludedByBudget: excludedByBudget.slice(0, 6),
    explicitMentions: [...fileMentions.map((f) => `@${f}`), ...symbolMentions.map((s) => `@${s}`)],
    timestamp: new Date().toISOString(),
  };
}
