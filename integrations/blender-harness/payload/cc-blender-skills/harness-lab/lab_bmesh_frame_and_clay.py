#!/usr/bin/env python3
"""Core BMesh Collector, Orientation-Safe Local/Elliptical Frames, Dihedral Symmetry, Crease Shading & Unit-X Normalizer
(`lab_bmesh_frame_and_clay.py`).

本模块提供三维建筑算子的底层数学标架、对称群变换与流形网格累加器：
- `LocalFrame`：任意朝向立面的局部正交标架 `(u, d, z)`，自动检测负行列式（镜像反射）翻转面环绕序；
- `EllipticalFrame`：基于椭圆弧微分数值积分与二分求逆的**等弧长平行偏移标架**；
- `PartBMesh`：支持多槽中性灰白明度材质、二面角折痕自动平滑（Crease Auto-Smooth）与 `reward_part_index` 双域契约写入的原生 `BMesh` 收集器；
- `replicate_cn_symmetry` / `replicate_d4_symmetry`：$C_n$ 旋转对称群与 $D_4$ 二面体反射对称群拷贝。
"""
from __future__ import annotations

import math
from pathlib import Path
import sys

try:
    import bpy
    import bmesh
    from mathutils import Euler, Matrix, Vector
    IN_BLENDER = True
except ImportError:
    IN_BLENDER = False

if IN_BLENDER:
    from lab_update_subpart import (
        Geometry, material, ensure_neutral_material, ensure_role_collection,
        stamp_object_contract, _resolve_role, _ACTIVE_GEOMETRIES, _GEOM_NAME_COUNTS,
    )

def strut(g, p0, p1, r0, r1=None, sides=6, cap=True):
    return g.strut(p0, p1, r0, r1, sides=sides, cap=cap)

def strip(g, pts0, pts1, closed=False):
    return g.strip(pts0, pts1, closed=closed)

def dougong_rafter_tier(name, level, hx, hy, center_y=0.0, count_x=17, count_y=9,
                        steps=3, rafter_proj=0.032, center_x=0.0, role="SUPPORTS", rafter_role=None):
    """Interlocking multi-stepped Dougong bracket sets and exposed eave rafters.
    Respects custom `role` / `rafter_role` from `part-contract.json`!
    """
    m_teal = material("Frieze_Blue_Green", (0.095, 0.205, 0.20), 0.72)
    m_timber = material("Timber_Cinnabar", (0.22, 0.065, 0.046), 0.75, grain=110)
    r_rafter = rafter_role if rafter_role is not None else ("ROOF" if role == "SUPPORTS" else role)
    bracket = Geometry(f"{name}_dougong_brackets", role, m_teal)
    rafter = Geometry(f"{name}_exposed_rafters", r_rafter, m_timber)
    nx = max(4, int(count_x))
    ny = max(3, int(count_y))
    n_steps = max(2, int(steps))
    for sign in [-1, 1]:
        for idx in range(nx):
            u = center_x - hx + idx * 2.0 * hx / max(1, nx - 1)
            for step in range(n_steps):
                bracket.box(
                    (u, center_y + sign * (hy + step * 0.0045), level - 0.015 + step * 0.0055),
                    (0.010 + step * 0.0055, 0.020 + step * 0.003, 0.005),
                    subdiv=2,
                )
            bracket.box((u, center_y + sign * hy, level - 0.019), (0.010, 0.013, 0.005), subdiv=2)
            bracket.strut(
                (u, center_y + sign * (hy - 0.004), level - 0.018),
                (u, center_y + sign * (hy + n_steps * 0.0055), level - 0.002),
                0.003,
                sides=6,
            )
        n_raf_x = nx * 2 - 1
        for idx in range(n_raf_x):
            u = center_x - hx + idx * 2.0 * hx / max(1, n_raf_x - 1)
            rafter.tube(
                [(u, center_y + sign * hy, level + 0.009), (u, center_y + sign * (hy + rafter_proj), level + 0.003)],
                0.0018,
                8,
            )
            rafter.tube(
                [(u, center_y + sign * (hy + rafter_proj * 0.7), level + 0.004), (u, center_y + sign * (hy + rafter_proj * 1.25), level + 0.002)],
                0.0015,
                8,
            )
        for idx in range(ny):
            v = center_y - hy + idx * 2.0 * hy / max(1, ny - 1)
            for step in range(n_steps):
                bracket.box(
                    (center_x + sign * (hx + step * 0.0045), v, level - 0.015 + step * 0.0055),
                    (0.020 + step * 0.003, 0.010 + step * 0.0055, 0.005),
                    subdiv=2,
                )
            bracket.box((center_x + sign * hx, v, level - 0.019), (0.013, 0.010, 0.005), subdiv=2)
        n_raf_y = ny * 2 - 1
        for idx in range(n_raf_y):
            v = center_y - hy + idx * 2.0 * hy / max(1, n_raf_y - 1)
            rafter.tube(
                [(center_x + sign * hx, v, level + 0.009), (center_x + sign * (hx + rafter_proj), v, level + 0.003)],
                0.0018,
                8,
            )
    return [bracket.finish(), rafter.finish()]

def column_colonnade(name, positions, z0, z1, radius=0.006, role="SUPPORTS", sides=16,
                     fluted=False, with_feet=True, with_capitals=True, with_braces=True, mat_col=None):
    """Gallery/veranda/temple column colonnade with stone bases, capitals, optional fluting (`fluted=True`), and braces."""
    m_timber = mat_col or material("Timber_Cinnabar", (0.22, 0.065, 0.046), 0.75, grain=110)
    m_stone = material("Stone_Limestone", (0.40, 0.39, 0.35), 0.75, grain=180)
    cols = Geometry(f"{name}_columns_and_capitals", role, m_timber)
    feet = Geometry(f"{name}_column_foot_stones", role, m_stone)
    braces = Geometry(f"{name}_diagonal_corner_braces", role, m_timber)
    h = z1 - z0
    for cx, cy in positions:
        cols.tube([(cx, cy, z0), (cx, cy, z0 + h * 0.33), (cx, cy, z0 + h * 0.67), (cx, cy, z1)], radius, sides=max(12, int(sides)))
        if fluted:
            for k in range(12):
                ang = 2.0 * math.pi * k / 12
                fx, fy = cx + radius * 0.96 * math.cos(ang), cy + radius * 0.96 * math.sin(ang)
                cols.tube([(fx, fy, z0 + 0.008), (fx, fy, z1 - 0.008)], radius * 0.14, sides=5)
        if with_feet:
            feet.box((cx, cy, z0 + 0.003), (radius * 2.8, radius * 2.8, 0.006), subdiv=2)
            feet.lathe(
                (cx, cy, z0 + 0.006),
                [(0.0, radius * 1.35), (0.002, radius * 1.45), (0.005, radius * 1.25), (0.007, radius * 1.02)],
                sides=16,
            )
        if with_capitals:
            cols.box((cx, cy, z1 - 0.0035), (radius * 3.4, radius * 3.0, 0.007), subdiv=2)
            cols.box((cx, cy, z1 + 0.002), (radius * 4.2, radius * 3.4, 0.005), subdiv=2)
        if with_braces and h > 0.02:
            z_start = z1 - min(0.028, h * 0.35)
            span = radius * 2.2
            for sign in [-1, 1]:
                braces.tube([(cx, cy, z_start), (cx + sign * span, cy, z1 - 0.004)], radius * 0.44, 8)
                braces.tube([(cx, cy, z_start), (cx, cy + sign * span, z1 - 0.004)], radius * 0.44, 8)
    out = [cols.finish()]
    if with_feet:
        out.append(feet.finish())
    if with_braces:
        out.append(braces.finish())
    return out

