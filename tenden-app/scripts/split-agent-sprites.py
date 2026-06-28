"""Split 4x5 agent sprite sheet and remove checkerboard/black background."""
from pathlib import Path
from PIL import Image

SRC = Path(
    r"C:\Users\maruy\.cursor\projects\e-kamakura-sim\assets"
    r"\c__Users_maruy_AppData_Roaming_Cursor_User_workspaceStorage_empty-window_images_"
    r"Gemini_Generated_Image_dmffamdmffamdmff-479c7ffc-f91f-4175-8f98-6ff3f5fd7e3e.png"
)
OUT_DIR = Path(__file__).resolve().parent.parent / "assets" / "agent"

# 4 columns x 5 rows (left-to-right, top-to-bottom)
COLS = 4
ROWS = 5

# (filename, col, row) — row/col are 0-based grid indices
NAMES = [
    ("agent-idle.png", 0, 0),           # 1 INFO walking
    ("agent-search.png", 1, 0),         # 2 Lantern
    ("agent-halt.png", 2, 0),           # 3 Stop gesture
    ("agent-route-plan.png", 3, 0),     # 4 Tablet map
    ("agent-navigate.png", 0, 1),       # 5 Compass + map
    ("agent-broadcast.png", 1, 1),      # 6 Megaphone
    ("agent-destination.png", 2, 1),    # 7 Flag on hill
    ("agent-ar-demo.png", 3, 1),        # 8 AR phone
    ("agent-evac-active.png", 0, 2),    # 9 Walkie + extinguisher
    ("agent-directing.png", 1, 2),      # 10 Walkie + pointing
    ("agent-high-ground.png", 2, 2),    # 11 Stairs
    ("agent-monitor.png", 3, 2),        # 12 Laptop + storm
    ("agent-scout.png", 0, 3),          # 13 Scout on hill
    ("agent-safety-share.png", 1, 3),   # 14 First aid box
    ("agent-urgent.png", 2, 3),         # 15 Running
    ("agent-synced.png", 3, 3),         # 16 Satellite
    ("agent-night-alert.png", 0, 4),    # 17 Torch
    ("agent-flood.png", 1, 4),          # 18 Water gauge
    ("agent-checkin.png", 2, 4),        # 19 QR checkmark
    ("agent-watch-coast.png", 3, 4),    # 20 Binoculars
]


def is_background(r: int, g: int, b: int) -> bool:
    diff = max(r, g, b) - min(r, g, b)
    avg = (r + g + b) / 3
    lo = min(r, g, b)
    if avg < 45:
        return True
    if diff < 28 and avg > 85:
        return True
    if diff < 15 and avg > 215:
        return True
    if diff < 40 and lo > 175:
        return True
    return False


def remove_background(img: Image.Image) -> Image.Image:
    img = img.convert("RGBA")
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, _ = px[x, y]
            if is_background(r, g, b):
                px[x, y] = (0, 0, 0, 0)
    return img


def trim_transparent(img: Image.Image, pad: int = 6) -> Image.Image:
    bbox = img.getbbox()
    if not bbox:
        return img
    left = max(0, bbox[0] - pad)
    top = max(0, bbox[1] - pad)
    right = min(img.width, bbox[2] + pad)
    bottom = min(img.height, bbox[3] + pad)
    return img.crop((left, top, right, bottom))


def find_gutters(sheet: Image.Image, axis: str, parts: int) -> list[int]:
    """Find split lines at low-content gutters."""
    gray = sheet.convert("L")
    w, h = gray.size
    if axis == "x":
        profile = []
        for x in range(w):
            col = [gray.getpixel((x, y)) for y in range(h)]
            profile.append(sum(col) / len(col))
        length = w
    else:
        profile = []
        for y in range(h):
            row = [gray.getpixel((x, y)) for x in range(w)]
            profile.append(sum(row) / len(row))
        length = h

    seg = length / parts
    bounds = [0]
    for i in range(1, parts):
        center = int(i * seg)
        window = max(8, int(seg * 0.15))
        lo = max(1, center - window)
        hi = min(length - 2, center + window)
        best = center
        best_val = profile[center]
        for p in range(lo, hi):
            if profile[p] > best_val:
                best_val = profile[p]
                best = p
        bounds.append(best)
    bounds.append(length)
    return bounds


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    sheet = Image.open(SRC)
    print(f"Source sheet size: {sheet.size} ({COLS}x{ROWS} grid)")
    x_bounds = find_gutters(sheet, "x", COLS)
    y_bounds = find_gutters(sheet, "y", ROWS)

    full = trim_transparent(remove_background(sheet.copy()))
    full.save(OUT_DIR / "agent-spritesheet.png", optimize=True)

    for name, col, row in NAMES:
        box = (
            x_bounds[col],
            y_bounds[row],
            x_bounds[col + 1],
            y_bounds[row + 1],
        )
        cell = sheet.crop(box)
        cell = trim_transparent(remove_background(cell))
        cell.save(OUT_DIR / name, optimize=True)
        print(f"Wrote {name} box={box} size={cell.size}")

    print(f"Sheet {sheet.size}, x={x_bounds}, y={y_bounds}")


if __name__ == "__main__":
    main()
