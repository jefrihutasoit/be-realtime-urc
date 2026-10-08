// Keep in sync with oee-realtime-urc/src/types/layout.ts

/** A machine's position on the plant layout, as fractions (0–1) of the image width and height. */
export interface LayoutMarker {
  machineId: string;
  x: number;
  y: number;
}

export interface PlantLayout {
  /** Backend path of the layout image (e.g. "/uploads/layout/x.png"); null when none is uploaded. */
  image: string | null;
  markers: LayoutMarker[];
  updatedAt: string | null;
}
