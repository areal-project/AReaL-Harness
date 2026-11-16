#!/usr/bin/env python3
"""Watertight Curved Roofs, Outward-Normal Arch Apertures, Explicit-Plane Prisms & 4-View Studio Inspection
(`lab_roof_and_aperture_ops.py`).

本模块实现了古建与经典建筑中最关键的四类几何算子，并在每个算子文档中给出**视觉图像特征 <-> 内部数学公式 <-> 三维拓扑构建**的完整对应关系：
1. `roof` / `roof_ridge_and_gables` / `univ_curved_hip_gable_roof`：基于举折二次凹曲线、十次幂翼角起翘与折肩参数连续分段的闭合屋顶生成；
2. `arch_cut_outward`（导出为 `arch_cut`）：基于二维闭合拱券参数方程挤出与外法向重算的穿堂拱洞布尔减法；
3. `prism_xz` / `prism_yz` / `prism_xy`：与三视图（正视图 X-Z、侧视图 Y-Z、俯视图 X-Y）一一对应的零歧义平面多边形挤出；
4. `render_inspection_sheet` / `run_structural_diagnostics`：正交包围盒自适应四视角摄影棚渲染与 BVH 垂直射线/层间连续性拓扑自检。
"""
from __future__ import annotations

import math
from pathlib import Path

try:
    import bpy
    import bmesh
    from mathutils import Euler, Matrix, Vector
    from mathutils.bvhtree import BVHTree
    IN_BLENDER = True
except ImportError:
    IN_BLENDER = False

_CLOSED_XIESHAN_CAPS: set[tuple[float, float, float]] = set()

