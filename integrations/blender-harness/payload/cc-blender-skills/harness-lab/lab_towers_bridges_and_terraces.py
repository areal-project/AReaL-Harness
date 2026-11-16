#!/usr/bin/env python3
"""Ruled Hyperboloid Diagrids, Exoskeletal Suspension Frames, Modular Concrete Clusters, Stepped Terraces & Stone Arch Bridges
(`lab_towers_bridges_and_terraces.py`).

本模块涵盖超高层斜交网壳、高技派悬挂桁架、模块化错位聚落、阶梯金字塔/圆坛及驼峰联拱石桥算子，附完整视觉与数学解析。
"""
from __future__ import annotations

import math
from pathlib import Path
import sys

_HERE = str(Path(__file__).resolve().parent)
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

try:
    import bpy
    import bmesh
    from mathutils import Matrix, Vector
    IN_BLENDER = True
except ImportError:
    IN_BLENDER = False

if IN_BLENDER:
    from lab_bmesh_frame_and_clay import LocalFrame, PartBMesh, ensure_part_bmesh


def build_twisted_hyperboloid_diagrid(
    target,
    cx=0.0,
    cy=0.0,
    z0=0.0,
    height=1.20,
    rx_bot=0.24,
    ry_bot=0.20,
    rx_top=0.15,
    ry_top=0.13,
    twist_deg=-125.0,
    rim_tilt_x=0.04,
    num_columns=24,
    num_rings=24,
    col_thick=0.008,
    core_radius=0.055,
    spire_h=0.28,
    role="SUPPORTS",
    mat="light_stone",
):
    """Build a ruled waisted hyperboloid diagrid tower (straight inclined columns + horizontal ring girders + diagonal braces + core + mast).

    【视觉悖论与单叶双曲面直纹几何原理】：
    图像中的小蛮腰扭转观光塔中部呈现优雅的纤细内凹双曲线轮廓，但结构上每一根通高外筒斜柱都是**纯粹的三维直线段**！
    设底环椭圆节点 $B_i = (a_b\cos\theta_i,\; b_b\sin\theta_i,\; z_0)$，顶环施加水平旋转扭角 $\Phi = \text{twist\_deg}$ 与椭圆斜切顶面倾角 $k_x$：
    $$T_i = \bigl(a_t\cos(\theta_i + \Phi),\; b_t\sin(\theta_i + \Phi),\; z_0 + H - k_x a_t\cos(\theta_i + \Phi)\bigr)$$
    对每根柱沿高度等分线性插值 $N_{i,j} = (1 - j/N_r) B_i + (j/N_r) T_i$：由于弦连接了方位角相差 $\Phi$ 的上下椭圆点，弦中点自然向中心轴收拢，最小腰部半径解析值为 $r_{\text{waist}} \approx \bar{R}\cos(\Phi/2)$；再连接层间水平环梁 $(i, j+1)\leftrightarrow(i+1, j+1)$ 与斜撑 $(i, j)\leftrightarrow(i+1, j+1)$ 即构成完整外筒网壳。
    """
    pbm, auto_fin = ensure_part_bmesh(target, role=role, mat=mat)
    nc = max(8, int(num_columns))
    nr = max(6, int(num_rings))
    tw = math.radians(float(twist_deg))

    def bot_pt(i):
        th = 2.0 * math.pi * (i + 0.5) / nc
        return Vector((float(cx) + float(rx_bot) * math.cos(th), float(cy) + float(ry_bot) * math.sin(th), float(z0)))

    def top_pt(i):
        th = 2.0 * math.pi * (i + 0.5) / nc + tw
        x = float(rx_top) * math.cos(th)
        y = float(ry_top) * math.sin(th)
        return Vector((float(cx) + x, float(cy) + y, float(z0) + float(height) - float(rim_tilt_x) * x))

    nodes = [[bot_pt(i).lerp(top_pt(i), j / nr) for j in range(nr + 1)] for i in range(nc)]
    ct = float(col_thick)
    for i in range(nc):
        ni = (i + 1) % nc
        for j in range(nr):
            pbm.add_oriented_beam(nodes[i][j], nodes[i][j + 1], ct, ct, mat="bright_trim")
            pbm.add_oriented_beam(nodes[i][j + 1], nodes[ni][j + 1], ct * 0.68, ct * 0.68, mat=mat)
            pbm.add_oriented_beam(nodes[i][j], nodes[ni][j + 1], ct * 0.58, ct * 0.58, mat=mat)

    if core_radius and float(core_radius) > 0.004:
        rc = float(core_radius)
        c_rings = [
            [Vector((float(cx) + rc * math.cos(2 * math.pi * k / 24), float(cy) + rc * math.sin(2 * math.pi * k / 24), float(z0))) for k in range(24)],
            [Vector((float(cx) + rc * math.cos(2 * math.pi * k / 24), float(cy) + rc * math.sin(2 * math.pi * k / 24), float(z0) + float(height) * 0.96)) for k in range(24)],
        ]
        pbm.add_lofted_rings(c_rings, cap_bottom=True, cap_top=True, smooth_sides=True, mat="main_clay")

    if spire_h and float(spire_h) > 0.01:
        zb = float(z0) + float(height) * 0.96
        pbm.add_oriented_beam((cx, cy, zb), (cx, cy, zb + float(spire_h)), ct * 1.1, ct * 1.1, mat="bright_trim")
    return pbm.finish() if auto_fin else pbm


