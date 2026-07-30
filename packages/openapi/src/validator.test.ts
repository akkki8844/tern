
    import { describe, it } from "node:test";
    import assert from "node:assert";
    import { DefaultSpecValidator } from "./validator";
    import { loadFromString } from "./spec-loader";

    describe("DefaultSpecValidator", () => {
      it("validates spec", async () => {
        const spec = loadFromString("openapi: `3.0.0`
info:
  title: T
  version: `1.0.0`
paths: {}");
        const issues = await new DefaultSpecValidator().validate(spec);
        assert.ok(issues.some(i => i.message.includes("No paths")));
      });
    });
