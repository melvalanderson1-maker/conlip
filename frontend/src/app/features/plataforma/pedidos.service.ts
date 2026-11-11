import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API } from '../../core/api';

export type EstadoPedido = 'nuevo' | 'en_curso' | 'entregado' | 'cancelado';
export interface Pendientes { pedidos_nuevos: number; ordenes_error: number; }
export interface ItemOrden { descripcion: string; cantidad: number; monto_unit: number; }
export interface OrdenFila {
  id: string; tipo_cuenta: string; periodo: string; total: number; estado: string;
  proveedor: string | null; ref_externa: string | null; creado_en: string; pagado_en: string | null;
  comprador: { nombre: string; doc_tipo: string; doc_numero: string; correo: string; telefono: string };
  empresa: string | null; items: ItemOrden[];
}
export interface PedidoFila {
  id: number; servicio_nombre: string; orden_id: string | null; origen: 'compra' | 'cotizacion'; estado: EstadoPedido;
  nombre: string; correo: string; telefono: string; mensaje: string; creado_en: string; empresa: string | null;
}

const BASE = `${API}/plataforma`;

@Injectable({ providedIn: 'root' })
export class PedidosService {
  private readonly http: HttpClient = inject(HttpClient);

  pendientes(): Observable<Pendientes> { return this.http.get<Pendientes>(`${BASE}/pendientes`); }

  ordenes(estado: string): Observable<OrdenFila[]> {
    return this.http.get<OrdenFila[]>(`${BASE}/ordenes`, { params: estado ? new HttpParams().set('estado', estado) : undefined });
  }

  pedidos(estado: string): Observable<PedidoFila[]> {
    return this.http.get<PedidoFila[]>(`${BASE}/pedidos`, { params: estado ? new HttpParams().set('estado', estado) : undefined });
  }

  cambiarPedido(id: number, estado: EstadoPedido): Observable<{ ok: boolean }> {
    return this.http.patch<{ ok: boolean }>(`${BASE}/pedidos/${id}`, { estado });
  }
}