def build_exoskeleton_suspension_frame(
    target,
    cx=0.0,
    cy=0.0,
    hx=0.22,
    hy=0.16,
    z0=0.0,
    height=0.85,
    truss_levels=(0.35, 0.68, 0.96),
    mast_thick=0.016,
    role="SUPPORTS",
    mat="bright_trim",
):
    """Build a high-tech exoskeletal steel tower frame with 4 twin-column Vierendeel ladder masts and coat-hanger suspension trusses.

    【视觉与高技派传力几何】：
    前后立面各立两座由双立柱 + 密集水平横档构成的空腹格构巨柱（位置 $\pm 0.72 h_x$）；在各设备避难层标高 `z0 + lv * height` 处，由巨柱节点向内跨中点 `(cx, ym, zt - th)` 与外悬挑端 `(cx ± hx, ym, zt - th)` 张拉人字形斜拉钢杆及水平下弦拉杆，并向下伸出中央吊杆悬挂各段楼层体块。
    """
    pbm, auto_fin = ensure_part_bmesh(target, role=role, mat=mat)
    mt = float(mast_thick)
    zh = float(height)
    for sy in (-1.0, 1.0):
        ym = float(cy) + sy * float(hy)
        for sx in (-1.0, 1.0):
            xm = float(cx) + sx * float(hx) * 0.72
            for sub in (-1.0, 1.0):
                pbm.add_oriented_beam((xm + sub * mt * 0.9, ym, float(z0)), (xm + sub * mt * 0.9, ym, float(z0) + zh), mt, mt, mat=mat)
            n_rungs = max(8, int(zh / 0.055))
            for r in range(n_rungs + 1):
                zr = float(z0) + zh * (r / n_rungs)
                pbm.add_oriented_beam((xm - mt * 0.9, ym, zr), (xm + mt * 0.9, ym, zr), mt * 0.65, mt * 0.65, mat=mat)

        for lv in truss_levels:
            zt = float(z0) + zh * float(lv)
            th = zh * 0.075
            pbm.add_oriented_beam((float(cx) - float(hx), ym, zt - th), (float(cx) + float(hx), ym, zt - th), mt * 0.85, mt * 0.85, mat=mat)
            for sx in (-1.0, 1.0):
                xm = float(cx) + sx * float(hx) * 0.72
                pbm.add_oriented_beam((xm, ym, zt), (float(cx), ym, zt - th), mt * 0.8, mt * 0.8, mat="light_stone")
                pbm.add_oriented_beam((xm, ym, zt), (float(cx) + sx * float(hx), ym, zt - th), mt * 0.8, mt * 0.8, mat="light_stone")
            pbm.add_oriented_beam((float(cx), ym, zt - th), (float(cx), ym, zt - th * 2.8), mt * 0.55, mt * 0.55, mat=mat)
    return pbm.finish() if auto_fin else pbm


