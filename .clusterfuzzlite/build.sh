#!/bin/bash -eu

npm ci
npm run build

compile_javascript_fuzzer aggregator fuzz_aggregator.cjs
