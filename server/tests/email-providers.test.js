import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MockEmailProvider } from "../services/email/mockEmailProvider.js";
import {
  OllastackEmailProvider,
  EmailDeliveryError,
} from "../services/email/ollastackEmailProvider.js";

describe("Email Providers", () => {
  describe("MockEmailProvider", () => {
    it("should capture sent emails in-memory and support queries", async () => {
      const mock = new MockEmailProvider();
      assert.equal(mock.sentEmails.length, 0);

      const res = await mock.sendOtpEmail({
        email: "alice@example.com",
        otp: "123456",
        expiresInMinutes: 10,
      });

      assert.ok(res.success);
      assert.equal(mock.sentEmails.length, 1);

      const last = mock.getLatestEmail("alice@example.com");
      assert.ok(last);
      assert.equal(last.to, "alice@example.com");
      assert.equal(last.otp, "123456");
      assert.equal(last.expiresInMinutes, 10);
      assert.ok(last.text.includes("123456"));
      assert.ok(last.html.includes("123456"));

      mock.clear();
      assert.equal(mock.sentEmails.length, 0);
      assert.equal(mock.getLatestEmail(), null);
    });
  });

  describe("OllastackEmailProvider", () => {
    it("should enforce required configuration", async () => {
      const missingKey = new OllastackEmailProvider({
        baseUrl: "https://login.ollastack.com",
        mailboxId: "mb_123",
      });
      await assert.rejects(
        () => missingKey.sendOtpEmail({ email: "test@example.com", otp: "123456" }),
        (err) => err instanceof EmailDeliveryError && err.code === "MISSING_OLLASTACK_API_KEY"
      );

      const missingMailbox = new OllastackEmailProvider({
        baseUrl: "https://login.ollastack.com",
        apiKey: "tok_secret_123",
      });
      await assert.rejects(
        () => missingMailbox.sendOtpEmail({ email: "test@example.com", otp: "123456" }),
        (err) => err instanceof EmailDeliveryError && err.code === "MISSING_OLLASTACK_MAILBOX_ID"
      );
    });

    it("should format requests according to official OpenAPI spec", async () => {
      let interceptedUrl = null;
      let interceptedHeaders = null;
      let interceptedBody = null;

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url, options) => {
        interceptedUrl = url;
        interceptedHeaders = options.headers;
        interceptedBody = JSON.parse(options.body);

        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { id: "msg_out_test_999", direction: "outbound" },
          }),
        };
      };

      try {
        const provider = new OllastackEmailProvider({
          baseUrl: "https://login.ollastack.com",
          apiKey: "tok_test_api_key_123",
          mailboxId: "mb_agent_456",
        });

        const result = await provider.sendOtpEmail({
          email: "recipient@example.com",
          otp: "654321",
          expiresInMinutes: 10,
        });

        assert.equal(result.success, true);
        assert.equal(result.messageId, "msg_out_test_999");

        // Verify OpenAPI-compliant request formatting
        assert.equal(interceptedUrl, "https://login.ollastack.com/api/mailboxes/mb_agent_456/send");
        assert.equal(interceptedHeaders["Authorization"], "Bearer tok_test_api_key_123");
        assert.equal(interceptedHeaders["Content-Type"], "application/json");
        assert.equal(interceptedBody.to, "recipient@example.com");
        assert.equal(interceptedBody.subject, "Your Timeline Studio Verification Code");
        assert.ok(interceptedBody.text.includes("654321"));
        assert.ok(interceptedBody.html.includes("654321"));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should handle provider HTTP errors without leaking secrets", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => ({
        ok: false,
        status: 401,
        json: async () => ({
          error: "Unauthorized: Token lacks mail.agent:send scope",
        }),
      });

      try {
        const provider = new OllastackEmailProvider({
          baseUrl: "https://login.ollastack.com",
          apiKey: "super_secret_token_never_leak",
          mailboxId: "mb_agent_456",
        });

        await assert.rejects(
          () => provider.sendOtpEmail({ email: "recipient@example.com", otp: "112233" }),
          (err) => {
            assert.ok(err instanceof EmailDeliveryError);
            assert.equal(err.code, "OLLASTACK_API_ERROR");
            assert.equal(err.status, 401);
            assert.ok(!err.message.includes("super_secret_token_never_leak"));
            return true;
          }
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should handle network timeouts gracefully", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        throw error;
      };

      try {
        const provider = new OllastackEmailProvider({
          baseUrl: "https://login.ollastack.com",
          apiKey: "tok_test_123",
          mailboxId: "mb_123",
        });

        await assert.rejects(
          () => provider.sendOtpEmail({ email: "user@example.com", otp: "998877" }),
          (err) => {
            assert.ok(err instanceof EmailDeliveryError);
            assert.equal(err.code, "OLLASTACK_TIMEOUT");
            return true;
          }
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