def radial_colonnade(name, radius, z0, z1, count=16, col_radius=0.006, center_x=0.0, center_y=0.0,
                     start_deg=0.0, end_deg=360.0, role="SUPPORTS", sides=16, fluted=False,
                     with_feet=True, with_capitals=True, with_ring_beam=True, mat_col=None):
    """Circular, elliptical (`radius=(rx, ry)`), or semicircular colonnade with optional ring architrave beam."""
    if isinstance(radius, (tuple, list)):
        rx, ry = float(radius[0]), float(radius[1])
    else:
        rx = ry = float(radius)
    n = max(3, int(count))
    span = float(end_deg) - float(start_deg)
    full_circle = abs(abs(span) - 360.0) < 1e-3
    positions = []
    ring_pts = []
    for idx in range(n):
        frac = idx / n if full_circle else (idx / max(1, n - 1))
        ang = math.radians(float(start_deg) + span * frac)
        px = float(center_x) + rx * math.cos(ang)
        py = float(center_y) + ry * math.sin(ang)
        positions.append((px, py))
        ring_pts.append((px, py, float(z1) + 0.004))
    out = column_colonnade(
        name, positions, z0, z1, radius=col_radius, role=role, sides=sides,
        fluted=fluted, with_feet=with_feet, with_capitals=with_capitals,
        with_braces=(not fluted), mat_col=mat_col,
    )
    if with_ring_beam and len(ring_pts) >= 3:
        g_beam = Geometry(f"{name}_ring_architrave", role, mat_col)
        g_beam.tube(ring_pts, col_radius * 1.45, sides=8, closed=full_circle)
        out.append(g_beam.finish())
    return out

def radial_arcade_tier(name, rx, ry, z0, z1, wall_thickness=0.032, bays=24,
                       arch_width_ratio=0.56, arch_height_ratio=0.72, with_engaged_columns=True,
                       role="BODY", center_x=0.0, center_y=0.0, start_deg=0.0, end_deg=360.0, mat=None):
    """Circular or elliptical curved arcade wall with arched bays, piers, spandrel lintels, and engaged columns.

    Why & When to Use:
    - Roman Colosseum (`m208`: use `rx, ry` for elliptical tiers, and `start_deg/end_deg` for partial outer ring!),
      circular Tulou interior galleries (`inputs-20261021-r-079`), or cylindrical drum arcades (`world-f034`, `world-m204`).
    """
    m_stone = mat or material("Arcade_Travertine_Stone", (0.56, 0.52, 0.44), 0.76, grain=160)
    g_wall = Geometry(f"{name}_arcade_piers_and_spandrels", role, m_stone)
    g_cols = Geometry(f"{name}_engaged_columns_and_cornice", role, m_stone)

    n_bays = max(4, int(bays))
    span_deg = float(end_deg) - float(start_deg)
    full_circle = abs(abs(span_deg) - 360.0) < 1e-3
    cx, cy = float(center_x), float(center_y)
    r_x, r_y = float(rx), float(ry)
    wt = float(wall_thickness)
    h_tier = float(z1) - float(z0)
    z_arch_top = float(z0) + h_tier * float(arch_height_ratio)
    z_spring = float(z0) + (z_arch_top - float(z0)) * 0.58
    arch_r_z = z_arch_top - z_spring

    def ring_xy(ang_rad, r_offset=0.0):
        return (cx + (r_x + r_offset) * math.cos(ang_rad), cy + (r_y + r_offset) * math.sin(ang_rad))

    for b_idx in range(n_bays):
        a0_deg = float(start_deg) + span_deg * (b_idx / n_bays)
        a1_deg = float(start_deg) + span_deg * ((b_idx + 1) / n_bays)
        a_mid = math.radians(0.5 * (a0_deg + a1_deg))
        d_ang = math.radians(a1_deg - a0_deg)
        pier_frac = 0.5 * (1.0 - float(arch_width_ratio))

        # Left and right piers of this bay
        for sub_a0, sub_a1 in [(0.0, pier_frac), (1.0 - pier_frac, 1.0)]:
            ang_s = math.radians(a0_deg) + d_ang * sub_a0
            ang_e = math.radians(a0_deg) + d_ang * sub_a1
            p_in_s, p_in_e = ring_xy(ang_s, -wt * 0.5), ring_xy(ang_e, -wt * 0.5)
            p_out_s, p_out_e = ring_xy(ang_s, wt * 0.5), ring_xy(ang_e, wt * 0.5)
            vs = [
                (p_in_s[0], p_in_s[1], z0), (p_out_s[0], p_out_s[1], z0),
                (p_out_e[0], p_out_e[1], z0), (p_in_e[0], p_in_e[1], z0),
                (p_in_s[0], p_in_s[1], z_arch_top), (p_out_s[0], p_out_s[1], z_arch_top),
                (p_out_e[0], p_out_e[1], z_arch_top), (p_in_e[0], p_in_e[1], z_arch_top),
            ]
            g_wall.poly(vs, [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)])

        # Upper spandrel lintel + radial arch voussoirs over the opening
        n_vous = 8
        for v_i in range(n_vous):
            t0 = v_i / n_vous
            t1 = (v_i + 1) / n_vous
            ang_v0 = math.radians(a0_deg) + d_ang * (pier_frac + (1.0 - 2.0 * pier_frac) * t0)
            ang_v1 = math.radians(a0_deg) + d_ang * (pier_frac + (1.0 - 2.0 * pier_frac) * t1)
            zb0 = z_spring + arch_r_z * math.sin(t0 * math.pi)
            zb1 = z_spring + arch_r_z * math.sin(t1 * math.pi)
            pi0, po0 = ring_xy(ang_v0, -wt * 0.5), ring_xy(ang_v0, wt * 0.5)
            pi1, po1 = ring_xy(ang_v1, -wt * 0.5), ring_xy(ang_v1, wt * 0.5)
            vs = [
                (pi0[0], pi0[1], zb0), (po0[0], po0[1], zb0),
                (po1[0], po1[1], zb1), (pi1[0], pi1[1], zb1),
                (pi0[0], pi0[1], z1), (po0[0], po0[1], z1),
                (po1[0], po1[1], z1), (pi1[0], pi1[1], z1),
            ]
            g_wall.poly(vs, [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)])

        if with_engaged_columns:
            ang_col = math.radians(a0_deg)
            cx_col, cy_col = ring_xy(ang_col, wt * 0.55)
            col_r = max(0.0025, wt * 0.22)
            g_cols.tube([(cx_col, cy_col, z0), (cx_col, cy_col, z1 - h_tier * 0.08)], col_r, sides=12)
            g_cols.box((cx_col, cy_col, z0 + col_r), (col_r * 2.6, col_r * 2.6, col_r * 1.6))
            g_cols.box((cx_col, cy_col, z1 - h_tier * 0.08), (col_r * 2.8, col_r * 2.8, col_r * 1.6))

    # Cornice band along the top of the arcade tier
    cornice_pts = [
        (*ring_xy(math.radians(float(start_deg) + span_deg * (i / (n_bays * 2))), wt * 0.62), float(z1) - h_tier * 0.03)
        for i in range(n_bays * 2 + 1)
    ]
    g_cols.tube(cornice_pts, max(0.003, wt * 0.24), sides=8, closed=full_circle)
    return [g_wall.finish(), g_cols.finish()]

