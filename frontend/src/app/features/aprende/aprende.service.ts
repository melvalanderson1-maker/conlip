import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API } from '../../core/api';
import { ModuloCurso, TipoLeccion } from './aprende-admin.service';

export type FuenteLeccion = 'youtube' | 'vimeo' | 'directo' | 'archivo' | 'texto';

export interface LeccionCarga {
  id: number; curso_id: number; titulo: string; tipo: TipoLeccion; duracion_seg: number;
  fuente: FuenteLeccion | null; url: string | null; ruta_media: string | null; contenido: string;
  posicion_seg?: number; completada?: boolean;
}
export interface CursoLista {
  id: number; modulo: ModuloCurso | null; titulo: string; subtitulo: string; nivel: string; instructor: string;
  portada: boolean; destacado: boolean; acceso: boolean; total: number; hechas: number; duracion_seg: number;
  visto_seg: number; ultimo: string | null;
}
export interface LeccionResumen {
  id: number; titulo: string; tipo: TipoLeccion; duracion_seg: number; completada: boolean; posicion_seg: number;
}
export interface SeccionCurso { id: number; titulo: string; lecciones: LeccionResumen[]; }
export interface CursoAlumno {
  id: number; modulo: ModuloCurso | null; titulo: string; subtitulo: string; descripcion: string; nivel: string;
  instructor: string; portada: boolean; acceso: boolean; secciones: SeccionCurso[]; total: number; hechas: number;
  duracion_seg: number; visto_seg: number; siguiente: number | null; ultima: number | null;
}
export interface ResultadoProgreso { completada: boolean; total: number; hechas: number; }

export const portadaUrl = (id: number): string => `${API}/publico/portadas/${id}`;

export const NIVELES: Record<string, string> = {
  todos: 'Todos los niveles', basico: 'Básico', intermedio: 'Intermedio', avanzado: 'Avanzado',
};

export function duracionTxt(seg: number): string {
  if (!seg) return '—';
  const m = Math.max(1, Math.round(seg / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

const BASE = `${API}/aprende`;

@Injectable({ providedIn: 'root' })
export class AprendeService {
  private readonly http: HttpClient = inject(HttpClient);

  cursos(modulo: string): Observable<CursoLista[]> {
    return this.http.get<CursoLista[]>(`${BASE}/cursos`, { params: new HttpParams().set('modulo', modulo) });
  }
  curso(id: number): Observable<CursoAlumno> { return this.http.get<CursoAlumno>(`${BASE}/cursos/${id}`); }
  leccion(id: number): Observable<LeccionCarga> { return this.http.get<LeccionCarga>(`${BASE}/lecciones/${id}`); }
  completar(id: number, completada: boolean): Observable<{ total: number; hechas: number }> {
    return this.http.post<{ total: number; hechas: number }>(`${BASE}/lecciones/${id}/completar`, { completada });
  }
  progreso(id: number, segundos: number, total: number): Observable<ResultadoProgreso> {
    return this.http.post<ResultadoProgreso>(`${BASE}/lecciones/${id}/progreso`, { segundos, total });
  }
}