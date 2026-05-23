"""
Export Blender collections into CrossOverWar game modules as .glb (glTF 2.0).

Layout in the .blend:
    pink (COLOR_07) top-level collection = game module (folder name in modules/)
        green  (COLOR_04) child collection = terrain tile
        orange (COLOR_02) child collection = map object
        red    (COLOR_01) child collection = hero
        any other colour or untagged child = exported anyway

Each child collection is exported, centered (XY by default), with textures
downscaled to 256px max, to:
    <modules-dir>/<MODULE>/assets/<child>.glb

Collections (at any level) whose name starts with '_' are skipped.

Run:
    blender --background tiles.blend --python export_tiles.py
    blender --background tiles.blend --python export_tiles.py -- --modules-dir /tmp/mods
"""

import argparse
import os
import sys
from mathutils import Vector

import bpy


MESH_LIKE = {"MESH", "CURVE", "SURFACE", "META", "FONT"}
MODULE_COLOR = "COLOR_07"  # pink
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MODULES_DIR = os.path.normpath(os.path.join(SCRIPT_DIR, "..", "src", "modules"))


def parse_args():
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    parser = argparse.ArgumentParser(description="Export collections as .glb into game modules")
    parser.add_argument(
        "--modules-dir",
        default=DEFAULT_MODULES_DIR,
        help=f"Root modules directory. Default: {DEFAULT_MODULES_DIR}",
    )
    parser.add_argument(
        "--center-z",
        action="store_true",
        help="Also center on Z. Default centers only XY so tiles keep their height.",
    )
    parser.add_argument(
        "--max-tex",
        type=int,
        default=256,
        help="Max texture dimension in pixels (aspect preserved). 0 disables. Default 256.",
    )
    return parser.parse_args(argv)


def pack_unbacked_images():
    """Pack images that exist only as in-memory pixels (e.g. painted GENERATED
    images with no filepath and no packed_files). The glTF exporter writes
    these as black textures otherwise."""
    for img in bpy.data.images:
        if not img.has_data:
            continue
        if img.packed_files:
            continue
        if img.source == "FILE" and img.filepath:
            continue
        try:
            img.pack()
            print(f"[export_tiles] packed {img.name} ({img.source}, {img.size[0]}x{img.size[1]})")
        except RuntimeError as e:
            print(f"[export_tiles] WARN: could not pack {img.name}: {e}")


def downscale_images(max_size):
    if max_size <= 0:
        return
    for img in bpy.data.images:
        if img.source not in {"FILE", "GENERATED"}:
            continue
        w, h = img.size
        if w == 0 or h == 0:
            continue
        if max(w, h) <= max_size:
            continue
        scale = max_size / max(w, h)
        new_w = max(1, int(round(w * scale)))
        new_h = max(1, int(round(h * scale)))
        print(f"[export_tiles] downscale {img.name}: {w}x{h} -> {new_w}x{new_h}")
        img.scale(new_w, new_h)


def export_targets():
    """Yield (module_name, child_collection) pairs to export.

    Top-level collections tagged pink (COLOR_07) are modules. Their direct
    child collections are the things to export. Underscore-prefixed names
    are skipped at either level.
    """
    for module in bpy.context.scene.collection.children:
        if module.name.startswith("_"):
            continue
        if module.color_tag != MODULE_COLOR:
            print(f"[export_tiles] skipping top-level {module.name!r} (not pink, tag={module.color_tag})")
            continue
        for child in module.children:
            if child.name.startswith("_"):
                continue
            yield module.name, child


def world_bounds_center(collection):
    mins = Vector((float("inf"),) * 3)
    maxs = Vector((float("-inf"),) * 3)
    found = False
    for obj in collection.all_objects:
        if obj.type not in MESH_LIKE:
            continue
        for corner in obj.bound_box:
            v = obj.matrix_world @ Vector(corner)
            mins.x, mins.y, mins.z = min(mins.x, v.x), min(mins.y, v.y), min(mins.z, v.z)
            maxs.x, maxs.y, maxs.z = max(maxs.x, v.x), max(maxs.y, v.y), max(maxs.z, v.z)
            found = True
    return (mins + maxs) / 2 if found else Vector((0, 0, 0))


def top_level_objects(collection):
    members = set(collection.all_objects)
    return [o for o in collection.all_objects if o.parent not in members]


def export_collection(collection, out_path, center_z):
    bpy.ops.object.select_all(action="DESELECT")

    center = world_bounds_center(collection)
    offset = Vector((center.x, center.y, center.z if center_z else 0.0))

    roots = top_level_objects(collection)
    original = {o.name: o.location.copy() for o in roots}
    for o in roots:
        o.location = o.location - offset

    selectable = [o for o in collection.all_objects if not o.hide_viewport and not o.hide_get()]
    for o in selectable:
        o.select_set(True)
    if selectable:
        bpy.context.view_layer.objects.active = selectable[0]

    try:
        bpy.ops.export_scene.gltf(
            filepath=out_path,
            export_format="GLB",
            use_selection=True,
            use_visible=False,
            use_renderable=False,
            export_apply=True,
            export_yup=True,
            export_materials="EXPORT",
            export_image_format="AUTO",
            export_cameras=False,
            export_lights=False,
            export_animations=False,
            export_extras=False,
        )
    finally:
        for o in roots:
            o.location = original[o.name]


def main():
    args = parse_args()

    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")

    downscale_images(args.max_tex)
    pack_unbacked_images()

    targets = list(export_targets())
    print(f"[export_tiles] {len(targets)} collection(s) under {args.modules_dir}")

    for module_name, child in targets:
        assets_dir = os.path.join(args.modules_dir, module_name, "assets")
        os.makedirs(assets_dir, exist_ok=True)
        out_path = os.path.join(assets_dir, f"{child.name}.glb")
        print(f"[export_tiles] {module_name}/{child.name} -> {out_path}")
        export_collection(child, out_path, center_z=args.center_z)

    print("[export_tiles] done.")


if __name__ == "__main__":
    main()
