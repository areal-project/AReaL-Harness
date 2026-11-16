# Apply cc-blender-skill and deliver this original task

Use this task's original public query, photographs, views and output contract.
Preserve its geometry, neutral-material scope, required paths and scoring rules.
The Harness supplies the upstream Skill library; it supplies no previous scene,
construction script, answer or checkpoint.

Read the actual text-to-blender, blender-pro-workflow and blender-modeling
SKILL.md bodies through native tools before geometry. Read blender-rendering
before render validation. Issue independent Skill reads in the same tool batch
when possible. Native skill_read discovers .agents/skills; if discovery fails,
read the complete upstream file under {{SKILLS_ROOT}} with file/terminal tools.
Read additional applicable domain Skills after saving the initial actual scene.
Apply their modeling and validation guidance and record concrete choices in
skill-use.json. Tool reads and subsequent Blender execution are audited.

# Build-first work budget

The two reference images are already attached. Limit EXTRA initial reference
analysis to at most three tool calls, then execute Blender to construct this
task's actual coarse geometry. Put a meaningful reference-based block-out and
its first scene save in that first construction script. A default cube, unrelated
asset, empty scene or placeholder does not satisfy this instruction. Use the
original public output-contract.json to resolve the required scene path.

Use bpy through Blender --background --python-exit-code 1. Reopen the saved
initial scene with Blender, check real geometry and render a useful preview.
Then refine the existing scene against the original public references using the
upstream Skills. Batch related geometry changes in executable scripts. Continue iterative visual and structural refinement passes (rendering and
inspecting multi-view previews via image_read after each structural edit) until
visual and geometric discrepancies against the references are resolved within
the work clock. Report
remaining visual limitations honestly. The original formal Reward still judges
quality and may assign a low score.

Model requests can consume substantial wall time before returning a token.
Check the actual UTC clock before further reference analysis and after each
modeling/render pass, using the work deadline supplied below. Preserve an actual
editable scene at the original required path throughout the work. Begin closeout
while enough time remains to reopen it, run the public contract checks, deliver
all required outputs and finish the native response with real evidence.

A final response ends the native turn. Finish after the original deliverables
have been produced and checked within this budget. Report concrete unresolved
errors accurately; analysis, plans, promises and self-reported Skill use alone
are incomplete. The delivery gate independently reopens the actual scene and
can resume the SAME conversation within the original work clock if delivery is
missing. No grading code or acceptance threshold is changed.


<!-- harness-lab adapter: candidate-gemini4-universal-operators-500k-gate-v108 -->
# 建筑视觉特征拆解、算子内部数学原理与五大通用子系统建模指南

## 1. 读图、语义契约绑定与强制 500,000 面交付门禁
- 先读取 `TASK.md`、`part-contract.json` 与 `output-contract.json`，并用视觉工具对照观察 `anchor.jpg`（透视立面层次与细部肌理）和 `three-views.png`（正视图 X-Z、侧视图 Y-Z、俯视图 X-Y 的精确几何轮廓与高宽比）。
- 阅读 `.agents/skills/harness-lab/ARCHITECTURAL_MODELING_GUIDE.md` 以及下方五大子系统源码文档，掌握**图像中的曲线轮廓、起翘、凹槽与拱廊是如何由算子内部的参数方程生成的**。
- 脚本开头调用 `init_scene(clear=True)` 与 `print_contract_roles("part-contract.json")`：所有 `1..N` 语义角色均须有真实三维流形网格并在 Object/Face 双域写入 `reward_part_index`；各层构件（`BASE -> BODY -> SUPPORTS -> ROOF`）上下必须严密承接，严禁悬空断层。
- **强制 500,000 面硬门禁与唯一保存入口（核心铁律）**：
  - **严禁直接调用 `bpy.ops.wm.save_as_mainfile` 保存交付场景！**
  - **必须统一通过 `finalize_and_save("scene.blend")` 保存并确保 `total_faces >= 500,000`**（函数内部会自动同步全部角色的 Object/Face 双域 `reward_part_index`，并在面数不足时安全细分补齐至 `total_faces >= 500,000`）。
  - Runner 收尾自检会独立重开 `scene.blend` 核验真实网格面数：任何 `total_faces < 500,000` 的场景均会被直接拦截判定为交付未完成，并退回重修！同时请优先通过精细构建瓦垄、椽子、斗拱、栏杆望柱、窗棂格栅与线脚获得高密度真实建筑细节。