def pilaster_panel_facade(name, u0_or_hx, u1_or_hy, v_pos_or_z0, z0_or_z1, z1=None,
                          bays=5, bays_x=None, bays_y=None, pilaster_w=0.008, pilaster_d=0.005,
                          header_bands=2, central_arch_w=0.0, central_arch_h=0.0,
                          center_x=0.0, center_y=0.0, role="BODY", axis="Y", side_sign=-1, mat=None):
    """Articulated wall facade with vertical pilasters, recessed wall bays, horizontal header bands, and optional central arched niche.
    Supports EITHER:
    - 4-sided story perimeter: `pilaster_panel_facade(name, hx, hy, z0, z1, bays_x=5, bays_y=5, role=...)`
    - Single wall face: `pilaster_panel_facade(name, u0, u1, v_pos, z0, z1, bays=5, axis="Y", side_sign=-1, role=...)`
    """
    if z1 is None:
        hx, hy = abs(float(u0_or_hx)), abs(float(u1_or_hy))
        za, zb = float(v_pos_or_z0), float(z0_or_z1)
        bx = int(bays_x if bays_x is not None else bays)
        by = int(bays_y if bays_y is not None else bays)
        cx, cy = float(center_x), float(center_y)
        out = []
        for sgn, tag in [(-1, "front"), (1, "back")]:
            out.append(
                pilaster_panel_facade(
                    f"{name}_{tag}", cx - hx, cx + hx, cy + sgn * hy, za, zb,
                    bays=bx, pilaster_w=pilaster_w, pilaster_d=pilaster_d,
                    header_bands=header_bands, central_arch_w=central_arch_w, central_arch_h=central_arch_h,
                    role=role, axis="Y", side_sign=sgn, mat=mat,
                )
            )
        for sgn, tag in [(-1, "left"), (1, "right")]:
            out.append(
                pilaster_panel_facade(
                    f"{name}_{tag}", cy - hy, cy + hy, cx + sgn * hx, za, zb,
                    bays=by, pilaster_w=pilaster_w, pilaster_d=pilaster_d,
                    header_bands=header_bands, central_arch_w=central_arch_w, central_arch_h=central_arch_h,
                    role=role, axis="X", side_sign=sgn, mat=mat,
                )
            )
        return out

    u0, u1, v_pos, z0 = float(u0_or_hx), float(u1_or_hy), float(v_pos_or_z0), float(z0_or_z1)
    m_use = mat or material("Facade_Articulated_Masonry", (0.58, 0.56, 0.52), 0.82, grain=160)
    g = Geometry(name, role, m_use)
    ax = axis.upper()
    n_bays = max(1, int(bays_x if (ax == "Y" and bays_x is not None) else (bays_y if (ax == "X" and bays_y is not None) else bays)))
    u_min, u_max = min(float(u0), float(u1)), max(float(u0), float(u1))
    span = u_max - u_min
    h = float(z1) - float(z0)
    zc = 0.5 * (float(z0) + float(z1))
    sgn = -1.0 if float(side_sign) < 0 else 1.0
    v_out = float(v_pos) + sgn * float(pilaster_d) * 0.5

    for idx in range(n_bays + 1):
        u = u_min + idx * span / n_bays
        if ax == "Y":
            g.box((u, v_out, zc), (pilaster_w, pilaster_d, h), subdiv=2)
        else:
            g.box((v_out, u, zc), (pilaster_d, pilaster_w, h), subdiv=2)
    for hb in range(max(1, int(header_bands))):
        hz = float(z1) - (hb + 0.6) * float(pilaster_w) * 1.35
        if ax == "Y":
            g.box((0.5 * (u_min + u_max), v_out, hz), (span, pilaster_d * 0.9, pilaster_w * 0.75), subdiv=2)
        else:
            g.box((v_out, 0.5 * (u_min + u_max), hz), (pilaster_d * 0.9, span, pilaster_w * 0.75), subdiv=2)

    if float(central_arch_w) > 0.004 and float(central_arch_h) > 0.006:
        aw = float(central_arch_w) * 0.5
        ah = float(central_arch_h)
        z_sp = float(z0) + max(0.004, ah - aw)
        u_mid = 0.5 * (u_min + u_max)
        arch_ring(
            f"{name}_central_arch_frame", u_mid,
            float(v_pos), float(v_pos) + sgn * float(pilaster_d) * 1.4,
            float(z0), z_sp, aw, width=pilaster_w * 0.85,
            role=role, mat=m_use, segments=20, jamb_blocks=5, axis=ax,
        )
    return g.finish()

def balustrade_perimeter(name, hx, hy, center_y=0.0, z_bottom=0.380, z_top=0.402,
                         role="BODY", posts_x=41, posts_y=25, center_x=0.0,
                         gap_front_w=0.0, gap_back_w=0.0):
    """4-sided open balcony/terrace balustrade with posts, rails, handrail caps, and optional stair entry gaps (`gap_front_w`)."""
    m_timber = material("Timber_Cinnabar", (0.22, 0.065, 0.046), 0.75, grain=110)
    m_cream = material("Carved_Trim_Stone", (0.61, 0.53, 0.36), 0.72)
    rail = Geometry(f"{name}_balustrade_rails_and_posts", role, m_timber)
    railcap = Geometry(f"{name}_balustrade_handrail_caps", role, m_cream)
    h = max(0.012, z_top - z_bottom)
    z_mid1 = z_bottom + h * 0.22
    z_mid2 = z_bottom + h * 0.68
    z_post = (z_bottom + z_top) * 0.5
    nx = max(9, int(posts_x))
    ny = max(7, int(posts_y))
    for side in [-1, 1]:
        gap_w = float(gap_front_w) if side == -1 else float(gap_back_w)
        if gap_w <= 1e-4:
            for hz in [z_mid1, z_mid2]:
                rail.box((center_x, center_y + side * hy, hz), (hx * 2.0, 0.0032, 0.0032), subdiv=2)
            railcap.box((center_x, center_y + side * hy, z_top), (hx * 2.0 + 0.005, 0.0042, 0.0035), subdiv=2)
        else:
            seg_w = max(0.01, hx - gap_w * 0.5)
            for s_x in [-1, 1]:
                seg_cx = center_x + s_x * (gap_w * 0.5 + seg_w * 0.5)
                for hz in [z_mid1, z_mid2]:
                    rail.box((seg_cx, center_y + side * hy, hz), (seg_w, 0.0032, 0.0032), subdiv=2)
                railcap.box((seg_cx, center_y + side * hy, z_top), (seg_w + 0.003, 0.0042, 0.0035), subdiv=2)
        for hz in [z_mid1, z_mid2]:
            rail.box((center_x + side * hx, center_y, hz), (0.0032, hy * 2.0, 0.0032), subdiv=2)
        railcap.box((center_x + side * hx, center_y, z_top), (0.0042, hy * 2.0 + 0.005, 0.0035), subdiv=2)
        for idx in range(nx):
            px = center_x - hx + idx * 2.0 * hx / max(1, nx - 1)
            if gap_w > 1e-4 and abs(px - center_x) < gap_w * 0.48:
                continue
            rail.box((px, center_y + side * hy, z_post), (0.0026, 0.0032, h), subdiv=2)
        for idx in range(ny):
            py = center_y - hy + idx * 2.0 * hy / max(1, ny - 1)
            rail.box((center_x + side * hx, py, z_post), (0.0032, 0.0026, h), subdiv=2)
    return [rail.finish(), railcap.finish()]

