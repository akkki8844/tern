/** Job type names. Kept in one place so producers and consumers cannot drift. */
export const JOB_TYPES = {
  /** Turn a persisted webhook delivery into domain state and follow-up work. */
  WEBHOOK: "webhook.process",
  /** Run the full analysis pipeline for one AnalysisRun. */
  ANALYSIS: "analysis.run"
} as const;

export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];

export interface WebhookJobPayload {
  webhookEventId: string;
  correlationId: string;
}

export interface AnalysisJobPayload {
  analysisRunId: string;
  correlationId: string;
}
