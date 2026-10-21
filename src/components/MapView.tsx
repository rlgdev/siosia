// Declarative wrapper over Leaflet (OSM tiles, FR-010/FR-033). The map fills the screen behind the
// sheets (FR-072). Markers are divIcons (no image assets); the car rotates to its heading.

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";
import type { MapEndpoints } from "../config";
import type { LatLng } from "../core/types";
import { iconSvg, normalPaint, profileIcon } from "./profileIcons";

export type MarkerKind = "pickup" | "dropoff" | "car" | "nearby" | "rider" | "me";

export interface MapMarker {
  id: string;
  kind: MarkerKind;
  pos: LatLng;
  heading?: number | null;
  stale?: boolean;
  draggable?: boolean;
  onDragEnd?: (p: LatLng) => void;
  title?: string;
  /** Profile icon id: a rider or driver with one is drawn as that icon instead of the dot / car. */
  icon?: string | null;
  /** 2.1: the car's paint (#rrggbb): the driver's car is drawn in it (FR-170). */
  paint?: string | null;
}

export interface MapViewProps {
  endpoints: MapEndpoints;
  center: LatLng;
  zoom?: number;
  markers: MapMarker[];
  accuracy?: { pos: LatLng; radius: number } | null;
  route?: LatLng[] | null;
  routeEstimate?: boolean;
  /** When this key changes the map fits `fitPoints`. */
  fitKey?: string;
  fitPoints?: LatLng[];
  onTap?: (p: LatLng) => void;
  onLongPress?: (p: LatLng) => void;
  /** Extra bottom padding (px) so fitted content is not hidden under the sheet. */
  bottomInset?: number;
  label: string;
}

/** Is this #rrggbb light (a white, silver or yellow car needs a dark outline on the map)? */
const light = (hex: string) => [1, 3, 5].reduce((sum, i, k) => sum + parseInt(hex.slice(i, i + 2), 16) * [0.299, 0.587, 0.114][k], 0) > 170;
const carSvg = (paint: string | null) =>
  `<svg viewBox="0 0 32 32" width="34" height="34" aria-hidden="true"><g><rect x="9" y="3" width="14" height="26" rx="6" fill="${paint ?? "#14161a"}" stroke="${paint && light(paint) ? "#14161a" : "#fff"}" stroke-width="2"/><rect x="11" y="8" width="10" height="6" rx="2" fill="#9fd8ff"/><rect x="11" y="20" width="10" height="4" rx="1.5" fill="#9fd8ff" opacity=".8"/></g></svg>`;
const NEARBY_SVG = `<svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true"><rect x="9" y="3" width="14" height="26" rx="6" fill="#4b5563" stroke="#fff" stroke-width="2"/><rect x="11" y="8" width="10" height="6" rx="2" fill="#d1d5db"/></svg>`;

