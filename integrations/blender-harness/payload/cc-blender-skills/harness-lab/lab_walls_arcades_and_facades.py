#!/usr/bin/env python3
"""Analytical Arch Curves, Mitered Profile Rings, Boolean-Free Perforated Walls, Curved Arcades & Curtain/Louver Facades
(`lab_walls_arcades_and_facades.py`).

本模块提供立面线脚扫掠、无布尔二维网格切分开洞、等弧长曲线拱廊与现代幕墙百叶算子，详细说明视觉形态与内部几何算法对应关系。
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
    from lab_bmesh_frame_and_clay import EllipticalFrame, LocalFrame, PartBMesh, ensure_part_bmesh


def arch_curve_profile(u_center, z_spring, half_w, rise=None, style="round", n=16):
    """Sample 2D `(u, z)` arch extrados/intrados coordinates from left spring `(u_center - half_w, z_spring)` over apex to right spring.

    【五种古典拱券的视觉轮廓与参数方程】（归一化横坐标 $u_t \in [-1, 1]$）：
    1. `'round'`（古罗马/中式半圆券）：$h(u_t) = \sqrt{1 - u_t^2}$；
    2. `'pointed'` / `'gothic'`（哥特双圆心尖券，拱顶呈锐折角）：$h(u_t) = \sqrt{1 - |u_t|(0.62 + 0.38|u_t|)}$；
    3. `'persian_4center'`（波斯四圆心尖拱，两侧拱肩宽阔饱满、顶部微尖）：$h(u_t) = (1 - |u_t|^{1.65})^{0.68}$；
    4. `'ogee_kokoshnik'`（威尼斯/俄式火焰反曲鸡冠拱）：$h(u_t) = (1 - |u_t|^{1.5})^{0.58}$；
    5. `'parabolic'` / `'segmental'`（桥梁抛物线弧拱）：$h(u_t) = 1 - u_t^2$。
    """
    hw = max(1e-4, float(half_w))
    zs = float(z_spring)
    st = str(style).lower()
    ar = float(rise) if rise is not None else hw * (1.28 if st in ("pointed", "gothic") else (1.16 if st in ("persian_4center", "ogee_kokoshnik") else 1.0))
    ns = max(6, int(n))
    pts = []
    for i in range(ns + 1):
        u_t = -1.0 + 2.0 * i / ns
        au = abs(u_t)
        if st in ("pointed", "gothic"):
            h = math.sqrt(max(0.0, 1.0 - au * (0.62 + 0.38 * au)))
        elif st in ("persian_4center", "persian"):
            h = (1.0 - au ** 1.65) ** 0.68
        elif st in ("ogee_kokoshnik", "kokoshnik", "ogee"):
            h = (1.0 - au ** 1.5) ** 0.58
        elif st in ("parabolic", "segmental"):
            h = max(0.0, 1.0 - u_t * u_t)
        else:
            h = math.sqrt(max(0.0, 1.0 - u_t * u_t))
        pts.append((float(u_center) + u_t * hw, zs + ar * h))
    return pts


def build_mitered_profile_ring(target, poly_ccw_xy, profile_out_z, role="BODY", mat="bright_trim"):
    """Sweep a closed 2D `(outward_offset, z)` molding/cornice/plinth profile around any CCW 2D polygon `(x, y)` with exact mitered corners.

    【视觉用途与角平分线斜接投影定理（Miter Scale）】：
    用于生成须弥座上下枭混束腰线脚、塔身层间腰檐、古典台基挑线或女儿墙压顶。
    若直接沿顶点平均法向平移距离 $o_k$，在 $90^\circ$ 直角转弯处线脚截面厚度会缩水为 $\cos 45^\circ = 0.707$ 倍！
    设逆时针多边形第 $i$ 边向量为 $(\Delta x_i, \Delta y_i)$，其精确单位外法向为 $\mathbf{n}_i = (\Delta y_i, -\Delta x_i)/L_i$。
    在顶点 $V_i$ 处计算前后两边单位外法向的单位角平分线 $\mathbf{b}_i = \frac{\mathbf{n}_{i-1} + \mathbf{n}_i}{\|\mathbf{n}_{i-1} + \mathbf{n}_i\|}$，并除以半角余弦 $\mathbf{b}_i \cdot \mathbf{n}_i$：
    $$\mathbf{m}_i = \frac{\mathbf{b}_i}{\mathbf{b}_i \cdot \mathbf{n}_i}, \qquad P_{i,k} = \bigl(V_{i,x} + o_k m_{i,x},\; V_{i,y} + o_k m_{i,y},\; z_k\bigr)$$
    由于 $(\mathbf{m}_i \cdot \mathbf{n}_i) = 1$ 且 $(\mathbf{m}_i \cdot \mathbf{n}_{i-1}) = 1$，扫掠出的闭合环在任意角度转角处均保持严格等宽平行线脚！
    """
    pbm, auto_fin = ensure_part_bmesh(target, role=role, mat=mat)
    pts = [(float(p[0]), float(p[1])) for p in poly_ccw_xy]
    prof = [(float(o), float(z)) for o, z in profile_out_z]
    n = len(pts)
    m = len(prof)
    if n < 3 or m < 3:
        return pbm.finish() if auto_fin else pbm

    e_norms = []
    for i in range(n):
        x0, y0 = pts[i]
        x1, y1 = pts[(i + 1) % n]
        dx, dy = x1 - x0, y1 - y0
        ln = math.hypot(dx, dy) or 1.0
        e_norms.append((dy / ln, -dx / ln))

    miters = []
    for i in range(n):
        n_prev = e_norms[(i - 1) % n]
        n_curr = e_norms[i]
        bx, by = n_prev[0] + n_curr[0], n_prev[1] + n_curr[1]
        bl = math.hypot(bx, by)
        if bl < 1e-6:
            miters.append(n_curr)
        else:
            bx, by = bx / bl, by / bl
            dot = max(0.35, bx * n_curr[0] + by * n_curr[1])
            miters.append((bx / dot, by / dot))

    v_grid = []
    for i in range(n):
        px, py = pts[i]
        mx, my = miters[i]
        v_grid.append([pbm.bm.verts.new((px + mx * off, py + my * off, z)) for off, z in prof])

    m_idx = pbm.mat_idx(mat)
    for i in range(n):
        ni = (i + 1) % n
        for k in range(m):
            nk = (k + 1) % m
            try:
                f = pbm.bm.faces.new((v_grid[i][k], v_grid[ni][k], v_grid[ni][nk], v_grid[i][nk]))
                f.material_index = m_idx
            except ValueError:
                pass
    return pbm.finish() if auto_fin else pbm


def build_perforated_wall(
    target,
    frame=None,
    u0=-0.30,
    u1=0.30,
    z0=0.0,
    z1=0.22,
    thickness=0.028,
    openings=(),
    with_sills=True,
    with_recess_glass=True,
    role="BODY",
    mat="main_clay",
):
    """Build an exact boolean-free 2-manifold wall in `frame` with arbitrary rectangular or arched openings, deep jamb reveals, sills, and optional dark recessed glazing.

    【无布尔二维笛卡尔区间切分拓扑原理】：
    对一堵开有数十扇方窗或拱窗的立面（如宫殿厚墙、土楼外墙、教堂侧墙），连续执行数十次三维布尔极易产生退化狭长三角面。
    本算子采用**精确解析网格剖分**：
    1. 提取墙体总边界与所有洞口的外接矩形切分坐标集合 $U = \{\text{sorted unique } u\},\; Z = \{\text{sorted unique } z\}$；
    2. 对每个子矩形格 $[u_a, u_b] \times [z_a, z_b]$，若格心落在任一洞口外接框内则跳过，否则生成实心墙体块（自动形成窗侧壁厚 Reveal）；
    3. 对带拱顶（`arch_style`）的洞口，在起拱线 `ozs` 至外接框顶 `ozt` 之间沿 `arch_curve_profile` 补齐前后立面拱肩四边形（Spandrels）、内弧拱腹（Soffit）与外凸券眉线，并在墙厚 `0.68 * thickness` 深处嵌入消光暗玻璃（设 `with_recess_glass=False` 则生成完全贯通的敞廊券洞）。
    """
    pbm, auto_fin = ensure_part_bmesh(target, role=role, mat=mat)
    fr = frame if isinstance(frame, LocalFrame) else LocalFrame()
    ops = []
    u_cuts = {round(float(u0), 6), round(float(u1), 6)}
    z_cuts = {round(float(z0), 6), round(float(z1), 6)}

    for raw in openings:
        if isinstance(raw, dict):
            a0, a1 = float(raw["u0"]), float(raw["u1"])
            b0, b1 = float(raw["z0"]), float(raw["z1"])
            astyle = raw.get("arch_style")
            arise = float(raw.get("arch_rise") or (0.5 * (a1 - a0) if astyle else 0.0))
        else:
            a0, a1, b0, b1 = float(raw[0]), float(raw[1]), float(raw[2]), float(raw[3])
            astyle = str(raw[4]) if len(raw) >= 5 and raw[4] else None
            arise = float(raw[5]) if len(raw) >= 6 else (0.5 * (a1 - a0) if astyle else 0.0)
        a0, a1 = max(float(u0), min(a0, a1)), min(float(u1), max(a0, a1))
        b0, b1 = max(float(z0), min(b0, b1)), min(float(z1), max(b0, b1))
        if a1 - a0 > 1e-4 and b1 + arise - b0 > 1e-4:
            z_top_box = min(float(z1), b1 + arise)
            ops.append((a0, a1, b0, b1, z_top_box, astyle, arise))
            u_cuts.update((round(a0, 6), round(a1, 6)))
            z_cuts.update((round(b0, 6), round(z_top_box, 6)))

    us = sorted(u_cuts)
    zs = sorted(z_cuts)
    th = float(thickness)

    for iu in range(len(us) - 1):
        ua, ub = us[iu], us[iu + 1]
        um = 0.5 * (ua + ub)
        for iz in range(len(zs) - 1):
            za, zb = zs[iz], zs[iz + 1]
            zm = 0.5 * (za + zb)
            in_hole = any(oa + 1e-6 < um < ob - 1e-6 and oza + 1e-6 < zm < ozt - 1e-6 for oa, ob, oza, _, ozt, _, _ in ops)
            if in_hole:
                continue
            pbm.add_box((um, th * 0.5, zm), (ub - ua, th, zb - za), frame_or_matrix=fr, mat=mat)

    for oa, ob, oza, ozs, ozt, astyle, arise in ops:
        ow = ob - oa
        oc = 0.5 * (oa + ob)
        if with_sills and oza > float(z0) + 0.004:
            pbm.add_box((oc, th * 0.35, oza - 0.002), (ow + 0.010, th * 1.15, 0.0045), frame_or_matrix=fr, mat="bright_trim")
        if astyle and arise > 1e-4:
            prof = arch_curve_profile(oc, ozs, ow * 0.5, rise=arise, style=astyle, n=14)
            for k in range(len(prof) - 1):
                u_l, z_l = prof[k]
                u_r, z_r = prof[k + 1]
                if ozt - min(z_l, z_r) > 1e-5:
                    f_pts = (fr.point(u_l, 0.0, z_l), fr.point(u_r, 0.0, z_r), fr.point(u_r, 0.0, ozt), fr.point(u_l, 0.0, ozt))
                    b_pts = (fr.point(u_r, th, z_r), fr.point(u_l, th, z_l), fr.point(u_l, th, ozt), fr.point(u_r, th, ozt))
                    s_pts = (fr.point(u_l, th, z_l), fr.point(u_r, th, z_r), fr.point(u_r, 0.0, z_r), fr.point(u_l, 0.0, z_l))
                    pbm.add_face(f_pts, mat=mat, flip=fr.flip_winding)
                    pbm.add_face(b_pts, mat=mat, flip=fr.flip_winding)
                    pbm.add_face(s_pts, mat="shadow_reveal", smooth=True, flip=fr.flip_winding)
                pbm.add_oriented_beam(fr.point(u_l, -0.002, z_l), fr.point(u_r, -0.002, z_r), 0.005, 0.005, mat="bright_trim")
        if with_recess_glass:
            pbm.add_box((oc, th * 0.68, 0.5 * (oza + ozs)), (ow * 0.96, 0.004, max(0.004, ozs - oza)), frame_or_matrix=fr, mat="dark_void")

    return pbm.finish() if auto_fin else pbm


def build_curved_arcade_wall(
    target,
    rx=0.42,
    ry=None,
    cx=0.0,
    cy=0.0,
    z0=0.0,
    tier_h=0.11,
    thickness=0.032,
    bays=24,
    start_u=0.0,
    end_u=1.0,
    arch_style="round",
    engaged_columns=True,
    role="BODY",
    mat="light_stone",
):
    """Build a circular or elliptical pierced multi-bay arcade tier (`rx, ry`) with piers, curved arch spandrels, soffits, engaged columns, and cornice.

    【视觉图像特征与等弧长曲面映射】：
    适用于罗马斗兽场椭圆外环、圆形围廊或半圆形回音廊。若建筑局部残缺（如斗兽场北侧外墙坍塌退台），只需传入部分弧长区间 `start_u=0.0, end_u=0.58`，即可精确生成保留完整端头断面的扇形弧段！
    内部在 `EllipticalFrame` 上把 `[start_u, end_u]` 等分为 `bays` 跨：每跨两端各留 `22%` 宽度的曲边实心承重墩（Pier），中间 `56%` 跨度按 `arch_curve_profile` 映射到三维等距椭圆面上生成镂空券洞与曲面拱腹，并在每座桥墩外侧附加凸出半圆柱（Engaged Column）与连续檐带。
    """
    pbm, auto_fin = ensure_part_bmesh(target, role=role, mat=mat)
    ef = EllipticalFrame(a=float(rx), b=float(ry if ry is not None else rx), cx=cx, cy=cy)
    nb = max(4, int(bays))
    u_span = float(end_u) - float(start_u)
    du_bay = u_span / nb
    th = float(thickness)
    zh = float(tier_h)
    z_sp = float(z0) + zh * 0.52
    z_ap = float(z0) + zh * 0.84

    for b in range(nb):
        ub0 = float(start_u) + b * du_bay
        ub1 = ub0 + du_bay
        pier_f = 0.22
        u_open0 = ub0 + du_bay * pier_f
        u_open1 = ub1 - du_bay * pier_f
        for pa, pb in ((ub0, u_open0), (u_open1, ub1)):
            f0, f1 = ef.point(pa, 0.0, float(z0)), ef.point(pb, 0.0, float(z0))
            f2, f3 = ef.point(pb, 0.0, float(z0) + zh), ef.point(pa, 0.0, float(z0) + zh)
            k0, k1 = ef.point(pa, th, float(z0)), ef.point(pb, th, float(z0))
            k2, k3 = ef.point(pb, th, float(z0) + zh), ef.point(pa, th, float(z0) + zh)
            pbm.add_quad(f0, f1, f2, f3, mat=mat)
            pbm.add_quad(k1, k0, k3, k2, mat=mat)
            pbm.add_quad(k0, f0, f3, k3, mat="shadow_reveal")
            pbm.add_quad(f1, k1, k2, f2, mat="shadow_reveal")
            pbm.add_quad(f3, f2, k2, k3, mat="bright_trim")
            pbm.add_quad(k0, k1, f1, f0, mat=mat)

        ns = 8
        prof = arch_curve_profile(0.5 * (u_open0 + u_open1), z_sp, 0.5 * (u_open1 - u_open0), rise=z_ap - z_sp, style=arch_style, n=ns)
        for s in range(ns):
            ua, za = prof[s]
            ub, zb = prof[s + 1]
            fa0, fb0 = ef.point(ua, 0.0, za), ef.point(ub, 0.0, zb)
            fa1, fb1 = ef.point(ua, 0.0, float(z0) + zh), ef.point(ub, 0.0, float(z0) + zh)
            ka0, kb0 = ef.point(ua, th, za), ef.point(ub, th, zb)
            ka1, kb1 = ef.point(ua, th, float(z0) + zh), ef.point(ub, th, float(z0) + zh)
            pbm.add_quad(fa0, fb0, fb1, fa1, mat=mat, smooth=True)
            pbm.add_quad(kb0, ka0, ka1, kb1, mat=mat, smooth=True)
            pbm.add_quad(ka0, kb0, fb0, fa0, mat="shadow_reveal", smooth=True)
            pbm.add_quad(fa1, fb1, kb1, ka1, mat="bright_trim")

        if engaged_columns:
            p_col0 = ef.point(ub0 + du_bay * pier_f * 0.5, -0.007, float(z0))
            p_col1 = ef.point(ub0 + du_bay * pier_f * 0.5, -0.007, float(z0) + zh * 0.92)
            pbm.add_oriented_beam(p_col0, p_col1, 0.011, 0.011, mat="bright_trim")

        c0, c1 = ef.point(ub0, -0.010, float(z0) + zh * 0.94), ef.point(ub1, -0.010, float(z0) + zh * 0.94)
        pbm.add_oriented_beam(c0, c1, th * 0.5, zh * 0.08, mat="bright_trim")

    return pbm.finish() if auto_fin else pbm


def build_curtain_and_louver_facade(
    target,
    frame=None,
    u0=-0.25,
    u1=0.25,
    z0=0.0,
    z1=0.22,
    cols=6,
    rows=3,
    mullion_w=0.005,
    mullion_d=0.012,
    louver_fins=0,
    fin_depth=0.022,
    role="BODY",
    mat="shadow_reveal",
):
    """Build a modern recessed glass curtain wall with orthogonal mullions/transoms and optional projecting vertical sun-shading louver fins.

    【现代建筑立面层次原理】：
    现代别墅与写字楼玻璃幕墙切忌做成一块平整白板！本算子通过三层进深 `d` 分离创造清晰光影：
    1. 后退暗腔玻璃层（`d = +0.85 * mullion_d`, `"dark_void"`）：模拟通透消光室内背景；
    2. 中层横竖金属龙骨网（`d = +0.35 * mullion_d`）：`cols + 1` 道竖梃与 `rows + 1` 道横梁正交交织；
    3. 前挑竖向百叶格栅（`d = -0.45 * fin_depth`, `"bright_trim"`）：高深宽比遮阳薄片向立面外侧悬挑，在斜射光下投出密集竖向条纹阴影。
    """
    pbm, auto_fin = ensure_part_bmesh(target, role=role, mat=mat)
    fr = frame if isinstance(frame, LocalFrame) else LocalFrame()
    span_u = float(u1) - float(u0)
    span_z = float(z1) - float(z0)
    um = 0.5 * (float(u0) + float(u1))
    zm = 0.5 * (float(z0) + float(z1))

    pbm.add_box((um, float(mullion_d) * 0.85, zm), (span_u, 0.005, span_z), frame_or_matrix=fr, mat="dark_void")
    nc = max(1, int(cols))
    nr = max(1, int(rows))
    for i in range(nc + 1):
        uc = float(u0) + span_u * (i / nc)
        pbm.add_box((uc, float(mullion_d) * 0.35, zm), (float(mullion_w), float(mullion_d), span_z), frame_or_matrix=fr, mat=mat)
    for j in range(nr + 1):
        zc = float(z0) + span_z * (j / nr)
        pbm.add_box((um, float(mullion_d) * 0.35, zc), (span_u, float(mullion_d), float(mullion_w)), frame_or_matrix=fr, mat=mat)

    if louver_fins and int(louver_fins) > 0:
        nf = int(louver_fins)
        for k in range(nf):
            uf = float(u0) + span_u * ((k + 0.5) / nf)
            pbm.add_box((uf, -float(fin_depth) * 0.45, zm), (float(mullion_w) * 0.75, float(fin_depth), span_z * 0.98), frame_or_matrix=fr, mat="bright_trim")

    return pbm.finish() if auto_fin else pbm


def run(arguments):
    return {
        "module": "lab_walls_arcades_and_facades",
        "operators": [
            "arch_curve_profile",
            "build_mitered_profile_ring",
            "build_perforated_wall",
            "build_curved_arcade_wall",
            "build_curtain_and_louver_facade",
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
