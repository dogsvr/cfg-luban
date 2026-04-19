#!/bin/bash
set -e

# ============================================================
# gen.sh — One-click build: Excel → LMDB
# ============================================================
# Prerequisites:
#   - tools/luban/   (Luban release, e.g. dotnet Luban.dll)
#   - tools/flatc    (flatc binary, >= 23.x)
#   - npm install    (flatbuffers, lmdb, tsx)
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# --- Configurable paths ---
LUBAN_DLL="tools/luban/Luban.dll"
FLATC="tools/flatc"
EXCEL_DIR="excel"
OUTPUT_DIR="gen_output"
CUSTOM_TEMPLATE_DIR="luban/custom_templates"

# --- Clean output ---
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR/fbs" "$OUTPUT_DIR/json" "$OUTPUT_DIR/bin" "$OUTPUT_DIR/ts" "$OUTPUT_DIR/db"

# ============================================================
# Step 1: Luban — Excel → .fbs + .json + table_keys.json
# ============================================================
echo "[Step 1] Running Luban..."
# TODO: Fill in actual Luban command with your luban.conf
# dotnet "$LUBAN_DLL" \
#     -t all \
#     --conf luban/luban.conf \
#     --customTemplateDir "$CUSTOM_TEMPLATE_DIR" \
#     -x outputCodeDir="$OUTPUT_DIR/fbs" \
#     -x outputDataDir="$OUTPUT_DIR/json" \
#     -x tableKeysOutputFile="$OUTPUT_DIR/table_keys.json"
echo "[Step 1] Luban complete. (TODO: uncomment and configure)"

# ============================================================
# Step 2: Sort JSON by primary keys
# ============================================================
echo "[Step 2] Sorting JSON data by primary keys..."
npx tsx scripts/sort_json.ts "$OUTPUT_DIR/table_keys.json" "$OUTPUT_DIR/json"

# ============================================================
# Step 3: flatc — .fbs + sorted .json → .bin + .ts
# ============================================================
echo "[Step 3] Running flatc..."

# Generate TypeScript code (with object API for unpack())
$FLATC --ts --gen-object-api --force-defaults \
    -o "$OUTPUT_DIR/ts" \
    "$OUTPUT_DIR/fbs/"*.fbs

# Generate binary files from sorted JSON
$FLATC --binary --force-defaults \
    -o "$OUTPUT_DIR/bin" \
    "$OUTPUT_DIR/fbs/"*.fbs \
    -- "$OUTPUT_DIR/json/"*.json

echo "[Step 3] flatc complete."

# ============================================================
# Step 4: Import .bin → LMDB
# ============================================================
echo "[Step 4] Importing binary files into LMDB..."
npx tsx scripts/importer.ts "$OUTPUT_DIR/bin" "$OUTPUT_DIR/db"

echo "=========================================="
echo "Build complete! LMDB at: $OUTPUT_DIR/db/"
echo "=========================================="
