import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API } from '../../core/api';

export interface PrecioPub { tipo_cuenta: string; concepto: string; periodo: string; monto: number; }
export interface PlanPub {
  id: number; codigo: string; nombre: string; subtitulo: string; destacado: boolean; usuarios_incluidos: number;
  modulos: string[]; precios: PrecioPub[]; beneficios: Record<string, string>;
}
export interface BeneficioPub { id: number; nombre: string; tipo: string; }
export interface ServicioPub {
  id: number; modulo: string | null; categoria: string; nombre: string; descripcion: string;
  entregables: string[]; precio: number | null;
}
export interface CatalogoPub {
  config: Record<string, string>; planes: PlanPub[]; beneficios: BeneficioPub[]; servicios: ServicioPub[];
}

@Injectable({ providedIn: 'root' })
export class PublicoService {
  private readonly http: HttpClient = inject(HttpClient);
  catalogo(): Observable<CatalogoPub> { return this.http.get<CatalogoPub>(`${API}/publico/catalogo`); }
}