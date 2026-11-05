import { useState, type ReactNode } from 'react';
import { Button, Card } from '@heroui/react';
import { Icon } from './icons';
import { Fullscreen, ImageView } from './media';
import { ProgressTrack } from './presentation';
import type { Props } from './charts';

function SceneMedia({
  image,
  height,
  width,
  cover = false,
  preview = true,
}: {
  image: Props | string;
  height: number;
  width?: number;
  cover?: boolean;
  preview?: boolean;
}) {
  return (
    <div
      className={`scene-media ${cover ? 'cover' : ''}`}
      style={{ height, width, flexShrink: width ? 0 : undefined }}
    >
      {preview ? (
        <Fullscreen label="打开图片预览">
          <ImageView image={image} />
        </Fullscreen>
      ) : (
        <ImageView image={image} interactive={false} />
      )}
    </div>
  );
}
function Person({ person = {} }: { person?: Props }) {
  return (
    <div className="scene-person">
      {person.image ? (
        <SceneMedia image={person.image} height={40} width={40} />
      ) : (
        <div className="scene-avatar">
          <Icon name="user-round" size={28} />
        </div>
      )}
      <div className="stack compact">
        <strong>{person.name}</strong>
        {person.role && <small className="muted">{person.role}</small>}
      </div>
    </div>
  );
}
function DetailRows({ rows = [] }: { rows?: Props[] }) {
  return (
    <div className="scene-details">
      {rows.map((row, i) => (
        <div className="row spread" key={i}>
          <small className="muted">{row.label}</small>
          <small>{row.value}</small>
        </div>
      ))}
    </div>
  );
}
const weatherIcons: Record<string, string> = {
  clear: 'sun',
  rain: 'cloud-rain',
  'partly-cloudy': 'cloud-sun',
  cloudy: 'cloud',
  windy: 'wind',
  snow: 'snowflake',
};
export function Scene({ p, children }: { p: Props; children: ReactNode }) {
  const [selectedTrack, setSelectedTrack] = useState<string>();
  const c = p.content ?? {};
  const colored = ['weather-current', 'weather-forecast', 'flight-tracker'].includes(p.kind);
  const heading =
    !colored && !['purchase-complete', 'purchase-items', 'player-card'].includes(p.kind);
  const money = (v: number, currency = 'USD') =>
    new Intl.NumberFormat('zh-CN', { style: 'currency', currency }).format(v);
  const symbol = (condition: string, size = 24) => (
    <Icon name={weatherIcons[condition] ?? 'cloud'} size={size} />
  );
  let body: ReactNode;
  switch (p.kind) {
    case 'create-event':
      body = (
        <div className="scene-calendar">
          <div className="scene-date">
            <small className="muted">{c.date?.weekday}</small>
            <strong>{c.date?.day}</strong>
          </div>
          <div className="stack compact grow">
            {c.events?.map((event: Props, i: number) => (
              <div
                key={event.id ?? i}
                className={`scene-event ${event.status === 'proposed' ? 'proposed' : ''}`}
              >
                <span className={`scene-event-line ${event.tone ?? ''}`} />
                <div className="stack compact">
                  <strong>{event.title}</strong>
                  <small className="muted">{event.time}</small>
                  {event.status === 'proposed' && <small className="scene-accent">待确认</small>}
                </div>
              </div>
            ))}
          </div>
        </div>
      );
      break;
    case 'view-event':
      body = (
        <div className="scene-view-event">
          <div className="scene-clock">
            <Icon name="clock" size={28} />
          </div>
          <div className="stack compact">
            <strong>{c.date}</strong>
            <p className="muted">{c.time}</p>
          </div>
        </div>
      );
      break;
    case 'playlist':
      body = (
        <div className="stack">
          {c.cover && <SceneMedia image={c.cover} height={170} />}
          {c.tracks?.map((track: Props, i: number) => (
            <Button
              key={track.id ?? i}
              variant="tertiary"
              className="scene-track"
              aria-pressed={selectedTrack === track.id}
              onPress={() => setSelectedTrack(selectedTrack === track.id ? undefined : track.id)}
            >
              <small className="muted scene-track-index">{i + 1}</small>
              {track.image && (
                <SceneMedia image={track.image} height={40} width={40} preview={false} />
              )}
              <span className="grow">
                <strong>{track.title}</strong>
                <small className="muted">{track.artist}</small>
              </span>
              {selectedTrack === track.id && <Icon name="check" size={18} />}
            </Button>
          ))}
        </div>
      );
      break;
    case 'flight-tracker':
      body = (
        <div className="scene-flight stack">
          <div className="row">
            {c.airline?.logo && <SceneMedia image={c.airline.logo} height={24} width={24} />}
            <strong>{c.flightNumber}</strong>
            <small className="grow scene-align-right">{c.date}</small>
          </div>
          <hr />
          <div className="row spread scene-airports">
            <span>{c.origin?.label}</span>
            <span>{c.destination?.label}</span>
          </div>
          <ProgressTrack value={c.progress ?? 0} label="航班进度" />
          <div className="row spread">
            <div>
              <p>{c.origin?.time}</p>
              <small>{c.origin?.status}</small>
            </div>
            <div className="scene-align-right">
              <p>{c.destination?.time}</p>
              <small>{c.destination?.status}</small>
            </div>
          </div>
        </div>
      );
      break;
    case 'ride-status':
      body = (
        <div className="stack">
          <div className="row spread">
            <Person person={c.driver} />
            <div className="scene-align-right">
              <strong className="scene-eta">{c.eta}</strong>
              <p className="muted">
                <small>预计到达</small>
              </p>
            </div>
          </div>
          <div className="row">
            <Icon name="route" />
            <div>
              <small className="muted">上车地点</small>
              <p>
                <strong>{c.pickup}</strong>
              </p>
            </div>
          </div>
        </div>
      );
      break;
    case 'purchase-complete':
      body = (
        <div className="stack">
          <div className="row positive">
            <span className="scene-success-icon">
              <Icon name="check" size={12} />
            </span>
            <strong>{p.title ?? '购买完成'}</strong>
          </div>
          <hr />
          <div className="row">
            {c.product?.image && <SceneMedia image={c.product.image} height={80} width={80} />}
            <div>
              <h3>{c.product?.name}</h3>
              <p className="muted">
                <small>{c.product?.description}</small>
              </p>
            </div>
          </div>
          <DetailRows rows={c.details} />
          <div className="row spread">
            <strong>实付金额</strong>
            <strong>{money(c.paid?.amount ?? 0, c.paid?.currency)}</strong>
          </div>
        </div>
      );
      break;
    case 'purchase-items':
      body = (
        <div className="stack">
          {c.items?.map((item: Props, i: number) => (
            <div className="row" key={item.id ?? i}>
              {item.image && <SceneMedia image={item.image} height={56} width={56} />}
              <div className="grow">
                <strong>{item.name}</strong>
                <p className="muted">
                  <small>{item.description}</small>
                </p>
              </div>
              <strong>{money(item.price, c.currency)}</strong>
            </div>
          ))}
          <hr />
          {c.totals?.map((total: Props, i: number) => (
            <div className="row spread" key={i}>
              <span style={{ fontWeight: total.emphasis ? 600 : 400 }}>{total.label}</span>
              <strong>{money(total.amount, c.currency)}</strong>
            </div>
          ))}
        </div>
      );
      break;
    case 'player-card':
      body = (
        <div className="scene-player">
          {c.backgroundImage && <SceneMedia image={c.backgroundImage} height={220} cover />}
          <div className="scene-player-info">
            <h2>
              {c.playerName} (#{c.jerseyNumber})
            </h2>
            <div className="scene-player-stats">
              {c.stats?.map((stat: Props, i: number) => (
                <div key={i}>
                  <strong>{stat.value}</strong>
                  <small>{stat.label}</small>
                </div>
              ))}
            </div>
          </div>
        </div>
      );
      break;
    case 'enable-notification':
      body = (
        <div className="scene-notification">
          <Icon name="bell" size={34} />
        </div>
      );
      break;
    case 'weather-current':
      body = (
        <div className="scene-current-weather-body">
          <div className="row">
            {symbol(c.condition, 40)}
            <strong>
              {c.temperature ?? 0}
              {c.unit === 'fahrenheit' ? '°F' : '°C'}
            </strong>
          </div>
          <p className="scene-weather-location">{c.location}</p>
          {p.description && <p>{p.description}</p>}
          <div className="scene-weather-details">
            {c.details?.map((detail: Props, i: number) => (
              <div key={i}>
                <small>{detail.label}</small>
                <p>{detail.value}</p>
              </div>
            ))}
          </div>
        </div>
      );
      break;
    case 'weather-forecast':
      body = (
        <div className="scene-forecast-body">
          <div className="row spread">
            <div>
              <h3>{c.location}</h3>
              <p>
                H:{c.high ?? 0}° &nbsp; L:{c.low ?? 0}°
              </p>
            </div>
            {symbol(c.condition, 40)}
          </div>
          {p.description && <p>{p.description}</p>}
          <div className="scene-forecast-days">
            {c.forecast?.map((day: Props, i: number) => (
              <div key={i}>
                <small>{day.label}</small>
                {symbol(day.condition)}
                <strong>{day.temperature}°</strong>
              </div>
            ))}
          </div>
        </div>
      );
      break;
    case 'channel-message':
      body = (
        <div className="stack">
          <div className="row spread">
            <Person person={c.author} />
            <small className="muted">{c.timestamp}</small>
          </div>
          <small className="scene-accent">{c.channel}</small>
          <p className="render-text">{c.content}</p>
          {c.attachments?.map((a: Props, i: number) => (
            <div className="scene-attachment" key={a.id ?? i}>
              {a.image ? (
                <>
                  <SceneMedia image={a.image} height={48} width={48} />
                  <small className="grow">{a.name}</small>
                  <Icon name="arrow-up-right" size={14} />
                </>
              ) : (
                <>
                  <Icon name="file-text" size={18} />
                  <small>{a.name}</small>
                </>
              )}
            </div>
          ))}
        </div>
      );
      break;
    case 'event-session':
      body = (
        <div className="stack">
          <small className="scene-accent">{c.eyebrow}</small>
          <div className="row">
            <Icon name="clock" size={16} />
            <small>{c.time}</small>
            <span className="muted">·</span>
            <small>{c.location}</small>
          </div>
          {c.speakers?.map((person: Props, i: number) => (
            <Person person={person} key={i} />
          ))}
        </div>
      );
      break;
    default:
      body = null;
  }
  return (
    <Card className={`render-card scene scene-${p.kind} ${colored ? 'scene-colored' : ''}`}>
      {heading && p.title && <h3>{p.title}</h3>}
      {heading && p.description && <p className="muted">{p.description}</p>}
      {body}
      <div className="scene-actions">{children}</div>
    </Card>
  );
}
