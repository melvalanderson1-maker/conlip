import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API } from '../../core/api';
import { TiempoRealService } from '../../core/tiempo-real.service';

export type TipoEtapa = 'abierta' | 'ganada' | 'perdida';
export type EstadoLead = 'abierto' | 'ganado' | 'perdido';
export type TipoActividad = 'nota' | 'llamada' | 'whatsapp' | 'correo' | 'reunion' | 'tarea' | 'sistema';

export interface Etapa { id: number; nombre: string; orden: number; tipo: TipoEtapa; color: string; activa: boolean; leads?: number; }
export interface Lead {
  id: number; nombre: string; empresa_nombre: string; correo: string; telefono: string; origen: string; interes: string;
  valor_estimado: number; etapa_id: number; estado: EstadoLead; asesor_id: number | null; asesor: string | null;
  asesor_color: string | null; siguiente_accion_en: string | null; ultimo_contacto_en: string | null;
  creado_en: string; actualizado_en: string; vencido: boolean; wa_no_leidos: number; wa_ultimo_entrante: string | null;
}
export interface Actividad {
  id: number; tipo: TipoActividad; contenido: string; usuario: string; programada_en: string | null;
  completada_en: string | null; creado_en: string;
}
export interface LeadDetalle extends Lead {
  doc_tipo: string; doc_numero: string; motivo_perdida: string; orden_id: string | null; creado_por: string; actividades: Actividad[];
}
export interface Resumen {
  abiertos: number; valor_abierto: number; vencidos: number; sin_asignar: number; ganados_mes: number; valor_ganado_mes: number;
  por_etapa: Record<string, { n: number; valor: number }>;
}
export interface AsesorCrm { id: number; nombre: string; color: string; leads: number; }
export interface ConfigCrm { reparto: 'manual' | 'rotativo'; etapas: Etapa[]; }
export interface ResultadoImport { creados: number; duplicados: number; invalidos: number; errores: string[]; }
export interface FiltroLeads { estado: string; q: string; asesor_id: number | null; vencidos: boolean; limite: number; desde: number; }

const BASE = `${API}/crm`;

@Injectable({ providedIn: 'root' })
export class CrmService {
  private readonly http: HttpClient = inject(HttpClient);

  etapas(): Observable<Etapa[]> { return this.http.get<Etapa[]>(`${BASE}/etapas`); }
  asesores(): Observable<AsesorCrm[]> { return this.http.get<AsesorCrm[]>(`${BASE}/asesores`); }
  resumen(): Observable<Resumen> { return this.http.get<Resumen>(`${BASE}/resumen`); }
  leads(f: FiltroLeads): Observable<Lead[]> {
    let p = new HttpParams().set('estado', f.estado).set('limite', f.limite).set('desde', f.desde);
    if (f.q.trim()) p = p.set('q', f.q.trim());
    if (f.asesor_id !== null) p = p.set('asesor_id', f.asesor_id);
    if (f.vencidos) p = p.set('vencidos', true);
    return this.http.get<Lead[]>(`${BASE}/leads`, { params: p });
  }
  lead(id: number): Observable<LeadDetalle> { return this.http.get<LeadDetalle>(`${BASE}/leads/${id}`); }
  crear(d: Record<string, unknown>): Observable<{ id: number }> { return this.http.post<{ id: number }>(`${BASE}/leads`, d); }
  editar(id: number, d: Record<string, unknown>): Observable<unknown> { return this.http.patch(`${BASE}/leads/${id}`, d); }
  mover(id: number, etapa_id: number, motivo = ''): Observable<unknown> { return this.http.post(`${BASE}/leads/${id}/etapa`, { etapa_id, motivo }); }
  actividad(id: number, d: Record<string, unknown>): Observable<unknown> { return this.http.post(`${BASE}/leads/${id}/actividades`, d); }
  completar(aid: number): Observable<unknown> { return this.http.post(`${BASE}/actividades/${aid}/completar`, {}); }
  asignar(id: number, asesor_id: number | null): Observable<unknown> { return this.http.post(`${BASE}/leads/${id}/asignar`, { asesor_id }); }
  borrar(id: number): Observable<unknown> { return this.http.delete(`${BASE}/leads/${id}`); }
  importar(filas: Record<string, string>[]): Observable<ResultadoImport> { return this.http.post<ResultadoImport>(`${BASE}/importar`, { filas }); }
  config(): Observable<ConfigCrm> { return this.http.get<ConfigCrm>(`${BASE}/admin/config`); }
  guardarConfig(d: Record<string, unknown>): Observable<unknown> { return this.http.put(`${BASE}/admin/config`, d); }
}

/** Dice si el CRM está encendido para este usuario. Se actualiza solo cuando el superadmin lo enciende o apaga. */
@Injectable({ providedIn: 'root' })
export class CrmFlagService {
  private readonly http: HttpClient = inject(HttpClient);
  readonly activo = signal<boolean>(false);

  constructor() {
    inject(TiempoRealService).cambios('catalogo').subscribe(() => this.cargar());
  }

  cargar(): void {
    this.http.get<{ activo: boolean }>(`${BASE}/estado`).subscribe({
      next: (r) => this.activo.set(r.activo),
      error: () => this.activo.set(false),
    });
  }
}