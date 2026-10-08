// Keep in sync with oee-realtime-urc/src/types/tag.ts

/** One reading of a gateway tag as stored in `tag_values`. Values are kept as text. */
export interface TagReading {
  id: number;
  tagName: string;
  value: string;
  timestamp: string;
}

/** Body of POST /tag-values. `timestamp` defaults to the server time. */
export interface TagPush {
  tagName: string;
  value: string | number;
  timestamp?: string;
}
