export type BreakingChangeType =
  | "removed_endpoint"
  | "changed_http_method"
  | "removed_operation_id"
  | "renamed_path_parameter"
  | "removed_required_request_parameter"
  | "added_required_request_parameter"
  | "renamed_request_body_field"
  | "removed_response_field"
  | "renamed_response_field"
  | "changed_enum_values"
  | "changed_sdk_method";

export type BreakingChange = {
  type: BreakingChangeType;
  severity: "high" | "medium";
  endpoint?: string;
  operationId?: string;
  oldValue?: string;
  newValue?: string;
  confidence: number;
};

export type AffectedUsage = {
  filePath: string;
  line: number;
  snippet: string;
  matchedSymbol: string;
  confidence: number;
};

export type MigrationPatch = {
  filePath: string;
  patch: string;
  rule: string;
  confidence: number;
};

export type AnalysisResult = {
  commitSha: string;
  confidence: number;
  breakingChanges: BreakingChange[];
  affectedUsages: AffectedUsage[];
  patches: MigrationPatch[];
};
