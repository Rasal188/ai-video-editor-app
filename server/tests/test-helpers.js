import { createApp } from "../app.js";
import { createTestPool, setPool, closePool } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { requestOtp, verifyOtp } from "../services/auth/authService.js";
import { MockEmailProvider } from "../services/email/mockEmailProvider.js";
import { setEmailProvider, resetEmailProvider } from "../services/email/emailProvider.js";
import { config } from "../config.js";

export async function withServer(app, testFn) {
  const server = app.listen(0);
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await testFn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

export async function setupTestEnvironment() {
  const mockEmail = new MockEmailProvider();
  setEmailProvider(mockEmail);

  const testPool = await createTestPool();
  setPool(testPool);
  await runMigrations(testPool, { silent: true });

  const app = createApp();

  const createSession = async (email) => {
    await requestOtp({ email }, { executor: testPool, emailProvider: mockEmail });
    const sent = mockEmail.getLatestEmail(email);
    const { rawToken, user } = await verifyOtp({ email, otp: sent.otp }, { executor: testPool });
    return {
      user,
      rawToken,
      cookie: `${config.auth.sessionCookieName}=${rawToken}`,
    };
  };

  const teardown = async () => {
    resetEmailProvider();
    await closePool();
  };

  return { testPool, app, createSession, teardown };
}
