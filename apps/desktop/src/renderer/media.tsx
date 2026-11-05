import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@heroui/react';
import { ExternalLink, MapPinOff, Maximize2, Minus, Plus, RotateCw, X } from 'lucide-react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Props } from './charts';
export function safeUrl(value: unknown): string | undefined {
  try {
    const u = new URL(String(value));
    return ['https:', 'http:'].includes(u.protocol) ? u.href : undefined;
  } catch {
    return undefined;
  }
}
export function Fullscreen({
  children,
  label = '全屏查看',
}: {
  children: ReactNode;
  label?: string;
}) {
  const [open, setOpen] = useState(false),
    [zoom, setZoom] = useState(1),
    [angle, setAngle] = useState(0),
    [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) {
      dialog.current?.showModal();
      setZoom(1);
      setPan({ x: 0, y: 0 });
      setAngle(0);
    } else dialog.current?.close();
  }, [open]);
  return (
    <div
      className="media-frame"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('figure')) setOpen(true);
      }}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && (e.target as HTMLElement).matches('figure')) {
          e.preventDefault();
          setOpen(true);
        }
      }}
    >
      <Button
        isIconOnly
        className="expand"
        size="sm"
        variant="secondary"
        onPress={() => setOpen(true)}
        aria-label={label}
      >
        <Maximize2 size={14} />
      </Button>
      {children}
      <dialog ref={dialog} className="fullscreen render-overlay" onCancel={() => setOpen(false)}>
        <div className="media-toolbar">
          <Button aria-label="缩小" onPress={() => setZoom((z) => Math.max(0.3, z - 0.2))}>
            <Minus size={16} />
          </Button>
          <Button aria-label="放大" onPress={() => setZoom((z) => Math.min(5, z + 0.2))}>
            <Plus size={16} />
          </Button>
          <Button aria-label="旋转" onPress={() => setAngle((a) => a + 90)}>
            <RotateCw size={16} />
          </Button>
          <Button
            variant="secondary"
            onPress={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
              setAngle(0);
            }}
          >
            复位
          </Button>
          <Button aria-label="关闭预览" onPress={() => setOpen(false)}>
            <X size={18} />
          </Button>
        </div>
        <div
          className="media-stage"
          onWheel={(e) => setZoom((z) => Math.max(0.3, Math.min(5, z - e.deltaY * 0.002)))}
          onPointerDown={(e) => {
            drag.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) =>
            drag.current &&
            setPan({
              x: e.clientX - drag.current.x,
              y: e.clientY - drag.current.y,
            })
          }
          onPointerUp={() => (drag.current = null)}
          onDoubleClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
        >
          <div
            style={{
              transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom}) rotate(${angle}deg)`,
              width: 'min(90vw,1000px)',
            }}
          >
            {open && children}
          </div>
        </div>
      </dialog>
    </div>
  );
}
export function ImageView({
  image,
  interactive = true,
}: {
  image: Props | string;
  interactive?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const item = typeof image === 'string' ? { src: image } : image;
  return (
    <figure
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={typeof image === 'string' ? '打开图片预览' : (image.alt ?? '打开图片预览')}
    >
      {safeUrl(item.src) && !failed ? (
        <img
          loading="lazy"
          src={safeUrl(item.src)}
          alt={item.alt ?? item.caption ?? '图片'}
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="empty">{item.alt ?? '图片暂不可用'}</div>
      )}
      {item.caption && <figcaption>{item.caption}</figcaption>}
    </figure>
  );
}
// An optional self-hosted Apple Maps page can communicate over postMessage.
// Without one, the live map uses Leaflet/OpenStreetMap.
const MAP_EMBED_URL: string = import.meta.env.VITE_MAP_EMBED_URL ?? '';
const embedOrigin = MAP_EMBED_URL ? new URL(MAP_EMBED_URL).origin : '';
type Place = Props & { latitude: number; longitude: number };
const located = (v: Props | undefined): v is Place =>
  !!v && Number.isFinite(v.latitude) && Number.isFinite(v.longitude);
/** Places plus every route form the catalog allows: point arrays, {points},
 *  {stopIds} referencing locations, and arcs {fromId,toId}. */
function geometry(p: Props) {
  const places: Place[] = (p.locations ?? []).filter(located);
  const byId = new Map(places.map((place) => [place.id, place]));
  const path = (route: Props): Props[] =>
    Array.isArray(route)
      ? route
      : (route.points ??
        (route.stopIds ?? (route.fromId ? [route.fromId, route.toId] : [])).map((id: string) =>
          byId.get(id),
        ));
  const paths = [...(p.routes ?? []), ...(p.arcs ?? [])]
    .map((route) => path(route).filter(located))
    .filter((points) => points.length > 1);
  return { places, paths };
}
// Maps are switched off for now: Apple's MapKit JS refuses requests from
// mainland China. Set to true to bring back the Apple Maps embed (with its
// Leaflet fallback); the agent's OPSIQUE_DISABLED=map hides Map as well.
const MAPS_ENABLED = false;
export function MapView({ p }: { p: Props }) {
  return MAPS_ENABLED ? <LiveMap p={p} /> : <MapOff p={p} />;
}
/** Keeps the places readable while the map itself is off. */
function MapOff({ p }: { p: Props }) {
  const { places } = geometry(p);
  return (
    <section className="map-off">
      {p.title && <h3>{p.title}</h3>}
      <div className="map-off-note">
        <MapPinOff size={18} />
        <div>
          <strong>当前不支持地图显示</strong>
          <p>已列出地点信息。</p>
        </div>
      </div>
      {places.length > 0 && (
        <ul>
          {places.map((place) => (
            <li key={place.id ?? place.title}>
              <strong>{place.title ?? place.id}</strong>
              {place.address && <span>{place.address}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
function LiveMap({ p }: { p: Props }) {
  const ref = useRef<HTMLDivElement>(null),
    frame = useRef<HTMLIFrameElement>(null),
    embedReady = useRef(false);
  const [selected, setSelected] = useState<Props | undefined>(
    p.locations?.find((l: Props) => l.id === p.initialLocationId) ?? p.locations?.[0],
  );
  const [engine, setEngine] = useState<'apple' | 'leaflet'>(MAP_EMBED_URL ? 'apple' : 'leaflet');
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || engine !== 'apple') return;
    const { places, paths } = geometry(p);
    const brand = getComputedStyle(element).getPropertyValue('--brand').trim() || '#079daa';
    const theme = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
    const post = (message: Props) =>
      frame.current?.contentWindow?.postMessage({ source: 'opsique-map', ...message }, embedOrigin);
    const render = () =>
      post({
        type: 'render',
        places: places.map(({ id, title, address, latitude, longitude }) => ({
          id,
          title,
          address,
          latitude,
          longitude,
        })),
        paths: paths.map((points) =>
          points.map(({ latitude, longitude }) => ({ latitude, longitude })),
        ),
        colorScheme: theme(),
        brand,
        selectedId: p.initialLocationId,
      });
    // The page must answer quickly; otherwise (offline, not deployed) use Leaflet.
    let timer = setTimeout(() => setEngine('leaflet'), 6000);
    const receive = (event: MessageEvent) => {
      const data = event.data;
      if (
        event.origin !== embedOrigin ||
        event.source !== frame.current?.contentWindow ||
        data?.source !== 'opsique-map'
      )
        return;
      if (data.type === 'ready') {
        embedReady.current = true;
        clearTimeout(timer);
        timer = setTimeout(() => setEngine('leaflet'), 10000);
        render();
      }
      if (data.type === 'rendered') {
        clearTimeout(timer);
        setDrawn(true);
      }
      if (data.type === 'error') {
        clearTimeout(timer);
        setEngine('leaflet');
      }
      if (data.type === 'select') setSelected(places.find((place) => place.id === data.id));
    };
    window.addEventListener('message', receive);
    if (embedReady.current) render();
    const themes = new MutationObserver(() => post({ type: 'theme', colorScheme: theme() }));
    themes.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => {
      clearTimeout(timer);
      themes.disconnect();
      window.removeEventListener('message', receive);
    };
  }, [p, engine]);
  useEffect(() => {
    const element = ref.current;
    if (!element || engine !== 'leaflet') return;
    const brand = getComputedStyle(element).getPropertyValue('--brand').trim() || '#079daa';
    const { places, paths } = geometry(p);
    const map = L.map(element, { scrollWheelZoom: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);
    for (const place of places)
      L.circleMarker([place.latitude, place.longitude], {
        radius: 9,
        color: '#fff',
        weight: 3,
        fillColor: brand,
        fillOpacity: 1,
      })
        .addTo(map)
        .bindTooltip(String(place.title ?? place.id))
        .on('click', () => setSelected(place));
    for (const points of paths)
      L.polyline(
        points.map((r) => [r.latitude, r.longitude] as L.LatLngTuple),
        { color: brand, weight: 3 },
      ).addTo(map);
    const bounds = [...places, ...paths.flat()].map(
      (r) => [r.latitude, r.longitude] as L.LatLngTuple,
    );
    if (bounds.length) map.fitBounds(L.latLngBounds(bounds), { padding: [40, 40], maxZoom: 13 });
    else map.setView([30.25, 120.15], 10);
    const obs = new ResizeObserver(() => map.invalidateSize());
    obs.observe(element);
    return () => {
      obs.disconnect();
      map.remove();
    };
  }, [p, engine]);
  return (
    <section>
      {p.title && <h3>{p.title}</h3>}
      <div ref={ref} className={'map ' + engine}>
        {engine === 'apple' && (
          <iframe
            ref={frame}
            src={MAP_EMBED_URL}
            title={p.title ?? '地图'}
            className={drawn ? 'drawn' : ''}
            sandbox="allow-scripts allow-same-origin allow-popups"
            referrerPolicy="origin"
          />
        )}
      </div>
      {selected && (
        <div className="surface inset">
          <strong>{selected.title}</strong>
          <p>{selected.address}</p>
          <p className="muted">{selected.description}</p>
          {selected.website && safeUrl(selected.website) && (
            <a href={safeUrl(selected.website)} target="_blank" rel="noreferrer">
              查看地点网站 <ExternalLink size={14} className="inline" />
            </a>
          )}
        </div>
      )}
    </section>
  );
}
export function FlowView({ p }: { p: Props }) {
  const [selected, setSelected] = useState<Props>();
  const nodes: Props[] = p.nodes ?? [],
    edges: Props[] = p.edges ?? [];
  const horizontal = p.direction === 'horizontal';
  const levels = new Map<string, number>(),
    incoming = new Set(edges.map((e) => e.to));
  let queue = nodes.filter((n) => !incoming.has(n.id));
  if (!queue.length && nodes.length) queue = [nodes[0]];
  for (const n of queue) levels.set(n.id, 0);
  while (queue.length) {
    const next: Props[] = [];
    for (const n of queue)
      for (const e of edges.filter((e) => e.from === n.id))
        if (!levels.has(e.to)) {
          levels.set(e.to, Math.min(10, (levels.get(n.id) ?? 0) + 1));
          const target = nodes.find((v) => v.id === e.to);
          if (target) next.push(target);
        }
    queue = next;
  }
  for (const n of nodes) if (!levels.has(n.id)) levels.set(n.id, 0);
  const used = new Map<number, number>();
  const positions = new Map(
    nodes.map((n) => {
      const level = levels.get(n.id) ?? 0,
        index = used.get(level) ?? 0;
      used.set(level, index + 1);
      return [
        n.id,
        {
          x: horizontal ? level * 215 + 30 : index * 215 + 30,
          y: horizontal ? index * 125 + 35 : level * 125 + 35,
        },
      ];
    }),
  );
  const width = Math.max(430, ...[...positions.values()].map((v) => v.x + 185)),
    height = Math.max(160, ...[...positions.values()].map((v) => v.y + 100));
  return (
    <section>
      {p.title && <h3>{p.title}</h3>}
      <div className="flow-scroll">
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          aria-label={p.title ?? '流程图'}
        >
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0 0 L10 5 L0 10Z" fill="#8ba4a8" />
            </marker>
          </defs>
          {edges.map((e, i) => {
            const a = positions.get(e.from),
              b = positions.get(e.to);
            if (!a || !b) return null;
            const x1 = a.x + (horizontal ? 170 : 85),
              y1 = a.y + (horizontal ? 30 : 60),
              x2 = b.x + (horizontal ? 0 : 85),
              y2 = b.y + (horizontal ? 30 : 0);
            return (
              <g key={i}>
                <path
                  d={`M${x1} ${y1} C${x1 + (horizontal ? 40 : 0)} ${y1 + (horizontal ? 0 : 40)},${x2 - (horizontal ? 40 : 0)} ${y2 - (horizontal ? 0 : 40)},${x2} ${y2}`}
                  fill="none"
                  stroke="#8ba4a8"
                  strokeWidth={2}
                  markerEnd="url(#arrow)"
                />
                <text x={(x1 + x2) / 2 + 5} y={(y1 + y2) / 2 - 5} fontSize="11" fill="currentColor">
                  {e.label}
                </text>
              </g>
            );
          })}
          {nodes.map((n) => {
            const v = positions.get(n.id)!;
            return (
              <g
                key={n.id}
                role="button"
                tabIndex={0}
                aria-label={n.label}
                onClick={() => setSelected(n)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') setSelected(n);
                }}
                className="flow-node"
              >
                <rect
                  x={v.x}
                  y={v.y}
                  width={170}
                  height={60}
                  rx={['start', 'end'].includes(n.kind) ? 30 : 12}
                  fill={selected?.id === n.id ? '#d9f4f1' : 'var(--surface)'}
                  stroke={
                    n.status === 'completed'
                      ? '#079daa'
                      : n.status === 'failed'
                        ? '#e87f87'
                        : '#a4b7b9'
                  }
                />
                <text x={v.x + 85} y={v.y + 34} textAnchor="middle" fill="var(--ink)" fontSize="13">
                  {n.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      {selected && (
        <div className="surface inset">
          <strong>{selected.label}</strong>
          <p>{selected.detail ?? selected.status ?? '流程节点'}</p>
        </div>
      )}
    </section>
  );
}
