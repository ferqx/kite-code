"""Write the Finder layout for the read-only Kite Desktop disk image."""

import plistlib
import struct
import sys
from pathlib import Path


def record(name, key, kind, value):
    filename = name.encode("utf-16be")
    if kind == b"blob":
        value = struct.pack(">I", len(value)) + value
    return struct.pack(">I", len(filename) // 2) + filename + key + kind + value


def options(value):
    return plistlib.dumps(value, fmt=plistlib.FMT_BINARY)


def icon_location(x):
    return struct.pack(">4I", x, 145, 0xFFFFFFFF, 0xFFFF0000)


def finder_layout():
    # Finder record names and values follow dmgbuild's icon-view format.
    # https://github.com/dmgbuild/dmgbuild/blob/main/src/dmgbuild/core.py
    records = [
        record(".", b"bwsp", b"blob", options({
            "WindowBounds": "{{100, 100}, {580, 320}}",
            "ContainerShowSidebar": False,
            "ShowPathbar": False,
            "ShowSidebar": False,
            "ShowStatusBar": False,
            "ShowTabView": False,
            "ShowToolbar": False,
        })),
        record(".", b"icvl", b"type", b"icnv"),
        record(".", b"icvp", b"blob", options({
            "viewOptionsVersion": 1,
            "backgroundType": 0,
            "arrangeBy": "none",
            "gridOffsetX": 0.0,
            "gridOffsetY": 0.0,
            "gridSpacing": 100.0,
            "iconSize": 96.0,
            "labelOnBottom": True,
            "scrollPositionX": 0.0,
            "scrollPositionY": 0.0,
            "showIconPreview": True,
            "showItemInfo": False,
            "textSize": 13.0,
        })),
        record(".", b"vSrn", b"long", struct.pack(">I", 1)),
        record("Applications", b"Iloc", b"blob", icon_location(435)),
        record("Kite Desktop.app", b"Iloc", b"blob", icon_location(145)),
    ]

    # Fixed buddy allocator with a directory block, DSDB superblock, and one leaf.
    # Logical offsets omit the four-byte file version. The low five bits of a
    # block address are the base-two logarithm of the block size.
    # https://github.com/dmgbuild/ds_store/blob/main/src/ds_store/buddy.py
    directory_offset, super_offset, leaf_offset = 2048, 32, 4096
    directory_size, super_size, leaf_size = 2048, 32, 4096
    header = struct.pack(">I4s7I", 1, b"Bud1", directory_offset, directory_size,
                         directory_offset, 0x100C, 0x87, 0x200B, 0)
    addresses = (directory_offset | 11, super_offset | 5, leaf_offset | 12)
    directory = struct.pack(">II256I", 3, 0, *addresses, *([0] * 253))
    directory += struct.pack(">IB4sI", 1, 4, b"DSDB", 1)
    for width in range(32):
        if 6 <= width <= 30 and width not in (11, 12):
            directory += struct.pack(">II", 1, 1 << width)
        else:
            directory += struct.pack(">I", 0)
    superblock = struct.pack(">5I", 2, 1, len(records), 1, leaf_size)
    leaf = struct.pack(">II", 0, len(records)) + b"".join(records)
    if len(directory) > directory_size or len(leaf) > leaf_size:
        raise ValueError("Finder layout exceeds the fixed storage blocks")

    data = bytearray(4 + leaf_offset + leaf_size)
    data[:len(header)] = header
    for offset, block in ((super_offset, superblock), (directory_offset, directory),
                          (leaf_offset, leaf)):
        start = 4 + offset
        data[start:start + len(block)] = block
    return data


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: finder-layout.py <disk-image-staging-directory>")
    with (Path(sys.argv[1]) / ".DS_Store").open("xb") as output:
        output.write(finder_layout())
