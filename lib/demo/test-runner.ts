export function runDemoTests(files: Record<string, string>): { passed: boolean; output: string } {
  const client = files["src/acmeClient.ts"] ?? "";
  const checks = [
    { ok: client.includes("/v2/payments"), msg: "endpoint migrated" },
    { ok: client.includes("currency"), msg: "required currency added" },
    { ok: !client.includes("statusText") && client.includes("state"), msg: "response field migrated" },
  ];

  const failed = checks.filter((check) => !check.ok);
  if (failed.length) {
    return { passed: false, output: failed.map((check) => `FAIL: ${check.msg}`).join("\n") };
  }
  return { passed: true, output: "All AcmePay migration checks passed" };
}
