#!/usr/bin/env node
// Downloads the embedding model once, before anything else runs.
//
// `embedText` memoises the pipeline per process, but vitest forks a worker per
// CPU and every worker misses that cache independently. They then race to write
// the same file under node_modules/@huggingface/transformers/.cache, and the
// loser reads a half-written one:
//
//   Load model from .../all-MiniLM-L6-v2/onnx/model.onnx failed:
//   Protobuf parsing failed. / ModelProto does not have a graph.
//
// That took out 68 tests on CI while every one of them passed locally, because
// a developer machine already has the model on disk. Fetching it serially here
// means the workers only ever read.

import { pipeline, env } from "@huggingface/transformers";
import { rm } from "node:fs/promises";

const model = process.env.ORI_EMBEDDING_MODEL ?? "Xenova/all-MiniLM-L6-v2";
const ATTEMPTS = Number(process.env.ORI_PREFETCH_ATTEMPTS ?? 3);

// Ask the library where it caches rather than reconstructing the path — the
// package does not export package.json, and the location is configurable.
const cacheDir = env.cacheDir;

async function attempt() {
  const extractor = await pipeline("feature-extraction", model, { dtype: "fp32" });
  // Actually run it. A downloaded file is not the same as a loadable one — the
  // corruption this script exists to prevent only surfaces at session creation.
  const out = await extractor("warm the cache", { pooling: "mean", normalize: true });
  if (!out?.data?.length) throw new Error("model produced no embedding");
  return out.data.length;
}

const started = Date.now();
let dims = 0;

for (let i = 1; i <= ATTEMPTS; i++) {
  try {
    dims = await attempt();
    break;
  } catch (err) {
    const reason = String(err?.cause?.code ?? err?.message ?? err).split("\n")[0];
    if (i === ATTEMPTS) {
      console.error(`prefetch: ${model} failed after ${ATTEMPTS} attempts — ${reason}`);
      process.exit(1);
    }
    // A failed download leaves exactly the truncated file the workers would
    // then read. Clear it so the retry starts from nothing.
    await rm(cacheDir, { recursive: true, force: true });
    const backoff = 2 ** i;
    console.warn(`prefetch: attempt ${i}/${ATTEMPTS} failed (${reason}) — cleared cache, retrying in ${backoff}s`);
    await new Promise((r) => setTimeout(r, backoff * 1000));
  }
}

console.log(
  `prefetch: ${model} ready — ${dims} dims in ${((Date.now() - started) / 1000).toFixed(1)}s`,
);
