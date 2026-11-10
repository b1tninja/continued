import assert from "node:assert/strict";
import test from "node:test";

import { limit } from "../src/app.js";

test("the request limit is 5", () => {
  assert.equal(
    limit(),
    5,
    `limit() is ${limit()}, expected 5 (configured in src/config.js)`,
  );
});