def radial_balustrade(name, radius, z_bottom, z_top, sides=32, posts=48,
                      center_x=0.0, center_y=0.0, gap_angles=(), role="BODY",
                      mat_rail=None, mat_cap=None):
    """Circular, elliptical (`radius=(rx, ry)`), or polygonal (`sides=8`) balustrade with posts, rails, and stair opening gaps.

    Why & When to Use:
    - Circular marble terrace railings of Temple of Heaven (`cn-base-c183`, pass `gap_angles=[(258, 282)]` to leave the front stair entry open!).
    - Octagonal pagoda perimeter balconies (`cn-orig-l016`, `cn-orig-l061`, pass `sides=8`).
    """
    m_r = mat_rail or material("Carved_Trim_Stone", (0.61, 0.53, 0.36), 0.72)
    m_c = mat_cap or material("Stone_Limestone", (0.68, 0.65, 0.58), 0.68)
    g_rail = Geometry(f"{name}_radial_posts_and_rails", role, m_r)
    g_cap = Geometry(f"{name}_radial_coping", role, m_c)

    if isinstance(radius, (tuple, list)):
        rx, ry = float(radius[0]), float(radius[1])
    else:
        rx = ry = float(radius)
    cx, cy = float(center_x), float(center_y)
    zb, zt = float(z_bottom), float(z_top)
    h = max(0.010, zt - zb)
    n_posts = max(int(sides), int(posts))

    def in_gap(deg):
        d_norm = deg % 360.0
        for g0, g1 in (gap_angles or ()):
            if float(g0) <= d_norm <= float(g1):
                return True
        return False

    for idx in range(n_posts):
        deg0 = 360.0 * idx / n_posts
        deg1 = 360.0 * (idx + 1) / n_posts
        a0, a1 = math.radians(deg0), math.radians(deg1)
        p0 = (cx + rx * math.cos(a0), cy + ry * math.sin(a0))
        p1 = (cx + rx * math.cos(a1), cy + ry * math.sin(a1))
        if not in_gap(deg0):
            g_rail.box((p0[0], p0[1], zb + h * 0.55), (0.0045, 0.0045, h * 1.1), subdiv=2)
            g_cap.box((p0[0], p0[1], zt + h * 0.12), (0.0062, 0.0062, h * 0.24))
        if not in_gap(0.5 * (deg0 + deg1)):
            g_rail.tube([(p0[0], p0[1], zb + h * 0.20), (p1[0], p1[1], zb + h * 0.20)], 0.0022, sides=6)
            g_rail.tube([(p0[0], p0[1], zb + h * 0.52), (p1[0], p1[1], zb + h * 0.52)], 0.0028, sides=6)
            g_cap.tube([(p0[0], p0[1], zt), (p1[0], p1[1], zt)], 0.0032, sides=8)
    return [g_rail.finish(), g_cap.finish()]

def lattice_window_bay(name, center_x, y_pos, z_center, width=0.080, height=0.060,
                       role="BODY", nx=11, nz=8, side_sign=1, axis="Y"):
    """Recessed dark window shadow backing + 3D timber lattice grille."""
    m_dark = material("Recessed_Lattice_Interior", (0.045, 0.035, 0.027), 0.90)
    m_timber = material("Timber_Cinnabar", (0.22, 0.065, 0.046), 0.75, grain=110)
    ax = axis.upper()
    if ax == "Y":
        shadow = box(f"{name}_shadow", (center_x, y_pos, z_center), (width, 0.003, height), role, m_dark)
    else:
        shadow = box(f"{name}_shadow", (y_pos, center_x, z_center), (0.003, width, height), role, m_dark)
    lattice = Geometry(f"{name}_lattice", role, m_timber)
    nx = max(3, int(nx))
    nz = max(3, int(nz))
    out_pos = y_pos + side_sign * 0.002
    for idx in range(nx):
        u = center_x - width * 0.485 + idx * (width * 0.97) / max(1, nx - 1)
        if ax == "Y":
            lattice.box((u, out_pos, z_center), (0.0016, 0.0022, height * 0.97))
        else:
            lattice.box((out_pos, u, z_center), (0.0022, 0.0016, height * 0.97))
    for idx in range(nz):
        hz = z_center - height * 0.485 + idx * (height * 0.97) / max(1, nz - 1)
        if ax == "Y":
            lattice.box((center_x, out_pos, hz), (width, 0.0022, 0.0016))
        else:
            lattice.box((out_pos, center_x, hz), (0.0022, width, 0.0016))
    return [shadow, lattice.finish()]

def louver_and_mullion_facade(name, x0, x1, y0, y1, z0, z1, nx=16, ny=1, nz=12,
                              slat_depth=0.006, slat_thickness=0.0018, role="BODY",
                              mat_frame=None, mat_glass=None):
    """Modern architectural curtain-wall mullion grid, recessed glazing, and horizontal sun-shading louver screen.

    Why & When to Use:
    - Modern cantilevered/atrium villas (`human-20261021-subject-001`, `human-20261021-subject-096`),
      high-tech office towers (`inputs-20261021-r-066` HSBC Building), and modular housing (`inputs-20261021-r-207` Habitat 67).
    """
    m_f = mat_frame or material("Modern_Mullion_Metal", (0.28, 0.29, 0.31), 0.42)
    m_g = mat_glass or material("Recessed_Dark_Glazing", (0.08, 0.11, 0.14), 0.18)
    g_glass = Geometry(f"{name}_recessed_glazing", role, m_g)
    g_frame = Geometry(f"{name}_mullions_and_louvers", role, m_f)

    xa, xb = min(float(x0), float(x1)), max(float(x0), float(x1))
    ya, yb = min(float(y0), float(y1)), max(float(y0), float(y1))
    za, zb = min(float(z0), float(z1)), max(float(z0), float(z1))
    dx, dy, dz = xb - xa, yb - ya, zb - za
    cx, cy, cz = 0.5 * (xa + xb), 0.5 * (ya + yb), 0.5 * (za + zb)

    g_glass.box((cx, cy, cz), (max(0.003, dx), max(0.003, dy), max(0.003, dz)), subdiv=2)
    n_u = max(2, int(nx))
    n_z = max(2, int(nz))
    sd = float(slat_depth)
    st = float(slat_thickness)

    if dx >= dy:
        for i in range(n_u + 1):
            ux = xa + i * dx / n_u
            g_frame.box((ux, cy, cz), (st * 1.2, dy + sd, dz))
        for k in range(n_z + 1):
            hz = za + k * dz / n_z
            g_frame.box((cx, cy, hz), (dx + sd, dy + sd * 1.4, st))
    else:
        for i in range(n_u + 1):
            uy = ya + i * dy / n_u
            g_frame.box((cx, uy, cz), (dx + sd, st * 1.2, dz))
        for k in range(n_z + 1):
            hz = za + k * dz / n_z
            g_frame.box((cx, cy, hz), (dx + sd * 1.4, dy + sd, st))
    return [g_glass.finish(), g_frame.finish()]

