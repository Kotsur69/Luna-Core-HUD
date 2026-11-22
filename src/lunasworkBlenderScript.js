// ============================================================================
// LunaCore - Luna's Work Blender export script (luna_asset_blender)
// ----------------------------------------------------------------------------
// Builds the Python the Blender MCP add-on runs for blenderModel
// (src/lunasworkAssetPipeline.js):
//
//   save        the open scene is saved as a copy to art/blender/<slug>.blend
//               (the untouched source, before any pass below)
//   toon pass   stylePass "blade-bullet-toon": the triangle count is held to a
//               poly budget (an applied Decimate when over it), the root is
//               zeroed and its scale applied, a character's height is checked
//               against 1.6 m, and an inverted-hull outline is added (Solidify
//               with negative thickness, flipped normals, material offset to a
//               black backface-culled outline material)
//   turntable   a fast Workbench sheet for the Critic's style check: front and
//               right-side orthographic, 3/4 perspective and a flat black-on-
//               gray silhouette, side by side in one PNG strip
//               (design/asset-renders/<slug>.png)
//   export      FBX for Unity (-Z forward, Y up, scale applied)
//
// Every value that ends up in the Python source is either a validated number
// or a JSON string literal (valid Python), set once in a header; the Python
// body itself is a constant. A model or a tool never writes Python here.
// ============================================================================

'use strict';

const path = require('path');

const STYLE_PASSES = Object.freeze(['none', 'blade-bullet-toon']);
const DEFAULT_STYLE_PASS = 'none';
const TOON_PASS = 'blade-bullet-toon';
// Triangle budgets when the call names none: props (and other models) vs. characters.
const PROP_POLY_BUDGET = 15000;
const CHARACTER_POLY_BUDGET = 25000;
const POLY_BUDGETS = Object.freeze({ character: CHARACTER_POLY_BUDGET, environment: CHARACTER_POLY_BUDGET, prop: PROP_POLY_BUDGET, model: PROP_POLY_BUDGET });
const MIN_POLY_BUDGET = 100;
const MAX_POLY_BUDGET = 1000000;
const CHARACTER_HEIGHT_M = 1.6;
const HEIGHT_TOLERANCE_M = 0.08;
const OUTLINE_THICKNESS_M = 0.015;
// The turntable sheet: four square panels side by side, so it is 4:1.
const TURNTABLE_PANEL_PX = 512;
const TURNTABLE_VIEWS = Object.freeze(['front', 'side', 'three-quarter', 'silhouette']);
const REPORT_MARK = 'LUNACORE_REPORT ';
const MAX_REPORT_CHARS = 20000;
const MAX_WARNINGS = 8;
const MAX_WARNING_CHARS = 200;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Width and height in the IHDR chunk: big-endian uint32 at bytes 16 and 20.
const IHDR_WIDTH_AT = 16;
const IHDR_HEIGHT_AT = 20;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const oneLine = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, max);

/**
 * The luna_asset_blender style options, validated at the tool boundary.
 * @param {object} raw the tool arguments (untrusted)
 * @returns {{ok:true, stylePass:string, polyBudget:number|null}|{ok:false, error:string, detail:string}}
 */
function cleanStyleOptions(raw) {
  const r = isObj(raw) ? raw : {};
  const stylePass = r.stylePass === undefined || r.stylePass === null ? DEFAULT_STYLE_PASS : r.stylePass;
  if (typeof stylePass !== 'string' || !STYLE_PASSES.includes(stylePass)) {
    return { ok: false, error: 'badStylePass', detail: `stylePass must be one of ${STYLE_PASSES.join(', ')}` };
  }
  const budget = r.polyBudget;
  if (budget === undefined || budget === null) return { ok: true, stylePass, polyBudget: null };
  if (!Number.isSafeInteger(budget) || budget < MIN_POLY_BUDGET || budget > MAX_POLY_BUDGET) {
    return { ok: false, error: 'badPolyBudget', detail: `polyBudget must be a whole number of triangles from ${MIN_POLY_BUDGET} to ${MAX_POLY_BUDGET}` };
  }
  return { ok: true, stylePass, polyBudget: budget };
}

/** The triangle budget of a `kind`: the asked one, else the kind's default. */
function polyBudgetFor(kind, polyBudget) {
  if (Number.isSafeInteger(polyBudget) && polyBudget >= MIN_POLY_BUDGET && polyBudget <= MAX_POLY_BUDGET) return polyBudget;
  return Object.prototype.hasOwnProperty.call(POLY_BUDGETS, kind) ? POLY_BUDGETS[kind] : PROP_POLY_BUDGET;
}

