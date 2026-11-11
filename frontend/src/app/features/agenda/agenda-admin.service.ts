import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API } from '../../core/api';

export type PlataformaCita = 'meet' | 'zoom' | 'otra';
export type EstadoEntregable = 'pendiente' | 'en_curso' | 'hecho';
export type EstadoSesion = 'programada' | 'realizada' | 'no_asistio' | 'cancelada';
export type EstadoServicio = 'nuevo' | 'en_curso' | 'entregado' | 'cancelado';

export interface Horario { dia: number; inicio: string; fin: string; }
export interface Bloqueo { id: number; desde: string; hasta: string; motivo: string; }
export interface Asesor {
  id: number; nombre: string; correo: string; plataforma: PlataformaCita; enlace: string; color: string;
  activo: boolean; proximas: number; horarios: Horario[]; bloqueos: Bloqueo[]; modo_enlace: 'fijo' | 'api'; zoom_usuario: string; usuario_id: number | null;
}
export interface ServicioAgenda {
  id: number; categoria: string; nombre: string; sesiones: number; duracion_sesion_min: number; asesor_ids: number[];
}
export interface Reglas { antelacion_horas: number; cancelacion_horas: number; dias_adelante: number; }
export interface ModuloServicios { id: string; nombre: string; habilitado: boolean; servicios: number; }

export interface PedidoSeg {
  id: number; servicio_nombre: string; estado: EstadoServicio; origen: string; nombre: string; correo: string;
  telefono: string; empresa: string | null; creado_en: string; sesiones_incluidas: number; total_e: number;
  hechos: number; realizadas: number; programadas: number; proxima: string | null; progreso: number;
}
export interface Entregable { id: number; orden: number; titulo: string; estado: EstadoEntregable; nota: string; }
export interface SesionFila {
  id: number; asesor_id: number; asesor: string; color: string; inicio: string; fin: string; estado: EstadoSesion;
  enlace: string; plataforma: string; nota: string;
}
export interface PedidoDetalle {
  id: number; servicio_nombre: string; estado: EstadoServicio; origen: string; nombre: string; correo: string;
  telefono: string; mensaje: string; empresa: string | null; creado_en: string; sesiones_incluidas: number;
  duracion_min: number; progreso: number; pendientes_agendar: number; entregables: Entregable[]; sesiones: SesionFila[];
}
export interface Slot { inicio: string; fin: string; asesor_id: number; asesor: string; }
export interface SesionCal {
  id: number; pedido_id: number; asesor_id: number; asesor: string; color: string; inicio: string; fin: string;
  estado: EstadoSesion; enlace: string; cliente: string; servicio_nombre: string;
}

const BASE = `${API}/agenda/admin`;

@Injectable({ providedIn: 'root' })
export class AgendaAdminService {
  private readonly http: HttpClient = inject(HttpClient);

  // Asesores
  asesores(): Observable<Asesor[]> { return this.http.get<Asesor[]>(`${BASE}/asesores`); }
  crearAsesor(d: Record<string, unknown>): Observable<{ id: number }> { return this.http.post<{ id: number }>(`${BASE}/asesores`, d); }
  editarAsesor(id: number, d: Record<string, unknown>): Observable<unknown> { return this.http.patch(`${BASE}/asesores/${id}`, d); }
  borrarAsesor(id: number): Observable<unknown> { return this.http.delete(`${BASE}/asesores/${id}`); }
  fijarHorarios(id: number, horarios: Horario[]): Observable<unknown> { return this.http.put(`${BASE}/asesores/${id}/horarios`, { horarios }); }
  crearBloqueo(id: number, d: { desde: string; hasta: string; motivo: string }): Observable<unknown> {
    return this.http.post(`${BASE}/asesores/${id}/bloqueos`, d);
  }
  borrarBloqueo(id: number): Observable<unknown> { return this.http.delete(`${BASE}/bloqueos/${id}`); }

  // Servicios y reglas
  servicios(): Observable<ServicioAgenda[]> { return this.http.get<ServicioAgenda[]>(`${BASE}/servicios`); }
  fijarServicio(id: number, d: { sesiones: number; duracion_min: number; asesor_ids: number[] }): Observable<unknown> {
    return this.http.put(`${BASE}/servicios/${id}`, d);
  }
  reglas(): Observable<Reglas> { return this.http.get<Reglas>(`${BASE}/reglas`); }
  modulosServicios(): Observable<ModuloServicios[]> { return this.http.get<ModuloServicios[]>(`${BASE}/modulos`); }
  fijarModulosServicios(d: Record<string, boolean>): Observable<unknown> { return this.http.put(`${BASE}/modulos`, d); }
  darAcceso(id: number): Observable<unknown> { return this.http.post(`${BASE}/asesores/${id}/acceso`, {}); }
  quitarAcceso(id: number): Observable<unknown> { return this.http.delete(`${BASE}/asesores/${id}/acceso`); }
  fijarReglas(d: Reglas): Observable<unknown> { return this.http.put(`${BASE}/reglas`, d); }

  // Seguimiento
  pedidos(): Observable<PedidoSeg[]> { return this.http.get<PedidoSeg[]>(`${BASE}/pedidos`); }
  pedido(id: number): Observable<PedidoDetalle> { return this.http.get<PedidoDetalle>(`${BASE}/pedidos/${id}`); }
  horarios(pid: number, desde: string, dias: number): Observable<Slot[]> {
    return this.http.get<Slot[]>(`${BASE}/pedidos/${pid}/horarios`, { params: new HttpParams().set('desde', desde).set('dias', dias) });
  }
  agendar(pid: number, d: { asesor_id: number; inicio: string }): Observable<unknown> { return this.http.post(`${BASE}/pedidos/${pid}/sesiones`, d); }
  editarSesion(id: number, d: Record<string, unknown>): Observable<unknown> { return this.http.patch(`${BASE}/sesiones/${id}`, d); }
  sesiones(desde: string, hasta: string, asesorId: number | null): Observable<SesionCal[]> {
    let params = new HttpParams().set('desde', desde).set('hasta', hasta);
    if (asesorId) params = params.set('asesor_id', asesorId);
    return this.http.get<SesionCal[]>(`${BASE}/sesiones`, { params });
  }
  agregarEntregable(pid: number, titulo: string): Observable<unknown> { return this.http.post(`${BASE}/pedidos/${pid}/entregables`, { titulo }); }
  editarEntregable(id: number, d: Record<string, unknown>): Observable<unknown> { return this.http.patch(`${BASE}/entregables/${id}`, d); }
  quitarEntregable(id: number): Observable<unknown> { return this.http.delete(`${BASE}/entregables/${id}`); }
}