import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API } from '../../core/api';

export type Modo = 'ver' | 'cotizar';
export type Periodo = 'mensual' | 'anual';

export interface Resumen { empresas: number; personas: number; suscripciones_activas: number; por_vencer: number; }

export interface SuscripcionFila {
  id: number; empresa_id: number; codigo: string; nombre: string; modo: Modo; periodo: Periodo;
  inicio: string; vence_en: string; estado: 'activa' | 'cancelada'; vigente: boolean;
}
export interface EmpresaFila {
  id: number; tipo: 'empresa' | 'persona'; nombre: string; doc_tipo: string; doc_numero: string;
  correo: string; cupo_usuarios: number; activo: number; creado_en: string; usuarios: number;
  suscripciones: SuscripcionFila[];
}
export interface PrecioFila { tipo_cuenta: string; concepto: string; periodo: string; monto: number; }
export interface PlanFila {
  id: number; codigo: string; nombre: string; descripcion: string; en_venta: boolean; orden: number;
  precios: PrecioFila[];
}
export interface ClienteNuevo {
  tipo: 'empresa' | 'persona'; nombre: string; doc_tipo: string; doc_numero: string; correo: string;
  usuario: string; clave: string; cupo_usuarios: number | null;
  suscripciones: { plan: string; modo: Modo; periodo: Periodo }[];
}

const BASE = `${API}/plataforma`;

@Injectable({ providedIn: 'root' })
export class PlataformaService {
  private readonly http: HttpClient = inject(HttpClient);

  resumen(): Observable<Resumen> { return this.http.get<Resumen>(`${BASE}/resumen`); }

  empresas(tipo: string): Observable<EmpresaFila[]> {
    let params = new HttpParams();
    if (tipo) params = params.set('tipo', tipo);
    return this.http.get<EmpresaFila[]>(`${BASE}/empresas`, { params });
  }

  planes(): Observable<PlanFila[]> { return this.http.get<PlanFila[]>(`${BASE}/planes`); }

  crearCliente(d: ClienteNuevo): Observable<{ id: number }> { return this.http.post<{ id: number }>(`${BASE}/empresas`, d); }

  editarEmpresa(id: number, d: { activo?: boolean; cupo_usuarios?: number }): Observable<{ ok: boolean }> {
    return this.http.patch<{ ok: boolean }>(`${BASE}/empresas/${id}`, d);
  }

  suscribir(id: number, d: { plan: string; modo: Modo; periodo: Periodo }): Observable<unknown> {
    return this.http.post(`${BASE}/empresas/${id}/suscripciones`, d);
  }

  editarSuscripcion(id: number, d: { estado?: string; vence_en?: string }): Observable<{ ok: boolean }> {
    return this.http.patch<{ ok: boolean }>(`${BASE}/suscripciones/${id}`, d);
  }

  editarPlan(id: number, d: { nombre?: string; descripcion?: string; en_venta?: boolean }): Observable<{ ok: boolean }> {
    return this.http.patch<{ ok: boolean }>(`${BASE}/planes/${id}`, d);
  }

  fijarPrecios(id: number, precios: PrecioFila[]): Observable<{ ok: boolean }> {
    return this.http.put<{ ok: boolean }>(`${BASE}/planes/${id}/precios`, precios);
  }
}