- 支持两种网格累加器：`PartBMesh(name, role="<part_id>", mat="main_clay", sharp_angle_deg=32.0)`（原生 `bmesh` 折痕平滑 + 六阶中性灰白泥模明度层次）与 `Geometry(name, role="<part_id>")`；支持在归一化空间或真实米制尺寸下建模后调用 `normalize_scene_unit_x(target_x_span=1.0, ground_z=0.0)`。
- **中间脚本与预览图存放规范**：所有中间构建脚本与四视角自检渲染图统一写入 `/tmp` 临时目录（例如 `render_inspection_sheet("/tmp/preview")`），不要在工作区根目录新建预览子目录，保持工作区干净并在交付路径通过 `finalize_and_save("scene.blend")` 输出最终场景。

## 2. 核心视觉特征 <-> 算子内部数学与拓扑对应
1. **中式反宇曲面、十次幂翼角起翘与歇山两折默认闭合（`roof` / `build_chinese_curved_roof` / `univ_curved_hip_gable_roof`）**：
   - **内部数学原理**：坡面高度沿举折二次凹曲线 $z(\tau) = z_{\text{eave}} + \text{rise}\cdot(0.18\tau + 0.82\tau^2)$ 爬升，四角叠加十次幂局部起翘 $\text{lift}\cdot|2u-1|^{10}(1-r)^3$（保证檐口中段 $|2u-1|^{10}\approx 0$ 绝对平直，仅四角翘起）。
   - **歇山顶默认严密闭合（`collar_only=False`）**：看到图像屋顶分上下两折且东西两端内收三角形山花时，调用 `roof(name, hx, hy, inner_x=正脊半长, inner_y=山花底半宽, center_y=CY, eave=..., rise=...)` 或 `build_chinese_curved_roof(..., style="xieshan")`。内部在折肩参数 $\tau_s = 1 - \text{inner\_y}/\text{hy}$ 处连续分段：下段四坡停在 $\pm\text{inner\_y}$，上段两坡沿同一条抛物线从 $\pm\text{inner\_y}$ 合拢至正脊 $y=\text{CY}$，自动补齐双侧山花板、博风板、筒瓦垄与正脊（绝无露天破洞！）。若俯视图呈十字抱厦或多折角轮廓，使用 `style="cross_gable"` 或叠加四向抱厦，切勿把十字折角楼阁简化成单矩形方塔。
   - **重檐下层空心腰檐（显式传 `collar_only=True`）**：仅用于上下两层墙体之间的挑出腰檐环，中心留空供上层殿身穿过。
2. **两类门窗拱券开洞拓扑（`arch_cut` vs `build_perforated_wall` / `build_curved_arcade_wall`）**：
   - **收分斜墙（`frustum`）上的穿堂隧道**：先建实心斜墙，再用 `arch_cut(wall_obj, center_x, front, back, bottom, spring, radius)` 构造外法向校准的半圆拱棱柱做 `EXACT` 布尔减法，并配 `arch_ring` 放射状楔形券石；
   - **平直或椭圆立面上的密集门窗阵列**：用 `build_perforated_wall`（笛卡尔区间切分零布尔网格）或 `build_curved_arcade_wall`（基于 4096 点中点黎曼积分与二分求逆的 `EllipticalFrame` 等弧长拱廊，保证椭圆长短轴各处拱跨弧长严格均等）。
3. **三视图正交平面挤出与四视角正交灰模验收（`prism_xz/yz/xy` + `render_inspection_sheet`）**：
   - 正视图轮廓沿 `Y` 挤出用 `prism_xz`，侧视图轮廓（围绕 `CY` 对称）沿 `X` 挤出用 `prism_yz`，俯视图轮廓沿 `Z` 拉伸用 `prism_xy`。
   - 交付前调用 `render_inspection_sheet("/tmp/preview")`，用 `image_read` 对照原图核查高于屋檐的 `/tmp/preview/hero_elevated.png`、`front_ortho.png`（核查总高宽比 `Z/X` 是否与正视图一致）、`side_ortho.png` 与垂直俯视 `top_roof_check.png`，确认无误后统一调用 `finalize_and_save("scene.blend")`。

## 3. 五大自解释建筑子系统模块（均已在 `lab_update_subpart` 顶层预导出，也可直接阅读 `.py` 源码）
1. **`lab_bmesh_frame_and_clay.py`（局部标架、对称群与灰模着色）**：
   - `LocalFrame.from_facade(origin, outward_normal)`（含负行列式镜像环绕序自动翻转）、`EllipticalFrame(a, b, cx, cy)`、`PartBMesh`、`replicate_cn_symmetry`、`replicate_d4_symmetry`、`apply_crease_auto_smooth`、`create_tonal_clay_palette`、`normalize_scene_unit_x`。