if IN_BLENDER:
    from lab_update_subpart import (
        Geometry,
        INDEX_TO_ROLE,
        boolean_cut,
        material,
        stamp_object_contract,
    )

    def recalc_object_outward_normals(obj):
        """Weld coincident seam vertices (`dist=1e-6`) and orient all polygon normals outward on a closed Mesh Object.

        【视觉与几何意义】：
        三维网格每个面的外法向由顶点逆时针环绕序（Right-Hand Rule: `(v1 - v0) x (v2 - v0)`）决定。
        在拼接双层屋面壳或负向挤压棱柱时，一旦局部环绕序反向：
        1. 渲染器会把内表面当成外表面，导致光照阴影颠倒或屋面厚度向内吞没表面瓦垄；
        2. 布尔求解器（`EXACT` Boolean）依赖有向体积（Signed Volume）判断内外，法向朝内会导致挖洞静默失效。
        本函数先通过 `remove_doubles(1e-6)` 缝合边界裂隙形成封闭二维流形（2-Manifold），再由连通体有向体积符号统一将所有面法向翻转朝外。
        """
        if obj is None or obj.type != "MESH" or obj.data is None or len(obj.data.polygons) == 0:
            return obj
        r_idx = int(obj.get("reward_part_index", 2))
        mat = obj.data.materials[0] if obj.data.materials else None
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        if len(bm.verts) > 0:
            bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-6)
        if len(bm.faces) > 0:
            bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        bm.to_mesh(obj.data)
        bm.free()
        obj.data.update()
        stamp_object_contract(obj, r_idx, mat=mat)
        return obj

    def prism_xz(name, poly_xz, y0, y1, role="BODY", mat=None, bevel=0.0):
        """Extrude a 2D front-elevation polygon `poly_xz = [(x0, z0), ...]` along world `Y` over `[min(y0,y1), max(y0,y1)]`.

        【三视图投影与数学映射】：
        - 对应 `three-views.png` 中的**正视图（Front Elevation, X-Z 平面）**：
          将正视图上量取的多边形轮廓点 `(x_i, z_i)` 置于前平面 `y_a = min(y0, y1)` 与后平面 `y_b = max(y0, y1)`，
          生成前盖面 `(x_i, y_a, z_i)`、后盖面 `(x_i, y_b, z_i)` 及侧面四边形条带 `(i, i+1)`，最后统一校准外法向。
        - 适用构件：前后立面三角形山墙、城门梯形女儿墙、入口踏步侧护坡墙（垂带/御路）。
        """
        ya, yb = min(float(y0), float(y1)), max(float(y0), float(y1))
        g = Geometry(name, role, mat)
        g.prism(poly_xz, ya, yb, axis="Y")
        return recalc_object_outward_normals(g.finish(bevel=bevel))

    def prism_yz(name, poly_yz, x0, x1, role="BODY", mat=None, bevel=0.0):
        """Extrude a 2D side-elevation polygon `poly_yz = [(y0, z0), ...]` along world `X` over `[min(x0,x1), max(x0,x1)]`.

        【三视图投影与数学映射】：
        - 对应 `three-views.png` 中的**侧视图（Side Elevation, Y-Z 平面）**：
          截面点第一坐标固定为世界 `Y`（当建筑水平中心在 `CY` 时，前后对称山墙的底边端点应写为 `(CY - half_y, z0)` 与 `(CY + half_y, z0)`），
          第二坐标为世界高度 `Z`，沿横向厚度区间 `[min(x0, x1), max(x0, x1)]` 正交挤出闭合流形棱柱。
        - 适用构件：歇山顶东西两侧内收三角形山花板、硬山顶两侧封火山墙、城台东西两侧内凹盲券壁龛。
        """
        xa, xb = min(float(x0), float(x1)), max(float(x0), float(x1))
        g = Geometry(name, role, mat)
        g.prism(poly_yz, xa, xb, axis="X")
        return recalc_object_outward_normals(g.finish(bevel=bevel))

    def prism_xy(name, poly_xy, z0, z1, role="BODY", mat=None, bevel=0.0):
        """Extrude a 2D top-plan footprint polygon `poly_xy = [(x0, y0), ...]` vertically along world `Z` over `[min(z0,z1), max(z0,z1)]`.

        【三视图投影与数学映射】：
        - 对应 `three-views.png` 中的**俯视图（Top Plan, X-Y 平面）**：
          将平面轮廓 `(x_i, y_i)` 从底标高 `z_a = min(z0, z1)` 垂直拉伸至顶标高 `z_b = max(z0, z1)`。
        - 适用构件：八角/六角亭台基座、L形/U形院落耳房体块、石桥桥墩三角形迎水分水尖（Cutwater）。
        """
        za, zb = min(float(z0), float(z1)), max(float(z0), float(z1))
        g = Geometry(name, role, mat)
        g.prism(poly_xy, za, zb, axis="Z")
        return recalc_object_outward_normals(g.finish(bevel=bevel))

    def _arch_profile_2d(center_u, bottom, spring, radius, segments=40, style="round", pointed_sharpness=1.35):
        segs = max(16, int(segments))
        st = str(style or "round").lower()
        pts = [(float(center_u) - float(radius), float(bottom)), (float(center_u) + float(radius), float(bottom))]
        for i in range(segs + 1):
            ang = i * math.pi / segs
            u = float(center_u) + float(radius) * math.cos(ang)
            s = max(0.0, math.sin(ang))
            if st in ("pointed", "gothic", "islamic", "ogive"):
                z = float(spring) + float(radius) * float(pointed_sharpness) * (s ** 0.78)
            elif st in ("segmental", "flat", "low"):
                z = float(spring) + float(radius) * 0.55 * s
            else:
                z = float(spring) + float(radius) * s
            pts.append((u, z))
        return pts

    def arch_cut_outward(obj, center_x, front, back, bottom, spring, radius, segments=44,
                         axis="Y", style="round", pointed_sharpness=1.35):
        """Carve a real arched tunnel or recessed niche through `obj` via outward-normal manifold Boolean subtraction.

        【视觉特征与参数物理含义】：
        在正立面看到城台券门、钟鼓楼穿堂门洞或石拱桥孔时，门洞由“下部垂直门腿 + 上部弧形拱顶”组成：
        - `center_x`：门洞中轴水平坐标；
        - `bottom`：门洞门槛底标高；
        - `spring`：起拱线标高（直墙门腿结束、圆弧开始起拱的转折点高度）；
        - `radius`：门洞半宽（半圆拱时，拱顶最高点标高恰为 `spring + radius`）；
        - `front, back`：沿穿墙方向的切割起止深度。贯穿隧道需比墙体前后外表面各多伸出 `0.01~0.02` 以避免共面残片；盲券壁龛则令内端停在墙厚内部。

        【内部数学原理】：
        1. 二维拱券截面构造：底边两端点 `(center_x - radius, bottom) -> (center_x + radius, bottom)` 向上连接极角采样点
           `u(theta) = center_x + radius * cos(theta)`（`theta` 从 `0` 到 `pi` 逆时针绕行）：
           - 半圆拱（`round`）：`z(theta) = spring + radius * sin(theta)`；
           - 尖拱（`pointed`）：`z(theta) = spring + sharpness * radius * sin(theta)^0.78`（抬高拱顶并加密顶部曲率）；
           - 扁弧拱（`segmental`）：`z(theta) = spring + 0.55 * radius * sin(theta)`。
        2. 流形布尔减法：将闭合截面沿穿墙轴挤出为封闭棱柱，经 `recalc_object_outward_normals` 保证有向体积为正，
           在斜收分棱台（Battered Frustum）上执行 `EXACT` 差集，从而自然切割出与斜墙坡面精确相贯的立体拱腹隧道（若错误使用贴在墙外的黑块，斜墙下宽上窄会导致黑块上部刺出墙面）。
        """
        if obj is None or obj.type != "MESH":
            return obj
        r_idx = int(obj.get("reward_part_index", 3))
        mat = obj.data.materials[0] if obj.data.materials else None
        v0, v1 = min(float(front), float(back)), max(float(front), float(back))
        if v1 - v0 < 1e-5:
            v0, v1 = v0 - 0.02, v1 + 0.02
        profile = _arch_profile_2d(center_x, bottom, spring, radius, segments=segments, style=style, pointed_sharpness=pointed_sharpness)
        g = Geometry(f"_tmp_arch_cutter_{float(center_x):.3f}", r_idx, mat)
        g.prism(profile, v0, v1, axis=axis)
        cutter = recalc_object_outward_normals(g.finish())
        boolean_cut(obj, [cutter], operation="DIFFERENCE", delete_cutters=True)
        return obj

    def _build_xieshan_upper_cap(
        shell,
        ribs,
        borders,
        gables,
        *,
        center_x: float,
        center_y: float,
        hx: float,
        hy: float,
        inner_x: float,
        inner_y: float,
        eave: float,
        rise: float,
        lift: float,
        tau_s: float,
        thick: float,
        tile_spacing: float,
        steps: int,
        rib_sides: int,
        ridge_along_x: bool,
    ):
        """Construct the upper two-slope Ju-Zhe curved tile roof (`tau in [tau_s, 1]`), barrel tiles, bofeng, and paired shanhua gables."""
        u_steps = max(10, int(round(steps * 0.65)))
        ts = max(0.0018, float(tile_spacing))

        if ridge_along_x:
            overhang_x = min(0.005, max(0.0015, 0.14 * max(0.0, hx - inner_x)))
            cap_hx = min(max(inner_x, hx - 0.0015), inner_x + overhang_x)
            count = max(16, round((2.0 * cap_hx) / ts))

            def upper_pt(sgn_y: float, along: float, v: float, z_off: float = 0.0):
                tau = tau_s + (1.0 - tau_s) * v
                x = center_x + (-cap_hx + 2.0 * cap_hx * along)
                y = center_y + sgn_y * inner_y * (1.0 - v)
                z = (
                    eave
                    + rise * (0.18 * tau + 0.82 * tau * tau)
                    + lift * 0.28 * (abs(2.0 * along - 1.0) ** 8) * ((1.0 - v) ** 2.2)
                    + z_off
                )
                return (x, y, z)

            for sgn_y in (-1.0, 1.0):
                flip_top = sgn_y > 0.0
                for layer_idx, z_off in enumerate((0.0, -thick)):
                    vs = [
                        upper_pt(sgn_y, a_i / count, v_i / u_steps, z_off)
                        for v_i in range(u_steps + 1)
                        for a_i in range(count + 1)
                    ]
                    fs = []
                    for v_i in range(u_steps):
                        for a_i in range(count):
                            st = v_i * (count + 1) + a_i
                            quad = (st, st + 1, st + count + 2, st + count + 1)
                            inv = flip_top ^ (layer_idx == 1)
                            fs.append(tuple(reversed(quad)) if inv else quad)
                    shell.poly(vs, fs)

                for v_edge in (0.0, 1.0):
                    rim_vs = [
                        upper_pt(sgn_y, a_i / count, v_edge, z_off)
                        for z_off in (0.0, -thick)
                        for a_i in range(count + 1)
                    ]
                    rim_fs = [(a_i, a_i + 1, count + 2 + a_i, count + 1 + a_i) for a_i in range(count)]
                    shell.poly(rim_vs, rim_fs)

                for a_edge in (0.0, 1.0):
                    side_vs = [
                        upper_pt(sgn_y, a_edge, v_i / u_steps, z_off)
                        for z_off in (0.0, -thick)
                        for v_i in range(u_steps + 1)
                    ]
                    side_fs = [(v_i, v_i + 1, u_steps + 2 + v_i, u_steps + 1 + v_i) for v_i in range(u_steps)]
                    shell.poly(side_vs, side_fs)

                rib_rad = max(0.0008, ts * 0.22)
                for a_i in range(count + 1):
                    ribs.tube(
                        [upper_pt(sgn_y, a_i / count, v_i / u_steps, 0.0008) for v_i in range(u_steps + 1)],
                        rib_rad,
                        rib_sides,
                    )
                for v_ring in (0.20, 0.42, 0.64, 0.84):
                    ribs.tube(
                        [upper_pt(sgn_y, a_i / count, v_ring, 0.0007) for a_i in range(count + 1)],
                        max(0.0003, ts * 0.08),
                        6,
                    )

                borders.tube([upper_pt(sgn_y, a_i / count, 0.0, 0.0005) for a_i in range(count + 1)], 0.0018, 8)
                for a_edge in (0.0, 1.0):
                    borders.tube([upper_pt(sgn_y, a_edge, v_i / u_steps, 0.0014) for v_i in range(u_steps + 1)], 0.0024, 10)

            z_ridge = eave + rise
            borders.box((center_x, center_y, z_ridge + 0.0018), (cap_hx * 2.0 + 0.004, max(0.009, thick * 1.8), max(0.006, thick * 1.4)), subdiv=3)
            borders.tube([(center_x - cap_hx - 0.002, center_y, z_ridge + 0.004), (center_x + cap_hx + 0.002, center_y, z_ridge + 0.004)], 0.0022, 10)

            z_sh_low = eave + rise * (0.18 * tau_s + 0.82 * tau_s * tau_s) - thick * 0.85
            poly_yz = [(center_y - inner_y, z_sh_low), (center_y + inner_y, z_sh_low)]
            for k in range(u_steps, -1, -1):
                vk = k / u_steps
                _, py, pz = upper_pt(1.0, 0.0, vk, -0.0012)
                poly_yz.append((py, max(z_sh_low + 0.001, pz)))
            for k in range(1, u_steps + 1):
                vk = k / u_steps
                _, py, pz = upper_pt(-1.0, 0.0, vk, -0.0012)
                poly_yz.append((py, max(z_sh_low + 0.001, pz)))
            gable_thick = max(0.0045, min(0.009, inner_x * 0.03))
            for sgn_x in (-1.0, 1.0):
                x_a = center_x + sgn_x * max(0.001, inner_x - gable_thick * 0.8)
                x_b = center_x + sgn_x * (inner_x + gable_thick * 0.2)
                gables.prism(poly_yz, min(x_a, x_b), max(x_a, x_b), axis="X")
                x_rel = center_x + sgn_x * (inner_x + gable_thick * 0.35)
                if z_ridge - z_sh_low > 0.008:
                    gables.box((x_rel, center_y, 0.5 * (z_sh_low + z_ridge - 0.002)), (0.0022, 0.0035, max(0.004, (z_ridge - z_sh_low) * 0.86)))
                    gables.box((x_rel, center_y, z_sh_low + (z_ridge - z_sh_low) * 0.36), (0.0022, inner_y * 1.18, 0.0028))

            _CLOSED_XIESHAN_CAPS.add((round(center_x, 2), round(center_y, 2), round(z_ridge, 2)))

        else:
            overhang_y = min(0.005, max(0.0015, 0.14 * max(0.0, hy - inner_y)))
            cap_hy = min(max(inner_y, hy - 0.0015), inner_y + overhang_y)
            count = max(16, round((2.0 * cap_hy) / ts))

            def upper_pt_y(sgn_x: float, along: float, v: float, z_off: float = 0.0):
                tau = tau_s + (1.0 - tau_s) * v
                x = center_x + sgn_x * inner_x * (1.0 - v)
                y = center_y + (-cap_hy + 2.0 * cap_hy * along)
                z = (
                    eave
                    + rise * (0.18 * tau + 0.82 * tau * tau)
                    + lift * 0.28 * (abs(2.0 * along - 1.0) ** 8) * ((1.0 - v) ** 2.2)
                    + z_off
                )
                return (x, y, z)

            for sgn_x in (-1.0, 1.0):
                flip_top = sgn_x < 0.0
                for layer_idx, z_off in enumerate((0.0, -thick)):
                    vs = [
                        upper_pt_y(sgn_x, a_i / count, v_i / u_steps, z_off)
                        for v_i in range(u_steps + 1)
                        for a_i in range(count + 1)
                    ]
                    fs = []
                    for v_i in range(u_steps):
                        for a_i in range(count):
                            st = v_i * (count + 1) + a_i
                            quad = (st, st + 1, st + count + 2, st + count + 1)
                            inv = flip_top ^ (layer_idx == 1)
                            fs.append(tuple(reversed(quad)) if inv else quad)
                    shell.poly(vs, fs)
                for v_edge in (0.0, 1.0):
                    rim_vs = [upper_pt_y(sgn_x, a_i / count, v_edge, z_off) for z_off in (0.0, -thick) for a_i in range(count + 1)]
                    shell.poly(rim_vs, [(a_i, a_i + 1, count + 2 + a_i, count + 1 + a_i) for a_i in range(count)])
                rib_rad = max(0.0008, ts * 0.22)
                for a_i in range(count + 1):
                    ribs.tube([upper_pt_y(sgn_x, a_i / count, v_i / u_steps, 0.0008) for v_i in range(u_steps + 1)], rib_rad, rib_sides)
                for a_edge in (0.0, 1.0):
                    borders.tube([upper_pt_y(sgn_x, a_edge, v_i / u_steps, 0.0014) for v_i in range(u_steps + 1)], 0.0024, 10)

            z_ridge = eave + rise
            borders.box((center_x, center_y, z_ridge + 0.0018), (max(0.009, thick * 1.8), cap_hy * 2.0 + 0.004, max(0.006, thick * 1.4)), subdiv=3)
            z_sh_low = eave + rise * (0.18 * tau_s + 0.82 * tau_s * tau_s) - thick * 0.85
            poly_xz = [(center_x - inner_x, z_sh_low), (center_x + inner_x, z_sh_low), (center_x, z_ridge - 0.001)]
            gable_thick = max(0.0045, min(0.009, inner_y * 0.03))
            for sgn_y in (-1.0, 1.0):
                y_a = center_y + sgn_y * max(0.001, inner_y - gable_thick * 0.8)
                y_b = center_y + sgn_y * (inner_y + gable_thick * 0.2)
                gables.prism(poly_xz, min(y_a, y_b), max(y_a, y_b), axis="Y")
            _CLOSED_XIESHAN_CAPS.add((round(center_x, 2), round(center_y, 2), round(z_ridge, 2)))

    def roof(
        name,
        hx,
        hy,
        inner_x,
        inner_y,
        center_y=0.0,
        eave=0.3,
        rise=0.05,
        lift=0.015,
        tile_spacing=0.0032,
        steps=24,
        rib_sides=8,
        role="ROOF",
        center_x=0.0,
        thickness=0.005,
        mat_tile=None,
        mat_ridge=None,
        collar_only=False,
    ):
        """Construct a curved tiled East Asian roof (`歇山顶` / `庑殿顶` / `悬山顶` / `攒尖顶` / `重檐空心腰檐`).

        ========================================================================
        1. 视觉图像特征 <-> 内部数学曲面方程对应关系
        ========================================================================
        观察参考图与正/侧立面时，中式古建屋顶有三个显著的几何特征，分别对应本函数内部的三项数学公式：
        - **特征 A（坡面“上陡下缓”的反宇凹曲线）**：
          立面剪影不是生硬的直线斜坡，而是靠近屋脊陡峭、靠近檐口平缓外展的凹弧线（“举折”）。
          内部设总进深爬升参数 `tau in [0, 1]`，采用二次凸组合高度方程：
            `z_slope(tau) = eave + rise * (0.18 * tau + 0.82 * tau^2)`
          在檐口 `tau=0` 处斜率仅为 `0.18 * rise`（平缓舒展），到正脊 `tau=1` 处斜率增至 `1.82 * rise`（陡立挺拔）。
        - **特征 B（“中段平直、唯独四角飞翘”的翼角起翘）**：
          正立面看檐口绝大部分是水平直线，只在左右两端最后 15% 处向斜上方翘起 `lift` 高度。
          内部设沿檐归一化坐标 `u = along in [0, 1]`、坡面径向进度 `r = radial in [0, 1]`，叠加高次幂角部升起项：
            `z_lift(u, r) = lift * |2*u - 1|^10 * (1 - r)^3`
          因为当 `u in [0.2, 0.8]` 时 `|2*u - 1| <= 0.6`，其 10 次幂 `< 0.006` 近似为 0，从而保证屋檐中段绝对水平不塌腰；
          而当 `u -> 0` 或 `1`（四角翼角）时 `|2*u - 1|^10 -> 1`，精准生成翼角飞翘，且随 `(1 - r)^3` 向屋脊平滑归零。
        - **特征 C（歇山顶“上下两折 + 内收山花” vs 庑殿顶“四坡直达正脊” vs 重檐“空心腰檐”）**：
          * **歇山顶（`collar_only=False` 且 `inner_x > 0.006, inner_y > 0.006`）**：
            侧立面可见屋顶在半腰 `(+-inner_x, +-inner_y)` 处折断：下半部是四面飞檐裙边，左右两端立起内收的竖直曲边三角形山花板，
            山花上方则是前后两坡弧形瓦面继续向上交汇于 `y = center_y` 正脊。
            内部取折肩分界点 `tau_s = 1 - inner_y / hy`：下段四面裙边令 `tau in [0, tau_s]`，上段前后两坡瓦面令 `tau in [tau_s, 1]`，
            二者共享同一条举折抛物线，既完全封死屋顶中央，又使正脊高度严格等于 `eave + rise`！
          * **庑殿顶 / 悬山顶（`collar_only=False` 且 `inner_y <= 0.006`）**：
            四坡（或前后两坡）直接从 `+-hy` 收拢到 `y = center_y` 正脊线（`tau_s = 1`），顶部加盖琉璃正脊梁。
          * **重檐下层空心腰檐（显式传 `collar_only=True`）**：
            用于一楼与二楼墙身之间的挑出腰檐——仅构建外圈 `(+-hx, +-hy)` 到内口 `(+-inner_x, +-inner_y)` 的四面飞檐环领，
            内口留空供上层殿墙与柱网垂直穿过。

        ========================================================================
        2. 瓦垄肌理拓扑构建
        ========================================================================
        - 屋面板由顶面 `offset=0` 与底面 `offset=-thickness` 缝合周边后经外法向校准形成封闭厚壳；
        - 按真实瓦垄间距 `tile_spacing` 在坡面上沿等 `u` 曲线扫掠半径 `0.22 * tile_spacing` 的纵向筒瓦圆管（`ribs`），
          并在径向铺设横向瓦层搭接细棱，使灰模在斜光下呈现出细腻的传统筒板瓦明暗条纹。
        """
        m_tile = mat_tile or material("Roof_Warm_Grey_Tile", (0.33, 0.31, 0.25), 0.74)
        m_ridge = mat_ridge or material("Roof_Glazed_Ridge", (0.105, 0.22, 0.17), 0.49)
        m_gable = material("Masonry_Vermilion", (0.34, 0.105, 0.085), 0.75, grain=240)

        shell = Geometry(f"{name}_curved_shell", role, m_tile)
        ribs = Geometry(f"{name}_barrel_tile_courses", role, m_tile)
        borders = Geometry(f"{name}_hips_and_eave_lips", role, m_ridge)

        hx_f, hy_f = abs(float(hx)), abs(float(hy))
        ix_f = max(0.0005, min(hx_f, abs(float(inner_x))))
        iy_f = max(0.0005, min(hy_f, abs(float(inner_y))))
        cx_f, cy_f = float(center_x), float(center_y)
        eave_f, rise_f, lift_f = float(eave), float(rise), float(lift)
        steps_i = max(16, int(steps))
        rib_sides_i = max(6, int(rib_sides))
        thick = abs(float(thickness))

        needs_xieshan_cap = (not bool(collar_only)) and (ix_f > 0.006) and (iy_f > 0.006)
        ridge_along_x = not (hy_f > hx_f * 1.05 and iy_f > ix_f * 1.05)
        if needs_xieshan_cap:
            ratio = (iy_f / max(hy_f, 1e-4)) if ridge_along_x else (ix_f / max(hx_f, 1e-4))
            tau_s = max(0.24, min(0.82, 1.0 - ratio))
        else:
            tau_s = 1.0

        def point(side, along, radial, offset=0.0):
            outer = [
                (-hx_f + 2.0 * hx_f * along, -hy_f),
                (hx_f, -hy_f + 2.0 * hy_f * along),
                (hx_f - 2.0 * hx_f * along, hy_f),
                (-hx_f, hy_f - 2.0 * hy_f * along),
            ][side]
            inner = [
                (-ix_f + 2.0 * ix_f * along, -iy_f),
                (ix_f, -iy_f + 2.0 * iy_f * along),
                (ix_f - 2.0 * ix_f * along, iy_f),
                (-ix_f, iy_f - 2.0 * iy_f * along),
            ][side]
            tau = tau_s * radial
            return (
                cx_f + outer[0] * (1.0 - radial) + inner[0] * radial,
                cy_f + outer[1] * (1.0 - radial) + inner[1] * radial,
                eave_f
                + rise_f * (0.18 * tau + 0.82 * tau * tau)
                + lift_f * (abs(2.0 * along - 1.0) ** 10) * ((1.0 - radial) ** 3)
                + offset,
            )

        for side in range(4):
            width = 2.0 * (hx_f if side % 2 == 0 else hy_f)
            count = max(18, round(width / max(0.0015, float(tile_spacing))))
            for layer in [0.0, -thick]:
                vertices = [
                    point(side, along / count, radial / steps_i, layer)
                    for radial in range(steps_i + 1)
                    for along in range(count + 1)
                ]
                faces = []
                for radial in range(steps_i):
                    for along in range(count):
                        start = radial * (count + 1) + along
                        face = (start, start + 1, start + count + 2, start + count + 1)
                        faces.append(tuple(reversed(face)) if layer else face)
                shell.poly(vertices, faces)
            for radial in [0.0, 1.0]:
                shell.poly(
                    [point(side, along / count, radial, offset) for offset in [0.0, -thick] for along in range(count + 1)],
                    [(along, along + 1, count + 2 + along, count + 1 + along) for along in range(count)],
                )
            for along in range(count + 1):
                ribs.tube(
                    [point(side, along / count, radial / steps_i, 0.0008) for radial in range(steps_i + 1)],
                    max(0.0008, float(tile_spacing) * 0.22),
                    rib_sides_i,
                )
            for radial in [0.14, 0.28, 0.42, 0.56, 0.70, 0.84, 0.94]:
                ribs.tube(
                    [point(side, along / count, radial, 0.0007) for along in range(count + 1)],
                    max(0.0003, float(tile_spacing) * 0.08),
                    6,
                )
            borders.tube([point(side, along / count, 0.0, 0.0002) for along in range(count + 1)], 0.0022, 10)
            borders.tube([point(side, 0.0, radial / steps_i, 0.0018) for radial in range(steps_i + 1)], 0.0024, 10)

        out_objs = []
        if needs_xieshan_cap:
            gables = Geometry(f"{name}_xieshan_end_gables", role, m_gable)
            _build_xieshan_upper_cap(
                shell,
                ribs,
                borders,
                gables,
                center_x=cx_f,
                center_y=cy_f,
                hx=hx_f,
                hy=hy_f,
                inner_x=ix_f,
                inner_y=iy_f,
                eave=eave_f,
                rise=rise_f,
                lift=lift_f,
                tau_s=tau_s,
                thick=thick,
                tile_spacing=float(tile_spacing),
                steps=steps_i,
                rib_sides=rib_sides_i,
                ridge_along_x=ridge_along_x,
            )
            o_shell = recalc_object_outward_normals(shell.finish())
            o_ribs = ribs.finish()
            o_borders = borders.finish()
            o_gables = recalc_object_outward_normals(gables.finish())
            out_objs = [o for o in (o_shell, o_ribs, o_borders, o_gables) if o is not None]
        else:
            if not bool(collar_only):
                z_r = eave_f + rise_f
                if iy_f <= 0.006 and ix_f >= iy_f:
                    borders.box((cx_f, cy_f, z_r + 0.0012), (ix_f * 2.0 + 0.004, max(0.010, iy_f * 2.6), max(0.005, thick * 1.2)), subdiv=2)
                    borders.tube([(cx_f - ix_f, cy_f, z_r + 0.003), (cx_f + ix_f, cy_f, z_r + 0.003)], 0.0020, 8)
                elif ix_f <= 0.006:
                    borders.box((cx_f, cy_f, z_r + 0.0012), (max(0.010, ix_f * 2.6), iy_f * 2.0 + 0.004, max(0.005, thick * 1.2)), subdiv=2)
                    borders.tube([(cx_f, cy_f - iy_f, z_r + 0.003), (cx_f, cy_f + iy_f, z_r + 0.003)], 0.0020, 8)
            o_shell = recalc_object_outward_normals(shell.finish())
            o_ribs = ribs.finish()
            o_borders = borders.finish()
            out_objs = [o for o in (o_shell, o_ribs, o_borders) if o is not None]
        return out_objs

    curved_hip_roof = roof
    hip_roof = roof

    def roof_ridge_and_gables(
        name,
        center_x=0.0,
        center_y=0.0,
        ridge_half_x=0.24,
        gable_half_y=0.13,
        z_base=0.55,
        z_ridge=0.615,
        z_top=0.625,
        role="ROOF",
        tile_spacing=0.004,
        thickness=0.0045,
        include_upper_slopes=None,
    ):
        """Build the horizontal main ridge beam (`正脊`), paired C-curved `chiwen` finials (`鸱吻`),
        and (when `roof()` used `collar_only=True`) the upper two-slope curved tiled roof and end gables.

        【视觉轮廓与内部空间曲线】：
        - 正立面屋顶最高处两端可见一对向外张口吞脊、尾部向内反卷翘起的吻兽剪影（决定整栋建筑的最高点 `z_top`）：
          内部通过五控制点空间折线 `(±(rhx-0.010), z_ridge-0.002) -> (±(rhx+0.007), z_top-0.002) -> (±(rhx+0.002), z_top)`
          扫掠圆管模拟鸱吻的反C形卷尾轮廓，且严格对 `sign in (-1, +1)` 左右镜像对称生成。
        """
        m_tile = material("Roof_Warm_Grey_Tile", (0.33, 0.31, 0.25), 0.74)
        m_green = material("Roof_Glazed_Ridge", (0.105, 0.22, 0.17), 0.49)
        m_red = material("Masonry_Vermilion", (0.34, 0.105, 0.085), 0.75, grain=240)

        cx_f, cy_f = float(center_x), float(center_y)
        rhx = abs(float(ridge_half_x))
        ghy = abs(float(gable_half_y))
        zb_f, zr_f, zt_f = float(z_base), float(z_ridge), float(z_top)

        already_closed = any(
            abs(cx_f - kx) < 0.03 and abs(cy_f - ky) < 0.03 and abs(zr_f - kz) < 0.04
            for (kx, ky, kz) in _CLOSED_XIESHAN_CAPS
        )
        build_slopes = (not already_closed) if include_upper_slopes is None else bool(include_upper_slopes)

        created = []
        if build_slopes and rhx > 0.006 and ghy > 0.006 and zr_f > zb_f + 0.002:
            sh = Geometry(f"{name}_upper_xieshan_shell", role, m_tile)
            rb = Geometry(f"{name}_upper_xieshan_tiles", role, m_tile)
            bd = Geometry(f"{name}_upper_xieshan_bofeng", role, m_green)
            gb = Geometry(f"{name}_recessed_end_gables", role, m_red)
            _build_xieshan_upper_cap(
                sh,
                rb,
                bd,
                gb,
                center_x=cx_f,
                center_y=cy_f,
                hx=rhx + 0.004,
                hy=ghy,
                inner_x=rhx,
                inner_y=ghy,
                eave=zb_f,
                rise=zr_f - zb_f,
                lift=0.006,
                tau_s=0.0,
                thick=abs(float(thickness)),
                tile_spacing=float(tile_spacing),
                steps=18,
                rib_sides=6,
                ridge_along_x=True,
            )
            created.extend(
                o
                for o in (
                    recalc_object_outward_normals(sh.finish()),
                    rb.finish(),
                    bd.finish(),
                    recalc_object_outward_normals(gb.finish()),
                )
                if o is not None
            )

        ridge = Geometry(f"{name}_main_ridge_and_crests", role, m_green)
        if rhx > 0.005:
            ridge.box((cx_f, cy_f, zr_f), (rhx * 2.0 + 0.004, 0.012, 0.008), subdiv=4)
            if zt_f > zr_f + 0.001:
                for sign in (-1.0, 1.0):
                    ridge.tube(
                        [
                            (cx_f + sign * (rhx - 0.010), cy_f, zr_f - 0.002),
                            (cx_f + sign * (rhx - 0.002), cy_f, zr_f),
                            (cx_f + sign * (rhx + 0.005), cy_f, (zr_f + zt_f) * 0.5),
                            (cx_f + sign * (rhx + 0.007), cy_f, zt_f - 0.002),
                            (cx_f + sign * (rhx + 0.002), cy_f, zt_f),
                        ],
                        0.0025,
                        12,
                    )
        o_ridge = ridge.finish()
        if o_ridge is not None:
            created.append(o_ridge)

        if not already_closed and not build_slopes and rhx > 0.005 and ghy > 0.005 and zr_f > zb_f:
            gable = Geometry(f"{name}_recessed_end_gables", role, m_red)
            for sign in (-1.0, 1.0):
                x_in = cx_f + sign * (rhx - 0.002)
                x_out = cx_f + sign * (rhx + 0.003)
                gable.prism(
                    [(cy_f - ghy, zb_f), (cy_f + ghy, zb_f), (cy_f, zr_f - 0.004)],
                    min(x_in, x_out),
                    max(x_in, x_out),
                    axis="X",
                )
            o_gable = recalc_object_outward_normals(gable.finish())
            if o_gable is not None:
                created.append(o_gable)
        return created

    def univ_curved_hip_gable_roof(
        name,
        hx,
        hy,
        z_eave,
        rise,
        style="xieshan",
        ridge_ratio=0.58,
        gable_drop_frac=0.42,
        lift=0.016,
        tile_spacing=0.0036,
        thickness=0.005,
        chiwen_height=0.012,
        collar_only=False,
        center_x=0.0,
        center_y=0.0,
        role="ROOF",
        mat_tile=None,
        mat_ridge=None,
    ):
        """High-level East Asian roof dispatcher mapping roof topology styles directly to inner contraction ratios `(inner_x, inner_y)`.

        【四种屋顶拓扑的数学退化统一性】：
        中式坡屋顶本质上都是外矩形 `[-hx, +hx] x [-hy, +hy]` 向内矩形 `[-ix, +ix] x [-iy, +iy]` 的参数化映射：
        - `style="xieshan"`（歇山顶）：`ix = hx * ridge_ratio`, `iy = hy * gable_drop_frac`（两维均不退化为 0，产生折肩与山花，再由上段两坡封口）；
        - `style="hip"`（庑殿顶）：`ix = hx * ridge_ratio`, `iy -> 0`（Y 方向退化为一条长度为 `2*ix` 的正脊线段，左右形成三角形斜坡）；
        - `style="gable"`（悬山/硬山顶）：`ix = 0.99 * hx`, `iy -> 0`（正脊等宽于外檐，左右端坡退化为竖直山墙面）；
        - `style="pyramidal"`（四角攒尖顶）：`ix -> 0, iy -> 0`（内矩形退化为单一中心顶点，四坡交汇于宝顶）。
        """
        st = str(style or "xieshan").lower()
        hx_f, hy_f = abs(float(hx)), abs(float(hy))
        ze_f, rs_f = float(z_eave), float(rise)
        cx_f, cy_f = float(center_x), float(center_y)

        if st in ("pyramidal", "zanjian", "tent"):
            ix, iy = 0.002, 0.002
        elif st in ("hip", "wudian"):
            ix, iy = max(0.01, hx_f * float(ridge_ratio)), 0.002
        elif st in ("gable", "xuanshan", "yingshan"):
            ix, iy = hx_f * 0.99, 0.002
        else:
            ix = max(0.012, hx_f * float(ridge_ratio))
            iy = max(0.010, hy_f * float(gable_drop_frac))

        objs = roof(
            name,
            hx_f,
            hy_f,
            ix,
            iy,
            center_y=cy_f,
            eave=ze_f,
            rise=rs_f,
            lift=float(lift),
            tile_spacing=float(tile_spacing),
            role=role,
            center_x=cx_f,
            thickness=float(thickness),
            mat_tile=mat_tile,
            mat_ridge=mat_ridge,
            collar_only=bool(collar_only),
        )
        if not collar_only and ix > 0.008 and float(chiwen_height) > 0.001:
            objs.extend(
                roof_ridge_and_gables(
                    f"{name}_crest",
                    center_x=cx_f,
                    center_y=cy_f,
                    ridge_half_x=ix,
                    gable_half_y=iy if iy > 0.006 else hy_f * 0.85,
                    z_base=ze_f,
                    z_ridge=ze_f + rs_f,
                    z_top=ze_f + rs_f + float(chiwen_height),
                    role=role,
                    include_upper_slopes=False,
                )
            )
        return objs

    def run_structural_diagnostics():
        """BVH raycast & bounding-interval topological sanity check (`BASE`->`BODY` gap, center `ROOF` closure, L/R symmetry)."""
        bpy.context.view_layer.update()
        deps = bpy.context.evaluated_depsgraph_get()
        role_z = {}
        left_verts = 0
        right_verts = 0
        all_mins = [float("inf")] * 3
        all_maxs = [float("-inf")] * 3

        meshes = [o for o in bpy.context.scene.objects if o.type == "MESH" and not o.hide_render and o.data and len(o.data.polygons) > 0]
        if not meshes:
            return {"warnings": ["Scene contains zero visible mesh objects."]}

        for obj in meshes:
            eo = obj.evaluated_get(deps)
            me = eo.to_mesh()
            mw = eo.matrix_world
            for v in me.vertices:
                w = mw @ v.co
                for k in range(3):
                    if w[k] < all_mins[k]:
                        all_mins[k] = w[k]
                    if w[k] > all_maxs[k]:
                        all_maxs[k] = w[k]
            eo.to_mesh_clear()

        cx_mid = 0.5 * (all_mins[0] + all_maxs[0])
        cy_mid = 0.5 * (all_mins[1] + all_maxs[1])

        roof_bvh_verts = []
        roof_bvh_tris = []
        for obj in meshes:
            r_idx = int(obj.get("reward_part_index", 0))
            r_name = INDEX_TO_ROLE.get(r_idx, f"PART_{r_idx}").upper()
            eo = obj.evaluated_get(deps)
            me = eo.to_mesh()
            me.calc_loop_triangles()
            mw = eo.matrix_world
            z_lo, z_hi = float("inf"), float("-inf")
            base_v = len(roof_bvh_verts)
            is_roof = "ROOF" in r_name or "DOME" in r_name or "SHELL" in r_name
            for v in me.vertices:
                w = mw @ v.co
                if w.z < z_lo:
                    z_lo = w.z
                if w.z > z_hi:
                    z_hi = w.z
                if w.x < cx_mid - 0.005:
                    left_verts += 1
                elif w.x > cx_mid + 0.005:
                    right_verts += 1
                if is_roof:
                    roof_bvh_verts.append((w.x, w.y, w.z))
            if is_roof:
                for tri in me.loop_triangles:
                    roof_bvh_tris.append((base_v + tri.vertices[0], base_v + tri.vertices[1], base_v + tri.vertices[2]))
            if z_lo < float("inf"):
                prev = role_z.get(r_name, [float("inf"), float("-inf")])
                role_z[r_name] = [min(prev[0], z_lo), max(prev[1], z_hi)]
            eo.to_mesh_clear()

        warnings = []
        if "BASE" in role_z and "BODY" in role_z:
            gap = role_z["BODY"][0] - role_z["BASE"][1]
            if gap > 0.005:
                warnings.append(
                    f"FLOATING_BODY_GAP: BODY bottom z={role_z['BODY'][0]:.4f} floats {gap*1000:.1f} mm above BASE top z={role_z['BASE'][1]:.4f}! Extend BODY bottom down to BASE top."
                )

        roof_center_hit = None
        if roof_bvh_verts and roof_bvh_tris:
            bvh = BVHTree.FromPolygons(roof_bvh_verts, roof_bvh_tris)
            hit_loc, _, _, _ = bvh.ray_cast(Vector((cx_mid, cy_mid, all_maxs[2] + 0.5)), Vector((0.0, 0.0, -1.0)), all_maxs[2] - all_mins[2] + 1.0)
            roof_center_hit = hit_loc is not None
            if not roof_center_hit:
                warnings.append(
                    f"OPEN_CENTER_ROOF_NOTICE: Vertical ray at scene center ({cx_mid:.3f}, {cy_mid:.3f}) did not hit ROOF. Check top_roof_check.png to verify whether this building is an open courtyard/arena or has an unclosed roof."
                )

        sym_ratio = round(min(left_verts, right_verts) / max(1, max(left_verts, right_verts)), 3)
        if sym_ratio < 0.72 and (left_verts + right_verts) > 500:
            warnings.append(
                f"ASYMMETRY_NOTICE: Left (-X) verts={left_verts:,} vs Right (+X) verts={right_verts:,} (ratio={sym_ratio}). If the reference building is symmetric, check loop signs (`for sgn in (-1, 1)`)."
            )

        return {
            "roof_center_sealed": roof_center_hit,
            "lr_symmetry_ratio": sym_ratio,
            "warnings": warnings,
        }

    def render_inspection_sheet(out_dir="preview", ortho_margin=1.18, samples=32, resolution=(1200, 960)):
        """Render 4 orthographic studio clay projections (`hero_elevated`, `front_ortho`, `side_ortho`, `top_roof_check`).

        【相机几何原理与透视遮挡消除】：
        当相机机位高度低于屋檐（`z_cam < z_eave`）时，向外挑出的飞檐在投影几何上会形成遮挡阴影锥（Occlusion Cone），
        使屋檐上方的屋面、山花和正脊处于完全不可见盲区。
        本函数测量全场景包围盒跨度 `(dx, dy, dz)`，使用无透视畸变的正交投影（`ORTHO`）：
        1. `hero_elevated.png`：机位架设在 `(cx + 1.15*span, cy - 1.75*span, z_min + max(1.65*dz, 1.05*span))`（俯角约 32°），完整看清屋顶瓦面与立面体量；
        2. `front_ortho.png`（沿 `+Y` 正视 X-Z 面）& `side_ortho.png`（沿 `-X` 正视 Y-Z 面）：直接与 `three-views.png` 像素级比对高宽比与轴线对齐；
        3. `top_roof_check.png`（沿 `-Z` 垂直俯视 X-Y 面）：直接与俯视图比对屋面交汇脊线、平面轮廓及中心闭合性。
        """
        out_p = Path(out_dir)
        out_p.mkdir(parents=True, exist_ok=True)
        bpy.context.view_layer.update()
        deps = bpy.context.evaluated_depsgraph_get()

        mins = [float("inf")] * 3
        maxs = [float("-inf")] * 3
        has_v = False
        for obj in bpy.context.scene.objects:
            if obj.type == "MESH" and not obj.hide_render and obj.data and len(obj.data.vertices) > 0:
                eo = obj.evaluated_get(deps)
                me = eo.to_mesh()
                mw = eo.matrix_world
                for v in me.vertices:
                    w = mw @ v.co
                    for k in range(3):
                        if w[k] < mins[k]:
                            mins[k] = w[k]
                        if w[k] > maxs[k]:
                            maxs[k] = w[k]
                    has_v = True
                eo.to_mesh_clear()
        if not has_v:
            return []

        cx, cy, cz = (0.5 * (mins[k] + maxs[k]) for k in range(3))
        dx, dy, dz = (max(0.05, maxs[k] - mins[k]) for k in range(3))
        span = max(dx, dy, dz)

        sc = bpy.context.scene
        if sc.world is None:
            sc.world = bpy.data.worlds.new("Inspection_Studio")
        sc.world.use_nodes = True
        bg = sc.world.node_tree.nodes.get("Background")
        if bg is not None:
            bg.inputs[0].default_value = (0.24, 0.25, 0.27, 1.0)
            bg.inputs[1].default_value = 0.65

        created_helpers = []
        for lname, pos, energy, lsize in [
            ("_insp_key", (cx - 1.5 * span, cy - 1.6 * span, mins[2] + 2.4 * span), 110.0, 1.6 * span),
            ("_insp_fill", (cx + 1.4 * span, cy - 0.6 * span, mins[2] + 1.1 * span), 48.0, 1.3 * span),
            ("_insp_rim", (cx + 0.3 * span, cy + 1.6 * span, mins[2] + 1.9 * span), 85.0, 1.1 * span),
        ]:
            old_l = bpy.data.objects.get(lname)
            if old_l is not None:
                bpy.data.objects.remove(old_l, do_unlink=True)
            ldata = bpy.data.lights.new(lname, "AREA")
            ldata.energy = energy
            ldata.size = max(0.2, lsize)
            lobj = bpy.data.objects.new(lname, ldata)
            sc.collection.objects.link(lobj)
            lobj.location = Vector(pos)
            lobj.rotation_euler = (Vector((cx, cy, cz)) - lobj.location).to_track_quat("-Z", "Y").to_euler()
            created_helpers.append(lobj)

        cam_data = bpy.data.cameras.new("_insp_cam_data")
        cam_data.type = "ORTHO"
        cam_data.clip_start = 0.005
        cam_data.clip_end = max(50.0, span * 25.0)
        cam_obj = bpy.data.objects.new("_insp_cam", cam_data)
        sc.collection.objects.link(cam_obj)
        prev_cam = sc.camera
        sc.camera = cam_obj
        created_helpers.append(cam_obj)

        sc.render.engine = "CYCLES"
        sc.cycles.samples = max(16, int(samples))
        sc.cycles.use_denoising = True
        sc.render.resolution_x = int(resolution[0])
        sc.render.resolution_y = int(resolution[1])
        sc.render.resolution_percentage = 100
        sc.render.image_settings.file_format = "PNG"

        views = [
            (
                "hero_elevated",
                (cx + 1.15 * span, cy - 1.75 * span, mins[2] + max(1.65 * dz, 1.05 * span)),
                (cx, cy, cz),
                max(dx, dy, dz) * float(ortho_margin) * 1.12,
            ),
            (
                "front_ortho",
                (cx, cy - 2.4 * span, cz),
                (cx, cy, cz),
                max(dx, dz * 1.25) * float(ortho_margin),
            ),
            (
                "side_ortho",
                (cx + 2.4 * span, cy, cz),
                (cx, cy, cz),
                max(dy, dz * 1.25) * float(ortho_margin),
            ),
            (
                "top_roof_check",
                (cx, cy, mins[2] + 3.5 * span),
                (cx, cy, mins[2]),
                max(dx, dy * 1.22) * float(ortho_margin),
            ),
        ]
        rendered_paths = []
        for vname, loc, tgt, o_scale in views:
            cam_obj.location = Vector(loc)
            if vname == "top_roof_check":
                cam_obj.rotation_euler = Euler((0.0, 0.0, 0.0), "XYZ")
            else:
                cam_obj.rotation_euler = (Vector(tgt) - cam_obj.location).to_track_quat("-Z", "Y").to_euler()
            cam_data.ortho_scale = o_scale
            fpath = out_p / f"{vname}.png"
            sc.render.filepath = str(fpath)
            bpy.ops.render.render(write_still=True)
            rendered_paths.append(str(fpath))

        sc.camera = prev_cam
        for h in created_helpers:
            if h.name in bpy.data.objects:
                bpy.data.objects.remove(h, do_unlink=True)
        return rendered_paths