def build_modular_cluster_stack(
    target,
    module_boxes,
    with_terraces=True,
    parapet_h=0.014,
    role="BODY",
    mat="main_clay",
):
    """Build cantilevered prefabricated concrete dwelling clusters from `(x0, x1, y0, y1, z0, z1)` boxes with occlusion-tested windows & roof parapets.

    【空间遮挡谓词与聚落退台原理】：
    模块化堆叠建筑（如 Habitat 67）由成组长方体盒子错位悬挑叠合。若给每个盒子盲目加屋顶栏杆和前窗，被上层盒子压住的栏杆会穿模刺入上层室内。
    本算子对每个模块 $B_i$ 执行两项三维区间邻接检测：
    1. **顶面暴露判定**：当且仅当不存在上层箱体 $B_j$ 满足 $|z_{0,j} - z_{1,i}| < \epsilon$ 且 $(c_{x,i}, c_{y,i}) \in [x_{0,j}, x_{1,j}]\times[y_{0,j}, y_{1,j}]$ 时，才在顶面四边生成女儿墙护栏；
    2. **前立面采光判定**：当且仅当前方 `-Y` 邻域无紧邻箱体遮挡时，自动嵌入深凹暗窗与窗台挑板。
    """
    pbm, auto_fin = ensure_part_bmesh(target, role=role, mat=mat)
    boxes = [(float(b[0]), float(b[1]), float(b[2]), float(b[3]), float(b[4]), float(b[5])) for b in module_boxes]
    for x0, x1, y0, y1, z0, z1 in boxes:
        cx, cy, cz = 0.5 * (x0 + x1), 0.5 * (y0 + y1), 0.5 * (z0 + z1)
        sx, sy, sz = x1 - x0, y1 - y0, z1 - z0
        pbm.add_box((cx, cy, cz), (sx, sy, sz), mat=mat)
        occ_front = any(
            ox0 < cx < ox1 and oz0 < cz < oz1 and oy0 < y0 - 0.002 < oy1 + 0.02
            for ox0, ox1, oy0, oy1, oz0, oz1 in boxes
        )
        if not occ_front:
            pbm.add_box((cx, y0 + 0.003, cz + sz * 0.06), (sx * 0.56, 0.008, sz * 0.44), mat="dark_void")
            pbm.add_box((cx, y0 - 0.002, cz - sz * 0.18), (sx * 0.62, 0.006, 0.004), mat="bright_trim")

        if with_terraces:
            occ_top = any(
                abs(oz0 - z1) < 0.008 and ox0 < cx < ox1 and oy0 < cy < oy1
                for ox0, ox1, oy0, oy1, oz0, oz1 in boxes
            )
            if not occ_top:
                ph = float(parapet_h)
                t = 0.005
                pbm.add_box((cx, y0 + t * 0.5, z1 + ph * 0.5), (sx, t, ph), mat="bright_trim")
                pbm.add_box((cx, y1 - t * 0.5, z1 + ph * 0.5), (sx, t, ph), mat="bright_trim")
                pbm.add_box((x0 + t * 0.5, cy, z1 + ph * 0.5), (t, sy, ph), mat="bright_trim")
                pbm.add_box((x1 - t * 0.5, cy, z1 + ph * 0.5), (t, sy, ph), mat="bright_trim")
    return pbm.finish() if auto_fin else pbm


