import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API } from '../../core/api';
import { ItemPlan } from '../../core/carrito.service';

export interface PagoInfo { proveedor: 'demo' | 'culqi' | 'whatsapp'; whatsapp_url?: string; codigo?: string;llave_publica?: string; }
export interface OrdenCreada {
  orden_id: string; total: number; moneda: string; pago: PagoInfo;
  items: { descripcion: string; cantidad: number; monto_unit: number }[];
}
export interface ResultadoPago { ok: boolean; estado: string; mensaje: string; cuenta_creada?: boolean; correo?: string; }
export interface OrdenBody {
  tipo_cuenta: 'persona' | 'empresa'; periodo: 'mensual' | 'anual';
  planes: ItemPlan[]; servicios: number[]; usuarios_extra: number;
  comprador: { nombre: string; doc_tipo: string; doc_numero: string; correo: string; telefono: string };
  acepto_terminos: boolean;
}

const BASE = `${API}/publico`;

@Injectable({ providedIn: 'root' })
export class CheckoutService {
  private readonly http: HttpClient = inject(HttpClient);

  crearOrden(b: OrdenBody): Observable<OrdenCreada> { return this.http.post<OrdenCreada>(`${BASE}/ordenes`, b); }

  pagar(id: string, datos: Record<string, unknown>): Observable<ResultadoPago> {
    return this.http.post<ResultadoPago>(`${BASE}/ordenes/${id}/pagar`, datos);
  }

  solicitud(b: { servicio_id: number; nombre: string; correo: string; telefono: string; mensaje: string }): Observable<unknown> {
    return this.http.post(`${BASE}/solicitudes`, b);
  }

  crearClave(token: string, clave: string): Observable<unknown> {
    return this.http.post(`${BASE}/crear-clave`, { token, clave });
  }

  solicitarEnlace(correo: string): Observable<unknown> { return this.http.post(`${BASE}/solicitar-enlace`, { correo }); }
}