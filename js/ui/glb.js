/*!
 * glb.js - just enough glTF to load the props.
 *
 * three.js ships GLTFLoader as an add-on module, and the pinned UMD build has
 * no add-ons at all, so rather than restructure the whole app around modules
 * this reads the small part of the format the prop models actually use:
 * positions, normals, texture coordinates, indices, one material per
 * primitive, and images embedded in the binary chunk.
 *
 * Node transforms are baked into the vertices as the hierarchy is walked,
 * because the models are static props and an instanced draw wants one
 * geometry, not a tree. That matters for more than tidiness: the palm tree
 * carries its Z up to Y up conversion as a rotation on its root node, so
 * ignoring node transforms lays it on its side.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
(function (root) {
"use strict";

const COMPONENT = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array,
  5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array
};
const COMPONENTS_PER = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/* Every model's colour maps live in one folder, because the same wall texture
   is shared by a dozen props and downloading it once per model would be
   absurd. */
const IMAGE_BASE = "maps3d/images/";

/* Material names carry variant suffixes like "desertshrubs#0". A hash in a URL
   starts the fragment, so the browser would request "desertshrubs" and throw
   away the extension with it. tools/modeltex.js writes the files through the
   same mapping. */
const safeName = n => String(n).replace(/[^\w.-]/g, "_");

/** Split the container into its JSON and binary chunks. */
function parseContainer(buffer){
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== 0x46546c67) return null;   // "glTF"
  const total = dv.getUint32(8, true);
  let p = 12, json = null, bin = null;
  while (p + 8 <= total) {
    const len = dv.getUint32(p, true);
    const type = dv.getUint32(p + 4, true);
    const start = p + 8;
    if (type === 0x4e4f534a) {
      json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, start, len)));
    } else if (type === 0x004e4942) {
      bin = new Uint8Array(buffer, start, len);
    }
    p = start + len + ((4 - (len % 4)) % 4);
  }
  return json ? { json, bin } : null;
}

/** One accessor as a typed array, honouring the buffer view's stride. */
function readAccessor(json, bin, index){
  const acc = json.accessors[index];
  if (!acc) return null;
  const Type = COMPONENT[acc.componentType];
  const per = COMPONENTS_PER[acc.type] || 1;
  if (!Type) return null;

  if (acc.bufferView === undefined) return new Type(acc.count * per);
  const view = json.bufferViews[acc.bufferView];
  const base = (view.byteOffset || 0) + (acc.byteOffset || 0);
  const stride = view.byteStride || 0;

  if (!stride || stride === per * Type.BYTES_PER_ELEMENT) {
    return new Type(bin.buffer, bin.byteOffset + base, acc.count * per);
  }
  /* Interleaved: copy element by element. */
  const out = new Type(acc.count * per);
  const dv = new DataView(bin.buffer, bin.byteOffset);
  const get = {
    5126: (o) => dv.getFloat32(o, true), 5125: (o) => dv.getUint32(o, true),
    5123: (o) => dv.getUint16(o, true), 5122: (o) => dv.getInt16(o, true),
    5121: (o) => dv.getUint8(o), 5120: (o) => dv.getInt8(o)
  }[acc.componentType];
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < per; c++) {
      out[i * per + c] = get(base + i * stride + c * Type.BYTES_PER_ELEMENT);
    }
  }
  return out;
}

/**
 * Build one merged geometry plus its materials.
 *
 * Every primitive in the file becomes a group on a single geometry, so an
 * instanced draw can render the whole prop with a material array.
 */
