import { NextResponse } from "next/server";
import { toTernError } from "@/packages/shared/src/errors";

export function errorResponse(error: unknown) {
  const normalized = toTernError(error);
  return NextResponse.json(
    {
      error: normalized.message,
      code: normalized.code,
      details: normalized.details,
    },
    { status: normalized.status },
  );
}
