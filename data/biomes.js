// data/biomes.js
// Biome classification as a PURE function of (temperature, moisture, elevation, waterDepth) —
// a Whittaker-style diagram (Appendix H). Biomes set the autotroph productivity backdrop and
// the sensory background against which coloration reads (camouflage/warning). No color-only
// encoding: each biome carries an id, a name, an icon glyph, and a CSS token as well as a hue.

export const BIOME = {
  OCEAN: 0, REEF: 1, WETLAND: 2, GRASSLAND: 3, FOREST: 4, RAINFOREST: 5,
  SAVANNA: 6, DESERT: 7, TUNDRA: 8, ICE: 9, ALPINE: 10, VOLCANIC: 11,
};

// Display metadata. `token` maps to a CSS custom property; `icon` gives a non-color affordance.
export const BIOME_META = [
  { id: 0, key: 'OCEAN', name: 'Ocean', icon: '≈', token: '--biome-ocean', productivity: 0.5, albedo: 0.08 },
  { id: 1, key: 'REEF', name: 'Reef / Shallows', icon: '✶', token: '--biome-reef', productivity: 1.2, albedo: 0.10 },
  { id: 2, key: 'WETLAND', name: 'Wetland', icon: '⌇', token: '--biome-forest', productivity: 1.3, albedo: 0.12 },
  { id: 3, key: 'GRASSLAND', name: 'Grassland', icon: '„', token: '--biome-forest', productivity: 0.9, albedo: 0.20 },
  { id: 4, key: 'FOREST', name: 'Forest', icon: '♣', token: '--biome-forest', productivity: 1.1, albedo: 0.15 },
  { id: 5, key: 'RAINFOREST', name: 'Rainforest', icon: '❦', token: '--biome-forest', productivity: 1.5, albedo: 0.13 },
  { id: 6, key: 'SAVANNA', name: 'Savanna', icon: '‸', token: '--biome-desert', productivity: 0.8, albedo: 0.24 },
  { id: 7, key: 'DESERT', name: 'Desert', icon: '∴', token: '--biome-desert', productivity: 0.2, albedo: 0.35 },
  { id: 8, key: 'TUNDRA', name: 'Tundra', icon: '⁙', token: '--biome-tundra', productivity: 0.35, albedo: 0.30 },
  { id: 9, key: 'ICE', name: 'Ice Sheet', icon: '❄', token: '--biome-ice', productivity: 0.02, albedo: 0.60 },
  { id: 10, key: 'ALPINE', name: 'Alpine', icon: '▲', token: '--biome-tundra', productivity: 0.3, albedo: 0.32 },
  { id: 11, key: 'VOLCANIC', name: 'Volcanic', icon: '⋔', token: '--biome-volcanic', productivity: 0.15, albedo: 0.10 },
];

// Classify a cell. temperature in °C, moisture in [0,1] (annual precip proxy), elevation in
// arbitrary units where 0 == sea level, waterDepth > 0 for submerged cells.
export function classifyBiome(temperature, moisture, elevation, waterDepth) {
  if (waterDepth > 0) {
    // Aquatic: shallow warm water => reef; else open ocean. Frozen surface => ice.
    if (temperature < -2) return BIOME.ICE;
    if (waterDepth < 0.15 && temperature > 18) return BIOME.REEF;
    return BIOME.OCEAN;
  }
  // Land.
  if (temperature < -5) return BIOME.ICE;
  if (elevation > 2.2) return temperature < 2 ? BIOME.ALPINE : BIOME.TUNDRA;
  if (temperature < 2) return BIOME.TUNDRA;

  if (temperature > 24) {
    if (moisture > 0.7) return BIOME.RAINFOREST;
    if (moisture > 0.4) return BIOME.FOREST;
    if (moisture > 0.2) return BIOME.SAVANNA;
    return BIOME.DESERT;
  }
  if (temperature > 10) {
    if (moisture > 0.75) return BIOME.WETLAND;
    if (moisture > 0.45) return BIOME.FOREST;
    if (moisture > 0.22) return BIOME.GRASSLAND;
    return BIOME.DESERT;
  }
  // Cool.
  if (moisture > 0.4) return BIOME.FOREST;
  if (moisture > 0.18) return BIOME.GRASSLAND;
  return BIOME.TUNDRA;
}

export function biomeProductivity(biomeId) {
  return BIOME_META[biomeId] ? BIOME_META[biomeId].productivity : 0.5;
}
export function biomeAlbedo(biomeId) {
  return BIOME_META[biomeId] ? BIOME_META[biomeId].albedo : 0.2;
}
export function biomeName(biomeId) {
  return BIOME_META[biomeId] ? BIOME_META[biomeId].name : 'Unknown';
}