def diagrid_truss_shell(name, radius_bottom, radius_waist, radius_top, z0, z1,
                         waist_t=0.58, rings=24, meridians=32, tube_radius=0.0028,
                        twist_deg=45.0, ellipse_ratio=1.0, role="SUPPORTS",
                        center_x=0.0, center_y=0.0, mat=None):
    """3D hyperboloid / cylindrical space-frame diagrid lattice of twisted columns, counter-diagonals, and horizontal rings.

    Why & When to Use:
    - Canton Tower (`cn-orig-l081`) hyperboloid twisted steel waist lattice, structural exoskeletons, and space-frame towers.
    """
    m_steel = mat or material("Structural_Steel_Diagrid", (0.64, 0.65, 0.68), 0.38)
    g = Geometry(name, role, m_steel)
    n_rings = max(6, int(rings))
    n_mer = max(8, int(meridians))
    cx, cy = float(center_x), float(center_y)
    za, zb = float(z0), float(z1)
    rb, rw, rt = float(radius_bottom), float(radius_waist), float(radius_top)
    wt = max(0.15, min(0.85, float(waist_t)))
    er = float(ellipse_ratio)
    tw = math.radians(float(twist_deg))
    tr = float(tube_radius)

    def r_at(t):
        if t <= wt:
            u = t / wt
            return rb + (rw - rb) * math.sin(u * math.pi * 0.5)
        u = (t - wt) / (1.0 - wt)
        return rw + (rt - rw) * (1.0 - math.cos(u * math.pi * 0.5))

    def pt(m_idx, r_idx, dir_sign=1):
        t = r_idx / n_rings
        r_cur = r_at(t)
        ang = 2.0 * math.pi * (m_idx / n_mer) + dir_sign * tw * t
        return (
            cx + r_cur * math.cos(ang),
            cy + r_cur * er * math.sin(ang),
            za + (zb - za) * t,
        )

    for m_idx in range(n_mer):
        g.tube([pt(m_idx, r_idx, 1) for r_idx in range(n_rings + 1)], tr, sides=6)
        g.tube([pt(m_idx, r_idx, -1) for r_idx in range(n_rings + 1)], tr * 0.82, sides=6)
    for r_idx in range(n_rings + 1):
        ring_pts = [pt(m_idx, r_idx, 1) for m_idx in range(n_mer)]
        g.tube(ring_pts, tr * 0.78, sides=6, closed=True)
    return g.finish()

def ashlar_courses(name, u0, u1, v_pos, z0, rows=4, cols=18, block_depth=0.005,
                   block_height=0.0055, role="BODY", axis="X"):
    """Dressed ashlar stone block courses along a wall face."""
    m_stone = material("Stone_Limestone", (0.40, 0.39, 0.35), 0.75, grain=180)
    g = Geometry(name, role, m_stone)
    ax = axis.upper()
    span = abs(u1 - u0)
    u_min = min(u0, u1)
    cols = max(4, int(cols))
    rows = max(1, int(rows))
    bw = span / cols * 0.94
    for row in range(rows):
        hz = z0 + (row + 0.5) * block_height
        for idx in range(cols):
            u = u_min + (idx + 0.5) * span / cols
            if ax == "X":
                g.box((u, v_pos, hz), (bw, block_depth, block_height * 0.90), subdiv=2)
            else:
                g.box((v_pos, u, hz), (block_depth, bw, block_height * 0.90), subdiv=2)
    return g.finish()

def stepped_stairs(name, center_x, y_start, y_end, z0, z1, width=0.145, steps=8,
                   role="BASE", with_cheek_walls=True, with_central_ramp=False, ramp_width_ratio=0.34, axis="Y"):
    """Multi-step stone staircase with ascending treads, stepped cheek walls, and optional central imperial ramp (`with_central_ramp=True`)."""
    m_stone = material("Stone_Limestone", (0.40, 0.39, 0.35), 0.75, grain=180)
    m_carved = material("Carved_Trim_Stone", (0.61, 0.53, 0.36), 0.72)
    g = Geometry(name, role, m_stone)
    n = max(4, int(steps))
    ax = axis.upper()
    du = (y_end - y_start) / n
    dz = (z1 - z0) / n
    for idx in range(n):
        uc = y_start + (idx + 0.5) * du
        zt = z0 + (idx + 1) * dz
        h_step = zt - z0
        w_cur = width - idx * 0.0015
        if ax == "Y":
            g.box((center_x, uc, z0 + h_step * 0.5), (w_cur, abs(du) * 1.05, h_step), subdiv=2)
        else:
            g.box((uc, center_x, z0 + h_step * 0.5), (abs(du) * 1.05, w_cur, h_step), subdiv=2)
    if with_cheek_walls:
        cw = max(0.012, width * 0.10)
        for sign in [-1, 1]:
            for idx in range(n):
                uc = y_start + (idx + 0.5) * du
                zt = z0 + (idx + 1) * dz + dz * 0.65
                if ax == "Y":
                    g.box((center_x + sign * (width * 0.5 + cw * 0.5), uc, (z0 + zt) * 0.5), (cw, abs(du) * 1.05, zt - z0), subdiv=2)
                else:
                    g.box((uc, center_x + sign * (width * 0.5 + cw * 0.5), (z0 + zt) * 0.5), (abs(du) * 1.05, cw, zt - z0), subdiv=2)
    if with_central_ramp:
        rw = width * float(ramp_width_ratio) * 0.5
        if ax == "Y":
            g.prism(
                [(y_start, z0), (y_end, z0), (y_end, z1 + dz * 0.35), (y_start, z0 + dz * 0.85)],
                center_x - rw,
                center_x + rw,
                axis="X",
            )
        else:
            g.prism(
                [(y_start, z0), (y_end, z0), (y_end, z1 + dz * 0.35), (y_start, z0 + dz * 0.85)],
                center_x - rw,
                center_x + rw,
                axis="Y",
            )
    return g.finish(bevel=0.0004)



