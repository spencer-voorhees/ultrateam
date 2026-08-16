#!/usr/bin/env bash
#
# ultrateam installer — one line, no manual clone:
#   curl -fsSL https://raw.githubusercontent.com/spencer-voorhees/ultrateam/main/install.sh | bash
#
# Fetches the repo, installs deps, builds, and puts the `ultrateam` command on your PATH.
# Re-running updates an existing install in place. Everything lives under ~/.ultrateam-app.

set -euo pipefail

REPO="https://github.com/spencer-voorhees/ultrateam"
DIR="${ULTRATEAM_HOME:-$HOME/.ultrateam-app}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

say() { printf '\033[38;5;36m%s\033[0m\n' "$*"; }   # ultrateam green
err() { printf '\033[38;5;203m%s\033[0m\n' "$*" >&2; }

command -v git >/dev/null 2>&1  || { err "ultrateam needs git."; exit 1; }
command -v node >/dev/null 2>&1 || { err "ultrateam needs Node.js 22.13+ — https://nodejs.org"; exit 1; }
command -v npm >/dev/null 2>&1  || { err "ultrateam needs npm (ships with Node.js)."; exit 1; }

# Node >= 22.13 (uses the built-in node:sqlite)
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 13 ]; }; then
  err "ultrateam needs Node.js 22.13+ (found $(node -v)). Please upgrade."; exit 1
fi

if [ -d "$DIR/.git" ]; then
  say "→ updating ultrateam in $DIR"
  git -C "$DIR" pull --ff-only --quiet
else
  say "→ fetching ultrateam into $DIR"
  git clone --depth 1 --quiet "$REPO" "$DIR"
fi

cd "$DIR"
say "→ installing dependencies"
npm install --no-audit --no-fund --silent
say "→ building"
npm run build --silent

mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/ultrateam" <<EOF
#!/usr/bin/env bash
exec node "$DIR/dist/cli.js" "\$@"
EOF
chmod +x "$BIN_DIR/ultrateam"

say "✓ ultrateam installed → $BIN_DIR/ultrateam"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) err "  note: add $BIN_DIR to your PATH, then reopen your shell";;
esac
echo "  next: cd your-project && ultrateam init"
