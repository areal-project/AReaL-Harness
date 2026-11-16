#!/usr/bin/env python3
"""Classical Entasis Fluted Columns, Entablatures & Pediments, 3D Dougong Bracket Sets, Gothic Portals/Roses & Persian Pishtaq Iwans
(`lab_columns_brackets_and_portals.py`).

本模块提供东西方建筑立面最核心的支撑柱式、挑檐斗拱与礼仪入口算子，所有文档均包含**视觉特征 <-> 内部数学公式 <-> 网格拓扑**对照。
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


def build_classical_fluted_column(
    target,
    cx=0.0,
    cy=0.0,
    z0=0.0,
    z1=0.22,
    r_bottom=0.016,
    r_top=None,
    order="doric",
    flutes=20,
    entasis=0.025,
    role="SUPPORTS",
    mat="light_stone",
):
    """Build an entasis-curved classical stone column or East Asian timber pillar
    (`order`: `'doric'` | `'corinthian'` | `'ionic'` | `'tuscan'` | `'chinese_timber'`).

    【视觉图像特征对应】：
    - `'doric'`（古希腊多立克柱）：**无柱础**直接立于台基顶面，柱身粗壮微收且腰部饱满，周圈 20 道竖向凹槽以锋利尖棱（Arris）相交，顶部承圆盘海胆垫（Echinus）与方形顶板（Abacus）；
    - `'corinthian'` / `'ionic'`：带方形柱础（Plinth），柱身细高配 24 道竖槽，柱头呈钟形外扩花篮承托方板；
    - `'chinese_timber'`（中式圆木柱）：光洁圆柱（柱顶微收“卷杀” `r_top = 0.96 * r_bottom`），立于鼓形/方形柱础石上。

    【内部数学公式（卷杀包络 + 正弦极坐标凹槽调制）】：
    设柱身归一化高度 $t = (z - z_{\text{shaft0}})/(z_{\text{shaft1}} - z_{\text{shaft0}}) \in [0, 1]$，周向角 $\theta \in [0, 2\pi)$，单槽周期内的归一化相位 $\phi = \frac{\theta \bmod (2\pi/N_f)}{2\pi/N_f} \in [0, 1]$：
    $$R_{\text{entasis}}(t) = (1 - t)R_{\text{bot}} + t R_{\text{top}} + \text{entasis}\cdot R_{\text{bot}}\sin(\pi t)$$
    $$r(\theta, t) = R_{\text{entasis}}(t)\cdot\bigl(1 - d_{\text{flute}}\sin(\pi\phi)\bigr)$$
    每道凹槽细分 4 段（整圈 $4 N_f$ 顶点）：槽谷内相邻面夹角 $< 25^\circ$ 自动平滑，而两槽交界棱处 $\phi = 0, 1$ 左右切线突变产生 $> 45^\circ$ 二面角，自动保留锋利亮棱！
    """
    pbm, auto_fin = ensure_part_bmesh(target, role=role, mat=mat)
    ord_s = str(order).lower()
    h = max(0.01, float(z1) - float(z0))
    rb = float(r_bottom)
    rt = float(r_top) if r_top is not None else rb * (0.96 if ord_s == "chinese_timber" else 0.82)

    z_shaft0 = float(z0)
    z_shaft1 = float(z1)
    if ord_s != "doric":
        bh = min(h * 0.09, rb * 1.1)
        pbm.add_box((cx, cy, float(z0) + bh * 0.35), (rb * 2.5, rb * 2.5, bh * 0.7), mat="bright_trim")
        z_shaft0 += bh

    cap_h = min(h * (0.14 if ord_s == "corinthian" else 0.09), rb * 1.8)
    if ord_s != "chinese_timber":
        z_shaft1 -= cap_h

    nf = 0 if ord_s in ("tuscan", "chinese_timber") else max(12, int(flutes))
    sub = 4 if nf > 0 else 1
    n_pts = nf * sub if nf > 0 else 24
    rings = []
    nz = 10
    for k in range(nz + 1):
        t = k / nz
        z = z_shaft0 + (z_shaft1 - z_shaft0) * t
        r_nom = rb * (1.0 - t) + rt * t + rb * float(entasis) * math.sin(math.pi * t)
        ring = []
        for i in range(n_pts):
            ang = 2.0 * math.pi * i / n_pts
            if nf > 0:
                u_fl = (i % sub) / sub
                conc = math.sin(math.pi * u_fl)
                depth = 0.125 if ord_s == "doric" else 0.095
                rr = r_nom * (1.0 - depth * conc)
            else:
                rr = r_nom
            ring.append(Vector((float(cx) + rr * math.cos(ang), float(cy) + rr * math.sin(ang), z)))
        rings.append(ring)
    pbm.add_lofted_rings(rings, cap_bottom=True, cap_top=True, smooth_sides=True, mat=mat)

    if ord_s != "chinese_timber":
        bell_rings = []
        for rf, zf in ((1.0, 0.0), (1.18, 0.45), (1.38, 0.72)):
            bell_rings.append([
                Vector((float(cx) + rt * rf * math.cos(2 * math.pi * m / 20), float(cy) + rt * rf * math.sin(2 * math.pi * m / 20), z_shaft1 + cap_h * zf))
                for m in range(20)
            ])
        pbm.add_lofted_rings(bell_rings, cap_bottom=True, cap_top=True, smooth_sides=True, mat="bright_trim")
        pbm.add_box((cx, cy, z_shaft1 + cap_h * 0.86), (rt * 2.85, rt * 2.85, cap_h * 0.28), mat="bright_trim")
    return pbm.finish() if auto_fin else pbm


def build_entablature_and_pediment(
    target,
    frame=None,
    span_u=0.60,
    depth_d=0.06,
    z0=0.22,
    entab_h=0.055,
    pediment="triangular",
    ped_rise=0.09,
    triglyphs=11,
    role="BODY",
    mat="light_stone",
):
    """Build a three-tier classical entablature (architrave + triglyph frieze + projecting cornice) + pediment
    (`pediment`: `'none'` | `'triangular'` | `'broken'` | `'segmental'` | `'kokoshnik'`).

    【视觉图像特征与山花轮廓方程】：
    柱列上方水平横跨三层线脚（下层额枋 Architrave、中层微退嵌等距竖块的三陇板檐壁 Frieze、上层深挑檐口 Cornice），其上承托立面山花。
    设横向归一化坐标 $s = 2t - 1 \in [-1, 1]$（$t \in [0, 1]$）：
    - `'triangular'`（古典三角山花）：$h(s) = H_p(1 - |s|)$，内嵌微退阴影鼓面（Tympanum）与外挑斜檐梁；
    - `'broken'`（巴洛克/佩特拉断山花）：在中央区间 $t \in [0.36, 0.64]$ 截断缺失，供中央圆亭或雕像穿出；
    - `'segmental'`（圆弧山花）：$h(s) = H_p\sqrt{1 - s^2}$；
    - `'kokoshnik'`（俄式火焰鸡冠拱山花）：$h(s) = H_p(1 - |s|^{1.6})^{0.62}$。
    """
    pbm, auto_fin = ensure_part_bmesh(target, role=role, mat=mat)
    fr = frame if isinstance(frame, LocalFrame) else LocalFrame()
    hw = float(span_u) * 0.5
    dp = float(depth_d)
    eh = float(entab_h)

    pbm.add_box((0.0, dp * 0.5, float(z0) + eh * 0.16), (float(span_u), dp, eh * 0.32), frame_or_matrix=fr, mat=mat)
    pbm.add_box((0.0, dp * 0.52, float(z0) + eh * 0.52), (float(span_u) * 0.99, dp * 0.94, eh * 0.38), frame_or_matrix=fr, mat="main_clay")
    pbm.add_box((0.0, dp * 0.42, float(z0) + eh * 0.86), (float(span_u) * 1.05, dp * 1.18, eh * 0.28), frame_or_matrix=fr, mat="bright_trim")

    if triglyphs and int(triglyphs) > 0:
        nt = int(triglyphs)
        tw = float(span_u) / max(4, nt * 2.2)
        for k in range(nt):
            u = -hw + tw * 0.6 + (float(span_u) - tw * 1.2) * (k / max(1, nt - 1))
            pbm.add_box((u, -0.002, float(z0) + eh * 0.52), (tw, 0.006, eh * 0.36), frame_or_matrix=fr, mat="bright_trim")

    ped = str(pediment).lower()
    zp0 = float(z0) + eh
    pr = float(ped_rise)
    if ped != "none" and pr > 1e-4:
        ns = 20
        for i in range(ns):
            t0, t1 = i / ns, (i + 1) / ns
            u0, u1 = -hw + float(span_u) * t0, -hw + float(span_u) * t1
            if ped == "broken" and 0.36 <= 0.5 * (t0 + t1) <= 0.64:
                continue

            def h_fn(t):
                au = abs(-1.0 + 2.0 * t)
                if ped in ("triangular", "broken"):
                    return pr * (1.0 - au)
                if ped == "kokoshnik":
                    return pr * ((1.0 - au ** 1.6) ** 0.62)
                return pr * math.sqrt(max(0.0, 1.0 - (-1.0 + 2.0 * t) ** 2))

            h0, h1 = h_fn(t0), h_fn(t1)
            f0, f1 = fr.point(u0, 0.008, zp0), fr.point(u1, 0.008, zp0)
            f2, f3 = fr.point(u1, 0.008, zp0 + h1), fr.point(u0, 0.008, zp0 + h0)
            b0, b1 = fr.point(u0, dp, zp0), fr.point(u1, dp, zp0)
            b2, b3 = fr.point(u1, dp, zp0 + h1), fr.point(u0, dp, zp0 + h0)
            pbm.add_quad(f0, f1, f2, f3, mat="shadow_reveal", flip=fr.flip_winding)
            pbm.add_quad(b1, b0, b3, b2, mat=mat, flip=fr.flip_winding)
            pbm.add_oriented_beam(fr.point(u0, -0.006, zp0 + h0), fr.point(u1, -0.006, zp0 + h1), dp * 1.15, eh * 0.22, mat="bright_trim")

    return pbm.finish() if auto_fin else pbm


def build_dougong_bracket_set(pbm, frame, z0=0.0, scale=1.0, tiers=3, mat="light_stone"):
    """Build one layered 3D Chinese dougong bracket cluster (`栌斗 + 正交华栱/泥道栱出跳`) in `frame`.

    【视觉与空间层叠原理】：
    古建檐下阴影带中成排挑出的十字交叉木构朵簇。底层置倒棱台形大栌斗（`bevel_top` 收底），其上第 $t = 1..T$ 跳同时沿横向 $\mathbf{e}_u$（泥道栱/令栱）与外法向 $-\mathbf{e}_d$（华栱/昂）正交悬挑，横向跨度随跳数线性外扩 $w_t = (0.020 + 0.012 t)s$，外挑中心逐层前移 $d_t = -0.003 t s$，形成地道的倒金字塔出跳悬挑形态。
    """
    s = float(scale)
    pbm.add_box((0.0, 0.0, float(z0) + 0.004 * s), (0.016 * s, 0.016 * s, 0.008 * s), frame_or_matrix=frame, mat="bright_trim", bevel_top=0.0015 * s)
    for t in range(1, max(1, int(tiers)) + 1):
        zt = float(z0) + (0.006 + t * 0.0065) * s
        span_u = (0.020 + t * 0.012) * s
        span_d = (0.018 + t * 0.011) * s
        pbm.add_box((0.0, -0.003 * t * s, zt), (span_u, 0.006 * s, 0.0055 * s), frame_or_matrix=frame, mat=mat)
        pbm.add_box((0.0, -0.003 * t * s, zt), (0.006 * s, span_d, 0.0055 * s), frame_or_matrix=frame, mat=mat)


def build_dougong_ring_or_bay(
    target,
    cx=0.0,
    cy=0.0,
    z0=0.20,
    hx=0.36,
    hy=0.22,
    radius=None,
    sides=8,
    count_per_side=7,
    tiers=3,
    scale=1.0,
    role="SUPPORTS",
    mat="light_stone",
):
    """Distribute 3D dougong bracket clusters + continuous architrave tie-beam (`阑额/普拍枋`) around a circular/polygonal ring (`radius != None`) or rectangular hall (`hx, hy`).

    【平面几何映射】：
    - 当传入 `radius` 且 `sides >= 20` 时（圆形攒尖殿），在极坐标圆周 $(c_x + R\cos\theta_k, c_y + R\sin\theta_k)$ 处构造径向外法向 `LocalFrame` 排布斗拱环；
    - 当传入 `radius` 且 `sides = 6` 或 `8` 时（多角木塔），先由内切圆半径换算顶点半径 $R_c = R / \cos(\pi/N)$，沿每条多边形边等分铺设普拍枋与柱头/补间铺作；
    - 当 `radius is None` 时（矩形殿堂/城楼），沿四面檐墙 `(±hx, ±hy)` 按模数间距自动布置整圈铺作层。
    """
    pbm, auto_fin = ensure_part_bmesh(target, role=role, mat=mat)
    if radius is not None:
        n_s = max(4, int(sides))
        r = float(radius)
        if n_s >= 20:
            total = max(12, int(count_per_side))
            for k in range(total):
                ang = 2.0 * math.pi * k / total
                nx, ny = math.cos(ang), math.sin(ang)
                fr = LocalFrame.from_facade((float(cx) + r * nx, float(cy) + r * ny, 0.0), (nx, ny))
                build_dougong_bracket_set(pbm, fr, z0=z0, scale=scale, tiers=tiers, mat=mat)
        else:
            cos_h = math.cos(math.pi / n_s)
            cr = r / cos_h
            verts = [Vector((float(cx) + cr * math.cos(-math.pi * 0.5 + math.pi / n_s + 2 * math.pi * i / n_s),
                             float(cy) + cr * math.sin(-math.pi * 0.5 + math.pi / n_s + 2 * math.pi * i / n_s), float(z0))) for i in range(n_s)]
            for i in range(n_s):
                pa, pb = verts[i], verts[(i + 1) % n_s]
                pbm.add_oriented_beam(pa, pb, 0.010 * scale, 0.010 * scale, mat=mat)
                ev = pb - pa
                n_out = Vector((ev.y, -ev.x, 0.0)).normalized()
                nc = max(2, int(count_per_side))
                for k in range(nc):
                    pt = pa.lerp(pb, (k + 0.5) / nc)
                    fr = LocalFrame.from_facade((pt.x, pt.y, 0.0), (n_out.x, n_out.y))
                    build_dougong_bracket_set(pbm, fr, z0=z0, scale=scale, tiers=tiers, mat=mat)
    else:
        corners = [
            (float(cx) - float(hx), float(cy) - float(hy)),
            (float(cx) + float(hx), float(cy) - float(hy)),
            (float(cx) + float(hx), float(cy) + float(hy)),
            (float(cx) - float(hx), float(cy) + float(hy)),
        ]
        normals = [(0.0, -1.0), (1.0, 0.0), (0.0, 1.0), (-1.0, 0.0)]
        for idx in range(4):
            a, b = corners[idx], corners[(idx + 1) % 4]
            pbm.add_oriented_beam((a[0], a[1], float(z0)), (b[0], b[1], float(z0)), 0.010 * scale, 0.010 * scale, mat=mat)
            span = math.hypot(b[0] - a[0], b[1] - a[1])
            nc = max(3, int(round(span / max(0.035, 0.055 * float(scale)))))
            for k in range(nc):
                t = (k + 0.5) / nc
                px, py = a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t
                fr = LocalFrame.from_facade((px, py, 0.0), normals[idx])
                build_dougong_bracket_set(pbm, fr, z0=z0, scale=scale, tiers=tiers, mat=mat)
    return pbm.finish() if auto_fin else pbm


def build_gothic_portal_and_rose(
    target,
    frame=None,
    portal_w=0.14,
    z0=0.0,
    z_spring=0.11,
    arch_rise=0.08,
    orders=4,
    splay_depth=0.045,
    rose_z=None,
    rose_r=0.085,
    rose_spokes=16,
    role="BODY",
    mat="light_stone",
):
    """Build a deeply splayed multi-order Gothic pointed portal (`层退尖拱雕饰门`) + optional polar radial rose window (`玫瑰花窗`).

    【视觉图像特征与三维层退数学映射】：
    1. **层退透视框（Splayed Archivolts）**：哥特主入口立面呈现强烈向内吸纳的漏斗状多层尖拱圈。第 $k = 0..K-1$ 层（从最内门洞向外墙面展开）同步线性插值三个物理量：
       - 半宽递增：$w_k = w_0(0.72 + 0.34\frac{k}{K-1})$；
       - 墙内深度递减：$d_k = D_{\text{splay}}(0.85 - 0.85\frac{k}{K-1})$（内圈深藏于墙内，外圈齐平于立面）；
       - 尖拱矢高递增：$h_k(u_t) = z_{\text{spring}} + H_{\text{arch}}(0.76 + 0.28\frac{k}{K-1})\sqrt{1 - |u_t|(0.62 + 0.38|u_t|)}$。
    2. **极坐标玫瑰花窗**：在深色圆形玻璃背板前方 `d = 0.006` 处，沿圆周角 $\theta_m = 2\pi m / M$ 架设放射状细石棂辐条与外周石框环。
    """
    pbm, auto_fin = ensure_part_bmesh(target, role=role, mat=mat)
    fr = frame if isinstance(frame, LocalFrame) else LocalFrame()
    n_ord = max(2, int(orders))
    hw0 = float(portal_w) * 0.5

    pbm.add_box((0.0, float(splay_depth) * 0.9, float(z0) + (float(z_spring) - float(z0)) * 0.5),
                (hw0 * 1.45, 0.012, float(z_spring) - float(z0)), frame_or_matrix=fr, mat="dark_void")

    for k in range(n_ord):
        frac = k / max(1, n_ord - 1)
        hw = hw0 * (0.72 + 0.34 * frac)
        d_pos = float(splay_depth) * (0.85 - 0.85 * frac)
        ar = float(arch_rise) * (0.76 + 0.28 * frac)
        for sgn in (-1.0, 1.0):
            pbm.add_oriented_beam(fr.point(sgn * hw, d_pos, float(z0)), fr.point(sgn * hw, d_pos, float(z_spring)), 0.006, 0.006, mat="bright_trim")
        n_seg = 16
        pts = []
        for i in range(n_seg + 1):
            u_t = -1.0 + 2.0 * i / n_seg
            au = abs(u_t)
            hz = float(z_spring) + ar * math.sqrt(max(0.0, 1.0 - au * (0.62 + 0.38 * au)))
            pts.append(fr.point(u_t * hw, d_pos, hz))
        for i in range(n_seg):
            pbm.add_oriented_beam(pts[i], pts[i + 1], 0.0065, 0.007, mat="bright_trim" if k % 2 == 0 else mat)

    if rose_z is not None and float(rose_r) > 0.01:
        rz = float(rose_z)
        rr = float(rose_r)
        ns = max(8, int(rose_spokes))
        ring_pts = [fr.point(rr * math.cos(2 * math.pi * i / (ns * 2)), 0.002, rz + rr * math.sin(2 * math.pi * i / (ns * 2))) for i in range(ns * 2)]
        back_pts = [fr.point(rr * 0.96 * math.cos(2 * math.pi * i / (ns * 2)), 0.022, rz + rr * 0.96 * math.sin(2 * math.pi * i / (ns * 2))) for i in range(ns * 2)]
        c_back = fr.point(0.0, 0.024, rz)
        for i in range(ns * 2):
            j = (i + 1) % (ns * 2)
            pbm.add_oriented_beam(ring_pts[i], ring_pts[j], 0.006, 0.008, mat="bright_trim")
            pbm.add_face((back_pts[i], back_pts[j], c_back), mat="dark_void", flip=fr.flip_winding)
        c_front = fr.point(0.0, 0.006, rz)
        for k in range(ns):
            ang = 2.0 * math.pi * k / ns
            p_rim = fr.point(rr * 0.94 * math.cos(ang), 0.006, rz + rr * 0.94 * math.sin(ang))
            pbm.add_oriented_beam(c_front, p_rim, 0.0032, 0.004, mat="bright_trim")

    return pbm.finish() if auto_fin else pbm


def build_pishtaq_iwan_portal(
    target,
    frame=None,
    pishtaq_w=0.22,
    pishtaq_d=0.09,
    z0=0.0,
    pishtaq_h=0.34,
    iwan_w=0.13,
    z_spring=0.16,
    z_apex=0.28,
    muqarnas_tiers=4,
    with_minarets=False,
    role="BODY",
    mat="light_stone",
):
    """Build a Persian/Islamic rectangular pishtaq frame with 4-centered pointed iwan vault, tiered muqarnas honeycomb hood, and optional flanking minarets.

    【视觉图像特征与内部几何原理】：
    - 高大矩形门框墙（Pishtaq）由左右双墩柱与顶部水平檐壁围合成门字形外框，中间深凹进去形成半室外尖拱大厅（Iwan）；
    - 四圆心波斯尖拱曲线：$z(u_t) = z_{\text{spring}} + (z_{\text{apex}} - z_{\text{spring}})(1 - |u_t|^{1.65})^{0.68}$（肩部宽阔饱满、拱顶微尖）；
    - 蜂窝钟乳石半穹顶（Muqarnas）：将起拱线至拱顶划分为 $T$ 层水平阶梯，第 $t$ 层宽度收缩 $w_t = w_0(0.92 - 0.55 t/T)$、进深向内推进 $d_t = D(0.28 + 0.52 t/T)$，并在每层内交替切分 `7 - t` 个悬挑棱柱小龛，在灰模渲染下呈现丰富的阶梯蜂窝阴影。
    """
    pbm, auto_fin = ensure_part_bmesh(target, role=role, mat=mat)
    fr = frame if isinstance(frame, LocalFrame) else LocalFrame()
    pw, pd, ph = float(pishtaq_w), float(pishtaq_d), float(pishtaq_h)
    iw = min(pw * 0.76, float(iwan_w))
    pier_w = 0.5 * (pw - iw)

    for sgn in (-1.0, 1.0):
        pbm.add_box((sgn * (0.5 * iw + 0.5 * pier_w), pd * 0.5, float(z0) + ph * 0.5),
                    (pier_w, pd, ph), frame_or_matrix=fr, mat=mat)
    sp_h = max(0.015, float(z0) + ph - float(z_apex))
    pbm.add_box((0.0, pd * 0.5, float(z_apex) + sp_h * 0.5), (iw, pd, sp_h), frame_or_matrix=fr, mat=mat)
    pbm.add_box((0.0, pd * 0.92, float(z0) + (float(z_apex) - float(z0)) * 0.5), (iw, pd * 0.16, float(z_apex) - float(z0)), frame_or_matrix=fr, mat="shadow_reveal")
    pbm.add_box((0.0, pd * 0.46, float(z0) + ph + 0.006), (pw * 1.04, pd * 1.08, 0.012), frame_or_matrix=fr, mat="bright_trim")

    hw = iw * 0.5
    ha = float(z_apex) - float(z_spring)
    pts = []
    for i in range(21):
        u_t = -1.0 + 2.0 * i / 20.0
        au = abs(u_t)
        hz = float(z_spring) + ha * ((1.0 - au ** 1.65) ** 0.68)
        pts.append((u_t * hw, hz))
    for i in range(20):
        pbm.add_oriented_beam(fr.point(pts[i][0], 0.004, pts[i][1]), fr.point(pts[i + 1][0], 0.004, pts[i + 1][1]), 0.007, 0.008, mat="bright_trim")

    nt = max(2, int(muqarnas_tiers))
    for t in range(nt):
        tf = t / nt
        zt = float(z_spring) + ha * (0.18 + 0.72 * tf)
        wt = hw * (0.92 - 0.55 * tf)
        dt = pd * (0.28 + 0.52 * tf)
        cells = max(3, 7 - t)
        for c in range(cells):
            uc = -wt + 2.0 * wt * (c + 0.5) / cells
            pbm.add_box((uc, dt, zt), (2.0 * wt / cells * 0.86, pd * 0.22, ha / nt * 0.82), frame_or_matrix=fr, mat="bright_trim" if t % 2 == 0 else "main_clay")

    if with_minarets:
        mh = ph * 1.42
        mr = pier_w * 0.34
        for sgn in (-1.0, 1.0):
            mc = fr.point(sgn * (pw * 0.42), pd * 0.35, float(z0) + ph)
            m_rings = []
            for k in range(6):
                zf = k / 5.0
                rr = mr * (1.0 - 0.16 * zf)
                m_rings.append([Vector((mc.x + rr * math.cos(2 * math.pi * m / 16), mc.y + rr * math.sin(2 * math.pi * m / 16), mc.z + (mh - ph) * zf)) for m in range(16)])
            pbm.add_lofted_rings(m_rings, cap_bottom=True, cap_top=True, smooth_sides=True, mat="light_stone")
            pbm.add_box((mc.x, mc.y, mc.z + (mh - ph) * 0.74), (mr * 2.9, mr * 2.9, 0.012), mat="bright_trim")
    return pbm.finish() if auto_fin else pbm


def run(arguments):
    return {
        "module": "lab_columns_brackets_and_portals",
        "operators": [
            "build_classical_fluted_column",
            "build_entablature_and_pediment",
            "build_dougong_bracket_set",
            "build_dougong_ring_or_bay",
            "build_gothic_portal_and_rose",
            "build_pishtaq_iwan_portal",
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
