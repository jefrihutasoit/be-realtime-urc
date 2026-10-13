// Keep in sync with oee-realtime-urc/src/types/layout.ts

/** A machine's position on the plant layout, as fractions (0–1) of the image width and height. */
export interface LayoutMarker {
  machineId: string;
  x: number;
  y: number;
}

/** Camera of the 3D layout in scene metres: where it stands and the floor point it looks at. */
export interface LayoutView {
  position: [x: number, y: number, z: number];
  target: [x: number, y: number, z: number];
}

/** How machine status is shown on the 3D layout: pulsing floor rings, or a glowing LED dot. */
export const LAYOUT_INDICATORS = ["ring", "led"] as const;
export type LayoutIndicator = (typeof LAYOUT_INDICATORS)[number];

/** Allowed marker scale (labels and status symbols on the 3D layout); 1 is the normal size. */
export const MARKER_SIZE_RANGE = { min: 0.4, max: 1.5 } as const;

/** How the 3D layout looks; part of the settings backup. */
export interface LayoutDisplay {
  view: LayoutView | null;
  indicator: LayoutIndicator;
  markerSize: number;
}

export interface PlantLayout {
  /** Backend path of the layout image (e.g. "/uploads/layout/x.png"); null when none is uploaded. */
  image: string | null;
  markers: LayoutMarker[];
  /** Default camera of the 3D layout, set in Settings; null fits the whole plant automatically. */
  view: LayoutView | null;
  indicator: LayoutIndicator;
  /** Scale of the machine labels and status symbols (MARKER_SIZE_RANGE); smaller avoids overlap. */
  markerSize: number;
  updatedAt: string | null;
}
