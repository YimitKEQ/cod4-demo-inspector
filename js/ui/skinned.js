/*!
 * skinned.js - the player models as real skinned meshes, so they can move.
 *
 * glb.js bakes every model into one static geometry, which is right for props
 * and wrong for people: a soldier baked in his rest pose can only slide. This
 * reads the same GLB files but keeps the skeleton, so the game's own
 * animations (tools/xanim.js) can drive it.
 *
 * A body and a head are separate files that share one skeleton by bone name,
 * the way the game assembles them. The template merges both skeletons into one
 * hierarchy and binds each mesh to the bones it names, so the head follows the
 * neck without any glue.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
(function (root) {
"use strict";

const ROOT_BONE = "__skel";

/** Scene roots of a parsed GLB, falling back to every top level node. */
function sceneRoots(json){
  const scene = json.scenes && json.scenes[json.scene || 0];
  if (scene) return scene.nodes;
  const children = new Set();
  json.nodes.forEach(n => (n.children || []).forEach(c => children.add(c)));
  return json.nodes.map((_, i) => i).filter(i => !children.has(i));
}

/** Merge the skeleton nodes of several parts into one list, parents first. */
function mergeSkeleton(parts){
  const nodes = [];
  const seen = new Set([ROOT_BONE]);
  nodes.push({ name: ROOT_BONE, parent: null, t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] });
  for (const { json } of parts) {
    const walk = (i, parentName, isRoot) => {
      const n = json.nodes[i];
      if (!n || n.mesh !== undefined) return;
      /* Each file has its own container node at the top ("..._skel"), always
         an identity; they collapse into one shared root. */
      const name = isRoot ? ROOT_BONE : n.name;
      if (!seen.has(name)) {
        seen.add(name);
        nodes.push({ name, parent: parentName,
                     t: n.translation || [0, 0, 0], r: n.rotation || [0, 0, 0, 1],
                     s: n.scale || [1, 1, 1] });
      }
      for (const c of (n.children || [])) walk(c, name, false);
    };
    for (const r of sceneRoots(json)) walk(r, null, true);
  }
  return nodes;
}

/** One part's geometry with its skin attributes, in bind space. */
function skinnedGeometry(THREE, json, bin){
  const read = (i) => root.DM1_GLB.readAccessor(json, bin, i);
  const pos = [], nor = [], uvs = [], jnt = [], wgt = [], idx = [];
  const groups = [];
  let skin = null;
  for (const n of json.nodes) {
    if (n.mesh === undefined) continue;
    if (n.skin !== undefined) skin = json.skins[n.skin];
    for (const prim of json.meshes[n.mesh].primitives) {
      const a = prim.attributes;
      const p = read(a.POSITION);
      if (!p || a.JOINTS_0 === undefined || a.WEIGHTS_0 === undefined) continue;
      const nn = a.NORMAL !== undefined ? read(a.NORMAL) : null;
      const uv = a.TEXCOORD_0 !== undefined ? read(a.TEXCOORD_0) : null;
      const j = read(a.JOINTS_0), w = read(a.WEIGHTS_0);
      const wAcc = json.accessors[a.WEIGHTS_0];
      /* Weights may be stored as normalised bytes or shorts. */
      const wScale = wAcc.componentType === 5121 ? 1 / 255 : wAcc.componentType === 5123 ? 1 / 65535 : 1;
      const base = pos.length / 3;
      for (let i = 0; i < p.length / 3; i++) {
        pos.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
        nor.push(nn ? nn[i * 3] : 0, nn ? nn[i * 3 + 1] : 1, nn ? nn[i * 3 + 2] : 0);
        uvs.push(uv ? uv[i * 2] : 0, uv ? uv[i * 2 + 1] : 0);
        for (let k = 0; k < 4; k++) { jnt.push(j[i * 4 + k]); wgt.push(w[i * 4 + k] * wScale); }
      }
      const start = idx.length;
      const ix = prim.indices !== undefined ? read(prim.indices) : null;
      if (ix) for (let i = 0; i < ix.length; i++) idx.push(base + ix[i]);
      else for (let i = 0; i < p.length / 3; i++) idx.push(base + i);
      groups.push({ start, count: idx.length - start });
    }
  }
  if (!pos.length || !skin) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(jnt, 4));
  geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(wgt, 4));
  geo.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1)
                                      : new THREE.Uint16BufferAttribute(idx, 1));
  groups.forEach((g, i) => geo.addGroup(g.start, g.count, i));
  geo.computeBoundingSphere();

  const joints = skin.joints.map(i => json.nodes[i].name);
  const ibm = read(skin.inverseBindMatrices);
  return { geometry: geo, joints, ibm };
}

/**
 * Load body and head into one reusable template.
 * The materials come from glb.js so textures resolve exactly as they do for
 * props; its baked geometry is thrown away.
 */
function loadTemplate(THREE, urls){
  return Promise.all(urls.map(url => fetch(url)
    .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error("missing " + url))))
    .then(buf => root.DM1_GLB.parseContainer(buf))))
    .then(parsed => {
      const parts = parsed.filter(p => p && p.bin);
      const meshes = [];
      for (const p of parts) {
        const g = skinnedGeometry(THREE, p.json, p.bin);
        if (!g) continue;
        const baked = root.DM1_GLB.build(THREE, p.json, p.bin);
        g.materials = baked ? baked.materials : [new THREE.MeshStandardMaterial({ color: 0x8A8A80 })];
        if (baked) baked.geometry.dispose();
        meshes.push(g);
      }
      if (!meshes.length) throw new Error("no skinned meshes in " + urls.join(", "));
      return { nodes: mergeSkeleton(parts), meshes };
    });
}

/**
 * One soldier from a template: its own bones, shared geometry, its own
 * material copies so one player can fade without fading his team.
 */
function instantiate(THREE, template){
  const bones = new Map();
  const rest = new Map();
  let top = null;
  for (const n of template.nodes) {
    const b = new THREE.Bone();
    b.name = n.name;
    b.position.set(n.t[0], n.t[1], n.t[2]);
    b.quaternion.set(n.r[0], n.r[1], n.r[2], n.r[3]);
    b.scale.set(n.s[0], n.s[1], n.s[2]);
    rest.set(n.name, { p: b.position.clone(), q: b.quaternion.clone() });
    bones.set(n.name, b);
    if (n.parent && bones.has(n.parent)) bones.get(n.parent).add(b);
    else top = b;
  }

  const group = new THREE.Group();
  group.add(top);
  const meshes = [];
  for (const m of template.meshes) {
    const mats = m.materials.map(src => { const c = src.clone(); c.transparent = true; return c; });
    const mesh = new THREE.SkinnedMesh(m.geometry, mats);
    const list = [], inverses = [];
    m.joints.forEach((name, i) => {
      const b = bones.get(name);
      list.push(b || top);
      inverses.push(new THREE.Matrix4().fromArray(m.ibm, i * 16));
    });
    group.add(mesh);
    mesh.bind(new THREE.Skeleton(list, inverses), new THREE.Matrix4());
    /* A skinned mesh's bounds are its bind pose; an animated one wanders
       outside them, and culling on the stale sphere pops limbs out of view. */
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    meshes.push(mesh);
  }
  return { group, meshes, bones, rest };
}

const API = { loadTemplate, instantiate, mergeSkeleton, ROOT_BONE };
if (typeof module === "object" && module.exports) module.exports = API;
root.DM1_SKINNED = API;

})(typeof globalThis !== "undefined" ? globalThis : this);
