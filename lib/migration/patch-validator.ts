export type PatchValidationInput = {
  patch: string;
  allowedFiles: string[];
};

const blockedPatterns = [/package-lock\.json/, /pnpm-lock\.yaml/, /yarn\.lock/, /node_modules/, /process\.env\./i];

export function validatePatch({ patch, allowedFiles }: PatchValidationInput): { valid: boolean; reason?: string } {
  const touchedFiles = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]);
  if (!touchedFiles.length) {
    return { valid: false, reason: "Patch must contain at least one file" };
  }

  for (const touched of touchedFiles) {
    if (!allowedFiles.includes(touched)) {
      return { valid: false, reason: `Patch touched unrelated file: ${touched}` };
    }
  }

  if (blockedPatterns.some((pattern) => pattern.test(patch))) {
    return { valid: false, reason: "Patch touched blocked content" };
  }

  return { valid: true };
}
