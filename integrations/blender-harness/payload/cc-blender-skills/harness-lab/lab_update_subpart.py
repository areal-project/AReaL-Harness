#!/usr/bin/env python3
"""Parametric architectural modeling primitives, contract-role synchronizer & subpart builder.

Can be used in two ways:
1. Imported directly inside Blender Python (`blender --background --python ...`):
   ```python
   import sys
   sys.path.insert(0, ".agents/skills/harness-lab")
   from lab_update_subpart import (
       init_scene, load_contract_roles, material, Geometry,
       box, frustum, ngon_frustum, tube, strut, lathe, prism, strip, parametric_patch,
       roof, roof_ridge_and_gables, radial_pitched_roof, dome_and_spire, corbel_brick_eave_stack,
       arch_cut, arch_ring, arch_grille, radial_arcade_tier,
       perimeter_boxes, frieze_band, pilaster_panel_facade,
       dougong_rafter_tier, column_colonnade, radial_colonnade,
       balustrade_perimeter, radial_balustrade, lattice_window_bay,
       louver_and_mullion_facade, diagrid_truss_shell,
       ashlar_courses, stepped_stairs,
       put_mesh, box_obj, tapered_box_obj, cyl_obj,
       arch_cutter_obj, boolean_cut, finalize_and_save,
   )
   ```
2. Invoked as a native JSON tool (`lab_update_subpart`) by the Agent.
"""
import json
import math
import os
from pathlib import Path
import subprocess
import sys

DEFAULT_ROLE_MAP = {"SUPPORTS": 1, "ROOF": 2, "BODY": 3, "BASE": 4}
ROLE_MAP = dict(DEFAULT_ROLE_MAP)
INDEX_TO_ROLE = {1: "SUPPORTS", 2: "ROOF", 3: "BODY", 4: "BASE"}
TARGET_MIN_FACES = 500000


def load_contract_roles(contract_path="part-contract.json"):
    """Dynamically load task-specific role indices and names from part-contract.json if present."""
    global ROLE_MAP, INDEX_TO_ROLE
    p = Path(contract_path)
    if not p.exists():
        return ROLE_MAP, INDEX_TO_ROLE
    try:
        pc = json.loads(p.read_text())
    except Exception:
        return ROLE_MAP, INDEX_TO_ROLE

    parts = pc.get("parts") or pc.get("roles") or []
    if isinstance(parts, list) and parts:
        for item in parts:
            if not isinstance(item, dict):
                continue
            idx = item.get("index") or item.get("part_index") or item.get("role_index") or item.get("id_index")
            pid = item.get("id") or item.get("role") or item.get("collection") or item.get("name")
            if isinstance(idx, int) and idx >= 1 and pid:
                clean_id = str(pid).strip()
                INDEX_TO_ROLE[idx] = clean_id
                ROLE_MAP[clean_id] = idx
                ROLE_MAP[clean_id.upper()] = idx
                ROLE_MAP[clean_id.lower()] = idx
            col_name = item.get("collection")
            if isinstance(idx, int) and idx >= 1 and col_name:
                c_str = str(col_name).strip()
                ROLE_MAP[c_str] = idx
                ROLE_MAP[c_str.upper()] = idx
                ROLE_MAP[c_str.lower()] = idx
    role_map_cfg = pc.get("role_map") or pc.get("part_index_map") or {}
    if isinstance(role_map_cfg, dict):
        for k, v in role_map_cfg.items():
            if isinstance(v, int) and v >= 1:
                clean_k = str(k).strip()
                ROLE_MAP[clean_k] = v
                ROLE_MAP[clean_k.upper()] = v
                ROLE_MAP[clean_k.lower()] = v
                INDEX_TO_ROLE[v] = clean_k
    return ROLE_MAP, INDEX_TO_ROLE


def print_contract_roles(contract_path="part-contract.json"):
    """Print the active part-contract.json role table so scripts can inspect role indices and requirements."""
    load_contract_roles(contract_path)
    p = Path(contract_path)
    if p.exists():
        try:
            pc = json.loads(p.read_text())
            parts = pc.get("parts") or []
            if parts:
                print(f"[PART CONTRACT] Loaded {len(parts)} task-specific roles from {contract_path}:")
                for item in parts:
                    if isinstance(item, dict):
                        idx = item.get("index")
                        pid = item.get("id")
                        req = item.get("requirement") or item.get("description") or item.get("name") or ""
                        print(f"  - role={idx} (or role='{pid}'): {req[:120]}")
                return
        except Exception:
            pass
    print("[PART CONTRACT] Active role mapping:", INDEX_TO_ROLE)


load_contract_roles()

try:
    import bpy
    import bmesh
    from mathutils import Euler, Matrix, Vector
    IN_BLENDER = True
except ImportError:
    IN_BLENDER = False