/** True when `buf` starts with the PNG signature. */
const isPng = (buf) => Buffer.isBuffer(buf) && buf.length >= PNG_MAGIC.length && buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);

/** True for a PNG whose header says it is a turntable strip (four square panels: width = 4 x height). */
function isTurntableSheet(buf) {
  if (!isPng(buf) || buf.length < IHDR_HEIGHT_AT + 4) return false;
  const width = buf.readUInt32BE(IHDR_WIDTH_AT);
  const height = buf.readUInt32BE(IHDR_HEIGHT_AT);
  return height > 0 && width === height * TURNTABLE_VIEWS.length;
}

// ---- the Python ---------------------------------------------------------------------------

// The passes as a constant Python body: everything variable comes from the header.
const PY_HELPERS = String.raw`
import json
import math
import os
from mathutils import Vector

LUNA_REPORT = {'warnings': []}

def luna_warn(text):
    LUNA_REPORT['warnings'].append(str(text)[:200])

def luna_meshes():
    return [o for o in bpy.context.scene.objects if o.type == 'MESH' and not o.name.startswith('LunaTurntable')]

def luna_override(o):
    return bpy.context.temp_override(object=o, active_object=o, selected_objects=[o], selected_editable_objects=[o])

def luna_outline_shown(objs, shown):
    for o in objs:
        m = o.modifiers.get('LunaOutline')
        if m is not None:
            m.show_viewport = shown
            m.show_render = shown
    bpy.context.view_layer.update()

def luna_tris(objs):
    dg = bpy.context.evaluated_depsgraph_get()
    total = 0
    for o in objs:
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        try:
            me.calc_loop_triangles()
            total += len(me.loop_triangles)
        finally:
            ev.to_mesh_clear()
    return total

def luna_bounds(objs):
    dg = bpy.context.evaluated_depsgraph_get()
    pts = []
    for o in objs:
        ev = o.evaluated_get(dg)
        pts.extend(ev.matrix_world @ Vector(c) for c in ev.bound_box)
    if not pts:
        return Vector((0.0, 0.0, 0.0)), Vector((1.0, 1.0, 1.0))
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return (lo + hi) * 0.5, hi - lo

def luna_decimate(objs):
    total = luna_tris(objs)
    LUNA_REPORT['polyBudget'] = POLY_BUDGET
    LUNA_REPORT['trisBefore'] = total
    LUNA_REPORT['decimateRatio'] = None
    if total > POLY_BUDGET:
        ratio = POLY_BUDGET / total
        LUNA_REPORT['decimateRatio'] = round(ratio, 4)
        for o in objs:
            mod = o.modifiers.new(name='LunaDecimate', type='DECIMATE')
            mod.decimate_type = 'COLLAPSE'
            mod.ratio = ratio
            try:
                with luna_override(o):
                    bpy.ops.object.modifier_move_to_index(modifier=mod.name, index=0)
                    bpy.ops.object.modifier_apply(modifier=mod.name)
            except Exception as err:
                # Kept as a modifier: the FBX export applies it (use_mesh_modifiers).
                luna_warn('decimate not applied on %s (kept as a modifier): %s' % (o.name, err))
        bpy.context.view_layer.update()
    LUNA_REPORT['trisAfter'] = luna_tris(objs)

def luna_roots():
    roots = [o for o in bpy.context.scene.objects if o.parent is None and o.type in {'MESH', 'ARMATURE', 'EMPTY'} and not o.name.startswith('LunaTurntable')]
    LUNA_REPORT['roots'] = len(roots)
    LUNA_REPORT['rootZeroed'] = None
    if len(roots) == 1:
        r = roots[0]
        r.location = (0.0, 0.0, 0.0)
        r.rotation_euler = (0.0, 0.0, 0.0)
        r.rotation_quaternion = (1.0, 0.0, 0.0, 0.0)
        r.rotation_axis_angle = (0.0, 0.0, 1.0, 0.0)
        LUNA_REPORT['rootZeroed'] = r.name
    elif roots:
        luna_warn('%d root objects: their location and rotation were kept' % len(roots))
    for r in roots:
        if tuple(round(s, 6) for s in r.scale) == (1.0, 1.0, 1.0):
            continue
        try:
            with luna_override(r):
                bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        except Exception as err:
            luna_warn('scale not applied on %s: %s' % (r.name, err))
    bpy.context.view_layer.update()

def luna_height(objs):
    center, size = luna_bounds(objs)
    height = round(size.z, 3)
    LUNA_REPORT['height'] = height
    LUNA_REPORT['heightTarget'] = CHARACTER_HEIGHT
    LUNA_REPORT['heightTolerance'] = HEIGHT_TOLERANCE
    LUNA_REPORT['heightOk'] = abs(height - CHARACTER_HEIGHT) <= HEIGHT_TOLERANCE

def luna_outline_material():
    mat = bpy.data.materials.get('LunaOutline')
    if mat is None:
        mat = bpy.data.materials.new('LunaOutline')
    mat.diffuse_color = (0.0, 0.0, 0.0, 1.0)
    mat.use_backface_culling = True
    if mat.use_nodes and mat.node_tree is not None:
        bsdf = mat.node_tree.nodes.get('Principled BSDF')
        if bsdf is not None:
            bsdf.inputs['Base Color'].default_value = (0.0, 0.0, 0.0, 1.0)
    return mat

def luna_outline(objs):
    mat = luna_outline_material()
    done = 0
    for o in objs:
        slots = o.data.materials
        names = [m.name if m is not None else None for m in slots]
        if 'LunaOutline' not in names:
            if len(slots) == 0:
                # The model's own faces keep slot 0; the outline is the last slot.
                slots.append(None)
            slots.append(mat)
            names = [m.name if m is not None else None for m in slots]
        mod = o.modifiers.get('LunaOutline')
        if mod is None:
            mod = o.modifiers.new(name='LunaOutline', type='SOLIDIFY')
        mod.thickness = -OUTLINE_THICKNESS
        mod.offset = -1.0
        mod.use_flip_normals = True
        mod.use_rim = False
        mod.material_offset = names.index('LunaOutline')
        mod.show_viewport = True
        mod.show_render = True
        done += 1
    LUNA_REPORT['outlined'] = done

def luna_turntable(objs):
    import numpy as np
    scene = bpy.context.scene
    rs = scene.render
    sh = scene.display.shading
    saved = (rs.engine, rs.resolution_x, rs.resolution_y, rs.resolution_percentage, rs.filepath, rs.image_settings.file_format,
             rs.film_transparent, scene.camera, scene.world, sh.light, sh.color_type, tuple(sh.single_color), sh.show_object_outline)
    world = bpy.data.worlds.new('LunaTurntableWorld')
    world.color = (0.5, 0.5, 0.5)
    cam_data = bpy.data.cameras.new('LunaTurntableCam')
    cam = bpy.data.objects.new('LunaTurntableCam', cam_data)
    scene.collection.objects.link(cam)
    try:
        rs.engine = 'BLENDER_WORKBENCH'
        rs.resolution_x = PANEL_PX
        rs.resolution_y = PANEL_PX
        rs.resolution_percentage = 100
        rs.image_settings.file_format = 'PNG'
        rs.film_transparent = False
        scene.camera = cam
        scene.world = world
        center, size = luna_bounds(objs)
        span = max(size.x, size.y, size.z, 0.01) * 1.15
        views = [('ORTHO', Vector((0.0, -1.0, 0.0)), False), ('ORTHO', Vector((1.0, 0.0, 0.0)), False),
                 ('PERSP', Vector((1.0, -1.0, 0.6)).normalized(), False), ('ORTHO', Vector((0.0, -1.0, 0.0)), True)]
        for i, (cam_type, direction, silhouette) in enumerate(views):
            cam_data.type = cam_type
            cam_data.ortho_scale = span
            dist = span * 0.5 / math.tan(cam_data.angle * 0.5) + span if cam_type == 'PERSP' else span * 2.0
            cam_data.clip_start = 0.01
            cam_data.clip_end = dist + span * 4.0
            cam.location = center + direction * dist
            cam.rotation_euler = (-direction).to_track_quat('-Z', 'Y').to_euler()
            sh.light = 'FLAT' if silhouette else 'STUDIO'
            sh.color_type = 'SINGLE' if silhouette else 'MATERIAL'
            sh.single_color = (0.0, 0.0, 0.0)
            sh.show_object_outline = not silhouette
            rs.filepath = PANEL_PATHS[i]
            bpy.ops.render.render(write_still=True)
        sheet = np.zeros((PANEL_PX, PANEL_PX * len(PANEL_PATHS), 4), dtype=np.float32)
        for i, panel in enumerate(PANEL_PATHS):
            img = bpy.data.images.load(panel, check_existing=False)
            try:
                if tuple(img.size) != (PANEL_PX, PANEL_PX):
                    raise RuntimeError('panel %d is %r, not %d px square' % (i, tuple(img.size), PANEL_PX))
                px = np.empty(PANEL_PX * PANEL_PX * 4, dtype=np.float32)
                img.pixels.foreach_get(px)
                sheet[:, i * PANEL_PX:(i + 1) * PANEL_PX, :] = px.reshape(PANEL_PX, PANEL_PX, 4)
            finally:
                bpy.data.images.remove(img)
        out = bpy.data.images.new('LunaTurntableSheet', PANEL_PX * len(PANEL_PATHS), PANEL_PX, alpha=False)
        try:
            out.pixels.foreach_set(sheet.ravel())
            out.filepath_raw = SHEET_PATH
            out.file_format = 'PNG'
            out.save()
        finally:
            bpy.data.images.remove(out)
        LUNA_REPORT['render'] = 'ok'
    finally:
        (rs.engine, rs.resolution_x, rs.resolution_y, rs.resolution_percentage, rs.filepath, rs.image_settings.file_format,
         rs.film_transparent, scene.camera, scene.world, sh.light, sh.color_type, sh.single_color, sh.show_object_outline) = saved
        bpy.data.objects.remove(cam)
        bpy.data.cameras.remove(cam_data)
        bpy.data.worlds.remove(world)
        for panel in PANEL_PATHS:
            if os.path.isfile(panel):
                os.remove(panel)
`;

