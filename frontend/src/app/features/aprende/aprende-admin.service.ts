import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpEvent } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API } from '../../core/api';

export type ModuloCurso = 'perucompras' | 'menor' | 'mayor';
export type TipoLeccion = 'video' | 'audio' | 'documento' | 'imagen' | 'texto';

export interface LeccionAdmin {
  id: number; seccion_id: number; titulo: string; tipo: TipoLeccion; archivo_id: number | null;
  archivo_nombre: string | null; url_externa: string | null; contenido: string; duracion_seg: number;
  vista_previa: boolean; orden: number;
}
export interface SeccionAdmin { id: number; titulo: string; orden: number; lecciones: LeccionAdmin[]; }
export interface CursoResumen {
  id: number; modulo: ModuloCurso | null; titulo: string; subtitulo: string; nivel: string; instructor: string;
  portada_id: number | null; publicado: boolean; publico: boolean; destacado: boolean; orden: number;
  n_secciones: number; n_lecciones: number; duracion_seg: number;
}
export interface CursoDetalle {
  id: number; modulo: ModuloCurso | null; titulo: string; subtitulo: string; descripcion: string; nivel: string;
  instructor: string; portada_id: number | null; publicado: boolean; publico: boolean; destacado: boolean;
  orden: number; plan_ids: number[]; secciones: SeccionAdmin[];
}
export interface LeccionBody {
  titulo: string; tipo: TipoLeccion; archivo_id: number | null; url_externa: string | null;
  contenido: string; duracion_seg: number; vista_previa: boolean;
}
export interface ArchivoSubido { id: number; nombre: string; categoria: string; tamano: number; }

const BASE = `${API}/aprende/admin`;

@Injectable({ providedIn: 'root' })
export class AprendeAdminService {
  private readonly http: HttpClient = inject(HttpClient);

  cursos(): Observable<CursoResumen[]> { return this.http.get<CursoResumen[]>(`${BASE}/cursos`); }
  curso(id: number): Observable<CursoDetalle> { return this.http.get<CursoDetalle>(`${BASE}/cursos/${id}`); }
  crearCurso(d: { titulo: string; modulo: ModuloCurso | null }): Observable<{ id: number }> {
    return this.http.post<{ id: number }>(`${BASE}/cursos`, d);
  }
  editarCurso(id: number, d: Record<string, unknown>): Observable<unknown> { return this.http.patch(`${BASE}/cursos/${id}`, d); }
  borrarCurso(id: number): Observable<unknown> { return this.http.delete(`${BASE}/cursos/${id}`); }
  fijarPlanes(id: number, plan_ids: number[]): Observable<unknown> { return this.http.put(`${BASE}/cursos/${id}/planes`, { plan_ids }); }
  ordenarCursos(ids: number[]): Observable<unknown> { return this.http.post(`${BASE}/cursos/orden`, { ids }); }

  crearSeccion(cid: number, titulo: string): Observable<unknown> { return this.http.post(`${BASE}/cursos/${cid}/secciones`, { titulo }); }
  renombrarSeccion(id: number, titulo: string): Observable<unknown> { return this.http.patch(`${BASE}/secciones/${id}`, { titulo }); }
  borrarSeccion(id: number): Observable<unknown> { return this.http.delete(`${BASE}/secciones/${id}`); }
  ordenarSecciones(cid: number, ids: number[]): Observable<unknown> { return this.http.post(`${BASE}/cursos/${cid}/secciones/orden`, { ids }); }

  crearLeccion(sid: number, d: LeccionBody): Observable<unknown> { return this.http.post(`${BASE}/secciones/${sid}/lecciones`, d); }
  editarLeccion(id: number, d: LeccionBody): Observable<unknown> { return this.http.put(`${BASE}/lecciones/${id}`, d); }
  borrarLeccion(id: number): Observable<unknown> { return this.http.delete(`${BASE}/lecciones/${id}`); }
  ordenarLecciones(sid: number, ids: number[]): Observable<unknown> { return this.http.post(`${BASE}/secciones/${sid}/lecciones/orden`, { ids }); }

  /** Sube un archivo y emite el progreso de la subida. */
  subir(file: File): Observable<HttpEvent<ArchivoSubido>> {
    const fd = new FormData();
    fd.append('archivo', file, file.name);
    return this.http.post<ArchivoSubido>(`${BASE}/archivos`, fd, { reportProgress: true, observe: 'events' });
  }
}