def build_stepped_terrace_and_stairs(
    target,
    cx=0.0,
    cy=0.0,
    z0=0.0,
    tiers=3,
    base_half_w=0.45,
    step_in=0.055,
    tier_h=0.045,
    shape="rounded_square",
    sides=8,
    batter=0.012,
    with_tablero=False,
    stair_azimuths_deg=(270.0,),
    stair_w=0.09,
    with_imperial_ramp=False,
    role="BASE",
    mat="light_stone",
):
    """Build a multi-tier circular marble altar (`'circle'`), polygonal plinth (`'polygon'`), or rounded-square talud-tablero pyramid (`'rounded_square'`) with axial stairs, alfardas balustrades & imperial ramp (`御路`).

    【视觉图像特征与几何映射】：
    - `shape='circle', tiers=3, with_imperial_ramp=True`：天坛祈年殿三层汉白玉圆形祈谷坛 + 四出陛阶与中央丹陛斜雕板；
    - `shape='rounded_square', tiers=9, with_tablero=True, stair_azimuths_deg=(0, 90, 180, 270)`：玛雅阶梯金字塔——每层由内倾斜坡（`batter` 控制 Talud 收分）加外挑垂直框板（Tablero）组成，四角按半径 $r_c$ 倒圆角过渡，四面中央架设贯穿全高的陡峭踏步与两侧斜护墙梁（Alfardas）。
    """
    pbm, auto_fin = ensure_part_bmesh(target, role=role, mat=mat)
    sh = str(shape).lower()
    nt = max(1, int(tiers))

    def ring_pts(hw, z):
        if sh == "circle":
            return [Vector((float(cx) + hw * math.cos(2 * math.pi * i / 48), float(cy) + hw * math.sin(2 * math.pi * i / 48), z)) for i in range(48)]
        if sh == "polygon":
            ns = max(4, int(sides))
            return [Vector((float(cx) + hw * math.cos(-math.pi * 0.5 + math.pi / ns + 2 * math.pi * i / ns),
                            float(cy) + hw * math.sin(-math.pi * 0.5 + math.pi / ns + 2 * math.pi * i / ns), z)) for i in range(ns)]
        rc = min(hw * 0.14, 0.035)
        fh = max(1e-4, hw - rc)
        pts = []
        for c_ang, ox, oy in ((-math.pi * 0.5, fh, -fh), (0.0, fh, fh), (math.pi * 0.5, -fh, fh), (math.pi, -fh, -fh)):
            for k in range(5):
                a = c_ang + (math.pi * 0.5) * (k / 4.0)
                pts.append(Vector((float(cx) + ox + rc * math.cos(a), float(cy) + oy + rc * math.sin(a), z)))
        return pts

    for t in range(nt):
        hw_b = max(0.04, float(base_half_w) - t * float(step_in))
        hw_t = max(0.035, hw_b - float(batter))
        za = float(z0) + t * float(tier_h)
        zb = za + float(tier_h)
        pbm.add_lofted_rings([ring_pts(hw_b, za), ring_pts(hw_t, zb)], cap_bottom=True, cap_top=True, smooth_sides=(sh == "circle"), mat=mat)
        if with_tablero:
            pbm.add_lofted_rings([ring_pts(hw_t + 0.005, za + float(tier_h) * 0.42), ring_pts(hw_t + 0.005, zb - float(tier_h) * 0.08)],
                                 cap_bottom=True, cap_top=True, smooth_sides=False, mat="bright_trim")

    total_h = nt * float(tier_h)
    hw_top = max(0.04, float(base_half_w) - (nt - 1) * float(step_in) - float(batter))
    r_bot = float(base_half_w) + float(tier_h) * 0.65
    n_steps = max(8, nt * 9)
    for az in stair_azimuths_deg:
        rad = math.radians(float(az))
        nx, ny = math.cos(rad), math.sin(rad)
        fr = LocalFrame.from_facade((float(cx), float(cy), 0.0), (nx, ny))
        for s in range(n_steps):
            sf0, sf1 = s / n_steps, (s + 1) / n_steps
            d0 = -(r_bot * (1.0 - sf0) + hw_top * sf0)
            d1 = -(r_bot * (1.0 - sf1) + hw_top * sf1)
            pbm.add_box(
                (0.0, 0.5 * (d0 + d1), float(z0) + total_h * (sf0 + sf1) * 0.5),
                (float(stair_w), max(0.006, abs(d1 - d0) * 1.15), total_h / n_steps * 1.05),
                frame_or_matrix=fr,
                mat="main_clay",
            )
        for sgn in (-1.0, 1.0):
            pbm.add_oriented_beam(
                fr.point(sgn * float(stair_w) * 0.54, -r_bot, float(z0) + 0.008),
                fr.point(sgn * float(stair_w) * 0.54, -hw_top, float(z0) + total_h + 0.012),
                0.010, 0.014, mat="bright_trim",
            )
        if with_imperial_ramp:
            pbm.add_oriented_beam(
                fr.point(0.0, -r_bot, float(z0) + 0.005),
                fr.point(0.0, -hw_top, float(z0) + total_h + 0.005),
                float(stair_w) * 0.34, 0.010, mat="bright_trim",
            )
    return pbm.finish() if auto_fin else pbm


