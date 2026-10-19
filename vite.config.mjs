import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentDiscoveryLinkHeader, agentDiscoveryPlugin } from "./scripts/agent-discovery.mjs";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  Link: agentDiscoveryLinkHeader,
};

function stripDevTestBridgePlugin(command) {
  return {
    name: "strip-dev-test-bridge",
    enforce: "pre",
    resolveId(id) {
      if (id.includes("devTestBridge") && command === "build") {
        return "\0virtual:devTestBridge";
      }
    },
    load(id) {
      if (id === "\0virtual:devTestBridge") {
        return "export function registerDevTestBridge() { return () => {}; }";
      }
    },
  };
}

export default defineConfig(({ command }) => ({
  build: {
    rollupOptions: {
      input: {
        editor: resolve(projectRoot, "index.html"),
      },
    },
  },
  test: {
    include: ["src/**/*.test.{js,jsx}"],
    coverage: {
      include: ["src/**/*.{js,jsx,ts,tsx}"],
      exclude: ["src/**/*.test.*", "src/**/__fixtures__/**"],
    },
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  worker: {
    format: "es",
  },
  server: {
    headers: isolationHeaders,
    watch: {
      ignored: ["**/storage/**", "**/test-artifacts/**", "**/scratch/**"],
    },
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  preview: {
    headers: isolationHeaders,
  },
  plugins: [stripDevTestBridgePlugin(command), agentDiscoveryPlugin(), react()],
}));
