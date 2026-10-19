import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distAssetsDir = path.resolve(__dirname, "../../dist/assets");
const viteConfigPath = path.resolve(__dirname, "../../vite.config.mjs");

test("Security Regression: window.__PROJECT_SNAPSHOT__ is absent from all production bundles", () => {
  assert.ok(fs.existsSync(distAssetsDir), "dist/assets directory must exist (run npm run build first)");
  const files = fs.readdirSync(distAssetsDir).filter((f) => f.endsWith(".js") || f.endsWith(".mjs"));
  assert.ok(files.length > 0, "Production bundle must contain generated JS files");

  for (const file of files) {
    const content = fs.readFileSync(path.join(distAssetsDir, file), "utf8");
    assert.equal(
      content.includes("__PROJECT_SNAPSHOT__"),
      false,
      `Forbidden identifier __PROJECT_SNAPSHOT__ found in production artifact: ${file}`
    );
  }
});

test("Security Regression: _virtual_devTestBridge chunk contains only an inert no-op stub", () => {
  const files = fs.readdirSync(distAssetsDir).filter((f) => f.includes("devTestBridge") && f.endsWith(".js"));
  assert.ok(files.length > 0, "Expected _virtual_devTestBridge chunk in dist/assets");

  for (const file of files) {
    const content = fs.readFileSync(path.join(distAssetsDir, file), "utf8");
    assert.equal(content.includes("__PROJECT_SNAPSHOT__"), false);
    assert.equal(content.includes("addEventListener"), false);
    assert.equal(content.includes("getProjectSnapshot"), false);
  }
});

test("Security Regression: stripDevTestBridgePlugin resolves virtual stub in build and passes through in serve", async () => {
  const viteConfigModule = await import(`file://${viteConfigPath}?t=${Date.now()}`);
  const configFn = viteConfigModule.default;
  assert.equal(typeof configFn, "function", "vite.config.mjs must export a defineConfig function");

  // In build mode:
  const buildConfig = configFn({ command: "build", mode: "production" });
  const buildPlugin = buildConfig.plugins.find((p) => p && p.name === "strip-dev-test-bridge");
  assert.ok(buildPlugin, "strip-dev-test-bridge plugin must be present in build plugins");
  assert.equal(buildPlugin.enforce, "pre", "Plugin must use enforce: pre to intercept before Vite resolver");

  const resolved = buildPlugin.resolveId("./lib/devTestBridge.js");
  assert.equal(resolved, "\0virtual:devTestBridge", "Must resolve devTestBridge to virtual stub in build mode");
  const loaded = buildPlugin.load("\0virtual:devTestBridge");
  assert.equal(loaded, "export function registerDevTestBridge() { return () => {}; }");

  // In dev / serve mode:
  const serveConfig = configFn({ command: "serve", mode: "development" });
  const servePlugin = serveConfig.plugins.find((p) => p && p.name === "strip-dev-test-bridge");
  assert.ok(servePlugin);
  const serveResolved = servePlugin.resolveId("./lib/devTestBridge.js");
  assert.equal(serveResolved, undefined, "Must NOT intercept devTestBridge in serve / dev mode");
});

test("Security Regression: security gate deliberately detects and rejects unprotected build configurations", () => {
  function verifyViteSecurity(config) {
    const plugin = config?.plugins?.find((p) => p && p.name === "strip-dev-test-bridge");
    if (!plugin) throw new Error("VULNERABILITY_DETECTED: strip-dev-test-bridge plugin missing");
    if (plugin.enforce !== "pre") throw new Error("VULNERABILITY_DETECTED: plugin must have enforce: pre");
    const resolved = plugin.resolveId?.("./lib/devTestBridge.js");
    if (resolved !== "\0virtual:devTestBridge") throw new Error("VULNERABILITY_DETECTED: devTestBridge is not intercepted");
    const loaded = plugin.load?.("\0virtual:devTestBridge");
    if (typeof loaded !== "string" || loaded.includes("__PROJECT_SNAPSHOT__")) throw new Error("VULNERABILITY_DETECTED: virtual stub is compromised");
    return true;
  }

  // 1. Deliberately simulate absent plugin
  assert.throws(() => verifyViteSecurity({ plugins: [] }), /VULNERABILITY_DETECTED: strip-dev-test-bridge plugin missing/);

  // 2. Deliberately simulate missing enforce: pre
  assert.throws(() => verifyViteSecurity({ plugins: [{ name: "strip-dev-test-bridge" }] }), /VULNERABILITY_DETECTED: plugin must have enforce: pre/);

  // 3. Deliberately simulate resolver failing to intercept devTestBridge
  assert.throws(() => verifyViteSecurity({ plugins: [{ name: "strip-dev-test-bridge", enforce: "pre", resolveId: () => undefined }] }), /VULNERABILITY_DETECTED: devTestBridge is not intercepted/);

  // 4. Deliberately simulate compromised stub
  assert.throws(() => verifyViteSecurity({ plugins: [{ name: "strip-dev-test-bridge", enforce: "pre", resolveId: () => "\0virtual:devTestBridge", load: () => "window.__PROJECT_SNAPSHOT__ = true" }] }), /VULNERABILITY_DETECTED: virtual stub is compromised/);
});

