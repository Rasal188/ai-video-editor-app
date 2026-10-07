import { config } from "../../config.js";
import { MockEmailProvider } from "./mockEmailProvider.js";
import { OllastackEmailProvider } from "./ollastackEmailProvider.js";

let currentProvider = null;

/**
 * Creates or retrieves the configured email provider.
 */
export function getEmailProvider(overrideProvider = null) {
  if (overrideProvider) {
    return overrideProvider;
  }
  if (currentProvider) {
    return currentProvider;
  }

  if (config.email.provider === "ollastack" && config.email.ollastack.apiKey) {
    currentProvider = new OllastackEmailProvider({
      baseUrl: config.email.ollastack.baseUrl,
      apiKey: config.email.ollastack.apiKey,
      mailboxId: config.email.ollastack.mailboxId,
    });
  } else {
    currentProvider = new MockEmailProvider();
  }

  return currentProvider;
}

/**
 * Sets an active email provider (useful for testing).
 */
export function setEmailProvider(provider) {
  currentProvider = provider;
}

/**
 * Resets the default email provider.
 */
export function resetEmailProvider() {
  currentProvider = null;
}
