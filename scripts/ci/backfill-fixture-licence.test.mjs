import assert from "node:assert/strict";
import test from "node:test";
import { insertLicence, licenceOf } from "./backfill-fixture-licence.mjs";

const fixture = `{
  "provenance": {
    "source": "template https://huggingface.co/a/b/blob/main/x, not observed",
    "retrieved": "2026-11-10",
    "note": ""
  }
}
`;

test("inserts the field after source and changes nothing else", () => {
  const out = insertLicence(fixture, "mit");
  assert.equal(
    out,
    fixture.replace('"retrieved"', '"license": "mit",\n    "retrieved"'),
  );
});

test("leaves a fixture that already has the field, or no source, alone", () => {
  assert.equal(insertLicence(insertLicence(fixture, "mit"), "mit"), undefined);
  assert.equal(insertLicence("{}", "mit"), undefined);
});

test("reads the licence from the card, the top level or a tag", () => {
  assert.equal(
    licenceOf({ cardData: { license: "mit" }, license: "x" }),
    "mit",
  );
  assert.equal(licenceOf({ license: "apache-2.0" }), "apache-2.0");
  assert.equal(licenceOf({ tags: ["a", "license:gemma"] }), "gemma");
  assert.equal(licenceOf({}), null);
});
