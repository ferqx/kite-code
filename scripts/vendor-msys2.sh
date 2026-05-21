#!/usr/bin/env bash
# Vendor MSYS2 bash + coreutils for openpx shell tool
# 对标 Claude Code：从系统 Git for Windows 提取 bash 和 coreutils 到 vendor/msys2/
# 布局：vendor/msys2/usr/bin/{bash.exe,ls.exe,...} + vendor/msys2/usr/bin/msys-2.0.dll
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENDOR_DIR="$PROJECT_ROOT/vendor/msys2"
BIN_DIR="$VENDOR_DIR/usr/bin"

echo "==> openpx MSYS2 vendor script"
echo "    target: $VENDOR_DIR"

# --- 定位 Git for Windows / MSYS2 ---
MSYS2_DIR=""
if [ -d "/d/Git/usr/bin" ]; then
  MSYS2_DIR="/d/Git/usr/bin"
elif [ -d "/c/Program Files/Git/usr/bin" ]; then
  MSYS2_DIR="/c/Program Files/Git/usr/bin"
elif [ -d "/c/Program Files (x86)/Git/usr/bin" ]; then
  MSYS2_DIR="/c/Program Files (x86)/Git/usr/bin"
elif [ -n "${GIT_INSTALL_ROOT:-}" ] && [ -d "$GIT_INSTALL_ROOT/usr/bin" ]; then
  MSYS2_DIR="$GIT_INSTALL_ROOT/usr/bin"
else
  echo "ERROR: Cannot find Git for Windows MSYS2 installation."
  echo "       Please install Git for Windows from https://git-scm.com/download/win"
  echo "       Expected paths: /c/Program Files/Git/usr/bin or /d/Git/usr/bin"
  exit 1
fi

echo "    source: $MSYS2_DIR"

# --- 收集所有需要的文件 ---
CORE_FILES=(
  "bash.exe"       # GNU bash 5.x
  "msys-2.0.dll"   # MSYS2 runtime
)

COREUTILS=(
  # 白名单 (PLAN_READ_ONLY_COMMANDS)
  awk cat du echo file find grep head ls nl pwd sed stat tail test wc
  # 日常必需
  rm mkdir cp mv touch chmod sort uniq tr cut dirname
  sleep tee xargs env date diff printf readlink realpath
  which id expr ln rmdir sh
)

# --- 复制文件到 usr/bin/ ---
rm -rf "$VENDOR_DIR"
mkdir -p "$BIN_DIR"

echo ""
echo "-- Core binaries --"
for f in "${CORE_FILES[@]}"; do
  cp "$MSYS2_DIR/$f" "$BIN_DIR/"
  echo "  $f"
done

echo ""
echo "-- Coreutils --"
for c in "${COREUTILS[@]}"; do
  f="${c}.exe"
  if [ -f "$MSYS2_DIR/$f" ]; then
    cp "$MSYS2_DIR/$f" "$BIN_DIR/"
  else
    echo "  MISS $f"
  fi
done

# --- DLL 依赖 ---
echo ""
echo "-- Checking DLL dependencies --"
KEY_TOOLS=(grep sed awk find file)
for tool in "${KEY_TOOLS[@]}"; do
  tool_path="$MSYS2_DIR/${tool}.exe"
  if [ ! -f "$tool_path" ]; then continue; fi
  for dll in $("$MSYS2_DIR/objdump.exe" -p "$tool_path" 2>/dev/null | grep -oP 'DLL Name:\s*\Kmsys[-\w]+\.dll' || true); do
    if [ ! -f "$BIN_DIR/$dll" ]; then
      cp "$MSYS2_DIR/$dll" "$BIN_DIR/"
      echo "    $dll (needed by $tool)"
    fi
  done
done

# --- 创建 /etc/fstab (MSYS2 需要 /tmp 等挂载) ---
mkdir -p "$VENDOR_DIR/etc"
cat > "$VENDOR_DIR/etc/fstab" << 'FSTAB'
none /cygdrive cygdrive binary,posix=0,user 0 0
FSTAB
echo ""
echo "-- Created /etc/fstab --"

# --- 报告 ---
echo ""
echo "==> Done."
echo "    Total size: $(du -sh "$VENDOR_DIR" | cut -f1)"
echo "    File count: $(find "$VENDOR_DIR" -type f | wc -l) files"

# --- 冒烟测试 ---
echo ""
echo "==> Smoke test"
"$BIN_DIR/bash.exe" -c '
  set -e
  echo "    bash: $(bash --version | head -1)"
  echo "    pwd:  $(pwd)"
  echo "    ls:   $(ls '"$BIN_DIR"' | head -1)..."
  echo hello | grep hello > /dev/null && echo "    grep: PASS"
  echo hello | sed "s/hello/hi/" | grep hi > /dev/null && echo "    sed: PASS"
  echo "1 2 3" | awk "{print \$2}" | grep 2 > /dev/null && echo "    awk: PASS"
'
echo ""
echo "    SMOKE TEST PASSED"
