
    import { describe, it } from "node:test";
    import assert from "node:assert";
    import { loadFromString } from "./spec-loader";

    describe("SpecLoader", () => {
      it("parses YAML", () => {
        const spec = loadFromString("openapi: "3.0.0"
info:
  title: T
  version: "1.0.0"
paths: {}");
        assert.strictEqual(spec.info.title, "T");
      });
    });