const PY_TOON = String.raw`
LUNA_REPORT['stylePass'] = STYLE_PASS
luna_objs = luna_meshes()
luna_outline_shown(luna_objs, False)
luna_decimate(luna_objs)
luna_roots()
if KIND == 'character':
    luna_height(luna_objs)
luna_outline(luna_objs)
`;

const PY_RENDER = String.raw`
try:
    luna_turntable(luna_meshes())
except Exception as err:
    LUNA_REPORT['render'] = 'failed'
    luna_warn('turntable render failed: %s' % err)
`;

/** A path as a Python string literal: forward slashes, JSON-escaped (valid Python). */
const pyPath = (p) => JSON.stringify(String(p).split(path.sep).join('/'));

/** The validated script options; throws on a value that must never reach Python. */
function scriptOptions(options) {
  const o = isObj(options) ? options : {};
  const style = cleanStyleOptions(o);
  if (!style.ok) throw new Error(style.detail);
  const kind = o.kind === undefined || o.kind === null ? 'model' : o.kind;
  if (typeof kind !== 'string' || !/^[a-z]{1,20}$/.test(kind)) throw new Error('kind must be a plain lower-case word');
  let render = null;
  if (o.render !== undefined && o.render !== null) {
    const r = o.render;
    const okPath = (p) => typeof p === 'string' && path.isAbsolute(p);
    if (!isObj(r) || !okPath(r.sheet) || !Array.isArray(r.panels) || r.panels.length !== TURNTABLE_VIEWS.length || !r.panels.every(okPath)) {
      throw new Error(`render needs an absolute sheet path and ${TURNTABLE_VIEWS.length} absolute panel paths`);
    }
    render = { sheet: r.sheet, panels: [...r.panels] };
  }
  return { kind, stylePass: style.stylePass, polyBudget: polyBudgetFor(kind, style.polyBudget), render };
}

