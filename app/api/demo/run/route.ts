import { NextResponse } from "next/server";
import { runDemoMigration } from "@/lib/demo/flow";

export async function POST() {
  try {
    const result = runDemoMigration();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown demo error" },
      { status: 500 },
    );
  }
}
