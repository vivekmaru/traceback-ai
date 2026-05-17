import { describe, expect, test } from "bun:test";
import { getTracebackPaths } from "../src/storage";

describe("getTracebackPaths", () => {
  test("uses .traceback as the local data directory", () => {
    expect(getTracebackPaths("/tmp/example-repo")).toEqual({
      root: "/tmp/example-repo",
      dir: "/tmp/example-repo/.traceback",
      imports: "/tmp/example-repo/.traceback/imports",
      records: "/tmp/example-repo/.traceback/records",
      reports: "/tmp/example-repo/.traceback/reports",
    });
  });
});
