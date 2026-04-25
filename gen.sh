#!/bin/bash
set -e

# ============================================================
# gen.sh — One-click build: Excel → LMDB
# ============================================================
# Pipeline: Luban (xlsx -> .fbs + .json)
#        -> gen_table_keys (xlsx -> table_keys.json)
#        -> sort_json (stable-order the JSON by primary keys)
#        -> flatc     (.fbs + .json -> .bin + .ts)
#        -> importer  (.bin -> LMDB)
#
# Prerequisites:
#   - tools/Luban/Luban.dll           (Luban release)
#   - tools/flatc                     (flatc binary, >= 23.x)
#   - python3 with openpyxl           (used by gen_table_keys.ts)
#   - npm install                     (flatbuffers, lmdb, tsx)
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# --- Configurable paths ---
LUBAN_DLL="tools/Luban/Luban.dll"
FLATC="tools/flatc"
DESIGNER_DIR="designer_cfg"
LUBAN_CONF="$DESIGNER_DIR/luban.conf"
TABLES_XLSX="$DESIGNER_DIR/Datas/__tables__.xlsx"
CUSTOM_TEMPLATE_DIR="tools/luban_custom_templates"
OUTPUT_DIR="gen_output"
TARGET_NAME="all"

# Pull the target's topModule out of luban.conf — this is the single source
# of truth for the FlatBuffers namespace (e.g. "cfg" -> `namespace cfg;` in
# schema.fbs -> `cfg.TbRank` passed to flatc --root-type). Avoids hardcoding
# the namespace string in this script.
TOP_MODULE=$(jq -r --arg t "$TARGET_NAME" \
    '.targets[] | select(.name==$t).topModule' "$LUBAN_CONF")
: "${TOP_MODULE:?topModule not found in $LUBAN_CONF for target '$TARGET_NAME'}"

# --- Clean output ---
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR/fbs" "$OUTPUT_DIR/json" "$OUTPUT_DIR/bin" "$OUTPUT_DIR/ts" "$OUTPUT_DIR/db"

# ============================================================
# Step 1: Luban — Excel → .fbs + .json
# ============================================================
# luban.conf uses paths relative to designer_cfg/, so we cd into it.
# outputCodeDir / outputDataDir therefore need to be relative to that cwd,
# so we pass "../$OUTPUT_DIR/...".
echo "[Step 1] Running Luban..."
(
    cd "$DESIGNER_DIR"
    dotnet "../$LUBAN_DLL" \
        -t "$TARGET_NAME" \
        -c flatbuffers \
        -d flatbuffers-json \
        --conf luban.conf \
        --customTemplateDir "../$CUSTOM_TEMPLATE_DIR" \
        -x outputCodeDir="../$OUTPUT_DIR/fbs" \
        -x outputDataDir="../$OUTPUT_DIR/json"
)
echo "[Step 1] Luban complete."

# ============================================================
# Step 1.5: Derive table_keys.json from __tables__.xlsx
# ============================================================
# Luban itself doesn't emit a machine-readable key manifest for the json
# target, so we generate one directly from __tables__.xlsx. Keys are written
# using luban's own output-stem rule (lowercase full_name, strip dots),
# matching the .json filenames luban produced in Step 1.
echo "[Step 1.5] Generating table_keys.json..."
npx tsx scripts/gen_table_keys.ts \
    "$TABLES_XLSX" \
    "$OUTPUT_DIR/table_keys.json"

# ============================================================
# Step 2: Sort JSON by primary keys (pre-flatc, for stable binaries)
# ============================================================
echo "[Step 2] Sorting JSON data by primary keys..."
npx tsx scripts/sort_json.ts "$OUTPUT_DIR/table_keys.json" "$OUTPUT_DIR/json"

# ============================================================
# Step 3: flatc — .fbs + sorted .json → .bin + .ts
# ============================================================
# The schema.fbs has NO root_type (our custom schema.sbn strips it), because
# FlatBuffers only honors the last `root_type` in a schema — multiple tables
# would silently shadow each other. So we compile each table's .bin
# separately, passing --root-type explicitly from table_keys.json.
echo "[Step 3] Running flatc..."

# 3a. Generate TypeScript code once (single schema -> one ts module tree).
$FLATC --ts --gen-object-api --force-defaults \
    -o "$OUTPUT_DIR/ts" \
    "$OUTPUT_DIR/fbs/schema.fbs"

# 3b. Per-table binary: iterate table_keys.json to pick the right root_type.
#     NOTE flatc's `--` separator: files BEFORE `--` are schema + JSON sources
#     to convert; files AFTER are EXISTING binaries to decode/validate. So
#     the .json goes on the left, no `--` needed here.
#     jq -r '... | "<stem> <value_type>"' feeds `read stem value_type`.
while read -r stem value_type; do
    [ -z "$stem" ] && continue
    json_file="$OUTPUT_DIR/json/${stem}.json"
    if [ ! -f "$json_file" ]; then
        echo "  [warn] $json_file missing, skipping"
        continue
    fi
    echo "  [flatc] $stem -> Tb${value_type} -> ${stem}.bin"
    $FLATC --binary --force-defaults \
        --root-type "${TOP_MODULE}.Tb${value_type}" \
        -o "$OUTPUT_DIR/bin" \
        "$OUTPUT_DIR/fbs/schema.fbs" \
        "$json_file"
done < <(jq -r 'to_entries[] | "\(.key) \(.value.value_type)"' "$OUTPUT_DIR/table_keys.json")

echo "[Step 3] flatc complete."

# ============================================================
# Step 4: Import .bin → LMDB
# ============================================================
echo "[Step 4] Importing binary files into LMDB..."
npx tsx scripts/importer.ts "$OUTPUT_DIR/bin" "$OUTPUT_DIR/db"

echo "=========================================="
echo "Build complete! LMDB at: $OUTPUT_DIR/db/"
echo "=========================================="
