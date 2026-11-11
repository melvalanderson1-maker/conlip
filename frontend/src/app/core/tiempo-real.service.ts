import { Injectable, effect, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, Subject, debounceTime, filter } from 'rxjs';
import { API } from './api';
import { AuthService } from './auth.service';

export interface EventoRT {
  tipo: 'asignacion_nueva' | 'asignacion_actualizada' | 'asignacion_quitada' | 'vistas' | 'listo'
    | 'catalogo' | 'cursos' | 'acceso' | 'pedido' | 'anuncios' | 'agenda' | 'servicio' | 'horarios';
  id?: number;
  id_contrato?: number;
  codigo?: string;
  por_id?: number;
  por?: string;
  para_id?: number;
  para?: string;
  estado?: string;
}
export interface Toast { id: number; texto: string; }

const WS_URL = API.replace(/^http/, 'ws') + '/ws'; // http -> ws, https -> wss

@Injectable({ providedIn: 'root' })
export class TiempoRealService {
  private readonly http: HttpClient = inject(HttpClient);
  private readonly auth: AuthService = inject(AuthService);

  /** Asignaciones que el usuario aún no ha visto (el numerito rojo). */
  readonly sinVer = signal<number>(0);
  readonly conectado = signal<boolean>(false);
  readonly toasts = signal<Toast[]>([]);
  /** Cada evento del servidor; las pantallas se suscriben para refrescarse solas. */
  readonly eventos = new Subject<EventoRT>();

  private ws: WebSocket | null = null;
  private activo = false;
  private intentos = 0;
  private seq = 0;
  private reintento: ReturnType<typeof setTimeout> | undefined;
  private ping: ReturnType<typeof setInterval> | undefined;

  constructor() {
    // Si la sesión se cierra (salir o 401), se corta el WebSocket
    effect(() => {
      if (!this.auth.logueado()) this.detener();
    });
  }

  iniciar(): void {
    if (this.activo || !this.auth.logueado()) return;
    this.activo = true;
    this.refrescarSinVer();
    this.conectar();
  }

  detener(): void {
    this.activo = false;
    this.intentos = 0;
    clearTimeout(this.reintento);
    clearInterval(this.ping);
    const ws = this.ws;
    this.ws = null;
    if (ws) { ws.onclose = null; ws.close(); }
    this.conectado.set(false);
    this.sinVer.set(0);
    this.toasts.set([]);
  }

  refrescarSinVer(): void {
    if (!this.auth.puede('menor:cotizar')) return;
    this.http.get<{ sin_ver: number }>(`${API}/menor/asignaciones/resumen`).subscribe({
      next: (r) => this.sinVer.set(r.sin_ver),
      error: () => undefined,
    });
  }

  /** Eventos de los tipos pedidos, agrupados (si llegan varios seguidos, se avisa una sola vez). */
  cambios(...tipos: string[]): Observable<EventoRT> {
    return this.eventos.pipe(filter((e) => tipos.includes(e.tipo)), debounceTime(400));
  }

  cerrarToast(id: number): void {
    this.toasts.update((l) => l.filter((t) => t.id !== id));
  }

  private conectar(): void {
    const token = this.auth.token();
    if (!this.activo || !token) return;

    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.onopen = () => ws.send(JSON.stringify({ token }));

    ws.onmessage = (m: MessageEvent<string>) => {
      if (m.data === 'pong') return;
      let ev: EventoRT;
      try { ev = JSON.parse(m.data) as EventoRT; } catch { return; }

      if (ev.tipo === 'listo') {
        this.conectado.set(true);
        this.intentos = 0;
        clearInterval(this.ping);
        this.ping = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send('ping');
        }, 25_000);
        this.refrescarSinVer(); // por si hubo eventos mientras estaba desconectado
        return;
      }
      this.alRecibir(ev);
    };

    ws.onclose = (e: CloseEvent) => {
      clearInterval(this.ping);
      this.conectado.set(false);
      if (this.ws !== ws || !this.activo) return;
      if (e.code === 1008) {
        // Rechazado (token vencido o usuario desactivado): una llamada REST dispara el 401 y el cierre de sesión
        this.activo = false;
        console.warn('WebSocket rechazado por el servidor (1008)');
        this.auth.refrescar().subscribe({ error: () => undefined });
        return;
      }
      const espera = Math.min(30_000, 1000 * 2 ** this.intentos++);
      this.reintento = setTimeout(() => this.conectar(), espera);
    };

    ws.onerror = () => ws.close();
  }

  private alRecibir(ev: EventoRT): void {
    const yo = this.auth.usuario()?.id;
    if (ev.tipo === 'asignacion_nueva' && ev.para_id === yo && ev.por_id !== yo) {
      this.toast(`${ev.por} te asignó ${ev.codigo}`);
    }
    // Cambió lo que este usuario puede ver (suscripción, permisos): el menú se actualiza al instante
    if (ev.tipo === 'acceso') this.auth.refrescar().subscribe({ error: () => undefined });
    this.eventos.next(ev);
    this.refrescarSinVer();
  }

  private toast(texto: string): void {
    const id = ++this.seq;
    this.toasts.update((l) => [...l, { id, texto }]);
    setTimeout(() => this.cerrarToast(id), 8000);
  }
}