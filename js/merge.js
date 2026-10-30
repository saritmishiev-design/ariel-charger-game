// Draw-call reduction for static sub-assemblies (car body, wheels, billboards, grandstands).
import * as THREE from '../vendor/three.module.min.js';

/** Merge a group's direct mesh children that share a material into single meshes (fewer draw calls). */
export function mergeByMaterial(group) {
  const lists = new Map();
  for (const m of group.children) {
    if (!m.isMesh || m.children.length || Array.isArray(m.material)) continue;
    const key = `${m.material.uuid}|${m.castShadow}|${m.renderOrder}`;
    if (!lists.has(key)) lists.set(key, []);
    lists.get(key).push(m);
  }
  for (const list of lists.values()) {
    if (list.length < 2) continue;
    const pos = [], nor = [], uv = [];
    for (const m of list) {
      m.updateMatrix();
      const g = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()).applyMatrix4(m.matrix);
      pos.push(...g.attributes.position.array);
      nor.push(...g.attributes.normal.array);
      if (g.attributes.uv) uv.push(...g.attributes.uv.array);
      else for (let i = 0; i < g.attributes.position.count; i++) uv.push(0, 0);
      group.remove(m);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    const merged = new THREE.Mesh(geo, list[0].material);
    merged.castShadow = list[0].castShadow;
    merged.receiveShadow = list[0].receiveShadow;
    merged.renderOrder = list[0].renderOrder;
    group.add(merged);
  }
}
