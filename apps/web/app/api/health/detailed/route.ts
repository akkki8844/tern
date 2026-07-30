import { NextResponse } from "next/server";
import { CompositeHealthChecker } from "@tern/shared";

export async function GET() {
  const checker = new CompositeHealthChecker({
    web: async () => true
  });
  const result = await checker.check();
  return NextResponse.json(result);
}
