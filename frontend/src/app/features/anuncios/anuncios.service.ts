import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API } from '../../core/api';
import { IconName } from '../../shared/icon.component';

export type TipoAnuncio = 'curso' | 'novedad' | 'promocion';

export interface AnuncioUsuario {
  id: number; tipo: TipoAnuncio; titulo: string; mensaje: string; curso_id: number | null;
  curso_modulo: string | null; publicado_en: string | null; leido: boolean;
}
export interface AnuncioPublico {
  id: number; tipo: TipoAnuncio; titulo: string; mensaje: string; curso_id: number | null; curso_modulo: string | null;
}
export interface AnuncioAdmin {
  id: number; tipo: TipoAnuncio; titulo: string; mensaje: string; curso_id: number | null; curso_titulo: string | null;
  para_clientes: boolean; para_publico: boolean; activo: boolean; publicado_en: string | null; vence_en: string | null;
  vencido: boolean; lecturas: number;
}

export const ICONO_ANUNCIO: Record<TipoAnuncio, IconName> = {
  curso: 'graduation-cap', novedad: 'megaphone', promocion: 'tag',
};

export function haceTxt(iso: string | null): string {
  if (!iso) return '';
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'ahora mismo';
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  return `hace ${d} ${d === 1 ? 'día' : 'días'}`;
}

@Injectable({ providedIn: 'root' })
export class AnunciosService {
  private readonly http: HttpClient = inject(HttpClient);

  mios(): Observable<{ items: AnuncioUsuario[]; sin_leer: number }> {
    return this.http.get<{ items: AnuncioUsuario[]; sin_leer: number }>(`${API}/anuncios`);
  }
  leer(id: number): Observable<unknown> { return this.http.post(`${API}/anuncios/${id}/leer`, {}); }
  leerTodos(): Observable<unknown> { return this.http.post(`${API}/anuncios/leer-todos`, {}); }
  publicos(): Observable<AnuncioPublico[]> { return this.http.get<AnuncioPublico[]>(`${API}/publico/anuncios`); }

  lista(): Observable<AnuncioAdmin[]> { return this.http.get<AnuncioAdmin[]>(`${API}/anuncios/admin`); }
  crear(d: Record<string, unknown>): Observable<{ id: number }> { return this.http.post<{ id: number }>(`${API}/anuncios/admin`, d); }
  editar(id: number, d: Record<string, unknown>): Observable<unknown> { return this.http.patch(`${API}/anuncios/admin/${id}`, d); }
  borrar(id: number): Observable<unknown> { return this.http.delete(`${API}/anuncios/admin/${id}`); }
}