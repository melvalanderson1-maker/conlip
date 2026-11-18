import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API } from '../../core/api';
import { Canal } from './crm-whatsapp.service';

export type TipoNodo = 'disparador' | 'mensaje' | 'plantilla' | 'ia' | 'esperar' | 'esperar_respuesta' | 'condicion' | 'asignar' | 'etapa' | 'nota' | 'tarea' | 'fin' | 'archivo' | 'botones';
export interface Nodo { id: string; tipo: TipoNodo; x: number; y: number; config: Record<string, unknown>; }
export interface Conexion { de: string; salida: string; a: string; }
export interface Definicion { nodos: Nodo[]; conexiones: Conexion[]; }
export interface FlujoResumen {
  id: number; nombre: string; canal: Canal; canal_id: number | null; estado: 'borrador' | 'publicado'; version: number;
  publicado_en: string | null; actualizado_en: string; evento: string; en_curso: number; ultimos7: number; cambios_sin_publicar: boolean;
}
export interface FlujoDetalle { id: number; nombre: string; canal: Canal; canal_id: number | null; estado: string; definicion: Definicion; }
export interface PlantillaFlujo { id: string; nombre: string; descripcion: string; }
export interface PasoPrueba { nodo: string; tipo: string; rotulo: string; salida: string; detalle: string; }
export interface ResultadoPrueba { coincide: boolean; motivo: string; pasos: PasoPrueba[]; }
export interface EjecucionFlujo { id: number; estado: string; error: string; creado_en: string; actualizado_en: string; nodo_actual: string; lead_id: number; nombre: string; }
export interface RegistroFlujo { nodo_id: string; tipo: string; salida: string; detalle: string; creado_en: string; }
export interface ProveedorIa { id: string; nombre: string; modelo: string; gratis: boolean; url_clave: string; }
export interface ConfigIa { proveedor: string; modelo: string; clave_guardada: boolean; instrucciones: string; max_dia: number; proveedores: ProveedorIa[]; }

const BASE = `${API}/crm/automatizaciones`;

@Injectable({ providedIn: 'root' })
export class AutomatizacionesService {
  private readonly http: HttpClient = inject(HttpClient);

  lista(): Observable<FlujoResumen[]> { return this.http.get<FlujoResumen[]>(BASE); }
  plantillas(): Observable<PlantillaFlujo[]> { return this.http.get<PlantillaFlujo[]>(`${BASE}/plantillas`); }
  detalle(id: number): Observable<FlujoDetalle> { return this.http.get<FlujoDetalle>(`${BASE}/${id}`); }
  crear(d: { nombre: string; canal: Canal; plantilla: string | null }): Observable<{ id: number }> { return this.http.post<{ id: number }>(BASE, d); }
  guardar(id: number, d: { nombre: string; canal: Canal; canal_id: number | null; definicion: Definicion }): Observable<unknown> { return this.http.put(`${BASE}/${id}`, d); }
  publicar(id: number): Observable<unknown> { return this.http.post(`${BASE}/${id}/publicar`, {}); }
  pausar(id: number): Observable<unknown> { return this.http.post(`${BASE}/${id}/pausar`, {}); }
  borrar(id: number): Observable<unknown> { return this.http.delete(`${BASE}/${id}`); }
  probar(id: number, d: { mensaje: string; respuesta: string; sin_respuesta: boolean }): Observable<ResultadoPrueba> {
    return this.http.post<ResultadoPrueba>(`${BASE}/${id}/probar`, d);
  }
  ejecuciones(id: number): Observable<EjecucionFlujo[]> { return this.http.get<EjecucionFlujo[]>(`${BASE}/${id}/ejecuciones`); }
  registros(eid: number): Observable<RegistroFlujo[]> { return this.http.get<RegistroFlujo[]>(`${BASE}/ejecuciones/${eid}/registros`); }
  configIa(): Observable<ConfigIa> { return this.http.get<ConfigIa>(`${BASE}/ia/config`); }
  guardarIa(d: { proveedor: string; modelo: string; clave: string; instrucciones: string; max_dia: number }): Observable<unknown> {
    return this.http.put(`${BASE}/ia/config`, d);
  }
  probarIa(): Observable<{ ok: boolean; detalle: string }> { return this.http.post<{ ok: boolean; detalle: string }>(`${BASE}/ia/probar`, {}); }
}