if IN_BLENDER:
    def apply_crease_auto_smooth(bm, sharp_angle_deg=32.0, merge_dist=1e-6, recalc_normals=True):
        """Weld coincident seam vertices, orient manifold normals outward, and mark dihedral creases >= `sharp_angle_deg` sharp.

        【视觉光影与微分几何原理】：
        在建筑灰模渲染中，圆柱、穹顶和反宇瓦面需要连续插值顶点法向以呈现柔和渐变高光；而台基折棱、柱头方板（Abacus）和窗框转角则需要断开法向插值以形成清晰锐利的明暗交界线。
        对每条内部流形边 $e$，设其两侧相邻面法向为 $\mathbf{n}_0, \mathbf{n}_1$，二面角 $\theta_e = \arccos(\mathbf{n}_0 \cdot \mathbf{n}_1)$：
        - 当 $\theta_e < \theta_{\text{sharp}}$（默认 $32^\circ$）时标记 `edge.smooth = True`（曲面连续过渡）；
        - 当 $\theta_e \ge \theta_{\text{sharp}}$ 或为边界边时标记 `edge.smooth = False`（硬朗折痕棱线）。
        """
        if merge_dist and merge_dist > 0.0 and len(bm.verts) > 0:
            bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=float(merge_dist))
        if recalc_normals and len(bm.faces) > 0:
            bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        bm.normal_update()
        sharp_rad = math.radians(float(sharp_angle_deg))
        for edge in bm.edges:
            if len(edge.link_faces) != 2:
                edge.smooth = False
            else:
                f0, f1 = edge.link_faces[0], edge.link_faces[1]
                if not (f0.smooth and f1.smooth):
                    edge.smooth = False
                else:
                    edge.smooth = f0.normal.angle(f1.normal, 0.0) < sharp_rad
        return bm

    def create_tonal_clay_palette(bevel_radius=0.0004):
        """Create a 6-tone neutral grey-white architectural clay material palette with micro-bevel normal highlights.

        【视觉明度层次与建筑进深映射】：
        无彩色灰模通过明度（Albedo Value）与微倒角法向节点表达建筑凹凸景深：
        - `"bright_trim"` (`0.84`): 突出于立面之外的栏杆、檐口挑线、柱头、券石环与吻兽（受光最亮）；
        - `"light_stone"` (`0.78`): 台基、阶梯、外露承重柱列；
        - `"main_clay"` (`0.72`): 主体墙面与塔身标准灰调；
        - `"roof_clay"` (`0.58`): 坡屋顶瓦面与穹顶壳体（压暗一档以在俯视和鸟瞰中与浅色墙身拉开清晰层次）；
        - `"shadow_reveal"` (`0.42`): 屋檐底面、拱腹内壁（Soffit）、窗套深槽；
        - `"dark_void"` (`0.14`): 深凹门窗玻璃面或暗腔背板（模拟室内消光负空间）。
        """
        tones = {
            "bright_trim": (0.84, 0.72),
            "light_stone": (0.78, 0.78),
            "main_clay": (0.72, 0.80),
            "roof_clay": (0.58, 0.82),
            "shadow_reveal": (0.42, 0.86),
            "dark_void": (0.14, 0.45),
        }
        palette = {}
        for key, (val, rough) in tones.items():
            m_name = f"Clay_{key}"
            mat = bpy.data.materials.get(m_name)
            if mat is None:
                mat = bpy.data.materials.new(m_name)
            mat.diffuse_color = (val, val, val, 1.0)
            mat.use_nodes = True
            nt = mat.node_tree
            bsdf = nt.nodes.get("Principled BSDF")
            if bsdf is not None:
                bsdf.inputs["Base Color"].default_value = (val, val, val, 1.0)
                bsdf.inputs["Roughness"].default_value = rough
                if bevel_radius and bevel_radius > 0.0:
                    bev = next((n for n in nt.nodes if n.bl_idname == "ShaderNodeBevel"), None)
                    if bev is None:
                        bev = nt.nodes.new("ShaderNodeBevel")
                        bev.samples = 4
                        nt.links.new(bev.outputs["Normal"], bsdf.inputs["Normal"])
                    bev.inputs["Radius"].default_value = float(bevel_radius)
            palette[key] = mat
        return palette

    def normalize_scene_unit_x(target_x_span=1.0, ground_z=0.0, center_y=True):
        """Uniformly transform all visible scene vertices so total X span == `target_x_span` and lowest vertex Z == `ground_z`.

        【仿射相似变换原理】：
        计算全场景可见网格顶点的世界包围盒 $[x_{\min}, x_{\max}]\times[y_{\min}, y_{\max}]\times[z_{\min}, z_{\max}]$，
        取各向同性缩放因子 $s = L_x / (x_{\max} - x_{\min})$（严格保持高宽比 `dz/dx` 与深宽比 `dy/dx` 不变），
        对所有网格顶点执行刚体居中 + 等比缩放变换 $P' = (0, 0, z_{\text{ground}}) + s\cdot(P - (c_x, c_y, z_{\min}))$。
        """
        bpy.context.view_layer.update()
        meshes = [o for o in bpy.context.scene.objects if o.type == "MESH" and not o.hide_render and o.data and len(o.data.vertices) > 0]
        if not meshes:
            return None
        mins = [float("inf")] * 3
        maxs = [float("-inf")] * 3
        for obj in meshes:
            mw = obj.matrix_world
            for v in obj.data.vertices:
                w = mw @ v.co
                for k in range(3):
                    if w[k] < mins[k]:
                        mins[k] = w[k]
                    if w[k] > maxs[k]:
                        maxs[k] = w[k]
        span_x = maxs[0] - mins[0]
        if span_x < 1e-8:
            return None
        scale = float(target_x_span) / span_x
        cx = 0.5 * (mins[0] + maxs[0])
        cy = 0.5 * (mins[1] + maxs[1]) if center_y else 0.0
        z0 = mins[2]
        xform = Matrix.Translation((0.0, 0.0, float(ground_z))) @ Matrix.Scale(scale, 4) @ Matrix.Translation((-cx, -cy, -z0))
        seen_meshes = set()
        for obj in meshes:
            if obj.data.users > 1:
                obj.data = obj.data.copy()
            mw = obj.matrix_world.copy()
            obj.matrix_world = Matrix.Identity(4)
            if obj.data.name not in seen_meshes:
                obj.data.transform(xform @ mw)
                obj.data.update()
                seen_meshes.add(obj.data.name)
        bpy.context.view_layer.update()
        return {"scale_applied": round(scale, 6), "target_x_span": target_x_span, "ground_z": ground_z}

    class LocalFrame:
        """Orientation-safe local architectural facade frame `(u, d, z)` with automatic mirrored-winding protection.

        【视觉与局部坐标定义】：
        观察建筑任意一侧立面（南向正立面、东西侧山墙、或八角塔的斜向立面），立面上的门窗、壁柱、山花和斗拱都以该立面为基准展开：
        - `u`：沿立面水平向右的横坐标（开间方向）；
        - `d`：**沿外法向反方向进入建筑内部的进深坐标**（`d = 0` 为外墙皮基准面，`d > 0` 向墙内凹入形成窗套阴影，`d < 0` 向墙外凸出形成壁柱/挑檐）；
        - `z`：世界竖直向上高度。

        【内部正交基与行列式环绕序原理】：
        给定单位外法向 $\mathbf{n}_{\text{out}} = (n_x, n_y, 0)$，令深入向量 $\mathbf{e}_d = -\mathbf{n}_{\text{out}}$，横向向量 $\mathbf{e}_u = (-n_y, n_x, 0)$，竖向向量 $\mathbf{e}_z = (0, 0, 1)$。
        此时混合积 $(\mathbf{e}_u \times \mathbf{e}_d) \cdot \mathbf{e}_z = n_x^2 + n_y^2 = +1 > 0$（标准右手系）；
        若开启水平镜像 `mirror_u=True`，混合积变为 $-1 < 0$，`self.flip_winding = True` 自动通知面构建器反转顶点环绕序，从根本上杜绝镜像侧立面法向朝内的黑面错误。
        """

        def __init__(self, origin=(0.0, 0.0, 0.0), yaw_deg=0.0, outward_normal=None, mirror_u=False):
            self.origin = Vector((float(origin[0]), float(origin[1]), float(origin[2])))
            if outward_normal is not None:
                nx, ny = float(outward_normal[0]), float(outward_normal[1])
                nlen = math.hypot(nx, ny) or 1.0
                n_out = Vector((nx / nlen, ny / nlen, 0.0))
                self.e_d = -n_out
                self.e_u = Vector((-n_out.y, n_out.x, 0.0))
            else:
                rad = math.radians(float(yaw_deg))
                self.e_u = Vector((math.cos(rad), math.sin(rad), 0.0))
                self.e_d = Vector((-math.sin(rad), math.cos(rad), 0.0))
            if mirror_u:
                self.e_u = -self.e_u
            self.e_z = Vector((0.0, 0.0, 1.0))
            self.flip_winding = self.e_u.cross(self.e_d).dot(self.e_z) < 0.0

        @classmethod
        def from_facade(cls, origin, outward_normal, mirror_u=False):
            return cls(origin=origin, outward_normal=outward_normal, mirror_u=mirror_u)

        def point(self, u, d, z):
            return self.origin + float(u) * self.e_u + float(d) * self.e_d + float(z) * self.e_z

        @property
        def matrix(self):
            return Matrix((
                (self.e_u.x, self.e_d.x, self.e_z.x, self.origin.x),
                (self.e_u.y, self.e_d.y, self.e_z.y, self.origin.y),
                (self.e_u.z, self.e_d.z, self.e_z.z, self.origin.z),
                (0.0, 0.0, 0.0, 1.0),
            ))

    class EllipticalFrame:
        """Arc-length-uniform elliptical parallel-offset coordinate frame `(u, d, z)` (`u in [0, 1]`, `d` inward normal offset).

        【视觉现象与等弧长微分几何原理】：
        在椭圆形建筑（如斗兽场、椭圆坛座，长半轴 $a$、短半轴 $b$）中，整圈拱门在图像上的弧长跨度处处均等，且环墙厚度处处恒定。
        若直接对离心角 $t \in [0, 2\pi)$ 等分，由于弧微分 $ds/dt = \sqrt{a^2\sin^2 t + b^2\cos^2 t}$，长轴两端（$t=0, \pi$）的拱门宽度会被压窄为短轴处的 $b/a$ 倍，且向心缩放 $(a-d)\cos t$ 会导致环墙厚度不均。
        本标架通过两步消除畸变：
        1. **4096 点中点黎曼和累积弧长表 + 二分反演**：计算 $S(t_k) = \sum_{m<k}\sqrt{a^2\sin^2 t_{m+1/2}+b^2\cos^2 t_{m+1/2}}\,\Delta t$，对归一化弧长参数 $u \in [0, 1]$ 二分反解精确角度 $t = S^{-1}(u\cdot L)$；
        2. **平行曲线外法向偏移**：椭圆在 $t$ 处的单位外法向为 $\mathbf{n}(t) = \frac{(b\cos t,\; a\sin t)}{\sqrt{b^2\cos^2 t + a^2\sin^2 t}}$，沿 $-\mathbf{n}(t)$ 向内平移真实法向厚度 $d$：
           $$P(u, d, z) = (c_x + a\cos t - d\,n_x(t),\; c_y + b\sin t - d\,n_y(t),\; z)$$
        """

        def __init__(self, a=0.5, b=0.4, cx=0.0, cy=0.0, t_origin_deg=0.0, samples=4096):
            self.a = max(1e-5, float(a))
            self.b = max(1e-5, float(b))
            self.cx = float(cx)
            self.cy = float(cy)
            self.t0 = math.radians(float(t_origin_deg))
            n = max(256, int(samples))
            dt = (2.0 * math.pi) / n
            cum = [0.0] * (n + 1)
            acc = 0.0
            for i in range(n):
                tm = self.t0 + (i + 0.5) * dt
                acc += math.hypot(-self.a * math.sin(tm), self.b * math.cos(tm)) * dt
                cum[i + 1] = acc
            self.perimeter = acc
            self._n = n
            self._dt = dt
            self._u = [c / acc for c in cum]

        def u_to_angle(self, u):
            wraps = math.floor(float(u))
            uf = float(u) - wraps
            if uf <= 0.0:
                return self.t0 + wraps * 2.0 * math.pi
            if uf >= 1.0:
                return self.t0 + (wraps + 1.0) * 2.0 * math.pi
            lo, hi = 0, self._n
            grid = self._u
            while lo + 1 < hi:
                mid = (lo + hi) // 2
                if grid[mid] <= uf:
                    lo = mid
                else:
                    hi = mid
            denom = grid[hi] - grid[lo]
            frac = (uf - grid[lo]) / denom if denom > 1e-12 else 0.0
            return self.t0 + wraps * 2.0 * math.pi + (lo + frac) * self._dt

        def point(self, u, d=0.0, z=0.0):
            t = self.u_to_angle(u)
            ct, st = math.cos(t), math.sin(t)
            nx, ny = self.b * ct, self.a * st
            nl = math.hypot(nx, ny) or 1.0
            nx, ny = nx / nl, ny / nl
            return Vector((self.cx + self.a * ct - float(d) * nx, self.cy + self.b * st - float(d) * ny, float(z)))

    class PartBMesh:
        """Native `bmesh.types.BMesh` accumulator with multi-tone clay slots, oriented 3D beams, lofted rings, and contract stamping.

        【核心几何构建原语】：
        - `add_box(center, size, frame_or_matrix=..., bevel_top=...)`：支持在 `LocalFrame` 或任意 4x4 矩阵下放置正交/台形六面体（当变换矩阵行列式 $<0$ 时自动反转 6 个面的顶点序）；
        - `add_oriented_beam(p0, p1, width, height)`：给定空间任意两点 $P_0, P_1$，用叉积构造正交横截面标架 $\mathbf{s} = (\hat{\mathbf{t}} \times \mathbf{r}) / \|\cdot\|,\; \mathbf{u} = \mathbf{s} \times \hat{\mathbf{t}}$，精确生成倾斜钢梁、飞椽、瓦垄、垂脊与哥特窗棂；
        - `add_lofted_rings(rings, cap_bottom=True, cap_top=True, smooth_sides=...)`：将一系列等顶点数截面环 $\{R_0, R_1, \dots, R_K\}$ 逐层桥接为封闭回转体或多棱台（用于凹槽柱、穹顶、宝塔叠涩檐与分水尖）。
        """

        def __init__(self, name, role=None, mat=None, sharp_angle_deg=32.0):
            if role is not None and hasattr(role, "diffuse_color") and mat is None:
                mat, role = role, None
            g_probe = Geometry(name, role=role, mat=mat)
            g_probe._finished = True
            self.name = g_probe.name
            self.role_idx = g_probe.role_idx
            self.role_name = g_probe.role_name
            self.sharp_angle_deg = float(sharp_angle_deg)
            self.bm = bmesh.new()
            self.materials = []
            self._mat_map = {}
            if mat is not None:
                self.mat_idx(mat)
            self._finished = False
            _ACTIVE_GEOMETRIES.append(self)

        @property
        def vertices(self):
            return self.bm.verts

        @property
        def faces(self):
            return self.bm.faces

        def mat_idx(self, mat):
            if mat is None:
                mat = ensure_neutral_material()
            elif isinstance(mat, str):
                pal = create_tonal_clay_palette()
                mat = pal.get(mat) or material(mat)
            if mat.name not in self._mat_map:
                self._mat_map[mat.name] = len(self.materials)
                self.materials.append(mat)
            return self._mat_map[mat.name]

        def add_face(self, pts, mat=None, smooth=False, flip=False):
            if len(pts) < 3:
                return None
            seq = list(reversed(pts)) if flip else list(pts)
            vs = [self.bm.verts.new(Vector(p)) for p in seq]
            if len({(round(v.co.x, 7), round(v.co.y, 7), round(v.co.z, 7)) for v in vs}) < 3:
                return None
            try:
                f = self.bm.faces.new(vs)
                f.smooth = bool(smooth)
                if mat is not None or self.materials:
                    f.material_index = self.mat_idx(mat) if mat is not None else 0
                return f
            except ValueError:
                return None

        def add_quad(self, p0, p1, p2, p3, mat=None, smooth=False, flip=False):
            return self.add_face((p0, p1, p2, p3), mat=mat, smooth=smooth, flip=flip)

        def add_box(self, center, size, frame_or_matrix=None, mat=None, bevel_top=0.0):
            cx, cy, cz = float(center[0]), float(center[1]), float(center[2])
            hx, hy, hz = float(size[0]) * 0.5, float(size[1]) * 0.5, float(size[2]) * 0.5
            hxt = max(hx * 0.15, hx - float(bevel_top))
            hyt = max(hy * 0.15, hy - float(bevel_top))
            pts = [
                Vector((cx - hx, cy - hy, cz - hz)),
                Vector((cx + hx, cy - hy, cz - hz)),
                Vector((cx + hx, cy + hy, cz - hz)),
                Vector((cx - hx, cy + hy, cz - hz)),
                Vector((cx - hxt, cy - hyt, cz + hz)),
                Vector((cx + hxt, cy - hyt, cz + hz)),
                Vector((cx + hxt, cy + hyt, cz + hz)),
                Vector((cx - hxt, cy + hyt, cz + hz)),
            ]
            mtx = frame_or_matrix.matrix if hasattr(frame_or_matrix, "matrix") else frame_or_matrix
            flip = False
            if mtx is not None:
                pts = [mtx @ p for p in pts]
                flip = mtx.determinant() < 0.0
            for q in ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
                self.add_face([pts[i] for i in q], mat=mat, smooth=False, flip=flip)

        def add_oriented_beam(self, p0, p1, width, height, mat=None):
            pa, pb = Vector(p0), Vector(p1)
            d = pb - pa
            if d.length < 1e-7:
                return
            dn = d.normalized()
            ref = Vector((0.0, 0.0, 1.0)) if abs(dn.z) < 0.96 else Vector((1.0, 0.0, 0.0))
            side = dn.cross(ref).normalized() * (float(width) * 0.5)
            up = side.cross(dn).normalized() * (float(height) * 0.5)
            a = [pa - side - up, pa + side - up, pa + side + up, pa - side + up]
            b = [pb - side - up, pb + side - up, pb + side + up, pb - side + up]
            self.add_face((a[0], a[3], a[2], a[1]), mat=mat)
            self.add_face((b[0], b[1], b[2], b[3]), mat=mat)
            for i in range(4):
                j = (i + 1) % 4
                self.add_face((a[i], b[i], b[j], a[j]), mat=mat)

        def add_lofted_rings(self, rings, cap_bottom=True, cap_top=True, smooth_sides=False, mat=None):
            if len(rings) < 2 or len(rings[0]) < 3:
                return
            n = len(rings[0])
            m_idx = self.mat_idx(mat) if (mat is not None or self.materials) else None
            v_rings = [[self.bm.verts.new(Vector(p)) for p in r] for r in rings]
            if cap_bottom:
                try:
                    fb = self.bm.faces.new(list(reversed(v_rings[0])))
                    fb.smooth = False
                    if m_idx is not None:
                        fb.material_index = m_idx
                except ValueError:
                    pass
            for r_i in range(len(v_rings) - 1):
                r0, r1 = v_rings[r_i], v_rings[r_i + 1]
                for i in range(n):
                    j = (i + 1) % n
                    if (r0[i].co - r1[i].co).length < 1e-7 and (r0[j].co - r1[j].co).length < 1e-7:
                        continue
                    try:
                        f = self.bm.faces.new((r0[i], r0[j], r1[j], r1[i]))
                        f.smooth = bool(smooth_sides)
                        if m_idx is not None:
                            f.material_index = m_idx
                    except ValueError:
                        pass
            if cap_top:
                try:
                    ft = self.bm.faces.new(v_rings[-1])
                    ft.smooth = False
                    if m_idx is not None:
                        ft.material_index = m_idx
                except ValueError:
                    pass

        def append_bmesh(self, src_bm, matrix=None, mat=None, smooth=None):
            vmap = {v: self.bm.verts.new((matrix @ v.co) if matrix is not None else v.co.copy()) for v in src_bm.verts}
            flip = matrix is not None and matrix.determinant() < 0.0
            m_idx = self.mat_idx(mat) if mat is not None else None
            for f in src_bm.faces:
                vs = [vmap[v] for v in (reversed(f.verts) if flip else f.verts)]
                try:
                    nf = self.bm.faces.new(vs)
                    nf.smooth = f.smooth if smooth is None else bool(smooth)
                    if m_idx is not None:
                        nf.material_index = m_idx
                except ValueError:
                    pass

        def finish(self, merge_dist=1e-6, recalc_normals=True):
            if self._finished:
                return bpy.data.objects.get(self.name)
            self._finished = True
            if len(self.bm.faces) == 0:
                self.bm.free()
                return None
            apply_crease_auto_smooth(
                self.bm,
                sharp_angle_deg=self.sharp_angle_deg,
                merge_dist=merge_dist,
                recalc_normals=recalc_normals,
            )
            old = bpy.data.objects.get(self.name)
            if old is not None:
                old_d = old.data
                bpy.data.objects.remove(old, do_unlink=True)
                if old_d is not None and old_d.users == 0 and isinstance(old_d, bpy.types.Mesh):
                    bpy.data.meshes.remove(old_d)
            mesh = bpy.data.meshes.new(f"{self.name}_Mesh")
            if not self.materials:
                self.materials.append(ensure_neutral_material())
            for m in self.materials:
                mesh.materials.append(m)
            self.bm.to_mesh(mesh)
            self.bm.free()
            obj = bpy.data.objects.new(self.name, mesh)
            stamp_object_contract(obj, self.role_idx, mat=self.materials[0])
            return obj

    def ensure_part_bmesh(target, role="BODY", mat="main_clay"):
        """Accept an existing `PartBMesh`, a `Geometry` instance, or an object name string (auto-creating and finishing `PartBMesh`)."""
        if isinstance(target, PartBMesh):
            return target, False
        if hasattr(target, "poly") and hasattr(target, "role_idx"):
            pbm = PartBMesh(f"{target.name}_bmesh", role=target.role_idx, mat=target.mat or mat)
            return pbm, True
        return PartBMesh(str(target), role=role, mat=mat), True

    def replicate_cn_symmetry(dst_pbm, template_bm, n_sides=8, cx=0.0, cy=0.0, mat=None):
        """Replicate one facet `BMesh` around vertical axis `(cx, cy)` under cyclic group $C_n$ ($\theta_k = 2\pi k / n$).

        【视觉与对称群原理】：
        八角木塔、六角亭、圆形攒尖殿或玫瑰花窗的每一面具有完全相同的柱网、斗拱和窗扇。
        只需在南向正面（`-Y`）局部标架中精细构建 $1/n$ 扇区模板 `template_bm`，本函数即按旋转矩阵 $R_z(2\pi k/n)$ 环绕拷贝 $n$ 份。
        """
        t_inv = Matrix.Translation((-float(cx), -float(cy), 0.0))
        t_pos = Matrix.Translation((float(cx), float(cy), 0.0))
        for k in range(int(n_sides)):
            rot = Matrix.Rotation(2.0 * math.pi * k / int(n_sides), 4, "Z")
            dst_pbm.append_bmesh(template_bm, matrix=t_pos @ rot @ t_inv, mat=mat)

    def replicate_d4_symmetry(dst_pbm, quadrant_bm, cx=0.0, cy=0.0, include_diagonal_swap=False, mat=None):
        """Replicate a quadrant/wing `BMesh` across X/Y reflection planes (and optional $X \leftrightarrow Y$ swap for $D_4$ cross symmetry).

        【视觉与反射法向保持原理】：
        四面对称楼阁（如十字脊抱厦、四向阶梯金字塔、四角角楼）只需建好第一象限构件：
        - `include_diagonal_swap=False`：执行克莱因四元群 $V_4 = \{(\pm 1, \pm 1)\}$ 四象限镜像；
        - `include_diagonal_swap=True`：额外交替执行对角置换 $(x, y) \mapsto (y, x)$，生成完整的 8 阶二面体群 $D_4$ 对称体，且自动翻转负行列式镜像副本的顶点序。
        """
        t_inv = Matrix.Translation((-float(cx), -float(cy), 0.0))
        t_pos = Matrix.Translation((float(cx), float(cy), 0.0))
        for sx in (1.0, -1.0):
            for sy in (1.0, -1.0):
                m_scale = Matrix.Diagonal((sx, sy, 1.0, 1.0))
                dst_pbm.append_bmesh(quadrant_bm, matrix=t_pos @ m_scale @ t_inv, mat=mat)
                if include_diagonal_swap:
                    m_swap = Matrix(((0, 1, 0, 0), (1, 0, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1)))
                    dst_pbm.append_bmesh(quadrant_bm, matrix=t_pos @ m_swap @ m_scale @ t_inv, mat=mat)


def run(arguments):
    return {
        "module": "lab_bmesh_frame_and_clay",
        "exports": [
            "PartBMesh", "LocalFrame", "EllipticalFrame",
            "replicate_cn_symmetry", "replicate_d4_symmetry",
            "apply_crease_auto_smooth", "create_tonal_clay_palette",
            "normalize_scene_unit_x",
        ],
    }


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
