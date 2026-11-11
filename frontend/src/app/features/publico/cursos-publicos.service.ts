import { Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API } from '../../core/api';
import { PublicoRealtimeService } from '../../core/publico-realtime.service';
import { LeccionCarga } from '../aprende/aprende.service';

export interface LeccionPublica { id: number; titulo: string; tipo: string; duracion_seg: number; vista_previa: boolean; }
export interface SeccionPublica { titulo: string; lecciones: LeccionPublica[]; }
export interface CursoPublico {
  id: number; modulo: string | null; titulo: string; subtitulo: string; descripcion: string; nivel: string;
  instructor: string; portada: boolean; destacado: boolean; n_lecciones: number; duracion_seg: number;
  secciones: SeccionPublica[]; planes: string[];
}

@Injectable({ providedIn: 'root' })
export class CursosPublicosService {
  private readonly http: HttpClient = inject(HttpClient);
  private readonly rt: PublicoRealtimeService = inject(PublicoRealtimeService);
  readonly cursos = signal<CursoPublico[]>([]);
  private pedido = false;

  constructor() {
    // Tiempo real: si el superadmin cambia cursos o lecciones, la portada se actualiza sola
    this.rt.cambios('cursos').pipe(takeUntilDestroyed()).subscribe(() => this.pedir());
  }

  /** Se pide una sola vez, aunque haya varias secciones de cursos en la página. */
  cargar(): void {
    if (this.pedido) return;
    this.pedido = true;
    this.pedir();
  }

  private pedir(): void {
    this.http.get<CursoPublico[]>(`${API}/publico/cursos`).subscribe({ next: (l) => this.cursos.set(l), error: () => undefined });
  }

  vistaPrevia(id: number): Observable<LeccionCarga> {
    return this.http.get<LeccionCarga>(`${API}/publico/lecciones/${id}/vista-previa`);
  }
}