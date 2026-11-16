import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHmac } from "node:crypto";
import { AuthenticationError, ValidationError, secret } from "@capibara/shared";
import {
  parseWebhookPayload,
  requireDeliveryId,
  summariseWebhook,
  verifyWebhookSignature
} from "./webhook.js";

const SECRET_VALUE = "0123456789abcdef-webhook-secret";
const WEBHOOK_SECRET = secret(SECRET_VALUE, "GITHUB_WEBHOOK_SECRET");

function sign(body: string, key = SECRET_VALUE): string {
  return `sha256=${createHmac("sha256", key).update(body, "utf8").digest("hex")}`;
}

const PUSH_BODY = JSON.stringify({
  ref: "refs/heads/main",
  before: "1111111111111111111111111111111111111111",
  after: "2222222222222222222222222222222222222222",
  repository: {
    id: 42,
    name: "acmepay-demo",
    full_name: "capibara-demo/acmepay-demo",
    private: false,
    default_branch: "main",
    html_url: "https://github.com/capibara-demo/acmepay-demo",
    owner: { login: "capibara-demo" }
  },
  installation: { id: 7, account: { login: "capibara-demo" } },
  commits: [{ id: "2222222", added: [], modified: ["openapi.yaml"], removed: [] }]
});

describe("verifyWebhookSignature", () => {
  it("accepts a correct signature", () => {
    assert.equal(verifyWebhookSignature(PUSH_BODY, sign(PUSH_BODY), WEBHOOK_SECRET), true);
  });

  it("rejects a signature produced with a different secret", () => {
    assert.equal(verifyWebhookSignature(PUSH_BODY, sign(PUSH_BODY, "another-secret-value"), WEBHOOK_SECRET), false);
  });

  it("rejects a tampered body", () => {
    const signature = sign(PUSH_BODY);
    const tampered = PUSH_BODY.replace("acmepay-demo", "attacker-repo");
    assert.equal(verifyWebhookSignature(tampered, signature, WEBHOOK_SECRET), false);
  });

  it("rejects a missing header", () => {
    assert.equal(verifyWebhookSignature(PUSH_BODY, null, WEBHOOK_SECRET), false);
    assert.equal(verifyWebhookSignature(PUSH_BODY, "", WEBHOOK_SECRET), false);
  });

  it("rejects sha1 signatures and unprefixed digests", () => {
    const digest = createHmac("sha256", SECRET_VALUE).update(PUSH_BODY).digest("hex");
    assert.equal(verifyWebhookSignature(PUSH_BODY, digest, WEBHOOK_SECRET), false);
    assert.equal(verifyWebhookSignature(PUSH_BODY, `sha1=${digest}`, WEBHOOK_SECRET), false);
  });

  it("rejects malformed hex and truncated digests", () => {
    assert.equal(verifyWebhookSignature(PUSH_BODY, "sha256=nothex", WEBHOOK_SECRET), false);
    assert.equal(verifyWebhookSignature(PUSH_BODY, `sha256=${"a".repeat(63)}`, WEBHOOK_SECRET), false);
    assert.equal(verifyWebhookSignature(PUSH_BODY, `sha256=${"a".repeat(65)}`, WEBHOOK_SECRET), false);
  });

  it("rejects everything when the secret is empty", () => {
    const empty = secret("", "GITHUB_WEBHOOK_SECRET");
    assert.equal(verifyWebhookSignature(PUSH_BODY, sign(PUSH_BODY, ""), empty), false);
  });

  it("is case-insensitive about the hex digest casing GitHub sends", () => {
    const signature = sign(PUSH_BODY).toUpperCase().replace("SHA256=", "sha256=");
    assert.equal(verifyWebhookSignature(PUSH_BODY, signature, WEBHOOK_SECRET), true);
  });
});

describe("parseWebhookPayload", () => {
  it("parses a push event", () => {
    const parsed = parseWebhookPayload("push", PUSH_BODY);
    assert.equal(parsed.event, "push");
    if (parsed.event !== "push") return;
    assert.equal(parsed.payload.repository.full_name, "capibara-demo/acmepay-demo");
    assert.equal(parsed.payload.installation?.id, 7);
  });

  it("rejects invalid JSON", () => {
    assert.throws(() => parseWebhookPayload("push", "{not json"), ValidationError);
  });

  it("rejects a JSON array body", () => {
    assert.throws(() => parseWebhookPayload("push", "[]"), ValidationError);
  });

  it("rejects a push event that is missing required fields", () => {
    assert.throws(() => parseWebhookPayload("push", JSON.stringify({ ref: "refs/heads/main" })), ValidationError);
  });

  it("rejects a push event with the wrong field types", () => {
    const body = JSON.parse(PUSH_BODY);
    body.repository.id = "forty-two";
    assert.throws(() => parseWebhookPayload("push", JSON.stringify(body)), ValidationError);
  });

  it("classifies unknown events as unsupported rather than failing", () => {
    const parsed = parseWebhookPayload("star", JSON.stringify({ action: "created" }));
    assert.equal(parsed.event, "unsupported");
  });

  it("parses installation and pull_request events", () => {
    const installation = parseWebhookPayload(
      "installation",
      JSON.stringify({ action: "created", installation: { id: 7, account: { login: "acme" } } })
    );
    assert.equal(installation.event, "installation");

    const pr = parseWebhookPayload(
      "pull_request",
      JSON.stringify({
        action: "closed",
        number: 3,
        pull_request: { number: 3, merged: true, state: "closed" },
        repository: { id: 1, name: "r", full_name: "o/r" }
      })
    );
    assert.equal(pr.event, "pull_request");
  });
});

describe("requireDeliveryId", () => {
  it("accepts a plausible delivery id", () => {
    assert.equal(requireDeliveryId("72d3162e-cc78-11e3-81ab-4c9367dc0958"), "72d3162e-cc78-11e3-81ab-4c9367dc0958");
  });

  it("rejects missing or absurd values", () => {
    assert.throws(() => requireDeliveryId(null), AuthenticationError);
    assert.throws(() => requireDeliveryId("short"), AuthenticationError);
    assert.throws(() => requireDeliveryId("x".repeat(500)), AuthenticationError);
  });
});

describe("summariseWebhook", () => {
  it("produces a compact, non-sensitive projection", () => {
    const summary = summariseWebhook(parseWebhookPayload("push", PUSH_BODY));
    assert.deepEqual(summary, {
      ref: "refs/heads/main",
      before: "1111111111111111111111111111111111111111",
      after: "2222222222222222222222222222222222222222",
      repository: "capibara-demo/acmepay-demo",
      commitCount: 1
    });
  });
});
