/**
 * Mock email provider for automated tests and local development.
 * Captures sent emails in-memory without making network calls.
 */
export class MockEmailProvider {
  constructor() {
    this.sentEmails = [];
  }

  /**
   * Simulates sending an OTP email.
   */
  async sendOtpEmail({ email, otp, expiresInMinutes = 10 }) {
    const record = {
      to: email,
      subject: "Your Timeline Studio Verification Code",
      otp,
      expiresInMinutes,
      sentAt: new Date().toISOString(),
      text: `Your verification code is: ${otp}\nThis code expires in ${expiresInMinutes} minutes.`,
      html: `<p>Your verification code is: <strong>${otp}</strong></p>`,
    };
    this.sentEmails.push(record);
    return {
      success: true,
      messageId: `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
  }

  /**
   * Retrieves the most recent email sent to a specific address.
   */
  getLatestEmail(email = null) {
    if (!email) {
      return this.sentEmails[this.sentEmails.length - 1] || null;
    }
    const filtered = this.sentEmails.filter((m) => m.to.toLowerCase() === email.toLowerCase());
    return filtered[filtered.length - 1] || null;
  }

  /**
   * Retrieves all emails sent to a specific address.
   */
  getEmailsFor(email) {
    return this.sentEmails.filter((m) => m.to.toLowerCase() === email.toLowerCase());
  }

  /**
   * Clears the sent email log.
   */
  clear() {
    this.sentEmails = [];
  }
}
