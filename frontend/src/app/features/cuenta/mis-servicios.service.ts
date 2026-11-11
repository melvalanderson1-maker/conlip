import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API } from '../../core/api';

export interface EntregableCli { id: number; titulo: string; estado: 'pendiente' | 'en_curso' | 'hecho'; nota: string; }
export interface SesionCli {
  id: number; inicio: string; fin: string; estado: 'programada' | 'realizada' | 'no_asistio' | 'cancelada';
  asesor: string; plataforma: string; enlace: string; puede_cambiar: boolean;
}
export interface ServicioCli {
  id: number; servicio_nombre: string; estado: 'nuevo' | 'en_curso' | 'entregado' | 'cancelado'; creado_en: string;
  progreso: number; sesiones_incluidas: number; duracion_min: number; pendientes_agendar: number;
  entregables: EntregableCli[]; sesiones: SesionCli[];
}
export interface MisServicios { reglas: { cancelacion_horas: number; antelacion_horas: number }; servicios: ServicioCli[]; }
export interface SlotCli { inicio: string; fin: string; }

const BASE = `${API}/mis-servicios`;

@Injectable({ providedIn: 'root' })
export class MisServiciosService {
  private readonly http: HttpClient = inject(HttpClient);

  lista(modulo = ''): Observable<MisServicios> {
    return this.http.get<MisServicios>(BASE, { params: modulo ? new HttpParams().set('modulo', modulo) : {} });
  }
  horarios(pid: number, desde: string, dias: number): Observable<SlotCli[]> {
    return this.http.get<SlotCli[]>(`${BASE}/${pid}/horarios`, { params: new HttpParams().set('desde', desde).set('dias', dias) });
  }
  agendar(pid: number, inicio: string): Observable<unknown> { return this.http.post(`${BASE}/${pid}/sesiones`, { inicio }); }
  cambiar(sid: number, d: { accion: 'cancelar' | 'reprogramar'; inicio?: string }): Observable<unknown> {
    return this.http.patch(`${BASE}/sesiones/${sid}`, d);
  }
}