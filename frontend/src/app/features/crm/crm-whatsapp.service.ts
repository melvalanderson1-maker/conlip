import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API } from '../../core/api';

export type Canal = 'whatsapp' | 'facebook' | 'instagram';

export interface Mensaje {
  id: number; direccion: 'in' | 'out'; tipo: string; texto: string; tiene_media: boolean; media_mime: string | null;
  media_nombre: string | null; estado: string; error: string; enviado_por: string; creado_en: string; canal: Canal;
}
export interface CanalInfo {
  canal: Canal; disponible: boolean; configurado: boolean; ventana_hasta: string | null; puede_texto_libre: boolean;
}
export interface Conversacion {
  configurado: boolean; telefono: string; no_leidos: number; ventana_hasta: string | null; puede_texto_libre: boolean;
  canales: CanalInfo[]; mensajes: Mensaje[];
}
export interface Plantilla { nombre: string; idioma: string; categoria: string; cuerpo: string; variables: number; }
export interface CanalCrm {
  id: number; tipo: Canal; nombre: string; ext_id: string; waba_id: string; page_id: string; detalle: string;
  estado: 'activo' | 'error' | 'desconectado'; error: string; legado: boolean; creado_en: string;
}
export interface EstadoCanales {
  app_id: string; config_id: string; app_secret_guardado: boolean; clave_ok: boolean; redirect_uri: string; canales: CanalCrm[];
}
export interface ActivosMeta {
  paginas: { id: string; nombre: string; ig: { id: string; usuario: string } | null; conectada: boolean; ig_conectada: boolean }[];
  numeros: { id: string; waba_id: string; waba: string; numero: string; nombre: string; calidad: string; conectada: boolean }[];
  avisos: string[];
}
export interface EstadoWa {
  clave_ok: boolean; configurado: boolean; phone_id: string; waba_id: string; token_guardado: boolean; secreto_guardado: boolean;
  version: string; verify_token: string; webhook_url: string; ultimo_evento: string | null;
}
export interface EstadoMeta {
  clave_ok: boolean; configurado: boolean; page_id: string; ig_id: string; token_guardado: boolean; ig_token_guardado: boolean; secreto_guardado: boolean;
  verify_token: string; webhook_url: string; entrada_url: string; clave_entrada_guardada: boolean; ultimo_evento: string | null;
}

@Injectable({ providedIn: 'root' })
export class WhatsappService {
  private readonly http: HttpClient = inject(HttpClient);
  private readonly crm = `${API}/crm`;
  private readonly adm = `${API}/integraciones/whatsapp`;
  private readonly meta = `${API}/integraciones/meta`;
  private readonly cnl = `${API}/integraciones/canales`;

  mensajes(id: number): Observable<Conversacion> { return this.http.get<Conversacion>(`${this.crm}/leads/${id}/mensajes`); }
  enviar(id: number, texto: string, canal: Canal = 'whatsapp'): Observable<unknown> {
    return this.http.post(`${this.crm}/leads/${id}/mensajes`, { texto, canal });
  }
  plantilla(id: number, d: { nombre: string; idioma: string; variables: string[] }): Observable<unknown> {
    return this.http.post(`${this.crm}/leads/${id}/plantilla`, d);
  }
  leido(id: number): Observable<unknown> { return this.http.post(`${this.crm}/leads/${id}/leido`, {}); }
  plantillas(leadId?: number): Observable<Plantilla[]> {
    return this.http.get<Plantilla[]>(`${this.crm}/whatsapp/plantillas`, { params: leadId ? { lead_id: leadId } : {} });
  }
  media(id: number): Observable<Blob> { return this.http.get(`${this.crm}/mensajes/${id}/media`, { responseType: 'blob' }); }

  estado(): Observable<EstadoWa> { return this.http.get<EstadoWa>(this.adm); }
  guardar(d: Record<string, string>): Observable<unknown> { return this.http.put(this.adm, d); }
  probar(): Observable<{ ok: boolean; detalle: string }> { return this.http.post<{ ok: boolean; detalle: string }>(`${this.adm}/probar`, {}); }
  suscribir(): Observable<{ ok: boolean; detalle: string }> { return this.http.post<{ ok: boolean; detalle: string }>(`${this.adm}/suscribir`, {}); }

  // ---- Facebook / Instagram / entrada genérica (solo superadmin) ----
  estadoMeta(): Observable<EstadoMeta> { return this.http.get<EstadoMeta>(this.meta); }
  guardarMeta(d: Record<string, string>): Observable<unknown> { return this.http.put(this.meta, d); }
  probarMeta(): Observable<{ ok: boolean; detalle: string }> { return this.http.post<{ ok: boolean; detalle: string }>(`${this.meta}/probar`, {}); }
  suscribirMeta(): Observable<{ ok: boolean; detalle: string }> { return this.http.post<{ ok: boolean; detalle: string }>(`${this.meta}/suscribir`, {}); }
  nuevaClaveEntrada(): Observable<{ clave: string }> { return this.http.post<{ clave: string }>(`${this.meta}/clave-entrada`, {}); }

  // ---- Canales: varios números, páginas y cuentas (solo superadmin) ----
  canales(): Observable<EstadoCanales> { return this.http.get<EstadoCanales>(this.cnl); }
  guardarApp(d: { app_id: string; config_id: string }): Observable<unknown> { return this.http.put(`${this.cnl}/app`, d); }
  iniciarOauth(): Observable<{ url: string }> { return this.http.post<{ url: string }>(`${this.cnl}/oauth/iniciar`, {}); }
  tokenWhatsapp(d: { waba_id: string; token: string }): Observable<{ sid: string }> {
    return this.http.post<{ sid: string }>(`${this.cnl}/token-whatsapp`, d);
  }
  activos(sid: string): Observable<ActivosMeta> { return this.http.get<ActivosMeta>(`${this.cnl}/sesiones/${sid}`); }
  conectarSesion(sid: string, d: { paginas: string[]; instagram: string[]; numeros: { id: string; waba_id: string }[] }):
    Observable<{ conectados: string[]; avisos: string[] }> {
    return this.http.post<{ conectados: string[]; avisos: string[] }>(`${this.cnl}/sesiones/${sid}/conectar`, d);
  }
  probarCanal(id: number): Observable<{ ok: boolean; detalle: string }> {
    return this.http.post<{ ok: boolean; detalle: string }>(`${this.cnl}/${id}/probar`, {});
  }
  renombrarCanal(id: number, nombre: string): Observable<unknown> { return this.http.patch(`${this.cnl}/${id}`, { nombre }); }
  desconectarCanal(id: number): Observable<unknown> { return this.http.delete(`${this.cnl}/${id}`); }
}