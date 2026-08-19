#!/bin/sh
# Runs the fuel-split logic tests. Requires node (18+ for the PDF checks).
cd "$(dirname "$0")" && exec node run_tests.js