/** The Python header: every variable value, as a number or a JSON literal. */
function pyHeader(o) {
  const lines = [
    `STYLE_PASS = ${JSON.stringify(o.stylePass)}`,
    `KIND = ${JSON.stringify(o.kind)}`,
    `POLY_BUDGET = ${String(o.polyBudget)}`,
    `CHARACTER_HEIGHT = ${String(CHARACTER_HEIGHT_M)}`,
    `HEIGHT_TOLERANCE = ${String(HEIGHT_TOLERANCE_M)}`,
    `OUTLINE_THICKNESS = ${String(OUTLINE_THICKNESS_M)}`,
    `PANEL_PX = ${String(TURNTABLE_PANEL_PX)}`,
  ];
  if (o.render) {
    lines.push(`SHEET_PATH = ${pyPath(o.render.sheet)}`, `PANEL_PATHS = [${o.render.panels.map(pyPath).join(', ')}]`);
  }
  return lines;
}

/**
 * The Python the Blender MCP add-on runs: save the open scene as a copy, run
 * the style pass and the turntable render when asked, then export FBX for
 * Unity. The two-argument call keeps the plain save + export script.
 * @param {string} blendAbs
 * @param {string} fbxAbs
 * @param {{kind?:string, stylePass?:string, polyBudget?:number|null,
 *   render?:{sheet:string, panels:string[]}|null}} [options]
 * @returns {string}
 */