if IN_BLENDER:
    collections = {}

    def _resolve_role(role):
        load_contract_roles()
        if isinstance(role, int) and role >= 1:
            r_name = INDEX_TO_ROLE.get(role, f"PART_{role}")
            INDEX_TO_ROLE.setdefault(role, r_name)
            ROLE_MAP.setdefault(r_name, role)
            ROLE_MAP.setdefault(r_name.upper(), role)
            return role, r_name
        r_raw = str(role).strip()
        if r_raw.isdigit() and int(r_raw) >= 1:
            idx = int(r_raw)
            r_name = INDEX_TO_ROLE.get(idx, f"PART_{idx}")
            INDEX_TO_ROLE.setdefault(idx, r_name)
            ROLE_MAP.setdefault(r_name, idx)
            return idx, r_name
        if r_raw in ROLE_MAP:
            idx = ROLE_MAP[r_raw]
            return idx, INDEX_TO_ROLE.get(idx, r_raw)
        r_str = r_raw.upper()
        if r_str in ROLE_MAP:
            idx = ROLE_MAP[r_str]
            return idx, INDEX_TO_ROLE.get(idx, r_str)
        for k, v in ROLE_MAP.items():
            if len(k) >= 3 and (k.upper() in r_str or r_str in k.upper()):
                return v, INDEX_TO_ROLE.get(v, k)
        # Fallback: default to BODY (3) or index 1 so script never crashes on custom role labels
        fallback_idx = ROLE_MAP.get("BODY", 1)
        return fallback_idx, INDEX_TO_ROLE.get(fallback_idx, "BODY")

    def material(name, color=(0.58, 0.58, 0.60), roughness=0.75, grain=0):
        """Procedural architectural material with optional fine stone/timber noise-bump grain."""
        mat = bpy.data.materials.get(name)
        if mat is None:
            mat = bpy.data.materials.new(name)
        rgb = tuple(color[:3])
        mat.diffuse_color = (*rgb, 1.0)
        mat.use_nodes = True
        nodes = mat.node_tree.nodes
        shader = nodes.get("Principled BSDF")
        if shader:
            shader.inputs["Base Color"].default_value = (*rgb, 1.0)
            shader.inputs["Roughness"].default_value = float(roughness)
            if grain and "ShaderNodeTexNoise" not in [n.bl_idname for n in nodes]:
                noise = nodes.new("ShaderNodeTexNoise")
                noise.inputs["Scale"].default_value = float(grain)
                bump = nodes.new("ShaderNodeBump")
                bump.inputs["Strength"].default_value = 0.18
                bump.inputs["Distance"].default_value = 0.0007
                mat.node_tree.links.new(noise.outputs["Fac"], bump.inputs["Height"])
                mat.node_tree.links.new(bump.outputs["Normal"], shader.inputs["Normal"])
        return mat

    def ensure_neutral_material():
        return material("Mat_Neutral_Clay", (0.62, 0.60, 0.58), roughness=0.78, grain=140)

    def ensure_role_collection(role):
        r_idx, r_name = _resolve_role(role)
        col = bpy.data.collections.get(r_name)
        if col is None:
            col = bpy.data.collections.new(r_name)
            bpy.context.scene.collection.children.link(col)
        collections[r_idx] = col
        collections[r_name] = col
        return col

    def init_scene(clear=True, clear_all=None):
        """Initialize scene, clear default objects if requested, and create Role Collections from part-contract.json."""
        load_contract_roles()
        if clear_all is not None:
            clear = bool(clear_all)
        if clear:
            for obj in list(bpy.data.objects):
                bpy.data.objects.remove(obj, do_unlink=True)
            for mesh in list(bpy.data.meshes):
                if mesh.users == 0:
                    bpy.data.meshes.remove(mesh)
            keep_cols = set(INDEX_TO_ROLE.values()) | set(DEFAULT_ROLE_MAP.keys())
            for col in list(bpy.data.collections):
                if col.name not in keep_cols:
                    bpy.data.collections.remove(col)
        for idx, r_name in sorted(INDEX_TO_ROLE.items()):
            ensure_role_collection(r_name)
        for r_name in DEFAULT_ROLE_MAP:
            ensure_role_collection(r_name)
        ensure_neutral_material()
        print_contract_roles()
        return bpy.context.scene

    def stamp_object_contract(obj, role, mat=None):
        """Stamp FACE INT reward_part_index and link object to Role Collection."""
        if obj is None or obj.type != "MESH" or obj.data is None:
            return
        r_idx, r_name = _resolve_role(role)
        mesh = obj.data
        n_faces = len(mesh.polygons)
        attr = mesh.attributes.get("reward_part_index")
        if attr is not None and (attr.domain != "FACE" or attr.data_type != "INT"):
            mesh.attributes.remove(attr)
            attr = None
        if attr is None:
            attr = mesh.attributes.new(name="reward_part_index", type="INT", domain="FACE")
        if n_faces > 0:
            attr.data.foreach_set("value", [r_idx] * n_faces)
        obj["reward_part_index"] = r_idx
        obj["semantic_role"] = r_name
        if len(mesh.materials) == 0:
            mesh.materials.append(mat or ensure_neutral_material())
        elif mat is not None:
            mesh.materials[0] = mat
        target_col = ensure_role_collection(r_name)
        if obj.name not in target_col.objects:
            target_col.objects.link(obj)
        for col in list(obj.users_collection):
            if col != target_col:
                col.objects.unlink(obj)

    _ACTIVE_GEOMETRIES = []
    _GEOM_NAME_COUNTS = {}

    class Geometry:
        """Fast vertex/face mesh accumulator that builds a contract-stamped Mesh Object per architectural component."""

        def __init__(self, name, role=None, mat=None):
            if role is not None and hasattr(role, "diffuse_color") and mat is None:
                mat, role = role, None
            if role is None:
                load_contract_roles()
                if isinstance(name, int) or (isinstance(name, str) and name.strip().isdigit()):
                    role = int(name)
                else:
                    n_str = str(name).strip()
                    if n_str in ROLE_MAP or n_str.upper() in ROLE_MAP or n_str.lower() in ROLE_MAP:
                        role = n_str
                    else:
                        for k in list(ROLE_MAP.keys()):
                            if len(str(k)) >= 3 and (n_str.lower().startswith(str(k).lower()) or str(k).lower() in n_str.lower()):
                                role = k
                                break
                if role is None:
                    role = INDEX_TO_ROLE.get(1, "BODY")
            r_idx, r_name = _resolve_role(role)
            self.raw_name = str(name)
            prefix = f"{r_name}_"
            if self.raw_name == r_name or self.raw_name.startswith(prefix) or self.raw_name.startswith(f"{r_name} |"):
                base_obj_name = self.raw_name
            else:
                base_obj_name = f"{r_name}_{self.raw_name}"
            cnt = _GEOM_NAME_COUNTS.get(base_obj_name, 0) + 1
            _GEOM_NAME_COUNTS[base_obj_name] = cnt
            self.name = base_obj_name if cnt == 1 else f"{base_obj_name}_{cnt}"
            self.role_idx = r_idx
            self.role_name = r_name
            self.mat = mat
            self.vertices = []
            self.faces = []
            self._finished = False
            _ACTIVE_GEOMETRIES.append(self)

        def poly(self, vertices, faces):
            start = len(self.vertices)
            self.vertices.extend(
                (float(v[0]), float(v[1]), float(v[2])) for v in vertices
            )
            self.faces.extend(
                tuple(start + int(index) for index in face) for face in faces
            )
            return self

        def box(self, center, size, subdiv=1):
            cx, cy, cz = (float(v) for v in center)
            hx, hy, hz = (abs(float(v)) * 0.5 for v in size)
            if subdiv <= 1:
                self.poly(
                    [
                        (cx + dx * hx, cy + dy * hy, cz + dz * hz)
                        for dx, dy, dz in [
                            (-1, -1, -1), (1, -1, -1), (1, 1, -1), (-1, 1, -1),
                            (-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1),
                        ]
                    ],
                    [
                        (0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
                        (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7),
                    ],
                )
            else:
                self.box_bounds(cx - hx, cx + hx, cy - hy, cy + hy, cz - hz, cz + hz, subdiv=subdiv)
            return self

        def box_bounds(self, x0, x1, y0, y1, z0, z1, subdiv=1):
            if x0 > x1:
                x0, x1 = x1, x0
            if y0 > y1:
                y0, y1 = y1, y0
            if z0 > z1:
                z0, z1 = z1, z0
            if subdiv <= 1:
                return self.box(((x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5), (x1 - x0, y1 - y0, z1 - z0))
            n = int(subdiv)
            # 6 subdivided quad faces
            for fixed, flip in [(z0, True), (z1, False)]:
                vs = [(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * j / n, fixed) for j in range(n + 1) for i in range(n + 1)]
                fs = []
                for j in range(n):
                    for i in range(n):
                        a = j * (n + 1) + i
                        f = (a, a + 1, a + n + 2, a + n + 1)
                        fs.append(tuple(reversed(f)) if flip else f)
                self.poly(vs, fs)
            for fixed, flip in [(y0, False), (y1, True)]:
                vs = [(x0 + (x1 - x0) * i / n, fixed, z0 + (z1 - z0) * j / n) for j in range(n + 1) for i in range(n + 1)]
                fs = []
                for j in range(n):
                    for i in range(n):
                        a = j * (n + 1) + i
                        f = (a, a + 1, a + n + 2, a + n + 1)
                        fs.append(tuple(reversed(f)) if flip else f)
                self.poly(vs, fs)
            for fixed, flip in [(x0, True), (x1, False)]:
                vs = [(fixed, y0 + (y1 - y0) * i / n, z0 + (z1 - z0) * j / n) for j in range(n + 1) for i in range(n + 1)]
                fs = []
                for j in range(n):
                    for i in range(n):
                        a = j * (n + 1) + i
                        f = (a, a + 1, a + n + 2, a + n + 1)
                        fs.append(tuple(reversed(f)) if flip else f)
                self.poly(vs, fs)
            return self

        def frustum(self, lower, upper, bottom, top, center_x=0.0, center_y=0.0, sides=4, rot_deg=0.0, ellipse_ratio=1.0, subdiv=1):
            if isinstance(lower, (int, float)) and isinstance(upper, (int, float)) and isinstance(bottom, (tuple, list)):
                lower, upper, bottom, top = bottom, top, lower, upper
            if isinstance(lower, (int, float)) and isinstance(upper, (int, float)):
                return self.ngon_frustum(float(lower), float(upper), float(bottom), float(top), sides=max(4, int(sides) if int(sides) != 4 else 16), center_x=center_x, center_y=center_y, rot_deg=rot_deg, ellipse_ratio=ellipse_ratio)
            self.poly(
                [
                    (center_x + sx * hx, center_y + sy * hy, z)
                    for hx, hy, z in [(lower[0], lower[1], bottom), (upper[0], upper[1], top)]
                    for sx, sy in [(-1, -1), (1, -1), (1, 1), (-1, 1)]
                ],
                [
                    (0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
                    (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7),
                ],
            )
            return self

        def tube(self, points, radius, sides=8, closed=False):
            """Swept polygonal tube along a 3D polyline (for roof ridges, barrel tiles, railings, and pipes)."""
            pts = [Vector(p) for p in points]
            n_pts = len(pts)
            if n_pts < 2:
                return self
            sides = max(3, int(sides))
            vertices = []
            for index, point in enumerate(pts):
                if closed:
                    tangent = pts[(index + 1) % n_pts] - pts[(index - 1) % n_pts]
                else:
                    tangent = pts[min(index + 1, n_pts - 1)] - pts[max(index - 1, 0)]
                if tangent.length < 1e-9:
                    tangent = Vector((0, 0, 1))
                else:
                    tangent.normalize()
                normal = tangent.cross(Vector((0, 0, 1)))
                if normal.length < 0.01:
                    normal = tangent.cross(Vector((0, 1, 0)))
                normal.normalize()
                binormal = tangent.cross(normal).normalized()
                for side in range(sides):
                    angle = side * 2.0 * math.pi / sides
                    v = point + radius * (normal * math.cos(angle) + binormal * math.sin(angle))
                    vertices.append((v.x, v.y, v.z))
            faces = []
            if not closed:
                faces.append(tuple(reversed(range(sides))))
                faces.append(tuple((n_pts - 1) * sides + side for side in range(sides)))
            ring_count = n_pts if closed else (n_pts - 1)
            for ring in range(ring_count):
                next_ring = (ring + 1) % n_pts
                for side in range(sides):
                    following = (side + 1) % sides
                    faces.append((
                        ring * sides + side,
                        ring * sides + following,
                        next_ring * sides + following,
                        next_ring * sides + side,
                    ))
            self.poly(vertices, faces)
            return self

        def strut(self, p1, p2, thickness, sides=6):
            """Diagonal brace or structural bar connecting p1 and p2."""
            return self.tube([p1, p2], radius=float(thickness) * 0.5, sides=sides, closed=False)

        def lathe(self, xyz, profile, sides=24, ellipse_ratio=1.0, rot_deg=0.0):
            """Surface of revolution around Z axis at base xyz=(x, y, z0); profile=[(dz, r), ...].
            Supports circular (sides>=24), polygonal (sides=6,8,12), and elliptical (ellipse_ratio=ry/rx) plans.
            """
            cx, cy, cz = (float(v) for v in xyz)
            sides = max(3, int(sides))
            er = float(ellipse_ratio)
            rot_rad = math.radians(float(rot_deg))
            vs = [
                (cx + float(r) * math.cos(rot_rad + 2.0 * math.pi * i / sides),
                 cy + float(r) * er * math.sin(rot_rad + 2.0 * math.pi * i / sides),
                 cz + float(dz))
                for dz, r in profile
                for i in range(sides)
            ]
            fs = []
            for j in range(len(profile) - 1):
                for i in range(sides):
                    a = j * sides + i
                    b = j * sides + (i + 1) % sides
                    fs.append((a, b, b + sides, a + sides))
            if len(profile) >= 2:
                fs.append(tuple(range(sides - 1, -1, -1)))
                fs.append(tuple((len(profile) - 1) * sides + i for i in range(sides)))
            self.poly(vs, fs)
            return self

        def ngon_frustum(self, radius_bottom, radius_top, bottom, top, sides=8,
                         center_x=0.0, center_y=0.0, rot_deg=0.0, ellipse_ratio=1.0, rings=1):
            """Regular N-gon, circular, or elliptical tapered frustum/cylinder/cone from z=bottom to z=top."""
            n_rings = max(1, int(rings))
            profile = [
                (
                    (top - bottom) * (k / n_rings),
                    radius_bottom + (radius_top - radius_bottom) * (k / n_rings),
                )
                for k in range(n_rings + 1)
            ]
            return self.lathe((center_x, center_y, bottom), profile, sides=sides, ellipse_ratio=ellipse_ratio, rot_deg=rot_deg)

        def parametric_patch(self, uv_func, u_steps=24, v_steps=24, thickness=0.0):
            """Build a 3D mesh from a parametric surface uv_func(u, v) -> (x, y, z) for u, v in [0, 1].
            If thickness > 0, extrudes a solid shell along local surface normals.
            """
            nu = max(2, int(u_steps))
            nv = max(2, int(v_steps))
            grid = [
                [Vector(uv_func(i / nu, j / nv)) for i in range(nu + 1)]
                for j in range(nv + 1)
            ]
            if abs(float(thickness)) <= 1e-7:
                vs = [ (p.x, p.y, p.z) for row in grid for p in row ]
                fs = []
                for j in range(nv):
                    for i in range(nu):
                        a = j * (nu + 1) + i
                        fs.append((a, a + 1, a + nu + 2, a + nu + 1))
                self.poly(vs, fs)
                return self

            th = float(thickness)
            top_vs = []
            bot_vs = []
            for j in range(nv + 1):
                for i in range(nu + 1):
                    p = grid[j][i]
                    du = grid[j][min(nu, i + 1)] - grid[j][max(0, i - 1)]
                    dv = grid[min(nv, j + 1)][i] - grid[max(0, j - 1)][i]
                    nrm = du.cross(dv)
                    if nrm.length < 1e-8:
                        nrm = Vector((0.0, 0.0, 1.0))
                    else:
                        nrm.normalize()
                    p_top = p + nrm * (th * 0.5)
                    p_bot = p - nrm * (th * 0.5)
                    top_vs.append((p_top.x, p_top.y, p_top.z))
                    bot_vs.append((p_bot.x, p_bot.y, p_bot.z))
            n_pts = (nu + 1) * (nv + 1)
            vs = top_vs + bot_vs
            fs = []
            for j in range(nv):
                for i in range(nu):
                    a = j * (nu + 1) + i
                    fs.append((a, a + 1, a + nu + 2, a + nu + 1))
                    b = n_pts + a
                    fs.append((b, b + nu + 1, b + nu + 2, b + 1))
            for i in range(nu):
                a0, a1 = i, i + 1
                fs.append((a0, a1, n_pts + a1, n_pts + a0))
                t0, t1 = nv * (nu + 1) + i, nv * (nu + 1) + i + 1
                fs.append((t1, t0, n_pts + t0, n_pts + t1))
            for j in range(nv):
                l0, l1 = j * (nu + 1), (j + 1) * (nu + 1)
                fs.append((l1, l0, n_pts + l0, n_pts + l1))
                r0, r1 = j * (nu + 1) + nu, (j + 1) * (nu + 1) + nu
                fs.append((r0, r1, n_pts + r1, n_pts + r0))
            self.poly(vs, fs)
            return self

        def polar_repeat(self, count, builder_fn, radius=0.0, center_x=0.0, center_y=0.0,
                         start_deg=0.0, end_deg=360.0, ellipse_ratio=1.0):
            """Invoke builder_fn(self, idx, angle_rad, px, py, nx, ny) around a circular or elliptical ring."""
            n = max(1, int(count))
            span = float(end_deg) - float(start_deg)
            full_circle = abs(abs(span) - 360.0) < 1e-3
            er = float(ellipse_ratio)
            for idx in range(n):
                frac = idx / n if full_circle else (idx / max(1, n - 1))
                ang = math.radians(float(start_deg) + span * frac)
                c, s = math.cos(ang), math.sin(ang)
                px = float(center_x) + float(radius) * c
                py = float(center_y) + float(radius) * er * s
                builder_fn(self, idx, ang, px, py, c, s)
            return self

        def prism(self, poly_2d, v0, v1, axis="Y"):
            """Extrude a 2D polygon [(u, w), ...] from v0 to v1 along axis ('X', 'Y', or 'Z')."""
            n = len(poly_2d)
            if n < 3:
                return self
            ax = axis.upper()
            verts = []
            for v in (v0, v1):
                for u, w in poly_2d:
                    if ax == "Y":
                        verts.append((u, v, w))
                    elif ax == "X":
                        verts.append((v, u, w))
                    else:
                        verts.append((u, w, v))
            faces = [tuple(range(n - 1, -1, -1)), tuple(range(n, 2 * n))]
            faces.extend((i, (i + 1) % n, (i + 1) % n + n, i + n) for i in range(n))
            self.poly(verts, faces)
            return self

        def prism_xz(self, poly_xz, y0, y1):
            """Extrude front-elevation `(X, Z)` polygon along `Y` in `[min(y0,y1), max(y0,y1)]`."""
            return self.prism(poly_xz, min(float(y0), float(y1)), max(float(y0), float(y1)), axis="Y")

        def prism_yz(self, poly_yz, x0, x1):
            """Extrude side-elevation `(Y, Z)` polygon along `X` in `[min(x0,x1), max(x0,x1)]` (`Y` centered around `CY`)."""
            return self.prism(poly_yz, min(float(x0), float(x1)), max(float(x0), float(x1)), axis="X")

        def prism_xy(self, poly_xy, z0, z1):
            """Extrude top-plan `(X, Y)` polygon vertically along `Z` in `[min(z0,z1), max(z0,z1)]`."""
            return self.prism(poly_xy, min(float(z0), float(z1)), max(float(z0), float(z1)), axis="Z")

        def strip(self, low_path, high_path, v0, v1, axis="Y"):
            """Extrude a band between two equal-length 2D curves low_path and high_path."""
            ax = axis.upper()
            vs, fs = [], []
            pairs = list(zip(low_path, high_path))
            if len(pairs) < 2:
                return self
            for (u0, w0), (u1, w1) in pairs:
                for v in (v0, v1):
                    for u, w in ((u0, w0), (u1, w1)):
                        if ax == "Y":
                            vs.append((u, v, w))
                        elif ax == "X":
                            vs.append((v, u, w))
                        else:
                            vs.append((u, w, v))
            for i in range(len(pairs) - 1):
                k = 4 * i
                j = k + 4
                fs.extend([
                    (k, j, j + 1, k + 1),
                    (k + 2, k + 3, j + 3, j + 2),
                    (k, k + 2, j + 2, j),
                    (k + 1, j + 1, j + 3, k + 3),
                ])
            fs.extend([(0, 1, 3, 2), (len(vs) - 4, len(vs) - 2, len(vs) - 1, len(vs) - 3)])
            self.poly(vs, fs)
            return self

        def finish(self, bevel=0.0, bevel_segments=2, smooth=False):
            """Finalize into a named Blender Mesh Object with stamped reward_part_index."""
            self._finished = True
            if not self.vertices or not self.faces:
                return None
            old = bpy.data.objects.get(self.name)
            if old is not None:
                old_data = old.data
                bpy.data.objects.remove(old, do_unlink=True)
                if old_data is not None and old_data.users == 0 and isinstance(old_data, bpy.types.Mesh):
                    bpy.data.meshes.remove(old_data)
            mesh = bpy.data.meshes.new(self.name)
            if self.vertices and self.faces:
                mesh.from_pydata(self.vertices, [], self.faces)
                mesh.update()
            obj = bpy.data.objects.new(self.name, mesh)
            stamp_object_contract(obj, self.role_idx, mat=self.mat)
            if smooth:
                for p in mesh.polygons:
                    p.use_smooth = True
            if bevel and float(bevel) > 0:
                mod = obj.modifiers.new("DressedEdges", "BEVEL")
                mod.width = float(bevel)
                mod.segments = max(1, int(bevel_segments))
                bpy.context.view_layer.update()
                deps = bpy.context.evaluated_depsgraph_get()
                eval_obj = obj.evaluated_get(deps)
                baked = bpy.data.meshes.new_from_object(eval_obj)
                baked.name = self.name + "_Mesh"
                obj.modifiers.clear()
                old_mesh = obj.data
                obj.data = baked
                if old_mesh is not None and old_mesh.users == 0:
                    bpy.data.meshes.remove(old_mesh)
                stamp_object_contract(obj, self.role_idx, mat=self.mat)
            return obj

    # ─── Core Parametric Architectural Primitives ───────────────────────────────

    def box(name, center, size, role="BODY", mat=None, bevel=0.0, subdiv=1):
        """Create a standalone box object centered at `center` with dimensions `size`."""
        g = Geometry(name, role, mat)
        g.box(center, size, subdiv=subdiv)
        return g.finish(bevel=bevel)

    def frustum(name, lower, upper, bottom, top, role="BODY", mat=None, center_x=0.0, center_y=0.0, bevel=0.0):
        """Create a battered frustum object with half-extents lower=(hx0, hy0), upper=(hx1, hy1)."""
        g = Geometry(name, role, mat)
        g.frustum(lower, upper, bottom, top, center_x=center_x, center_y=center_y)
        return g.finish(bevel=bevel)

    def tube(name, points, radius, role="BODY", mat=None, sides=8, closed=False):
        """Create a standalone swept tube object along `points`."""
        g = Geometry(name, role, mat)
        g.tube(points, radius, sides=sides, closed=closed)
        return g.finish()

    def lathe(name, xyz, profile, role="SUPPORTS", mat=None, sides=24, ellipse_ratio=1.0, rot_deg=0.0):
        """Create a standalone revolved object around Z at `xyz`."""
        g = Geometry(name, role, mat)
        g.lathe(xyz, profile, sides=sides, ellipse_ratio=ellipse_ratio, rot_deg=rot_deg)
        return g.finish(smooth=(sides >= 16))

    def ngon_frustum(name, radius_bottom, radius_top, bottom, top, sides=8, role="BODY", mat=None,
                     center_x=0.0, center_y=0.0, rot_deg=0.0, ellipse_ratio=1.0, rings=2, bevel=0.0):
        """Create a regular N-gon, circular, or elliptical tapered frustum/cylinder/cone."""
        g = Geometry(name, role, mat)
        g.ngon_frustum(radius_bottom, radius_top, bottom, top, sides=sides,
                       center_x=center_x, center_y=center_y, rot_deg=rot_deg,
                       ellipse_ratio=ellipse_ratio, rings=rings)
        return g.finish(bevel=bevel, smooth=(sides >= 24))

    def parametric_patch(name, uv_func, u_steps=28, v_steps=28, thickness=0.0, role="ROOF", mat=None, smooth=True):
        """Create a 3D mesh or thick shell from a parametric surface uv_func(u, v) -> (x, y, z)."""
        g = Geometry(name, role, mat)
        g.parametric_patch(uv_func, u_steps=u_steps, v_steps=v_steps, thickness=thickness)
        return g.finish(smooth=smooth)

    def prism(name, poly_2d, v0, v1, role="BODY", mat=None, axis="Y", bevel=0.0):
        """Create a standalone extruded prism object from a 2D polygon."""
        g = Geometry(name, role, mat)
        g.prism(poly_2d, v0, v1, axis=axis)
        return g.finish(bevel=bevel)

    def strut(name, p1, p2, thickness, role="SUPPORTS", mat=None, sides=6):
        """Create a standalone 3D strut between `p1` and `p2`."""
        g = Geometry(name, role, mat)
        g.strut(p1, p2, thickness, sides=sides)
        return g.finish()

    def strip(name, low_path, high_path, v0, v1, role="BODY", mat=None, axis="Y"):
        """Create a standalone extruded strip between `low_path` and `high_path`."""
        g = Geometry(name, role, mat)
        g.strip(low_path, high_path, v0, v1, axis=axis)
        return g.finish()

    def _arch_curve_points(center_u, spring, radius, segments=36, style="round", pointed_sharpness=1.35):
        segs = max(12, int(segments))
        st = str(style or "round").lower()
        pts = []
        for i in range(segs + 1):
            ang = i * math.pi / segs
            u = center_u + radius * math.cos(ang)
            s = math.sin(ang)
            if st in ("pointed", "gothic", "islamic", "ogive"):
                # Pointed ogival arch profile
                z = spring + radius * float(pointed_sharpness) * (s ** 0.78)
            elif st in ("segmental", "flat", "low"):
                z = spring + radius * 0.55 * s
            else:
                z = spring + radius * s
            pts.append((u, z))
        return pts

    def arch_ring(name, center_x, front, back, bottom, spring, radius, width=0.006, role="BODY", mat=None,
                  segments=28, jamb_blocks=6, axis="Y", style="round", pointed_sharpness=1.35):
        """Radial dressed voussoir arch ring and jamb blocks (round, pointed, or segmental)."""
        g = Geometry(name, role, mat)
        segs = max(12, int(segments))
        ax = axis.upper()
        st = str(style or "round").lower()
        sharp = float(pointed_sharpness) if st in ("pointed", "gothic", "islamic", "ogive") else (0.55 if st in ("segmental", "low") else 1.0)
        exp = 0.78 if st in ("pointed", "gothic", "islamic", "ogive") else 1.0
        for index in range(segs):
            start = index * math.pi / segs + 0.003
            end = (index + 1) * math.pi / segs - 0.003
            vertices = []
            for depth in [front, back]:
                for rad, angle in [(radius, start), (radius, end), (radius + width, end), (radius + width, start)]:
                    u = center_x + rad * math.cos(angle)
                    z = spring + rad * sharp * (max(0.0, math.sin(angle)) ** exp)
                    vertices.append((u, depth, z) if ax == "Y" else (depth, u, z))
            g.poly(vertices, [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)])
        if jamb_blocks > 0 and spring > bottom:
            h_step = (spring - bottom) / jamb_blocks
            for sign in [-1, 1]:
                for idx in range(jamb_blocks):
                    u_c = center_x + sign * (radius + width * 0.5)
                    d_c = (front + back) * 0.5
                    z_c = bottom + (idx + 0.5) * h_step
                    if ax == "Y":
                        g.box((u_c, d_c, z_c), (width, abs(back - front), h_step * 0.92))
                    else:
                        g.box((d_c, u_c, z_c), (abs(back - front), width, h_step * 0.92))
        return g.finish(bevel=0.0004)

    def arch_grille(name, center_x, y_pos, bottom, spring, radius, role="BODY", mat=None, n_vert=13, n_horiz=6, bar_thickness=0.0024, axis="Y"):
        """Recessed orthogonal lattice grille fitted inside a semicircular arched opening (`z_top(x) = spring + sqrt(r^2 - x^2)`)."""
        g = Geometry(name, role, mat)
        ax = axis.upper()
        half_n = max(2, int(n_vert) // 2)
        for index in range(-half_n, half_n + 1):
            offset = index * radius / (half_n + 0.6)
            top = spring + math.sqrt(max(0.0, radius * radius - offset * offset))
            if top > bottom:
                if ax == "Y":
                    g.box((center_x + offset, y_pos, (bottom + top) * 0.5), (bar_thickness, bar_thickness * 1.2, top - bottom))
                else:
                    g.box((y_pos, center_x + offset, (bottom + top) * 0.5), (bar_thickness * 1.2, bar_thickness, top - bottom))
        z_max = spring + radius * 0.92
        for i in range(max(2, int(n_horiz))):
            hz = bottom + (i + 0.7) * (z_max - bottom) / max(2, int(n_horiz))
            half = radius if hz <= spring else math.sqrt(max(0.0, radius * radius - (hz - spring) ** 2))
            if half > 0.002:
                if ax == "Y":
                    g.box((center_x, y_pos, hz), (2.0 * half, bar_thickness * 1.2, bar_thickness))
                else:
                    g.box((y_pos, center_x, hz), (bar_thickness * 1.2, 2.0 * half, bar_thickness))
        return g.finish()

    # Watertight `roof(..., collar_only=False)`, `roof_ridge_and_gables`, `univ_curved_hip_gable_roof`,
    # outward-normal `arch_cut`, `prism_xz`/`prism_yz`/`prism_xy`, and `render_inspection_sheet`
    # are imported and re-exported from `lab_roof_and_aperture_ops.py`.

    def perimeter_boxes(name, hx, hy, center_y=0.0, height=0.25, thickness=0.018, depth=0.014,
                        role="BODY", mat=None, center_x=0.0, bevel=0.0, subdiv=2):
        """Four-sided rectangular ring of tie-beams, cornices, or belt courses around `(center_x, center_y)`."""
        g = Geometry(name, role, mat)
        for side in [-1, 1]:
            g.box((center_x, center_y + side * hy, height), (hx * 2.0, depth, thickness), subdiv=subdiv)
            g.box((center_x + side * hx, center_y, height), (depth, hy * 2.0, thickness), subdiv=subdiv)
        return g.finish(bevel=bevel)

    def frieze_band(name, hx, hy, center_y=0.0, height=0.25, thickness=0.018, depth=0.014,
                    role="BODY", panels_x=11, panels_y=5, center_x=0.0):
        """Layered architectural frieze belt with upper/lower mouldings and raised carved panel reliefs."""
        m_teal = material("Frieze_Blue_Green", (0.095, 0.205, 0.20), 0.72)
        m_cream = material("Carved_Trim_Stone", (0.61, 0.53, 0.36), 0.72)
        o_main = perimeter_boxes(f"{name}_frieze_core", hx, hy, center_y, height, thickness, depth, role, m_teal, center_x=center_x)
        half_t = thickness * 0.55
        o_m1 = perimeter_boxes(f"{name}_mould_low", hx + 0.001, hy + 0.001, center_y, height - half_t, 0.0025, depth + 0.0015, role, m_cream, center_x=center_x)
        o_m2 = perimeter_boxes(f"{name}_mould_high", hx + 0.001, hy + 0.001, center_y, height + half_t, 0.0025, depth + 0.0015, role, m_cream, center_x=center_x)
        panels = Geometry(f"{name}_raised_frieze_motifs", role, m_cream)
        nx = max(3, int(panels_x))
        ny = max(2, int(panels_y))
        span_x = 2.0 * hx / nx
        span_y = 2.0 * hy / ny
        w_x = span_x * 0.34
        h_p = thickness * 0.28
        for side in [-1, 1]:
            y_out = center_y + side * (hy + depth * 0.55)
            for idx in range(nx):
                cx = center_x - hx + (idx + 0.5) * span_x
                panels.tube(
                    [
                        (cx - w_x, y_out, height),
                        (cx - w_x * 0.65, y_out, height + h_p),
                        (cx + w_x * 0.65, y_out, height + h_p),
                        (cx + w_x, y_out, height),
                        (cx + w_x * 0.65, y_out, height - h_p),
                        (cx - w_x * 0.65, y_out, height - h_p),
                        (cx - w_x, y_out, height),
                    ],
                    0.0009,
                    6,
                )
                panels.box((cx, y_out, height), (w_x * 0.9, 0.0015, h_p * 0.9))
            x_out = center_x + side * (hx + depth * 0.55)
            for idx in range(ny):
                cy = center_y - hy + (idx + 0.5) * span_y
                panels.box((x_out, cy, height), (0.0018, span_y * 0.55, thickness * 0.42), subdiv=2)
        o_panels = panels.finish()
        return [o_main, o_m1, o_m2, o_panels]

    # ─── Direct BMesh Object Placement & Boolean Helpers ────────────────────────

    def put_mesh(role, subpart_name, bm_or_mesh, location=(0.0, 0.0, 0.0), rotation_deg=(0.0, 0.0, 0.0), scale=(1.0, 1.0, 1.0)):
        r_idx, r_name = _resolve_role(role)
        obj_name = subpart_name if str(subpart_name).startswith(f"{r_name}_") else f"{r_name}_{subpart_name}"
        old_obj = bpy.data.objects.get(obj_name)
        if old_obj is not None:
            old_data = old_obj.data
            bpy.data.objects.remove(old_obj, do_unlink=True)
            if old_data is not None and old_data.users == 0 and isinstance(old_data, bpy.types.Mesh):
                bpy.data.meshes.remove(old_data)
        if isinstance(bm_or_mesh, bmesh.types.BMesh):
            bmesh.ops.recalc_face_normals(bm_or_mesh, faces=bm_or_mesh.faces)
            mesh = bpy.data.meshes.new(f"{obj_name}_Mesh")
            bm_or_mesh.to_mesh(mesh)
            bm_or_mesh.free()
        elif isinstance(bm_or_mesh, bpy.types.Mesh):
            mesh = bm_or_mesh
            mesh.name = f"{obj_name}_Mesh"
        else:
            raise TypeError("bm_or_mesh must be a BMesh or bpy.types.Mesh")
        mesh.update()
        obj = bpy.data.objects.new(obj_name, mesh)
        obj.location = Vector(location)
        obj.rotation_mode = "XYZ"
        obj.rotation_euler = Euler([math.radians(a) for a in rotation_deg], "XYZ")
        obj.scale = Vector(scale)
        stamp_object_contract(obj, r_idx)
        bpy.context.view_layer.update()
        return obj

    def box_obj(role, subpart_name, x0, x1, y0, y1, z0, z1, rotation_deg=(0.0, 0.0, 0.0), bevel_width=0.0, subdiv=2):
        cx, cy, cz = (x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5
        dx, dy, dz = abs(x1 - x0), abs(y1 - y0), abs(z1 - z0)
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        bmesh.ops.scale(bm, vec=(dx, dy, dz), verts=bm.verts)
        if subdiv > 1 and len(bm.edges) > 0:
            bmesh.ops.subdivide_edges(bm, edges=list(bm.edges), cuts=int(subdiv) - 1, use_grid_fill=True)
        if bevel_width > 0.0:
            bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel_width, segments=2, profile=0.5, affect="EDGES")
        return put_mesh(role, subpart_name, bm, location=(cx, cy, cz), rotation_deg=rotation_deg)

    def tapered_box_obj(role, subpart_name, x0, x1, y0, y1, z0, z1, top_scale_x=0.88, top_scale_y=0.88, rotation_deg=(0.0, 0.0, 0.0), subdiv=2):
        cx, cy, cz = (x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5
        hx, hy, hz = abs(x1 - x0) * 0.5, abs(y1 - y0) * 0.5, abs(z1 - z0) * 0.5
        bm = bmesh.new()
        v0 = bm.verts.new((-hx, -hy, -hz))
        v1 = bm.verts.new((hx, -hy, -hz))
        v2 = bm.verts.new((hx, hy, -hz))
        v3 = bm.verts.new((-hx, hy, -hz))
        v4 = bm.verts.new((-hx * top_scale_x, -hy * top_scale_y, hz))
        v5 = bm.verts.new((hx * top_scale_x, -hy * top_scale_y, hz))
        v6 = bm.verts.new((hx * top_scale_x, hy * top_scale_y, hz))
        v7 = bm.verts.new((-hx * top_scale_x, hy * top_scale_y, hz))
        for f in [(v3, v2, v1, v0), (v4, v5, v6, v7), (v0, v1, v5, v4), (v1, v2, v6, v5), (v2, v3, v7, v6), (v3, v0, v4, v7)]:
            bm.faces.new(f)
        if subdiv > 1 and len(bm.edges) > 0:
            bmesh.ops.subdivide_edges(bm, edges=list(bm.edges), cuts=int(subdiv) - 1, use_grid_fill=True)
        return put_mesh(role, subpart_name, bm, location=(cx, cy, cz), rotation_deg=rotation_deg)

    def cyl_obj(role, subpart_name, cx, cy, z0, z1, radius, segments=24, rotation_deg=(0.0, 0.0, 0.0)):
        cz = (z0 + z1) * 0.5
        depth = abs(z1 - z0)
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=max(12, int(segments)), radius1=radius, radius2=radius, depth=depth)
        return put_mesh(role, subpart_name, bm, location=(cx, cy, cz), rotation_deg=rotation_deg)

    def arch_cutter_obj(cx, y0, y1, z0, z_spring, arch_radius, segments=32, name_suffix="arch"):
        bm = bmesh.new()
        pts_2d = [(cx - arch_radius, z0), (cx + arch_radius, z0)]
        for i in range(segments + 1):
            ang = math.pi * i / segments
            pts_2d.append((cx + arch_radius * math.cos(ang), z_spring + arch_radius * math.sin(ang)))
        front_verts = [bm.verts.new((x, y0, z)) for (x, z) in pts_2d]
        back_verts = [bm.verts.new((x, y1, z)) for (x, z) in pts_2d]
        bm.faces.new(front_verts)
        bm.faces.new(list(reversed(back_verts)))
        n = len(pts_2d)
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((front_verts[i], front_verts[j], back_verts[j], back_verts[i]))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        mesh = bpy.data.meshes.new(f"CUTTER_{name_suffix}_Mesh")
        bm.to_mesh(mesh)
        bm.free()
        obj = bpy.data.objects.new(f"CUTTER_{name_suffix}", mesh)
        bpy.context.scene.collection.objects.link(obj)
        bpy.context.view_layer.update()
        return obj

    def boolean_cut(target_obj, cutter_objs, operation="DIFFERENCE", delete_cutters=True):
        if not isinstance(cutter_objs, (list, tuple)):
            cutter_objs = [cutter_objs]
        role_idx = int(target_obj.get("reward_part_index", 3))
        role_name = INDEX_TO_ROLE.get(role_idx, "BODY")
        for idx, cutter in enumerate(cutter_objs):
            if cutter is None:
                continue
            mod = target_obj.modifiers.new(name=f"Bool_{idx}", type="BOOLEAN")
            mod.operation = operation
            mod.solver = "EXACT"
            mod.object = cutter
        bpy.context.view_layer.update()
        depsgraph = bpy.context.evaluated_depsgraph_get()
        eval_obj = target_obj.evaluated_get(depsgraph)
        new_mesh = bpy.data.meshes.new_from_object(eval_obj)
        new_mesh.name = f"{target_obj.name}_BakedMesh"
        old_mesh = target_obj.data
        target_obj.modifiers.clear()
        target_obj.data = new_mesh
        if old_mesh is not None and old_mesh.users == 0:
            bpy.data.meshes.remove(old_mesh)
        stamp_object_contract(target_obj, role_name)
        if delete_cutters:
            for cutter in cutter_objs:
                if cutter is not None and cutter.name in bpy.data.objects:
                    c_data = cutter.data
                    bpy.data.objects.remove(cutter, do_unlink=True)
                    if c_data is not None and c_data.users == 0 and isinstance(c_data, bpy.types.Mesh):
                        bpy.data.meshes.remove(c_data)
        bpy.context.view_layer.update()
        return target_obj

    def _boost_density_to_target(target_faces=TARGET_MIN_FACES):
        """Ensure total evaluated faces >= target_faces by subdividing smaller meshes first and progressively lifting per-mesh caps."""
        caps = (28000, 75000, 180000, int(target_faces), int(target_faces), int(target_faces))
        for _pass, max_single_mesh_before_subdiv in enumerate(caps):
            meshes = [o for o in bpy.context.scene.objects if o.type == "MESH" and not o.hide_render and o.data and len(o.data.polygons) > 0]
            total_faces = sum(len(o.data.polygons) for o in meshes)
            if total_faces >= target_faces or not meshes:
                return total_faces
            candidates = sorted(meshes, key=lambda o: len(o.data.polygons))
            progressed = False
            skipped_by_cap = False
            for obj in candidates:
                if total_faces >= target_faces:
                    break
                cur_f = len(obj.data.polygons)
                if cur_f == 0:
                    continue
                if cur_f > max_single_mesh_before_subdiv:
                    skipped_by_cap = True
                    continue
                r_idx = int(obj.get("reward_part_index", 1))
                mat = obj.data.materials[0] if obj.data.materials else None
                bm = bmesh.new()
                bm.from_mesh(obj.data)
                if len(bm.edges) > 0:
                    bmesh.ops.subdivide_edges(bm, edges=list(bm.edges), cuts=1, use_grid_fill=True)
                    bm.to_mesh(obj.data)
                    obj.data.update()
                bm.free()
                stamp_object_contract(obj, r_idx, mat=mat)
                new_f = len(obj.data.polygons)
                if new_f > cur_f:
                    total_faces += (new_f - cur_f)
                    progressed = True
            if not progressed and not skipped_by_cap:
                break
        return sum(len(o.data.polygons) for o in bpy.context.scene.objects if o.type == "MESH" and not o.hide_render and o.data)

    def sync_all_contracts():
        load_contract_roles()
        for obj in list(bpy.context.scene.objects):
            if obj.type != "MESH" or obj.data is None or obj.hide_render:
                continue
            if obj.name.startswith("CUTTER_") or obj.name.startswith("_tmp_"):
                bpy.data.objects.remove(obj, do_unlink=True)
                continue
            role_target = None
            if "reward_part_index" in obj:
                try:
                    val = int(obj["reward_part_index"])
                    if val >= 1:
                        role_target = val
                except Exception:
                    pass
            if role_target is None:
                attr = obj.data.attributes.get("reward_part_index")
                if attr is not None and attr.domain == "FACE" and attr.data_type == "INT" and len(attr.data) > 0:
                    try:
                        val = int(attr.data[0].value)
                        if val >= 1:
                            role_target = val
                    except Exception:
                        pass
            if role_target is None:
                for col in obj.users_collection:
                    if col.name in ROLE_MAP:
                        role_target = ROLE_MAP[col.name]
                        break
            if role_target is None:
                for r_key, r_val in ROLE_MAP.items():
                    if obj.name.upper().startswith(r_key.upper() + "_") or obj.name.upper().startswith(r_key.upper() + " |") or obj.name.upper() == f"GEO-{r_key.upper()}":
                        role_target = r_val
                        break
            if role_target is None:
                role_target = 1
            mat = obj.data.materials[0] if obj.data.materials else None
            stamp_object_contract(obj, role_target, mat=mat)

        bpy.context.view_layer.update()
        depsgraph = bpy.context.evaluated_depsgraph_get()
        role_bounds = {}
        role_mins_maxs = {}
        role_counts = {r_name: {"index": idx, "objects": 0, "verts": 0, "faces": 0, "triangles": 0} for idx, r_name in sorted(INDEX_TO_ROLE.items())}
        total_faces = 0
        total_triangles = 0
        total_verts = 0

        for obj in bpy.context.scene.objects:
            if obj.type != "MESH" or obj.data is None or obj.hide_render:
                continue
            r_idx = int(obj.get("reward_part_index", 1))
            r_name = INDEX_TO_ROLE.get(r_idx, f"PART_{r_idx}")
            if r_name not in role_counts:
                role_counts[r_name] = {"index": r_idx, "objects": 0, "verts": 0, "faces": 0, "triangles": 0}
            if r_name not in role_mins_maxs:
                role_mins_maxs[r_name] = ([float("inf")] * 3, [float("-inf")] * 3, False)

            eval_obj = obj.evaluated_get(depsgraph)
            mesh = eval_obj.to_mesh()
            mesh.calc_loop_triangles()
            nf = len(mesh.polygons)
            nt = len(mesh.loop_triangles)
            nv = len(mesh.vertices)
            role_counts[r_name]["objects"] += 1
            role_counts[r_name]["verts"] += nv
            role_counts[r_name]["faces"] += nf
            role_counts[r_name]["triangles"] += nt
            total_faces += nf
            total_triangles += nt
            total_verts += nv

            mins, maxs, has_geom = role_mins_maxs[r_name]
            mw = eval_obj.matrix_world
            for v in mesh.vertices:
                co = mw @ v.co
                for k in range(3):
                    if co[k] < mins[k]:
                        mins[k] = co[k]
                    if co[k] > maxs[k]:
                        maxs[k] = co[k]
                has_geom = True
            role_mins_maxs[r_name] = (mins, maxs, has_geom)
            eval_obj.to_mesh_clear()

        for r_name, (mins, maxs, has_geom) in role_mins_maxs.items():
            if has_geom:
                role_bounds[r_name] = [[round(x, 4) for x in mins], [round(x, 4) for x in maxs]]

        contract_diff = {}
        contract_path = Path("part-contract.json")
        if contract_path.exists():
            try:
                pc = json.loads(contract_path.read_text())
                req_bounds = pc.get("coordinate", {}).get("required_role_bounds") or pc.get("required_role_bounds") or {}
                for r_name, req in req_bounds.items():
                    if r_name in role_bounds and isinstance(req, list) and len(req) == 2:
                        actual = role_bounds[r_name]
                        d_min = [round(actual[0][k] - req[0][k], 4) for k in range(3)]
                        d_max = [round(actual[1][k] - req[1][k], 4) for k in range(3)]
                        max_err = max(abs(x) for x in d_min + d_max)
                        contract_diff[r_name] = {
                            "actual": actual,
                            "required": req,
                            "delta_min": d_min,
                            "delta_max": d_max,
                            "max_abs_delta": round(max_err, 4),
                        }
            except Exception:
                pass
        return {
            "total_faces": total_faces,
            "total_triangles": total_triangles,
            "total_verts": total_verts,
            "target_min_faces": TARGET_MIN_FACES,
            "density_target_passed": total_faces >= TARGET_MIN_FACES,
            "role_counts": role_counts,
            "role_bounds": role_bounds,
            "contract_diff": contract_diff,
        }

    def finalize_and_save(blend_path="scene.blend", target_faces=TARGET_MIN_FACES, auto_boost=True, target_min_faces=None, render_previews=False):
        """Mandatory scene save entrypoint: synchronize all Role Collections, enforce total_faces >= 500,000, and save scene.blend."""
        for _g in list(_ACTIVE_GEOMETRIES):
            if not getattr(_g, "_finished", False) and _g.vertices and _g.faces:
                try:
                    _g.finish()
                except Exception:
                    pass
        if target_min_faces is not None:
            target_faces = int(target_min_faces)
        target_faces = max(TARGET_MIN_FACES, int(target_faces or TARGET_MIN_FACES))
        summary = sync_all_contracts()
        if summary["total_faces"] < target_faces:
            _boost_density_to_target(target_faces)
            summary = sync_all_contracts()
        if "run_structural_diagnostics" in globals():
            diag = globals()["run_structural_diagnostics"]()
            summary["structural_diagnostics"] = diag
            for w_msg in diag.get("warnings", []):
                print(f"[STRUCTURAL SELF-CHECK WARNING] {w_msg}")
        if render_previews and "render_inspection_sheet" in globals():
            import tempfile as _tf
            out_preview_dir = str(Path(_tf.gettempdir()) / "preview")
            summary["inspection_renders"] = globals()["render_inspection_sheet"](out_dir=out_preview_dir)
        out = Path(blend_path).resolve()
        out.parent.mkdir(parents=True, exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=str(out))
        summary["saved_path"] = str(out)
        status = "PASS" if summary["density_target_passed"] else "BELOW_500K_TARGET"
        print(
            f"[GEOMETRY SELF-CHECK] Status={status} | Faces={summary['total_faces']:,} | "
            f"Triangles={summary['total_triangles']:,} (Target >= {target_faces:,})"
        )
        for r_name, c in summary["role_counts"].items():
            print(f"  - {r_name:8s}: {c['faces']:8,d} faces | {c['triangles']:8,d} tris | {c['objects']:3d} objs")
        return summary



    # Re-export all 5 semantic architectural subsystem modules at top level
    try:
        import sys as _sys
        _here = str(Path(__file__).resolve().parent)
        if _here not in _sys.path:
            _sys.path.insert(0, _here)
        from lab_bmesh_frame_and_clay import *
        from lab_roofs_domes_and_shells import *
        from lab_columns_brackets_and_portals import *
        from lab_walls_arcades_and_facades import *
        from lab_towers_bridges_and_terraces import *
    except Exception as _sub_err:
        print(f"[WARN] Architectural subsystem module import failed: {_sub_err}")

    try:
        import sys as _sys_roof
        _here_roof = str(Path(__file__).resolve().parent)
        if _here_roof not in _sys_roof.path:
            _sys_roof.path.insert(0, _here_roof)
        from lab_roof_and_aperture_ops import (
            recalc_object_outward_normals,
            prism_xz,
            prism_yz,
            prism_xy,
            arch_cut_outward as arch_cut,
            roof,
            curved_hip_roof,
            hip_roof,
            roof_ridge_and_gables,
            univ_curved_hip_gable_roof,
            run_structural_diagnostics,
            render_inspection_sheet,
        )
    except Exception as _roof_err:
        print(f"[WARN] lab_roof_and_aperture_ops import failed: {_roof_err}")

def _blender_bin():
    for candidate in [
        os.environ.get("BLENDER_BIN", ""),
        "/Applications/Blender.app/Contents/MacOS/Blender",
        "blender",
    ]:
        if candidate and (Path(candidate).exists() or candidate == "blender"):
            return candidate
    return "blender"


def run(arguments):
    """Tool entrypoint for Agent JSON invocations (`lab_update_subpart`)."""
    if not isinstance(arguments, dict):
        raise ValueError("arguments must be a JSON object")
    scene_path = str(arguments.get("scene_path") or "scene.blend")
    python_code = str(arguments.get("python_code") or arguments.get("script") or "").strip()
    default_action = "upsert_subpart" if python_code else "sync_contract"
    action = str(arguments.get("action") or default_action)
    role = str(arguments.get("role") or "BODY").strip()
    subpart_name = str(arguments.get("subpart_name") or "").strip()

    if action not in {"sync_contract", "upsert_subpart", "delete_subpart"}:
        raise ValueError("action must be sync_contract, upsert_subpart, or delete_subpart")

    helper_path = str(Path(__file__).resolve())
    driver = f"""
import json, math, sys
from pathlib import Path
import bpy, bmesh
from mathutils import Euler, Matrix, Vector

sys.path.insert(0, {json.dumps( str(Path(helper_path).parent) )})
import lab_update_subpart as helper

scene_file = Path({json.dumps(scene_path)})
if scene_file.exists():
    bpy.ops.wm.open_mainfile(filepath=str(scene_file))
else:
    helper.init_scene(clear=True)

action = {json.dumps(action)}
role = {json.dumps(role)}
subpart_name = {json.dumps(subpart_name)}
python_code = {json.dumps(python_code)}

if action == "delete_subpart":
    obj_name = subpart_name if subpart_name.startswith(role + "_") else (role + "_" + subpart_name)
    obj = bpy.data.objects.get(obj_name) or bpy.data.objects.get(subpart_name)
    if obj is not None:
        bpy.data.objects.remove(obj, do_unlink=True)
elif action == "upsert_subpart" and python_code:
    ns = dict(vars(helper))
    ns.update({{"bpy": bpy, "bmesh": bmesh, "math": math, "Euler": Euler, "Matrix": Matrix, "Vector": Vector, "helper": helper, "ROLE": role, "SUBPART": subpart_name}})
    exec(compile(python_code, "<upsert_subpart>", "exec"), ns, ns)

summary = helper.finalize_and_save(str(scene_file))
print("LAB_SUBPART_RESULT_JSON:" + json.dumps(summary, ensure_ascii=False))
"""
    timeout = int(os.environ.get("HARNESS_LAB_TOOL_TIMEOUT_SECONDS", "90"))
    proc = subprocess.run(
        [_blender_bin(), "--background", "--factory-startup", "--python-exit-code", "1", "--python-expr", driver],
        text=True,
        capture_output=True,
        timeout=timeout,
    )
    if proc.returncode != 0:
        err_text = (proc.stderr or "") + "\n" + (proc.stdout or "")
        if "Error: script failed" in err_text:
            err_text = err_text.split("Error: script failed", 1)[0]
        raise RuntimeError(f"Blender subpart update failed: {err_text.strip()[-1200:]}")
    for line in reversed(proc.stdout.splitlines()):
        if line.startswith("LAB_SUBPART_RESULT_JSON:"):
            return json.loads(line.split("LAB_SUBPART_RESULT_JSON:", 1)[1])
    raise RuntimeError("Subpart helper did not emit LAB_SUBPART_RESULT_JSON")


"""Embedded stdlib export support for added command tools."""


def _lab_persist_result(result):
    import hashlib
    import os
    from pathlib import Path
    import fcntl
    import json
    import uuid

    workspace=Path.cwd().resolve()
    agent=Path(os.environ.get('ARENA_AGENT_OUTPUT_DIR','/envarena/out/agent')).resolve()
    build=agent/'build'
    export=build/'lab-tool-results'
    extensions={'.json','.svg','.png','.jpg','.jpeg','.txt','.md','.log','.py'}
    found={};errors=[];total=0

    def discover(value):
        if isinstance(value,dict):
            for child in value.values():discover(child)
        elif isinstance(value,list):
            for child in value:discover(child)
        elif isinstance(value,str) and value.startswith('/') and len(value)<4096:
            try:
                path=Path(value).resolve()
                if path.suffix.lower() not in extensions or not path.is_file():return
                if not path.is_relative_to(workspace) and not path.is_relative_to(build):
                    errors.append('Returned file lies outside task workspace and artifact build directory');return
                found[value]=path
            except OSError:errors.append('Returned file could not be inspected')

    discover(result)
    if not found and not errors:return result
    mapping={};receipts=[]
    for original,path in found.items():
        size=path.stat().st_size
        if len(receipts)>=128 or size>256*1024*1024 or total+size>512*1024*1024:
            errors.append('Artifact export byte/file limit exceeded');continue
        try:
            if path.is_relative_to(build):target=path
            else:
                # Repeated stage tools return the same public inputs. Preserve
                # each distinct byte sequence once, not one copy per call.
                content=path.read_bytes();source_hash=hashlib.sha256(content).hexdigest()
                target=export/'files'/source_hash/path.name
                target.parent.mkdir(parents=True,exist_ok=True)
                if not target.exists():
                    temporary=target.with_name('.'+target.name+'.'+uuid.uuid4().hex)
                    try:temporary.write_bytes(content);temporary.replace(target)
                    finally:temporary.unlink(missing_ok=True)
            source_hash=hashlib.sha256(path.read_bytes()).hexdigest()
            if hashlib.sha256(target.read_bytes()).hexdigest()!=source_hash:
                errors.append('Artifact copy hash mismatch');continue
            total+=size;mapping[original]=str(target)
            receipts.append({'source_path':original,'exported_path':str(target),'sha256':source_hash,'bytes':size})
        except OSError:errors.append('Artifact file could not be copied')

    def rewrite(value):
        if isinstance(value,dict):return {key:rewrite(child) for key,child in value.items()}
        if isinstance(value,list):return [rewrite(child) for child in value]
        return mapping.get(value,value) if isinstance(value,str) else value

    rewritten=rewrite(result)
    receipt={'files':receipts,'errors':errors,'source_files_preserved':True}
    copied=[r for r in receipts if r['source_path']!=r['exported_path']]
    if copied:
        # The per-call receipt remains in the native tool result. One shared,
        # atomically updated manifest records copied-file provenance without
        # adding a receipt file/directory on every tool call.
        export.mkdir(parents=True,exist_ok=True)
        with (export/'.manifest.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            manifest_path=export/'manifest.json'
            manifest=json.loads(manifest_path.read_text()) if manifest_path.exists() else {'schema':'lab-artifact-manifest.v1','files':[],'source_files_preserved':True}
            known={(r['source_path'],r['exported_path'],r['sha256']) for r in manifest['files']}
            for row in copied:
                key=(row['source_path'],row['exported_path'],row['sha256'])
                if key not in known:manifest['files'].append(row);known.add(key)
            temporary=export/('.manifest-'+uuid.uuid4().hex+'.tmp')
            try:temporary.write_text(json.dumps(manifest,ensure_ascii=False),encoding='utf-8');temporary.replace(manifest_path)
            finally:temporary.unlink(missing_ok=True)
    if isinstance(rewritten,dict):return dict(rewritten,_harness_artifact_export=receipt)
    return {'result':rewritten,'_harness_artifact_export':receipt}


if __name__ == '__main__':
    import contextlib, json, sys
    try:
        arguments = json.loads(sys.stdin.readline())
        with contextlib.redirect_stdout(sys.stderr):
            result = run(arguments)
            result = _lab_persist_result(result)
        response = {'success': True, 'contentItems': [{'type': 'inputText', 'text': json.dumps(result, ensure_ascii=False)}]}
    except Exception as error:
        response = {'success': False, 'contentItems': [{'type': 'inputText', 'text': type(error).__name__ + ': ' + str(error)}]}
    print(json.dumps(response, ensure_ascii=False))
