#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: GSTREAMER_ROOT_ANDROID=/path/to/sdk $0 <aarch64|armv7|i686|x86_64> <command...>" >&2
  exit 2
fi

if [[ -z "${GSTREAMER_ROOT_ANDROID:-}" ]]; then
  echo "GSTREAMER_ROOT_ANDROID must point to the extracted official Android universal SDK" >&2
  exit 2
fi

target="$1"
shift
case "$target" in
  aarch64) gst_abi="arm64" ;;
  armv7) gst_abi="armv7" ;;
  i686) gst_abi="x86" ;;
  x86_64) gst_abi="x86_64" ;;
  *) echo "unsupported ABI: $target" >&2; exit 2 ;;
esac

gst_sysroot="${GSTREAMER_ROOT_ANDROID}/${gst_abi}"
if [[ ! -d "$gst_sysroot/lib/pkgconfig" ]]; then
  echo "missing GStreamer pkg-config sysroot: $gst_sysroot/lib/pkgconfig" >&2
  exit 2
fi

export PKG_CONFIG_ALLOW_CROSS=1
export PKG_CONFIG_ALL_STATIC=1
export PKG_CONFIG_SYSROOT_DIR="$gst_sysroot"
export PKG_CONFIG_PATH="$gst_sysroot/lib/pkgconfig:$gst_sysroot/share/pkgconfig"
export GSTREAMER_ROOT_ANDROID

exec "$@"
