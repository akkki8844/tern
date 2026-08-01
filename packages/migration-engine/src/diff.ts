
export function generateUnifiedDiff(original: string, modified: string, filePath: string): string {
  const origLines = original.split("\n");
  const modLines = modified.split("\n");

  // Compute LCS (Longest Common Subsequence) table
  const m = origLines.length;
  const n = modLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (origLines[i - 1] === modLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find the diff
  const diffOps: Array<{ type: " " | "+" | "-"; line: string }> = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && origLines[i - 1] === modLines[j - 1]) {
      diffOps.unshift({ type: " ", line: origLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diffOps.unshift({ type: "+", line: modLines[j - 1] });
      j--;
    } else if (i > 0) {
      diffOps.unshift({ type: "-", line: origLines[i - 1] });
      i--;
    }
  }

  // Build unified diff output with hunk headers
  const result: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];

  // Group operations into hunks
  const hunks: Array<{ origStart: number; origCount: number; modStart: number; modCount: number; lines: Array<{ type: " " | "+" | "-"; line: string }> }> = [];
  let currentHunk: { origStart: number; origCount: number; modStart: number; modCount: number; lines: Array<{ type: " " | "+" | "-"; line: string }> } | null = null;
  let origLine = 1;
  let modLine = 1;
  let contextLines = 0;
  const CONTEXT_SIZE = 3;

  for (const op of diffOps) {
    if (op.type === " ") {
      // Context line
      if (currentHunk) {
        currentHunk.lines.push(op);
        currentHunk.origCount++;
        currentHunk.modCount++;
        contextLines++;

        // If we have too many context lines, close the hunk
        if (contextLines > CONTEXT_SIZE * 2) {
          // Keep only the last CONTEXT_SIZE lines
          const excess = contextLines - CONTEXT_SIZE;
          currentHunk.lines.splice(currentHunk.lines.length - excess, excess);
          currentHunk.origCount -= excess;
          currentHunk.modCount -= excess;
          hunks.push(currentHunk);
          currentHunk = null;
          contextLines = 0;
        }
      }
      origLine++;
      modLine++;
    } else {
      // Changed line
      if (!currentHunk) {
        currentHunk = {
          origStart: Math.max(1, origLine - CONTEXT_SIZE),
          origCount: 0,
          modStart: Math.max(1, modLine - CONTEXT_SIZE),
          modCount: 0,
          lines: []
        };
        // Add context lines before the change
        const contextStart = Math.max(0, origLine - CONTEXT_SIZE - 1);
        for (let k = contextStart; k < origLine - 1 && k < origLines.length; k++) {
          currentHunk.lines.push({ type: " ", line: origLines[k] });
          currentHunk.origCount++;
          currentHunk.modCount++;
        }
      }

      currentHunk.lines.push(op);
      if (op.type === "-") {
        currentHunk.origCount++;
        origLine++;
      } else {
        currentHunk.modCount++;
        modLine++;
      }
      contextLines = 0;
    }
  }

  if (currentHunk) {
    // Add context lines after the last change
    const contextEnd = Math.min(origLines.length, origLine + CONTEXT_SIZE - 1);
    for (let k = origLine - 1; k < contextEnd; k++) {
      currentHunk.lines.push({ type: " ", line: origLines[k] });
      currentHunk.origCount++;
      currentHunk.modCount++;
    }
    hunks.push(currentHunk);
  }

  // Format hunks
  for (const hunk of hunks) {
    result.push(`@@ -${hunk.origStart},${hunk.origCount} +${hunk.modStart},${hunk.modCount} @@`);
    for (const line of hunk.lines) {
      result.push(`${line.type}${line.line}`);
    }
  }

  return result.join("\n");
}
