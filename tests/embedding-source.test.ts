import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "../src/config.js";
import { embeddingOptions, embeddingSource } from "../src/vectors.js";

test("offline embedding requires all files from the exact revision and never falls back to main", () => {
  mkdirSync(resolve(ROOT, "var/tests"), { recursive: true });
  const cache = mkdtempSync(resolve(ROOT, "var/tests/model-source-"));
  const options = embeddingOptions();
  const files = [
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "onnx/model_quantized.onnx",
  ];
  for (const file of files) {
    const path = resolve(cache, options.model, file);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, "fixture");
  }
  assert.throws(() => embeddingSource(options, true, cache), /incomplete/);
  assert.equal(embeddingSource(options, false, cache), options.model);
  const pinned = resolve(cache, options.model, options.revision);
  for (const file of files) {
    const path = resolve(pinned, file);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, "fixture");
  }
  assert.equal(embeddingSource(options, true, cache), pinned);
  assert.equal(embeddingSource(options, false, cache), pinned);
  assert.throws(
    () =>
      embeddingSource({ ...options, revision: "1".repeat(40) }, true, cache),
    /incomplete/,
  );
});
