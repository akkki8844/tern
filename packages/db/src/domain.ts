export type Timestamped = {
  createdAt: Date;
  updatedAt: Date;
};

export type SoftDelete = {
  deletedAt: Date | null;
};

export type OrganizationRole = "owner" | "admin" | "member";

export type RunStatus =
  | "queued"
  | "running"
  | "failed"
  | "completed"
  | "cancelled"
  | "timed_out"
  | "blocked";

export type PatchStatus = "generated" | "validated" | "rejected" | "approved";

export type SandboxOutcome = "passed" | "failed" | "timed_out" | "blocked";
