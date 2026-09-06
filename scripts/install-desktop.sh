#!/usr/bin/env bash
#
# Put Foxxers in the applications menu and on the desktop, with the fox icon.
# Everything lands under $HOME — nothing here needs root.
set -eu

ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
APPS="$HOME/.local/share/applications"
ICONS="$HOME/.local/share/icons/hicolor"
ENTRY="$APPS/foxxers.desktop"

mkdir -p "$APPS"

# Install the icon at each size the theme looks for, so the launcher, the
# dock and the window list all find one they do not have to rescale.
for size in 32 180 192 512 1024; do
  src="$ROOT/web/public/icons/icon-$size.png"
  [ -f "$src" ] || continue
  dir="$ICONS/${size}x${size}/apps"
  mkdir -p "$dir"
  cp "$src" "$dir/foxxers.png"
done

cat > "$ENTRY" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Foxxers
GenericName=Trades booking
Comment=Find a tradesperson, book a slot, agree a quote, get the invoice
Exec=$ROOT/scripts/foxxers
Icon=foxxers
Terminal=false
Categories=Office;
Keywords=trades;tradesperson;electrician;plumber;quote;invoice;booking;
StartupNotify=true
DESKTOP

chmod +x "$ENTRY"
command -v update-desktop-database > /dev/null && update-desktop-database "$APPS" 2>/dev/null || true
command -v gtk-update-icon-cache > /dev/null && gtk-update-icon-cache -f -t "$ICONS" 2>/dev/null || true

# A copy on the desktop itself, marked trusted so GNOME will run it rather
# than showing it as an untrusted text file.
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
if [ -d "$DESKTOP_DIR" ]; then
  cp "$ENTRY" "$DESKTOP_DIR/foxxers.desktop"
  chmod +x "$DESKTOP_DIR/foxxers.desktop"
  command -v gio > /dev/null && gio set "$DESKTOP_DIR/foxxers.desktop" metadata::trusted true 2>/dev/null || true
fi

echo "Installed:"
echo "  $ENTRY"
[ -d "$DESKTOP_DIR" ] && echo "  $DESKTOP_DIR/foxxers.desktop"
echo "  icon 'foxxers' in $ICONS"
