export class EmailDeliveryError extends Error {
  constructor(message, { code = "EMAIL_DELIVERY_FAILED", status = null, cause = null } = {}) {
    super(message);
    this.name = "EmailDeliveryError";
    this.code = code;
    this.status = status;
    this.cause = cause;
  }
}

/**
 * Official OllaStack Email Provider.
 * Conforms to the official OllaStack OpenAPI 3.1 specification:
 * POST /api/mailboxes/{mailboxId}/send
 * Header: Authorization: Bearer <API_KEY>
 */
export class OllastackEmailProvider {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || "https://login.ollastack.com").replace(/\/+$/, "");
    this.apiKey = options.apiKey || "";
    this.mailboxId = options.mailboxId || "";
    this.timeoutMs = options.timeoutMs || 10000;
  }

  /**
   * Verifies required credentials are present.
   */
  validateConfig() {
    if (!this.apiKey) {
      throw new EmailDeliveryError("OllaStack API key is not configured.", {
        code: "MISSING_OLLASTACK_API_KEY",
      });
    }
    if (!this.mailboxId) {
      throw new EmailDeliveryError("OllaStack Mailbox ID is not configured.", {
        code: "MISSING_OLLASTACK_MAILBOX_ID",
      });
    }
  }

  /**
   * Sends an OTP verification email through OllaStack.
   */
  async sendOtpEmail({ email, otp, expiresInMinutes = 10 }) {
    this.validateConfig();

    const url = `${this.baseUrl}/api/mailboxes/${encodeURIComponent(this.mailboxId)}/send`;
    const subject = "Your Timeline Studio Verification Code";
    const text = [
      `Your verification code is: ${otp}`,
      "",
      `This code will expire in ${expiresInMinutes} minutes.`,
      "If you did not request this verification code, please ignore this email.",
    ].join("\n");

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px;">
        <h2 style="color: #0f172a; margin-top: 0;">Timeline Studio</h2>
        <p style="color: #475569; font-size: 15px;">Use the following verification code to complete sign in:</p>
        <div style="background-color: #f1f5f9; padding: 16px; border-radius: 6px; text-align: center; margin: 24px 0;">
          <span style="font-family: monospace; font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #0284c7;">${otp}</span>
        </div>
        <p style="color: #64748b; font-size: 13px;">This code expires in <strong>${expiresInMinutes} minutes</strong>.</p>
        <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
        <p style="color: #94a3b8; font-size: 12px; margin-bottom: 0;">If you did not request this code, you can safely ignore this message.</p>
      </div>
    `.trim();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify({
          to: email,
          subject,
          text,
          html,
        }),
        signal: controller.signal,
      });

      let responseData = null;
      try {
        responseData = await response.json();
      } catch {
        // Non-JSON response body
      }

      if (!response.ok) {
        const errorMsg =
          responseData?.message ||
          responseData?.error ||
          `OllaStack returned HTTP status ${response.status}`;
        throw new EmailDeliveryError(errorMsg, {
          code: "OLLASTACK_API_ERROR",
          status: response.status,
        });
      }

      return {
        success: true,
        messageId: responseData?.data?.id || null,
      };
    } catch (err) {
      if (err.name === "AbortError") {
        throw new EmailDeliveryError("OllaStack API request timed out.", {
          code: "OLLASTACK_TIMEOUT",
        });
      }
      if (err instanceof EmailDeliveryError) {
        throw err;
      }
      throw new EmailDeliveryError(`Network error while contacting OllaStack: ${err.message}`, {
        code: "OLLASTACK_NETWORK_ERROR",
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
