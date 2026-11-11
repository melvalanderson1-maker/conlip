import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API } from '../../../core/api';

export type EstadoAsig = 'pendiente' | 'en_curso' | 'cotizada' | 'descartada';
export type Ambito = 'mias' | 'enviadas' | 'todas';

export const ESTADOS_ASIG: Record<EstadoAsig, string> = {
  pendiente: 'Pendiente',
  en_curso: 'En curso',
  cotizada: 'Cotizada',
  descartada: 'Descartada',
};
export const LISTA_ESTADOS: EstadoAsig[] = ['pendiente', 'en_curso', 'cotizada', 'descartada'];

export interface Miembro { id: number; usuario: string; nombre: string; }

export interface Asignacion {
  id: number;
  id_contrato: number;
  estado: EstadoAsig;
  nota: string | null;
  creado_en: string;
  visto_en: string | null;
  por_id: number;
  por_nombre: string;
  para_id: number;
  para_nombre: string;
  codigo: string;
  descripcion: string;
  entidad: string;
  objeto: string;
  anio: number;
  fec_publica: string | null;
  fec_ini_cot: string | null;
  fec_fin_cot: string | null;
  id_estado: number;
  estado_contrato: string;
}

export interface AsigContrato {
  id: number;
  para_id: number;
  para_nombre: string;
  por_id: number;
  por_nombre: string;
  estado: EstadoAsig;
  creado_en: string;
}

const BASE = `${API}/menor/asignaciones`;

@Injectable({ providedIn: 'root' })
export class AsignacionesService {
  private readonly http: HttpClient = inject(HttpClient);

  equipo(): Observable<Miembro[]> { return this.http.get<Miembro[]>(`${BASE}/equipo`); }

  listar(ambito: Ambito, estado: string): Observable<Asignacion[]> {
    let params = new HttpParams().set('ambito', ambito);
    if (estado) params = params.set('estado', estado);
    return this.http.get<Asignacion[]>(BASE, { params });
  }

  deContrato(idContrato: number): Observable<AsigContrato[]> {
    return this.http.get<AsigContrato[]>(`${BASE}/contrato/${idContrato}`);
  }

  crear(d: { id_contrato: number; asignado_a: number; nota: string | null }): Observable<{ id: number }> {
    return this.http.post<{ id: number }>(BASE, d);
  }

  cambiarEstado(id: number, estado: EstadoAsig): Observable<{ ok: boolean }> {
    return this.http.patch<{ ok: boolean }>(`${BASE}/${id}`, { estado });
  }

  quitar(id: number): Observable<{ ok: boolean }> { return this.http.delete<{ ok: boolean }>(`${BASE}/${id}`); }

  marcarVistas(): Observable<{ marcadas: number }> {
    return this.http.post<{ marcadas: number }>(`${BASE}/vistas`, {});
  }
}