function blenderExportScript(blendAbs, fbxAbs, options) {
  const o = scriptOptions(options);
  const toon = o.stylePass === TOON_PASS;
  const extra = toon || o.render;
  return [
    'import bpy',
    ...(extra ? pyHeader(o) : []),
    `bpy.ops.wm.save_as_mainfile(filepath=${pyPath(blendAbs)}, copy=True)`,
    ...(extra ? [PY_HELPERS.trim()] : []),
    ...(toon ? [PY_TOON.trim()] : []),
    ...(o.render ? [PY_RENDER.trim()] : []),
    `bpy.ops.export_scene.fbx(filepath=${pyPath(fbxAbs)}, use_selection=False,`,
    "    object_types={'ARMATURE', 'MESH', 'EMPTY'}, apply_unit_scale=True, apply_scale_options='FBX_SCALE_ALL',",
    "    axis_forward='-Z', axis_up='Y', bake_space_transform=True, add_leaf_bones=False,",
    "    mesh_smooth_type='FACE', use_mesh_modifiers=True, bake_anim=True, path_mode='COPY', embed_textures=True)",
    ...(extra ? [`print(${JSON.stringify(REPORT_MARK)} + json.dumps(LUNA_REPORT))`] : []),
    "print('LUNACORE_EXPORT_OK')",
  ].join('\n');
}

// ---- the script's answer ------------------------------------------------------------------

/** The text the add-on sent back: a string, or the captured output in `result`. */
function outputText(result) {
  if (typeof result === 'string') return result;
  if (isObj(result) && typeof result.result === 'string') return result.result;
  if (isObj(result) && typeof result.output === 'string') return result.output;
  return '';
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);

/**
 * The script's LUNACORE_REPORT line, validated (it crossed a boundary). Null
 * when there is none or it does not parse.
 * @returns {null|{stylePass:string|null, polyBudget:number|null, trisBefore:number|null, trisAfter:number|null,
 *   decimateRatio:number|null, roots:number|null, rootZeroed:string|null, outlined:number|null,
 *   height:number|null, heightTarget:number|null, heightOk:boolean|null, render:string|null, warnings:string[]}}
 */
function parseScriptReport(result) {
  const text = outputText(result).slice(-MAX_REPORT_CHARS);
  const at = text.lastIndexOf(REPORT_MARK);
  if (at < 0) return null;
  let raw;
  try {
    raw = JSON.parse(text.slice(at + REPORT_MARK.length).split('\n')[0]);
  } catch {
    return null;
  }
  if (!isObj(raw)) return null;
  return {
    stylePass: STYLE_PASSES.includes(raw.stylePass) ? raw.stylePass : null,
    polyBudget: int(raw.polyBudget),
    trisBefore: int(raw.trisBefore),
    trisAfter: int(raw.trisAfter),
    decimateRatio: num(raw.decimateRatio),
    roots: int(raw.roots),
    rootZeroed: typeof raw.rootZeroed === 'string' ? oneLine(raw.rootZeroed, 80) : null,
    outlined: int(raw.outlined),
    height: num(raw.height),
    heightTarget: num(raw.heightTarget),
    heightOk: typeof raw.heightOk === 'boolean' ? raw.heightOk : null,
    render: raw.render === 'ok' || raw.render === 'failed' ? raw.render : null,
    warnings: (Array.isArray(raw.warnings) ? raw.warnings : []).slice(0, MAX_WARNINGS).map((w) => oneLine(w, MAX_WARNING_CHARS)).filter(Boolean),
  };
}

/** The notes a report gives the worker: an off-height character, Blender's warnings. */
function reportNotes(report) {
  if (!report) return [];
  const notes = [];
  if (report.heightOk === false) {
    notes.push(`The character is ${report.height} m tall, outside ${CHARACTER_HEIGHT_M} m +/- ${HEIGHT_TOLERANCE_M} m: rescale it in Blender and export again.`);
  }
  if (report.warnings.length) notes.push(`Blender: ${report.warnings.join('; ')}.`);
  return notes;
}

module.exports = {
  STYLE_PASSES,
  DEFAULT_STYLE_PASS,
  TOON_PASS,
  PROP_POLY_BUDGET,
  CHARACTER_POLY_BUDGET,
  MIN_POLY_BUDGET,
  MAX_POLY_BUDGET,
  CHARACTER_HEIGHT_M,
  HEIGHT_TOLERANCE_M,
  TURNTABLE_PANEL_PX,
  TURNTABLE_VIEWS,
  cleanStyleOptions,
  polyBudgetFor,
  isPng,
  isTurntableSheet,
  blenderExportScript,
  parseScriptReport,
  reportNotes,
};