function build(THREE, json, bin){
  const positions = [], normals = [], uvs = [], indices = [];
  const groups = [];
  const materialOf = [];

  const M = new THREE.Matrix4();
  const N = new THREE.Matrix3();
  const v = new THREE.Vector3();

  const nodeMatrix = node => {
    const m = new THREE.Matrix4();
    if (node.matrix) return m.fromArray(node.matrix);
    const t = node.translation || [0, 0, 0];
    const r = node.rotation || [0, 0, 0, 1];
    const s = node.scale || [1, 1, 1];
    return m.compose(new THREE.Vector3(t[0], t[1], t[2]),
                     new THREE.Quaternion(r[0], r[1], r[2], r[3]),
                     new THREE.Vector3(s[0], s[1], s[2]));
  };

  const addPrimitive = (prim, world) => {
    const pos = readAccessor(json, bin, prim.attributes.POSITION);
    if (!pos) return;
    const nor = prim.attributes.NORMAL !== undefined
      ? readAccessor(json, bin, prim.attributes.NORMAL) : null;
    const uv = prim.attributes.TEXCOORD_0 !== undefined
      ? readAccessor(json, bin, prim.attributes.TEXCOORD_0) : null;
    const idx = prim.indices !== undefined
      ? readAccessor(json, bin, prim.indices) : null;

    const base = positions.length / 3;
    N.getNormalMatrix(world);
    for (let i = 0; i < pos.length / 3; i++) {
      v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyMatrix4(world);
      positions.push(v.x, v.y, v.z);
      if (nor) {
        v.set(nor[i * 3], nor[i * 3 + 1], nor[i * 3 + 2]).applyMatrix3(N).normalize();
        normals.push(v.x, v.y, v.z);
      } else {
        normals.push(0, 1, 0);
      }
      uvs.push(uv ? uv[i * 2] : 0, uv ? uv[i * 2 + 1] : 0);
    }

    const start = indices.length;
    if (idx) {
      for (let i = 0; i < idx.length; i++) indices.push(base + idx[i]);
    } else {
      for (let i = 0; i < pos.length / 3; i++) indices.push(base + i);
    }
    groups.push({ start, count: indices.length - start });
    materialOf.push(prim.material === undefined ? -1 : prim.material);
  };

  const walk = (nodeIndex, parent) => {
    const node = json.nodes[nodeIndex];
    if (!node) return;
    const world = new THREE.Matrix4().multiplyMatrices(parent, nodeMatrix(node));
    if (node.mesh !== undefined && json.meshes[node.mesh]) {
      for (const prim of json.meshes[node.mesh].primitives) addPrimitive(prim, world);
    }
    for (const child of (node.children || [])) walk(child, world);
  };

  const scene = json.scenes && json.scenes[json.scene || 0];
  const roots = scene ? scene.nodes : json.nodes.map((_, i) => i);
  for (const r of roots) walk(r, M);

  if (!positions.length) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(positions.length / 3 > 65535
    ? new THREE.Uint32BufferAttribute(indices, 1)
    : new THREE.Uint16BufferAttribute(indices, 1));
  geo.computeBoundingSphere();

  /* Images live in the binary chunk; a blob URL is the shortest route from
     there to a texture. */
  const textureCache = new Map();
  const textureFor = matIndex => {
    const mat = json.materials && json.materials[matIndex];
    const tex = mat && mat.pbrMetallicRoughness &&
                mat.pbrMetallicRoughness.baseColorTexture;
    if (!tex) return null;
    if (textureCache.has(tex.index)) return textureCache.get(tex.index);
    const src = json.textures[tex.index];
    const image = src && json.images[src.source];
    let out = null;
    if (image && image.bufferView !== undefined) {
      const view = json.bufferViews[image.bufferView];
      const bytes = bin.slice(view.byteOffset || 0,
                              (view.byteOffset || 0) + view.byteLength);
      const blob = new Blob([bytes], { type: image.mimeType || "image/png" });
      out = new THREE.TextureLoader().load(URL.createObjectURL(blob));
      out.colorSpace = THREE.SRGBColorSpace;
      out.wrapS = THREE.RepeatWrapping;
      out.wrapT = THREE.RepeatWrapping;
    } else if (image && image.uri) {
      /* The exporter names images as .dds files sitting beside the model, and
         writes neither the files nor a format a browser could decode. The real
         images were pulled out of the game's archives instead, as PNG, into
         one shared folder keyed by the same bare name: see tools/modeltex.js.
         Without this every prop and every character draws flat grey. */
      const bare = image.uri.split("/").pop().replace(/\.[^.]+$/, "").toLowerCase();
      out = new THREE.TextureLoader().load(IMAGE_BASE + safeName(bare) + ".webp");
      out.colorSpace = THREE.SRGBColorSpace;
      out.wrapS = THREE.RepeatWrapping;
      out.wrapT = THREE.RepeatWrapping;
      out.flipY = false;
    }
    textureCache.set(tex.index, out);
    return out;
  };

  const materials = [];
  groups.forEach((g, i) => {
    geo.addGroup(g.start, g.count, i);
    const mi = materialOf[i];
    const src = json.materials && json.materials[mi];
    const map = mi >= 0 ? textureFor(mi) : null;
    materials.push(new THREE.MeshStandardMaterial({
      color: map ? 0xFFFFFF : 0x9AA08E,
      map,
      roughness: 0.9,
      metalness: 0,
      /* Foliage is cut out with alpha, so it has to test rather than blend or
         the leaves draw as solid cards. */
      /* Foliage is cut out with alpha and has to be seen from both sides;
         solid props do not, and drawing them twice is wasted fill. */
      alphaTest: (src && src.alphaMode === "MASK") ? (src.alphaCutoff || 0.5) : 0.35,
      transparent: false,
      side: (src && src.doubleSided) ? THREE.DoubleSide : THREE.FrontSide
    }));
  });

  return { geometry: geo, materials, triangles: indices.length / 3 };
}

/** Fetch and build one model. */
function load(THREE, url){
  return fetch(url)
    .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error("missing " + url))))
    .then(buf => {
      const parsed = parseContainer(buf);
      if (!parsed || !parsed.bin) throw new Error("not a binary glTF: " + url);
      const built = build(THREE, parsed.json, parsed.bin);
      if (!built) throw new Error("no geometry in " + url);
      return built;
    });
}

const API = { load, build, parseContainer, readAccessor };
if (typeof module === "object" && module.exports) module.exports = API;
root.DM1_GLB = API;

})(typeof globalThis !== "undefined" ? globalThis : this);
