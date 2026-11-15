#!/bin/sh
set -eu
BASE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SDK_DIR=${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}
: "${SDK_DIR:?Set ANDROID_SDK_ROOT to your Android SDK directory}"
API=${ANDROID_API:-35}
TOOLS=${ANDROID_BUILD_TOOLS:-35.0.0}
ANDROID_JAR="$SDK_DIR/platforms/android-$API/android.jar"
mkdir -p "$BASE/build/cursor/classes" "$BASE/build/cursor/dex"
javac -source 8 -target 8 -bootclasspath "$ANDROID_JAR" \
    -d "$BASE/build/cursor/classes" "$BASE/cursor/PointerVisibility.java"
"$SDK_DIR/build-tools/$TOOLS/d8" --min-api 28 --lib "$ANDROID_JAR" \
    --output "$BASE/build/cursor/dex" "$BASE/build/cursor/classes/PointerVisibility.class"
cd "$BASE/build/cursor/dex"
jar cf "$BASE/cursor/cursor-visibility.jar" classes.dex
