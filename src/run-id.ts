const SAFE_RUN_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(?:-\d+)?$/;

export function assertSafeRunId(runId: string): void {
  if (!SAFE_RUN_ID_PATTERN.test(runId)) {
    throw new Error(
      "Invalid run ID. Expected a Traceback run ID like 2026-05-18T11-35-13Z.",
    );
  }
}
