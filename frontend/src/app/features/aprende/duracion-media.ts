interface YTPlayer { getDuration(): number; destroy(): void; }
interface YTApi {
  Player: new (
    el: HTMLElement,
    o: { videoId: string; events: { onReady: (e: { target: YTPlayer }) => void; onError: () => void } },
  ) => YTPlayer;
}
type VentanaYT = Window & { YT?: YTApi; onYouTubeIframeAPIReady?: () => void };

function medir(src: string, esAudio: boolean, liberar?: () => void): Promise<number> {
  return new Promise((ok, fallo) => {
    const el = document.createElement(esAudio ? 'audio' : 'video');
    el.preload = 'metadata';
    el.onloadedmetadata = () => {
      const d = el.duration;
      liberar?.();
      if (Number.isFinite(d) && d > 0) ok(Math.round(d)); else fallo(new Error('Sin duración'));
    };
    el.onerror = () => { liberar?.(); fallo(new Error('No se pudo leer el archivo')); };
    el.src = src;
  });
}

/** Duración de un archivo elegido en el computador (video o audio). */
export function duracionDeArchivo(file: File): Promise<number> {
  const url = URL.createObjectURL(file);
  const audio = file.type.startsWith('audio') || /\.(mp3|m4a|ogg|wav)$/i.test(file.name);
  return medir(url, audio, () => URL.revokeObjectURL(url));
}

/** Duración de un enlace directo a un .mp4 o .webm. */
export function duracionDeUrl(url: string): Promise<number> { return medir(url, false); }

/** Vimeo informa la duración públicamente. */
export async function duracionVimeo(url: string): Promise<number> {
  const r = await fetch(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`);
  if (!r.ok) throw new Error('No se pudo consultar Vimeo');
  const j = (await r.json()) as { duration?: number };
  if (!j.duration) throw new Error('Sin duración');
  return Math.round(j.duration);
}

export function idYoutube(url: string): string | null {
  try {
    const u = new URL(url.trim());
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
    if (host.endsWith('youtube.com')) {
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const p = u.pathname.split('/');
      if (['embed', 'shorts', 'live'].includes(p[1]) && p[2]) return p[2];
    }
  } catch { /* no es un enlace */ }
  return null;
}

let apiYoutube: Promise<YTApi> | null = null;

function cargarYoutube(): Promise<YTApi> {
  const w = window as VentanaYT;
  if (w.YT?.Player) return Promise.resolve(w.YT);
  if (!apiYoutube) {
    apiYoutube = new Promise<YTApi>((ok, fallo) => {
      w.onYouTubeIframeAPIReady = () => { if (w.YT) ok(w.YT); else fallo(new Error('YouTube no disponible')); };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => { apiYoutube = null; fallo(new Error('No se pudo cargar YouTube')); };
      document.head.appendChild(s);
    });
  }
  return apiYoutube;
}

/** YouTube no entrega la duración por enlace: se lee con su reproductor, oculto un instante. */
export async function duracionYoutube(id: string): Promise<number> {
  const YT = await cargarYoutube();
  return new Promise<number>((ok, fallo) => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;overflow:hidden';
    document.body.appendChild(host);
    const limpiar = (): void => { try { jugador.destroy(); } catch { /* ya destruido */ } host.remove(); };
    const jugador = new YT.Player(host, {
      videoId: id,
      events: {
        onReady: (e) => {
          let n = 0;
          const t = setInterval(() => {
            const d = e.target.getDuration();
            if (d > 0) { clearInterval(t); limpiar(); ok(Math.round(d)); }
            else if (++n > 24) { clearInterval(t); limpiar(); fallo(new Error('Sin duración')); }
          }, 250);
        },
        onError: () => { limpiar(); fallo(new Error('No se pudo leer el video de YouTube')); },
      },
    });
  });
}