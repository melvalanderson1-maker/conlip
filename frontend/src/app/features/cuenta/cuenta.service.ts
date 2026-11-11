import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API } from '../../core/api';
import { ItemPlan } from '../../core/carrito.service';
import { OrdenCreada, ResultadoPago } from '../publico/checkout.service';

export interface EmpresaCuenta {
  id: number; tipo: 'empresa' | 'persona'; nombre: string; doc_tipo: string; doc_numero: string; correo: string;
  cupo_usuarios: number; usuarios_extra: number; extras_vence_en: string | null; extras_vigentes: boolean;
  cupo_efectivo: number; usados: number;
}
export interface SuscripcionCuenta {
  id: number; plan_id: number; nombre: string; en_venta: boolean; modo: 'ver' | 'cotizar';
  periodo: 'mensual' | 'anual'; inicio: string; vence_en: string; estado: 'activa' | 'cancelada';
  vigente: boolean; modulos: string[];
}
export interface OrdenCuenta {
  id: string; total: number; periodo: string; estado: string; pagado_en: string | null; creado_en: string;
  items: { descripcion: string; cantidad: number; monto_unit: number }[];
}
export interface PedidoCuenta { id: number; servicio_nombre: string; estado: string; creado_en: string; }
export interface MiCuenta {
  empresa: EmpresaCuenta; suscripciones: SuscripcionCuenta[]; ordenes: OrdenCuenta[]; pedidos: PedidoCuenta[];
}
export interface OrdenCuentaBody {
  periodo: 'mensual' | 'anual'; planes: ItemPlan[]; servicios: number[]; usuarios_extra: number;
}

const BASE = `${API}/cuenta`;

@Injectable({ providedIn: 'root' })
export class CuentaService {
  private readonly http: HttpClient = inject(HttpClient);

  cuenta(): Observable<MiCuenta> { return this.http.get<MiCuenta>(BASE); }
  crearOrden(b: OrdenCuentaBody): Observable<OrdenCreada> { return this.http.post<OrdenCreada>(`${BASE}/ordenes`, b); }
  pagar(id: string, datos: { token?: string; simular?: string }): Observable<ResultadoPago> {
    return this.http.post<ResultadoPago>(`${BASE}/ordenes/${id}/pagar`, datos);
  }
}