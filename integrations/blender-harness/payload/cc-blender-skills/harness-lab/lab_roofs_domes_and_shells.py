#!/usr/bin/env python3
"""Curved East Asian Roofs, Polygonal Cones, Corbelled Brick Eaves, Ribbed/Bulbous/Onion Domes & Spherical Sail Shells
(`lab_roofs_domes_and_shells.py`).

本模块封装五大类屋盖与薄壳曲面算子，每个函数文档详细阐明**图像视觉轮廓 <-> 参数曲面方程 <-> 流形封闭拓扑**的对应关系。
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
    from lab_bmesh_frame_and_clay import PartBMesh, ensure_part_bmesh


def build_chinese_curved_roof(
    target,
    cx=0.0,
    cy=0.0,
    hx=0.42,
    hy=0.28,
    z_eave=0.25,
    rise=0.14,
    style="xieshan",
    ridge_frac=0.62,
    gable_drop_frac=0.42,
    collar_only=False,
    corner_lift=0.018,
    thickness=0.010,
    tile_pitch=0.018,
    with_rafters=True,
    role="ROOF",
    mat="roof_clay",
):
    """Build a watertight East Asian curved roof (`style`: `'xieshan'` | `'hip'` | `'gable'` | `'pyramidal'` | `'cross_gable'`),
    or an open-centered lower waist-eave collar when `collar_only=True`.

    【视觉图像特征对应】：
    - `'xieshan'`（歇山顶）：立面与鸟瞰可见**九脊两折结构**——下半段四面斜坡飞檐爬升至半腰折肩线，东西两端向内收进露出三角形山花板与悬挑博风板，上半段前后两坡弧形瓦面继续爬升并严密合拢于水平正脊与两端卷尾鸱吻；
    - `'hip'`（庑殿顶）：四面弧形瓦坡无折肩，前后长坡与东西三角形端坡直接交汇于顶部水平正脊；
    - `'gable'`（悬山/硬山顶）：仅前后两面长坡在顶部正脊交汇，东西两端挑出博风板并封闭山墙三角；
    - `'pyramidal'`（四角攒尖顶）：四面弧坡向中心宝顶汇聚成一点；
    - `'cross_gable'`（十字歇山/十字脊顶）：纵横两座歇山/悬山屋顶正交穿插（常见于角楼、黄鹤楼抱厦）；
    - `collar_only=True`（重檐下层空心腰檐）：仅构建下段四面空心飞檐裙边，中央留洞供二层/三层墙柱穿过。

    【内部数学公式与两折连续闭合原理】：
    1. **举折反宇凹曲线**：设外檐至正脊的水平归一化进度为 $\tau \in [0, 1]$，屋面高程采用上陡下缓的二次抛物线：
       $$z_{\text{slope}}(\tau) = z_{\text{eave}} + \text{rise}\cdot(0.18\tau + 0.82\tau^2)$$
    2. **十次幂翼角局部起翘**：设沿檐边横向参数 $u \in [0, 1]$、坡面径向参数 $r \in [0, 1]$，四角起翘增量为：
       $$\Delta z_{\text{lift}}(u, r) = \text{corner\_lift}\cdot |2u - 1|^{10}\cdot(1 - r)^3$$
       在檐口中段 $u \in [0.2, 0.8]$ 处 $|2u-1|^{10} < 0.006$（檐线保持平直），仅在接近四角顶点 $u \to 0, 1$ 时急剧扬起，还原真实木构子角梁起翘！
    3. **歇山顶两折参数无缝衔接（彻底杜绝屋顶中央露天破洞）**：
       当 `style='xieshan'` 且 `collar_only=False` 时，设山花底半宽 $i_y = h_y \cdot \text{gable\_drop\_frac}$，正脊半长 $i_x = h_x \cdot \text{ridge\_frac}$，取折肩参数 $\tau_s = 1 - i_y / h_y$：
       - 下段四面坡（`side = 0..3`）映射 $\tau = r \cdot \tau_s \in [0, \tau_s]$，精确停在折肩矩形 $(\pm i_x, \pm i_y, z_{\text{slope}}(\tau_s))$；
       - 上段前后两坡封顶瓦面（`sgn_y = -1, +1`）从 $y = \pm i_y$ 映射 $\tau = \tau_s + (1 - \tau_s) s \in [\tau_s, 1]$ 直至 $y = c_y$ 正脊，高度与斜率在折肩处连续衔接，并在 $x = \pm i_x$ 处生成贴合弧坡的曲边三角形山花板、悬挑博风板、筒瓦垄与正脊鸱吻。
    """
    pbm, auto_fin = ensure_part_bmesh(target, role=role, mat=mat)
    st = str(style).lower().strip()
    cx_f, cy_f = float(cx), float(cy)
    hx_f, hy_f = max(0.02, float(hx)), max(0.02, float(hy))
    ze_f, rise_f = float(z_eave), max(0.005, float(rise))
    th_f = max(0.003, float(thickness))
    lift_f = float(corner_lift)

    if st in ("cross_gable", "cross_xieshan", "cross"):
        build_chinese_curved_roof(
            pbm, cx=cx_f, cy=cy_f, hx=hx_f, hy=hy_f * 0.62, z_eave=ze_f, rise=rise_f,
            style="xieshan", ridge_frac=0.72, gable_drop_frac=0.38, collar_only=False,
            corner_lift=lift_f, thickness=th_f, tile_pitch=tile_pitch, with_rafters=with_rafters,
        )
        t_bm = PartBMesh("_tmp_cross_wing", role=pbm.role_idx, mat=mat)
        t_bm._finished = True
        build_chinese_curved_roof(
            t_bm, cx=0.0, cy=0.0, hx=hy_f, hy=hx_f * 0.62, z_eave=ze_f, rise=rise_f,
            style="xieshan", ridge_frac=0.72, gable_drop_frac=0.38, collar_only=False,
            corner_lift=lift_f, thickness=th_f, tile_pitch=tile_pitch, with_rafters=with_rafters,
        )
        pbm.append_bmesh(
            t_bm.bm,
            matrix=Matrix.Translation((cx_f, cy_f, 0.0)) @ Matrix.Rotation(math.pi * 0.5, 4, "Z"),
            mat=mat,
        )
        t_bm.bm.free()
        return pbm.finish() if auto_fin else pbm

    def juzhe_z(tau):
        return ze_f + rise_f * (0.18 * tau + 0.82 * tau * tau)

    if collar_only:
        in_x = hx_f * float(ridge_frac)
        in_y = hy_f * max(0.25, float(gable_drop_frac))
        tau_s = 1.0
    elif st in ("hip", "wudian"):
        in_x = hx_f * float(ridge_frac)
        in_y = 0.002
        tau_s = 1.0
    elif st in ("pyramidal", "zanjian", "tent"):
        in_x = 0.002
        in_y = 0.002
        tau_s = 1.0
    elif st in ("gable", "xuanshan", "yingshan"):
        in_x = hx_f * 0.99
        in_y = 0.002
        tau_s = 1.0
    else:
        # Default 'xieshan': two-stage closed hip-and-gable roof!
        in_x = min(hx_f * 0.92, max(0.015, hx_f * float(ridge_frac)))
        in_y = min(hy_f * 0.82, max(0.015, hy_f * float(gable_drop_frac)))
        tau_s = max(0.28, min(0.86, 1.0 - in_y / hy_f))

    is_xieshan_cap = (not collar_only) and (in_x > 0.006) and (in_y > 0.006)
    nu, nr = 32, 16

    def lower_side_pt(side, u, r):
        s_val = -1.0 + 2.0 * u
        tau = r * tau_s
        zc = juzhe_z(tau) + lift_f * (abs(s_val) ** 10) * ((1.0 - r) ** 3)
        if side == 0:  # Front (-Y)
            return Vector((cx_f + ((1.0 - r) * hx_f + r * in_x) * s_val, cy_f - ((1.0 - r) * hy_f + r * in_y), zc))
        if side == 1:  # Back (+Y)
            return Vector((cx_f - ((1.0 - r) * hx_f + r * in_x) * s_val, cy_f + ((1.0 - r) * hy_f + r * in_y), zc))
        if side == 2:  # Left (-X)
            return Vector((cx_f - ((1.0 - r) * hx_f + r * in_x), cy_f - ((1.0 - r) * hy_f + r * in_y) * s_val, zc))
        return Vector((cx_f + ((1.0 - r) * hx_f + r * in_x), cy_f + ((1.0 - r) * hy_f + r * in_y) * s_val, zc))

    # 1. Build 4 lower curved slopes (front, back, left, right) + soffit + eave fascia + corner hip ridges
    sides_to_build = (0, 1) if st in ("gable", "xuanshan", "yingshan") else (0, 1, 2, 3)
    for side in sides_to_build:
        top_g, bot_g = [], []
        for i in range(nu + 1):
            u = i / nu
            ct, cb = [], []
            for j in range(nr + 1):
                p = lower_side_pt(side, u, j / nr)
                ct.append(p)
                cb.append(Vector((p.x, p.y, p.z - th_f)))
            top_g.append(ct)
            bot_g.append(cb)
        for i in range(nu):
            for j in range(nr):
                pbm.add_quad(top_g[i][j], top_g[i + 1][j], top_g[i + 1][j + 1], top_g[i][j + 1], mat=mat, smooth=True)
                pbm.add_quad(bot_g[i][j], bot_g[i][j + 1], bot_g[i + 1][j + 1], bot_g[i + 1][j], mat="shadow_reveal", smooth=True)
            pbm.add_quad(bot_g[i][0], bot_g[i + 1][0], top_g[i + 1][0], top_g[i][0], mat="bright_trim")

        if tile_pitch and float(tile_pitch) > 0.004:
            span_len = 2.0 * (hx_f if side < 2 else hy_f)
            n_rolls = max(8, int(span_len / float(tile_pitch)))
            for k in range(1, n_rolls):
                uk = k / n_rolls
                pts = [lower_side_pt(side, uk, j / nr) + Vector((0.0, 0.0, 0.0016)) for j in range(0, nr + 1, 4)]
                for s_i in range(len(pts) - 1):
                    pbm.add_oriented_beam(pts[s_i], pts[s_i + 1], float(tile_pitch) * 0.28, 0.0028, mat=mat)

        if with_rafters:
            span_len = 2.0 * (hx_f if side < 2 else hy_f)
            n_raf = max(8, int(span_len / 0.028))
            for k in range(1, n_raf):
                uk = k / n_raf
                p0 = lower_side_pt(side, uk, 0.0) - Vector((0.0, 0.0, th_f * 0.65))
                p1 = lower_side_pt(side, uk, 0.24) - Vector((0.0, 0.0, th_f * 0.85))
                pbm.add_oriented_beam(p0, p1, 0.0042, 0.0042, mat="light_stone")

    # 4 corner hip ridges (qiangji)
    if st not in ("gable", "xuanshan", "yingshan"):
        for side, u_corner in ((0, 0.0), (0, 1.0), (1, 0.0), (1, 1.0)):
            c_pts = [lower_side_pt(side, u_corner, j / 10.0) + Vector((0.0, 0.0, 0.003)) for j in range(11)]
            for j in range(10):
                pbm.add_oriented_beam(c_pts[j], c_pts[j + 1], 0.009, 0.010, mat="bright_trim")

    # 2. Close upper two-slope curved Xieshan cap + shanhua triangular gables + bofeng bargeboards!
    if is_xieshan_cap:
        barge_x = min(hx_f * 0.98, in_x + max(0.008, th_f * 1.4))
        nx_u, ny_u = 28, 12
        for sgn_y in (-1.0, 1.0):
            ug_t, ug_b = [], []
            for i in range(nx_u + 1):
                px = cx_f + (-1.0 + 2.0 * i / nx_u) * barge_x
                ct, cb = [], []
                for j in range(ny_u + 1):
                    s_up = j / ny_u
                    tau = tau_s + (1.0 - tau_s) * s_up
                    py = cy_f + sgn_y * in_y * (1.0 - s_up)
                    pz = juzhe_z(tau)
                    ct.append(Vector((px, py, pz)))
                    cb.append(Vector((px, py, pz - th_f * 0.85)))
                ug_t.append(ct)
                ug_b.append(cb)
            flip_u = sgn_y > 0.0
            for i in range(nx_u):
                for j in range(ny_u):
                    pbm.add_quad(ug_t[i][j], ug_t[i + 1][j], ug_t[i + 1][j + 1], ug_t[i][j + 1], mat=mat, smooth=True, flip=flip_u)
                    pbm.add_quad(ug_b[i][j], ug_b[i][j + 1], ug_b[i + 1][j + 1], ug_b[i + 1][j], mat="shadow_reveal", smooth=True, flip=flip_u)
            if tile_pitch and float(tile_pitch) > 0.004:
                n_ur = max(8, int(2.0 * barge_x / float(tile_pitch)))
                for k in range(1, n_ur):
                    px = cx_f + (-1.0 + 2.0 * k / n_ur) * barge_x
                    pts = [
                        Vector((px, cy_f + sgn_y * in_y * (1.0 - s_k / 3.0), juzhe_z(tau_s + (1.0 - tau_s) * (s_k / 3.0)) + 0.0018))
                        for s_k in range(4)
                    ]
                    for s_i in range(3):
                        pbm.add_oriented_beam(pts[s_i], pts[s_i + 1], float(tile_pitch) * 0.28, 0.0028, mat=mat)

            # Bofeng bargeboards at both +/-barge_x ends
            for sgn_x in (-1.0, 1.0):
                b_pts = [
                    Vector((cx_f + sgn_x * barge_x, cy_f + sgn_y * in_y * (1.0 - j / 8.0), juzhe_z(tau_s + (1.0 - tau_s) * (j / 8.0)) - th_f * 0.25))
                    for j in range(9)
                ]
                for j in range(8):
                    pbm.add_oriented_beam(b_pts[j], b_pts[j + 1], 0.008, th_f * 1.6, mat="bright_trim")

        # Recessed shanhua triangular gables at BOTH -X and +X!
        z_sh = juzhe_z(tau_s) - th_f * 0.75
        gw = max(0.006, th_f * 0.9)
        for sgn_x in (-1.0, 1.0):
            gx_out = cx_f + sgn_x * in_x
            gx_in = gx_out - sgn_x * gw
            prof_yz = [(cy_f - in_y, z_sh)]
            for k in range(9):
                u_g = -1.0 + 2.0 * k / 8.0
                s_up = 1.0 - abs(u_g)
                prof_yz.append((cy_f + u_g * in_y, juzhe_z(tau_s + (1.0 - tau_s) * s_up) - th_f * 0.25))
            prof_yz.append((cy_f + in_y, z_sh))
            r_out = [Vector((gx_out, yv, zv)) for yv, zv in prof_yz]
            r_in = [Vector((gx_in, yv, zv)) for yv, zv in prof_yz]
            if sgn_x < 0.0:
                r_out, r_in = list(reversed(r_out)), list(reversed(r_in))
            pbm.add_lofted_rings([r_in, r_out], cap_bottom=True, cap_top=True, smooth_sides=False, mat="shadow_reveal")

    elif st in ("gable", "xuanshan", "yingshan") and not collar_only:
        # Close vertical triangular end walls under pure two-slope gable roof
        for sgn_x in (-1.0, 1.0):
            gx_out = cx_f + sgn_x * in_x * 0.96
            gx_in = gx_out - sgn_x * max(0.006, th_f)
            prof_yz = [(cy_f - hy_f, ze_f - th_f * 0.5)]
            for k in range(9):
                u_g = -1.0 + 2.0 * k / 8.0
                tau = 1.0 - abs(u_g)
                prof_yz.append((cy_f + u_g * hy_f, juzhe_z(tau) - th_f * 0.2))
            prof_yz.append((cy_f + hy_f, ze_f - th_f * 0.5))
            r_out = [Vector((gx_out, yv, zv)) for yv, zv in prof_yz]
            r_in = [Vector((gx_in, yv, zv)) for yv, zv in prof_yz]
            if sgn_x < 0.0:
                r_out, r_in = list(reversed(r_out)), list(reversed(r_in))
            pbm.add_lofted_rings([r_in, r_out], cap_bottom=True, cap_top=True, smooth_sides=False, mat="light_stone")

    # 3. Main ridge beam & chiwen / central pyramidal finial (only when not a hollow lower waist eave!)
    if not collar_only:
        z_ridge = ze_f + rise_f
        if st in ("pyramidal", "zanjian", "tent"):
            pbm.add_box((cx_f, cy_f, z_ridge + 0.012), (0.018, 0.018, 0.026), mat="bright_trim", bevel_top=0.005)
        else:
            pbm.add_oriented_beam((cx_f - in_x, cy_f, z_ridge + 0.004), (cx_f + in_x, cy_f, z_ridge + 0.004), 0.014, 0.016, mat="bright_trim")
            for sgn_x in (-1.0, 1.0):
                pbm.add_box((cx_f + sgn_x * in_x, cy_f, z_ridge + 0.013), (0.014, 0.012, 0.022), mat="bright_trim", bevel_top=0.003)

    return pbm.finish() if auto_fin else pbm


def build_polygonal_conical_roof(
    target,
    cx=0.0,
    cy=0.0,
    r_eave=0.32,
    r_top=0.01,
    z_eave=0.22,
    rise=0.18,
    sides=8,
    sag=0.25,
    corner_lift=0.012,
    style="pagoda_curved",
    corbel_steps=0,
    with_finial=False,
    role="ROOF",
    mat="roof_clay",
):
    """Build an N-sided polygonal (octagonal/hexagonal/square) or circular conical roof with optional pagoda finial (`刹`).

    【视觉图像特征对应】：
    - `'pagoda_curved'`（多角木塔/攒尖亭檐）：正 $N$ 边形（$N=4,6,8$）飞檐，每道角梁向外放射，坡面内凹，棱角微微上翘；
    - `'conical_hall'`（圆攒尖大殿顶，如祈年殿三重圆檐，$N \ge 32$）：光滑无棱线的内凹圆锥曲面瓦顶；
    - `'corbelled_trullo'`（干垒石阶梯圆锥顶）：无砂浆石板逐层内收形成水平同心阶梯纹理的陡峭圆锥屋顶。

    【内部数学公式】：
    设径向层参数 $v \in [0, 1]$，周向顶点角 $\theta_i = -\frac{\pi}{2} + \frac{\pi}{N} + \frac{2\pi i}{N}$（使第 0 条底边严格平行于正视图 $X$ 轴！）：
    - 曲面半径：$r(v) = (1 - v_r) R_{\text{eave}} + v_r R_{\text{top}}$，其中阶梯石锥取阶跃量化 $v_r = \lfloor v K \rfloor / K$；
    - 反宇高度：$z(v) = z_{\text{eave}} + \text{rise}\cdot v^{1 + \text{sag}} + \text{corner\_lift}\cdot(1 - v)^{1.8}$。
    """
    pbm, auto_fin = ensure_part_bmesh(target, role=role, mat=mat)
    n = max(4, int(sides))
    st = str(style).lower()
    steps_v = max(14, int(corbel_steps) * 2 if corbel_steps > 0 else 16)
    rings = []
    for j in range(steps_v + 1):
        v = j / steps_v
        if st == "corbelled_trullo" and corbel_steps > 0:
            v_r = math.floor(v * corbel_steps) / max(1, corbel_steps)
        else:
            v_r = v
        r = float(r_eave) * (1.0 - v_r) + max(0.002, float(r_top)) * v_r
        z_base = float(z_eave) + float(rise) * (v ** (1.0 + float(sag)))
        ring = []
        for i in range(n):
            ang = -math.pi * 0.5 + (math.pi / n) + 2.0 * math.pi * i / n
            lift = float(corner_lift) * ((1.0 - v) ** 1.8) if n <= 12 else 0.0
            ring.append(Vector((float(cx) + r * math.cos(ang), float(cy) + r * math.sin(ang), z_base + lift)))
        rings.append(ring)
    pbm.add_lofted_rings(rings, cap_bottom=True, cap_top=True, smooth_sides=(n >= 20), mat=mat)

    if n <= 16 and st != "corbelled_trullo":
        for i in range(n):
            pbm.add_oriented_beam(rings[0][i], rings[-1][i], 0.007, 0.008, mat="bright_trim")

    if with_finial:
        z_top = float(z_eave) + float(rise)
        fin_rings = []
        for rf, zf in ((0.022, 0.0), (0.028, 0.015), (0.014, 0.032), (0.020, 0.048), (0.006, 0.085), (0.002, 0.115)):
            s_f = rf * (float(r_eave) / 0.30)
            h_f = z_top + zf * (float(rise) / 0.18)
            fin_rings.append([Vector((float(cx) + s_f * math.cos(2 * math.pi * m / 16), float(cy) + s_f * math.sin(2 * math.pi * m / 16), h_f)) for m in range(16)])
        pbm.add_lofted_rings(fin_rings, cap_bottom=True, cap_top=True, smooth_sides=True, mat="bright_trim")

    return pbm.finish() if auto_fin else pbm


def build_corbel_eave_band(
    target,
    cx=0.0,
    cy=0.0,
    apothem_in=0.22,
    overhang=0.045,
    z0=0.20,
    height=0.042,
    sides=4,
    tiers=5,
    with_dentils=True,
    role="ROOF",
    mat="light_stone",
):
    """Build a multi-course cantilevered brick pagoda corbel eave (`叠涩挑檐`) with dentil brick frieze and pitched drip cap.

    【视觉特征与几何原理】：
    唐宋砖石密檐塔与楼阁式方塔（如大雁塔、大理崇圣寺三塔）每层檐口由 $T$ 皮青砖逐层向外悬挑（下窄上宽），底部常砌一排菱角牙子锯齿砖（Dentils），顶部覆短促滴水斜坡。
    设正 $N$ 边形内切圆心距（Apothem）为 $a_{\text{in}}$，第 $t$ 皮砖心距按幂律 $a_t = a_{\text{in}} + \text{overhang}\cdot(t/T)^{0.85}$ 递增，外接圆顶点半径换算为 $R_t = a_t / \cos(\pi/N)$，从而保证正立面测得的每层挑出宽度与输入 `apothem_in + overhang` 完全一致！
    """
    pbm, auto_fin = ensure_part_bmesh(target, role=role, mat=mat)
    n = max(4, int(sides))
    n_t = max(3, int(tiers))
    dh = float(height) * 0.72 / n_t
    cos_half = math.cos(math.pi / n)
    for t in range(n_t):
        frac = (t + 1) / n_t
        ap = float(apothem_in) + float(overhang) * (frac ** 0.85)
        cr = ap / cos_half
        za = float(z0) + t * dh
        zb = za + dh * 0.96
        r_lo = [Vector((float(cx) + cr * math.cos(-math.pi * 0.5 + math.pi / n + 2 * math.pi * i / n),
                        float(cy) + cr * math.sin(-math.pi * 0.5 + math.pi / n + 2 * math.pi * i / n), za)) for i in range(n)]
        r_hi = [Vector((p.x, p.y, zb)) for p in r_lo]
        pbm.add_lofted_rings([r_lo, r_hi], cap_bottom=True, cap_top=True, smooth_sides=False, mat=mat)

    z_cap0 = float(z0) + float(height) * 0.72
    cr_out = (float(apothem_in) + float(overhang) * 1.04) / cos_half
    cr_in = (float(apothem_in) * 0.96) / cos_half
    r0 = [Vector((float(cx) + cr_out * math.cos(-math.pi * 0.5 + math.pi / n + 2 * math.pi * i / n),
                  float(cy) + cr_out * math.sin(-math.pi * 0.5 + math.pi / n + 2 * math.pi * i / n), z_cap0)) for i in range(n)]
    r1 = [Vector((float(cx) + cr_in * math.cos(-math.pi * 0.5 + math.pi / n + 2 * math.pi * i / n),
                  float(cy) + cr_in * math.sin(-math.pi * 0.5 + math.pi / n + 2 * math.pi * i / n), float(z0) + float(height))) for i in range(n)]
    pbm.add_lofted_rings([r0, r1], cap_bottom=True, cap_top=True, smooth_sides=False, mat="roof_clay")

    if with_dentils:
        for i in range(n):
            p_a, p_b = r0[i], r0[(i + 1) % n]
            edge_len = (p_b - p_a).length
            nd = max(4, int(edge_len / 0.018))
            for k in range(nd):
                pt = p_a.lerp(p_b, (k + 0.5) / nd)
                pbm.add_box((pt.x * 0.96 + float(cx) * 0.04, pt.y * 0.96 + float(cy) * 0.04, float(z0) - dh * 0.45), (0.007, 0.007, dh * 0.8), mat="bright_trim")
    return pbm.finish() if auto_fin else pbm


def build_ribbed_dome_and_drum(
    target,
    cx=0.0,
    cy=0.0,
    radius=0.14,
    z_drum_base=0.30,
    drum_h=0.10,
    dome_h=0.18,
    profile="bulbous_persian",
    sides=32,
    ribs=16,
    spiral_twist_deg=0.0,
    drum_windows=12,
    finial_h=0.05,
    role="ROOF",
    mat="roof_clay",
):
    """Build a fenestrated drum (`鼓座`) + revolved dome (`'hemispherical'` | `'pointed'` | `'bulbous_persian'` | `'onion_russian'` | `'conical_tent'`) + meridian/helical ribs + finial spire.

    【视觉轮廓与旋转母线方程对应】（高度参数 $t \in [0, 1]$）：
    1. `'hemispherical'`（古典/拜占庭半球穹顶）：$r(t) = R\cos(\frac{\pi}{2}t),\; z(t) = z_0 + H\sin(\frac{\pi}{2}t)$；
    2. `'pointed'`（文艺复兴/哥特尖拱穹顶）：$r(t) = R(1 - t^{1.45})$，以有限切线斜率收结于顶尖；
    3. `'bulbous_persian'`（波斯球根形双壳大穹顶）：$r(t) = R\bigl(1 + 0.16\sin(1.45\pi t)\bigr)\cos^{0.78}(\frac{\pi}{2}t)$，腰部微鼓超过下方鼓座半径；
    4. `'onion_russian'`（俄罗斯洋葱头穹顶）：$r(t) = R\bigl(1 + 0.28\sin(1.35\pi t)\bigr)(1-t)^{0.68}$，下部强烈鼓肚、上部S形反曲收成细尖；当设置 `spiral_twist_deg != 0`（如 `90.0`）时，每层环叠加方位扭角 $\Delta\theta(t) = \omega t$，经线凸肋随之化为立体螺旋麻花彩瓣；
    5. `'conical_tent'`（八角/多角帐篷尖顶 Shatyor）：$r(t) = R(1 - t)$ 线性陡坡锥体。
    """
    pbm, auto_fin = ensure_part_bmesh(target, role=role, mat=mat)
    ns = max(8, int(sides))
    r_d = float(radius) * 0.92
    z_dome0 = float(z_drum_base) + max(0.0, float(drum_h))

    if float(drum_h) > 1e-4:
        d_rings = [
            [Vector((float(cx) + r_d * math.cos(2 * math.pi * i / ns), float(cy) + r_d * math.sin(2 * math.pi * i / ns), float(z_drum_base))) for i in range(ns)],
            [Vector((float(cx) + r_d * math.cos(2 * math.pi * i / ns), float(cy) + r_d * math.sin(2 * math.pi * i / ns), z_dome0)) for i in range(ns)],
        ]
        pbm.add_lofted_rings(d_rings, cap_bottom=True, cap_top=True, smooth_sides=(ns >= 16), mat="light_stone")
        if drum_windows and int(drum_windows) > 0:
            nw = int(drum_windows)
            for k in range(nw):
                ang = 2.0 * math.pi * k / nw
                wx = float(cx) + (r_d + 0.001) * math.cos(ang)
                wy = float(cy) + (r_d + 0.001) * math.sin(ang)
                rot = Matrix.Rotation(ang + math.pi * 0.5, 4, "Z")
                pbm.add_box((0.0, 0.0, 0.0), (r_d * 1.4 / nw, 0.008, float(drum_h) * 0.56),
                            frame_or_matrix=Matrix.Translation((wx, wy, float(z_drum_base) + float(drum_h) * 0.5)) @ rot, mat="dark_void")

    pr = str(profile).lower()
    nv = 22
    dome_rings = []
    prof_rz = []
    for j in range(nv + 1):
        t = j / nv
        if pr == "onion_russian":
            swell = 1.0 + 0.28 * math.sin(math.pi * min(1.0, t * 1.35))
            r_cur = float(radius) * swell * ((1.0 - t) ** 0.68) if t < 0.999 else 0.002
            z_cur = z_dome0 + float(dome_h) * (t ** 0.86)
        elif pr == "bulbous_persian":
            swell = 1.0 + 0.16 * math.sin(math.pi * min(1.0, t * 1.45))
            r_cur = float(radius) * swell * math.cos(t * math.pi * 0.5) ** 0.78 if t < 0.999 else 0.002
            z_cur = z_dome0 + float(dome_h) * (t ** 0.92)
        elif pr == "conical_tent":
            r_cur = max(0.002, float(radius) * (1.0 - t))
            z_cur = z_dome0 + float(dome_h) * t
        elif pr == "pointed":
            r_cur = max(0.002, float(radius) * (1.0 - t ** 1.45))
            z_cur = z_dome0 + float(dome_h) * math.sin(t * math.pi * 0.5)
        else:
            r_cur = max(0.002, float(radius) * math.cos(t * math.pi * 0.5))
            z_cur = z_dome0 + float(dome_h) * math.sin(t * math.pi * 0.5)
        prof_rz.append((r_cur, z_cur))
        tw = math.radians(float(spiral_twist_deg) * t)
        dome_rings.append([
            Vector((float(cx) + r_cur * math.cos(2 * math.pi * i / ns + tw),
                    float(cy) + r_cur * math.sin(2 * math.pi * i / ns + tw), z_cur))
            for i in range(ns)
        ])
    pbm.add_lofted_rings(dome_rings, cap_bottom=True, cap_top=True, smooth_sides=(pr != "conical_tent"), mat=mat)

    if ribs and int(ribs) > 0:
        nr = int(ribs)
        for k in range(nr):
            b_ang = 2.0 * math.pi * k / nr
            pts = []
            for j, (rc, zc) in enumerate(prof_rz):
                ang = b_ang + math.radians(float(spiral_twist_deg) * (j / nv))
                pts.append((float(cx) + (rc + 0.002) * math.cos(ang), float(cy) + (rc + 0.002) * math.sin(ang), zc))
            for s_i in range(len(pts) - 1):
                pbm.add_oriented_beam(pts[s_i], pts[s_i + 1], 0.004, 0.005, mat="bright_trim")

    if finial_h and float(finial_h) > 0.0:
        zt = z_dome0 + float(dome_h)
        pbm.add_oriented_beam((float(cx), float(cy), zt - 0.005), (float(cx), float(cy), zt + float(finial_h)), 0.005, 0.005, mat="bright_trim")
        pbm.add_box((float(cx), float(cy), zt + float(finial_h) * 0.35), (0.016, 0.016, 0.016), mat="bright_trim", bevel_top=0.004)
    return pbm.finish() if auto_fin else pbm


def build_spherical_sail_shell(
    target,
    base_center=(0.0, 0.0, 0.12),
    yaw_deg=0.0,
    mouth_span=0.26,
    length=0.30,
    apex_h=0.28,
    thickness=0.010,
    n_ribs=14,
    with_glass_mouth=True,
    role="ROOF",
    mat="bright_trim",
):
    """Build a pointed precast ribbed spherical-section sail shell vault with ridge spine and radial fan glass curtain wall.

    【视觉图像特征与双参数球面切片原理】：
    图像中表现力极强的白色帆形薄壳（如歌剧院壳群）由后方基座支点向前上方倾斜张开成巨大的尖拱壳口，表面布满放射状肋棱，壳口内嵌扇形内倾玻璃幕墙。
    内部用双参数 $(u, v) \in [0, 1]^2$ 定义两侧对称壳瓣（`side = -1, +1`）：
    - $u \in [0, 1]$ 沿脊线从后支点推进到前张口，脊高 $z_{\text{ridge}}(u) = H_{\text{apex}} u^{0.62}$，半跨度 $w(u) = \frac{1}{2}W_{\text{mouth}} u^{0.78}$；
    - $v \in [0, 1]$ 从底部基座沿球面圆弧升至中央尖脊：$x(u,v) = \pm w(u)\cos(\frac{\pi}{2}v),\; z(u,v) = z_{\text{ridge}}(u)\sin^{0.82}(\frac{\pi}{2}v)$；
    - 沿每条等 $u_i$ 弧线排布放射状预制肋梁，并在壳口下方用直纹扇形网格连接拱缘与地面基线生成玻璃幕墙。
    """
    pbm, auto_fin = ensure_part_bmesh(target, role=role, mat=mat)
    bx, by, bz = float(base_center[0]), float(base_center[1]), float(base_center[2])
    rot = Matrix.Translation((bx, by, bz)) @ Matrix.Rotation(math.radians(float(yaw_deg)), 4, "Z")

    nu, nv = max(10, int(n_ribs)), 16
    for side in (-1.0, 1.0):
        outer, inner = [], []
        for i in range(nu + 1):
            u = i / nu
            y_l = -float(length) * 0.45 + float(length) * u
            z_ridge = float(apex_h) * (u ** 0.62)
            w_half = float(mouth_span) * 0.5 * (u ** 0.78)
            col_o, col_i = [], []
            for j in range(nv + 1):
                v = j / nv
                x_l = side * w_half * math.cos(v * math.pi * 0.5)
                z_l = z_ridge * math.sin(v * math.pi * 0.5) ** 0.82
                p_out = rot @ Vector((x_l, y_l, z_l))
                p_in = rot @ Vector((x_l * 0.94, y_l - 0.004, max(0.0, z_l - float(thickness))))
                col_o.append(p_out)
                col_i.append(p_in)
            outer.append(col_o)
            inner.append(col_i)
        flip = side < 0.0
        for i in range(nu):
            for j in range(nv):
                pbm.add_quad(outer[i][j], outer[i + 1][j], outer[i + 1][j + 1], outer[i][j + 1], mat=mat, smooth=True, flip=flip)
                pbm.add_quad(inner[i][j], inner[i][j + 1], inner[i + 1][j + 1], inner[i + 1][j], mat="shadow_reveal", smooth=True, flip=flip)
        for j in range(nv):
            pbm.add_quad(inner[nu][j], outer[nu][j], outer[nu][j + 1], inner[nu][j + 1], mat=mat, flip=flip)
        for i in range(0, nu + 1):
            for j in range(nv):
                pbm.add_oriented_beam(outer[i][j], outer[i][j + 1], 0.0035, 0.004, mat="light_stone")

    if with_glass_mouth:
        y_m = float(length) * 0.52
        n_mull = 10
        for k in range(-n_mull // 2, n_mull // 2 + 1):
            frac = k / max(1, n_mull // 2)
            x_m = frac * float(mouth_span) * 0.46
            z_top = float(apex_h) * 0.92 * max(0.08, 1.0 - abs(frac) ** 1.35)
            p0 = rot @ Vector((x_m, y_m * 0.85, 0.0))
            p1 = rot @ Vector((x_m * 0.35, y_m, z_top))
            pbm.add_oriented_beam(p0, p1, 0.0032, 0.0045, mat="shadow_reveal")
            if k < n_mull // 2:
                frac2 = (k + 1) / max(1, n_mull // 2)
                x_m2 = frac2 * float(mouth_span) * 0.46
                z_top2 = float(apex_h) * 0.92 * max(0.08, 1.0 - abs(frac2) ** 1.35)
                q0 = rot @ Vector((x_m2, y_m * 0.85, 0.0))
                q1 = rot @ Vector((x_m2 * 0.35, y_m, z_top2))
                pbm.add_quad(p0, q0, q1, p1, mat="dark_void", smooth=False)
    return pbm.finish() if auto_fin else pbm


def run(arguments):
    return {
        "module": "lab_roofs_domes_and_shells",
        "operators": [
            "build_chinese_curved_roof",
            "build_polygonal_conical_roof",
            "build_corbel_eave_band",
            "build_ribbed_dome_and_drum",
            "build_spherical_sail_shell",
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