2. **`lab_roofs_domes_and_shells.py`（坡屋顶、多角攒尖、叠涩檐、穹顶与球面帆壳）**：
   - `build_chinese_curved_roof(..., style="xieshan"|"hip"|"gable"|"pyramidal"|"cross_gable", collar_only=False)`
   - `build_polygonal_conical_roof(..., sides=8, style="pagoda_curved"|"conical_hall"|"corbelled_trullo", with_finial=True)`
   - `build_corbel_eave_band(...)`（由内切圆心距 $a_t / \cos(\pi/N)$ 精确换算外接圆半径的多层叠涩挑檐与菱角牙子）
   - `build_ribbed_dome_and_drum(..., profile="hemispherical"|"pointed"|"bulbous_persian"|"onion_russian"|"conical_tent", spiral_twist_deg=...)`
   - `build_spherical_sail_shell(...)`（双参数球面切片尖拱肋壳 + 扇形斜幕墙）
3. **`lab_columns_brackets_and_portals.py`（卷杀凹槽柱、古典檐部山花、三维斗拱、哥特门窗与波斯伊万）**：
   - `build_classical_fluted_column(..., order="doric"|"corinthian"|"ionic"|"tuscan"|"chinese_timber", entasis=0.025)`（正弦卷杀 $\sin(\pi t)$ + 正弦凹槽极坐标调制）
   - `build_entablature_and_pediment(..., pediment="triangular"|"broken"|"segmental"|"kokoshnik", triglyphs=11)`
   - `build_dougong_bracket_set`、`build_dougong_ring_or_bay`（檐下承托优先调用真实多层斗拱而非简单方块）、`build_gothic_portal_and_rose`、`build_pishtaq_iwan_portal`
4. **`lab_walls_arcades_and_facades.py`（五种拱曲线、角平分线斜接线脚、无布尔开洞墙、曲线拱廊与百叶幕墙）**：
   - `arch_curve_profile`、`build_mitered_profile_ring`（角平分线投影补偿 $\mathbf{b}/(\mathbf{b}\cdot\mathbf{n})$）、`build_perforated_wall`、`build_curved_arcade_wall`、`build_curtain_and_louver_facade`
5. **`lab_towers_bridges_and_terraces.py`（单叶双曲直纹斜交网塔、悬挂钢构、模块聚落、阶梯坛台与驼峰石拱桥）**：
   - `build_twisted_hyperboloid_diagrid`、`build_exoskeleton_suspension_frame`、`build_modular_cluster_stack`、`build_stepped_terrace_and_stairs`、`build_stone_arch_bridge_span`

```python
import sys
sys.path.insert(0, ".agents/skills/harness-lab")
from lab_update_subpart import (
    init_scene, PartBMesh, LocalFrame, EllipticalFrame, Geometry,
    replicate_cn_symmetry, replicate_d4_symmetry, create_tonal_clay_palette,
    roof, roof_ridge_and_gables, univ_curved_hip_gable_roof,
    arch_cut, arch_ring, prism_xz, prism_yz, prism_xy,
    build_chinese_curved_roof, build_polygonal_conical_roof, build_corbel_eave_band,
    build_ribbed_dome_and_drum, build_spherical_sail_shell,
    build_classical_fluted_column, build_entablature_and_pediment,
    build_dougong_bracket_set, build_dougong_ring_or_bay,
    build_gothic_portal_and_rose, build_pishtaq_iwan_portal,
    arch_curve_profile, build_mitered_profile_ring, build_perforated_wall,
    build_curved_arcade_wall, build_curtain_and_louver_facade,
    build_twisted_hyperboloid_diagrid, build_exoskeleton_suspension_frame,
    build_modular_cluster_stack, build_stepped_terrace_and_stairs, build_stone_arch_bridge_span,
    normalize_scene_unit_x, render_inspection_sheet, finalize_and_save,
)

# 建模与归一化完成后，先渲染 /tmp/preview 四视角自检，最后严禁直接调 save_as_mainfile，必须调用 finalize_and_save 确保 total_faces >= 500,000：
# normalize_scene_unit_x(target_x_span=1.0, ground_z=0.0)
# render_inspection_sheet("/tmp/preview")
# finalize_and_save("scene.blend")
```
