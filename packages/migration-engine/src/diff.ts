
export function generateUnifiedDiff(original: string, modified: string, filePath: string): string {
  const origLines = original.split("\n");
  const modLines = modified.split("\n");
  const diff: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];
  let i = 0, j = 0;
  while (i < origLines.length || j < modLines.length) {
    if (i < origLines.length && j < modLines.length && origLines[i] === modLines[j]) {
      diff.push(` ${origLines[i]}`);
      i++; j++;
    } else if (j < modLines.length) {
      diff.push(`+${modLines[j]}`);
      j++;
    } else if (i < origLines.length) {
      diff.push(`-${origLines[i]}`);
      i++;
    }
  }
  return diff.join("\n");
}
