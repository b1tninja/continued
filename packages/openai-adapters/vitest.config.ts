import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    testTimeout: 10000,
    include: ["src/**/*.test.{ts,tsx}", "src/**/*.vitest.{ts,tsx}"],
    exclude: [...configDefaults.exclude, "src/**/*.live.test.{ts,tsx}"],
    tags: [
      {
        name: "perf",
        description:
          "Wall-clock comparisons. Left out of the default run; npm run test:perf",
      },
    ],
    // A filter given on the command line (--tags-filter) replaces this one.
    tagsFilter: ["!perf"],
  },
  resolve: {
    alias: {
      "(.+)\\.js": "$1",
    },
  },
});
