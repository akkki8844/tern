import { NextResponse } from "next/server";
import { analysisQueue } from "@/lib/jobs/queue";
import { errorResponse, logger } from "@/packages/shared/src";

export async function POST() {
  try {
    const job = await analysisQueue.add("analysis", { trigger: "manual" });
    logger.info("analysis_queued", { jobId: job.id });
    return NextResponse.json({ queued: true, jobId: job.id });
  } catch (error) {
    logger.error("analysis_queue_failed", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return errorResponse(error);
  }
}