def build_stone_arch_bridge_span(
    target,
    span_x=0.92,
    bridge_w=0.14,
    z0=0.0,
    deck_z_ends=0.11,
    deck_crown_rise=0.045,
    num_arches=7,
    with_cutwaters=True,
    with_parapets=True,
    role="BASE",
    mat="light_stone",
):
    """Build a multi-span stone masonry arch bridge with parabolic humpback deck, pierced barrel vaults, V-prow cutwaters, and parapets.

    【视觉图像特征与抛物线纵坡耦合原理】：
    传统多孔石拱桥（如十七孔桥、双龙桥）桥面并非水平直线，而是呈两端低、跨中高的优美微拱曲线：
    $$z_{\text{deck}}(x) = z_{\text{end}} + H_{\text{crown}}\Bigl(1 - \bigl(\frac{2x}{L}\bigr)^2\Bigr)$$
    第 $k$ 孔的起拱线标高随局部桥面高度自适应抬升，拱圈上半圆弧 $(x_c + r\cos\theta,\; z_s + 0.82 r\sin\theta)$ 与上方的弧形桥面 $z_{\text{deck}}(x)$ 直接围合出精确贴合的实心拱肩墙与贯通水面的弧形拱腹筒，并在每座桥墩迎水/背水两侧拉伸等腰三角形棱柱分水尖（Cutwaters）。
    """
    pbm, auto_fin = ensure_part_bmesh(target, role=role, mat=mat)
    sx = float(span_x)
    hw = float(bridge_w) * 0.5
    na = max(1, int(num_arches))
    bay_w = sx / na

    def deck_z(x):
        u = x / (sx * 0.5)
        return float(deck_z_ends) + float(deck_crown_rise) * max(0.0, 1.0 - u * u)

    for k in range(na):
        xa = -0.5 * sx + k * bay_w
        xb = xa + bay_w
        xc = 0.5 * (xa + xb)
        zd = deck_z(xc)
        pier_w = bay_w * 0.22
        arch_r = (bay_w - pier_w) * 0.5
        z_sp = float(z0) + (zd - float(z0)) * 0.34

        for px in (xa + pier_w * 0.25, xb - pier_w * 0.25):
            pbm.add_box((px, 0.0, 0.5 * (float(z0) + zd)), (pier_w * 0.55, float(bridge_w), zd - float(z0)), mat=mat)
        if with_cutwaters and k > 0:
            for sy in (-1.0, 1.0):
                v_prow = [
                    Vector((xa - pier_w * 0.35, sy * hw, float(z0))),
                    Vector((xa + pier_w * 0.35, sy * hw, float(z0))),
                    Vector((xa, sy * (hw + pier_w * 0.65), float(z0))),
                ]
                if sy < 0:
                    v_prow = [v_prow[1], v_prow[0], v_prow[2]]
                v_top = [Vector((p.x, p.y, z_sp + 0.015)) for p in v_prow]
                pbm.add_lofted_rings([v_prow, v_top], cap_bottom=True, cap_top=True, smooth_sides=False, mat="bright_trim")

        ns = 12
        for s in range(ns):
            a0, a1 = math.pi * (1.0 - s / ns), math.pi * (1.0 - (s + 1) / ns)
            u0, z_a0 = xc + arch_r * math.cos(a0), z_sp + arch_r * 0.82 * math.sin(a0)
            u1, z_a1 = xc + arch_r * math.cos(a1), z_sp + arch_r * 0.82 * math.sin(a1)
            zt0, zt1 = deck_z(u0), deck_z(u1)
            pbm.add_quad((u0, -hw, z_a0), (u1, -hw, z_a1), (u1, -hw, zt1), (u0, -hw, zt0), mat=mat)
            pbm.add_quad((u1, hw, z_a1), (u0, hw, z_a0), (u0, hw, zt0), (u1, hw, zt1), mat=mat)
            pbm.add_quad((u0, hw, z_a0), (u1, hw, z_a1), (u1, -hw, z_a1), (u0, -hw, z_a0), mat="shadow_reveal", smooth=True)
            pbm.add_quad((u0, -hw, zt0), (u1, -hw, zt1), (u1, hw, zt1), (u0, hw, zt0), mat="main_clay")
            for sy in (-1.0, 1.0):
                pbm.add_oriented_beam((u0, sy * (hw + 0.002), z_a0), (u1, sy * (hw + 0.002), z_a1), 0.005, 0.007, mat="bright_trim")

        if with_parapets:
            for sy in (-1.0, 1.0):
                pbm.add_oriented_beam((xa, sy * (hw - 0.006), deck_z(xa) + 0.010), (xb, sy * (hw - 0.006), deck_z(xb) + 0.010), 0.008, 0.018, mat="bright_trim")

    return pbm.finish() if auto_fin else pbm


def run(arguments):
    return {
        "module": "lab_towers_bridges_and_terraces",
        "operators": [
            "build_twisted_hyperboloid_diagrid",
            "build_exoskeleton_suspension_frame",
            "build_modular_cluster_stack",
            "build_stepped_terrace_and_stairs",
            "build_stone_arch_bridge_span",
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
