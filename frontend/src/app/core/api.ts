import { Injectable, inject, isDevMode } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

/**
 * URL base del backend.
 * - Desarrollo (ng serve): el mismo equipo desde el que abres la página, puerto 8000. Sirve con localhost y con tu IP de red.
 * - Producción: la misma dirección web de la página; nginx reenvía /api al backend.
 */
export const API: string = isDevMode()
  ? `${location.protocol}//${location.hostname}:8000/api`
  : `${location.origin}/api`;

export interface Contrato {
  id_contrato: number;
  codigo: string;
  anio: number;
  objeto: string;
  descripcion: string;
  entidad: string;
  fec_publica: string;
  fec_ini_cot: string;
  fec_fin_cot: string;
  id_estado: number;
  estado: string;
  relevante: number;
  enriquecido: number;
  archivos?: any[];
  n_archivos?: number | null;
}

export interface Lista {
  total: number;
  page: number;
  page_size: number;
  items: Contrato[];
}

export interface Stats {
  total: number;
  relevantes: number;
  por_estado: Record<string, number>;
}


export interface Sesion {
  activa: boolean;
  expira_en: number;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http: HttpClient = inject(HttpClient);

  stats(): Observable<Stats> {
    return this.http.get<Stats>(`${API}/stats`);
  }

  contratos(params: Record<string, string | number | boolean>): Observable<Lista> {
    return this.http.get<Lista>(`${API}/contratos`, { params });
  }

  detalle(id: number): Observable<Contrato> {
    return this.http.get<Contrato>(`${API}/contratos/${id}`);
  }

  sesion(): Observable<Sesion> {
    return this.http.get<Sesion>(`${API}/sesion`);
  }

  iniciarSesion(): Observable<Sesion> {
    return this.http.post<Sesion>(`${API}/sesion/iniciar`, {});
  }
}