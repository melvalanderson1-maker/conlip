import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API } from '../../core/api';

export interface Mensaje {
  id: number; direccion: 'in' | 'out'; tipo: string; texto: string; tiene_media: boolean; media_mime: string | null;
  media_nombre: string | null; estado: string; error: string; enviado_por: string; creado_en: string;
}
export interface Conversacion {
  configurado: boolean; telefono: string; no_leidos: number; ventana_hasta: string | null; puede_texto_libre: boolean; mensajes: Mensaje[];
}
export interface Plantilla { nombre: string; idioma: string; categoria: string; cuerpo: string; variables: number; }
export interface EstadoWa {
  clave_ok: boolean; configurado: boolean; phone_id: string; waba_id: string; token_guardado: boolean; secreto_guardado: boolean;
  version: string; verify_token: string; webhook_url: string; ultimo_evento: string | null;
}

@Injectable({ providedIn: 'root' })
export class WhatsappService {
  private readonly http: HttpClient = inject(HttpClient);
  private readonly crm = `${API}/crm`;
  private readonly adm = `${API}/integraciones/whatsapp`;

  mensajes(id: number): Observable<Conversacion> { return this.http.get<Conversacion>(`${this.crm}/leads/${id}/mensajes`); }
  enviar(id: number, texto: string): Observable<unknown> { return this.http.post(`${this.crm}/leads/${id}/mensajes`, { texto }); }
  plantilla(id: number, d: { nombre: string; idioma: string; variables: string[] }): Observable<unknown> {
    return this.http.post(`${this.crm}/leads/${id}/plantilla`, d);
  }
  leido(id: number): Observable<unknown> { return this.http.post(`${this.crm}/leads/${id}/leido`, {}); }
  plantillas(): Observable<Plantilla[]> { return this.http.get<Plantilla[]>(`${this.crm}/whatsapp/plantillas`); }
  media(id: number): Observable<Blob> { return this.http.get(`${this.crm}/mensajes/${id}/media`, { responseType: 'blob' }); }

  estado(): Observable<EstadoWa> { return this.http.get<EstadoWa>(this.adm); }
  guardar(d: Record<string, string>): Observable<unknown> { return this.http.put(this.adm, d); }
  probar(): Observable<{ ok: boolean; detalle: string }> { return this.http.post<{ ok: boolean; detalle: string }>(`${this.adm}/probar`, {}); }
  suscribir(): Observable<{ ok: boolean; detalle: string }> { return this.http.post<{ ok: boolean; detalle: string }>(`${this.adm}/suscribir`, {}); }
}