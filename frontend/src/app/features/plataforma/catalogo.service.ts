import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API } from '../../core/api';

export type Modulo = 'perucompras' | 'menor' | 'mayor';
export type TipoBeneficio = 'check' | 'numero' | 'texto';

export interface PrecioFila { tipo_cuenta: string; concepto: string; periodo: string; monto: number; }

export interface PlanCat {
  id: number; codigo: string; nombre: string; subtitulo: string; descripcion: string;
  en_venta: boolean; destacado: boolean; usuarios_incluidos: number; orden: number;
  modulos: Modulo[]; precios: PrecioFila[]; beneficios: Record<string, string>;
}
export interface Beneficio { id: number; nombre: string; tipo: TipoBeneficio; visible: boolean; orden: number; }
export interface ServicioCat {
  id: number; modulo: Modulo | null; categoria: string; nombre: string; descripcion: string; entregables: string[];
  precio: number | null; activo: boolean; orden: number;
}
export type Config = Record<string, string>;

const BASE = `${API}/catalogo`;

@Injectable({ providedIn: 'root' })
export class CatalogoService {
  private readonly http: HttpClient = inject(HttpClient);

  // ---- Planes ----
  planes(): Observable<PlanCat[]> { return this.http.get<PlanCat[]>(`${BASE}/planes`); }
  crearPlan(d: { nombre: string; modulos: Modulo[] }): Observable<{ id: number }> {
    return this.http.post<{ id: number }>(`${BASE}/planes`, d);
  }
  editarPlan(id: number, d: Record<string, unknown>): Observable<unknown> { return this.http.patch(`${BASE}/planes/${id}`, d); }
  borrarPlan(id: number): Observable<unknown> { return this.http.delete(`${BASE}/planes/${id}`); }
  fijarModulos(id: number, modulos: Modulo[]): Observable<unknown> { return this.http.put(`${BASE}/planes/${id}/modulos`, { modulos }); }
  fijarBeneficios(id: number, valores: Record<string, string>): Observable<unknown> {
    return this.http.put(`${BASE}/planes/${id}/beneficios`, { valores });
  }
  fijarPrecios(id: number, precios: PrecioFila[]): Observable<unknown> {
    return this.http.put(`${API}/plataforma/planes/${id}/precios`, precios);
  }
  ordenarPlanes(ids: number[]): Observable<unknown> { return this.http.post(`${BASE}/planes/orden`, { ids }); }

  // ---- Beneficios ----
  beneficios(): Observable<Beneficio[]> { return this.http.get<Beneficio[]>(`${BASE}/beneficios`); }
  crearBeneficio(d: { nombre: string; tipo: TipoBeneficio }): Observable<unknown> { return this.http.post(`${BASE}/beneficios`, d); }
  editarBeneficio(id: number, d: Record<string, unknown>): Observable<unknown> { return this.http.patch(`${BASE}/beneficios/${id}`, d); }
  borrarBeneficio(id: number): Observable<unknown> { return this.http.delete(`${BASE}/beneficios/${id}`); }
  ordenarBeneficios(ids: number[]): Observable<unknown> { return this.http.post(`${BASE}/beneficios/orden`, { ids }); }

  // ---- Servicios ----
  servicios(): Observable<ServicioCat[]> { return this.http.get<ServicioCat[]>(`${BASE}/servicios`); }
  crearServicio(d: Record<string, unknown>): Observable<unknown> { return this.http.post(`${BASE}/servicios`, d); }
  editarServicio(id: number, d: Record<string, unknown>): Observable<unknown> { return this.http.patch(`${BASE}/servicios/${id}`, d); }
  borrarServicio(id: number): Observable<unknown> { return this.http.delete(`${BASE}/servicios/${id}`); }
  ordenarServicios(ids: number[]): Observable<unknown> { return this.http.post(`${BASE}/servicios/orden`, { ids }); }

  // ---- Sitio ----
  config(): Observable<Config> { return this.http.get<Config>(`${BASE}/config`); }
  guardarConfig(valores: Config): Observable<unknown> { return this.http.put(`${BASE}/config`, { valores }); }
}