function iconFor(m: MapMarker): L.DivIcon {
  const rot = m.heading ?? 0;
  switch (m.kind) {
    case "pickup":
      return L.divIcon({ className: "pin pin-pickup", html: `<span class="pin-dot"></span>`, iconSize: [28, 28], iconAnchor: [14, 14] });
    case "dropoff":
      return L.divIcon({ className: "pin pin-dropoff", html: `<span class="pin-square"></span>`, iconSize: [28, 28], iconAnchor: [14, 14] });
    case "rider": {
      const def = profileIcon(m.icon);
      if (def)
        return L.divIcon({ className: `rider-icon${m.stale ? " is-stale" : ""}`, html: `<span>${def.svg}</span>`, iconSize: [64, 32], iconAnchor: [32, 16] });
      return L.divIcon({ className: `pin pin-rider${m.stale ? " is-stale" : ""}`, html: `<span class="pulse"></span><span class="pin-core"></span>`, iconSize: [24, 24], iconAnchor: [12, 12] });
    }
    case "me":
      return L.divIcon({ className: "pin pin-me", html: `<span class="pin-core"></span>`, iconSize: [22, 22], iconAnchor: [11, 11] });
    case "nearby":
      return L.divIcon({ className: "car car-nearby", html: `<span style="transform:rotate(${rot}deg)">${NEARBY_SVG}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] });
    case "car":
    default: {
      // A side-view profile icon faces the way the car drives (left or right).
      const def = profileIcon(m.icon);
      if (def)
        return L.divIcon({
          className: `rider-icon car-icon${m.stale ? " is-stale" : ""}`,
          html: `<span style="transform:scaleX(${rot > 180 && rot < 360 ? -1 : 1})">${iconSvg(def, m.paint)}</span>`,
          iconSize: [64, 32],
          iconAnchor: [32, 16]
        });
      return L.divIcon({ className: `car${m.stale ? " is-stale" : ""}`, html: `<span class="car-rot" style="transform:rotate(${rot}deg)">${carSvg(normalPaint(m.paint))}</span>`, iconSize: [34, 34], iconAnchor: [17, 17] });
    }
  }
}

const iconKey = (m: MapMarker) => `${m.kind}|${Math.round(m.heading ?? 0)}|${m.stale ? 1 : 0}|${m.icon ?? ""}|${m.paint ?? ""}`;

export function MapView(props: MapViewProps) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layers = useRef(new Map<string, { marker: L.Marker; key: string; dragging: boolean }>());
  const acc = useRef<L.Circle | null>(null);
  const route = useRef<L.Polyline | null>(null);
  const handlers = useRef(props);
  handlers.current = props;

  // Create once.
  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, {
      zoomControl: false,
      attributionControl: false,
      center: [props.center.lat, props.center.lng],
      zoom: props.zoom ?? 15
    });
    L.control.zoom({ position: "topright" }).addTo(m);
    // Attribution stays visible above the bottom sheet (FR-033).
    L.control.attribution({ position: "topleft", prefix: '<a href="https://leafletjs.com">Leaflet</a>' }).addTo(m);
    L.tileLayer(props.endpoints.tileUrl, {
      attribution: props.endpoints.tileAttribution,
      maxZoom: props.endpoints.tileMaxZoom,
      crossOrigin: true
    }).addTo(m);
    m.on("click", (e: L.LeafletMouseEvent) => handlers.current.onTap?.({ lat: e.latlng.lat, lng: e.latlng.lng }));
    m.on("contextmenu", (e: L.LeafletMouseEvent) => handlers.current.onLongPress?.({ lat: e.latlng.lat, lng: e.latlng.lng }));
    map.current = m;
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => m.invalidateSize()) : null;
    ro?.observe(el.current);
    const layerMap = layers.current;
    return () => {
      ro?.disconnect();
      m.remove();
      map.current = null;
      layerMap.clear();
      acc.current = null;
      route.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Markers.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const seen = new Set<string>();
    for (const mk of props.markers) {
      seen.add(mk.id);
      const existing = layers.current.get(mk.id);
      const k = iconKey(mk);
      if (existing) {
        // Never move a pin the user is dragging (a GPS re-render would snap it back mid-drag).
        if (!existing.dragging) existing.marker.setLatLng([mk.pos.lat, mk.pos.lng]);
        if (existing.key !== k) {
          existing.marker.setIcon(iconFor(mk));
          existing.key = k;
        }
        if (mk.draggable) existing.marker.dragging?.enable();
        else {
          existing.marker.dragging?.disable(); // Leaflet drops dragend here, so clear the flag
          existing.dragging = false;
        }
      } else {
        const marker = L.marker([mk.pos.lat, mk.pos.lng], {
          icon: iconFor(mk),
          draggable: !!mk.draggable,
          keyboard: false,
          title: mk.title,
          zIndexOffset: mk.kind === "car" ? 1000 : mk.kind === "pickup" || mk.kind === "dropoff" ? 500 : 0
        }).addTo(m);
        const entry = { marker, key: k, dragging: false };
        marker.on("dragstart", () => {
          entry.dragging = true;
        });
        marker.on("dragend", () => {
          entry.dragging = false;
          const ll = marker.getLatLng();
          const current = handlers.current.markers.find((x) => x.id === mk.id);
          current?.onDragEnd?.({ lat: ll.lat, lng: ll.lng });
        });
        layers.current.set(mk.id, entry);
      }
    }
    for (const [id, { marker }] of layers.current) {
      if (!seen.has(id)) {
        marker.remove();
        layers.current.delete(id);
      }
    }
  }, [props.markers]);

  // Accuracy circle (FR-030).
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const a = props.accuracy;
    if (!a) {
      acc.current?.remove();
      acc.current = null;
      return;
    }
    if (!acc.current) acc.current = L.circle([a.pos.lat, a.pos.lng], { radius: a.radius, className: "accuracy", interactive: false }).addTo(m);
    else acc.current.setLatLng([a.pos.lat, a.pos.lng]).setRadius(a.radius);
  }, [props.accuracy]);

  // Route line.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const line = props.route;
    if (!line || line.length < 2) {
      route.current?.remove();
      route.current = null;
      return;
    }
    const latlngs = line.map((p) => [p.lat, p.lng] as [number, number]);
    const cls = props.routeEstimate ? "route route-estimate" : "route";
    if (!route.current) route.current = L.polyline(latlngs, { className: cls, interactive: false }).addTo(m);
    else route.current.setLatLngs(latlngs);
    route.current.getElement()?.setAttribute("class", `leaflet-interactive ${cls}`);
  }, [props.route, props.routeEstimate]);

  // Fit to the important points when the scene changes.
  useEffect(() => {
    const m = map.current;
    if (!m || !props.fitKey) return;
    const pts = (props.fitPoints ?? []).filter(Boolean);
    if (pts.length === 1) m.setView([pts[0].lat, pts[0].lng], Math.max(m.getZoom(), 15));
    else if (pts.length > 1)
      m.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng] as [number, number])), {
        paddingTopLeft: [40, 70],
        paddingBottomRight: [40, (props.bottomInset ?? 0) + 40],
        maxZoom: 16
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fitKey]);

  return <div ref={el} className="map" role="application" aria-label={props.label} />;
}
