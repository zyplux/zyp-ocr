import { defineConfig } from "vitest/config";

// Vitest does not need the TanStack Start / Cloudflare Vite plugins — those expect
// a generated router entry that only exists after the first dev/build run. Keeping
// vitest on a plain config means unit tests run cleanly on a fresh checkout.
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
