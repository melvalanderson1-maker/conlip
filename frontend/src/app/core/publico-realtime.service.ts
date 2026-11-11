import { Injectable, signal } from '@angular/core';
import { Observable, Subject, debounceTime, filter } from 'rxjs';
import { API } from './api';

export interface EventoPublico { tipo: string; }

const WS_URL = API.replace(/^http/, 'ws') + '/ws/publico';

@Injectable({ providedIn: 'root' })
export class PublicoRealtimeService {
  readonly conectado = signal<boolean>(false);
  private readonly eventos = new Subject<EventoPublico>();

  private ws: WebSocket | null = null;
  private activo = false;
  private intentos = 0;
  private huboCaida = false;
  private reintento: ReturnType<typeof setTimeout> | undefined;
  private ping: ReturnType<typeof setInterval> | undefined;

  cambios(...tipos: string[]): Observable<EventoPublico> {
    return this.eventos.pipe(filter((e) => tipos.includes(e.tipo)), debounceTime(400));
  }

  iniciar(): void {
    if (this.activo) return;
    this.activo = true;
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
  }

  private conectar(): void {
    if (!this.activo) return;
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.onmessage = (m: MessageEvent<string>) => {
      if (m.data === 'pong') return;
      let ev: EventoPublico;
      try { ev = JSON.parse(m.data) as EventoPublico; } catch { return; }
      if (ev.tipo === 'listo') {
        this.conectado.set(true);
        this.intentos = 0;
        clearInterval(this.ping);
        this.ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('ping'); }, 25_000);
        if (this.huboCaida) {  // si hubo una caída, se vuelve a pedir todo por si se perdió algún cambio
          this.huboCaida = false;
          this.eventos.next({ tipo: 'catalogo' });
          this.eventos.next({ tipo: 'cursos' });
        }
        return;
      }
      this.eventos.next(ev);
    };

    ws.onclose = () => {
      clearInterval(this.ping);
      this.conectado.set(false);
      if (this.ws !== ws || !this.activo) return;
      this.huboCaida = true;
      const espera = Math.min(30_000, 1000 * 2 ** this.intentos++);
      this.reintento = setTimeout(() => this.conectar(), espera);
    };

    ws.onerror = () => ws.close();
  }
}