import { NextResponse } from "next/server";
import { analysisQueue } from "@/lib/jobs/queue";

export async function POST() {
  const job = await analysisQueue.add("analysis", { trigger: "manual" });
  return NextResponse.json({ queued: true, jobId: job.id });
}
